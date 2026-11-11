// Which connecting markets a hub sells, and how many passengers it says it carried.
//
// Discord, Matthijs 2026-11-10: a JFK focus city with 147 routes showed ONE
// connecting passenger a week. Rebuilt from the live airline, two things were
// wrong:
//
//   1. Every pair of spokes at a hub is a market, each scored market is a full
//      share fight, so a hub's list is cut — and the cut ranked by raw city-pair
//      demand. The biggest pairs among a hub's spokes are neighbours of each
//      other (Tokyo–Osaka, Seoul–Tokyo, Dubai–London), so a 147-spoke JFK
//      spent all 150 places on routings 3 to 27 times the nonstop trip, which
//      lose to every nonstop, and never scored one of its 4,000 sensible pairs.
//      Now a routing longer than MAX_CIRCUITY × the nonstop is not sold (the
//      rule rival one-stops follow), the rest rank by demand × how the stop is
//      rated, and each spoke's best partners are kept on top of the hub's 150.
//
//   2. The hub figures (hubThroughput, ownMetalOD.byHub and .entries) were what
//      each market WON. The route loop then boards that feed into the seats
//      nonstop passengers leave, so a full network carried a fraction of the
//      figure on its own hub card. They are now the passengers carried, with
//      `wanted` beside them.
//
//   node --import ./tools/_register-loader.mjs tools/connecting-markets-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }

const { AIRPORTS } = await import('../packages/engine/src/data/airports.js');
const { baseCityPairDemand, routeDistance } = await import('../packages/engine/src/utils/market.js');
const network = await import('../packages/engine/src/models/network.js');
const { buildOwnMetalConnections, computeOwnMetalODRevenue, MAX_OWN_METAL_ODS_PER_HUB, MAX_CIRCUITY } = network;
const { weeklyTick, defaultConfig, defaultClassPrices, referencePrice } = await import('../packages/engine/src/utils/simulation.js');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');

// ── The fixture: the shape of the airline in the report ──────────────────────
// A focus city at JFK with its 147 biggest destinations, worldwide.
const HUB = 'JFK';
const SPOKES = AIRPORTS.map(a => a.code).filter(c => c !== HUB)
  .map(c => ({ c, d: baseCityPairDemand(HUB, c) || 0 })).sort((a, b) => b.d - a.d).slice(0, 147).map(x => x.c);
const hubs = { [HUB]: { tier: 0, tierSince: 0 } };
const plainRoutes = SPOKES.map((s, k) => ({ id: `r${k}`, origin: HUB, destination: s, weeklyFrequency: 4, ticketPrice: referencePrice(HUB, s) }));
const circuity = (c) => (routeDistance(c.legOneOrigin, c.hub) + routeDistance(c.hub, c.legTwoDest)) / routeDistance(c.legOneOrigin, c.legTwoDest);
const cut = () => buildOwnMetalConnections(plainRoutes, {}, false, { hubs, perHubLimit: MAX_OWN_METAL_ODS_PER_HUB });

section('which markets a big hub sells');

await test('nothing it sells doubles back', () => {
  const kept = cut();
  assert.ok(kept.length > 0);
  const worst = kept.reduce((w, c) => (circuity(c) > circuity(w) ? c : w), kept[0]);
  assert.ok(circuity(worst) <= MAX_CIRCUITY,
    `${worst.legOneOrigin}–${worst.legTwoDest} over ${HUB} is ${circuity(worst).toFixed(1)}× the nonstop distance and is still on the list`);
});

await test('the list grows with the hub, and stays bounded', () => {
  const kept = cut();
  const perSpoke = network.OWN_METAL_MARKETS_PER_SPOKE;
  assert.ok(perSpoke >= 1, 'OWN_METAL_MARKETS_PER_SPOKE is not exported');
  assert.ok(kept.length > MAX_OWN_METAL_ODS_PER_HUB, `a 147-spoke hub still scores only ${kept.length} markets`);
  assert.ok(kept.length <= MAX_OWN_METAL_ODS_PER_HUB + perSpoke * SPOKES.length);
  // A small hub is not handed more than its hub quota allows for.
  const small = buildOwnMetalConnections(plainRoutes.slice(0, 12), {}, false, { hubs, perHubLimit: MAX_OWN_METAL_ODS_PER_HUB });
  assert.ok(small.length <= 12 * 11 / 2);
});

