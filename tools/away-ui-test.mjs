// The two new screens, rendered for real.
//
// Both are modals or panels that only appear in states a unit test cannot
// reach by calling a function — the away digest needs a save that has jumped
// weeks AND a localStorage that remembers otherwise, and the alliance dashboard
// needs a bloc. Rendering them is the only way to know the numbers reach the
// page rather than merely existing.
//
//   node --import ./tools/_register-loader.mjs tools/away-ui-test.mjs

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

const { GameProvider, RemoteGameProvider, freshState } = await import('../src/store/GameContext.jsx');
const AwayDigest        = (await import('../src/components/AwayDigest.jsx')).default;
const AllianceDashboard = (await import('../src/components/AllianceDashboard.jsx')).default;
const { seenKeyFor }    = await import('../src/utils/awayDigest.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// React SSR splits adjacent text nodes with an empty comment, so `{n} weeks`
// arrives as "12<!-- --> weeks". Rejoin before matching.
const clean = (html) => html
  .replace(/<!-- -->/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const finWeek = (i, over = {}) => ({
  label: `W${i}`, week: ((i - 1) % 52) + 1, year: 1,
  revenue: 2_000_000, cargoRevenue: 0, totalCost: 1_700_000, profit: 300_000,
  passengers: 9_000, fuel: 400_000, labor: 600_000, cash: 20_000_000, ...over,
});
const statWeek = (i, over = {}) => ({
  label: `W${i}`, absWeek: i, week: ((i - 1) % 52) + 1, year: 1,
  fleet: 4, routes: 7, destinations: 5, sharePrice: 9, svps: 11, loadFactor: 0.82, ...over,
});

const SAVE = {
  ...freshState(),
  phase: 'playing', week: 30, year: 1, cash: 21_500_000, hub: 'JFK',
  routes: [], cargoRoutes: [], competitors: [],
  financialHistory: Array.from({ length: 30 }, (_, i) => finWeek(i + 1)),
  statsHistory: Array.from({ length: 30 }, (_, i) =>
    statWeek(i + 1, i >= 18 ? { fleet: 8, routes: 14, destinations: 9, sharePrice: 13 } : {})),
};

const renderAway = (state = SAVE) =>
  clean(renderToString(React.createElement(GameProvider, null, React.createElement(AwayDigest))));

// ── The away digest ─────────────────────────────────────────────────────────

console.log('\n── While you were away ──────────────────────────────────');

test('a first sighting shows nothing and just starts the clock', () => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  assert.equal(renderAway().trim(), '', 'a brand-new device should not be told it was away');
});

test('twelve missed weeks produce a digest with the span in it', () => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  store.set(seenKeyFor(null), '18');    // last seen at week 18; the save is at 30
  const html = renderAway();
  assert.ok(html.includes('While you were away'), 'the digest did not render');
  assert.ok(html.includes('12 weeks passed'), 'the span is not stated');
  assert.ok(html.includes('W19') && html.includes('W30'), 'the from/to labels are missing');
});

test('the aggregate cash figure is the span, not the last week', () => {
  // THE defect: the debrief could only ever show one week of a twelve-week gap.
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  store.set(seenKeyFor(null), '18');
  const html = renderAway();
  // formatMoney abbreviates, so match its output rather than a raw figure.
  assert.ok(html.includes('$3.60M'),
    'expected the 12-week total ($3.60M), not the $0.30M of a single week');
  assert.ok(!html.includes('$0.30M'), 'a single week\'s figure has no business here');
  assert.ok(html.includes('12 profitable'), 'the week-by-week split is missing');
});

test('network movement across the gap is on the page', () => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  store.set(seenKeyFor(null), '18');
  const html = renderAway();
  assert.ok(html.includes('Fleet') && html.includes('Routes') && html.includes('Destinations'));
  assert.ok(html.includes('+4'), 'the fleet grew by 4 over the span and should say so');
  assert.ok(html.includes('Share price'));
});

