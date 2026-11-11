// The weekly tick at the size airlines really are.
//
// 2026-11-10: players reported the game freezing on every click. Rebuilding
// the live top airlines (1,909 tails / 1,672 routes in Lunar Gateway, 4,869 /
// 4,027 in Scarce Assets) put the weekly projection at 0.9–1.8 s, run twice per
// click on the main thread, and nearly all of it in three places:
//
//   * baseCityPairDemand's memo was capped at 200,000 pairs and cleared
//     wholesale. One 1,672-spoke hub asks about 1.4 million pairs, so the memo
//     emptied itself seven times a tick — and again whenever the server moved
//     between worlds on different demand models;
//   * buildOwnMetalConnections collected every candidate pair at a hub and
//     sorted them all to keep the top 150;
//   * the tick looked aircraft and routes up with `find` inside its loops:
//     routes × fleet comparisons, 20 million a week at 4,000 × 4,900.
//
// None of the fixes may change an answer (the golden masters hold that for the
// whole tick). This file holds the two things a golden master cannot see: that
// the work is not repeated, and that the cut selection and the memos agree with
// the code they replaced on inputs the masters do not contain.
//
//   node --import ./tools/_register-loader.mjs tools/tick-scale-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }

const { AIRPORTS } = await import('../packages/engine/src/data/airports.js');
const market = await import('../packages/engine/src/utils/market.js');
const { baseCityPairDemand, clearPairDemandMemo, setDemandModel, getDemandModel } = market;
const network = await import('../packages/engine/src/models/network.js');
const { buildOwnMetalConnections, MAX_OWN_METAL_ODS_PER_HUB } = network;
const { setMarketDev } = await import('../packages/engine/src/models/marketDev.js');
const mro = await import('../packages/engine/src/data/mroBase.js');
const { AIRCRAFT_FAMILY } = await import('../packages/engine/src/data/families.js');

// How many times the gravity model really ran: every computation measures a
// great-circle distance, and distanceKm ends in exactly one Math.atan2.
function countingComputations(fn) {
  const real = Math.atan2; let n = 0;
  Math.atan2 = (...a) => { n++; return real(...a); };
  try { fn(); } finally { Math.atan2 = real; }
  return n;
}
const CODES = AIRPORTS.map(a => a.code);
const sweep = (codes) => { let s = 0; for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) s += baseCityPairDemand(codes[i], codes[j]); return s; };

// Deterministic pseudo-random numbers (no Math.random in a test).
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

section('pair-demand memo: a big hub does not empty it');

await test('800 airports (319,600 pairs — past the old 200,000 cap) are computed once', () => {
  clearPairDemandMemo();
  const codes = CODES.slice(0, 800);
  const first = sweep(codes);
  let second;
  const recomputed = countingComputations(() => { second = sweep(codes); });
  assert.equal(second, first, 'the warm sweep must return the same demand');
  assert.equal(recomputed, 0, `the warm sweep re-ran the gravity model ${recomputed} times`);
});

await test('the memo holds what it was asked, and reports it', () => {
  if (typeof market.pairDemandMemoSize !== 'function') throw new Error('pairDemandMemoSize is not exported');
  clearPairDemandMemo();
  assert.equal(market.pairDemandMemoSize(), 0);
  sweep(CODES.slice(0, 60));
  assert.equal(market.pairDemandMemoSize(), 60 * 59 / 2);
});

await test('cold, warm and re-cleared reads agree on a wide sample', () => {
  const r = rng(7); const pairs = [];
  for (let k = 0; k < 4000; k++) pairs.push([CODES[Math.floor(r() * CODES.length)], CODES[Math.floor(r() * CODES.length)]]);
  pairs.push(['JFK', 'ZZZZ'], ['ZZZZ', 'YYYY'], ['JFK', 'JFK'], [undefined, 'JFK']);
  clearPairDemandMemo();
  const cold = pairs.map(([a, b]) => baseCityPairDemand(a, b));
  const warm = pairs.map(([a, b]) => baseCityPairDemand(a, b));
  const flipped = pairs.map(([a, b]) => baseCityPairDemand(b, a));
  clearPairDemandMemo();
  const again = pairs.map(([a, b]) => baseCityPairDemand(b, a));
  assert.deepEqual(warm, cold);
  assert.deepEqual(flipped, cold, 'the memo must be symmetric');
  assert.deepEqual(again, cold);
});

