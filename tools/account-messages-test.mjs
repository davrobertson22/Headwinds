// Account-level messaging — DMs that outlive any world (profiles, phase 3).
//
// What this suite protects:
//   - dmRefusal() is the one policy authority: NOBODY refuses with the SAME
//     text a block uses (a refusal never reveals it was personal),
//     SHARED_WORLD needs a shared world ever, EVERYONE lets it through, and
//     a legacy/unknown policy falls back to the SHARED_WORLD default.
//   - Schema + migration carry the feature: AccountMessage with the inbox and
//     rate-limit indexes, the block table's unique pair, the dmPolicy enum
//     default, Report.worldId gone nullable WITH its own account-context
//     partial dedupe index (the world-scoped one treats NULL as distinct).
//   - The routes wire the rules in the right ORDER: banned target → 404,
//     blocks before policy, policy before rate limit, and the caps are the
//     same numbers world DMs use.
//   - /me piggybacks the unread count without a new polling loop, and
//     tolerates a database that predates the migration.
//   - The inbox widget and the profile's ✉ Message button render.
//
// Verified failing on HEAD (2026-08-24) before the feature: no AccountMessage
// or dmPolicy in the schema, Report.worldId NOT NULL, no accountMessages
// route or lib, no unreadMessages on /me, no /reports/account.
//
//   node --import ./tools/_register-loader.mjs tools/account-messages-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';

globalThis.window = globalThis.window ?? {};
window.location = window.location ?? { hash: '', origin: 'http://localhost:5173' };
window.addEventListener = window.addEventListener ?? (() => {});
window.removeEventListener = window.removeEventListener ?? (() => {});

import {
  ACCOUNT_MESSAGE_MAX_LENGTH, ACCOUNT_MESSAGE_RATE_LIMIT_PER_HOUR,
  DM_POLICIES, DEFAULT_DM_POLICY, dmRefusal,
} from '../apps/headwinds-server/src/lib/accountMessaging.mjs';

// routes/messages.mjs imports the live Prisma client (needs a DATABASE_URL),
// so its cap constants are read from SOURCE here instead of imported.
const messagesSrc = readFileSync(new URL('../apps/headwinds-server/src/routes/messages.mjs', import.meta.url), 'utf8');
const constOf = (name) => Number(messagesSrc.match(new RegExp(`export const ${name} = (\\d+);`))?.[1]);
const MESSAGE_RATE_LIMIT_PER_HOUR = constOf('MESSAGE_RATE_LIMIT_PER_HOUR');
const MESSAGE_MAX_LENGTH = constOf('MESSAGE_MAX_LENGTH');

const AccountInboxWidget = (await import('../apps/headwinds-web/src/AccountInbox.jsx')).default;
const { PlayerProfileView } = await import('../apps/headwinds-web/src/PlayerProfile.jsx');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const srcOf = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('\n── Policy: one authority, pure ──────────────────────────');

test('NOBODY refuses with the same text a block uses', () => {
  const nobody = dmRefusal('NOBODY', { sharesWorld: true });
  assert.ok(nobody, 'NOBODY must refuse');
  const route = srcOf('apps/headwinds-server/src/routes/accountMessages.mjs');
  assert.ok(route.includes(`httpError(403, '${nobody}')`),
    'the block refusal must be byte-identical to the NOBODY refusal');
});

test('SHARED_WORLD hinges on a shared world, ever', () => {
  assert.equal(dmRefusal('SHARED_WORLD', { sharesWorld: true }), null);
  assert.match(dmRefusal('SHARED_WORLD', { sharesWorld: false }), /share a world/);
});

test('EVERYONE lets it through; legacy policy falls back to the default', () => {
  assert.equal(dmRefusal('EVERYONE', { sharesWorld: false }), null);
  assert.equal(DEFAULT_DM_POLICY, 'SHARED_WORLD');
  assert.equal(dmRefusal(null, { sharesWorld: true }), null);
  assert.match(dmRefusal(undefined, { sharesWorld: false }), /share a world/);
  assert.match(dmRefusal('GARBAGE', { sharesWorld: false }), /share a world/);
});

test('caps match world DMs exactly', () => {
  assert.equal(ACCOUNT_MESSAGE_MAX_LENGTH, MESSAGE_MAX_LENGTH);
  assert.equal(ACCOUNT_MESSAGE_RATE_LIMIT_PER_HOUR, MESSAGE_RATE_LIMIT_PER_HOUR);
  assert.deepEqual(DM_POLICIES, ['EVERYONE', 'SHARED_WORLD', 'NOBODY']);
});

console.log('\n── Schema + migration ───────────────────────────────────');

