// Cabin refits: they must REACH the server, and they must do what the modal says.
//
// Reported on Discord (Knightmare, 2026-08-27): "cabin reconfigs dont appear to
// work. I select the new config, apply, and when I click confirm refit it goes
// through but the plane isnt taken out of service the next week, nor does it
// actually change configurations".
//
// TWO separate faults met in that one report:
//
//   1. CONFIGURE_AIRCRAFT_BULK — which FleetConfig dispatches for a SINGLE tail
//      too — shipped in a8648dd with a reducer case and a full server-side
//      decision guard, but was never added to ALLOWED_PLAYER_ACTIONS. The web
//      client imports that same set and drops unlisted actions before the fetch,
//      so the refit never left the browser: no request, no 403, no error, no
//      change. The first suite below is the generalizable guard — every action
//      the UI dispatches and the reducer implements must be on the allow-list.
//
//   2. "Aircraft is taken out of service for refitting" was aspirational copy.
//      No reducer, in either repo, had ever grounded anything for a cabin job.
//      Refits now cost shop time (refitWeeks), and the modal quotes the same
//      function the reducer grounds the tail with.
//
//   node --import ./tools/_register-loader.mjs tools/cabin-refit-test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { ALLOWED_PLAYER_ACTIONS } from '../apps/headwinds-server/src/world.mjs';
import { guardDecision } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { getAircraftType, AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { calcReconfCost, refitWeeks, defaultConfig, advanceDowntimeOneWeek } from '../src/utils/simulation.js';
import { dueInfo, isOutOfService, C_HOURS_DUE, C_WEEKS_DUE } from '../src/data/maintenance.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Every action the UI dispatches can reach the server ───');

// The four the server keeps for itself (documented in world.mjs) plus the two
// client-only ones the reducer never sees over the wire.
const SERVER_OWNED = new Set(['ADVANCE_WEEK', 'START_GAME', 'LOAD_STATE', 'RESET']);
const DELIBERATELY_UNLISTED = new Set([
  'LEASE_AIRCRAFT',  // no cash check — MP leases go through ORDER_AIRCRAFT
  'PUSH_TOAST',      // local UI queue; nothing to write, never leaves the tab
]);

function jsFilesUnder(dir) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === 'dist' || e.startsWith('_to_delete')) continue;
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(jsx|js)$/.test(e)) out.push(p);
    }
  })(dir);
  return out;
}

const uiFiles = [...jsFilesUnder(path.join(ROOT, 'src')),
                 ...jsFilesUnder(path.join(ROOT, 'apps/headwinds-web/src'))];
const reducerSrc = readFileSync(path.join(ROOT, 'packages/engine/src/reducer.mjs'), 'utf8');
const reducerCases = new Set([...reducerSrc.matchAll(/case '([A-Z_]+)'/g)].map(m => m[1]));

const dispatched = new Map();
for (const f of uiFiles) {
  for (const m of readFileSync(f, 'utf8').matchAll(/type:\s*'([A-Z][A-Z0-9_]+)'/g)) {
    if (!dispatched.has(m[1])) dispatched.set(m[1], new Set());
    dispatched.get(m[1]).add(path.relative(ROOT, f));
  }
}

test('the UI dispatches something (the scan is not silently empty)', () => {
  assert.ok(dispatched.size > 20, `only found ${dispatched.size} action literals — the scan broke`);
  assert.ok(dispatched.has('ADD_ROUTE'), 'ADD_ROUTE should be in any honest scan of the UI');
});

test('every engine action the UI dispatches is on the allow-list', () => {
  const stranded = [];
  for (const [type, files] of dispatched) {
    if (!reducerCases.has(type)) continue;                 // not an engine action
    if (SERVER_OWNED.has(type) || DELIBERATELY_UNLISTED.has(type)) continue;
    if (ALLOWED_PLAYER_ACTIONS.has(type)) continue;
    stranded.push(`${type} (dispatched from ${[...files].join(', ')})`);
  }
  assert.deepEqual(stranded, [],
    'these actions are dispatched by the UI and implemented by the reducer, but are '
    + 'not on ALLOWED_PLAYER_ACTIONS — the client drops them before the fetch and the '
    + 'player sees nothing happen:\n    ' + stranded.join('\n    '));
});

test('CONFIGURE_AIRCRAFT_BULK specifically (the reported bug)', () => {
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('CONFIGURE_AIRCRAFT_BULK'));
});

