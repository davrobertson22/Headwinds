// Which aircraft are never the right answer?
//
//   node tools/catalogue-deadweight-report.mjs
//   node tools/catalogue-deadweight-report.mjs --verbose      # per-type detail
//   node tools/catalogue-deadweight-report.mjs --validate     # agreement check only
//
// Read-only. Touches no database and no save.
//
// WHY THIS EXISTS. A Discord thread argued the catalogue carries types that are
// "more screen filler than anything anyone will have in their fleet". Answering
// that needs a definition of dead weight that survives contact with the game, and
// two earlier attempts did not:
//
//   1. ATTRIBUTE DOMINANCE — A beats B if it has >= seats and range for <= price,
//      fuel, maintenance and runway. This "proved" the A319 kills the E190, which
//      is nonsense: it rewards seat count, and a small aircraft exists precisely
//      to MATCH THIN DEMAND. Filling 149 seats is not a virtue on a route with 90
//      passengers.
//   2. BEST-PROFIT-AT-A-MARKET-SIZE, sampled over six sectors and eight demand
//      points. Right shape, but 48 cells cannot support a claim about 140 types —
//      "122 never win" was an artefact of the grid, not a finding.
//
// So: sweep the mission space properly. A mission is (sector, market size), and
// the eligible aircraft are those with the range to fly it and the field
// performance to use both ends. Each type picks its OWN best weekly frequency
// under the block-hour cap, which is what makes this fair to small aircraft —
// their answer to a thin market is more rotations, not a bigger cabin.
//
// A type is dead weight only if it is never the best answer AND never even close
// to it. "Never wins" alone is far too strong: an aircraft that is consistently
// within a couple of percent of the winner is a perfectly good alternative, and a
// catalogue where every type wins outright somewhere would be a catalogue with no
// meaningful choices in it. The report therefore ranks by BEST RATIO TO WINNER
// across every mission the type can fly, and the prune candidates are the ones
// that never get close anywhere.
//
// The cost model is assembled from the engine's own functions rather than
// re-derived — fuelCostPerKm, crewCostPerKm, weeklyLandingFee,
// weeklyInsuranceCost, the labour groups through crewScaleFor, and HQ through
// hqScaleFor. --validate reconciles it against weeklyTick on real fixtures and
// prints the worst disagreement; if that number is not near zero, the model has
// drifted from the tick and nothing below it can be trusted.

import { AIRCRAFT_TYPES, getAircraftType } from '../packages/engine/src/data/aircraft.js';
import { getAirport, AIRPORTS } from '../packages/engine/src/data/airports.js';
import {
  calcHQCost, hqScaleFor, weeklyInsuranceCost, weeklyLandingFee,
} from '../packages/engine/src/data/overhead.js';
import { LABOR_GROUPS, crewScaleFor } from '../packages/engine/src/data/labor.js';
import { fuelCostPerKm } from '../packages/engine/src/utils/fuel.js';
import {
  weeklyTick, routeDistanceKm, maxFrequency, MAX_WEEKLY_BLOCK_HOURS,
} from '../packages/engine/src/utils/simulation.js';
import { referencePrice, expectedCarried } from '../packages/engine/src/utils/market.js';
import { pathToFileURL } from 'node:url';

const args    = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const ONLY_VALIDATE = args.includes('--validate');
const f = (n) => Math.round(n).toLocaleString();
const pct = (x) => (100 * x).toFixed(1) + '%';

// ── The mission space ────────────────────────────────────────────────────────
// Sectors chosen to span distance AND field length, because runway is the one
// axis on which a small aircraft is not merely cheaper but the ONLY option.
export const SECTORS = [
  // Genuinely tiny fields FIRST. These are the missions where a small aircraft is
  // not merely cheaper but the only thing that fits, and leaving them out was a
  // real flaw in the first cut of this grid: the 19-seaters were only ever tested
  // against 4,300ft fields a Short 360 can also use, so they looked pointless.
  ['SAB', 'SXM'], ['SBH', 'SXM'], ['LUA', 'KTM'], ['CVF', 'NOU'],
  ['BRR', 'GLA'], ['DGH', 'CCU'], ['TVU', 'NAN'], ['GZO', 'HIR'],
  ['LCY', 'AMS'], ['SDU', 'CGH'], ['FLR', 'CDG'],          // short field
  ['BOI', 'SLC'], ['BLI', 'SEA'], ['KTN', 'JNU'],          // short, regional field
  ['JFK', 'BOS'], ['LAX', 'SFO'], ['LHR', 'CDG'],          // short, big field
  ['JFK', 'ORD'], ['LHR', 'MAD'], ['SYD', 'MEL'],
  ['JFK', 'DEN'], ['LAX', 'ORD'], ['LHR', 'IST'],
  ['JFK', 'LAX'], ['LHR', 'DXB'], ['NRT', 'SIN'],
  ['JFK', 'LHR'], ['LAX', 'NRT'], ['DXB', 'LHR'],
  ['JFK', 'NRT'], ['SYD', 'LAX'], ['SIN', 'LHR'],
  ['SYD', 'LHR'],                                           // ultra-long
].map(([o, d]) => {
  const O = getAirport(o), D = getAirport(d);
  if (!O || !D) return null;
  return { o, d, O, D, km: routeDistanceKm(o, d),
           runway: Math.min(O.runwayFt, D.runwayFt),
           fare: referencePrice(o, d) };
}).filter(Boolean);

