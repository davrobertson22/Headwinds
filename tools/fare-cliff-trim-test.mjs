// Trim fares back under the fare cliff — TRIM_FARES_TO_CLIFF.
//
// Dunno23 (Discord 2026-10-19, Old Metal): "I always price my tickets under the
// fare cliff, but if I come back later several routes are priced above it ...
// it's rather problematic with hundreds of routes." Old Metal is not an era
// world, so neither the fares nor the reference moved: the CLIFF did. It sits
// at 1.10–1.25x reference by the pair's live quality, and the economy cliff
// steps 5% lower for each carrier that joins the pair. The only bulk way back
// was RESET_ROUTE_PRICING, which throws away the markup; this pulls only the
// over-cliff cabins to just under it (models/fareCliff.js).
//
//   node --import ./tools/_register-loader.mjs tools/fare-cliff-trim-test.mjs
import { readFileSync } from 'node:fs';
import { gameReducer } from '../src/store/GameContext.jsx';
import { routePairKey, defaultClassPrices, CLASS_FARE_MULTIPLIERS } from '../src/utils/simulation.js';
import { referencePrice, setNwrYieldChoke, nwrChokeThreshold } from '../src/utils/market.js';
import {
  faresTrimmedUnderCliff, networkFareCliff, FARE_CLIFF_TRIM_MARGIN,
} from '../src/models/fareCliff.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name)); };

const r1 = { id: 'r1', origin: 'JFK', destination: 'LAX', aircraftId: 'a1', weeklyFrequency: 7 };
const r2 = { id: 'r2', origin: 'ORD', destination: 'MIA', aircraftId: 'a2', weeklyFrequency: 7 };
const k1 = routePairKey('JFK', 'LAX'), k2 = routePairKey('ORD', 'MIA');
const ref1 = defaultClassPrices(referencePrice('JFK', 'LAX'));
const ref2 = defaultClassPrices(referencePrice('ORD', 'MIA'));
const scaled = (ref, m) => Object.fromEntries(Object.entries(ref).map(([k, v]) => [k, Math.round(v * m)]));
// Unknown typeId: no quality score, so both pairs sit at the quality-50 cliff (1.10x).
const fleet = [
  { id: 'a1', typeId: 'x', config: { economy: 150, businessClass: 12 } },
  { id: 'a2', typeId: 'x', config: { economy: 180 } },
];
const thr = nwrChokeThreshold(50);
// The cliff is priced off the unrounded cabin reference (economy ref × multiplier).
const trimmedTo = (ref, cls, compression = 1) =>
  Math.floor(Math.floor(ref.economy * CLASS_FARE_MULTIPLIERS[cls] * thr * compression) * (1 - FARE_CLIFF_TRIM_MARGIN));
const world = (pricing, extra = {}) => ({
  newWorldRestrictions: true, routes: [r1, r2], fleet, routePricing: pricing, ...extra,
});

