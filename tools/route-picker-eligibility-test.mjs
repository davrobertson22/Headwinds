// Route form: the Aircraft picker must offer only airframes the ADD_ROUTE
// reducer would actually accept.
//
// The reducer's connectivity rule: an aircraft that already flies somewhere can
// only pick up a route touching an airport it already serves — no teleporting.
// If the picker lists a plane that fails that rule, the player builds a whole
// route form and gets rejected on submit. This renders the REAL AddRouteForm and
// asserts the offending airframes never reach the <option> list.
//
//   node --import ./tools/_register-loader.mjs tools/route-picker-eligibility-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { MAX_WEEKLY_BLOCK_HOURS, deployableFleetForRoute, routeDistanceKm, effectiveRangeKm } from '../src/utils/simulation.js';

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
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// A long-range jet (so range never becomes the reason a plane is excluded) and a
// freighter, which must never appear in a passenger picker at all.
const jet  = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const frtr = AIRCRAFT_TYPES.filter(t => t.freighter).sort((a, b) => b.range - a.range)[0];

// HUB/SPOKE are where the player flies today. FAR1/FAR2 are an unrelated pair —
// nothing in the fleet touches them.
const [HUB, SPOKE, FAR1, FAR2] = ['GRR', 'DFW', 'SFO', 'FRA'];
for (const c of [HUB, SPOKE, FAR1, FAR2]) assert.ok(getAirport(c), `${c} missing from the airport data`);

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { AddRouteForm } = await import('../src/components/Routes.jsx');

const plane = (id, name) => ({
  id, name, typeId: jet.id, tailNumber: id.toUpperCase(),
  status: 'assigned', ageWeeks: 52, ownershipType: 'owned',
  config: { economy: jet.seats },
});

const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { [HUB]: 10, [SPOKE]: 10, [FAR1]: 10, [FAR2]: 10 },
  fleet: [
    plane('ac_hub',  'Hub Flyer'),      // flies HUB–SPOKE — eligible for that pair
    plane('ac_far',  'Far Flyer'),      // flies FAR1–FAR2 — cannot teleport to HUB
    { ...plane('ac_idle', 'Idle Bird'), status: 'idle' },  // no routes — goes anywhere
    { id: 'frt', name: 'Box Hauler', typeId: frtr.id, tailNumber: 'NF1',
      status: 'assigned', ageWeeks: 52, ownershipType: 'owned' },
  ],
  routes: [
    { id: 'r1', origin: HUB,  destination: SPOKE, aircraftId: 'ac_hub', weeklyFrequency: 7, weeksOpen: 20, hub: HUB, ticketPrice: 220, cateringLevel: 'full' },
    { id: 'r2', origin: FAR1, destination: FAR2,  aircraftId: 'ac_far', weeklyFrequency: 3, weeksOpen: 20, hub: HUB, ticketPrice: 480, cateringLevel: 'full' },
  ],
  cargoRoutes: [],
};

store.set('bbae_save_v2', JSON.stringify(save));

const clean = (h) => h.replace(/<!-- -->/g, '');
const render = (props) => clean(renderToString(
  React.createElement(GameProvider, null,
    React.createElement(AddRouteForm, { onClose: () => {}, ...props }))
));

// Pull just the Aircraft <select>, so a plane named elsewhere on the form (the
// warning line, a preview) can't be mistaken for an offered option.
const optionsOf = (html) => {
  const sel = html.match(/<select[^>]*>((?:(?!<\/select>)[\s\S])*)<\/select>/g) ?? [];
  const acSel = sel.find(s => /seats\)/.test(s));
  return acSel ?? '';
};

console.log('\n── 1. A plane whose network misses the pair is not offered ──');

let opts;
test('form renders', () => {
  opts = optionsOf(render({ initialOrigin: HUB, initialDest: SPOKE }));
  assert.ok(opts.length > 0, 'no aircraft <select> rendered');
});

test('the idle aircraft is offered (it can go anywhere)', () => {
  assert.ok(opts.includes('Idle Bird'), 'an idle airframe must always be selectable');
});

test('the aircraft already serving the pair is offered', () => {
  assert.ok(opts.includes('Hub Flyer'), 'a plane already on this pair must be selectable');
});

test('the aircraft based on an unrelated pair is NOT offered', () => {
  assert.ok(!opts.includes('Far Flyer'),
    'a plane whose network misses both endpoints would be rejected by ADD_ROUTE — hide it');
});

