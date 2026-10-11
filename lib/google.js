// Verifies the ID token that Google One Tap hands the page.
//
// The token is a JWT signed by Google. Verifying it means checking the
// signature against Google's published keys and then checking the claims, which
// is done here with node:crypto rather than google-auth-library, to keep the
// dependency list at three packages.
//
// Nothing here can post a review to Google. It only establishes who the
// customer is, so the review on our own wall is tied to a real Google account.

import crypto from 'node:crypto';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
// A little slack for clock drift between us and Google.
const CLOCK_SKEW_SECONDS = 300;

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

export function createGoogleVerifier({ clientId, fetchImpl, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  let cache = { keys: new Map(), expiresAt: 0 };

  async function keyFor(kid) {
    if (cache.keys.has(kid) && cache.expiresAt > now()) {
      return cache.keys.get(kid);
    }
    const response = await doFetch(CERTS_URL);
    if (!response.ok) throw new Error(`Could not fetch Google's signing keys (${response.status}).`);
    const body = await response.json();

    // Respect Google's own cache lifetime, with a floor so a bad header cannot
    // make us refetch on every single sign-in.
    const control = response.headers?.get?.('cache-control') ?? '';
    const maxAge = Number(/max-age=(\d+)/.exec(control)?.[1] ?? 3600);
    const keys = new Map();
    for (const jwk of body?.keys ?? []) {
      if (jwk.kid) keys.set(jwk.kid, jwk);
    }
    cache = { keys, expiresAt: now() + Math.max(maxAge, 300) * 1000 };

    const found = keys.get(kid);
    if (!found) throw new Error('Google signed this token with a key we do not recognise.');
    return found;
  }

  // Returns the customer's Google identity, or throws. Callers treat any throw
  // as "not signed in".
  async function verify(idToken) {
    if (!clientId) throw new Error('Google sign-in is not configured.');
    if (typeof idToken !== 'string' || idToken.length > 8192) {
      throw new Error('That sign-in token is not usable.');
    }

    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('That sign-in token is malformed.');
    const [headerPart, payloadPart, signaturePart] = parts;

    let header;
    let payload;
    try {
      header = decodeSegment(headerPart);
      payload = decodeSegment(payloadPart);
    } catch {
      throw new Error('That sign-in token could not be read.');
    }

    // Only RS256, so a token claiming "alg": "none" cannot slip through.
    if (header.alg !== 'RS256' || !header.kid) {
      throw new Error('That sign-in token is not signed the way Google signs them.');
    }

    const jwk = await keyFor(header.kid);
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const verified = crypto
      .createVerify('RSA-SHA256')
      .update(`${headerPart}.${payloadPart}`)
      .verify(publicKey, Buffer.from(signaturePart, 'base64url'));
    if (!verified) throw new Error('That sign-in token has a bad signature.');

    if (!ISSUERS.has(payload.iss)) throw new Error('That sign-in token came from the wrong issuer.');
    // Without this check, a token minted for any other site would be accepted.
    if (payload.aud !== clientId) throw new Error('That sign-in token was issued for another site.');

    const seconds = Math.floor(now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < seconds) {
      throw new Error('That sign-in has expired. Please try again.');
    }
    if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_SECONDS > seconds) {
      throw new Error('That sign-in token is not valid yet.');
    }
    if (!payload.sub) throw new Error('That sign-in token has no account on it.');

    return {
      // The stable account id. Unlike an address, it never changes hands.
      sub: String(payload.sub),
      email: payload.email ? String(payload.email).toLowerCase() : '',
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      firstName: String(payload.given_name || payload.name || '').trim().slice(0, 40),
    };
  }

  return { verify };
}
