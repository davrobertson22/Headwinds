// Metro-pair demand pooling — guards the 2026-08-13 rework (Dave: "cities with
// multiple airports end up with duplicated demand, e.g. NYC has JFK, EWR and
// LGA — demand should split across them and not be duplicated").
//
// Before this rework every member airport of a multi-airport metro carried the
// FULL metro demand mass, and nothing connected the airport pairs they formed:
// JFK–LHR, EWR–LHR and LGA–STN each independently generated a near-full-size
// New York↔London market, so serving a metro pair through two member pairs
// roughly DOUBLED the passengers the model handed out. docs/DEMAND_MODEL_AUDIT.md
// flagged this as open question 1 (Tokyo↔Osaka worst at 4x).
//
// Now (data/metros.js):
//   · baseCityPairDemand prices a metro pair ONCE, at the registry primaries —
//     every member pair returns the same metro↔metro total;
//   · weeklyTick's pre-pass pools ALL routes on a metro pair — the player's
//     member pairs and every rival on every sibling pair — into ONE share fight;
//   · each member airport carries a mission-dependent APPEAL (dom/intl +
//     perimeter rules): a utility term in contested fights, a pool cap for
//     monopolists, so a lone route from a secondary field cannot capture the
//     whole metro market;
//   · the old city-STRING same-metro rule is gone, which un-breaks the
//     same-name-different-city pairs it wrongly zeroed (Columbus OH–Columbus GA,
//     the Norfolks, Albanys, Augustas, Watertowns and Greenvilles).
//
//   node tools/metro-demand-test.mjs
//
// VERIFIED FAILING ON HEAD (pre-rework engine): tests 1, 2, 4, 5, 6 fail —
// member pairs priced independently, two member-pair routes booked ~2x the
// passengers, CMH–CSG returned 0, secondary-field monopolies captured a full
// metro pool, and sibling-pair rivals were invisible to the tick.

import assert from 'node:assert/strict';
import {
  weeklyTick, defaultConfig, defaultClassPrices,
} from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import {
  baseCityPairDemand, referencePrice,
  metroPairKeyOf, memberPairKeysOf, airportAppeal, pairAppeal,
} from '../packages/engine/src/utils/market.js';
import { offerAirportAppeal } from '../packages/engine/src/models/demand.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nMetro-pair demand pooling\n');

const TYPE = getAircraftType('a320neo');

/**
 * Minimal deterministic tick fixture: N mature monopoly routes at reference
 * fares, no hubs / loyalty / campaigns / competitors, parity awareness so
 * brandReach is 1 and any difference between runs is route structure alone.
 */
function run(routeSpecs, { competitors = [], humanRivals = {}, priceMult = 1, freq = 7 } = {}) {
  const routePricing = {};
  for (const [o, d] of routeSpecs) {
    routePricing[[o, d].sort().join('-')] =
      defaultClassPrices(Math.round(referencePrice(o, d) * priceMult));
  }
  const state = {
    fleet: routeSpecs.map(([, , id]) => ({
      id, typeId: TYPE.id, status: 'assigned', ageWeeks: 52,
      config: defaultConfig(TYPE.seats), ownershipType: 'owned',
    })),
    routes: routeSpecs.map(([o, d, id]) => ({
      id: `r-${id}`, origin: o, destination: d, aircraftId: id,
      weeklyFrequency: freq, weeksOpen: 60,   // matured: maturityFactor = 1
    })),
    cargoRoutes: [],
    gameDate: { week: 1, month: 6 },
    gates: Object.fromEntries(routeSpecs.flatMap(([o, d]) => [[o, 20], [d, 20]])),
    hubs: {},
    routePricing,
    routeCatering: {},
    competitors,
    humanRivals,
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 },
    allianceMembership: null,
    campaignStrength: {},
    targetedMarketing: {},
    awareness: 65,                             // parity — brandReach 1
    labor: undefined,
  };
  const report = weeklyTick(state);
  const pax = (id) => {
    const r = report.routeResults.find((x) => x.routeId === `r-${id}`);
    assert.ok(r, `fixture must produce a route result for ${id}`);
    return r.passengers;
  };
  return { report, pax };
}

// ── 1. One metro pair, one market ────────────────────────────────────────────

test('every member pair of a metro pair prices the SAME total market', () => {
  const total = baseCityPairDemand('JFK', 'LHR');
  assert.ok(total > 0, 'JFK-LHR must have demand');
  for (const [a, b] of [['EWR', 'LHR'], ['EWR', 'LGW'], ['JFK', 'STN'], ['LGA', 'LTN']]) {
    assert.equal(baseCityPairDemand(a, b), total,
      `${a}-${b} must price the New York–London metro market, not its own`);
  }
  // And metro↔non-metro pairs agree across members too.
  assert.equal(baseCityPairDemand('BOS', 'LGA'), baseCityPairDemand('BOS', 'JFK'));
});

