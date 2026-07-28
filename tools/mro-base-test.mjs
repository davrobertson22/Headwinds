// Jet bases (MRO network) engine test — no DB, no network.
//   node tools/mro-base-test.mjs
//
// Covers: AOG repair pricing and the write-off cap, base resolution gating
// (family / network / open / slot), the efficiency ramp, alliance guest terms,
// contract offsets, the build-upgrade-close lifecycle, and the weekly tick.
import assert from 'node:assert/strict';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import * as M from '../packages/engine/src/data/maintenance.js';
import * as B from '../packages/engine/src/data/mroBase.js';
import { weeklyFamilyBaseCost, aircraftFamily, FAMILY_INFO } from '../packages/engine/src/data/families.js';
import { absoluteWeek } from '../packages/engine/src/utils/fuel.js';

const REAL_RANDOM = Math.random;
// Determinism: keep RNG high (no wear failures, no events) but VARYING — uid()
// builds ids from Math.random, and a constant stub makes two aircraft bought in
// the same millisecond collide on id. Tests that need a breakdown call
// forceFailures() to take over.
let _rng = 0;
const quietRng = () => 0.90 + ((_rng++ % 97) / 1000);
Math.random = quietRng;

const TYPE = 'crj200';
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); fail++; }
  finally { Math.random = quietRng; }
}
/** Force rollMechanicalFailures to fire on every eligible airframe. */
function forceFailures(severityIndex = 0) {
  let call = 0;
  Math.random = () => {
    // 1st call: failure roll (0 → always fails). 2nd: failure template.
    // 3rd: duration within range. Cycle repeats per aircraft.
    const i = call++ % 3;
    if (i === 0) return 0;
    if (i === 1) return severityIndex / 8 + 0.001;
    return 0;
  };
}

function newGame() {
  return gameReducer(freshState(), { type: 'START_GAME', airlineName: 'MX', hub: 'JFK', enableObjectives: false });
}
function withJet(s) {
  const before = s.fleet.length;
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: TYPE });
  if (s.fleet.length === before) throw new Error('buy failed, cash=' + s.cash);
  const acId = s.fleet[s.fleet.length - 1].id;
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'ORD' });
  s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: acId, origin: 'JFK', destination: 'ORD', weeklyFrequency: 7 });
  if (s.routes.length === 0) throw new Error('route did not attach');
  return { s, acId };
}
/** Give the airline enough gates at `code` to host a base at `level`. */
function withGates(s, code, level) {
  const need = B.mroLevelDef(level).gatesRequired;
  for (let i = (s.gates?.[code] ?? 0); i < need; i++) {
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: code });
  }
  return s;
}
const find = (s, id) => s.fleet.find(a => a.id === id);
const FAM = aircraftFamily(TYPE);

// ── AOG repair pricing ───────────────────────────────────────────────────────

t('AOG cost scales with severity', () => {
  const type = getAircraftType(TYPE);
  const a = { id: 'x', ageWeeks: 0, ownershipType: 'owned' };
  const minor  = M.aogRepairCost(a, type, 'minor').cost;
  const major  = M.aogRepairCost(a, type, 'major').cost;
  const severe = M.aogRepairCost(a, type, 'severe').cost;
  assert.ok(minor > 0, 'a breakdown is no longer free');
  assert.ok(major > minor && severe > major, 'severity ladder holds');
  assert.equal(major, Math.round(type.purchasePrice * M.AOG_COST_PCT.major), 'new airframe pays the base rate');
});

t('AOG cost climbs steeply with airframe age', () => {
  const type = getAircraftType(TYPE);
  const young = M.aogRepairCost({ id: 'y', ageWeeks: 0, ownershipType: 'owned' }, type, 'major').cost;
  const old   = M.aogRepairCost({ id: 'o', ageWeeks: 20 * 52, ownershipType: 'owned' }, type, 'major').cost;
  assert.ok(old > young * 2.5, `20-year airframe costs far more to fix (${young} → ${old})`);
  assert.equal(M.aogAgeFactor({ ageWeeks: 20 * 52 }), 3, '20 years = 3x');
});

