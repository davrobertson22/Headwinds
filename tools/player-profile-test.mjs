// Player profiles — the public, cross-world view of an account.
//
// The endpoint that serves other players is an exercise in what NOT to send,
// and this suite protects the two redaction rules (Dave, 2026-08-24):
//
//   1. PRIVATE worlds are invisible: not the season, not the trophy, not the
//      totals, not the badge earned there. A world whose visibility cannot be
//      resolved counts as private — fail closed, never open.
//   2. Podium or nothing: a public season carries `place` (1|2|3|null) and no
//      rank/of/svps/marketCap/status at all. A 14th-place bankruptcy reads as
//      "Played", and the numbers never reach the network tab.
//
// Verified failing on HEAD (2026-08-24) by reproducing the old paths:
//   - serializeCareer on the same fixture returned the private season, its
//     rank 14, and its BANKRUPT status (there was no public view at all)
//   - worldRecord dropped `visibility` on the floor
//   - RIVAL_PROFILE_SELECT carried no accountId, and the standings serializer
//     in routes/worlds.mjs did not emit one — nothing to link a profile to
//
//   node --import ./tools/_register-loader.mjs tools/player-profile-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';

globalThis.window = globalThis.window ?? {};
window.location = window.location ?? { hash: '', origin: 'http://localhost:5173' };
window.addEventListener = window.addEventListener ?? (() => {});
window.removeEventListener = window.removeEventListener ?? (() => {});

import {
  PODIUM_RANK, worldRecord, emptyCareer, withWorldRecord,
  serializeCareer, publicCareer,
} from '../apps/headwinds-server/src/lib/career.mjs';
import { snapshotWorldCareers } from '../apps/headwinds-server/src/lib/careerService.mjs';
import { RIVAL_PROFILE_SELECT } from '../apps/headwinds-server/src/lib/rivalProfile.mjs';

const { PlayerProfileView } = await import('../apps/headwinds-web/src/PlayerProfile.jsx');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const run = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
};

const season = (over = {}) => ({
  worldId: 'w1', worldName: 'Blitz One', lengthYears: 3, endedAt: '2026-01-01T00:00:00.000Z',
  airlineId: 'a1', airlineName: 'Test Air', hub: 'JFK',
  rank: 4, of: 20, bestRank: 2, svps: 12_345, marketCap: 900_000_000,
  status: 'ACTIVE', restarts: 0, passengers: 2_400_000, weeksPlayed: 156,
  visibility: 'PUBLIC', ...over,
});

// The career this suite keeps coming back to: two championships — one of them
// in a PRIVATE world — a 14th-place bankruptcy, a silver, a legacy record
// whose visibility must be looked up, and a legacy record whose world is gone.
const raw = [
  season({ worldId: 'wPub1', worldName: 'Open Skies', rank: 1, endedAt: '2026-05-01T00:00:00.000Z' }),
  season({ worldId: 'wPriv', worldName: 'Secret League', rank: 1, visibility: 'PRIVATE', endedAt: '2026-04-01T00:00:00.000Z' }),
  season({ worldId: 'wPub2', worldName: 'Long Haul', rank: 14, of: 38, status: 'BANKRUPT', restarts: 1, endedAt: '2026-03-01T00:00:00.000Z' }),
  season({ worldId: 'wPub3', worldName: 'Blitz Two', rank: 2, endedAt: '2026-02-01T00:00:00.000Z' }),
  season({ worldId: 'wLegacy', worldName: 'Old Metal World', rank: 3, visibility: null, endedAt: '2026-01-15T00:00:00.000Z' }),
  season({ worldId: 'wGone', worldName: 'Vanished', rank: 1, visibility: null, endedAt: '2026-01-05T00:00:00.000Z' }),
].reduce((c, s) => withWorldRecord(c, s), emptyCareer());

const LOOKUP = new Map([['wLegacy', 'PUBLIC']]); // wGone deliberately absent
const pub = publicCareer(raw, LOOKUP);

console.log('\n── Visibility: hide private worlds, fail closed ─────────');

test('worldRecord keeps the visibility it was handed', () => {
  assert.equal(worldRecord(season({ visibility: 'PRIVATE' })).visibility, 'PRIVATE');
  assert.equal(worldRecord(season({ visibility: undefined })).visibility, null);
});