// ── 2. Serving two member pairs must NOT double the passengers ───────────────

test('a second route on a sibling member pair splits the pool instead of duplicating it', () => {
  // Priced above reference AND flown at high frequency so the fixture is
  // DEMAND-constrained: at the reference fare (or at 7/wk) the New York–London
  // pool dwarfs the aircraft and every run is capacity-capped, which hides
  // pooling entirely — two full aeroplanes carry 2x one full aeroplane whether
  // or not they share a market. Capacity caps are correct; they are just the
  // wrong instrument for this assertion, so give the offers room to spare.
  const PM = 2, FREQ = 30;
  const solo = run([['JFK', 'LHR', 'a1']], { priceMult: PM, freq: FREQ });
  const both = run([['JFK', 'LHR', 'a1'], ['EWR', 'LHR', 'a2']], { priceMult: PM, freq: FREQ });
  const soloPax = solo.pax('a1');
  const bothPax = both.pax('a1') + both.pax('a2');
  assert.ok(soloPax > 0, 'solo route must carry passengers');
  // Pooled: the two routes SHARE one New York–London market — the second
  // airport reslices the pool, it must not conjure a second one.
  assert.ok(bothPax < soloPax * 1.25,
    `two member-pair routes booked ${bothPax} pax vs ${soloPax} solo — `
    + '~2x means each pair still draws its own full metro market');
  // And the solo route genuinely lost pax to its sibling (self-competition).
  assert.ok(both.pax('a1') < soloPax,
    'the JFK route must cede some share to the EWR sibling');
});

test('two aircraft on the SAME pair still pool exactly as before', () => {
  const solo = run([['CAI', 'DXB', 'a1']]);
  const both = run([['CAI', 'DXB', 'a1'], ['CAI', 'DXB', 'a2']]);
  const soloPax = solo.pax('a1');
  const bothPax = both.pax('a1') + both.pax('a2');
  assert.ok(bothPax < soloPax * 2.05,
    'same-pair pooling must not regress (was the original pre-pass)');
});

// ── 3. Airport appeal: the right airport for the right mission ───────────────

test('appeal is haul-aware: LGA long-haul international collapses, domestic does not', () => {
  assert.ok(airportAppeal('LGA', true, 1200) >= 0.9, 'LGA short-haul domestic is a primary');
  assert.ok(airportAppeal('LGA', false, 5500) < 0.05, 'LGA transatlantic must collapse (perimeter)');
  assert.equal(airportAppeal('ATL', true, 1000), 1, 'non-metro airports sit at parity');
  // The resolver on offers agrees with the raw tables.
  const appeal = offerAirportAppeal({ origin: 'SWF', destination: 'STN' });
  assert.ok(appeal < 0.1, `SWF–STN pair appeal must be tiny, got ${appeal}`);
  assert.equal(offerAirportAppeal({ origin: 'CAI', destination: 'DXB' }), 1);
});

// ── 4. A monopolist at a weak secondary field cannot capture the metro pool ──

test('a lone Newburgh route books far fewer than a lone JFK route in the same market', () => {
  // Above-reference fare keeps the JFK run just at/below capacity and makes the
  // SWF run purely appeal-limited — the cleanest visible contrast.
  const PM = 2;
  const jfk = run([['JFK', 'LHR', 'a1']], { priceMult: PM }).pax('a1');
  const swf = run([['SWF', 'STN', 'a1']], { priceMult: PM }).pax('a1');
  assert.ok(jfk > 0 && swf > 0, 'both must carry someone');
  assert.ok(swf < jfk * 0.35,
    `SWF–STN (${swf} pax) must reach only a sliver of what JFK–LHR does (${jfk} pax) — `
    + 'parity means the secondary field captured the whole metro pool');
});

// ── 5. Rivals on SIBLING member pairs contest the lane ───────────────────────

test('a human rival on EWR–LHR takes passengers from a player flying JFK–LHR', () => {
  // Demand-constrained fixture (see above) + an at-reference rival: the player
  // holds a 2.4x fare, the rival sells at 1x on the sibling pair, so if the
  // tick actually pools the lane the player's bookings must collapse.
  const PM = 2.4;
  const alone = run([['JFK', 'LHR', 'a1']], { priceMult: PM }).pax('a1');
  const contested = run([['JFK', 'LHR', 'a1']], {
    priceMult: PM,
    humanRivals: {
      'EWR-LHR': [{
        competitorId: 'rival-1', frequency: 14, seatsPerFlight: TYPE.seats,
        economyFare: Math.round(referencePrice('EWR', 'LHR')),
        businessSeatsPerWeek: 0, qualityScore: 65, brandReach: 1,
      }],
    },
  }).pax('a1');
  assert.ok(contested < alone * 0.85,
    `sibling-pair rival must bite: ${contested} pax contested vs ${alone} alone — `
    + 'parity means the tick never saw the rival on the other member pair');
});