// Weekly market size, log-spaced from a bush route to a trunk.
const DEMANDS = [];
for (let x = 60; x <= 60000; x = Math.round(x * 1.35)) DEMANDS.push(x);

const PAX = AIRCRAFT_TYPES.filter(t => !t.freighter && t.seats > 0);

// ── One airframe, one route, one week ────────────────────────────────────────
export function fixedWeekly(t) {
  let labour = 0;
  for (const g of LABOR_GROUPS) labour += g.baseWeeklyPerAircraft * crewScaleFor(g.id, t);
  const insurance = weeklyInsuranceCost({ ownershipType: 'leased', ageWeeks: 260 }, t);
  return t.weeklyLease + t.baseMaintenancePerWk + insurance + labour + calcHQCost(hqScaleFor(t));
}
const FIXED = new Map(PAX.map(t => [t.id, fixedWeekly(t)]));

export function variableWeekly(t, s, freq) {
  const flights = freq * 2;
  return s.km * fuelCostPerKm(t) * flights
       + s.km * t.crewCostPerKm * flights
       + weeklyLandingFee(t.category, freq, s.O.tier, s.D.tier);
}

export function eligible(t, s) { return t.range >= s.km && t.runwayFt <= s.runway; }

// Best profit this type can reach on this sector against a market of `demand`,
// choosing its own frequency. Costs per (type, sector, freq) are demand-free, so
// they are computed once and reused across the whole demand sweep.
const COST = new Map();
function costsFor(t, s) {
  const key = t.id + '|' + s.o + s.d;
  let rows = COST.get(key);
  if (rows) return rows;
  const cap = Math.max(1, Math.min(28, maxFrequency(s.km, t, MAX_WEEKLY_BLOCK_HOURS)));
  rows = [];
  for (let freq = 1; freq <= cap; freq++) {
    rows.push({ freq, cap: t.seats * freq * 2, cost: FIXED.get(t.id) + variableWeekly(t, s, freq) });
  }
  COST.set(key, rows);
  return rows;
}
function bestProfit(t, s, demand) {
  let best = -Infinity;
  for (const r of costsFor(t, s)) {
    const pax = expectedCarried(demand, r.cap);
    const p = pax * s.fare * (t.ticketPremium ?? 1) - r.cost;
    if (p > best) best = p;
  }
  return best;
}

/**
 * The best week this type could ever have on this sector: every seat sold, at
 * whichever frequency pays best. An aircraft that cannot clear zero here cannot
 * clear it anywhere — no load factor, fare or schedule saves it.
 */
export function bestCaseProfit(t, s) {
  if (!eligible(t, s)) return null;
  let best = -Infinity;
  for (const r of costsFor(t, s)) {
    const p = r.cap * s.fare * (t.ticketPremium ?? 1) - r.cost;
    if (p > best) best = p;
  }
  return best;
}

export function sector(o, d) {
  const O = getAirport(o), D = getAirport(d);
  if (!O || !D) return null;
  return { o, d, O, D, km: routeDistanceKm(o, d),
           runway: Math.min(O.runwayFt, D.runwayFt), fare: referencePrice(o, d) };
}

