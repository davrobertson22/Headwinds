// Connection-seat worlds: who gets the seat when a connection and a local
// passenger both want it (state.connectionSeatsWorld; new worlds from 2026-11-11).
//
// The old rule, which every earlier world keeps: nonstop passengers board
// first, and each leg hands its leftover seats to connections one leg at a
// time. Rebuilding the live airlines for the "one connecting passenger at
// JFK" report (Discord, Matthijs 2026-11-10) showed what that does to a mature
// network: 603 of one airline's 758 routes were full of nonstop passengers, so
// its hubs carried almost nobody, while the legs that did have room booked
// passengers for one flight of a two-flight trip.
//
// The new rule (network.js seatItineraries, weeklyTick):
//   * a connection boards on both of its flights or on neither;
//   * the best fares board first;
//   * on a full flight a connection takes a local passenger's seat only when
//     its fare is worth more than the locals it displaces, up to the share of
//     the flight the hub's tier holds for connections;
//   * connections are booked both directions, as nonstop passengers are.
//
//   node --import ./tools/_register-loader.mjs tools/connection-seats-test.mjs

import assert from 'node:assert/strict';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }

const { AIRPORTS } = await import('../packages/engine/src/data/airports.js');
const { baseCityPairDemand, routeDistance } = await import('../packages/engine/src/utils/market.js');
const network = await import('../packages/engine/src/models/network.js');
const { weeklyTick, defaultConfig, defaultClassPrices, referencePrice } = await import('../packages/engine/src/utils/simulation.js');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const { projectRouteAddition } = await import('../packages/engine/src/models/pairShare.js');

// ── The seating itself ───────────────────────────────────────────────────────
section('seating itineraries');

const seat = (entries, legs) => {
  if (typeof network.seatItineraries !== 'function') throw new Error('seatItineraries is not exported');
  return network.seatItineraries(entries, legs);
};
const market = (od, pax, fare, hub = 'JFK') => ({ od, hub, pax, revenue: pax * fare });

await test('both flights or neither: the tighter leg decides', () => {
  const out = seat([market('LHR→LAX', 20, 900)], { 'JFK-LHR': { free: 12, hold: 0, localYield: 500 }, 'JFK-LAX': { free: 5, hold: 0, localYield: 300 } });
  assert.equal(out.byPair['JFK-LHR'].pax, 5);
  assert.equal(out.byPair['JFK-LAX'].pax, 5);
  assert.equal(out.entries[0].pax, 5);
  assert.equal(out.entries[0].wanted, 20);
  assert.equal(out.byPair['JFK-LHR'].revenue + out.byPair['JFK-LAX'].revenue, 5 * 900);
});

await test('a leg nobody flew this week boards nobody', () => {
  const out = seat([market('LHR→LAX', 20, 900)], { 'JFK-LHR': { free: 50, hold: 0, localYield: 500 } });
  assert.deepEqual(out.entries, []);
  assert.deepEqual(out.byPair, {});
});

await test('the best fare boards first', () => {
  const legs = { 'JFK-LHR': { free: 10, hold: 0, localYield: 500 }, 'JFK-LAX': { free: 100, hold: 0, localYield: 300 }, 'BOS-JFK': { free: 100, hold: 0, localYield: 100 } };
  const out = seat([market('BOS→LHR', 10, 400), market('LHR→LAX', 10, 900)], legs);
  assert.deepEqual(out.entries.map(e => [e.od, e.pax]), [['LHR→LAX', 10]]);
});

await test('a full flight gives up a local seat only to a fare worth more', () => {
  const legs = () => ({ 'JFK-LHR': { free: 100, hold: 0, localYield: 800 }, 'BOS-JFK': { free: 0, hold: 30, localYield: 240 } });
  const pays = seat([market('BOS→LHR', 50, 700)], legs());
  assert.equal(pays.entries[0].pax, 30, 'the hub holds 30 seats for connections');
  assert.equal(pays.byPair['BOS-JFK'].displaced, 30);
  assert.equal(pays.byPair['JFK-LHR'].displaced, 0);
  assert.equal(pays.entries[0].displacedRevenue, 30 * 240);
  // Boston is made whole for its 30 locals first; the rest is split by mileage.
  assert.ok(pays.byPair['BOS-JFK'].revenue > 30 * 240 && pays.byPair['JFK-LHR'].revenue > pays.byPair['BOS-JFK'].revenue);
  assert.equal(pays.byPair['BOS-JFK'].revenue + pays.byPair['JFK-LHR'].revenue, 30 * 700);
  const cheap = seat([market('BOS→LHR', 50, 200)], legs());
  assert.deepEqual(cheap.entries, [], 'a $200 connection displaced a $240 local');
});

