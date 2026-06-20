#!/usr/bin/env node
/**
 * score-candidates.mjs — Data-driven airport expansion scorer
 *
 * Scores candidate airports against TWO gates, using the GAME'S OWN gravity model
 * (imported live from src/data/airports.js so it never drifts from the game):
 *
 *   1. DISTINCTIVENESS — km to the nearest airport already in the game.
 *      A candidate sitting on top of an existing one just cannibalizes it.
 *   2. VIABILITY — best modeled weekly one-way demand from the candidate to any
 *      existing airport (its natural partner/hub). If nothing clears the floor,
 *      no aircraft in the fleet can profitably serve it.
 *
 * Verdicts: ADD | DUPLICATE (too close) | WEAK (no viable market) | EXISTS (code already in game)
 *
 * Usage:
 *   node score-candidates.mjs [candidates.csv] [path/to/src/data/airports.js]
 *
 * Tunables below (DISTINCT_MIN_KM, VIABLE_MIN_PAX, FEEDER_MAX_KM) are the policy
 * levers — change them to make the bar stricter or looser and re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ── Policy levers ────────────────────────────────────────────────────────────
const DISTINCT_MIN_KM = 90;   // closer than this to an existing airport => DUPLICATE
const VIABLE_MIN_PAX  = 150;  // best weekly one-way market below this => WEAK
const FEEDER_MAX_KM   = 2500; // "natural feeder hub" search radius (for reporting)

// ── Args ─────────────────────────────────────────────────────────────────────
const candPath = process.argv[2] || 'candidates.csv';
const __dir = path.dirname(fileURLToPath(import.meta.url));
// Default assumes this script lives in <repo>/tools/airport-expansion/
const gameAirportsPath = process.argv[3] ||
  path.resolve(__dir, '../../src/data/airports.js');

// ── Import the game's real data + scoring ────────────────────────────────────
const mod = await import(pathToFileURL(path.resolve(gameAirportsPath)).href);
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
// Candidate multiplier mirrors the game's tier defaults: leisure dest vs plain regional.
const multForCandidate = isLeisure =>
  isLeisure ? (15 + 90) / 100 : (32 + 55) / 100; // 1.05 vs 0.87
// Mirrors market.js getDemandMass(): population + tourism + gateway, effectivePop overrides.
const TOURISM_VISITOR_WEIGHT = 1.5, GATEWAY_WEIGHT = 1.0;
const demandMass = ap => ap.effectivePop != null ? ap.effectivePop
  : (ap.population ?? 0) + (ap.visitors ?? 0) * TOURISM_VISITOR_WEIGHT + (ap.gateway ?? 0) * GATEWAY_WEIGHT;
function pairDemand(popA, multA, popB, multB, dist) {
  return Math.round((Math.sqrt(popA * multA * popB * multB) * 1054) / Math.pow(1 + dist / 3000, 1.1));
}

// ── Parse candidates ─────────────────────────────────────────────────────────
const lines = fs.readFileSync(candPath, 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const header = lines.shift().split(',');
const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
const candidates = lines.map(l => {
  const c = l.split(',');
  return {
    code: c[idx.code], name: c[idx.name], city: c[idx.city], country: c[idx.country],
    lat: +c[idx.lat], lon: +c[idx.lon], population: +c[idx.population],
    leisure: +c[idx.leisure] === 1,
    visitors: idx.visitors != null ? +c[idx.visitors] || 0 : 0, // optional column
    gateway:  idx.gateway  != null ? +c[idx.gateway]  || 0 : 0, // optional column
  };
});

// ── Score ────────────────────────────────────────────────────────────────────
const results = candidates.map(cand => {
  if (existingCodes.has(cand.code)) {
    return { ...cand, verdict: 'EXISTS', nearestKm: 0, nearest: cand.code, bestDemand: 0, bestPartner: '', feederDemand: 0, feederHub: '' };
  }
  const cm = multForCandidate(cand.leisure);
  const cpop = demandMass(cand); // honours optional visitors/gateway columns if present

  let nearestKm = Infinity, nearest = '';
  let bestDemand = 0, bestPartner = '', bestKm = 0;
  let feederDemand = 0, feederHub = '', feederKm = 0;

  for (const ex of AIRPORTS) {
    const dist = distanceKm(cand, ex);
    if (dist < nearestKm) { nearestKm = dist; nearest = ex.code; }
    const epop = demandMass(ex);
    const d = pairDemand(cpop, cm, epop, multForExisting(ex.code), dist);
    if (d > bestDemand) { bestDemand = d; bestPartner = ex.code; bestKm = Math.round(dist); }
    if (dist <= FEEDER_MAX_KM && d > feederDemand) { feederDemand = d; feederHub = ex.code; feederKm = Math.round(dist); }
  }

  let verdict;
  if (nearestKm < DISTINCT_MIN_KM) verdict = 'DUPLICATE';
  else if (bestDemand < VIABLE_MIN_PAX) verdict = 'WEAK';
  else verdict = 'ADD';

  return {
    ...cand,
    verdict,
    nearestKm: Math.round(nearestKm), nearest,
    bestDemand, bestPartner, bestKm,
    feederDemand, feederHub, feederKm,
  };
});

// ── Output CSV ───────────────────────────────────────────────────────────────
const order = { ADD: 0, WEAK: 1, DUPLICATE: 2, EXISTS: 3 };
results.sort((a, b) => (order[a.verdict] - order[b.verdict]) || (b.bestDemand - a.bestDemand));
const outCols = ['verdict','code','name','city','country','population','leisure','bestDemand','bestPartner','bestKm','feederDemand','feederHub','feederKm','nearestKm','nearest'];
const csv = [outCols.join(',')].concat(results.map(r =>
  outCols.map(k => {
    let v = k === 'leisure' ? (r.leisure ? 1 : 0) : r[k];
    if (typeof v === 'string' && v.includes(',')) v = '"' + v + '"';
    return v;
  }).join(','))).join('\n');
fs.writeFileSync('scored-candidates.csv', csv);

// ── Summary ──────────────────────────────────────────────────────────────────
const by = v => results.filter(r => r.verdict === v);
const add = by('ADD');
console.log('='.repeat(64));
console.log(`Scored ${results.length} candidates against the game's gravity model`);
console.log(`Existing game airports: ${AIRPORTS.length}`);
console.log(`Gates: distinctiveness >= ${DISTINCT_MIN_KM}km, viability >= ${VIABLE_MIN_PAX} pax/wk one-way`);
console.log('='.repeat(64));
console.log(`  ADD ........ ${by('ADD').length}   (clears both gates)`);
console.log(`  WEAK ....... ${by('WEAK').length}   (no viable market)`);
console.log(`  DUPLICATE .. ${by('DUPLICATE').length}   (too close to an existing airport)`);
console.log(`  EXISTS ..... ${by('EXISTS').length}   (code already in game)`);
console.log('='.repeat(64));

const region = c => ({
  CN:'E Asia',JP:'E Asia',KR:'E Asia',IN:'S Asia',ID:'SE Asia',PH:'SE Asia',VN:'SE Asia',TH:'SE Asia',KH:'SE Asia',LA:'SE Asia',MM:'SE Asia',
  BR:'S America',NG:'Africa',CI:'Africa',TZ:'Africa',UG:'Africa',RW:'Africa',AO:'Africa',ZM:'Africa',MG:'Africa',MA:'Africa',KE:'Africa',
  UZ:'C Asia',AZ:'C Asia',AM:'C Asia',GE:'C Asia',KG:'C Asia',TR:'MidEast',SA:'MidEast',IQ:'MidEast',OM:'MidEast',
  IT:'Europe',PT:'Europe',ES:'Europe',FR:'Europe',DE:'Europe',PL:'Europe',HR:'Europe',BG:'Europe',LV:'Europe',EE:'Europe',
  DO:'Caribbean',CU:'Caribbean',JM:'Caribbean',BS:'Caribbean',AW:'Caribbean',CW:'Caribbean',BB:'Caribbean',TT:'Caribbean',
  GU:'Pacific',FJ:'Pacific',PF:'Pacific',NC:'Pacific',PG:'Pacific',CK:'Pacific',VU:'Pacific',WS:'Pacific',
}[c] || 'Other');
const regCounts = {};
add.forEach(r => { regCounts[region(r.country)] = (regCounts[region(r.country)] || 0) + 1; });
console.log('\nADD recommendations by region:');
Object.entries(regCounts).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k.padEnd(12)} ${v}`));

console.log('\nTop 20 ADD by modeled demand (best single-route market, pax/wk one-way):');
add.slice(0, 20).forEach(r =>
  console.log(`  ${r.code}  ${r.city.padEnd(16).slice(0,16)} ${String(r.bestDemand).padStart(5)}pax -> ${r.bestPartner} (${r.bestKm}km)  [near ${r.nearest} ${r.nearestKm}km]`));

console.log('\nFlagged WEAK (interesting only as monopoly small-aircraft niche):');
by('WEAK').slice(0,12).forEach(r =>
  console.log(`  ${r.code}  ${r.city.padEnd(16).slice(0,16)} best ${String(r.bestDemand).padStart(4)}pax -> ${r.bestPartner}`));

console.log('\nFlagged DUPLICATE / EXISTS (already covered):');
console.log('  ' + by('DUPLICATE').map(r=>`${r.code}(~${r.nearest} ${r.nearestKm}km)`).join(', '));
console.log('  EXISTS: ' + by('EXISTS').map(r=>r.code).join(', '));
console.log('\nWrote scored-candidates.csv');
