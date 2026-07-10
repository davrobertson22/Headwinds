// Tests for labor relations: union unrest, strikes, and contract negotiations.
//
// Part 1 exercises the pure helpers in src/data/laborRelations.js directly.
// Part 2 transpiles GameContext.jsx (same harness as reducer-tag-test.mjs) and
// drives the reducer through RESOLVE_NEGOTIATION / SETTLE_STRIKE / ADVANCE_WEEK.
//
//   node tools/labor-relations-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_LABOR_RELATIONS, STRIKE_SEVERITY, UNREST_STRIKE_THRESHOLD,
  tickUnrest, strikeProbability, rollStrike, settlementPayMultiplier,
  scheduleFirstNegotiations, scheduleNextNegotiation, negotiationDemand,
  counterOfferMultiplier, counterAccepted, NEGOTIATION_EFFECTS,
  NEGOTIATION_RESPONSE_WEEKS,
} from '../src/data/laborRelations.js';
import { LABOR_GROUPS } from '../src/data/labor.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

// ─── Part 1: pure helpers ─────────────────────────────────────────────────────

console.log('\n── laborRelations helpers ───────────────────────────────');

const laborAt = (morale) => Object.fromEntries(
  LABOR_GROUPS.map(g => [g.id, { payMultiplier: 1.0, morale }]));

test('unrest builds while morale < 50 and decays at ≥ 50', () => {
  const low  = tickUnrest(laborAt(30), { pilots: 0, cabinCrew: 0, groundStaff: 0, maintenanceTeam: 0 });
  assert.ok(low.pilots > 0, 'unrest builds at morale 30');
  const high = tickUnrest(laborAt(80), { pilots: 40, cabinCrew: 40, groundStaff: 40, maintenanceTeam: 40 });
  assert.ok(high.pilots < 40, 'unrest decays at morale 80');
  const floor = tickUnrest(laborAt(80), { pilots: 0, cabinCrew: 0, groundStaff: 0, maintenanceTeam: 0 });
  assert.equal(floor.pilots, 0, 'unrest never goes negative');
});

test('unrest is clamped to 100 and builds faster the lower morale is', () => {
  const u1 = tickUnrest(laborAt(40), { pilots: 0 }).pilots;
  const u2 = tickUnrest(laborAt(10), { pilots: 0 }).pilots;
  assert.ok(u2 > u1, 'deeper morale deficit → faster build');
  const cap = tickUnrest(laborAt(5), { pilots: 99 }).pilots;
  assert.ok(cap <= 100, 'clamped to 100');
});

test('strike probability is 0 below threshold, positive above', () => {
  assert.equal(strikeProbability(UNREST_STRIKE_THRESHOLD - 1), 0);
  assert.ok(strikeProbability(UNREST_STRIKE_THRESHOLD) > 0);
  assert.ok(strikeProbability(100) > strikeProbability(70));
  assert.ok(strikeProbability(100) < 1, 'never certain');
});

test('rollStrike picks the angriest group and respects cooldown', () => {
  const unrest = { pilots: 70, cabinCrew: 90, groundStaff: 0, maintenanceTeam: 0 };
  const s = rollStrike(unrest, 100, 0, () => 0);   // rng 0 → always strikes, 1 week
  assert.equal(s.group, 'cabinCrew', 'angriest group walks');
  assert.equal(s.severity, STRIKE_SEVERITY.cabinCrew);
  assert.ok(s.weeksLeft >= 1 && s.weeksLeft <= 2);
  assert.equal(rollStrike(unrest, 100, 120, () => 0), null, 'cooldown blocks strikes');
  assert.equal(rollStrike({ pilots: 10 }, 100, 0, () => 0), null, 'calm unions never strike');
});

test('settlement raise is +15% rounded to slider steps, capped at 2.0', () => {
  assert.equal(settlementPayMultiplier(1.0), 1.15);
  assert.ok(settlementPayMultiplier(1.9) <= 2.0);
  const v = settlementPayMultiplier(1.0);
  assert.ok(Math.abs(v * 20 - Math.round(v * 20)) < 1e-9, 'multiple of 0.05');
});

test('negotiation demand always exceeds current pay, ≤ 2.0, in 0.05 steps', () => {
  for (const pay of [0.5, 0.8, 1.0, 1.3, 1.95, 2.0]) {
    for (let i = 0; i < 50; i++) {
      const d = negotiationDemand(pay, i % 2 === 0);
      assert.ok(d > pay || pay >= 2.0, `demand ${d} > pay ${pay}`);
      assert.ok(d <= 2.0, 'capped at slider max');
      assert.ok(Math.abs(d * 20 - Math.round(d * 20)) < 1e-9, '0.05 steps');
    }
  }
});

