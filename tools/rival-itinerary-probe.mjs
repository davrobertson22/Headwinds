// rival-itinerary-probe.mjs — @not-a-test: Phase 0 of HUB_CONNECTIVITY_PLAN.md.
//
// Measures, on a seeded solo game with the stock 70 AI carriers, how much of the
// player's world is uncontested today and how much of it would gain a rival
// one-stop itinerary under decision 1 (declared rival hubs, tiered by spoke
// count on the player's own 4/20/50 thresholds). Also a first-order share
// estimate: append the rival one-stop offers (§3.3 shape, sum-of-legs fares) to
// each player market's real offer set and re-run computeMarketShare.
//
//   node --import ./tools/_register-loader.mjs tools/rival-itinerary-probe.mjs [classic|1950] [weeks...]
//   default: classic 0 52 104
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { AIRPORTS, getAirport } from '../packages/engine/src/data/airports.js';
import { defaultConfig, defaultClassPrices, distanceKm, referencePrice } from '../packages/engine/src/utils/simulation.js';
import { computeMarketShare, HUB_TIERS, BUSINESS_PRICE_MULTIPLIER } from '../packages/engine/src/models/demand.js';
import { buildOwnMetalConnections } from '../packages/engine/src/models/network.js';
import { pairMarketShare } from '../packages/engine/src/models/pairShare.js';
import { NWR_FARE_INDEX } from '../packages/engine/src/utils/market.js';

