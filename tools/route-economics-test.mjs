// One definition of route profit.
//
// The same route could show four different profits on four screens under
// near-identical labels: the Routes table split fixed costs by DEPARTURES over
// passenger routes only, the cards on that same screen showed no fixed cost at
// all, the Dashboard split by BLOCK-HOURS, and Finance split by block-hours over
// passenger routes only while costing the lease off the type's list rate instead
// of the rate the tail signed at. So the health strip could say "3 losing" over
// a screen of green cards, and the Dashboard's "N loss-making routes" alert
// counted a different N than the filter it linked to.
//
// These tests pin the shared helper's arithmetic (the slices for one tail sum
// back to exactly that tail's cost, freight included), and SSR-render the real
// Routes page to assert the strip and the card now name and print the same
// number — the check that fails on the old code.
//
//   node --import ./tools/_register-loader.mjs tools/route-economics-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { weeklyBlockHours, routeDistanceKm } from '../src/utils/simulation.js';
import {
  allocateFixedCosts, aircraftFixedWeekly, pairEconomics, routeProfit, breakEvenLoad,
  directCostOf, PROFIT_LABELS, PROFIT_SHORT, PROFIT_HELP,
  BASIS_CONTRIBUTION, BASIS_FULL, loadProfitBasis, saveProfitBasis,
} from '../src/utils/routeEconomics.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
// Routes picks its default view from a media query and falls back to the wide
// TABLE when there is no matchMedia — but the card is where the second, silently
// different profit lived, so force the card view for these assertions.
globalThis.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps = 1) => Math.abs(a - b) <= eps;

const jet  = AIRCRAFT_TYPES.filter(t => !t.freighter && t.range > 4000).sort((a, b) => a.seats - b.seats)[0];
const frtr = AIRCRAFT_TYPES.filter(t => t.freighter).sort((a, b) => b.range - a.range)[0];
assert.ok(jet && frtr, 'expected a passenger type and a freighter in the catalogue');

const SHORT = ['JFK', 'BOS'];   // ~300 km
const LONG  = ['JFK', 'LAX'];   // ~4,000 km

const leasedTail = (id, typeId, weeklyLease) => ({
  id, typeId, name: id, ownershipType: 'lease', weeklyLease,
  leaseRemainingWeeks: 100, ageWeeks: 104,
});

// ── The split itself ────────────────────────────────────────────────────────

test('a tail flying one route carries its whole fixed cost on that route', () => {
  const fleet  = [leasedTail('a1', jet.id, 100_000)];
  const routes = [{ id: 'r1', origin: LONG[0], destination: LONG[1], aircraftId: 'a1', weeklyFrequency: 4 }];
  const alloc  = allocateFixedCosts({ routes, cargoRoutes: [], fleet });
  assert.ok(near(alloc.r1, aircraftFixedWeekly(fleet[0])), `got ${alloc.r1}`);
});

test('the slices for one tail sum back to exactly that tail\'s weekly cost', () => {
  const fleet  = [leasedTail('a1', jet.id, 100_000)];
  const routes = [
    { id: 'short', origin: SHORT[0], destination: SHORT[1], aircraftId: 'a1', weeklyFrequency: 10 },
    { id: 'long',  origin: LONG[0],  destination: LONG[1],  aircraftId: 'a1', weeklyFrequency: 2 },
  ];
  const alloc = allocateFixedCosts({ routes, cargoRoutes: [], fleet });
  assert.ok(near(alloc.short + alloc.long, aircraftFixedWeekly(fleet[0])),
    `slices ${alloc.short} + ${alloc.long} should equal ${aircraftFixedWeekly(fleet[0])}`);
});

test('block-hours, not departures: the long-haul carries more than the shuttle', () => {
  // 10 short hops a week against 4 long-hauls. By DEPARTURES the shuttle would
  // swallow 71% of the lease; by TIME — which is what a lease actually buys —
  // the long-haul consumes twice as much of the aeroplane and pays for it.
  const fleet  = [leasedTail('a1', jet.id, 100_000)];
  const routes = [
    { id: 'short', origin: SHORT[0], destination: SHORT[1], aircraftId: 'a1', weeklyFrequency: 10 },
    { id: 'long',  origin: LONG[0],  destination: LONG[1],  aircraftId: 'a1', weeklyFrequency: 4 },
  ];
  const alloc = allocateFixedCosts({ routes, cargoRoutes: [], fleet });
  const bhShort = weeklyBlockHours(routeDistanceKm(...SHORT), 10, jet);
  const bhLong  = weeklyBlockHours(routeDistanceKm(...LONG), 4, jet);
  assert.ok(bhLong > bhShort, `fixture is wrong: long ${bhLong}h should exceed short ${bhShort}h`);
  assert.ok(alloc.long > alloc.short,
    `the route consuming more of the aircraft should carry more of it (${alloc.long} vs ${alloc.short})`);

  const byDepartures = aircraftFixedWeekly(fleet[0]) * (10 / 14);
  assert.ok(alloc.short < byDepartures * 0.8,
    `the shuttle is still carrying roughly its departure share (${alloc.short} vs ${byDepartures})`);
});

