import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';

import { loadEnv, buildConfig, assertConfig } from './lib/env.js';
import {
  openDb,
  seed,
  createBusiness,
  updateBusiness,
  setBusinessSwitches,
  upsertUser,
  upsertDeviceUser,
  upsertGoogleUser,
  findUserByDevice,
  topicsFor,
  parseTopicList,
  nowIso,
} from './db.js';
import * as limits from './lib/ratelimit.js';
import {
  sha256,
  randomToken,
  generateLoginCode,
  makeCodeHasher,
  timingSafeEqualStr,
} from './lib/security.js';
import { createMailer } from './lib/mail.js';
import { createGoogleVerifier } from './lib/google.js';
import { createSuggester, DRAFT_MIN, DRAFT_MAX, NOTE_MAX } from './lib/ai.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const SESSION_COOKIE = 'rq_session';
const CSRF_COOKIE = 'rq_csrf';
const DEVICE_COOKIE = 'rq_device';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Browsers cap cookie lifetimes at 400 days, so there is no point asking for
// more. This is what keeps "one review per device" working between visits.
const DEVICE_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const NAME_MAX = 40;
const BUSINESS_NAME_MAX = 80;
const FIELD_MAX = 200;
const DESCRIPTION_MAX = 500;
// A business reply is an answer, not an essay: room for a paragraph.
const REPLY_MAX = 600;

// ---------------------------------------------------------------- validation

// Collapses whitespace and strips control characters. Review text is rendered
// with textContent on the client, so this is about predictable storage rather
// than escaping.
function clean(value, max) {
  if (typeof value !== 'string') return '';
  /* eslint-disable-next-line no-control-regex */
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return max ? collapsed.slice(0, max) : collapsed;
}

function cleanEmail(value) {
  return clean(value, 254).toLowerCase();
}

// Deliberately simple: one @, something either side, a dot in the domain.
function isEmail(value) {
  return /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

function parseRating(value) {
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  return rating;
}

// Only topics this business actually offers are accepted, so a chosen topic is
// always a label the customer was really shown.
function parseTopics(value, allowed) {
  if (!Array.isArray(value)) return [];
  const chosen = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const match = allowed.find((topic) => topic.toLowerCase() === entry.trim().toLowerCase());
    if (match && !chosen.includes(match)) chosen.push(match);
  }
  return chosen;
}

// Accepts a Google place id or a Google review/maps link and returns a link we
// are willing to send a customer to. Anything else is rejected, so this cannot
// be used to point the button at an unrelated site.
const GOOGLE_HOSTS = /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|maps\.app\.goo\.gl|goo\.gl|g\.page|g\.co)$/i;

