// Supporter worlds — private worlds a ♥ SUPPORTER creates for their own group.
//
//   node --import ./tools/_register-loader.mjs tools/supporter-worlds-test.mjs
//
// The three rules (Dave, 2026-09-19), each exercised through the pure function
// the route calls, with fixture rows standing in for Prisma — no database:
//   1. a supporter world is always PRIVATE and its join code is the OWNER'S
//      PASSWORD (compared trimmed, case-insensitively);
//   2. every member must hold the badge: non-supporters cannot join, and a
//      member whose badge lapses is locked out (403 SUPPORTER_LAPSED) of reads
//      and decisions until it is back — never the 404 a stranger gets;
//   3. nobody is in more than MAX_SUPPORTER_WORLD_MEMBERSHIPS live supporter
//      worlds at once, owning counting as being in; the owner's own join takes
//      no new slot; ended/archived worlds and operator worlds never count.
// Plus the invariant that keeps this a hosting perk and not a gameplay one:
// packages/engine never reads who owns a world.
//
// Verified failing on HEAD (2026-09-19) by running this file against a
// `git archive HEAD` copy of the tree: createWorld ignored ownerAccountId and
// wrote a PUBLIC world, joinWorld admitted a non-supporter, and access.mjs
// exported none of the supporter gate.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';

// Browser shims — apps/headwinds-web/src/App.jsx reads window at import time.
globalThis.window = globalThis.window ?? {};
window.location = window.location ?? { hash: '', origin: 'http://localhost:5173' };
window.addEventListener = window.addEventListener ?? (() => {});
window.removeEventListener = window.removeEventListener ?? (() => {});
globalThis.fetch = globalThis.fetch ?? (() => Promise.reject(new Error('no network in SSR')));

const HW = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const opt = async (spec) => { try { return await import(spec); } catch (e) { return { __err: e }; } };
const access = await opt('../apps/headwinds-server/src/lib/access.mjs');
const cfg = await opt('../apps/headwinds-server/src/lib/worldConfig.mjs');
const svc = await opt('../apps/headwinds-server/src/lib/worldService.mjs');
const web = await opt('../apps/headwinds-web/src/App.jsx');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const rejects = async (fn, status, re) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `expected a ${status}, got no error`);
  assert.equal(err.statusCode, status, `expected ${status}, got ${err.statusCode}: ${err.message}`);
  if (re) assert.match(err.message, re);
  return err;
};

// ── Fixtures ─────────────────────────────────────────────────────────────────
const supporter = { id: 'acc-sup', email: 'sup@example.com', isSupporter: true };
const lapsed    = { id: 'acc-lapsed', email: 'lapsed@example.com', isSupporter: false };
const owner     = { id: 'acc-owner', email: 'owner@example.com', isSupporter: true };
const stranger  = { id: 'acc-str', email: 'str@example.com', isSupporter: false };

const supporterWorld = {
  id: 'w-sup', name: 'Friends', status: 'RUNNING', visibility: 'PRIVATE', joinCode: 'Secret Pass',
  ownerAccountId: owner.id, lengthYears: 50, weeksPerDay: 24, currentWeek: 3, currentYear: 1,
  maxPlayers: 20, tickConfig: {}, worldSeed: 'seed', startedAt: new Date(),
};
const adminWorld = { ...supporterWorld, id: 'w-admin', ownerAccountId: null, joinCode: 'K7P2QF' };