test('freighters are never offered on a passenger route', () => {
  assert.ok(!opts.includes('Box Hauler'), 'freighters belong to the cargo planner');
});

console.log('\n── 2. Eligibility follows the chosen pair ──────────────');

test('choosing the far pair flips which airframes are offered', () => {
  const o = optionsOf(render({ initialOrigin: FAR1, initialDest: FAR2 }));
  assert.ok(o.includes('Far Flyer'), 'the far-based plane serves this pair');
  assert.ok(o.includes('Idle Bird'), 'idle is eligible everywhere');
  assert.ok(!o.includes('Hub Flyer'), 'the hub plane cannot teleport to the far pair');
});

test('a pair touching one served airport keeps that aircraft eligible', () => {
  // SPOKE is an endpoint of the hub plane's existing route, so it may extend there.
  const o = optionsOf(render({ initialOrigin: SPOKE, initialDest: FAR1 }));
  assert.ok(o.includes('Hub Flyer'), 'extending from a served airport is allowed');
  assert.ok(o.includes('Far Flyer'), 'FAR1 is served by the far plane');
});

console.log('\n── 3. Out-of-hours airframes drop out ──────────────────');

test('a plane with no block hours left is not offered', () => {
  const t = AIRCRAFT_TYPES.find(x => x.id === jet.id);
  assert.ok(t, 'jet type missing');
  // Saturate the hub plane: enough frequency to blow past the weekly cap.
  // scheduleTrimVersion marks the save as already through the one-off over-cap
  // migration, so loading it leaves this deliberately-over-cap fixture alone —
  // the subject here is the PICKER, not the migration. A real save in this shape
  // is an NWR tail grandfathered above its world's scheduling ceiling.
  const saturated = {
    ...save,
    scheduleTrimVersion: 1,
    routes: [
      { ...save.routes[0], weeklyFrequency: 21 },
      { id: 'r1b', origin: HUB, destination: FAR1, aircraftId: 'ac_hub', weeklyFrequency: 21, weeksOpen: 20, hub: HUB, ticketPrice: 300, cateringLevel: 'full' },
      save.routes[1],
    ],
  };
  store.set('bbae_save_v2', JSON.stringify(saturated));
  const o = optionsOf(render({ initialOrigin: HUB, initialDest: SPOKE }));
  store.set('bbae_save_v2', JSON.stringify(save));
  assert.ok(!o.includes('Hub Flyer'),
    `a plane past ${MAX_WEEKLY_BLOCK_HOURS}h block hours has nothing left to give`);
  assert.ok(o.includes('Idle Bird'), 'the idle plane should still be there');
});

console.log('\n── 4. An empty picker explains itself ──────────────────');

test('with no eligible aircraft the player is told why, not shown a blank list', () => {
  const only = { ...save, fleet: [save.fleet[1]], routes: [save.routes[1]] };  // far plane only
  store.set('bbae_save_v2', JSON.stringify(only));
  const html = render({ initialOrigin: HUB, initialDest: SPOKE });
  store.set('bbae_save_v2', JSON.stringify(save));
  assert.ok(html.includes('no eligible aircraft'), 'expected the empty-picker option label');
  assert.ok(html.includes('No aircraft is free for this pair'), 'expected the explanatory hint');
});

console.log('\n── 5. The pool reads a route\'s stops the way ADD_ROUTE does ──');

// Ringwraith (Discord, 15 Sep 2026): planes "flying from one of those airports"
// were still told they couldn't reach the lane. The pool counted only a route's
// endpoints as served; the reducer counts every stop (routeStops). A tail flying
// FAR1 → HUB → FAR2 as a tag flight serves HUB.
test('a tag stop counts as a served airport', () => {
  const fleet  = [plane('ac_tag', 'Tag Flyer')];
  const routes = [{ id: 'rt', origin: FAR1, destination: FAR2, stops: [FAR1, HUB, FAR2],
                    aircraftId: 'ac_tag', weeklyFrequency: 3, weeksOpen: 20, hub: HUB }];
  const pool = deployableFleetForRoute({
    fleet, existingRoutes: routes, typeId: jet.id, origin: HUB, dest: SPOKE,
    distKm: routeDistanceKm(HUB, SPOKE), weeklyFrequency: 3,
  });
  assert.equal(pool.length, 1);
  assert.equal(pool[0].connectivityOk, true, 'HUB is an interior stop of its route — it serves HUB');
  assert.equal(pool[0].eligible, true);
});

