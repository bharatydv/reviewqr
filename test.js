import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';

import { buildConfig } from './lib/env.js';
import { openDb, seed, migrate, setBusinessSwitches, upsertUser, topicsFor, nowIso } from './db.js';
import { createSuggester } from './lib/ai.js';
import { createGoogleVerifier } from './lib/google.js';
import { createApp } from './server.js';

const QUIET = { log() {}, warn() {}, error() {} };

// A Messages API response carrying the given drafts, shaped the way the real
// endpoint shapes one (thinking block first, then the text block).
function modelResponse(drafts) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        id: 'msg_test',
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: JSON.stringify(drafts) },
        ],
      };
    },
    async text() {
      return '';
    },
  };
}

// Stands in for the Anthropic API and records every request body it is sent.
function createModelMock(behaviour) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, headers: options.headers, body });
    return behaviour(body, calls.length);
  };
  return { calls, fetchImpl };
}

const DEFAULT_DRAFTS = [
  'Good visit. The service was attentive and the food was enjoyable.',
  'I enjoyed this place. The staff were friendly and it was clean throughout my visit.',
  'A calm spot with attentive service. I would happily come back another morning.',
  'Service was quick, the room was tidy and the whole visit felt easy from start to finish.',
  'I left satisfied. Attentive service, a clean room and a relaxed feel to the place overall.',
  'Everything about the visit worked: the welcome, the pace of the service and the tidy room.',
];

async function startApp(options = {}) {
  const config = buildConfig({
    NODE_ENV: 'test',
    ADMIN_TOKEN: 'test-admin-token-0123456789',
    BASE_URL: 'http://localhost:3000',
    DB_PATH: ':memory:',
    MAX_VISIBLE_REVIEWS: '6',
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_MODEL: 'claude-opus-5-5',
    ...(options.env || {}),
  });

  const db = openDb(':memory:');
  if (options.seedDemo !== false) seed(db);

  const mailer = {
    sent: [],
    reset: [],
    async sendLoginCode(email, code) {
      this.sent.push({ email, code });
      return { delivered: true, mode: 'test' };
    },
    async sendPasswordReset(email, code) {
      this.reset.push({ email, code });
      return { delivered: true, mode: 'test' };
    },
  };

  const model = options.model ?? createModelMock(() => modelResponse(DEFAULT_DRAFTS));
  const suggester = options.suggester
    ?? createSuggester({ config, fetchImpl: model.fetchImpl, logger: QUIET });

  const app = createApp({ config, db, mailer, suggester, googleVerifier: options.googleVerifier ?? null, logger: QUIET });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    config,
    db,
    mailer,
    model,
    base: `http://127.0.0.1:${server.address().port}`,
    client: () => createClient(`http://127.0.0.1:${server.address().port}`),
    async close() {
      server.close();
      await once(server, 'close');
      db.close();
    },
  };
}

// A browser-ish client: keeps cookies and echoes the CSRF cookie back in the
// header, the way the real page does.
function createClient(base) {
  const jar = new Map();

  async function request(path, options = {}) {
    const { method = 'GET', body, headers = {}, csrf = true, admin } = options;
    const sent = { ...headers };
    if (body !== undefined) sent['content-type'] = 'application/json';
    if (admin) sent['x-admin-token'] = admin;

    const cookieHeader = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookieHeader) sent.cookie = cookieHeader;
    if (method !== 'GET' && csrf && jar.has('rq_csrf') && !('x-csrf-token' in sent)) {
      sent['x-csrf-token'] = jar.get('rq_csrf');
    }

    const response = await fetch(base + path, {
      method,
      headers: sent,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = decodeURIComponent(pair.slice(eq + 1).trim());
      const expired = attrs.some((attr) => /^\s*max-age=0\s*$/i.test(attr));
      if (!value || expired) jar.delete(name);
      else jar.set(name, value);
    }

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  }

  return { request, jar, base };
}

// Primes the CSRF cookie, then runs the two-step email sign-in.
async function signIn(app, client, email, firstName) {
  await client.request('/api/auth/me');
  const requested = await client.request('/api/auth/request-code', {
    method: 'POST',
    body: { email, firstName },
  });
  assert.equal(requested.status, 200, requested.text);
  const delivered = app.mailer.sent.filter((entry) => entry.email === email.toLowerCase()).at(-1);
  assert.ok(delivered, `no code was sent to ${email}`);
  const verified = await client.request('/api/auth/verify-code', {
    method: 'POST',
    body: { email, code: delivered.code },
  });
  assert.equal(verified.status, 200, verified.text);
  return { code: delivered.code, body: verified.json };
}

