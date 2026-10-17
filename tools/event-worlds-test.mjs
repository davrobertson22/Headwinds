// Event worlds — operator-run competitions with trophies for the top three.
//
//   node --import ./tools/_register-loader.mjs tools/event-worlds-test.mjs
//
// Dave, 2026-10-17: "a discord event world where it will be 15 min weeks and
// run quickly and we will give the winner/top 3 players a trophy in their
// trophy cabinet" — and the players he invites "don't need to be supporters".
//
//   1. an admin creates it (tickConfig.event = { name }); it may be as short as
//      one game-year, an ordinary world still may not; a supporter may not
//      create one;
//   2. it is an OPERATOR world: anyone with the join code joins, no badge;
//   3. Dave's follow-up the same morning: it ENDS AT A SET TIME (start + end
//      instead of a length dropdown) — the weeks that fit become the world's
//      length for the tick, progress and endsAt alike;
//   4. an admin sees the ranking (with player names) and AWARDS trophies by
//      hand from a TROPHY BANK of admin-made trophies with their own artwork;
//      awards show in the public trophy case and outlive the world;
//   5. an event is not a season: no automatic placing, no season totals/badges;
//   6. a trophy may carry a 3D MODEL (.glb) — validated, served by URL, and
//      opened from the trophy case in a three.js turntable (trophy3d.js, which
//      was also exercised in real headless Chromium against Dave's Concorde
//      model while building this: poster render + auto-rotating viewer).
//
// Verified failing on HEAD (115a0b2) against a `git archive HEAD` copy: a
// one-year event world was refused with a 400, endAt was ignored (the world
// ran its full length), the snapshot dropped the event, and the trophy bank
// did not exist (HEAD has no lib/trophies.mjs — the award path was probed with
// the import failing, which is why section 4 also asserts behaviour, not just
// exports).

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

globalThis.window = globalThis.window ?? {};
window.location = window.location ?? { hash: '', origin: 'http://localhost:5173' };
window.addEventListener = window.addEventListener ?? (() => {});
window.removeEventListener = window.removeEventListener ?? (() => {});
globalThis.fetch = globalThis.fetch ?? (() => Promise.reject(new Error('no network in SSR')));

const opt = async (spec) => { try { return await import(spec); } catch (e) { return { __err: e }; } };
const cfg = await opt('../apps/headwinds-server/src/lib/worldConfig.mjs');
const tick = await opt('../apps/headwinds-server/src/lib/tickService.mjs');
const trophies = await opt('../apps/headwinds-server/src/lib/trophies.mjs');
const trophyUi = await opt('../apps/headwinds-web/src/Trophies.jsx');
const app = await opt('../apps/headwinds-web/src/App.jsx');
const svc = await opt('../apps/headwinds-server/src/lib/worldService.mjs');
const career = await opt('../apps/headwinds-server/src/lib/career.mjs');
const careerSvc = await opt('../apps/headwinds-server/src/lib/careerService.mjs');
const profile = await opt('../apps/headwinds-web/src/PlayerProfile.jsx');
const panel = await opt('../apps/headwinds-web/src/CareerPanel.jsx');

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
};

function worldPrisma({ members = [] } = {}) {
  const created = { worlds: [], airlines: [] };
  return {
    created,
    world: {
      count: async () => 0,
      create: async ({ data }) => { const w = { id: 'w-new', ...data }; created.worlds.push(w); return w; },
      updateMany: async () => ({ count: 1 }),
    },
    airline: {
      findUnique: async () => null,
      count: async () => members.length,
      create: async ({ data }) => { const a = { id: 'a-new', ...data }; created.airlines.push(a); return a; },
    },
  };
}

const EVENT_BODY = {
  name: 'Discord Sprint', lengthYears: 1, weeksPerDay: 96, visibility: 'PRIVATE',
  password: 'cup2026', event: { name: 'Discord Cup · October 2026' },
};

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. creating an event world ───────────────────────────\n');

await test('an admin event world: one game-year at 15-minute weeks, private, chosen code, unowned', async () => {
  assert.ok(!svc.__err, svc.__err?.message);
  const prisma = worldPrisma();
  const w = await svc.createWorld(prisma, { ...EVENT_BODY });
  assert.equal(w.lengthYears, 1);
  assert.equal(w.weeksPerDay, 96, '96 weeks a day = one every 15 minutes');
  assert.equal(w.visibility, 'PRIVATE');
  assert.equal(w.joinCode, 'cup2026');
  assert.equal(w.ownerAccountId, null, 'an operator world — the supporter rules never apply');
  assert.deepEqual(w.tickConfig.event, { name: 'Discord Cup · October 2026' });
});