// A fake Prisma: `memberships` is what world.count answers (the cap query),
// `members` the airline rows that exist, `created` collects writes.
function fakePrisma({ memberships = 0, members = [] } = {}) {
  const created = { worlds: [], airlines: [] };
  return {
    created,
    world: {
      count: async () => memberships,
      create: async ({ data }) => { const w = { id: 'w-new', ...data }; created.worlds.push(w); return w; },
      updateMany: async () => ({ count: 1 }),
    },
    airline: {
      findUnique: async ({ where }) => {
        const k = where.worldId_accountId;
        return members.find((m) => m.worldId === k.worldId && m.accountId === k.accountId) ?? null;
      },
      count: async () => members.filter((m) => m.status === 'ACTIVE').length,
      create: async ({ data }) => { const a = { id: 'a-new', ...data }; created.airlines.push(a); return a; },
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 0. the modules export the supporter gate ─────────────\n');

await test('worldConfig exports the cap, the password rules and joinCodeMatches', () => {
  assert.ok(!cfg.__err, cfg.__err?.message);
  assert.equal(cfg.MAX_SUPPORTER_WORLD_MEMBERSHIPS, 2, 'Dave: max 2 private worlds per user');
  assert.equal(typeof cfg.validatePassword, 'function');
  assert.equal(typeof cfg.joinCodeMatches, 'function');
});
await test('access exports isSupporterWorld / mayUseSupporterWorld / assertSupporterAccess', () => {
  assert.ok(!access.__err, access.__err?.message);
  for (const k of ['isSupporterWorld', 'mayUseSupporterWorld', 'assertSupporterAccess', 'supporterLapsedError']) {
    assert.equal(typeof access[k], 'function', `access.${k} missing`);
  }
});
await test('worldService exports supporterWorldMemberships / supporterSlotProblem', () => {
  assert.ok(!svc.__err, svc.__err?.message);
  assert.equal(typeof svc.supporterWorldMemberships, 'function');
  assert.equal(typeof svc.supporterSlotProblem, 'function');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. password = join code, forgiving on case and whitespace ─\n');

await test('joinCodeMatches ignores case and surrounding whitespace, never matches empty', () => {
  assert.equal(cfg.joinCodeMatches('secret pass', 'Secret Pass'), true);
  assert.equal(cfg.joinCodeMatches('  SECRET PASS ', 'Secret Pass'), true);
  assert.equal(cfg.joinCodeMatches('k7p2qf', 'K7P2QF'), true, 'generated admin codes keep working lower-cased');
  assert.equal(cfg.joinCodeMatches('secret', 'Secret Pass'), false);
  assert.equal(cfg.joinCodeMatches('', ''), false);
  assert.equal(cfg.joinCodeMatches(undefined, 'K7P2QF'), false);
});

await test('validatePassword trims and enforces 4–32 characters', () => {
  assert.equal(cfg.validatePassword('  wj crew  '), 'wj crew');
  assert.throws(() => cfg.validatePassword('abc'), /4–32/);
  assert.throws(() => cfg.validatePassword('x'.repeat(33)), /4–32/);
  assert.throws(() => cfg.validatePassword(undefined), /password is required/);
});

await test('createWorld with an owner is PRIVATE whatever visibility was asked for, and stores the password', async () => {
  const prisma = fakePrisma({ memberships: 0 });
  const w = await svc.createWorld(prisma, {
    lengthYears: 50, weeksPerDay: 24, visibility: 'PUBLIC', ownerAccountId: owner.id, password: ' Secret Pass ',
  });
  assert.equal(w.visibility, 'PRIVATE');
  assert.equal(w.joinCode, 'Secret Pass');
  assert.equal(w.ownerAccountId, owner.id);
});

await test('createWorld with an owner refuses a missing password (400)', async () => {
  const prisma = fakePrisma({ memberships: 0 });
  await rejects(() => svc.createWorld(prisma, { lengthYears: 50, weeksPerDay: 24, ownerAccountId: owner.id }), 400, /password/i);
  assert.equal(prisma.created.worlds.length, 0);
});

await test('an operator world (no owner) still gets a generated 6-char code, and no owner', async () => {
  const prisma = fakePrisma();
  const w = await svc.createWorld(prisma, { lengthYears: 50, weeksPerDay: 24, visibility: 'PRIVATE' });
  assert.match(w.joinCode, /^[A-Z2-9]{6}$/);
  assert.equal(w.ownerAccountId, null);
});

await test('the owner reads their world before founding an airline in it (create → join hand-off)', () => {
  assert.equal(access.mayReadWorld(supporterWorld, { account: owner, isMember: false }), true);
  assert.equal(access.mayReadWorld(supporterWorld, { account: stranger, isMember: false }), false);
  assert.equal(access.mayReadWorld(adminWorld, { account: owner, isMember: false }), false, 'owning some OTHER world grants nothing');
  assert.equal(access.isOwner(supporterWorld, owner), true);
  assert.equal(access.isOwner(supporterWorld, { id: undefined }), false);
});

await test('serializeWorld exposes supporterWorld + ownerAccountId, never a stranger\'s code', () => {
  const s = cfg.serializeWorld(supporterWorld, { playerCount: 3 });
  assert.equal(s.supporterWorld, true);
  assert.equal(s.ownerAccountId, owner.id);
  assert.equal(s.joinCode, undefined);
  assert.equal(cfg.serializeWorld(adminWorld, {}).supporterWorld, false);
  assert.equal(cfg.serializeWorld(supporterWorld, { includeJoinCode: true }).joinCode, 'Secret Pass');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. supporters only: joining, reading, acting ─────────\n');

await test('mayUseSupporterWorld: operator worlds never consult the badge', () => {
  assert.equal(access.mayUseSupporterWorld(adminWorld, lapsed), true);
  assert.equal(access.mayUseSupporterWorld(adminWorld, null), true);
});
await test('mayUseSupporterWorld: supporter worlds admit the badge, refuse a lapsed one, exempt an admin', () => {
  assert.equal(access.mayUseSupporterWorld(supporterWorld, supporter), true);
  assert.equal(access.mayUseSupporterWorld(supporterWorld, lapsed), false);
  assert.equal(access.mayUseSupporterWorld(supporterWorld, null), false);
  assert.equal(access.mayUseSupporterWorld(supporterWorld, lapsed, { admin: true }), true);
});

await test('assertWorldReadable: a lapsed MEMBER gets 403 SUPPORTER_LAPSED with the renew message, a stranger still 404', async () => {
  const prisma = fakePrisma({ members: [{ worldId: 'w-sup', accountId: lapsed.id, status: 'ACTIVE' }] });
  const e = await rejects(() => access.assertWorldReadable(prisma, supporterWorld, lapsed), 403, /SUPPORTER badge/);
  assert.equal(e.code, 'SUPPORTER_LAPSED');
  await rejects(() => access.assertWorldReadable(prisma, supporterWorld, stranger), 404);
  await access.assertWorldReadable(prisma, supporterWorld, lapsed, { admin: true }); // operator moderates
});

await test('assertWorldReadable: a supporter member of a supporter world reads normally', async () => {
  const prisma = fakePrisma({ members: [{ worldId: 'w-sup', accountId: supporter.id, status: 'ACTIVE' }] });
  await access.assertWorldReadable(prisma, supporterWorld, supporter);
});

await test('joinWorld: a non-supporter with the right password is refused (403), no row written', async () => {
  const prisma = fakePrisma({ memberships: 0 });
  await rejects(() => svc.joinWorld(prisma, { account: stranger, world: supporterWorld, airlineName: 'Str Air', hub: 'JFK', joinCode: 'secret pass' }), 403, /SUPPORTER/);
  assert.equal(prisma.created.airlines.length, 0);
});

await test('joinWorld: a supporter with the password (any case) is admitted', async () => {
  const prisma = fakePrisma({ memberships: 0 });
  const a = await svc.joinWorld(prisma, { account: supporter, world: supporterWorld, airlineName: 'Sup Air', hub: 'JFK', joinCode: 'SECRET PASS' });
  assert.equal(a.accountId, supporter.id);
  assert.equal(prisma.created.airlines.length, 1);
});

await test('joinWorld: the wrong password is a 403 that says "password", not "join code"', async () => {
  const prisma = fakePrisma({ memberships: 0 });
  await rejects(() => svc.joinWorld(prisma, { account: supporter, world: supporterWorld, airlineName: 'Sup Air', hub: 'JFK', joinCode: 'nope' }), 403, /password/i);
});

await test('joinWorld: operator private worlds still admit a non-supporter with the code', async () => {
  const prisma = fakePrisma({ memberships: 5 });
  const a = await svc.joinWorld(prisma, { account: stranger, world: adminWorld, airlineName: 'Str Air', hub: 'JFK', joinCode: 'k7p2qf' });
  assert.equal(a.accountId, stranger.id);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. the cap: two live supporter worlds per account ────\n');

await test('supporterSlotProblem: free below the cap, refused at it', () => {
  assert.equal(svc.supporterSlotProblem(0), null);
  assert.equal(svc.supporterSlotProblem(1), null);
  assert.match(svc.supporterSlotProblem(2), /at most 2/);
  assert.match(svc.supporterSlotProblem(7), /at most 2/);
});

await test('supporterWorldMemberships counts LIVE owned-or-member supporter worlds, each once', async () => {
  let captured = null;
  const prisma = { world: { count: async (q) => { captured = q; return 1; } } };
  assert.equal(await svc.supporterWorldMemberships(prisma, supporter.id), 1);
  assert.deepEqual(captured.where.ownerAccountId, { not: null }, 'operator worlds never count');
  assert.deepEqual(captured.where.status, { in: ['LOBBY', 'RUNNING'] }, 'ended/archived worlds free their slot');
  assert.deepEqual(captured.where.OR, [
    { ownerAccountId: supporter.id },
    { airlines: { some: { accountId: supporter.id } } },
  ], 'owning counts as being in; a world is counted once whichever way');
  assert.equal(await svc.supporterWorldMemberships(prisma, null), 0);
});

await test('createWorld: an owner already in 2 live supporter worlds gets a 409', async () => {
  const prisma = fakePrisma({ memberships: 2 });
  await rejects(() => svc.createWorld(prisma, { lengthYears: 50, weeksPerDay: 24, ownerAccountId: owner.id, password: 'Secret Pass' }), 409, /at most 2/);
  assert.equal(prisma.created.worlds.length, 0);
});

await test('joinWorld: a supporter already in 2 live supporter worlds gets a 409', async () => {
  const prisma = fakePrisma({ memberships: 2 });
  await rejects(() => svc.joinWorld(prisma, { account: supporter, world: supporterWorld, airlineName: 'Sup Air', hub: 'JFK', joinCode: 'Secret Pass' }), 409, /at most 2/);
  assert.equal(prisma.created.airlines.length, 0);
});

await test('joinWorld: the OWNER joining their own world takes no new slot even at the cap', async () => {
  const prisma = fakePrisma({ memberships: 2 }); // this world is already one of the two
  const a = await svc.joinWorld(prisma, { account: owner, world: supporterWorld, airlineName: 'Owner Air', hub: 'JFK', joinCode: 'Secret Pass' });
  assert.equal(a.accountId, owner.id);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. a hosting perk, not a gameplay one ────────────────\n');

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(mjs|js|jsx)$/.test(f)) out.push(p);
  }
  return out;
}
await test('packages/engine never reads ownerAccountId or supporterWorld', () => {
  const files = walk(path.join(HW, 'packages/engine/src'));
  assert.ok(files.length > 20, `only found ${files.length} engine files — is the path right?`);
  const guilty = files.filter((f) => /ownerAccountId|supporterWorld/.test(readFileSync(f, 'utf8')));
  assert.equal(guilty.length, 0, 'the simulation must not know who owns a world:\n      ' + guilty.map((f) => path.relative(HW, f)).join('\n      '));
});

await test('the decision routes gate both the state read and the decision post on the badge', () => {
  const src = readFileSync(path.join(HW, 'apps/headwinds-server/src/routes/decisions.mjs'), 'utf8');
  assert.ok((src.match(/assertSupporterAccess\(/g) ?? []).length >= 2,
    'GET /worlds/:id/airline and loadMyAirline (POST /decisions) must both call assertSupporterAccess');
});

await test('the migration drops the unique index on joinCode (two groups may pick the same password)', () => {
  const dir = path.join(HW, 'apps/headwinds-server/prisma/migrations');
  const mig = readdirSync(dir).find((d) => /supporter_worlds/.test(d));
  assert.ok(mig, 'no supporter_worlds migration');
  const sql = readFileSync(path.join(dir, mig, 'migration.sql'), 'utf8');
  assert.match(sql, /DROP INDEX IF EXISTS "World_joinCode_key"/);
  assert.match(sql, /ADD COLUMN "ownerAccountId" TEXT/);
  const schema = readFileSync(path.join(HW, 'apps/headwinds-server/prisma/schema.prisma'), 'utf8');
  assert.ok(!/joinCode\s+String\?\s+@unique/.test(schema), 'schema.prisma still marks joinCode @unique');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 5. the lobby, SSR-rendered from the real components ──\n');

// React SSR splices <!-- --> between adjacent text nodes; strip them so the
// assertions read like the page does.
const h = (C, props) => renderToString(React.createElement(C, props)).replace(/<!-- -->/g, '');
const meSupporter = (used) => ({ account: { id: 'acc-sup', isAdmin: false, isSupporter: true }, supporterWorldSlots: { used, max: 2 } });

await test('App.jsx exports the supporter-world lobby pieces', () => {
  assert.ok(!web.__err, web.__err?.message);
  for (const k of ['CreateWorld', 'AirlineCard', 'OwnedWorldCard', 'SupporterWorldTag']) {
    assert.equal(typeof web[k], 'function', `App.jsx must export ${k}`);
  }
});

await test('a supporter with a free slot sees the private-world create button; a full one sees "2 of 2"', () => {
  const free = h(web.CreateWorld, { token: 't', me: meSupporter(1) });
  assert.match(free, /Create a private world/);
  assert.doesNotMatch(free, /Create a world</, 'the admin wording must not show to a supporter');
  const full = h(web.CreateWorld, { token: 't', me: meSupporter(2) });
  assert.match(full, /2 of 2 supporter worlds/);
  assert.doesNotMatch(full, /<button/, 'no create button once the cap is hit');
});

await test('an admin still sees the plain create button, uncapped', () => {
  const out = h(web.CreateWorld, { token: 't', me: { account: { id: 'a', isAdmin: true, isSupporter: false }, supporterWorldSlots: { used: 2, max: 2 } } });
  assert.match(out, /\+ Create a world/);
});

await test('an airline card in a supporter world carries the ♥ private tag, or ⚠ badge lapsed', () => {
  const airline = { id: 'a1', worldId: 'w-sup', name: 'Sup Air', hub: 'JFK', cash: 1e6, status: 'ACTIVE',
    world: cfg.serializeWorld(supporterWorld, { playerCount: 2 }) };
  assert.match(h(web.AirlineCard, { airline }), /♥[^<]*<\/span>private/);
  assert.match(h(web.AirlineCard, { airline, lapsed: true }), /badge lapsed/);
  const plain = { ...airline, world: cfg.serializeWorld(adminWorld, { playerCount: 2 }) };
  assert.doesNotMatch(h(web.AirlineCard, { airline: plain }), /private|badge lapsed/, 'operator worlds carry no ♥ tag');
});

await test('an owned-but-not-joined world card shows the password and a way in', () => {
  const out = h(web.OwnedWorldCard, { world: cfg.serializeWorld(supporterWorld, { playerCount: 0, includeJoinCode: true }) });
  assert.match(out, /Secret Pass/);
  assert.match(out, /Found your airline/);
  assert.match(out, /href="#\/w\/w-sup"/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