// Inserts a review straight into the database. Used where a test needs many
// reviewers and the sign-in rate limits would otherwise get in the way.
function addReview(db, slug, { email, firstName, rating, comment, status = 'visible' }) {
  const business = db.prepare('SELECT id FROM businesses WHERE slug = ?').get(slug);
  const user = upsertUser(db, { email, firstName });
  db.prepare(
    `INSERT INTO reviews (business_id, user_id, rating, comment, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(business.id, user.id, rating, comment, status, nowIso());
  return user;
}

const LONG = (n) => 'This is review text that goes on. '.repeat(40).slice(0, n);

// ---------------------------------------------------------------- full flow

test('a new customer verifies their email, gets drafts and posts a review that appears first', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();

  const before = await client.request('/api/b/blue-door-cafe');
  assert.equal(before.status, 200);
  assert.equal(before.json.me.verified, false);
  assert.equal(before.json.stats.count, 4);

  await signIn(app, client, 'New.Person@Example.com', 'Sam');

  const me = await client.request('/api/auth/me');
  assert.equal(me.json.signedIn, true);
  assert.equal(me.json.firstName, 'Sam');

  const suggested = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 5, topics: ['Service', 'Food'], note: 'Quiet back room' },
  });
  assert.equal(suggested.status, 200, suggested.text);
  assert.ok(suggested.json.drafts.length >= 5 && suggested.json.drafts.length <= 7);
  for (const draft of suggested.json.drafts) {
    assert.ok(draft.length >= 20 && draft.length <= 400);
  }

  const posted = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: suggested.json.drafts[0] },
  });
  assert.equal(posted.status, 201, posted.text);

  const after = await client.request('/api/b/blue-door-cafe');
  assert.equal(after.json.stats.count, 5);
  assert.equal(after.json.reviews[0].firstName, 'Sam');
  assert.equal(after.json.reviews[0].comment, suggested.json.drafts[0]);
  // Coming back to the page shows their own review instead of the form.
  assert.ok(after.json.me.review);
  assert.equal(after.json.me.review.rating, 5);
});

test('a returning customer skips the email step', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const first = app.client();
  await signIn(app, first, 'repeat@example.com', 'Rae');
  const cookie = first.jar.get('rq_session');

  // A fresh client with the same session cookie is the same returning person.
  const second = app.client();
  second.jar.set('rq_session', cookie);
  const me = await second.request('/api/auth/me');
  assert.equal(me.json.signedIn, true);
  assert.equal(me.json.firstName, 'Rae');
});

// ------------------------------------------------------------------- profile

test('the profile shows at most MAX_VISIBLE_REVIEWS, with the full count and average', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  // Four seeded reviews (5, 4, 5, 3) plus five more.
  const extra = [5, 5, 4, 2, 1];
  extra.forEach((rating, index) => {
    addReview(app.db, 'blue-door-cafe', {
      email: `extra${index}@example.com`,
      firstName: `Extra${index}`,
      rating,
      comment: `A perfectly ordinary review number ${index} with enough characters to pass.`,
    });
  });

  const response = await app.client().request('/api/b/blue-door-cafe');
  assert.equal(response.status, 200);
  assert.equal(response.json.reviews.length, 6);
  assert.equal(response.json.maxVisibleReviews, 6);
  assert.equal(response.json.stats.count, 9);

  const ratings = [5, 4, 5, 3, ...extra];
  const expected = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;
  assert.equal(response.json.stats.average, expected);
  assert.equal(response.json.stats.breakdown[5], 4);
  assert.equal(response.json.stats.breakdown[1], 1);
  // Newest first.
  assert.equal(response.json.reviews[0].firstName, 'Extra4');
});

test('MAX_VISIBLE_REVIEWS is clamped to the allowed 3 to 6 range', async () => {
  assert.equal(buildConfig({ MAX_VISIBLE_REVIEWS: '1' }).maxVisibleReviews, 3);
  assert.equal(buildConfig({ MAX_VISIBLE_REVIEWS: '99' }).maxVisibleReviews, 6);
  assert.equal(buildConfig({ MAX_VISIBLE_REVIEWS: '4' }).maxVisibleReviews, 4);
  assert.equal(buildConfig({}).maxVisibleReviews, 6);
});

test('a profile with no reviews reports an empty state rather than an error', async (t) => {
  const app = await startApp({ seedDemo: false });
  t.after(() => app.close());

  const created = await app.client().request('/api/admin/businesses', {
    method: 'POST',
    body: { name: 'Fresh Start Bakery' },
    admin: app.config.adminToken,
  });
  assert.equal(created.status, 201, created.text);

  const response = await app.client().request('/api/b/fresh-start-bakery');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.reviews, []);
  assert.equal(response.json.stats.count, 0);
  assert.equal(response.json.stats.average, 0);
});

test('an unknown slug returns 404 on the API and on the page', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  assert.equal((await client.request('/api/b/nope')).status, 404);
  assert.equal((await client.request('/b/nope')).status, 404);
  assert.equal((await client.request('/b/blue-door-cafe')).status, 200);
});

// ------------------------------------------------------- one review per person

test('a second review for the same business is refused with 409', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'once@example.com', 'Ona');

  const first = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 4, comment: 'A good visit, with friendly service and a tidy room throughout.' },
  });
  assert.equal(first.status, 201, first.text);

  const second = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 1, comment: 'Trying to post a second review for the very same business here.' },
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'You already reviewed this business.');

  const profile = await client.request('/api/b/blue-door-cafe');
  assert.equal(profile.json.stats.count, 5);
});

test('the same person can review a different business', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'two-places@example.com', 'Tao');

  await app.client().request('/api/admin/businesses', {
    method: 'POST',
    body: { name: 'Second Place Diner' },
    admin: app.config.adminToken,
  });

  for (const slug of ['blue-door-cafe', 'second-place-diner']) {
    const posted = await client.request(`/api/b/${slug}/reviews`, {
      method: 'POST',
      body: { rating: 4, comment: `A fair visit to ${slug} with enough detail to clear the minimum.` },
    });
    assert.equal(posted.status, 201, posted.text);
  }
});

test('edit and delete only touch the signed-in person own review', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const alice = app.client();
  await signIn(app, alice, 'alice@example.com', 'Alice');
  const bob = app.client();
  await signIn(app, bob, 'bob@example.com', 'Bob');

  const alicesText = 'Alice original review text, long enough to be accepted by the server.';
  const bobsText = 'Bob original review text, also long enough to be accepted by the server.';
  await alice.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: alicesText },
  });
  await bob.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 2, comment: bobsText },
  });

  const edited = await alice.request('/api/b/blue-door-cafe/reviews/me', {
    method: 'PUT',
    body: { rating: 3, comment: 'Alice has changed her mind, and this is the updated review text.' },
  });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.review.rating, 3);

  // Bob's review is untouched.
  const bobSees = await bob.request('/api/b/blue-door-cafe');
  assert.equal(bobSees.json.me.review.comment, bobsText);
  assert.equal(bobSees.json.me.review.rating, 2);

  const deleted = await alice.request('/api/b/blue-door-cafe/reviews/me', { method: 'DELETE' });
  assert.equal(deleted.status, 200);

  const afterDelete = await bob.request('/api/b/blue-door-cafe');
  assert.equal(afterDelete.json.me.review.comment, bobsText);
  assert.ok(
    afterDelete.json.reviews.every((review) => review.comment !== alicesText),
    'Alice review should be gone',
  );

  // Alice has nothing to edit or delete now.
  assert.equal((await alice.request('/api/b/blue-door-cafe/reviews/me', { method: 'DELETE' })).status, 404);
  assert.equal(
    (
      await alice.request('/api/b/blue-door-cafe/reviews/me', {
        method: 'PUT',
        body: { rating: 4, comment: 'Trying to edit a review that no longer exists at all here.' },
      })
    ).status,
    404,
  );
});

test('a user_id in the request body is ignored', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const victim = addReview(app.db, 'blue-door-cafe', {
    email: 'victim@example.com',
    firstName: 'Vic',
    rating: 5,
    comment: 'A review belonging to somebody else entirely, left well before this test ran.',
  });

  const client = app.client();
  await signIn(app, client, 'attacker@example.com', 'Ada');

  const posted = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: {
      user_id: victim.id,
      userId: victim.id,
      rating: 1,
      comment: 'A review posted while trying to pass somebody else user id in the body.',
    },
  });
  assert.equal(posted.status, 201, posted.text);

  // The new review is attributed to the session, not to the id in the body.
  const admin = await app
    .client()
    .request('/api/admin/businesses/1/reviews', { admin: app.config.adminToken });
  const mine = admin.json.reviews.find((review) => review.id === posted.json.review.id);
  assert.equal(mine.user.email, 'attacker@example.com');

  // The victim's review is unchanged, and the edit route cannot reach it.
  const edit = await client.request('/api/b/blue-door-cafe/reviews/me', {
    method: 'PUT',
    body: { user_id: victim.id, rating: 5, comment: 'Trying to rewrite the other person review.' },
  });
  assert.equal(edit.status, 200);
  const victimReview = admin.json.reviews.find((review) => review.user.email === 'victim@example.com');
  assert.match(victimReview.comment, /belonging to somebody else/);
});

// ----------------------------------------------------------- access and CSRF

test('a customer reviews without being asked for an email or a name', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();

  // Scan, and that is the whole introduction.
  const profile = await client.request('/api/b/blue-door-cafe');
  assert.equal(profile.status, 200);
  assert.equal(profile.json.me.verified, false);
  assert.equal(profile.json.business.requireEmail, false);
  assert.ok(client.jar.has('rq_device'), 'the scan hands out a device cookie');

  // Nothing has been stored for someone who only looked.
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 4);

  const suggested = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 5, topics: ['Food', 'Service'], note: '' },
  });
  assert.equal(suggested.status, 200, suggested.text);

  const posted = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: suggested.json.drafts[0] },
  });
  assert.equal(posted.status, 201, posted.text);

  const after = await client.request('/api/b/blue-door-cafe');
  assert.equal(after.json.stats.count, 5);
  assert.equal(after.json.reviews[0].comment, suggested.json.drafts[0]);
  // No name was ever asked for, so the review is shown without one.
  assert.equal(after.json.reviews[0].firstName, 'A customer');
  assert.ok(after.json.me.review, 'coming back shows their own review');
  assert.equal(after.json.me.verified, false);

  // No email address was stored anywhere for them.
  const row = app.db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.email, null);
  assert.equal(row.first_name, '');
  assert.equal(typeof row.device_hash, 'string');
});

test('one review per device, and a different device can still review', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const phone = app.client();
  await phone.request('/api/b/blue-door-cafe');
  const first = await phone.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: 'A first review left from this phone, with no sign-in at all.' },
  });
  assert.equal(first.status, 201, first.text);

  const second = await phone.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 1, comment: 'A second review from the very same phone, which must be refused.' },
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'You already reviewed this business.');

  // Somebody else's phone is a different device, so they can review.
  const otherPhone = app.client();
  await otherPhone.request('/api/b/blue-door-cafe');
  const theirs = await otherPhone.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 4, comment: 'A review from a different phone entirely, which is allowed.' },
  });
  assert.equal(theirs.status, 201, theirs.text);
  assert.equal((await phone.request('/api/b/blue-door-cafe')).json.stats.count, 6);
});

test('editing and deleting still only reach your own review, with no sign-in', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const mine = app.client();
  const theirs = app.client();
  await mine.request('/api/b/blue-door-cafe');
  await theirs.request('/api/b/blue-door-cafe');

  const theirText = 'Their review, left from another device and not mine to touch at all.';
  await mine.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: 'My own review, left from my own phone without any sign-in.' },
  });
  await theirs.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 2, comment: theirText },
  });

  const edited = await mine.request('/api/b/blue-door-cafe/reviews/me', {
    method: 'PUT',
    body: { rating: 4, comment: 'My own review, now edited from the same phone that wrote it.' },
  });
  assert.equal(edited.status, 200, edited.text);
  assert.equal((await theirs.request('/api/b/blue-door-cafe')).json.me.review.comment, theirText);

  assert.equal((await mine.request('/api/b/blue-door-cafe/reviews/me', { method: 'DELETE' })).status, 200);
  assert.equal((await theirs.request('/api/b/blue-door-cafe')).json.me.review.comment, theirText);

  // A device that never reviewed has nothing to edit or delete.
  const stranger = app.client();
  await stranger.request('/api/b/blue-door-cafe');
  assert.equal(
    (await stranger.request('/api/b/blue-door-cafe/reviews/me', { method: 'DELETE' })).status,
    404,
  );
  assert.equal(
    (await stranger.request('/api/b/blue-door-cafe/reviews/me', {
      method: 'PUT',
      body: { rating: 5, comment: 'Trying to edit a review this device never wrote in the first place.' },
    })).status,
    404,
  );
});

test('a business can still insist on a verified email', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const created = await app.client().request('/api/admin/businesses', {
    method: 'POST',
    body: { name: 'Members Only Club', requireEmail: true },
    admin: app.config.adminToken,
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.business.requireEmail, true);

  const client = app.client();
  const profile = await client.request('/api/b/members-only-club');
  assert.equal(profile.json.business.requireEmail, true);

  // Without an email session, neither drafting nor posting is allowed.
  const suggest = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'members-only-club', rating: 5, topics: [], note: '' },
  });
  assert.equal(suggest.status, 401);
  const post = await client.request('/api/b/members-only-club/reviews', {
    method: 'POST',
    body: { rating: 5, comment: 'Trying to post without the verification this business asks for.' },
  });
  assert.equal(post.status, 401);
  assert.equal(app.model.calls.length, 0, 'the model is not called for a visitor who cannot post');

  // After verifying, the same customer goes through.
  await signIn(app, client, 'member@example.com', 'Mem');
  const allowed = await client.request('/api/b/members-only-club/reviews', {
    method: 'POST',
    body: { rating: 5, comment: 'A review posted after verifying an email, as this business asks.' },
  });
  assert.equal(allowed.status, 201, allowed.text);
  const after = await client.request('/api/b/members-only-club');
  assert.equal(after.json.reviews[0].firstName, 'Mem');
  assert.equal(after.json.me.verified, true);
});

test('the device cookie is HttpOnly and long lived', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const response = await app.client().request('/api/b/blue-door-cafe');
  const device = response.headers.getSetCookie().find((value) => value.startsWith('rq_device='));
  assert.match(device, /HttpOnly/);
  assert.match(device, /SameSite=Lax/);
  const maxAge = Number(/Max-Age=(\d+)/.exec(device)[1]);
  assert.ok(maxAge > 300 * 24 * 60 * 60, 'the device should be remembered for months');
});

test('moderation can tell devices apart without an email', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const one = app.client();
  const two = app.client();
  await one.request('/api/b/blue-door-cafe');
  await two.request('/api/b/blue-door-cafe');
  await one.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: 'One device leaving a perfectly ordinary review on the wall here.' },
  });
  await two.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 1, comment: 'Another device leaving a much less complimentary review here.' },
  });

  const listed = await app.client().request('/api/admin/reviews', { admin: app.config.adminToken });
  const devices = listed.json.reviews.filter((review) => !review.user.email);
  assert.equal(devices.length, 2);
  assert.match(devices[0].user.label, /^Device [0-9a-f]{8}$/);
  assert.notEqual(devices[0].user.label, devices[1].user.label, 'two devices look different');

  // Suspending the device behind the 1-star review stops it posting again.
  const target = devices.find((review) => review.comment.startsWith('Another device'));
  const suspended = await app.client().request(`/api/admin/users/${target.user.id}`, {
    method: 'PATCH',
    body: { suspended: true },
    admin: app.config.adminToken,
  });
  assert.equal(suspended.status, 200);
  await two.request('/api/b/blue-door-cafe/reviews/me', { method: 'DELETE' });
  const blocked = await two.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 1, comment: 'A suspended device trying to come back and post another review.' },
  });
  assert.equal(blocked.status, 403);
});

test('a missing or mismatched CSRF token is rejected', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'csrf@example.com', 'Cas');

  const body = { rating: 5, comment: 'A review submitted without the double-submit CSRF token.' };

  const missing = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body,
    csrf: false,
  });
  assert.equal(missing.status, 403);

  const wrong = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body,
    headers: { 'x-csrf-token': 'not-the-right-token' },
  });
  assert.equal(wrong.status, 403);

  const suggest = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 5, topics: [], note: '' },
    csrf: false,
  });
  assert.equal(suggest.status, 403);

  // With the token it goes through, so the rejection was the CSRF check.
  const ok = await client.request('/api/b/blue-door-cafe/reviews', { method: 'POST', body });
  assert.equal(ok.status, 201, ok.text);
});

test('the session cookie is HttpOnly and SameSite=Lax', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await client.request('/api/auth/me');
  await client.request('/api/auth/request-code', {
    method: 'POST',
    body: { email: 'cookie@example.com', firstName: 'Coo' },
  });
  const code = app.mailer.sent.at(-1).code;
  const verified = await client.request('/api/auth/verify-code', {
    method: 'POST',
    body: { email: 'cookie@example.com', code },
  });
  const cookies = verified.headers.getSetCookie();
  const session = cookies.find((value) => value.startsWith('rq_session='));
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Lax/);
  // Not Secure outside production, or the cookie would be dropped over http.
  assert.doesNotMatch(session, /Secure/);
  const csrf = cookies.find((value) => value.startsWith('rq_csrf='));
  assert.doesNotMatch(csrf, /HttpOnly/);
});

// --------------------------------------------------------------- login codes

test('a wrong code fails, and attempts are limited to five', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await client.request('/api/auth/me');
  await client.request('/api/auth/request-code', {
    method: 'POST',
    body: { email: 'attempts@example.com', firstName: 'Att' },
  });
  const real = app.mailer.sent.at(-1).code;
  const wrong = real === '000000' ? '111111' : '000000';

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await client.request('/api/auth/verify-code', {
      method: 'POST',
      body: { email: 'attempts@example.com', code: wrong },
    });
    assert.equal(response.status, 400, `attempt ${attempt}: ${response.text}`);
  }

  const blocked = await client.request('/api/auth/verify-code', {
    method: 'POST',
    body: { email: 'attempts@example.com', code: wrong },
  });
  assert.equal(blocked.status, 429);

  // Even the real code no longer works once the attempts are spent.
  const tooLate = await client.request('/api/auth/verify-code', {
    method: 'POST',
    body: { email: 'attempts@example.com', code: real },
  });
  assert.equal(tooLate.status, 429);
  assert.equal((await client.request('/api/auth/me')).json.signedIn, false);
});

test('an expired code fails', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await client.request('/api/auth/me');
  await client.request('/api/auth/request-code', {
    method: 'POST',
    body: { email: 'expired@example.com', firstName: 'Exp' },
  });
  const code = app.mailer.sent.at(-1).code;

  app.db.prepare('UPDATE login_codes SET expires_at = ? WHERE email = ?')
    .run(Date.now() - 1000, 'expired@example.com');

  const response = await client.request('/api/auth/verify-code', {
    method: 'POST',
    body: { email: 'expired@example.com', code },
  });
  assert.equal(response.status, 400);
  assert.match(response.json.error, /expired/i);
  assert.equal((await client.request('/api/auth/me')).json.signedIn, false);
});

test('a code cannot be reused', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  const { code } = await signIn(app, client, 'reuse@example.com', 'Reu');

  await client.request('/api/auth/logout', { method: 'POST' });
  const again = await client.request('/api/auth/verify-code', {
    method: 'POST',
    body: { email: 'reuse@example.com', code },
  });
  assert.equal(again.status, 400);
  assert.equal((await client.request('/api/auth/me')).json.signedIn, false);
});

test('asking for a new code invalidates the previous one', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await client.request('/api/auth/me');
  for (let i = 0; i < 2; i += 1) {
    await client.request('/api/auth/request-code', {
      method: 'POST',
      body: { email: 'rotate@example.com', firstName: 'Rot' },
    });
  }
  const [first, second] = app.mailer.sent.slice(-2).map((entry) => entry.code);
  assert.notEqual(first, second);

  const stale = await client.request('/api/auth/verify-code', {
    method: 'POST',
    body: { email: 'rotate@example.com', code: first },
  });
  assert.equal(stale.status, 400);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM login_codes').get().c, 1);
});

test('login codes are stored hashed, never in the clear', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await client.request('/api/auth/me');
  await client.request('/api/auth/request-code', {
    method: 'POST',
    body: { email: 'hashed@example.com', firstName: 'Has' },
  });
  const code = app.mailer.sent.at(-1).code;
  const row = app.db.prepare('SELECT * FROM login_codes WHERE email = ?').get('hashed@example.com');
  assert.notEqual(row.code_hash, code);
  assert.equal(row.code_hash.length, 64);
  assert.equal(row.attempts, 0);
});

test('the reply to a code request is the same whether or not the address is known', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'known@example.com', 'Kno');

  const fresh = app.client();
  await fresh.request('/api/auth/me');
  const forKnown = await fresh.request('/api/auth/request-code', {
    method: 'POST',
    body: { email: 'known@example.com', firstName: 'Kno' },
  });
  const forUnknown = await fresh.request('/api/auth/request-code', {
    method: 'POST',
    body: { email: 'nobody-here@example.com', firstName: 'Nob' },
  });
  assert.equal(forKnown.status, forUnknown.status);
  assert.deepEqual(forKnown.json, forUnknown.json);
});

test('the honeypot field quietly drops a submission without sending a code', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await client.request('/api/auth/me');
  const response = await client.request('/api/auth/request-code', {
    method: 'POST',
    body: { email: 'bot@example.com', firstName: 'Bot', company: 'Acme Spam Co' },
  });
  assert.equal(response.status, 200);
  assert.equal(app.mailer.sent.length, 0);
});

test('a code request is limited to five an hour for one address', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await client.request('/api/auth/me');
  for (let i = 0; i < 5; i += 1) {
    await client.request('/api/auth/request-code', {
      method: 'POST',
      body: { email: 'floody@example.com', firstName: 'Flo' },
    });
  }
  assert.equal(app.mailer.sent.length, 5);

  const sixth = await client.request('/api/auth/request-code', {
    method: 'POST',
    body: { email: 'floody@example.com', firstName: 'Flo' },
  });
  // Same reply as a success, but no sixth email.
  assert.equal(sixth.status, 200);
  assert.equal(app.mailer.sent.length, 5);
});

// ------------------------------------------------------------- AI guardrails

test('the model is only told the rating, topics, note, business name and category', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'privacy@example.com', 'Pria');

  const response = await client.request('/api/suggest', {
    method: 'POST',
    body: {
      slug: 'blue-door-cafe',
      rating: 4,
      topics: ['Service', 'Atmosphere'],
      note: 'Table by the window',
    },
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(app.model.calls.length, 1);

  const call = app.model.calls[0];
  const prompt = call.body.messages[0].content;
  const whole = JSON.stringify(call.body);

  // Everything the customer gave is there.
  assert.match(prompt, /Blue Door Caf/);
  assert.match(prompt, /4 out of 5/);
  assert.match(prompt, /Service, Atmosphere/);
  assert.match(prompt, /Table by the window/);

  // Nothing identifying is.
  assert.doesNotMatch(whole, /privacy@example\.com/);
  assert.doesNotMatch(whole, /Pria/);
  assert.doesNotMatch(whole, /127\.0\.0\.1/);
  assert.doesNotMatch(whole, /user_id|userId/);
  assert.doesNotMatch(prompt, /Price|Cleanliness/, 'topics the customer did not choose');

  // And the system prompt carries the no-invention rule.
  assert.match(call.body.system, /Never invent dishes, staff names, prices/);
  assert.match(call.body.system, /JSON array/);
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.headers['x-api-key'], 'test-key');
});

test('drafts outside 20 to 400 characters are dropped, and the set is topped up', async (t) => {
  const model = createModelMock(() =>
    modelResponse([
      'too short',
      LONG(620),
      'A good visit overall, with attentive service from the moment I walked in.',
      'The room was clean and the staff were friendly, so I left in a good mood.',
      '   A third usable draft, padded out so that it clears the minimum length.   ',
    ]),
  );
  const app = await startApp({ model });
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'lengths@example.com', 'Len');

  const response = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 4, topics: ['Service'], note: '' },
  });
  assert.equal(response.status, 200, response.text);

  const drafts = response.json.drafts;
  assert.ok(!drafts.includes('too short'));
  assert.ok(drafts.every((draft) => draft.length >= 20 && draft.length <= 400));
  assert.ok(!drafts.some((draft) => draft.startsWith('This is review text that goes on. This')));
  // The three usable ones survived, trimmed, and templates made up the rest.
  assert.ok(drafts.includes('A third usable draft, padded out so that it clears the minimum length.'));
  assert.ok(drafts.length >= 5 && drafts.length <= 7);
  assert.equal(response.json.source, 'mixed');
});

test('duplicate drafts are removed', async (t) => {
  const model = createModelMock(() =>
    modelResponse([
      'A pleasant visit with attentive service and a room that felt clean and calm.',
      'A pleasant visit with attentive service and a room that felt clean and calm.',
      'A PLEASANT VISIT WITH ATTENTIVE SERVICE AND A ROOM THAT FELT CLEAN AND CALM.'.toLowerCase(),
    ]),
  );
  const app = await startApp({ model });
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'dupes@example.com', 'Dup');

  const response = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 5, topics: [], note: '' },
  });
  const unique = new Set(response.json.drafts.map((draft) => draft.toLowerCase()));
  assert.equal(unique.size, response.json.drafts.length);
});

test('template drafts are used when the model call fails', async (t) => {
  const model = createModelMock(() => {
    throw new Error('connection reset');
  });
  const app = await startApp({ model });
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'offline@example.com', 'Off');

  const response = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 2, topics: ['Price', 'Service'], note: 'Long wait' },
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.source, 'template');
  assert.ok(response.json.drafts.length >= 5 && response.json.drafts.length <= 7);
  for (const draft of response.json.drafts) {
    assert.ok(draft.length >= 20 && draft.length <= 400);
  }
  // Sentiment follows the stars: two stars should not read as praise.
  assert.ok(response.json.drafts.some((draft) => /Disappointing|fell short|did not/.test(draft)));
});

test('template drafts are used when there is no API key, and the model is never called', async (t) => {
  const model = createModelMock(() => modelResponse(DEFAULT_DRAFTS));
  const app = await startApp({ model, env: { ANTHROPIC_API_KEY: '' } });
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'nokey@example.com', 'Nok');

  const response = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 5, topics: ['Food'], note: '' },
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.source, 'template');
  assert.equal(model.calls.length, 0);
});

test('a model refusal and a non-JSON reply both fall back to templates', async (t) => {
  const refusal = {
    ok: true,
    status: 200,
    async json() {
      return { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null }, content: [] };
    },
    async text() {
      return '';
    },
  };
  const prose = {
    ok: true,
    status: 200,
    async json() {
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry, I cannot help.' }] };
    },
    async text() {
      return '';
    },
  };
  const model = createModelMock((body, call) => (call === 1 ? refusal : prose));
  const app = await startApp({ model });
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'refused@example.com', 'Ref');

  for (let i = 0; i < 2; i += 1) {
    const response = await client.request('/api/suggest', {
      method: 'POST',
      body: { slug: 'blue-door-cafe', rating: 3, topics: ['Food'], note: '' },
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.source, 'template');
    assert.ok(response.json.drafts.length >= 5);
  }
});

test('suggestions are limited to ten an hour per person', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'greedy@example.com', 'Gre');

  for (let i = 0; i < 10; i += 1) {
    const response = await client.request('/api/suggest', {
      method: 'POST',
      body: { slug: 'blue-door-cafe', rating: 5, topics: [], note: '' },
    });
    assert.equal(response.status, 200, `request ${i + 1}: ${response.text}`);
  }
  const blocked = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 5, topics: [], note: '' },
  });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
  assert.equal(app.model.calls.length, 10);
});

test('a rating is required before drafts are suggested', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'norating@example.com', 'Nor');

  for (const rating of [undefined, 0, 6, 2.5, 'five']) {
    const response = await client.request('/api/suggest', {
      method: 'POST',
      body: { slug: 'blue-door-cafe', rating, topics: [], note: '' },
    });
    assert.equal(response.status, 400, `rating ${String(rating)}`);
  }
  assert.equal(app.model.calls.length, 0);
});

// ------------------------------------------------------- suspension and hiding

test('a suspended person cannot post, edit or sign in', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'suspended@example.com', 'Sus');

  const user = app.db.prepare('SELECT id FROM users WHERE email = ?').get('suspended@example.com');
  // Suspend through the admin API, as a moderator would.
  const suspended = await app.client().request(`/api/admin/users/${user.id}`, {
    method: 'PATCH',
    body: { suspended: true },
    admin: app.config.adminToken,
  });
  assert.equal(suspended.status, 200, suspended.text);

  // Their session was ended, so they are signed out.
  assert.equal((await client.request('/api/auth/me')).json.signedIn, false);

  // And they cannot sign back in: no new code is sent to the address.
  const sentBefore = app.mailer.sent.length;
  const fresh = app.client();
  await fresh.request('/api/auth/me');
  const requested = await fresh.request('/api/auth/request-code', {
    method: 'POST',
    body: { email: 'suspended@example.com', firstName: 'Sus' },
  });
  assert.equal(requested.status, 200, 'the reply must not reveal the suspension');
  assert.equal(app.mailer.sent.length, sentBefore, 'no code should be sent to a suspended address');

  // Even with a session row that predates the suspension, posting is refused.
  const stillSuspended = app.db
    .prepare('SELECT suspended FROM users WHERE id = ?')
    .get(user.id).suspended;
  assert.equal(stillSuspended, 1);
});

test('a session that survives a suspension cannot post', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'latent@example.com', 'Lat');

  // Suspend the row directly, leaving the session in place.
  app.db.prepare('UPDATE users SET suspended = 1 WHERE email = ?').run('latent@example.com');

  const posted = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: 'A review from somebody who has since been suspended by admin.' },
  });
  assert.equal(posted.status, 403);
  const suggest = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 5, topics: [], note: '' },
  });
  assert.equal(suggest.status, 403);
});

test('a hidden review disappears from the profile but the rest stay', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const before = await app.client().request('/api/b/blue-door-cafe');
  assert.equal(before.json.stats.count, 4);
  const target = before.json.reviews[0];

  const hidden = await app.client().request(`/api/admin/reviews/${target.id}`, {
    method: 'PATCH',
    body: { status: 'hidden' },
    admin: app.config.adminToken,
  });
  assert.equal(hidden.status, 200, hidden.text);

  const after = await app.client().request('/api/b/blue-door-cafe');
  assert.equal(after.json.stats.count, 3);
  assert.ok(after.json.reviews.every((review) => review.id !== target.id));

  // Showing it again brings it back.
  await app.client().request(`/api/admin/reviews/${target.id}`, {
    method: 'PATCH',
    body: { status: 'visible' },
    admin: app.config.adminToken,
  });
  const restored = await app.client().request('/api/b/blue-door-cafe');
  assert.equal(restored.json.stats.count, 4);
});

// --------------------------------------------------------------- data leakage

test('public responses never contain an email address or a user id', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'leak-check@example.com', 'Lea');
  await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: 'A review used to check that no private fields leak out at all.' },
  });

  const paths = ['/api/b/blue-door-cafe', '/api/auth/me'];
  for (const path of paths) {
    for (const who of [client, app.client()]) {
      const response = await who.request(path);
      assert.equal(response.status, 200);
      assert.doesNotMatch(response.text, /@example\.com/, `${path} leaked an email`);
      assert.doesNotMatch(response.text, /"user_id"|"userId"/, `${path} leaked a user id`);
      assert.doesNotMatch(response.text, /@/, `${path} contains an address-like string`);
      assert.doesNotMatch(response.text, /"email"/, `${path} leaked an email field`);
    }
  }

  const profile = await client.request('/api/b/blue-door-cafe');
  // The business's reply is public by design; it still says nothing about who
  // wrote the review it answers.
  assert.deepEqual(Object.keys(profile.json.reviews[0]).sort(), [
    'comment',
    'createdAt',
    'firstName',
    'id',
    'rating',
    'repliedAt',
    'reply',
  ]);
});

test('the suggest response does not echo anything private back', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'echo@example.com', 'Ech');
  const response = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 5, topics: ['Food'], note: 'note text' },
  });
  assert.doesNotMatch(response.text, /@example\.com/);
  assert.doesNotMatch(response.text, /"user_id"|"userId"/);
});

// --------------------------------------------------------------- input limits

test('review text is checked for length and a rating is required', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'limits@example.com', 'Lim');

  const tooShort = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: 'Too short' },
  });
  assert.equal(tooShort.status, 400);
  assert.match(tooShort.json.error, /between 20 and 400/);

  const tooLong = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: LONG(500) },
  });
  assert.equal(tooLong.status, 400);

  const noRating = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { comment: 'A review with a perfectly reasonable length but no star rating at all.' },
  });
  assert.equal(noRating.status, 400);

  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM reviews').get().c, 4);
});

test('a body over 10kb is rejected', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'big@example.com', 'Big');
  const response = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: 'x'.repeat(20000) },
  });
  assert.equal(response.status, 413);
});

test('security headers are set on every response', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const response = await app.client().request('/api/b/blue-door-cafe');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-powered-by'), null);
});

// ------------------------------------------------------------------ QR codes

test('QR codes are served as PNG and SVG, with an optional download', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();

  const png = await fetch(`${app.base}/api/b/blue-door-cafe/qr.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await png.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.match(png.headers.get('content-disposition'), /^inline/);

  const svg = await client.request('/api/b/blue-door-cafe/qr.svg');
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(svg.text, /<svg/);

  const download = await client.request('/api/b/blue-door-cafe/qr.png?download=1');
  assert.match(download.headers.get('content-disposition'), /attachment; filename="blue-door-cafe-qr\.png"/);

  assert.equal((await client.request('/api/b/nope/qr.png')).status, 404);
});

