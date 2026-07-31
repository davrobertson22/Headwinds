// Brand reach is a DEMAND term — guards the 2026-07-31 report
// ("my margins were tiny at first, now brand-new routes print 37–70% margins at
// the reference price, and revenue kept climbing for months while I opened no
// routes and changed no fares").
//
// The cause: brand awareness, reputation, the loyalty programme, alliance
// membership and rival ad pressure were multiplied together into `combinedMult`
// and applied to route REVENUE in weeklyTick — after the share fight and after
// the capacity cap:
//
//     boostedRevenue = (result.revenue - catering - ancillary) * combinedMult ...
//
// `result.revenue` is already pax x fare with pax capped at seats, so this moved
// no passengers at all. `passengers`, `loadFactor` and `classSummary` came back
// unboosted while `revenue` was scaled, which meant:
//
//   * revenue / pax stopped equalling the fare the player had set, and per-cabin
//     revenues stopped summing to the route total;
//   * Finance's yield (revenue / RPK) climbed year after year on routes nobody
//     had repriced — the "revenue keeps rising" in the report;
//   * a new airline at awareness 5 (multiplier 0.446) wasn't reaching 45% of the
//     market, it was selling every seat at 45% of its own ticket price — hence
//     full aircraft that lost money, which taught players to raise fares;
//   * and the payout was LARGEST at 100% load factor, where a stronger brand
//     cannot sell one more seat. The reward was exactly inverted.
//
// Meanwhile the freight path took the same awareness figure as `demandMultiplier`
// and correctly applied it to TONNES. One engine, two contradictory meanings.
//
// It is now `offer.brandReach`, consumed by the demand model: a pool multiplier
// on a monopoly, a log-odds share shift on a contested pair (see
// models/demand.js), assembled by `brandReachFor` in utils/simulation.js.
//
//   node tools/brand-demand-test.mjs

import assert from 'node:assert/strict';
import {
  weeklyTick, defaultConfig, defaultClassPrices, stateBrandReach,
} from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { awarenessDemandMultiplier } from '../packages/engine/src/data/overhead.js';
import { computeMarketShare, buildRouteMarket } from '../packages/engine/src/models/demand.js';
import { buildEncroachmentOffer } from '../packages/engine/src/models/encroachment.js';
import { toRivalSpecs } from '../apps/headwinds-server/src/lib/humanRivals.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nBrand reach is a demand term\n');

const TYPE = getAircraftType('a320neo');
const O = 'CAI', D = 'DXB';
const REF = Math.round(referencePrice(O, D));

/**
 * One monopoly route, no hubs, no loyalty, no alliance, no campaigns — so
 * brandReach reduces to awareness x reputation, and reputation is identical
 * across runs (same fleet, same age, same morale). Any difference between two
 * runs is therefore awareness and nothing else.
 */
function run(awareness, { weeklyFrequency, priceMult = 1 }) {
  const state = {
    fleet: [{
      id: 'a1', typeId: TYPE.id, status: 'assigned', ageWeeks: 52,
      config: defaultConfig(TYPE.seats), ownershipType: 'owned',
    }],
    routes: [{
      id: 'r1', origin: O, destination: D, aircraftId: 'a1',
      weeklyFrequency, weeksOpen: 60,       // matured: maturityFactor = 1
    }],
    cargoRoutes: [],
    gameDate: { week: 1, month: 6 },
    gates: { [O]: 10, [D]: 10 },
    hubs: {},                                // no hub => no loyalty concentration
    routePricing: { [[O, D].sort().join('-')]: defaultClassPrices(Math.round(REF * priceMult)) },
    routeCatering: {},
    competitors: [],
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 },
    allianceMembership: null,
    campaignStrength: {},
    targetedMarketing: {},
    awareness,
    labor: undefined,
  };
  const report = weeklyTick(state);
  const r = report.routeResults.find(x => x.routeId === 'r1');
  assert.ok(r, 'fixture must produce a route result');
  return r;
}

const UNKNOWN = 5;    // the default a brand-new airline starts at -> 0.446
const PARITY  = 65;   // "established carrier"                     -> 1.000

// ── 0. The fixture is what we think it is ────────────────────────────────────

test('the awareness curve still spans the range this test assumes', () => {
  assert.ok(Math.abs(awarenessDemandMultiplier(UNKNOWN) - 0.446) < 0.005,
    'awareness 5 should be ~0.446');
  assert.equal(awarenessDemandMultiplier(PARITY), 1);
});

