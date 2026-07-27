// Local Supabase-token verification + how the client classifies an auth outage.
//
// Incident, 2026-07-27: the project's Supabase Auth (GoTrue) went soft — 18-22s
// on /auth/v1/health, 35s then 504 on /auth/v1/user — while Postgres stayed at
// 45ms. Because every authenticated route called supabase.auth.getUser() with no
// timeout, and turned ANY failure into `401 Invalid or expired session`:
//   • players saw "The server did not respond — retrying…" and could not load a
//     world (the 15s client timeout fired long before GoTrue answered), and
//   • any request that did complete looked like a dead session, so an outage
//     nobody could see could sign a player out mid-game.
//
// Two changes, both covered here:
//   1. src/lib/jwt.mjs verifies the token signature locally against the
//      project's published JWKS, so gameplay no longer depends on GoTrue being
//      up. These tests generate real ES256/RS256 keypairs and mint real tokens —
//      no network, no Supabase project.
//   2. an unreachable auth provider is a 503, and the web client treats
//      502/503/504 as TRANSIENT (retry) rather than as a bad session.
//
//   node tools/auth-verify-test.mjs

import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, sign as rawSign } from 'node:crypto';
import {
  AuthProviderUnavailableError,
  assertClaims,
  decodeJwt,
  jwkToKeyEntry,
  keysFromJwks,
  unverifiedSubject,
  verifyTokenWithKeys,
} from '../apps/headwinds-server/src/lib/jwt.mjs';
import { isTransientError, NetworkError } from '../apps/headwinds-web/src/api.js';

let passed = 0;
const check = (name, fn) => {
  try { fn(); passed += 1; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

// ── Test fixtures: a project signing key, and tokens minted with it ──────────
const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function makeEcKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, alg: 'ES256', privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } };
}
function makeRsaKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, alg: 'RS256', privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