// --------------------------------------------------------------------- admin

test('admin endpoints reject a missing or wrong password', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();

  const calls = [
    ['/api/admin/businesses', 'GET', undefined],
    ['/api/admin/businesses', 'POST', { name: 'Sneaky Shop' }],
    ['/api/admin/businesses/1', 'DELETE', undefined],
    ['/api/admin/businesses/1/reviews', 'GET', undefined],
    ['/api/admin/reviews', 'GET', undefined],
    ['/api/admin/reviews/1', 'PATCH', { status: 'hidden' }],
    ['/api/admin/reviews/1', 'DELETE', undefined],
    ['/api/admin/users', 'GET', undefined],
    ['/api/admin/users/1', 'PATCH', { suspended: true }],
  ];

  for (const [path, method, body] of calls) {
    const missing = await client.request(path, { method, body });
    assert.equal(missing.status, 401, `${method} ${path} without a password`);
    const wrong = await client.request(path, { method, body, admin: 'not-the-password' });
    assert.equal(wrong.status, 401, `${method} ${path} with the wrong password`);
    const close = await client.request(path, { method, body, admin: 'test-admin-token-012345678' });
    assert.equal(close.status, 401, `${method} ${path} with a truncated password`);
  }

  // Nothing was changed by any of that.
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM businesses').get().c, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM reviews').get().c, 4);
});

