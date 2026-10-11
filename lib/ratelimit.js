// Sliding-window rate limiting backed by the rate_hits table, so limits are not
// reset by a restart. `peek` reports whether another hit would be allowed and
// `hit` records one; keeping them separate lets callers charge a limit only on
// success (for example, only for reviews that were actually posted).

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;

function prune(db, bucket, windowMs, now) {
  db.prepare('DELETE FROM rate_hits WHERE bucket = ? AND created_at <= ?').run(bucket, now - windowMs);
}

export function count(db, bucket, windowMs, now = Date.now()) {
  prune(db, bucket, windowMs, now);
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM rate_hits WHERE bucket = ? AND created_at > ?')
    .get(bucket, now - windowMs);
  return row?.c ?? 0;
}

export function hit(db, bucket, now = Date.now()) {
  db.prepare('INSERT INTO rate_hits (bucket, created_at) VALUES (?, ?)').run(bucket, now);
}

// Seconds until the oldest hit in the window falls out of it.
export function retryAfter(db, bucket, windowMs, now = Date.now()) {
  const row = db
    .prepare('SELECT MIN(created_at) AS oldest FROM rate_hits WHERE bucket = ? AND created_at > ?')
    .get(bucket, now - windowMs);
  if (!row?.oldest) return Math.ceil(windowMs / 1000);
  return Math.max(1, Math.ceil((row.oldest + windowMs - now) / 1000));
}

export function peek(db, bucket, limit, windowMs, now = Date.now()) {
  const used = count(db, bucket, windowMs, now);
  if (used >= limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter(db, bucket, windowMs, now) };
  }
  return { allowed: true, remaining: limit - used, retryAfterSeconds: 0 };
}

// Check and charge in one step, for limits that count attempts rather than
// successes.
export function consume(db, bucket, limit, windowMs, now = Date.now()) {
  const result = peek(db, bucket, limit, windowMs, now);
  if (result.allowed) hit(db, bucket, now);
  return result;
}

// Express middleware form, keyed per IP.
export function ipLimiter(getDb, name, limit, windowMs) {
  return (req, res, next) => {
    const result = consume(getDb(), `${name}:ip:${req.clientIp}`, limit, windowMs);
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.',
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
    return next();
  };
}

// Removes expired counters, login codes and sessions.
export function sweep(db, now = Date.now()) {
  db.prepare('DELETE FROM rate_hits WHERE created_at <= ?').run(now - HOUR);
  db.prepare('DELETE FROM login_codes WHERE expires_at <= ?').run(now - HOUR);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}
