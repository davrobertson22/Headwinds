// Hemisphere-accurate seasonality.
//
// The seasonal profile a route uses is built from its airports' LATITUDE, not
// from a hand-kept list of southern-hemisphere countries. Three claims:
//
//   • a temperate southern airport peaks in the southern summer (Dec–Feb) and
//     troughs in July — whatever country it is in, including the ~44 southern
//     countries the old country map never listed;
//   • the calendar does not flip with the climate: Christmas stays in December
//     in both hemispheres, which is why the southern curves are not a plain
//     six-month rotation of the northern ones;
//   • seasonality fades toward the equator — an airport at 3°S must not be
//     handed either hemisphere's summer, and a country that straddles the
//     equator (Brazil, Indonesia, Ecuador, Kenya, Colombia) must not get one
//     answer for all of its airports.
//
// Total demand is hemisphere-neutral: flipping the seasons moves traffic
// between months, it does not create or destroy it over a year.
//
//   node tools/hemisphere-seasons-test.mjs

import assert from 'node:assert/strict';
import {
  SEASONAL_PROFILES, seasonalProfileForAirport, getSeasonalProfile,
  seasonalProfileIdFor, directionalSeasonalSkew, SEASONAL_SKEW_CAP,
} from '../packages/engine/src/models/demand.js';
import { getAirport } from '../packages/engine/src/data/airports.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const mean   = p => MONTHS.reduce((s, m) => s + p[m], 0) / 12;
const peakOf = p => MONTHS.reduce((b, m) => (p[m] > p[b] ? m : b), 1);
const troughOf = p => MONTHS.reduce((b, m) => (p[m] < p[b] ? m : b), 1);
const SUMMER_S = new Set([12, 1, 2]);
const SUMMER_N = new Set([6, 7, 8]);

console.log('\n── Southern hemisphere, by latitude ─────────────────────');

test('southern temperate airports peak in the southern summer', () => {
  for (const code of ['SYD', 'AKL', 'JNB', 'EZE', 'SCL', 'MVD', 'CPT']) {
    const ap = getAirport(code);
    if (!ap) continue;
    assert.ok(ap.lat < 0, `${code} should be southern`);
    const p = seasonalProfileForAirport(code);
    assert.ok(SUMMER_S.has(peakOf(p)), `${code} peaks in month ${peakOf(p)}`);
    assert.ok(p[7] < p[1], `${code}: July ${p[7]} should be quieter than January ${p[1]}`);
  }
});

test('countries the old map never listed are southern too', () => {
  // MVD Uruguay, WDH Namibia, HRE Zimbabwe, ANT/TNR Madagascar, LAD Angola…
  // none of these were in COUNTRY_PROFILE, so all of them ran on the northern
  // generic curve: a July peak in the middle of the southern winter.
  for (const code of ['MVD', 'WDH', 'HRE', 'TNR', 'GBE']) {
    const ap = getAirport(code);
    if (!ap || ap.lat > -15) continue;
    const p = seasonalProfileForAirport(code);
    assert.ok(p[1] > p[7], `${code} (${ap.country}, lat ${ap.lat}): Jan ${p[1]} vs Jul ${p[7]}`);
  }
});

test('northern temperate airports are untouched', () => {
  // The whole northern temperate world must be bit-identical to the authored
  // archetype — this change is not a rebalance of everyone else.
  for (const code of ['JFK', 'LAX', 'ORD', 'LHR', 'FRA', 'NRT', 'SEA']) {
    const ap = getAirport(code);
    if (!ap) continue;
    const id = seasonalProfileIdFor(code);
    assert.deepEqual(seasonalProfileForAirport(code), SEASONAL_PROFILES[id], code);
  }
});

console.log('\n── The calendar does not flip with the climate ──────────');

test('December stays busy in the south — Christmas does not move', () => {
  const syd = seasonalProfileForAirport('SYD');
  assert.ok(syd[12] > 1.05, `Sydney December ${syd[12]} should be a peak, not a trough`);
});

