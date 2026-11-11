// The jet age (packages/engine/src/models/jetAge.js) and the Original 737s.
//
// Discord (Kat the Fox, 2026-11-03, Timely Takeoff):
//   "Where 737-100 and -200 in Timely takeoff? It should show up since the 100
//    and 200 showed up in '68 but all we get is a redundant tupolev"
//   "I also have noticed the lack of obsolescence for long range turboprop
//    flights. It's the last week of '66 and the #1 airline has 0 jets. But 406
//    vanguards."
//
// On HEAD a Vanguard on a long sector in 1966 carried exactly what it carried
// in 1957, and the catalogue's only Original 737 was the 1971 -200 Advanced
// (tools/_probe/jet-age-head-probe.mjs reproduces both on the HEAD engine).
//
//   node tools/jet-age-test.mjs

import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { computeMarketShare, buildRouteMarket } from '../packages/engine/src/models/demand.js';
import { setEraCalendarYear, referencePrice } from '../packages/engine/src/utils/market.js';
import { simulateRoute, routeDistanceKm, defaultClassPrices, routeQualityBreakdown } from '../packages/engine/src/utils/simulation.js';
import { projectWeek } from '../packages/engine/src/utils/financeProjection.js';
import { buildEncroachmentOffer } from '../packages/engine/src/models/encroachment.js';
import { projectRouteAddition } from '../packages/engine/src/models/pairShare.js';
import { AIRCRAFT_TYPES, getAircraftType, aircraftAvailability } from '../packages/engine/src/data/aircraft.js';
import { lineOf as productionLineOf } from '../packages/engine/src/data/productionLines.js';
import { buildRivalViews } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import {
  jetAgeAppeal, blendJetAgeAppeal, offersJetAgeCapture, JET_AGE_MAX_LOSS,
} from '../packages/engine/src/models/jetAge.js';

let passed = 0, failed = 0;
const realRandom = Math.random;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
  finally { setEraCalendarYear(null); Math.random = realRandom; }
}

const T = (id) => getAircraftType(id);
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

await test('the appeal curve: props on long sectors once jets are established, nothing else', () => {
  assert.equal(jetAgeAppeal(T('vanguard'), 2000, null), 1, 'classic world (no era calendar)');
  assert.equal(jetAgeAppeal(T('vanguard'), 2000, 1957), 1, 'before the 707');
  assert.equal(jetAgeAppeal(T('vanguard'), 2000, 1966), 1 - JET_AGE_MAX_LOSS, 'full jet age, long sector');
  assert.equal(jetAgeAppeal(T('vanguard'), 350, 1966), 1, 'a short hop stays a prop market');
  assert.ok(jetAgeAppeal(T('vanguard'), 1000, 1966) > 0.65 && jetAgeAppeal(T('vanguard'), 1000, 1966) < 1, 'ramps with distance');
  assert.ok(jetAgeAppeal(T('vanguard'), 2000, 1961) > 0.65, 'ramps with the calendar');
  assert.equal(jetAgeAppeal(T('caravelle'), 2000, 1966), 1, 'jets are untouched');
  assert.equal(jetAgeAppeal(T('dc3'), 2000, 1966) < 1, true, 'pistons count as props too');
  const prFreighter = AIRCRAFT_TYPES.find(t => t.freighter && t.category === 'Turboprop');
  if (prFreighter) assert.equal(jetAgeAppeal(prFreighter, 2000, 1966), 1, `freight does not care (${prFreighter.id})`);
  assert.equal(blendJetAgeAppeal([{ type: T('vanguard'), freq: 7 }, { type: T('caravelle'), freq: 7 }], 2000, 1966),
    +(1 - JET_AGE_MAX_LOSS / 2).toFixed(4), 'a half-jet schedule sits halfway');
});

