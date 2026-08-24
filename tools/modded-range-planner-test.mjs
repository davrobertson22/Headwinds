// Route Planner: a jet whose MODIFICATIONS carry it past the lane must be offered.
//
// Reported by ASAS (Discord, 8/19/26):
//
//   "route planner does not allow me to use routes that my aircraft can handle
//    if their max range is below the route range BUT the aircraft have
//    modifications such as engine and sharklet that allow them to have more than
//    enough range"
//
// He was right, and the split was one-sided in an unusually clean way. Range in
// this game belongs to the AIRFRAME: buying sharklets stamps `rangeMod` on the
// tail, and `effectiveRangeKm(aircraft, type)` is what the reducer's own
// ADD_ROUTE guard measures a lane against — so the engine would have opened the
// route happily. Every other surface agreed with the engine (Routes.jsx, the tag
// planner, the Route Finder, findCandidates). RoutePlanner.jsx and
// CargoRoutePlanner.jsx were the last two comparing against the CATALOGUE figure
// `type.range`, in two places each:
//
//   · reachableTypes — the aircraft <select>: the type never appeared at all
//   · the forecast guard — belt to the same braces, so even a seeded selection
//     produced no economics
//
// A third hole sat underneath both: deployableFleetForRoute() checked block
// hours and network connectivity but never range, so once the type WAS listed
// its stock sister tails would have been counted as "ready" for a lane only the
// modded one reaches — offered by the picker, then refused by the reducer.
//
// This suite asserts the engine's acceptance FIRST (so the premise is proven,
// not assumed), then drives the real component into the reporter's state and
// checks the type reaches the <option> list and the economics card actually
// renders. The negative control is the same lane with the mod removed.
//
//   node --import ./tools/_register-loader.mjs tools/modded-range-planner-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES, getAircraftType } from '../src/data/aircraft.js';
import { AIRPORTS, getAirport } from '../src/data/airports.js';
import { distanceKm, effectiveRangeKm, deployableFleetForRoute } from '../src/utils/simulation.js';

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

// ── Hook seeding (same technique as route-planner-render-test) ────────────────
// RoutePlanner takes no props; origin/dest/type are local useState and SSR runs
// no effects, so the only way in is to substitute the initial values of its
// leading state slots. The component itself is the real, unmodified module.
const RCD = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
assert.ok(RCD, 'React 18 hook dispatcher not reachable — this harness needs updating');

let seed = null;
let rawDispatcher = RCD.current;
let liveDispatcher = null;
function wrapDispatcher(d) {
  if (!d) return d;
  const w = Object.create(Object.getPrototypeOf(d));
  Object.assign(w, d);
  w.useState = function (initial) {
    if (seed) {
      const i = seed.i++;
      if (i < seed.slots.length) {
        seed.seen[i] = typeof initial === 'function' ? initial() : initial;
        const slot = seed.slots[i];
        if (slot) return d.useState(slot.value);
      }
      if (seed.i >= seed.slots.length) seed = null;
    }
    return d.useState(initial);
  };
  return w;
}
Object.defineProperty(RCD, 'current', {
  configurable: true,
  get() { return liveDispatcher; },
  set(v) { rawDispatcher = v; liveDispatcher = wrapDispatcher(v); },
});
RCD.current = rawDispatcher;

const SLOT_NAMES = ['mode', 'origin', 'dest', 'selectedTypeId'];
const EXPECTED_INITIALS = ['passenger', '', '', ''];
let lastSeed = null;
function Seed({ slots, children }) { seed = { i: 0, slots, seen: [] }; lastSeed = seed; return children; }

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { addRouteBlockReason } = await import('../packages/engine/src/reducer.mjs');
const RoutePlanner = (await import('../src/components/RoutePlanner.jsx')).default;

