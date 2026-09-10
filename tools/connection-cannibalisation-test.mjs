// A nonstop only steals the connecting traffic it can actually carry.
//
// Discord 2026-09-10 (wj): "is it normal when i buy out a big airline demand
// drops for routes cross the board".
//
// Buying a rival hands you its nonstops. Every market you used to CONNECT over
// your hub now has a direct in your own network, and the direct-vs-connect logit
// moves those passengers off your two hub legs. That much is the model working.
//
// What was broken is how the direct was scored: a hard-coded proxy
// (`-PRICE_WEIGHT * 1.0 + FREQ_WEIGHT * Math.log1p(7)`) that ignored the route's
// real frequency and fare, and no capacity check at all. Measured on HEAD before
// the fix: 15 inherited nonstops at 1x/week diverted EXACTLY as much connecting
// traffic as the same 15 at 14x/week (6,616 → 4,704 own-metal connecting pax,
// $4.53M → $3.12M, identical to the dollar). A single 1x/week A320 on BOS-LAX
// displaced 344 connecting passengers off the ORD legs while flying 194 seats:
// 150 passengers a week deleted from the network by a route with no room for them.
//
//   node tools/connection-cannibalisation-test.mjs
import assert from 'node:assert/strict';
import {
  weeklyTick, defaultConfig, defaultClassPrices, referencePrice, configBodies,
} from '../packages/engine/src/utils/simulation.js';
import { gameReducer } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { DEFAULT_LABOR_STATE, seedCrewFor } from '../packages/engine/src/data/labor.js';

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
};

const narrow = getAircraftType('a320neo');
const typeOf = (a) => getAircraftType(a.typeId);
const SPOKES = ['DEN','MSP','PHX','SEA','LAX','DFW','ATL','BOS'];
const SEATS  = configBodies(defaultConfig(narrow.seats));

// Hub-and-spoke network over ORD, optionally plus one spoke-to-spoke nonstop.
function build({ nonstop = null, freq = 7, priceMult = 1, hubPackage = true } = {}) {
  let n = 0;
  const fleet = [], routes = [], routePricing = {}, gates = { ORD: 60 };
  const add = (o, d, f, pm) => {
    const ac = { id: `p${n++}`, typeId: narrow.id, tailNumber: `N${n}CC`, status: 'assigned',
      ageWeeks: 100, config: defaultConfig(narrow.seats), ownershipType: 'owned' };
    fleet.push(ac);
    routes.push({ id: `r-${o}-${d}`, origin: o, destination: d, aircraftId: ac.id,
      weeklyFrequency: f, hub: 'ORD', weeksOpen: 40 });
    routePricing[[o, d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(o, d) * pm));
    gates[o] = (gates[o] ?? 0) + 6; gates[d] = (gates[d] ?? 0) + 6;
  };
  for (const s of SPOKES) add('ORD', s, 28, 1);
  if (nonstop) add(nonstop[0], nonstop[1], freq, priceMult);
  return { week: 40, year: 3, hub: 'ORD', airlineName: 'Cannibal Air', cash: 1e9,
    fleet, routes, cargoRoutes: [], gameDate: { week: 40, month: 6 }, gates,
    hubs: { ORD: { tier: 2, tierSince: 0 } }, routePricing, routeCatering: {},
    competitors: [], codeshareAgreements: [], pendingToasts: [],
    labor: seedCrewFor(DEFAULT_LABOR_STATE, fleet, typeOf), awareness: 50,
    // The hub-connectivity package. Off = a beta world, frozen on the old rules.
    rivalItineraries: hubPackage };
}
const connectingPax = (opts) => weeklyTick(build(opts)).ownMetalOD.totalPax;

const BASE  = connectingPax({});
const PAIR  = ['BOS','LAX'];          // a real ORD connecting market
const thin  = connectingPax({ nonstop: PAIR, freq: 1 });
const daily = connectingPax({ nonstop: PAIR, freq: 21 });

console.log('\n── how hard a nonstop bites ─────────────');
console.log(`  no nonstop: ${BASE} connecting pax   1x/wk: ${thin} (−${BASE - thin})   21x/wk: ${daily} (−${BASE - daily})`);

t('a nonstop diverts fewer connecting passengers at 1x/week than at 21x/week', () => {
  assert.ok(BASE - thin < BASE - daily,
    `1x/week diverted ${BASE - thin} pax, 21x/week diverted ${BASE - daily} — frequency is not being scored`);
});

