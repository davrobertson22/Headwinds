// Bug and consistency audit, 2026-11-09 — the fixes.
// (docs: claude/bug-and-consistency-audit-2026-11-09.md)
//
// Each section pins one place where a screen showed a figure, or a sentence,
// that the engine does not act on:
//   1. cancelling an order   — Fleet's dialog quoted the classic 5% fee in
//                              production-line worlds (refund 70–95%, or none)
//   2. gate fees             — Finance ▸ By Airport priced every gate at the
//                              first gate's rate ÷ 4.33
//   3. line maintenance      — the Fleet page ignored the maintenance budget
//   4. protected markets     — a rival at a sibling airport did not count
//   5. fare cliff copy       — "about 14%" in demand model v4 worlds (it is 8%)
//   6. board mandate         — load factor averaged per route, not per seat
//   7. stale copy            — old ranking rule, $15M, gate pricing
//
// HEAD failure proof. Sections 1, 2, 3 and 5 call helpers that do not exist on
// HEAD; the old call paths were reproduced in tools/_probe/audit1109-*.mjs,
// which print the disagreement (e.g. "$100M purchase, slot 5 wks out: engine
// refunds $70,000,000, Fleet page says $95,000,000"; "ORD 20 gates billed
// $1,714,773, table shows $554,273"). Sections 4, 6 and 7 fail on HEAD as
// written.
//
//   node --import ./tools/_register-loader.mjs tools/audit-1109-fixes-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { gameReducer } = await import('../packages/engine/src/reducer.mjs');
const { formatMoney, weeklyGateFeeAt, maintenanceMultiplier } = await import('../packages/engine/src/utils/simulation.js');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { effectiveMaintAgeWeeks } = await import('../packages/engine/src/data/maintenance.js');
const { getAirport, gateMonthlyFee } = await import('../packages/engine/src/data/airports.js');
const { setDemandModel, setNwrYieldChoke, nwrYieldChokeFactor } = await import('../packages/engine/src/utils/market.js');
const { projectWeek } = await import('../src/utils/financeProjection.js');
const { cancelOrderDialog } = await import('../src/utils/cancelOrderCopy.js');
const { tailMaintenanceFn } = await import('../src/utils/tailCosts.js');
const { pricingHeadroomBreakdown, pricingHeadroomFor } = await import('../packages/engine/src/models/pricingPower.js');
const { fareCliffDropPct, fareCliffRatioMax } = await import('../packages/engine/src/models/fareCliff.js');
const { MANDATE_KINDS } = await import('../packages/engine/src/models/boardMandates.js');
const { MULTIPLAYER_OBJECTIVE_TEMPLATES } = await import('../packages/engine/src/data/objectives.js');

const playing = (over = {}) => ({ ...freshState(), phase: 'playing', cash: 2_000_000_000, year: 2, week: 10,
  hub: 'ORD', fleet: [], pendingOrders: [], routes: [], cargoRoutes: [], ...over });

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 1. Cancelling an order: the dialog is the refund ───────────');

const ABS = (2 - 1) * 52 + 10;
const order = (over) => ({ id: 'o1', typeId: 'b737800', name: 'Boeing 737-800', ownershipType: 'owned',
  totalPrice: 100_000_000, deliverAbsWeek: ABS + 5, ...over });
const refundOf = (state, o) => {
  const before = { ...state, pendingOrders: [o] };
  const after = gameReducer(before, { type: 'CANCEL_ORDER', orderId: o.id });
  return { refund: after.cash - before.cash, cancelled: (after.pendingOrders ?? []).length === 0 };
};

