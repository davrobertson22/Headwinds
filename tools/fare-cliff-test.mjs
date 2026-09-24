// Fare cliff: bulk reset to reference, and warnings that name the NWR yield
// choke before a fare lands past it (models/fareCliff.js).
//
// Regression for 2026-09-24, Piston Age: one BULK_ADJUST_PRICING +50% on all
// 266 routes put every pair at ~1.53x reference, the NWR choke cut demand to
// ~0.1%, and there was no way to put 161 pairs back except one at a time.
import { readFileSync } from 'node:fs';
import { gameReducer } from '../src/store/GameContext.jsx';
import { routePairKey, defaultClassPrices } from '../src/utils/simulation.js';
import { referencePrice, setNwrYieldChoke, nwrYieldChokeFactor, nwrChokeThreshold,
  NWR_CHOKE_THRESHOLD_BASE, NWR_CHOKE_THRESHOLD_MAX } from '../src/utils/market.js';
import { priceChokeFactor } from '../src/models/demand.js';
import {
  faresOverCliff, bulkFareCliffPreview, bulkAdjustedFares, networkFareCliff, fareCliffActive,
} from '../src/models/fareCliff.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name)); };

const r1  = { id: 'r1',  origin: 'JFK', destination: 'LAX', aircraftId: 'a1', weeklyFrequency: 7 };
const r1b = { id: 'r1b', origin: 'LAX', destination: 'JFK', aircraftId: 'a3', weeklyFrequency: 7 };
const r2  = { id: 'r2',  origin: 'ORD', destination: 'MIA', aircraftId: 'a2', weeklyFrequency: 7 };
const k1 = routePairKey('JFK', 'LAX'), k2 = routePairKey('ORD', 'MIA');
const ref1 = defaultClassPrices(referencePrice('JFK', 'LAX'));
const ref2 = defaultClassPrices(referencePrice('ORD', 'MIA'));
const fleet = [
  { id: 'a1', typeId: 'x', config: { economy: 150, businessClass: 12 } },
  { id: 'a2', typeId: 'x', config: { economy: 180 } },
  { id: 'a3', typeId: 'x', config: { economy: 150 } },
];
const hiked = (ref, m) => Object.fromEntries(Object.entries(ref).map(([k, v]) => [k, Math.round(v * m)]));
const base = {
  routes: [r1, r1b, r2], fleet,
  routePricing: { [k1]: hiked(ref1, 1.5), [k2]: hiked(ref2, 1.5) },
};

console.log('\n── RESET_ROUTE_PRICING ─────────────────');
{
  const next = gameReducer(base, { type: 'RESET_ROUTE_PRICING', routeIds: ['r1', 'r1b', 'r2'] });
  ok('every cabin on pair 1 back to reference', JSON.stringify(next.routePricing[k1]) === JSON.stringify(ref1));
  ok('every cabin on pair 2 back to reference', JSON.stringify(next.routePricing[k2]) === JSON.stringify(ref2));
  ok('does not mutate the original state', base.routePricing[k1].economy === Math.round(ref1.economy * 1.5));
}
{
  const next = gameReducer(base, { type: 'RESET_ROUTE_PRICING', routeIds: ['r2'] });
  ok('only the selected pair resets', next.routePricing[k1] === base.routePricing[k1] && next.routePricing[k2].economy === ref2.economy);
}
{
  const next = gameReducer(base, { type: 'RESET_ROUTE_PRICING', routeIds: ['r1'], classes: ['businessClass'] });
  ok('classes limits the reset to those cabins',
    next.routePricing[k1].businessClass === ref1.businessClass && next.routePricing[k1].economy === base.routePricing[k1].economy);
}
{
  ok('empty routeIds is a no-op', gameReducer(base, { type: 'RESET_ROUTE_PRICING', routeIds: [] }) === base);
  ok('unknown routeId is a no-op', gameReducer(base, { type: 'RESET_ROUTE_PRICING', routeIds: ['nope'] }) === base);
  const atRef = { ...base, routePricing: { [k1]: ref1, [k2]: ref2 } };
  ok('already at reference is a no-op', gameReducer(atRef, { type: 'RESET_ROUTE_PRICING', routeIds: ['r1', 'r2'] }) === atRef);
}
{
  const allowed = readFileSync(new URL('../apps/headwinds-server/src/world.mjs', import.meta.url), 'utf8');
  ok('server allow-list accepts RESET_ROUTE_PRICING', /'RESET_ROUTE_PRICING'/.test(allowed));
}