// A thin 2,000 km market so nobody is capacity-bound.
const market = () => ({ ...buildRouteMarket('LHR', 'ATH', { month: 6 }) });
const offer = (id, extra = {}) => ({
  airlineId: id, origin: 'LHR', destination: 'ATH', economyPrice: referencePrice('LHR', 'ATH'), businessPrice: null,
  weeklyFrequency: 7, seatsPerFlight: 139, economySeats: 1e9, businessSeats: 0, totalSeats: 1e9,
  qualityScore: 60, qualityScoreLeisure: 60, qualityScoreBusiness: 60, connectivityBonus: 0, ...extra,
});

await test('a prop alone on a long sector reaches 65% of the market a jet would', () => {
  const m = market();
  const jet  = computeMarketShare(m, [offer('a')])[0];
  const prop = computeMarketShare(m, [offer('a', { jetAgeAppeal: 0.65 })])[0];
  assert.ok(jet.totalPax ?? jet.passengers, 'fixture');
  const pj = jet.totalPax ?? (jet.leisurePax + jet.businessPax), pp = prop.totalPax ?? (prop.leisurePax + prop.businessPax);
  close(pp / pj, 0.65, 0.02, 'prop/jet passengers');
});

await test('against a jet the prop keeps ~39%, and nobody is turned away', () => {
  const m = market();
  const both = computeMarketShare(m, [offer('prop', { jetAgeAppeal: 0.65 }), offer('jet', { airlineId: 'jet' })]);
  const twinJets = computeMarketShare(m, [offer('a'), offer('b', { airlineId: 'b' })]);
  const pax = (r) => r.totalPax ?? (r.leisurePax + r.businessPax);
  const total = pax(both[0]) + pax(both[1]), totalJets = pax(twinJets[0]) + pax(twinJets[1]);
  close(total / totalJets, 1, 0.02, 'the pair carries what two jets would');
  close(pax(both[0]) / total, 0.65 / 1.65, 0.03, 'prop share');
  assert.equal(offersJetAgeCapture([{ jetAgeAppeal: 0.65 }, {}]), 1);
  assert.equal(offersJetAgeCapture([{ jetAgeAppeal: 0.65 }, { jetAgeAppeal: 0.8 }]), 0.8, 'two props reach what the better one reaches');
});

await test('simulateRoute: a Vanguard on a long sector books less in 1966 than in 1957 (the HEAD call path)', () => {
  const ac = { id: 'v', typeId: 'vanguard', ageWeeks: 0 };
  const route = { origin: 'EDI', destination: 'PMI', aircraftId: 'v', weeklyFrequency: 7,
    ticketPrice: Math.round(referencePrice('EDI', 'PMI') * 1.3) };
  setEraCalendarYear(1957);
  const before = simulateRoute(route, ac);
  setEraCalendarYear(1966);
  const after = simulateRoute(route, ac);
  assert.ok(before.passengers < 139 * 7, `fixture must be demand-limited: ${before.passengers}`);
  assert.ok(after.passengers < before.passengers * 0.75,
    `1966 ${after.passengers} pax vs 1957 ${before.passengers}`);
  setEraCalendarYear(1966);
  const jet = simulateRoute({ ...route, aircraftId: 'c' }, { id: 'c', typeId: 'caravelle', ageWeeks: 0 });
  setEraCalendarYear(1957);
  const jet57 = simulateRoute({ ...route, aircraftId: 'c' }, { id: 'c', typeId: 'caravelle', ageWeeks: 0 });
  assert.equal(jet.passengers, jet57.passengers, 'a jet books the same either side of the transition');
});

