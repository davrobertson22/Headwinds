// Local verification of Supabase access tokens — pure, network-free, no env.
//
// Split out of auth.mjs so the rules that decide "is this token genuine" can be
// tested directly against generated keypairs (tools/auth-verify-test.mjs). Auth
// code that can only be exercised through a live Supabase project is auth code
// nobody checks.
//
// Supabase signs access tokens with an asymmetric key (ES256 today, RS256 for
// projects on the older RSA setting) whose public half is published at
// {SUPABASE_URL}/auth/v1/.well-known/jwks.json. Checking the signature here
// means a GoTrue outage cannot take gameplay down with it — see the header of
// auth.mjs for the incident that motivated this.
import { createPublicKey, verify as verifySignature } from 'node:crypto';

// Tokens carry an `exp`; allow a little clock drift between us and Supabase.
export const CLOCK_SKEW_MS = 30_000;

export function unauthorized(message) {
  const e = new Error(message);
  e.statusCode = 401;
  return e;
}

// 503, not 401. The token may well be fine — we just cannot reach the service
// that would tell us. The client treats 503 as transient and retries; a 401
// would send the player to the sign-in screen over someone else's outage.
export class AuthProviderUnavailableError extends Error {
  constructor(cause) {
    super('Sign-in service is not responding — retrying…');
    this.name = 'AuthProviderUnavailableError';
    this.statusCode = 503;
    this.cause = cause;
  }
}

const b64urlToBuffer = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlToJson = (s) => JSON.parse(b64urlToBuffer(s).toString('utf8'));

// Split a compact JWS. Returns null for anything that isn't shaped like one —
// callers turn that into a 401, never a crash.
export function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: b64urlToJson(parts[0]),
      payload: b64urlToJson(parts[1]),
      signature: b64urlToBuffer(parts[2]),
      signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
    };
  } catch {
    return null;
  }
}

// The `sub` claim WITHOUT verifying the signature. Only ever safe as a lookup
// key into a cache whose entries were themselves created from verified tokens:
// a forged token can name any sub it likes, but it cannot put anything there.
export function unverifiedSubject(token) {
  return decodeJwt(token)?.payload?.sub ?? null;
}

// Turn one JWKS entry into a verifiable key. Unsupported algorithms return null
// so the caller falls back to the remote check rather than guessing.
export function jwkToKeyEntry(jwk) {
  if (!jwk || !jwk.kid) return null;
  const alg = jwk.alg || (jwk.kty === 'EC' ? 'ES256' : 'RS256');
  if (alg !== 'ES256' && alg !== 'RS256') return null;
  try {
    return { kid: jwk.kid, alg, key: createPublicKey({ key: jwk, format: 'jwk' }) };
  } catch {
    return null;
  }
}

// Build the kid → key map a verification pass needs, skipping anything we can't
// use. Never throws on a malformed key set.
export function keysFromJwks(jwks) {
  const keys = new Map();
  if (!Array.isArray(jwks?.keys)) return keys;
  for (const jwk of jwks.keys) {
    const entry = jwkToKeyEntry(jwk);
    if (entry) keys.set(entry.kid, entry);
  }
  return keys;
}

// ES256 signatures in a JWS are the raw r‖s pair, NOT the DER envelope Node
// defaults to — hence dsaEncoding. Getting this wrong rejects every valid token.
function signatureIsValid(entry, signingInput, signature) {
  if (entry.alg === 'ES256') {
    return verifySignature(
      'sha256', signingInput, { key: entry.key, dsaEncoding: 'ieee-p1363' }, signature,
    );
  }
  return verifySignature('sha256', signingInput, entry.key, signature);
}

// Claim checks, separate from signature verification: these are the rules a
// well-signed token from somewhere else (another Supabase project, an anon-role
// token, a stale one) still has to clear.
export function assertClaims(payload, { now = Date.now(), issuer } = {}) {
  if (!payload || typeof payload !== 'object') throw unauthorized('Invalid session token');
  if (!payload.sub) throw unauthorized('Invalid session token');
  if (issuer && payload.iss !== issuer) throw unauthorized('Invalid session token');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes('authenticated')) throw unauthorized('Invalid session token');
  if (typeof payload.exp !== 'number') throw unauthorized('Invalid session token');
  if (payload.exp * 1000 + CLOCK_SKEW_MS <= now) throw unauthorized('Invalid or expired session');
  return payload;
}

// Verify a token against an already-loaded key set.
//   → user object   the token is genuine and current
//   → null          we hold no key for this `kid` (caller may refresh or fall back)
//   → throws 401    the token is malformed, forged, or expired
export function verifyTokenWithKeys(token, keys, { now = Date.now(), issuer } = {}) {
  const decoded = decodeJwt(token);
  if (!decoded) throw unauthorized('Invalid session token');
  const { header, payload, signature, signingInput } = decoded;
  if (!header?.kid) return null;
  const entry = keys.get(header.kid);
  if (!entry) return null;
  // `alg: none` and algorithm-substitution stop here: verification always uses
  // the algorithm of the KEY we hold, and a token naming a different one is
  // rejected outright rather than quietly re-interpreted.
  if (header.alg !== entry.alg) throw unauthorized('Invalid session token');
  if (!signatureIsValid(entry, signingInput, signature)) throw unauthorized('Invalid session token');
  assertClaims(payload, { now, issuer });
  return {
    id: payload.sub,
    email: payload.email ?? null,
    user_metadata: payload.user_metadata ?? {},
  };
}