await test('full on both flights: the fare has to beat both locals', () => {
  const legs = () => ({ 'JFK-LHR': { free: 0, hold: 40, localYield: 800 }, 'BOS-JFK': { free: 0, hold: 40, localYield: 240 } });
  assert.deepEqual(seat([market('BOS→LHR', 50, 1000)], legs()).entries, []);
  const out = seat([market('BOS→LHR', 50, 1100)], legs());
  assert.equal(out.entries[0].pax, 40);
  assert.equal(out.entries[0].displacedRevenue, 40 * (800 + 240));
});

await test('free seats first, then held seats, in one market', () => {
  const out = seat([market('BOS→LHR', 50, 700)], { 'JFK-LHR': { free: 100, hold: 0, localYield: 800 }, 'BOS-JFK': { free: 8, hold: 30, localYield: 240 } });
  assert.equal(out.entries[0].pax, 38);
  assert.equal(out.byPair['BOS-JFK'].displaced, 30);
});

await test('what a hub holds grows with its tier, and never exceeds the locals aboard', () => {
  const leg = (tier, over = {}) => network.connectionLegState({ seats: 1000, room: 0, ecoPax: 900, ecoRev: 900 * 300, tier, ...over });
  assert.equal(leg(null).hold, 0, 'an undesignated airport holds seats');
  const holds = [0, 1, 2, 3].map(t => leg(t).hold);
  assert.deepEqual(holds, [...holds].sort((a, b) => a - b));
  assert.ok(holds[0] > 0 && holds[3] > holds[0]);
  assert.equal(leg(3, { ecoPax: 40 }).hold, 40);
  assert.equal(leg(3, { room: 950 }).hold, 0, 'a flight with seats to spare displaced a local');
  assert.equal(leg(2).localYield, 300);
});

await test('apportion: whole passengers, in proportion, none above its limit', () => {
  assert.deepEqual(network.apportion(10, [3, 3, 30]), [1, 1, 8]);
  assert.deepEqual(network.apportion(7, [4, 4]), [4, 3]);
  assert.deepEqual(network.apportion(6, [0, 2, 2, 2]), [0, 2, 2, 2]);
  assert.deepEqual(network.apportion(0, [5, 5]), [0, 0]);
  assert.equal(network.apportion(9, [1, 9]).reduce((a, b) => a + b, 0), 9);
});

// ── The week ─────────────────────────────────────────────────────────────────
section('the weekly tick');

function hub({ code = 'JFK', tier = 2, n = 60, freq = 7, over = {} } = {}) {
  const spokes = AIRPORTS.map(a => a.code).filter(c => c !== code)
    .map(c => ({ c, d: baseCityPairDemand(code, c) || 0 })).sort((a, b) => b.d - a.d).slice(0, n).map(x => x.c);
  const fleet = [], routes = [], routePricing = {}, gates = { [code]: 40 };
  spokes.forEach((s, k) => {
    const type = getAircraftType(routeDistance(code, s) > 4500 ? 'b7879' : 'a320neo');
    const ac = { id: `a${k}`, typeId: type.id, name: `a${k}`, tailNumber: `N${k}`, status: 'assigned', ageWeeks: 52, config: defaultConfig(type.seats), ownershipType: 'owned' };
    fleet.push(ac);
    const fare = referencePrice(code, s);
    routes.push({ id: `r${k}`, origin: code, destination: s, stops: [code, s], aircraftId: ac.id, weeklyFrequency: freq, weeksOpen: 40, hub: code, ticketPrice: fare });
    routePricing[[code, s].sort().join('-')] = defaultClassPrices(fare);
    gates[s] = 2;
  });
  return { fleet, routes, cargoRoutes: [], gameDate: { week: 1, month: 6 }, gates, hub: code, hubs: { [code]: { tier, tierSince: 0 } },
    routePricing, routeCatering: {}, competitors: [], labor: undefined, cash: 1e9, rivalItineraries: true, ...over };
}
const seats = { connectionSeatsWorld: true };
const sum = (report, f) => report.routeResults.reduce((s, r) => s + (f(r) ?? 0), 0);