// ── Fixture discovery ────────────────────────────────────────────────────────
// Derived, not hard-coded: find a real (type, lane) pair where the CATALOGUE
// range falls short and the sharklet-modded range clears it. The band is narrow
// (rangeMod is 1.025–1.04), so pinning a specific pair would rot the moment the
// aircraft or airport data moves. The winner must also survive the reducer's
// full guard — runways, perimeter rules, body class — so the suite can never
// "pass" on a lane the engine would have refused for an unrelated reason.
const airportList = Array.isArray(AIRPORTS) ? AIRPORTS : Object.values(AIRPORTS);
const bigAirports = airportList.filter(a => (a.runwayFt ?? 0) >= 10_000).slice(0, 60);
assert.ok(bigAirports.length > 10, 'not enough long-runway airports in the data to build a fixture');

const moddableTypes = AIRCRAFT_TYPES.filter(t => !t.freighter && t.configOptions?.wingtips?.rangeMod > 1);
assert.ok(moddableTypes.length > 0,
  'no passenger type offers a range-extending wingtip option any more — this bug class is gone, retire the suite');

function buildSave({ type, origin, dest, spoke, rangeMod }) {
  const tailOf = (id, tailNumber, extra = {}) => ({
    id, tailNumber, name: `Tail ${tailNumber}`, typeId: type.id,
    status: 'idle', ageWeeks: 52, ownershipType: 'owned',
    config: { economy: type.seats }, fuelMod: 1.0, maintMod: 1.0, ...extra,
  });
  return {
    ...freshState(),
    phase: 'playing', week: 20, year: 1, hub: origin, cash: 500_000_000,
    hubs: { [origin]: { tier: 2, tierSince: 1 } },
    gates: { [origin]: 20, [dest]: 20, [spoke]: 20 },
    fleet: [
      tailOf('ac_mod',   'N1MOD',   { rangeMod, hasWingtips: true }), // sharklets fitted
      tailOf('ac_stock', 'N2STOCK', { rangeMod: 1.0 }),               // same type, book range
    ],
    routes: [],
    cargoRoutes: [],
  };
}

let FIX = null;
outer:
for (const type of moddableTypes) {
  const rangeMod = type.configOptions.wingtips.rangeMod;
  const moddedRange = Math.round(type.range * rangeMod);
  for (let i = 0; i < bigAirports.length && !FIX; i++) {
    for (let j = i + 1; j < bigAirports.length; j++) {
      const o = bigAirports[i], d = bigAirports[j];
      const dist = Math.round(distanceKm(o, d));
      if (!(dist > type.range && dist <= moddedRange)) continue;
      const spoke = bigAirports.find(a => a.code !== o.code && a.code !== d.code)?.code;
      if (!spoke) continue;
      const save = buildSave({ type, origin: o.code, dest: d.code, spoke, rangeMod });
      const reason = addRouteBlockReason(save, {
        origin: o.code, destination: d.code, aircraftId: 'ac_mod', weeklyFrequency: 7,
      });
      if (reason) continue;                       // runway / perimeter / size — not our case
      FIX = { type, rangeMod, moddedRange, origin: o.code, dest: d.code, spoke, dist, save };
      break outer;
    }
  }
}

assert.ok(FIX, 'could not build a lane that a stock type misses and a modded one clears — widen the airport slice');

console.log('\nRoute Planner — modified range (ASAS, 8/19/26)\n');
console.log(`  fixture: ${FIX.type.name}  book ${FIX.type.range.toLocaleString()} km`
  + `  ·  with sharklets ${FIX.moddedRange.toLocaleString()} km`
  + `  ·  ${FIX.origin}–${FIX.dest} ${FIX.dist.toLocaleString()} km\n`);

console.log('── 0. Premise: the ENGINE already accepts this route ────');

test('the reducer opens the lane on the modded tail', () => {
  assert.equal(
    addRouteBlockReason(FIX.save, { origin: FIX.origin, destination: FIX.dest, aircraftId: 'ac_mod', weeklyFrequency: 7 }),
    null,
    'ADD_ROUTE would refuse the modded tail — the fixture is wrong, not the planner');
});

