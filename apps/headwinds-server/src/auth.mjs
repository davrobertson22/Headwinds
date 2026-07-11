// Supabase auth: verify the bearer token on each request and map it to an Account.
//
// The browser signs in with Supabase (email / Google / Apple) and sends the
// resulting access token as `Authorization: Bearer <token>`. We verify it with
// Supabase, then upsert a local Account row keyed by the Supabase user id — so the
// first authenticated request a new user makes "creates" their account.
//
// Phase-1 note: getUser() validates the token via Supabase (one network call per
// request). That's fine for lobby traffic. A later optimization is to verify the
// JWT locally with the project's JWT secret and cache the account lookup.
import { createClient } from '@supabase/supabase-js';
import { env } from './env.mjs';
import { prisma } from './db.mjs';

const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function unauthorized(message) {
  const e = new Error(message);
  e.statusCode = 401;
  return e;
}

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

// A banned account is one an admin has locked out. The ban is account-wide, so
// we enforce it here — one gate covers every authenticated route in the app.
export function isBanned(account) {
  return Boolean(account?.bannedAt);
}

// Verify a Supabase token and return the matching local Account (creating it on
// first sight). Throws 401 if the token is missing or invalid, or 403 if the
// account has been banned.
export async function resolveAccount(request) {
  const token = bearerToken(request);
  if (!token) throw unauthorized('Missing Authorization: Bearer <token>');

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw unauthorized('Invalid or expired session');

  const user = data.user;
  const email = user.email ?? `${user.id}@no-email.local`;
  const displayName =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    email.split('@')[0];

  const account = await prisma.account.upsert({
    where: { authUserId: user.id },
    update: { email },
    create: { authUserId: user.id, email, displayName },
  });

  // Banned accounts are stopped here — before they can touch any world.
  if (isBanned(account)) {
    throw forbidden(
      account.banReason
        ? `Your account has been banned: ${account.banReason}`
        : 'Your account has been banned.'
    );
  }

  return account;
}

// Fastify preHandler: require a valid session and attach request.account.
// Usage: fastify.get('/me', { preHandler: requireAuth }, handler)
export async function requireAuth(request) {
  request.account = await resolveAccount(request);
}

// ── Admin gate ────────────────────────────────────────────────────────────────
// Admins are the accounts listed in the ADMIN_EMAILS env var (comma-separated,
// case-insensitive). For now ALL game worlds are operator-controlled: players
// join worlds, only admins (and the worker's spawner) create them. Admins also
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
