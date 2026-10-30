// Travel partnerships — cruise lines, tour operators, hotel chains, ride share.
//
// Guards the decisions locked with Dave on 2026-10-29 (PARTNERSHIPS_PLAN.md):
//
//   1. Cruise + tours lift LEISURE; hotels + ride share lift BUSINESS, at the
//      airports the partner covers — cruise lines only in their season.
//   2. Each partner sets its own requirements; combined attainment moves
//      happiness 10%/week toward a target (80 for meeting the brief exactly).
//   3. Happiness fades the lift (full ≥50, none at 20), prices the renewal and
//      feeds reputation (+2 … −8).
//   4. Every contract is 2 years, paid in two annual instalments through the
//      weekly report.
//   5. A partner that walks out (below 15 for 4 weeks) or refuses to renew is
//      LOST for 5 years. Breaking early yourself is not losing it.
//   6. Shared book, new worlds only (state.partnershipsWorld).
//   7. An airline without partners is byte-identical (golden master), and
//      previews agree with the tick.
//
//   node tools/travel-partners-test.mjs

import assert from 'node:assert/strict';
import {
  weeklyTick, defaultClassPrices, stateTravelPartnerFields, routeStops,
} from '../packages/engine/src/utils/simulation.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { defaultAncillaries } from '../packages/engine/src/data/ancillaries.js';
import { calcReputation } from '../packages/engine/src/models/reputation.js';
import { pairMarketShare } from '../packages/engine/src/models/pairShare.js';
import { costBridge, bridgeInputsFromReport } from '../packages/engine/src/utils/pnlBridge.js';
import {
  TRAVEL_PARTNERS, TRAVEL_PARTNER_MAP, TP_TYPES, TP_TERM_WEEKS, TP_LOST_COOLDOWN_WEEKS,
  TP_APPEAL_CAP, TP_BOOK_DRIFT,
  travelPartnerAirports, travelPartnerInSeason, travelLiftScale, travelAppealForPair, travelPartnerAt,
  travelPartnerFieldsFor, travelPartnerListFee, makeTravelPartnerContract, canSignTravelPartner,
  requirementAttainment, combinedAttainment, targetHappiness, requirementTarget, contractTargets,
  rolloverTravelPartners, settleTravelPartners, dueTravelInstalments, measureTravelPartners,
  travelPartnerReputation, travelBreakCost, travelRenewalOffer, travelPartnerMood,
} from '../packages/engine/src/data/travelPartners.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

console.log('\nTravel partnerships — partners, requirements, happiness, renewal\n');

const WEEK = 120;
const contract = (id, extra = {}) => ({ ...makeTravelPartnerContract(id, WEEK - 30), graceUntil: 0, ...extra });

// ═══════════════════════════════════════════════════════════════════════════
// Catalogue
// ═══════════════════════════════════════════════════════════════════════════

test('catalogue: 16 partners, 4 of each type, unique ids, invented names', () => {
  assert.equal(TRAVEL_PARTNERS.length, 16);
  for (const t of Object.keys(TP_TYPES)) {
    assert.equal(TRAVEL_PARTNERS.filter(p => p.type === t).length, 4, `${t} has 4`);
  }
  assert.equal(new Set(TRAVEL_PARTNERS.map(p => p.id)).size, 16);
  for (const p of TRAVEL_PARTNERS) {
    assert.doesNotMatch(p.name,
      /carnival|royal caribbean|norwegian|princess|celebrity|msc|hilton|marriott|hyatt|accor|ihg|uber|lyft|grab|didi|bolt|tui|expedia|thomas cook|kayak/i,
      `${p.name} must not be a real brand`);
    assert.ok(p.requirements.length >= 1 && p.lift > 0 && p.fee > 0 && p.prominence >= 1 && p.prominence <= 3);
  }
});

test('segments: cruise and tours lift leisure, hotels and ride share lift business', () => {
  assert.equal(TP_TYPES.cruise.segment, 'leisure');
  assert.equal(TP_TYPES.tours.segment, 'leisure');
  assert.equal(TP_TYPES.hotel.segment, 'business');
  assert.equal(TP_TYPES.rideshare.segment, 'business');
});

