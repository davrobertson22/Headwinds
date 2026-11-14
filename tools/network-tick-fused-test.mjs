// The weekly tick's connection pass works out only what it reads, and gets
// exactly the numbers the old pass did.
//
// runNetworkTick used to enumerate every one-stop connection in the player's
// network (buildAllConnections), then fold the ones a nonstop competes with
// into the cannibalisation map and hand the rest to the partner models. On a
// 4,000-route airline that was 200,000 connection objects a projection, most
// of them read once and dropped. connectionsForTick does the same enumeration
// in one pass and keeps only the cannibalisation factors and the connections
// a partner flies a leg of (2026-11-12). This suite holds it to the old path:
// the same factors to the last bit and in the same key order, the same partner
// connections, the same partner revenue and health decay, for networks with
// hubs, nonstops between spokes, tag flights, alliance / codeshare / joint
// venture partners, market development and the flag-off (legacy) scoring.
//
//   node tools/network-tick-fused-test.mjs

import assert from 'node:assert/strict';
import {
  buildAllConnections, buildCannibalizationMap, buildPartnershipMap, connectionsForTick,
  computePartnerODRevenue, computePartnerHealthDecay, runNetworkTick, odKeyOf, buildCompetitorRouteIndex,
} from '../packages/engine/src/models/network.js';
import { setMarketDev } from '../packages/engine/src/models/marketDev.js';
import { AIRPORTS } from '../packages/engine/src/data/airports.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}

let seed = 7654321;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const BIG = [...AIRPORTS].sort((a, b) => b.population - a.population).slice(0, 250).map(a => a.code);
const pick = () => BIG[Math.floor(rand() * BIG.length)];

// Hubs with spokes, nonstops between some of each hub's spokes (so connections
// over the hub compete with them), point-to-point flying and tag flights.
function network({ hubs, spokesPerHub, directs, extra = 0, tags = 0 }) {
  const routes = [];
  let n = 0;
  const route = (o, d, more = {}) => routes.push({ id: `r${n++}`, origin: o, destination: d,
    weeklyFrequency: 1 + Math.floor(rand() * 21), ticketPrice: 150 + Math.floor(rand() * 600), ...more });
  for (const h of hubs) {
    const spokes = new Set();
    while (spokes.size < spokesPerHub) { const s = pick(); if (s !== h) spokes.add(s); }
    const list = [...spokes];
    for (const s of list) (rand() < 0.5 ? route(h, s) : route(s, h));
    for (let k = 0; k < directs; k++) {
      const a = list[Math.floor(rand() * list.length)], b = list[Math.floor(rand() * list.length)];
      if (a !== b) route(a, b);
    }
  }
  for (let k = 0; k < extra; k++) { const a = pick(), b = pick(); if (a !== b) route(a, b); }
  for (let k = 0; k < tags; k++) {
    const h = hubs[k % hubs.length], a = pick(), b = pick();
    if (new Set([a, h, b]).size === 3) route(a, b, { stops: [a, h, b], weeklyFrequency: 5, ticketPrice: 400 });
  }
  // A duplicate pair (two routes on one nonstop) and a route flown twice in
  // opposite directions: the direct index sums them.
  if (routes.length > 2) { routes.push({ ...routes[1], id: 'dup' }); routes.push({ ...routes[2], id: 'rev', origin: routes[2].destination, destination: routes[2].origin }); }
  return routes;
}

// Partners flying from the player's airports, as competitor route tables.
function partners(routes, count) {
  const airports = [...new Set(routes.flatMap(r => [r.origin, r.destination]))];
  const comps = [];
  for (let c = 0; c < count; c++) {
    const table = {};
    for (let k = 0; k < 40; k++) {
      const a = airports[Math.floor(rand() * airports.length)], b = pick();
      if (a !== b) table[[a, b].sort().join('-')] = { frequency: 1 + Math.floor(rand() * 14), priceMultiplier: 0.8 + rand() * 0.5 };
    }
    comps.push({ id: `c${c}`, name: `Partner ${c}`, routes: table });
  }
  return comps;
}

const seatsFor = (routes) => {
  const seats = {};
  for (const r of routes) {
    const k = [r.origin, r.destination].sort().join('-');
    seats[k] = (seats[k] ?? 0) + 120 * (r.weeklyFrequency ?? 7);
  }
  return seats;
};

// Exact equality, key order included: a factor is a running product, so any
// change in the order the shares were multiplied in shows up here.
function sameMap(a, b) {
  assert.deepEqual(Object.keys(a), Object.keys(b), 'same keys in the same order');
  for (const k of Object.keys(a)) assert.ok(Object.is(a[k], b[k]), `${k}: ${a[k]} vs ${b[k]}`);
}

function check(routes, competitors, pmap, { legacy = false, seats = {} } = {}) {
  const all = buildAllConnections(routes, competitors, pmap, seats, legacy);
  const fused = connectionsForTick(routes, competitors, pmap, seats, legacy);
  sameMap(fused.cannibalizationMap, buildCannibalizationMap(all));
  assert.deepEqual(fused.partnerConnections, all.filter(c => c.partnershipType !== 'ownMetal'));
  const opts = { gameDate: { month: 7 } };
  assert.deepEqual(computePartnerODRevenue(fused.partnerConnections, opts), computePartnerODRevenue(all, opts));
  assert.deepEqual(computePartnerHealthDecay(fused.partnerConnections, pmap), computePartnerHealthDecay(all, pmap));
  return { all: all.length, partner: fused.partnerConnections.length, factors: Object.keys(fused.cannibalizationMap).length };
}