test('a southern curve is NOT a six-month rotation of the northern one', () => {
  const gen = SEASONAL_PROFILES.generic;
  const syd = seasonalProfileForAirport('SYD');
  const rotated = MONTHS.map(m => gen[((m + 5) % 12) + 1]);
  const same = MONTHS.every(m => Math.abs(syd[m] - rotated[m - 1]) < 0.02);
  assert.ok(!same, 'southern profile is a plain rotation — the holidays moved with it');
});

console.log('\n── The tropics ─────────────────────────────────────────');

test('seasonality fades toward the equator', () => {
  const swing = p => Math.max(...MONTHS.map(m => p[m])) - Math.min(...MONTHS.map(m => p[m]));
  const equator = ['UIO', 'BOG'].map(getAirport).find(a => a && Math.abs(a.lat) < 6);
  assert.ok(equator, 'no equatorial airport found to test');
  const near = seasonalProfileForAirport(equator.code);
  const far  = seasonalProfileForAirport('SYD');
  assert.ok(swing(near) < swing(far) * 0.5,
    `${equator.code} swing ${swing(near).toFixed(2)} vs SYD ${swing(far).toFixed(2)}`);
});

test('a country that straddles the equator gets more than one answer', () => {
  // Brazil ran entirely on the southern curve; Indonesia entirely on the Asian
  // one. Manaus is 3°S and São Paulo is 23°S — they cannot share a season.
  const north = seasonalProfileForAirport('MAO');
  const south = seasonalProfileForAirport('GRU');
  assert.ok(MONTHS.some(m => Math.abs(north[m] - south[m]) > 0.05),
    'Manaus and São Paulo have identical seasons');
});

console.log('\n── Conservation and continuity ─────────────────────────');

test('flipping the seasons does not change the annual total', () => {
  for (const code of ['SYD', 'GRU', 'MAO', 'JFK', 'NBO', 'DPS']) {
    if (!getAirport(code)) continue;
    const p  = seasonalProfileForAirport(code);
    const id = seasonalProfileIdFor(code);
    const base = mean(SEASONAL_PROFILES[id]);
    assert.ok(Math.abs(mean(p) - base) / base < 0.02,
      `${code}: annual mean ${mean(p).toFixed(3)} vs archetype ${base.toFixed(3)}`);
  }
});

test('no cliff between two cities a hundred kilometres apart', () => {
  // A hard cutoff at the Tropic of Capricorn would put Rio (22.9°S) and
  // São Paulo (23.4°S) in different hemispheres.
  const rio = seasonalProfileForAirport('GIG') ?? seasonalProfileForAirport('SDU');
  const sao = seasonalProfileForAirport('GRU');
  for (const m of MONTHS) {
    assert.ok(Math.abs(rio[m] - sao[m]) < 0.15, `month ${m}: ${rio[m]} vs ${sao[m]}`);
  }
});

test('a route blends its two ends, and its skew stays capped', () => {
  const p = getSeasonalProfile('SYD', 'LAX');
  assert.equal(p.length, 13);
  for (const m of MONTHS) assert.ok(p[m] > 0.4 && p[m] < 1.8, `month ${m}: ${p[m]}`);
  for (const [o, d] of [['SYD', 'LAX'], ['JFK', 'GRU'], ['AKL', 'SIN']]) {
    for (const m of MONTHS) {
      assert.ok(Math.abs(directionalSeasonalSkew(o, d, m)) <= SEASONAL_SKEW_CAP + 1e-12);
    }
  }
});

test('a long-haul north-south route is lopsided both ways across the year', () => {
  // The aeroplane flies south full in January and north full in July.
  const jan = directionalSeasonalSkew('LAX', 'SYD', 1);
  const jul = directionalSeasonalSkew('LAX', 'SYD', 7);
  assert.ok(jan < -0.05, `January skew ${jan} should point at Sydney`);
  assert.ok(jul > 0.05, `July skew ${jul} should point at Los Angeles`);
});

test('two ends of the same season are still never lopsided', () => {
  for (const [o, d] of [['JFK', 'LAX'], ['SYD', 'MEL']]) {
    if (!getAirport(o) || !getAirport(d)) continue;
    for (const m of MONTHS) {
      assert.equal(directionalSeasonalSkew(o, d, m), 0, `${o}-${d} month ${m}`);
    }
  }
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