// ── 1. The invariant that combinedMult broke ─────────────────────────────────

test('route revenue equals the tickets actually sold, at every awareness level', () => {
  for (const awareness of [UNKNOWN, 30, PARITY, 100]) {
    const r = run(awareness, { weeklyFrequency: 14 });
    const cabins = Object.values(r.classSummary ?? {})
      .reduce((s, c) => s + (c.revenue ?? 0), 0);
    const nonTicket = (r.connecting?.totalRevenue ?? 0)
      + (r.cateringRevenue ?? 0) + (r.ancillaryRevenue ?? 0);
    const tickets = r.revenue - nonTicket;
    // Rounding: revenue is rounded once per cabin and once for the route.
    assert.ok(Math.abs(tickets - cabins) <= 2,
      `at awareness ${awareness} the route booked $${cabins.toLocaleString()} of `
      + `tickets but reported $${tickets.toLocaleString()} of ticket revenue — a `
      + `$${(tickets - cabins).toLocaleString()} fare nobody was charged`);
  }
});

test('implied fare per passenger is the fare the player set', () => {
  const r = run(UNKNOWN, { weeklyFrequency: 14 });
  const eco = r.classSummary?.economy;
  assert.ok(eco && eco.passengers > 0, 'fixture must carry economy passengers');
  // classSummary stores one-way pax; revenue covers both directions.
  const impliedFare = eco.revenue / (eco.passengers * 2);
  assert.ok(Math.abs(impliedFare - REF) < 1,
    `an unknown brand must sell at the price on the ticket ($${REF}), `
    + `not $${impliedFare.toFixed(2)}`);
});

// ── 2. It moves passengers, which is the whole point ─────────────────────────

test('a stronger brand carries MORE PEOPLE when there are seats to sell', () => {
  // High frequency, and priced well above reference so demand doesn't swamp the
  // cabin: capacity comfortably exceeds demand, so the brand has somewhere to
  // put the extra passengers it wins. (CAI–DXB at the reference fare sells out
  // even at 60x/week, which is itself why the old bug hid so well — the routes
  // players actually fly are demand-rich and permanently capped.)
  const weak   = run(UNKNOWN, { weeklyFrequency: 60, priceMult: 2.0 });
  const strong = run(PARITY,  { weeklyFrequency: 60, priceMult: 2.0 });
  assert.equal(weak.capacityCapped, false, 'fixture must have spare seats');
  assert.equal(strong.capacityCapped, false, 'fixture must have spare seats');
  // Reach 0.446 -> 1.000 is a 2.24x pool on a monopoly; allow slack for the
  // elasticity and rounding that sit downstream of the pool multiplier.
  const ratio = strong.passengers / weak.passengers;
  assert.ok(ratio > 2.0 && ratio < 2.5,
    `awareness must change PAX — as a revenue multiplier it changed none. `
    + `expected ~2.24x, got ${weak.passengers} -> ${strong.passengers} (${ratio.toFixed(2)}x)`);
  assert.ok(strong.loadFactor > weak.loadFactor,
    'an unknown brand flies emptier aircraft; that is the legible signal the '
    + 'player never got while this was hidden in the fare');
});

// ── 3. And it stops printing money on sold-out flights ───────────────────────

test('a full aircraft earns the same no matter how famous the airline is', () => {
  // Low frequency at the reference fare: demand swamps capacity either way.
  const weak   = run(UNKNOWN, { weeklyFrequency: 3 });
  const strong = run(PARITY,  { weeklyFrequency: 3 });
  assert.equal(weak.capacityCapped, true, 'fixture must be capacity-capped');
  assert.equal(strong.capacityCapped, true, 'fixture must be capacity-capped');
  assert.equal(weak.passengers, strong.passengers,
    'both flights are full — there is no seat left for a brand to sell');
  const gap = Math.abs(strong.revenue - weak.revenue) / weak.revenue;
  assert.ok(gap < 0.005,
    `same seats, same fare, same load — revenue must match. As a post-cap `
    + `multiplier this route paid out ${((strong.revenue / weak.revenue - 1) * 100).toFixed(0)}% `
    + `more for a brand that could not sell a single extra ticket`);
});

test('operating profit on a sold-out route does not move with awareness', () => {
  const weak   = run(UNKNOWN, { weeklyFrequency: 3 });
  const strong = run(PARITY,  { weeklyFrequency: 3 });
  assert.ok(Math.abs(strong.profit - weak.profit) <= Math.abs(weak.profit) * 0.005,
    'the reported symptom: identical routes, wildly different margins, purely '
    + 'because one airline had been flying longer');
});

