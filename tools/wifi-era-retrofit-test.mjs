// wifi-era-retrofit-test.mjs — onboard Wi-Fi cannot be retrofitted before it
// exists (Discord, Kat the Fox, 2026-11-12: "I can retrofit WiFi on to planes
// in the year 1971 in Timely Takeoff").
//
// HEAD failure proof:
//   1. The Fleet selection bar quoted canRetrofitWifi, which knew the AIRFRAME
//      gate but not the ERA gate, so ticking a 747-100 in a 1971 world showed a
//      live "Fit Wi-Fi (1) · $1.05M" button. Its handler then returned without
//      a word — the single-tail badge was already era-gated, the bar was not.
//   2. The engine's era refusal returns a NEW state object (it carries a toast),
//      so routes/decisions.mjs read `next !== injected` as a change and replied
//      201 to every era-locked action — Wi-Fi, lounges, ancillaries, alliances,
//      codeshares, loyalty — instead of a readable 400 the client rolls back on.
//   3. era-features-test asserted `.wifi` on the fleet row; the field is
//      `hasWifi`, so that check could not fail.
//
//   node --import ./tools/_register-loader.mjs tools/wifi-era-retrofit-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
};

const { GameProvider, freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const Fleet = (await import('../src/components/Fleet.jsx')).default;
const { canRetrofitWifi } = await import('../packages/engine/src/data/wifi.js');
const { ERA_FEATURE_MESSAGE, ERA_FEATURE_FROM, ERA_GATED_ACTIONS } =
  await import('../packages/engine/src/data/eraFeatures.js');
const { eraBlockReasonFor } = await import('../apps/headwinds-server/src/lib/eraBlocks.mjs');
const { getAircraftType, canFitWifi } = await import('../packages/engine/src/data/aircraft.js');

const JUMBO = getAircraftType('b747100');
const tail = (id) => ({
  id, typeId: JUMBO.id, name: `Tail ${id}`, tailNumber: id.toUpperCase(), status: 'idle',
  ageWeeks: 20, ownershipType: 'owned', config: { economy: JUMBO.seats },
});
const save = (startYear, calYear, extra = {}) => ({
  ...freshState(),
  phase: 'playing', multiplayer: true, competitors: [],
  startYear, year: startYear == null ? 3 : calYear - startYear + 1, week: 20,
  hub: 'JFK', cash: 2_000_000_000, homeCountry: 'US',
  gates: { JFK: 20 }, hubs: { JFK: { tier: 1 } }, routes: [], cargoRoutes: [],
  fleet: [tail('j1')], ...extra,
});
const strip = (h) => h.replace(/<!-- -->/g, '');
const renderFleet = (s, checked) => {
  store.set('bbae_save_v2', JSON.stringify(s));
  return strip(renderToString(React.createElement(GameProvider, null,
    React.createElement(Fleet, { initialCheckedIds: checked }))));
};

console.log('\nWi-Fi retrofit — not before onboard internet exists\n');

test('premise: the 747-100 airframe CAN carry Wi-Fi, so only the era gate can stop it', () => {
  assert.ok(canFitWifi(JUMBO), 'a 1970s jumbo passes the airframe gate');
  assert.ok(ERA_FEATURE_FROM.wifi > 1971);
});

test('the shared quote refuses before 2004, with the era sentence, and quotes nothing', () => {
  const q = canRetrofitWifi([tail('j1')], 2e9, { calYear: 1971 });
  assert.equal(q.ok, false);
  assert.equal(q.eligible.length, 0, 'no tail is eligible');
  assert.equal(q.capex, 0, 'nothing to charge');
  assert.equal(q.reasons[0], ERA_FEATURE_MESSAGE.wifi);
  assert.equal(q.eraLocked, true);
});

test('the shared quote is unchanged once Wi-Fi exists, and in classic worlds', () => {
  for (const calYear of [2004, 2015, null, undefined]) {
    const q = canRetrofitWifi([tail('j1')], 2e9, { calYear });
    assert.equal(q.ok, true, `calYear ${calYear}`);
    assert.equal(q.eligible.length, 1);
  }
  assert.equal(canRetrofitWifi([tail('j1')], 2e9).ok, true, 'two-argument callers keep working');
});

test('Fleet selection bar: no Fit Wi-Fi button for a ticked 747 in 1971 (Timely Takeoff)', () => {
  const html = renderFleet(save(1950, 1971), ['j1']);
  assert.ok(html.includes('Tail j1'), 'the fleet rendered');
  assert.ok(!/Fit Wi-Fi/.test(html), 'no retrofit button, per tail or in the bar');
  assert.ok(!/No Wi-Fi possible/.test(html), 'and no airframe excuse either — it is the era');
});

test('Fleet selection bar: the button is still there in 2010 and in a classic world', () => {
  assert.ok(/Fit Wi-Fi \(1\)/.test(renderFleet(save(1950, 2010), ['j1'])), 'era world, 2010');
  assert.ok(/Fit Wi-Fi \(1\)/.test(renderFleet(save(null, null), ['j1'])), 'classic world');
});

test('the reducer leaves the tail unfitted and the cash untouched in 1971', () => {
  const s = save(1950, 1971);
  const next = gameReducer(s, { type: 'INSTALL_WIFI', aircraftIds: ['j1'] });
  assert.equal(next.fleet.find((a) => a.id === 'j1').hasWifi ?? false, false);
  assert.equal(next.cash, s.cash);
});

test('server pre-flight: every era-locked action gets a sentence, not a 201', () => {
  const s = save(1950, 1971, { loyaltyPoolsWorld: true });
  for (const [type, feature] of Object.entries(ERA_GATED_ACTIONS)) {
    if (ERA_FEATURE_FROM[feature] <= 1971) continue;
    assert.equal(eraBlockReasonFor(type, s), ERA_FEATURE_MESSAGE[feature], type);
  }
  assert.equal(eraBlockReasonFor('INSTALL_WIFI', save(1950, 2010)), null, 'live in 2010');
  assert.equal(eraBlockReasonFor('INSTALL_WIFI', save(null, null)), null, 'classic worlds never');
  assert.equal(eraBlockReasonFor('ADD_ROUTE', s), null, 'ungated actions pass');
});

test('loyalty is only pre-flighted in loyalty-pools worlds, matching the reducer order', () => {
  assert.equal(eraBlockReasonFor('SET_LOYALTY_GENEROSITY', save(1950, 1971)), null);
});

test('guard: ERA_GATED_ACTIONS lists exactly the reducer cases that call refuseEraFeature', () => {
  const src = fs.readFileSync(new URL('../packages/engine/src/reducer.mjs', import.meta.url), 'utf8');
  const found = {};
  for (const block of src.split(/\n    case '/).slice(1)) {
    const m = /^([A-Z_]+)'/.exec(block);
    const f = /refuseEraFeature\(state, '([a-zA-Z]+)'\)/.exec(block);
    if (m && f) found[m[1]] = f[1];
  }
  assert.deepEqual(Object.fromEntries(Object.entries(found).sort()),
    Object.fromEntries(Object.entries(ERA_GATED_ACTIONS).sort()));
});

test('guard: routes/decisions.mjs pre-flights era refusals before running the reducer', () => {
  const src = fs.readFileSync(new URL('../apps/headwinds-server/src/routes/decisions.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('eraBlockReasonFor(');
  assert.ok(at > 0, 'decisions.mjs calls eraBlockReasonFor');
  assert.ok(at < src.indexOf('const next = gameReducer(injected, action)'), 'and does so before the reducer');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
