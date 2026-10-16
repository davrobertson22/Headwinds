// buildOwnMetalConnections' hub / per-hub pre-filter must not change a single
// number the network tick produces.
//
// runNetworkTick now asks buildOwnMetalConnections to skip non-hub airports and
// to rank each hub's spoke pairs by gravity demand BEFORE pricing them, keeping
// only the MAX_OWN_METAL_ODS_PER_HUB that computeOwnMetalODRevenue would keep
// anyway. That is a pure speed-up (the Route Finder runs a network tick per
// forecast row — Discord, 2026-10-16) and this suite is what says so: for
// networks with big hubs (well past the per-hub cap), tag routes, focus cities
// and a non-hub airport with spokes of its own, the revenue model's output from
// the filtered connections must deep-equal its output from the unfiltered ones.
//
//   node tools/network-own-metal-prefilter-test.mjs

import assert from 'node:assert/strict';
import {
  buildOwnMetalConnections, computeOwnMetalODRevenue, MAX_OWN_METAL_ODS_PER_HUB,
} from '../packages/engine/src/models/network.js';
import { AIRPORTS } from '../packages/engine/src/data/airports.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')}`); failed++; }
}

let seed = 1234567;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const BIG = [...AIRPORTS].sort((a, b) => b.population - a.population).slice(0, 300).map(a => a.code);

function network({ hubs, spokesPerHub, extra = 0, tags = 0 }) {
  const routes = [];
  let n = 0;
  for (const h of hubs) {
    const picked = new Set();
    while (picked.size < spokesPerHub) {
      const s = BIG[Math.floor(rand() * BIG.length)];
      if (s !== h) picked.add(s);
    }
    for (const s of picked) {
      routes.push({ id: `r${n++}`, origin: rand() < 0.5 ? h : s, destination: rand() < 0.5 ? s : h,
        weeklyFrequency: 1 + Math.floor(rand() * 21), ticketPrice: 150 + Math.floor(rand() * 600) });
    }
  }
  // Point-to-point flying between non-hub airports: their spoke pairs are never
  // revenue (no designated hub), so the filter drops them wholesale.
  for (let k = 0; k < extra; k++) {
    const a = BIG[Math.floor(rand() * BIG.length)], b = BIG[Math.floor(rand() * BIG.length)];
    if (a !== b) routes.push({ id: `p${n++}`, origin: a, destination: b, weeklyFrequency: 7, ticketPrice: 300 });
  }
  for (let k = 0; k < tags; k++) {
    const h = hubs[k % hubs.length];
    const a = BIG[Math.floor(rand() * BIG.length)], b = BIG[Math.floor(rand() * BIG.length)];
    if (new Set([a, h, b]).size === 3) {
      routes.push({ id: `t${n++}`, origin: a, destination: b, stops: [a, h, b], weeklyFrequency: 5, ticketPrice: 400 });
    }
  }
  return routes;
}

function same(routes, hubs, { legacy = false } = {}) {
  const seats = {};
  for (const r of routes) seats[[r.origin, r.destination].sort().join('-')] = 150 * (r.weeklyFrequency ?? 7);
  const opts = { hubs, gameDate: { month: 7 }, routeCountByAirport: {}, slotsByAirport: {}, gates: {} };
  const full     = buildOwnMetalConnections(routes, seats, legacy);
  const filtered = buildOwnMetalConnections(routes, seats, legacy, { hubs, perHubLimit: MAX_OWN_METAL_ODS_PER_HUB });
  assert.ok(filtered.length <= full.length);
  assert.deepEqual(computeOwnMetalODRevenue(filtered, opts), computeOwnMetalODRevenue(full, opts));
  return { full: full.length, filtered: filtered.length };
}

console.log('\n── own-metal connection pre-filter ─────────────────────────────');

test('big hubs well past the per-hub cap: identical revenue model output', () => {
  const hubs = { JFK: { tier: 3 }, LHR: { tier: 2 }, DXB: { tier: 1 } };
  const routes = network({ hubs: Object.keys(hubs), spokesPerHub: 60, extra: 40, tags: 8 });
  const { full, filtered } = same(routes, hubs);
  assert.ok(full > 3 * MAX_OWN_METAL_ODS_PER_HUB, `fixture too small to exercise the cap (${full} pairs)`);
  assert.ok(filtered < full / 2, `the filter is not cutting anything (${filtered} of ${full})`);
});

test('a focus city (tier 0) counts as designated; a null tier does not', () => {
  const hubs = { ORD: { tier: 0 }, ATL: { tier: null }, LAX: { tier: 1 } };
  same(network({ hubs: ['ORD', 'ATL', 'LAX'], spokesPerHub: 25, extra: 10 }), hubs);
});

test('small networks under the cap', () => {
  for (let k = 0; k < 6; k++) {
    const hubs = { [BIG[k * 3]]: { tier: 1 } };
    same(network({ hubs: Object.keys(hubs), spokesPerHub: 4 + k * 3, extra: k, tags: k % 3 }), hubs);
  }
});

test('legacy (flag-off) worlds', () => {
  const hubs = { SIN: { tier: 2 }, HKG: { tier: 1 } };
  same(network({ hubs: Object.keys(hubs), spokesPerHub: 40, extra: 15, tags: 4 }), hubs, { legacy: true });
});

test('no hubs at all → no connections either way', () => {
  const routes = network({ hubs: ['CDG'], spokesPerHub: 20 });
  const filtered = buildOwnMetalConnections(routes, {}, false, { hubs: {}, perHubLimit: MAX_OWN_METAL_ODS_PER_HUB });
  assert.equal(filtered.length, 0);
  same(routes, {});
});

console.log(`\n${failed === 0 ? '✓' : '✗'} network-own-metal-prefilter: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