await test('every route that has an on-the-way partner gets connecting feed', () => {
  const fed = new Set();
  for (const c of cut()) { fed.add(c.legOneOrigin); fed.add(c.legTwoDest); }
  const starved = SPOKES.filter((a) => !fed.has(a) && SPOKES.some((b) => b !== a
    && (baseCityPairDemand(a, b) || 0) >= 5
    && routeDistance(a, HUB) + routeDistance(HUB, b) <= MAX_CIRCUITY * routeDistance(a, b)));
  assert.deepEqual(starved, [], `${starved.length} routes have sensible connections over ${HUB} and none on the list`);
});

await test('the markets it keeps are worth more to a connection than the ones it drops', () => {
  if (typeof network.ownMetalMarketScore !== 'function') throw new Error('ownMetalMarketScore is not exported');
  const kept = new Set(cut().map(c => `${c.legOneOrigin}-${c.legTwoDest}`));
  const every = buildOwnMetalConnections(plainRoutes, {}, false, { hubs });
  const score = (c) => network.ownMetalMarketScore(c.odDemand, routeDistance(c.legOneOrigin, HUB), routeDistance(HUB, c.legTwoDest), routeDistance(c.legOneOrigin, c.legTwoDest));
  assert.ok(every.length > 1000, 'fixture too small');
  assert.ok(every.every(c => score(c) > 0), 'an unsellable routing was enumerated');
  const ranked = [...every].sort((a, b) => score(b) - score(a));
  for (const c of ranked.slice(0, MAX_OWN_METAL_ODS_PER_HUB)) assert.ok(kept.has(`${c.legOneOrigin}-${c.legTwoDest}`), `${c.legOneOrigin}–${c.legTwoDest} is in the hub's best ${MAX_OWN_METAL_ODS_PER_HUB} and was cut`);
  // A stop that barely lengthens the trip outranks one that nearly doubles it, at equal demand.
  assert.ok(network.ownMetalMarketScore(1000, 5000, 5000, 9900) > network.ownMetalMarketScore(1000, 5000, 5000, 6800));
  assert.equal(network.ownMetalMarketScore(1000, 5000, 5000, 6000), 0, 'a routing past MAX_CIRCUITY has a score');
});

await test('a list that was already cut is not cut differently when it is priced', () => {
  const opts = { hubs, gameDate: { month: 6 }, gates: { [HUB]: 22 }, slotsByAirport: { [HUB]: 147 * 4 } };
  const full = computeOwnMetalODRevenue(buildOwnMetalConnections(plainRoutes), opts);
  const pre  = computeOwnMetalODRevenue(cut(), opts);
  assert.deepEqual(pre, full);
  assert.ok(full.byHub[HUB].markets > MAX_OWN_METAL_ODS_PER_HUB);
});

await test('old-rule worlds get the same list (the cut is not part of the hub package)', () => {
  const modern = cut().map(c => `${c.legOneOrigin}-${c.legTwoDest}`);
  const legacy = buildOwnMetalConnections(plainRoutes, {}, true, { hubs, perHubLimit: MAX_OWN_METAL_ODS_PER_HUB }).map(c => `${c.legOneOrigin}-${c.legTwoDest}`);
  assert.deepEqual(legacy, modern);
});

// ── The hub's figures are passengers carried ─────────────────────────────────
section('the hub card counts passengers who boarded');

