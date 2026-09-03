// The Competition battle card must show the demand model's projected share and
// name the inputs its comparison grid cannot display.
//
// Player report (Discord, 2026-09-02, JFK→YYZ): $140/quality 92 against
// $184/quality 82 at equal frequency — every visible row won — yet half-empty
// planes and "why am I losing this battle". The deciding inputs (brand
// awareness ~0.45× reach for a new carrier, and an economy-only cabin ceding
// the whole business segment) appeared NOWHERE on the card. The card now
// carries a "Projected share" row fed by pairMarketShare — the single source
// of truth for share previews (never a hand-rolled ratio) — plus hints for low
// awareness and a missing business cabin.
//
//   node --import ./tools/_register-loader.mjs tools/battle-card-share-test.mjs

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
const CompetitionModule = await import('../src/components/Competition.jsx');
const Competition = CompetitionModule.default;
const { buildPlayerPairMap, ContestedRouteRow } = CompetitionModule;
const { pairMarketShare } = await import('../packages/engine/src/models/pairShare.js');
const { getAircraftType } = await import('../src/data/aircraft.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// React SSR splits adjacent text nodes with an empty comment.
const clean = (html) => html
  .replace(/<!-- -->/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const TYPE = getAircraftType('a220100') ?? getAircraftType('a220300');
assert.ok(TYPE, 'sample aircraft type resolves');

// Three tails on one pair, economy-only, priced 22% under reference — the
// shape of the report: wins price, quality and frequency, low awareness.
function makeState(over = {}) {
  const cabin = over.cabin ?? { economy: TYPE.seats, businessClass: 0 };
  const fleet = [1, 2, 3].map(i => ({ id: `t${i}`, typeId: TYPE.id, config: { ...cabin }, ageWeeks: 52 }));
  const routes = fleet.map(a => ({
    origin: 'JFK', destination: 'YYZ', aircraftId: a.id,
    weeklyFrequency: 7, ticketPrice: 140, weeksOpen: 30,
  }));
  const base = freshState();
  return {
    ...base,
    phase: 'playing', week: 30, year: 1, hub: 'YYZ', cash: 10_000_000,
    awareness: 5,
    // Shrink the pool so nobody is capacity-capped and share differences show.
    worldDemandMult: 0.05,
    fleet, routes, cargoRoutes: [],
    competitors: [{
      id: 'continentalx', name: 'Continental Express', homeHub: 'JFK',
      tier: 'legacy', logoId: 'eagle', baseQualityScore: 82, cash: 45_000_000,
      weeklyStats: null,
      routes: { 'JFK-YYZ': { frequency: 21, priceMultiplier: 1.02 } },
    }],
    ...over,
  };
}

function renderRow(state) {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(state));
  const map = buildPlayerPairMap(state.routes, state.fleet, 6);
  assert.ok(map['JFK-YYZ'], 'fixture produces a pair aggregate');
  return clean(renderToString(React.createElement(GameProvider, null,
    React.createElement(ContestedRouteRow, {
      routeKey: 'JFK-YYZ',
      playerRoute: map['JFK-YYZ'],
      competitors: state.competitors,
      fleet: state.fleet,
    }))));
}

function playerShareShown(html) {
  const m = html.match(/data-share="(\d+)" data-carrier="player"/);
  return m ? Number(m[1]) : null;
}

console.log('\n── projected-share row ──────────────────────────────────');

test('the full Competition screen shows a projected-share row on a contested pair', () => {
  const state = makeState();
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(state));
  const html = clean(renderToString(React.createElement(GameProvider, null,
    React.createElement(Competition))));
  assert.ok(html.includes('Projected share'),
    'contested-route card must carry a Projected share row');
});

test('the share shown is the demand model\'s answer for the same state', () => {
  const state = makeState();
  const html = renderRow(state);
  const shown = playerShareShown(html);
  assert.ok(shown != null, 'player share cell renders with data-share');
  const { playerShare } = pairMarketShare(state, 'JFK', 'YYZ');
  assert.equal(shown, Math.round(playerShare * 100),
    'UI must agree with pairMarketShare — a preview that disagrees with the tick is a bug');
});

test('a rival share cell renders too', () => {
  const html = renderRow(makeState());
  assert.ok(/data-share="(\d+)" data-carrier="rival"/.test(html), 'rival cell has a share');
});

test('brand awareness moves the share the player is shown', () => {
  const low  = playerShareShown(renderRow(makeState({ awareness: 5 })));
  const high = playerShareShown(renderRow(makeState({ awareness: 80 })));
  assert.ok(low != null && high != null);
  assert.ok(high > low,
    `awareness 80 must show a larger share than awareness 5 (got ${high} vs ${low})`);
});

console.log('\n── hints for the invisible inputs ───────────────────────');

test('low awareness earns an explanatory hint', () => {
  const html = renderRow(makeState({ awareness: 5 }));
  assert.ok(html.includes('Brand awareness is 5/100'),
    'the card must say the market does not know this airline yet');
});

test('awareness near parity earns no awareness hint', () => {
  const html = renderRow(makeState({ awareness: 80 }));
  assert.ok(!html.includes('Brand awareness is'),
    'an established brand needs no awareness warning');
});

test('economy-only against a J-selling rival earns a business-cabin hint', () => {
  const html = renderRow(makeState());
  assert.ok(html.includes('no business cabin'),
    'the card must say the business segment books only with rivals');
});

test('a player selling business seats gets no cabin hint', () => {
  const html = renderRow(makeState({
    cabin: { economy: TYPE.seats - 24, businessClass: 12 },
  }));
  assert.ok(!html.includes('no business cabin'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