section('pair-demand memo: one table per demand model');

await test('a different demand model gets its own answers, not the cached classic ones', () => {
  const sample = [['JFK', 'LAX'], ['LHR', 'CDG'], ['HND', 'CTS'], ['SYD', 'MEL'], ['ORD', 'LGA'], ['DEL', 'BOM']];
  const read = () => sample.map(([a, b]) => baseCityPairDemand(a, b));
  try {
    setDemandModel(null); clearPairDemandMemo();
    const classic = read();
    setDemandModel(3);
    const v3 = read();
    clearPairDemandMemo();
    assert.deepEqual(read(), v3, 'v3 from a warm table must equal v3 computed fresh');
    setDemandModel(null);
    assert.deepEqual(read(), classic, 'classic must come back unchanged');
    assert.notDeepEqual(v3, classic, 'the two models were expected to differ on this sample');
  } finally { setDemandModel(null); }
});

await test('switching to another model and back does not throw the table away', () => {
  try {
    setDemandModel(null); clearPairDemandMemo();
    const codes = CODES.slice(0, 120);
    sweep(codes);
    setDemandModel(3); sweep(codes.slice(0, 10)); setDemandModel(null);
    const recomputed = countingComputations(() => sweep(codes));
    assert.equal(recomputed, 0, `a round trip through another model cost ${recomputed} recomputations`);
    assert.equal(getDemandModel() >= 2, false);
  } finally { setDemandModel(null); }
});

section('own-metal cut: selected as it goes === collect, score, cut');

// Every sellable market at a hub in enumeration order, scored: the plain
// statement of the cut's input. cutOwnMetalMarkets (sort, slice, add each
// spoke's best) is the plain statement of the cut; selectOwnMetalMarkets has
// to return the same markets without ever holding the whole list.
// (2026-11-11: the cut ranks by ownMetalMarketScore and keeps each spoke's
// best, where it ranked by raw demand — tools/connecting-markets-test.mjs.)
function allMarkets(hub, spokes) {
  const km = market.routeDistance;
  const cands = [];
  for (let i = 0; i < spokes.length; i++) {
    for (let j = i + 1; j < spokes.length; j++) {
      const a = spokes[i], b = spokes[j];
      if (a.spoke === b.spoke) continue;
      let sharedTag = false;
      for (const t of a.tagParents) { if (b.tagParents.has(t)) { sharedTag = true; break; } }
      if (sharedTag) continue;
      const [origin, dest] = a.spoke < b.spoke ? [a.spoke, b.spoke] : [b.spoke, a.spoke];
      const odDemand = Math.round(baseCityPairDemand(origin, dest));
      if (!odDemand || odDemand < 5) continue;
      const score = network.ownMetalMarketScore(odDemand, km(a.spoke, hub), km(hub, b.spoke), km(a.spoke, b.spoke));
      if (!(score > 0)) continue;
      cands.push({ a, b, origin, dest, odDemand, score, sa: a.spoke, sb: b.spoke, n: cands.length });
    }
  }
  return cands;
}
const slim = (list) => list.map(c => `${c.a.spoke}>${c.b.spoke}|${c.origin}-${c.dest}|${c.odDemand}`);
const spokesOf = (codes, r, tagEvery = 0) => codes.map((spoke, k) => ({
  spoke, freq: 1 + Math.floor(r() * 20), price: 100 + Math.floor(r() * 900),
  tagParents: new Set(tagEvery && k % tagEvery === 0 ? [`tag${Math.floor(k / (tagEvery * 3))}`] : []),
}));