test('a private world appears NOWHERE in the public view', () => {
  const text = JSON.stringify(pub);
  assert.ok(!text.includes('wPriv'), 'world id leaked');
  assert.ok(!text.includes('Secret League'), 'world name leaked');
});

test('a world that cannot be resolved counts as private', () => {
  assert.ok(!JSON.stringify(pub).includes('wGone'), 'unresolvable world leaked');
});

test('a legacy record resolves through the lookup map', () => {
  assert.ok(pub.seasons.some((s) => s.worldId === 'wLegacy'));
});

test('totals are recomputed from the public subset, not read from storage', () => {
  // Three championships were banked (wPub1, wPriv, wGone); only ONE is public.
  assert.equal(pub.totals.championships, 1);
  assert.equal(pub.totals.worldsFinished, 4);
  assert.equal(pub.totals.podiums, 3); // 1st, 2nd, 3rd — all public
});

test('a badge earned only in private worlds cannot out itself', () => {
  const privOnly = [
    season({ worldId: 'wPriv', rank: 1, visibility: 'PRIVATE' }),
  ].reduce((c, s) => withWorldRecord(c, s), emptyCareer());
  const view = publicCareer(privOnly);
  assert.ok(!view.badges.some((b) => b.id === 'champion'), 'Champion badge leaked a private title');
  assert.equal(view.totals.worldsFinished, 0);
});

test('your own /me view is untouched — private seasons and full ranks intact', () => {
  const own = serializeCareer(raw);
  assert.ok(own.worlds.some((w) => w.worldId === 'wPriv'));
  assert.equal(own.worlds.find((w) => w.worldId === 'wPub2').rank, 14);
  assert.equal(own.totals.championships, 3);
});

console.log('\n── Redaction: podium or nothing ─────────────────────────');

test('a non-podium season carries place: null and NO numbers at all', () => {
  const s = pub.seasons.find((x) => x.worldId === 'wPub2');
  assert.equal(s.place, null);
  for (const key of ['rank', 'of', 'bestRank', 'svps', 'marketCap', 'status', 'passengers']) {
    assert.ok(!(key in s), `public season leaked '${key}'`);
  }
});

test('a podium season carries its place and nothing more', () => {
  const s = pub.seasons.find((x) => x.worldId === 'wPub3');
  assert.equal(s.place, 2);
  assert.ok(!('rank' in s) && !('of' in s));
});

test('PODIUM_RANK is the cut — 3rd places, 4th does not', () => {
  assert.equal(PODIUM_RANK, 3);
  const four = publicCareer(withWorldRecord(emptyCareer(), season({ worldId: 'w4', rank: 4 })));
  assert.equal(four.seasons[0].place, null);
});

test('public totals omit bestFinish and bankruptcies', () => {
  assert.ok(!('bestFinish' in pub.totals), 'bestFinish leaked');
  assert.ok(!('bankruptcies' in pub.totals), 'bankruptcies leaked');
  assert.ok(!('refoundings' in pub.totals), 'refoundings leaked');
});

test('trophies are exactly the podium seasons, newest first', () => {
  assert.deepEqual(pub.trophies.map((t) => [t.worldId, t.place]),
    [['wPub1', 1], ['wPub3', 2], ['wLegacy', 3]]);
});

console.log('\n── Snapshot stamps visibility (and stays idempotent) ────');

