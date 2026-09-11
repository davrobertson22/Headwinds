// Route Planner: aircraft recommendations.
//
//   ASAS  "or like aircraft recommendations to route planner too"  (9/11/26)
//
// The planner already chose a type for you, but it chose by AVAILABILITY — the
// first reachable type with a tail free to fly today — and never by economics.
// On a thin lane that is routinely the worst earner you own, and the only way to
// discover it was to reopen the dropdown and re-read the card for every entry.
//
// What this suite pins is not "there is a ranking". It is that the ranking
// cannot disagree with the card sitting next to it, because a second opinion on
// the same lane is worse than no opinion at all. Three ways it could:
//
//   1. a bare simulateRoute per candidate — the bug this codebase has shipped
//      three times. On a pair you already fly it hands each candidate the WHOLE
//      demand pool, so it ranks the biggest cabin top on a lane where your own
//      tails are already carrying the traffic.
//   2. a flat frequency for every candidate — one airframe has a fixed weekly
//      block-hour budget, so a slower type fits fewer rotations on a long sector.
//   3. the catalogue lease rate on a tail you own outright, or on a leased one
//      that signed at a different rate.
//
//   node --import ./tools/_register-loader.mjs tools/aircraft-recommender-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRPORTS, getAirport } from '../src/data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../src/data/aircraft.js';
import {
  referencePrice, distanceKm, defaultClassPrices, defaultConfig,
  baseCityPairDemand, maxFrequency, simulateRoute,
} from '../src/utils/simulation.js';
import { projectRouteAddition } from '../src/models/pairShare.js';
import {
  rankAircraftForRoute, tailsOfType, weeklyLeaseFor,
} from '../src/models/aircraftRecommender.js';

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

console.log('\nRoute Planner — "which of these should I put on this lane?"\n');

const HUB = 'JFK';
assert.ok(getAirport(HUB), 'fixture airport missing');

const gates = {};
for (const a of AIRPORTS) gates[a.code] = 20;

const mkAc = (id, typeId, extra = {}) => ({
  id, typeId, tailNumber: id.toUpperCase(), status: 'idle', ownershipType: 'owned',
  ageWeeks: 52, config: { economy: getAircraftType(typeId).seats }, ...extra,
});

function world({ fleet = [], routes = [], competitors = [] } = {}) {
  return {
    week: 60, absWeek: 60, hub: HUB, hubs: {}, cash: 5e8,
    fleet, routes, cargoRoutes: [], competitors, humanRivals: {}, encroachments: {},
    gates, routePricing: {}, gameDate: { week: 60, month: 6, absWeek: 60 },
  };
}

const kmTo   = (code) => Math.round(distanceKm(getAirport(HUB), getAirport(code)));
const fareTo = (code) => Math.round(referencePrice(HUB, code));
const typesFor = (code) => AIRCRAFT_TYPES.filter((t) => !t.freighter && t.range >= kmTo(code));

const rank = (state, code, opts = {}) => rankAircraftForRoute(state, {
  origin: HUB, destination: code, distKm: kmTo(code),
  types: typesFor(code), weeklyFrequency: 7,
  ticketPrice: fareTo(code), classPrices: defaultClassPrices(fareTo(code)),
  gameDate: state.gameDate, ...opts,
});

// A thin lane is where the feature earns its keep: on a fat one every cabin
// fills and "biggest wins" needs no help from a ranking.
const THIN = AIRPORTS
  .map((a) => ({ a, demand: baseCityPairDemand(HUB, a.code), km: kmTo(a.code) }))
  .filter((x) => x.a.code !== HUB && x.demand > 200 && x.demand < 1200 && x.km > 1200 && x.km < 5000)
  .sort((x, y) => x.demand - y.demand)[0];
assert.ok(THIN, 'fixture needs a thin market out of JFK');
const FAT = 'LAX';

// ── 1. The whole point: it is not "biggest cabin wins" ──────────────────────
console.log('── 1. A full small cabin beats an empty big one ──────────');

const thinRows = rank(world(), THIN.a.code);

test(`the best aircraft on a thin lane (${HUB}–${THIN.a.code}, ${THIN.demand}/wk) is not the biggest`, () => {
  const biggest = [...typesFor(THIN.a.code)].sort((x, y) => y.seats - x.seats)[0];
  assert.ok(thinRows.length > 1, 'nothing to rank');
  assert.notEqual(thinRows[0].typeId, biggest.id,
    'the ranking is just cabin size in disguise — it would tell a player nothing the dropdown does not');
  assert.ok(thinRows[0].seats < biggest.seats);
  // And it is a real gap, not a rounding tie.
  const worst = thinRows[thinRows.length - 1];
  assert.ok(thinRows[0].projection.netProfit > worst.projection.netProfit,
    'top and bottom of the ranking clear the same money');
});