test('the server-reserved four are still excluded', () => {
  for (const t of SERVER_OWNED) assert.ok(!ALLOWED_PLAYER_ACTIONS.has(t), `${t} must stay server-only`);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── A refit is shop work ──────────────────────────────────');

const NB = getAircraftType('a320neo');
const WB = AIRCRAFT_TYPES.find(t => t.category === 'Wide Body' && !t.freighter);
assert.ok(NB && WB, 'need a narrow-body and a wide-body in the type table');

function seeded(typeId = 'a320neo') {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Probe', hub: 'JFK', enableObjectives: false });
  s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId });
  return s;
}

const base = seeded();
const tail = base.fleet.at(-1);
const NEW_CABIN = { firstClass: 0, businessClass: 20, premiumEconomy: 0, economy: 100, seatQuality: 'standard' };
const refit = (state, id = tail.id, config = NEW_CABIN) =>
  gameReducer(state, { type: 'CONFIGURE_AIRCRAFT', aircraftId: id, config, reconfCost: 0 });

test('the tail comes out of service, with the reason recorded', () => {
  const a = refit(base).fleet.find(x => x.id === tail.id);
  assert.equal(a.status, 'grounded');
  assert.ok(a.groundedWeeksLeft >= 1, `groundedWeeksLeft is ${a.groundedWeeksLeft}`);
  assert.equal(a.groundedReason, 'refit', 'a refit must not be indistinguishable from a breakdown');
});

test('the cabin actually changes', () => {
  const a = refit(base).fleet.find(x => x.id === tail.id);
  assert.equal(a.config.businessClass, 20);
  assert.equal(a.config.seatQuality, 'standard');
});

test('the charge is re-derived, never taken from the payload', () => {
  const inflated = gameReducer(base, {
    type: 'CONFIGURE_AIRCRAFT', aircraftId: tail.id, config: NEW_CABIN, reconfCost: 99_000_000,
  });
  const expected = calcReconfCost(tail.config ?? defaultConfig(NB.seats), NEW_CABIN);
  assert.equal(base.cash - inflated.cash, expected, 'a forged reconfCost was charged');
});

test('a no-op refit grounds nothing', () => {
  const same = refit(base, tail.id, tail.config);
  assert.equal(same.fleet.find(x => x.id === tail.id).status, tail.status,
    'reopening the modal and pressing Confirm on an unchanged cabin parked the aircraft');
  assert.equal(same.cash, base.cash);
});

test('a bigger change on a bigger airframe books more shop time', () => {
  const small = refitWeeks(NB, defaultConfig(NB.seats), { ...defaultConfig(NB.seats), businessClass: 4, economy: 180 });
  const big   = refitWeeks(WB, defaultConfig(WB.seats),
    { firstClass: 8, businessClass: Math.round(WB.seats * 0.3), premiumEconomy: 0, economy: 40 });
  assert.ok(big > small, `wide-body major refit (${big}w) should outlast a narrow-body tweak (${small}w)`);
  assert.ok(big <= 4, 'refit downtime must stay capped');
});

test('a tail in a heavy check refuses the job instead of losing its slot', () => {
  const inShop = {
    ...base,
    fleet: base.fleet.map(a => (a.id === tail.id
      ? { ...a, status: 'maintenance', checkType: 'C', checkWeeksLeft: 2 } : a)),
  };
  const after = refit(inShop);
  const a = after.fleet.find(x => x.id === tail.id);
  assert.equal(a.status, 'maintenance', 'the C check was cancelled by a cabin job');
  assert.equal(a.checkWeeksLeft, 2, 'the check countdown was disturbed');
  assert.equal(after.cash, inShop.cash, 'the player was charged for a refit that did not happen');
  assert.ok(after.error, 'the refusal must say something — a silent no-op is the bug we are fixing');
});