test('coverage: every named airport exists; region and score clauses resolve', () => {
  for (const p of TRAVEL_PARTNERS) {
    for (const c of p.coverage) if (c.kind === 'airports') for (const code of c.codes) {
      assert.ok(getAirport(code), `${p.id}: ${code} exists`);
    }
    assert.ok(travelPartnerAirports(p).size > 0, `${p.id} covers something`);
  }
  assert.ok(travelPartnerAirports('zipway').has('JFK') && !travelPartnerAirports('zipway').has('YYZ'), 'Zipway: US only');
  assert.ok(travelPartnerAirports('velo').has('LHR'));
  assert.ok(travelPartnerAirports('backroads').has('MCO'), 'Backroads: NA leisure ≥60');
  assert.ok(!travelPartnerAirports('backroads').has('ORD'));
  assert.ok(travelPartnerAirports('rumbo').has('MEX') && travelPartnerAirports('rumbo').has('GRU'));
});

test('season: Azure Horizon sails Nov–Apr only; hotels are year-round', () => {
  assert.ok(travelPartnerInSeason('azurehorizon', 1));
  assert.ok(!travelPartnerInSeason('azurehorizon', 7));
  assert.ok(travelPartnerInSeason('northernpassage', 7));
  for (let m = 1; m <= 12; m++) assert.ok(travelPartnerInSeason('aldgate', m));
});