test('every candidate handed in comes back — none silently dropped', () => {
  // A candidate missing from a ranked list reads as "not worth flying", which is
  // a verdict the recommender has not earned.
  const handed = typesFor(THIN.a.code);
  assert.equal(thinRows.length, handed.length,
    `${handed.length} types in, ${thinRows.length} out`);
  const ids = new Set(thinRows.map((r) => r.typeId));
  for (const t of handed) assert.ok(ids.has(t.id), `${t.name} vanished from the ranking`);
});

test('it is sorted by net profit, best first', () => {
  for (let i = 1; i < thinRows.length; i++) {
    const a = thinRows[i - 1].projection?.netProfit ?? -Infinity;
    const b = thinRows[i].projection?.netProfit ?? -Infinity;
    assert.ok(a >= b, `row ${i} (${thinRows[i].type.name}) out of order`);
  }
});

test('a type the lane is out of reach for is never offered', () => {
  const km   = kmTo(THIN.a.code);
  const rows = rankAircraftForRoute(world(), {
    origin: HUB, destination: THIN.a.code, distKm: km,
    types: AIRCRAFT_TYPES.filter((t) => !t.freighter),   // the WHOLE catalogue
    weeklyFrequency: 7, ticketPrice: fareTo(THIN.a.code),
    classPrices: defaultClassPrices(fareTo(THIN.a.code)),
    gameDate: world().gameDate,
  });
  for (const r of rows) {
    assert.ok(r.type.range >= km,
      `${r.type.name} reaches ${r.type.range} km and was offered a ${km} km lane`);
  }
});

// ── 2. It cannot disagree with the card beside it ───────────────────────────
console.log('\n── 2. The ranking and the planner card are one forecast ──');

test('a row\'s net profit is the planner card\'s own arithmetic, to the dollar', () => {
  // The card builds it as revenue + connecting − (opCost + landing fee) − lease.
  // The recommender builds it as profitAfterLandingFees + connecting − lease.
  // Two different paths to one number: if they ever part, one screen is lying.
  const st  = world();
  const row = thinRows.find((r) => r.projection);
  const type = row.type;
  const p = projectRouteAddition(st, {
    origin: HUB, destination: THIN.a.code,
    aircraft: { id: 'p', typeId: type.id, ageWeeks: 0, rangeMod: 1.0, config: defaultConfig(type.seats) },
    weeklyFrequency: row.weeklyFrequency,
    ticketPrice: fareTo(THIN.a.code),
    classPrices: defaultClassPrices(fareTo(THIN.a.code)),
    gameDate: st.gameDate,
  });
  const m = p.mature;
  const connecting = p.connecting ?? { totalRevenue: 0 };
  const cardWay = (m.revenue + connecting.totalRevenue)
    - (m.totalOpCost + (m.landingFee ?? 0))
    - row.weeklyLease;
  assert.equal(Math.round(cardWay), row.projection.netProfit,
    `card ${Math.round(cardWay)} vs ranking ${row.projection.netProfit} for ${type.name}`);
});

test('on a pair you already fly, the ranking pools rather than re-selling the whole market', () => {
  // The bug this codebase has shipped three times. A bare simulateRoute asks
  // "what would this aircraft carry ALONE in this market?" — on a pair your own
  // tails are already working, that is the whole pool, twice sold.
  const bigType = [...typesFor(FAT)].sort((x, y) => y.seats - x.seats)[0];
  const incumbent = mkAc('ac_inc', bigType.id);
  const st = world({
    fleet: [incumbent, mkAc('ac_new', bigType.id)],
    routes: [{
      id: 'r1', origin: HUB, destination: FAT, aircraftId: 'ac_inc', weeklyFrequency: 14,
      weeksOpen: 60, hub: HUB, ticketPrice: fareTo(FAT),
      classPrices: { economy: fareTo(FAT) },
    }],
  });
  const rows = rank(st, FAT);
  const row  = rows.find((r) => r.typeId === bigType.id);
  assert.ok(row?.projection, 'the incumbent type is not in the ranking at all');

  // The old way, reproduced: this aircraft alone against the market.
  const bare = simulateRoute(
    { id: 'x', origin: HUB, destination: FAT, aircraftId: 'ac_new', weeklyFrequency: row.weeklyFrequency,
      ticketPrice: fareTo(FAT), classPrices: defaultClassPrices(fareTo(FAT)), hub: HUB },
    mkAc('ac_new', bigType.id), st.gameDate,
  );
  assert.ok(bare && bare.passengers > 0, 'bare simulateRoute fixture produced nothing');
  assert.ok(row.projection.passengers < bare.passengers,
    `pooled forecast (${row.projection.passengers}) is not below the bare one (${bare.passengers}) — `
    + 'the ranking is selling the same travellers twice');
});