await test('an ordinary world still may not be shorter than five years', async () => {
  await rejects(() => svc.createWorld(worldPrisma(), { lengthYears: 1, weeksPerDay: 96 }), 400, /between 5/);
});

await test('a supporter cannot hand out trophies from their own world', async () => {
  await rejects(() => svc.createWorld(worldPrisma(), { ...EVENT_BODY, ownerAccountId: 'acc-sup' }), 403, /admin/);
});

await test('serializeWorld names the event, defaulting the trophy to the world name; ordinary worlds say null', () => {
  assert.ok(!cfg.__err, cfg.__err?.message);
  const base = { id: 'w', name: 'Sprint', status: 'LOBBY', visibility: 'PRIVATE', lengthYears: 1, weeksPerDay: 96, currentWeek: 1, currentYear: 1, maxPlayers: 30 };
  assert.deepEqual(cfg.serializeWorld({ ...base, tickConfig: { event: { name: 'Cup' } } }).event, { name: 'Cup', endAt: null });
  assert.deepEqual(cfg.serializeWorld({ ...base, tickConfig: { event: { name: null } } }).event, { name: 'Sprint', endAt: null });
  assert.equal(cfg.serializeWorld({ ...base, tickConfig: {} }).event, null);
  assert.equal(cfg.paceLabel(96), '1 week / 15 min');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. anyone with the code joins — no supporter badge ───\n');

const eventWorld = {
  id: 'w-ev', name: 'Discord Sprint', status: 'RUNNING', visibility: 'PRIVATE', joinCode: 'cup2026',
  ownerAccountId: null, lengthYears: 1, weeksPerDay: 96, currentWeek: 2, currentYear: 1,
  maxPlayers: 30, tickConfig: { event: { name: 'Discord Cup' } }, worldSeed: 'seed', startedAt: new Date(),
};
const nonSupporter = { id: 'acc-n', email: 'n@example.com', isSupporter: false };

await test('a player without the badge joins with the code', async () => {
  const prisma = worldPrisma();
  const a = await svc.joinWorld(prisma, { account: nonSupporter, world: eventWorld, airlineName: 'Cup Air', hub: 'JFK', joinCode: 'CUP2026' });
  assert.equal(a.accountId, nonSupporter.id);
});
await test('…and not without it', async () => {
  await rejects(() => svc.joinWorld(worldPrisma(), { account: nonSupporter, world: eventWorld, airlineName: 'Cup Air', hub: 'JFK', joinCode: 'nope' }), 403);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. it ends at a set time ─────────────────────────────\n');

const START = new Date(Date.now() + 2 * 3600_000);
START.setUTCMinutes(0, 0, 0);
const END = new Date(START.getTime() + 26 * 3600_000);  // 26 hours later

await test('start + end at 15-minute weeks → 104 game-weeks, fixed at creation', async () => {
  const prisma = worldPrisma();
  const w = await svc.createWorld(prisma, { ...EVENT_BODY, lengthYears: 50, scheduledStartAt: START.toISOString(), endAt: END.toISOString() });
  assert.equal(w.tickConfig.totalWeeks, 104, '26 h × 4 weeks an hour');
  assert.equal(w.tickConfig.endAt, END.toISOString());
  assert.equal(w.lengthYears, 2, 'the passed length is replaced, rounded up to whole years');
});

await test('an end time needs a start time, an event, and at least 4 weeks', async () => {
  await rejects(() => svc.createWorld(worldPrisma(), { ...EVENT_BODY, endAt: END.toISOString() }), 400, /start time/);
  await rejects(() => svc.createWorld(worldPrisma(), { lengthYears: 5, weeksPerDay: 96, scheduledStartAt: START.toISOString(), endAt: END.toISOString() }), 400, /event/);
  await rejects(() => svc.createWorld(worldPrisma(), { ...EVENT_BODY, scheduledStartAt: START.toISOString(), endAt: new Date(START.getTime() + 30 * 60_000).toISOString() }), 400, /4 game-weeks/);
});

const timedWorld = (over = {}) => ({
  id: 'w-t', name: 'Timed', status: 'RUNNING', visibility: 'PRIVATE', lengthYears: 2, weeksPerDay: 96,
  currentWeek: 1, currentYear: 1, startedAt: START,
  tickConfig: { event: { name: 'Cup' }, totalWeeks: 70, endAt: new Date(START.getTime() + 70 * 15 * 60_000).toISOString(), scheduledStartAt: START.toISOString() },
  ...over,
});

await test('the tick ends a timed world after its weeks, not after lengthYears × 52', () => {
  assert.ok(!tick.__err, tick.__err?.message);
  assert.equal(tick.completeIndex(timedWorld()), 71);
  assert.equal(tick.completeIndex({ lengthYears: 2, tickConfig: {} }), 105, 'ordinary worlds unchanged');
  const late = new Date(START.getTime() + 500 * 15 * 60_000);
  assert.equal(tick.ticksDue(timedWorld(), late), 70, 'never owes more than its 70 weeks');
});

await test('the scheduled start sets endsAt to exactly the end time', async () => {
  const w = timedWorld({ status: 'LOBBY', startedAt: null });
  let written = null;
  const prisma = {
    world: {
      findMany: async () => [w],
      updateMany: async ({ data }) => { written = data; return { count: 1 }; },
    },
  };
  await tick.startDueWorlds(prisma, { now: new Date(START.getTime() + 1000), log: { info() {} } });
  assert.equal(written.endsAt.toISOString(), w.tickConfig.endAt);
});

await test('progress reads in the timed world\'s own weeks', () => {
  const p = cfg.worldProgress(timedWorld({ currentYear: 2, currentWeek: 19 }));  // index 71 = complete
  assert.equal(p.percent, 100);
  assert.equal(p.totalWeeks, 70);
  assert.deepEqual([p.year, p.week], [2, 18], 'the last week flown is year 2 week 18');
  const ordinary = cfg.worldProgress({ lengthYears: 50, currentYear: 51, currentWeek: 1, tickConfig: {} });
  assert.deepEqual([ordinary.year, ordinary.week, ordinary.totalYears], [50, 52, 50]);
});

await test('the admin create form in event mode asks for start + end, not a length, and counts the weeks', () => {
  assert.ok(!app.__err, app.__err?.message);
  const me = { account: { id: 'admin', isAdmin: true } };
  const html = renderToString(React.createElement(app.CreateWorld, {
    token: 't', me, initialOpen: true, initialEvent: { start: '2026-10-24T18:00', end: '2026-10-25T20:00' },
  }));
  assert.match(html, /Starts at/);
  assert.match(html, /Ends at/);
  assert.match(html, /104 game-weeks/);
  assert.doesNotMatch(html, />Length</, 'no length dropdown for a timed event');
  assert.match(html, /Any pace you like per event/, 'pace stays a per-event choice');
  assert.match(html, /1 wk \/ 20 min/, 'event quick-picks include 20-minute weeks');
  const ordinary = renderToString(React.createElement(app.CreateWorld, { token: 't', me, initialOpen: true }));
  assert.match(ordinary, />Length/);
  assert.match(ordinary, /Event world/);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. the trophy bank ───────────────────────────────────\n');

// 1×1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function trophyPrisma() {
  const db = { trophies: [], awards: [], accounts: [{ id: 'acc1' }, { id: 'acc2' }],
    worlds: [{ id: 'w-ev', name: 'Discord Sprint', tickConfig: { event: { name: 'Discord Cup' } } }],
    airlines: [{ worldId: 'w-ev', accountId: 'acc1', name: 'Cup Air' }] };
  let n = 0;
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => k in row).map((k) => [k, row[k]])) : row);
  return {
    db,
    trophy: {
      create: async ({ data, select }) => { const t = { id: `t${++n}`, createdAt: new Date(), ...data }; db.trophies.push(t); return pick(t, select); },
      findUnique: async ({ where }) => db.trophies.find((t) => t.id === where.id) ?? null,
      update: async ({ where, data, select }) => { const t = db.trophies.find((x) => x.id === where.id); Object.assign(t, data); return pick(t, select); },
      delete: async ({ where }) => { db.trophies = db.trophies.filter((t) => t.id !== where.id); },
    },
    trophyAward: {
      count: async ({ where }) => db.awards.filter((a) => a.trophyId === where.trophyId).length,
      findFirst: async ({ where }) => db.awards.find((a) => a.trophyId === where.trophyId && a.accountId === where.accountId && a.worldId === where.worldId) ?? null,
      create: async ({ data }) => { const a = { id: `aw${++n}`, awardedAt: new Date(), ...data }; db.awards.push(a); return { ...a, trophy: db.trophies.find((t) => t.id === a.trophyId) }; },
      findMany: async ({ where }) => db.awards.filter((a) => a.accountId === where.accountId).map((a) => ({ ...a, trophy: db.trophies.find((t) => t.id === a.trophyId) })),
    },
    account: { findUnique: async ({ where }) => db.accounts.find((a) => a.id === where.id) ?? null },
    world: { findUnique: async ({ where }) => db.worlds.find((w) => w.id === where.id) ?? null },
    airline: { findUnique: async ({ where }) => db.airlines.find((a) => a.worldId === where.worldId_accountId.worldId && a.accountId === where.worldId_accountId.accountId) ?? null },
  };
}

await test('a trophy stores its picture as bytes, served by URL — never inline', async () => {
  assert.ok(!trophies.__err, trophies.__err?.message);
  const prisma = trophyPrisma();
  const t = await trophies.createTrophy(prisma, { name: ' Discord Cup ', description: 'First event', image: PNG }, { adminEmail: 'dave@x' });
  const stored = prisma.db.trophies[0];
  assert.equal(stored.name, 'Discord Cup');
  assert.equal(stored.imageType, 'image/png');
  assert.ok(Buffer.isBuffer(stored.image) && stored.image.length > 0);
  const out = trophies.serializeTrophy(t);
  assert.match(out.imageUrl, /^\/trophies\/t\d+\/image\?v=[0-9a-f]{12}$/);
  assert.equal(out.image, undefined);
});

await test('only real raster images: no SVG, no mislabelled bytes, nothing oversized', () => {
  assert.throws(() => trophies.decodeTrophyImage('data:image/svg+xml;base64,' + Buffer.from('<svg onload="x()"/>').toString('base64')), /PNG, JPEG/);
  assert.throws(() => trophies.decodeTrophyImage('data:image/png;base64,' + Buffer.from('not a png').toString('base64')), /PNG, JPEG/);
  const big = Buffer.alloc(trophies.TROPHY_IMAGE_MAX_BYTES + 10); big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
  assert.throws(() => trophies.decodeTrophyImage('data:image/png;base64,' + big.toString('base64')), /kB/);
});

await test('awarding from an event snapshots the event name, airline and place; no double award', async () => {
  const prisma = trophyPrisma();
  const t = await trophies.createTrophy(prisma, { name: 'Gold', image: PNG });
  const a = await trophies.awardTrophy(prisma, { trophyId: t.id, accountId: 'acc1', worldId: 'w-ev', place: 1, note: 'Champion' });
  assert.equal(a.worldName, 'Discord Cup', 'the event name, not the world name');
  assert.equal(a.airlineName, 'Cup Air');
  assert.equal(a.place, 1);
  await rejects(() => trophies.awardTrophy(prisma, { trophyId: t.id, accountId: 'acc1', worldId: 'w-ev', place: 1 }), 409);
  await rejects(() => trophies.awardTrophy(prisma, { trophyId: 'nope', accountId: 'acc1' }), 404);
});

await test('a trophy that has been awarded cannot be deleted from the bank', async () => {
  const prisma = trophyPrisma();
  const t = await trophies.createTrophy(prisma, { name: 'Gold' });
  await trophies.awardTrophy(prisma, { trophyId: t.id, accountId: 'acc2' });
  await rejects(() => trophies.deleteTrophy(prisma, t.id), 409, /revoke/);
});

await test('the public trophy case lists the award with its picture', async () => {
  const prisma = trophyPrisma();
  const t = await trophies.createTrophy(prisma, { name: 'Discord Cup', image: PNG });
  await trophies.awardTrophy(prisma, { trophyId: t.id, accountId: 'acc1', worldId: 'w-ev', place: 1 });
  const awards = await trophies.awardsForAccount(prisma, 'acc1');
  assert.equal(awards.length, 1);
  assert.equal(awards[0].name, 'Discord Cup');
  assert.match(awards[0].imageUrl, /\/trophies\/.+\/image\?v=/);

  assert.ok(!profile.__err, profile.__err?.message);
  const html = renderToString(React.createElement(profile.PlayerProfileView, { data: {
    player: { id: 'acc1', displayName: 'Winner' }, badges: [], trophies: [], awards,
    totals: { worldsFinished: 0 }, seasons: [], current: [],
  } }));
  assert.match(html, /Discord Cup/);
  assert.match(html, /<img[^>]+\/trophies\//);
  assert.match(html, /1st/);
  assert.doesNotMatch(html, /No trophies yet/);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 5. an event is not a season ──────────────────────────\n');

function careerPrisma(airlines, accounts) {
  const store = new Map(Object.entries(accounts));
  return {
    store,
    airline: { findMany: async () => airlines },
    standing: { groupBy: async () => [] },
    account: {
      findUnique: async ({ where }) => (store.has(where.id) ? { careerStats: store.get(where.id) } : null),
      update: async ({ where, data }) => { store.set(where.id, data.careerStats); return {}; },
    },
  };
}
const row = (n) => ({ id: `a${n}`, accountId: `acc${n}`, name: `Air ${n}`, hub: 'JFK', status: 'ACTIVE',
  svps: 0n, marketCap: 0n, rankScore: BigInt(1000 - n), restarts: 0, joinedWeek: 1, week: 52 });
const AIRLINES = [1, 2, 3, 4].map(row);
async function endEvent() {
  const db = careerPrisma(AIRLINES, { acc1: {}, acc2: {}, acc3: {}, acc4: {} });
  await careerSvc.snapshotWorldCareers(db, { ...eventWorld, status: 'ENDED', endedAt: new Date('2026-10-18T12:00:00Z') }, {
    weekIndex: 52, ranked: AIRLINES.map((a) => ({ airlineId: a.id })), log: { info() {}, warn() {}, error() {} },
  });
  return db.store;
}

await test('the snapshot stamps the event on every record', async () => {
  assert.ok(!careerSvc.__err, careerSvc.__err?.message);
  const rec = career.normalizeCareer((await endEvent()).get('acc1')).worlds['w-ev'];
  assert.deepEqual(rec.event, { name: 'Discord Cup' });
  assert.equal(rec.rank, 1);
});

await test('winning an event is no season championship and earns no automatic public placing', async () => {
  const store = await endEvent();
  const mine = career.serializeCareer(store.get('acc1'));
  assert.equal(mine.totals.championships, 0);
  assert.equal(mine.totals.worldsFinished, 0);
  assert.equal(mine.totals.eventsPlayed, 1);
  assert.ok(!mine.badges.some((b) => b.id === 'champion'));
  const pub = career.publicCareer(store.get('acc1'), new Map([['w-ev', 'PUBLIC']]));
  assert.equal(pub.trophies.length, 0, 'the prize is the trophy an admin awards');
  assert.equal(pub.seasons.length, 0);
});

await test('your own Career panel still lists the event', async () => {
  assert.ok(!panel.__err, panel.__err?.message);
  const html = renderToString(React.createElement(panel.default, { career: career.serializeCareer((await endEvent()).get('acc1')) }));
  assert.match(html, /Discord Cup/);
  assert.match(html, /1 event/);
});

await test('the admin ranking panel lists every airline with its player, final once ended', () => {
  assert.ok(!trophyUi.__err, trophyUi.__err?.message);
  const html = renderToString(React.createElement(trophyUi.EventRankingPanel, {
    world: { ...eventWorld, status: 'ENDED', event: { name: 'Discord Cup', endAt: null } },
    standings: [
      { id: 'a1', rank: 1, accountId: 'acc1', name: 'Cup Air', hub: 'JFK', playerName: 'barca', avgProfit: 2_500_000 },
      { id: 'a2', rank: 2, accountId: 'acc2', name: 'Two Air', hub: 'LHR', playerName: 'wj', avgProfit: 900_000 },
    ],
    token: 't',
  }));
  assert.match(html, /Final ranking/);
  assert.match(html, /Cup Air[\s\S]*barca[\s\S]*Two Air[\s\S]*wj/);
  assert.match(html, /\$2\.5M/);
});

await test('the Trophies tab lists event worlds, and a finished one links straight to its results', () => {
  const html = renderToString(React.createElement(trophyUi.EventsList, { events: [
    { id: 'w-done', name: 'Sprint', status: 'ENDED', event: { name: 'Discord Cup' }, paceLabel: '1 week / 15 min', playerCount: 14, endedAt: '2026-10-25T03:00:00Z' },
    { id: 'w-live', name: 'Next', status: 'RUNNING', event: { name: 'Night Race' }, paceLabel: '1 week / 30 min', playerCount: 8 },
  ] }));
  assert.match(html, /Discord Cup[\s\S]*Finished[\s\S]*1 week \/ 15 min[\s\S]*href="#\/w\/w-done"[^>]*>Results &amp; awards/);
  assert.match(html, /Night Race[\s\S]*Running[\s\S]*1 week \/ 30 min/);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 6. 3D trophies ───────────────────────────────────────\n');

// The smallest valid binary glTF: header + one JSON chunk.
function glb({ version = 2, json = '{"asset":{"version":"2.0"}}', lie = 0 } = {}) {
  let js = Buffer.from(json);
  while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
  const total = 12 + 8 + js.length;
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'ascii'); head.writeUInt32LE(version, 4); head.writeUInt32LE(total + lie, 8);
  head.writeUInt32LE(js.length, 12); head.write('JSON', 16, 'ascii');
  return Buffer.concat([head, js]);
}

await test('a real .glb is accepted and hashed; anything else is refused with a reason', () => {
  const ok = trophies.validateTrophyModel(glb());
  assert.match(ok.hash, /^[0-9a-f]{12}$/);
  assert.throws(() => trophies.validateTrophyModel(Buffer.from('{"asset":{}}')), /not a \.glb/);
  assert.throws(() => trophies.validateTrophyModel(glb({ version: 1 })), /version 1/);
  assert.throws(() => trophies.validateTrophyModel(glb({ lie: 64 })), /incomplete or damaged/);
  const big = Buffer.alloc(trophies.TROPHY_MODEL_MAX_BYTES + 1); big.write('glTF', 0, 'ascii');
  assert.throws(() => trophies.validateTrophyModel(big), /MB/);
});

await test('a trophy with a model serves it by URL; awards carry it to the trophy case', async () => {
  const prisma = trophyPrisma();
  const t = await trophies.createTrophy(prisma, { name: 'Concorde', image: PNG });
  const withModel = await trophies.setTrophyModel(prisma, t.id, glb());
  const out = trophies.serializeTrophy(withModel);
  assert.match(out.modelUrl, /^\/trophies\/t\d+\/model\?v=[0-9a-f]{12}$/);
  assert.equal(out.model, undefined, 'never the bytes');
  await trophies.awardTrophy(prisma, { trophyId: t.id, accountId: 'acc1', worldId: 'w-ev', place: 1 });
  const [award] = await trophies.awardsForAccount(prisma, 'acc1');
  assert.equal(award.modelUrl, out.modelUrl);
});

await test('the trophy case marks a 3D trophy and makes it openable', () => {
  const html = renderToString(React.createElement(trophyUi.TrophyCard, { award: {
    id: 'aw', name: 'Concorde', imageUrl: '/trophies/t1/image?v=a', modelUrl: '/trophies/t1/model?v=b', place: 1, worldName: 'Time Flies',
  } }));
  assert.match(html, /title="View in 3D"/);
  assert.match(html, />3D</);
  const flat = renderToString(React.createElement(trophyUi.TrophyCard, { award: { id: 'aw', name: 'Plain', imageUrl: '/trophies/t2/image?v=a' } }));
  assert.doesNotMatch(flat, /View in 3D/);
});

await test('three.js is loaded from one pinned CDN core that every addon shares', async () => {
  const t3 = await opt('../apps/headwinds-web/src/trophy3d.js');
  assert.ok(!t3.__err, t3.__err?.message);
  assert.match(t3.THREE_URLS.core, /three@\d+\.\d+\.\d+\/\+esm$/, 'pinned exact version');
  for (const k of ['gltf', 'orbit', 'room']) assert.ok(t3.THREE_URLS[k].startsWith(t3.THREE_URLS.core.replace('/+esm', '/')), k);
  for (const fn of ['loadThree', 'mountTrophyViewer', 'renderTrophyPoster']) assert.equal(typeof t3[fn], 'function');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