t('a jet base discounts the repair bill', () => {
  const type = getAircraftType(TYPE);
  const a = { id: 'x', ageWeeks: 5 * 52, ownershipType: 'owned' };
  const full = M.aogRepairCost(a, type, 'major').cost;
  const at3  = M.aogRepairCost(a, type, 'major', { baseFactor: B.MRO_LEVELS[3].aogCostMult }).cost;
  assert.ok(at3 < full, 'base is cheaper');
  assert.equal(at3, Math.round(full * B.MRO_LEVELS[3].aogCostMult), 'exactly the level-3 multiplier');
});

t('repair bill larger than the airframe becomes a write-off', () => {
  const type = getAircraftType(TYPE);
  const wreck = { id: 'w', ageWeeks: 32 * 52, ownershipType: 'owned' };
  const r = M.aogRepairCost(wreck, type, 'severe');
  assert.equal(r.writeOff, true, 'written off');
  assert.equal(r.cost, 0, 'no repair is paid for');
  assert.ok(r.payout > 0, 'hull insurance pays out on owned metal');
  assert.ok(r.payout < r.nav, 'payout is below NAV, so writing off is never better than selling');
});

t('a leased write-off pays the operator nothing', () => {
  const type = getAircraftType(TYPE);
  const r = M.aogRepairCost({ id: 'l', ageWeeks: 32 * 52, ownershipType: 'lease' }, type, 'severe');
  assert.equal(r.writeOff, true);
  assert.equal(r.payout, 0, 'the lessor insures its own metal');
});

t('a young airframe is never written off', () => {
  const type = getAircraftType(TYPE);
  for (const sev of ['minor', 'major', 'severe']) {
    const r = M.aogRepairCost({ id: 'n', ageWeeks: 3 * 52, ownershipType: 'owned' }, type, sev);
    assert.equal(r.writeOff, false, sev + ' on a 3-year airframe is repairable');
  }
});

// ── Base resolution ──────────────────────────────────────────────────────────

const openBase = (code, level, families, openedWeek = 0) => ({
  code, level, families, openedWeek, buildWeeksLeft: 0, partsPool: 1.0,
});

t('resolveBaseFor needs family, network AND an open base', () => {
  const ac = { id: 'a1', typeId: TYPE };
  const routes = [{ aircraftId: 'a1', origin: 'JFK', destination: 'ORD' }];
  const good = { ORD: openBase('ORD', 2, [FAM]) };
  assert.ok(B.resolveBaseFor(ac, good, routes, [], 100), 'qualifies');

  const wrongFamily = { ORD: openBase('ORD', 2, ['airbus_a380']) };
  assert.equal(B.resolveBaseFor(ac, wrongFamily, routes, [], 100), null, 'wrong certification');

  const offNetwork = { LAX: openBase('LAX', 2, [FAM]) };
  assert.equal(B.resolveBaseFor(ac, offNetwork, routes, [], 100), null, 'not on the network');

  const building = { ORD: { ...openBase('ORD', 2, [FAM]), buildWeeksLeft: 3 } };
  assert.equal(B.resolveBaseFor(ac, building, routes, [], 100), null, 'still under construction');
});

t('the highest-level base on the network wins', () => {
  const ac = { id: 'a1', typeId: TYPE };
  const routes = [{ aircraftId: 'a1', origin: 'JFK', destination: 'ORD' }];
  const bases = { JFK: openBase('JFK', 1, [FAM]), ORD: openBase('ORD', 3, [FAM]) };
  assert.equal(B.resolveBaseFor(ac, bases, routes, [], 100).code, 'ORD');
});

t('a multi-stop leg counts every stop as network', () => {
  const ac = { id: 'a1', typeId: TYPE };
  const routes = [{ aircraftId: 'a1', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'DEN', 'LAX'] }];
  const bases = { DEN: openBase('DEN', 2, [FAM]) };
  assert.equal(B.resolveBaseFor(ac, bases, routes, [], 100).code, 'DEN', 'an intermediate stop qualifies');
});