test('an admin creates a business with a unique slug, sees its QR code and deletes it', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();

  const first = await client.request('/api/admin/businesses', {
    method: 'POST',
    body: {
      name: 'Blue Door Café',
      category: 'Café',
      address: '2 Mill Street',
      description: 'A second branch.',
    },
    admin,
  });
  assert.equal(first.status, 201, first.text);
  // The seeded demo already owns blue-door-cafe.
  assert.equal(first.json.business.slug, 'blue-door-cafe-2');
  assert.equal(first.json.business.url, 'http://localhost:3000/b/blue-door-cafe-2');

  const listed = await client.request('/api/admin/businesses', { admin });
  assert.equal(listed.json.businesses.length, 2);
  const created = listed.json.businesses.find((business) => business.id === first.json.business.id);
  assert.equal(created.reviewCount, 0);
  assert.equal(created.qrPng, '/api/b/blue-door-cafe-2/qr.png');

  const qr = await client.request('/api/b/blue-door-cafe-2/qr.svg');
  assert.equal(qr.status, 200);

  const deleted = await client.request(`/api/admin/businesses/${created.id}`, {
    method: 'DELETE',
    admin,
  });
  assert.equal(deleted.status, 200);
  assert.equal((await client.request('/api/b/blue-door-cafe-2')).status, 404);
  assert.equal((await client.request('/api/admin/businesses', { admin })).json.businesses.length, 1);
});

test('deleting a business removes its reviews', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const business = app.db.prepare('SELECT id FROM businesses WHERE slug = ?').get('blue-door-cafe');

  const response = await app.client().request(`/api/admin/businesses/${business.id}`, {
    method: 'DELETE',
    admin,
  });
  assert.equal(response.status, 200);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM reviews').get().c, 0);
});

test('an admin can moderate and delete reviews, and sees reviewer emails', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();

  const all = await client.request('/api/admin/reviews', { admin });
  assert.equal(all.status, 200);
  assert.equal(all.json.reviews.length, 4);
  assert.match(all.json.reviews[0].user.email, /@example\.com$/);
  assert.equal(all.json.reviews[0].businessName, 'Blue Door Café');

  const target = all.json.reviews[0];
  const deleted = await client.request(`/api/admin/reviews/${target.id}`, { method: 'DELETE', admin });
  assert.equal(deleted.status, 200);
  assert.equal((await client.request('/api/admin/reviews', { admin })).json.reviews.length, 3);

  assert.equal(
    (await client.request('/api/admin/reviews/9999', { method: 'PATCH', body: { status: 'hidden' }, admin })).status,
    404,
  );
  assert.equal(
    (await client.request(`/api/admin/reviews/${all.json.reviews[1].id}`, {
      method: 'PATCH',
      body: { status: 'nonsense' },
      admin,
    })).status,
    400,
  );
});

test('an admin suspends and unsuspends a person', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();

  const users = await client.request('/api/admin/users', { admin });
  assert.equal(users.status, 200);
  const target = users.json.users.find((user) => user.email === 'maya@example.com');
  assert.equal(target.suspended, false);
  assert.equal(target.reviewCount, 1);

  const suspended = await client.request(`/api/admin/users/${target.id}`, {
    method: 'PATCH',
    body: { suspended: true },
    admin,
  });
  assert.equal(suspended.json.suspended, true);

  const restored = await client.request(`/api/admin/users/${target.id}`, {
    method: 'PATCH',
    body: { suspended: false },
    admin,
  });
  assert.equal(restored.json.suspended, false);

  assert.equal(
    (await client.request(`/api/admin/users/${target.id}`, { method: 'PATCH', body: {}, admin })).status,
    400,
  );
  assert.equal(
    (await client.request('/api/admin/users/9999', { method: 'PATCH', body: { suspended: true }, admin })).status,
    404,
  );
});

// --------------------------------------------- per-business feature switches

test('a new business has every integration on, and the admin can switch each one off', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();

  const created = await client.request('/api/admin/businesses', {
    method: 'POST',
    body: { name: 'Switch Test Garage' },
    admin,
  });
  assert.equal(created.status, 201, created.text);
  // On by default, so a business behaves as the server is configured.
  assert.equal(created.json.business.aiDrafts, true);
  assert.equal(created.json.business.googleSignin, true);
  assert.equal(created.json.business.requireEmail, false);

  const id = created.json.business.id;
  const patched = await client.request(`/api/admin/businesses/${id}`, {
    method: 'PATCH',
    body: { aiDrafts: false, googleSignin: false, requireEmail: true },
    admin,
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.business.aiDrafts, false);
  assert.equal(patched.json.business.googleSignin, false);
  assert.equal(patched.json.business.requireEmail, true);

  // And back again, one switch at a time, without disturbing the others.
  const back = await client.request(`/api/admin/businesses/${id}`, {
    method: 'PATCH',
    body: { aiDrafts: true },
    admin,
  });
  assert.equal(back.json.business.aiDrafts, true);
  assert.equal(back.json.business.googleSignin, false);
  assert.equal(back.json.business.requireEmail, true);

  const listed = (await client.request('/api/admin/businesses', { admin })).json.businesses.find(
    (row) => row.id === id,
  );
  assert.equal(listed.aiDrafts, true);
  assert.equal(listed.googleSignin, false);
});