await test('random hubs, every limit and per-spoke quota, tags included', () => {
  if (typeof network.selectOwnMetalMarkets !== 'function') throw new Error('selectOwnMetalMarkets is not exported');
  setDemandModel(null); setMarketDev(null);
  const r = rng(42);
  let cases = 0, cut = 0, grew = 0;
  for (let round = 0; round < 30; round++) {
    const size = 3 + Math.floor(r() * 70);
    const start = Math.floor(r() * (CODES.length - size));
    const codes = CODES.slice(start, start + size).sort(() => r() - 0.5);
    // Alternate a hub among its own neighbours with one a long way off, so
    // both "everything is on the way" and "almost nothing is" are sampled.
    const hub = round % 2 ? codes.pop() : ['JFK', 'DXB', 'NRT', 'GRU'][round % 4];
    const spokes = spokesOf(codes.filter(c => c !== hub), r, round % 3 === 0 ? 4 : 0);
    const every = allMarkets(hub, spokes);
    for (const limit of [0, 1, 2, 7, 25, MAX_OWN_METAL_ODS_PER_HUB, Infinity]) {
      for (const perSpoke of [0, 1, 2, 3]) {
        const want = network.cutOwnMetalMarkets(every, limit, perSpoke);
        const got = network.selectOwnMetalMarkets(hub, spokes, limit, perSpoke);
        assert.deepEqual(slim(got), slim(want), `${hub} with ${spokes.length} spokes, limit ${limit}, ${perSpoke} per spoke`);
        cases++; if (want.length < every.length) cut++; if (want.length > limit) grew++;
      }
    }
  }
  assert.ok(cut > 60, `only ${cut} of ${cases} cases actually cut anything — the sample is too easy`);
  assert.ok(grew > 20, `only ${grew} of ${cases} cases kept a market for a spoke's sake`);
});

await test('what is cut ranks below what is kept, unless a spoke needed it', () => {
  setDemandModel(null); setMarketDev(null);
  const r = rng(3);
  // A spread of the whole catalogue: a slice of neighbours leaves a far hub
  // almost nothing that is on the way.
  const spokes = spokesOf(CODES.filter((c, k) => k % 12 === 0 && c !== 'LHR'), r);
  const every = allMarkets('LHR', spokes);
  const limit = 40;
  assert.ok(every.length > 3 * limit, `only ${every.length} sellable markets — nothing to cut`);
  const key = (c) => slim([c])[0];
  const top = new Set(slim(network.selectOwnMetalMarkets('LHR', spokes, limit, 0)));
  assert.equal(top.size, limit);
  const floor = Math.min(...every.filter(c => top.has(key(c))).map(c => c.score));
  for (const c of every) if (!top.has(key(c))) assert.ok(c.score <= floor, 'a dropped market outranks a kept one');
  // With a quota, every extra market is one of its two spokes' best two.
  const kept = network.selectOwnMetalMarkets('LHR', spokes, limit, 2);
  assert.ok(kept.length > limit);
  for (const c of kept) {
    if (top.has(key(c))) continue;
    const better = (sp) => every.filter(o => (o.sa === sp || o.sb === sp) && o.score > c.score).length;
    assert.ok(better(c.sa) < 2 || better(c.sb) < 2, `${key(c)} is nobody's top two`);
  }
});

section('own-metal connections: remembered cut === recomputed cut');

const hubRoutes = (hub, spokes, r, extra = {}) => spokes.map((s, k) => ({
  id: `r${k}`, origin: hub, destination: s, weeklyFrequency: 2 + Math.floor(r() * 14), ticketPrice: 150 + Math.floor(r() * 600), ...extra[s],
}));
const hubsOf = (...codes) => Object.fromEntries(codes.map(c => [c, { tier: 2 }]));
function bothWays(routes, hubs) {
  const opts = { hubs, perHubLimit: MAX_OWN_METAL_ODS_PER_HUB };
  network.setOwnMetalCutMemo(false);
  const plain = buildOwnMetalConnections(routes, {}, false, opts);
  network.setOwnMetalCutMemo(true);
  const cold = buildOwnMetalConnections(routes, {}, false, opts);
  const warm = buildOwnMetalConnections(routes, {}, false, opts);
  assert.deepEqual(cold, plain, 'first (cold) remembered call differs from the plain computation');
  assert.deepEqual(warm, plain, 'second (warm) remembered call differs from the plain computation');
  return plain;
}

