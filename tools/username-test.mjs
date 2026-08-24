// Usernames — claim, rename, and the audit trail (player profiles, phase 2).
//
// What this suite protects:
//   - usernameProblem() is the single validation authority: shape, length,
//     reserved names. Uniqueness is deliberately NOT here (the DB's
//     lower("username") index owns it).
//   - The schema and migration actually carry the feature: nullable
//     Account.username, the CASE-INSENSITIVE unique index, the NameChange
//     audit table with cascade delete.
//   - The route wires the rules together: cooldown, transactional
//     write + audit row, and a 409 sourced from the DB constraint (P2002) so
//     two racing claims cannot both win.
//   - Display = username ?? displayName, resolved server-side for profiles.
//   - The claim card renders its two states.
//
// Verified failing on HEAD (2026-08-24) before the feature: schema had no
// username or NameChange, no lib/username.mjs, no POST /me/username, and no
// payload anywhere carried an accountId for messages, news or alliances.
//
//   node --import ./tools/_register-loader.mjs tools/username-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';

globalThis.window = globalThis.window ?? {};
window.location = window.location ?? { hash: '', origin: 'http://localhost:5173' };
window.addEventListener = window.addEventListener ?? (() => {});
window.removeEventListener = window.removeEventListener ?? (() => {});

import {
  USERNAME_MIN, USERNAME_MAX, USERNAME_RE, RENAME_COOLDOWN_DAYS,
  RESERVED_USERNAMES, usernameProblem, displayNameOf,
} from '../apps/headwinds-server/src/lib/username.mjs';

const UsernameCard = (await import('../apps/headwinds-web/src/UsernameCard.jsx')).default;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const srcOf = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('\n── Validation: one authority, pure ──────────────────────');

test('good names pass', () => {
  for (const n of ['Dave', 'dave', 'kat-the-fox', 'Fox_Air2', 'abc', 'a'.repeat(20), '747fan']) {
    assert.equal(usernameProblem(n), null, `rejected ${n}`);
  }
});

test('shape violations are rejected with a human reason', () => {
  assert.match(usernameProblem('ab'), /at least 3/);
  assert.match(usernameProblem('a'.repeat(21)), /at most 20/);
  for (const n of ['-dave', '_dave', 'da ve', 'dave!', 'døve', 'dave@x', '']) {
    assert.ok(usernameProblem(n), `accepted ${JSON.stringify(n)}`);
  }
  assert.ok(usernameProblem(null));
  assert.ok(usernameProblem(42));
});

test('reserved names are rejected case-insensitively', () => {
  for (const n of ['admin', 'Admin', 'HEADWINDS', 'Moderator', 'system']) {
    assert.match(usernameProblem(n) ?? '', /reserved/i, `accepted ${n}`);
  }
  assert.ok(RESERVED_USERNAMES.has('tailwinds'));
});

test('constants hold the agreed rules', () => {
  assert.equal(USERNAME_MIN, 3);
  assert.equal(USERNAME_MAX, 20);
  assert.equal(RENAME_COOLDOWN_DAYS, 30);
  assert.ok(USERNAME_RE.test('a1-_x'));
  assert.ok(!USERNAME_RE.test('-a1'));
});

test('display = username ?? displayName', () => {
  assert.equal(displayNameOf({ username: 'fox', displayName: 'Old Name' }), 'fox');
  assert.equal(displayNameOf({ username: null, displayName: 'Old Name' }), 'Old Name');
  assert.equal(displayNameOf(null), null);
});

console.log('\n── Schema + migration carry the feature ─────────────────');

test('schema: nullable unique username + NameChange with cascade', () => {
  const schema = srcOf('apps/headwinds-server/prisma/schema.prisma');
  assert.match(schema, /username String\? @unique/);
  assert.match(schema, /model NameChange/);
  assert.match(schema, /oldName {2,}String\?/, 'oldName must be nullable (first claim)');
  assert.match(schema, /onDelete: Cascade/);
  assert.match(schema, /@@index\(\[accountId, createdAt\]\)/);
});