test('the book is shared and deterministic, within ±10% of list', () => {
  for (const p of TRAVEL_PARTNERS) {
    const a = travelPartnerListFee(p.id, WEEK);
    assert.equal(a, travelPartnerListFee(p.id, WEEK + 1), 'same window, same price for everyone');
    assert.ok(Math.abs(a / p.fee - 1) <= TP_BOOK_DRIFT + 0.001);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// The lift
// ═══════════════════════════════════════════════════════════════════════════

test('lift fades with happiness: full at ≥50, none at 20', () => {
  assert.equal(travelLiftScale(80), 1);
  assert.equal(travelLiftScale(50), 1);
  assert.equal(travelLiftScale(35), 0.5);
  assert.equal(travelLiftScale(20), 0);
  assert.equal(travelLiftScale(5), 0);
});

test('a partner counts once per pair; lifts add within a segment and cap at 1.15', () => {
  const ps = { azurehorizon: contract('azurehorizon', { happiness: 70 }) };
  const at = travelPartnerAt(ps, ['MIA', 'SJU'], 1);
  assert.equal(travelAppealForPair(at, 'MIA', 'SJU').leisure, 1.07, 'both ends covered → still +7%');
  assert.equal(travelAppealForPair(at, 'MIA', 'SJU').business, 1);
  const many = {
    aldgate: contract('aldgate'), harbourline: contract('harbourline'),
    velo: contract('velo'), kestrel: contract('kestrel'),
  };
  const f = travelPartnerFieldsFor(many, 'LHR', 'HKG', 6);
  assert.equal(f.travelBusinessAppeal, TP_APPEAL_CAP, '6+5+3+6 = 20% → capped at 15%');
  assert.ok(!('travelLeisureAppeal' in f), 'leisure untouched → field absent');
});

test('out of season, or a sour partner, lifts nothing (no fields at all)', () => {
  const ps = { azurehorizon: contract('azurehorizon') };
  assert.deepEqual(travelPartnerFieldsFor(ps, 'JFK', 'MCO', 7), {});
  assert.equal(travelPartnerFieldsFor(ps, 'JFK', 'MCO', 1).travelLeisureAppeal, 1.07);
  const sour = { azurehorizon: contract('azurehorizon', { happiness: 18 }) };
  assert.deepEqual(travelPartnerFieldsFor(sour, 'JFK', 'MCO', 1), {});
  const half = { azurehorizon: contract('azurehorizon', { happiness: 35 }) };
  assert.equal(travelPartnerFieldsFor(half, 'JFK', 'MCO', 1).travelLeisureAppeal, 1.035);
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirements and happiness
// ═══════════════════════════════════════════════════════════════════════════

test('attainment: volume is a ratio; rates use a 10-point band; both cap at 1.25', () => {
  const pax = { kind: 'segmentPaxTo', segment: 'leisure', min: 1500 };
  assert.equal(requirementAttainment(pax, 1200, 1500), 0.8);
  assert.equal(requirementAttainment(pax, 9000, 1500), 1.25);
  const otp = { kind: 'onTime', min: 85 };
  assert.equal(requirementAttainment(otp, 83, 85), 0.8, '2 points short is a mild miss');
  assert.equal(requirementAttainment(otp, 75, 85), 0);
  assert.equal(requirementAttainment(otp, 95, 85), 1.25);
});

test('combined attainment cannot hide one big miss; target happiness curve', () => {
  assert.equal(combinedAttainment([1, 0]), 0.25);
  assert.equal(targetHappiness(0.4), 0);
  assert.equal(targetHappiness(1.0), 80);
  assert.equal(targetHappiness(1.25), 100);
  assert.ok(Math.abs(targetHappiness(0.8) - 53.33) < 0.01, 'the plan’s worked example: 1,200 of 1,500 → ~53');
});

test('happiness moves 10%/week toward target; in grace it can only rise', () => {
  const m = (A) => ({ inForce: true, actuals: [A * 1500] });
  const c = contract('azurehorizon', { happiness: 60 });
  const up = settleTravelPartners({ azurehorizon: c }, {}, { azurehorizon: m(1.0) }, WEEK);
  assert.equal(up.partners.azurehorizon.happiness, 62, '60 + 0.1 × (80 − 60)');
  const down = settleTravelPartners({ azurehorizon: c }, {}, { azurehorizon: m(0.2) }, WEEK);
  assert.equal(down.partners.azurehorizon.happiness, 54);
  const fresh = { ...c, graceUntil: WEEK + 4 };
  const grace = settleTravelPartners({ azurehorizon: fresh }, {}, { azurehorizon: m(0) }, WEEK);
  assert.equal(grace.partners.azurehorizon.happiness, 60, 'a new signing gets 8 weeks to add flights');
});

test('out of season the requirements are not measured: happiness holds', () => {
  const c = contract('azurehorizon', { happiness: 60 });
  const r = settleTravelPartners({ azurehorizon: c }, {}, { azurehorizon: { inForce: false, actuals: [0] } }, WEEK);
  assert.equal(r.partners.azurehorizon.happiness, 60);
});

test('walk-out: below 15 for 4 weeks → lost for 5 years, reputation hit by prominence', () => {
  let ps = { azurehorizon: contract('azurehorizon', { happiness: 12 }) };
  let mem = {};
  const zero = { azurehorizon: { inForce: true, actuals: [0] } };
  let r;
  for (let w = 0; w < 3; w++) {
    r = settleTravelPartners(ps, mem, zero, WEEK + w);
    assert.ok(r.partners.azurehorizon, `still there after week ${w + 1}`);
    ps = r.partners; mem = r.memory;
  }
  r = settleTravelPartners(ps, mem, zero, WEEK + 3);
  assert.ok(!r.partners.azurehorizon, 'walked on the fourth week');
  assert.equal(r.memory.azurehorizon.cooldownUntil, WEEK + 3 + TP_LOST_COOLDOWN_WEEKS);
  assert.equal(TP_LOST_COOLDOWN_WEEKS, 260, '5 years');
  assert.equal(r.repHit, 9, 'prominence 3 × 3');
  assert.deepEqual(r.events.map(e => e.type), ['lost']);
});

test('frustrated event fires once, naming the worst requirement', () => {
  const c = contract('lodestar', { happiness: 36 });
  const r = settleTravelPartners({ lodestar: c }, {}, { lodestar: { inForce: true, actuals: [1000, 70] } }, WEEK);
  const e = r.events.find(x => x.type === 'frustrated');
  assert.ok(e, 'crossed below 35');
  assert.equal(e.worst, 1, 'the on-time miss, not the passengers');
  const again = settleTravelPartners(r.partners, {}, { lodestar: { inForce: true, actuals: [1000, 70] } }, WEEK + 1);
  assert.ok(!again.events.some(x => x.type === 'frustrated'), 'only on the crossing');
});

// ═══════════════════════════════════════════════════════════════════════════
// Terms, renewal, exits
// ═══════════════════════════════════════════════════════════════════════════

test('every contract is 2 years, two annual instalments', () => {
  const c = makeTravelPartnerContract('zipway', WEEK);
  assert.equal(c.termWeeks, TP_TERM_WEEKS);
  assert.equal(TP_TERM_WEEKS, 104);
  assert.deepEqual(dueTravelInstalments({ zipway: c }, WEEK), [{ partnerId: 'zipway', amount: c.annualFee }]);
  const paid1 = { ...c, instalmentsPaid: 1 };
  assert.deepEqual(dueTravelInstalments({ zipway: paid1 }, WEEK + 51), []);
  assert.equal(dueTravelInstalments({ zipway: paid1 }, WEEK + 52).length, 1);
  assert.deepEqual(dueTravelInstalments({ zipway: { ...c, instalmentsPaid: 2 } }, WEEK + 90), []);
});

test('renewal prices by happiness: delighted −40%, frustrated +35% and tighter targets, below 15 refuses', () => {
  const at = (h) => travelRenewalOffer({ ...contract('lodestar'), happiness: h }, WEEK);
  const list = travelPartnerListFee('lodestar', WEEK);
  assert.equal(at(80).annualFee, Math.round(list * 0.60 / 1000) * 1000);
  assert.equal(at(60).annualFee, Math.round(list * 0.85 / 1000) * 1000);
  assert.equal(at(40).annualFee, Math.round(list * 1.00 / 1000) * 1000);
  assert.equal(at(20).annualFee, Math.round(list * 1.35 / 1000) * 1000);
  assert.equal(at(20).tighten, 1);
  assert.ok(at(10).refuses);
  const req = TRAVEL_PARTNER_MAP.lodestar.requirements;
  assert.deepEqual(contractTargets({ partnerId: 'lodestar', tighten: 1 }), [1150, 88], 'pax +15%, on-time +3 pts');
  assert.equal(requirementTarget(req[1], 5), 95, 'rate targets have a ceiling');
});

test('rollover: happy auto-renews cheaply; frustrated lapses; below 15 is lost for 5 years', () => {
  const end = (h, extra = {}) => ({ ...makeTravelPartnerContract('lodestar', WEEK - TP_TERM_WEEKS), happiness: h, instalmentsPaid: 2, ...extra });
  const happy = rolloverTravelPartners({ lodestar: end(80) }, {}, WEEK);
  assert.equal(happy.events[0].type, 'renewed');
  assert.equal(happy.partners.lodestar.signedWeek, WEEK);
  assert.equal(happy.partners.lodestar.instalmentsPaid, 0, 'the new term’s first instalment is due now');
  assert.equal(happy.partners.lodestar.annualFee, travelRenewalOffer(end(80), WEEK).annualFee);

  const sour = rolloverTravelPartners({ lodestar: end(30) }, {}, WEEK);
  assert.equal(sour.events[0].type, 'lapsed');
  assert.equal(sour.events[0].reason, 'unhappy', 'never auto-renews into frustrated pricing');
  assert.equal(sour.memory.lodestar.rejoinHappiness, 30, 'the partner remembers');
  assert.equal(sour.memory.lodestar.cooldownUntil, undefined, 'a lapse is not a loss');

  const queued = rolloverTravelPartners({ lodestar: end(30, { renewal: { annualFee: 4_000_000, tighten: 1 } }) }, {}, WEEK);
  assert.equal(queued.events[0].type, 'renewed', 'a renewal agreed in the window is honoured');
  assert.equal(queued.partners.lodestar.tighten, 1);

  const lost = rolloverTravelPartners({ lodestar: end(10) }, {}, WEEK);
  assert.equal(lost.events[0].type, 'lost');
  assert.equal(lost.memory.lodestar.cooldownUntil, WEEK + 260);

  const broke = rolloverTravelPartners({ lodestar: end(80) }, {}, WEEK, { cash: 1000 });
  assert.equal(broke.events[0].reason, 'cash');
  const off = rolloverTravelPartners({ lodestar: end(80, { autoRenew: false }) }, {}, WEEK);
  assert.equal(off.events[0].reason, 'not-renewed');
});

test('break cost: half the unpaid instalments', () => {
  const c = { ...makeTravelPartnerContract('aldgate', WEEK), annualFee: 8_000_000 };
  assert.equal(travelBreakCost({ ...c, instalmentsPaid: 1 }), 4_000_000);
  assert.equal(travelBreakCost({ ...c, instalmentsPaid: 2 }), 0);
});

test('canSign: world flag, reputation gate, cooldown, already signed, cash', () => {
  const base = { partners: {}, memory: {}, absWeek: WEEK, reputation: 70, cash: 1e9, worldOn: true };
  assert.ok(canSignTravelPartner('aldgate', base).ok);
  assert.ok(!canSignTravelPartner('aldgate', { ...base, worldOn: false }).ok, 'old worlds: no partners');
  assert.match(canSignTravelPartner('aldgate', { ...base, reputation: 40 }).reasons[0], /reputation of 60/);
  assert.match(canSignTravelPartner('aldgate', { ...base, memory: { aldgate: { cooldownUntil: WEEK + 10 } } }).reasons[0], /won’t work with you/);
  assert.ok(canSignTravelPartner('aldgate', { ...base, memory: { aldgate: { cooldownUntil: WEEK } } }).ok, 'after 5 years they talk again');
  assert.ok(!canSignTravelPartner('aldgate', { ...base, partners: { aldgate: {} } }).ok);
  assert.ok(!canSignTravelPartner('aldgate', { ...base, cash: 10 }).ok);
});

test('reputation term: delighted +0.25×prominence, sour down to −8, clamped', () => {
  assert.equal(travelPartnerReputation(null), 0);
  assert.equal(travelPartnerReputation({ aldgate: { partnerId: 'aldgate', happiness: 90 } }), 0.8, '3 × 0.25, to 1 dp');
  assert.equal(travelPartnerReputation({ aldgate: { partnerId: 'aldgate', happiness: 0 } }), -3);
  const all = Object.fromEntries(TRAVEL_PARTNERS.map(p => [p.id, { partnerId: p.id, happiness: 0 }]));
  assert.equal(travelPartnerReputation(all), -8);
  const joy = Object.fromEntries(TRAVEL_PARTNERS.map(p => [p.id, { partnerId: p.id, happiness: 99 }]));
  assert.equal(travelPartnerReputation(joy), 2);
  assert.equal(travelPartnerMood(80).label, 'Delighted');
});

// ═══════════════════════════════════════════════════════════════════════════
// The tick
// ═══════════════════════════════════════════════════════════════════════════

const TYPE = getAircraftType('a320neo');
// A thin pair so the routes are demand-limited, not full: a lift can only add
// passengers to an aircraft with empty seats. MCO is an Azure Horizon port;
// JFK is a Lodestar city; Petersburg (AK) is neither.
const THIN = 'PSG';
const PAIR_OF = (o, d) => [o, d].sort().join('-');
const tail = (id) => ({
  id, typeId: TYPE.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned',
  config: { firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: TYPE.seats - 12,
            seatQuality: 'standard', serviceQuality: 'standard' },
});
const route = (id, aircraftId, o, d, freq = 7) => ({
  id, origin: o, destination: d, stops: [o, d], aircraftId, weeklyFrequency: freq, weeksOpen: 60,
});
function tickState({ month = 1, travelPartners, world = true, cash = 1e9, o = 'MCO', d = THIN } = {}) {
  return {
    fleet: [tail('a1')], routes: [route('r1', 'a1', o, d)], cargoRoutes: [],
    gameDate: { week: 3, month }, week: 3, year: 3,
    gates: { [o]: 10, [d]: 10 }, hubs: {},
    lounges: {}, loungePolicy: null,
    routePricing: { [PAIR_OF(o, d)]: defaultClassPrices(Math.round(referencePrice(o, d))) }, routeCatering: {},
    competitors: [], loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 },
    allianceMembership: null, campaignStrength: {}, targetedMarketing: {},
    awareness: 65, ancillaries: defaultAncillaries(), labor: undefined,
    absWeek: WEEK, cash,
    ...(world ? { partnershipsWorld: true } : {}),
    ...(travelPartners ? { travelPartners } : {}),
  };
}

test('fixture: the thin pairs are demand-limited', () => {
  for (const o of ['MCO', 'JFK']) {
    const rr = weeklyTick(tickState({ o })).routeResults[0];
    assert.ok(rr.passengers < rr.configuredSeatsOneWay * 0.95, `${o}–PSG LF ${(rr.passengers / rr.configuredSeatsOneWay).toFixed(2)}`);
  }
});

test('tick: a cruise partner lifts leisure passengers on its ports, in season', () => {
  const base = weeklyTick(tickState({ month: 1 })).routeResults[0];
  const ps = { azurehorizon: contract('azurehorizon', { happiness: 70, instalmentsPaid: 1 }) };
  const lifted = weeklyTick(tickState({ month: 1, travelPartners: ps })).routeResults[0];
  assert.ok(base.segmentPax && lifted.segmentPax, 'partnership worlds report the segment split');
  assert.ok(lifted.segmentPax.leisure > base.segmentPax.leisure,
    `leisure ${base.segmentPax.leisure} → ${lifted.segmentPax.leisure}`);
  const summer = weeklyTick(tickState({ month: 7, travelPartners: ps })).routeResults[0];
  const summerBase = weeklyTick(tickState({ month: 7 })).routeResults[0];
  assert.equal(summer.passengers, summerBase.passengers, 'out of season: no lift');
});

test('tick: a hotel partner lifts business, not leisure', () => {
  const ps = { lodestar: contract('lodestar', { happiness: 70, instalmentsPaid: 1 }) };
  // A business cabin big enough not to fill, so extra business demand shows.
  const roomy = (st) => ({ ...st, fleet: [{ ...tail('a1'), config: { ...tail('a1').config, businessClass: 40, economy: TYPE.seats - 40 } }] });
  const base = weeklyTick(roomy(tickState({ o: 'JFK' }))).routeResults[0];
  const lifted = weeklyTick(roomy(tickState({ o: 'JFK', travelPartners: ps }))).routeResults[0];
  assert.ok(travelPartnerAirports('lodestar').has('JFK'));
  assert.ok(lifted.segmentPax.business > base.segmentPax.business,
    `business ${base.segmentPax.business} → ${lifted.segmentPax.business}`);
  assert.ok(Math.abs(lifted.segmentPax.leisure - base.segmentPax.leisure) <= 1, 'leisure unchanged');
});

test('tick: segment split sums to passengers; absent outside partnership worlds', () => {
  const rr = weeklyTick(tickState()).routeResults[0];
  assert.equal(rr.segmentPax.leisure + rr.segmentPax.business, rr.passengers);
  const old = weeklyTick(tickState({ world: false })).routeResults[0];
  assert.ok(!('segmentPax' in old));
});

test('tick: business travellers flying economy still count as business (no cabin, or a full one)', () => {
  const allEco = (st) => ({ ...st, fleet: [{ ...tail('a1'), config: { ...tail('a1').config, businessClass: 0, economy: TYPE.seats } }] });
  const eco = weeklyTick(allEco(tickState({ o: 'JFK' }))).routeResults[0];
  assert.ok(eco.segmentPax.business > 0, `an all-economy airline still carries business travellers (${eco.segmentPax.business})`);
  assert.equal(eco.segmentPax.leisure + eco.segmentPax.business, eco.passengers);
  const withJ = weeklyTick(tickState({ o: 'JFK' })).routeResults[0];
  const jSeats = 12 * 7;
  assert.ok(withJ.segmentPax.business > jSeats, `a full 12-seat cabin plus the overflow (${withJ.segmentPax.business} > ${jSeats})`);
});

test('tick: the first instalment is charged on the report and the P&L bridge names it', () => {
  const c = makeTravelPartnerContract('zipway', WEEK);
  const r = weeklyTick(tickState({ travelPartners: { zipway: c } }));
  assert.equal(r.totalTravelPartnerFees, c.annualFee);
  assert.equal(r.travelPartnersNext.zipway.instalmentsPaid, 1);
  const r2 = weeklyTick({ ...tickState({ travelPartners: r.travelPartnersNext }), absWeek: WEEK + 1 });
  assert.ok(!('totalTravelPartnerFees' in r2), 'not again next week');
  const b = costBridge(bridgeInputsFromReport(r));
  if (b && 'residual' in b) assert.ok(Math.abs(b.residual) < 2, `bridge residual ${b.residual}`);
});

test('tick: requirement actuals — leisure pax arriving at the ports, counted at each covered end', () => {
  const ps = { azurehorizon: contract('azurehorizon', { happiness: 60, instalmentsPaid: 1 }) };
  const r = weeklyTick(tickState({ travelPartners: ps }));
  const rr = r.routeResults[0];
  const score = r.travelPartnerScores.azurehorizon;
  assert.equal(score.actuals[0], rr.segmentPax.leisure, 'MCO is a port, PSG is not: one end');
  const measured = measureTravelPartners(['azurehorizon'], {
    routes: [{ id: 'x', origin: 'MIA', destination: 'SJU', stops: ['MIA', 'SJU'], weeklyFrequency: 7 }],
    routeResults: [{ routeId: 'x', segmentPax: { leisure: 100, business: 10 } }], month: 1,
  });
  assert.equal(measured.azurehorizon.actuals[0], 200, 'both ends are ports: arrivals at each');
});

test('tick: no partners → no partner keys on the report', () => {
  const r = weeklyTick(tickState());
  for (const k of ['travelPartnersNext', 'travelPartnerScores', 'travelPartnerEvents', 'totalTravelPartnerFees']) {
    assert.ok(!(k in r), `${k} absent`);
  }
});

test('preview = tick: pairMarketShare carries the partner lift', () => {
  const ps = { azurehorizon: contract('azurehorizon', { happiness: 70, instalmentsPaid: 1 }) };
  const st = tickState({ travelPartners: ps });
  const fields = stateTravelPartnerFields(st, 'MCO', THIN);
  assert.equal(fields.travelLeisureAppeal, 1.07);
  const withP = pairMarketShare({ ...st }, 'MCO', THIN);
  const without = pairMarketShare({ ...st, travelPartners: undefined }, 'MCO', THIN);
  const pax = (x) => x?.playerResult?.leisurePax ?? x?.player?.leisurePax ?? null;
  assert.ok(pax(withP) != null, 'pairMarketShare returns the player result');
  assert.ok(pax(withP) > pax(without), `${pax(without)} → ${pax(withP)}`);
});

test('reputation: calcReputation includes the partners term; unchanged without partners', () => {
  const st = tickState();
  const a = calcReputation(st, 0, 0.5);
  const sour = calcReputation({ ...st, travelPartners: { aldgate: { partnerId: 'aldgate', happiness: 0 } } }, 0, 0.5);
  assert.equal(sour.partners, -3);
  assert.ok(sour.overall === Math.max(0, a.overall - 3) || Math.abs(sour.overall - (a.overall - 3)) <= 1);
  assert.ok(!('partners' in a), 'no key without partners');
});

// ═══════════════════════════════════════════════════════════════════════════
// The reducer
// ═══════════════════════════════════════════════════════════════════════════

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const playing = (extra = {}) => ({ ...freshState(), phase: 'playing', week: 10, year: 3, cash: 500_000_000,
  partnershipsWorld: true, lastReport: { reputationScore: 70 }, ...extra });

test('freshState carries no partner keys', () => {
  const f = freshState();
  for (const k of ['travelPartners', 'travelPartnerMemory', 'partnershipsWorld']) assert.ok(!(k in f), k);
});

test('SIGN: refused outside partnership worlds, signed inside, fee charged by the tick', () => {
  const old = gameReducer(playing({ partnershipsWorld: undefined }), { type: 'SIGN_TRAVEL_PARTNER', partnerId: 'zipway' });
  assert.ok(old.error && !old.travelPartners);
  const s = gameReducer(playing(), { type: 'SIGN_TRAVEL_PARTNER', partnerId: 'zipway' });
  assert.ok(!s.error, s.error);
  assert.equal(s.travelPartners.zipway.happiness, 60);
  assert.equal(s.cash, 500_000_000, 'nothing charged until the tick');
  const gate = gameReducer(playing({ lastReport: { reputationScore: 40 } }), { type: 'SIGN_TRAVEL_PARTNER', partnerId: 'aldgate' });
  assert.match(gate.error, /reputation/);
});

test('ADVANCE_WEEK: the tick charges the first instalment and the reducer persists the contract', () => {
  let s = gameReducer(playing(), { type: 'SIGN_TRAVEL_PARTNER', partnerId: 'zipway' });
  const fee = s.travelPartners.zipway.annualFee;
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s.lastReport.totalTravelPartnerFees, fee);
  assert.equal(s.travelPartners.zipway.instalmentsPaid, 1);
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.ok(!s.lastReport.totalTravelPartnerFees, 'once a year');
});

test('SIGN counts fees already signed for against cash', () => {
  const fee = travelPartnerListFee('zipway', 2 * 52 + 10);
  let s = playing({ cash: fee * 1.5 });
  s = gameReducer(s, { type: 'SIGN_TRAVEL_PARTNER', partnerId: 'zipway' });
  assert.ok(!s.error);
  const s2 = gameReducer(s, { type: 'SIGN_TRAVEL_PARTNER', partnerId: 'velo' });
  assert.match(s2.error ?? '', /cash/);
});

test('BREAK: half the unpaid fee, a reputation hit, remembered at 40 — but no 5-year cooldown', () => {
  let s = gameReducer(playing(), { type: 'SIGN_TRAVEL_PARTNER', partnerId: 'aldgate' });
  const c = s.travelPartners.aldgate;
  s = { ...s, travelPartners: { aldgate: { ...c, instalmentsPaid: 1, happiness: 70 } } };
  const b = gameReducer(s, { type: 'BREAK_TRAVEL_PARTNER', partnerId: 'aldgate' });
  assert.equal(b.cash, s.cash - Math.round(c.annualFee * 0.5));
  assert.equal(b.reputationPenalty, 4.5, 'prominence 3 × 1.5');
  assert.ok(!('travelPartners' in b), 'key cleared');
  assert.equal(b.travelPartnerMemory.aldgate.rejoinHappiness, 40);
  assert.equal(b.travelPartnerMemory.aldgate.cooldownUntil, undefined);
  const again = gameReducer(b, { type: 'SIGN_TRAVEL_PARTNER', partnerId: 'aldgate' });
  assert.ok(!again.error, 'can sign again');
  assert.equal(again.travelPartners.aldgate.happiness, 40);
  assert.ok(!again.travelPartnerMemory, 'memory consumed');
});

test('a lost partner refuses to sign for 5 years', () => {
  const absWeek = 2 * 52 + 10;
  const s = playing({ travelPartnerMemory: { aldgate: { cooldownUntil: absWeek + 100, rejoinHappiness: 40 } } });
  const r = gameReducer(s, { type: 'SIGN_TRAVEL_PARTNER', partnerId: 'aldgate' });
  assert.match(r.error, /won’t work with you/);
});

test('RENEW only inside the window, and locks today’s offer', () => {
  const absWeek = 2 * 52 + 10;
  const c = { ...makeTravelPartnerContract('lodestar', absWeek - 100), happiness: 80, instalmentsPaid: 2 };
  const s = playing({ travelPartners: { lodestar: c } });
  const r = gameReducer(s, { type: 'RENEW_TRAVEL_PARTNER', partnerId: 'lodestar' });
  assert.ok(!r.error, r.error);
  assert.equal(r.travelPartners.lodestar.renewal.annualFee, travelRenewalOffer(c, absWeek).annualFee);
  const early = gameReducer(playing({ travelPartners: { lodestar: { ...c, signedWeek: absWeek - 10 } } }),
    { type: 'RENEW_TRAVEL_PARTNER', partnerId: 'lodestar' });
  assert.match(early.error, /8 weeks/);
});

test('SET_TRAVEL_PARTNER_AUTORENEW: one or all', () => {
  const s = playing({ travelPartners: { zipway: makeTravelPartnerContract('zipway', 100), velo: makeTravelPartnerContract('velo', 100) } });
  const one = gameReducer(s, { type: 'SET_TRAVEL_PARTNER_AUTORENEW', partnerId: 'zipway', on: false });
  assert.equal(one.travelPartners.zipway.autoRenew, false);
  assert.equal(one.travelPartners.velo.autoRenew, true);
  const all = gameReducer(one, { type: 'SET_TRAVEL_PARTNER_AUTORENEW', partnerId: 'all', on: false });
  assert.ok(Object.values(all.travelPartners).every(c => c.autoRenew === false));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