function mint(key, claims, { header = {} } = {}) {
  const h = b64url(JSON.stringify({ alg: key.alg, kid: key.kid, typ: 'JWT', ...header }));
  const p = b64url(JSON.stringify(claims));
  const signingInput = Buffer.from(`${h}.${p}`, 'ascii');
  const sig = key.alg === 'ES256'
    // The JWS form of an ECDSA signature is the raw r‖s pair, not DER.
    ? rawSign('sha256', signingInput, { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
    : createSign('sha256').update(signingInput).end().sign(key.privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

const goodClaims = (over = {}) => ({
  iss: ISSUER,
  sub: '11111111-2222-3333-4444-555555555555',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'player@example.com',
  user_metadata: { full_name: 'A Player' },
  exp: Math.floor(NOW / 1000) + 3600,
  ...over,
});

const EC = makeEcKey('kid-ec-1');
const RSA = makeRsaKey('kid-rsa-1');
const KEYS = keysFromJwks({ keys: [EC.jwk, RSA.jwk] });
const opts = { now: NOW, issuer: ISSUER };

// ── 1. the happy path: a real token verifies with no network at all ──────────
check('a genuine ES256 token verifies locally', () => {
  const user = verifyTokenWithKeys(mint(EC, goodClaims()), KEYS, opts);
  assert.equal(user.id, '11111111-2222-3333-4444-555555555555');
  assert.equal(user.email, 'player@example.com');
  assert.equal(user.user_metadata.full_name, 'A Player');
});

check('a genuine RS256 token verifies too (older projects)', () => {
  assert.equal(verifyTokenWithKeys(mint(RSA, goodClaims()), KEYS, opts).email, 'player@example.com');
});

check('a JWKS parses into one usable key per entry', () => {
  assert.equal(KEYS.size, 2);
  assert.equal(KEYS.get('kid-ec-1').alg, 'ES256');
});

check('unusable JWKS entries are skipped, not fatal', () => {
  const keys = keysFromJwks({ keys: [{ kid: 'oct-1', kty: 'oct', alg: 'HS256' }, EC.jwk, null] });
  assert.equal(keys.size, 1);
  assert.equal(jwkToKeyEntry({ kty: 'EC' }), null); // no kid
  assert.equal(keysFromJwks(null).size, 0);
});

// ── 2. forgery and tampering ────────────────────────────────────────────────
check('a token signed by the WRONG key is rejected', () => {
  const attacker = makeEcKey('kid-ec-1'); // same kid, different key material
  assert.throws(() => verifyTokenWithKeys(mint(attacker, goodClaims()), KEYS, opts), { statusCode: 401 });
});

check('a tampered payload is rejected', () => {
  const token = mint(EC, goodClaims());
  const [h, , s] = token.split('.');
  const forged = `${h}.${b64url(JSON.stringify(goodClaims({ sub: 'someone-else' })))}.${s}`;
  assert.throws(() => verifyTokenWithKeys(forged, KEYS, opts), { statusCode: 401 });
});

check('alg:none is rejected — never trust the token\'s own algorithm', () => {
  const h = b64url(JSON.stringify({ alg: 'none', kid: 'kid-ec-1', typ: 'JWT' }));
  const p = b64url(JSON.stringify(goodClaims()));
  assert.throws(() => verifyTokenWithKeys(`${h}.${p}.`, KEYS, opts), { statusCode: 401 });
});

check('algorithm substitution (claiming RS256 against an EC key) is rejected', () => {
  const token = mint(EC, goodClaims(), { header: { alg: 'RS256' } });
  assert.throws(() => verifyTokenWithKeys(token, KEYS, opts), { statusCode: 401 });
});

check('garbage that is not a JWT is rejected, not crashed on', () => {
  for (const bad of ['', 'not.a.jwt', 'a.b', null, undefined, 'x'.repeat(200)]) {
    assert.throws(() => verifyTokenWithKeys(bad, KEYS, opts), { statusCode: 401 });
  }
  assert.equal(decodeJwt('a.b'), null);
  assert.equal(unverifiedSubject('nonsense'), null);
});

// ── 3. claim rules ──────────────────────────────────────────────────────────
check('an expired token is rejected', () => {
  const token = mint(EC, goodClaims({ exp: Math.floor(NOW / 1000) - 120 }));
  assert.throws(() => verifyTokenWithKeys(token, KEYS, opts), { statusCode: 401 });
});

check('a token from ANOTHER Supabase project is rejected', () => {
  const token = mint(EC, goodClaims({ iss: 'https://someone-else.supabase.co/auth/v1' }));
  assert.throws(() => verifyTokenWithKeys(token, KEYS, opts), { statusCode: 401 });
});

check('an anon-role token (aud != authenticated) is rejected', () => {
  const token = mint(EC, goodClaims({ aud: 'anon' }));
  assert.throws(() => verifyTokenWithKeys(token, KEYS, opts), { statusCode: 401 });
  // …but the array form Supabase sometimes emits is fine.
  assert.ok(verifyTokenWithKeys(mint(EC, goodClaims({ aud: ['authenticated'] })), KEYS, opts));
});

check('a token with no exp at all is rejected', () => {
  const c = goodClaims(); delete c.exp;
  assert.throws(() => verifyTokenWithKeys(mint(EC, c), KEYS, opts), { statusCode: 401 });
  assert.throws(() => assertClaims({ sub: 'x', iss: ISSUER, aud: 'authenticated' }, opts), { statusCode: 401 });
});

check('small clock skew between us and Supabase is tolerated', () => {
  // Expired 10s ago by our clock — inside the skew allowance, so still valid.
  const token = mint(EC, goodClaims({ exp: Math.floor(NOW / 1000) - 10 }));
  assert.ok(verifyTokenWithKeys(token, KEYS, opts));
});

// ── 4. unknown kid means "ask someone else", NOT "reject" ───────────────────
check('an unknown kid returns null so the caller can refresh or fall back', () => {
  const other = makeEcKey('kid-rotated');
  assert.equal(verifyTokenWithKeys(mint(other, goodClaims()), KEYS, opts), null);
  // An empty key set (JWKS unreachable) behaves the same way — never a 401.
  assert.equal(verifyTokenWithKeys(mint(EC, goodClaims()), new Map(), opts), null);
});

check('the unverified subject is readable for a cache lookup', () => {
  assert.equal(unverifiedSubject(mint(EC, goodClaims())), '11111111-2222-3333-4444-555555555555');
});

// ── 5. an unreachable provider is transient, a bad token is not ─────────────
check('AuthProviderUnavailableError is a 503, not a 401', () => {
  const e = new AuthProviderUnavailableError(new Error('504'));
  assert.equal(e.statusCode, 503);
  assert.match(e.message, /not responding/);
});

check('the client retries 502/503/504 instead of ending the session', () => {
  // THE REGRESSION THIS GUARDS: a 35s GoTrue timeout used to reach the client as
  // 401 and latch the session dead. It now arrives as 503 and must read as
  // transient, so the poller simply tries again.
  for (const status of [502, 503, 504]) {
    const e = new Error('Sign-in service is not responding — retrying…'); e.status = status;
    assert.equal(isTransientError(e), true, `${status} must be transient`);
  }
});

check('a real 401 still ends the session, and 500 still surfaces', () => {
  const unauth = new Error('Invalid or expired session'); unauth.status = 401;
  assert.equal(isTransientError(unauth), false);
  const boom = new Error('boom'); boom.status = 500; // our bug, not an outage
  assert.equal(isTransientError(boom), false);
  assert.equal(isTransientError(new NetworkError('offline')), true);
});

if (process.exitCode) console.error(`\nauth-verify-test: ${passed} passed, failures above`);
else console.log(`auth-verify-test: ${passed}/${passed} passed`);