for (const wk of [60, 30, 15, 5]) {
  test(`production lines, purchase ${wk} weeks out: the dialog quotes what CANCEL_ORDER refunds`, () => {
    const st = playing({ productionLinesWorld: true });
    const o = order({ deliverAbsWeek: ABS + wk });
    const d = cancelOrderDialog({ ...st, pendingOrders: [o] }, o);
    const r = refundOf(st, o);
    assert.equal(d.refund, r.refund);
    assert.ok(d.body.includes(formatMoney(r.refund)), d.body);
    if (wk < 52) assert.ok(!d.body.includes('5% cancellation fee'), 'classic copy in a production-line world');
  });
}
test('production lines, lease 5 weeks out: the deposit is forfeit and the dialog says so', () => {
  const st = playing({ productionLinesWorld: true });
  const o = order({ ownershipType: 'lease', totalPrice: 0, leaseDeposit: 3_000_000 });
  const d = cancelOrderDialog({ ...st, pendingOrders: [o] }, o);
  assert.equal(refundOf(st, o).refund, 0);
  assert.equal(d.refund, 0);
  assert.match(d.body, /deposit is forfeit/);
  assert.ok(!/returned in full/.test(d.body));
});
test('production lines, launch order: not offered as cancellable', () => {
  const st = playing({ productionLinesWorld: true });
  const o = order({ launch: true });
  const d = cancelOrderDialog({ ...st, pendingOrders: [o] }, o);
  assert.equal(d.allowed, false);
  assert.ok(d.reason);
  assert.equal(refundOf(st, o).cancelled, false);
});
test('classic world: 95% of a purchase, the whole lease deposit', () => {
  const st = playing();
  const o = order();
  assert.equal(cancelOrderDialog(st, o).refund, refundOf(st, o).refund);
  assert.equal(refundOf(st, o).refund, 95_000_000);
  const l = order({ ownershipType: 'lease', totalPrice: 0, leaseDeposit: 3_000_000 });
  assert.equal(cancelOrderDialog(st, l).refund, refundOf(st, l).refund);
  assert.equal(refundOf(st, l).refund, 3_000_000);
});
test('the Fleet and Market pages both use the one dialog', () => {
  for (const f of ['src/components/Fleet.jsx', 'src/components/Marketplace.jsx']) {
    const s = src(f);
    assert.match(s, /cancelOrderDialog\(state, order\)/, f);
    assert.ok(!/totalPrice \* 0\.95/.test(s), `${f} still computes its own refund`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 2. Gate fees: one figure, the tick\'s ──────────────────────');

const GATES = { ORD: 20, BOI: 6, JFK: 1, LHR: 40 };
for (const [label, over] of [
  ['classic rent', {}],
  ['demand model v4 rent', { demandModel: 4 }],
  ['a congested scarcity airport', { gateScarcityWorld: true, gateMarket: { airports: { ORD: { surcharge: true } } } }],
]) {
  test(`${label}: per-airport fees add up to the report's gate bill`, () => {
    const st = playing({ gates: GATES, ...over });
    const report = projectWeek(st).report;
    const sum = Object.entries(GATES).reduce((s, [c, n]) => s + weeklyGateFeeAt(st, c, n), 0);
    assert.equal(sum, report.totalGateFees);
  });
}
test('20 gates at a mega airport are not 20 first gates ÷ 4.33 (classic rent)', () => {
  const st = playing({ gates: GATES });
  projectWeek(st);   // sets the world's rent rule, as any screen's projection does
  const real = weeklyGateFeeAt(st, 'ORD', 20);
  const old = Math.round(gateMonthlyFee(getAirport('ORD')) * 20 / 4.33);
  assert.ok(real > old * 2, `billed ${real}, the old table showed ${old}`);
});
test('Finance prints the shared figure in both places', () => {
  const s = src('src/components/Finance.jsx');
  assert.ok(!s.includes('4.33'));
  assert.ok(!/gateMonthlyFee\(/.test(s), 'Finance still prices gates itself');
  assert.equal((s.match(/weeklyGateFeeAt\(state, code, /g) ?? []).length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 3. Line maintenance: the Fleet page shows the tick\'s bill ──');

let fleetState = playing({ maintenanceBudget: 1.3 });
for (const typeId of ['b737800', 'b737800', 'a320neo']) fleetState = gameReducer(fleetState, { type: 'BUY_AIRCRAFT', typeId });
fleetState = { ...fleetState, fleet: fleetState.fleet.map((a, i) => ({ ...a, ageWeeks: 300 + 200 * i })) };

test('per tail, the helper is the report\'s figure and carries the budget', () => {
  assert.equal(fleetState.fleet.length, 3);
  const report = projectWeek(fleetState).report;
  const fn = tailMaintenanceFn(fleetState);
  let sum = 0;
  for (const a of fleetState.fleet) {
    const want = report.fleetCosts.find(c => c.aircraftId === a.id).maintenance;
    assert.equal(fn(a), want);
    const bare = Math.round(getAircraftType(a.typeId).baseMaintenancePerWk * maintenanceMultiplier(effectiveMaintAgeWeeks(a)));
    assert.ok(fn(a) > bare * 1.2, `budget 1.30× not in the figure: ${fn(a)} vs bare ${bare}`);
    sum += fn(a);
  }
  assert.equal(sum, report.totalMaintenance);
});
const FleetPage = (await import('../src/components/Fleet.jsx')).default;
test('SSR: Weekly Maintenance on the Fleet page equals report.totalMaintenance', () => {
  store.set('bbae_save_v2', JSON.stringify(fleetState));
  const html = renderToString(React.createElement(GameProvider, null, React.createElement(FleetPage)))
    .replace(/<!-- -->/g, '');
  const i = html.indexOf('Weekly Maintenance');
  assert.ok(i > 0, 'tile rendered');
  const tile = html.slice(i, i + 300).replace(/<[^>]+>/g, ' ');
  const total = fleetState.fleet.reduce((s, a) => s + tailMaintenanceFn(fleetState)(a), 0);
  assert.ok(tile.includes(formatMoney(total)), `tile "${tile.trim()}" should show ${formatMoney(total)}`);
});
test('Fleet.jsx no longer multiplies base maintenance by age alone for a bill', () => {
  const lines = src('src/components/Fleet.jsx').split('\n')
    .filter(l => /baseMaintenancePerWk/.test(l) && !/RESERVE_READINESS_MULT/.test(l));
  assert.deepEqual(lines, []);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 4. Protected market: cities, not airports ──────────────────');

const v4 = { demandModel: 4, newWorldRestrictions: true, hubs: {}, hub: 'BOS' };
const rival = [{ competitorId: 'human:r1', name: 'Rival', weeklyFrequency: 14 }];
test('alone on the lane: protected', () => {
  assert.equal(pricingHeadroomFor({ ...v4, humanRivals: {} }, 'JFK', 'LAX'), 0.10);
});
test('a rival on EWR–LAX contests JFK–LAX: no protected-market headroom', () => {
  const b = pricingHeadroomBreakdown({ ...v4, humanRivals: { 'EWR-LAX': rival } }, 'JFK', 'LAX');
  assert.equal(b.contested, true);
  assert.equal(b.protectedMarket, 0);
});
test('a rival on EWR–BUR (both cities, neither airport) contests it too', () => {
  assert.equal(pricingHeadroomFor({ ...v4, humanRivals: { 'BUR-EWR': rival } }, 'JFK', 'LAX'), 0);
});
test('a rival serving both cities from other fields is a credible entrant', () => {
  const b = pricingHeadroomBreakdown({ ...v4, humanRivals: { 'BOS-EWR': rival, 'BUR-SEA': rival } }, 'JFK', 'LAX');
  assert.equal(b.contested, false);
  assert.equal(b.credibleEntrant, true);
  assert.equal(b.protectedMarket, 0);
});
test('a rival in one of the two cities only leaves the market protected', () => {
  assert.equal(pricingHeadroomFor({ ...v4, humanRivals: { 'BOS-EWR': rival } }, 'JFK', 'LAX'), 0.10);
});
test('solo: an AI carrier on a sibling pair counts the same way', () => {
  const st = { ...v4, competitors: [{ id: 'ai1', routes: { 'EWR-LAX': {} } }] };
  assert.equal(pricingHeadroomFor(st, 'JFK', 'LAX'), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 5. Fare cliff copy follows the world\'s steepness ───────────');

test('the quoted drop per 1% is the engine\'s: 14% before v4, 8% from v4', () => {
  setNwrYieldChoke(true);
  for (const [model, pct] of [[3, 14], [4, 8]]) {
    setDemandModel(model);
    assert.equal(fareCliffDropPct(), pct);
    assert.equal(Math.round((1 - nwrYieldChokeFactor(1.11, 50)) * 100), pct);
  }
  setDemandModel(4);
  assert.equal(Math.round((fareCliffRatioMax() - 1) * 100), 43);
  setDemandModel(3);
  assert.equal(Math.round((fareCliffRatioMax() - 1) * 100), 25);
  setNwrYieldChoke(false); setDemandModel(undefined);
});
test('no screen hard-codes "about 14%"', () => {
  for (const f of ['src/components/Routes.jsx', 'src/components/FareEditor.jsx']) {
    assert.ok(!/about 14%/.test(src(f)), f);
    assert.match(src(f), /fareCliffDropPct\(\)/, f);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 6. Board mandate load factor is the Dashboard\'s ────────────');

test('seat-weighted, tag rotations left out', () => {
  const report = { routeResults: [
    { passengers: 380, configuredSeatsOneWay: 400, loadFactor: 0.95 },   // trunk
    { passengers: 20,  configuredSeatsOneWay: 50,  loadFactor: 0.40 },   // spoke
    { passengers: 10,  tag: true, loadFactor: 0.10 },                    // tag rotation
  ] };
  const want = 400 / 450;   // 88.9%, what networkStatsOf prints; the plain mean was 48%
  const k = MANDATE_KINDS.load_factor;
  assert.equal(k.met({ report }, 0.88), true);
  assert.equal(k.met({ report }, 0.90), false);
  assert.equal(k.target({ report }), +Math.min(0.92, want + 0.03).toFixed(3));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 7. Copy that named an old rule ─────────────────────────────');

test('onboarding tour: no $15 million, no market-cap ranking', () => {
  const s = src('src/components/OnboardingTour.jsx');
  assert.ok(!/\$15 million/.test(s));
  assert.ok(!/by market cap/.test(s));
  assert.match(s, /average weekly net profit/);
});
test('Stocks tab: no value-per-share ranking, private airlines are ranked', () => {
  const s = src('src/components/StockMarket.jsx');
  assert.ok(!/ranks airlines on/.test(s));
  assert.ok(!/the leaderboard metric/.test(s));
  assert.ok(!/are not ranked/.test(s));
});
test('Wiki: share price is not the scoreboard; loans, deliveries and objectives match the engine', () => {
  const s = src('src/components/Wiki.jsx');
  assert.ok(!/IS the scoreboard/.test(s));
  assert.ok(!/widebodies take 4 weeks/.test(s));
  assert.ok(!/offers a \*\*guaranteed amount\*\*/.test(s));
  assert.ok(!/Cash, loans, budgets and per-route profit stay yours/.test(s));
  assert.match(s, /Border Crosser/);
  assert.match(s, /id: 'moresystems'/);
});
test('airport page: "gates get dearer" only where rent really escalates', () => {
  const s = src('src/components/AirportDetail.jsx');
  assert.match(s, /getGateRentV4\(\) \?/);
  assert.ok(!/from next month's bill/.test(s));
});
test('the hub objective names the tier players see', () => {
  const o = MULTIPLAYER_OBJECTIVE_TEMPLATES.find(t => /hub/i.test(t.desc));
  assert.match(o.desc, /Major Hub/);
  assert.ok(!/Tier 2/.test(o.desc));
});
test('net assets tooltip lists what the figure counts', () => {
  assert.match(src('src/utils/standingsView.js'), /lease deposits and aircraft on order/);
});
test('website: priority delivery, not "up to 25% more"', () => {
  for (const d of ['pages', 'public']) for (const f of ['how-to-play.html', 'fleet-planning.html']) {
    assert.ok(!/up to 25% more/.test(src(`apps/headwinds-web/${d}/${f}`)), `${d}/${f}`);
  }
});

console.log(`\n${failed ? '✗' : '✓'} audit-1109-fixes: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