// An era airline flying one type, re-badged straight onto the fleet: an open era
// world refuses a lease on a type in its first ten years and a classic one
// won't lease a Vanguard, so the tails are leased as E175s and swapped.
function eraAirline({ name, hub, typeId, dests, calYear = 1966, spare = null }) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub, enableObjectives: false });
  s = { ...s, cash: 5e8, multiplayer: true, competitors: [], humanRivals: {}, encroachments: {} };
  for (const d of dests) {
    s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: 'e175' });
    const ac = s.fleet[s.fleet.length - 1].id;
    s = { ...s, fleet: s.fleet.map(a => (a.id === ac ? { ...a, typeId, config: undefined } : a)) };
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: d });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac, origin: hub, destination: d, weeklyFrequency: 7 });
  }
  if (spare) {   // an unassigned tail, leased before the calendar moves to the era
    s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: 'e175' });
    const ac = s.fleet[s.fleet.length - 1].id;
    s = { ...s, fleet: s.fleet.map(a => (a.id === ac ? { ...a, typeId: spare, config: undefined, spare: true } : a)) };
  }
  const routePricing = { ...s.routePricing };
  for (const d of dests) routePricing[[hub, d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(hub, d) * 1.3));
  return { ...s, routePricing, startYear: 1950, year: calYear - 1949, week: 10 };
}

await test('the server ships a Vanguard rival\'s jet-age appeal on its spec; a Caravelle rival ships none', () => {
  const props = eraAirline({ name: 'Props', hub: 'LHR', typeId: 'vanguard', dests: ['ATH', 'EDI'] });
  const jets  = eraAirline({ name: 'Jets', hub: 'ATH', typeId: 'caravelle', dests: ['LHR'] });
  assert.equal(props.routes.length, 2, `fixture: ${props.error ?? ''}`);
  setEraCalendarYear(2026);   // a stale module-global from another world must not leak in
  const views = buildRivalViews([
    { id: 'p', worldId: 'w', name: 'Props', hub: 'LHR', status: 'ACTIVE', state: props },
    { id: 'j', worldId: 'w', name: 'Jets',  hub: 'ATH', status: 'ACTIVE', state: jets },
  ]);
  const seenByJets = views.get('j').humanRivals;
  const ath = seenByJets[['ATH', 'LHR'].sort().join('-')];
  const spec = (Array.isArray(ath) ? ath : [ath]).find(Boolean);
  assert.ok(spec, `no spec for LHR–ATH: ${JSON.stringify(Object.keys(seenByJets))}`);
  assert.equal(spec.jetAgeAppeal, jetAgeAppeal(T('vanguard'), routeDistanceKm('LHR', 'ATH'), 1966));
  const seenByProps = views.get('p').humanRivals[['ATH', 'LHR'].sort().join('-')];
  assert.equal((Array.isArray(seenByProps) ? seenByProps : [seenByProps])[0].jetAgeAppeal, undefined, 'a jet rival is parity');
  setEraCalendarYear(1966);
  const m = buildRouteMarket('LHR', 'ATH', { month: 6 });
  assert.equal(buildEncroachmentOffer(spec, m)?.jetAgeAppeal, spec.jetAgeAppeal, 'the spec reaches the offer');
});

await test('the forecast agrees with the tick for a Vanguard airline against a Caravelle rival in 1966', () => {
  let props = eraAirline({ name: 'Props', hub: 'LHR', typeId: 'vanguard', dests: ['ATH', 'EDI', 'FCO'] });
  const jets = eraAirline({ name: 'Jets', hub: 'ATH', typeId: 'caravelle', dests: ['LHR'] });
  const views = buildRivalViews([
    { id: 'p', worldId: 'w', name: 'Props', hub: 'LHR', status: 'ACTIVE', state: props },
    { id: 'j', worldId: 'w', name: 'Jets',  hub: 'ATH', status: 'ACTIVE', state: jets },
  ]);
  props = { ...props, competitors: views.get('p').competitors, humanRivals: views.get('p').humanRivals };
  Math.random = () => 0.9999999;
  for (let i = 0; i < 2; i++) props = gameReducer(props, { type: 'ADVANCE_WEEK' });
  const proj = projectWeek(props);
  const next = gameReducer(props, { type: 'ADVANCE_WEEK' });
  const byId = (rep) => new Map((rep?.routeResults ?? []).map(x => [x.routeId, x]));
  const P = byId(proj.report), A = byId(next.lastReport);
  assert.ok(A.size >= 3, `expected 3 flown routes, got ${A.size}`);
  for (const [id, a] of A) {
    assert.equal(P.get(id)?.passengers, a.passengers, `route ${id}: projected ${P.get(id)?.passengers}, flew ${a.passengers}`);
  }
  // …and the route screen can explain it.
  const r = props.routes.find(x => x.destination === 'ATH');
  const qb = routeQualityBreakdown(r, props.fleet.find(a => a.id === r.aircraftId), props);
  assert.equal(qb.jetAgeAppeal, jetAgeAppeal(T('vanguard'), routeDistanceKm('LHR', 'ATH'), 1966));
});