test('the reducer refuses the STOCK tail on the same lane', () => {
  const reason = addRouteBlockReason(FIX.save, { origin: FIX.origin, destination: FIX.dest, aircraftId: 'ac_stock', weeklyFrequency: 7 });
  assert.ok(reason && /can't reach/.test(reason),
    `expected a range refusal for the unmodded sister, got ${JSON.stringify(reason)}`);
});

test('effectiveRangeKm is what separates them', () => {
  const t = getAircraftType(FIX.type.id);
  assert.ok(effectiveRangeKm({ typeId: t.id, rangeMod: FIX.rangeMod }, t) >= FIX.dist, 'modded tail reaches');
  assert.ok(effectiveRangeKm({ typeId: t.id }, t) < FIX.dist, 'stock tail does not');
});

console.log('\n── 1. deployableFleetForRoute gates on range per airframe ──');

test('the modded tail is eligible, the stock sister is not', () => {
  const pool = deployableFleetForRoute({
    fleet: FIX.save.fleet, existingRoutes: [], typeId: FIX.type.id,
    origin: FIX.origin, dest: FIX.dest, distKm: FIX.dist, weeklyFrequency: 7,
  });
  const mod   = pool.find(d => d.aircraft.id === 'ac_mod');
  const stock = pool.find(d => d.aircraft.id === 'ac_stock');
  assert.ok(mod && stock, 'both tails should be in the pool, flagged differently');
  assert.equal(mod.eligible, true,  'the sharklet tail can fly this lane');
  assert.equal(stock.eligible, false,
    'the stock tail was counted as ready for a lane it cannot reach — the picker would offer a plane ADD_ROUTE refuses');
  assert.equal(stock.rangeOk, false, 'rangeOk is the flag that must catch it');
});

test('on a lane both tails reach, neither is filtered out', () => {
  const shortLane = Math.round(FIX.type.range * 0.5);
  const pool = deployableFleetForRoute({
    fleet: FIX.save.fleet, existingRoutes: [], typeId: FIX.type.id,
    origin: FIX.origin, dest: FIX.dest, distKm: shortLane, weeklyFrequency: 7,
  });
  assert.equal(pool.filter(d => d.eligible).length, 2,
    'the range gate must not swallow airframes on a lane they comfortably reach');
});

console.log('\n── 2. The planner OFFERS the modded type ────────────────');

function renderPlanner(save, origin, dest, typeId) {
  store.set('bbae_save_v2', JSON.stringify(save));
  const slots = [null, { value: origin }, { value: dest }, { value: typeId }];
  return renderToString(
    React.createElement(GameProvider, null,
      React.createElement(Seed, { slots },
        React.createElement(RoutePlanner)))).replace(/<!-- -->/g, '');
}

let html;
test("the harness is seeding RoutePlanner's own state slots", () => {
  html = renderPlanner(FIX.save, FIX.origin, FIX.dest, FIX.type.id);
  assert.ok(lastSeed, 'seed wrapper never ran');
  assert.deepEqual(lastSeed.seen.slice(0, SLOT_NAMES.length), EXPECTED_INITIALS,
    `RoutePlanner's leading useState block changed — expected [${SLOT_NAMES}] to start as `
    + `${JSON.stringify(EXPECTED_INITIALS)} but saw ${JSON.stringify(lastSeed.seen.slice(0, 4))}.`);
});

test('the aircraft picker lists the modded type', () => {
  const selects = html.match(/<select[^>]*>((?:(?!<\/select>)[\s\S])*)<\/select>/g) ?? [];
  const acSelect = selects.find(s => /seats\)/.test(s)) ?? '';
  assert.ok(acSelect, 'no aircraft <select> rendered at all');
  assert.ok(acSelect.includes(FIX.type.name),
    `${FIX.type.name} is missing from the aircraft picker on a ${FIX.dist.toLocaleString()} km lane `
    + `it reaches with sharklets (${FIX.moddedRange.toLocaleString()} km) — the picker is still `
    + `comparing against the catalogue range (${FIX.type.range.toLocaleString()} km)`);
});

