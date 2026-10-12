import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

/* Owner passwords.
 *
 * scrypt from node:crypto, so there is still nothing to compile - the whole
 * point of this app is that it installs with three npm packages and no native
 * build. scrypt is deliberately slow and memory-hard, which is what makes a
 * stolen database expensive to crack.
 *
 * Async rather than scryptSync: at these parameters a hash costs ~100ms of
 * pure CPU, and scryptSync would block the single thread for that long on
 * every sign-in - a handful of concurrent logins would stall the whole server,
 * reviewers included.
 */

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
// N=16384, r=8, p=1: the Node defaults, and still the usual recommendation for
// an interactive login. maxmem has to be raised because the default ceiling is
// just under what N=16384 needs.
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LENGTH, PARAMS, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

// Stored as scrypt$<salt hex>$<hash hex>. The prefix is there so a future
// change of algorithm can be told apart from this one rather than guessed at.
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(String(password), salt);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

// What to verify against when there is no account for that email. It has to be
// well formed, or verifyPassword rejects it on the shape alone and returns
// without paying scrypt's ~100ms - and that difference is exactly the oracle
// the decoy exists to close. The derived key it names is unreachable: no
// password hashes to 64 zero bytes under this salt in any useful sense, and
// the comparison is constant time either way.
export const NO_SUCH_ACCOUNT = `scrypt$${'00'.repeat(SALT_BYTES)}$${'00'.repeat(KEY_LENGTH)}`;

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (!salt.length || expected.length !== KEY_LENGTH) return false;

  const derived = await scrypt(String(password), salt);
  // timingSafeEqual throws on a length mismatch, which the check above rules
  // out, but the guard is cheap and the throw would be a 500.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// Returned as a list so the form can show everything wrong at once rather than
// making someone guess one rule at a time.
export function passwordProblems(password) {
  const value = typeof password === 'string' ? password : '';
  const problems = [];
  if (value.length < PASSWORD_MIN) {
    problems.push(`Use at least ${PASSWORD_MIN} characters.`);
  }
  if (value.length > PASSWORD_MAX) {
    problems.push(`Use at most ${PASSWORD_MAX} characters.`);
  }
  // Length does the real work, so this is the only composition rule: it only
  // rules out the handful of passwords that are one repeated character.
  if (value.length >= PASSWORD_MIN && new Set(value).size < 4) {
    problems.push('Use a mix of characters, not the same one repeated.');
  }
  return problems;
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase().slice(0, 200);
}

// Deliberately loose: the only authority on whether an address works is
// whether mail to it arrives, and over-strict patterns reject real addresses.
export function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? ''));
}