test('freight lanes take their share instead of flying on the passenger side\'s tab', () => {
  const fleet = [leasedTail('mix', frtr.id, 120_000)];
  const routes      = [{ id: 'p1', origin: LONG[0], destination: LONG[1], aircraftId: 'mix', weeklyFrequency: 2 }];
  const cargoRoutes = [{ id: 'c1', origin: LONG[0], destination: LONG[1], aircraftId: 'mix', weeklyFrequency: 2 }];

  const withCargo    = allocateFixedCosts({ routes, cargoRoutes, fleet });
  const withoutCargo = allocateFixedCosts({ routes, cargoRoutes: [], fleet });

  assert.ok(withCargo.c1 > 0, 'the freight lane must carry a share of the aircraft it flies');
  assert.ok(withCargo.p1 < withoutCargo.p1,
    'ignoring freight made the passenger route absorb the whole aircraft');
  assert.ok(near(withCargo.p1 + withCargo.c1, aircraftFixedWeekly(fleet[0])));
});

test('a grounded tail still owes its lease — spread, not dropped', () => {
  // Zero block-hours everywhere. The cost must not silently leave the network.
  const fleet  = [leasedTail('a1', jet.id, 100_000)];
  const routes = [
    { id: 'r1', origin: LONG[0], destination: LONG[1], aircraftId: 'a1', weeklyFrequency: 0 },
    { id: 'r2', origin: SHORT[0], destination: SHORT[1], aircraftId: 'a1', weeklyFrequency: 0 },
  ];
  const alloc = allocateFixedCosts({ routes, cargoRoutes: [], fleet });
  assert.ok(near(alloc.r1 + alloc.r2, aircraftFixedWeekly(fleet[0])));
  assert.ok(alloc.r1 > 0 && alloc.r2 > 0);
});

test('an owned aircraft owes no lease, only maintenance', () => {
  const owned = { id: 'o1', typeId: jet.id, ownershipType: 'owned', ageWeeks: 104 };
  const fixed = aircraftFixedWeekly(owned);
  assert.ok(fixed > 0, 'maintenance is still real');
  assert.ok(fixed < aircraftFixedWeekly(leasedTail('l1', jet.id, 100_000)));
});

test('the engine\'s own lease figure wins over the type\'s list rate', () => {
  // Leases lock their rate on delivery; the catalogue has moved since. Finance
  // used to price every tail off the CURRENT list rate and quietly misreport
  // ownership cost for anything signed earlier.
  const tail = leasedTail('a1', jet.id, 999_999);
  const fromEngine = aircraftFixedWeekly(tail, { weeklyLeaseCost: 40_000, weeklyMaintCost: 5_000 });
  assert.equal(fromEngine, 45_000);
  assert.notEqual(fromEngine, aircraftFixedWeekly(tail));
});

// ── The two numbers ─────────────────────────────────────────────────────────

const RESULT = { revenue: 500_000, totalOpCost: 380_000, landingFee: 20_000, loadFactor: 0.8 };

test('direct cost includes landing fees — they are charged per departure', () => {
  assert.equal(directCostOf(RESULT), 400_000);
});

test('contribution ignores the aircraft; fully-loaded pays for it', () => {
  assert.equal(routeProfit(RESULT, 60_000, BASIS_CONTRIBUTION), 100_000);
  assert.equal(routeProfit(RESULT, 60_000, BASIS_FULL), 40_000);
});

test('the two bases can straddle zero — the whole reason screens disagreed', () => {
  const thin = { revenue: 420_000, totalOpCost: 380_000, landingFee: 20_000, loadFactor: 0.55 };
  assert.ok(routeProfit(thin, 60_000, BASIS_CONTRIBUTION) > 0, 'contribution says keep flying it');
  assert.ok(routeProfit(thin, 60_000, BASIS_FULL) < 0, 'fully loaded says it does not pay for the plane');
});

test('a pair totals every tail on it, and reports both bases', () => {
  const entries = [
    { route: { id: 'r1' }, result: RESULT },
    { route: { id: 'r2' }, result: { revenue: 200_000, totalOpCost: 150_000, landingFee: 10_000, loadFactor: 0.7 } },
  ];
  const econ = pairEconomics(entries, { r1: 60_000, r2: 30_000 });
  assert.equal(econ.revenue, 700_000);
  assert.equal(econ.direct, 560_000);
  assert.equal(econ.fixed, 90_000);
  assert.equal(econ.contribution, 140_000);
  assert.equal(econ.full, 50_000);
  assert.equal(econ.profitFor(BASIS_FULL), 50_000);
  assert.equal(econ.profitFor(BASIS_CONTRIBUTION), 140_000);
});

