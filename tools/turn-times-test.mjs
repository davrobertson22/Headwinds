// Turn times — the player's standard ground turns (models/turnTimes.js,
// docs/turn-times-design.md).
//
// Pins: untouched settings are byte-identical to the old table; limits clamp
// and step; a route override beats its class; padding is slack for the
// on-time pressure while a cut turn is pressure; effects are weighted by
// flying hours (a padded idle spare moves nothing); the reducer stores,
// cleans and refuses (block-hour cap); the tick's on-time rate and morale
// move the right way; budget rivals need fewer tails.
//
// Ported from Tailwinds (tools/turn-times-test.mjs), plus the server's guard.
//
//   node --import ./tools/_register-loader.mjs tools/turn-times-test.mjs

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

const { getAircraftType, AIRCRAFT_TYPES } = await import('../packages/engine/src/data/aircraft.js');
const T = await import('../packages/engine/src/models/turnTimes.js');
const SIM = await import('../packages/engine/src/utils/simulation.js');
const { laborEffects, DEFAULT_LABOR_STATE } = await import('../packages/engine/src/data/labor.js');
const { tailsForRoute } = await import('../packages/engine/src/models/demand.js');
const { routeRotation } = await import('../packages/engine/src/models/schedule.js');
const { gameReducer, freshState } = await import('../src/store/GameContext.jsx');
const { prepareWeek } = await import('../packages/engine/src/utils/tickPrep.js');
const { guardDecision } = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { ALLOWED_PLAYER_ACTIONS } = await import('../apps/headwinds-server/src/world.mjs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
  finally { T.setPlayerTurnTimes(null); }
}

const jet = getAircraftType('a320neo');
const wide = getAircraftType('b7879');
const HUB = 'SYD';
const mkAc = (id, type = jet) => ({ id, typeId: type.id, name: id, tailNumber: `VH-${id}`, status: 'assigned',
  ownershipType: 'owned', ageWeeks: 40, config: { economy: type.seats } });
const mkRoute = (id, dest, acId, f = 14, extra = {}) => {
  const fare = Math.round(SIM.referencePrice(HUB, dest));
  return { id, origin: HUB, destination: dest, stops: [HUB, dest], aircraftId: acId, weeklyFrequency: f,
    weeksOpen: 40, hub: HUB, ticketPrice: fare, classPrices: { economy: fare }, ...extra };
};
function airline(over = {}) {
  const fleet = [mkAc('a'), mkAc('b'), mkAc('c')];
  const routes = [mkRoute('rMEL', 'MEL', 'a', 21), mkRoute('rBNE', 'BNE', 'b', 14)];
  const routePricing = {};
  for (const r of routes) routePricing[[r.origin, r.destination].sort().join('-')] = { economy: r.ticketPrice };
  return {
    fleet, routes, cargoRoutes: [], charters: [], routePricing, gates: { SYD: 40, MEL: 10, BNE: 10 },
    hubs: { [HUB]: { tier: 2, tierSince: 0 } }, hub: HUB, competitors: [], encroachments: {},
    gameDate: { month: 6 }, absWeek: 40, week: 40, year: 1, cash: 1e9,
    labor: DEFAULT_LABOR_STATE,
    ...over,
  };
}

console.log('turn times');

test('standard turns are the old table, unrounded', () => {
  assert.equal(T.standardTurnHours(jet), 0.83);
  assert.equal(SIM.turnaroundHours(jet), 0.83);
  assert.equal(SIM.turnaroundHours(wide), 1.5);
  assert.equal(SIM.blockTimeHours(1000, jet), 1000 / SIM.cruiseSpeedKmh(jet) + 0.83 + 0);
  const fr = AIRCRAFT_TYPES.find(t => t.freighter && (t.payloadTonnes ?? 0) > 130);
  assert.equal(SIM.turnaroundHours(fr), 1.75);
});

test('limits clamp and step; standard values are never stored', () => {
  assert.deepEqual(T.turnLimitsForClass('Narrow Body'), { min: 30, std: 50, max: 80 });
  assert.equal(T.clampTurnForClass('Narrow Body', 12), 30);
  assert.equal(T.clampTurnForClass('Narrow Body', 999), 80);
  assert.equal(T.clampTurnForClass('Narrow Body', 43), 45);
  assert.equal(T.cleanTurnTimes({ byClass: { 'Narrow Body': 50 } }), null);
  assert.deepEqual(T.cleanTurnTimes({ byClass: { 'Narrow Body': 33, Bogus: 10 } }), { byClass: { 'Narrow Body': 35 } });
});