console.log('\n── Threshold is one definition ─────────');
ok('nwrChokeThreshold(50) is the base', nwrChokeThreshold(50) === NWR_CHOKE_THRESHOLD_BASE);
ok('nwrChokeThreshold(100) is the max', nwrChokeThreshold(100) === NWR_CHOKE_THRESHOLD_MAX);
setNwrYieldChoke(true);
ok('choke is exactly 1 at the threshold', nwrYieldChokeFactor(nwrChokeThreshold(50), 50) === 1);
ok('choke bites just past it', nwrYieldChokeFactor(nwrChokeThreshold(50) + 0.01, 50) < 1);

console.log('\n── Cliff warnings (NWR on) ─────────────');
ok('fareCliffActive follows the world flag', fareCliffActive() === true);
{
  // The incident, reproduced: reference fares + 50% keep ~0.1% of demand.
  const r = 1.5;
  const kept = priceChokeFactor(r * ref1.economy, ref1.economy, 50) * (1 / r) ** 2;
  ok(`+50% from reference keeps < 1% of demand (got ${(kept * 100).toFixed(2)}%)`, kept < 0.01);
}
{
  const atRef = { ...base, routePricing: { [k1]: ref1, [k2]: ref2 } };
  const p50 = bulkFareCliffPreview(atRef, ['r1', 'r1b', 'r2'], { economy: 50, businessClass: 50, premiumEconomy: 50, firstClass: 50 });
  ok('+50% bulk preview flags both pairs', p50.pairs === 2 && p50.over.length === 2 && p50.newlyOver === 2);
  ok('preview only names cabins that carry seats', p50.over.find(o => o.key === k2).cabins.every(c => c.cls === 'economy'));
  const p5 = bulkFareCliffPreview(atRef, ['r1', 'r2'], { economy: 5 });
  ok('+5% bulk preview flags nothing', p5.over.length === 0);
  const pCut = bulkFareCliffPreview(base, ['r1', 'r2'], { economy: -40, businessClass: -40 });
  ok('a cut back under the cliff clears the warning', pCut.over.length === 0);
}
{
  // Preview must store what the reducer stores (CLAUDE.md: previews agree with the action).
  const pct = { economy: 37, businessClass: -12 };
  const next = gameReducer(base, { type: 'BULK_ADJUST_PRICING', routeIds: ['r1'], pct });
  const pred = bulkAdjustedFares(base.routePricing[k1], 'JFK', 'LAX', pct);
  ok('bulkAdjustedFares mirrors BULK_ADJUST_PRICING', JSON.stringify(pred) === JSON.stringify(next.routePricing[k1]));
}
{
  // Every reducer call re-syncs the choke from state (base is a classic state),
  // so switch it back on before reading the scan.
  setNwrYieldChoke(true);
  const net = networkFareCliff(base);
  ok('network scan finds both over-cliff pairs', net.length === 2);
  ok('network scan carries every route id on the pair', net.find(n => n.key === k1).routeIds.sort().join() === 'r1,r1b');
  const fixed = gameReducer(base, { type: 'RESET_ROUTE_PRICING', routeIds: net.flatMap(n => n.routeIds) });
  setNwrYieldChoke(true);
  ok('resetting the scan result clears the network', networkFareCliff(fixed).length === 0);
  ok('reference fares are never over the cliff', faresOverCliff(ref1, 'JFK', 'LAX').length === 0);
}

console.log('\n── Classic worlds (NWR off) ────────────');
setNwrYieldChoke(false);
ok('no cliff warnings without the choke', networkFareCliff(base).length === 0
  && bulkFareCliffPreview(base, ['r1'], { economy: 50 }).over.length === 0);
ok('force still evaluates (for tests / tooling)', faresOverCliff(base.routePricing[k1], 'JFK', 'LAX', { force: true }).length > 0);

console.log('\n───────────────────────────────────────');
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