test('margin follows the basis it is quoted with', () => {
  const econ = pairEconomics([{ route: { id: 'r1' }, result: RESULT }], { r1: 60_000 });
  assert.ok(near(econ.marginFor(BASIS_CONTRIBUTION) * 100, 20, 0.01));
  assert.ok(near(econ.marginFor(BASIS_FULL) * 100, 8, 0.01));
});

test('a pair with no results is zero, not NaN', () => {
  const econ = pairEconomics([{ route: { id: 'x' }, result: null }], {});
  assert.equal(econ.revenue, 0);
  assert.equal(econ.marginFor(BASIS_FULL), 0);
});

// ── Break-even ──────────────────────────────────────────────────────────────

test('break-even load is higher once the aircraft has to be paid for', () => {
  const beContribution = breakEvenLoad(RESULT, 60_000, BASIS_CONTRIBUTION);
  const beFull         = breakEvenLoad(RESULT, 60_000, BASIS_FULL);
  assert.ok(beFull > beContribution);
  // revenue at 100% load = 500k / 0.8 = 625k; direct 400k → 64%
  assert.ok(near(beContribution * 100, 64, 0.01), `got ${beContribution}`);
  assert.ok(near(beFull * 100, 73.6, 0.01), `got ${beFull}`);
});

test('a route below its break-even is losing money on that basis', () => {
  const be = breakEvenLoad(RESULT, 60_000, BASIS_FULL);
  assert.ok(RESULT.loadFactor > be, 'this fixture is profitable fully loaded');
  const thin = { ...RESULT, revenue: 430_000, loadFactor: 0.69 };
  assert.ok(thin.loadFactor < breakEvenLoad(thin, 60_000, BASIS_FULL));
  assert.ok(routeProfit(thin, 60_000, BASIS_FULL) < 0, 'and the profit agrees with the break-even');
});

test('break-even is null when nothing is flying, not a confident zero', () => {
  assert.equal(breakEvenLoad({ ...RESULT, loadFactor: 0 }, 0, BASIS_FULL), null);
  assert.equal(breakEvenLoad(null, 0, BASIS_FULL), null);
});

// ── The basis is shared, not per-screen ─────────────────────────────────────

test('the chosen basis persists, so two screens cannot answer differently', () => {
  store.clear();
  assert.equal(loadProfitBasis(), BASIS_FULL, 'fully loaded is the honest default');
  saveProfitBasis(BASIS_CONTRIBUTION);
  assert.equal(loadProfitBasis(), BASIS_CONTRIBUTION);
  saveProfitBasis(BASIS_FULL);
});

test('an unreadable or junk store degrades to the default rather than throwing', () => {
  store.clear();
  store.set('hw_profit_basis_v1', 'nonsense');
  assert.equal(loadProfitBasis(), BASIS_FULL);
  store.clear();
});

test('every basis has a long label, a short label and help text', () => {
  for (const b of [BASIS_CONTRIBUTION, BASIS_FULL]) {
    assert.ok(PROFIT_LABELS[b] && PROFIT_SHORT[b] && PROFIT_HELP[b], `${b} is missing a label`);
  }
  assert.notEqual(PROFIT_LABELS[BASIS_CONTRIBUTION], PROFIT_LABELS[BASIS_FULL]);
});

// ── The screens actually agree now ──────────────────────────────────────────

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Routes = (await import('../src/components/Routes.jsx')).default;

// The health strip only renders past three city pairs, so give it four — and a
// leased freighter sharing nothing, so there is a real fixed cost to disagree
// about. Every tail is LEASED: an owned fleet would make the two bases nearly
// identical and the test would pass for the wrong reason.
const HUB = 'JFK';
const SPOKES = ['LAX', 'ORD', 'MIA', 'SEA'];
const save = {
  ...freshState(),
  phase: 'playing', week: 30, year: 1, hub: HUB, cash: 50_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: Object.fromEntries([HUB, ...SPOKES].map(c => [c, 12])),
  fleet: [
    ...SPOKES.map((s, i) => ({
      id: `ac${i}`, typeId: jet.id, name: `Jet ${i}`, tailNumber: `N${i}`, status: 'assigned',
      ageWeeks: 104, ownershipType: 'lease', weeklyLease: 90_000, leaseRemainingWeeks: 120,
      config: { economy: jet.seats },
    })),
    { id: 'f1', typeId: frtr.id, name: 'Freighter', tailNumber: 'NF', status: 'assigned',
      ageWeeks: 104, ownershipType: 'lease', weeklyLease: 80_000, leaseRemainingWeeks: 120 },
  ],
  routes: SPOKES.map((s, i) => ({
    id: `r${i}`, origin: HUB, destination: s, aircraftId: `ac${i}`, weeklyFrequency: 6,
    weeksOpen: 30, hub: HUB, ticketPrice: 260, cateringLevel: 'full',
  })),
  cargoRoutes: [
    { id: 'c1', origin: HUB, destination: SPOKES[0], aircraftId: 'f1', weeklyFrequency: 4,
      yieldPrice: 0.35, weeksOpen: 30 },
  ],
};