Math.random = (() => { let s = 424242; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();

const mode  = process.argv[2] ?? 'classic';
const snaps = process.argv.slice(3).map(Number).filter(Number.isFinite);
const SNAPS = snaps.length ? snaps : [0, 52, 104];
const startYear = mode === 'classic' ? null : Number(mode);
// CIRC=1.5 skips routings whose (A→H + H→C) / (A→C) distance ratio exceeds it.
const CIRC_CAP = Number(process.env.CIRC) || Infinity;

// ── Player network: a JFK Major Hub (T2) with 20 spokes, an ORD Hub (T1) with
// 10 spokes, plus 6 point-to-point routes. Widebodies long-haul, A320s short.
const wide = getAircraftType('b7879'), narrow = getAircraftType('a320neo');
let n = 0;
const mkAc = (t) => ({ id: `p${n++}`, typeId: t.id, status: 'assigned', ageWeeks: 52, config: defaultConfig(t.seats), ownershipType: 'owned', tailNumber: `N${n}P`, name: t.name });
const fleet = [], routes = [], routePricing = {}, gates = {};
const addRoute = (o, d, freq) => {
  const t = distanceKm(getAirport(o), getAirport(d)) > 4000 ? wide : narrow;
  const ac = mkAc(t); fleet.push(ac);
  routes.push({ id: `r${routes.length}`, origin: o, destination: d, stops: [o, d], aircraftId: ac.id, weeklyFrequency: freq, weeksOpen: 30 });
  routePricing[[o, d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice(o, d)));
  gates[o] = (gates[o] ?? 0) + 1; gates[d] = (gates[d] ?? 0) + 1;
};
for (const s of ['LHR','CDG','FRA','LAX','SFO','MIA','ORD','BOS','ATL','DFW','DEN','SEA','YYZ','MEX','GRU','MAD','FCO','DUB','AMS','LAS']) addRoute('JFK', s, 14);
for (const s of ['DEN','MSP','DTW','STL','MCI','LAS','PHX','SEA','SFO','IAH']) addRoute('ORD', s, 14);
for (const [o, d] of [['LAX','SFO'],['MIA','ATL'],['BOS','DCA'],['SEA','PDX'],['DEN','SLC'],['LAX','LAS']]) addRoute(o, d, 21);
gates.JFK = 24; gates.ORD = 14;

let st = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Probe', hub: 'JFK', enableObjectives: false });
st = { ...st, cash: 500_000_000, fleet, routes, routePricing, gates,
  hubs: { JFK: { tier: 2, tierSince: 0 }, ORD: { tier: 1, tierSince: 0 } },
  fareIndex: NWR_FARE_INDEX, newWorldRestrictions: true,
  ...(startYear ? { startYear } : {}) };

// ── Decision 1: rival connection points ───────────────────────────────────
const tierForSpokes = (k) => k >= 50 ? 3 : k >= 20 ? 2 : k >= 4 ? 1 : 0;   // HUB_TIERS routesRequired 4/20/50
function buildRivalHubIndex(competitors) {
  const idx = new Map();
  for (const c of competitors ?? []) {
    const hubs = [c.homeHub, c.secondaryHub].filter(Boolean);
    if (!hubs.length || !c.routes) continue;
    const legs = new Map();
    for (const [key, cfg] of Object.entries(c.routes)) {
      const [a, b] = key.split('-');
      for (const h of hubs) {
        const spoke = a === h ? b : b === h ? a : null;
        if (!spoke) continue;
        if (!legs.has(h)) legs.set(h, new Map());
        legs.get(h).set(spoke, cfg);
      }
    }
    const tierAt = new Map();
    for (const [h, m] of legs) { const t = tierForSpokes(m.size); if (t >= 1) tierAt.set(h, t); }
    idx.set(c.id, { c, legs, tierAt });
  }
  return idx;
}
let probes = 0;
function rivalOneStopsFor(idx, A, C) {
  const key = [A, C].sort().join('-');
  const out = [];
  for (const { c, legs, tierAt } of idx.values()) {
    if (c.routes?.[key]) continue;                     // their nonstop speaks
    for (const [h, tier] of tierAt) {
      probes++;
      if (h === A || h === C) continue;
      const m = legs.get(h);
      if (!(m.has(A) && m.has(C))) continue;
      const circ = (distanceKm(getAirport(A), getAirport(h)) + distanceKm(getAirport(h), getAirport(C)))
                 / Math.max(1, distanceKm(getAirport(A), getAirport(C)));
      if (circ > CIRC_CAP) continue;
      out.push({ c, hub: h, tier, legIn: m.get(A), legOut: m.get(C), circ });
    }
  }
  return out;
}
const SEAT_FRACTION = { 0: 0.10, 1: 0.15, 2: 0.18, 3: 0.22 };
const TIER_SEATS = { budget: 160, legacy: 250, premium: 330 };
function rivalOneStopOffer(cand, market) {
  const { c, hub, tier, legIn, legOut } = cand;
  const seatsOf = (cfg) => cfg.seats ?? getAircraftType(cfg.aircraftType ?? '')?.seats ?? TIER_SEATS[c.tier] ?? 180;
  const pIn  = Math.round(referencePrice(market.origin, hub) * (legIn.priceMultiplier ?? 1));
  const pOut = Math.round(referencePrice(hub, market.destination) * (legOut.priceMultiplier ?? 1));
  const freq = Math.min(legIn.frequency, legOut.frequency);
  const econ = Math.max(1, Math.round(Math.min(legIn.frequency * seatsOf(legIn), legOut.frequency * seatsOf(legOut)) * SEAT_FRACTION[tier]));
  const tierDef = HUB_TIERS[tier];
  return {
    airlineId: `__rival_conn__${c.id}__${hub}`, origin: market.origin, destination: market.destination,
    economyPrice: pIn + pOut, businessPrice: Math.round((pIn + pOut) * BUSINESS_PRICE_MULTIPLIER),
    weeklyFrequency: freq, seatsPerFlight: 180, economySeats: econ, businessSeats: Math.max(1, Math.round(econ * 0.13)),
    totalSeats: econ, qualityScore: c.baseQualityScore + Math.round((tierDef.qualityBonus ?? 0) / 2) + (c.allianceId ? 3 : 0),
    connectivityBonus: -(tierDef.connPenalty ?? 0.38),
  };
}

// ── Analysis ─────────────────────────────────────────────────────────────
function analyse(label) {
  const t0 = performance.now();
  const idx = buildRivalHubIndex(st.competitors);
  const tIdx = performance.now() - t0;
  const tierCount = { 1: 0, 2: 0, 3: 0 };
  let rivalsWithHub = 0;
  for (const { tierAt } of idx.values()) { if (tierAt.size) rivalsWithHub++; for (const t of tierAt.values()) tierCount[t]++; }
  const rivalRoutes = (st.competitors ?? []).reduce((s, c) => s + Object.keys(c.routes ?? {}).length, 0);

  // Player nonstop markets
  probes = 0;
  const nonstop = [];
  let paxBefore = 0, paxAfter = 0, paxAfterRecap = 0, afterRecap = 0, hit = 0, unc = 0, uncHit = 0, losses = [], rivalCarried = 0, rivalCapped = 0;
  for (const r of st.routes) {
    const share = pairMarketShare(st, r.origin, r.destination);
    if (!share.playerResult) continue;
    const rivalsNow = share.offers.filter(o => o.airlineId !== 'player' && !String(o.airlineId).startsWith('__')).length;
    const cands = rivalOneStopsFor(idx, r.origin, r.destination);
    const before = share.playerResult.totalPax;
    let after = before;
    if (cands.length) {
      const res = computeMarketShare(share.market, [...share.offers, ...cands.map(c => rivalOneStopOffer(c, share.market))]);
      after = res.find(x => x.airlineId === 'player')?.totalPax ?? before;
      const carried = res.filter(x => String(x.airlineId).startsWith('__rival_conn__')).reduce((a, x) => a + x.totalPax, 0);
      const capped  = res.filter(x => String(x.airlineId).startsWith('__rival_conn__') && x.capacityCapped).length;
      rivalCarried += carried; rivalCapped += capped;
      // Recapture estimate: evaporated demand handed back to UNCAPPED offers pro
      // rata to their leisure share (the fix Phase 1a would make inside the model).
      const evap = res.reduce((a, x) => a + Math.max(0, (x.leisurePaxUncapped + x.businessPaxUncapped) - x.totalPax), 0);
      const open = res.filter(x => !x.capacityCapped);
      const openShare = open.reduce((a, x) => a + x.leisureShare, 0);
      const me = res.find(x => x.airlineId === 'player');
      if (me && !me.capacityCapped && openShare > 0) {
        const back = evap * me.leisureShare / openShare;
        const room = Math.max(0, (share.playerResult.totalSeatsHint ?? Infinity) - after);
        afterRecap = after + Math.min(back, room);
      } else afterRecap = after;
      paxAfterRecap += afterRecap - after;
      hit++;
    }
    if (rivalsNow === 0) { unc++; if (cands.length) uncHit++; }
    if (!cands.length) afterRecap = after;
    paxBefore += before; paxAfter += after; paxAfterRecap += after;
    if (cands.length) losses.push({ key: `${r.origin}-${r.destination}`, rivalsNow, cands: cands.length, via: [...new Set(cands.map(c => `${c.c.name} via ${c.hub} (T${c.tier}, ${c.circ.toFixed(2)}×)`))].slice(0, 3), before, after });
    nonstop.push(r);
  }
  // Player own-metal markets (over designated hubs)
  const conns = buildOwnMetalConnections(st.routes).filter(c => st.hubs[c.hub]?.tier != null);
  let omHit = 0, omCands = 0;
  const seen = new Set();
  for (const c of conns) {
    const k = [c.legOneOrigin, c.legTwoDest].sort().join('-');
    if (seen.has(k)) continue; seen.add(k);
    const cands = rivalOneStopsFor(idx, c.legOneOrigin, c.legTwoDest);
    if (cands.length) { omHit++; omCands += cands.length; }
  }

  console.log(`\n══ ${label} ══  week ${st.week} yr ${st.year}`);
  console.log(`rivals: ${st.competitors.length} carriers, ${rivalRoutes} routes; ${rivalsWithHub} carriers with ≥1 qualifying hub; hub tiers T1 ${tierCount[1]} · T2 ${tierCount[2]} · T3 ${tierCount[3]}`);
  console.log(`index build ${tIdx.toFixed(1)} ms; ${probes.toLocaleString()} probes for ${nonstop.length + seen.size} O&Ds`);
  console.log(`player nonstop markets: ${nonstop.length}; uncontested today ${unc} (${Math.round(unc / nonstop.length * 100)}%); gain ≥1 rival one-stop ${hit} (${Math.round(hit / nonstop.length * 100)}%); of the uncontested, ${uncHit} gain one`);
  console.log(`player own-metal markets: ${seen.size}; gain ≥1 rival one-stop ${omHit} (${Math.round(omHit / Math.max(1, seen.size) * 100)}%), ${omCands} routings`);
  console.log(`first-order share estimate on nonstops: ${Math.round(paxBefore).toLocaleString()} → ${Math.round(paxAfter).toLocaleString()} pax/wk (${((paxAfter / paxBefore - 1) * 100).toFixed(1)}%)`);
  console.log(`   with spill recapture (Phase 1a): ${Math.round(paxBefore).toLocaleString()} → ${Math.round(paxAfterRecap).toLocaleString()} pax/wk (${((paxAfterRecap / paxBefore - 1) * 100).toFixed(1)}%)`);
  console.log(`   of the ${Math.round(paxBefore - paxAfter).toLocaleString()} pax the player loses, rival one-stops actually CARRY ${Math.round(rivalCarried).toLocaleString()} (${rivalCapped} routings seat-capped) — the rest evaporates (no spill recapture in computeMarketShare)`);
  losses.sort((a, b) => (a.after / a.before) - (b.after / b.before));
  for (const l of losses.slice(0, 8)) console.log(`   ${l.key.padEnd(8)} rivals now ${l.rivalsNow}, +${l.cands} one-stop(s): ${Math.round(l.before)} → ${Math.round(l.after)} (${((l.after / l.before - 1) * 100).toFixed(0)}%)  ${l.via.join('; ')}`);
}

let week = 0;
for (const target of SNAPS.sort((a, b) => a - b)) {
  const t0 = performance.now();
  while (week < target) { st = gameReducer(st, { type: 'ADVANCE_WEEK' }); week++; }
  if (target > 0) console.log(`\n(ticked to week ${week} in ${((performance.now() - t0) / 1000).toFixed(1)}s, cash ${(st.cash / 1e6).toFixed(0)}M)`);
  analyse(`${mode} @ +${target} weeks`);
}
