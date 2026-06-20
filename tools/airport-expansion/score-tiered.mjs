#!/usr/bin/env node
/**
 * score-tiered.mjs — Region-aware (tiered) airport expansion scorer
 *
 * Same two gates as score-candidates.mjs (distinctiveness + viability), scored
 * against the GAME'S OWN gravity model (imported live from src/data/airports.js),
 * but the thresholds vary by REGION TIER so we can scale toward 2,500-3,000 with
 * realism instead of a flat global bar:
 *
 *   DENSE  (US, Canada, W. Europe, Japan, Korea, Australia, Gulf) — STRICT.
 *          These markets already have deep coverage; a new field there is almost
 *          always a DUPLICATE or marginal, so keep the bar high.
 *   MID    (Russia, Latin America, E. Europe, developed SE Asia, S. Africa) — MEDIUM.
 *   SPARSE (China, India, Indonesia, Pakistan, Bangladesh, Africa, most of the
 *          Middle East, Central Asia, Pacific) — LOOSE. Under-served per the
 *          AUDIT, so allow closer spacing + smaller markets to add depth.
 *
 * Verdicts: ADD | DUPLICATE (too close) | WEAK (no viable market) | EXISTS (code in game)
 *
 * Usage:
 *   node score-tiered.mjs <out.csv> <candidates1.csv> [candidates2.csv ...]
 *   (defaults: out = scored-tiered.csv, inputs = candidates.csv)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ── Region tiers ─────────────────────────────────────────────────────────────
const DENSE = new Set(['US','CA','GB','FR','DE','IT','ES','NL','BE','CH','AT','IE','JP','KR','AU','NZ','AE','QA','SG','LU','DK','SE','NO','FI']);
const MID   = new Set(['RU','BR','MX','AR','CL','CO','PE','EC','UY','PY','BO','VE',
                       'PL','RO','CZ','HU','GR','PT','HR','BG','RS','SK','SI','LT','LV','EE','UA','BY','TR',
                       'TH','MY','VN','ZA','IL','SA','KW','BH','OM']);
// everything else => SPARSE

// thresholds: [DISTINCT_MIN_KM, VIABLE_MIN_PAX]
const GATES = {
  DENSE:  [90, 150],
  MID:    [65, 90],
  SPARSE: [45, 55],
  // US runs its own tier: the country genuinely has deep multi-airport metros
  // (the game already models JFK/LGA/EWR, DAL/DFW, HOU/IAH, ORD/MDW, SFO/OAK/SJC).
  // Relax distinctiveness to admit legit secondary-metro + separate-city airports,
  // but keep it >20km so a truly co-located field (e.g. ECP 20km from PFN) stays out.
  US:     [24, 130],
};
const FEEDER_MAX_KM = 2500;
const tierOf = country => country === 'US' ? 'US'
  : DENSE.has(country) ? 'DENSE' : MID.has(country) ? 'MID' : 'SPARSE';

// ── Args ─────────────────────────────────────────────────────────────────────
const outPath = process.argv[2] || 'scored-tiered.csv';
const inputs  = process.argv.slice(3);
if (inputs.length === 0) inputs.push('candidates.csv');
const __dir = path.dirname(fileURLToPath(import.meta.url));
const gameAirportsPath = path.resolve(__dir, '../../src/data/airports.js');

// ── Import the game's real data + scoring ────────────────────────────────────
const mod = await import(pathToFileURL(gameAirportsPath).href);
const AIRPORTS = mod.AIRPORTS;
const getAirportScores = mod.getAirportScores;
const existingCodes = new Set(AIRPORTS.map(a => a.code));

// ── Gravity model — identical to utils/market.js ─────────────────────────────
const toRad = d => d * Math.PI / 180;
function distanceKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
  const x = s1*s1 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*s2*s2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
const multForExisting = code => {
  const { businessScore, leisureScore } = getAirportScores(code);
  return (businessScore + leisureScore) / 100;
};
const multForCandidate = isLeisure => isLeisure ? (15 + 90) / 100 : (32 + 55) / 100;
const TOURISM_VISITOR_WEIGHT = 1.5, GATEWAY_WEIGHT = 1.0;
const demandMass = ap => ap.effectivePop != null ? ap.effectivePop
  : (ap.population ?? 0) + (ap.visitors ?? 0) * TOURISM_VISITOR_WEIGHT + (ap.gateway ?? 0) * GATEWAY_WEIGHT;
function pairDemand(popA, multA, popB, multB, dist) {
  return Math.round((Math.sqrt(popA * multA * popB * multB) * 1054) / Math.pow(1 + dist / 3000, 1.1));
}

// ── Parse candidates (multiple files, dedupe by code, skip intra-batch dupes) ─
const seen = new Set();
const candidates = [];
for (const f of inputs) {
  const lines = fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const header = lines.shift().split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  for (const l of lines) {
    const c = l.split(',');
    const code = c[idx.code];
    if (!code) continue;
    if (seen.has(code)) continue;           // duplicate candidate code across batches
    seen.add(code);
    candidates.push({
      code, name: c[idx.name], city: c[idx.city], country: c[idx.country],
      lat: +c[idx.lat], lon: +c[idx.lon], population: +c[idx.population],
      leisure: +c[idx.leisure] === 1,
      visitors: idx.visitors != null ? +c[idx.visitors] || 0 : 0,
      gateway:  idx.gateway  != null ? +c[idx.gateway]  || 0 : 0,
    });
  }
}

// ── Score ────────────────────────────────────────────────────────────────────
const results = candidates.map(cand => {
  const tier = tierOf(cand.country);
  const [DMIN, VMIN] = GATES[tier];
  if (existingCodes.has(cand.code))
    return { ...cand, tier, verdict: 'EXISTS', nearestKm: 0, nearest: cand.code, bestDemand: 0, bestPartner: '', bestKm: 0 };
  if (!isFinite(cand.lat) || !isFinite(cand.lon) || (cand.lat === 0 && cand.lon === 0))
    return { ...cand, tier, verdict: 'BADGEO', nearestKm: -1, nearest: '', bestDemand: 0, bestPartner: '', bestKm: 0 };

  const cm = multForCandidate(cand.leisure);
  const cpop = demandMass(cand);
  let nearestKm = Infinity, nearest = '', bestDemand = 0, bestPartner = '', bestKm = 0;
  for (const ex of AIRPORTS) {
    const dist = distanceKm(cand, ex);
    if (dist < nearestKm) { nearestKm = dist; nearest = ex.code; }
    const d = pairDemand(cpop, cm, demandMass(ex), multForExisting(ex.code), dist);
    if (d > bestDemand) { bestDemand = d; bestPartner = ex.code; bestKm = Math.round(dist); }
  }
  let verdict;
  if (nearestKm < DMIN) verdict = 'DUPLICATE';
  else if (bestDemand < VMIN) verdict = 'WEAK';
  else verdict = 'ADD';
  return { ...cand, tier, verdict, nearestKm: Math.round(nearestKm), nearest, bestDemand, bestPartner, bestKm };
});

// ── Output CSV ───────────────────────────────────────────────────────────────
const order = { ADD: 0, WEAK: 1, DUPLICATE: 2, EXISTS: 3, BADGEO: 4 };
results.sort((a, b) => (order[a.verdict] - order[b.verdict]) || (b.bestDemand - a.bestDemand));
const outCols = ['verdict','tier','code','name','city','country','lat','lon','population','leisure','visitors','gateway','bestDemand','bestPartner','bestKm','nearestKm','nearest'];
const csv = [outCols.join(',')].concat(results.map(r =>
  outCols.map(k => {
    let v = k === 'leisure' ? (r.leisure ? 1 : 0) : r[k];
    if (typeof v === 'string' && v.includes(',')) v = '"' + v + '"';
    return v;
  }).join(','))).join('\n');
fs.writeFileSync(outPath, csv);

// ── Summary ──────────────────────────────────────────────────────────────────
const by = v => results.filter(r => r.verdict === v);
console.log('='.repeat(68));
console.log(`Scored ${results.length} candidates | existing game airports: ${AIRPORTS.length}`);
console.log(`Tier gates  DENSE ${GATES.DENSE.join('/')}  MID ${GATES.MID.join('/')}  SPARSE ${GATES.SPARSE.join('/')}  (km / pax-wk)`);
console.log('='.repeat(68));
for (const v of ['ADD','WEAK','DUPLICATE','EXISTS','BADGEO'])
  console.log(`  ${v.padEnd(10)} ${by(v).length}`);
console.log('='.repeat(68));
const add = by('ADD');
const regC = {}; add.forEach(r => regC[r.country] = (regC[r.country]||0)+1);
console.log('ADD by country:');
console.log('  ' + Object.entries(regC).sort((a,b)=>b[1]-a[1]).map(([c,n])=>`${c}:${n}`).join('  '));
console.log(`\nProjected total if all ADDs inserted: ${AIRPORTS.length + add.length}`);
console.log(`Wrote ${outPath}`);