test('below-market pay draws a demand back toward market rate', () => {
  const d = negotiationDemand(0.6, false, () => 0.5);
  assert.ok(d >= 0.75 && d <= 1.05, `cut-rate pay → demand ~market, got ${d}`);
});

test('counter-offer is the midpoint in slider steps; acceptance scales with morale', () => {
  assert.equal(counterOfferMultiplier(1.0, 1.2), 1.1);
  assert.equal(counterAccepted(100, () => 0.84), true);
  assert.equal(counterAccepted(0,  () => 0.26), false);
});

test('negotiation schedules stagger and soured talks return sooner', () => {
  const first = scheduleFirstNegotiations(0, () => 0.5);
  for (const g of LABOR_GROUPS) assert.ok(first[g.id] >= 65 && first[g.id] <= 130);
  const clean  = scheduleNextNegotiation(0, false, () => 0.5);
  const soured = scheduleNextNegotiation(0, true,  () => 0.5);
  assert.ok(soured < clean, 'soured talks come back sooner');
});

// ─── Part 2: reducer integration ──────────────────────────────────────────────

const SRC = 'src/store/GameContext.jsx';
const SRC_DIR = path.resolve(path.dirname(SRC));
const TMP = path.join(os.tmpdir(), `gc_labor_transpiled_${process.pid}.mjs`);

