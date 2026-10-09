// Aircraft pickers leave out airports, and types, the runway cannot take.
//
// Matthijs (Discord 2026-10-04): "Would be really nice if airports with a runway
// too short would not show up when selecting a plane" — with a screenshot of
// the Cargo Route Finder searching on an MD-11F, then the freight planner
// saying "PNQ offers only 10,000 ft". The finder's freighter picker only wrote
// the type's range into the max-distance box, so every lane the type could reach
// was listed whether or not it could land; the planners' type pickers likewise
// tested range alone and offered types ADD_ROUTE / ADD_CARGO_ROUTE refuse on the
// runway.
//
// Rendered from the real components (SSR), against the engine's own data.
//
//   node --import ./tools/_register-loader.mjs tools/runway-aware-pickers-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES, getAircraftType } from '../src/data/aircraft.js';
import { AIRPORTS, getAirport } from '../src/data/airports.js';
import { distanceKm } from '../src/utils/simulation.js';
import { cargoCityPairDemand, baseCityPairDemand } from '../src/utils/market.js';
import { checkRouteRestrictions } from '../src/data/airportRestrictions.js';

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

// ── Hook seeding (see planner-class-fares-test for the rationale) ─────────────
const RCD = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
assert.ok(RCD, 'React 18 hook dispatcher not reachable — this harness needs updating');
let seed = null, rawDispatcher = RCD.current, liveDispatcher = null;
function wrapDispatcher(d) {
  if (!d) return d;
  const w = Object.create(Object.getPrototypeOf(d));
  Object.assign(w, d);
  w.useState = function (initial) {
    if (seed) {
      const i = seed.i++;
      if (i < seed.slots.length) {
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
  configurable: true, get() { return liveDispatcher; },
  set(v) { rawDispatcher = v; liveDispatcher = wrapDispatcher(v); },
});
RCD.current = rawDispatcher;
function Seed({ slots, children }) { seed = { i: 0, slots }; return children; }

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { default: CargoRouteFinder } = await import('../src/components/CargoRouteFinder.jsx');
const { default: CargoRoutePlanner } = await import('../src/components/CargoRoutePlanner.jsx');
const { default: RoutePlanner } = await import('../src/components/RoutePlanner.jsx');

const strip = (h) => h.replace(/<!-- -->/g, '');
function render(save, el, slots = null) {
  store.set('bbae_save_v2', JSON.stringify(save));
  const inner = slots ? React.createElement(Seed, { slots }, el) : el;
  return strip(renderToString(React.createElement(GameProvider, null, inner)));
}

// ── Fixture: the report's own freighter, from a field long enough for it ─────
const MD11F = getAircraftType('md11f');
assert.ok(MD11F?.freighter && MD11F.runwayFt > 0, 'MD-11F missing or has no runway requirement');
const ORIGIN = 'BOM';
assert.ok(getAirport(ORIGIN).runwayFt >= MD11F.runwayFt, 'fixture origin too short for the MD-11F');
// The biggest freight lane from BOM the MD-11F reaches but cannot land at.
const short = AIRPORTS
  // A real field (8,000 ft+), not a STOL strip — so the planner check below has
  // freighters that CAN land there to keep offering.
  .filter(a => a.code !== ORIGIN && a.runwayFt >= 8000 && a.runwayFt < MD11F.runwayFt)
  .map(a => ({ a, d: Math.round(distanceKm(getAirport(ORIGIN), a)), dem: cargoCityPairDemand(ORIGIN, a.code, 6) }))
  .filter(r => r.dem > 0 && r.d <= MD11F.range && r.d > 500)
  .sort((x, y) => y.dem - x.dem)[0];
assert.ok(short, 'no short-runway freight lane in range of the MD-11F from BOM');
const SHORT = short.a.code, D = short.d;
console.log(`\n  fixture: MD-11F (needs ${MD11F.runwayFt} ft) · ${ORIGIN}→${SHORT} ${D} km, ${SHORT} has ${short.a.runwayFt} ft\n`);

const save = (extra = {}) => ({
  ...freshState(), phase: 'playing', week: 20, year: 2, hub: ORIGIN, cash: 500_000_000,
  fleet: [], routes: [], cargoRoutes: [], gates: { [ORIGIN]: 20, [SHORT]: 20 }, ...extra,
});

// CargoRouteFinder's state, in source order:
// open, origin, minDist, maxDist, rangeTypeId, sortBy, limit
const finderSlots = (typeId) => [null, { value: ORIGIN }, { value: String(D) }, { value: String(D) }, { value: typeId }];
const rowFor = (html, code) => new RegExp(`<span[^>]*>${code}</span>`).test(html);

console.log('── 1. Cargo Route Finder ────────────────────────────');
test('without a freighter the short-runway lane is listed (raw demand browse)', () => {
  const html = render(save(), React.createElement(CargoRouteFinder, { standalone: true }), finderSlots(''));
  assert.ok(rowFor(html, SHORT), `${SHORT} missing from an unfiltered search — fixture broken`);
});
test('picking the MD-11F hides the lane it cannot land at', () => {
  const html = render(save(), React.createElement(CargoRouteFinder, { standalone: true }), finderSlots(MD11F.id));
  assert.ok(!rowFor(html, SHORT),
    `${SHORT} (${short.a.runwayFt} ft) still listed for an MD-11F that needs ${MD11F.runwayFt} ft`);
});
test('…and says what it hid, so a short list does not read as a thin market', () => {
  const html = render(save(), React.createElement(CargoRouteFinder, { standalone: true }), finderSlots(MD11F.id));
  assert.match(html, /runway too short/, 'no note of the lanes hidden for runway');
});
test('a freighter the origin itself is too short for is named as such', () => {
  // Same search out of the short field: every lane is barred at the origin.
  const s = save({ hub: SHORT });
  const html = render(s, React.createElement(CargoRouteFinder, { standalone: true }),
    [null, { value: SHORT }, null, null, { value: MD11F.id }]);
  assert.match(html, new RegExp(`${SHORT}(&#x27;|')s longest\\s+is`), 'origin runway shortfall not explained');
});

console.log('\n── 2. Freight planner type picker ───────────────────');
const freightOptions = (html) => (html.match(/<select class="form-select"[^>]*>([\s\S]*?)<\/select>/) ?? [, ''])[1];
test('the MD-11F is not offered for a lane its runway rules out', () => {
  const html = render(save(), React.createElement(CargoRoutePlanner, { embedded: true, initialOrigin: ORIGIN, initialDest: SHORT }));
  const opts = freightOptions(html);
  assert.ok(!opts.includes(MD11F.name), `the freighter picker still offers the ${MD11F.name} for ${ORIGIN}→${SHORT}`);
});
test('freighters that can land there are still offered', () => {
  const ok = AIRCRAFT_TYPES.find(t => t.freighter && t.runwayFt && t.runwayFt <= short.a.runwayFt && t.range >= D
    && !checkRouteRestrictions(ORIGIN, SHORT, D, 7, null, { aircraftType: t }));
  assert.ok(ok, 'no freighter in the catalogue can fly this lane — pick another fixture');
  const html = render(save(), React.createElement(CargoRoutePlanner, { embedded: true, initialOrigin: ORIGIN, initialDest: SHORT }));
  assert.ok(freightOptions(html).includes(ok.name), `${ok.name} (needs ${ok.runwayFt} ft) missing from the picker`);
});

console.log('\n── 3. Passenger planner type picker ─────────────────');
// London City: 4,948 ft. A wide-body from Amsterdam reaches it easily and cannot land.
const P_ORIG = 'AMS', P_DEST = 'LCY';
const wide = AIRCRAFT_TYPES.filter(t => !t.freighter && t.runwayFt > getAirport(P_DEST).runwayFt && t.range > 2000)
  .sort((a, b) => b.runwayFt - a.runwayFt)[0];
assert.ok(baseCityPairDemand(P_ORIG, P_DEST) > 0, 'AMS–LCY carries no demand — pick another fixture');
// RoutePlanner state: mode, origin, dest, selectedTypeId, ...
const plannerSlots = [null, { value: P_ORIG }, { value: P_DEST }];
test(`${wide.name} (needs ${wide.runwayFt} ft) is not offered into ${P_DEST}`, () => {
  const html = render(save({ hub: P_ORIG, gates: { [P_ORIG]: 20, [P_DEST]: 20 } }), React.createElement(RoutePlanner), plannerSlots);
  assert.ok(/Aircraft type|needs more runway than/.test(html), 'planner never reached its aircraft section — harness broken');
  assert.ok(!html.includes(`>${wide.name}`), `the passenger picker still lists the ${wide.name} for ${P_ORIG}→${P_DEST}`);
});

console.log('\n── 4. Multi-stop planner aircraft picker ────────────');
const { default: TagRoutePlanner } = await import('../src/components/TagRoutePlanner.jsx');
// A rotation through a short field, with one idle jet too big for it and one
// that fits. ADD_TAG_ROUTE checks the runway on every leg; the picker did not.
const CHAIN = ['AMS', 'BRU', 'LCY'];
const fits = AIRCRAFT_TYPES.filter(t => !t.freighter && t.runwayFt && t.runwayFt <= getAirport('LCY').runwayFt && t.range > 800)
  .sort((a, b) => b.seats - a.seats)[0];
assert.ok(fits, 'no passenger type fits LCY — fixture broken');
const tagSave = save({
  hub: 'AMS', gates: Object.fromEntries(CHAIN.map(c => [c, 20])),
  fleet: [
    { id: 'big', typeId: wide.id, name: 'Too Big', tailNumber: 'NBIG', status: 'idle', ageWeeks: 10, ownershipType: 'owned', config: { economy: wide.seats } },
    { id: 'fit', typeId: fits.id, name: 'Fits Fine', tailNumber: 'NFIT', status: 'idle', ageWeeks: 10, ownershipType: 'owned', config: { economy: fits.seats } },
  ],
});
test(`an idle ${wide.name} is not offered for a rotation through ${P_DEST}`, () => {
  const html = render(tagSave, React.createElement(TagRoutePlanner, { embedded: true, initialStops: CHAIN, onOpened: () => {} }));
  assert.ok(html.includes('Fits Fine'), `the ${fits.name} that fits ${P_DEST} is missing — harness broken`);
  assert.ok(!html.includes('Too Big'), `the picker still offers the ${wide.name}, which ADD_TAG_ROUTE refuses on ${P_DEST}'s runway`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
