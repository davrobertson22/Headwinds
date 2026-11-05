// Hub banks — hub-bank worlds (state.hubBanksWorld), models/schedule.js.
//
// Designated hubs run on banks (waves of arrivals, then departures). The
// automatic week aims every rotation through a banked hub at a wave, and the
// network tick counts a connection only when the timetable makes it (40 min
// to 6 h) instead of assuming every flight connects in 1.5 h. Pins: the
// settings are cleaned, worlds without the flag are untouched, a banked hub
// connects more than a rolling one, and the preview of a new route agrees
// with the tick that books it.
//
//   node tools/hub-banks-test.mjs

import assert from 'node:assert/strict';
import { getAircraftType } from '../packages/engine/src/data/aircraft.js';
import {
  airlineWeeks, aircraftWeek, hubBankPlan, bankContextOf, normalizeBankTimes, normalizeHubBankSetting,
  hubTimetable, hubTimetableOf, hubConnectivity, blockHubEvents, snapToBank, canPlace, pinsAfterMove,
  overlaps, wrapWeek, WEEK_MIN, CONNECT_MIN, CONNECT_MAX, BANK_PRESETS, scheduleInputsOf,
} from '../packages/engine/src/models/schedule.js';
import { weeklyTick, referencePrice } from '../packages/engine/src/utils/simulation.js';
import { projectRouteAddition } from '../packages/engine/src/models/pairShare.js';
import { gameReducer } from '../packages/engine/src/reducer.mjs';
import { guardDecision } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';
import { ALLOWED_PLAYER_ACTIONS } from '../apps/headwinds-server/src/world.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const jet = getAircraftType('a320neo');
const HUB = 'SYD';
const SPOKES = ['MEL', 'BNE', 'ADL', 'CBR', 'OOL', 'HBA', 'CNS', 'PER'];
const mkAc = (id) => ({ id, typeId: jet.id, name: id, tailNumber: `VH-${id}`, status: 'assigned',
  ownershipType: 'owned', ageWeeks: 40, config: { economy: jet.seats } });