test('a business can be created with the switches already off', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const created = await app.client().request('/api/admin/businesses', {
    method: 'POST',
    body: { name: 'Templates Only Bakery', aiDrafts: false, googleSignin: false },
    admin: app.config.adminToken,
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.business.aiDrafts, false);
  assert.equal(created.json.business.googleSignin, false);
});

test('an edit that mentions no switch leaves all three alone', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();

  const created = await client.request('/api/admin/businesses', {
    method: 'POST',
    body: { name: 'Untouched Switches Ltd', aiDrafts: false, requireEmail: true },
    admin,
  });
  const id = created.json.business.id;

  const renamed = await client.request(`/api/admin/businesses/${id}`, {
    method: 'PATCH',
    body: { name: 'Untouched Switches Limited' },
    admin,
  });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.json.business.name, 'Untouched Switches Limited');
  assert.equal(renamed.json.business.aiDrafts, false);
  assert.equal(renamed.json.business.requireEmail, true);
  assert.equal(renamed.json.business.googleSignin, true);
});

test('with AI drafts off for a business, the model is never called for it', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();

  const created = await client.request('/api/admin/businesses', {
    method: 'POST',
    body: { name: 'No Model Noodles', aiDrafts: false },
    admin,
  });
  assert.equal(created.status, 201, created.text);

  await client.request('/api/auth/me');
  const suggested = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: created.json.business.slug, rating: 5, topics: [], note: '' },
  });
  assert.equal(suggested.status, 200, suggested.text);
  assert.equal(suggested.json.source, 'template');
  assert.ok(suggested.json.drafts.length >= 5);
  // The server holds an API key; this business simply does not use it.
  assert.equal(app.config.anthropic.apiKey, 'test-key');
  assert.equal(app.model.calls.length, 0);

  // Another business on the same server still gets model drafts.
  const normal = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 5, topics: ['Service'], note: '' },
  });
  assert.equal(normal.status, 200, normal.text);
  assert.equal(normal.json.source, 'ai');
  assert.equal(app.model.calls.length, 1);
});

