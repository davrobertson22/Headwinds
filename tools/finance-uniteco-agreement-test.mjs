// Finance ▸ Unit Economics has to describe the week the tick actually ran.
//
// The tab re-simulated every route with `simulateRoute(route, a, gd, labor,
// fuel, null, [], ...)` — demandOverride null, encroachmentSpecs an empty
// literal, and the 12th `competitors` argument never passed — and then
// overwrote ONLY `revenue` with the engine's booked figure. So RASK came from a
// contested numerator over an uncontested denominator, while Load %, System
// Load, RPK, Yield, CASKop, CASKfull, Spread, Grade and the Above/Below-BEP
// badge all described a monopoly that does not exist.
//
// It is not a fallback. Finance builds an `rrById` map from
// proj.report.routeResults in RouteBreakdown and AirportBreakdown, but not in
// UnitEconomics and not in the P&L per-route cost table — and projectWeek
// returns only `revById`, so there was nothing to fall back FROM. Measured on a
// contested ATL–ORD fixture: the Routes screen showed 11.6% load where this tab
// showed 100.0%, with a 671.3% break-even.
//
// Two independent errors stacked, pointing opposite ways: no rivals inflated
// load, and no pooled demandOverride inflated it again on a shared pair — while
// the missing brandReach/hub/marketing fields the tick attaches moved cost the
// other way. Even a solo uncontested carrier read 56.7% → 100.0%.
//
// bep-consistency-test and bep-render-test both pass with this live: they guard
// the break-even FORMULA, not the simulation feeding it.
//
//   node --import ./tools/_register-loader.mjs tools/finance-uniteco-agreement-test.mjs

import assert from 'node:assert/strict';
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

// freshState() samples its competitor bank with Math.random, so the fixture pair
// and how busy it is would otherwise change from run to run. Pin it.
const realRandom = Math.random;
Math.random = () => 0.5;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Finance = (await import('../src/components/Finance.jsx')).default;
const { projectWeek } = await import('../packages/engine/src/utils/financeProjection.js');

console.log('\nFinance ▸ Unit Economics agrees with the engine\n');

// ── Fixture: a contested trunk, flown by two tails ────────────────────────────
// Two tails so the pooled demandOverride matters, and freshState()'s live
// carrier bank left in place so the rivals matter. Both are things the tab's
// own call threw away.
// The pair is chosen from freshState()'s own carrier bank rather than hardcoded:
// which pairs the sampled AI carriers fly moves with the data, and a fixture on
// an uncontested pair would prove nothing about rivals.
const base0 = freshState();
const contested = (() => {
  const counts = new Map();
  for (const c of base0.competitors ?? []) {
    for (const key of Object.keys(c.routes ?? {})) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const [a, b] = key.split('-');
    if (a && b && n >= 1) return { HUB: a, DEST: b };
  }
  return null;
})();
assert.ok(contested, 'no carrier in freshState() flies any pair');
const { HUB, DEST } = contested;

const fleet = [0, 1].map((i) => ({
  id: `ac${i}`, typeId: 'b737800', name: `Test ${i}`, tailNumber: `N${i}UE`,
  status: 'assigned', ageWeeks: 60, ownershipType: 'owned',
  config: { businessClass: 16, economy: 144, seatQuality: 'standard', serviceQuality: 'standard' },
}));

const saveAt = (fare) => ({
  ...base0,
  phase: 'playing', week: 20, year: 2, hub: HUB, cash: 200_000_000,
  scheduleTrimVersion: 1,
  gates: { [HUB]: 20, [DEST]: 10 },
  fleet,
  routes: [0, 1].map((i) => ({
    id: `r${i}`, origin: HUB, destination: DEST, aircraftId: `ac${i}`,
    weeklyFrequency: 14, weeksOpen: 60, hub: HUB,
    ticketPrice: fare, classPrices: { economy: fare, businessClass: Math.round(fare * 2.5) },
    cateringLevel: 'full',
  })),
});