export function normalizeGoogleUrl(value) {
  const input = clean(value, 500);
  if (!input) return { ok: true, url: '' };

  // A bare place id, as shown in Google Business Profile.
  if (/^[A-Za-z0-9_-]{15,}$/.test(input) && !input.includes('.')) {
    return { ok: true, url: `https://search.google.com/local/writereview?placeid=${input}` };
  }

  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { ok: false, url: '' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, url: '' };
  if (!GOOGLE_HOSTS.test(parsed.hostname)) return { ok: false, url: '' };
  parsed.protocol = 'https:';
  return { ok: true, url: parsed.toString() };
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ------------------------------------------------------------------- cookies

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

function serializeCookie(name, value, { maxAge, httpOnly, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ------------------------------------------------------------------ shaping

// Public shape of a review: first name only, never the email or the user id.
// Most reviewers are never asked for a name, so they show as "A customer".
function publicReview(row) {
  return {
    id: row.id,
    firstName: row.first_name || 'A customer',
    rating: row.rating,
    comment: row.comment,
    createdAt: row.created_at,
    // The business's answer, when it has written one. Public by design.
    reply: row.reply || '',
    repliedAt: row.replied_at || null,
  };
}

function ownReview(row) {
  return {
    id: row.id,
    rating: row.rating,
    comment: row.comment,
    status: row.status,
    createdAt: row.created_at,
    reply: row.reply || '',
    repliedAt: row.replied_at || null,
  };
}

function businessStats(db, businessId) {
  const rows = db
    .prepare("SELECT rating, COUNT(*) AS c FROM reviews WHERE business_id = ? AND status = 'visible' GROUP BY rating")
    .all(businessId);
  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let total = 0;
  for (const row of rows) {
    breakdown[row.rating] = row.c;
    count += row.c;
    total += row.rating * row.c;
  }
  return {
    count,
    average: count ? Math.round((total / count) * 10) / 10 : 0,
    breakdown,
  };
}

// ----------------------------------------------------------------- the app

// ------------------------------------------- per-business page metadata

// The customer page is one static file, so every business would otherwise
// share a single title. WhatsApp, Facebook and iMessage never run the
// script that fills the name in, so a link pasted into a chat has to carry
// the name in the HTML itself. Read once: the file only changes on deploy.
const BUSINESS_HTML = readFileSync(path.join(PUBLIC_DIR, 'business.html'), 'utf8');
const BUSINESS_META = [
  '    <title>Reviews \u00b7 ReviewQR</title>',
  '    <meta name="description" content="Read the latest reviews for this business and leave one of your own." />',
].join('\n');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Name, category and score in the <head>, so a link shared in a chat
// previews as the business rather than as the app.
function businessPage(db, business, baseUrl) {
  const stats = businessStats(db, business.id);
  const title = `${business.name} \u2014 Reviews`;
  const score = stats.count
    ? `${stats.average} stars from ${stats.count} review${stats.count === 1 ? '' : 's'}`
    : 'Be the first to leave a review';
  const description = [business.category, score].filter(Boolean).join(' \u00b7 ');
  const url = `${baseUrl}/b/${business.slug}`;
  const block = [
    `    <title>${escapeHtml(title)}</title>`,
    `    <meta name="description" content="${escapeHtml(description)}" />`,
    '    <meta property="og:type" content="website" />',
    '    <meta property="og:site_name" content="ReviewQR" />',
    `    <meta property="og:title" content="${escapeHtml(title)}" />`,
    `    <meta property="og:description" content="${escapeHtml(description)}" />`,
    `    <meta property="og:url" content="${escapeHtml(url)}" />`,
    '    <meta name="twitter:card" content="summary" />',
  ].join('\n');
  return BUSINESS_HTML.replace(BUSINESS_META, block);
}

export function createApp({ config, db, mailer, suggester, googleVerifier = null, logger = console } = {}) {
  const app = express();
  const hashCode = makeCodeHasher(config.adminToken || 'reviewqr-dev-secret');
  const cookieBase = { secure: config.isProduction, maxAge: SESSION_TTL_MS };

  app.set('trust proxy', config.trustProxy);
  app.set('x-powered-by', false);

  // ---- baseline middleware

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data: https://lh3.googleusercontent.com",
        // accounts.google.com is only reachable by the One Tap prompt, and only
        // when GOOGLE_CLIENT_ID is set and the page loads their script.
        "script-src 'self' https://accounts.google.com/gsi/client",
        "style-src 'self' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'self' https://accounts.google.com/gsi/",
        "frame-src https://accounts.google.com/gsi/",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
    });
    if (config.isProduction) {
      res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  });

  app.use(express.json({ limit: '10kb' }));

  app.use((req, res, next) => {
    req.clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    req.cookies = parseCookies(req.headers.cookie);
    next();
  });

  // Every visitor gets a readable CSRF cookie; mutating requests must echo it
  // back in the x-csrf-token header (double submit).
  app.use((req, res, next) => {
    let token = req.cookies[CSRF_COOKIE];
    if (!token || token.length < 16) {
      token = randomToken(32);
      res.append('Set-Cookie', serializeCookie(CSRF_COOKIE, token, { ...cookieBase, httpOnly: false }));
      req.cookies[CSRF_COOKIE] = token;
    }
    req.csrfToken = token;
    next();
  });

  // Resolve the session. user_id comes from here and nowhere else - a user_id
  // in a request body is never read.
  app.use((req, res, next) => {
    req.user = null;
    req.session = null;
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return next();
    const row = db
      .prepare(
        `SELECT s.id, s.user_id, s.csrf_token, s.expires_at,
                u.email, u.first_name, u.suspended
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`,
      )
      .get(sha256(raw));
    if (!row) return next();
    if (row.expires_at <= Date.now()) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      return next();
    }
    req.session = { id: row.id, csrfToken: row.csrf_token };
    req.user = {
      id: row.user_id,
      email: row.email,
      firstName: row.first_name,
      suspended: Boolean(row.suspended),
    };
    return next();
  });

  // The ordinary reviewer is just this browser. Every visitor gets a device
  // cookie, and that is the identity behind "one review per business" - no
  // email, no name, nothing asked. An email session, where a business asks for
  // one, takes precedence over it.
  app.use((req, res, next) => {
    let token = req.cookies[DEVICE_COOKIE];
    if (!token || token.length < 16) {
      token = randomToken(32);
      res.append(
        'Set-Cookie',
        serializeCookie(DEVICE_COOKIE, token, {
          secure: config.isProduction,
          maxAge: DEVICE_TTL_MS,
          httpOnly: true,
        }),
      );
      req.cookies[DEVICE_COOKIE] = token;
    }
    req.deviceHash = sha256(token);

    if (!req.user) {
      // The row is only created when they write something, so simply loading
      // the page leaves nothing behind.
      const row = findUserByDevice(db, req.deviceHash);
      if (row) {
        req.user = {
          id: row.id,
          email: row.email,
          firstName: row.first_name,
          suspended: Boolean(row.suspended),
          verified: false,
        };
      }
    }
    next();
  });

  function requireCsrf(req, res, next) {
    if (!MUTATING.has(req.method)) return next();
    const header = req.get('x-csrf-token') || '';
    const cookie = req.cookies[CSRF_COOKIE] || '';
    if (!header || !cookie || !timingSafeEqualStr(header, cookie)) {
      return res.status(403).json({ error: 'Your page is out of date. Please reload and try again.' });
    }
    // Once signed in, the token is also pinned to the session.
    if (req.session && !timingSafeEqualStr(header, req.session.csrfToken)) {
      return res.status(403).json({ error: 'Your page is out of date. Please reload and try again.' });
    }
    return next();
  }

  // Resolves who is writing, creating the device's row on first use. Returns
  // null once it has answered the request itself.
  function reviewer(req, res, business) {
    if (business.require_email && !req.session) {
      res.status(401).json({ error: 'Please verify your email before continuing.' });
      return null;
    }
    let user = req.user;
    if (!user) {
      const row = upsertDeviceUser(db, req.deviceHash);
      user = {
        id: row.id,
        email: row.email,
        firstName: row.first_name,
        suspended: Boolean(row.suspended),
        verified: false,
      };
      req.user = user;
    }
    if (user.suspended) {
      res.status(403).json({ error: 'This account cannot post reviews.' });
      return null;
    }
    return user;
  }

  // For editing and deleting: no identity means there is nothing of theirs to
  // act on, and a new device row would be pointless.
  function existingReviewer(req, res) {
    if (!req.user) {
      res.status(404).json({ error: 'You have not reviewed this business yet.' });
      return null;
    }
    if (req.user.suspended) {
      res.status(403).json({ error: 'This account cannot post reviews.' });
      return null;
    }
    return req.user;
  }

  function requireAdmin(req, res, next) {
    const supplied = req.get('x-admin-token') || '';
    if (!config.adminToken || !supplied || !timingSafeEqualStr(supplied, config.adminToken)) {
      return res.status(401).json({ error: 'Wrong admin password.' });
    }
    return next();
  }

  function findBusiness(req, res) {
    const slug = clean(req.params.slug, 80).toLowerCase();
    const business = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slug);
    if (!business) {
      res.status(404).json({ error: 'We could not find that business.' });
      return null;
    }
    return business;
  }

  function setSessionCookie(res, token) {
    res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { ...cookieBase, httpOnly: true }));
  }

  function rotateCsrf(res, req) {
    const token = randomToken(32);
    res.append('Set-Cookie', serializeCookie(CSRF_COOKIE, token, { ...cookieBase, httpOnly: false }));
    req.cookies[CSRF_COOKIE] = token;
    return token;
  }

  const loginIpLimiter = limits.ipLimiter(() => db, 'login', 10, 15 * limits.MINUTE);
  const adminIpLimiter = limits.ipLimiter(() => db, 'admin', 100, 15 * limits.MINUTE);

  // ---- public profile

  app.get('/api/b/:slug', (req, res) => {
    const business = findBusiness(req, res);
    if (!business) return;

    const reviews = db
      .prepare(
        `SELECT r.id, r.rating, r.comment, r.reply, r.replied_at, r.created_at, u.first_name
           FROM reviews r
           JOIN users u ON u.id = r.user_id
          WHERE r.business_id = ? AND r.status = 'visible'
          ORDER BY r.id DESC
          LIMIT ?`,
      )
      .all(business.id, config.maxVisibleReviews);

    // "verified" means they went through email. Most reviewers never do, and
    // can still write: the device cookie is identity enough.
    const me = { verified: Boolean(req.session), firstName: null, review: null, suspended: false };
    if (req.user) {
      me.firstName = req.user.firstName || null;
      me.suspended = req.user.suspended;
      const own = db
        .prepare('SELECT * FROM reviews WHERE business_id = ? AND user_id = ?')
        .get(business.id, req.user.id);
      me.review = own ? ownReview(own) : null;
    }

    res.json({
      business: {
        slug: business.slug,
        name: business.name,
        category: business.category,
        address: business.address,
        description: business.description,
        googleReviewUrl: business.google_review_url || '',
        requireEmail: Boolean(business.require_email),
      },
      stats: businessStats(db, business.id),
      reviews: reviews.map(publicReview),
      maxVisibleReviews: config.maxVisibleReviews,
      // Per business: a business with Google sign-in switched off never loads
      // the prompt, even when the server has a client id.
      googleClientId: business.google_signin ? config.googleClientId : '',
      topics: topicsFor(business),
      limits: { commentMin: DRAFT_MIN, commentMax: DRAFT_MAX, noteMax: NOTE_MAX },
      me,
      csrfToken: req.csrfToken,
    });
  });

  // ---- QR codes

  app.get('/api/b/:slug/qr.:format(png|svg)', async (req, res, next) => {
    const business = findBusiness(req, res);
    if (!business) return;
    const target = `${config.baseUrl}/b/${business.slug}`;
    // Error correction M, quiet zone of 2 modules, black on white.
    const options = {
      errorCorrectionLevel: 'M',
      margin: 2,
      color: { dark: '#101418ff', light: '#ffffffff' },
    };
    try {
      const download = req.query.download === '1';
      const filename = `${business.slug}-qr.${req.params.format}`;
      // The image depends on BASE_URL, which can change. Revalidate rather than
      // cache, so nobody is ever handed a code pointing at the old address.
      // Express adds an ETag, so an unchanged code still costs one 304.
      res.set('Cache-Control', 'no-cache');
      res.set(
        'Content-Disposition',
        `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
      );
      if (req.params.format === 'svg') {
        const svg = await QRCode.toString(target, { ...options, type: 'svg' });
        res.type('image/svg+xml').send(svg);
      } else {
        const png = await QRCode.toBuffer(target, { ...options, type: 'png', width: 640 });
        res.type('image/png').send(png);
      }
    } catch (error) {
      next(error);
    }
  });

  // ---- auth

  app.post('/api/auth/request-code', loginIpLimiter, requireCsrf, async (req, res, next) => {
    const body = req.body ?? {};
    const email = cleanEmail(body.email);
    const firstName = clean(body.firstName, NAME_MAX);
    // Same reply in every case below, so the response never reveals whether an
    // address is known, suspended or rate limited.
    const sameReply = () =>
      res.json({ ok: true, message: 'If that address can receive mail, a 6-digit code is on its way.' });

    if (clean(body.company, 80)) return sameReply(); // honeypot
    if (!isEmail(email)) {
      return res.status(400).json({ error: 'Please enter an email address like you@example.com.' });
    }
    if (!firstName || firstName.length < 2) {
      return res.status(400).json({ error: 'Please enter your first name (at least 2 characters).' });
    }

    const perEmail = limits.consume(db, `code-req:email:${email}`, 5, limits.HOUR);
    const perIp = limits.consume(db, `code-req:ip:${req.clientIp}`, 5, limits.HOUR);
    if (!perEmail.allowed || !perIp.allowed) return sameReply();

    const user = upsertUser(db, { email, firstName });
    if (user.suspended) return sameReply();

    const code = generateLoginCode();
    // Only the newest code for an address is valid.
    db.prepare('DELETE FROM login_codes WHERE email = ?').run(email);
    db.prepare(
      'INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)',
    ).run(email, hashCode(email, code), Date.now() + CODE_TTL_MS, nowIso());

    try {
      await mailer.sendLoginCode(email, code);
    } catch (error) {
      logger.error?.(`[auth] could not send the login code: ${error.message}`);
      return res.status(502).json({ error: 'We could not send the email just now. Please try again in a minute.' });
    }
    return sameReply();
  });

  app.post('/api/auth/verify-code', loginIpLimiter, requireCsrf, (req, res) => {
    const body = req.body ?? {};
    const email = cleanEmail(body.email);
    const code = clean(body.code, 12).replace(/\D/g, '');
    const invalid = () => res.status(400).json({ error: 'That code is not right. Check it, or ask for a new one.' });

    if (!isEmail(email) || code.length !== 6) return invalid();

    const row = db
      .prepare('SELECT * FROM login_codes WHERE email = ? ORDER BY id DESC LIMIT 1')
      .get(email);
    if (!row) return invalid();
    if (row.expires_at <= Date.now()) {
      db.prepare('DELETE FROM login_codes WHERE id = ?').run(row.id);
      return res.status(400).json({ error: 'That code has expired. Please ask for a new one.' });
    }
    if (row.attempts >= MAX_CODE_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many attempts. Please ask for a new code.' });
    }

    if (!timingSafeEqualStr(hashCode(email, code), row.code_hash)) {
      db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      const left = MAX_CODE_ATTEMPTS - (row.attempts + 1);
      return res.status(400).json({
        error: left > 0
          ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
          : 'Too many attempts. Please ask for a new code.',
      });
    }

    // Correct: the code is spent whatever happens next.
    db.prepare('DELETE FROM login_codes WHERE email = ?').run(email);

    const user = upsertUser(db, { email, firstName: clean(body.firstName, NAME_MAX) });
    if (user.suspended) {
      return res.status(403).json({ error: 'This account cannot sign in. Please contact the business.' });
    }

    const token = randomToken(32);
    const csrfToken = rotateCsrf(res, req);
    db.prepare(
      'INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(user.id, sha256(token), csrfToken, Date.now() + SESSION_TTL_MS, nowIso());
    setSessionCookie(res, token);

    return res.json({ signedIn: true, firstName: user.first_name, csrfToken });
  });

  app.post('/api/auth/logout', requireCsrf, (req, res) => {
    if (req.session) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(req.session.id);
    }
    res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { ...cookieBase, maxAge: 0, httpOnly: true }));
    res.json({ signedIn: false, csrfToken: rotateCsrf(res, req) });
  });

  // Google One Tap. The page sends the ID token Google handed it; we check it
  // against Google's signing keys and start a session. This identifies the
  // customer - it does not give us any power to post on Google.
  app.post('/api/auth/google', loginIpLimiter, requireCsrf, async (req, res) => {
    if (!googleVerifier) {
      return res.status(503).json({ error: 'Google sign-in is not set up on this server.' });
    }
    let identity;
    try {
      identity = await googleVerifier.verify(req.body?.credential);
    } catch (error) {
      logger.warn?.(`[auth] rejected a Google token: ${error.message}`);
      return res.status(401).json({ error: 'We could not confirm that Google account. Please try again.' });
    }

    const user = upsertGoogleUser(
      db,
      {
        sub: identity.sub,
        email: identity.emailVerified ? identity.email : '',
        firstName: clean(identity.firstName, NAME_MAX),
      },
      // Lets a review they just left anonymously stay theirs.
      req.user && !req.session ? req.user.id : null,
    );
    if (user.suspended) {
      return res.status(403).json({ error: 'This account cannot post reviews.' });
    }

    const token = randomToken(32);
    const csrfToken = rotateCsrf(res, req);
    db.prepare(
      'INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(user.id, sha256(token), csrfToken, Date.now() + SESSION_TTL_MS, nowIso());
    setSessionCookie(res, token);

    return res.json({ signedIn: true, firstName: user.first_name, csrfToken });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.json({ signedIn: false, csrfToken: req.csrfToken });
    return res.json({
      signedIn: true,
      firstName: req.user.firstName,
      suspended: req.user.suspended,
      csrfToken: req.session.csrfToken,
    });
  });

  // ---- suggestions

  app.post('/api/suggest', requireCsrf, async (req, res, next) => {
    const body = req.body ?? {};
    const business = db
      .prepare('SELECT * FROM businesses WHERE slug = ?')
      .get(clean(body.slug, 80).toLowerCase());
    if (!business) return res.status(404).json({ error: 'We could not find that business.' });

    const user = reviewer(req, res, business);
    if (!user) return undefined;

    const rating = parseRating(body.rating);
    if (!rating) return res.status(400).json({ error: 'Please choose a star rating first.' });

    const note = clean(body.note, NOTE_MAX);
    const topics = parseTopics(body.topics, topicsFor(business));

    // Charged per device and per IP: a device is cheap to reset by clearing
    // cookies, so the address is the backstop.
    const limit = limits.consume(db, `suggest:user:${user.id}`, 10, limits.HOUR);
    const perIp = limits.consume(db, `suggest:ip:${req.clientIp}`, 30, limits.HOUR);
    if (!limit.allowed || !perIp.allowed) {
      const retryAfter = Math.max(limit.retryAfterSeconds, perIp.retryAfterSeconds);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'You have asked for a lot of drafts in the last hour. Please write your review in your own words, or try again later.',
      });
    }

    try {
      // Only these five fields leave the server. No email, name, IP or user id.
      const { drafts, source } = await suggester.suggest(
        {
          businessName: business.name,
          category: business.category,
          rating,
          topics,
          note,
        },
        { useModel: Boolean(business.ai_drafts) },
      );
      return res.json({ drafts, source, rating, topics, note });
    } catch (error) {
      return next(error);
    }
  });

  // ---- reviews

  app.post('/api/b/:slug/reviews', requireCsrf, (req, res) => {
    const business = findBusiness(req, res);
    if (!business) return undefined;
    const body = req.body ?? {};
    if (clean(body.company, 80)) {
      return res.status(400).json({ error: 'That submission looked automated. Please try again.' });
    }

    const rating = parseRating(body.rating);
    if (!rating) return res.status(400).json({ error: 'Please choose a star rating.' });
    const comment = clean(body.comment, DRAFT_MAX + 1);
    if (comment.length < DRAFT_MIN || comment.length > DRAFT_MAX) {
      return res.status(400).json({
        error: `Your review needs to be between ${DRAFT_MIN} and ${DRAFT_MAX} characters.`,
      });
    }

    const user = reviewer(req, res, business);
    if (!user) return undefined;

    const existing = db
      .prepare('SELECT id FROM reviews WHERE business_id = ? AND user_id = ?')
      .get(business.id, user.id);
    if (existing) {
      return res.status(409).json({ error: 'You already reviewed this business.' });
    }

    const limit = limits.peek(db, `review:user:${user.id}`, 3, limits.HOUR);
    const perIp = limits.peek(db, `review:ip:${req.clientIp}`, 10, limits.HOUR);
    if (!limit.allowed || !perIp.allowed) {
      res.set('Retry-After', String(Math.max(limit.retryAfterSeconds, perIp.retryAfterSeconds)));
      return res.status(429).json({ error: 'You have posted several reviews in the last hour. Please try again later.' });
    }

    let row;
    try {
      const info = db
        .prepare(
          `INSERT INTO reviews (business_id, user_id, rating, comment, status, created_at)
           VALUES (?, ?, ?, ?, 'visible', ?)`,
        )
        .run(business.id, user.id, rating, comment, nowIso());
      row = db.prepare('SELECT * FROM reviews WHERE id = ?').get(info.lastInsertRowid);
    } catch (error) {
      // The UNIQUE (business_id, user_id) index is the real guard against a
      // double post from two requests racing each other.
      if (String(error.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'You already reviewed this business.' });
      }
      throw error;
    }

    // Only successful posts count against the limits.
    limits.hit(db, `review:user:${user.id}`);
    limits.hit(db, `review:ip:${req.clientIp}`);
    return res.status(201).json({ review: ownReview(row), stats: businessStats(db, business.id) });
  });

  app.put('/api/b/:slug/reviews/me', requireCsrf, (req, res) => {
    const business = findBusiness(req, res);
    if (!business) return undefined;
    const user = existingReviewer(req, res);
    if (!user) return undefined;
    const existing = db
      .prepare('SELECT * FROM reviews WHERE business_id = ? AND user_id = ?')
      .get(business.id, user.id);
    if (!existing) {
      return res.status(404).json({ error: 'You have not reviewed this business yet.' });
    }

    const body = req.body ?? {};
    const rating = body.rating === undefined ? existing.rating : parseRating(body.rating);
    if (!rating) return res.status(400).json({ error: 'Please choose a star rating.' });
    const comment = body.comment === undefined ? existing.comment : clean(body.comment, DRAFT_MAX + 1);
    if (comment.length < DRAFT_MIN || comment.length > DRAFT_MAX) {
      return res.status(400).json({
        error: `Your review needs to be between ${DRAFT_MIN} and ${DRAFT_MAX} characters.`,
      });
    }

    // A business reply was written about the words that were there before, so
    // a real change drops it rather than leaving the answer under new text. An
    // identical re-save changes nothing and keeps it.
    const changed = rating !== existing.rating || comment !== existing.comment;
    if (changed && existing.reply) {
      db.prepare("UPDATE reviews SET reply = '', replied_at = NULL WHERE id = ?").run(existing.id);
    }
    db.prepare('UPDATE reviews SET rating = ?, comment = ? WHERE id = ? AND user_id = ?')
      .run(rating, comment, existing.id, user.id);
    const row = db.prepare('SELECT * FROM reviews WHERE id = ?').get(existing.id);
    return res.json({ review: ownReview(row), stats: businessStats(db, business.id) });
  });

  app.delete('/api/b/:slug/reviews/me', requireCsrf, (req, res) => {
    const business = findBusiness(req, res);
    if (!business) return undefined;
    const user = existingReviewer(req, res);
    if (!user) return undefined;
    const info = db
      .prepare('DELETE FROM reviews WHERE business_id = ? AND user_id = ?')
      .run(business.id, user.id);
    if (!info.changes) {
      return res.status(404).json({ error: 'You have not reviewed this business yet.' });
    }
    return res.json({ deleted: true, stats: businessStats(db, business.id) });
  });

  // ---- admin
  //
  // These routes are authenticated with the x-admin-token header. A header is
  // not sent ambiently by a browser the way a cookie is, so the cookie-based
  // CSRF check does not apply here and curl can drive the admin API directly.

  // One shape for a business everywhere in the admin API, so the console sees
  // the same fields whether it just created one or is listing them all.
  function adminBusiness(row) {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      category: row.category,
      address: row.address,
      description: row.description,
      topics: topicsFor(row),
      googleReviewUrl: row.google_review_url || '',
      requireEmail: Boolean(row.require_email),
      aiDrafts: Boolean(row.ai_drafts),
      googleSignin: Boolean(row.google_signin),
      createdAt: row.created_at,
      url: `${config.baseUrl}/b/${row.slug}`,
      qrPng: `/api/b/${row.slug}/qr.png`,
      qrSvg: `/api/b/${row.slug}/qr.svg`,
    };
  }

  app.get('/api/admin/businesses', adminIpLimiter, requireAdmin, (req, res) => {
    const rows = db
      .prepare(
        `SELECT b.*,
                (SELECT COUNT(*) FROM reviews r WHERE r.business_id = b.id) AS review_count,
                (SELECT COUNT(*) FROM reviews r WHERE r.business_id = b.id AND r.status = 'visible') AS visible_count,
                (SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.business_id = b.id AND r.status = 'visible') AS average
           FROM businesses b
          ORDER BY b.id DESC`,
      )
      .all();
    res.json({
      baseUrl: config.baseUrl,
      businesses: rows.map((row) => ({
        ...adminBusiness(row),
        reviewCount: row.review_count,
        visibleCount: row.visible_count,
        average: row.average ?? 0,
      })),
    });
  });

  app.post('/api/admin/businesses', adminIpLimiter, requireAdmin, (req, res) => {
    const body = req.body ?? {};
    const name = clean(body.name, BUSINESS_NAME_MAX);
    if (name.length < 2) {
      return res.status(400).json({ error: 'Please give the business a name of at least 2 characters.' });
    }
    const google = normalizeGoogleUrl(body.googleReviewUrl);
    if (!google.ok) {
      return res.status(400).json({
        error: 'The Google review link has to be a Google address, or a place id from Google Business Profile.',
      });
    }

    const business = createBusiness(db, {
      name,
      category: clean(body.category, FIELD_MAX),
      address: clean(body.address, FIELD_MAX),
      description: clean(body.description, DESCRIPTION_MAX),
      topics: parseTopicList(body.topics ?? []),
      googleReviewUrl: google.url,
    });
    let created = business;
    if (setBusinessSwitches(db, business.id, body)) {
      created = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business.id);
    }
    return res.status(201).json({ business: adminBusiness(created) });
  });

  // Editing never changes the slug: that string is already printed on QR codes
  // standing on counters, and those have to keep working forever.
  app.patch('/api/admin/businesses/:id', adminIpLimiter, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'That is not a valid business id.' });
    const body = req.body ?? {};
    const changes = {};

    if (body.name !== undefined) {
      const name = clean(body.name, BUSINESS_NAME_MAX);
      if (name.length < 2) {
        return res.status(400).json({ error: 'Please give the business a name of at least 2 characters.' });
      }
      changes.name = name;
    }
    if (body.category !== undefined) changes.category = clean(body.category, FIELD_MAX);
    if (body.address !== undefined) changes.address = clean(body.address, FIELD_MAX);
    if (body.description !== undefined) changes.description = clean(body.description, DESCRIPTION_MAX);
    if (body.topics !== undefined) changes.topics = parseTopicList(body.topics);
    if (body.googleReviewUrl !== undefined) {
      const google = normalizeGoogleUrl(body.googleReviewUrl);
      if (!google.ok) {
        return res.status(400).json({
          error: 'The Google review link has to be a Google address, or a place id from Google Business Profile.',
        });
      }
      changes.googleReviewUrl = google.url;
    }

    let business = updateBusiness(db, id, changes);
    if (!business) return res.status(404).json({ error: 'We could not find that business.' });
    if (setBusinessSwitches(db, id, body)) {
      business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
    }
    return res.json({ business: adminBusiness(business) });
  });

  app.delete('/api/admin/businesses/:id', adminIpLimiter, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'That is not a valid business id.' });
    const info = db.prepare('DELETE FROM businesses WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'We could not find that business.' });
    return res.json({ deleted: true });
  });

  app.get('/api/admin/businesses/:id/reviews', adminIpLimiter, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'That is not a valid business id.' });
    const rows = db
      .prepare(
        `SELECT r.*, u.email, u.device_hash, u.first_name, u.suspended, u.id AS user_id
           FROM reviews r
           JOIN users u ON u.id = r.user_id
          WHERE r.business_id = ?
          ORDER BY r.id DESC`,
      )
      .all(id);
    res.json({ reviews: rows.map(adminReview) });
  });

  // Every review across every business, for the moderation list.
  app.get('/api/admin/reviews', adminIpLimiter, requireAdmin, (req, res) => {
    const rows = db
      .prepare(
        `SELECT r.*, u.email, u.device_hash, u.first_name, u.suspended, u.id AS user_id, b.name AS business_name, b.slug
           FROM reviews r
           JOIN users u ON u.id = r.user_id
           JOIN businesses b ON b.id = r.business_id
          ORDER BY r.id DESC
          LIMIT 500`,
      )
      .all();
    res.json({
      reviews: rows.map((row) => ({
        ...adminReview(row),
        businessName: row.business_name,
        slug: row.slug,
      })),
    });
  });

  function adminReview(row) {
    return {
      id: row.id,
      businessId: row.business_id,
      rating: row.rating,
      comment: row.comment,
      status: row.status,
      createdAt: row.created_at,
      reply: row.reply || '',
      repliedAt: row.replied_at || null,
      user: {
        id: row.user_id,
        email: row.email,
        // Most reviewers have no email, so moderation needs something stable to
        // recognise them by. A short prefix of the device hash is enough to
        // tell two reviewers apart without being a usable token.
        label: row.email || `Device ${String(row.device_hash ?? '').slice(0, 8)}`,
        firstName: row.first_name,
        suspended: Boolean(row.suspended),
      },
    };
  }

  app.patch('/api/admin/reviews/:id', adminIpLimiter, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'That is not a valid review id.' });
    const status = clean(req.body?.status, 10);
    if (status !== 'visible' && status !== 'hidden') {
      return res.status(400).json({ error: 'Status has to be "visible" or "hidden".' });
    }
    const info = db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, id);
    if (!info.changes) return res.status(404).json({ error: 'We could not find that review.' });
    return res.json({ id, status });
  });

  app.delete('/api/admin/reviews/:id', adminIpLimiter, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'That is not a valid review id.' });
    const info = db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'We could not find that review.' });
    return res.json({ deleted: true });
  });

  // The business's answer to a review. It is shown publicly under the review,
  // so it is held to the same cleaning as everything else a visitor reads, and
  // it carries no reviewer details of its own.
  app.put('/api/admin/reviews/:id/reply', adminIpLimiter, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'That is not a valid review id.' });
    const reply = clean(req.body?.reply, REPLY_MAX + 1);
    if (!reply || reply.length > REPLY_MAX) {
      return res.status(400).json({
        error: `A reply needs to be between 1 and ${REPLY_MAX} characters.`,
      });
    }
    const repliedAt = nowIso();
    const info = db
      .prepare('UPDATE reviews SET reply = ?, replied_at = ? WHERE id = ?')
      .run(reply, repliedAt, id);
    if (!info.changes) return res.status(404).json({ error: 'We could not find that review.' });
    return res.json({ id, reply, repliedAt });
  });

  app.delete('/api/admin/reviews/:id/reply', adminIpLimiter, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'That is not a valid review id.' });
    const info = db
      .prepare("UPDATE reviews SET reply = '', replied_at = NULL WHERE id = ?")
      .run(id);
    if (!info.changes) return res.status(404).json({ error: 'We could not find that review.' });
    return res.json({ id, reply: '', repliedAt: null });
  });

  app.get('/api/admin/users', adminIpLimiter, requireAdmin, (req, res) => {
    const rows = db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM reviews r WHERE r.user_id = u.id) AS review_count
           FROM users u ORDER BY u.id DESC LIMIT 500`,
      )
      .all();
    res.json({
      users: rows.map((row) => ({
        id: row.id,
        email: row.email,
        label: row.email || `Device ${String(row.device_hash ?? '').slice(0, 8)}`,
        firstName: row.first_name,
        suspended: Boolean(row.suspended),
        createdAt: row.created_at,
        reviewCount: row.review_count,
      })),
    });
  });

  app.patch('/api/admin/users/:id', adminIpLimiter, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'That is not a valid user id.' });
    if (typeof req.body?.suspended !== 'boolean') {
      return res.status(400).json({ error: 'Send {"suspended": true} or {"suspended": false}.' });
    }
    const suspended = req.body.suspended ? 1 : 0;
    const info = db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(suspended, id);
    if (!info.changes) return res.status(404).json({ error: 'We could not find that person.' });
    // A suspended user should not keep an active session.
    if (suspended) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return res.json({ id, suspended: Boolean(suspended) });
  });

  // ---- pages and static files

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
  // Before /b/:slug, so the poster is not read as a business called "poster".
  app.get('/b/:slug/poster', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'poster.html')));

  app.get('/b/:slug', (req, res) => {
    const business = db
      .prepare('SELECT * FROM businesses WHERE slug = ?')
      .get(clean(req.params.slug, 80).toLowerCase());
    // The page renders its own "not found" state; the status code is for
    // crawlers and link checkers.
    if (!business) {
      return res.status(404).sendFile(path.join(PUBLIC_DIR, 'business.html'));
    }
    return res.type('html').send(businessPage(db, business, config.baseUrl));
  });

  // "no-cache" means revalidate, not "do not store": the browser still keeps a
  // copy and the server still answers 304, but it always asks first. Filenames
  // here carry no version fingerprint, so a long max-age would leave customers
  // running an old business.js for an hour after a deploy.
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      extensions: [],
      etag: true,
      lastModified: true,
      setHeaders(res) {
        res.set('Cache-Control', 'no-cache');
      },
    }),
  );

  // ---- fallbacks

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'That endpoint does not exist.' });
    }
    return res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  /* eslint-disable-next-line no-unused-vars */
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'That request was too large.' });
    }
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'We could not read that request.' });
    }
    logger.error?.('[server]', error);
    return res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}

