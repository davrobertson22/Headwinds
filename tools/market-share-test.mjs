// Market share — guards the class of errors behind the 2026-07-29 Discord report
// ("I have more flights, more seats, better quality, more advertising and have a
// 26% lower ticket price and yet only hold a 53% market share for that route").
//
// The reported 53% was ATL–DFW: 35 weekly departures against a rival's 31.
// 35 / (35 + 31) = 53.03%. AirportDetail's "Your Share" column was a ratio of
// FLIGHT COUNTS wearing the label of a market share — fare, quality, seats and
// advertising appeared nowhere in it. The demand model put the same player at
// ~68%. Four separate defects fell out of investigating it:
//
//   1. A departure ratio presented as market share (the UI half — the fix routes
//      that column through pairMarketShare, so the two can never diverge again).
//   2. Human rivals were denied the hub connectivity bonus in the weekly tick
//      (buildEncroachmentOffer hardcoded 0) but GRANTED it in the client's
//      preview (buildCompetitorOffer), so the predicted share and the actual
//      share disagreed by several points on every hub route.
//   3. Human rivals were modelled as tier 'legacy' and therefore always sold a
//      business cabin at 3.5x their economy fare — even all-economy carriers,
//      which competed for premium passengers they could not carry.
//   4. Targeted advertising multiplied route REVENUE after the share fight was
//      over, so a player could outspend every rival at both endpoints and watch
//      their market share sit perfectly still. It is a utility term now.
//
//   node tools/market-share-test.mjs

import assert from 'node:assert/strict';
import {
  computeUtility, softmax, computeMarketShare, buildCompetitorOffer,
  UTILITY_WEIGHTS, BUSINESS_PRICE_MULTIPLIER,
} from '../packages/engine/src/models/demand.js';
import { buildEncroachmentOffer } from '../packages/engine/src/models/encroachment.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nMarket share\n');

// ── The reported route, as a fixture ─────────────────────────────────────────
// ATL–DFW, reference fare $162. Player: $120 (26% under reference), quality 71,
// 35x/week, 10,325 seats/week, hubbed at ATL. Rival "Otter Air": $162, quality
// 62, 31x/week, 4,185 seats/week.
const MARKET = {
  origin: 'ATL', destination: 'DFW',
  referencePrice: 162,
  distanceKm: 1160,
  leisureDemand: 7600,
  businessDemand: 2100,
};
const YOU = {
  airlineId: 'player',
  origin: 'ATL', destination: 'DFW',
  economyPrice: 120, businessPrice: 420,
  weeklyFrequency: 35,
  seatsPerFlight: 295, economySeats: 9500, businessSeats: 825, totalSeats: 10325,
  qualityScore: 71, connectivityBonus: 0.20,
};
const OTTER = {
  airlineId: 'otter',
  origin: 'ATL', destination: 'DFW',
  economyPrice: 162, businessPrice: 567,
  weeklyFrequency: 31,
  seatsPerFlight: 135, economySeats: 3800, businessSeats: 385, totalSeats: 4185,
  qualityScore: 62, connectivityBonus: 0,
};

const shareOf = (offers, id, seg = 'leisure') => {
  const utils = offers.map(o => computeUtility(o, MARKET, seg));
  const s = softmax(utils);
  return s[offers.findIndex(o => o.airlineId === id)];
};

// ── 1. A departure ratio is NOT a market share ───────────────────────────────

test('the reported 53% is exactly the departure ratio, not a market share', () => {
  const departureRatio = YOU.weeklyFrequency / (YOU.weeklyFrequency + OTTER.weeklyFrequency);
  assert.equal(Math.round(departureRatio * 100), 53,
    'fixture drift: this test exists because 35/(35+31) rounds to the reported 53%');
});

test('the demand model puts that player far above their departure ratio', () => {
  const departureRatio = YOU.weeklyFrequency / (YOU.weeklyFrequency + OTTER.weeklyFrequency);
  const modelled = shareOf([YOU, OTTER], 'player');
  assert.ok(modelled > departureRatio + 0.10,
    `undercutting by 26% with 2.5x the seats and higher quality should beat a raw `
    + `flight-count ratio by more than 10 points — got ${(modelled * 100).toFixed(1)}% `
    + `vs ${(departureRatio * 100).toFixed(1)}%`);
  assert.ok(modelled > 0.60 && modelled < 0.80,
    `expected roughly two thirds of the market, got ${(modelled * 100).toFixed(1)}%`);
});