test('downtime ends and the aircraft returns clean', () => {
  let a = refit(base).fleet.find(x => x.id === tail.id);
  const weeks = a.groundedWeeksLeft;
  for (let i = 0; i < weeks; i++) a = advanceDowntimeOneWeek(a, false);
  assert.ok(!isOutOfService(a), `still out of service after ${weeks} week(s)`);
  assert.equal(a.groundedWeeksLeft, 0);
  assert.ok(!a.groundedReason, 'a stale refit reason would mislabel the next breakdown');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── A batch charges for what it actually did ──────────────');

let fleetState = seeded();
fleetState = gameReducer(fleetState, { type: 'LEASE_AIRCRAFT', typeId: 'a320neo' });
fleetState = gameReducer(fleetState, { type: 'LEASE_AIRCRAFT', typeId: 'a320neo' });
const [t1, t2, t3] = fleetState.fleet.slice(-3);
const withOneInShop = {
  ...fleetState,
  fleet: fleetState.fleet.map(a => (a.id === t3.id
    ? { ...a, status: 'maintenance', checkType: 'D', checkWeeksLeft: 4 } : a)),
};
const bulk = gameReducer(withOneInShop, {
  type: 'CONFIGURE_AIRCRAFT_BULK',
  aircraftIds: [t1.id, t2.id, t3.id],
  config: NEW_CABIN,
  reconfCost: 99_000_000,
});

test('the shop-bound tail is skipped, the other two are refit', () => {
  assert.equal(bulk.fleet.find(a => a.id === t1.id).status, 'grounded');
  assert.equal(bulk.fleet.find(a => a.id === t2.id).status, 'grounded');
  const skipped = bulk.fleet.find(a => a.id === t3.id);
  assert.equal(skipped.status, 'maintenance');
  assert.equal(skipped.config.businessClass ?? 0, t3.config.businessClass ?? 0,
    'a tail in the shop had its cabin rewritten anyway');
});

test('only the applied tails are billed', () => {
  const per = calcReconfCost(t1.config ?? defaultConfig(NB.seats), NEW_CABIN);
  assert.equal(withOneInShop.cash - bulk.cash, per * 2,
    'the batch charged for the aircraft it skipped');
});

test('the batch reports what it skipped', () => {
  assert.deepEqual(bulk.bulkResult,
    { action: 'CONFIGURE_AIRCRAFT_BULK', requested: 3, applied: 2, skipped: 1 });
});

test('the multiplayer guard prices a batch with the SAME function as the reducer', () => {
  const guarded = guardDecision('CONFIGURE_AIRCRAFT_BULK',
    { aircraftIds: [t1.id, t2.id], config: NEW_CABIN, reconfCost: 1 }, fleetState);
  const expected = 2 * calcReconfCost(t1.config ?? defaultConfig(NB.seats), NEW_CABIN);
  assert.equal(guarded.reconfCost, expected,
    'the guard kept its own copy of the price and it has drifted from the engine');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── The modal promises what the reducer delivers ──────────');

const { GameProvider } = await import('../src/store/GameContext.jsx');
const FleetConfigMod = await import('../src/components/FleetConfig.jsx');
const FleetConfig = FleetConfigMod.default;
const { refitDowntimeNote } = FleetConfigMod;

const cfgSave = {
  ...freshState(), phase: 'playing', week: 10, year: 2, hub: 'JFK', cash: 500_000_000,
  homeCountry: 'US', gates: { JFK: 10 }, hubs: { JFK: { tier: 1 } },
  fleet: [{ id: 'wb1', typeId: WB.id, name: 'Wide One', tailNumber: 'NWB01',
            status: 'idle', ageWeeks: 60, ownershipType: 'owned',
            config: defaultConfig(WB.seats) }],
};
store.set('bbae_save_v2', JSON.stringify(cfgSave));
const modalHtml = renderToString(React.createElement(GameProvider, null,
  React.createElement(FleetConfig, { aircraftId: 'wb1', onClose() {} }))).replace(/<!-- -->/g, '');

test('the modal renders at all (the banner path is live)', () => {
  assert.ok(modalHtml.includes('Confirm Refit') || modalHtml.includes('No Changes'),
    'FleetConfig did not render its action row');
});

// The banner only appears once the player has moved a seat, which SSR cannot
// do. Test the promise itself against the function the reducer grounds with —
// a preview that disagrees with the tick is a bug in one of them.
test('the sentence quotes the same downtime the reducer applies', () => {
  const bigChange = { firstClass: 8, businessClass: Math.round(WB.seats * 0.3), premiumEconomy: 0, economy: 40 };
  const weeks = refitWeeks(WB, defaultConfig(WB.seats), bigChange);
  const promised = refitDowntimeNote(weeks, false);
  assert.match(promised, new RegExp(`out of service for ${weeks} weeks? while the cabin is refitted`));

  const wbState = {
    ...cfgSave,
    fleet: [{ id: 'wb1', typeId: WB.id, name: 'Wide One', status: 'idle', ageWeeks: 60,
              ownershipType: 'owned', config: defaultConfig(WB.seats) }],
  };
  const after = gameReducer(wbState, {
    type: 'CONFIGURE_AIRCRAFT', aircraftId: 'wb1', config: bigChange, reconfCost: 0,
  }).fleet[0];
  assert.equal(after.groundedWeeksLeft, weeks,
    `the modal promised ${weeks}w and the reducer grounded for ${after.groundedWeeksLeft}w`);
});

test('a refit with no shop time says so rather than promising downtime', () => {
  assert.ok(!refitDowntimeNote(0, false).includes('out of service'));
});

test('a tail already in the shop is excluded, not silently dropped', () => {
  store.set('bbae_save_v2', JSON.stringify({
    ...cfgSave,
    fleet: [{ ...cfgSave.fleet[0], status: 'maintenance', checkType: 'C', checkWeeksLeft: 2 }],
  }));
  const html = renderToString(React.createElement(GameProvider, null,
    React.createElement(FleetConfig, { aircraftId: 'wb1', onClose() {} }))).replace(/<!-- -->/g, '');
  assert.ok(html.includes('already out of service'),
    'the modal offered a refit on a tail the reducer will refuse');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Maintenance reads as time till due ────────────────────');

// Knightmare's screenshot: C 83% (3734h · 29w), D 16% (3734h · 29w). The same
// hour count under both checks, and neither of them the number he wanted.
const SHOT = { hoursSinceC: 3734, hoursSinceD: 3734, weeksSinceC: 29, weeksSinceD: 29 };

test('remaining hours are the shortfall to the threshold', () => {
  const d = dueInfo(SHOT, NB, 30);
  assert.equal(d.cHoursLeft, C_HOURS_DUE - 3734);
  assert.equal(d.cWeeksLeft, C_WEEKS_DUE - 29);
});

test('the estimate uses the tail\'s own utilization, not the calendar alone', () => {
  const d = dueInfo(SHOT, NB, 30);
  // ~129 block-hours a week burns the remaining 766h in about 6 weeks; the
  // calendar clock still has 75 weeks on it, so hours are what bites.
  assert.equal(d.cDueInWeeks, 6);
  assert.ok(d.cDueInWeeks < d.cWeeksLeft, 'the calendar clock was reported as if it were the binding one');
});

test('a parked tail falls back to the calendar clock', () => {
  const d = dueInfo({ hoursSinceC: 0, hoursSinceD: 0, weeksSinceC: 10, weeksSinceD: 10 }, NB, 10);
  assert.equal(d.cDueInWeeks, C_WEEKS_DUE - 10, 'a tail flying no hours has no hour-based estimate');
  assert.ok(Number.isFinite(d.cDueInWeeks));
});

test('an already-due check reports zero, not a negative countdown', () => {
  const d = dueInfo({ hoursSinceC: C_HOURS_DUE + 500, hoursSinceD: 0, weeksSinceC: 90, weeksSinceD: 90 }, NB, 100);
  assert.equal(d.cDueInWeeks, 0);
  assert.equal(d.cHoursLeft, 0);
});

const { AircraftDetail } = await import('../src/components/Fleet.jsx');
store.set('bbae_save_v2', JSON.stringify({
  ...cfgSave,
  fleet: [{ id: 'nb1', typeId: NB.id, name: 'Narrow One', tailNumber: 'NNB01',
            status: 'idle', ageWeeks: 29, ownershipType: 'owned',
            config: defaultConfig(NB.seats), ...SHOT }],
}));
const cardHtml = renderToString(React.createElement(GameProvider, null,
  React.createElement(AircraftDetail, {
    aircraft: { id: 'nb1', typeId: NB.id, name: 'Narrow One', tailNumber: 'NNB01',
                status: 'idle', ageWeeks: 29, ownershipType: 'owned',
                config: defaultConfig(NB.seats), ...SHOT },
    onClose() {}, onConfigure() {}, onRetire() {}, onSell() {},
  }))).replace(/<!-- -->/g, '');

test('the card prints the time till due', () => {
  assert.match(cardHtml, /due in ~6w/, 'the maintenance panel does not say when the check is due');
  assert.ok(cardHtml.includes('766h left'), 'the remaining hours are missing');
});

test('the card no longer prints hours accrued as if it were the answer', () => {
  assert.ok(!cardHtml.includes('3,734h') && !cardHtml.includes('3734h'),
    'total time flown is still being shown in the check panel');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
