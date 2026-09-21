// The Rivals battle card's "Quality score" for the player must be the same
// number Route Details shows and the weekly tick scores the offer with.
//
// Player report (Discord, 2026-09-21, djak2103): "Why is there a difference in
// route quality shown in the route details versus the rivals tab for the same
// route? This seems to happen for all my routes" — 63 on Rivals, 100 on Route
// Details.
//
// Cause: Competition.jsx rebuilt the player's quality by hand from
// computeQualityScore (on-time, cabin, age, rating) and stopped there. The
// engine's figure — routeQualityBreakdown().total, which buildPlayerPairOffer
// feeds the share fight — also stacks the ground-handling, cabin-space,
// catering, ancillary and hub bonuses. Rivals was showing the raw subtotal.
//
//   node --import ./tools/_register-loader.mjs tools/rivals-quality-agreement-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.window ??= {
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
if (!globalThis.window.localStorage) globalThis.window.localStorage = globalThis.localStorage;

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { buildPlayerPairMap, ContestedRouteRow } = await import('../src/components/Competition.jsx');
const { pairMarketShare } = await import('../packages/engine/src/models/pairShare.js');
const { routeQualityBreakdown } = await import('../packages/engine/src/utils/simulation.js');
const { getAircraftType } = await import('../src/data/aircraft.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const clean = (html) => html.replace(/<!-- -->/g, '');

const TYPE = getAircraftType('b744') ?? getAircraftType('a220100') ?? getAircraftType('a220300');
assert.ok(TYPE, 'sample aircraft type resolves');

function makeState({ tails = 1, ages = [0, 0], freqs = [5, 4], hubTier = 2 } = {}) {
  const fleet = Array.from({ length: tails }, (_, i) => ({
    id: `t${i + 1}`, typeId: TYPE.id, config: null, ageWeeks: ages[i] ?? 0,
  }));
  const routes = fleet.map((a, i) => ({
    origin: 'JFK', destination: 'LHR', aircraftId: a.id,
    weeklyFrequency: freqs[i] ?? 5, ticketPrice: 476, weeksOpen: 30,
    cateringLevel: 'premium',
  }));
  const base = freshState();
  return {
    ...base,
    phase: 'playing', week: 30, year: 1, hub: 'JFK', cash: 10_000_000,
    hubs: { JFK: { tier: hubTier } },
    fleet, routes, cargoRoutes: [],
    competitors: [{
      id: 'rival', name: 'Air Caldor', homeHub: 'LHR',
      tier: 'legacy', logoId: 'eagle', baseQualityScore: 86, cash: 45_000_000,
      weeklyStats: null,
      routes: { 'JFK-LHR': { frequency: 5, priceMultiplier: 0.95 } },
    }],
  };
}

function shownPlayerQuality(state) {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(state));
  const map = buildPlayerPairMap(state.routes, state.fleet, 6);
  const html = clean(renderToString(React.createElement(GameProvider, null,
    React.createElement(ContestedRouteRow, {
      routeKey: 'JFK-LHR', playerRoute: map['JFK-LHR'],
      competitors: state.competitors, fleet: state.fleet,
    }))));
  const at = html.indexOf('Quality score');
  assert.ok(at >= 0, 'battle card renders a Quality score row');
  const m = html.slice(at).match(/font-weight:700[^>]*>(\d+)<\/span>/);
  assert.ok(m, 'player quality cell renders a number');
  return Number(m[1]);
}

function engineQuality(state) {
  const { offers } = pairMarketShare(state, 'JFK', 'LHR');
  const player = offers.find(o => o.airlineId === 'player');
  assert.ok(player, 'share fight carries a player offer');
  return player.qualityScore;
}

console.log('\n── Rivals quality agrees with Route Details and the tick ──');

test('fixture: the bonuses stacked on top of the raw score are non-zero', () => {
  const s = makeState();
  const bd = routeQualityBreakdown(s.routes[0], s.fleet[0], s);
  assert.ok(bd.total > bd.raw, `total ${bd.total} should exceed raw ${bd.raw} (hub + catering + space)`);
});

test('one aircraft: Rivals shows the engine total, not the raw subtotal', () => {
  const s = makeState();
  assert.equal(shownPlayerQuality(s), engineQuality(s));
});

test('one aircraft: equals the Route Details breakdown total', () => {
  const s = makeState();
  assert.equal(shownPlayerQuality(s), Math.round(routeQualityBreakdown(s.routes[0], s.fleet[0], s).total));
});

test('two aircraft of different ages: pooled the same way the share fight pools them', () => {
  const s = makeState({ tails: 2, ages: [0, 52 * 15], freqs: [5, 2] });
  assert.equal(shownPlayerQuality(s), engineQuality(s));
});

test('no hub on the pair: still agrees', () => {
  const s = makeState({ hubTier: null });
  s.hubs = {}; s.hub = 'ORD';
  assert.equal(shownPlayerQuality(s), engineQuality(s));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