await test('a 90-spoke hub: cold and warm agree with the memo off', () => {
  if (typeof network.setOwnMetalCutMemo !== 'function') throw new Error('setOwnMetalCutMemo is not exported');
  setDemandModel(null); setMarketDev(null);
  const r = rng(11);
  const spokes = CODES.filter(c => c !== 'LHR').slice(0, 90);
  const out = bothWays(hubRoutes('LHR', spokes, r), hubsOf('LHR'));
  assert.ok(out.length > 0 && out.length <= MAX_OWN_METAL_ODS_PER_HUB + network.OWN_METAL_MARKETS_PER_SPOKE * spokes.length);
  assert.ok(network.ownMetalCutMemoSize() >= 1, 'a 90-spoke hub was expected to be remembered');
});

await test('fares and frequencies change the prices, never the remembered cut', () => {
  setDemandModel(null); setMarketDev(null);
  const spokes = CODES.filter(c => c !== 'LHR').slice(0, 90);
  const a = bothWays(hubRoutes('LHR', spokes, rng(11)), hubsOf('LHR'));
  const b = bothWays(hubRoutes('LHR', spokes, rng(99)), hubsOf('LHR'));
  assert.notDeepEqual(a, b, 'different fares were expected to price differently');
});

await test('adding, dropping and reordering spokes each give the plain answer', () => {
  setDemandModel(null); setMarketDev(null);
  const r = rng(5);
  const pool = CODES.filter(c => c !== 'SIN').slice(200, 330);
  let spokes = pool.slice(0, 100);
  network.setOwnMetalCutMemo(true);
  for (let step = 0; step < 12; step++) {
    bothWays(hubRoutes('SIN', spokes, r), hubsOf('SIN'));
    const move = step % 3;
    if (move === 0) spokes = [...spokes, pool[100 + step]];
    else if (move === 1) spokes = spokes.filter((_, k) => k !== Math.floor(r() * spokes.length));
    else spokes = [...spokes.slice(40), ...spokes.slice(0, 40)];
  }
});

await test('a tag flight through the hub opts out and still agrees', () => {
  setDemandModel(null); setMarketDev(null);
  const r = rng(21);
  const spokes = CODES.filter(c => c !== 'DXB').slice(300, 360);
  const routes = hubRoutes('DXB', spokes, r);
  routes.push({ id: 'tag1', origin: spokes[0], destination: spokes[1], stops: [spokes[0], 'DXB', spokes[1]], weeklyFrequency: 7, ticketPrice: 400 });
  network.setOwnMetalCutMemo(true);
  const before = network.ownMetalCutMemoSize();
  bothWays(routes, hubsOf('DXB'));
  assert.equal(network.ownMetalCutMemoSize(), before, 'a hub with a tag parent must not be remembered');
});

await test('a market-development world opts out and still agrees', () => {
  setDemandModel(null);
  const r = rng(31);
  const spokes = CODES.filter(c => c !== 'FRA').slice(400, 470);
  try {
    setMarketDev({ marketDevWorld: true, marketDev: { pairs: {} } });
    network.setOwnMetalCutMemo(true);
    const dev = bothWays(hubRoutes('FRA', spokes, rng(31)), hubsOf('FRA'));
    assert.equal(network.ownMetalCutMemoSize(), 0, 'a market-development world must not be remembered');
    setMarketDev(null);
    const flat = bothWays(hubRoutes('FRA', spokes, rng(31)), hubsOf('FRA'));
    assert.notDeepEqual(dev, flat, 'market development was expected to change the connections');
    // …and the flat world's remembered cut must not leak back into the dev world.
    setMarketDev({ marketDevWorld: true, marketDev: { pairs: {} } });
    assert.deepEqual(buildOwnMetalConnections(hubRoutes('FRA', spokes, rng(31)), {}, false, { hubs: hubsOf('FRA'), perHubLimit: MAX_OWN_METAL_ODS_PER_HUB }), dev);
  } finally { setMarketDev(null); }
});

