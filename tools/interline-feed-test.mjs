// Interline feed from real rival legs — HUB_CONNECTIVITY_PLAN.md Phase 2.
//
// The "gateway pool" (AIRPORT_GATEWAY_SCORES × 800 × captureRate …) has been
// the game's only representation of OTHER carriers' passengers connecting onto
// yours. With rival networks now real data, the modeled half of that feed can
// be real itineraries: a non-partner rival's leg A→H arriving at YOUR designated
// hub H, joined to your leg H→C, sold as a bare interline connection (penalty
// .75, prorate floor .38) through computePartnerODRevenue — the same rails
// alliance and codeshare feed already ride. Gated on state.rivalItineraries.
// The gateway pool then shrinks to the residual "world beyond modeled carriers"
// (GATEWAY_RESIDUAL), and partner-fed passengers finally occupy real seats.
//
//   node --import ./tools/_register-loader.mjs tools/interline-feed-test.mjs

import assert from 'node:assert/strict';
import {
  buildAllConnections, buildInterlineLegs, computePartnerODRevenue, runNetworkTick,
} from '../packages/engine/src/models/network.js';
import { computeConnectingDemand, GATEWAY_RESIDUAL } from '../packages/engine/src/models/demand.js';
import { weeklyTick, defaultConfig, defaultClassPrices } from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const rival = (id, homeHub, pairs, over = {}) => ({
  id, name: id, homeHub, tier: 'legacy', baseQualityScore: 70, cash: 1e8,
  routes: Object.fromEntries(pairs.map(k => [k.split('-').sort().join('-'), { frequency: 14, priceMultiplier: 1.0, ...over }])),
});
// Two rivals both flying AMS–LHR into the player's LHR hub; one also flies BOS–LHR.
const R1 = rival('r1', 'AMS', ['AMS-LHR', 'AMS-MAD']);
const R2 = rival('r2', 'BOS', ['LHR-BOS', 'AMS-LHR'], { frequency: 7 });
const PLAYER = [
  { id: 'a', origin: 'LHR', destination: 'JFK', weeklyFrequency: 14, ticketPrice: referencePrice('LHR', 'JFK') },
  { id: 'b', origin: 'LHR', destination: 'DXB', weeklyFrequency: 14, ticketPrice: referencePrice('LHR', 'DXB') },
];
const HUBS = { LHR: { tier: 2, tierSince: 0 } };
const noPartners = new Map();

console.log('\n── interline legs ───────────────────────');

test('non-partner rival legs touching a DESIGNATED player hub become interline legs, one per carrier', () => {
  const legs = buildInterlineLegs([R1, R2], noPartners, HUBS);
  const amsLhr = legs.filter(l => l.routeKey === 'AMS-LHR');
  assert.equal(amsLhr.length, 4, 'two rivals × two directions');
  assert.deepEqual(amsLhr.map(l => l.weeklyFrequency).sort((a, b) => a - b), [7, 7, 14, 14]);
  assert.ok(amsLhr.every(l => l.partnershipType === 'interline' && l.owner === 'partner' && l.interline));
  assert.ok(legs.some(l => l.routeKey === 'BOS-LHR' && l.partnerId === 'r2'));
  assert.ok(!legs.some(l => l.routeKey === 'AMS-MAD'), 'a rival leg touching no player hub is not feed');
});

test('a partner\'s legs are not duplicated as interline', () => {
  const partners = new Map([['r1', 'codeshare']]);
  const legs = buildInterlineLegs([R1, R2], partners, HUBS);
  const amsLhr = legs.filter(l => l.routeKey === 'AMS-LHR' && l.origin === 'AMS');
  assert.equal(amsLhr.length, 1);
  assert.equal(amsLhr[0].partnerId, 'r2', 'only the non-partner rival remains');
});

test('no designated hub → no interline legs', () => {
  assert.equal(buildInterlineLegs([R1, R2], noPartners, {}).length, 0);
});

console.log('\n── connections & revenue ────────────────');

test('an interline connection forms over the designated hub and nowhere else', () => {
  const conns = buildAllConnections(PLAYER, [R1, R2], noPartners, { hubs: HUBS, interline: true });
  const inter = conns.filter(c => c.partnershipType === 'interline');
  assert.ok(inter.length > 0, 'AMS→LHR→JFK / DXB and BOS→LHR→DXB should exist');
  assert.ok(inter.every(c => c.hub === 'LHR'));
  assert.ok(inter.some(c => c.legOneOrigin === 'AMS' && c.legTwoDest === 'JFK'));
  const off = buildAllConnections(PLAYER, [R1, R2], noPartners, { hubs: HUBS, interline: false });
  assert.equal(off.filter(c => c.partnershipType === 'interline').length, 0, 'gated');
});

test('a rival that flies the onward leg itself keeps its passengers — no interline over you', () => {
  // R3 flies AMS–LHR AND LHR–JFK: its Amsterdam passengers to New York connect
  // on ITS metal (a Phase-1b rival one-stop), not on yours. AMS→LHR→DXB, which
  // it cannot carry alone, still feeds you.
  const R3 = rival('r3', 'AMS', ['AMS-LHR', 'LHR-JFK']);
  const conns = buildAllConnections(PLAYER, [R3], noPartners, { hubs: HUBS, interline: true })
    .filter(c => c.partnershipType === 'interline' && c.legOneOrigin === 'AMS');
  assert.ok(!conns.some(c => c.legTwoDest === 'JFK'), 'AMS→LHR→JFK on R3 + you must not exist');
  assert.ok(conns.some(c => c.legTwoDest === 'DXB'), 'AMS→LHR→DXB does');
});

