// Fleet → Summary view: a row per aircraft type with count, ages, ownership,
// on-order, not-flying, capacity, utilisation, fixed cost and book value, plus a
// fleet total. Dave asked for it (2026-10-28) in both games.
//
// What this pins:
//   1. The Fleet page offers the Summary view at all (fails on HEAD: no button).
//   2. The SSR-rendered table prints the right count / average age / age range /
//      on-order figures per type, including a type that is only on order.
//   3. The totals agree with the rest of the page: fixed / wk is exactly the
//      Weekly Leases + Weekly Maintenance boxes, utilisation is the engine's
//      aircraftUtilization() (the UTIL. column's source), book value is
//      airframeNAV (what SELL_AIRCRAFT prices on). Expected values are rebuilt
//      from the engine, not from the helper, so the checks are not vacuous.
//   4. Sorting puts types with no data last in both directions, and the chosen
//      sort survives a reload.
//
//   node --import ./tools/_register-loader.mjs tools/fleet-summary-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { airframeNAV } from '../src/data/maintenance.js';
import {
  maintenanceMultiplier, aircraftUtilization, weekToGameDate, formatMoney,
} from '../src/utils/simulation.js';
import * as sim from '../src/utils/simulation.js';
import { absoluteWeek } from '../src/utils/fuel.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const FleetMod = await import('../src/components/Fleet.jsx');
const Fleet = FleetMod.default;

const pax = AIRCRAFT_TYPES.filter(t => !t.freighter && (t.seats ?? 0) > 100 && (t.range ?? 0) > 5000);
const JET = pax[0];
const OTHER = pax.find(t => t.id !== JET.id && t.category !== JET.category) ?? pax[1];
const FRT = AIRCRAFT_TYPES.find(t => t.freighter && (t.payloadTonnes ?? 0) > 10);
assert.ok(JET && OTHER && FRT, 'need two passenger types and a freighter');

const WEEK = 20, YEAR = 4;
const MONTH = weekToGameDate(WEEK).monthIndex;
const capHours = typeof sim.maxWeeklyBlockHoursFor === 'function'
  ? sim.maxWeeklyBlockHoursFor(freshState()) : sim.MAX_WEEKLY_BLOCK_HOURS;

const save = {
  ...freshState(),
  phase: 'playing', week: WEEK, year: YEAR, hub: 'JFK', cash: 400_000_000,
  gates: { JFK: 40, LAX: 40, MIA: 40 },
  hubs: { JFK: { tier: 2 } },
  fleet: [
    { id: 'a1', typeId: JET.id, name: 'J1', tailNumber: 'NJET01', status: 'assigned', ageWeeks: 52,  ownershipType: 'owned',  config: { economy: 120, businessClass: 12 } },
    { id: 'a2', typeId: JET.id, name: 'J2', tailNumber: 'NJET02', status: 'idle',     ageWeeks: 260, ownershipType: 'owned',  config: { economy: 150 } },
    { id: 'a3', typeId: JET.id, name: 'J3', tailNumber: 'NJET03', status: 'grounded', ageWeeks: 520, ownershipType: 'leased', weeklyLease: 77_000, config: { economy: 150 } },
    { id: 'f1', typeId: FRT.id, name: 'F1', tailNumber: 'NFRT01', status: 'assigned', ageWeeks: 104, ownershipType: 'leased', config: {} },
  ],
  routes: [
    { id: 'r1', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'LAX'], aircraftId: 'a1',
      weeklyFrequency: 7, weeksOpen: 30, hub: 'JFK', season: null, seasonState: 'active' },
  ],
  cargoRoutes: [
    { id: 'c1', origin: 'JFK', destination: 'MIA', aircraftId: 'f1', cargo: true,
      weeklyFrequency: 3, weeksOpen: 30, hub: 'JFK', yieldPrice: 0.4 },
  ],
  pendingOrders: [
    { id: 'o1', typeId: OTHER.id, name: 'Order 1', ownershipType: 'owned', deliverAbsWeek: absoluteWeek(YEAR, WEEK) + 20 },
    { id: 'o2', typeId: OTHER.id, name: 'Order 2', ownershipType: 'owned', deliverAbsWeek: absoluteWeek(YEAR, WEEK) + 25 },
    { id: 'o3', typeId: JET.id,   name: 'Order 3', ownershipType: 'leased', deliverAbsWeek: absoluteWeek(YEAR, WEEK) + 10 },
  ],
};
store.set('bbae_save_v2', JSON.stringify(save));

const render = (el) => renderToString(React.createElement(GameProvider, null, el));
const text = (html) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function rowHtml(html, key) {
  const i = html.indexOf(`data-summary-type="${key}"`);
  if (i < 0) return null;
  return html.slice(html.indexOf('>', i) + 1, html.indexOf('</tr>', i));
}
const yrs = (w) => (w < 52 ? '<1 yr' : `${(w / 52).toFixed(1)} yrs`);

console.log('\n── Fleet → Summary view ─────────────────────────────────');

await test('the Fleet page offers a Summary view', () => {
  const html = text(render(React.createElement(Fleet)));
  assert.match(html, /Summary/, 'no Summary option in the Fleet view switcher');
});

const FleetSummary = FleetMod.FleetSummary;
const summaryHtml = FleetSummary ? render(React.createElement(FleetSummary, { onPickType: () => {} })) : '';