// ── 3. Frequency is capped per type, and said out loud ──────────────────────
console.log('\n── 3. One airframe, one block-hour budget ────────────────');

test('a candidate that cannot fit the asked frequency is capped, not fantasised', () => {
  const code = FAT, km = kmTo(code);
  const rows = rank(world(), code, { weeklyFrequency: 14 });
  let capped = 0;
  for (const r of rows) {
    const cap = Math.max(1, maxFrequency(km, r.type));
    assert.ok(r.weeklyFrequency <= cap,
      `${r.type.name} ranked at ${r.weeklyFrequency}× on a lane it fits ${cap} rotations of`);
    assert.equal(r.weeklyFrequency, Math.min(14, cap));
    assert.equal(r.frequencyCapped, r.weeklyFrequency < 14);
    if (r.frequencyCapped) capped++;
  }
  assert.ok(capped > 0,
    `fixture is vacuous: nothing is capped at 14× on a ${km} km lane, so the flag is untested`);
});

// ── 4. The lease is the one that tail signed ────────────────────────────────
console.log('\n── 4. Lease: owned costs nothing, leased costs its own rate ─');

test('an owned tail carries no lease; the catalogue rate is only for a type you have none of', () => {
  const t = typesFor(FAT).find((x) => (x.weeklyLease ?? 0) > 0);
  assert.ok(t, 'fixture needs a type with a catalogue lease rate');
  assert.equal(weeklyLeaseFor(mkAc('o', t.id), t), 0, 'an owned tail was charged a lease');
  assert.equal(weeklyLeaseFor(null, t), t.weeklyLease, 'a type you own none of must quote list');
  assert.equal(
    weeklyLeaseFor({ ...mkAc('l', t.id), ownershipType: 'lease', weeklyLease: 123_456 }, t),
    123_456, 'a leased tail must pay the rate IT signed, not the catalogue rate');
});

test('the ranking moves by exactly the rate a leased tail signed', () => {
  const t = typesFor(FAT).find((x) => (x.weeklyLease ?? 0) > 0);
  const owned  = world({ fleet: [mkAc('t1', t.id)] });
  const leased = world({ fleet: [{ ...mkAc('t1', t.id), ownershipType: 'lease', weeklyLease: 123_456 }] });
  const a = rank(owned,  FAT).find((r) => r.typeId === t.id);
  const b = rank(leased, FAT).find((r) => r.typeId === t.id);
  assert.ok(a?.projection && b?.projection, 'the type dropped out of one of the two runs');
  assert.equal(a.projection.netProfit - b.projection.netProfit, 123_456);
});

test('the tail quoted is the one Open Route would actually assign', () => {
  // Free idle first, reserves last — the planner's own fleetOfType order.
  const t = typesFor(FAT)[0];
  const fleet = [
    { ...mkAc('res', t.id), reserveBase: HUB },
    { ...mkAc('busy', t.id), status: 'assigned' },
    mkAc('free', t.id),
  ];
  assert.equal(tailsOfType(fleet, t.id)[0].id, 'free', 'a reserve or a busy tail won the pick');
  const row = rank(world({ fleet }), FAT).find((r) => r.typeId === t.id);
  assert.equal(row.tail?.id, 'free');
  assert.equal(row.owned, true);
});

test('availability is reported but never re-orders the ranking', () => {
  // A plane you can fly today is the decision; what it earns is the ranking.
  // Folding one into the other would quietly recommend a worse aircraft.
  const plain = rank(world(), THIN.a.code);
  const withAvail = rank(world(), THIN.a.code, {
    availabilityFor: (id) => (id === plain[plain.length - 1].typeId ? { ready: 9, onReserve: 3 } : { ready: 0, onReserve: 0 }),
  });
  assert.deepEqual(withAvail.map((r) => r.typeId), plain.map((r) => r.typeId),
    'reporting how many are ready changed the order');
  assert.equal(withAvail[withAvail.length - 1].ready, 9);
  assert.equal(withAvail[withAvail.length - 1].onReserve, 3);
});

// ── 5. The panel the player sees ────────────────────────────────────────────
console.log('\n── 5. The recommendation on the planner screen ───────────');