await test('each demand model remembers its own cut', () => {
  setMarketDev(null);
  const spokes = CODES.filter(c => c !== 'ATL').slice(500, 580);
  try {
    setDemandModel(null);
    const classic = bothWays(hubRoutes('ATL', spokes, rng(8)), hubsOf('ATL'));
    setDemandModel(3);
    const v3 = bothWays(hubRoutes('ATL', spokes, rng(8)), hubsOf('ATL'));
    setDemandModel(null);
    network.setOwnMetalCutMemo(true);
    const opts = { hubs: hubsOf('ATL'), perHubLimit: MAX_OWN_METAL_ODS_PER_HUB };
    buildOwnMetalConnections(hubRoutes('ATL', spokes, rng(8)), {}, false, opts);          // classic, remembered
    setDemandModel(3);
    assert.deepEqual(buildOwnMetalConnections(hubRoutes('ATL', spokes, rng(8)), {}, false, opts), v3, 'v3 was served the classic cut');
    setDemandModel(null);
    assert.deepEqual(buildOwnMetalConnections(hubRoutes('ATL', spokes, rng(8)), {}, false, opts), classic);
  } finally { setDemandModel(null); }
});

await test('an unchanged hub is not re-enumerated', () => {
  setDemandModel(null); setMarketDev(null);
  const spokes = CODES.filter(c => c !== 'LHR').slice(0, 300);
  const routes = hubRoutes('LHR', spokes, rng(2));
  const opts = { hubs: hubsOf('LHR'), perHubLimit: MAX_OWN_METAL_ODS_PER_HUB };
  network.setOwnMetalCutMemo(true);
  clearPairDemandMemo();
  buildOwnMetalConnections(routes, {}, false, opts);
  clearPairDemandMemo();   // so any pair the second call asks about must be computed again
  const recomputed = countingComputations(() => buildOwnMetalConnections(routes, {}, false, opts));
  // Pricing the 150 survivors measures their distances; enumerating the hub
  // again would measure 44,850 pairs twice each.
  assert.ok(recomputed < 2000, `the second call ran the distance formula ${recomputed} times`);
});

section('own-metal cuts: handed from the projection worker to the page');

await test('recorded cuts, filed on a clean engine, save it the enumeration and change nothing', () => {
  if (typeof network.takeOwnMetalCuts !== 'function') throw new Error('takeOwnMetalCuts is not exported');
  setDemandModel(null); setMarketDev(null);
  const spokes = CODES.filter(c => c !== 'LHR').slice(0, 300);
  const routes = hubRoutes('LHR', spokes, rng(2));
  const opts = { hubs: hubsOf('LHR'), perHubLimit: MAX_OWN_METAL_ODS_PER_HUB };
  network.setOwnMetalCutMemo(false);
  const plain = buildOwnMetalConnections(routes, {}, false, opts);
  // "The worker": records what it cuts.
  network.setOwnMetalCutMemo(true);
  network.recordOwnMetalCuts(true);
  buildOwnMetalConnections(routes, {}, false, opts);
  const cuts = network.takeOwnMetalCuts();
  assert.equal(cuts.length, 1, 'one hub was cut');
  assert.equal(network.takeOwnMetalCuts().length, 0, 'taking empties the list');
  buildOwnMetalConnections(routes, {}, false, opts);
  assert.equal(network.takeOwnMetalCuts().length, 0, 'a remembered cut is not sent twice');
  // "The page": a clean memo, as a structured clone would deliver the cuts.
  const delivered = JSON.parse(JSON.stringify(cuts));
  network.recordOwnMetalCuts(false);
  network.setOwnMetalCutMemo(true);
  assert.equal(network.ownMetalCutMemoSize(), 0);
  assert.equal(network.primeOwnMetalCuts(delivered), 1);
  clearPairDemandMemo();
  let primed;
  const recomputed = countingComputations(() => { primed = buildOwnMetalConnections(routes, {}, false, opts); });
  assert.deepEqual(primed, plain);
  assert.ok(recomputed < 2000, `the page still enumerated the hub (${recomputed} distance computations)`);
});

