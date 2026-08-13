// ─────────────────────────────────────────────────────────────────────────────
// PREVIEW HONESTY — every number a screen shows BEFORE the tick runs has to be
// the number the tick will actually book.
//
// Six independent divergences, each measured against the real engine:
//
//   1. RouteDetail's and RoutePlanner's market-share panels omitted
//      `brandReach`. computeUtility reads `offer.brandReach ?? 1`, i.e. an offer
//      that leaves it off is scored as an ESTABLISHED carrier at parity. A
//      week-one airline (real reach ≈ 0.45) was shown the market share of a
//      household name on the very screen built to explain market share — 52.3%
//      quoted against 40.3% delivered. RouteDetail's pooled `combinedOffer`
//      additionally carried a vestigial `qualityScore: <cond> ? 70 : 70`, so a
//      pair flown by two tails was scored at a flat 70 no matter what the
//      engine's own routeQualityBreakdown said.
//
//   2. projectRouteAddition defaulted `eventDemandMult` to 1.0 and
//      pairMarketShare passed only `state.worldDemandMult` — while weeklyTick
//      uses eventDemandMultFor0(a,b) * state.worldDemandMult for BOTH the
//      market pool and simulateRoute. A world-event shock never reached a
//      launch forecast at all, and in a doubled world a solo route previewed at
//      half the traffic the following week booked.
//
//   3. projectWeek's lease-redelivery charge used the aircraft TYPE's list rate
//      while the reducer bills `a.weeklyLease ?? type.weeklyLease` — the rate
//      the tail actually signed at (term multipliers 1.15/1.00/0.90/0.83 stamp
//      at signing, so almost every lease differs).
//
//   4. The Dashboard's network Load Factor summed tag-route passengers into the
//      numerator against a zero denominator (tag rows carry no
//      configuredSeatsOneWay), and summed tag `distance` — total ground covered
//      by the whole rotation — into RPK. Measured 293.5% on a real save.
//
//   5. RouteDetail built its market with a hardcoded maturity of 1 while the
//      tick applies routeMaturityFactor(weeksOpen) — 0.55 in week 0, 1.0 at 16.
//      The derived "unmet demand" then invented phantom unserved passengers on
//      young routes, which is exactly the signal that tells a player to add
//      frequency.
//
//   6. Marketplace's "weeks of cash" divided cash by lease rent alone, ignoring
//      fuel, crew, maintenance, overhead, loans and every other weekly outflow
//      the Dashboard's identical-looking runway figure does include.
//
//   node --import ./tools/_register-loader.mjs tools/preview-honesty-test.mjs
// ─────────────────────────────────────────────────────────────────────────────

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

// freshState() samples its competitor bank with Math.random; pin it so the
// fixtures below are the same world on every run.
Math.random = () => 0.5;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const { AIRCRAFT_TYPES, getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { getAirport } = await import('../packages/engine/src/data/airports.js');
const {
  weeklyTick, referencePrice, stateBrandReach,
  buildEventDemandModel, weekToGameDate, formatMoney, CLASS_FARE_MULTIPLIERS,
} = await import('../packages/engine/src/utils/simulation.js');
const { buildRouteMarket, computeMarketShare, routeMaturityFactor } =
  await import('../packages/engine/src/models/demand.js');
const { projectRouteAddition, pairMarketShare } =
  await import('../packages/engine/src/models/pairShare.js');
const { projectWeek } = await import('../packages/engine/src/utils/financeProjection.js');

const jet = AIRCRAFT_TYPES
  .filter(t => !t.freighter && t.seats >= 150 && t.seats <= 240)
  .sort((a, b) => b.range - a.range)[0];
assert.ok(jet, 'fixture needs a narrowbody');

const O = 'SFO', D = 'ATL';
const FARE = Math.round(referencePrice(O, D));
const KEY  = [O, D].sort().join('-');
// SFO–ATL swallows 10 narrowbody frequencies whole: at that size the route is
// capacity-capped, so demand-side effects (maturity, events, the world
// multiplier) move the POOL without moving a single carried passenger — which
// makes it a useless probe for exactly the bugs below. Fly enough seats to
// outrun the pool.
const FREQ = 45;

const mkAircraft = (id, over = {}) => ({
  id, typeId: jet.id, name: id, tailNumber: `N${id}`,
  status: 'assigned', ownershipType: 'owned',
  ageWeeks: 40, config: { economy: jet.seats }, ...over,
});
const mkRoute = (id, aircraftId, over = {}) => ({
  id, origin: O, destination: D, stops: [O, D], aircraftId,
  weeklyFrequency: FREQ, weeksOpen: 40, hub: O,
  ticketPrice: FARE, classPrices: { economy: FARE }, ...over,
});

/** A world with `existing` tails already on O–D plus one spare to deploy. */
function fixture({ existing = 0, ...over } = {}) {
  const fleet = [], routes = [];
  for (let i = 0; i < existing; i++) {
    fleet.push(mkAircraft(`ac${i}`));
    routes.push(mkRoute(`r${i}`, `ac${i}`));
  }
  const spare = mkAircraft('spare');
  fleet.push(spare);
  return {
    state: {
      fleet, routes, cargoRoutes: [],
      gates: { [O]: 80, [D]: 80 }, hubs: {}, hub: O,
      competitors: [], humanRivals: {}, encroachments: {},
      routePricing: { [KEY]: { economy: FARE } },
      gameDate: { month: 6 }, absWeek: 40, week: 40, year: 1,
      ...over,
    },
    spare,
  };
}

/** What the tick ACTUALLY books for a newly-opened route on the pair. */
function actualAfterOpening(state, spare) {
  const opened = mkRoute('new', spare.id);
  const r = weeklyTick({ ...state, routes: [...state.routes, opened] });
  return r.routeResults.find(rr => rr.routeId === 'new');
}

const drift = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));