console.log('\n── network tick: the connection pass, fused ────────────────────');

test('the sorted O&D key is the string [a, b].sort().join("-") makes', () => {
  for (let k = 0; k < 2000; k++) { const a = pick(), b = pick(); assert.equal(odKeyOf(a, b), [a, b].sort().join('-')); }
  for (const [a, b] of [['A', 'A'], ['a', 'B'], ['ÄBC', 'ABC'], ['X', undefined], [undefined, 'X'], [null, 'X'], [3, 'X'], ['', 'X']]) {
    assert.equal(odKeyOf(a, b), [a, b].sort().join('-'), `${a} / ${b}`);
  }
});

test('own metal only: hubs, nonstops between spokes, tags — identical factors', () => {
  const routes = network({ hubs: ['JFK', 'LHR', 'DXB', 'SIN'], spokesPerHub: 45, directs: 60, extra: 30, tags: 10 });
  const r = check(routes, [], new Map(), { seats: seatsFor(routes) });
  assert.ok(r.factors > 100, `fixture too small (${r.factors} factors)`);
  assert.equal(r.partner, 0);
});

test('alliance, codeshare and joint-venture partners — identical factors, partner connections, revenue and decay', () => {
  const routes = network({ hubs: ['ATL', 'FRA', 'HND'], spokesPerHub: 30, directs: 40, extra: 20, tags: 6 });
  const comps = partners(routes, 4);
  const pmap = buildPartnershipMap(null, [{ competitorId: 'c1' }], null, { c2: true }, comps);
  pmap.set('c0', 'alliance'); pmap.set('c3', 'interline');
  const r = check(routes, comps, pmap, { seats: seatsFor(routes) });
  assert.ok(r.partner > 50, `fixture has too few partner connections (${r.partner})`);
});

test('flag-off (legacy) scoring and no seat table — identical', () => {
  const routes = network({ hubs: ['ORD', 'CDG'], spokesPerHub: 35, directs: 50, extra: 10, tags: 4 });
  const comps = partners(routes, 2);
  const pmap = new Map([['c0', 'codeshare'], ['c1', 'jointVenture']]);
  check(routes, comps, pmap, { legacy: true });
  check(routes, comps, pmap, { legacy: false });
});

test('market development on: connecting markets priced from the stored levels — identical', () => {
  const routes = network({ hubs: ['LAX', 'AMS'], spokesPerHub: 30, directs: 40, extra: 10 });
  const pairs = {};
  for (const r of routes.slice(0, 40)) pairs[[r.origin, r.destination].sort().join('-')] = { d: 0.3 + rand(), t: 1 };
  setMarketDev({ marketDevWorld: true, marketDev: { pairs } });
  try { check(routes, partners(routes, 2), new Map([['c0', 'alliance']]), { seats: seatsFor(routes) }); }
  finally { setMarketDev({}); }
});

test('runNetworkTick: the same results as the old pass over the whole connection set', () => {
  const routes = network({ hubs: ['JFK', 'NRT'], spokesPerHub: 30, directs: 40, extra: 15, tags: 5 });
  const comps = partners(routes, 3);
  const codeshareAgreements = [{ competitorId: 'c0' }, { competitorId: 'c2' }];
  const seats = seatsFor(routes);
  const out = runNetworkTick({ routes, competitors: comps, codeshareAgreements, gameDate: { month: 7 }, seatsByRouteKey: seats });
  const pmap = buildPartnershipMap(null, codeshareAgreements, null, {}, comps);
  const all = buildAllConnections(routes, comps, pmap, seats, false);
  sameMap(out.cannibalizationMap, buildCannibalizationMap(all));
  assert.deepEqual(out.partnerODRevenue, computePartnerODRevenue(all, {
    gameDate: { month: 7 }, competitorRouteIndex: buildCompetitorRouteIndex(comps), demandMultFor: null, rivalIndex: undefined,
  }));
  assert.ok(out.partnerODRevenue.entries.length > 0, 'fixture has partner revenue');
  assert.deepEqual(out.partnerHealthDecay, computePartnerHealthDecay(all, pmap));
  // The whole set is still there for a caller that asks for it.
  assert.deepEqual(out.connections, all);
});

test('runNetworkTick does not build the whole connection set unless asked', () => {
  // On HEAD before this change `connections` was an own, enumerable field the
  // tick had already filled; it is now built only when read.
  const routes = network({ hubs: ['MIA'], spokesPerHub: 20, directs: 20 });
  const out = runNetworkTick({ routes, competitors: [], gameDate: { month: 7 } });
  assert.ok(!Object.keys(out).includes('connections'), 'connections is not one of the fields the tick filled');
  const d = Object.getOwnPropertyDescriptor(out, 'connections');
  assert.ok(d && typeof d.get === 'function', 'connections is built on read');
  assert.ok(out.connections.length > 0);
  assert.equal(out.connections, out.connections, 'built once');
});

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