await run('snapshotWorldCareers writes world.visibility into the record', async () => {
  const store = { careerStats: {} };
  const prisma = {
    airline: { findMany: async () => [{
      id: 'a1', accountId: 'acct1', name: 'Test Air', hub: 'JFK', status: 'ACTIVE',
      svps: 12345n, marketCap: 1000n, restarts: 0, joinedWeek: 1, restartedWeek: null, week: 156,
    }] },
    standing: { groupBy: async () => [{ airlineId: 'a1', _min: { rank: 2 } }] },
    account: {
      findUnique: async () => ({ careerStats: store.careerStats }),
      update: async ({ data }) => { store.careerStats = data.careerStats; },
    },
  };
  const world = {
    id: 'wSnap', name: 'Snapshot World', lengthYears: 3,
    visibility: 'PRIVATE', endedAt: new Date('2026-06-01T00:00:00.000Z'),
  };
  const quiet = { info() {}, warn() {}, error() {} };
  await snapshotWorldCareers(prisma, world, {
    weekIndex: 156, ranked: [{ airlineId: 'a1' }],
    passengersById: new Map([['a1', 100]]), log: quiet,
  });
  assert.equal(store.careerStats.worlds.wSnap.visibility, 'PRIVATE');

  const first = JSON.stringify(store.careerStats);
  await snapshotWorldCareers(prisma, world, {
    weekIndex: 156, ranked: [{ airlineId: 'a1' }],
    passengersById: new Map([['a1', 100]]), log: quiet,
  });
  assert.equal(JSON.stringify(store.careerStats), first, 'second snapshot changed the record');
});

console.log('\n── accountId reaches the client (the link target) ───────');

test('the rival-profile select fetches accountId', () => {
  assert.equal(RIVAL_PROFILE_SELECT.accountId, true);
});

test('the world-standings serializer emits accountId', () => {
  // The raw SQL has always SELECTed a."accountId"; what was missing was the
  // serializer line. Guard the source so a refactor cannot silently drop it.
  const src = readFileSync(new URL('../apps/headwinds-server/src/routes/worlds.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('standings: airlines.map');
  assert.ok(at >= 0, 'standings serializer not found');
  assert.ok(/accountId: a\.accountId/.test(src.slice(at, at + 1200)),
    'standings serializer no longer emits accountId');
});

test('the players route is registered', () => {
  const src = readFileSync(new URL('../apps/headwinds-server/src/server.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("import playerRoutes from './routes/players.mjs'"));
  assert.ok(src.includes('app.register(playerRoutes)'));
});

console.log('\n── The profile page, rendered for real ──────────────────');

// React SSR splits adjacent text nodes with an empty comment.
const render = (data) => renderToString(React.createElement(PlayerProfileView, { data }))
  .replace(/<!-- -->/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const payload = {
  player: { id: 'acct1', displayName: 'Kat the Fox', isOG: true, dev: false, memberSince: '2026-06-01T00:00:00.000Z' },
  ...pub,
  current: [{
    worldId: 'wRun', worldName: 'Old Metal World', worldStatus: 'RUNNING',
    airlineId: 'ar1', airlineName: 'Fox Air', hub: 'GRR', status: 'ACTIVE',
    week: 50, rank: 3, svps: 4.2,
  }],
};

test('the profile renders the player, their trophies, and their worlds', () => {
  const html = render(payload);
  assert.ok(html.includes('Kat the Fox'));
  assert.ok(html.includes('🏆'), 'gold trophy missing');
  assert.ok(html.includes('🥈'), 'silver trophy missing');
  assert.ok(html.includes('🥉'), 'bronze trophy missing');
  assert.ok(html.includes('Fox Air'));
  assert.ok(html.includes('#/w/wRun'), 'current world does not link to its lobby');
});

test('a non-podium season reads "Played" — no rank anywhere', () => {
  const html = render(payload);
  assert.ok(html.includes('Played'));
  assert.ok(!html.includes('14th'), 'a non-podium rank reached the page');
  assert.ok(!/of\s*38/.test(html), 'field size reached the page');
  assert.ok(!html.toLowerCase().includes('bankrupt'), 'a finished season leaked BANKRUPT');
});

test('the private world is nowhere in the rendered page', () => {
  const html = render(payload);
  assert.ok(!html.includes('Secret League'));
  assert.ok(!html.includes('Vanished'), 'unresolvable legacy world leaked');
});

test('an empty profile degrades to honest empty states', () => {
  const html = render({
    player: { id: 'x', displayName: 'Newcomer', isOG: false, dev: false, memberSince: null },
    totals: { worldsFinished: 0, championships: 0, podiums: 0, lifetimePassengers: 0, weeksPlayed: 0 },
    badges: [], trophies: [], seasons: [], current: [],
  });
  assert.ok(html.includes('No trophies yet'));
  assert.ok(html.includes('Not flying in any public world'));
  assert.ok(html.includes('No finished seasons yet'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