test('a departure ratio ignores every lever the player actually pulled', () => {
  // Same schedule, wildly worse product: the flight-count ratio cannot move,
  // which is precisely why it must never be labelled market share.
  const crippled = { ...YOU, economyPrice: 400, qualityScore: 20 };
  const before = shareOf([YOU, OTTER], 'player');
  const after  = shareOf([crippled, OTTER], 'player');
  assert.equal(crippled.weeklyFrequency, YOU.weeklyFrequency);   // ratio unchanged
  assert.ok(after < before - 0.25,
    `tripling the fare and gutting quality must collapse share; ${(before * 100).toFixed(1)}% → ${(after * 100).toFixed(1)}%`);
});

// ── 2. Preview and tick must agree about a human rival's hub ─────────────────

test('a rival flying from its own hub gets the connecting-feed bonus in the tick', () => {
  const spec = {
    competitorId: 'human:1', tier: 'legacy', qualityScore: 62,
    frequency: 31, seatsPerFlight: 135, priceMultiplier: 1,
    homeHub: 'DFW',
  };
  const offer = buildEncroachmentOffer(spec, MARKET);
  assert.equal(offer.connectivityBonus, 0.20,
    'a rival hubbed at an endpoint feeds the route exactly like the player does');
});

test('the client preview and the weekly tick score that rival identically', () => {
  const shared = {
    frequency: 31, seatsPerWeek: 4185, seats: 135, economyFare: 162,
    businessSeatsPerWeek: 385, businessFare: 567,
  };
  const viaTick = buildEncroachmentOffer({
    competitorId: 'human:1', tier: 'legacy', qualityScore: 62, homeHub: 'DFW',
    seatsPerFlight: 135, priceMultiplier: 1, ...shared,
  }, MARKET);
  const viaPreview = buildCompetitorOffer({
    id: 'human:1', human: true, tier: 'legacy', baseQualityScore: 62, homeHub: 'DFW',
    routes: { 'ATL-DFW': { priceMultiplier: 1, ...shared } },
  }, MARKET);

  for (const field of ['economyPrice', 'businessPrice', 'weeklyFrequency',
                       'economySeats', 'businessSeats', 'qualityScore',
                       'connectivityBonus']) {
    assert.equal(viaPreview[field], viaTick[field],
      `${field}: preview says ${viaPreview[field]}, tick says ${viaTick[field]} — `
      + 'a share preview that disagrees with the tick is the bug this test exists for');
  }
});

test('a solo AI encroacher still gets no hub bonus (no homeHub on its spec)', () => {
  const offer = buildEncroachmentOffer({
    competitorId: 'ai:1', tier: 'legacy', qualityScore: 60,
    frequency: 10, seatsPerFlight: 180, priceMultiplier: 0.9,
  }, MARKET);
  assert.equal(offer.connectivityBonus, 0);
});

// ── 3. No phantom business cabin ─────────────────────────────────────────────

test('an all-economy rival is not handed a business cabin by its tier', () => {
  const offer = buildEncroachmentOffer({
    competitorId: 'human:2', tier: 'legacy', qualityScore: 62,
    frequency: 20, seatsPerFlight: 180, priceMultiplier: 1,
    economyFare: 150, businessSeatsPerWeek: 0,
  }, MARKET);
  assert.equal(offer.businessSeats, 0);
  assert.equal(offer.businessPrice, null,
    'a carrier with no premium seats must not hold a premium fare — it would '
    + 'compete for business travellers it cannot carry');
});

test('a rival that DOES sell business gets its real fare, not economy x3.5', () => {
  const offer = buildEncroachmentOffer({
    competitorId: 'human:3', tier: 'legacy', qualityScore: 70,
    frequency: 20, seatsPerFlight: 200, priceMultiplier: 1,
    economyFare: 150, businessSeatsPerWeek: 400, businessFare: 480,
  }, MARKET);
  assert.equal(offer.businessPrice, 480);
  assert.notEqual(offer.businessPrice, Math.round(150 * BUSINESS_PRICE_MULTIPLIER));
  assert.equal(offer.businessSeats, 400);
  assert.equal(offer.economySeats, 200 * 20 - 400,
    'economy capacity is what is left once the premium cabin is carved out');
});

test('an economy-only carrier wins no business-segment share', () => {
  const allEconomy = { ...OTTER, businessPrice: null, businessSeats: 0 };
  const results = computeMarketShare(MARKET, [YOU, allEconomy]);
  const otter = results.find(r => r.airlineId === 'otter');
  assert.equal(otter.businessShare, 0);
  assert.equal(otter.businessPax, 0);
});

// ── 4. buildCompetitorOffer trusts the data the server actually sent ─────────

