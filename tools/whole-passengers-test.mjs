// Whole passengers — an airline cannot carry 0.491 of a person.
//
// Reported from a live New World Restrictions world: the Network table printed
// "4,276.271 pax/wk" (and a "36,666.491/wk" network total). Two defects, one
// per layer, and BOTH are load-bearing:
//
//   ENGINE. simulateRoute scales the demand pool by `nwrDemandScale` for NWR
//     load-factor realism. The demand model hands it INTEGERS; a continuous
//     scale factor does not preserve that. Per-class fan-out rounds
//     (`preferredDemand`), so the fraction hid there — but the involuntary
//     -upgrade pass sizes itself off the RAW pool (`maxFillable = min(leisure +
//     business, cap)`), so the remainder went straight into `totalPaxOneWay`.
//     That is why only SOME routes showed it: a route whose economy cabin never
//     overflows never runs the upgrade pass. Classic (non-NWR) worlds were
//     always integral, which is why this survived so long.
//
//   UI. Every pax figure called `.toLocaleString()` on a raw number, which
//     happily renders three decimals. Now they all go through `formatPax`, so
//     history written by older builds renders as whole people too.
//
//   node --import ./tools/_register-loader.mjs tools/whole-passengers-test.mjs

import assert from 'node:assert/strict';
import { simulateRoute, formatPax } from '../packages/engine/src/utils/simulation.js';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// A narrowbody with a small premium cabin: the config that exercises the
// involuntary-upgrade path (economy overflows while premium seats sit empty).
const type = AIRCRAFT_TYPES.find(t => !t.freighter && t.seats >= 150 && t.seats <= 220)
          ?? AIRCRAFT_TYPES.find(t => !t.freighter);
assert.ok(type, 'expected a passenger aircraft type in the catalogue');

const aircraftWith = (cfg) => ({
  id: 'ac-1', typeId: type.id, ageWeeks: 30, ownershipType: 'owned', config: cfg,
});
const CONFIGS = [
  { economy: Math.round(type.seats * 0.85), premiumEconomy: 0, businessClass: Math.round(type.seats * 0.05), firstClass: 0 },
  { economy: Math.round(type.seats * 0.70), premiumEconomy: Math.round(type.seats * 0.10), businessClass: Math.round(type.seats * 0.06), firstClass: 2 },
  { economy: type.seats, premiumEconomy: 0, businessClass: 0, firstClass: 0 },
];

const routeAt = (jitter, i) => ({
  id: `r-${i}`, origin: 'SFO', destination: 'LAX', hub: 'SFO',
  weeklyFrequency: 10 + (i % 25), ticketPrice: 120,
  classPrices: { economy: 120 }, weeksOpen: 60,
  ...(jitter == null ? {} : { nwrLoadJitter: jitter }),
});

// ── 1. NWR worlds: whole pax on every route, at every jitter ──────────────────
test('NWR route pax are whole numbers (this is the reported bug)', () => {
  const offenders = [];
  let sims = 0;
  for (const cfg of CONFIGS) {
    const aircraft = aircraftWith(cfg);
    for (let i = 0; i < 40; i++) {
      // Sweep the full jitter band the NWR model produces.
      const r = simulateRoute(routeAt(0.88 + i * 0.006, i), aircraft, { month: 6 });
      if (!r) continue;
      sims++;
      if (!Number.isInteger(r.passengers)) offenders.push(r.passengers);
      for (const [cls, d] of Object.entries(r.classSummary ?? {})) {
        if (!Number.isInteger(d.passengers)) offenders.push(`${cls}:${d.passengers}`);
      }
    }
  }
  assert.ok(sims > 50, `expected a meaningful sweep, ran ${sims}`);
  assert.deepEqual(offenders.slice(0, 5), [], `fractional pax in ${offenders.length}/${sims} sims`);
});

// ── 2. Classic worlds were never broken — keep them that way ──────────────────
test('classic (no jitter) route pax are whole numbers', () => {
  for (const cfg of CONFIGS) {
    const aircraft = aircraftWith(cfg);
    for (let i = 0; i < 20; i++) {
      const r = simulateRoute(routeAt(null, i), aircraft, { month: 6 });
      if (!r) continue;
      assert.ok(Number.isInteger(r.passengers), `classic route returned ${r.passengers} pax`);
    }
  }
});

// ── 3. Rounding must not silently invent or destroy demand ────────────────────
test('rounding never moves pax by more than a passenger per cabin', () => {
  const cfg = CONFIGS[1];
  const aircraft = aircraftWith(cfg);
  for (let i = 0; i < 20; i++) {
    const r = simulateRoute(routeAt(0.95, i), aircraft, { month: 6 });
    if (!r) continue;
    const summed = Object.values(r.classSummary ?? {})
      .reduce((s, d) => s + (d.passengers ?? 0), 0);
    assert.equal(summed, r.passengers, 'class summary must sum to the route total');
    assert.ok(r.passengers <= r.configuredSeatsOneWay + 1,
      `${r.passengers} pax exceeds ${r.configuredSeatsOneWay} configured seats`);
    assert.ok(r.loadFactor >= 0 && r.loadFactor <= 1.001, `load factor out of range: ${r.loadFactor}`);
  }
});

// ── 4. The display guard: old saves carry fractional history ──────────────────
test('formatPax rounds legacy fractional history to whole people', () => {
  assert.equal(formatPax(4276.271), '4,276');
  assert.equal(formatPax(36666.491), '36,666');
  assert.equal(formatPax(1943.5),    '1,944');
  assert.equal(formatPax(0),         '0');
  assert.equal(formatPax(undefined), '0');   // never renders "NaN"
  assert.equal(formatPax(null),      '0');
  assert.equal(formatPax(NaN),       '0');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