test('a route override beats its class; charters are never overridden', () => {
  T.setPlayerTurnTimes({ byClass: { 'Narrow Body': 35 } });
  const r = mkRoute('x', 'MEL', 'a');
  assert.equal(T.turnMinutesFor(jet, r), 35);
  assert.equal(T.turnMinutesFor(jet, { ...r, schedule: { turnMin: 70 } }), 70);
  assert.equal(T.turnMinutesFor(jet, { ...r, charter: true, schedule: { turnMin: 70 } }), 35);
  assert.equal(T.turnHoursFor(jet, T.STANDARD_TURN), 0.83);
});

test('shorter turns fit more flights; the timetable uses the turn', () => {
  const r = mkRoute('x', 'MEL', 'a');
  const before = SIM.maxFrequency(700, jet, 100, r);
  T.setPlayerTurnTimes({ byClass: { 'Narrow Body': 30 } });
  assert.ok(SIM.maxFrequency(700, jet, 100, r) > before);
  assert.equal(routeRotation(r, jet).legs[0].turnMin, 30);
});

test('padding is slack for schedule pressure; a cut turn is pressure', () => {
  const r = mkRoute('x', 'MEL', 'a');
  const std = SIM.routePressureBlockHours(r, jet, 14);
  assert.equal(std, SIM.routeBlockHours(r, jet, 14));
  const padded = { ...r, schedule: { turnMin: 80 } };
  assert.ok(SIM.routeBlockHours(padded, jet, 14) > std);
  assert.equal(SIM.routePressureBlockHours(padded, jet, 14), std);
  const cut = { ...r, schedule: { turnMin: 30 } };
  assert.ok(SIM.routePressureBlockHours(cut, jet, 14) < std);
});

test('effects are weighted by flying hours: an idle padded spare moves nothing', () => {
  const st = airline();
  assert.deepEqual(SIM.turnTimeEffectsOf(st).otpDelta, 0);
  const spare = airline({ fleet: [...airline().fleet, mkAc('d', wide)], turnTimes: { byClass: { 'Wide Body': 150 } } });
  assert.equal(SIM.turnTimeEffectsOf(spare).otpDelta, 0);
  const quick = airline({ turnTimes: { byClass: { 'Narrow Body': 30 } } });
  const fx = SIM.turnTimeEffectsOf(quick);
  assert.ok(Math.abs(fx.otpDelta + T.TURN_OTP_SHORT) < 1e-9);
  assert.ok(Math.abs(fx.moraleLift.groundStaff + T.TURN_MORALE_SHORT) < 1e-9);
  const slow = airline({ turnTimes: { byClass: { 'Narrow Body': 80 } } });
  assert.ok(Math.abs(SIM.turnTimeEffectsOf(slow).otpDelta - T.TURN_OTP_LONG) < 1e-9);
  const half = airline({ routes: airline().routes.map(r => r.id === 'rMEL' ? { ...r, schedule: { turnMin: 30 } } : r) });
  const h = SIM.turnTimeEffectsOf(half);
  assert.ok(h.short > 0 && h.short < 1);
});

test('the on-time rate takes the signed turn delta', () => {
  const base = laborEffects(DEFAULT_LABOR_STATE).onTimeRate;
  assert.ok(laborEffects({ ...DEFAULT_LABOR_STATE, turnOtpDelta: -0.05 }).onTimeRate < base);
  assert.ok(laborEffects({ ...DEFAULT_LABOR_STATE, turnOtpDelta: 0.03 }).onTimeRate > base - 1e-9);
});

test('the tick prep attaches the delta only when turns are set', () => {
  const plain = prepareWeek(airline());
  assert.equal(plain.laborThisWeek.turnOtpDelta, undefined);
  const quick = prepareWeek(airline({ turnTimes: { byClass: { 'Narrow Body': 30 } } }));
  assert.ok(quick.laborThisWeek.turnOtpDelta < 0);
});