await test('a row per type: count, share, owned/leased, on order, average age and age range', () => {
  assert.ok(FleetSummary, 'Fleet.jsx exports no FleetSummary');
  const row = text(rowHtml(summaryHtml, JET.id) ?? '');
  assert.ok(row, `no row for ${JET.name}`);
  assert.ok(row.includes(JET.name), row);
  assert.match(row, /\b3 75%/, `count 3 of 4 (75%) — got: ${row}`);
  assert.match(row, /\b2 \/ 1\b/, `2 owned / 1 leased — got: ${row}`);
  assert.ok(row.includes(yrs((52 + 260 + 520) / 3)), `avg age ${yrs((52 + 260 + 520) / 3)} — got: ${row}`);
  assert.ok(row.includes(`${yrs(52)} – ${yrs(520)}`), `age range — got: ${row}`);
  assert.match(row, /1 idle/, row);
  assert.match(row, /1 down/, row);
  assert.match(row, /432 seats/, `132 + 150 + 150 seats — got: ${row}`);
});

await test('a type that is only on order still gets a row, with no ages', () => {
  const row = text(rowHtml(summaryHtml, OTHER.id) ?? '');
  assert.ok(row && row.includes(OTHER.name), `no row for on-order-only ${OTHER.name}`);
  assert.match(row, /^\S.*?\b0\b/, row);
  assert.ok(!/yrs/.test(row), `an undelivered type has no age — got: ${row}`);
  assert.match(row, /— 2 —/, `on order 2 — got: ${row}`);
});

await test('a freighter row reads capacity in tonnes', () => {
  const row = text(rowHtml(summaryHtml, FRT.id) ?? '');
  assert.ok(row.includes(`${FRT.payloadTonnes.toLocaleString(undefined, { maximumFractionDigits: 1 })} t`), row);
  assert.ok(!/seats/.test(row), row);
});

const absWeek = absoluteWeek(YEAR, WEEK);
const typeOf = (id) => AIRCRAFT_TYPES.find(t => t.id === id);
const expectFixed = save.fleet.reduce((s, a) => {
  const t = typeOf(a.typeId);
  const lease = a.ownershipType === 'owned' ? 0 : (a.weeklyLease ?? t.weeklyLease ?? 0);
  return s + lease + Math.round((t.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(a.ageWeeks));
}, 0);
const expectValue = save.fleet.filter(a => a.ownershipType === 'owned')
  .reduce((s, a) => s + airframeNAV(a, typeOf(a.typeId), absWeek), 0);
const expectHours = save.fleet.reduce((s, a) => s + aircraftUtilization({
  aircraft: a, type: typeOf(a.typeId), routes: save.routes, cargoRoutes: save.cargoRoutes,
  month: MONTH, capHours,
}).flyingHours, 0) / save.fleet.length;

await test('the totals row agrees with the stat boxes, the UTIL. column and the sale valuation', () => {
  const row = text(rowHtml(summaryHtml, 'total') ?? '');
  assert.ok(row.startsWith('Fleet total'), row);
  assert.match(row, /Fleet total 4\b/, row);
  assert.match(row, /\b2 \/ 2\b/, row);
  assert.ok(expectHours > 0, 'scenario needs some flying');
  assert.ok(row.includes(`${expectHours.toFixed(0)}h`), `avg util ${expectHours.toFixed(0)}h — got: ${row}`);
  assert.ok(row.includes(`−${formatMoney(expectFixed)}`), `fixed −${formatMoney(expectFixed)} — got: ${row}`);
  assert.ok(row.includes(formatMoney(expectValue)), `book value ${formatMoney(expectValue)} — got: ${row}`);
  assert.match(row, /— 3 —|\b3\b/, row);
});

const { fleetTypeSummary, sortSummaryRows, readSummarySort, writeSummarySort } =
  await import('../src/components/fleetSummary.js').catch(() => ({}));

await test('helper totals are exact (no display rounding hiding a drift)', () => {
  assert.ok(fleetTypeSummary, 'no fleetSummary.js');
  const { rows, totals } = fleetTypeSummary({
    fleet: save.fleet, pendingOrders: save.pendingOrders, typeOf, absWeek, capHours,
    utilOf: (a) => aircraftUtilization({ aircraft: a, type: typeOf(a.typeId), routes: save.routes, cargoRoutes: save.cargoRoutes, month: MONTH, capHours }),
  });
  assert.equal(totals.fixedPerWk, expectFixed);
  assert.equal(totals.bookValue, expectValue);
  assert.equal(totals.count, 4);
  assert.equal(totals.onOrder, 3);
  assert.equal(rows.reduce((s, r) => s + r.count, 0), totals.count);
  assert.equal(rows.reduce((s, r) => s + r.fixedPerWk, 0), totals.fixedPerWk);
  assert.ok(Math.abs(totals.avgHours - expectHours) < 1e-9);

  for (const dir of ['asc', 'desc']) {
    const byAge = sortSummaryRows(rows, 'avgAge', dir);
    assert.equal(byAge[byAge.length - 1].typeId, OTHER.id, `on-order-only type sorts last (${dir})`);
  }
  assert.equal(sortSummaryRows(rows, 'count', 'desc')[0].typeId, JET.id);
  assert.deepEqual(sortSummaryRows(rows, null).map(r => r.typeId), rows.map(r => r.typeId));
});

await test('the chosen sort is remembered, and junk in storage falls back to the default', () => {
  writeSummarySort({ key: 'fixed', dir: 'desc' });
  assert.deepEqual(readSummarySort(), { key: 'fixed', dir: 'desc' });
  localStorage.setItem('fleet_summary_sort_v1', '{"key":"nope","dir":"sideways"}');
  assert.deepEqual(readSummarySort(), { key: null, dir: 'asc' });
  localStorage.setItem('fleet_summary_sort_v1', 'not json');
  assert.deepEqual(readSummarySort(), { key: null, dir: 'asc' });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