test('a human rival\'s published fare beats a reverse-engineered multiple', () => {
  const offer = buildCompetitorOffer({
    id: 'human:4', human: true, tier: 'legacy', baseQualityScore: 60, homeHub: 'DFW',
    // The multiplier is stale (it lags a fare change by a tick); economyFare is
    // what the rival is charging RIGHT NOW.
    routes: { 'ATL-DFW': { frequency: 14, priceMultiplier: 0.98, economyFare: 129,
                           seatsPerWeek: 2520, seats: 180 } },
  }, MARKET);
  assert.equal(offer.economyPrice, 129);
  assert.notEqual(offer.economyPrice, Math.round(MARKET.referencePrice * 0.98),
    'falling back to the reference multiple hands the model a fare nobody is selling');
});

test('a mixed-fleet rival is sized by blended seats, not its first aircraft type', () => {
  // 7x a 300-seat widebody + 7x a 70-seat turboprop = 2,590 seats/week.
  // Reading `aircraftType` (the first type found) would have said 14 x 300 = 4,200.
  const offer = buildCompetitorOffer({
    id: 'human:5', human: true, tier: 'legacy', baseQualityScore: 60, homeHub: 'DFW',
    routes: { 'ATL-DFW': { frequency: 14, priceMultiplier: 1, economyFare: 162,
                           seatsPerWeek: 2590, seats: 185,
                           aircraftTypes: ['b777300er', 'crj700'],
                           aircraftType: 'b777300er' } },
  }, MARKET);
  assert.equal(offer.seatsPerFlight, Math.round(2590 / 14));
  assert.ok(offer.economySeats <= 2590,
    `blended capacity is ${offer.economySeats}, must not exceed the 2,590 seats actually flown`);
});

// ── 5. Advertising buys passengers, and buys them exactly once ──────────────

test('a campaign moves market share on a contested pair', () => {
  const plain      = shareOf([YOU, OTTER], 'player');
  const advertised = shareOf([{ ...YOU, marketingBoost: 0.075 }, OTTER], 'player');
  assert.ok(advertised > plain,
    'advertising used to multiply revenue AFTER the share fight, so this was a '
    + 'no-op — the whole point of the report was that it did nothing');
  assert.ok(advertised - plain > 0.02 && advertised - plain < 0.08,
    `a sustained ~7.5% campaign should be worth a few points of share, got `
    + `+${((advertised - plain) * 100).toFixed(1)}`);
});

test('business travellers are half as swayed by advertising as leisure ones', () => {
  const lGain = shareOf([{ ...YOU, marketingBoost: 0.1 }, OTTER], 'player')
              - shareOf([YOU, OTTER], 'player');
  const bGain = shareOf([{ ...YOU, marketingBoost: 0.1 }, OTTER], 'player', 'business')
              - shareOf([YOU, OTTER], 'player', 'business');
  assert.ok(lGain > bGain,
    'corporate travel policy and schedule beat advertising for business travellers');
  assert.equal(UTILITY_WEIGHTS.business.marketing, UTILITY_WEIGHTS.leisure.marketing / 2);
});

test('a campaign still lifts demand on an UNCONTESTED pair', () => {
  const [plain]      = computeMarketShare(MARKET, [{ ...YOU, totalSeats: 1e9, economySeats: 1e9 }]);
  const [advertised] = computeMarketShare(MARKET,
    [{ ...YOU, totalSeats: 1e9, economySeats: 1e9, marketingBoost: 0.10 }]);
  assert.ok(advertised.totalPax > plain.totalPax,
    'with no rival to take passengers from, a campaign has to grow the pool instead');
  const lift = advertised.leisurePax / plain.leisurePax - 1;
  assert.ok(Math.abs(lift - 0.10) < 0.02,
    `monopoly lift should track the campaign boost 1:1 (the old magnitude), got ${(lift * 100).toFixed(1)}%`);
});

test('an offer with no marketingBoost is scored exactly as before', () => {
  const withField    = computeUtility({ ...YOU, marketingBoost: 0 }, MARKET, 'leisure');
  const withoutField = computeUtility(YOU, MARKET, 'leisure');
  assert.equal(withField, withoutField,
    'every caller that has not opted in must be byte-identical');
});

// ── 5b. Brand reach sells SEATS, never a fare the player never set ───────────
// Awareness, reputation, loyalty and alliance membership used to be multiplied
// together into `combinedMult` and applied to route REVENUE — after the share
// fight and after the capacity cap. It moved no passengers: `passengers`,
// `loadFactor` and `classSummary` came back unboosted while `revenue` was
// scaled, so a full aircraft booked at the reference fare reported revenue that
// no ticket price could produce, and the payout was LARGEST at 100% load, where
// a brand cannot sell one more seat. These pin it to the demand model.

