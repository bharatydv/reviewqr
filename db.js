import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The slug is in every printed QR code, so it is set once and never changed.
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  -- JSON array of topic chips. Empty means "use DEFAULT_TOPICS".
  topics      TEXT NOT NULL DEFAULT '',
  -- Where "post this to Google" sends the customer. Empty hides the button.
  google_review_url TEXT NOT NULL DEFAULT '',
  -- Off by default: customers review without being asked anything. Turn it on
  -- for a business that wants every reviewer to verify an email first.
  require_email INTEGER NOT NULL DEFAULT 0 CHECK (require_email IN (0, 1)),
  -- The optional integrations, per business. On by default, so a business
  -- behaves exactly as the server is configured unless the admin turns one off
  -- for it. Switching one off here never needs a restart or a key change.
  ai_drafts     INTEGER NOT NULL DEFAULT 1 CHECK (ai_drafts IN (0, 1)),
  google_signin INTEGER NOT NULL DEFAULT 1 CHECK (google_signin IN (0, 1)),
  -- Who manages this business. NULL means nobody has claimed it yet, which is
  -- how every business created before accounts existed starts out; only a
  -- platform admin sees those.
  owner_id    INTEGER REFERENCES owners (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);
-- The index on owner_id is NOT here. On an existing database CREATE TABLE IF
-- NOT EXISTS does nothing, so the column does not appear until migrate() adds
-- it below - and an index over a column that is not there yet is an error that
-- takes the whole process down on startup. It is created after the migration.