function airline(typeId, freq, spokes = SPOKES.slice(0, 60)) {
  const type = getAircraftType(typeId);
  const fleet = [], routes = [], routePricing = {}, gates = { [HUB]: 22 };
  spokes.forEach((s, k) => {
    const ac = { id: `a${k}`, typeId: type.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(type.seats), ownershipType: 'owned' };
    fleet.push(ac);
    routes.push({ id: `r${k}`, origin: HUB, destination: s, aircraftId: ac.id, weeklyFrequency: freq });
    routePricing[[HUB, s].sort().join('-')] = defaultClassPrices(referencePrice(HUB, s));
    gates[s] = 2;
  });
  // The modern rule set, said out loud: Tailwinds reads a state without the key as an old-rule save.
  return { fleet, routes, cargoRoutes: [], gameDate: { week: 1, month: 6 }, gates, hubs, routePricing, routeCatering: {}, competitors: [], labor: undefined, rivalItineraries: true };
}
const boarded = (report) => (report.routeResults ?? []).reduce((s, r) => s + (r.connecting?.itineraryPax ?? 0), 0);
const booked  = (report) => (report.routeResults ?? []).reduce((s, r) => s + (r.connecting?.itineraryRevenue ?? 0), 0);

await test('full flights: the hub reports what it boarded, and what wanted to connect', () => {
  // One small aircraft a week per route into the biggest markets from New York:
  // the nonstop passengers fill it.
  const report = weeklyTick(airline('a320neo', 1));
  const hub = report.ownMetalOD.byHub[HUB];
  assert.ok(hub?.wanted > 0, 'byHub carries no `wanted`');
  assert.ok(hub.pax < hub.wanted * 0.5, `fixture is not seat-bound (${hub.pax} carried of ${hub.wanted})`);
  // Each itinerary is a boarding on two legs.
  const legBoardings = boarded(report);
  assert.ok(Math.abs(hub.pax * 2 - legBoardings) <= Math.max(60, legBoardings * 0.05),
    `hub says ${hub.pax} connected; the routes boarded ${legBoardings} connecting passengers on their legs (÷2 = ${Math.round(legBoardings / 2)})`);
  assert.ok(report.hubThroughput[HUB] >= hub.pax && report.hubThroughput[HUB] < hub.wanted,
    `hubThroughput ${report.hubThroughput[HUB]} is not the carried figure (${hub.pax} carried, ${hub.wanted} wanted)`);
  const revenue = booked(report);
  assert.ok(Math.abs(hub.revenue - revenue) <= Math.max(2000, revenue * 0.05), `hub revenue ${hub.revenue} vs ${revenue} booked on the routes`);
  const listed = report.ownMetalOD.entries.filter(e => e.hub === HUB);
  assert.ok(listed.every(e => e.pax > 0), 'a market nobody boarded in is listed');
});

await test('spare seats: carried equals wanted', () => {
  // An A380 four times a day to the thinnest of the 147.
  const report = weeklyTick(airline('a380', 28, SPOKES.slice(-25)));
  const hub = report.ownMetalOD.byHub[HUB];
  assert.ok(hub.pax > 0);
  assert.ok(hub.pax >= hub.wanted * 0.9, `${hub.pax} carried of ${hub.wanted} with near-empty A380s`);
  assert.ok(Math.abs(hub.pax * 2 - boarded(report)) <= Math.max(60, boarded(report) * 0.05));
});

// ── The card says so ─────────────────────────────────────────────────────────
section('the hub card says when seats are the limit');

await test('HubManagement shows wanted beside carried, and stays quiet when they agree', async () => {
  const store = new Map();
  globalThis.window = globalThis.window ?? {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k), clear: () => store.clear(),
  };
  const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
  const HubManagement = (await import('../src/components/HubManagement.jsx')).default;
  const a = airline('a320neo', 1);
  const render = (report) => {
    store.set('bbae_save_v2', JSON.stringify({
      ...freshState(), phase: 'playing', week: 30, year: 2, hub: HUB, homeCountry: 'US', cash: 250_000_000,
      gates: a.gates, hubs, fleet: a.fleet.map((f, k) => ({ ...f, name: 'Jet', tailNumber: `N${k}` })),
      routes: a.routes.map(r => ({ ...r, stops: [r.origin, r.destination], weeksOpen: 20, ticketPrice: referencePrice(r.origin, r.destination) })),
      hubThroughput: {}, lastReport: { ...report, routeResults: [] },
    }));
    return renderToString(React.createElement(GameProvider, null, React.createElement(HubManagement)));
  };
  const report = weeklyTick(a);
  const hub = report.ownMetalOD.byHub[HUB];
  const html = render(report);
  assert.ok(html.includes('wanted to connect'), 'the seat-limit line is missing on a seat-bound hub');
  assert.ok(html.includes(hub.wanted.toLocaleString()) && html.includes(hub.pax.toLocaleString()));
  const roomy = { ...report, ownMetalOD: { ...report.ownMetalOD, byHub: { [HUB]: { ...hub, pax: hub.wanted } } } };
  assert.ok(!render(roomy).includes('wanted to connect'), 'the line shows on a hub that carried everyone');
  // A report from before `wanted` existed says nothing either.
  const old = { ...report, ownMetalOD: { ...report.ownMetalOD, byHub: { [HUB]: { pax: hub.pax, revenue: hub.revenue, markets: hub.markets } } } };
  assert.ok(!render(old).includes('wanted to connect'));
});

