// Demand realism v2: freight has a season and a direction, a hub is worth what
// it connects, and a route between two different seasons cannot fly full both
// ways at once.
//
// A5.  Cargo was the one market in the game with no calendar and no weather.
//      Tonnage on a lane was the same in February — when the factories feeding
//      it are shut for New Year — as in November. A global recession halved the
//      passenger pool and left the freight deck untouched. And every lane in the
//      world, from Memphis–Las Vegas to Shanghai–Los Angeles, shared one
//      backhaul constant of 0.65, so the single most important fact about a
//      trade lane — which way the goods are going — was not in the model.
//
// A13. `computeConnectivityBonus` returned a flat 0.20 to anything touching your
//      hub, with a TODO next to it saying it should count the network. A carrier
//      with one aeroplane and a carrier with forty spokes scored the same, so
//      the reward for building a connecting bank was exactly zero.
//
// A14b The seasonal profile of a route is the AVERAGE of its two ends, and that
//      average drove both directions. In January a London–Geneva aeroplane went
//      to the snow full and came home light; the model sold both legs at the
//      average and never noticed the empty half.
//
//   node tools/cargo-demand-test.mjs

import assert from 'node:assert/strict';
import {
  cargoCityPairDemand, cargoBackhaulFactor, cargoSeasonalFactor,
  CARGO_SEASONAL_PROFILE, CARGO_BACKHAUL_MIN, CARGO_BACKHAUL_MAX, getCargoMass,
} from '../packages/engine/src/utils/market.js';
import {
  simulateCargoRoute, simulateRoute, cargoLaneAllocations, weeklyTick,
  hubSpokeCounts, pairConnectivityBonus, defaultConfig,
} from '../packages/engine/src/utils/simulation.js';
import {
  computeConnectivityBonus, connectivityBonusForSpokes,
  directionalSeasonalSkew, directionalLoadMultiplier,
  CONNECTIVITY_MIN_BONUS, CONNECTIVITY_MAX_BONUS, CONNECTIVITY_LEGACY_SPOKES,
  SEASONAL_SKEW_CAP, seasonalProfileIdFor, getSeasonalProfile,
} from '../packages/engine/src/models/demand.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const freighter = (typeId = 'b777f') => ({
  id: 'f1', typeId, ownershipType: 'owned', ageWeeks: 100, status: 'active',
});
const cargoRoute = (o, d, extra = {}) => ({
  id: 'c1', origin: o, destination: d, aircraftId: 'f1', weeklyFrequency: 4,
  weeksOpen: 60, ...extra,
});

// ── A5: freight has a season ────────────────────────────────────────────────

console.log('\n── Cargo seasonality ────────────────────────────────────');

test('the freight year averages exactly 1.0', () => {
  // Anything else would be a silent buff or nerf to every freighter in the game
  // dressed up as realism.
  const months = CARGO_SEASONAL_PROFILE.slice(1);
  assert.equal(months.length, 12);
  assert.ok(near(months.reduce((a, b) => a + b, 0) / 12, 1, 1e-9),
    `mean ${months.reduce((a, b) => a + b, 0) / 12}`);
});

test('peak is Q4 and the trough is Chinese New Year', () => {
  const nov = cargoSeasonalFactor(11), feb = cargoSeasonalFactor(2), jul = cargoSeasonalFactor(7);
  assert.ok(nov > 1.15, `November ${nov} should be the retail build`);
  assert.ok(feb < 0.85, `February ${feb} should be the factory shutdown`);
  assert.ok(jul < 1, `July ${jul} — freight's quiet month is passengers' busiest`);
  assert.equal(Math.max(...CARGO_SEASONAL_PROFILE.slice(1)), nov);
  assert.equal(Math.min(...CARGO_SEASONAL_PROFILE.slice(1)), feb);
});