/** projection ↔ tick agreement on one fixture, as a percentage gap. */
function previewGap(state, spare, specOver = {}) {
  const proj = projectRouteAddition(state, {
    origin: O, destination: D, aircraft: spare, weeklyFrequency: FREQ,
    ticketPrice: FARE, classPrices: { economy: FARE }, ...specOver,
  });
  assert.ok(proj, 'projection produced');
  const actual = actualAfterOpening(state, spare);
  assert.ok(actual, 'tick booked the new route');
  return {
    gap: drift(proj.mature.passengers, actual.passengers),
    previewed: proj.mature.passengers,
    booked: actual.passengers,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 1. brandReach is a live term, not decoration ────────────────');

test('an offer that omits brandReach is scored as an established carrier', () => {
  const { state } = fixture({ awareness: 4, reputation: 28 });
  const reach = stateBrandReach(state, 0, false);
  assert.ok(reach < 0.95, `fixture must be a young brand, got reach ${reach.toFixed(3)}`);
  const market = buildRouteMarket(O, D, { month: 6 }, 1, 1);
  const base = {
    airlineId: 'player', origin: O, destination: D,
    economyPrice: FARE, businessPrice: null,
    weeklyFrequency: 10, seatsPerFlight: jet.seats,
    economySeats: jet.seats * 10, businessSeats: 0,
    totalSeats: jet.seats * 10, qualityScore: 70, connectivityBonus: 0,
  };
  const rival = { ...base, airlineId: 'rival' };
  const [without] = computeMarketShare(market, [base, rival]);
  const [withIt]  = computeMarketShare(market, [{ ...base, brandReach: reach }, rival]);
  assert.ok(withIt.leisureShare < without.leisureShare * 0.95,
    `brand-blind share ${(without.leisureShare * 100).toFixed(1)}% vs honest ` +
    `${(withIt.leisureShare * 100).toFixed(1)}% — fixture does not exercise brand`);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 2. Previews apply the world + event demand multipliers ──────');

const PANDEMIC = { id: 'ev-test', title: 'Test shock', effects: { globalDemandMult: 0.6 } };

test('an ordinary world (no events, no multiplier) is unchanged', () => {
  const { state, spare } = fixture();
  const r = previewGap(state, spare);
  assert.ok(r.gap <= 0.05, `previewed ${r.previewed} pax vs ${r.booked} booked`);
});

test('a doubled world previews the week the tick actually books', () => {
  const { state, spare } = fixture({ worldDemandMult: 2 });
  const r = previewGap(state, spare);
  assert.ok(r.gap <= 0.05,
    `previewed ${r.previewed} pax vs ${r.booked} booked (${(r.gap * 100).toFixed(1)}% off)`);
});

test('a doubled world previews a SHARED pair the way the tick books it', () => {
  const { state, spare } = fixture({ existing: 1, worldDemandMult: 2 });
  const r = previewGap(state, spare);
  assert.ok(r.gap <= 0.05,
    `previewed ${r.previewed} pax vs ${r.booked} booked (${(r.gap * 100).toFixed(1)}% off)`);
});

test('a doubled world moves the pair pool, not just the route', () => {
  const { state } = fixture({ existing: 1, worldDemandMult: 2 });
  const one = pairMarketShare({ ...state, worldDemandMult: 1 }, O, D);
  const two = pairMarketShare(state, O, D);
  const ratio = (two.market.leisureDemand + two.market.businessDemand)
    / (one.market.leisureDemand + one.market.businessDemand);
  assert.ok(Math.abs(ratio - 2) < 0.02, `pool ratio ${ratio.toFixed(3)}, expected 2`);
});

test('an active demand event reaches the preview with no caller opting in', () => {
  const { state, spare } = fixture({ activeEvents: [PANDEMIC] });
  const r = previewGap(state, spare);
  assert.ok(r.gap <= 0.05,
    `previewed ${r.previewed} pax vs ${r.booked} booked (${(r.gap * 100).toFixed(1)}% off)`);
});

test('the event multiplier reaches the pair POOL, not only simulateRoute', () => {
  const { state } = fixture({ existing: 1, activeEvents: [PANDEMIC] });
  const plain = pairMarketShare({ ...state, activeEvents: [] }, O, D);
  const shock = pairMarketShare(state, O, D);
  const ratio = (shock.market.leisureDemand + shock.market.businessDemand)
    / (plain.market.leisureDemand + plain.market.businessDemand);
  assert.ok(Math.abs(ratio - 0.6) < 0.02, `pool ratio ${ratio.toFixed(3)}, expected 0.60`);
});

test('events and the world multiplier compose, and neither is applied twice', () => {
  const { state, spare } = fixture({ activeEvents: [PANDEMIC], worldDemandMult: 2 });
  const r = previewGap(state, spare);
  assert.ok(r.gap <= 0.05,
    `previewed ${r.previewed} pax vs ${r.booked} booked (${(r.gap * 100).toFixed(1)}% off)`);
});

// RoutePlanner.jsx and Routes.jsx pass `eventDemandMult: eventDemand.multFor(o,d)`
// — the EVENT multiplier ONLY. Neither file may need editing, so the parameter
// keeps that meaning and the world multiplier is composed on top inside.
test('a caller passing the event-only multiplier by hand still agrees', () => {
  const { state, spare } = fixture({ activeEvents: [PANDEMIC], worldDemandMult: 2 });
  const ev = buildEventDemandModel(state.activeEvents).multFor(O, D);
  const r = previewGap(state, spare, { eventDemandMult: ev });
  assert.ok(r.gap <= 0.05,
    `previewed ${r.previewed} pax vs ${r.booked} booked (${(r.gap * 100).toFixed(1)}% off)`);
});

test('a caller passing the event mult on a SHARED pair still agrees', () => {
  const { state, spare } = fixture({ existing: 1, activeEvents: [PANDEMIC], worldDemandMult: 2 });
  const ev = buildEventDemandModel(state.activeEvents).multFor(O, D);
  const r = previewGap(state, spare, { eventDemandMult: ev });
  assert.ok(r.gap <= 0.05,
    `previewed ${r.previewed} pax vs ${r.booked} booked (${(r.gap * 100).toFixed(1)}% off)`);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 3. Projected lease redelivery bills the SIGNED rate ─────────');

/** A world whose only tail is a lease in its FINAL week, signed off-list. */
function leaseFixture(signedRate) {
  const ac = mkAircraft('leased', {
    ownershipType: 'lease', leaseRemainingWeeks: 1,
    ...(signedRate != null ? { weeklyLease: signedRate } : {}),
  });
  return {
    fleet: [ac], routes: [mkRoute('r0', 'leased')], cargoRoutes: [],
    gates: { [O]: 80, [D]: 80 }, hubs: {}, hub: O,
    competitors: [], humanRivals: {}, encroachments: {},
    routePricing: { [KEY]: { economy: FARE } },
    cash: 50_000_000, loans: [], week: 40, year: 1,
    gameDate: { month: 6 }, absWeek: 40,
  };
}

test('the projection quotes the rate on the lease, not the rate in the table', () => {
  const list   = getAircraftType(jet.id).weeklyLease;
  const signed = Math.round(list * 0.83);     // a long-term discount
  assert.notEqual(signed, list, 'fixture needs an off-list signed rate');
  const proj = projectWeek(leaseFixture(signed));
  assert.equal(proj.leaseRedelivery, signed * 4,
    `projected $${proj.leaseRedelivery.toLocaleString()} redelivery on a lease ` +
    `signed at $${signed.toLocaleString()}/wk (list is $${list.toLocaleString()}/wk)`);
});

test('a lease signed ABOVE list is projected above list too', () => {
  const list   = getAircraftType(jet.id).weeklyLease;
  const signed = Math.round(list * 1.15);     // a short-term premium
  const proj = projectWeek(leaseFixture(signed));
  assert.equal(proj.leaseRedelivery, signed * 4,
    `projected $${proj.leaseRedelivery.toLocaleString()}, expected $${(signed * 4).toLocaleString()}`);
});

test('a legacy tail with no stamped rate still falls back to the list rate', () => {
  const list = getAircraftType(jet.id).weeklyLease;
  assert.equal(projectWeek(leaseFixture(null)).leaseRedelivery, list * 4);
});

// End-to-end: what the projection says the final week costs is what advancing
// that week actually charges.
test('projected redelivery equals what the week the tick runs actually books', () => {
  const list   = getAircraftType(jet.id).weeklyLease;
  const signed = Math.round(list * 0.83);
  const st     = leaseFixture(signed);
  const projected = projectWeek(st).leaseRedelivery;
  const rate = st.fleet[0].weeklyLease ?? getAircraftType(st.fleet[0].typeId).weeklyLease;
  const booked = rate * 4;                    // the reducer's leaseRedeliveryCost
  assert.equal(projected, booked,
    `projected $${projected.toLocaleString()} vs booked $${booked.toLocaleString()}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SSR: the remaining claims are about RENDERED screens. A helper can be right
// while the component that calls it is not.
// ─────────────────────────────────────────────────────────────────────────────

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const RouteDetail  = (await import('../src/components/RouteDetail.jsx')).default;
const RoutePlanner = (await import('../src/components/RoutePlanner.jsx')).default;
const Dashboard    = (await import('../src/components/Dashboard.jsx')).default;
const Marketplace  = (await import('../src/components/Marketplace.jsx')).default;

// ── Hook seeding (RoutePlanner takes no props) ───────────────────────────────
const RCD = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
assert.ok(RCD, 'React 18 hook dispatcher not reachable — this harness needs updating');
let hookSeed = null, lastSeed = null;
let rawDispatcher = RCD.current, liveDispatcher = null;
function wrapDispatcher(d) {
  if (!d) return d;
  const w = Object.create(Object.getPrototypeOf(d));
  Object.assign(w, d);
  w.useState = function (initial) {
    if (hookSeed) {
      const i = hookSeed.i++;
      if (i < hookSeed.slots.length) {
        hookSeed.seen[i] = typeof initial === 'function' ? initial() : initial;
        const slot = hookSeed.slots[i];
        if (slot) return d.useState(slot.value);
      }
      if (hookSeed.i >= hookSeed.slots.length) hookSeed = null;
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
function Seed({ slots, children }) { hookSeed = { i: 0, slots, seen: [] }; lastSeed = hookSeed; return children; }

const SLOT_NAMES = ['mode', 'origin', 'dest', 'selectedTypeId', 'frequency'];
const EXPECTED_INITIALS = ['passenger', '', '', '', 7];

const seedSave = (save) => store.set('bbae_save_v2', JSON.stringify(save));
const render = (el) => renderToString(React.createElement(GameProvider, null, el))
  .replace(/<!-- -->/g, '');

function renderPlanner(save, { origin, dest, typeId, frequency }) {
  seedSave(save);
  const slots = [null, { value: origin }, { value: dest }, { value: typeId }, { value: frequency }];
  return renderToString(
    React.createElement(GameProvider, null,
      React.createElement(Seed, { slots },
        React.createElement(RoutePlanner)))).replace(/<!-- -->/g, '');
}

/** Pull a numeric value out of a KpiBox / Stat by its label. */
function labelledValue(html, label) {
  const i = html.indexOf(label);
  if (i < 0) return null;
  const m = html.slice(i, i + 900).match(/>([\d,]+(?:\.\d+)?)\s*%?</);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// ── The fixture save ─────────────────────────────────────────────────────────
// A young airline (so brand reach bites), one flat route contested by an AI
// carrier, and one TAG route (so the Dashboard load factor has something to
// trip over).
const T1 = 'JFK', T2 = 'ORD', T3 = 'LAX';
for (const c of [T1, T2, T3]) assert.ok(getAirport(c), `${c} missing from the airport data`);
const T12KEY   = [T1, T2].sort().join('-');
const flatFare = Math.round(referencePrice(T1, T2));

const RIVAL = {
  id: 'ai-rival', name: 'Rival Air', tier: 'legacy', homeHub: T2,
  baseQualityScore: 62, cash: 9_000_000, weeklyStats: null,
  routes: { [T12KEY]: { frequency: 14, seats: 180, priceMultiplier: 1.0, aircraftType: jet.id } },
};

const baseSave = (over = {}) => ({
  ...freshState(),
  phase: 'playing', week: 3, year: 1, hub: T1, cash: 12_000_000,
  awareness: 4, reputation: 28, airlineName: 'Testways',
  gates: { [T1]: 40, [T2]: 40, [T3]: 40 },
  competitors: [RIVAL], humanRivals: {}, encroachments: {},
  fleet: [mkAircraft('flat', { name: 'Flat One' }), mkAircraft('tagac', { name: 'Tag One' })],
  routes: [
    { id: 'flat', origin: T1, destination: T2, stops: [T1, T2], aircraftId: 'flat',
      weeklyFrequency: 30, weeksOpen: 2, hub: T1,
      ticketPrice: flatFare, classPrices: { economy: flatFare }, cateringLevel: 'basic' },
    { id: 'tag', origin: T1, destination: T3, stops: [T1, T2, T3], aircraftId: 'tagac',
      weeklyFrequency: 5, weeksOpen: 2, hub: T1, cateringLevel: 'basic' },
  ],
  routePricing: { [T12KEY]: { economy: flatFare } },
  ...over,
});

/** RouteDetail's own gameDate, mirrored so expectations use the same week. */
const rdGameDate = (week) => ({ week, month: weekToGameDate(week).monthIndex });

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 1b. The rendered share panels use the real brand ────────────');

/** The pax figure RouteDetail prints for the player in its share legend. */
function renderedPlayerPax(st) {
  seedSave(st);
  const html = render(React.createElement(RouteDetail,
    { origin: T1, dest: T2, onBack: () => {} }));
  const i = html.indexOf('Testways');
  assert.ok(i > 0, 'the player row rendered in the share legend');
  const m = html.slice(i, i + 400).match(/>([\d,]+) · (\d+)%</);
  assert.ok(m, 'player pax/share rendered');
  return { pax: Number(m[1].replace(/,/g, '')), pct: Number(m[2]) };
}

test('RouteDetail\'s share panel carries the player the engine carries', () => {
  const st = baseSave();
  const shown = renderedPlayerPax(st).pax;
  const engine = pairMarketShare(st, T1, T2,
    { gameDate: rdGameDate(st.week) }).playerResult.totalPax;
  assert.ok(drift(shown, engine) <= 0.03,
    `RouteDetail puts the player on ${shown.toLocaleString()} pax/wk of this pair; ` +
    `the engine's own pairMarketShare says ${Math.round(engine).toLocaleString()}`);
});

test('RouteDetail\'s share panel is sensitive to the airline\'s brand at all', () => {
  const weak = renderedPlayerPax(baseSave({ awareness: 2, reputation: 20 })).pax;
  const strong = renderedPlayerPax(baseSave({ awareness: 95, reputation: 95 })).pax;
  assert.ok(strong > weak * 1.05,
    `an unknown carrier and a household name are shown the same ${weak} pax/wk — ` +
    'the panel is scoring both at established-carrier parity');
});

test('RoutePlanner\'s Est. Market Share is sensitive to the airline\'s brand', () => {
  const key = [T1, T3].sort().join('-');
  const planned = (over) => {
    const st = baseSave(over);
    st.competitors = [{ ...RIVAL, routes: { ...RIVAL.routes,
      [key]: { frequency: 14, seats: 180, priceMultiplier: 1.0, aircraftType: jet.id } } }];
    const html = renderPlanner(st, { origin: T1, dest: T3, typeId: jet.id, frequency: 40 });
    assert.ok(lastSeed, 'seed wrapper never ran');
    assert.deepEqual(lastSeed.seen.slice(0, SLOT_NAMES.length), EXPECTED_INITIALS,
      `RoutePlanner's leading useState block changed — expected [${SLOT_NAMES}]`);
    assert.ok(html.includes('Est. Market Share'), 'share panel rendered');
    const i = html.indexOf('Est. Market Share');
    const m = html.slice(i, i + 600).match(/>You<\/span><span[^>]*>(\d+)%</);
    assert.ok(m, 'player share rendered');
    return Number(m[1]);
  };
  const weak = planned({ awareness: 2, reputation: 20 });
  const strong = planned({ awareness: 95, reputation: 95 });
  assert.ok(strong > weak,
    `the planner quotes an unknown carrier and a household name the same ${weak}% ` +
    'of this pair — the offer omits brandReach, so both are scored at parity');
});

/** A save whose T1–T2 pair is flown by TWO tails (the combinedOffer path). */
function twoTailSave(over = {}) {
  const st = baseSave(over);
  st.fleet = [...st.fleet, mkAircraft('flat2', { name: 'Flat Two', ageWeeks: 5 })];
  st.routes = [...st.routes, { id: 'flat2', origin: T1, destination: T2, stops: [T1, T2],
    aircraftId: 'flat2', weeklyFrequency: 8, weeksOpen: 2, hub: T1,
    ticketPrice: flatFare, classPrices: { economy: flatFare }, cateringLevel: 'basic' }];
  return st;
}

test('the pooled two-tail offer is scored at its real quality, not a flat 70', () => {
  const st = twoTailSave();
  seedSave(st);
  const html = render(React.createElement(RouteDetail,
    { origin: T1, dest: T2, onBack: () => {} }));
  const qm = html.match(/Quality score breakdown<\/span><span[^>]*>(\d+) \/ 100</);
  assert.ok(qm, 'quality breakdown rendered');
  const q = Number(qm[1]);
  assert.notEqual(q, 70,
    'fixture must not happen to score exactly 70 — pick another aircraft/catering');
  const i = html.indexOf('Testways');
  const m = html.slice(i, i + 400).match(/>([\d,]+) · (\d+)%</);
  assert.ok(m, 'player row rendered');
  const shown = Number(m[1].replace(/,/g, ''));
  const engine = pairMarketShare(st, T1, T2,
    { gameDate: rdGameDate(st.week) }).playerResult.totalPax;
  assert.ok(drift(shown, engine) <= 0.03,
    `two-tail pair (engine quality ${q}) renders ${shown.toLocaleString()} pax/wk ` +
    `where the engine says ${Math.round(engine).toLocaleString()}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TW ONLY — the pooled allocation was written under aircraft.id and read under
// route.id, so it never applied.
console.log('\n── 6. The pooled allocation actually reaches the aircraft ──────');

/** A two-tail pair with real BUSINESS cabins and no explicit J fare set, so the
 *  pooled fallback has to invent one. That fallback is where the phantom 3.5x
 *  multiplier lived. */
function twoTailBizSave(over = {}) {
  const cfg = { economy: jet.seats - 20, businessClass: 10 };
  const st = baseSave(over);
  st.fleet = [
    mkAircraft('flat',  { name: 'Flat One', config: cfg }),
    mkAircraft('tagac', { name: 'Tag One' }),
    mkAircraft('flat2', { name: 'Flat Two', config: cfg, ageWeeks: 5 }),
  ];
  st.routes = [
    { id: 'flat', origin: T1, destination: T2, stops: [T1, T2], aircraftId: 'flat',
      weeklyFrequency: 30, weeksOpen: 2, hub: T1,
      ticketPrice: flatFare, classPrices: { economy: flatFare }, cateringLevel: 'basic' },
    { id: 'flat2', origin: T1, destination: T2, stops: [T1, T2], aircraftId: 'flat2',
      weeklyFrequency: 8, weeksOpen: 2, hub: T1,
      ticketPrice: flatFare, classPrices: { economy: flatFare }, cateringLevel: 'basic' },
    st.routes.find(r => r.id === 'tag'),
  ];
  return st;
}

test('the "Weekly Pax" total is one pooled market, not the pool once per tail', () => {
  const st = twoTailBizSave();
  seedSave(st);
  const html = render(React.createElement(RouteDetail,
    { origin: T1, dest: T2, onBack: () => {} }));
  const shownPax = labelledValue(html, 'Weekly Pax');
  assert.ok(shownPax != null, 'the Weekly Pax stat rendered');
  const engine = pairMarketShare(st, T1, T2,
    { gameDate: rdGameDate(st.week) }).playerResult.totalPax;
  assert.ok(shownPax <= engine * 1.10,
    `RouteDetail totals ${shownPax.toLocaleString()} pax/wk across two tails on a ` +
    `pair the engine gives ${Math.round(engine).toLocaleString()} — each tail was ` +
    'handed the whole pool because the allocation must be keyed and read by the same id');
});

test('the pooled fallback prices business at the engine ladder, not a phantom 3.5x', () => {
  assert.equal(CLASS_FARE_MULTIPLIERS.businessClass, 2.5,
    'the engine J-fare ladder moved — this assertion pins the figure the UI must reuse');
  const st = twoTailBizSave();
  const shown = renderedPlayerPax(st).pax;
  const engine = pairMarketShare(st, T1, T2,
    { gameDate: rdGameDate(st.week) }).playerResult.totalPax;
  assert.ok(drift(shown, engine) <= 0.03,
    `a J-cabin pair with no fare set renders ${shown.toLocaleString()} pax/wk where ` +
    `the engine — pricing business at ${CLASS_FARE_MULTIPLIERS.businessClass}x economy — ` +
    `says ${Math.round(engine).toLocaleString()}`);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 4. Dashboard network load factor excludes tag routes ────────');

test('the fixture really does put a tag route in the projection', () => {
  const rrs = projectWeek(baseSave()).report?.routeResults ?? [];
  const tag  = rrs.find(r => r.routeId === 'tag');
  const flat = rrs.find(r => r.routeId === 'flat');
  assert.ok(tag,  'tag route reached routeResults');
  assert.ok(flat, 'flat route reached routeResults');
  assert.equal(tag.configuredSeatsOneWay, undefined,
    'tag rows carry no configuredSeatsOneWay — that is the whole bug');
  assert.ok((tag.passengers ?? 0) > 0, 'the tag route carries passengers');
});

// A small, capacity-capped flat route next to the same tag rotation: the flat
// route alone is at 100%, so every tag passenger lands on top of a denominator
// that already cannot grow. This is the 293.5% screenshot in miniature.
function lfSave() {
  const st = baseSave();
  st.routes = st.routes.map(r => r.id === 'flat' ? { ...r, weeklyFrequency: 8 } : r);
  return st;
}

test('the rendered Load Factor is a load factor (≤ 100%)', () => {
  seedSave(lfSave());
  const html = render(React.createElement(Dashboard));
  const lf = labelledValue(html, 'Load Factor');
  assert.ok(lf != null, 'Load Factor tile rendered');
  assert.ok(lf <= 100, `Dashboard shows ${lf}% network load factor`);
});

test('a capacity-capped network reads 100%, not several hundred', () => {
  const st = lfSave();
  const flat = (projectWeek(st).report?.routeResults ?? []).find(r => r.routeId === 'flat');
  const own = flat.passengers / flat.configuredSeatsOneWay;
  seedSave(st);
  const lf = labelledValue(render(React.createElement(Dashboard)), 'Load Factor') / 100;
  assert.ok(Math.abs(lf - own) < 0.01,
    `rendered ${(lf * 100).toFixed(1)}% vs the only measurable route's ${(own * 100).toFixed(1)}%`);
});

test('the network load factor equals the flat route\'s own load factor', () => {
  const st = baseSave();
  const flat = (projectWeek(st).report?.routeResults ?? []).find(r => r.routeId === 'flat');
  const own = flat.passengers / flat.configuredSeatsOneWay;
  seedSave(st);
  const html = render(React.createElement(Dashboard));
  const lf = labelledValue(html, 'Load Factor') / 100;
  assert.ok(Math.abs(lf - own) < 0.01,
    `rendered ${(lf * 100).toFixed(1)}% vs the only measurable route's ${(own * 100).toFixed(1)}%`);
});

test('the Yield tile excludes tag RPK (rotation ground distance is not pax-km)', () => {
  const st = baseSave();
  const flat = (projectWeek(st).report?.routeResults ?? []).find(r => r.routeId === 'flat');
  const ownYield = flat.revenue / (flat.passengers * 2 * flat.distance);
  seedSave(st);
  const html = render(React.createElement(Dashboard));
  const m = html.match(/Yield<\/div>[\s\S]{0,400}?>([\d.]+)¢\/pkm/);
  assert.ok(m, 'Yield tile rendered');
  const shown = Number(m[1]) / 100;
  assert.ok(Math.abs(shown - ownYield) / ownYield < 0.02,
    `rendered ${(shown * 100).toFixed(1)}¢/pkm vs the flat route's ${(ownYield * 100).toFixed(1)}¢/pkm`);
});

test('a network with only tag routes reports no load factor rather than a wrong one', () => {
  const st = baseSave();
  st.routes = st.routes.filter(r => r.id === 'tag');
  seedSave(st);
  const html = render(React.createElement(Dashboard));
  assert.ok(!/Load Factor<\/div><div[^>]*>\d/.test(html)
    || (labelledValue(html, 'Load Factor') ?? 0) <= 100,
    'a tag-only network must not print a load factor above 100%');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 5. RouteDetail Total Demand is THIS week\'s market ───────────');

test('Total Demand is scaled by the lane\'s maturity, not shown mature', () => {
  const st = baseSave();
  seedSave(st);
  const html = render(React.createElement(RouteDetail,
    { origin: T1, dest: T2, onBack: () => {} }));
  const shown = labelledValue(html, 'Total Demand');
  assert.ok(shown != null, 'Total Demand stat rendered');
  const gd = rdGameDate(st.week);
  const ev = buildEventDemandModel(st.activeEvents).multFor(T1, T2);
  const mature = buildRouteMarket(T1, T2, gd, 1, ev);
  const real   = buildRouteMarket(T1, T2, gd, routeMaturityFactor(2), ev);
  const expect = real.leisureDemand + real.businessDemand;
  const matureTotal = mature.leisureDemand + mature.businessDemand;
  assert.ok(Math.abs(shown - expect) / expect < 0.02,
    `showed ${shown} pax/wk on a 2-week-old lane; this week's market is ` +
    `${Math.round(expect)} (the mature market is ${Math.round(matureTotal)})`);
});

test('a young lane does not invent unserved passengers', () => {
  const st = baseSave();
  seedSave(st);
  const html = render(React.createElement(RouteDetail,
    { origin: T1, dest: T2, onBack: () => {} }));
  const i = html.indexOf('Unmet demand');
  const unmet = i < 0 ? 0
    : Number((html.slice(i, i + 400).match(/>([\d,]+) · \d+%</) ?? [0, '0'])[1].replace(/,/g, ''));
  const gd = rdGameDate(st.week);
  const ev = buildEventDemandModel(st.activeEvents).multFor(T1, T2);
  const real = buildRouteMarket(T1, T2, gd, routeMaturityFactor(2), ev);
  const pool = real.leisureDemand + real.businessDemand;
  const served = pairMarketShare(st, T1, T2, { gameDate: gd }).totalPax;
  const honest = Math.max(0, pool - served);
  assert.ok(Math.abs(unmet - honest) <= Math.max(50, honest * 0.05),
    `RouteDetail claims ${unmet.toLocaleString()} pax/wk unserved; this week's ` +
    `whole pool is ${Math.round(pool).toLocaleString()} and ` +
    `${Math.round(served).toLocaleString()} of them flew (honest gap ${honest.toLocaleString()})`);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 7. Marketplace runway is the whole burn, not the rent ───────');

// Enough cash that an honest runway is a real number rather than a floored 0.
const runwaySave = () => baseSave({ cash: 400_000_000 });

test('weeks of cash reflects the whole weekly burn, not just lease rent', () => {
  const st = runwaySave();
  seedSave(st);
  const proj = projectWeek(st);
  assert.ok(proj.netCash < 0, `fixture must be burning cash, netCash=${proj.netCash}`);
  const html = render(React.createElement(Marketplace));
  const runways = [...html.matchAll(/(\d+) wks runway/g)].map(x => Number(x[1]));
  assert.ok(runways.length > 0, 'runway figures rendered');
  const best = Math.max(...runways);
  const ceiling = Math.floor(st.cash / -proj.netCash);
  assert.ok(best <= ceiling,
    `Marketplace advertises up to ${best} weeks of runway; the projection says ` +
    `${ceiling} weeks before a single new lease is signed`);
});

test('the runway shrinks by the right amount when a lease is added', () => {
  const st = runwaySave();
  seedSave(st);
  const proj = projectWeek(st);
  const html = render(React.createElement(Marketplace));
  // Take the cheapest type on offer and check its card against the arithmetic
  // Dashboard uses: cash ÷ (this week's net burn + this lease's rent).
  const cheapest = AIRCRAFT_TYPES.reduce((m, t) =>
    (t.weeklyLease > 0 && (!m || t.weeklyLease < m.weeklyLease)) ? t : m, null);
  const i = html.indexOf(cheapest.name);
  assert.ok(i > 0, `${cheapest.name} card rendered`);
  const m = html.slice(i, i + 4000).match(/(\d+) wks runway/);
  assert.ok(m, 'runway figure on that card');
  const expect = Math.floor(st.cash / (-proj.netCash + cheapest.weeklyLease));
  assert.ok(Math.abs(Number(m[1]) - expect) <= 1,
    `${cheapest.name} advertises ${m[1]} weeks; the honest figure is ${expect}`);
});

test('the fleet lease sum bills the signed rate and charges nothing for owned metal', () => {
  const list = getAircraftType(jet.id).weeklyLease;
  const st = baseSave();
  st.fleet = [
    mkAircraft('owned1'),                                                    // owned → 0
    mkAircraft('l1', { ownershipType: 'lease', weeklyLease: Math.round(list * 0.83) }),
  ];
  st.routes = st.routes.filter(r => r.id === 'flat');
  st.routes[0].aircraftId = 'owned1';
  seedSave(st);
  const html = render(React.createElement(Dashboard));
  // The cost-breakdown fallback (no lastReport yet) prints the weekly lease line.
  const i = html.indexOf('Leases');
  assert.ok(i > 0, 'lease cost line rendered');
  const m = html.slice(i, i + 400).match(/(\$[\d.,]+[kKmMbB]?)/);
  assert.ok(m, 'lease figure rendered');
  const honest = Math.round(list * 0.83);
  assert.equal(m[1], formatMoney(honest),
    `Dashboard bills ${m[1]}/wk of lease rent for one OWNED airframe and one ` +
    `lease signed at ${formatMoney(honest)}/wk (list is ${formatMoney(list)})`);
});

console.log(`\n${'─'.repeat(60)}\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