test('migration: the case-insensitive index is the authority', () => {
  const sql = srcOf('apps/headwinds-server/prisma/migrations/20260824100000_player_usernames/migration.sql');
  assert.match(sql, /ADD COLUMN "username" TEXT/);
  assert.match(sql, /CREATE UNIQUE INDEX "Account_username_lower_key" ON "Account"\(lower\("username"\)\)/);
  assert.match(sql, /CREATE TABLE "NameChange"/);
  assert.match(sql, /ON DELETE CASCADE/);
});

console.log('\n── The route wires the rules together ───────────────────');

test('POST /me/username exists, behind requireAuth', () => {
  const me = srcOf('apps/headwinds-server/src/routes/me.mjs');
  assert.ok(me.includes("fastify.post('/me/username'"));
  const at = me.indexOf("fastify.post('/me/username'");
  assert.match(me.slice(at, at + 400), /preHandler: requireAuth/);
});

test('validation, cooldown, transaction + audit row, DB-sourced 409', () => {
  const me = srcOf('apps/headwinds-server/src/routes/me.mjs');
  const route = me.slice(me.indexOf("fastify.post('/me/username'"));
  assert.match(route, /usernameProblem\(requested\)/, 'route must defer to the lib');
  assert.match(route, /RENAME_COOLDOWN_DAYS/, 'cooldown must come from the lib constant');
  assert.match(route, /\$transaction\(\[/, 'username write and audit row must be atomic');
  assert.match(route, /nameChange\.create/, 'every set writes the audit trail');
  assert.match(route, /oldName: current/, 'audit row records what the name was');
  assert.match(route, /P2002/, 'the race resolves at the DB constraint, not the pre-check');
  assert.match(route, /mode: 'insensitive'/, 'the friendly pre-check must be case-insensitive');
});

test('/me tells the client its username; the profile resolves display', () => {
  const me = srcOf('apps/headwinds-server/src/routes/me.mjs');
  assert.match(me, /username: account\.username \?\? null/);
  const players = srcOf('apps/headwinds-server/src/routes/players.mjs');
  assert.match(players, /displayName: account\.username \?\? account\.displayName/);
});

console.log('\n── accountId reaches every phase-2 entry point ──────────');

test('messages: conversations, directory and alliance posts carry accountId', () => {
  const msg = srcOf('apps/headwinds-server/src/routes/messages.mjs');
  assert.ok((msg.match(/accountId: true/g) ?? []).length >= 2, 'airline selects must fetch accountId');
  assert.match(msg, /accountId: acctById\.get\(other\)/, 'conversations');
  assert.match(msg, /accountId: a\.accountId/, 'directory');
  assert.match(msg, /fromAccountId: acctById\.get\(m\.fromAirlineId\)/, 'alliance posts');
});

test('news: player-attributed items carry accountId', () => {
  const news = srcOf('apps/headwinds-server/src/lib/newsService.mjs');
  assert.match(news, /accountId: acctOf\.get\(d\.airlineId\)/, 'rolled decisions');
  assert.match(news, /accountId: acctOf\.get\(id\)/, 'who()');
});

test('alliances: member roster carries accountId', () => {
  const alli = srcOf('apps/headwinds-server/src/routes/alliances.mjs');
  assert.match(alli, /accountId: airlineById\.get\(m\.airlineId\)\?\.accountId \?\? null/);
});

console.log('\n── The claim card, rendered for real ────────────────────');

const render = (props) => renderToString(React.createElement(UsernameCard, props))
  .replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");

test('unclaimed: the nudge with the claim form', () => {
  const html = render({ me: { account: { id: 'a1', displayName: 'Dave', username: null } }, token: 't' });
  assert.ok(html.includes('Choose your username'));
  assert.ok(html.includes('Claim'));
  assert.ok(!html.includes('@'), 'no @name before one exists');
});

test('claimed: shows @name and the monthly-change rule', () => {
  const html = render({ me: { account: { id: 'a1', displayName: 'Dave', username: 'dave-air' } }, token: 't' });
  assert.ok(html.includes('@dave-air'));
  assert.ok(html.includes('Change'));
  assert.ok(html.includes('30 days'));
});

test('no account or no token: renders nothing', () => {
  assert.equal(render({ me: null, token: 't' }).trim(), '');
  assert.equal(render({ me: { account: { id: 'a1' } }, token: null }).trim(), '');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
