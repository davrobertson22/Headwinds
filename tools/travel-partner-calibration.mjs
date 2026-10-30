// @not-a-test — calibration report, asserts nothing.
//
// Travel partner fees (PARTNERSHIPS_PLAN.md §8): for each partner, build a
// reference network into its airports, tune each route to ~80% load (a lift can
// only add passengers to an aircraft with empty seats), and run weeklyTick with
// and without the partner. The revenue the lift adds, scaled to an airline
// that EXACTLY meets the partner's volume target and counted over its season,
// is the partner's yearly value. Rule: list fee ≈ 40% of it.
//
// Solo airline, no rivals: on a monopoly the lift grows the pool, which is the
// most a partner can be worth. Against a rival it only moves share (and nothing
// at all if the rival has signed the same partner), so real value is lower.
//
//   node tools/travel-partner-calibration.mjs

import { weeklyTick, defaultClassPrices, routeDistanceKm } from '../packages/engine/src/utils/simulation.js';
import { AIRPORTS, getAirport } from '../packages/engine/src/data/airports.js';
import { referencePrice } from '../packages/engine/src/utils/market.js';
import { defaultAncillaries } from '../packages/engine/src/data/ancillaries.js';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import {
  TRAVEL_PARTNERS, travelPartnerAirports, makeTravelPartnerContract, contractTargets,
} from '../packages/engine/src/data/travelPartners.js';

const FEE_SHARE = 0.40;
const MONTH_WEEKS = [5, 4, 5, 4, 4, 4, 5, 4, 4, 5, 4, 4];   // game calendar (simulation.js MONTH_STARTS)
const WEEK_OF_MONTH = [3, 7, 12, 16, 20, 24, 29, 33, 37, 42, 46, 50];
const NB = getAircraftType('a320neo');
const WB = getAircraftType('a350900');
const MAX_DEST = 10;
const MAX_FREQ = 14;

const big = AIRPORTS.filter(a => a.tier === 'mega' || a.tier === 'major');

function plan(p) {
  const covered = travelPartnerAirports(p);
  const dests = [...covered]
    .map(getAirport)
    .sort((a, b) => (b.effectivePop ?? b.population ?? 0) - (a.effectivePop ?? a.population ?? 0))
    .slice(0, MAX_DEST);
  return dests.map(d => {
    // Nearest big airport outside the coverage, 500 km+ away, in range.
    const cands = big.filter(o => o.code !== d.code && !covered.has(o.code))
      .map(o => ({ o, km: routeDistanceKm(o.code, d.code) }))
      .filter(x => x.km >= 500 && x.km <= (WB?.range ?? 13000) * 0.95)
      .sort((a, b) => a.km - b.km);
    const pick = cands[0] ?? big.filter(o => o.code !== d.code)
      .map(o => ({ o, km: routeDistanceKm(o.code, d.code) }))
      .filter(x => x.km >= 500).sort((a, b) => a.km - b.km)[0];
    return { origin: pick.o.code, dest: d.code, km: pick.km };
  });
}

// One aircraft flies at most ~140 block hours a week; a leg needing more
// frequency than that gets more aircraft on the same pair (pooled by the tick).
const perAircraft = (km) => Math.max(1, Math.floor(140 / (2 * (km / 800 + 0.7))));

function stateFor(legs, { month, partners = null }) {
  const fleet = [], routes = [], pricing = {}, gates = {};
  legs.forEach((l, i) => {
    const type = l.km > NB.range * 0.9 ? WB : NB;
    let left = l.freq ?? 7, j = 0;
    const cap = perAircraft(l.km);
    while (left > 0) {
      const f = Math.min(cap, left);
      left -= f;
      fleet.push({ id: `a${i}_${j}`, typeId: type.id, status: 'assigned', ageWeeks: 52, ownershipType: 'owned',
        config: { firstClass: 0, businessClass: 12, premiumEconomy: 0, economy: type.seats - 12,
                  seatQuality: 'standard', serviceQuality: 'standard' } });
      routes.push({ id: `r${i}_${j}`, origin: l.origin, destination: l.dest, stops: [l.origin, l.dest],
        aircraftId: `a${i}_${j}`, weeklyFrequency: f, weeksOpen: 60 });
      j++;
    }
    pricing[[l.origin, l.dest].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(l.origin, l.dest)));
    gates[l.origin] = 500; gates[l.dest] = 500;
  });
  return {
    fleet, routes, cargoRoutes: [], gameDate: { week: WEEK_OF_MONTH[month - 1], month },
    week: WEEK_OF_MONTH[month - 1], year: 3, gates, hubs: {}, lounges: {}, loungePolicy: null,
    routePricing: pricing, routeCatering: {}, competitors: [],
    loyalty: { members: 0, weeklyInvestment: 0, maturity: 0 }, allianceMembership: null,
    campaignStrength: {}, targetedMarketing: {}, awareness: 65, ancillaries: defaultAncillaries(),
    absWeek: 120, cash: 1e12, partnershipsWorld: true,
    ...(partners ? { travelPartners: partners } : {}),
  };
}