// Price the fixture so the engine leaves seats empty. A saturated route reads
// 100% no matter what simulation produced it, so a fixture that fills the
// aeroplane cannot detect the disagreement this file exists to catch. Fares are
// swept rather than hardcoded because which pairs are busy moves with the data.
const { save, proj, engineRows } = (() => {
  let last = null;
  for (const fare of [90, 120, 150, 180, 220, 260, 300, 340, 420, 520, 640, 780, 950, 1150, 1400]) {
    const candidate = saveAt(fare);
    const p = projectWeek(candidate);
    const rows = new Map((p.report.routeResults ?? []).map((r) => [r.routeId, r]));
    if (rows.size !== candidate.routes.length) continue;
    const lfs = [...rows.values()].map((r) => r.loadFactor);
    last = { save: candidate, proj: p, engineRows: rows, fare, lfs };
    if (lfs.every((lf) => lf > 0.2 && lf < 0.97)) return last;
  }
  assert.fail(`no fare left the fixture partly empty (last: ${last?.lfs?.map(l => (l * 100).toFixed(1)).join(', ')}%)`);
})();
store.set('bbae_save_v2', JSON.stringify(save));
const routes = save.routes;

const rivalsOnPair = (save.competitors ?? []).filter((c) => c.routes?.[[HUB, DEST].sort().join('-')]);

const html = renderToString(
  React.createElement(GameProvider, null,
    React.createElement(Finance, { initialView: 'uniteco' })),
).replaceAll('<!-- -->', '');

/** Per-row Load % out of the rendered table, keyed by pair. */
function renderedLoads() {
  const out = [];
  for (const row of html.split('<tr').slice(1)) {
    const pair = row.match(/<strong>([A-Z]{3})→([A-Z]{3})<\/strong>/);
    if (!pair) continue;
    const loads = [...row.matchAll(/>(\d+\.\d)%</g)].map((m) => Number(m[1]));
    out.push({ pair: `${pair[1]}→${pair[2]}`, loads });
  }
  return out;
}

const shown = renderedLoads();

test('the fixture is genuinely contested and genuinely shared', () => {
  assert.ok(rivalsOnPair.length > 0,
    'no carrier in freshState() flies the fixture pair — the test would prove nothing');
  assert.equal(routes.length, 2, 'fixture needs two tails for the pooled path to matter');
});

test('the engine does not fill these aircraft', () => {
  // If the engine itself said 100% there would be no disagreement to detect.
  for (const rr of engineRows.values()) {
    assert.ok(rr.loadFactor < 0.99,
      `engine load ${(rr.loadFactor * 100).toFixed(1)}% — pick a busier fixture`);
  }
});

test('the table rendered the fixture routes', () => {
  assert.ok(html.includes('Break-even Load Factor'), 'Unit Economics did not render');
  assert.equal(shown.length, routes.length, `expected ${routes.length} rows, parsed ${shown.length}`);
});

test('every rendered Load % is one the engine actually booked', () => {
  const engineLoads = [...engineRows.values()].map((rr) => +(rr.loadFactor * 100).toFixed(1));
  for (const row of shown) {
    assert.ok(row.loads.length, `${row.pair}: no percentage cells parsed`);
    const match = row.loads.some((l) => engineLoads.some((e) => Math.abs(l - e) <= 0.2));
    assert.ok(match,
      `${row.pair}: rendered ${row.loads.join('%, ')}% — the engine booked ${engineLoads.join('%, ')}%`);
  }
});

test('no row claims a full aeroplane the engine did not fill', () => {
  const pinned = shown.filter((r) => r.loads.includes(100.0));
  assert.equal(pinned.length, 0,
    `${pinned.map(r => r.pair).join(', ')} rendered at 100.0% load against an engine that booked `
    + [...engineRows.values()].map(rr => `${(rr.loadFactor * 100).toFixed(1)}%`).join(', '));
});

test('the fleet-wide System Load is the engine\'s, not a monopoly\'s', () => {
  // Both fixture routes are identical, so the fleet aggregate must land on the
  // same load factor the engine gave each of them. This is the stat that read
  // 100.0% while the tick booked 81.3%.
  const engineLF = [...engineRows.values()][0].loadFactor * 100;
  const m = html.match(/System Load[\s\S]{0,400}?>(\d+\.\d)%</);
  assert.ok(m, 'System Load stat did not render');
  const shownLF = Number(m[1]);
  assert.ok(Math.abs(shownLF - engineLF) <= 0.5,
    `System Load rendered ${shownLF}% against an engine that booked ${engineLF.toFixed(1)}%`);
});

Math.random = realRandom;
console.log(`\nFinance unit-economics agreement: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
