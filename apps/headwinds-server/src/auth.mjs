// Supabase auth: verify the bearer token on each request and map it to an Account.
//
// The browser signs in with Supabase (email / Google / Apple) and sends the
// resulting access token as `Authorization: Bearer <token>`. We verify it, then
// map it to a local Account row keyed by the Supabase user id — so the first
// authenticated request a new user makes "creates" their account.
//
// ── Why this file verifies tokens LOCALLY ────────────────────────────────────
// It used to call supabase.auth.getUser(token) on every cache miss: one network
// round-trip to GoTrue per request, with no timeout, and ANY failure — including
// GoTrue being down — collapsed into `401 Invalid or expired session`.
//
// 2026-07-27 outage: the project's GoTrue answered /auth/v1/health in 18-22s and
// /auth/v1/user in 35s → 504, while Postgres (/rest/v1/) stayed at 45ms. Every
// authenticated request inherited that hang. The web client time-boxes requests
// at 15s, so players got "The server did not respond — retrying…" and could not
// load a world at all. Worse, the requests that DID complete came back 401,
// which the client reads as a dead session — an outage with nothing to do with
// the player's session could sign them out mid-game.
//
// So: verify the signature ourselves against the project's published JWKS
// (src/lib/jwt.mjs). Existing sessions then keep playing straight through a
// GoTrue outage, and only *fresh sign-ins* — which have to talk to GoTrue
// anyway — are affected.
//
// The remote check survives as a fallback for tokens we cannot verify locally
// (a legacy HS256 project secret, or a JWKS we could not fetch). That path is
// time-boxed, and — this is the important part — it distinguishes "this token is
// bad" (401, permanent) from "the auth provider is unreachable" (503, transient,
// and answerable from a recently-cached account instead).
import { env } from './env.mjs';
import { prisma } from './db.mjs';
import {
  AuthProviderUnavailableError,
  keysFromJwks,
  unauthorized,
  unverifiedSubject,
  verifyTokenWithKeys,
} from './lib/jwt.mjs';

export { AuthProviderUnavailableError };

const ISSUER = `${env.supabaseUrl}/auth/v1`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const USER_URL = `${ISSUER}/user`;

// Signing keys rotate rarely; an unknown `kid` forces a refresh regardless, so a
// long TTL costs nothing and keeps us off the network.
const JWKS_TTL_MS = 10 * 60_000;
// Floor between refetch attempts, so a barrage of tokens with an unknown kid
// (or a JWKS endpoint that is down) can't turn into a request storm.
const JWKS_RETRY_MIN_MS = 30_000;
// Every call we make to the auth provider is time-boxed. The whole point of this
// file is that a wedged GoTrue cannot hold a game request open.
const AUTH_FETCH_TIMEOUT_MS = 5_000;

function forbidden(message) {
  const e = new Error(message);
  e.statusCode = 403;
  return e;
}