const money = (n) => `$${(n / 1e6).toFixed(2)}M`;
// Share of an on-target airline's flights into the partner's airports that
// have seats to spare for the lift (a network flown at ~80% load).
const SPARE = 0.70;
const rows = [];
for (const p of TRAVEL_PARTNERS) {
  const seg = p.type === 'hotel' || p.type === 'rideshare' ? 'business' : 'leisure';
  const month = p.season?.length ? p.season[Math.floor(p.season.length / 2)] : 6;
  const serveN = p.requirements.find(r => r.kind === 'serveCount')?.min;
  const volume = p.requirements.find(r => r.kind === 'segmentPaxTo' || r.kind === 'departures');
  const legs = !volume && serveN ? plan(p).slice(0, serveN) : plan(p);
  for (const l of legs) l.freq = 7;
  const contract = { ...makeTravelPartnerContract(p.id, 100), happiness: 80, instalmentsPaid: 1, graceUntil: 0 };
  const base = weeklyTick(stateFor(legs, { month, partners: { [p.id]: { ...contract, happiness: 0 } } }));
  // Fares and loads from the engine: revenue per one-way arrival of this
  // segment at the partner's airports, and arrivals per weekly departure.
  const score = base.travelPartnerScores[p.id];
  let segRev = 0, arrivals = 0, deps = 0;
  const covered = travelPartnerAirports(p);
  for (const rr of base.routeResults) {
    const r = stateFor(legs, { month }).routes.find(x => x.id === rr.routeId);
    const ends = [r.origin, r.destination].filter(c => covered.has(c)).length;
    if (!ends || !rr.segmentPax) continue;
    const share = rr.passengers > 0 ? rr.segmentPax[seg] / rr.passengers : 0;
    segRev   += rr.revenue * share;                 // both directions
    arrivals += rr.segmentPax[seg] * ends;
    deps     += r.weeklyFrequency * ends;
  }
  const revPerArrival = arrivals > 0 ? segRev / arrivals : 0;
  const arrPerDep = deps > 0 ? arrivals / deps : 0;
  // On target: the arrivals an airline exactly meeting the partner's volume
  // target delivers (departures → arrivals at the network's own load).
  let onTarget;
  if (volume?.kind === 'segmentPaxTo') onTarget = volume.min;
  else if (volume?.kind === 'departures') onTarget = volume.min * arrPerDep;
  else onTarget = arrivals;                          // "serve N": the N-airport network itself
  const weeks = p.season?.length ? p.season.reduce((s, m) => s + MONTH_WEEKS[m - 1], 0) : 52;
  const value = p.lift * onTarget * revPerArrival * weeks * SPARE;
  const suggested = Math.max(250_000, Math.round(value * FEE_SHARE / 50_000) * 50_000);
  rows.push({ p, seg, revPerArrival, onTarget, weeks, value, suggested,
    met: score.actuals.map((a, i) => `${a}/${contractTargets(contract)[i]}`).join(' ') });
}

console.log('\nTravel partner fee calibration — fee ≈ 40% of the yearly revenue the lift adds on target\n');
console.log('partner'.padEnd(26), 'seg'.padEnd(9), '$/arrival'.padStart(9), 'arrivals'.padStart(9), 'wks'.padStart(4),
  'value/yr'.padStart(10), 'fee now'.padStart(9), 'suggested'.padStart(10));
for (const r of rows) {
  console.log(r.p.name.padEnd(26), r.seg.padEnd(9), `$${Math.round(r.revPerArrival)}`.padStart(9),
    String(Math.round(r.onTarget)).padStart(9), String(r.weeks).padStart(4), money(r.value).padStart(10),
    money(r.p.fee).padStart(9), money(r.suggested).padStart(10));
}
console.log('\nPaste-ready:');
for (const r of rows) console.log(`  ${r.p.id}: ${r.suggested},`);
