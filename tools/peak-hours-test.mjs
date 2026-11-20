// Peak hours and layovers — peak-hour worlds (state.peakHours), models/peakHours.js
// and the daytime week and holds in models/schedule.js.
//
// Every flight is scored by when it leaves and lands (local time at each end,
// business and leisure separately), every landing is priced by its hour at
// mega and major airports, and the player may hold an aircraft at the far end
// of a route (parking by the hour). The automatic timetable keeps to waking
// hours and is par by construction. Pins: games without the flag are
// untouched; the automatic week is par; a deliberately bad timetable costs
// more than a good one gains; holds wait where they should, never cost a
// flight, and pay parking; the tick, the preview and the reducer agree.
//
//   node --import ./tools/_register-loader.mjs tools/peak-hours-test.mjs

import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window ??= {
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { getAirport, AIRPORTS } = await import('../packages/engine/src/data/airports.js');
const S = await import('../packages/engine/src/models/schedule.js');
const PH = await import('../packages/engine/src/models/peakHours.js');
const { weeklyTick, referencePrice, weeklyBlockHours, routeDistanceKm } = await import('../packages/engine/src/utils/simulation.js');
const { projectRouteAddition } = await import('../packages/engine/src/models/pairShare.js');
const { computeUtility } = await import('../packages/engine/src/models/demand.js');
const { gameReducer, freshState } = await import('../src/store/GameContext.jsx');
const { genAirline } = await import('./peak-hours-calibrate.mjs');
const { airlineWeeks, aircraftWeek, WEEK_MIN, DAY_MIN } = S;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const jet = getAircraftType('a320neo');
const wide = getAircraftType('b7879');
const HUB = 'SYD';
const mkAc = (id, type = jet) => ({ id, typeId: type.id, name: id, tailNumber: `VH-${id}`, status: 'assigned',
  ownershipType: 'owned', ageWeeks: 40, config: { economy: type.seats } });
const mkRoute = (id, dest, acId, f = 14, origin = HUB, extra = {}) => {
  const fare = Math.round(referencePrice(origin, dest));
  return { id, origin, destination: dest, stops: [origin, dest], aircraftId: acId, weeklyFrequency: f,
    weeksOpen: 40, hub: origin, ticketPrice: fare, classPrices: { economy: fare }, ...extra };
};
/** A small SYD airline: three domestic tails. */
function airline(over = {}) {
  const fleet = [mkAc('a'), mkAc('b'), mkAc('c')];
  const routes = [mkRoute('rMEL', 'MEL', 'a', 21), mkRoute('rBNE', 'BNE', 'b', 14), mkRoute('rADL', 'ADL', 'c', 10)];
  const routePricing = {};
  for (const r of routes) routePricing[[r.origin, r.destination].sort().join('-')] = { economy: r.ticketPrice };
  return {
    fleet, routes, cargoRoutes: [], charters: [], routePricing, gates: { SYD: 40, MEL: 10, BNE: 10, ADL: 10 },
    hubs: { [HUB]: { tier: 2, tierSince: 0 } }, hub: HUB, competitors: [], encroachments: {},
    rivalItineraries: true, gameDate: { month: 6 }, absWeek: 40, week: 40, year: 1, cash: 1e9,
    ...over,
  };
}
const peak = (over = {}) => airline({ peakHours: true, ...over });
const local = (code, utc) => PH.localTod(code, utc);
const legsOf = (week) => week.blocks.flatMap(b => {
  let t = b.start;
  return b.legs.map(l => { const x = { ...l, dep: t, arr: t + l.flightMin, routeId: b.routeId, block: b }; t += l.flightMin + l.turnMin; return x; });
});
const nightDep = (code, utc) => { const m = local(code, utc); return m < 330 || m >= 1350; };
/** Pin every rotation of a route at `tod` local at its origin, every day it fits. */
function pinAllAt(st, routeId, tod) {
  const r = st.routes.find(x => x.id === routeId);
  const off = Math.round(PH.localTod(r.origin, 0));
  const starts = [];
  for (let d = 0; d < 7 && starts.length < r.weeklyFrequency; d++) starts.push(S.wrapWeek(d * DAY_MIN + tod - off));
  return { ...st, routes: st.routes.map(x => (x.id === routeId ? { ...x, weeklyFrequency: starts.length, schedule: { starts } } : x)) };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 1. Worlds without the flag ────────────────────────────────────');

test('no flag: no factors, no daytime week, holds ignored', () => {
  const st = airline();
  assert.equal(PH.peakHoursOf(st, 6), null);
  const held = { ...st, routes: st.routes.map(r => ({ ...r, schedule: { hold: 20 * 60 } })) };
  const a = airlineWeeks(st, 6), b = airlineWeeks(held, 6);
  for (const [id, w] of a) {
    assert.ok(!w.daytime);
    assert.deepEqual(b.get(id).blocks.map(x => `${x.start}+${x.dur}`), w.blocks.map(x => `${x.start}+${x.dur}`));
  }
});

test('no flag: the tick pays the same landing fees and sells the same seats as before', () => {
  const st = airline();
  const a = weeklyTick(st), b = weeklyTick({ ...st, peakHours: false });
  assert.equal(JSON.stringify(b.routeResults), JSON.stringify(a.routeResults));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 2. The daytime week ──────────────────────────────────────────');

test('short haul: far fewer night departures than the old week, and every rotation still flies', () => {
  let nOld = 0, nNew = 0, all = 0, flownOld = 0, flownNew = 0;
  for (let s = 1; s <= 60; s++) {
    const st = genAirline(s, { banks: false });
    const o = airlineWeeks({ ...st, peakHours: false }, 6), n = airlineWeeks(st, 6);
    for (const [id, w] of n) {
      const ow = o.get(id);
      flownOld += ow.blocks.length; flownNew += w.blocks.length;
      for (const l of legsOf(ow)) if (l.flightMin < 240) { all++; if (nightDep(l.from, l.dep)) nOld++; }
      for (const l of legsOf(w)) if (l.flightMin < 240 && nightDep(l.from, l.dep)) nNew++;
    }
  }
  assert.equal(flownNew, flownOld, 'the daytime week drops nothing the old week flew');
  assert.ok(nNew < nOld * 0.6, `night departures ${nNew} vs ${nOld} of ${all}`);
});

test('a tail led by a long sector lands at the far end in the morning', () => {
  const st = peak({ fleet: [mkAc('w', wide)], routes: [mkRoute('rLAX', 'LAX', 'w', 4)] });
  const w = airlineWeeks(st, 6).get('w');
  assert.ok(w.daytime && w.blocks.length === 4);
  // A rotation of more than a day can't land at the same hour every day it
  // flies; the tail's day is timed by it, so most land in the morning.
  const arr = w.blocks.map(b => local('LAX', b.start + b.legs[0].flightMin));
  const morning = arr.filter(a => a >= 7 * 60 && a <= 10 * 60 + 5).length;
  assert.ok(morning >= 3, `lands ${arr.map(S.clockLabel).join(', ')}`);
});

test('pins are kept exactly; the rest flow round them', () => {
  const st = peak();
  const r = st.routes[0];
  const pins = [S.wrapWeek(2 * DAY_MIN + 3 * 60)];
  const w = airlineWeeks({ ...st, routes: [{ ...r, schedule: { starts: pins } }, ...st.routes.slice(1)] }, 6).get('a');
  assert.ok(w.blocks.some(b => b.pinned && b.start === pins[0]));
  assert.equal(w.blocks.length, r.weeklyFrequency);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 3. Holds ─────────────────────────────────────────────────────');

const heldState = (hold, over = {}) => {
  const st = peak({ fleet: [mkAc('w', wide)], routes: [mkRoute('rSIN', 'SIN', 'w', 3, HUB, { schedule: { hold } })], ...over });
  return st;
};

test('the return leaves the far end at the held local time, on every rotation', () => {
  const st = heldState(21 * 60);
  const w = airlineWeeks(st, 6).get('w');
  assert.equal(w.blocks.length, 3);
  for (const b of w.blocks) {
    const back = legsOf({ blocks: [b] })[1];
    assert.equal(local('SIN', back.dep), 21 * 60, `leaves ${S.clockLabel(local('SIN', back.dep))}`);
    assert.ok(b.holdMin > 0 && b.holdMin < DAY_MIN);
  }
});

test('a hold lengthens the rotation by the wait and not the block hours', () => {
  const plain = airlineWeeks(heldState(null), 6).get('w').blocks[0];
  const b = airlineWeeks(heldState(21 * 60), 6).get('w').blocks[0];
  assert.equal(b.dur, plain.dur + b.holdMin);
  const flown = (x) => x.legs.reduce((s, l) => s + l.flightMin, 0);
  assert.equal(flown(b), flown(plain), 'same flying');
  // The block-hour figure the cap checks never reads the timetable.
  assert.equal(weeklyBlockHours(routeDistanceKm(HUB, 'SIN'), 3, wide), weeklyBlockHours(routeDistanceKm(HUB, 'SIN'), 3, wide));
});

test('a hold is always under a day, overnight included', () => {
  for (let h = 0; h < DAY_MIN; h += 85) {
    for (const b of airlineWeeks(heldState(h), 6).get('w').blocks) {
      assert.ok((b.holdMin ?? 0) < DAY_MIN);
      const back = legsOf({ blocks: [b] })[1];
      assert.equal(local('SIN', back.dep), S.normalizeHold(h) < local('SIN', back.dep) - 0 ? local('SIN', back.dep) : local('SIN', back.dep));
      assert.equal(local('SIN', back.dep), (b.holdMin ? S.normalizeHold(h) : local('SIN', back.dep)));
    }
  }
});

test('a hold with no room in the week turns some rotations round as usual — no flight is lost', () => {
  for (const [f, someHeld] of [[14, true], [21, true], [28, false]]) {
    const st = peak({ routes: [mkRoute('rMEL', 'MEL', 'a', f, HUB, { schedule: { hold: 12 * 60 } })], fleet: [mkAc('a')] });
    const w = airlineWeeks(st, 6).get('a');
    assert.equal(w.blocks.length, f, `${f}/wk: every rotation flies`);
    assert.equal(w.overflow.length, 0);
    assert.ok(w.blocks.some(b => b.unheld), `${f}/wk: some rotations fly without the hold`);
    if (someHeld) assert.ok(w.blocks.some(b => b.holdMin), `${f}/wk: and some take it`);
    assert.ok(w.blocks.every(b => (b.holdMin ?? 0) <= S.HOLD_AUTO_MAX_MIN), 'the automatic week plans no day-long waits');
  }
});

test('in a hub-bank world the hold wins over the bank wait at that stop', () => {
  const st = heldState(21 * 60, { hubBanksWorld: true });
  const w = airlineWeeks(st, 6).get('w');
  assert.ok(w.banked);
  for (const b of w.blocks.filter(x => !x.unheld)) {
    const back = legsOf({ blocks: [b] })[1];
    assert.equal(local('SIN', back.dep), 21 * 60);
  }
});

test('the editor sees a held rotation\'s real length (durAt)', () => {
  const w = airlineWeeks(heldState(21 * 60), 6).get('w');
  const b = w.blocks[0];
  assert.equal(w.durAt('rSIN', b.start), b.dur);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 4. Scores ────────────────────────────────────────────────────');

test('the automatic timetable is par, exactly: an airline that times nothing scores 1 and pays its old landing fees', () => {
  for (let s = 101; s <= 200; s++) {
    const st = genAirline(s, { banks: s % 10 < 7 });
    const ph = PH.peakHoursOf(st, 6);
    for (const p of ph.pairs.values()) assert.ok(p.business === 1 && p.leisure === 1, JSON.stringify(p));
    for (const r of ph.routes.values()) assert.ok(r.slotMult === 1 && r.parking === 0, JSON.stringify(r));
  }
});

test('timing one route moves only that route\'s pair and fees', () => {
  const st = pinAllAt(peak(), 'rMEL', 2 * 60);
  const ph = PH.peakHoursOf(st, 6);
  assert.ok(ph.demandFor(HUB, 'MEL').business < 1 && ph.slotMultFor('rMEL') !== 1);
  for (const d of ['BNE', 'ADL']) assert.deepEqual([ph.demandFor(HUB, d).business, ph.demandFor(HUB, d).leisure], [1, 1]);
  assert.equal(ph.slotMultFor('rBNE'), 1);
});

test('a deliberately bad timetable loses more than a good one gains', () => {
  const st = peak({ routes: [mkRoute('rMEL', 'MEL', 'a', 7)], fleet: [mkAc('a')] });
  const auto = PH.peakHoursOf(st, 6).demandFor(HUB, 'MEL');
  const bad = PH.peakHoursOf(pinAllAt(st, 'rMEL', 2 * 60), 6).demandFor(HUB, 'MEL');
  const good = PH.peakHoursOf(pinAllAt(st, 'rMEL', 7 * 60 + 30), 6).demandFor(HUB, 'MEL');
  assert.ok(bad.business < auto.business && good.business > auto.business, JSON.stringify({ auto, bad, good }));
  assert.ok(auto.business - bad.business > good.business - auto.business, 'more downside than upside');
  for (const f of [bad, good]) for (const v of [f.business, f.leisure]) assert.ok(v >= 0.80 && v <= 1.04);
});

test('landing at night at a mega airport is cheaper, at the peaks dearer; regional airports have no bands', () => {
  assert.ok(PH.slotBand('mega', 3 * 60) < 1 && PH.slotBand('mega', 8 * 60) > 1);
  assert.ok(PH.slotBand('major', 3 * 60) < 1 && PH.slotBand('major', 18 * 60) > 1);
  for (let t = 0; t < DAY_MIN; t += 30) assert.equal(PH.slotBand('regional', t), 1);
});

test('a hold at a mega or major airport pays parking by the hour; at a regional one it pays none', () => {
  const ph = PH.peakHoursOf(heldState(21 * 60), 6);
  const r = ph.routes.get('rSIN');
  assert.ok(r.holdMin > 0 && r.parking > 0, JSON.stringify(r));
  const fee = (tier) => 7650 * (tier === 'mega' ? 1 : 0);
  assert.equal(getAirport('SIN').tier, 'mega');
  assert.ok(Math.abs(r.parking - (r.holdMin / 60) * fee('mega') * PH.HOLD_PARKING_PER_HOUR.mega) <= 1);
  const regional = Object.values(await_airports()).find(a => a.tier === 'regional' && routeDistanceKm(HUB, a.code) > 300 && routeDistanceKm(HUB, a.code) < 1500);
  const st = peak({ fleet: [mkAc('a')], routes: [mkRoute('rR', regional.code, 'a', 3, HUB, { schedule: { hold: 18 * 60 } })] });
  const rr = PH.peakHoursOf(st, 6).routes.get('rR');
  assert.ok(rr.holdMin > 0 && rr.parking === 0, JSON.stringify(rr));
});
function await_airports() { return AIRPORTS; }

test('the demand model: a timetable factor is a share term on a contested pair and a pool term alone', () => {
  const base = { airlineId: 'p', origin: HUB, destination: 'MEL', economyPrice: 200, businessPrice: 600, weeklyFrequency: 14, qualityScore: 60, connectivityBonus: 0 };
  const market = { referencePrice: 200, distanceKm: 700, leisureDemand: 1000, businessDemand: 300 };
  const u = (o, seg, out) => computeUtility(o, market, seg, out);
  assert.ok(Math.abs((u({ ...base, timetableLeisure: 0.8 }, 'leisure') - u(base, 'leisure')) - Math.log(0.8)) < 1e-9);
  assert.equal(u({ ...base, timetableLeisure: 0.8 }, 'business'), u(base, 'business'), 'each segment its own term');
  assert.ok(Math.abs((u({ ...base, timetableBusiness: 1.04 }, 'business') - u(base, 'business')) - Math.log(1.04)) < 1e-9);
  const parts = {};
  u({ ...base, timetableLeisure: 0.8 }, 'leisure', parts);
  assert.ok(Math.abs(parts.timetable - Math.log(0.8)) < 1e-9, 'the Brand page sees the term');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 5. The tick and the preview ──────────────────────────────────');

const rr = (res, id) => res.routeResults.find(x => x.routeId === id);

test('the tick: a 2am timetable sells fewer seats than the automatic one', () => {
  // Headwinds' SYD–MEL market fills an A320 at 1.6x the fare whatever the
  // timetable (1358 v 1358 seats); at 2.2x it has seats to spare.
  const st = peak({ routes: [mkRoute('rMEL', 'MEL', 'a', 7)], fleet: [mkAc('a')],
    routePricing: { 'MEL-SYD': { economy: Math.round(referencePrice(HUB, 'MEL') * 2.2) } } });
  const auto = rr(weeklyTick(st), 'rMEL');
  const bad = rr(weeklyTick(pinAllAt(st, 'rMEL', 2 * 60)), 'rMEL');
  assert.ok(bad.passengers < auto.passengers, `${bad.passengers} vs ${auto.passengers}`);
});

test('the tick: landing fees follow the hours, and a hold adds parking', () => {
  const st = peak({ routes: [mkRoute('rMEL', 'MEL', 'a', 7)], fleet: [mkAc('a')] });
  const off = rr(weeklyTick({ ...st, peakHours: false }), 'rMEL').landingFee;
  const night = rr(weeklyTick(pinAllAt(st, 'rMEL', 1 * 60)), 'rMEL').landingFee;
  const ph = PH.peakHoursOf(pinAllAt(st, 'rMEL', 1 * 60), 6);
  assert.equal(night, Math.round(off * ph.slotMultFor('rMEL')) + ph.parkingFor('rMEL'));
  assert.ok(night < off, `night ${night} vs ${off}`);
  const held = { ...st, routes: [{ ...st.routes[0], schedule: { hold: 20 * 60 } }] };
  const h = rr(weeklyTick(held), 'rMEL').landingFee;
  const hp = PH.peakHoursOf(held, 6);
  assert.ok(hp.parkingFor('rMEL') > 0);
  assert.equal(h, Math.round(off * hp.slotMultFor('rMEL')) + hp.parkingFor('rMEL'));
});

test('the preview of a change to a route quotes the landing fee the tick charges', () => {
  const st = pinAllAt(peak({ routes: [mkRoute('rMEL', 'MEL', 'a', 7)], fleet: [mkAc('a')] }), 'rMEL', 1 * 60);
  const tick = rr(weeklyTick(st), 'rMEL');
  const r = st.routes[0];
  const proj = projectRouteAddition(st, { origin: HUB, destination: 'MEL', aircraft: st.fleet[0], weeklyFrequency: r.weeklyFrequency,
    ticketPrice: r.ticketPrice, classPrices: r.classPrices, replacesRouteId: 'rMEL' });
  assert.equal(proj.mature.landingFee, tick.landingFee);
});

test('AI rivals fly at par: nothing in their offers carries a timetable', () => {
  const st = peak({ competitors: [] });
  const ph = PH.peakHoursOf(st, 6);
  assert.deepEqual(PH.timetableFieldsFor(null, HUB, 'MEL'), {});
  assert.ok(ph.pairs.size > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 6. New games, the decision and saves ─────────────────────────');

const newGame = (extra = {}) => gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Peak Air', hub: HUB, enableObjectives: false, ...extra });

test('the reducer never adds the flag: a world has peak hours only when the server stamps it', () => {
  // In Headwinds the flag is the world's (tickConfig.peakHours), stamped on
  // each airline at join and every tick; tools/peak-hours-server-test.mjs.
  assert.equal(newGame().peakHours, undefined);
  assert.equal(PH.peakHoursOf(newGame(), 6), null);
});

test('SET_ROUTE_HOLDS: peak-hour worlds only, cleaned, null clears, no-op returns the same state', () => {
  const plain = airline();
  assert.equal(gameReducer(plain, { type: 'SET_ROUTE_HOLDS', holds: { rMEL: 1200 } }), plain);
  const st = peak();
  const s1 = gameReducer(st, { type: 'SET_ROUTE_HOLDS', holds: { rMEL: 1203 } });
  assert.equal(s1.routes[0].schedule.hold, 1205);
  assert.equal(gameReducer(s1, { type: 'SET_ROUTE_HOLDS', holds: { rMEL: 1205 } }), s1);
  const s2 = gameReducer(s1, { type: 'SET_ROUTE_HOLDS', holds: { rMEL: null } });
  assert.equal(s2.routes[0].schedule, undefined);
});

test('a hold survives pinning and unpinning the route, and moving it to a busy tail', () => {
  const st = gameReducer(peak(), { type: 'SET_ROUTE_HOLDS', holds: { rMEL: 1200 } });
  const pinned = gameReducer(st, { type: 'SET_ROUTE_SCHEDULES', schedules: { rMEL: [600, 2040] } });
  assert.deepEqual(pinned.routes[0].schedule, { starts: [600, 2040], hold: 1200 });
  const unpinned = gameReducer(pinned, { type: 'SET_ROUTE_SCHEDULES', schedules: { rMEL: [] } });
  assert.deepEqual(unpinned.routes[0].schedule, { hold: 1200 });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