test('the freight season is NOT the passenger season', () => {
  // If they moved together there'd be no reason to model them apart.
  const pax = getSeasonalProfile('HKG', 'FRA');
  const paxPeak   = pax.slice(1).indexOf(Math.max(...pax.slice(1))) + 1;
  const cargoPeak = CARGO_SEASONAL_PROFILE.slice(1)
    .indexOf(Math.max(...CARGO_SEASONAL_PROFILE.slice(1))) + 1;
  assert.notEqual(paxPeak, cargoPeak, `both peak in month ${paxPeak}`);
});

test('a lane carries more in November than in February', () => {
  const nov = cargoCityPairDemand('HKG', 'FRA', 11);
  const feb = cargoCityPairDemand('HKG', 'FRA', 2);
  assert.ok(nov > feb * 1.5, `Nov ${nov} vs Feb ${feb}`);
});

test('omitting the month gives the annual average, unchanged from before', () => {
  const annual = cargoCityPairDemand('HKG', 'FRA');
  const may    = cargoCityPairDemand('HKG', 'FRA', 5);   // profile value 1.00
  assert.equal(annual, may);
  for (const junk of [null, undefined, 0, 13, NaN, 'November']) {
    assert.ok(cargoCityPairDemand('HKG', 'FRA', junk) > 0);
  }
  assert.equal(cargoSeasonalFactor(99), 1);
  assert.equal(cargoSeasonalFactor('x'), 1);
});

test('demand is still symmetric — direction lives in the backhaul, not the pool', () => {
  for (const m of [2, 6, 11]) {
    assert.equal(cargoCityPairDemand('HKG', 'FRA', m), cargoCityPairDemand('FRA', 'HKG', m));
  }
});

test('a freighter earns more in the peak than in the trough', () => {
  const nov = simulateCargoRoute(cargoRoute('NBO', 'AMS', { weeklyFrequency: 7 }), freighter('b7478f'), { month: 11 });
  const feb = simulateCargoRoute(cargoRoute('NBO', 'AMS', { weeklyFrequency: 7 }), freighter('b7478f'), { month: 2 });
  assert.ok(nov.revenue > feb.revenue * 1.3, `Nov $${nov.revenue} vs Feb $${feb.revenue}`);
  assert.ok(nov.loadFactor > feb.loadFactor);
});

// ── A5: the world reaches the freight deck ─────────────────────────────────

console.log('\n── Cargo and the world ──────────────────────────────────');

const baseState = (cargoRoutes) => ({
  cash: 5e8, week: 60, year: 2, hub: 'HKG', airlineName: 'P',
  fleet: [freighter()], routes: [], cargoRoutes,
  gameDate: { week: 60, month: 6 }, maintenanceBudget: 1.0,
  satisfaction: 70, brandAwareness: 75, financialHistory: [],
});

test('a global demand shock reaches freight', () => {
  const calm = weeklyTick({ ...baseState([cargoRoute('HKG', 'FRA')]), activeEvents: [] });
  const bust = weeklyTick({
    ...baseState([cargoRoute('HKG', 'FRA')]),
    activeEvents: [{ id: 'e', name: 'Recession', effects: { globalDemandMult: 0.60 } }],
  });
  assert.ok(bust.totalCargoRevenue < calm.totalCargoRevenue,
    `$${bust.totalCargoRevenue} should trail $${calm.totalCargoRevenue}`);
});

test('a regional shock reaches only the lanes that touch it', () => {
  const near_ = weeklyTick({
    ...baseState([cargoRoute('HKG', 'FRA')]),
    activeEvents: [{ id: 'e', name: 'Airspace closed', effects: { regionCodes: ['DE'], regionDemandMult: 0.5 } }],
  });
  const far = weeklyTick({
    ...baseState([cargoRoute('HKG', 'FRA')]),
    activeEvents: [{ id: 'e', name: 'Airspace closed', effects: { regionCodes: ['BR'], regionDemandMult: 0.5 } }],
  });
  assert.ok(near_.totalCargoRevenue < far.totalCargoRevenue,
    'a German event should hit a Frankfurt lane and not a Brazilian one');
});