console.log('\n── Trim pulls over-cliff cabins just under it ─────');
{
  const s = world({ [k1]: scaled(ref1, 1.5), [k2]: scaled(ref2, 1.5) });
  const next = gameReducer(s, { type: 'TRIM_FARES_TO_CLIFF', routeIds: ['r1', 'r2'] });
  const p1 = next.routePricing?.[k1] ?? {};
  ok(`economy lands ${FARE_CLIFF_TRIM_MARGIN * 100}% under the cliff (got ${p1.economy}, want ${trimmedTo(ref1, 'economy')})`,
    p1.economy === trimmedTo(ref1, 'economy'));
  ok(`a seated premium cabin is trimmed too (got ${p1.businessClass}, want ${trimmedTo(ref1, 'businessClass')})`, p1.businessClass === trimmedTo(ref1, 'businessClass'));
  ok('cabins with no seats on the pair are left alone',
    p1.firstClass === s.routePricing[k1].firstClass && p1.premiumEconomy === s.routePricing[k1].premiumEconomy);
  ok('the trimmed fare keeps the markup (above reference)', p1.economy > ref1.economy);
  setNwrYieldChoke(true);
  ok('nothing is left over the cliff', networkFareCliff(next).length === 0);
  ok('the preview helper stores exactly what the reducer stores',
    JSON.stringify(Object.fromEntries(faresTrimmedUnderCliff(s, ['r1', 'r2']))) ===
    JSON.stringify({ [k1]: next.routePricing[k1], [k2]: next.routePricing[k2] }));
  ok('does not mutate the original state', s.routePricing[k1].economy === Math.round(ref1.economy * 1.5));
}
{
  const s = world({ [k1]: { ...ref1, economy: Math.round(ref1.economy * 1.05), businessClass: Math.round(ref1.businessClass * 1.5) }, [k2]: ref2 });
  const next = gameReducer(s, { type: 'TRIM_FARES_TO_CLIFF', routeIds: ['r1', 'r2'] });
  ok('a cabin under the cliff keeps its fare', next.routePricing[k1].economy === s.routePricing[k1].economy);
  ok('only the over-cliff cabin moves', next.routePricing[k1].businessClass === trimmedTo(ref1, 'businessClass'));
  ok('a pair entirely under the cliff is not rewritten', next.routePricing[k2] === s.routePricing[k2]);
}
{
  const s = world({ [k1]: scaled(ref1, 1.5), [k2]: scaled(ref2, 1.5) });
  const next = gameReducer(s, { type: 'TRIM_FARES_TO_CLIFF', routeIds: ['r2'] });
  ok('only the routes asked for are trimmed', next.routePricing[k1] === s.routePricing[k1] && next.routePricing[k2].economy < s.routePricing[k2].economy);
}

console.log('\n── The cliff moved, the fare did not ──────────────');
{
  // Priced 7% over reference: under a quality-50 cliff (10%) with the pair to
  // itself. A rival joins the pair — the economy cliff drops 5% to ~4.5% over
  // reference, and the same fare is now past it.
  const fare = Math.round(ref1.economy * 1.07);
  const alone = world({ [k1]: { ...ref1, economy: fare }, [k2]: ref2 });
  setNwrYieldChoke(true);
  ok('alone on the pair, +7% is under the cliff', networkFareCliff(alone).length === 0);
  ok('...and the trim leaves it alone', gameReducer(alone, { type: 'TRIM_FARES_TO_CLIFF', routeIds: ['r1'] }) === alone);
  const rival = { ...alone, competitors: [{ id: 'c1', routes: { [k1]: { frequency: 14 } } }] };
  setNwrYieldChoke(true);
  ok('a rival joins: the same fare is now past the cliff', networkFareCliff(rival).some(p => p.key === k1));
  const next = gameReducer(rival, { type: 'TRIM_FARES_TO_CLIFF', routeIds: ['r1'] });
  ok(`trim lands under the rival-compressed cliff (got ${next.routePricing[k1].economy}, want ${trimmedTo(ref1, 'economy', 0.95)})`,
    next.routePricing[k1].economy === trimmedTo(ref1, 'economy', 0.95));
}

console.log('\n── No-ops ──────────────────────────────────────────');
{
  const s = world({ [k1]: scaled(ref1, 1.5), [k2]: scaled(ref2, 1.5) });
  ok('empty routeIds is a no-op', gameReducer(s, { type: 'TRIM_FARES_TO_CLIFF', routeIds: [] }) === s);
  ok('missing routeIds is a no-op (never "every route")', gameReducer(s, { type: 'TRIM_FARES_TO_CLIFF' }) === s);
  const classic = { ...s, newWorldRestrictions: false };
  ok('classic worlds have no cliff: no-op', gameReducer(classic, { type: 'TRIM_FARES_TO_CLIFF', routeIds: ['r1', 'r2'] }) === classic);
  const allowed = readFileSync(new URL('../apps/headwinds-server/src/world.mjs', import.meta.url), 'utf8');
  ok('server allow-list accepts TRIM_FARES_TO_CLIFF', /'TRIM_FARES_TO_CLIFF'/.test(allowed));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