t('a stationed reserve is covered by the base it sits at', () => {
  const ac = { id: 'a1', typeId: TYPE, reserveBase: 'ORD' };
  const bases = { ORD: openBase('ORD', 2, [FAM]) };
  assert.equal(B.resolveBaseFor(ac, bases, [], [], 100).code, 'ORD', 'flies nothing but is still based there');
});

// ── Efficiency ramp ──────────────────────────────────────────────────────────

t('a new base opens below full effectiveness and ramps up', () => {
  const base = openBase('ORD', 3, [FAM], 100);
  assert.equal(B.baseEfficiency(base, 100), B.MRO_RAMP_FLOOR, 'opens at the floor');
  assert.equal(B.baseEfficiency(base, 100 + B.MRO_RAMP_WEEKS), 1, 'fully ramped after the window');
  const mid = B.baseEfficiency(base, 100 + B.MRO_RAMP_WEEKS / 2);
  assert.ok(mid > B.MRO_RAMP_FLOOR && mid < 1, 'monotonic in between');
});

t('a half-ramped base delivers a weaker discount than a mature one', () => {
  const fresh  = B.mroFactorsFor({ def: B.MRO_LEVELS[3], eff: B.MRO_RAMP_FLOOR, code: 'ORD', level: 3 });
  const mature = B.mroFactorsFor({ def: B.MRO_LEVELS[3], eff: 1, code: 'ORD', level: 3 });
  assert.ok(fresh.dCostMult > mature.dCostMult, 'new base discounts less');
  assert.equal(mature.dCostMult, B.MRO_LEVELS[3].dCostMult, 'mature base delivers the full rate');
});

t('a base with no benefit for a check type leaves it at full price', () => {
  const l1 = B.mroFactorsFor({ def: B.MRO_LEVELS[1], eff: 1, code: 'JFK', level: 1 });
  assert.equal(l1.cCostMult, 1, 'a line station cannot do C checks');
  assert.equal(l1.dCostMult, 1, 'nor D checks');
  assert.ok(l1.aogCostMult < 1, 'but it does cover AOG');
});

// ── Alliance guests ──────────────────────────────────────────────────────────

t('an alliance guest gets half the discount and no ownership benefits', () => {
  const owner = B.mroFactorsFor({ def: B.MRO_LEVELS[3], eff: 1, code: 'ORD', level: 3 });
  const guest = B.mroFactorsFor({ def: B.MRO_LEVELS[3], eff: 1, code: 'ORD', level: 3 }, { guest: true });
  const ownerSaving = 1 - owner.dCostMult;
  const guestSaving = 1 - guest.dCostMult;
  assert.ok(Math.abs(guestSaving - ownerSaving * B.ALLIANCE_GUEST_DISCOUNT_FRACTION) < 1e-9, 'exactly half the saving');
  assert.equal(guest.lineFactor, 1, 'guests get no line-maintenance discount');
  assert.equal(guest.contractOffset, 0, 'guests get no contract offset');
  assert.ok(guest.dWeeksSaved <= B.ALLIANCE_GUEST_WEEKS_SAVED, 'guest downtime saving is capped');
});

t('the host fee is a fixed share of the undiscounted job', () => {
  assert.equal(B.allianceHostFee(1_000_000), Math.round(1_000_000 * B.ALLIANCE_HOST_FEE_PCT));
  assert.equal(B.allianceHostFee(0), 0);
  assert.equal(B.allianceHostFee(-5), 0, 'never negative');
});

t('hosting is worth it for the guest but not free money', () => {
  const undiscounted = 1_000_000;
  const guest = B.mroFactorsFor({ def: B.MRO_LEVELS[2], eff: 1, code: 'ORD', level: 2 }, { guest: true });
  const paid = Math.round(undiscounted * guest.cCostMult) + B.allianceHostFee(undiscounted);
  assert.ok(paid < undiscounted * 1.02, 'guest is not worse off in cash terms');
  assert.ok(paid > undiscounted * 0.90, 'and the fee eats most of the discount');
});

