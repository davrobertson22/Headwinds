// Route Finder: a lead the finder offers must be one you can actually fly, have
// not already taken, and would not lose money on.
//
// All four defects here were reported in one Discord thread, and all four are the
// same mistake — the finder (and the projection behind it) answered "how big is
// this market?" when the player was asking "should I fly this?".
//
//   ASAS             "it will give you routes that the plane you selected cannot
//                     fly to as the runway length is too short"
//   ASAS             "there arent enough to sort by"
//   ASAS             "you always have to find the aircraft you own for its max
//                     range etc"
//   Lancelotbronner  "multiple airports in the same city still show a large
//                     demand but none of the routes are profitable, are they
//                     linked? Should they disappear from the list as the
//                     (remaining) demand is reduced?"
//
// The fourth one is not a UI complaint. It is a preview↔tick disagreement, and
// section 3 is the one that matters: weeklyTick fights ONE share fight per metro
// pair (utils/simulation.js, "Lanes: one share fight per METRO pair"), while
// pairMarketShare scanned the exact airport pair and nothing else. Measured on
// HEAD before the fix, with a rival flying JFK-LHR and the player pricing up
// EWR-LHR:
//
//     preview  6,160 pax  100.0% load  +$3,131,886/wk   and "no competitors"
//     tick     4,633 pax   75.2% load  +$1,642,215/wk
//
// A 33% passenger and $1.49M/wk overstatement, on a screen that also told the
// player the lane was empty. That is exactly "large demand, no profit".
//
//   node --import ./tools/_register-loader.mjs tools/route-finder-quality-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES, getAircraftType } from '../src/data/aircraft.js';
import { AIRPORTS, getAirport } from '../src/data/airports.js';
import {
  referencePrice, distanceKm, weeklyTick, baseCityPairDemand,
  defaultClassPrices,
} from '../src/utils/simulation.js';
import { projectRouteAddition } from '../src/models/pairShare.js';
import { computeConnectingDemand } from '../src/models/demand.js';
import {
  findCandidates, scoreCandidates, sortCandidates, laneBlockFor, SORTS, DEFAULT_SCORE_LIMIT,
} from '../src/models/routeFinder.js';