const mkRoute = (id, dest, acId, f = 14) => {
  const fare = Math.round(referencePrice(HUB, dest));
  return { id, origin: HUB, destination: dest, stops: [HUB, dest], aircraftId: acId, weeklyFrequency: f,
    weeksOpen: 40, hub: HUB, ticketPrice: fare, classPrices: { economy: fare } };
};
/** A SYD hub with a tail per spoke. `over` lands on the state. */
function network(over = {}, spokes = SPOKES) {
  const fleet = [], routes = [], routePricing = {}, gates = { [HUB]: 60 };
  spokes.forEach((s, i) => {
    fleet.push(mkAc(`ac${i}`));
    routes.push(mkRoute(`r${i}`, s, `ac${i}`, s === 'PER' ? 7 : 14));
    routePricing[[HUB, s].sort().join('-')] = { economy: routes[i].ticketPrice };
    gates[s] = 10;
  });
  return {
    fleet, routes, cargoRoutes: [], routePricing, gates,
    hubs: { [HUB]: { tier: 2, tierSince: 0 } }, hub: HUB,
    competitors: [], humanRivals: {}, encroachments: {},
    gameDate: { month: 6 }, absWeek: 40, week: 40, year: 1, cash: 1e9,
    ...over,
  };
}
const banked = (over = {}) => network({ hubBanksWorld: true, ...over });
const allBlocks = (weeks) => [...weeks.values()].flatMap(w => w.blocks);
const noOverlap = (blocks) => {
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
    assert.ok(!overlaps(blocks[i].start, blocks[i].dur, blocks[j].start, blocks[j].dur), `${blocks[i].key} × ${blocks[j].key}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 1. Settings ─────────────────────────────────────────────────');

test('bank times are cleaned: 5-min steps, sorted, ≥ 90 min apart (round midnight too), ≤ 8', () => {
  assert.deepEqual(normalizeBankTimes([660, 422, 'x', 700, 1500]), [60, 420, 660]);
  assert.deepEqual(normalizeBankTimes([60, 1420]), [60]);    // 23:40 → 01:00 is only 80 min round midnight
  assert.deepEqual(normalizeBankTimes([60, 1400]), [60, 1400]);
  assert.equal(normalizeBankTimes(Array.from({ length: 20 }, (_, i) => i * 100)).length, 8);
});

test('a hub setting is Rolling, a preset count, custom times — or Automatic (null)', () => {
  assert.deepEqual(normalizeHubBankSetting({ mode: 'rolling', count: 4 }), { mode: 'rolling' });
  assert.deepEqual(normalizeHubBankSetting({ mode: 'banks', count: 4 }), { mode: 'banks', count: 4 });
  assert.equal(normalizeHubBankSetting({ mode: 'banks', count: 5 }), null);
  assert.deepEqual(normalizeHubBankSetting({ mode: 'banks', times: [600, 420] }), { mode: 'banks', times: [420, 600] });
  assert.equal(normalizeHubBankSetting({ mode: 'banks', times: ['x'] }), null);
  assert.equal(normalizeHubBankSetting('rolling'), null);
});

test('plans: only in a hub-bank world, only designated hubs; Automatic by tier', () => {
  assert.equal(hubBankPlan(network(), HUB), null, 'not a hub-bank world');
  assert.equal(hubBankPlan(banked(), 'MEL'), null, 'not a hub');
  const p = hubBankPlan(banked(), HUB);
  assert.equal(p.mode, 'auto');
  assert.deepEqual(p.times, BANK_PRESETS[4], 'a tier-2 hub runs four banks');
  assert.equal(p.utc.length, 28);
  assert.equal(hubBankPlan(banked({ hubs: { [HUB]: { tier: 3 } } }), HUB).times.length, 6);
  assert.equal(hubBankPlan(banked({ hubs: { [HUB]: { tier: 0 } } }), HUB).times.length, 3);
  assert.equal(hubBankPlan(banked({ hubBanks: { [HUB]: { mode: 'rolling' } } }), HUB).mode, 'rolling');
  assert.equal(bankContextOf(banked({ hubBanks: { [HUB]: { mode: 'rolling' } } })), null, 'nothing banked');
  // Local time: SYD is UTC+10, so the 07:00 bank is 21:00 UTC Sunday.
  assert.equal(p.utc[p.utc.length - 1] % 1440, 21 * 60);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 2. The automatic banked week ───────────────────────────────');

test('outside a hub-bank world the week is exactly the old one', () => {
  const st = network({ hubBanks: { [HUB]: { mode: 'banks', count: 6 } } });
  const weeks = airlineWeeks(st, 6);
  for (const [acId, w] of weeks) {
    const routes = st.routes.filter(r => r.aircraftId === acId);
    const old = aircraftWeek(routes, jet, acId, w.anchor != null ? undefined : undefined);
    assert.equal(w.banked, undefined);
    assert.equal(w.blocks.length, old.blocks.length);
  }
  assert.equal(hubTimetableOf(st, 6), null, 'and the tick gets no timetable');
});

test('every flight flies, nothing overlaps, and every hub arrival and departure makes a bank', () => {
  const st = banked();
  const weeks = airlineWeeks(st, 6);
  const ctx = bankContextOf(st);
  for (const [acId, w] of weeks) {
    const f = st.routes.find(r => r.aircraftId === acId).weeklyFrequency;
    assert.equal(w.banked, true);
    assert.equal(w.blocks.length, f, `${acId}: ${w.blocks.length}/${f}`);
    assert.equal(w.overflow.length, 0);
    noOverlap(w.blocks);
  }
  const ev = allBlocks(weeks).flatMap(b => blockHubEvents(b, ctx));
  const missed = ev.filter(e => !e.made);
  assert.ok(ev.length > 0);
  assert.equal(missed.length, 0, `${missed.length} of ${ev.length} hub events miss a bank`);
});

test('an aircraft waits at the far end to make the next bank, and that wait is in the block', () => {
  const w = airlineWeeks(banked(), 6).get('ac0');
  const waited = w.blocks.filter(b => b.waitMin > 0);
  assert.ok(waited.length > 0, 'some rotation waits for a bank');
  for (const b of waited) {
    assert.equal(b.dur, b.legs.reduce((s, l) => s + l.flightMin + l.turnMin, 0));
    assert.equal(b.waitMin, b.legs.reduce((s, l) => s + (l.waitMin ?? 0), 0));
  }
});

test('a pinned flight keeps the length it had: Pin all changes nothing', () => {
  const st = banked();
  const before = airlineWeeks(st, 6).get('ac0');
  const pinned = { ...st, routes: st.routes.map(r => r.id === 'r0' ? { ...r, schedule: { starts: before.blocks.map(b => b.start) } } : r) };
  const after = airlineWeeks(pinned, 6).get('ac0');
  assert.deepEqual(after.blocks.map(b => [b.start, b.dur, b.pinned]), before.blocks.map(b => [b.start, b.dur, true]));
});

test('canPlace asks the week for a rotation\'s length at the target time', () => {
  const w = airlineWeeks(banked(), 6).get('ac0');
  const b = w.blocks[0];
  for (let t = 0; t < WEEK_MIN; t += 355) {
    const dur = w.durAt('r0', t);
    assert.ok(dur >= b.dur - (b.waitMin ?? 0), 'never shorter than the bare rotation');
  }
  assert.equal(typeof canPlace(w, 'r0', 1, b.start, b), 'boolean');
});

test('Snap to bank moves an off-bank pin onto the nearest wave', () => {
  const st = banked();
  const w0 = airlineWeeks(st, 6).get('ac7');   // PER, 7×
  const ctx = bankContextOf(st);
  const off = w0.blocks[0].start + 95;         // an hour and a half late: misses the wave
  const pins = pinsAfterMove(w0, 'r7', w0.blocks[0], off);
  const st2 = { ...st, routes: st.routes.map(r => r.id === 'r7' ? { ...r, schedule: { starts: pins } } : r) };
  const w = airlineWeeks(st2, 6).get('ac7');
  const b = w.blocks.find(x => x.start === wrapWeek(off));
  assert.ok(b && b.pinned);
  assert.ok(blockHubEvents(b, ctx).some(e => !e.made), 'the moved flight misses a bank');
  const to = snapToBank(w, b, ctx);
  assert.ok(to != null, 'a wave is free');
  const st3 = { ...st, routes: st.routes.map(r => r.id === 'r7' ? { ...r, schedule: { starts: pinsAfterMove(w, 'r7', b, to) } } : r) };
  const b3 = airlineWeeks(st3, 6).get('ac7').blocks.find(x => x.start === to);
  assert.ok(blockHubEvents(b3, ctx).every(e => e.made), 'snapped: makes its banks');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 3. Connections from the timetable ───────────────────────────');

test('stats: a connection counts from CONNECT_MIN to CONNECT_MAX, both directions averaged', () => {
  // Hand-built week: A lands at the hub at 600, C leaves at 600 + 60 and at
  // 600 + 20 (too tight) and 600 + CONNECT_MAX + 30 (too long).
  const leg = (from, to, flightMin) => ({ from, to, flightMin, turnMin: 0 });
  const block = (routeId, start, legs) => ({ routeId, start, legs, dur: 0 });
  const weeks = new Map([['x', { blocks: [
    block('a', 500, [leg('A', 'H', 100)]),                   // arrives H at 600
    block('c1', 660, [leg('H', 'C', 50)]),                   // +60: connects
    block('c2', 620, [leg('H', 'C', 50)]),                   // +20: too tight
    block('c3', 600 + CONNECT_MAX + 30, [leg('H', 'C', 50)]),// too long
    block('cb', 2000, [leg('C', 'H', 50)]),                  // C → H at 2050
    block('ab', 2050 + CONNECT_MIN, [leg('H', 'A', 50)]),    // exactly CONNECT_MIN: connects
  ] }]]);
  const st = hubTimetable(weeks).stats('H', 'A', 'C');
  assert.equal(st.known, true);
  assert.equal(st.freq, 1);
  assert.equal(st.ratio, 1);
  assert.ok(Math.abs(st.waitH - (60 + CONNECT_MIN) / 2 / 60) < 1e-9, `${st.waitH}`);
  assert.deepEqual(hubTimetable(weeks).stats('H', 'A', 'Z'), { known: false });
});

test('a banked hub connects far more than the same network on Rolling', () => {
  const mk = (hubBanks) => { const s = banked({ hubBanks }); return hubConnectivity(hubTimetableOf(s, 6), airlineWeeks(s, 6), hubBankPlan(s, HUB)); };
  const auto = mk({}), rolling = mk({ [HUB]: { mode: 'rolling' } });
  assert.ok(auto.options > rolling.options * 3, `banked ${auto.options} vs rolling ${rolling.options}`);
  assert.ok(auto.avgWaitMin < rolling.avgWaitMin);
  assert.equal(rolling.waitHoursPerDay, 0, 'rolling aircraft never wait');
  assert.ok(auto.waitHoursPerDay > 0, 'banking costs some waiting');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 4. The tick ──────────────────────────────────────────────────');

const connPax = (st) => {
  const r = weeklyTick(st);
  return r.routeResults.reduce((s, x) => s + (x.connecting?.itineraryPax ?? 0), 0);
};

test('a hub-bank world: banked connects more passengers than Rolling', () => {
  const a = connPax(banked());
  const r = connPax(banked({ hubBanks: { [HUB]: { mode: 'rolling' } } }));
  assert.ok(a > r * 1.05, `banked ${a} vs rolling ${r}`);
});

test('outside a hub-bank world the bank setting changes nothing', () => {
  const a = weeklyTick(network());
  const r = weeklyTick(network({ hubBanks: { [HUB]: { mode: 'rolling' } } }));
  assert.equal(JSON.stringify(r.routeResults), JSON.stringify(a.routeResults));
});

test('the preview of a new spoke moves with the timetable exactly as the tick does', () => {
  // The fixture's direct passengers already differ preview vs tick by ~1.7%
  // with hub banks OFF (991 vs 974 — not this change), and the connecting
  // feed seats into that headroom. So pin what this change owns: switching
  // the timetable on moves the preview's connecting feed by the same factor
  // as the tick's.
  const run = (over) => {
    const st = network(over);
    const spare = mkAc('spare');
    const base = { ...st, fleet: [...st.fleet, spare] };
    const dest = 'MKY';
    const fare = Math.round(referencePrice(HUB, dest));
    const proj = projectRouteAddition(base, {
      origin: HUB, destination: dest, aircraft: spare, weeklyFrequency: 14,
      ticketPrice: fare, classPrices: { economy: fare },
    });
    const tick = weeklyTick({ ...base, routes: [...base.routes, mkRoute('new', dest, 'spare')],
      routePricing: { ...base.routePricing, [[HUB, dest].sort().join('-')]: { economy: fare } } });
    return { p: proj.connecting.itineraryPax, t: tick.routeResults.find(x => x.routeId === 'new').connecting.itineraryPax };
  };
  const off = run({}), on = run({ hubBanksWorld: true }), roll = run({ hubBanksWorld: true, hubBanks: { [HUB]: { mode: 'rolling' } } });
  assert.ok(off.t > 0 && on.t > 0, 'the fixture connects someone');
  assert.ok(on.t !== off.t, 'the timetable changes the booked feed');
  for (const x of [on, roll]) {
    assert.ok(Math.abs(x.p / off.p - x.t / off.t) < 0.01,
      `preview ×${(x.p / off.p).toFixed(3)} vs tick ×${(x.t / off.t).toFixed(3)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 5. The decision ──────────────────────────────────────────────');

test('SET_HUB_BANKS: hub-bank worlds only, own hubs only, null = Automatic, no-op returns the same state', () => {
  const plain = network();
  assert.equal(gameReducer(plain, { type: 'SET_HUB_BANKS', banks: { [HUB]: { mode: 'rolling' } } }), plain);
  const st = banked();
  const s1 = gameReducer(st, { type: 'SET_HUB_BANKS', banks: { [HUB]: { mode: 'banks', count: 6 }, MEL: { mode: 'rolling' } } });
  assert.deepEqual(s1.hubBanks, { [HUB]: { mode: 'banks', count: 6 } });
  assert.equal(s1.cash, st.cash);
  assert.equal(gameReducer(s1, { type: 'SET_HUB_BANKS', banks: { [HUB]: { mode: 'banks', count: 6 } } }), s1);
  const s2 = gameReducer(s1, { type: 'SET_HUB_BANKS', banks: { [HUB]: null } });
  assert.deepEqual(s2.hubBanks, {});
});

test('the server allows it, cleans it, and refuses it outside a hub-bank world', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('SET_HUB_BANKS'));
  assert.deepEqual(guardDecision('SET_HUB_BANKS', { banks: { [HUB]: { mode: 'banks', times: [700, 420, 425] }, MEL: { mode: 'rolling' } } }, banked()),
    { banks: { [HUB]: { mode: 'banks', times: [420, 700] } } });
  assert.throws(() => guardDecision('SET_HUB_BANKS', { banks: { [HUB]: { mode: 'rolling' } } }, network()));
  assert.throws(() => guardDecision('SET_HUB_BANKS', { banks: { MEL: { mode: 'rolling' } } }, banked()));
});

test('scheduleInputsOf carries the bank fields to airlineWeeks', () => {
  const st = banked({ hubBanks: { [HUB]: { mode: 'banks', count: 3 } } });
  const i = scheduleInputsOf(st);
  assert.equal(i.hubBanksWorld, true);
  assert.deepEqual(i.hubBanks, st.hubBanks);
  assert.equal(airlineWeeks(i, 6).get('ac0').banked, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