// ── Slots ────────────────────────────────────────────────────────────────────

t('shop slots run out and overflow work loses the discount', () => {
  const bases = { ORD: openBase('ORD', 1, [FAM]) };   // level 1 = 2 slots
  const ledger = B.newSlotLedger(bases);
  assert.equal(ledger.ORD, B.MRO_LEVELS[1].slots);
  assert.equal(B.claimSlot(ledger, 'ORD'), true);
  assert.equal(B.claimSlot(ledger, 'ORD'), true);
  assert.equal(B.claimSlot(ledger, 'ORD'), false, 'third job overflows');
  assert.equal(B.hasSlot(ledger, 'ORD'), false);
  B.releaseSlot(ledger, 'ORD');
  assert.equal(B.hasSlot(ledger, 'ORD'), true, 'an unpaid job hands its slot back');
});

t('a base still under construction offers no slots', () => {
  const ledger = B.newSlotLedger({ ORD: { ...openBase('ORD', 3, [FAM]), buildWeeksLeft: 5 } });
  assert.equal(ledger.ORD, 0);
});

// ── Contract offsets ─────────────────────────────────────────────────────────

t('a certified base offsets most of the outsourced family contract', () => {
  const fleet = [{ id: 'a', typeId: TYPE }];
  const gross = weeklyFamilyBaseCost(fleet);
  assert.ok(gross > 0, 'the family bill exists');
  const offsets = B.familyContractOffsets({ ORD: openBase('ORD', 3, [FAM], 0) }, 1000);
  const net = weeklyFamilyBaseCost(fleet, offsets);
  assert.ok(net < gross, 'the bill falls');
  assert.equal(net, Math.round(gross * (1 - B.MRO_LEVELS[3].contractOffset)), 'by exactly the level-3 offset');
});

t('an uncertified family keeps paying full contract', () => {
  const fleet = [{ id: 'a', typeId: TYPE }];
  const offsets = B.familyContractOffsets({ ORD: openBase('ORD', 3, ['airbus_a380'], 0) }, 1000);
  assert.equal(weeklyFamilyBaseCost(fleet, offsets), weeklyFamilyBaseCost(fleet));
});

t('contract offsets ramp with the base', () => {
  const fresh = B.familyContractOffsets({ ORD: openBase('ORD', 2, [FAM], 500) }, 500);
  const ripe  = B.familyContractOffsets({ ORD: openBase('ORD', 2, [FAM], 500) }, 500 + B.MRO_RAMP_WEEKS);
  assert.ok(ripe[FAM] > fresh[FAM], 'a mature base offsets more');
});

// ── Parts pool ───────────────────────────────────────────────────────────────

t('a deeper parts pool shortens AOG downtime and costs more', () => {
  assert.ok(B.partsPoolDurationMult(2.0) < B.partsPoolDurationMult(1.0), 'deep pool is faster');
  assert.ok(B.partsPoolDurationMult(0.5) > B.partsPoolDurationMult(1.0), 'thin pool is slower');
  const lean = B.partsPoolCost({ ...openBase('ORD', 3, [FAM]), partsPool: 0.5 });
  const deep = B.partsPoolCost({ ...openBase('ORD', 3, [FAM]), partsPool: 2.0 });
  assert.ok(deep > lean, 'and it ties up more cash');
});

t('the parts pool is clamped to its legal band', () => {
  assert.equal(B.clampPartsPool(99), B.PARTS_POOL_MAX);
  assert.equal(B.clampPartsPool(0), B.PARTS_POOL_MIN);
  assert.equal(B.clampPartsPool('nonsense'), B.PARTS_POOL_DEFAULT);
});

// ── Build lifecycle ──────────────────────────────────────────────────────────

