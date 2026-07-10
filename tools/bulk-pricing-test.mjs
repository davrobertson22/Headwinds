// Targeted test for the BULK_ADJUST_PRICING reducer action.
// Run with: node --import ./tools/_register-loader.mjs tools/bulk-pricing-test.mjs
import { gameReducer } from '../src/store/GameContext.jsx';
import { routePairKey, defaultClassPrices, clampClassPrice, maxClassPrice } from '../src/utils/simulation.js';
import { referencePrice } from '../src/utils/market.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name)); };

// Build a minimal state with two single-leg routes on different pairs.
const r1 = { id: 'r1', origin: 'JFK', destination: 'LAX', aircraftId: 'a1', weeklyFrequency: 7 };
const r2 = { id: 'r2', origin: 'ORD', destination: 'MIA', aircraftId: 'a2', weeklyFrequency: 7 };
const k1 = routePairKey('JFK', 'LAX');
const k2 = routePairKey('ORD', 'MIA');
const ref1 = referencePrice('JFK', 'LAX');
const ref2 = referencePrice('ORD', 'MIA');

const baseState = {
  routes: [r1, r2],
  routePricing: {
    [k1]: defaultClassPrices(ref1),
    [k2]: defaultClassPrices(ref2),
  },
};

console.log('\n── BULK_ADJUST_PRICING ──────────────────');

// 1. Applies +10% economy to only the selected route.
{
  const before1 = baseState.routePricing[k1].economy;
  const before2 = baseState.routePricing[k2].economy;
  const next = gameReducer(baseState, { type: 'BULK_ADJUST_PRICING', routeIds: ['r1'], pct: { economy: 10 } });
  const expected = clampClassPrice(Math.round(before1 * 1.1), ref1, 'economy');
  ok('raises selected pair economy by 10%', next.routePricing[k1].economy === expected);
  ok('leaves unselected pair untouched', next.routePricing[k2].economy === before2);
  ok('does not mutate original state', baseState.routePricing[k1].economy === before1);
}

// 2. Negative pct cuts fares; multiple classes at once.
{
  const next = gameReducer(baseState, { type: 'BULK_ADJUST_PRICING', routeIds: ['r1', 'r2'], pct: { economy: -20, businessClass: 5 } });
  const e1 = clampClassPrice(Math.round(baseState.routePricing[k1].economy * 0.8), ref1, 'economy');
  const b2 = clampClassPrice(Math.round(baseState.routePricing[k2].businessClass * 1.05), ref2, 'businessClass');
  ok('cuts economy -20% on pair 1', next.routePricing[k1].economy === e1);
  ok('raises business +5% on pair 2', next.routePricing[k2].businessClass === b2);
}

// 3. Result is clamped to the per-class ceiling on huge increases.
{
  const next = gameReducer(baseState, { type: 'BULK_ADJUST_PRICING', routeIds: ['r1'], pct: { economy: 100000 } });
  ok('clamps to per-class ceiling', next.routePricing[k1].economy === maxClassPrice(ref1, 'economy'));
}

// 4. No-op cases return the same state reference.
{
  const a = gameReducer(baseState, { type: 'BULK_ADJUST_PRICING', routeIds: [], pct: { economy: 10 } });
  const b = gameReducer(baseState, { type: 'BULK_ADJUST_PRICING', routeIds: ['r1'], pct: { economy: 0 } });
  const c = gameReducer(baseState, { type: 'BULK_ADJUST_PRICING', routeIds: ['nope'], pct: { economy: 10 } });
  ok('empty routeIds is a no-op', a === baseState);
  ok('zero pct is a no-op', b === baseState);
  ok('unknown routeId is a no-op', c === baseState);
}

// 5. Multiple aircraft on the same pair adjust the pair's price once (not twice).
{
  const r1b = { id: 'r1b', origin: 'LAX', destination: 'JFK', aircraftId: 'a3', weeklyFrequency: 7 };
  const st = { ...baseState, routes: [r1, r1b, r2] };
  const before = st.routePricing[k1].economy;
  const next = gameReducer(st, { type: 'BULK_ADJUST_PRICING', routeIds: ['r1', 'r1b'], pct: { economy: 10 } });
  const expected = clampClassPrice(Math.round(before * 1.1), ref1, 'economy');
  ok('shared pair adjusts once regardless of aircraft count', next.routePricing[k1].economy === expected);
}

console.log('\n───────────────────────────────────────');
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
