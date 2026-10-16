// Banning players: the BANNED_EMAIL_DOMAINS blocklist and the Ban button on the
// admin account search.
//
// 2026-10-16: a spam account signed up from spambot.com.au. Two gaps:
//   1. A ban is per account, and auth.mjs creates a fresh Account on the first
//      request from any new sign-in — so a spammer who owns a domain just signs
//      up again with another address. BANNED_EMAIL_DOMAINS refuses those
//      sign-ups before the INSERT and locks out existing accounts on the domain.
//      Admins are exempt, so a typo can't lock the operators out.
//   2. The moderation panel only offered "Ban" on a player report. The account
//      search (by name, airline or email) had badge buttons but no Ban.
//
// The auth half runs the real resolveAccount: real ES256 tokens, a stubbed JWKS
// fetch, and an in-memory prisma (db.mjs reuses globalThis.__headwindsPrisma).
//
//   node --import ./tools/_register-loader.mjs tools/admin-ban-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign as rawSign } from 'node:crypto';
import React from 'react';
import { renderToString } from 'react-dom/server';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// ── Environment + fakes, set up BEFORE the server modules load ───────────────
const SUPABASE_URL = 'https://project-ref.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/test';
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.ADMIN_EMAILS = 'boss@spambot.com.au, dave@example.com';
process.env.BANNED_EMAIL_DOMAINS = 'spambot.com.au, @Junk.Example ';

const accounts = new Map(); // authUserId -> account row
const created = [];
const searchRows = [];
globalThis.__headwindsPrisma = {
  account: {
    findUnique: async ({ where }) => (where.authUserId ? accounts.get(where.authUserId) ?? null : null),
    create: async ({ data }) => {
      const row = { id: `acct-${data.authUserId}`, bannedAt: null, banReason: null, ...data };
      created.push(row); accounts.set(data.authUserId, row); return row;
    },
    update: async ({ where, data }) => {
      const row = { ...accounts.get(where.authUserId), ...data };
      accounts.set(where.authUserId, row); return row;
    },
    findMany: async () => searchRows,
  },
};

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-1', alg: 'ES256', use: 'sig' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/.well-known/jwks.json')) {
    return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
  }
  throw new Error(`unexpected fetch ${url}`);
};