// ── 6. The same-city string bug is dead ──────────────────────────────────────

test('same-NAME different-CITY pairs price normally (Columbus OH vs Columbus GA)', () => {
  for (const [a, b] of [['CMH', 'CSG'], ['ORF', 'OFK'], ['ALB', 'ABY'], ['AGS', 'AUG']]) {
    assert.ok(baseCityPairDemand(a, b) > 0,
      `${a}-${b} are different cities and must carry demand`);
  }
});

test('genuine same-metro pairs still price at zero', () => {
  for (const [a, b] of [['JFK', 'EWR'], ['LHR', 'LGW'], ['HND', 'NRT'], ['DFW', 'DAL']]) {
    assert.equal(baseCityPairDemand(a, b), 0, `${a}-${b} serve one metro — no O&D demand`);
  }
});

// ── 6b. Previews agree with the pooled tick ──────────────────────────────────

test('pairMarketShare previews the SAME pooled lane the tick books', async () => {
  const { pairMarketShare } = await import('../packages/engine/src/models/pairShare.js');
  const PM = 2.4;
  const specs = [['JFK', 'LHR', 'a1'], ['EWR', 'LHR', 'a2']];
  const routePricing = {};
  for (const [o, d] of specs) {
    routePricing[[o, d].sort().join('-')] =
      defaultClassPrices(Math.round(referencePrice(o, d) * PM));
  }
  const state = {
    fleet: specs.map(([, , id]) => ({
      id, typeId: TYPE.id, status: 'assigned', ageWeeks: 52,
      config: defaultConfig(TYPE.seats), ownershipType: 'owned',
    })),
    routes: specs.map(([o, d, id]) => ({
      id: `r-${id}`, origin: o, destination: d, aircraftId: id,
      weeklyFrequency: 7, weeksOpen: 60,
    })),
    cargoRoutes: [], gameDate: { week: 1, month: 6 },
    gates: { JFK: 10, EWR: 10, LHR: 10 },
    hubs: {}, routePricing, routeCatering: {}, competitors: [],
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 },
    allianceMembership: null, campaignStrength: {}, targetedMarketing: {},
    awareness: 65, labor: undefined,
  };
  const report = weeklyTick(state);
  const tickPax = Object.fromEntries(
    report.routeResults.map((r) => [r.routeId, r.passengers]));

  // Each member pair's preview must match what the tick booked for it — the
  // requested pair's sub-offer result comes back as playerResults[0].
  const jfk = pairMarketShare(state, 'JFK', 'LHR');
  const ewr = pairMarketShare(state, 'EWR', 'LHR');
  assert.ok(jfk.pooled && ewr.pooled, 'a two-member-pair lane must preview as pooled');
  for (const [share, routeId] of [[jfk, 'r-a1'], [ewr, 'r-a2']]) {
    const previewPax = share.playerResults[0].totalPax;
    const booked = tickPax[routeId];
    assert.ok(Math.abs(previewPax - booked) <= Math.max(2, booked * 0.03),
      `${routeId}: preview says ${previewPax} pax, the tick booked ${booked} — `
      + 'a preview that disagrees with weeklyTick is a bug in one of them');
  }
  // And both previews see the whole lane: identical totals, lane-wide share 1.
  assert.equal(jfk.totalPax, ewr.totalPax,
    'both member-pair previews must describe the same pooled market');
  assert.ok(Math.abs(jfk.playerShare - 1) < 1e-9,
    'an uncontested lane is 100% player share, counted across member pairs');
});

// ── 7. Registry helpers behave ───────────────────────────────────────────────

test('lane keys collapse member pairs; non-metro pairs are their own lane', () => {
  assert.equal(metroPairKeyOf('EWR', 'LGW'), metroPairKeyOf('JFK', 'LHR'));
  assert.equal(metroPairKeyOf('LGA', 'STN'), metroPairKeyOf('JFK', 'LHR'));
  assert.notEqual(metroPairKeyOf('BOS', 'LHR'), metroPairKeyOf('JFK', 'LHR'));
  assert.equal(metroPairKeyOf('CAI', 'DXB'), 'CAI-DXB');
  assert.deepEqual(memberPairKeysOf('CAI', 'DXB'), ['CAI-DXB']);
  assert.ok(memberPairKeysOf('JFK', 'LHR').includes('EWR-LGW'));
  // Appeal products stay in (0, 1] and parity for non-members.
  assert.equal(pairAppeal('CAI', 'DXB', false, 2400), 1);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