// --------------------------------------------------------------- entry point

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  loadEnv();
  const config = buildConfig();
  const problems = assertConfig(config);
  if (problems.length) {
    console.error('ReviewQR cannot start:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const db = openDb(config.dbPath);
  // Off in production: see config.seedDemo.
  if (config.seedDemo) seed(db);
  const mailer = createMailer(config);
  const suggester = createSuggester({ config });
  const googleVerifier = config.googleClientId
    ? createGoogleVerifier({ clientId: config.googleClientId })
    : null;
  const app = createApp({ config, db, mailer, suggester, googleVerifier });

  // Housekeeping: drop expired sessions, codes and rate-limit counters.
  const sweeper = setInterval(() => {
    try {
      limits.sweep(db);
    } catch (error) {
      console.error('[sweep]', error.message);
    }
  }, 10 * 60 * 1000);
  sweeper.unref();

  const server = app.listen(config.port, () => {
    console.log(`ReviewQR listening on ${config.baseUrl} (${config.nodeEnv})`);
    console.log(`  demo profile: ${config.baseUrl}/b/blue-door-cafe`);
    console.log(`  admin:        ${config.baseUrl}/admin`);
    if (!config.smtpConfigured) console.log('  email:        not configured, login codes print here');
    if (!config.anthropic.apiKey) console.log('  AI drafts:    no ANTHROPIC_API_KEY, using template drafts');
    console.log(
      config.googleClientId
        ? '  Google:       One Tap sign-in enabled'
        : '  Google:       no GOOGLE_CLIENT_ID, customers review with no sign-in',
    );
    console.log();
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}