test('a shared lane is not the one place a recession cannot reach', () => {
  // The pooled path computes its own demand; before this it read no event term
  // at all, so putting a SECOND freighter on a lane made it immune.
  const routes = [cargoRoute('NBO', 'AMS', { id: 'c1', aircraftId: 'f1', weeklyFrequency: 5 }),
                  cargoRoute('NBO', 'AMS', { id: 'c2', aircraftId: 'f2', weeklyFrequency: 5 })];
  const fleet  = [freighter(), { ...freighter(), id: 'f2' }];
  const calm = cargoLaneAllocations(routes, fleet, 1.0, { gameDate: { month: 6 } });
  const bust = cargoLaneAllocations(routes, fleet, 1.0,
    { gameDate: { month: 6 }, demandMultFor: () => 0.6 });
  assert.ok(bust.get('c1').demandTonnes < calm.get('c1').demandTonnes * 0.75,
    `${bust.get('c1').demandTonnes} vs ${calm.get('c1').demandTonnes}`);
});

test('the pooled path and the solo path agree about the month', () => {
  const routes = [cargoRoute('NBO', 'AMS', { id: 'c1', aircraftId: 'f1', weeklyFrequency: 5 }),
                  cargoRoute('NBO', 'AMS', { id: 'c2', aircraftId: 'f2', weeklyFrequency: 5 })];
  const fleet  = [freighter(), { ...freighter(), id: 'f2' }];
  const feb = cargoLaneAllocations(routes, fleet, 1.0, { gameDate: { month: 2 } });
  const nov = cargoLaneAllocations(routes, fleet, 1.0, { gameDate: { month: 11 } });
  assert.ok(nov.get('c1').demandTonnes > feb.get('c1').demandTonnes * 1.5);
  // …and a caller with no calendar still gets the annual average.
  const plain = cargoLaneAllocations(routes, fleet, 1.0);
  assert.ok(plain.get('c1').demandTonnes > 0);
});

// ── A5: every lane has its own imbalance ───────────────────────────────────

console.log('\n── Backhaul ─────────────────────────────────────────────');

test('a lopsided lane earns less on the return than a matched one', () => {
  // Memphis ships; Las Vegas does not. Hong Kong and Frankfurt both do.
  const lopsided = cargoBackhaulFactor('MEM', 'LAS');
  const matched  = cargoBackhaulFactor('HKG', 'FRA');
  assert.ok(lopsided < matched, `MEM–LAS ${lopsided} should trail HKG–FRA ${matched}`);
  assert.ok(lopsided >= CARGO_BACKHAUL_MIN && matched <= CARGO_BACKHAUL_MAX);
});

test('the factor tracks the freight masses it is derived from', () => {
  const LANES = [['HKG', 'FRA'], ['MEM', 'LAS'], ['PVG', 'LAX'], ['ANC', 'HKG'], ['LAS', 'MIA']];
  const rows = LANES.map(([o, d]) => {
    const mo = getCargoMass(o), md = getCargoMass(d);
    return { ratio: Math.min(mo, md) / Math.max(mo, md), f: cargoBackhaulFactor(o, d) };
  }).sort((a, b) => a.ratio - b.ratio);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].f >= rows[i - 1].f,
      `factor must rise with mass parity: ${JSON.stringify(rows)}`);
  }
});

test('it is symmetric — a lane is as lopsided from either end', () => {
  for (const [o, d] of [['MEM', 'LAS'], ['HKG', 'FRA'], ['ANC', 'LAX']]) {
    assert.equal(cargoBackhaulFactor(o, d), cargoBackhaulFactor(d, o));
  }
});

test('an unknown airport falls back to the historical 0.65', () => {
  assert.equal(cargoBackhaulFactor('ZZZ', 'HKG'), 0.65);
  assert.equal(cargoBackhaulFactor('HKG', 'ZZZ'), 0.65);
});