test('brand reach moves market share on a contested pair', () => {
  const known   = shareOf([{ ...YOU, brandReach: 1.0  }, OTTER], 'player');
  const unknown = shareOf([{ ...YOU, brandReach: 0.45 }, OTTER], 'player');
  assert.ok(unknown < known,
    'a brand the market has never heard of must lose passengers TO ITS RIVAL, '
    + 'not quietly sell the same seats at 45% of the fare it set');
  assert.ok(known - unknown > 0.10,
    `awareness 5 vs parity is a 2.2x swing in reach; got only `
    + `${((known - unknown) * 100).toFixed(1)} points of share`);
});

test('brand reach enters utility as a log, so it scales the softmax weight exactly', () => {
  const base = computeUtility({ ...YOU, brandReach: 1 },   MARKET, 'leisure');
  const half = computeUtility({ ...YOU, brandReach: 0.5 }, MARKET, 'leisure');
  assert.ok(Math.abs((base - half) - Math.log(2)) < 1e-9,
    'softmax share is proportional to exp(utility), so a demand multiplier of b '
    + 'is log(b) in utility space — anything else is a different magnitude '
    + 'in the contested path than in the monopoly path');
});

test('brand reach shrinks the pool on an UNCONTESTED pair', () => {
  const big = { ...YOU, totalSeats: 1e9, economySeats: 1e9, businessSeats: 1e9 };
  const [full]    = computeMarketShare(MARKET, [{ ...big, brandReach: 1.0 }]);
  const [unknown] = computeMarketShare(MARKET, [{ ...big, brandReach: 0.45 }]);
  const ratio = unknown.leisurePax / full.leisurePax;
  assert.ok(Math.abs(ratio - 0.45) < 0.02,
    `with no rival to lose share to, an unknown brand loses passengers to `
    + `not-flying, 1:1 with reach — got ${ratio.toFixed(3)} instead of 0.45`);
});

test('brand reach cannot conjure revenue on a route already at 100% load', () => {
  // THE BUG, in one assertion. Seats deliberately far below demand so both
  // offers are capacity-capped: same aircraft, same fare, same full cabin.
  const capped = { ...YOU, totalSeats: 400, economySeats: 400, businessSeats: 0,
                   businessPrice: null };
  const [weak]   = computeMarketShare(MARKET, [{ ...capped, brandReach: 0.45 }]);
  const [strong] = computeMarketShare(MARKET, [{ ...capped, brandReach: 1.35 }]);
  assert.equal(weak.totalPax, strong.totalPax,
    'both aircraft are full — brand cannot add a passenger to a sold-out flight');
  assert.equal(weak.totalRevenue, strong.totalRevenue,
    'and it must not add revenue either. As a post-cap revenue multiplier this '
    + 'was a 3x payout on exactly the routes where it could sell nothing');
});

test('revenue divided by passengers equals the fare that was set', () => {
  // The invariant combinedMult broke: revenue was scaled while pax was not, so
  // revenue / pax stopped being a price anyone was charged, and Finance's
  // yield (revenue / RPK) drifted upward on routes nobody had repriced.
  const solo = { ...YOU, totalSeats: 400, economySeats: 400, businessSeats: 0,
                 businessPrice: null };
  for (const brandReach of [0.45, 1.0, 1.35]) {
    const [r] = computeMarketShare(MARKET, [{ ...solo, brandReach }]);
    assert.equal(r.economyRevenue, r.leisurePax * solo.economyPrice,
      `at brandReach ${brandReach} the implied fare was `
      + `$${(r.economyRevenue / Math.max(r.leisurePax, 1)).toFixed(2)}, `
      + `but the player set $${solo.economyPrice}`);
  }
});

test('an offer with no brandReach is scored exactly as before', () => {
  const withField    = computeUtility({ ...YOU, brandReach: 1 }, MARKET, 'leisure');
  const withoutField = computeUtility(YOU, MARKET, 'leisure');
  assert.equal(withField, withoutField,
    'AI competitors, previews and every existing test sit at parity');
  const big = { ...YOU, totalSeats: 1e9, economySeats: 1e9 };
  const [a] = computeMarketShare(MARKET, [{ ...big, brandReach: 1 }]);
  const [b] = computeMarketShare(MARKET, [big]);
  assert.equal(a.totalRevenue, b.totalRevenue, 'monopoly path too');
});