// ── 4. Multiplayer symmetry ─────────────────────────────────────────────────
// brandReach only lands on the PLAYER's offer inside weeklyTick. Human rivals
// arrive as encroachment specs built by the server, and an offer with no
// brandReach sits at parity (1) by design — correct for solo AI incumbents,
// badly wrong for a human rival in a fresh world. Without the server shipping
// the figure, two week-one airlines each scored the OTHER as an established
// brand and under-counted their own share from both sides.

const RIVAL_TYPE = getAircraftType('b737800');
function rivalRow(awareness, id = 'r1') {
  const cfg = defaultConfig(RIVAL_TYPE.seats);
  return {
    id, name: 'Rival Air', status: 'ACTIVE', hub: O,
    state: {
      airlineName: 'Rival Air', hub: O, hubs: {},
      fleet: [{ id: 'f1', typeId: RIVAL_TYPE.id, status: 'assigned',
                ageWeeks: 52, config: cfg, ownershipType: 'leased' }],
      routes: [{ id: 'rr1', origin: O, destination: D, aircraftId: 'f1',
                 weeklyFrequency: 14, weeksOpen: 40 }],
      cargoRoutes: [], routePricing: { [[O, D].sort().join('-')]: { economy: REF } },
      loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 },
      awareness,
    },
  };
}

test('the server ships each human rival its real brand reach', () => {
  const specs = toRivalSpecs(rivalRow(UNKNOWN));
  const spec = specs[[O, D].sort().join('-')];
  assert.ok(spec, 'fixture must produce a spec for the pair');
  assert.ok(typeof spec.brandReach === 'number',
    'without this field every human rival is scored as an established brand');
  assert.ok(spec.brandReach < 0.6,
    `a week-one airline must not read as famous — got ${spec.brandReach}`);
  const famous = toRivalSpecs(rivalRow(100))[[O, D].sort().join('-')];
  assert.ok(famous.brandReach > spec.brandReach * 1.8,
    'and a household name must read as one');
});

test('buildEncroachmentOffer carries brand reach through to the demand model', () => {
  const market = buildRouteMarket(O, D, { week: 1, month: 6 }, 1, 1);
  const spec = toRivalSpecs(rivalRow(UNKNOWN))[[O, D].sort().join('-')];
  const offer = buildEncroachmentOffer(spec, market);
  assert.equal(offer.brandReach, spec.brandReach);
});

test('two identical week-one airlines split a contested pair evenly', () => {
  // THE MP BUG. Same fare, same aircraft, same frequency, same awareness — the
  // only honest answer is 50/50. With the rival defaulting to parity while the
  // player carried 0.446, each side scored itself at roughly 31%.
  const market = buildRouteMarket(O, D, { week: 1, month: 6 }, 1, 1);
  const row  = rivalRow(UNKNOWN);
  const spec = toRivalSpecs(row)[[O, D].sort().join('-')];
  const them = buildEncroachmentOffer(spec, market);
  // Both sides resolved the way the real code does: the PLAYER's reach comes
  // from their own state (weeklyTick's brandReachFor / stateBrandReach), the
  // RIVAL's has to survive the trip through the server spec and the offer
  // builder. Deriving both from one object would hide exactly the bug this
  // guards — it is the disagreement between the two paths that matters.
  const you = { ...them, airlineId: 'player',
                brandReach: stateBrandReach(row.state, 0, false) };
  const [mine] = computeMarketShare(market, [you, them]);
  assert.ok(Math.abs(mine.leisureShare - 0.5) < 0.01,
    `identical unknown carriers must split evenly — got ${(mine.leisureShare * 100).toFixed(1)}%. `
    + `you ${you.brandReach?.toFixed(3)} vs them ${them.brandReach?.toFixed(3)}`);
});

test('a spec with no brandReach still sits at parity', () => {
  // Solo AI encroachers are incumbents; the player is the unknown one. That
  // asymmetry is deliberate and must survive.
  const market = buildRouteMarket(O, D, { week: 1, month: 6 }, 1, 1);
  const spec = toRivalSpecs(rivalRow(UNKNOWN))[[O, D].sort().join('-')];
  delete spec.brandReach;
  assert.equal(buildEncroachmentOffer(spec, market).brandReach, 1);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
