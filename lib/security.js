import crypto from 'node:crypto';

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// 32 random bytes, url-safe. Used for session tokens and CSRF tokens.
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// A 6-digit code from a cryptographic source, zero padded.
export function generateLoginCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Login codes only have a million possibilities, so a bare hash would be easy
// to reverse if the database leaked. Key the hash with a server-side pepper and
// bind it to the email so a stored hash cannot be replayed for another address.
export function makeCodeHasher(secret) {
  const key = crypto.createHash('sha256').update(`${secret}::reviewqr-login-code-pepper`).digest();
  return (email, code) =>
    crypto.createHmac('sha256', key).update(`${String(email).toLowerCase()}:${code}`).digest('hex');
}

// Length-independent constant-time comparison for secrets.
export function timingSafeEqualStr(a, b) {
  const left = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const right = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(left, right);
}
