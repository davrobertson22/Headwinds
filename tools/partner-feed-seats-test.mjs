// Partner feed sits in real seats — HUB_CONNECTIVITY_PLAN.md Phase 2 (as decided).
//
// Feed onto your legs comes from PARTNERS only: alliance, codeshare, joint
// venture, at their real partnership tier. A stranger's passengers do not
// through-connect onto you (Dave, 2026-09-05: "shouldn't it only work for
// partners you have an alliance or partnership agreement with?") — that
// residual is what the gateway pool has always represented. What Phase 2 keeps:
//
//   1. Partner-fed passengers occupy the seats of YOUR leg of the itinerary and
//      are scaled by the seats left after direct passengers, exactly like
//      own-metal and gateway feed. Before, partner revenue rode above the seat
//      count — free money on a full aircraft.
//   2. One pair, one feed: two tails on a pair were each credited the whole
//      pair's itinerary feed. Each takes its share of the pair's seats.
//   3. No feed from a carrier you have no agreement with.
//
//   node --import ./tools/_register-loader.mjs tools/partner-feed-seats-test.mjs

import assert from 'node:assert/strict';
import { buildAllConnections, runNetworkTick } from '../packages/engine/src/models/network.js';
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
const R1 = rival('r1', 'AMS', ['AMS-LHR', 'AMS-MAD']);
const PLAYER = [
  { id: 'a', origin: 'LHR', destination: 'JFK', weeklyFrequency: 14, ticketPrice: referencePrice('LHR', 'JFK') },
  { id: 'b', origin: 'LHR', destination: 'DXB', weeklyFrequency: 14, ticketPrice: referencePrice('LHR', 'DXB') },
];
const HUBS = { LHR: { tier: 2, tierSince: 0 } };

console.log('\n── who feeds you ────────────────────────');

test('a codeshare partner\'s leg into your hub forms a connection; a stranger\'s does not', () => {
  const partner = buildAllConnections(PLAYER, [R1], new Map([['r1', 'codeshare']]));
  assert.ok(partner.some(c => c.legOneOrigin === 'AMS' && c.hub === 'LHR' && c.partnershipType === 'codeshare'));
  const stranger = buildAllConnections(PLAYER, [R1], new Map());
  assert.equal(stranger.filter(c => c.leg1Owner === 'partner' || c.leg2Owner === 'partner').length, 0,
    'no agreement, no feed — the gateway pool carries the residual');
});

test('rival itineraries being on does not create feed from strangers', () => {
  const on = runNetworkTick({ routes: PLAYER, competitors: [R1], hubs: HUBS, gates: { LHR: 20 },
    routeCountByAirport: { LHR: 2 }, rivalIndex: new Map() });
  assert.equal(on.partnerODRevenue.totalPax, 0);
});

console.log('\n── seats ────────────────────────────────');

const small = getAircraftType('atr72') ?? getAircraftType('dash8q400') ?? getAircraftType('crj900') ?? getAircraftType('a320neo');
const mk = (id, t) => ({ id, typeId: t.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(t.seats), ownershipType: 'owned' });
// The partner (codeshare with r1) feeds AMS→LHR→DUB onto the player's LHR–DUB.
const base = (fareMult, tails = 1) => ({
  fleet: Array.from({ length: tails }, (_, i) => mk(`p${i}`, small)),
  routes: Array.from({ length: tails }, (_, i) => ({ id: `a${i}`, origin: 'LHR', destination: 'DUB', aircraftId: `p${i}`, weeklyFrequency: 7 })),
  cargoRoutes: [], gameDate: { week: 1, month: 6 }, gates: { LHR: 12, DUB: 4 }, hubs: HUBS,
  routePricing: { 'DUB-LHR': defaultClassPrices(Math.round(referencePrice('LHR', 'DUB') * fareMult)) },
  routeCatering: {}, competitors: [R1], labor: undefined,
  codeshareAgreements: [{ competitorId: 'r1', weeklyFee: 0 }],
  rivalItineraries: true,   // the hub-connectivity package is on (seated feed is part of it)
});

test('partner-fed passengers occupy real seats — a full leg scales its feed down', () => {
  const full = weeklyTick(base(0.8));
  const leg = full.routeResults.find(x => x.routeId === 'a0');
  assert.ok(leg, 'route simulated');
  assert.ok(leg.loadFactor >= 0.94, `fixture: the small aircraft should be full (LF ${leg.loadFactor})`);
  assert.ok((full.partnerODRevenue?.totalPax ?? 0) <= 5, `no seats → no partner pax, got ${full.partnerODRevenue?.totalPax}`);
  const roomy = weeklyTick(base(3.4));
  const leg2 = roomy.routeResults.find(x => x.routeId === 'a0');
  assert.ok(leg2.loadFactor < 0.9, `fixture: room on board (LF ${leg2.loadFactor})`);
  assert.ok((roomy.partnerODRevenue?.totalPax ?? 0) > 0, 'partner feed boards when there are seats');
  assert.ok(leg2.connecting.partnerPax > 0 && leg2.connecting.partnerRevenue > 0, 'and is reported on the leg');
  assert.equal(roomy.partnerODRevenue.totalPax, leg2.connecting.partnerPax, 'report total == what the leg seated');
});

test('one pair, one feed — two tails on a pair share it, they do not each get all of it', () => {
  const one = weeklyTick(base(3.4, 1));
  const two = weeklyTick(base(3.4, 2));
  const sum = (r) => r.routeResults.reduce((s, x) => s + (x.connecting?.partnerPax ?? 0), 0);
  assert.ok(sum(one) > 0);
  assert.ok(sum(two) <= sum(one) * 1.05, `two tails booked ${sum(two)} partner pax vs ${sum(one)} with one — the pair's feed was duplicated`);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