// ── Partner-fed connections follow the same rule ─────────────────────────────
section('partner connections are on the way too');

await test('a codeshare leg into your hub sells onward where the hub is on the way, and nowhere else', () => {
  const partner = { id: 'p1', name: 'p1', homeHub: 'FRA', tier: 'legacy', baseQualityScore: 70, cash: 1e8,
    routes: { 'FRA-LHR': { frequency: 14, priceMultiplier: 1.0 } } };
  const mine = [
    { id: 'a', origin: 'LHR', destination: 'JFK', weeklyFrequency: 14, ticketPrice: referencePrice('LHR', 'JFK') },
    { id: 'b', origin: 'LHR', destination: 'IST', weeklyFrequency: 14, ticketPrice: referencePrice('LHR', 'IST') },
  ];
  // Frankfurt–New York over London is on the way; Frankfurt–Istanbul over London is 1.7× the nonstop.
  assert.ok(routeDistance('FRA', 'LHR') + routeDistance('LHR', 'IST') > MAX_CIRCUITY * routeDistance('FRA', 'IST'));
  const conns = network.buildAllConnections(mine, [partner], new Map([['p1', 'codeshare']]));
  assert.ok(conns.some(c => [c.legOneOrigin, c.legTwoDest].sort().join('-') === 'FRA-IST' && c.partnershipType === 'codeshare'), 'fixture forms no FRA–IST connection to refuse');
  const sold = network.computePartnerODRevenue(conns, { gameDate: { month: 6 } }).entries.map(e => [e.origin, e.dest].sort().join('-'));
  assert.ok(sold.includes('FRA-JFK'), `the on-the-way market did not sell (${sold.join(', ') || 'nothing sold'})`);
  assert.ok(!sold.includes('FRA-IST'), 'Frankfurt–Istanbul by way of London was sold');
});

// ── Old-rule worlds: one share of the feed per aircraft ──────────────────────
section('several aircraft on a route share its connecting passengers');

await test('an old-rule world boards a pair\'s connections once, not once per aircraft', () => {
  // Three A380s on each of the 25 thinnest of the 147: seats to spare, so
  // everyone who wants to connect boards — once.
  const one = airline('a380', 28, SPOKES.slice(-25));
  const type = getAircraftType('a380');
  const fleet = [...one.fleet], routes = [...one.routes];
  one.routes.forEach((r, k) => {
    for (const n of [1, 2]) {
      const ac = { id: `x${n}-${k}`, typeId: type.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(type.seats), ownershipType: 'owned' };
      fleet.push(ac);
      routes.push({ ...r, id: `${r.id}-${n}`, aircraftId: ac.id });
    }
  });
  const report = weeklyTick({ ...one, fleet, routes, rivalItineraries: false });
  const hub = report.ownMetalOD.byHub[HUB];
  assert.ok(hub.wanted > 100, 'fixture connects nobody');
  const legBoardings = boarded(report);
  assert.ok(legBoardings <= hub.wanted * 2 * 1.02,
    `${hub.wanted} passengers wanted to connect (two flights each) and the routes boarded ${legBoardings}: ${(legBoardings / (hub.wanted * 2)).toFixed(1)}× over`);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} connecting-markets: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