test('SET_TURN_TIMES stores, cleans, and goes back to standard', () => {
  let st = airline();
  st = gameReducer(st, { type: 'SET_TURN_TIMES', byClass: { 'Narrow Body': 33 } });
  assert.deepEqual(st.turnTimes, { byClass: { 'Narrow Body': 35 } });
  st = gameReducer(st, { type: 'SET_TURN_TIMES', byClass: { 'Narrow Body': null } });
  assert.equal('turnTimes' in st, false);
});

test('SET_TURN_TIMES refuses a change that breaks the block-hour cap', () => {
  const cap = SIM.maxWeeklyBlockHoursFor(airline());
  const r = mkRoute('rMEL', 'MEL', 'a');
  const per = SIM.routeBlockHours(r, jet, 1);
  const f = Math.floor(cap / per);
  const full = airline({ routes: [mkRoute('rMEL', 'MEL', 'a', f), mkRoute('rBNE', 'BNE', 'b', 14)] });
  assert.ok(SIM.turnTimeBreaches(full, { turnTimes: { byClass: { 'Narrow Body': 80 } } }).length > 0);
  const after = gameReducer(full, { type: 'SET_TURN_TIMES', byClass: { 'Narrow Body': 80 } });
  assert.equal(after, full);
  const quick = gameReducer(full, { type: 'SET_TURN_TIMES', byClass: { 'Narrow Body': 30 } });
  assert.notEqual(quick, full);
});

test('SET_ROUTE_TURN sets and clears an override', () => {
  let st = airline();
  st = gameReducer(st, { type: 'SET_ROUTE_TURN', routeId: 'rBNE', turnMin: 61 });
  assert.equal(st.routes.find(r => r.id === 'rBNE').schedule.turnMin, 60);
  st = gameReducer(st, { type: 'SET_ROUTE_TURN', routeId: 'rBNE', turnMin: null });
  assert.equal(st.routes.find(r => r.id === 'rBNE').schedule, undefined);
});

test('the weekly tick lowers morale targets on quick turns', () => {
  const st = { ...freshState(), ...airline({ turnTimes: { byClass: { 'Narrow Body': 30 } },
    labor: Object.fromEntries(Object.entries(DEFAULT_LABOR_STATE).map(([k, g]) => [k, { ...g, morale: 80 }])) }) };
  const next = gameReducer(st, { type: 'ADVANCE_WEEK' });
  const plain = gameReducer({ ...st, turnTimes: undefined }, { type: 'ADVANCE_WEEK' });
  assert.ok(next.labor.groundStaff.morale < plain.labor.groundStaff.morale);
  assert.ok(next.labor.pilots.morale === plain.labor.pilots.morale);
});

test('no AI rivals here: a budget-tier rival sizes like any other (golden master unchanged)', () => {
  assert.equal(T.RIVAL_BUDGET_TURN_SCALE, 1);
  assert.equal(tailsForRoute(800, 70, 'budget'), tailsForRoute(800, 70));
});

test('the server allows both actions and guards them', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('SET_TURN_TIMES'));
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('SET_ROUTE_TURN'));
  const st = airline();
  assert.deepEqual(guardDecision('SET_TURN_TIMES', { byClass: { 'Narrow Body': 35, Bogus: 5 } }, st),
    { byClass: { 'Narrow Body': 35 } });
  assert.throws(() => guardDecision('SET_TURN_TIMES', { byClass: { 'Narrow Body': 'fast' } }, st));
  assert.deepEqual(guardDecision('SET_ROUTE_TURN', { routeId: 'rMEL', turnMin: 60 }, st), { routeId: 'rMEL', turnMin: 60 });
  assert.throws(() => guardDecision('SET_ROUTE_TURN', { routeId: 'someone-elses', turnMin: 60 }, st));
});

test("one airline's turns never leak into another's block hours (shared server module)", () => {
  const quick = airline({ turnTimes: { byClass: { 'Narrow Body': 30 } } });
  const plain = airline();
  const r = plain.routes[0];
  const standard = SIM.routeBlockHours(r, jet, r.weeklyFrequency);
  gameReducer(quick, { type: 'NOOP' });
  assert.ok(SIM.routeBlockHours(r, jet, r.weeklyFrequency) < standard);   // quick's turns are live
  gameReducer(plain, { type: 'NOOP' });
  assert.equal(SIM.routeBlockHours(r, jet, r.weeklyFrequency), standard); // and gone for the next airline
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