console.log('\n── 6. An empty pool names the real blocker ──────────────');

// Resolved lazily: on a tree without the helper, section 5 above must still run
// and fail on its own merits rather than the whole file dying at import.
const deploymentShortfall = (await import('../src/utils/simulation.js')).deploymentShortfall
  ?? (() => { throw new Error('deploymentShortfall is not exported from utils/simulation.js'); });

// The type is listed because its longest-legged tail reaches the lane. That tail
// is busy elsewhere; the idle ones are short as configured. The old sentence —
// "flying other networks" — was false about the idle planes.
const lane = (() => {
  // A regional type and a pair just beyond its stock range, so a lighter cabin
  // brings one tail into reach. Search the catalogue for a workable pair.
  for (const t of AIRCRAFT_TYPES.filter(t => !t.freighter && t.range >= 1500 && t.range <= 4000)) {
    const stock = effectiveRangeKm({ typeId: t.id, config: { economy: t.seats } }, t);
    const light = effectiveRangeKm({ typeId: t.id, config: { economy: Math.round(t.seats * 0.5) } }, t);
    if (light <= stock) continue;
    for (const [a, b] of [['DFW','SFO'],['GRR','DFW'],['FRA','SFO'],['DFW','FRA'],['SFO','GRR'],['JFK','DEN'],['LHR','ATH'],['LHR','CAI'],['JFK','LAX'],['DFW','SEA'],['ORD','LAX'],['BOS','DEN']]) {
      if (!getAirport(a) || !getAirport(b)) continue;
      const d = routeDistanceKm(a, b);
      if (d > stock && d <= light) return { t, a, b, d, stock, light };
    }
  }
  return null;
})();

test('a mixed fleet is described as short AND committed, not just committed', () => {
  assert.ok(lane, 'no type/pair combination found for the fixture');
  const { t, a, b, d } = lane;
  const mk = (id, seats, status) => ({ id, name: id, typeId: t.id, tailNumber: id.toUpperCase(),
    status, ageWeeks: 52, ownershipType: 'owned', config: { economy: seats } });
  const fleet = [
    mk('lite', Math.round(t.seats * 0.5), 'assigned'),   // reaches the lane, flies FAR1–FAR2
    mk('idle1', t.seats, 'idle'),                        // parked, short
    mk('idle2', t.seats, 'idle'),                        // parked, short
  ];
  // The busy tail's own route: one short rotation a week between two airports
  // that are neither end of the lane, so hours are never what stops it.
  const [o1, o2] = [HUB, SPOKE, FAR1, FAR2, 'ORD', 'BOS'].filter(c => c !== a && c !== b && getAirport(c));
  const routes = [{ id: 'rf', origin: o1, destination: o2, aircraftId: 'lite', weeklyFrequency: 1, weeksOpen: 20, hub: HUB }];
  const pool = deployableFleetForRoute({ fleet, existingRoutes: routes, typeId: t.id, origin: a, dest: b, distKm: d, weeklyFrequency: 1 });
  const short = deploymentShortfall(pool);
  assert.equal(short?.reason, 'other-networks', JSON.stringify(short));
  assert.equal(short.inRange, 1);
  assert.equal(short.outOfRange, 2);
  assert.equal(short.idleOutOfRange, 2);
  assert.equal(short.reachable[0].id, 'lite');
  assert.ok(short.bestShortReachKm > 0 && short.bestShortReachKm < d, 'the short tails\' best reach is below the lane');
});

test('the other reasons still come out by name', () => {
  assert.equal(deploymentShortfall([])?.reason, 'none-owned');
  const base = { aircraft: { id: 'x' }, idle: true, reserve: false, reachKm: 1000 };
  assert.equal(deploymentShortfall([{ ...base, rangeOk: false, hoursOk: true, connectivityOk: true, eligible: false }])?.reason, 'out-of-range');
  assert.equal(deploymentShortfall([{ ...base, rangeOk: true, hoursOk: false, connectivityOk: true, eligible: false }])?.reason, 'no-hours');
  assert.equal(deploymentShortfall([{ ...base, rangeOk: true, hoursOk: true, connectivityOk: false, eligible: false }])?.reason, 'other-networks');
  assert.equal(deploymentShortfall([{ ...base, rangeOk: true, hoursOk: true, connectivityOk: true, eligible: true }]), null, 'an eligible tail needs no explanation');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
