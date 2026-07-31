// Rival route maps — the Rivals tab can draw a competitor's published network.
//
// Two halves, both covered here because they are two ends of one feature:
//
//   1. SERVER — toHumanCompetitor() now projects a rival's freight lanes
//      alongside their passenger routes, folded per city pair the same way, and
//      still withholds everything private (tonnes actually carried, load factor,
//      per-lane margin).
//   2. CLIENT — buildRivalNetwork() turns those two maps into drawable links,
//      and decides which of them are contested with the player.
//
// The contested rule is the subtle one: a lane is contested only against the
// SAME kind of flying. Your passenger service on JFK–LHR does not contest a
// rival's freighter there — different customers, different aircraft, no shared
// demand pool — and marking it contested would put a fake fight on the map.
//
//   node --import ./tools/_register-loader.mjs tools/rival-map-test.mjs

import assert from 'node:assert/strict';
import { toHumanCompetitor } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { AIRCRAFT_TYPES, getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { cargoReferenceYield } from '../packages/engine/src/utils/market.js';

const { buildRivalNetwork, networkSignature, pairKey } = await import('../src/components/RivalRouteMap.jsx');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const freighters = AIRCRAFT_TYPES.filter((t) => t.freighter && (t.payloadTonnes ?? 0) > 0);
assert.ok(freighters.length >= 2, 'engine data has at least two freighter types');
// Two DIFFERENT payloads, so a lane flown by both proves capacity is summed per
// aircraft rather than payload × total frequency.
const bigF = freighters.reduce((a, b) => (b.payloadTonnes > a.payloadTonnes ? b : a));
const smallF = freighters.reduce((a, b) => (b.payloadTonnes < a.payloadTonnes ? b : a));
assert.notEqual(bigF.payloadTonnes, smallF.payloadTonnes, 'fixture freighters differ in payload');

function rivalRow({ routes = [], cargoRoutes = [], fleet = [], routePricing = {} } = {}) {
  return {
    id: 'rival-1',
    name: 'Rival Air',
    hub: 'JFK',
    state: { hub: 'JFK', airlineName: 'Rival Air', fleet, routes, cargoRoutes, routePricing },
  };
}

const cargoLeg = (over) => ({
  origin: 'JFK', destination: 'LHR', aircraftId: 'f1', weeklyFrequency: 4, yieldPrice: 0.5, cargo: true, ...over,
});

console.log('\n── server: rival freight lanes are public ───────────────');

test('a rival with no freighters gets an empty map, never undefined', () => {
  const c = toHumanCompetitor(rivalRow());
  assert.deepEqual(c.cargoRoutes, {});
});

test('a freight lane is projected under the sorted pair key', () => {
  const c = toHumanCompetitor(rivalRow({
    fleet: [{ id: 'f1', typeId: bigF.id }],
    cargoRoutes: [cargoLeg()],
  }));
  assert.ok('JFK-LHR' in c.cargoRoutes, `expected JFK-LHR, got ${Object.keys(c.cargoRoutes)}`);
  assert.equal(c.cargoRoutes['JFK-LHR'].frequency, 4);
});

test('direction does not create a second lane', () => {
  const c = toHumanCompetitor(rivalRow({
    fleet: [{ id: 'f1', typeId: bigF.id }],
    cargoRoutes: [cargoLeg(), cargoLeg({ origin: 'LHR', destination: 'JFK', weeklyFrequency: 3 })],
  }));
  assert.equal(Object.keys(c.cargoRoutes).length, 1);
  assert.equal(c.cargoRoutes['JFK-LHR'].frequency, 7);
});

test('capacity is summed per freighter, not payload × total frequency', () => {
  const c = toHumanCompetitor(rivalRow({
    fleet: [{ id: 'f1', typeId: bigF.id }, { id: 'f2', typeId: smallF.id }],
    cargoRoutes: [
      cargoLeg({ aircraftId: 'f1', weeklyFrequency: 4 }),
      cargoLeg({ aircraftId: 'f2', weeklyFrequency: 6 }),
    ],
  }));
  const lane = c.cargoRoutes['JFK-LHR'];
  assert.equal(lane.tonnesPerWeek, bigF.payloadTonnes * 4 + smallF.payloadTonnes * 6);
  // The naive version — one payload × the pair's whole schedule — is wrong.
  assert.notEqual(lane.tonnesPerWeek, bigF.payloadTonnes * 10);
});

test('published rate is frequency-weighted across the lane', () => {
  const c = toHumanCompetitor(rivalRow({
    fleet: [{ id: 'f1', typeId: bigF.id }, { id: 'f2', typeId: bigF.id }],
    cargoRoutes: [
      cargoLeg({ aircraftId: 'f1', weeklyFrequency: 1, yieldPrice: 1.0 }),
      cargoLeg({ aircraftId: 'f2', weeklyFrequency: 3, yieldPrice: 0.2 }),
    ],
  }));
  // (1×1.0 + 3×0.2) / 4 = 0.4 — not the last row's 0.2, not the mean 0.6.
  assert.equal(c.cargoRoutes['JFK-LHR'].yieldPrice, 0.4);
});

test('rate is also published relative to the lane reference yield', () => {
  const c = toHumanCompetitor(rivalRow({
    fleet: [{ id: 'f1', typeId: bigF.id }],
    cargoRoutes: [cargoLeg({ yieldPrice: 0.5 })],
  }));
  const expected = +(0.5 / cargoReferenceYield('JFK', 'LHR')).toFixed(3);
  assert.equal(c.cargoRoutes['JFK-LHR'].yieldMultiplier, expected);
});

test('every freighter type on the lane is listed', () => {
  const c = toHumanCompetitor(rivalRow({
    fleet: [{ id: 'f1', typeId: bigF.id }, { id: 'f2', typeId: smallF.id }],
    cargoRoutes: [cargoLeg({ aircraftId: 'f1' }), cargoLeg({ aircraftId: 'f2' })],
  }));
  const lane = c.cargoRoutes['JFK-LHR'];
  assert.deepEqual([...lane.aircraftTypes].sort(), [bigF.id, smallF.id].sort());
  assert.ok(getAircraftType(lane.aircraftType), 'aircraftType resolves');
});

test('private performance never leaks onto a lane', () => {
  const c = toHumanCompetitor(rivalRow({
    fleet: [{ id: 'f1', typeId: bigF.id }],
    cargoRoutes: [cargoLeg()],
  }));
  const lane = c.cargoRoutes['JFK-LHR'];
  for (const banned of ['tonnes', 'loadFactor', 'profit', 'revenue', 'launchCost', 'cash']) {
    assert.ok(!(banned in lane), `lane must not publish "${banned}"`);
  }
  // The frequency-weighting accumulator is an implementation detail.
  assert.ok(!('_yieldFreq' in lane), 'internal accumulator must not ship to clients');
});

test('a malformed lane is skipped rather than keyed as undefined', () => {
  const c = toHumanCompetitor(rivalRow({
    fleet: [{ id: 'f1', typeId: bigF.id }],
    cargoRoutes: [cargoLeg(), { aircraftId: 'f1', weeklyFrequency: 2 }],
  }));
  assert.deepEqual(Object.keys(c.cargoRoutes), ['JFK-LHR']);
});

console.log('\n── client: network derivation for the map ───────────────');

const paxRoutes = {
  'BOS-JFK': { frequency: 14, economyFare: 120, seatsPerWeek: 2100 },
  'JFK-LHR': { frequency: 7, economyFare: 480, seatsPerWeek: 1900 },
};
const cargoLanes = {
  'JFK-LHR': { frequency: 4, tonnesPerWeek: 400, yieldPrice: 0.5 },
};

test('pair keys match the server and the player pair map', () => {
  assert.equal(pairKey('LHR', 'JFK'), 'JFK-LHR');
  assert.equal(pairKey('JFK', 'LHR'), 'JFK-LHR');
});

test('every known route becomes a drawable link', () => {
  const n = buildRivalNetwork({ routes: paxRoutes, cargoRoutes: cargoLanes, hubs: ['JFK'] });
  assert.equal(n.passengerCount, 2);
  assert.equal(n.cargoCount, 1);
  assert.equal(n.links.length, 3);
});

test('a pair you also fly is contested', () => {
  const n = buildRivalNetwork({ routes: paxRoutes, playerRouteMap: { 'JFK-LHR': {} } });
  assert.equal(n.contestedCount, 1);
  assert.equal(n.links.find(l => l.key === 'JFK-LHR').contested, true);
  assert.equal(n.links.find(l => l.key === 'BOS-JFK').contested, false);
});

test('your passenger service does NOT contest their freighter', () => {
  const n = buildRivalNetwork({
    routes: {}, cargoRoutes: cargoLanes,
    playerRouteMap: { 'JFK-LHR': {} },   // you fly pax there
    playerCargoKeys: [],                  // but no freight
  });
  assert.equal(n.contestedCount, 0);
});

test('your freighter DOES contest theirs on the same lane', () => {
  const n = buildRivalNetwork({
    routes: {}, cargoRoutes: cargoLanes,
    playerRouteMap: {}, playerCargoKeys: ['JFK-LHR'],
  });
  assert.equal(n.contestedCount, 1);
  assert.equal(n.links[0].cargo, true);
});

test('contested links sort last so they draw on top', () => {
  const n = buildRivalNetwork({ routes: paxRoutes, playerRouteMap: { 'BOS-JFK': {} } });
  assert.equal(n.links[n.links.length - 1].key, 'BOS-JFK');
});

test('an airport this client cannot resolve is skipped, not drawn at 0,0', () => {
  const n = buildRivalNetwork({ routes: { ...paxRoutes, 'JFK-ZZZ': { frequency: 3 } } });
  assert.equal(n.links.length, 2);
  assert.ok(!n.airports.some(a => a.code === 'ZZZ'));
  assert.ok(n.airports.every(a => Number.isFinite(a.lat) && Number.isFinite(a.lon)));
});

test('hubs are flagged, and a hub with no routes still shows', () => {
  const n = buildRivalNetwork({ routes: paxRoutes, hubs: ['JFK', 'LAX'] });
  assert.equal(n.airports.find(a => a.code === 'JFK').isHub, true);
  assert.equal(n.airports.find(a => a.code === 'BOS').isHub, false);
  assert.ok(n.airports.some(a => a.code === 'LAX' && a.isHub), 'unserved hub still appears');
});

test('a rival with nothing open derives an empty network', () => {
  const n = buildRivalNetwork({});
  assert.deepEqual(n.links, []);
  assert.deepEqual(n.airports, []);
  assert.equal(n.contestedCount, 0);
});

test('a solo AI carrier (no cargoRoutes field at all) still derives', () => {
  const n = buildRivalNetwork({ routes: { 'BOS-JFK': { frequency: 10, priceMultiplier: 1.1 } } });
  assert.equal(n.passengerCount, 1);
  assert.equal(n.cargoCount, 0);
});

console.log('\n── client: redraw signature ─────────────────────────────');

// The map only rebuilds its Leaflet layers when this signature changes, and the
// tooltip HTML is baked in at draw time. So anything the tooltip ASSERTS has to
// move the signature — otherwise the map keeps stating a fare the rival no
// longer charges. `extent` is deliberately separate: it drives fitBounds, and
// must NOT move when only a number changed, or the viewport snaps back from
// wherever the player panned it.
const sigOf = (routes, cargo = {}, player = {}) => {
  const n = buildRivalNetwork({ routes, cargoRoutes: cargo, hubs: ['JFK'], playerRouteMap: player });
  return networkSignature(n.links, n.airports);
};
const base = { 'JFK-LHR': { frequency: 7, economyFare: 480, seatsPerWeek: 1900, aircraftTypes: ['b789'] } };

test('an unchanged network produces an unchanged signature', () => {
  assert.equal(sigOf(base).full, sigOf({ 'JFK-LHR': { ...base['JFK-LHR'] } }).full);
});

for (const [label, patch] of [
  ['a fare cut', { economyFare: 392 }],
  ['a price-multiplier move (solo AI fare war)', { priceMultiplier: 0.85 }],
  ['a frequency change', { frequency: 10 }],
  ['a capacity change', { seatsPerWeek: 2400 }],
  ['a re-equipment', { aircraftTypes: ['a350900'] }],
]) {
  test(`${label} changes the signature`, () => {
    assert.notEqual(sigOf(base).content, sigOf({ 'JFK-LHR': { ...base['JFK-LHR'], ...patch } }).content);
  });
}

test('a freight re-rate changes the signature', () => {
  const a = sigOf({}, { 'JFK-LHR': { frequency: 4, yieldPrice: 0.50, tonnesPerWeek: 400 } });
  const b = sigOf({}, { 'JFK-LHR': { frequency: 4, yieldPrice: 0.42, tonnesPerWeek: 400 } });
  assert.notEqual(a.content, b.content);
});

test('becoming contested changes the signature', () => {
  assert.notEqual(sigOf(base).content, sigOf(base, {}, { 'JFK-LHR': {} }).content);
});

test('a fare change does NOT move the extent (viewport stays put)', () => {
  assert.equal(sigOf(base).extent, sigOf({ 'JFK-LHR': { ...base['JFK-LHR'], economyFare: 100 } }).extent);
});

test('opening a new route DOES move the extent (viewport refits)', () => {
  assert.notEqual(sigOf(base).extent, sigOf({ ...base, 'JFK-NRT': { frequency: 3 } }).extent);
});

console.log(`\n${failed === 0 ? '✅' : '❌'} rival map: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