await test('the Route Planner forecasts a jet joining a Vanguard pair the way the tick flies it', () => {
  let props = eraAirline({ name: 'Props', hub: 'LHR', typeId: 'vanguard', dests: ['ATH', 'EDI'], spare: 'caravelle' });
  props = { ...props, routes: props.routes.map(r => ({ ...r, weeksOpen: 40 })) };
  const jets = eraAirline({ name: 'Jets', hub: 'ATH', typeId: 'caravelle', dests: ['LHR'] });
  const views = buildRivalViews([
    { id: 'p', worldId: 'w', name: 'Props', hub: 'LHR', status: 'ACTIVE', state: props },
    { id: 'j', worldId: 'w', name: 'Jets',  hub: 'ATH', status: 'ACTIVE', state: jets },
  ]);
  props = { ...props, competitors: views.get('p').competitors, humanRivals: views.get('p').humanRivals };
  const tail = props.fleet.find(a => a.spare), id = tail.id;
  assert.equal(props.fleet.length, 3, 'fixture: two Vanguards and a spare Caravelle');
  Math.random = () => 0.9999999;
  props = gameReducer(props, { type: 'ADVANCE_WEEK' });
  const key = ['ATH', 'LHR'].sort().join('-');
  const planned = projectRouteAddition(props, { origin: 'LHR', destination: 'ATH', aircraft: tail, weeklyFrequency: 7,
    classPrices: props.routePricing[key] });
  assert.ok(planned?.shared, 'the planner should see the pair as shared with the Vanguard');
  let t = gameReducer(props, { type: 'ADD_ROUTE', aircraftId: id, origin: 'LHR', destination: 'ATH', weeklyFrequency: 7 });
  assert.ok(t.routes.some(r => r.aircraftId === id), `route did not open: ${t.error ?? ''}`);
  t = { ...t, routes: t.routes.map(r => ({ ...r, weeksOpen: 40 })) };
  const next = gameReducer(t, { type: 'ADVANCE_WEEK' });
  const onPair = new Set(t.routes.filter(r => [r.origin, r.destination].sort().join('-') === key).map(r => r.id));
  const flown = next.lastReport.routeResults.filter(x => onPair.has(x.routeId)).reduce((n, x) => n + x.passengers, 0);
  const got = planned.mature?.pairPassengers ?? planned.pairPassengers;
  assert.ok(Math.abs(got - flown) <= Math.max(3, flown * 0.02), `planner ${got} pax on the pair vs tick ${flown}`);
});

await test('the Original 737s: -100 and -200 from 1968, on one Renton line', () => {
  for (const id of ['b737100', 'b737200']) {
    assert.equal(aircraftAvailability(T(id), 1967), 'future', `${id} in 1967`);
    assert.equal(aircraftAvailability(T(id), 1968), 'new', `${id} in 1968`);
  }
  assert.equal(aircraftAvailability(T('b737100'), 1970), 'used', 'the -100 line closed in 1969');
  assert.equal(aircraftAvailability(T('b737200'), 1985), 'new', 'the -200 (Advanced from 1971) ran to 1988');
  assert.equal(productionLineOf?.('b737100'), productionLineOf?.('b737200'), 'same production line');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