// ── 6. End to end: the screen that reported 53% now asks the model ──────────
// pairShare.js is the Headwinds-only module AirportDetail calls. Skipped in the
// solo repo, which has no such screen.

let pairShare = null;
try { pairShare = await import('../packages/engine/src/models/pairShare.js'); } catch { /* solo repo */ }

if (pairShare) {
  const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
  const A = getAircraftType('b737900er') ?? getAircraftType('b737800');
  const B = getAircraftType('a321neo')   ?? getAircraftType('a320neo');

  const tail = (id, typeId) => ({ id, typeId, ageWeeks: 40, config: null, ownershipType: 'leased', status: 'active' });
  const STATE = {
    gameDate: { week: 30, year: 1, month: 6 },
    cash: 5e7, airlineName: 'Test Air', hub: 'ATL', hubs: { ATL: { tier: 2 } },
    fleet: [tail('t1', A.id), tail('t2', B.id)],
    // 18x + 17x = the reported 35 weekly departures, split across two aircraft.
    routes: [
      { id: 'r1', origin: 'ATL', destination: 'DFW', aircraftId: 't1', weeklyFrequency: 18, ticketPrice: 120, weeksOpen: 40 },
      { id: 'r2', origin: 'ATL', destination: 'DFW', aircraftId: 't2', weeklyFrequency: 17, ticketPrice: 120, weeksOpen: 40 },
    ],
    cargoRoutes: [], routePricing: { 'ATL-DFW': { economy: 120 } },
    campaignStrength: { ATL: 50, DFW: 50 },
    // An established carrier: 35 weekly departures, a T2 hub and live campaigns
    // at both endpoints. Awareness is now a DEMAND term (offer.brandReach), so
    // leaving it unset would default this fixture to the 5-point unknown-brand
    // floor and quietly turn a test about "does this screen ask the model?" into
    // a test about brand. Parity (65) keeps the subject the channel, not the brand.
    awareness: 65,
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 },
    competitors: [],
    humanRivals: {
      'ATL-DFW': [{
        competitorId: 'human:otter', name: 'Otter Air', tier: 'legacy', qualityScore: 62,
        homeHub: 'DFW', frequency: 31, seatsPerFlight: 135, priceMultiplier: 1,
        economyFare: 162, businessSeatsPerWeek: 0, businessFare: null,
      }],
    },
    financialHistory: [], statsHistory: [],
  };

  test('the airport page reports the model\'s share, not a departure ratio', () => {
    const { playerShare, contested } = pairShare.pairMarketShare(STATE, 'ATL', 'DFW');
    assert.equal(contested, true);
    assert.ok(playerShare > 0.60,
      `the screen that reported 53% must now report the model's answer — got ${(playerShare * 100).toFixed(1)}%`);
    assert.ok(Math.abs(playerShare - 35 / 66) > 0.10,
      'if this lands back on the departure ratio, the column has regressed');
  });

  test('two aircraft on one pair compete as ONE carrier, not two', () => {
    const { offers } = pairShare.pairMarketShare(STATE, 'ATL', 'DFW');
    const mine = offers.filter(o => o.airlineId === 'player');
    assert.equal(mine.length, 1, 'a pair flown by two tails is still one airline');
    assert.equal(mine[0].weeklyFrequency, 35, 'the combined offer carries the whole schedule');
  });

  test('an uncontested pair is 100%, and a pair you do not fly is null', () => {
    const solo = pairShare.pairMarketShare({ ...STATE, humanRivals: {} }, 'ATL', 'DFW');
    assert.equal(solo.playerShare, 1);
    assert.equal(solo.contested, false);
    const unserved = pairShare.pairMarketShare(STATE, 'ATL', 'LAX');
    assert.equal(unserved.playerShare, null, 'the cell renders an em dash, not 0%');
  });

  test('a human rival is not counted twice when it also appears in competitors', () => {
    const both = {
      ...STATE,
      competitors: [{
        id: 'human:otter', human: true, name: 'Otter Air', tier: 'legacy',
        baseQualityScore: 62, homeHub: 'DFW',
        routes: { 'ATL-DFW': { frequency: 31, priceMultiplier: 1, economyFare: 162,
                               seatsPerWeek: 4185, seats: 135, businessSeatsPerWeek: 0 } },
      }],
    };
    const a = pairShare.pairMarketShare(STATE, 'ATL', 'DFW');
    const b = pairShare.pairMarketShare(both,  'ATL', 'DFW');
    assert.equal(b.offers.length, a.offers.length,
      'the server ships every human rival in BOTH state.competitors and '
      + 'state.humanRivals — adding them from both lists would halve your share');
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