const b64url = (v) => Buffer.from(v).toString('base64url');
let subSeq = 0;
function tokenFor(email) {
  const sub = `00000000-0000-0000-0000-${String(++subSeq).padStart(12, '0')}`;
  const h = b64url(JSON.stringify({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' }));
  const p = b64url(JSON.stringify({
    iss: ISSUER, sub, aud: 'authenticated', role: 'authenticated', email,
    user_metadata: {}, exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const sig = rawSign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return { sub, token: `${h}.${p}.${b64url(sig)}` };
}
const req = (token) => ({ headers: { authorization: `Bearer ${token}` }, log: {} });

const { parseDomainList, isEmailDomainBlocked } = await import('../apps/headwinds-server/src/lib/emailDomains.mjs');
const { resolveAccount } = await import('../apps/headwinds-server/src/auth.mjs');
const adminRoutes = (await import('../apps/headwinds-server/src/routes/admin.mjs')).default;

console.log('\n── Email-domain blocklist ───────────────────────────────');

await test('the env list is normalised: case, spaces, leading @, duplicates', () => {
  assert.deepEqual(parseDomainList(' spambot.com.au, @Junk.Example ,SPAMBOT.com.au,, x '), ['spambot.com.au', 'junk.example']);
  assert.deepEqual(parseDomainList(''), []);
  assert.deepEqual(parseDomainList(undefined), []);
});

await test('a blocked domain matches itself and its subdomains, never a look-alike', () => {
  const list = ['spambot.com.au'];
  assert.equal(isEmailDomainBlocked('bot1@spambot.com.au', list), true);
  assert.equal(isEmailDomainBlocked('Bot2@SpamBot.COM.AU', list), true);
  assert.equal(isEmailDomainBlocked('x@mail.spambot.com.au', list), true);
  assert.equal(isEmailDomainBlocked('x@notspambot.com.au', list), false);
  assert.equal(isEmailDomainBlocked('spambot.com.au@gmail.com', list), false);
  assert.equal(isEmailDomainBlocked('x@spambot.com.au', []), false);
  assert.equal(isEmailDomainBlocked(null, list), false);
});

console.log('\n── Sign-in gate (resolveAccount) ────────────────────────');

const rejects403 = async (p) => {
  await assert.rejects(p, (e) => { assert.equal(e.statusCode, 403); assert.match(e.message, /email domain/); return true; });
};

await test('a new sign-up from a blocked domain is refused and no Account row is created', async () => {
  const before = created.length;
  await rejects403(resolveAccount(req(tokenFor('bot1@spambot.com.au').token)));
  await rejects403(resolveAccount(req(tokenFor('bot2@mail.spambot.com.au').token)));
  await rejects403(resolveAccount(req(tokenFor('x@junk.example').token)));
  assert.equal(created.length, before, 'no Account INSERT for a blocked domain');
});

await test('an account that already exists on a blocked domain is locked out', async () => {
  const { sub, token } = tokenFor('old@spambot.com.au');
  accounts.set(sub, { id: 'acct-old', authUserId: sub, email: 'old@spambot.com.au', displayName: 'old', bannedAt: null });
  await rejects403(resolveAccount(req(token)));
});

await test('an ordinary sign-up (including a look-alike domain) still creates its account', async () => {
  const a = await resolveAccount(req(tokenFor('pilot@notspambot.com.au').token));
  assert.equal(a.email, 'pilot@notspambot.com.au');
  assert.ok(created.some((r) => r.email === 'pilot@notspambot.com.au'));
});

await test('an admin on a blocked domain is never locked out', async () => {
  const a = await resolveAccount(req(tokenFor('boss@spambot.com.au').token));
  assert.equal(a.email, 'boss@spambot.com.au');
});

await test('a per-account ban still wins with its own message', async () => {
  const { sub, token } = tokenFor('rude@example.org');
  accounts.set(sub, { id: 'acct-rude', authUserId: sub, email: 'rude@example.org', displayName: 'rude', bannedAt: new Date(), banReason: 'spam' });
  await assert.rejects(resolveAccount(req(token)), (e) => e.statusCode === 403 && /banned: spam/.test(e.message));
});

console.log('\n── Admin account search ─────────────────────────────────');

await test('search results say which rows are admins and which domains are blocked', async () => {
  const routes = {};
  const fake = { get: (path, opts, h) => { routes[`GET ${path}`] = h; }, post: (path, opts, h) => { routes[`POST ${path}`] = h; } };
  await adminRoutes(fake);
  const search = routes['GET /admin/accounts/search'];
  assert.ok(search, 'search route registered');
  searchRows.length = 0;
  searchRows.push(
    { id: 'a1', email: 'bot1@spambot.com.au', displayName: 'bot', isOG: false, isSupporter: false, bannedAt: null, airlines: [], nameChanges: [] },
    { id: 'a2', email: 'dave@example.com', displayName: 'Dave', isOG: false, isSupporter: false, bannedAt: null, airlines: [], nameChanges: [] },
  );
  const { accounts: out } = await search({ query: { q: 'x' } });
  assert.equal(out[0].domainBlocked, true);
  assert.equal(out[0].isAdmin, false);
  assert.equal(out[1].domainBlocked, false);
  assert.equal(out[1].isAdmin, true);
});

console.log('\n── Ban button on the search results (SSR) ───────────────');

globalThis.window = globalThis.window ?? {};
const AccountSearchResults = (await import('../apps/headwinds-web/src/AccountSearchResults.jsx')).default;
const noop = () => {};
const render = (accounts) => renderToString(React.createElement(AccountSearchResults, {
  accounts, busyId: null, onSetOg: noop, onSetSupporter: noop, onBan: noop, onUnban: noop,
})).replace(/<!-- -->/g, '');
const row = (over) => ({ id: 'x', email: 'p@spambot.com.au', displayName: 'Spammy', airlines: ['Spam Air'], ...over });
const buttons = (html) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

await test('an ordinary account found by email has a Ban button', () => {
  const html = render([row({})]);
  assert.ok(buttons(html).includes('Ban'), buttons(html).join(' | '));
  assert.ok(html.includes('p@spambot.com.au'));
});

await test('a banned account offers Unban instead, with its reason', () => {
  const html = render([row({ bannedAt: '2026-10-16T00:00:00Z', banReason: 'spam' })]);
  assert.ok(buttons(html).includes('Unban'));
  assert.ok(!buttons(html).includes('Ban'));
  assert.ok(html.includes('Ban reason: spam'));
});

await test('admins get no Ban button; a blocked domain is labelled', () => {
  const admin = render([row({ isAdmin: true })]);
  assert.ok(!buttons(admin).includes('Ban') && !buttons(admin).includes('Unban'));
  assert.ok(render([row({ domainBlocked: true })]).includes('domain blocked'));
});

await test('ModerationScreen renders the search through AccountSearchResults, wired to ban/unban', () => {
  const src = readFileSync(new URL('../apps/headwinds-web/src/App.jsx', import.meta.url), 'utf8');
  const mod = src.slice(src.indexOf('function ModerationScreen'));
  assert.match(mod, /<AccountSearchResults[\s\S]*?onBan=\{ban\}[\s\S]*?onUnban=\{unban\}/);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
