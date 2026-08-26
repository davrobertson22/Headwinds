// A territory belongs to its sovereign state where "home country" rules apply.
//
// Reported on Discord (Knightmare, 2026-08-25): "hubs can only be built in the
// starting country, but puerto rico is listed as a separate country from the
// US". The airport table is right — SJU's country IS 'PR' — but every rule
// phrased as "your home country" was comparing those raw ISO codes, so a US
// airline was refused a hub on US soil. The same refusal was waiting at
// Pointe-à-Pitre for a French airline and at Nuuk for a Danish one.
//
// data/territories.js is the sovereignty reading. Demand, affinity and the
// domestic/international split in market.js deliberately still read
// airport.country — those are balance questions, not legal ones — so this test
// also pins that separation down.
//
//   node tools/territory-hub-test.mjs

import assert from 'node:assert/strict';
import { sovereignCountry, sameSovereign, SOVEREIGN_OF } from '../packages/engine/src/data/territories.js';
import { hubUpgradeChecklist, intlDestinationsFrom } from '../packages/engine/src/models/demand.js';
import { getAirport } from '../packages/engine/src/data/airports.js';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\n── The map itself ───────────────────────────────────────');

test('a territory resolves to its sovereign, a sovereign to itself', () => {
  assert.equal(sovereignCountry('PR'), 'US');
  assert.equal(sovereignCountry('GU'), 'US');
  assert.equal(sovereignCountry('GP'), 'FR');
  assert.equal(sovereignCountry('GL'), 'DK');
  assert.equal(sovereignCountry('US'), 'US');
  assert.equal(sovereignCountry('FR'), 'FR');
  assert.equal(sovereignCountry('ZZ'), 'ZZ');      // unknown codes pass through
  assert.equal(sovereignCountry(null), null);
});

test('sameSovereign never matches on a missing side', () => {
  assert.equal(sameSovereign('PR', 'US'), true);
  assert.equal(sameSovereign('US', 'PR'), true);
  assert.equal(sameSovereign('PR', 'FR'), false);
  assert.equal(sameSovereign(null, null), false);
  assert.equal(sameSovereign('US', undefined), false);
});

test('separate-registry countries are NOT folded in', () => {
  // Aruba, Curaçao, Sint Maarten, Hong Kong, Macau and the British Overseas
  // Territories run their own registries and their own air-services agreements.
  for (const code of ['AW', 'CW', 'SX', 'HK', 'MO', 'BM', 'KY', 'TC', 'GI', 'VG', 'AI']) {
    assert.equal(SOVEREIGN_OF[code], undefined, `${code} should stay its own country`);
  }
});

test('the map only ever points at a real sovereign', () => {
  for (const [terr, sov] of Object.entries(SOVEREIGN_OF)) {
    assert.ok(!SOVEREIGN_OF[sov], `${terr} → ${sov}, but ${sov} is itself a territory`);
  }
});

console.log('\n── Hub eligibility ──────────────────────────────────────');

const usSnap = (extra = {}) => ({
  routes: [], gates: { SJU: 12, MIA: 12, YYZ: 12, LHR: 12 }, homeCountry: 'US',
  hubs: {}, hubThroughput: {}, cash: 5_000_000_000, absWeek: 400, ...extra,
});
const countryCheck = (snap, code, tier) =>
  hubUpgradeChecklist(snap, code, tier).checks.find(c => c.id === 'country') ?? null;

test('San Juan is home soil for a US airline', () => {
  assert.equal(getAirport('SJU').country, 'PR', 'the airport table should still say PR');
  const chk = countryCheck(usSnap(), 'SJU', 1);
  assert.ok(chk, 'a full hub should still be country-checked');
  assert.equal(chk.met, true, 'a US airline was refused a hub in Puerto Rico');
});

test('a genuinely foreign airport is still refused', () => {
  assert.equal(countryCheck(usSnap(), 'YYZ', 1).met, false);
  assert.equal(countryCheck(usSnap(), 'LHR', 1).met, false);
});

test('it reads both ways — a San Juan airline may hub on the mainland', () => {
  const chk = countryCheck(usSnap({ homeCountry: 'PR' }), 'MIA', 1);
  assert.equal(chk.met, true);
});

test('France reaches its overseas departments too', () => {
  const snap = usSnap({ homeCountry: 'FR', gates: { PTP: 12, FDF: 12, JFK: 12 } });
  for (const code of ['PTP', 'FDF']) {
    if (!getAirport(code)) continue;                       // not in this airport table
    assert.equal(countryCheck(snap, code, 1).met, true, `${code} should be French soil`);
  }
  assert.equal(countryCheck(snap, 'JFK', 1).met, false);
});

test('the foreign focus-city cap counts states, not territory codes', () => {
  // One focus city per FOREIGN country. A US airline with a focus city at SJU
  // has spent nothing — SJU is domestic — so MIA-based expansion is unaffected.
  const snap = usSnap({ hubs: { SJU: { tier: 0 } } });
  const foreignCap = hubUpgradeChecklist(snap, 'SJU', 0).checks.find(c => c.id === 'foreignCap');
  assert.equal(foreignCap, undefined, 'a domestic territory should not be capped as foreign');
});

test('intl destinations are counted against the sovereign state', () => {
  const routes = [{ origin: 'SJU', destination: 'MIA', stops: ['SJU', 'MIA'], weeklyFrequency: 7 }];
  assert.equal(intlDestinationsFrom(routes, 'SJU'), 0, 'SJU–MIA is a domestic US flight');
  const intl = [{ origin: 'SJU', destination: 'LHR', stops: ['SJU', 'LHR'], weeklyFrequency: 7 }];
  assert.equal(intlDestinationsFrom(intl, 'SJU'), 1);
});

console.log('\n── Registrations ────────────────────────────────────────');

const TYPE = AIRCRAFT_TYPES.find(t => !t.freighter && (t.range ?? 0) > 2000);
const tailFor = (hub) => {
  const started = gameReducer({ ...freshState(), phase: 'setup' },
    { type: 'START_GAME', airlineName: 'Island Air', hub });
  const leased = gameReducer({ ...started, cash: 500_000_000 },
    { type: 'LEASE_AIRCRAFT', typeId: TYPE.id });
  return (leased.fleet ?? [])[0]?.tailNumber ?? '';
};

test('a San Juan airline is N-registered, a Papeete one is not', () => {
  const sju = tailFor('SJU');
  assert.ok(sju.startsWith('N'), `SJU tail ${sju} should be N-registered`);
  if (getAirport('PPT')) {
    const ppt = tailFor('PPT');
    assert.ok(ppt.startsWith('F-'), `PPT tail ${ppt} should carry the French prefix, not the 'N' fallback`);
  }
});

console.log('\n── What deliberately did NOT change ─────────────────────');

test('the airport table still files territories under their own code', () => {
  assert.equal(getAirport('SJU').country, 'PR');
  const ppt = getAirport('PPT');
  if (ppt) assert.equal(ppt.country, 'PF');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