test('one week away is not an absence', () => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(SAVE));
  store.set(seenKeyFor(null), '29');
  assert.equal(renderAway().trim(), '');
});

test('a save with no history renders nothing rather than an empty modal', () => {
  store.clear();
  const bare = { ...SAVE, financialHistory: [], statsHistory: [] };
  store.set('bbae_save_v2', JSON.stringify(bare));
  store.set(seenKeyFor(null), '18');
  assert.equal(renderAway(bare).trim(), '');
});

// ── The alliance dashboard ──────────────────────────────────────────────────

console.log('\n── Alliance dashboard ───────────────────────────────────');

const ALLIANCE = { id: 'sky', name: 'Skyline Pact', color: '#4fc3f7' };
const MEMBERS = [
  { id: 'r1', name: 'Alpha Air', homeHub: 'LHR', tier: 'legacy', human: true,
    marketCap: 90_000_000, cash: 25_000_000, baseQualityScore: 71,
    weeklyStats: { weeklyRevenue: 5_000_000, weeklyProfit: 700_000 },
    profitHistory: [600_000, 700_000],
    routes: { 'CDG-LHR': { frequency: 14 }, 'FRA-LHR': { frequency: 7 } }, cargoRoutes: {} },
  { id: 'r2', name: 'Beta Wings', homeHub: 'NRT', tier: 'premium', human: true,
    marketCap: 40_000_000, cash: 12_000_000, baseQualityScore: 66,
    weeklyStats: { weeklyRevenue: 2_500_000, weeklyProfit: -150_000 },
    profitHistory: [100_000, -150_000],
    routes: { 'JFK-LAX': { frequency: 7 }, 'NRT-SIN': { frequency: 7 } }, cargoRoutes: {} },
];
const DASH_STATE = {
  ...SAVE,
  routes: [{ origin: 'JFK', destination: 'LAX' }, { origin: 'JFK', destination: 'ORD' }],
  marketCap: 30_000_000,
  lastReport: { totalRevenue: 3_000_000 },
};

const renderDash = (props) => clean(renderToString(
  React.createElement(GameProvider, null,
    React.createElement(AllianceDashboard, { alliance: ALLIANCE, state: DASH_STATE, ...props }))));

test('the bloc renders as one network', () => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(DASH_STATE));
  const html = renderDash({ members: MEMBERS });
  assert.ok(html.includes('Skyline Pact'));
  assert.ok(html.includes('3 carriers'), 'you plus two partners');
  assert.ok(html.includes('Combined market cap'));
  assert.ok(html.includes('Airports reached'));
});

test('the reach partners add is the default view, and it is specific', () => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(DASH_STATE));
  const html = renderDash({ members: MEMBERS });
  // Alpha and Beta reach CDG, LHR, FRA, NRT, SIN — none of which you serve.
  for (const code of ['CDG', 'LHR', 'FRA', 'NRT', 'SIN']) {
    assert.ok(html.includes(`>${code}`), `${code} should be listed as reach the bloc adds`);
  }
  assert.ok(html.includes('Reach (5)'), 'the count should be on the tab');
});

test('overlap with a partner is counted, not hidden', () => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(DASH_STATE));
  const html = renderDash({ members: MEMBERS });
  // Beta flies JFK-LAX, and so do you.
  assert.ok(html.includes('Overlap (1)'), 'a partner competing with you should be surfaced');
});

test('a bloc of one is your own network, not a crash', () => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(DASH_STATE));
  const html = renderDash({ members: [] });
  assert.ok(html.includes('1 carrier'));
  assert.ok(html.includes('Reach (0)'));
});

test('no alliance renders nothing at all', () => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(DASH_STATE));
  const html = clean(renderToString(React.createElement(GameProvider, null,
    React.createElement(AllianceDashboard, { alliance: null, members: MEMBERS, state: DASH_STATE }))));
  assert.equal(html.trim(), '');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