// Minimal browser shims for SSR (effects don't run, but init reads localStorage).
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = globalThis.localStorage ?? {
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

console.log('\nRoute Finder — a lead you can fly, have not taken, and would not lose money on\n');

// ── Fixtures ─────────────────────────────────────────────────────────────────
const HUB = 'JFK';
assert.ok(getAirport(HUB), 'fixture airport missing');

// A big jet with a real runway appetite — the type ASAS was being offered
// unusable fields for.
const bigJet = AIRCRAFT_TYPES
  .filter((t) => !t.freighter && t.runwayFt >= 8000 && t.range >= 5000)
  .sort((a, b) => b.runwayFt - a.runwayFt)[0];
assert.ok(bigJet, 'fixture needs a long-runway passenger type');

// Section 3 flies an ORDINARY widebody rather than the runway monster above.
// A supersonic type's ticketPremium puts its fares far up the elasticity curve,
// where the pooled preview and the tick still part company by ~6% — a separate,
// pre-existing residual that has nothing to teach us about metro lanes, and
// pinning it here would only make this suite a supersonic-pricing test.
const laneJet = AIRCRAFT_TYPES
  .filter((t) => !t.freighter && t.range >= 6000 && t.seats >= 250 && (t.ticketPremium ?? 1) === 1)
  .sort((a, b) => b.range - a.range)[0];
assert.ok(laneJet, 'fixture needs a long-haul widebody with ordinary fares');

const mkAc = (id, typeId, extra = {}) => ({
  id, typeId, tailNumber: id.toUpperCase(), status: 'idle', ownershipType: 'owned',
  ageWeeks: 40, config: { economy: getAircraftType(typeId).seats }, ...extra,
});
const mkRoute = (id, o, d, aircraftId, freq = 7) => ({
  id, origin: o, destination: d, aircraftId, weeklyFrequency: freq, weeksOpen: 60,
  hub: HUB, ticketPrice: Math.round(referencePrice(o, d)),
  classPrices: { economy: Math.round(referencePrice(o, d)) },
});

function world({ routes = [], encroachments = {}, fleet = [mkAc('spare', laneJet.id)] } = {}) {
  const gates = {};
  for (const a of AIRPORTS) gates[a.code] = 20;   // gates are not what this suite tests
  return {
    week: 60, absWeek: 60, hub: HUB, hubs: {}, cash: 5e8,
    fleet, routes, cargoRoutes: [], competitors: [], humanRivals: {}, encroachments,
    gates, routePricing: {}, gameDate: { week: 60, month: 6 },
  };
}

// ── 1. Runway: the engine's own guard, not a distance box ────────────────────
console.log('── 1. "routes that the plane you selected cannot fly to" ─────');

const state1 = world();
const shown  = findCandidates(state1, { origin: HUB, aircraftTypeId: bigJet.id, aircraft: state1.fleet[0] });
const everything = findCandidates(state1, {
  origin: HUB, aircraftTypeId: bigJet.id, aircraft: state1.fleet[0],
  hideUnflyable: false, hideServedLanes: false,
});

test('the old distance-only filter really did offer unusable airports', () => {
  // Reproduces the pre-fix candidate loop: demand > 0, inside the type's range,
  // and nothing else. This is the list the finder used to print.
  const from = getAirport(HUB);
  const oldWay = AIRPORTS.filter((a) =>
    a.code !== HUB
    && baseCityPairDemand(HUB, a.code) > 0
    && distanceKm(from, a) <= bigJet.range);
  const tooShort = oldWay.filter((a) => a.runwayFt && a.runwayFt < bigJet.runwayFt);
  assert.ok(tooShort.length > 0,
    `fixture is not exercising the bug: no short-runway airport is in range of the ${bigJet.name}`);
  console.log(`      (the ${bigJet.name} needs ${bigJet.runwayFt.toLocaleString()} ft; `
    + `${tooShort.length} in-range airports cannot take it)`);
});

test('none of them survive the finder now', () => {
  for (const r of shown) {
    assert.ok(!(r.airport.runwayFt && r.airport.runwayFt < bigJet.runwayFt),
      `${r.code} offers ${r.airport.runwayFt} ft, the ${bigJet.name} needs ${bigJet.runwayFt}`);
  }
});

test('they are still findable, labelled with the reason', () => {
  const blocked = everything.filter((r) => r.block?.kind === 'runway');
  assert.ok(blocked.length > 0, 'nothing was runway-blocked — the guard is not running');
  assert.match(blocked[0].block.reason, /runway/i);
});

test('out-of-range airports are blocked as range, not as runway', () => {
  const far = laneBlockFor({
    origin: HUB, destination: 'SYD', distKm: 99999, type: bigJet, routes: [],
  });
  assert.equal(far?.kind, 'range');
});

test('with no aircraft chosen the finder blocks nothing — it is a market browser again', () => {
  const anyPlane = findCandidates(state1, { origin: HUB });
  assert.ok(anyPlane.every((r) => r.block === null));
  assert.ok(anyPlane.length > shown.length);
});

// ── 2. Metro lanes: sibling airports are one market ──────────────────────────
console.log('\n── 2. "are they linked?" — yes ────────────────────────────────');

const flyingLHR = world({
  fleet:  [mkAc('ac0', bigJet.id, { status: 'active' }), mkAc('spare', bigJet.id)],
  routes: [mkRoute('r0', HUB, 'LHR', 'ac0')],
});

test('a London field you already serve from JFK is not offered as a new market', () => {
  const rows = findCandidates(flyingLHR, { origin: HUB, aircraftTypeId: bigJet.id });
  const london = rows.filter((r) => ['LHR', 'LGW', 'STN', 'LTN'].includes(r.code));
  assert.deepEqual(london.map((r) => r.code), [],
    `still offering ${london.map((r) => r.code).join(', ')} — JFK-LHR already takes that traffic`);
});

test('and it is not hidden, only demoted: asking shows it with your own route named', () => {
  const rows = findCandidates(flyingLHR, {
    origin: HUB, aircraftTypeId: bigJet.id, hideServedLanes: false,
  });
  // Grouped, London is one row at whichever field the market prefers — the point
  // is that the market is still reachable and still names the route taking it.
  const london = rows.find((r) => r.lane === 'JFK-LHR');
  assert.ok(london, 'the whole London market vanished rather than being demoted');
  assert.equal(london.servesLane, true);
  assert.deepEqual(london.yourLanePairs, ['JFK-LHR']);
});

test('one row per market: the four Washington airports are one opportunity', () => {
  const rows = findCandidates(state1, { origin: HUB, aircraftTypeId: laneJet.id });
  const dc = rows.filter((r) => ['IAD', 'DCA', 'BWI'].includes(r.code));
  assert.equal(dc.length, 1,
    `${dc.length} Washington rows — IAD, DCA and BWI print the same metro total, `
    + 'so listing them apart shows the same travellers three times');
  assert.ok(dc[0].altCodes.length >= 1, 'the other fields should be named on the row, not silently dropped');
  for (const alt of dc[0].altCodes) assert.notEqual(alt, dc[0].code);
});

test('and every airport is still one checkbox away', () => {
  const rows = findCandidates(state1, { origin: HUB, aircraftTypeId: laneJet.id, groupMetros: false });
  const dc = rows.filter((r) => ['IAD', 'BWI'].includes(r.code));
  assert.ok(dc.length >= 2, 'ungrouped, each field is its own row again');
});

test('a field the aircraft cannot use never wins its market', () => {
  // Recommending the preferred airport is worthless if the metal cannot land
  // there and a sibling would have taken it.
  const opts = {
    origin: HUB, aircraftTypeId: bigJet.id, aircraft: state1.fleet[0], hideUnflyable: false,
  };
  const grouped = findCandidates(state1, opts);
  const flyableLanes = new Set(findCandidates(state1, { ...opts, groupMetros: false })
    .filter((o) => !o.block).map((o) => o.lane));
  for (const r of grouped) {
    if (!r.block) continue;
    assert.ok(!flyableLanes.has(r.lane),
      `${r.code} was chosen for its market despite being unusable, when a sibling field is flyable`);
  }
});

test('a market on nobody else\'s lane is untouched by any of this', () => {
  const rows = findCandidates(flyingLHR, { origin: HUB, aircraftTypeId: bigJet.id });
  const cdg = rows.find((r) => r.code === 'CDG');
  assert.ok(cdg, 'CDG should still be a lead');
  assert.equal(cdg.servesLane, false);
});

// ── 3. The preview has to agree with the tick on a pooled lane ───────────────
console.log('\n── 3. "large demand but none of the routes are profitable" ────');

// A rival flying JFK-LHR while the player prices up EWR-LHR. Nothing at all sits
// on the EWR-LHR key, which is precisely why the old preview saw an empty market.
const RIVAL = { competitorId: 'R1', frequency: 40, priceMultiplier: 0.85, seatsPerFlight: 350, tier: 'legacy' };
const FARE  = Math.round(referencePrice('EWR', 'LHR'));
const FREQ  = 14;
const siblingRival = world({ encroachments: { 'JFK-LHR': RIVAL } });

function previewAndTick(st) {
  const proj = projectRouteAddition(st, {
    origin: 'EWR', destination: 'LHR', aircraft: st.fleet.find((a) => a.id === 'spare'),
    weeklyFrequency: FREQ, ticketPrice: FARE, classPrices: { economy: FARE },
  });
  const opened = mkRoute('rnew', 'EWR', 'LHR', 'spare', FREQ);
  const booked = weeklyTick({ ...st, routes: [...st.routes, opened] })
    .routeResults.find((r) => r.routeId === 'rnew');
  return { proj, booked };
}

test('a rival at the sibling airport is IN the forecast', () => {
  const { proj } = previewAndTick(siblingRival);
  assert.equal(proj.lanePooled, true, 'the metro pre-pass should engage on this lane');
  assert.ok(proj.rivalCount >= 1,
    'the preview still reports an empty market on a lane a rival is flying from the other New York field');
  assert.deepEqual(proj.siblingPairs, [], 'you fly none of this lane yourself');
});

test('and the forecast now matches what the tick books', () => {
  const { proj, booked } = previewAndTick(siblingRival);
  const drift = Math.abs(proj.mature.passengers - booked.passengers) / Math.max(1, booked.passengers);
  assert.ok(drift <= 0.02,
    `previewed ${proj.mature.passengers} pax against the tick's ${booked.passengers} `
    + `(${(drift * 100).toFixed(1)}% drift)`);
});

test('your own sibling service is in it too, and is named', () => {
  const st = world({
    fleet:  [mkAc('ac0', laneJet.id, { status: 'active' }), mkAc('spare', laneJet.id)],
    routes: [mkRoute('r0', HUB, 'LHR', 'ac0', FREQ)],
  });
  const { proj, booked } = previewAndTick(st);
  assert.equal(proj.lanePooled, true);
  assert.deepEqual(proj.siblingPairs, ['JFK-LHR']);
  assert.ok(proj.pairPassengers != null && proj.laneDemand > 0,
    'the planner needs the pair and lane totals to explain the split');
  const drift = Math.abs(proj.mature.passengers - booked.passengers) / Math.max(1, booked.passengers);
  assert.ok(drift <= 0.02,
    `previewed ${proj.mature.passengers} against ${booked.passengers} (${(drift * 100).toFixed(1)}%)`);
});

test('a lane with no metro sibling in play keeps the historical path', () => {
  const st = world();
  const p = projectRouteAddition(st, {
    origin: HUB, destination: 'CDG', aircraft: st.fleet[0], weeklyFrequency: 7,
    ticketPrice: Math.round(referencePrice(HUB, 'CDG')),
  });
  assert.equal(p.lanePooled, false);
  assert.equal(p.rivalCount, 0);
});

// ── 4. Sorting, and a forecast that means something ──────────────────────────
console.log('\n── 4. "there arent enough to sort by" ─────────────────────────');

test('the finder sorts on seven things, three of them earned from the engine', () => {
  const ids = Object.keys(SORTS);
  for (const need of ['demand', 'profit', 'loadFactor', 'fare', 'quiet', 'shortest', 'longest']) {
    assert.ok(ids.includes(need), `missing sort: ${need}`);
  }
  assert.equal(SORTS.profit.needsForecast, true);
  assert.equal(SORTS.demand.needsForecast, false);
});

const scored = scoreCandidates(state1, shown, {
  aircraftTypeId: bigJet.id, aircraft: state1.fleet[0], weeklyFrequency: 7,
  gameDate: { week: 60, month: 6 },
});

test('the forecast reaches the rows and stops at the documented cap', () => {
  const n = scored.filter((r) => r.scored).length;
  assert.ok(n > 0, 'nothing was forecast at all');
  assert.ok(n <= DEFAULT_SCORE_LIMIT, `${n} rows forecast against a cap of ${DEFAULT_SCORE_LIMIT}`);
});

test('profit sort is ordered by profit, and unpriced rows sink rather than lead', () => {
  const ranked = sortCandidates(scored, 'profit');
  let last = Infinity, seenUnscored = false;
  for (const r of ranked) {
    if (!r.projection) { seenUnscored = true; continue; }
    assert.ok(!seenUnscored, 'a forecast row sorted BELOW an unforecast one');
    assert.ok(r.projection.netProfit <= last, 'profit order broken');
    last = r.projection.netProfit;
  }
});

test('the row and the Route Planner quote the same number', () => {
  // The whole point of routing the finder through projectRouteAddition: "Plan →"
  // must not open a screen that disagrees with the row it was clicked on.
  const row = sortCandidates(scored, 'profit').find((r) => r.projection);
  const again = projectRouteAddition(state1, {
    origin: HUB, destination: row.code, aircraft: state1.fleet[0],
    weeklyFrequency: row.projection.weeklyFrequency,
    ticketPrice: row.refPrice,
    gameDate: { week: 60, month: 6 },
  });
  assert.equal(row.projection.passengers, again.mature.passengers);
});

// ── 5. The planner says WHY, in words ────────────────────────────────────────
console.log('\n── 5. "how come net profit comes down if i add more aircraft" ─');

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
  configurable: true,
  get() { return liveDispatcher; },
  set(v) { rawDispatcher = v; liveDispatcher = wrapDispatcher(v); },
});
RCD.current = rawDispatcher;
function Seed({ slots, children }) { seed = { i: 0, slots }; return children; }

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RoutePlanner = (await import('../src/components/RoutePlanner.jsx')).default;