t('building a base needs gates at the airport', () => {
  let { s } = withJet(newGame());
  const before = s.cash;
  s = gameReducer(s, { type: 'BUILD_MRO_BASE', code: 'ORD', level: 2, families: [FAM] });
  assert.equal(s.mroBases?.ORD, undefined, 'refused without the gates');
  assert.equal(s.cash, before, 'and nothing was charged');
  assert.ok(/gates/i.test(s.error ?? ''), 'the reason names gates: ' + s.error);
});

t('BUILD_MRO_BASE charges capex and starts construction', () => {
  let { s } = withJet(newGame());
  s = withGates(s, 'ORD', 1);
  const before = s.cash;
  s = gameReducer(s, { type: 'BUILD_MRO_BASE', code: 'ORD', level: 1, families: [FAM] });
  const base = s.mroBases?.ORD;
  assert.ok(base, 'base exists');
  assert.equal(before - s.cash, B.MRO_LEVELS[1].capex, 'exact capex charged');
  assert.equal(base.buildWeeksLeft, B.MRO_LEVELS[1].buildWeeks, 'construction pending');
  assert.equal(B.isBaseOpen(base), false, 'not yet working');
  assert.deepEqual(base.families, [FAM]);
});

t('construction counts down and the base opens', () => {
  let { s } = withJet(newGame());
  s = withGates(s, 'ORD', 1);
  s = gameReducer(s, { type: 'BUILD_MRO_BASE', code: 'ORD', level: 1, families: [FAM] });
  for (let i = 0; i < B.MRO_LEVELS[1].buildWeeks; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const base = s.mroBases.ORD;
  assert.equal(base.buildWeeksLeft, 0, 'finished');
  assert.equal(B.isBaseOpen(base), true, 'open for business');
  assert.equal(base.openedWeek, absoluteWeek(s.year, s.week) - 1, 'stamped the week it opened');
});

t('an upgrade builds in place — the old level keeps working', () => {
  let { s } = withJet(newGame());
  s = withGates(s, 'ORD', 2);
  s = { ...s, cash: 500_000_000 };
  s = gameReducer(s, { type: 'BUILD_MRO_BASE', code: 'ORD', level: 1, families: [FAM] });
  for (let i = 0; i < B.MRO_LEVELS[1].buildWeeks; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const cashBefore = s.cash;
  s = gameReducer(s, { type: 'UPGRADE_MRO_BASE', code: 'ORD', level: 2 });
  assert.equal(cashBefore - s.cash, B.upgradeCapex(1, 2), 'upgrade capex charged');
  assert.equal(s.mroBases.ORD.level, 1, 'still operating at the old level');
  assert.equal(B.isBaseOpen(s.mroBases.ORD), true, 'never goes offline');
  assert.equal(s.mroBases.ORD.upgradeTo, 2);
  for (let i = 0; i < B.MRO_LEVELS[2].buildWeeks; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.equal(s.mroBases.ORD.level, 2, 'upgrade lands');
  assert.equal(s.mroBases.ORD.upgradeTo ?? null, null, 'and clears');
});

t('a second upgrade cannot be stacked on one in flight', () => {
  let { s } = withJet(newGame());
  s = withGates(s, 'ORD', 3);
  s = { ...s, cash: 1_000_000_000 };
  s = gameReducer(s, { type: 'BUILD_MRO_BASE', code: 'ORD', level: 1, families: [FAM] });
  for (let i = 0; i < B.MRO_LEVELS[1].buildWeeks; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  s = gameReducer(s, { type: 'UPGRADE_MRO_BASE', code: 'ORD', level: 2 });
  const cash = s.cash;
  s = gameReducer(s, { type: 'UPGRADE_MRO_BASE', code: 'ORD', level: 3 });
  assert.equal(s.cash, cash, 'nothing charged for the second attempt');
  assert.equal(s.mroBases.ORD.upgradeTo, 2, 'the first upgrade still stands');
});

t('extra certifications cost capex beyond the included allowance', () => {
  let { s } = withJet(newGame());
  s = withGates(s, 'ORD', 1);
  s = { ...s, cash: 200_000_000 };
  s = gameReducer(s, { type: 'BUILD_MRO_BASE', code: 'ORD', level: 1, families: [FAM] });
  const before = s.cash;
  s = gameReducer(s, { type: 'ADD_BASE_CERTIFICATION', code: 'ORD', familyId: 'boeing_737' });
  assert.equal(before - s.cash, B.MRO_LEVELS[1].extraCertCapex, 'charged for the extra type');
  assert.deepEqual(s.mroBases.ORD.families, [FAM, 'boeing_737']);
  const again = s.cash;
  s = gameReducer(s, { type: 'ADD_BASE_CERTIFICATION', code: 'ORD', familyId: 'boeing_737' });
  assert.equal(s.cash, again, 'certifying the same family twice is a no-op');
});

t('closing a base refunds a fraction and frees the airport', () => {
  let { s } = withJet(newGame());
  s = withGates(s, 'ORD', 1);
  s = gameReducer(s, { type: 'BUILD_MRO_BASE', code: 'ORD', level: 1, families: [FAM] });
  const base = s.mroBases.ORD;
  const before = s.cash;
  s = gameReducer(s, { type: 'CLOSE_MRO_BASE', code: 'ORD' });
  assert.equal(s.mroBases.ORD, undefined, 'gone');
  assert.equal(s.cash - before, B.closeRefund(base), 'partial refund');
  assert.ok(B.closeRefund(base) < B.MRO_LEVELS[1].capex, 'you do not get it all back');
});

t('the parts pool is settable and clamped through the reducer', () => {
  let { s } = withJet(newGame());
  s = withGates(s, 'ORD', 1);
  s = gameReducer(s, { type: 'BUILD_MRO_BASE', code: 'ORD', level: 1, families: [FAM] });
  s = gameReducer(s, { type: 'SET_BASE_PARTS_POOL', code: 'ORD', pool: 99 });
  assert.equal(s.mroBases.ORD.partsPool, B.PARTS_POOL_MAX);
});

// ── The weekly tick ──────────────────────────────────────────────────────────

t('old saves tick cleanly with no bases at all', () => {
  let { s } = withJet(newGame());
  s = { ...s, mroBases: undefined };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.deepEqual(s.mroBases, {}, 'normalised, not crashed');
});

t('a breakdown now costs money in the tick', () => {
  let { s, acId } = withJet(newGame());
  s = { ...s, fleet: s.fleet.map(a => a.id === acId ? { ...a, ageWeeks: 8 * 52 } : a) };
  forceFailures(0);
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const jobs = s.lastReport?.mro?.jobs ?? [];
  const aog = jobs.find(j => j.kind === 'aog' && j.aircraftId === acId);
  assert.ok(aog, 'the repair was booked as a job');
  assert.ok(aog.cost > 0, 'and it cost money');
  assert.equal(aog.base, null, 'no base, so it went outside');
  assert.ok((s.lastReport.mro.aogSpend ?? 0) > 0, 'reported on the P&L');
});

t('a jet base makes the same breakdown cheaper and shorter', () => {
  function run(withBase) {
    let { s, acId } = withJet(newGame());
    s = { ...s, cash: 500_000_000, fleet: s.fleet.map(a => a.id === acId ? { ...a, ageWeeks: 8 * 52 } : a) };
    if (withBase) {
      s = { ...s, mroBases: { ORD: openBase('ORD', 3, [FAM], absoluteWeek(s.year, s.week) - 200) } };
    }
    forceFailures(0);
    s = gameReducer(s, { type: 'ADVANCE_WEEK' });
    return (s.lastReport.mro.jobs ?? []).find(j => j.kind === 'aog' && j.aircraftId === acId);
  }
  const out = run(false);
  const home = run(true);
  assert.ok(home.cost < out.cost, `base is cheaper (${out.cost} → ${home.cost})`);
  assert.equal(home.base, 'ORD', 'and the job is attributed to the base');
  assert.ok(home.weeks <= out.weeks, 'and no slower');
});

t('a written-off airframe leaves the fleet and its routes close', () => {
  let { s, acId } = withJet(newGame());
  // 50 years old: even a routine engine fault now costs more than the airframe.
  s = { ...s, fleet: s.fleet.map(a => a.id === acId ? { ...a, ageWeeks: 50 * 52, ownershipType: 'owned' } : a) };
  forceFailures(0);
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const job = (s.lastReport.mro.jobs ?? []).find(j => j.kind === 'aog' && j.aircraftId === acId);
  assert.ok(job?.writeOff, 'written off: ' + JSON.stringify(job));
  assert.equal(find(s, acId), undefined, 'removed from the fleet');
  assert.equal(s.routes.filter(r => r.aircraftId === acId).length, 0, 'its routes went with it');
  assert.ok((s.lastReport.mro.aogInsurance ?? 0) > 0, 'insurance paid out');
});

t('a heavy check routed through a base is cheaper than one that is not', () => {
  function run(withBase) {
    let { s, acId } = withJet(newGame());
    s = { ...s, cash: 900_000_000 };
    if (withBase) s = { ...s, mroBases: { ORD: openBase('ORD', 3, [FAM], absoluteWeek(s.year, s.week) - 200) } };
    const cur = absoluteWeek(s.year, s.week);
    s = { ...s, fleet: s.fleet.map(a => a.id === acId
      ? { ...a, hoursSinceD: M.D_HOURS_DUE + 10, weeksSinceD: M.D_WEEKS_DUE + 1, dDueAtWeek: cur - 1,
          scheduledCheck: { type: 'D', startWeek: cur } } : a) };
    s = gameReducer(s, { type: 'ADVANCE_WEEK' });
    return (s.lastReport.mro.jobs ?? []).find(j => j.kind === 'check');
  }
  const out = run(false);
  const home = run(true);
  assert.ok(out && home, 'both checks started');
  assert.ok(home.cost < out.cost, `base is cheaper (${out.cost} → ${home.cost})`);
  assert.ok(home.weeks < out.weeks, `and shorter (${out.weeks} → ${home.weeks} weeks)`);
  assert.equal(home.base, 'ORD');
});

t('slot overflow sends the extra jobs outside at full price', () => {
  // Level 1 has 2 slots; give the base three broken aircraft to cover.
  let s = newGame();
  s = { ...s, cash: 900_000_000 };
  s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'ORD' });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: TYPE });
    const id = s.fleet[s.fleet.length - 1].id;
    ids.push(id);
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: id, origin: 'JFK', destination: 'ORD', weeklyFrequency: 7 });
  }
  s = { ...s, fleet: s.fleet.map(a => ({ ...a, ageWeeks: 8 * 52 })),
        mroBases: { ORD: openBase('ORD', 1, [FAM], absoluteWeek(s.year, s.week) - 200) } };
  forceFailures(0);
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  const aogJobs = (s.lastReport.mro.jobs ?? []).filter(j => j.kind === 'aog');
  assert.equal(aogJobs.length, 3, 'all three broke');
  const covered = aogJobs.filter(j => j.base === 'ORD');
  assert.equal(covered.length, B.MRO_LEVELS[1].slots, 'only as many as there are slots');
  const overflow = aogJobs.find(j => j.base === null);
  assert.ok(overflow.cost > covered[0].cost, 'overflow pays full price');
});

t('base running costs land on the P&L', () => {
  let { s } = withJet(newGame());
  s = { ...s, cash: 900_000_000,
        mroBases: { ORD: openBase('ORD', 2, [FAM], absoluteWeek(s.year, s.week) - 200) } };
  s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  assert.ok((s.lastReport.mro.baseCosts ?? 0) >= B.MRO_LEVELS[2].weeklyOpex, 'opex is charged');
  assert.ok((s.lastReport.mro.contractSavings ?? 0) > 0, 'and the contract offset is credited back');
});

console.log(fail ? ('\n' + fail + ' FAILED, ' + pass + ' passed') : ('\nALL PASS (' + pass + ')'));
Math.random = REAL_RANDOM;
process.exit(fail ? 1 : 0);