test('every factor stays inside the stated band', () => {
  for (const [o, d] of [['MEM', 'LAS'], ['HKG', 'FRA'], ['ANC', 'LAX'], ['LAS', 'MCO'], ['PVG', 'JFK']]) {
    const f = cargoBackhaulFactor(o, d);
    assert.ok(f >= CARGO_BACKHAUL_MIN - 1e-9 && f <= CARGO_BACKHAUL_MAX + 1e-9, `${o}-${d} ${f}`);
  }
});

test('the route result carries the factor it charged', () => {
  const r = simulateCargoRoute(cargoRoute('HKG', 'FRA'), freighter(), { month: 6 });
  assert.equal(r.backhaulFactor, cargoBackhaulFactor('HKG', 'FRA'));
  // tonnes and distance are rounded on the result, so compare within 0.1%.
  const expected = r.tonnes * (1 + r.backhaulFactor) * r.distance * r.yieldPrice;
  assert.ok(near(r.revenue, expected, expected * 0.001),
    `charged $${r.revenue}, factor ${r.backhaulFactor} implies $${Math.round(expected)}`);
});

test('two lanes of equal tonnage and distance no longer earn the same', () => {
  // The whole point: before this, lane choice was a tonnage question only.
  const a = simulateCargoRoute(cargoRoute('MEM', 'LAS'), freighter(), { month: 6 });
  const b = simulateCargoRoute(cargoRoute('HKG', 'FRA'), freighter(), { month: 6 });
  assert.ok(a && b);
  assert.notEqual(a.backhaulFactor, b.backhaulFactor);
});

// ── A13: a hub is worth what it connects ───────────────────────────────────

console.log('\n── Hub connectivity ─────────────────────────────────────');

test('twelve spokes reproduces the old flat 0.20 exactly', () => {
  // The calibration anchor. Without it this is a balance change wearing a
  // realism costume.
  assert.ok(near(connectivityBonusForSpokes(CONNECTIVITY_LEGACY_SPOKES), 0.20, 1e-12));
  assert.ok(near(computeConnectivityBonus('JFK', 'JFK', 'LAX'), 0.20, 1e-12));
});

test('a one-route "hub" is worth much less than a network', () => {
  const solo = connectivityBonusForSpokes(1);
  const big  = connectivityBonusForSpokes(40);
  assert.ok(solo < 0.10, `one spoke scored ${solo}`);
  assert.ok(big > 0.24, `forty spokes scored ${big}`);
  assert.ok(big > solo * 2.5);
});

test('the curve rises with every spoke and saturates', () => {
  let prev = -1;
  for (const s of [1, 2, 4, 8, 16, 32, 64, 256]) {
    const v = connectivityBonusForSpokes(s);
    assert.ok(v > prev, `${s} spokes (${v}) did not beat ${prev}`);
    assert.ok(v < CONNECTIVITY_MAX_BONUS, `${s} spokes broke the asymptote`);
    prev = v;
  }
  // Diminishing returns: the 2nd spoke is worth more than the 40th.
  const early = connectivityBonusForSpokes(2) - connectivityBonusForSpokes(1);
  const late  = connectivityBonusForSpokes(40) - connectivityBonusForSpokes(39);
  assert.ok(early > late * 5, `early ${early} vs late ${late}`);
});

test('a station you connect nothing to is not a hub', () => {
  assert.equal(connectivityBonusForSpokes(0), 0);
  assert.equal(connectivityBonusForSpokes(-3), 0);
  assert.equal(connectivityBonusForSpokes(NaN), 0);
  assert.ok(connectivityBonusForSpokes(1) >= CONNECTIVITY_MIN_BONUS);
});

test('a pair that touches no hub scores nothing, however big the hub', () => {
  assert.equal(computeConnectivityBonus('JFK', 'LAX', 'SFO', 40), 0);
  assert.equal(computeConnectivityBonus(null, 'JFK', 'LAX', 40), 0);
  assert.equal(computeConnectivityBonus(undefined, 'JFK', 'LAX'), 0);
});

