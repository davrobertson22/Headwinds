// Targeted test for ADD_ROUTE carrying full per-cabin classPrices (fare editor).
// Run with: node --import ./tools/_register-loader.mjs tools/fare-editor-test.mjs
import { gameReducer } from '../src/store/GameContext.jsx';
import { routePairKey, defaultClassPrices, maxClassPrice } from '../src/utils/simulation.js';
import { referencePrice } from '../src/utils/market.js';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name)); };

const type = AIRCRAFT_TYPES.find(t => !t.freighter && t.range > 4500);
const pair = routePairKey('JFK', 'LAX');
const ref  = referencePrice('JFK', 'LAX');

const mkState = () => ({
  week: 1, cash: 500_000_000, hub: 'JFK',
  fleet: [
    { id: 'a1', typeId: type.id, status: 'idle', ageWeeks: 0 },
    { id: 'a2', typeId: type.id, status: 'idle', ageWeeks: 0 },
  ],
  routes: [], cargoRoutes: [],
  gates: { JFK: 5, LAX: 5 },
  routePricing: {}, routeCatering: {},
});

console.log('\n── ADD_ROUTE + classPrices ─────────────');
console.log(`  (type: ${type.id}, ref JFK-LAX: $${ref})`);

// 1. No classPrices → defaults from ticketPrice (legacy behaviour unchanged).
{
  const next = gameReducer(mkState(), { type: 'ADD_ROUTE', origin: 'JFK', destination: 'LAX', aircraftId: 'a1', weeklyFrequency: 7, ticketPrice: 300 });
  const cp = next.routePricing[pair];
  const want = defaultClassPrices(300);
  ok('route opened', next.routes.length === 1);
  ok('defaults applied without classPrices', cp && cp.economy === want.economy && cp.businessClass === want.businessClass && cp.firstClass === want.firstClass);
}

// 2. Custom classPrices land verbatim (within caps).
{
  const custom = { economy: 250, premiumEconomy: 390, businessClass: 700, firstClass: 1500 };
  const next = gameReducer(mkState(), { type: 'ADD_ROUTE', origin: 'JFK', destination: 'LAX', aircraftId: 'a1', weeklyFrequency: 7, ticketPrice: 250, classPrices: custom });
  const cp = next.routePricing[pair];
  ok('custom economy kept', cp.economy === 250);
  ok('custom prem-eco kept', cp.premiumEconomy === 390);
  ok('custom business kept', cp.businessClass === 700);
  ok('custom first kept', cp.firstClass === 1500);
}

// 3. Absurd fares are clamped to each class ceiling.
{
  const next = gameReducer(mkState(), { type: 'ADD_ROUTE', origin: 'JFK', destination: 'LAX', aircraftId: 'a1', weeklyFrequency: 7, ticketPrice: 300, classPrices: { economy: 999999, firstClass: 999999 } });
  const cp = next.routePricing[pair];
  ok('economy clamped to cap', cp.economy === maxClassPrice(ref, 'economy'));
  ok('first clamped to cap', cp.firstClass === maxClassPrice(ref, 'firstClass'));
}

// 4. Missing cabins fall back to multipliers off the economy ticketPrice.
{
  const next = gameReducer(mkState(), { type: 'ADD_ROUTE', origin: 'JFK', destination: 'LAX', aircraftId: 'a1', weeklyFrequency: 7, ticketPrice: 280, classPrices: { economy: 280, businessClass: 650 } });
  const cp = next.routePricing[pair];
  const want = defaultClassPrices(280);
  ok('set cabins kept', cp.economy === 280 && cp.businessClass === 650);
  ok('missing cabins defaulted', cp.premiumEconomy === want.premiumEconomy && cp.firstClass === want.firstClass);
}

// 5. Second aircraft on the pair INHERITS existing fares (can't overwrite).
{
  let st = gameReducer(mkState(), { type: 'ADD_ROUTE', origin: 'JFK', destination: 'LAX', aircraftId: 'a1', weeklyFrequency: 7, ticketPrice: 250, classPrices: { economy: 250 } });
  st = gameReducer(st, { type: 'ADD_ROUTE', origin: 'JFK', destination: 'LAX', aircraftId: 'a2', weeklyFrequency: 7, ticketPrice: 400, classPrices: { economy: 400 } });
  ok('two routes on pair', st.routes.length === 2);
  ok('pair pricing inherited, not overwritten', st.routePricing[pair].economy === 250);
}

// 6. Bad classPrices values are ignored, not poisonous.
{
  const next = gameReducer(mkState(), { type: 'ADD_ROUTE', origin: 'JFK', destination: 'LAX', aircraftId: 'a1', weeklyFrequency: 7, ticketPrice: 300, classPrices: { economy: 'garbage', businessClass: -5, firstClass: null } });
  const cp = next.routePricing[pair];
  const want = defaultClassPrices(300);
  ok('garbage values fall back to defaults', cp.economy === want.economy && cp.businessClass === want.businessClass && cp.firstClass === want.firstClass);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