// Two spokes, so one market: a daily narrowbody to Boston that the nonstop
// market fills, and four A380s a day to London with room for everyone.
function twoSpokes(over = {}) {
  const fleet = [], routes = [], routePricing = {}, gates = { JFK: 40 };
  [['BOS', 'a320neo', 7], ['LHR', 'a380', 28]].forEach(([s, t, f], k) => {
    const type = getAircraftType(t);
    fleet.push({ id: `a${k}`, typeId: type.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(type.seats), ownershipType: 'owned' });
    routes.push({ id: s, origin: 'JFK', destination: s, aircraftId: `a${k}`, weeklyFrequency: f });
    routePricing[['JFK', s].sort().join('-')] = defaultClassPrices(referencePrice('JFK', s));
    gates[s] = 2;
  });
  return { fleet, routes, cargoRoutes: [], gameDate: { week: 1, month: 6 }, gates, hubs: { JFK: { tier: 2, tierSince: 0 } },
    routePricing, routeCatering: {}, competitors: [], labor: undefined, rivalItineraries: true, ...over };
}

await test('one market over a full flight and a roomy one: the same passengers on both', () => {
  const report = weeklyTick(twoSpokes(seats));
  const bos = report.routeResults.find(r => r.routeId === 'BOS'), lhr = report.routeResults.find(r => r.routeId === 'LHR');
  assert.ok(lhr.connecting.itineraryPax > 0, 'fixture connects nobody');
  assert.equal(bos.connecting.itineraryPax, lhr.connecting.itineraryPax,
    `${bos.connecting.itineraryPax} connecting passengers boarded the Boston flight and ${lhr.connecting.itineraryPax} the London one`);
  // Boston was full, or nearly: most are aboard because locals worth less gave up seats.
  assert.ok(bos.connecting.displacedPax > bos.connecting.itineraryPax * 0.8 && bos.connecting.displacedPax <= bos.connecting.itineraryPax,
    `${bos.connecting.displacedPax} locals gave up seats for ${bos.connecting.itineraryPax} connections`);
  assert.ok(bos.connecting.itineraryRevenue > bos.connecting.displacedRevenue, 'Boston earns less than its locals paid');
  assert.equal(lhr.connecting.displacedPax ?? 0, 0);
});

await test('the old rule on the same airline boards them on one flight only (and still does, without the flag)', () => {
  const report = weeklyTick(twoSpokes());
  const bos = report.routeResults.find(r => r.routeId === 'BOS'), lhr = report.routeResults.find(r => r.routeId === 'LHR');
  assert.ok(lhr.connecting.itineraryPax > 0);
  assert.ok(bos.connecting.itineraryPax < lhr.connecting.itineraryPax * 0.25,
    `Boston boarded ${bos.connecting.itineraryPax} of the ${lhr.connecting.itineraryPax} London did`);
});

await test('every connection is on two flights, and the hub card counts it once', () => {
  const report = weeklyTick(hub({ over: seats }));
  const h = report.ownMetalOD.byHub.JFK;
  assert.ok(h.pax > 500, `fixture carries too few (${h.pax})`);
  assert.equal(sum(report, r => r.connecting.itineraryPax), 2 * h.pax);
  const booked = sum(report, r => r.connecting.itineraryRevenue);
  assert.ok(Math.abs(booked - h.revenue) <= report.routeResults.length, `routes booked ${booked}, hub says ${h.revenue}`);
  assert.ok(h.pax <= h.wanted);
  assert.ok(report.hubThroughput.JFK >= h.pax);
});

await test('a displaced local comes off the route: passengers, economy cabin and revenue', () => {
  const st = hub();
  const off = weeklyTick(st), on = weeklyTick({ ...st, ...seats });
  let displaced = 0;
  for (const r of on.routeResults) {
    const was = off.routeResults.find(x => x.routeId === r.routeId);
    const d = r.connecting.displacedPax ?? 0, lost = r.connecting.displacedRevenue ?? 0;
    displaced += d;
    assert.equal(r.passengers + d, was.passengers, `${r.routeId}: nonstop passengers do not add up`);
    assert.equal(r.classSummary.economy.passengers + d, was.classSummary.economy.passengers);
    assert.equal(r.classSummary.economy.revenue + lost, was.classSummary.economy.revenue);
    assert.ok(r.connecting.itineraryPax >= d, `${r.routeId}: ${d} locals gave up seats to ${r.connecting.itineraryPax} connections`);
    // Nobody stands: the seats nonstop passengers left, plus the ones given up.
    const room = Math.max(0, Math.round(r.configuredSeatsOneWay * 0.95) - was.passengers) + d;
    assert.ok(r.connecting.itineraryPax + r.connecting.externalPax + (r.connecting.partnerPax ?? 0) <= room + 1, `${r.routeId} is over its seats`);
    // What it gave up was worth less than what it took on.
    if (d > 0) assert.ok(lost / d === was.classSummary.economy.revenue / was.classSummary.economy.passengers || Math.abs(lost - d * was.classSummary.economy.revenue / was.classSummary.economy.passengers) <= 1);
  }
  assert.ok(displaced > 0, 'fixture displaced nobody');
});