test('spoke counting sees a route from either end', () => {
  const counts = hubSpokeCounts([
    { origin: 'JFK', destination: 'LAX' },
    { origin: 'BOS', destination: 'JFK' },
    { origin: 'JFK', destination: 'ORD' },
  ]);
  assert.equal(counts.JFK, 3);
  assert.equal(counts.LAX, 1);
  assert.equal(counts.BOS, 1);
});

test('a lane flown twice is still one spoke', () => {
  // Two aeroplanes on JFK–LAX do not make two destinations.
  const counts = hubSpokeCounts([
    { origin: 'JFK', destination: 'LAX', aircraftId: 'a' },
    { origin: 'LAX', destination: 'JFK', aircraftId: 'b' },
    { origin: 'JFK', destination: 'LAX', aircraftId: 'c' },
  ]);
  assert.equal(counts.JFK, 1);
});

test('a multi-stop rotation feeds every station it touches', () => {
  const counts = hubSpokeCounts([{ origin: 'JFK', destination: 'SFO', stops: ['JFK', 'ORD', 'SFO'] }]);
  assert.equal(counts.ORD, 2);   // sees JFK and SFO
  assert.equal(counts.JFK, 1);   // sees only ORD — it does not fly JFK–SFO nonstop
  assert.equal(counts.SFO, 1);
});

test('an empty or junk network counts nothing', () => {
  assert.deepEqual(hubSpokeCounts([]), {});
  assert.deepEqual(hubSpokeCounts(), {});
  assert.equal(pairConnectivityBonus({}, ['JFK'], 'JFK', 'LAX'), 0);
  assert.equal(pairConnectivityBonus(null, null, 'JFK', 'LAX'), 0);
});

test('the pair helper picks the better endpoint', () => {
  const counts = { JFK: 20, LAX: 3 };
  const both = pairConnectivityBonus(counts, ['JFK', 'LAX'], 'JFK', 'LAX');
  assert.ok(near(both, connectivityBonusForSpokes(20), 1e-12), 'should take the bigger hub');
  assert.equal(pairConnectivityBonus(counts, ['JFK'], 'BOS', 'SFO'), 0);
});

// A contested pair. The connectivity bonus is a term in the SHARE fight, so a
// route with no rival on it cannot show the effect however big the hub — which
// is exactly why an uncontested assertion here would be worthless.
const RIVALS = [
  { competitorId: 'r1', frequency: 28, priceMultiplier: 0.95, tier: 'legacy', seatsPerFlight: 200, qualityScore: 70 },
  { competitorId: 'r2', frequency: 21, priceMultiplier: 0.90, tier: 'budget', seatsPerFlight: 189, qualityScore: 58 },
];
const contested = (hubSpokes) => {
  const type = getAircraftType('b7878');
  const ac = { id: 'w', typeId: 'b7878', ageWeeks: 60, config: defaultConfig(type.seats) };
  const route = { id: 'r', origin: 'JFK', destination: 'ORD', hub: 'JFK',
                  aircraftId: 'w', weeklyFrequency: 21, ticketPrice: 240, weeksOpen: 60,
                  ...(hubSpokes == null ? {} : { hubSpokes }) };
  return simulateRoute(route, ac, { week: 30, month: 7 }, null, 1.0, null, RIVALS);
};

test('growing the network wins passengers off the competition', () => {
  // The reward the flat number withheld: open spokes, and every existing route
  // through the hub gets better.
  const solo = contested(1);
  const big  = contested(48);
  assert.ok(big.connectivityBonus > solo.connectivityBonus);
  assert.ok(big.passengers > solo.passengers * 1.05,
    `a 48-spoke hub carried ${big.passengers}, a 1-spoke one ${solo.passengers}`);
  // …and monotonically, not just at the ends.
  let prev = 0;
  for (const s of [1, 6, 12, 24, 48]) {
    const pax = contested(s).passengers;
    assert.ok(pax > prev, `${s} spokes carried ${pax}, fewer than the last step's ${prev}`);
    prev = pax;
  }
});