// The reporter's situation: already flying JFK-LHR, now pricing up EWR-LHR.
const SAVE = {
  ...freshState(),
  phase: 'playing', week: 60, year: 2, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { JFK: 20, EWR: 20, LHR: 20 },
  fleet: [
    mkAc('ac0', bigJet.id, { status: 'active' }),
    mkAc('spare', bigJet.id),
  ],
  routes: [mkRoute('r0', HUB, 'LHR', 'ac0')],
  cargoRoutes: [],
};

test('the planner names the market you are already in', () => {
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  const html = renderToString(React.createElement(
    GameProvider, null,
    React.createElement(Seed, {
      slots: [null, { value: 'EWR' }, { value: 'LHR' }, { value: bigJet.id }],
    }, React.createElement(RoutePlanner)),
  )).replace(/<!-- -->/g, '');
  assert.ok(html.includes('Your estimated economics'),
    'the economics card never rendered — the fixture is not reaching the forecast');
  assert.ok(html.includes('You are already in this market'),
    'a pooled lane rendered with no explanation of the pooling');
  assert.ok(html.includes('JFK-LHR'),
    'the callout does not name the route that is taking the traffic');
});

test('an untouched market gets no "you are already in this market"', () => {
  // Untouched by YOU. Tailwinds seeds AI carriers into a fresh world, and one of
  // them flying JFK-LHR legitimately pools the lane — the planner says so, in the
  // other wording. What must never appear is the claim that the player is on it.
  store.set('bbae_save_v2', JSON.stringify({
    ...SAVE, routes: [], competitors: [], encroachments: {},
    fleet: [mkAc('spare', bigJet.id)],
  }));
  const html = renderToString(React.createElement(
    GameProvider, null,
    React.createElement(Seed, {
      slots: [null, { value: 'EWR' }, { value: 'LHR' }, { value: bigJet.id }],
    }, React.createElement(RoutePlanner)),
  )).replace(/<!-- -->/g, '');
  assert.ok(!html.includes('You are already in this market'),
    'the pooling callout fired on a lane the player has never flown');
});