-- A reviewer. Normally just a device: the browser that scanned the code, known
-- by the hash of a cookie it was given. email is only set for the businesses
-- that ask customers to verify one.
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT UNIQUE,
  device_hash TEXT UNIQUE,
  -- The Google account id (the "sub" claim), when they signed in with Google.
  google_sub  TEXT UNIQUE,
  first_name  TEXT NOT NULL DEFAULT '',
  suspended   INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes (email, id DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- A business owner: somebody who signs in to the console and manages their own
-- venues. Entirely separate from users, who are reviewers and never have a
-- password - conflating the two would mean a reviewer's device cookie and an
-- owner's password sat behind the same identity.
CREATE TABLE IF NOT EXISTS owners (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  -- A platform admin sees every business, not just their own. The first
  -- account created gets this, so a fresh install has somebody in charge.
  is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  suspended     INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_sessions_owner ON owner_sessions (owner_id);

-- Password reset codes. Separate from login_codes, which belong to reviewers:
-- a code that can reset a password should never be interchangeable with one
-- that just proves an email address.
CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_resets_owner ON password_resets (owner_id, id DESC);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  -- The business's public answer, shown under the review. Empty means none.
  reply       TEXT NOT NULL DEFAULT '',
  replied_at  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (business_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_business_status ON reviews (business_id, status, id DESC);

-- Sliding-window counters for rate limits. Kept in SQLite so the login-code
-- and review limits survive a restart.
CREATE TABLE IF NOT EXISTS rate_hits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_hits_bucket ON rate_hits (bucket, created_at);
`;

// The topic chips a business gets when it has not chosen its own.
export const DEFAULT_TOPICS = ['Service', 'Food', 'Price', 'Cleanliness', 'Staff', 'Atmosphere'];
export const MAX_TOPICS = 8;
export const TOPIC_MAX_LENGTH = 24;

export function nowIso() {
  return new Date().toISOString();
}

// Accepts an array or a comma-separated string and returns clean topic labels.
export function parseTopicList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const label = entry.replace(/\s+/g, ' ').trim().slice(0, TOPIC_MAX_LENGTH);
    if (!label) continue;
    if (out.some((existing) => existing.toLowerCase() === label.toLowerCase())) continue;
    out.push(label);
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

// A business row's topics, falling back to the defaults.
export function topicsFor(business) {
  if (!business?.topics) return [...DEFAULT_TOPICS];
  try {
    const parsed = JSON.parse(business.topics);
    const topics = parseTopicList(parsed);
    return topics.length ? topics : [...DEFAULT_TOPICS];
  } catch {
    return [...DEFAULT_TOPICS];
  }
}

export function slugify(input, fallback = 'business') {
  const base = String(input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || fallback;
}

export function openDb(dbPath = ':memory:') {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Brings an older database up to the current schema, so an existing install
// keeps its businesses, reviews and printed QR codes.
export function migrate(db) {
  const businessColumns = new Set(
    db.prepare('PRAGMA table_info(businesses)').all().map((row) => row.name),
  );
  if (!businessColumns.has('topics')) {
    db.exec("ALTER TABLE businesses ADD COLUMN topics TEXT NOT NULL DEFAULT ''");
  }
  if (!businessColumns.has('google_review_url')) {
    db.exec("ALTER TABLE businesses ADD COLUMN google_review_url TEXT NOT NULL DEFAULT ''");
  }
  if (!businessColumns.has('require_email')) {
    db.exec(
      'ALTER TABLE businesses ADD COLUMN require_email INTEGER NOT NULL DEFAULT 0 CHECK (require_email IN (0, 1))',
    );
  }
  if (!businessColumns.has('ai_drafts')) {
    db.exec(
      'ALTER TABLE businesses ADD COLUMN ai_drafts INTEGER NOT NULL DEFAULT 1 CHECK (ai_drafts IN (0, 1))',
    );
  }
  if (!businessColumns.has('google_signin')) {
    db.exec(
      'ALTER TABLE businesses ADD COLUMN google_signin INTEGER NOT NULL DEFAULT 1 CHECK (google_signin IN (0, 1))',
    );
  }

  if (!businessColumns.has('owner_id')) {
    // Existing businesses keep working and stay visible to a platform admin
    // until somebody claims them; printed QR codes are untouched either way.
    db.exec('ALTER TABLE businesses ADD COLUMN owner_id INTEGER REFERENCES owners (id) ON DELETE SET NULL');
  }
  // Unconditional, and after the ALTER: a fresh database has the column from
  // the schema and an upgraded one has just gained it, so this is the one place
  // that can index it for both.
  db.exec('CREATE INDEX IF NOT EXISTS idx_businesses_owner ON businesses (owner_id)');

  const reviewColumns = new Set(
    db.prepare('PRAGMA table_info(reviews)').all().map((row) => row.name),
  );
  if (!reviewColumns.has('reply')) {
    db.exec("ALTER TABLE reviews ADD COLUMN reply TEXT NOT NULL DEFAULT ''");
  }
  if (!reviewColumns.has('replied_at')) {
    db.exec('ALTER TABLE reviews ADD COLUMN replied_at TEXT');
  }

  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  if (userColumns.has('device_hash') && !userColumns.has('google_sub')) {
    db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub)');
  }
  if (!userColumns.has('device_hash')) {
    // email used to be NOT NULL, and SQLite cannot relax that in place, so the
    // table is rebuilt. Foreign keys are suspended for the swap; the references
    // from reviews and sessions follow the rename.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE users_rebuilt (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        email       TEXT UNIQUE,
        device_hash TEXT UNIQUE,
        google_sub  TEXT UNIQUE,
        first_name  TEXT NOT NULL DEFAULT '',
        suspended   INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
        created_at  TEXT NOT NULL
      );
      INSERT INTO users_rebuilt (id, email, device_hash, google_sub, first_name, suspended, created_at)
        SELECT id, email, NULL, NULL, first_name, suspended, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_rebuilt RENAME TO users;
      COMMIT;
    `);
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Picks a unique slug, appending -2, -3, ... when the base is taken.
export function uniqueSlug(db, name) {
  const base = slugify(name);
  const taken = db.prepare('SELECT 1 FROM businesses WHERE slug = ?');
  if (!taken.get(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.get(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function createBusiness(
  db,
  { name, category = '', address = '', description = '', topics = [], googleReviewUrl = '' },
) {
  const slug = uniqueSlug(db, name);
  const chosen = parseTopicList(topics);
  const info = db
    .prepare(
      `INSERT INTO businesses (slug, name, category, address, description, topics, google_review_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      slug,
      name,
      category,
      address,
      description,
      chosen.length ? JSON.stringify(chosen) : '',
      googleReviewUrl,
      nowIso(),
    );
  return db.prepare('SELECT * FROM businesses WHERE id = ?').get(info.lastInsertRowid);
}

// The per-business switches: which of the optional integrations this business
// uses. They are kept together because they are all booleans the admin flips,
// they all default to the server's own configuration, and none of them can
// change the slug.
export const BUSINESS_SWITCHES = {
  requireEmail: 'require_email',
  aiDrafts: 'ai_drafts',
  googleSignin: 'google_signin',
};

// Applies only the switches actually present as booleans, so a PATCH that
// mentions none of them leaves all three alone.
export function setBusinessSwitches(db, id, changes = {}) {
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(BUSINESS_SWITCHES)) {
    if (typeof changes[key] !== 'boolean') continue;
    sets.push(`${column} = ?`);
    values.push(changes[key] ? 1 : 0);
  }
  if (!sets.length) return false;
  values.push(id);
  const info = db.prepare(`UPDATE businesses SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return info.changes > 0;
}

// Updates the editable fields of a business. The slug is deliberately not one
// of them: it is printed in every QR code already out in the world.
export function updateBusiness(db, id, changes) {
  const current = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
  if (!current) return null;

  const next = {
    name: changes.name ?? current.name,
    category: changes.category ?? current.category,
    address: changes.address ?? current.address,
    description: changes.description ?? current.description,
    topics: current.topics,
    google_review_url: changes.googleReviewUrl ?? current.google_review_url,
  };
  if (changes.topics !== undefined) {
    const chosen = parseTopicList(changes.topics);
    next.topics = chosen.length ? JSON.stringify(chosen) : '';
  }

  db.prepare(
    `UPDATE businesses
        SET name = ?, category = ?, address = ?, description = ?, topics = ?, google_review_url = ?
      WHERE id = ?`,
  ).run(
    next.name,
    next.category,
    next.address,
    next.description,
    next.topics,
    next.google_review_url,
    id,
  );
  return db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
}

// The ordinary reviewer: a browser that scanned the code. The row is only
// created when they actually write something, so a passing bot that loads the
// page leaves nothing behind.
export function findUserByDevice(db, deviceHash) {
  if (!deviceHash) return null;
  return db.prepare('SELECT * FROM users WHERE device_hash = ?').get(deviceHash) ?? null;
}

export function upsertDeviceUser(db, deviceHash) {
  const existing = findUserByDevice(db, deviceHash);
  if (existing) return existing;
  const info = db
    .prepare('INSERT INTO users (email, device_hash, first_name, suspended, created_at) VALUES (NULL, ?, \'\', 0, ?)')
    .run(deviceHash, nowIso());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

// A customer who tapped "continue as ..." in the Google prompt.
//
// If the device they are on already wrote a review anonymously, that row is
// upgraded in place rather than orphaned, so the review they left a moment ago
// stays theirs.
export function upsertGoogleUser(db, { sub, email = '', firstName = '' }, deviceUserId = null) {
  const bySub = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(sub);
  if (bySub) {
    if (firstName && firstName !== bySub.first_name) {
      db.prepare('UPDATE users SET first_name = ? WHERE id = ?').run(firstName, bySub.id);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(bySub.id);
    }
    return bySub;
  }

  // Only claim an address that nobody else holds.
  const emailTaken = email
    ? db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    : null;

  // The row this device has been using, if it is still unclaimed.
  const device = deviceUserId
    ? db.prepare('SELECT * FROM users WHERE id = ? AND google_sub IS NULL AND email IS NULL').get(deviceUserId)
    : null;

  if (device) {
    db.prepare('UPDATE users SET google_sub = ?, email = ?, first_name = ? WHERE id = ?')
      .run(sub, emailTaken ? null : email || null, firstName || device.first_name, device.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(device.id);
  }

  if (emailTaken) {
    // They verified this address by email before. Same person, so link it.
    db.prepare('UPDATE users SET google_sub = ?, first_name = COALESCE(NULLIF(?, \'\'), first_name) WHERE id = ?')
      .run(sub, firstName, emailTaken.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(emailTaken.id);
  }

  const info = db
    .prepare(
      'INSERT INTO users (email, device_hash, google_sub, first_name, suspended, created_at) VALUES (?, NULL, ?, ?, 0, ?)',
    )
    .run(email || null, sub, firstName, nowIso());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

export function upsertUser(db, { email, firstName }) {
  const normalized = String(email).trim().toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);
  if (existing) {
    // A returning user may give a new first name; keep the latest non-empty one.
    if (firstName && firstName !== existing.first_name) {
      db.prepare('UPDATE users SET first_name = ? WHERE id = ?').run(firstName, existing.id);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
    }
    return existing;
  }
  const info = db
    .prepare('INSERT INTO users (email, first_name, suspended, created_at) VALUES (?, ?, 0, ?)')
    .run(normalized, firstName || 'Guest', nowIso());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

// Demo data so a fresh install has something to scan.
export function seed(db) {
  const existing = db.prepare('SELECT * FROM businesses WHERE slug = ?').get('blue-door-cafe');
  if (existing) return existing;

  const business = createBusiness(db, {
    name: 'Blue Door Café',
    category: 'Café',
    address: '18 Harbour Lane, Riverside',
    description: 'Small neighbourhood café with all-day breakfast and a quiet back room.',
  });

  const demo = [
    { email: 'maya@example.com', firstName: 'Maya', rating: 5, comment: 'Lovely spot to start the morning. The staff were warm without being pushy and my order came out quickly.' },
    { email: 'tomas@example.com', firstName: 'Tomas', rating: 4, comment: 'Good coffee and a calm room to work in. It got busy around noon, so service slowed a little, but I would come back.' },
    { email: 'priya@example.com', firstName: 'Priya', rating: 5, comment: 'Clean, friendly and reasonably priced. I appreciated how patient the team was while I made up my mind.' },
    {
      email: 'dan@example.com',
      firstName: 'Dan',
      rating: 3,
      comment: 'Pleasant atmosphere, though I waited longer than I expected at the counter. The place itself is nice and tidy.',
      // One demo reply, so a fresh install shows what an answer looks like.
      reply: 'Thank you Dan, and sorry about the wait at the counter. We have put a second person on the till over lunch since you came in.',
    },
  ];

  const insertReview = db.prepare(
    `INSERT INTO reviews (business_id, user_id, rating, comment, status, reply, replied_at, created_at)
     VALUES (?, ?, ?, ?, 'visible', ?, ?, ?)`,
  );
  demo.forEach((entry, index) => {
    const user = upsertUser(db, { email: entry.email, firstName: entry.firstName });
    // Stagger the timestamps so the list has believable dates.
    const createdAt = new Date(Date.now() - (demo.length - index) * 86400000).toISOString();
    const repliedAt = entry.reply
      ? new Date(Date.now() - (demo.length - index) * 86400000 + 3600000).toISOString()
      : null;
    insertReview.run(
      business.id,
      user.id,
      entry.rating,
      entry.comment,
      entry.reply ?? '',
      repliedAt,
      createdAt,
    );
  });
  return business;
}