const stripJsx = ({ types: t }) => ({
  visitor: {
    JSXElement(p)  { p.replaceWith(t.nullLiteral()); },
    JSXFragment(p) { p.replaceWith(t.nullLiteral()); },
  },
});
const reqFromSrc = createRequire(path.join(SRC_DIR, '_noop.js'));
const resolveSpec = (spec) => {
  if (spec.startsWith('.')) return pathToFileURL(path.resolve(SRC_DIR, spec)).href;
  try { return pathToFileURL(reqFromSrc.resolve(spec)).href; } catch { return spec; }
};
const absolutizeImports = (code) =>
  code.replace(/(from\s+|import\s*\(\s*)(['"])([^'"]+)\2/g,
    (_m, lead, q, spec) => `${lead}${q}${resolveSpec(spec)}${q}`);

const out = babel.transformFileSync(SRC, {
  babelrc: false, configFile: false,
  parserOpts: { plugins: ['jsx'] },
  plugins: [stripJsx],
});
fs.writeFileSync(TMP, absolutizeImports(out.code));

try {
  const mod = await import(pathToFileURL(path.resolve(TMP)).href);
  const { gameReducer: reducer, freshState, reconcileState } = mod;

  console.log('\n── RESOLVE_NEGOTIATION reducer ──────────────────────────');

  const negoState = (over = {}) => ({
    ...freshState(),
    phase: 'playing',
    laborRelations: {
      ...DEFAULT_LABOR_RELATIONS,
      negotiation: { group: 'pilots', demandMultiplier: 1.2, weeksLeft: 4, totalWeeks: 4 },
      nextNegotiationAbsWeek: { pilots: 999, cabinCrew: 999, groundStaff: 999, maintenanceTeam: 999 },
    },
    ...over,
  });

  test('accept: pay jumps to demand, morale rises, unrest drops, talks close', () => {
    const s = reducer(negoState(), { type: 'RESOLVE_NEGOTIATION', response: 'accept' });
    assert.equal(s.labor.pilots.payMultiplier, 1.2);
    assert.equal(s.labor.pilots.morale, 80 + NEGOTIATION_EFFECTS.accept.morale);
    assert.equal(s.laborRelations.negotiation, null);
    assert.equal(s.laborRelations.unrest.pilots, 0, 'unrest floored at 0');
    assert.ok(s.laborRelations.nextNegotiationAbsWeek.pilots > 52, 'next talks scheduled');
    assert.equal(s.laborRelations.lastOutcome.outcome, 'accepted');
  });

  test('counter: pay set to midpoint whatever the union decides', () => {
    const s = reducer(negoState(), { type: 'RESOLVE_NEGOTIATION', response: 'counter' });
    assert.equal(s.labor.pilots.payMultiplier, 1.1, 'midpoint of 1.0 and 1.2');
    assert.equal(s.laborRelations.negotiation, null);
    assert.ok(['counterAccepted', 'counterRejected'].includes(s.laborRelations.lastOutcome.outcome));
  });

  test('refuse: no raise, morale −10, unrest +30', () => {
    const s = reducer(negoState(), { type: 'RESOLVE_NEGOTIATION', response: 'refuse' });
    assert.equal(s.labor.pilots.payMultiplier, 1.0);
    assert.equal(s.labor.pilots.morale, 70);
    assert.equal(s.laborRelations.unrest.pilots, 30);
    assert.equal(s.laborRelations.lastOutcome.outcome, 'refused');
  });

  test('no open negotiation → action is a no-op', () => {
    const s0 = { ...negoState(), laborRelations: DEFAULT_LABOR_RELATIONS };
    assert.equal(reducer(s0, { type: 'RESOLVE_NEGOTIATION', response: 'accept' }), s0);
  });

  console.log('\n── SETTLE_STRIKE reducer ────────────────────────────────');

  const strikeState = () => ({
    ...freshState(),
    phase: 'playing',
    laborRelations: {
      ...DEFAAULT_OR_STRIKE(),
    },
  });
  function DEFAAULT_OR_STRIKE() {
    return {
      ...DEFAULT_LABOR_RELATIONS,
      strike: { group: 'pilots', weeksLeft: 2, totalWeeks: 2, severity: STRIKE_SEVERITY.pilots },
      unrest: { ...DEFAULT_LABOR_RELATIONS.unrest, pilots: 80 },
    };
  }

  test('settling ends the strike with a 15% raise and a truce', () => {
    const s = reducer(strikeState(), { type: 'SETTLE_STRIKE' });
    assert.equal(s.laborRelations.strike, null);
    assert.equal(s.labor.pilots.payMultiplier, 1.15);
    assert.equal(s.labor.pilots.morale, 90);
    assert.equal(s.laborRelations.unrest.pilots, 15);
    assert.ok(s.laborRelations.strikeCooldownUntilAbsWeek > 1);
  });

  test('no active strike → SETTLE_STRIKE is a no-op', () => {
    const s0 = { ...strikeState(), laborRelations: DEFAULT_LABOR_RELATIONS };
    assert.equal(reducer(s0, { type: 'SETTLE_STRIKE' }), s0);
  });

  console.log('\n── ADVANCE_WEEK integration ─────────────────────────────');

  const playState = (over = {}) => ({
    ...freshState(),
    phase: 'playing', cash: 50_000_000, hub: 'JFK',
    ...over,
  });

  test('active strike costs revenue and ticks down', () => {
    // Crisis-level pay so we can also confirm unrest builds the same week.
    const labor = Object.fromEntries(LABOR_GROUPS.map(g =>
      [g.id, { payMultiplier: 0.5, morale: 20 }]));
    const s0 = playState({
      labor,
      laborRelations: {
        ...DEFAULT_LABOR_RELATIONS,
        strike: { group: 'pilots', weeksLeft: 2, totalWeeks: 2, severity: 0.55 },
        nextNegotiationAbsWeek: { pilots: 9999, cabinCrew: 9999, groundStaff: 9999, maintenanceTeam: 9999 },
      },
    });
    const s1 = reducer(s0, { type: 'ADVANCE_WEEK' });
    assert.equal(s1.laborRelations.strike.weeksLeft, 1, 'strike ticked down');
    assert.ok(s1.laborRelations.unrest.pilots > 0, 'unrest builds at crisis morale');
    const h = s1.financialHistory.at(-1);
    assert.ok(h.strikeLoss >= 0, 'strikeLoss recorded (0 with no routes)');
    assert.equal(s1.lastReport.strikeLoss, h.strikeLoss);
  });

  test('strike ends after its final week and starts a cooldown', () => {
    const s0 = playState({
      laborRelations: {
        ...DEFAULT_LABOR_RELATIONS,
        strike: { group: 'cabinCrew', weeksLeft: 1, totalWeeks: 1, severity: 0.3 },
        nextNegotiationAbsWeek: { pilots: 9999, cabinCrew: 9999, groundStaff: 9999, maintenanceTeam: 9999 },
      },
    });
    const s1 = reducer(s0, { type: 'ADVANCE_WEEK' });
    assert.equal(s1.laborRelations.strike, null, 'strike over');
    assert.ok(s1.laborRelations.strikeCooldownUntilAbsWeek > 1, 'truce started');
    assert.equal(s1.laborRelations.unrest.cabinCrew, 20, 'unrest reset');
    assert.ok(s1.pendingToasts.some(t => (t.title ?? '').includes('Strike over')), 'end-of-strike toast');
  });

  test('a due negotiation opens with a demand above current pay', () => {
    const s0 = playState({
      week: 10, year: 2,
      laborRelations: {
        ...DEFAULT_LABOR_RELATIONS,
        nextNegotiationAbsWeek: { pilots: 1, cabinCrew: 9999, groundStaff: 9999, maintenanceTeam: 9999 },
      },
    });
    const s1 = reducer(s0, { type: 'ADVANCE_WEEK' });
    const nego = s1.laborRelations.negotiation;
    assert.ok(nego, 'negotiation opened');
    assert.equal(nego.group, 'pilots');
    assert.ok(nego.demandMultiplier > 1.0);
    assert.equal(nego.weeksLeft, NEGOTIATION_RESPONSE_WEEKS);
    assert.ok(s1.pendingToasts.some(t => (t.title ?? '').includes('Contract talks')), 'talks toast');
  });

  test('an ignored negotiation lapses into a refusal (morale hit + unrest)', () => {
    let s = playState({
      laborRelations: {
        ...DEFAULT_LABOR_RELATIONS,
        negotiation: { group: 'groundStaff', demandMultiplier: 1.15, weeksLeft: 1, totalWeeks: 4 },
        nextNegotiationAbsWeek: { pilots: 9999, cabinCrew: 9999, groundStaff: 9999, maintenanceTeam: 9999 },
      },
    });
    const moraleBefore = s.labor.groundStaff.morale;
    s = reducer(s, { type: 'ADVANCE_WEEK' });
    assert.equal(s.laborRelations.negotiation, null, 'demand lapsed');
    assert.ok(s.labor.groundStaff.morale < moraleBefore, 'morale dropped');
    assert.ok(s.laborRelations.unrest.groundStaff >= 25, 'unrest spiked');
    assert.ok(s.laborRelations.nextNegotiationAbsWeek.groundStaff < 9999, 'union re-tables sooner');
  });

  test('old saves get first negotiations scheduled on the next tick', () => {
    const s0 = playState();
    delete s0.laborRelations;             // simulate a pre-feature save
    const s1 = reducer(s0, { type: 'ADVANCE_WEEK' });
    const sched = s1.laborRelations.nextNegotiationAbsWeek;
    for (const g of LABOR_GROUPS) {
      assert.ok(sched[g.id] >= 65, `${g.id} first talks scheduled`);
    }
    assert.equal(s1.laborRelations.strike, null);
  });

  test('reconcileState fills laborRelations on old saves', () => {
    const rc = reconcileState({ ...freshState(), laborRelations: undefined });
    assert.deepEqual(rc.laborRelations, DEFAULT_LABOR_RELATIONS);
    const rc2 = reconcileState({
      ...freshState(),
      laborRelations: { unrest: { pilots: 33 } },
    });
    assert.equal(rc2.laborRelations.unrest.pilots, 33, 'existing unrest preserved');
    assert.equal(rc2.laborRelations.unrest.cabinCrew, 0, 'missing groups defaulted');
  });

  test('unrest at strike threshold eventually triggers a walkout (probabilistic)', () => {
    // Run many independent weeks from the same angry state; expect ≥1 strike.
    const angryLabor = Object.fromEntries(LABOR_GROUPS.map(g =>
      [g.id, { payMultiplier: 0.5, morale: 10 }]));
    const s0 = playState({
      labor: angryLabor,
      laborRelations: {
        ...DEFAULT_LABOR_RELATIONS,
        unrest: { pilots: 95, cabinCrew: 0, groundStaff: 0, maintenanceTeam: 0 },
        nextNegotiationAbsWeek: { pilots: 9999, cabinCrew: 9999, groundStaff: 9999, maintenanceTeam: 9999 },
      },
    });
    let struck = false;
    for (let i = 0; i < 40 && !struck; i++) {
      const s1 = reducer(s0, { type: 'ADVANCE_WEEK' });
      if (s1.laborRelations.strike) {
        struck = true;
        assert.equal(s1.laborRelations.strike.group, 'pilots');
      }
    }
    assert.ok(struck, 'a strike fired within 40 independent rolls at 95 unrest');
  });
} finally {
  try { fs.unlinkSync(TMP); } catch (_) { /* ignore */ }
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
