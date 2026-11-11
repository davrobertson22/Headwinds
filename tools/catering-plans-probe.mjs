// @not-a-test
// Balance probe for custom catering (data/cateringPlans.js). Prints, for one
// monopoly route at several distances and two cabin layouts, the weekly route
// profit under each classic level and a set of item plans — to see whether any
// one plan wins everywhere, and whether each quality tier is the right answer
// somewhere. Asserts nothing.
//
//   node tools/catering-plans-probe.mjs                       monopoly, 7 a week
//   node tools/catering-plans-probe.mjs --freq=21 --rival=42  contested: a rival flying 42 a week

import { weeklyTick, defaultClassPrices, routeDistanceKm } from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { defaultAncillaries } from '../packages/engine/src/data/ancillaries.js';
import { CABIN_CLASSES, CATERING_LEVEL_ORDER } from '../packages/engine/src/data/catering.js';
import { CATERING_EXPECTED, itemReferencePrice } from '../packages/engine/src/data/cateringPlans.js';

const free = (ids, tier = 'standard') => Object.fromEntries(ids.map(id => [id, { mode: 'free', tier }]));
const sold = (cabin, ids, mult = 1, tier = 'standard') => Object.fromEntries(ids.map(id =>
  [id, { mode: 'sold', tier, price: +(itemReferencePrice(id, cabin, tier) * mult).toFixed(2) }]));
const all = (fn) => Object.fromEntries(CABIN_CLASSES.map(c => [c, fn(c)]));
const PLANS = {
  basicFull:    { name: 'Expected set, Basic',    cabins: all(c => free(CATERING_EXPECTED[c], 'basic')) },
  stdFull:      { name: 'Expected set, Standard', cabins: all(c => free(CATERING_EXPECTED[c])) },
  premFull:     { name: 'Expected set, Premium',  cabins: all(c => free(CATERING_EXPECTED[c], 'premium')) },
  premFront:    { name: 'Standard back, Premium front', cabins: all(c => free(CATERING_EXPECTED[c], c === 'economy' ? 'standard' : 'premium')) },
  basicBack:    { name: 'Basic back, Standard front',   cabins: all(c => free(CATERING_EXPECTED[c], c === 'economy' ? 'basic' : 'standard')) },
  drinksSnack:  { name: 'Free drinks and snack only',   cabins: all(() => free(['water', 'softDrinks', 'snack'])) },
  drinksSell:   { name: 'Free drinks and snack, meals sold', cabins: all(c => ({ ...free(['water', 'softDrinks', 'snack']), ...sold(c, ['beerWine', 'coldMeal', 'hotMeal']) })) },
  sellAll:      { name: 'Everything sold at 2× cost',   cabins: all(c => sold(c, ['softDrinks', 'beerWine', 'snack', 'coldMeal', 'hotMeal'])) },
  sellDear:     { name: 'Everything sold at 2.8× cost', cabins: all(c => sold(c, ['softDrinks', 'beerWine', 'snack', 'coldMeal', 'hotMeal'], 1.4)) },
  sellBack:     { name: 'Economy sold, Standard front', cabins: all(c => (c === 'economy' ? { water: { mode: 'free' }, ...sold(c, ['softDrinks', 'beerWine', 'snack', 'coldMeal', 'hotMeal']) } : free(CATERING_EXPECTED[c]))) },
};
for (const [id, p] of Object.entries(PLANS)) p.id = id;

const FREQ = Number(process.argv.find(a => /^--freq=/.test(a))?.slice(7) ?? 7);
const RIVAL = Number(process.argv.find(a => /^--rival=/.test(a))?.slice(8) ?? 0);
const ROUTES = [['JFK', 'BOS', 'a320neo'], ['JFK', 'ORD', 'a320neo'], ['JFK', 'LAX', 'a320neo'], ['JFK', 'LHR', 'b7879'], ['LAX', 'SYD', 'b7879']];
const LAYOUTS = {
  'a320neo': (s) => ({ firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: s - 24 }),
  'b7879':   (s) => ({ firstClass: 0, businessClass: 30, premiumEconomy: 28, economy: Math.round(s * 0.62) }),
};

function run(o, d, typeId, ref) {
  const type = getAircraftType(typeId) ?? getAircraftType('787-9') ?? getAircraftType('a350-900');
  const pair = [o, d].sort().join('-');
  const st = {
    fleet: [{ id: 'a1', typeId: type.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned',
      config: { ...LAYOUTS[typeId](type.seats), seatQuality: 'standard', serviceQuality: 'standard' } }],
    routes: [{ id: 'r1', origin: o, destination: d, stops: [o, d], aircraftId: 'a1', weeklyFrequency: FREQ, weeksOpen: 60 }],
    cargoRoutes: [], gameDate: { week: 1, month: 6 }, gates: { [o]: 10, [d]: 10 }, hubs: {},
    lounges: {}, loungePolicy: null, cateringPlans: PLANS,
    routePricing: { [pair]: defaultClassPrices(Math.round(referencePrice(o, d))) },
    routeCatering: { [pair]: ref },
    // --rival: a legacy carrier on the pair, so quality fights for share
    // instead of filling a monopoly aircraft whatever is served.
    competitors: RIVAL ? [{ id: 'rivalx', name: 'Rival Air', homeHub: o, tier: 'legacy', logoId: 'eagle',
      baseQualityScore: 70, cash: 45_000_000, weeklyStats: null,
      routes: { [pair]: { frequency: RIVAL, priceMultiplier: 1.0 } } }] : [],
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 }, allianceMembership: null,
    campaignStrength: {}, targetedMarketing: {}, awareness: 65, ancillaries: defaultAncillaries(), labor: undefined, absWeek: 100,
  };
  return weeklyTick(st).routeResults[0];
}

if (process.argv.includes('--keys')) { console.log(Object.keys(run('JFK', 'LAX', 'a320neo', 'full')).join(' ')); process.exit(0); }

for (const [o, d, typeId] of ROUTES) {
  if (!getAircraftType(typeId)) { console.log(`skip ${o}-${d}: no ${typeId}`); continue; }
  const rows = [...CATERING_LEVEL_ORDER.map(l => [`classic ${l}`, l]), ...Object.values(PLANS).map(p => [p.name, `plan:${p.id}`])]
    .map(([name, ref]) => { const r = run(o, d, typeId, ref); return { name, r }; });
  const base = rows.find(x => x.name === 'classic full').r;
  console.log(`\n${o}–${d}  ${Math.round(routeDistanceKm(o, d)).toLocaleString()} km  ${typeId}   (profit vs classic Full)`);
  console.log('  ' + 'service'.padEnd(36) + 'quality'.padStart(8) + 'LF'.padStart(7) + 'catering net'.padStart(14) + 'profit'.padStart(12) + 'vs Full'.padStart(11));
  for (const { name, r } of rows.sort((a, b) => b.r.profit - a.r.profit)) {
    console.log('  ' + name.padEnd(36) + String(r.cateringQuality).padStart(8) + `${Math.round((r.loadFactor ?? 0) * 100)}%`.padStart(7)
      + String(Math.round(r.cateringRevenue - r.cateringCost)).padStart(14) + String(Math.round(r.profit)).padStart(12)
      + String(Math.round(r.profit - base.profit)).padStart(11));
  }
}