// ── Agreement with the tick ──────────────────────────────────────────────────
// The model above must not drift from weeklyTick. Reconcile the VARIABLE half —
// the part that depends on the route — since the fixed half is read from the
// same functions the tick reads.
function validate() {
  console.log('\nAgreement with weeklyTick (variable route cost, one leased airframe)');
  let worst = 0, worstAt = '';
  const cases = [];
  for (const id of ['dhc8300', 'e190', 'b737800', 'b767300', 'a380', 'b777300er']) {
    const t = getAircraftType(id); if (!t) continue;
    for (const s of SECTORS) {
      if (!eligible(t, s)) continue;
      cases.push([t, s]); break;
    }
  }
  for (const [t, s] of cases) {
    const freq = Math.max(1, Math.min(4, maxFrequency(s.km, t, MAX_WEEKLY_BLOCK_HOURS)));
    const state = {
      fleet: [{ id: 'a1', typeId: t.id, status: 'idle', ownershipType: 'leased', ageWeeks: 260,
                config: { economy: t.seats, premiumEconomy: 0, businessClass: 0, firstClass: 0,
                          seatQuality: 'standard', serviceQuality: 'standard' } }],
      routes: [{ id: 'r1', aircraftId: 'a1', origin: s.o, destination: s.d,
                 weeklyFrequency: freq, ticketPrice: s.fare, classPrices: { economy: s.fare } }],
      cargoRoutes: [], gates: { [s.o]: 2, [s.d]: 2 }, hubs: {}, cash: 500_000_000,
    };
    const r = weeklyTick(state);
    const tickVar = (r.totalFuel ?? 0) + (r.totalCrew ?? 0) + (r.totalLandingFees ?? 0);
    const mine = variableWeekly(t, s, freq);
    const diff = tickVar > 0 ? Math.abs(mine - tickVar) / tickVar : (mine === 0 ? 0 : 1);
    if (diff > worst) { worst = diff; worstAt = `${t.id} ${s.o}-${s.d} f${freq}`; }
    console.log(`  ${t.id.padEnd(11)} ${(s.o + '-' + s.d).padEnd(9)} f${String(freq).padStart(2)}  ` +
      `tick $${f(tickVar).padStart(10)}  model $${f(mine).padStart(10)}  ${pct(diff)}`);
  }
  console.log(`\n  worst disagreement ${pct(worst)}${worstAt ? ' at ' + worstAt : ''}`);
  if (worst > 0.02) console.log('  ⚠ over 2% — the model has drifted from the tick; treat the report below as unsound.');
  return worst;
}

const RUN_AS_SCRIPT = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (!RUN_AS_SCRIPT) {
  // Imported for its model (see tools/seat-scale-continuity-test.mjs) — do not sweep.
} else {

const drift = validate();
if (ONLY_VALIDATE) process.exit(drift > 0.02 ? 1 : 0);

// ── Sweep ────────────────────────────────────────────────────────────────────
const stat = new Map(PAX.map(t => [t.id, { wins: 0, bestRatio: 0, missions: 0, wonAt: [] }]));
let cells = 0;
for (const s of SECTORS) {
  const runners = PAX.filter(t => eligible(t, s));
  if (!runners.length) continue;
  for (const demand of DEMANDS) {
    cells++;
    let bestP = -Infinity, bestT = null;
    const scored = [];
    for (const t of runners) {
      const p = bestProfit(t, s, demand);
      scored.push([t, p]);
      if (p > bestP) { bestP = p; bestT = t; }
    }
    if (bestP <= 0) continue;                     // nobody can make money here
    stat.get(bestT.id).wins++;
    stat.get(bestT.id).wonAt.push(`${s.o}-${s.d}@${demand}`);
    for (const [t, p] of scored) {
      const st = stat.get(t.id);
      st.missions++;
      const ratio = p / bestP;
      if (ratio > st.bestRatio) st.bestRatio = ratio;
    }
  }
}

const rows = [...stat.entries()].map(([id, st]) => ({ t: getAircraftType(id), ...st }))
  .filter(r => r.missions > 0);
const never = rows.filter(r => r.wins === 0).sort((a, b) => a.bestRatio - b.bestRatio);

console.log(`\n${SECTORS.length} sectors × ${DEMANDS.length} market sizes = ${cells} missions · ` +
  `${PAX.length} passenger types · ${rows.filter(r => r.wins > 0).length} win at least one mission`);

console.log('\n── PRUNE CANDIDATES: never the best answer, and never close to it ──');
const dead = never.filter(r => r.bestRatio < 0.5);
console.log(dead.length ? '' : '  (none)');
for (const r of dead) {
  console.log(`  ${r.t.id.padEnd(13)} ${r.t.name.slice(0, 26).padEnd(27)} ${String(r.t.eis).padStart(4)}  ` +
    `${String(r.t.seats).padStart(3)}s  best it ever manages: ${pct(r.bestRatio).padStart(7)} of the winner`);
}

console.log('\n── VIABLE ALTERNATIVES: never win outright, but come close ──');
for (const r of never.filter(r => r.bestRatio >= 0.5).sort((a, b) => b.bestRatio - a.bestRatio)) {
  console.log(`  ${r.t.id.padEnd(13)} ${r.t.name.slice(0, 26).padEnd(27)} ${String(r.t.eis).padStart(4)}  ` +
    `${String(r.t.seats).padStart(3)}s  peaks at ${pct(r.bestRatio)} of the winner`);
}

if (VERBOSE) {
  console.log('\n── WINNERS: what each one owns ──');
  for (const r of rows.filter(r => r.wins > 0).sort((a, b) => b.wins - a.wins)) {
    console.log(`  ${r.t.id.padEnd(13)} ${String(r.wins).padStart(4)} missions  ` +
      `${r.t.seats}s ${r.t.range}km  e.g. ${r.wonAt.slice(0, 3).join(', ')}`);
  }
}

}