function bearerToken(request) {
  const h = request.headers.authorization || '';
  const [scheme, token] = h.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

// ── JWKS cache ───────────────────────────────────────────────────────────────

let jwksKeys = new Map();
let jwksFetchedAt = 0;
let jwksAttemptedAt = 0;
let jwksInFlight = null;

async function fetchJson(url, { headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    return { res, body: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

// Load (or refresh) the public key set. Never throws: a failure leaves the
// previous keys in place — possibly empty, in which case the caller falls back
// to the remote check.
async function loadJwks({ force = false, now = Date.now() } = {}) {
  if (jwksInFlight) return jwksInFlight;
  if (!force && jwksKeys.size && now - jwksFetchedAt < JWKS_TTL_MS) return jwksKeys;
  if (now - jwksAttemptedAt < JWKS_RETRY_MIN_MS) return jwksKeys;
  jwksAttemptedAt = now;
  jwksInFlight = fetchJson(JWKS_URL)
    .then(({ res, body }) => {
      if (!res.ok) return jwksKeys;
      const next = keysFromJwks(body);
      if (next.size) {
        jwksKeys = next;
        jwksFetchedAt = Date.now();
      }
      return jwksKeys;
    })
    .catch(() => jwksKeys)
    .finally(() => { jwksInFlight = null; });
  return jwksInFlight;
}

// ── Remote verification (fallback) ───────────────────────────────────────────
// Only reached for tokens we cannot check locally. Classifies the outcome so an
// unreachable provider never masquerades as a bad token.
async function verifyRemotely(token) {
  let res;
  let body;
  try {
    ({ res, body } = await fetchJson(USER_URL, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.supabaseAnonKey },
    }));
  } catch (e) {
    // Timeout, DNS, TLS, connection reset — the provider, not the token.
    throw new AuthProviderUnavailableError(e);
  }
  if (res.status === 401 || res.status === 403) throw unauthorized('Invalid or expired session');
  // 5xx (including the 504s this outage produced), 429, and anything else
  // unexpected are the provider's problem, not the player's.
  if (!res.ok || !body?.id) throw new AuthProviderUnavailableError(new Error(`auth ${res.status}`));
  return { id: body.id, email: body.email ?? null, user_metadata: body.user_metadata ?? {} };
}

// ── Account cache ────────────────────────────────────────────────────────────
// Keyed by Supabase user id, not by token: tokens rotate roughly hourly and
// keying on them threw the cache away for no reason. TTL is short so a ban / OG
// / admin change takes effect within seconds.
const ACCOUNT_TTL_MS = 30_000;
// How long a cached account may still answer requests while the auth provider is
// unreachable. Long enough to ride out an outage like 2026-07-27 without
// interrupting play; short enough that it is not a way around a ban.
export const ACCOUNT_OUTAGE_GRACE_MS = 10 * 60_000;

const accountCache = new Map(); // authUserId -> { account, at }
let lastAuthSweep = 0;
function sweepAuthCache(now) {
  if (now - lastAuthSweep < 60_000) return;
  lastAuthSweep = now;
  for (const [k, v] of accountCache) if (now - v.at > ACCOUNT_OUTAGE_GRACE_MS) accountCache.delete(k);
}

// A banned account is one an admin has locked out. The ban is account-wide, so
// we enforce it here — one gate covers every authenticated route in the app.
export function isBanned(account) {
  return Boolean(account?.bannedAt);
}

function assertNotBanned(account) {
  if (!isBanned(account)) return account;
  throw forbidden(
    account.banReason
      ? `Your account has been banned: ${account.banReason}`
      : 'Your account has been banned.'
  );
}

// Read-then-write: the overwhelmingly common case is an existing account whose
// email hasn't changed, and that case should cost a SELECT, not the UPSERT it
// used to. Across a few hundred polling players that is thousands of pointless
// writes an hour against the same Postgres the auth service depends on.
async function accountForUser(user, now) {
  const email = user.email ?? `${user.id}@no-email.local`;
  let account = await prisma.account.findUnique({ where: { authUserId: user.id } });
  if (!account) {
    const displayName =
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      email.split('@')[0];
    account = await prisma.account.create({ data: { authUserId: user.id, email, displayName } });
  } else if (account.email !== email) {
    account = await prisma.account.update({ where: { authUserId: user.id }, data: { email } });
  }
  accountCache.set(user.id, { account, at: now });
  return account;
}

// Verify a Supabase token and return the matching local Account (creating it on
// first sight). Throws 401 if the token is missing or invalid, 403 if the
// account has been banned, 503 if the auth provider is unreachable.
export async function resolveAccount(request) {
  const token = bearerToken(request);
  if (!token) throw unauthorized('Missing Authorization: Bearer <token>');

  const now = Date.now();
  sweepAuthCache(now);

  // 1. Local verification — the path virtually every request takes. A 401 from
  //    here is provable (bad signature, wrong issuer, expired) and final: no
  //    fallback could rescue it, so it propagates.
  let user = verifyTokenWithKeys(token, await loadJwks({ now }), { now, issuer: ISSUER });
  if (!user) {
    // Unknown kid — the project may have rotated its signing key, or we have no
    // keys yet. Refresh once (rate-limited inside loadJwks) before giving up.
    user = verifyTokenWithKeys(token, await loadJwks({ force: true, now }), { now, issuer: ISSUER });
  }

  // 2. Fallback for a token we hold no key for (legacy HS256 project, or a JWKS
  //    we could not fetch). Check the cache first so an outage doesn't stall
  //    players we already know.
  if (!user) {
    const known = accountCache.get(unverifiedSubject(token));
    if (known && now - known.at < ACCOUNT_TTL_MS) return assertNotBanned(known.account);
    try {
      user = await verifyRemotely(token);
    } catch (e) {
      if (e instanceof AuthProviderUnavailableError && known && now - known.at < ACCOUNT_OUTAGE_GRACE_MS) {
        request.log?.warn?.({ err: e.cause }, 'auth provider unreachable — serving cached account');
        return assertNotBanned(known.account);
      }
      throw e;
    }
  }

  // 3. Map the verified user to a local Account.
  const hit = accountCache.get(user.id);
  if (hit && now - hit.at < ACCOUNT_TTL_MS) return assertNotBanned(hit.account);
  return assertNotBanned(await accountForUser(user, now));
}

// Fastify preHandler: require a valid session and attach request.account.
// Usage: fastify.get('/me', { preHandler: requireAuth }, handler)
export async function requireAuth(request) {
  request.account = await resolveAccount(request);
}

// ── Admin gate ────────────────────────────────────────────────────────────────
// Admins are the accounts listed in the ADMIN_EMAILS env var (comma-separated,
// case-insensitive). For now ALL game worlds are operator-controlled: players
// join worlds, only admins create them (no auto-spawner). Admins also
// review player reports and issue/lift bans (routes/admin.mjs).

export function isAdmin(account) {
  return env.adminEmails.includes((account?.email ?? '').toLowerCase());
}

// Fastify preHandler: require a valid session belonging to an admin account.
// Usage: fastify.post('/worlds', { preHandler: requireAdmin }, handler)
export async function requireAdmin(request) {
  request.account = await resolveAccount(request);
  if (!isAdmin(request.account)) {
    const e = new Error('This action is limited to game admins');
    e.statusCode = 403;
    throw e;
  }
}