test('schema: AccountMessage, its indexes, the block pair, the policy default', () => {
  const schema = srcOf('apps/headwinds-server/prisma/schema.prisma');
  assert.match(schema, /model AccountMessage/);
  assert.match(schema, /@@index\(\[toAccountId, readAt\]\)/, 'inbox/unread index');
  assert.match(schema, /@@index\(\[fromAccountId, createdAt\]\)/, 'rate-limit index');
  assert.match(schema, /model AccountMessageBlock/);
  assert.match(schema, /@@unique\(\[accountId, blockedAccountId\]\)/);
  assert.match(schema, /dmPolicy DmPolicy @default\(SHARED_WORLD\)/);
});

test('schema: Report.worldId (and its world relation) went nullable', () => {
  const schema = srcOf('apps/headwinds-server/prisma/schema.prisma');
  const report = schema.slice(schema.indexOf('model Report'), schema.indexOf('model Report') + 1800);
  assert.match(report, /worldId {2,}String\?/);
  assert.match(report, /World\? {2,}@relation/);
});

test('migration: tables, enum, DROP NOT NULL, account-context dedupe index', () => {
  const sql = srcOf('apps/headwinds-server/prisma/migrations/20260824200000_account_messages/migration.sql');
  assert.match(sql, /CREATE TYPE "DmPolicy"/);
  assert.match(sql, /CREATE TABLE "AccountMessage"/);
  assert.match(sql, /CREATE TABLE "AccountMessageBlock"/);
  assert.match(sql, /ALTER TABLE "Report" ALTER COLUMN "worldId" DROP NOT NULL/);
  // Postgres unique indexes treat NULL as distinct, so the account-context
  // dedupe MUST have its own partial index or two racing reports both land.
  assert.match(sql, /WHERE "status" = 'OPEN' AND "worldId" IS NULL/);
});

console.log('\n── Route wiring, in the right order ─────────────────────');

test('send: banned → 404, blocks before policy, policy before rate limit', () => {
  const route = srcOf('apps/headwinds-server/src/routes/accountMessages.mjs');
  const send = route.slice(route.indexOf("fastify.post('/me/messages'"));
  const at = (s) => { const i = send.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };
  assert.ok(at('target.bannedAt') < at('blockedByThem'), 'ban check first');
  assert.ok(at('blockedByThem') < at('dmRefusal'), 'blocks before policy');
  assert.ok(at('dmRefusal') < at('ACCOUNT_MESSAGE_RATE_LIMIT_PER_HOUR'), 'policy before rate limit');
  assert.match(send, /sharesWorld: policy === 'SHARED_WORLD'/, 'the world lookup only runs when needed');
});

test('routes registered; /me carries unreadMessages, tolerantly', () => {
  const server = srcOf('apps/headwinds-server/src/server.mjs');
  assert.ok(server.includes('app.register(accountMessageRoutes)'));
  const me = srcOf('apps/headwinds-server/src/routes/me.mjs');
  assert.match(me, /unreadMessages/);
  const block = me.slice(me.indexOf('let unreadMessages'), me.indexOf('return {'));
  assert.match(block, /try \{/, 'the badge is not worth failing /me over');
  assert.match(block, /notIn/, 'blocked senders must not count');
});

test('reports: /reports/account exists, dedupes on worldId null, shares the budget', () => {
  const rp = srcOf('apps/headwinds-server/src/routes/reports.mjs');
  assert.ok(rp.includes("fastify.post('/reports/account'"));
  const acct = rp.slice(rp.indexOf("fastify.post('/reports/account'"), rp.indexOf("fastify.post('/worlds/:id/report'"));
  assert.match(acct, /worldId: null/, 'account reports carry no world');
  assert.match(acct, /REPORT_RATE_LIMIT_PER_HOUR/, 'one reporter, one budget');
  assert.match(acct, /P2002/, 'create race folds into the open row');
});

console.log('\n── The inbox and the button, rendered for real ──────────');

const render = (el) => renderToString(el).replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");

test('the inbox widget renders its envelope; nothing without a token', () => {
  const html = render(React.createElement(AccountInboxWidget, { token: 't' }));
  assert.ok(html.includes('✉'));
  assert.equal(render(React.createElement(AccountInboxWidget, { token: null })).trim(), '');
});

test('a profile shows ✉ Message only when the shell provides onMessage', () => {
  const data = {
    player: { id: 'p1', displayName: 'Kat', isOG: false, dev: false, memberSince: null },
    totals: { worldsFinished: 0 }, badges: [], trophies: [], seasons: [], current: [],
  };
  const withBtn = render(React.createElement(PlayerProfileView, { data, onMessage: () => {} }));
  assert.ok(withBtn.includes('✉ Message'));
  const without = render(React.createElement(PlayerProfileView, { data }));
  assert.ok(!without.includes('✉ Message'), 'no button on your own profile / in-game overlay');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
