#!/usr/bin/env node
// What the API tells a visitor who is not signed in (2026-11-10).
//
//   node tools/public-view-test.mjs
//
// The public web pages are built from the standings, rival dossiers and news of
// PUBLIC worlds, read without an account. Before this, those answers carried the
// account id, display name, last-move time and account badges of every player —
// the 29 Oct site audit flagged it, and Dave's call was "airline only". Signed-in
// players still get everything: profile links and badges in the game depend on it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { withoutPeople, forViewer, PERSON_KEYS } from '../apps/headwinds-server/src/lib/publicView.mjs';
import { assembleHistory, yearEndWeek, yearEndWeeks } from '../apps/headwinds-server/src/lib/worldHistory.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const standings = {
  world: { id: 'w1', name: 'Scarce Assets', ownerAccountId: 'acct-9' },
  allianceStandings: [{ name: 'Oriental', members: [{ id: 'a1', accountId: 'acct-1', playerName: 'dave', name: 'Ajax Air' }] }],
  standings: [{
    rank: 1, id: 'a1', accountId: 'acct-1', playerName: 'dave', name: 'Ajax Air', hub: 'NRT', avgProfit: 4_200_000,
    logoId: 'horizon', livery: { tail: '#ff3b3b' }, og: true, sup: true, dev: false,
    lastMoveAt: new Date('2026-11-10T00:00:00Z'), createdAt: new Date('2026-09-01T00:00:00Z'),
  }],
};

test('a signed-out visitor gets the airlines without the people', () => {
  const out = withoutPeople(standings);
  const flat = JSON.stringify(out);
  for (const k of ['accountId', 'ownerAccountId', 'playerName', 'lastMoveAt', '"og"', '"sup"', '"dev"']) assert.ok(!flat.includes(k), `${k} survived`);
  assert.ok(!flat.includes('acct-') && !flat.includes('dave'));
  // …and everything about the airline is still there.
  const a = out.standings[0];
  assert.deepEqual([a.rank, a.id, a.name, a.hub, a.avgProfit, a.logoId, a.livery.tail], [1, 'a1', 'Ajax Air', 'NRT', 4_200_000, 'horizon', '#ff3b3b']);
  assert.equal(out.allianceStandings[0].members[0].name, 'Ajax Air');
});

test('it copies: the cached body a signed-in player gets is not touched', () => {
  withoutPeople(standings);
  assert.equal(standings.standings[0].accountId, 'acct-1');
  assert.equal(standings.world.ownerAccountId, 'acct-9');
});

test('dates and other non-plain values pass through as they are', () => {
  const out = withoutPeople(standings);
  assert.ok(out.standings[0].createdAt instanceof Date);
  assert.equal(withoutPeople(null), null);
  assert.equal(withoutPeople(7), 7);
  assert.deepEqual(withoutPeople([{ accountId: 'x', n: 1 }]), [{ n: 1 }]);
});

test('a signed-in viewer gets the body whole', () => {
  assert.equal(forViewer({ id: 'me' }, standings), standings);
  assert.notEqual(forViewer(null, standings), standings);
  assert.ok(!('accountId' in forViewer(null, standings).standings[0]));
});

test('news items and rival dossiers lose the account too', () => {
  const news = withoutPeople({ items: [{ kind: 'bankruptcy', airlineId: 'a1', accountId: 'acct-1', airline: 'Spirit', og: false, data: { name: 'Spirit' } }] });
  assert.deepEqual(news.items[0], { kind: 'bankruptcy', airlineId: 'a1', airline: 'Spirit', data: { name: 'Spirit' } });
  const rival = withoutPeople({ airline: { id: 'a1', name: 'Ajax Air', accountId: 'acct-1' }, badges: ['champion'], lastMoveAt: 'x', routeNetwork: [{ origin: 'NRT', destination: 'NGO' }] });
  assert.deepEqual(Object.keys(rival), ['airline', 'routeNetwork']);
  assert.ok(PERSON_KEYS.has('badges'));
});