test('a route that omits hubSpokes is byte-identical to the old model', () => {
  // Every AI competitor and human rival takes this path — their offers must not
  // have moved, or this became a stealth rebalance of the whole world.
  const legacy = contested(null);
  assert.ok(near(legacy.connectivityBonus, 0.20, 1e-12));
  // The twelve-spoke calibration must land on precisely the same passengers.
  assert.equal(contested(CONNECTIVITY_LEGACY_SPOKES).passengers, legacy.passengers);
  assert.equal(contested(CONNECTIVITY_LEGACY_SPOKES).revenue, legacy.revenue);
});

// ── A14b: two ends, two seasons ────────────────────────────────────────────

console.log('\n── Directional seasonal skew ────────────────────────────');

test('a ski destination and a city are lopsided in opposite directions', () => {
  const jan = directionalSeasonalSkew('LHR', 'GVA', 1);
  const jul = directionalSeasonalSkew('LHR', 'GVA', 7);
  assert.ok(jan < -0.10, `January skew ${jan} should point at the snow`);
  assert.ok(jul > 0.10, `July skew ${jul} should point home`);
  assert.equal(Math.sign(jan), -Math.sign(jul));
});

test('two ends of the same season are never lopsided', () => {
  // Most of the world. This is why the change is narrow.
  assert.equal(seasonalProfileIdFor('JFK'), seasonalProfileIdFor('LAX'));
  for (let m = 1; m <= 12; m++) {
    assert.equal(directionalSeasonalSkew('JFK', 'LAX', m), 0, `month ${m}`);
  }
});

test('the skew is antisymmetric and capped', () => {
  for (const m of [1, 4, 7, 11]) {
    assert.ok(near(directionalSeasonalSkew('LHR', 'GVA', m),
                  -directionalSeasonalSkew('GVA', 'LHR', m), 1e-12));
  }
  for (const [o, d] of [['LHR', 'GVA'], ['LHR', 'PMI'], ['SYD', 'HKG'], ['JFK', 'DXB']]) {
    for (let m = 1; m <= 12; m++) {
      assert.ok(Math.abs(directionalSeasonalSkew(o, d, m)) <= SEASONAL_SKEW_CAP + 1e-12);
    }
  }
});

test('a missing or junk month is not lopsided', () => {
  for (const m of [null, undefined, 0, 13, NaN, 'July']) {
    assert.equal(directionalSeasonalSkew('LHR', 'GVA', m), 0, `month ${m}`);
  }
});

test('an empty aeroplane does not care which way the passengers point', () => {
  // The haircut must not touch a route with seats to spare — it is a spill
  // effect, not a tax.
  assert.equal(directionalLoadMultiplier(100, 1000, 0.3), 1);
  assert.equal(directionalLoadMultiplier(100, 1000, -0.3), 1);
});

test('a full aeroplane loses the seats the empty direction cannot sell', () => {
  const m = directionalLoadMultiplier(1000, 1000, 0.30);
  // Peak direction spills 300 (capped at 1000); off-peak carries 700.
  assert.ok(near(m, (1000 + 700) / 2000, 1e-12), `got ${m}`);
  assert.ok(m < 1);
});

test('the loss grows with the skew and never inverts', () => {
  let prev = 1.0000001;
  for (const s of [0.05, 0.10, 0.20, 0.35]) {
    const m = directionalLoadMultiplier(1000, 1000, s);
    assert.ok(m < prev, `skew ${s} (${m}) should cost more than the last`);
    assert.ok(m > 0.5, `skew ${s} took more than half the route`);
    prev = m;
  }
});

