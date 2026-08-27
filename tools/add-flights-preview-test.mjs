// "Add Flights" must not offer hours the reducer will refuse.
//
// Reported by Knightmare (Discord, 2026-08-26): the Add Flights form showed a
// 757-200 with "11h free" in the picker and an utilisation bar reading
// 136.3 / 140h — comfortably inside the cap — and then the submit came back
// "NMIA25 has no spare flying hours — this would need 151h/wk against a 140h
// limit". Two readings of the same tail, ~15h apart, on one screen.
//
// The bar (and the frequency ceiling derived from it) computed the tail's
// committed hours itself:
//
//   routes.filter(r => r.aircraftId === aircraft.id)
//     .reduce((s, r) => s + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), ...))
//
// which is the very reading the same component's own picker had already been
// fixed away from: it charges a MULTI-STOP route only its direct O&D hop
// instead of every sector it flies, and it cannot see a route a reserve is
// covering for the tail (those carry coverForAircraftId, not aircraftId).
// addRouteBlockReason uses routesCommittedTo + routeBlockHours, so the form
// under-counted and the reducer did not.
//
// The invariant pinned here: whatever the form renders as "fits", the reducer
// accepts — and the form's own two readings of one tail agree with each other.
//
//   node --import ./tools/_register-loader.mjs tools/add-flights-preview-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import {
  routeDistanceKm, routeBlockHours, weeklyBlockHours, blockTimeHours,
  committedPeakBlockHours, MAX_WEEKLY_BLOCK_HOURS,
} from '../src/utils/simulation.js';

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

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { addRouteBlockReason } = await import('../packages/engine/src/reducer.mjs');
const { AddRouteForm } = await import('../src/components/Routes.jsx');

// ── The world: the reported shape — a narrow-body already on the pair, and a
// tag rotation on the same tail whose intermediate legs the bar cannot see ───
const JET = AIRCRAFT_TYPES.find(t => /757-200$/.test(t.name))
  ?? AIRCRAFT_TYPES.find(t => !t.freighter && t.category === 'Narrow Body' && (t.range ?? 0) > 5000);
assert.ok(JET, 'need a narrow-body jet in the type table');

const CODES = ['MCI', 'MSP', 'ORD', 'DEN'];
const PAIR_FREQ = 3;
const TAG_FREQ  = 14;
const TAG = { id: 'r-tag', origin: 'MCI', destination: 'DEN', stops: ['MCI', 'ORD', 'DEN'] };

const save = {
  ...freshState(),
  phase: 'playing', week: 20, year: 4, hub: 'MCI', cash: 400_000_000,
  gates: Object.fromEntries(CODES.map(c => [c, 40])),
  hubs: { MCI: { tier: 2 } },
  fleet: [
    { id: 'ac1', typeId: JET.id, name: 'Boeing 757-200 #3', tailNumber: 'NMIA25',
      status: 'assigned', ageWeeks: 260, ownershipType: 'owned',
      config: { business: 20, premiumEconomy: 30, economy: 168 } },
  ],
  routes: [
    { id: 'r-pair', origin: 'MCI', destination: 'MSP', stops: ['MCI', 'MSP'], aircraftId: 'ac1',
      weeklyFrequency: PAIR_FREQ, weeksOpen: 60, hub: 'MCI', season: null, seasonState: 'active' },
    { ...TAG, aircraftId: 'ac1', weeklyFrequency: TAG_FREQ, weeksOpen: 60, hub: 'MCI',
      segmentPrices: {}, cateringLevel: 'full', season: null, seasonState: 'active' },
  ],
  cargoRoutes: [],
};

// Truth, from the engine helpers the reducer's guard itself uses.
const committed = committedPeakBlockHours('ac1', JET, save.routes, save.cargoRoutes);
const addedAt7  = weeklyBlockHours(routeDistanceKm('MCI', 'MSP'), 7, JET);

// The scenario is only meaningful if the legs-blind reading is materially
// cheaper than the real one AND lands on the wrong side of the cap.
const blindCommitted =
    weeklyBlockHours(routeDistanceKm('MCI', 'MSP'), PAIR_FREQ, JET)
  + weeklyBlockHours(routeDistanceKm('MCI', 'DEN'), TAG_FREQ,  JET);
assert.ok(committed + addedAt7 > MAX_WEEKLY_BLOCK_HOURS,
  `scenario invalid: the reducer would ACCEPT this (${(committed + addedAt7).toFixed(1)}h)`);
assert.ok(blindCommitted + addedAt7 < MAX_WEEKLY_BLOCK_HOURS,
  `scenario invalid: the legs-blind reading already refuses (${(blindCommitted + addedAt7).toFixed(1)}h)`);
assert.ok(committed < MAX_WEEKLY_BLOCK_HOURS,
  'scenario invalid: the tail must still have SOME spare hours, or the picker hides it');

store.set('bbae_save_v2', JSON.stringify(save));
const html = renderToString(React.createElement(GameProvider, null,
  React.createElement(AddRouteForm, { initialOrigin: 'MCI', initialDest: 'MSP', onClose: () => {} })));