await test('a full hub earns more than it did on leftovers', () => {
  const st = hub();
  const off = weeklyTick(st), on = weeklyTick({ ...st, ...seats });
  assert.ok(on.totalRevenue > off.totalRevenue * 1.01, `revenue ${off.totalRevenue} → ${on.totalRevenue}`);
  assert.ok(on.cashDelta > off.cashDelta);
  const gain = sum(on, r => r.connecting.itineraryRevenue) - sum(on, r => r.connecting.displacedRevenue);
  assert.ok(gain > sum(off, r => r.connecting.itineraryRevenue), 'connections net of the locals they displaced earn less than the old leftovers');
});

await test('a better hub holds more seats for connections', () => {
  const carried = (tier) => weeklyTick(hub({ tier, over: seats })).ownMetalOD.byHub.JFK.pax;
  const focus = carried(0), gateway = carried(3);
  assert.ok(gateway > focus * 1.3, `focus city ${focus}, gateway ${gateway}`);
});

await test('worlds without the flag, and old-rule worlds with it, tick as before', () => {
  const st = hub({ n: 30 });
  const plain = weeklyTick(st);
  assert.equal(sum(plain, r => r.connecting.displacedPax), 0);
  const oldRule = { ...st, rivalItineraries: false };
  assert.deepEqual(weeklyTick({ ...oldRule, ...seats }), weeklyTick(oldRule));
});

// ── Previews ─────────────────────────────────────────────────────────────────
section('the route preview');

await test('a steady network: the planner quotes the week the tick books', () => {
  // The preview reads every other leg from last week's report, so on a
  // network that is not changing it has to land on the tick.
  const st0 = hub({ over: seats });
  const st = { ...st0, lastReport: weeklyTick(st0) };
  const tick = weeklyTick(st);
  let worstPax = 0, worstRev = 0, checked = 0;
  for (const route of st.routes.filter((_, k) => k % 6 === 0)) {
    const rr = tick.routeResults.find(x => x.routeId === route.id);
    const proj = projectRouteAddition(st, {
      origin: route.origin, destination: route.destination, aircraft: st.fleet.find(a => a.id === route.aircraftId),
      weeklyFrequency: route.weeklyFrequency, ticketPrice: route.ticketPrice,
      classPrices: st.routePricing[[route.origin, route.destination].sort().join('-')], replacesRouteId: route.id,
    });
    const booked  = rr.passengers + rr.connecting.totalPax;
    const quoted  = proj.mature.passengers + proj.connecting.totalPax;
    const bookedR = rr.revenue, quotedR = proj.mature.revenue + proj.connecting.totalRevenue;
    worstPax = Math.max(worstPax, Math.abs(quoted - booked) / booked);
    worstRev = Math.max(worstRev, Math.abs(quotedR - bookedR) / bookedR);
    checked++;
  }
  assert.ok(checked >= 8);
  assert.ok(worstPax < 0.03, `passengers off by up to ${(worstPax * 100).toFixed(1)}%`);
  assert.ok(worstRev < 0.03, `revenue off by up to ${(worstRev * 100).toFixed(1)}%`);
});

await test('the preview shows the locals a new connection would displace, net', () => {
  const st0 = hub({ over: seats });
  const st = { ...st0, lastReport: weeklyTick(st0) };
  const route = st.routes.find(r => (st.lastReport.routeResults.find(x => x.routeId === r.id)?.connecting.displacedPax ?? 0) > 0);
  assert.ok(route, 'fixture displaced nobody');
  const proj = projectRouteAddition(st, {
    origin: route.origin, destination: route.destination, aircraft: st.fleet.find(a => a.id === route.aircraftId),
    weeklyFrequency: route.weeklyFrequency, ticketPrice: route.ticketPrice,
    classPrices: st.routePricing[[route.origin, route.destination].sort().join('-')], replacesRouteId: route.id,
  });
  const c = proj.connecting;
  assert.ok(c.displacedPax > 0, 'the preview displaced nobody on a route the tick did');
  assert.equal(c.totalPax, c.externalPax + c.itineraryPax - c.displacedPax);
  assert.equal(c.totalRevenue, c.externalRevenue + c.itineraryRevenue - c.displacedRevenue);
  assert.ok(c.totalRevenue > 0, 'the connections it quoted lose money against the locals');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} connection-seats: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