// RoutePlanner takes no props — origin, destination and type are local useState,
// and renderToString runs no effects and fires no onChange. So seed the initial
// values of its leading state block by wrapping React's hook dispatcher, exactly
// as tools/route-planner-render-test.mjs does. The component under test stays the
// real, unmodified module.
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
const RoutePlanner = (await import('../src/components/RoutePlanner.jsx')).default;

const dist = kmTo(FAT);
// Own a type that is NOT the best earner on this lane, so the panel has
// something to tell the player. A fixture where the owned plane already wins
// would pass whether or not the ranking works.
const ownedType = AIRCRAFT_TYPES
  .filter((t) => !t.freighter && t.range >= dist && t.seats >= 60 && t.seats <= 160)
  .sort((x, y) => x.seats - y.seats)[0];
assert.ok(ownedType, 'fixture needs a modest owned type able to reach JFK–LAX');

const SAVE = {
  ...freshState(),
  phase: 'playing', week: 20, year: 1, hub: HUB, cash: 500_000_000,
  hubs: { [HUB]: { tier: 2, tierSince: 1 } },
  gates: { [HUB]: 10, [FAT]: 10 },
  fleet: [{
    id: 'ac_free', tailNumber: 'N3FREE', name: 'Tail N3FREE', typeId: ownedType.id,
    status: 'idle', ageWeeks: 52, ownershipType: 'owned', config: { economy: ownedType.seats },
  }],
  routes: [], cargoRoutes: [],
};

function renderPlanner() {
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  const slots = [null, { value: HUB }, { value: FAT }, { value: ownedType.id }];
  return renderToString(
    React.createElement(GameProvider, null,
      React.createElement(Seed, { slots }, React.createElement(RoutePlanner))),
  ).replace(/<!-- -->/g, '');
}

let html;
test('the harness is seeding the slots it thinks it is', () => {
  html = renderPlanner();
  assert.ok(lastSeed, 'seed wrapper never ran');
  assert.deepEqual(lastSeed.seen.slice(0, SLOT_NAMES.length), EXPECTED_INITIALS,
    `RoutePlanner's leading useState block changed — expected [${SLOT_NAMES}] to start as `
    + `${JSON.stringify(EXPECTED_INITIALS)} but saw ${JSON.stringify(lastSeed.seen.slice(0, 4))}`);
});

test('the planner renders a recommendation panel', () => {
  assert.match(html, /Best aircraft for this route/i, 'no recommendation panel on the planner');
});

test('it names real aircraft, ranked', () => {
  const rows = rank(
    { ...SAVE, gameDate: { week: 20, month: 5, absWeek: 20 } },
    FAT,
  );
  assert.ok(rows.length > 1, 'nothing to rank in the fixture');
  assert.ok(html.includes(rows[0].type.name) || html.includes(rows[1].type.name),
    'the panel rendered without any of the top-ranked aircraft in it');
});

test('it says which of the recommendations you could fly today', () => {
  assert.ok(/ready|lease required|on reserve|none free/.test(html),
    'the panel ranks planes without saying which you can actually deploy');
});

test('it offers a way to move the forecast onto a recommendation', () => {
  assert.ok(html.includes('Use') || html.includes('shown below'),
    'the ranking is read-only — there is no way to act on it');
});

// A ranking of losses is still a ranking, and the top of it is not a
// recommendation. The fixture lane above is a fat one, so render a thin one too.
test('when nothing on the lane pays, the panel says so before the table', () => {
  const thinSave = { ...SAVE, gates: { [HUB]: 10, [THIN.a.code]: 10 } };
  store.set('bbae_save_v2', JSON.stringify(thinSave));
  const slots = [null, { value: HUB }, { value: THIN.a.code }, { value: ownedType.id }];
  const thinHtml = renderToString(
    React.createElement(GameProvider, null,
      React.createElement(Seed, { slots }, React.createElement(RoutePlanner))),
  ).replace(/<!-- -->/g, '');

  const rows = rank({ ...thinSave, gameDate: { week: 20, month: 5, absWeek: 20 } }, THIN.a.code);
  const best = rows.find((r) => r.projection);
  assert.ok(best && best.projection.netProfit < 0,
    `fixture is vacuous: ${HUB}–${THIN.a.code} is profitable, so the warning branch is untested`);
  assert.match(thinHtml, /clears a profit/,
    'every aircraft on this lane loses money and the panel still presents a "best"');
  assert.match(thinHtml, /least-bad, not good/,
    'the ranking is not qualified — the top row reads as a recommendation');
});

test('the panel never hides candidates without saying so', () => {
  assert.match(html, /Show all \d+ aircraft that can fly this/,
    'the shortlist is capped with no way to see the rest');
});

console.log('\n────────────────────────────────────────────────────────');
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