await test('filing never replaces a cut already held, and ignores anything malformed', () => {
  setDemandModel(null); setMarketDev(null);
  const spokes = CODES.filter(c => c !== 'SIN').slice(0, 60);
  const routes = hubRoutes('SIN', spokes, rng(4));
  const opts = { hubs: hubsOf('SIN'), perHubLimit: MAX_OWN_METAL_ODS_PER_HUB };
  network.setOwnMetalCutMemo(true);
  network.recordOwnMetalCuts(true);
  const good = buildOwnMetalConnections(routes, {}, false, opts);
  const [[key]] = network.takeOwnMetalCuts();
  network.recordOwnMetalCuts(false);
  assert.equal(network.primeOwnMetalCuts([[key, []]]), 0, 'an existing cut was replaced');
  assert.deepEqual(buildOwnMetalConnections(routes, {}, false, opts), good);
  assert.equal(network.primeOwnMetalCuts([null, 'x', [1, []], ['k'], ['k2', 'nope']]), 0);
  assert.equal(network.primeOwnMetalCuts(null), 0);
});

await test('an engine nobody takes from does not accumulate cuts (the server never records)', () => {
  setDemandModel(null); setMarketDev(null);
  network.setOwnMetalCutMemo(true);
  const opts = { hubs: hubsOf('LHR'), perHubLimit: MAX_OWN_METAL_ODS_PER_HUB };
  for (let k = 0; k < 5; k++) buildOwnMetalConnections(hubRoutes('LHR', CODES.filter(c => c !== 'LHR').slice(k, k + 40), rng(k)), {}, false, opts);
  assert.equal(network.takeOwnMetalCuts().length, 0);
});

await test('the projection worker sends the cuts with the projection that made them', async () => {
  const { createProjectionWorkerCore } = await import('../apps/headwinds-web/src/projectionWorkerCore.js');
  const { freshState } = await import('../src/store/GameContext.jsx');
  const { getAircraftType } = await import('../src/data/aircraft.js');
  const { defaultConfig } = await import('../src/utils/simulation.js');
  const t = getAircraftType('a320neo');
  const dests = CODES.filter(c => c !== 'SIN').slice(0, 40);
  const state = { ...freshState(), phase: 'playing', week: 20, year: 3, hub: 'SIN', airlineName: 'Probe Air', cash: 5e9, multiplayer: true,
    competitors: [], humanRivals: {}, encroachments: {}, hubs: { SIN: { tier: 3, tierSince: 0 } },
    fleet: dests.map((d, i) => ({ id: `p${i}`, typeId: t.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(t.seats), ownershipType: 'owned', tailNumber: `9V-${i}`, name: t.name })),
    routes: dests.map((d, i) => ({ id: `r${i}`, origin: 'SIN', destination: d, stops: ['SIN', d], aircraftId: `p${i}`, weeklyFrequency: 7, weeksOpen: 30, hub: 'SIN', ticketPrice: 300 })),
    gates: Object.fromEntries([['SIN', 60], ...dests.map(d => [d, 2])]) };
  network.setOwnMetalCutMemo(true);
  const handle = createProjectionWorkerCore();
  const first = handle({ id: 1, op: 'project', state });
  assert.ok(first.proj, `the worker did not project: ${first.error ?? ''}`);
  assert.ok(Array.isArray(first.cuts) && first.cuts.length >= 1, 'no cuts came back with the first projection');
  assert.ok(first.cuts.every(([k, tuples]) => typeof k === 'string' && Array.isArray(tuples)));
  const second = handle({ id: 2, op: 'project', state: { ...state } });
  assert.equal(second.cuts, undefined, 'cuts already sent must not be sent again');
  network.recordOwnMetalCuts(false);
});

section('jet bases: the network index === walking the routes per tail');