// ── C-new-3: the finder must quote the same economics as the planner ────────
console.log('\n── C-new-3: finder vs planner vs the tick ────────────────');

test('the finder credits connecting revenue, as weeklyTick and the planner do', () => {
  // A HUB with traffic through it: exactly where connecting feed exists and where
  // the finder used to under-rank the row the planner then quoted higher.
  const st = world({
    routes: [mkRoute('r1', HUB, AIRPORTS[2].code, 'spare', 7), mkRoute('r2', HUB, AIRPORTS[3].code, 'spare', 7)],
  });
  st.hubs = { [HUB]: { tier: 2, tierSince: 0 } };
  const rows = findCandidates(st, { origin: HUB, aircraftTypeId: laneJet.id, aircraft: st.fleet[0] });
  const scored = scoreCandidates(st, rows, {
    aircraftTypeId: laneJet.id, aircraft: st.fleet[0], weeklyFrequency: 7,
    gameDate: st.gameDate, capHours: 140,
  }).filter(r => r.scored && r.projection);
  assert.ok(scored.length > 0, 'fixture produced no scored rows');
  const withFeed = scored.filter(r => (r.projection.connectingRevenue ?? 0) > 0);
  assert.ok(withFeed.length > 0, 'a tier-2 hub must generate connecting feed on some lane');

  for (const row of withFeed) {
    // Rebuild the planner's arithmetic for the same row and require agreement.
    const p = projectRouteAddition(st, {
      origin: row.origin, destination: row.code, aircraft: st.fleet[0],
      weeklyFrequency: row.projection.weeklyFrequency, ticketPrice: row.refPrice,
      classPrices: defaultClassPrices(row.refPrice), gameDate: st.gameDate,
    });
    const conn = computeConnectingDemand(
      row.origin, row.code, st.hubs,
      1 + [...st.routes].filter(r => r.origin === row.origin || r.destination === row.origin).length,
      1 + [...st.routes].filter(r => r.origin === row.code || r.destination === row.code).length,
      row.refPrice,
    );
    // The tail is OWNED in this fixture, so no lease is deducted (the tick charges none).
    const plannerNet = Math.round(p.mature.profit + conn.totalRevenue);
    assert.equal(row.projection.netProfit, plannerNet,
      `finder and planner disagree on ${row.origin}-${row.code}`);
  }
});

