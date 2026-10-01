// Staff pay no longer ratchets to the 2.0× cap, and leavers can be rehired
// automatically.
//
// Discord 2026-09-30 (VodkaOnFire): "I started a game in 1955 and went up to
// around 1980. The staff costs went to 2x ... now they've gone to 2x again and
// don't reset, so I lose 1-3 staff every week on maximum wages with no way to
// mitigate except to keep rehiring."
//
//   1. a premium over market erodes (~6%/yr) — 1.0× is today's market rate
//   2. it never erodes below 1.0×, and under-market pay is untouched
//   3. a 30-year run of accepted union demands settles well below the cap
//   4. "replace leavers automatically" keeps the line staffed, at normal cost
//   5. it never hires past what the fleet needs; off means off
//
//   node --import ./tools/_register-loader.mjs tools/labor-market-catchup-test.mjs
import assert from 'node:assert/strict';
import {
  erodePayPremium, PAY_MARKET_CATCHUP_PER_YEAR, DEFAULT_LABOR_STATE, LABOR_GROUPS,
  seedCrewFor, crewRequired, crewAvailable, crewInTraining,
} from '../packages/engine/src/data/labor.js';
import { negotiationDemand } from '../packages/engine/src/data/laborRelations.js';

Math.random = () => 0.5;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

t('a premium erodes ~6% a year', () => {
  const after = erodePayPremium(2.0, 52);
  assert.ok(Math.abs(after - 2.0 * (1 - PAY_MARKET_CATCHUP_PER_YEAR)) < 0.01, `2.0× after a year: ${after}`);
});

t('never below market, and under-market pay is left alone', () => {
  assert.equal(erodePayPremium(1.0, 520), 1.0);
  assert.equal(erodePayPremium(1.02, 520), 1);
  assert.equal(erodePayPremium(0.8, 52), 0.8);
});

t('thirty years of accepting every union demand stays well under the cap', () => {
  // A round every ~2.5 years, profitable airline, always accepted.
  let pay = 1.0, peak = 1.0;
  for (let wk = 1; wk <= 52 * 30; wk++) {
    pay = erodePayPremium(pay);
    if (wk % 130 === 0) pay = negotiationDemand(pay, true, () => 0.5) ?? pay;
    peak = Math.max(peak, pay);
  }
  assert.ok(peak < 1.6, `pay peaked at ${peak.toFixed(2)}× — still ratcheting`);
});

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { getAircraftType } = await import('../packages/engine/src/data/aircraft.js');
const typeOf = (a) => getAircraftType(a.typeId);
const fleet = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, typeId: 'b737800', status: 'idle', ownershipType: 'owned', ageWeeks: 20 }));
const base = (labor) => ({
  ...freshState(), phase: 'playing', week: 10, year: 1, hub: 'JFK', cash: 500_000_000,
  crewPipeline: true, fleet, routes: [], cargoRoutes: [], labor,
});
const seeded = seedCrewFor(DEFAULT_LABOR_STATE, fleet, typeOf);
const run = (s, weeks) => { for (let i = 0; i < weeks; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' }); return s; };
const staffed = (s, g) => crewAvailable(s.labor, g) + crewInTraining(s.labor, g);

t('the tick erodes a 2.0× payroll', () => {
  const s = run(base({ ...seeded, pilots: { ...seeded.pilots, payMultiplier: 2.0 } }), 4);
  assert.ok(s.labor.pilots.payMultiplier < 2.0 && s.labor.pilots.payMultiplier > 1.95);
});

t('auto-replace keeps every group staffed over a year', () => {
  let s = base(seeded);
  for (const g of LABOR_GROUPS) s = gameReducer(s, { type: 'SET_AUTO_REPLACE', group: g.id, enabled: true });
  s = run(s, 52);
  for (const g of LABOR_GROUPS) {
    const need = crewRequired(g.id, fleet, typeOf);
    assert.ok(staffed(s, g.id) >= need - 0.2, `${g.id}: ${staffed(s, g.id).toFixed(2)} of ${need.toFixed(2)} after a year`);
    assert.ok(staffed(s, g.id) <= need + 1e-6, `${g.id} over-hired`);
  }
});

t('without it the line shrinks (control)', () => {
  const s = run(base(seeded), 52);
  const g = 'cabinCrew';
  assert.ok(staffed(s, g) < crewRequired(g, fleet, typeOf) - 0.2, 'fixture attrition too small to tell');
});

t('auto-replace never hires for aircraft you no longer have', () => {
  let s = base(seedCrewFor(DEFAULT_LABOR_STATE, [...fleet, ...fleet.map(a => ({ ...a, id: a.id + 'x' }))], typeOf));
  s = gameReducer(s, { type: 'SET_AUTO_REPLACE', group: 'pilots', enabled: true });
  const before = s.cash;
  const s1 = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s1.labor.pilots.pipeline?.length ?? 0, 0, 'hired into a surplus');
  assert.ok(Number.isFinite(before));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
