// Live side races on the standings (docs/game-audit-2026-11-06.md F2).
//
//   node --import ./tools/_register-loader.mjs tools/live-races-test.mjs
//
// Best newcomer, each region's champion and the busiest week — races an airline
// outside the top five can win while the season runs, from public rows only.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { liveRaces } from '../packages/engine/src/utils/standings.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const rows = [
  { id: 'a', name: 'Atlantic', hub: 'JFK', joinedWeek: 1, avgProfit: 500_000, paxWeek: 9000 },
  { id: 'b', name: 'Late Bird', hub: 'ORD', joinedWeek: 60, avgProfit: 100_000, paxWeek: 3000 },
  { id: 'c', name: 'Channel', hub: 'LHR', joinedWeek: 1, avgProfit: 200_000, paxWeek: 120 },
  { id: 'd', name: 'Seine', hub: 'CDG', joinedWeek: 1, avgProfit: 300_000, paxWeek: 140 },
  { id: 'e', name: 'Lonely', hub: 'SYD', joinedWeek: 1, avgProfit: 900_000, paxWeek: 50 },
];

console.log('\nLive races\n');

await test('a newcomer is scored per week actually flown, not against the whole window', () => {
  const r = liveRaces(rows, { weeksFlown: 80 }).find(x => x.key === 'newcomer');
  assert.equal(r.leader.id, 'b');
  // 52-week window, flying for 21 of them: 100k × 52 / 21.
  assert.ok(Math.abs(r.leader.value - (100_000 * 52) / 21) < 1, `got ${r.leader.value}`);
});

await test('regions with two or more airlines get a champion; a lone region does not', () => {
  const races = liveRaces(rows, { weeksFlown: 80 });
  const eur = races.find(x => x.key === 'region:EUR');
  assert.equal(eur?.leader.id, 'd');
  assert.equal(eur?.runnerUp?.id, 'c');
  assert.equal(races.some(x => x.key === 'region:OCE' || /Oceania|Australia/.test(x.title)), false);
});

await test('the busiest airline this week', () => {
  assert.equal(liveRaces(rows, { weeksFlown: 80 }).find(x => x.key === 'busiest').leader.id, 'a');
});

await test('the world page renders the races above the standings', async () => {
  const Table = (await import('../apps/headwinds-web/src/StandingsTable.jsx')).default;
  const html = renderToString(React.createElement(Table, {
    world: { id: 'w', status: 'RUNNING' }, standings: rows.map((r, i) => ({ ...r, rank: i + 1, status: 'ACTIVE', weeklyProfit: 1, netAssets: 1, flightsWeek: 1, fleetSize: 1 })),
    ranking: { metric: 'avgWeeklyNetProfit', weeksFlown: 80, inFinalStretch: false, weeksUntilFinalStretch: 10, weeksLeft: 62, ended: false },
    mineId: 'b',
  }));
  assert.match(html, /data-live-races="\d+"/);
  assert.match(html, /Best newcomer/);
  assert.match(html, /Europe champion/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