test('every anonymous-readable world route answers through forViewer', () => {
  const worlds = read('../apps/headwinds-server/src/routes/worlds.mjs');
  // detail, rival dossier, legacy feed
  assert.equal((worlds.match(/return forViewer\(viewer, \{/g) ?? []).length, 3);
  const news = read('../apps/headwinds-server/src/routes/news.mjs');
  assert.ok(news.includes('return forViewer(viewer, hit)') && news.includes('return forViewer(viewer, body)'), 'the news cache hit and the fresh body are both scrubbed');
  assert.ok(read('../apps/headwinds-server/src/server.mjs').includes('app.register(worldHistoryRoutes)'));
  // The public trophy list must never join the account.
  const hist = read('../apps/headwinds-server/src/routes/worldHistory.mjs');
  assert.ok(!/account:\s*\{/.test(hist) && !hist.includes('playerName'), '/trophies/awards selects no account');
});

// ── A world's season so far ─────────────────────────────────────────────────
test('a game year closes on the tick that lands on week 1 of the next', () => {
  assert.equal(yearEndWeek(28), 1457);            // the year_in_review row for year 28 is written at linear week 1457
  assert.deepEqual(yearEndWeeks(105), [53, 105]);
  assert.deepEqual(yearEndWeeks(52), []);
});

const airlines = [
  { id: 'a1', name: 'Ajax Air', hub: 'NRT', status: 'ACTIVE', joinedWeek: 1, restartedWeek: null },
  { id: 'a2', name: 'Phoenix', hub: 'CDG', status: 'ACTIVE', joinedWeek: 1, restartedWeek: 80 },
  { id: 'a3', name: 'Gone Air', hub: 'LHR', status: 'BANKRUPT', joinedWeek: 1, restartedWeek: null },
];
const h = assembleHistory({
  thisWeek: 160, rankingSince: 100,
  podiumRows: [
    { week: 53, rank: 1, airlineId: 'a2', score: 125000n }, { week: 53, rank: 2, airlineId: 'a3', score: 90000n }, { week: 53, rank: 3, airlineId: 'a1', score: 1n },
    { week: 105, rank: 2, airlineId: 'a2', score: 3n }, { week: 105, rank: 1, airlineId: 'a1', score: 5_000_000n },
    { week: 157, rank: 1, airlineId: 'a1', score: 6_000_000n },
  ],
  leaderRows: [160, 159, 158, 157, 156].map((week) => ({ week, airlineId: 'a1' })).concat([{ week: 155, airlineId: 'a2' }, { week: 154, airlineId: 'a1' }]),
  yearAgoRows: [{ airlineId: 'a1', rank: 2 }, { airlineId: 'a2', rank: 1 }],
  airlines,
});

test('every finished year has its podium, in rank order', () => {
  assert.deepEqual(h.years.map((y) => y.year), [1, 2, 3]);
  assert.deepEqual(h.years[1].podium.map((p) => [p.rank, p.name]), [[1, 'Ajax Air'], [2, 'Phoenix']]);
});

test('years before the rankings rework carry a share value, later ones a profit', () => {
  assert.deepEqual([h.years[0].metric, h.years[0].podium[0].score], ['svps', 12.5]);
  assert.deepEqual([h.years[1].metric, h.years[1].podium[0].score], ['avgWeeklyNetProfit', 5_000_000]);
});

test('a place earned before an airline was re-founded is not credited to the new one', () => {
  const y1 = h.years[0].podium[0];
  assert.equal(y1.airlineId, 'a2');
  assert.equal(y1.name, null);
  assert.equal(y1.gone, true);
  assert.equal(h.years[1].podium[1].name, 'Phoenix');          // week 105 ≥ restart at 80
  assert.ok(!h.yearsLed.some((t) => t.airlineId === 'a2'), 'and it does not count as a year led');
});

test('a bankrupt airline keeps its place in the record', () => {
  assert.deepEqual([h.years[0].podium[1].name, h.years[0].podium[1].active], ['Gone Air', false]);
});

test('weeks at #1 is the unbroken run, not the total', () => {
  assert.deepEqual([h.reign.airlineId, h.reign.weeks, h.reign.since, h.reign.capped], ['a1', 5, 156, false]);
  assert.deepEqual(h.yearsLed.map((t) => [t.name, t.years, t.lastYear]), [['Ajax Air', 2, 3]]);
});

test("last year's ranks are offered only when they were ranked the same way", () => {
  assert.equal(h.yearAgo.week, 108);
  assert.equal(assembleHistory({ thisWeek: 120, rankingSince: 100, yearAgoRows: [{ airlineId: 'a1', rank: 1 }], airlines }).yearAgo, null);
  assert.equal(assembleHistory({ thisWeek: 30, airlines }).yearAgo, null);
  assert.equal(assembleHistory({ thisWeek: 30, airlines }).reign, null);
});