// ── Reading the rendered form ───────────────────────────────────────────────
// React SSR splits interpolated text with <!-- --> markers, so the bar renders
// as: (existing <!-- -->61.2<!-- -->h + new <!-- -->22.2<!-- -->h)
const BAR_RE = /existing\s*(?:<!-- -->)?\s*([\d.]+)(?:<!-- -->)?h\s*\+\s*new\s*(?:<!-- -->)?\s*([\d.]+)/;
function breakdown(markup) {
  const m = markup.match(BAR_RE);
  assert.ok(m, 'the utilisation bar did not render an "existing Xh + new Yh" breakdown');
  return { existing: Number(m[1]), added: Number(m[2]) };
}
function barHours() {
  return breakdown(html);
}
function pickerFreeHours() {
  const m = html.match(/—\s*(?:<!-- -->)?\s*([\d.]+)h free/);
  return m ? Number(m[1]) : null;
}
function freqMax() {
  const m = html.match(/type="number"[^>]*max="(\d+)"/);
  return m ? Number(m[1]) : null;
}

console.log('\n── Add Flights: one tail, one reading ────────────────');

test('the utilisation bar counts every sector the tail already flies', () => {
  const { existing } = barHours();
  assert.ok(Math.abs(existing - committed) < 0.15,
    `bar says the tail is on ${existing}h; it is committed to ${committed.toFixed(1)}h `
    + `(a ${(committed - existing).toFixed(1)}h blind spot — the tag route's intermediate legs)`);
});

test('the picker and the bar report the same tail', () => {
  const free = pickerFreeHours();
  const { existing } = barHours();
  assert.ok(free != null, 'the aircraft picker printed no free-hours figure');
  assert.ok(Math.abs((MAX_WEEKLY_BLOCK_HOURS - free) - existing) < 1,
    `picker offers ${free}h free (i.e. ${(MAX_WEEKLY_BLOCK_HOURS - free).toFixed(1)}h used) `
    + `while the bar on the same screen says ${existing}h used`);
});

test('a frequency the form offers is a frequency the reducer accepts', () => {
  const max = freqMax();
  assert.ok(max != null, 'the frequency input rendered no max');
  const reason = addRouteBlockReason(save, {
    origin: 'MCI', destination: 'MSP', aircraftId: 'ac1', weeklyFrequency: max, season: null,
  });
  assert.equal(reason, null,
    `the form offers up to ${max} flights/wk, but the reducer refuses ${max}: ${reason}`);
});

test('the bar never shows a fit the reducer will refuse', () => {
  const { existing, added } = barHours();
  const fitsOnScreen = existing + added <= MAX_WEEKLY_BLOCK_HOURS;
  const reason = addRouteBlockReason(save, {
    origin: 'MCI', destination: 'MSP', aircraftId: 'ac1', weeklyFrequency: 7, season: null,
  });
  if (fitsOnScreen) {
    assert.equal(reason, null,
      `bar reads ${(existing + added).toFixed(1)} / ${MAX_WEEKLY_BLOCK_HOURS}h, then submit says: ${reason}`);
  }
});

test('a route out on cover still counts against the tail that owns it', () => {
  const covered = {
    ...save,
    fleet: [
      ...save.fleet,
      { id: 'res', typeId: JET.id, name: 'Reserve', tailNumber: 'NRES01', status: 'assigned',
        ageWeeks: 260, ownershipType: 'owned', config: save.fleet[0].config, reserveBase: 'MCI' },
    ],
    routes: save.routes.map(r => (r.id === 'r-tag'
      ? { ...r, aircraftId: 'res', coverForAircraftId: 'ac1' }
      : r)),
  };
  const peak = committedPeakBlockHours('ac1', JET, covered.routes, covered.cargoRoutes);
  assert.ok(Math.abs(peak - committed) < 1e-6,
    `a tail whose rotation is out on cover reads as ${peak.toFixed(1)}h instead of ${committed.toFixed(1)}h`);
  store.set('bbae_save_v2', JSON.stringify(covered));
  const h = renderToString(React.createElement(GameProvider, null,
    React.createElement(AddRouteForm, { initialOrigin: 'MCI', initialDest: 'MSP', onClose: () => {} })));
  const shown = breakdown(h).existing;
  assert.ok(Math.abs(shown - peak) < 0.15,
    `bar says ${shown}h while ${peak.toFixed(1)}h is committed (routes out on cover come home)`);
});

test('a tag rotation\u2019s intermediate stop counts as an airport the tail serves', () => {
  // The reducer asks routeStops(); the form used to ask [origin, destination],
  // so a tail whose only rotation is MCI\u2192ORD\u2192DEN was told it "can't
  // teleport" to ORD \u2014 an airport it lands at every rotation.
  const tagOnly = {
    ...save,
    routes: [{ ...TAG, aircraftId: 'ac1', weeklyFrequency: 3, weeksOpen: 60, hub: 'MCI',
      segmentPrices: {}, cateringLevel: 'full', season: null, seasonState: 'active' }],
  };
  const reason = addRouteBlockReason(tagOnly, {
    origin: 'ORD', destination: 'MSP', aircraftId: 'ac1', weeklyFrequency: 3, season: null,
  });
  assert.equal(reason, null, `scenario invalid: the reducer already refuses this (${reason})`);
  store.set('bbae_save_v2', JSON.stringify(tagOnly));
  const h = renderToString(React.createElement(GameProvider, null,
    React.createElement(AddRouteForm, { initialOrigin: 'ORD', initialDest: 'MSP', onClose: () => {} })));
  assert.ok(/<option value="ac1" selected/.test(h),
    'the form did not even offer the tail whose rotation calls at ORD');
  assert.ok(!/can.{0,6}t teleport/.test(h),
    'the form warned that the aircraft cannot teleport to a stop on its own rotation');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