function renderRoutes(basis) {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(save));
  if (basis) store.set('hw_profit_basis_v1', basis);
  const html = renderToString(React.createElement(GameProvider, null, React.createElement(Routes)));
  return html.replace(/<!-- -->/g, '');
}

/** First money figure after a label, e.g. "Full profit / wk" -> "-$12.3K". */
function figureAfter(html, label) {
  const i = html.indexOf(label);
  if (i < 0) return null;
  return (html.slice(i).match(/-?\$[\d.,]+[KMB]?/) ?? [null])[0];
}

const fullHtml    = renderRoutes(BASIS_FULL);
const contribHtml = renderRoutes(BASIS_CONTRIBUTION);

test('the Routes page says which profit it is showing', () => {
  // Twice: the basis switch, and the health strip that used to print a bare
  // number with nothing to say which of the two profits it meant.
  const hits = fullHtml.split(PROFIT_LABELS[BASIS_FULL]).length - 1;
  assert.ok(hits >= 2, `expected the basis named on the strip and the switch, found ${hits}`);
});

test('the card no longer invents its own label', () => {
  assert.ok(!fullHtml.includes('Op Profit / wk'),
    '"Op Profit / wk" meant contribution while the strip beside it meant fully loaded');
  assert.ok(fullHtml.includes(PROFIT_SHORT[BASIS_FULL]));
});

test('the fully-loaded card shows what it took off for the aircraft', () => {
  assert.ok(/lease \+ maint/.test(fullHtml),
    'a fully-loaded number should say what it subtracted');
});

test('the profit switch offers both bases', () => {
  assert.ok(fullHtml.includes(PROFIT_LABELS[BASIS_CONTRIBUTION]) && fullHtml.includes(PROFIT_LABELS[BASIS_FULL]));
});

test('the card follows the basis, instead of always showing contribution', () => {
  // The whole defect in one assertion: switch the basis and the CARD has to
  // move with the strip. It used to be hard-wired to revenue − direct cost, so
  // it printed the same figure whatever the rest of the screen was counting.
  const cardFull    = figureAfter(fullHtml, PROFIT_SHORT[BASIS_FULL]);
  const cardContrib = figureAfter(contribHtml, PROFIT_SHORT[BASIS_CONTRIBUTION]);
  assert.ok(cardFull && cardContrib, `expected a figure on both cards (${cardFull} / ${cardContrib})`);
  assert.notEqual(cardFull, cardContrib,
    'the card printed the same number on both bases — it is not carrying the aircraft');
});

test('the strip moves with the basis too, and in the same direction as the card', () => {
  // Contribution ignores lease + maintenance, so it must be the larger number
  // on both surfaces. Compare the network totals the strip prints first.
  const stripFull    = figureAfter(fullHtml, PROFIT_LABELS[BASIS_FULL]);
  const stripContrib = figureAfter(contribHtml, PROFIT_LABELS[BASIS_CONTRIBUTION]);
  assert.ok(stripFull && stripContrib, 'expected a network total in the strip on both bases');
  assert.notEqual(stripFull, stripContrib);
});

// ── The alert counts what the filter it links to counts ─────────────────────

test('the Dashboard alert counts city pairs, on the shared basis', () => {
  const src = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.ok(/loss-making city pair/.test(src),
    'the alert still counts per-aircraft deployments, but links to a filter over city pairs');
  assert.ok(/loadProfitBasis\(\)/.test(src),
    'the alert must count on the same basis the Routes filter uses');
  assert.ok(/allocateFixedCosts/.test(src),
    'the Dashboard must allocate from the shared helper, not its own copy');
});

test('Finance allocates from the shared helper too', () => {
  const src = readFileSync(new URL('../src/components/Finance.jsx', import.meta.url), 'utf8');
  assert.ok(/allocateFixedCosts/.test(src));
  assert.ok(!/const allAircraftRoutes = routes\.filter/.test(src),
    'Finance still splits over passenger routes only — a freighter tail bills the passenger side');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