test('two rivals feeding the same hub are two routings in the market, not one', () => {
  const conns = buildAllConnections(PLAYER, [R1, R2], noPartners, { hubs: HUBS, interline: true });
  const rev = computePartnerODRevenue(conns, {});
  const amsDxb = rev.entries.filter(e => e.origin === 'AMS' && e.dest === 'DXB');
  assert.equal(amsDxb.length, 2, `expected r1 and r2 routings on AMS→DXB, got ${amsDxb.length}`);
});

test('interline feed earns the player a prorated share, floored at the interline prorate', () => {
  const conns = buildAllConnections(PLAYER, [R1, R2], noPartners, { hubs: HUBS, interline: true });
  const rev = computePartnerODRevenue(conns, {});
  assert.ok(rev.totalRevenue > 0 && rev.totalPax > 0);
  for (const e of rev.entries) {
    assert.equal(e.partnershipType, 'interline');
    assert.ok(e.origin && e.dest, 'entries carry direction so the tick can seat them on the player leg');
    assert.ok(e.playerRevenue > 0);
  }
});

test('runNetworkTick wires it through, gated on the rival index', () => {
  const on = runNetworkTick({ routes: PLAYER, competitors: [R1, R2], hubs: HUBS, gates: { LHR: 20 },
    routeCountByAirport: { LHR: 2 }, rivalIndex: new Map() /* truthy = on */, interlineFeed: true });
  const off = runNetworkTick({ routes: PLAYER, competitors: [R1, R2], hubs: HUBS, gates: { LHR: 20 }, routeCountByAirport: { LHR: 2 } });
  assert.ok(on.partnerODRevenue.totalPax > 0, 'interline feed on');
  assert.equal(off.partnerODRevenue.totalPax, 0, 'no partners, no flag → no feed');
});

console.log('\n── the gateway pool becomes a residual ──');

test('GATEWAY_RESIDUAL scales the external pool only when rival itineraries are on', () => {
  assert.ok(GATEWAY_RESIDUAL > 0 && GATEWAY_RESIDUAL <= 1);
  const args = ['LHR', 'JFK', HUBS, 100, 20, referencePrice('LHR', 'JFK')];
  const base = computeConnectingDemand(...args, { weeklyFrequency: 14, gates: { LHR: 20 } });
  const scaled = computeConnectingDemand(...args, { weeklyFrequency: 14, gates: { LHR: 20 }, gatewayResidual: GATEWAY_RESIDUAL });
  assert.ok(base.totalPax > 0);
  assert.ok(Math.abs(scaled.totalPax / base.totalPax - GATEWAY_RESIDUAL) < 0.03,
    `residual pool should be ${GATEWAY_RESIDUAL}× the classic pool, got ${(scaled.totalPax / base.totalPax).toFixed(3)}`);
});

console.log('\n── seats ────────────────────────────────');

test('partner-fed passengers occupy real seats — a full leg scales its feed down', () => {
  // A small aircraft on LHR–DUB at a low fare fills on direct demand alone; the
  // interline feed AMS→LHR→DUB (Rhine's AMS–LHR leg + the player's) then has
  // no seats and must be scaled to ~0 — not carried free above the seat count.
  const small = getAircraftType('atr72') ?? getAircraftType('dash8q400') ?? getAircraftType('crj900') ?? getAircraftType('a320neo');
  const mk = (id, t) => ({ id, typeId: t.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(t.seats), ownershipType: 'owned' });
  const fare = (m) => defaultClassPrices(Math.round(referencePrice('LHR', 'DUB') * m));
  const base = (m) => ({
    fleet: [mk('p1', small)], routes: [{ id: 'a', origin: 'LHR', destination: 'DUB', aircraftId: 'p1', weeklyFrequency: 7 }],
    cargoRoutes: [], gameDate: { week: 1, month: 6 }, gates: { LHR: 12, DUB: 2 }, hubs: HUBS,
    routePricing: { 'DUB-LHR': fare(m) }, routeCatering: {}, competitors: [R1, R2], labor: undefined, rivalItineraries: true,
  });
  const full = weeklyTick(base(0.8));
  const leg = full.routeResults.find(x => x.routeId === 'a');
  assert.ok(leg, 'route simulated');
  assert.ok(leg.loadFactor >= 0.94, `fixture: the small aircraft should be full (LF ${leg.loadFactor})`);
  assert.ok((full.partnerODRevenue?.totalPax ?? 0) <= 5, `no seats → no interline pax, got ${full.partnerODRevenue?.totalPax}`);
  // Priced up so the aircraft has room: the same feed now boards.
  const roomy = weeklyTick(base(3.4));
  const leg2 = roomy.routeResults.find(x => x.routeId === 'a');
  assert.ok(leg2.loadFactor < 0.9, `fixture: room on board (LF ${leg2.loadFactor})`);
  assert.ok((roomy.partnerODRevenue?.totalPax ?? 0) > 0, 'interline feed boards when there are seats');
  assert.ok(leg2.connecting.partnerPax > 0 && leg2.connecting.partnerRevenue > 0, 'and is reported on the leg');
  assert.equal(roomy.partnerODRevenue.totalPax, leg2.connecting.partnerPax, 'report total == what the legs seated');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