test('the row says WHY a short-on-paper type is listed', () => {
  assert.ok(/km with your mods/.test(html),
    'a type whose book range falls short of the lane must be labelled with its real reach, '
    + 'or the entry reads like a bug to anyone who knows the published figure');
});

test('the modded type is the one actually SELECTED, not silently swapped out', () => {
  // Without this the case above is weak: RoutePlanner re-seeds selectedTypeId to a
  // reachable default during render, so on the broken build the economics card
  // still renders — for some other jet entirely. The <option selected> marker is
  // what proves the forecast on screen belongs to the plane the player picked.
  const selects = html.match(/<select[^>]*>((?:(?!<\/select>)[\s\S])*)<\/select>/g) ?? [];
  const acSelect = selects.find(s => /seats\)/.test(s)) ?? '';
  const chosen = (acSelect.match(/<option[^>]*selected[^>]*>[\s\S]*?<\/option>/g) ?? [])[0] ?? '';
  assert.ok(chosen.includes(FIX.type.name),
    `the planner swapped the selection away from ${FIX.type.name} — it still treats the lane as `
    + 'out of range for a tail that reaches it');
});

test('the economics card renders rather than blanking out', () => {
  assert.ok(!html.includes('Select two airports to analyse a route'), 'seeding did not take');
  assert.ok(html.includes('Your estimated economics'), 'the economics card is missing');
  assert.ok(html.includes('Cabin configuration'),
    'the forecast came back null — the simulate guard is still measuring the catalogue range, '
    + 'or the forecast aircraft is not carrying the tail\'s rangeMod into the engine');
  assert.ok(!/Nothing that can reach/.test(html), 'the planner is still on the out-of-range empty state');
});

test('the fares block still prices every cabin', () => {
  // Guards the other half of ASAS's report: per-cabin fares before the route
  // opens. If this suite ever renders a planner without it, the port regressed.
  assert.ok(/Fares/.test(html), 'the fare block is missing from the planner');
});

console.log('\n── 3. The cabin-payload bonus counts too ───────────────');

// configRangeMod: a cabin carrying fewer bodies trades payload for fuel, worth up
// to +15% range — nearly four times what the best wingtip gives. It is stored on
// the airframe like any mod, and effectiveRangeKm (so the reducer) already counts
// it. Crediting only `rangeMod` in the picker left the identical bug in place for
// anyone flying a premium layout, and the InfoTip claiming otherwise made it worse.
const lightCabinFixture = (() => {
  for (const type of AIRCRAFT_TYPES.filter(t => !t.freighter && t.seats >= 150)) {
    // A premium-heavy cabin: same floor, far fewer bodies.
    const config = {
      firstClass: Math.floor(type.seats * 0.05),
      businessClass: Math.floor(type.seats * 0.12),
      premiumEconomy: Math.floor(type.seats * 0.10),
      economy: Math.floor(type.seats * 0.25),
      seatQuality: 'standard', serviceQuality: 'standard',
    };
    const probe = { id: 'x', typeId: type.id, config };
    const reach = effectiveRangeKm(probe, type);
    if (!(reach > type.range * 1.05)) continue;   // want a bonus well past any wingtip
    for (let i = 0; i < bigAirports.length; i++) {
      for (let j = i + 1; j < bigAirports.length; j++) {
        const o = bigAirports[i], d = bigAirports[j];
        const dist = Math.round(distanceKm(o, d));
        if (!(dist > type.range && dist <= reach)) continue;
        const spoke = bigAirports.find(a => a.code !== o.code && a.code !== d.code)?.code;
        if (!spoke) continue;
        const save = {
          ...freshState(),
          phase: 'playing', week: 20, year: 1, hub: o.code, cash: 500_000_000,
          hubs: { [o.code]: { tier: 2, tierSince: 1 } },
          gates: { [o.code]: 20, [d.code]: 20, [spoke]: 20 },
          fleet: [{ id: 'ac_light', tailNumber: 'N3LGHT', name: 'Light Cabin', typeId: type.id,
                    status: 'idle', ageWeeks: 52, ownershipType: 'owned', rangeMod: 1.0, config }],
          routes: [], cargoRoutes: [],
        };
        if (addRouteBlockReason(save, { origin: o.code, destination: d.code, aircraftId: 'ac_light', weeklyFrequency: 7 })) continue;
        return { type, config, reach, origin: o.code, dest: d.code, dist, save };
      }
    }
  }
  return null;
})();