t('a nonstop cannot divert more passengers than it has seats', () => {
  const seats = SEATS * 1;   // one-way weekly seats at 1x/week
  assert.ok(BASE - thin <= seats,
    `a ${seats}-seat/week nonstop displaced ${BASE - thin} connecting pax — ${BASE - thin - seats} of them have nowhere to sit`);
});

t('a nonstop priced at twice the reference fare diverts less than one at reference', () => {
  const cheap = connectingPax({ nonstop: PAIR, freq: 21, priceMult: 1 });
  const dear  = connectingPax({ nonstop: PAIR, freq: 21, priceMult: 2 });
  assert.ok(BASE - dear < BASE - cheap,
    `a 2x-fare nonstop diverted ${BASE - dear} pax vs ${BASE - cheap} at reference — the direct's fare is not being scored`);
});

t('a big nonstop still takes the traffic — the cap only binds when seats run out', () => {
  assert.ok(BASE - daily > 100,
    `a 21x/week nonstop only diverted ${BASE - daily} pax — the cap is biting when it should not`);
});

t('a flag-off beta world keeps the old proxy — the fix does not leak past the flag', () => {
  const base0 = connectingPax({ hubPackage: false });
  const one   = connectingPax({ nonstop: PAIR, freq: 1,  hubPackage: false });
  const many  = connectingPax({ nonstop: PAIR, freq: 21, hubPackage: false });
  assert.equal(base0 - one, base0 - many,
    `a beta world diverted ${base0 - one} pax at 1x and ${base0 - many} at 21x — the new scoring reached a flag-off world`);
});

// ── Inherited fleet: a rival's multi-tail route arrives as a multi-tail route ──
console.log('\n── acquisition: surplus tails ───────────');

const RIVAL_FREQ = 42, TAILS = 3;
const rivalFleet = [];
for (let k = 0; k < TAILS; k++) rivalFleet.push({ id: `m${k}`, typeId: 'a320neo', routeKey: 'DEN-ORD', ageWeeks: 250 });
const TARGET = { id: 'mega', name: 'Mega Air', tier: 'legacy', homeHub: 'ORD', cash: 0,
  marketCap: 3e8, baseQualityScore: 55, fleet: rivalFleet,
  routes: { 'DEN-ORD': { frequency: RIVAL_FREQ, priceMultiplier: 1 } } };

const preAcq = { ...build({}), competitors: [TARGET], cash: 3e9 };
const acq    = gameReducer(preAcq, { type: 'ACQUIRE_COMPETITOR', competitorId: 'mega' });
const inherited = acq.routes.filter(r => r.inherited);
const inheritedFreq = inherited.reduce((s, r) => s + (r.weeklyFrequency ?? 0), 0);
const idleAcquired  = acq.fleet.filter(a => a.acquired && a.status !== 'assigned').length;
console.log(`  rival flew DEN-ORD ${RIVAL_FREQ}x with ${TAILS} tails → inherited ${inherited.length} route(s), ${inheritedFreq}x total, ${idleAcquired} tail(s) parked`);

t('the schedule you paid for survives the deal', () => {
  assert.ok(inheritedFreq >= RIVAL_FREQ * 0.9,
    `rival flew ${RIVAL_FREQ}x/week, you inherited ${inheritedFreq}x/week`);
});

t('a tail is only parked once the schedule it flew is covered', () => {
  assert.ok(idleAcquired === 0 || inheritedFreq >= RIVAL_FREQ,
    `${idleAcquired} inherited aircraft are parked while the route flies only ${inheritedFreq}x of ${RIVAL_FREQ}x`);
});

t('every inherited tail flies when the schedule needs them all', () => {
  const busy = { ...TARGET, routes: { 'DEN-ORD': { frequency: 78, priceMultiplier: 1 } } };
  const out  = gameReducer({ ...preAcq, competitors: [busy] },
    { type: 'ACQUIRE_COMPETITOR', competitorId: 'mega' });
  const parked = out.fleet.filter(a => a.acquired && a.status !== 'assigned').length;
  const freq   = out.routes.filter(r => r.inherited).reduce((s, r) => s + r.weeklyFrequency, 0);
  assert.equal(parked, 0, `${parked} of ${TAILS} tails parked on a 78x/week route flying ${freq}x`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
