// Sanity test for the rebuilt partner O&D revenue model.
// Reproduces a "player hub + several partners feeding it" network, then compares
// the OLD full-market-grab formula against the NEW competitive-logit model.
//
// Run: node tools/partner-od-test.mjs

import {
  buildPartnershipMap,
  buildAllConnections,
  buildCompetitorRouteIndex,
  computePartnerODRevenue,
  PRORATE_FLOOR,
} from '../src/models/network.js';
import {
  COMPETITOR_AIRLINES,
  initializeCompetitorRoutes,
} from '../src/models/demand.js';
import { routeDistance } from '../src/utils/market.js';

// ── Build the competitor universe with their default route networks ──────────
const competitors = COMPETITOR_AIRLINES.map(c => ({ ...c, routes: {} }));
initializeCompetitorRoutes(competitors);

// ── Player: a JFK hub-and-spoke carrier ──────────────────────────────────────
const HUB = 'JFK';
const spokes = ['LAX', 'MIA', 'ORD', 'SFO', 'BOS', 'CDG', 'LHR'];
const playerRoutes = spokes.flatMap(s => ([
  { origin: HUB, destination: s, owner: 'player', weeklyFrequency: 14, price: 380 },
  { origin: s, destination: HUB, owner: 'player', weeklyFrequency: 14, price: 380 },
]));

// ── Partner with a handful of carriers that also touch the player's network ──
const partnerIds = ['globalair', 'continentalx', 'euroconnect', 'apexair'];
const partnershipMap = buildPartnershipMap(
  null,                                   // allianceMembership
  partnerIds.map(id => ({ competitorId: id })), // codeshareAgreements
  null,                                   // allianceDef
  {},                                     // jointVentures
);

// ── Build connections + indices ──────────────────────────────────────────────
const connections = buildAllConnections(playerRoutes, competitors, partnershipMap);
const competitorRouteIndex = buildCompetitorRouteIndex(competitors);

const mixed = connections.filter(
  c => (c.leg1Owner === 'player') !== (c.leg2Owner === 'player'),
);

// ── OLD model (the bug): book ~100% of every city-pair market ────────────────
function oldModel(conns, loadFactor = 0.72) {
  let total = 0;
  for (const conn of conns) {
    const mixedLegs = (conn.leg1Owner === 'player') !== (conn.leg2Owner === 'player');
    if (!mixedLegs) continue;
    const pax = Math.round(conn.odDemand * conn.connectionShare * loadFactor);
    if (pax <= 0) continue;
    const playerLeg = conn.leg1Owner === 'player' ? 'leg1' : 'leg2';
    const pOrigin = playerLeg === 'leg1' ? conn.legOneOrigin : conn.hub;
    const pDest   = playerLeg === 'leg1' ? conn.hub : conn.legTwoDest;
    const pMiles = routeDistance(pOrigin, pDest);
    const tMiles = routeDistance(conn.legOneOrigin, conn.legTwoDest);
    if (!pMiles || !tMiles) continue;
    const prorate = Math.max(pMiles / tMiles,
      PRORATE_FLOOR[conn.partnershipType] ?? PRORATE_FLOOR.interline);
    total += Math.round(pax * conn.totalPrice * prorate);
  }
  return total;
}

const oldTotal = oldModel(mixed);
const next = computePartnerODRevenue(connections, {
  gameDate: { month: 6 },
  competitorRouteIndex,
});

// ── Report ───────────────────────────────────────────────────────────────────
const fmt = n => '$' + (n / 1e6).toFixed(2) + 'M';
const shares = next.entries.map(e => e.capturedShare);
const maxShare = shares.length ? Math.max(...shares) : 0;
const avgShare = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;

console.log('Mixed-leg partner connections:', mixed.length);
console.log('Priced entries (new model):   ', next.entries.length);
console.log('');
console.log('OLD partner O&D / week:', fmt(oldTotal));
console.log('NEW partner O&D / week:', fmt(next.totalRevenue));
console.log('Reduction:             ', (oldTotal / Math.max(next.totalRevenue, 1)).toFixed(1) + '×');
console.log('');
console.log('Captured share — max:', (maxShare * 100).toFixed(1) + '%',
            ' avg:', (avgShare * 100).toFixed(1) + '%');
console.log('');
console.log('Top 5 partner O&D entries:');
[...next.entries].sort((a, b) => b.playerRevenue - a.playerRevenue).slice(0, 5)
  .forEach(e => console.log(
    `  ${e.odKey.padEnd(9)} via ${e.hub}  pax ${String(e.pax).padStart(4)}  ` +
    `share ${(e.capturedShare * 100).toFixed(1).padStart(4)}%  rev ${fmt(e.playerRevenue)}  [${e.partnershipType}]`,
  ));

// ── Assertions ────────────────────────────────────────────────────────────────
let failures = 0;
function assert(cond, msg) { if (!cond) { console.error('  ✗ FAIL:', msg); failures++; } else { console.log('  ✓', msg); } }
// Aggregate player share per O&D market must stay below 100% (no over-booking).
const shareByOD = {};
for (const e of next.entries) shareByOD[e.odKey] = (shareByOD[e.odKey] ?? 0) + e.capturedShare;
const maxODShare = Math.max(0, ...Object.values(shareByOD));

console.log('\nChecks:');
assert(maxODShare < 1.0, `combined player share per O&D < 100% (max ${(maxODShare*100).toFixed(1)}%)`);
assert(maxShare < 1.0, 'no single routing captures the entire market (share < 100%)');
assert(maxShare <= 0.95, 'max captured share is realistically bounded (≤95%)');
assert(next.totalRevenue < oldTotal, 'new total is below the old full-market figure');
assert(next.entries.every(e => e.pax >= 0), 'no negative pax');
assert(next.totalRevenue > 0, 'partner feed still produces positive revenue');
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