test('a fixture exists where only the cabin bonus clears the lane', () => {
  assert.ok(lightCabinFixture,
    'could not build a lane a premium cabin reaches and the book range does not — widen the airport slice');
});

test('the reducer opens it and the picker offers it', function () {
  const F = lightCabinFixture;
  if (!F) return;   // already reported above
  assert.equal(
    addRouteBlockReason(F.save, { origin: F.origin, destination: F.dest, aircraftId: 'ac_light', weeklyFrequency: 7 }),
    null, 'premise broken: the reducer refuses the light-cabin tail');
  const lightHtml = renderPlanner(F.save, F.origin, F.dest, F.type.id);
  const selects = lightHtml.match(/<select[^>]*>((?:(?!<\/select>)[\s\S])*)<\/select>/g) ?? [];
  const acSelect = selects.find(x => /seats\)/.test(x)) ?? '';
  assert.ok(acSelect.includes(F.type.name),
    `${F.type.name} reaches ${Math.round(F.reach).toLocaleString()} km with its actual cabin and the `
    + `reducer opens the ${F.dist.toLocaleString()} km lane, but the picker still hides it — the `
    + 'cabin-payload bonus is not being counted');
});

console.log('\n── 4. A tail that cannot fly must not advertise its type ──');

test('a grounded modded tail does not put its type in the picker', () => {
  // deployableFleetForRoute drops out-of-service airframes, so a type advertised
  // on a grounded tail's mods renders a picker row with nothing behind it: "0
  // ready", a forecast for a plane you cannot deploy, and an Open Route button
  // with no airframe to reach for.
  const groundedSave = {
    ...FIX.save,
    fleet: [{ ...FIX.save.fleet[0], status: 'maintenance' }, FIX.save.fleet[1]],
  };
  const groundedHtml = renderPlanner(groundedSave, FIX.origin, FIX.dest, FIX.type.id);
  const selects = groundedHtml.match(/<select[^>]*>((?:(?!<\/select>)[\s\S])*)<\/select>/g) ?? [];
  const acSelect = selects.find(x => /seats\)/.test(x)) ?? '';
  assert.ok(!acSelect.includes(`${FIX.type.name} (`),
    `${FIX.type.name} is offered on the strength of a grounded tail's mods — the only airframe `
    + 'that reaches this lane is out of service');
});

console.log('\n── 5. Negative control: same lane, no modification ───────');

test('an all-stock fleet does NOT get the type offered', () => {
  const stockSave = {
    ...FIX.save,
    fleet: FIX.save.fleet.map(a => ({ ...a, rangeMod: 1.0, hasWingtips: false })),
  };
  const stockHtml = renderPlanner(stockSave, FIX.origin, FIX.dest, FIX.type.id);
  const selects = stockHtml.match(/<select[^>]*>((?:(?!<\/select>)[\s\S])*)<\/select>/g) ?? [];
  const acSelect = selects.find(s => /seats\)/.test(s)) ?? '';
  assert.ok(!acSelect.includes(`${FIX.type.name} (`),
    `${FIX.type.name} was offered on a ${FIX.dist.toLocaleString()} km lane with no modified tail in the `
    + 'fleet — the fix over-corrected and now ignores range entirely');
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