test('with Google sign-in off for a business, its page is never given the client id', async (t) => {
  const app = await startApp({ env: { GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com' } });
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();

  // On by default, so the prompt appears wherever the server is configured.
  assert.equal(
    (await client.request('/api/b/blue-door-cafe')).json.googleClientId,
    'test-client-id.apps.googleusercontent.com',
  );

  const created = await client.request('/api/admin/businesses', {
    method: 'POST',
    body: { name: 'No Prompt Pizzeria', googleSignin: false },
    admin,
  });
  const profile = await client.request(`/api/b/${created.json.business.slug}`);
  assert.equal(profile.status, 200, profile.text);
  assert.equal(profile.json.googleClientId, '');
});

test('a database from before the switches gets them switched on', async () => {
  const db = openDb(':memory:');
  db.exec('DROP TABLE businesses');
  db.exec(`CREATE TABLE businesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  db.prepare('INSERT INTO businesses (slug, name, created_at) VALUES (?, ?, ?)')
    .run('old-shop', 'Old Shop', nowIso());

  migrate(db);
  const row = db.prepare('SELECT * FROM businesses WHERE slug = ?').get('old-shop');
  // An existing install keeps behaving exactly as it did before the upgrade.
  assert.equal(row.ai_drafts, 1);
  assert.equal(row.google_signin, 1);
  assert.equal(row.require_email, 0);

  assert.equal(setBusinessSwitches(db, row.id, { aiDrafts: false }), true);
  assert.equal(setBusinessSwitches(db, row.id, { nonsense: true }), false);
  const after = db.prepare('SELECT * FROM businesses WHERE id = ?').get(row.id);
  assert.equal(after.ai_drafts, 0);
  assert.equal(after.google_signin, 1);
  db.close();
});

// ------------------------------------------------------- replying to reviews

const REPLY = 'Sorry about the cold room. The radiator was fixed on Tuesday.';

// Posts one review as a fresh customer and hands back what the server stored.
async function postReview(app, client, comment, rating = 2) {
  await client.request('/api/auth/me');
  const posted = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating, comment },
  });
  assert.equal(posted.status, 201, posted.text);
  return posted.json.review;
}

test('a business replies to a review, and the reply reaches everyone who can see it', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();

  const review = await postReview(
    app,
    client,
    'The room was cold and I waited a long time for a flat white.',
  );
  assert.equal(review.reply, '');
  assert.equal(review.repliedAt, null);

  const replied = await app.client().request(`/api/admin/reviews/${review.id}/reply`, {
    method: 'PUT',
    body: { reply: `   ${REPLY.replace('the cold', 'the   cold')}  ` },
    admin,
  });
  assert.equal(replied.status, 200, replied.text);
  // Whitespace is collapsed, the same as every other string we store.
  assert.equal(replied.json.reply, REPLY);
  assert.ok(replied.json.repliedAt);

  // On the public list, under the review it answers.
  const profile = await app.client().request('/api/b/blue-door-cafe');
  const listed = profile.json.reviews.find((row) => row.id === review.id);
  assert.equal(listed.reply, REPLY);
  assert.equal(listed.repliedAt, replied.json.repliedAt);
  // A review with no reply says so plainly rather than leaving the field out.
  const unanswered = profile.json.reviews.filter((row) => row.reply === '');
  assert.ok(unanswered.length > 0);
  assert.ok(unanswered.every((row) => row.repliedAt === null));

  // To the reviewer, on their own review.
  const mine = await client.request('/api/b/blue-door-cafe');
  assert.equal(mine.json.me.review.reply, REPLY);
  assert.equal(mine.json.me.review.repliedAt, replied.json.repliedAt);

  // And in the moderation list, so the business can see what it said.
  const moderation = await app.client().request('/api/admin/reviews', { admin });
  const row = moderation.json.reviews.find((entry) => entry.id === review.id);
  assert.equal(row.reply, REPLY);
  assert.equal(row.repliedAt, replied.json.repliedAt);
});

test('a reply can be rewritten and taken down', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();

  // The demo business ships with one answered review.
  const seeded = (await client.request('/api/admin/reviews', { admin })).json.reviews.find(
    (row) => row.reply,
  );
  assert.ok(seeded, 'the demo data should include a reply');

  const rewritten = await client.request(`/api/admin/reviews/${seeded.id}/reply`, {
    method: 'PUT',
    body: { reply: 'Thank you for coming back to tell us. The second till is there to stay.' },
    admin,
  });
  assert.equal(rewritten.status, 200, rewritten.text);
  assert.notEqual(rewritten.json.reply, seeded.reply);

  let listed = (await client.request('/api/b/blue-door-cafe')).json.reviews.find(
    (row) => row.id === seeded.id,
  );
  assert.equal(listed.reply, rewritten.json.reply);

  const removed = await client.request(`/api/admin/reviews/${seeded.id}/reply`, {
    method: 'DELETE',
    admin,
  });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.json.reply, '');
  assert.equal(removed.json.repliedAt, null);

  // Gone from the public page, while the review itself stays put.
  listed = (await client.request('/api/b/blue-door-cafe')).json.reviews.find(
    (row) => row.id === seeded.id,
  );
  assert.equal(listed.reply, '');
  assert.equal(listed.repliedAt, null);
  assert.equal(listed.comment, seeded.comment);
});

test('a reply is checked for length, a real review and the admin password', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();
  const review = (await client.request('/api/admin/reviews', { admin })).json.reviews[0];
  const path = `/api/admin/reviews/${review.id}/reply`;

  for (const body of [{}, { reply: '' }, { reply: '   ' }, { reply: 'x'.repeat(601) }]) {
    const rejected = await client.request(path, { method: 'PUT', body, admin });
    assert.equal(rejected.status, 400, JSON.stringify(body));
  }
  // The limit itself is allowed.
  assert.equal(
    (await client.request(path, { method: 'PUT', body: { reply: 'y'.repeat(600) }, admin })).status,
    200,
  );

  assert.equal(
    (
      await client.request('/api/admin/reviews/not-an-id/reply', {
        method: 'PUT',
        body: { reply: 'Thanks for writing.' },
        admin,
      })
    ).status,
    400,
  );
  for (const method of ['PUT', 'DELETE']) {
    assert.equal(
      (
        await client.request('/api/admin/reviews/9999/reply', {
          method,
          body: { reply: 'Thanks for writing.' },
          admin,
        })
      ).status,
      404,
      method,
    );
    // No password, no reply.
    assert.equal(
      (await client.request(path, { method, body: { reply: 'Posted by nobody.' } })).status,
      401,
      method,
    );
  }
  // Every refusal above left the reply that was already there alone.
  const listed = (await client.request('/api/b/blue-door-cafe')).json.reviews.find(
    (row) => row.id === review.id,
  );
  assert.equal(listed.reply, 'y'.repeat(600));
});

test('editing a review drops the reply it was written about', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();

  const review = await postReview(
    app,
    client,
    'The room was cold and I waited a long time for a flat white.',
  );
  const mine = () =>
    client.request('/api/b/blue-door-cafe').then((response) => response.json.me.review);

  async function answer() {
    const replied = await app.client().request(`/api/admin/reviews/${review.id}/reply`, {
      method: 'PUT',
      body: { reply: REPLY },
      admin,
    });
    assert.equal(replied.status, 200, replied.text);
  }

  // Saving the same words back changes nothing, so the answer stands.
  await answer();
  const unchanged = await client.request('/api/b/blue-door-cafe/reviews/me', {
    method: 'PUT',
    body: { rating: review.rating, comment: review.comment },
  });
  assert.equal(unchanged.status, 200, unchanged.text);
  assert.equal(unchanged.json.review.reply, REPLY);
  assert.equal((await mine()).reply, REPLY);

  // Rewriting them does: the reply was an answer to something else.
  const edited = await client.request('/api/b/blue-door-cafe/reviews/me', {
    method: 'PUT',
    body: { rating: 5, comment: 'They sorted the heating out and the coffee was excellent today.' },
  });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.review.reply, '');
  assert.equal(edited.json.review.repliedAt, null);
  assert.equal((await mine()).reply, '');

  const listed = (await app.client().request('/api/b/blue-door-cafe')).json.reviews.find(
    (row) => row.id === review.id,
  );
  assert.equal(listed.reply, '');
});

test('a database from before replies gains the columns rather than breaking', async () => {
  const db = openDb(':memory:');
  db.exec('DROP TABLE reviews');
  db.exec(`CREATE TABLE reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'visible',
    created_at TEXT NOT NULL,
    UNIQUE (business_id, user_id)
  )`);
  db.prepare(
    'INSERT INTO reviews (business_id, user_id, rating, comment, created_at) VALUES (1, 1, 4, ?, ?)',
  ).run('A review written before replies existed at all.', nowIso());

  migrate(db);
  const row = db.prepare('SELECT * FROM reviews').get();
  assert.equal(row.reply, '');
  assert.equal(row.replied_at, null);
  assert.equal(row.comment, 'A review written before replies existed at all.');
  db.close();
});

test('reviews are limited to three successful posts an hour per person', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();
  await signIn(app, client, 'prolific@example.com', 'Pro');

  for (let i = 0; i < 4; i += 1) {
    const created = await app.client().request('/api/admin/businesses', {
      method: 'POST',
      body: { name: `Rate Limited Place ${i}` },
      admin,
    });
    assert.equal(created.status, 201, created.text);
  }

  for (let i = 0; i < 3; i += 1) {
    const posted = await client.request(`/api/b/rate-limited-place-${i}/reviews`, {
      method: 'POST',
      body: { rating: 4, comment: `A genuine review for place number ${i}, long enough to be valid.` },
    });
    assert.equal(posted.status, 201, `post ${i + 1}: ${posted.text}`);
  }

  const fourth = await client.request('/api/b/rate-limited-place-3/reviews', {
    method: 'POST',
    body: { rating: 4, comment: 'A fourth review inside the same hour, which should be refused.' },
  });
  assert.equal(fourth.status, 429);
  assert.ok(fourth.headers.get('retry-after'));
});

test('a failed post does not count against the review limit', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'careful@example.com', 'Car');

  for (let i = 0; i < 6; i += 1) {
    const rejected = await client.request('/api/b/blue-door-cafe/reviews', {
      method: 'POST',
      body: { rating: 4, comment: 'short' },
    });
    assert.equal(rejected.status, 400);
  }

  const posted = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 4, comment: 'A valid review after several rejected attempts in the same hour.' },
  });
  assert.equal(posted.status, 201, posted.text);
});

// ------------------------------------------------- per-business topic chips

test('a business can define its own topic chips', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;

  const created = await app.client().request('/api/admin/businesses', {
    method: 'POST',
    body: {
      name: 'BikerTechie Technologies Private Limited',
      category: 'Business development service',
      topics: 'Service, Communication, Delivery time, Expertise, Value',
    },
    admin,
  });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.business.topics, [
    'Service',
    'Communication',
    'Delivery time',
    'Expertise',
    'Value',
  ]);

  // The customer page offers exactly those chips.
  const profile = await app.client().request('/api/b/bikertechie-technologies-private-limited');
  assert.deepEqual(profile.json.topics, [
    'Service',
    'Communication',
    'Delivery time',
    'Expertise',
    'Value',
  ]);

  // A business that sets none keeps the defaults.
  const demo = await app.client().request('/api/b/blue-door-cafe');
  assert.deepEqual(demo.json.topics, ['Service', 'Food', 'Price', 'Cleanliness', 'Staff', 'Atmosphere']);
});

test('only topics the business offers reach the model', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  await app.client().request('/api/admin/businesses', {
    method: 'POST',
    body: { name: 'Topic Test Co', topics: ['Expertise', 'Value'] },
    admin,
  });

  const client = app.client();
  await signIn(app, client, 'topics@example.com', 'Top');
  const response = await client.request('/api/suggest', {
    method: 'POST',
    body: {
      slug: 'topic-test-co',
      // "Food" is not on this business's list, so it must be dropped.
      topics: ['Expertise', 'Food', 'expertise'],
      rating: 5,
      note: '',
    },
  });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json.topics, ['Expertise']);
  assert.match(app.model.calls[0].body.messages[0].content, /Topics the customer chose: Expertise/);
  assert.doesNotMatch(app.model.calls[0].body.messages[0].content, /Food/);
});

test('template drafts read sensibly for a custom topic list', async (t) => {
  const model = createModelMock(() => {
    throw new Error('offline');
  });
  const app = await startApp({ model });
  t.after(() => app.close());
  await app.client().request('/api/admin/businesses', {
    method: 'POST',
    body: { name: 'Custom Topic Studio', topics: ['Communication', 'Delivery time'] },
    admin: app.config.adminToken,
  });

  const client = app.client();
  await signIn(app, client, 'custom@example.com', 'Cus');
  const response = await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'custom-topic-studio', rating: 5, topics: ['Communication', 'Delivery time'], note: '' },
  });
  assert.equal(response.json.source, 'template');
  assert.ok(response.json.drafts.length >= 5);
  const joined = response.json.drafts.join(' ');
  assert.match(joined, /communication/i);
  assert.match(joined, /delivery time/i);
  for (const draft of response.json.drafts) {
    assert.ok(draft.length >= 20 && draft.length <= 400);
  }
});

test('the no-invention rules cover currency, places and dates', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await signIn(app, client, 'rules@example.com', 'Rul');
  await client.request('/api/suggest', {
    method: 'POST',
    body: { slug: 'blue-door-cafe', rating: 5, topics: [], note: '' },
  });
  const system = app.model.calls[0].body.system;
  assert.match(system, /Do not name a currency, an amount, a city, a country or a date/);
});

// --------------------------------------------------- posting on Google too

test('a Google review link is accepted as a link or a place id, and rejected otherwise', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const client = app.client();

  const cases = [
    ['ChIJN1t_tDeuEmsRUsoyG83frY4', 'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4'],
    ['https://maps.app.goo.gl/abc123', 'https://maps.app.goo.gl/abc123'],
    ['https://g.page/r/abc/review', 'https://g.page/r/abc/review'],
    ['https://www.google.com/maps/place/Somewhere', 'https://www.google.com/maps/place/Somewhere'],
    ['http://search.google.com/local/writereview?placeid=x', 'https://search.google.com/local/writereview?placeid=x'],
    ['', ''],
  ];

  for (const [input, expected] of cases) {
    const created = await client.request('/api/admin/businesses', {
      method: 'POST',
      body: { name: `Google Link Test ${cases.indexOf([input, expected])}${input.length}`, googleReviewUrl: input },
      admin,
    });
    assert.equal(created.status, 201, `${input}: ${created.text}`);
    assert.equal(created.json.business.googleReviewUrl, expected, `input ${input}`);
  }

  for (const bad of ['https://evil.example.com/review', 'javascript:alert(1)', 'https://google.evil.com/x']) {
    const rejected = await client.request('/api/admin/businesses', {
      method: 'POST',
      body: { name: 'Bad Link Shop', googleReviewUrl: bad },
      admin,
    });
    assert.equal(rejected.status, 400, `${bad} should be rejected`);
    assert.match(rejected.json.error, /Google/);
  }
});

test('the Google link reaches the customer page only when it is set', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;

  const without = await app.client().request('/api/b/blue-door-cafe');
  assert.equal(without.json.business.googleReviewUrl, '');

  const business = app.db.prepare('SELECT id FROM businesses WHERE slug = ?').get('blue-door-cafe');
  const updated = await app.client().request(`/api/admin/businesses/${business.id}`, {
    method: 'PATCH',
    body: { googleReviewUrl: 'https://maps.app.goo.gl/bikertechie' },
    admin,
  });
  assert.equal(updated.status, 200, updated.text);

  const withLink = await app.client().request('/api/b/blue-door-cafe');
  assert.equal(withLink.json.business.googleReviewUrl, 'https://maps.app.goo.gl/bikertechie');
});

// ------------------------------------------------------------ editing a business

test('editing a business never changes its slug, so printed QR codes keep working', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const business = app.db.prepare('SELECT id, slug FROM businesses WHERE slug = ?').get('blue-door-cafe');

  const qrBefore = await fetch(`${app.base}/api/b/blue-door-cafe/qr.svg`);
  const svgBefore = await qrBefore.text();

  const renamed = await app.client().request(`/api/admin/businesses/${business.id}`, {
    method: 'PATCH',
    body: {
      name: 'Completely Different Name Ltd',
      category: 'Tea room',
      topics: ['Service', 'Value'],
    },
    admin,
  });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.json.business.slug, 'blue-door-cafe');
  assert.equal(renamed.json.business.name, 'Completely Different Name Ltd');

  // The old address still works and the QR code is byte for byte the same.
  const profile = await app.client().request('/api/b/blue-door-cafe');
  assert.equal(profile.status, 200);
  assert.equal(profile.json.business.name, 'Completely Different Name Ltd');
  assert.deepEqual(profile.json.topics, ['Service', 'Value']);
  assert.equal(profile.json.stats.count, 4, 'reviews survive an edit');

  const qrAfter = await fetch(`${app.base}/api/b/blue-door-cafe/qr.svg`);
  assert.equal(await qrAfter.text(), svgBefore);
});

test('a partial edit leaves the other fields alone', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const admin = app.config.adminToken;
  const business = app.db.prepare('SELECT id FROM businesses WHERE slug = ?').get('blue-door-cafe');

  const response = await app.client().request(`/api/admin/businesses/${business.id}`, {
    method: 'PATCH',
    body: { address: '19 Harbour Lane, Riverside' },
    admin,
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.business.address, '19 Harbour Lane, Riverside');
  assert.equal(response.json.business.name, 'Blue Door Café');
  assert.equal(response.json.business.category, 'Café');
  assert.deepEqual(response.json.business.topics, [
    'Service',
    'Food',
    'Price',
    'Cleanliness',
    'Staff',
    'Atmosphere',
  ]);
});

test('editing a business needs the admin password and a real id', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  assert.equal((await client.request('/api/admin/businesses/1', { method: 'PATCH', body: { name: 'Nope' } })).status, 401);
  assert.equal(
    (await client.request('/api/admin/businesses/1', { method: 'PATCH', body: { name: 'Nope' }, admin: 'wrong' })).status,
    401,
  );
  assert.equal(
    (await client.request('/api/admin/businesses/9999', {
      method: 'PATCH',
      body: { name: 'Nope' },
      admin: app.config.adminToken,
    })).status,
    404,
  );
  assert.equal(
    (await client.request('/api/admin/businesses/1', {
      method: 'PATCH',
      body: { name: 'x' },
      admin: app.config.adminToken,
    })).status,
    400,
  );
});

test('an older database is migrated rather than broken', async () => {
  // A database created before topics and google_review_url existed.
  const db = openDb(':memory:');
  db.exec('DROP TABLE businesses');
  db.exec(`CREATE TABLE businesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  db.prepare('INSERT INTO businesses (slug, name, created_at) VALUES (?, ?, ?)')
    .run('old-shop', 'Old Shop', nowIso());

  migrate(db);
  const row = db.prepare('SELECT * FROM businesses WHERE slug = ?').get('old-shop');
  assert.equal(row.topics, '');
  assert.equal(row.google_review_url, '');
  assert.deepEqual(topicsFor(row), ['Service', 'Food', 'Price', 'Cleanliness', 'Staff', 'Atmosphere']);
  db.close();
});

// ------------------------------------------------------- Google One Tap

// A stand-in for Google: a real RSA key, real RS256 signatures, served through
// a fake certs endpoint, so the verifier is exercised exactly as in production.
function createFakeGoogle({ clientId = 'test-client-id.apps.googleusercontent.com' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

  function sign(payload, options = {}) {
    const header = { alg: options.alg ?? 'RS256', kid: options.kid ?? kid, typ: 'JWT' };
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${encode(header)}.${encode(payload)}`;
    if (options.unsigned) return `${body}.`;
    const signature = crypto.createSign('RSA-SHA256').update(body).sign(options.key ?? privateKey);
    return `${body}.${signature.toString('base64url')}`;
  }

  function token(overrides = {}) {
    const seconds = Math.floor(Date.now() / 1000);
    return sign({
      iss: 'https://accounts.google.com',
      aud: clientId,
      sub: '1234567890',
      email: 'bharat@gmail.com',
      email_verified: true,
      given_name: 'Bharat',
      name: 'Bharat Yadav',
      iat: seconds,
      exp: seconds + 3600,
      ...overrides,
    });
  }

  let certCalls = 0;
  const fetchImpl = async () => {
    certCalls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'cache-control' ? 'max-age=3600' : null) },
      async json() {
        return { keys: [jwk] };
      },
    };
  };

  return { clientId, token, sign, privateKey, fetchImpl, certs: () => certCalls };
}

test('a valid Google token signs the customer in', async (t) => {
  const google = createFakeGoogle();
  const app = await startApp({
    env: { GOOGLE_CLIENT_ID: google.clientId },
    googleVerifier: createGoogleVerifier({ clientId: google.clientId, fetchImpl: google.fetchImpl }),
  });
  t.after(() => app.close());

  const client = app.client();
  const profile = await client.request('/api/b/blue-door-cafe');
  assert.equal(profile.json.googleClientId, google.clientId, 'the page is told which client id to use');

  const signedIn = await client.request('/api/auth/google', {
    method: 'POST',
    body: { credential: google.token() },
  });
  assert.equal(signedIn.status, 200, signedIn.text);
  assert.equal(signedIn.json.firstName, 'Bharat');

  const me = await client.request('/api/auth/me');
  assert.equal(me.json.signedIn, true);
  assert.equal(me.json.firstName, 'Bharat');

  // Their review carries the name from their Google account.
  const posted = await client.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: 'A review posted after signing in with a Google account on a phone.' },
  });
  assert.equal(posted.status, 201, posted.text);
  const after = await client.request('/api/b/blue-door-cafe');
  assert.equal(after.json.reviews[0].firstName, 'Bharat');
  assert.equal(after.json.me.verified, true);

  // The account is stored by its Google id, and the address never reaches the public page.
  const row = app.db.prepare('SELECT * FROM users WHERE google_sub = ?').get('1234567890');
  assert.equal(row.email, 'bharat@gmail.com');
  assert.doesNotMatch(after.text, /bharat@gmail\.com/);
});

test('forged, expired and misaddressed Google tokens are all refused', async (t) => {
  const google = createFakeGoogle();
  const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const app = await startApp({
    env: { GOOGLE_CLIENT_ID: google.clientId },
    googleVerifier: createGoogleVerifier({ clientId: google.clientId, fetchImpl: google.fetchImpl }),
  });
  t.after(() => app.close());

  const seconds = Math.floor(Date.now() / 1000);
  const bad = {
    'signed by somebody else': google.sign(
      { iss: 'https://accounts.google.com', aud: google.clientId, sub: 'x', exp: seconds + 3600 },
      { key: attacker.privateKey },
    ),
    'no signature at all': google.sign(
      { iss: 'https://accounts.google.com', aud: google.clientId, sub: 'x', exp: seconds + 3600 },
      { unsigned: true, alg: 'none' },
    ),
    'issued for another site': google.token({ aud: 'someone-elses-client-id' }),
    'from the wrong issuer': google.token({ iss: 'https://evil.example.com' }),
    expired: google.token({ exp: seconds - 7200, iat: seconds - 10800 }),
    'unknown signing key': google.sign({ iss: 'https://accounts.google.com', aud: google.clientId, sub: 'x', exp: seconds + 3600 }, { kid: 'not-a-real-kid' }),
    'not a token': 'this is not a jwt at all',
    empty: '',
  };

  for (const [name, credential] of Object.entries(bad)) {
    const client = app.client();
    await client.request('/api/auth/me');
    const response = await client.request('/api/auth/google', { method: 'POST', body: { credential } });
    assert.equal(response.status, 401, `${name} should be refused: ${response.text}`);
    assert.equal((await client.request('/api/auth/me')).json.signedIn, false, name);
  }

  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
});

test('signing in with Google keeps the review the device just left', async (t) => {
  const google = createFakeGoogle();
  const app = await startApp({
    env: { GOOGLE_CLIENT_ID: google.clientId },
    googleVerifier: createGoogleVerifier({ clientId: google.clientId, fetchImpl: google.fetchImpl }),
  });
  t.after(() => app.close());

  const client = app.client();
  await client.request('/api/b/blue-door-cafe');
  const text = 'A review left before signing in, which should still belong to me afterwards.';
  await client.request('/api/b/blue-door-cafe/reviews', { method: 'POST', body: { rating: 5, comment: text } });

  const usersBefore = app.db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  await client.request('/api/auth/google', { method: 'POST', body: { credential: google.token() } });

  const after = await client.request('/api/b/blue-door-cafe');
  assert.equal(after.json.me.review.comment, text, 'the review followed them into the account');
  assert.equal(after.json.reviews[0].firstName, 'Bharat', 'and now carries their name');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM users').get().c, usersBefore, 'no duplicate person');
});

test('the same Google account cannot review a business twice from two phones', async (t) => {
  const google = createFakeGoogle();
  const app = await startApp({
    env: { GOOGLE_CLIENT_ID: google.clientId },
    googleVerifier: createGoogleVerifier({ clientId: google.clientId, fetchImpl: google.fetchImpl }),
  });
  t.after(() => app.close());

  const phone = app.client();
  await phone.request('/api/b/blue-door-cafe');
  await phone.request('/api/auth/google', { method: 'POST', body: { credential: google.token() } });
  const first = await phone.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 5, comment: 'The first review from this Google account, left on the first phone.' },
  });
  assert.equal(first.status, 201, first.text);

  // A different device, but the same Google account: this is the gap the
  // device cookie alone cannot close.
  const laptop = app.client();
  await laptop.request('/api/b/blue-door-cafe');
  await laptop.request('/api/auth/google', { method: 'POST', body: { credential: google.token() } });
  const second = await laptop.request('/api/b/blue-door-cafe/reviews', {
    method: 'POST',
    body: { rating: 1, comment: 'A second review from the same account on a completely other device.' },
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'You already reviewed this business.');
});

test('Google sign-in is refused when the server has no client id', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();
  await client.request('/api/auth/me');
  const profile = await client.request('/api/b/blue-door-cafe');
  assert.equal(profile.json.googleClientId, '', 'the page is told not to load the prompt');

  const response = await client.request('/api/auth/google', {
    method: 'POST',
    body: { credential: 'anything at all' },
  });
  assert.equal(response.status, 503);
});

test('a suspended Google account cannot sign back in', async (t) => {
  const google = createFakeGoogle();
  const app = await startApp({
    env: { GOOGLE_CLIENT_ID: google.clientId },
    googleVerifier: createGoogleVerifier({ clientId: google.clientId, fetchImpl: google.fetchImpl }),
  });
  t.after(() => app.close());

  const client = app.client();
  await client.request('/api/b/blue-door-cafe');
  await client.request('/api/auth/google', { method: 'POST', body: { credential: google.token() } });
  const user = app.db.prepare('SELECT id FROM users WHERE google_sub = ?').get('1234567890');
  await app.client().request(`/api/admin/users/${user.id}`, {
    method: 'PATCH',
    body: { suspended: true },
    admin: app.config.adminToken,
  });

  const again = app.client();
  await again.request('/api/b/blue-door-cafe');
  const response = await again.request('/api/auth/google', {
    method: 'POST',
    body: { credential: google.token() },
  });
  assert.equal(response.status, 403);
});

test('Google signing keys are fetched once and reused', async (t) => {
  const google = createFakeGoogle();
  const verifier = createGoogleVerifier({ clientId: google.clientId, fetchImpl: google.fetchImpl });
  for (let i = 0; i < 3; i += 1) {
    const identity = await verifier.verify(google.token());
    assert.equal(identity.sub, '1234567890');
    assert.equal(identity.firstName, 'Bharat');
    assert.equal(identity.emailVerified, true);
  }
  assert.equal(google.certs(), 1, 'the certs endpoint should be called once, then cached');
});

test('the CSP lets the Google prompt load and nothing else new', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const response = await app.client().request('/api/b/blue-door-cafe');
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client/);
  assert.match(csp, /frame-src https:\/\/accounts\.google\.com\/gsi\//);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

// ------------------------------------------------------------------- startup

test('the seed is idempotent and the demo business has four reviews', async () => {
  const db = openDb(':memory:');
  const first = seed(db);
  const second = seed(db);
  assert.equal(first.id, second.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM businesses').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reviews').get().c, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 4);
  db.close();
});

test('the pages and the stylesheet are served', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const client = app.client();

  for (const path of ['/', '/admin', '/b/blue-door-cafe']) {
    const response = await client.request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.text, /<!doctype html>/i);
  }
  const css = await client.request('/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  // The scripts carry no version in their names, so they must be revalidated
  // rather than cached for an hour, or a deploy leaves customers on old code.
  for (const asset of ['/style.css', '/business.js', '/admin.js']) {
    const response = await client.request(asset);
    assert.equal(response.headers.get('cache-control'), 'no-cache', asset);
    assert.ok(response.headers.get('etag'), `${asset} should have an ETag`);
  }
  assert.equal((await client.request('/api/nothing-here')).status, 404);
  assert.equal((await client.request('/healthz')).json.ok, true);
});

// ----------------------------------------------------------- owner accounts

// Signs a brand new owner up and returns their client.
async function signUpOwner(app, email, password, name = 'Owner') {
  const client = app.client();
  await client.request('/api/owner/me');
  const response = await client.request('/api/owner/signup', {
    method: 'POST',
    body: { email, password, name },
  });
  return { client, response };
}

async function createBusinessAs(client, name) {
  return client.request('/api/admin/businesses', { method: 'POST', body: { name } });
}

test('the first account becomes a platform admin and adopts businesses that had no owner', async () => {
  const app = await startApp();
  try {
    // The demo business was seeded before any account existed.
    const orphan = app.db.prepare('SELECT id, owner_id FROM businesses').get();
    assert.equal(orphan.owner_id, null);

    const { response } = await signUpOwner(app, 'first@example.com', 'a-long-enough-password');
    assert.equal(response.status, 201);
    assert.equal(response.json.owner.isAdmin, true);

    const adopted = app.db.prepare('SELECT owner_id FROM businesses WHERE id = ?').get(orphan.id);
    assert.equal(adopted.owner_id, response.json.owner.id);

    // The second account is an ordinary owner, not another admin.
    const second = await signUpOwner(app, 'second@example.com', 'another-good-password');
    assert.equal(second.response.status, 201);
    assert.equal(second.response.json.owner.isAdmin, false);
  } finally {
    await app.close();
  }
});

test('a wrong password and an unknown account are refused in the same words', async () => {
  const app = await startApp();
  try {
    await signUpOwner(app, 'owner@example.com', 'a-long-enough-password');

    const client = app.client();
    await client.request('/api/owner/me');

    const wrongPassword = await client.request('/api/owner/login', {
      method: 'POST',
      body: { email: 'owner@example.com', password: 'not-the-password' },
    });
    const startedAt = Date.now();
    const noSuchAccount = await client.request('/api/owner/login', {
      method: 'POST',
      body: { email: 'nobody@example.com', password: 'not-the-password' },
    });
    const unknownTook = Date.now() - startedAt;

    assert.equal(wrongPassword.status, 401);
    assert.equal(noSuchAccount.status, 401);
    // Same wording, so the form cannot be used to discover who has an account.
    assert.equal(wrongPassword.json.error, noSuchAccount.json.error);
    // And the same work: the unknown address is verified against a decoy hash,
    // so it pays for scrypt too. Answering it without that cost would say "no
    // such account" in the timing, however carefully the wording hides it.
    // scrypt at these parameters is tens of milliseconds; a request that
    // skipped it comes back in under one. The bar is well below the real cost
    // so that a fast machine does not make this flaky.
    assert.ok(unknownTook >= 10, `unknown account answered in ${unknownTook}ms, too fast to have hashed`);

    const right = await client.request('/api/owner/login', {
      method: 'POST',
      body: { email: 'owner@example.com', password: 'a-long-enough-password' },
    });
    assert.equal(right.status, 200);
    assert.equal(right.json.owner.email, 'owner@example.com');
  } finally {
    await app.close();
  }
});

test('an owner sees only their own businesses', async () => {
  const app = await startApp({ seedDemo: false });
  try {
    const alice = await signUpOwner(app, 'alice@example.com', 'alice-long-password');
    await createBusinessAs(alice.client, "Alice's Cafe");

    const bob = await signUpOwner(app, 'bob@example.com', 'bob-long-password-x');
    await createBusinessAs(bob.client, "Bob's Garage");

    const bobList = await bob.client.request('/api/admin/businesses');
    assert.equal(bobList.json.businesses.length, 1);
    assert.equal(bobList.json.businesses[0].name, "Bob's Garage");

    // Alice is the first account, so she is a platform admin and sees both.
    const aliceList = await alice.client.request('/api/admin/businesses');
    assert.equal(aliceList.json.businesses.length, 2);
  } finally {
    await app.close();
  }
});

test('one owner cannot read, edit or delete another owner\'s business', async () => {
  const app = await startApp({ seedDemo: false });
  try {
    // The first account is an admin, so make two ordinary owners after it.
    await signUpOwner(app, 'admin@example.com', 'admin-long-password');
    const alice = await signUpOwner(app, 'alice@example.com', 'alice-long-password');
    const bob = await signUpOwner(app, 'bob@example.com', 'bob-long-password-x');

    const created = await createBusinessAs(alice.client, "Alice's Cafe");
    const id = created.json.business.id;

    const read = await bob.client.request(`/api/admin/businesses/${id}/reviews`);
    const edited = await bob.client.request(`/api/admin/businesses/${id}`, {
      method: 'PATCH',
      body: { name: 'Stolen' },
    });
    const deleted = await bob.client.request(`/api/admin/businesses/${id}`, { method: 'DELETE' });

    // 404 rather than 403: a 403 would confirm the id exists.
    assert.equal(read.status, 404);
    assert.equal(edited.status, 404);
    assert.equal(deleted.status, 404);

    // And it really is untouched.
    const still = app.db.prepare('SELECT name FROM businesses WHERE id = ?').get(id);
    assert.equal(still.name, "Alice's Cafe");
  } finally {
    await app.close();
  }
});

test('a review can only be moderated by the owner of its business', async () => {
  const app = await startApp();
  try {
    // The admin adopts the demo business, so its reviews belong to them.
    const admin = await signUpOwner(app, 'admin@example.com', 'admin-long-password');
    const stranger = await signUpOwner(app, 'stranger@example.com', 'stranger-password-1');

    const reviews = await admin.client.request('/api/admin/reviews');
    const reviewId = reviews.json.reviews[0].id;

    const hidden = await stranger.client.request(`/api/admin/reviews/${reviewId}`, {
      method: 'PATCH',
      body: { status: 'hidden' },
    });
    assert.equal(hidden.status, 404);

    const strangerList = await stranger.client.request('/api/admin/reviews');
    assert.equal(strangerList.json.reviews.length, 0);

    const mine = await admin.client.request(`/api/admin/reviews/${reviewId}`, {
      method: 'PATCH',
      body: { status: 'hidden' },
    });
    assert.equal(mine.status, 200);
  } finally {
    await app.close();
  }
});

test('changing a password needs the current one, and signs other browsers out', async () => {
  const app = await startApp({ seedDemo: false });
  try {
    const { client } = await signUpOwner(app, 'owner@example.com', 'the-first-password');

    // A second browser, signed in as the same person.
    const other = app.client();
    await other.request('/api/owner/me');
    await other.request('/api/owner/login', {
      method: 'POST',
      body: { email: 'owner@example.com', password: 'the-first-password' },
    });
    assert.ok((await other.request('/api/owner/me')).json.owner);

    const wrong = await client.request('/api/owner/password', {
      method: 'POST',
      body: { currentPassword: 'wrong', newPassword: 'the-second-password' },
    });
    assert.equal(wrong.status, 403);

    const short = await client.request('/api/owner/password', {
      method: 'POST',
      body: { currentPassword: 'the-first-password', newPassword: 'short' },
    });
    assert.equal(short.status, 400);

    const changed = await client.request('/api/owner/password', {
      method: 'POST',
      body: { currentPassword: 'the-first-password', newPassword: 'the-second-password' },
    });
    assert.equal(changed.status, 200);

    // This browser stays signed in; the other one does not.
    assert.ok((await client.request('/api/owner/me')).json.owner);
    assert.equal((await other.request('/api/owner/me')).json.owner, null);

    // And the old password no longer works.
    const stale = app.client();
    await stale.request('/api/owner/me');
    const refused = await stale.request('/api/owner/login', {
      method: 'POST',
      body: { email: 'owner@example.com', password: 'the-first-password' },
    });
    assert.equal(refused.status, 401);
  } finally {
    await app.close();
  }
});

test('a reset code sets a new password once, and wrong codes are counted', async () => {
  const app = await startApp({ seedDemo: false, env: { SMTP_HOST: 'smtp.example.com' } });
  try {
    await signUpOwner(app, 'owner@example.com', 'the-first-password');

    const client = app.client();
    await client.request('/api/owner/me');
    const asked = await client.request('/api/owner/forgot', {
      method: 'POST',
      body: { email: 'owner@example.com' },
    });
    assert.equal(asked.status, 200);

    const { code } = app.mailer.reset.at(-1);

    const wrong = await client.request('/api/owner/reset', {
      method: 'POST',
      body: { email: 'owner@example.com', code: '000000', newPassword: 'a-brand-new-password' },
    });
    assert.equal(wrong.status, 400);

    const reset = await client.request('/api/owner/reset', {
      method: 'POST',
      body: { email: 'owner@example.com', code, newPassword: 'a-brand-new-password' },
    });
    assert.equal(reset.status, 200);

    // The code is spent, so it cannot be replayed.
    const replay = await client.request('/api/owner/reset', {
      method: 'POST',
      body: { email: 'owner@example.com', code, newPassword: 'another-new-password' },
    });
    assert.equal(replay.status, 400);

    // The new password works, the old one does not.
    const fresh = app.client();
    await fresh.request('/api/owner/me');
    const good = await fresh.request('/api/owner/login', {
      method: 'POST',
      body: { email: 'owner@example.com', password: 'a-brand-new-password' },
    });
    assert.equal(good.status, 200);
  } finally {
    await app.close();
  }
});

test('asking to reset an address with no account says the same as one with', async () => {
  const app = await startApp({ seedDemo: false, env: { SMTP_HOST: 'smtp.example.com' } });
  try {
    await signUpOwner(app, 'owner@example.com', 'the-first-password');
    const client = app.client();
    await client.request('/api/owner/me');

    const real = await client.request('/api/owner/forgot', {
      method: 'POST',
      body: { email: 'owner@example.com' },
    });
    const absent = await client.request('/api/owner/forgot', {
      method: 'POST',
      body: { email: 'nobody@example.com' },
    });

    assert.equal(real.status, absent.status);
    assert.deepEqual(real.json, absent.json);
    // Only the real one actually produced a code.
    assert.equal(app.mailer.reset.length, 1);
  } finally {
    await app.close();
  }
});

test('without SMTP, password reset says so rather than failing quietly', async () => {
  const app = await startApp({ seedDemo: false });
  try {
    await signUpOwner(app, 'owner@example.com', 'the-first-password');
    const client = app.client();
    await client.request('/api/owner/me');

    const asked = await client.request('/api/owner/forgot', {
      method: 'POST',
      body: { email: 'owner@example.com' },
    });
    assert.equal(asked.status, 503);
    assert.match(asked.json.error, /cannot send email/i);

    // And the page knows not to offer it in the first place.
    const state = await client.request('/api/owner/me');
    assert.equal(state.json.canResetPassword, false);
  } finally {
    await app.close();
  }
});

test('the ADMIN_TOKEN still works, and still sees everything', async () => {
  const app = await startApp({ seedDemo: false });
  try {
    const alice = await signUpOwner(app, 'alice@example.com', 'alice-long-password');
    await createBusinessAs(alice.client, "Alice's Cafe");
    const bob = await signUpOwner(app, 'bob@example.com', 'bob-long-password-x');
    await createBusinessAs(bob.client, "Bob's Garage");

    const token = app.client();
    const all = await token.request('/api/admin/businesses', {
      admin: 'test-admin-token-0123456789',
    });
    assert.equal(all.status, 200);
    assert.equal(all.json.businesses.length, 2);
  } finally {
    await app.close();
  }
});

test('the console refuses anyone who is neither signed in nor holding the token', async () => {
  const app = await startApp({ seedDemo: false });
  try {
    const stranger = app.client();
    const refused = await stranger.request('/api/admin/businesses');
    assert.equal(refused.status, 401);

    const wrongToken = await stranger.request('/api/admin/businesses', { admin: 'not-the-token' });
    assert.equal(wrongToken.status, 401);
  } finally {
    await app.close();
  }
});

test('the reviewer list is for platform admins, not for every owner', async () => {
  const app = await startApp({ seedDemo: false });
  try {
    const admin = await signUpOwner(app, 'admin@example.com', 'admin-long-password');
    const owner = await signUpOwner(app, 'owner@example.com', 'owner-long-password');

    assert.equal((await admin.client.request('/api/admin/users')).status, 200);

    const refused = await owner.client.request('/api/admin/users');
    assert.equal(refused.status, 403);
  } finally {
    await app.close();
  }
});

test('signing up is refused for a taken email, a bad address or a weak password', async () => {
  const app = await startApp({ seedDemo: false });
  try {
    await signUpOwner(app, 'taken@example.com', 'a-long-enough-password');

    const again = await signUpOwner(app, 'taken@example.com', 'a-long-enough-password');
    assert.equal(again.response.status, 409);

    const bad = await signUpOwner(app, 'not-an-email', 'a-long-enough-password');
    assert.equal(bad.response.status, 400);

    const weak = await signUpOwner(app, 'weak@example.com', 'short');
    assert.equal(weak.response.status, 400);
    assert.match(weak.response.json.error, /at least 10 characters/);
  } finally {
    await app.close();
  }
});

test('signing out ends the session', async () => {
  const app = await startApp({ seedDemo: false });
  try {
    const { client } = await signUpOwner(app, 'owner@example.com', 'a-long-enough-password');
    assert.ok((await client.request('/api/owner/me')).json.owner);

    const out = await client.request('/api/owner/logout', { method: 'POST' });
    assert.equal(out.status, 200);

    assert.equal((await client.request('/api/owner/me')).json.owner, null);
    assert.equal((await client.request('/api/admin/businesses')).status, 401);
  } finally {
    await app.close();
  }
});