await test('networkAirportsIndex agrees with aircraftNetworkAirports for every tail', () => {
  if (typeof mro.networkAirportsIndex !== 'function') throw new Error('networkAirportsIndex is not exported');
  const r = rng(13);
  const fleet = Array.from({ length: 60 }, (_, k) => ({ id: `a${k}` }));
  const pick = () => CODES[Math.floor(r() * 400)];
  const routes = Array.from({ length: 150 }, (_, k) => {
    const o = pick(), d = pick(), via = pick();
    return { id: `r${k}`, aircraftId: `a${Math.floor(r() * 70)}`, origin: o, destination: d, ...(k % 9 === 0 ? { stops: [o, via, d] } : {}) };
  });
  const cargo = Array.from({ length: 40 }, (_, k) => ({ id: `c${k}`, aircraftId: `a${Math.floor(r() * 70)}`, origin: pick(), destination: pick() }));
  const index = mro.networkAirportsIndex(routes, cargo);
  for (const a of [...fleet, { id: 'nobody' }]) {
    const want = [...mro.aircraftNetworkAirports(a.id, routes, cargo)];
    assert.deepEqual([...(index.get(a.id) ?? [])], want, `tail ${a.id}`);
  }
});

await test('resolveBaseFor gives the same base with the index as without', () => {
  const r = rng(17);
  const byFamily = new Map();
  for (const [typeId, fam] of Object.entries(AIRCRAFT_FAMILY)) if (!byFamily.has(fam)) byFamily.set(fam, typeId);
  const types = [...byFamily.values()].slice(0, 6);
  const fleet = Array.from({ length: 80 }, (_, k) => ({ id: `a${k}`, typeId: types[k % types.length], ...(k % 11 === 0 ? { reserveBase: 'LHR' } : {}) }));
  const stations = ['LHR', 'JFK', 'SIN', 'DXB', 'FRA', 'SYD', 'NRT', 'LAX'];
  const routes = Array.from({ length: 200 }, (_, k) => ({ id: `r${k}`, aircraftId: `a${Math.floor(r() * 80)}`, origin: stations[Math.floor(r() * 8)], destination: CODES[Math.floor(r() * 300)] }));
  // Certify every family the sample fleet belongs to at three stations.
  // Three open bases, each certified for a different part of the sample fleet.
  const fams = [...byFamily.keys()].slice(0, 6);
  const base = (level, openedWeek, families) => ({ level, openedWeek, buildWeeksLeft: 0, families });
  const bases = { LHR: base(2, 0, fams.slice(0, 4)), SIN: base(3, 480, fams.slice(2)), JFK: base(1, 0, fams) };
  const index = mro.networkAirportsIndex(routes, []);
  let resolved = 0;
  for (const a of fleet) {
    const want = mro.resolveBaseFor(a, bases, routes, [], 500);
    const got = mro.resolveBaseFor(a, bases, routes, [], 500, index);
    assert.deepEqual(got, want, `tail ${a.id}`);
    if (want) resolved++;
  }
  // The index must not have been edited by the reserve-base add.
  assert.deepEqual([...(index.get('a0') ?? [])], [...mro.aircraftNetworkAirports('a0', routes, [])]);
  assert.ok(resolved >= 20 && resolved < fleet.length, `${resolved} of ${fleet.length} tails resolved a base — the sample should have both kinds`);
});

section('the tick does not look records up with find inside its loops');

// A lookup by id inside a loop over routes or tails is routes × fleet work. The
// tick files carry none: they index once (firstById, a Set of ids) and read.
const FIND_BY_ID = /\b(?:fleet|routes|rawRoutes|cargoRoutes|freightRoutes|ops)\s*(?:\?\?\s*\[\]\))?\.(?:find|some)\(\s*\(?\w+\)?\s*=>\s*\w+\.(?:id|aircraftId)\s*===/g;
for (const file of ['packages/engine/src/utils/simulation.js', 'packages/engine/src/utils/tickPrep.js']) {
  await test(`${file.split('/').pop()} has no find-by-id over the fleet or route tables`, () => {
    const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const hits = [];
    src.split('\n').forEach((line, i) => { FIND_BY_ID.lastIndex = 0; if (FIND_BY_ID.test(line)) hits.push(`${i + 1}: ${line.trim().slice(0, 110)}`); });
    assert.equal(hits.length, 0, `index the table once instead of:\n        ${hits.join('\n        ')}`);
  });
}

network.setOwnMetalCutMemo?.(true);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