test('direction of the skew does not matter, only its size', () => {
  for (const s of [0.1, 0.25, 0.35]) {
    assert.ok(near(directionalLoadMultiplier(900, 800, s),
                   directionalLoadMultiplier(900, 800, -s), 1e-12));
  }
});

test('a balanced or degenerate week is exactly 1', () => {
  assert.equal(directionalLoadMultiplier(1000, 1000, 0), 1);
  assert.equal(directionalLoadMultiplier(0, 1000, 0.3), 1);
  assert.equal(directionalLoadMultiplier(1000, 0, 0.3), 1);
  assert.equal(directionalLoadMultiplier(1000, 1000, NaN), 1);
  assert.equal(directionalLoadMultiplier(1000, 1000, null), 1);
});

test('a seasonal route carries less than its average seasonality promises', () => {
  const type = getAircraftType('a320ceo');
  const ac = { id: 'a', typeId: 'a320ceo', ageWeeks: 60, config: defaultConfig(type.seats) };
  const mk = (o, d) => ({ id: 'r', origin: o, destination: d, hub: o, hubSpokes: 12,
    aircraftId: 'a', weeklyFrequency: 21, ticketPrice: 140, weeksOpen: 60 });
  const jan = simulateRoute(mk('LHR', 'GVA'), ac, { week: 4, month: 1 });
  assert.ok(jan, 'LHR–GVA should be flyable by an A320');
  assert.ok(jan.seasonalSkew < 0, `expected a January skew, got ${jan.seasonalSkew}`);
  if (jan.directionalScale < 1) {
    assert.ok(jan.loadFactor < 1, 'a skewed route cannot also be 100% full');
  } else {
    // directionalScale === 1 no longer implies "not capacity-bound".
    //
    // The model is handed UNCAPPED demand now, so a scale of 1 means one of two
    // things: the aeroplane is not full (nothing to lose), or demand is so far
    // above capacity that BOTH directions saturate and nothing is lost either.
    // This fixture is the second: LHR–GVA in January prices at 6,336 one-way
    // against 3,906 seats, so the peak direction spills and the off-peak still
    // fills — the correct haircut is exactly zero and the aeroplane is full.
    // Feeding the model capped demand pinned it in the first regime forever and
    // docked this route ~10% it could not lose.
    assert.ok(jan.loadFactor <= 1, 'load factor cannot exceed 1');
  }
});

test('a deeply oversubscribed skewed route takes no directional haircut', () => {
  // The property the branch above used to assert the opposite of.
  const type = getAircraftType('a320ceo');
  const ac = { id: 'a', typeId: 'a320ceo', ageWeeks: 60, config: defaultConfig(type.seats) };
  const jan = simulateRoute({ id: 'r', origin: 'LHR', destination: 'GVA', hub: 'LHR',
    hubSpokes: 12, aircraftId: 'a', weeklyFrequency: 21, ticketPrice: 140, weeksOpen: 60 },
    ac, { week: 4, month: 1 });
  assert.ok(jan.seasonalSkew < 0, 'fixture must be seasonally skewed');
  assert.equal(jan.directionalScale, 1,
    `demand far above capacity saturates both directions, so the haircut must be `
    + `exactly 1 — got ${jan.directionalScale}`);
  assert.ok(jan.loadFactor > 0.99, 'and the aeroplane fills');
});

test('a same-season route is untouched by the whole mechanism', () => {
  const type = getAircraftType('a320ceo');
  const ac = { id: 'a', typeId: 'a320ceo', ageWeeks: 60, config: defaultConfig(type.seats) };
  const r = simulateRoute({ id: 'r', origin: 'JFK', destination: 'ORD', hub: 'JFK', hubSpokes: 12,
    aircraftId: 'a', weeklyFrequency: 21, ticketPrice: 180, weeksOpen: 60 }, ac, { week: 26, month: 7 });
  assert.equal(r.seasonalSkew, 0);
  assert.equal(r.directionalScale, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