test('an OWNED tail is not charged a phantom catalogue lease', () => {
  const st = world();
  st.fleet = [{ ...st.fleet[0], ownershipType: 'owned' }];
  const rows = findCandidates(st, { origin: HUB, aircraftTypeId: laneJet.id, aircraft: st.fleet[0] });
  const scored = scoreCandidates(st, rows, {
    aircraftTypeId: laneJet.id, aircraft: st.fleet[0], weeklyFrequency: 7,
    gameDate: st.gameDate, capHours: 140,
  }).filter(r => r.scored && r.projection);
  const leased = { ...st.fleet[0], ownershipType: 'lease', weeklyLease: 123_456 };
  const scoredLeased = scoreCandidates({ ...st, fleet: [leased] }, rows, {
    aircraftTypeId: laneJet.id, aircraft: leased, weeklyFrequency: 7,
    gameDate: st.gameDate, capHours: 140,
  }).filter(r => r.scored && r.projection);
  const a = scored.find(r => r.projection);
  const b = scoredLeased.find(r => r.code === a.code);
  assert.ok(b, 'same row missing from the leased run');
  assert.equal(a.projection.netProfit - b.projection.netProfit, 123_456,
    'the gap between owned and leased must be exactly the rate that tail signed at');
});

console.log('\n────────────────────────────────────────────────────────');
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
