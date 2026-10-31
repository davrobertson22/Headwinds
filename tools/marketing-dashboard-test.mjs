// The Dashboard shows what brand marketing costs each week (Discord:
// VodkaOnFire, on Barca's "% of revenue" thread — "it could be nice to display
// it on the dashboard so you know how much you are spending, since it grows
// really quickly").
//
// Server-renders the REAL Dashboard over states produced by the REAL reducer
// and reads the tile back out of the markup. Expected figures come from the
// engine's own projection and report, never from the component's helper.
//
//   node --import ./tools/_register-loader.mjs tools/marketing-dashboard-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
window.dispatchEvent = () => true;
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
globalThis.matchMedia = window.matchMedia;
globalThis.CustomEvent = globalThis.CustomEvent ?? class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
window.localStorage = globalThis.localStorage;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

let x = 4242;
Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { projectWeek } = await import('../packages/engine/src/utils/financeProjection.js');
const { defaultClassPrices, formatMoney } = await import('../packages/engine/src/utils/simulation.js');
const { referencePrice } = await import('../packages/engine/src/utils/market.js');
const { getAircraftType } = await import('../src/data/aircraft.js');
const { GameProvider } = await import('../src/store/GameContext.jsx');
const Dashboard = (await import('../src/components/Dashboard.jsx')).default;

console.log('\nDashboard: brand marketing tile\n');

const render = (state) => {
  store.set('bbae_save_v2', JSON.stringify(state));
  return renderToString(React.createElement(GameProvider, null, React.createElement(Dashboard)));
};

const DESTS = ['ORD', 'LAX', 'MIA', 'BOS'];
function airline() {
  let s = gameReducer(freshState(),
    { type: 'START_GAME', airlineName: 'Probe Air', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 5e9 };
  for (let i = 0; i < 6; i++) s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'JFK' });
  for (const d of DESTS) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
    const ac = s.fleet[s.fleet.length - 1].id;
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: d });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac, origin: 'JFK', destination: d, weeklyFrequency: 21 });
  }
  const routePricing = { ...s.routePricing };
  for (const d of DESTS) {
    routePricing[['JFK', d].sort().join('-')] = defaultClassPrices(Math.round(referencePrice('JFK', d) * 1.1));
  }
  return {
    ...s, routePricing,
    fleet: s.fleet.map(a => ({ ...a, config: { ...a.config, economy: getAircraftType(a.typeId).seats } })),
  };
}
const tick = (s, n = 1) => { for (let i = 0; i < n; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' }); return s; };

function tile(html) {
  const at = html.indexOf('data-kpi="brand-marketing"');
  if (at === -1) return null;
  const open = html.lastIndexOf('<div', at);
  let depth = 0, i = open;
  while (i < html.length) {
    const o = html.indexOf('<div', i + 1), c = html.indexOf('</div>', i + 1);
    if (o !== -1 && o < c) { depth++; i = o; } else if (depth === 0) { i = c + 6; break; } else { depth--; i = c; }
  }
  const frag = html.slice(open, i);
  const exact = frag.match(/data-kpi-exact="([^"]*)"/);
  const text = frag.replace(/<!-- -->/g, '').replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
  return { exact: exact ? Number(exact[1]) : null, text };
}

const base = tick(airline(), 1);

await test('1. % mode: the tile shows this week\'s brand spend — the engine\'s pct × projected revenue', () => {
  let s = gameReducer(base, { type: 'SET_MARKETING_PCT', pct: 0.04 });
  s = tick(s, 1);
  const rep = projectWeek(s).report;
  assert.ok(rep.brandMarketingSpend > 0, 'fixture: the projection has a brand spend');
  assert.equal(rep.brandMarketingSpend, Math.round(0.04 * rep.totalRevenue), 'fixture: engine charges 4% of its revenue');
  const t = tile(render(s));
  assert.ok(t, 'no brand marketing tile on the Dashboard');
  assert.equal(t.exact, rep.brandMarketingSpend, 'tile figure is the engine\'s projected brand spend');
  assert.ok(t.text.includes(formatMoney(rep.brandMarketingSpend)), `tile text: ${t.text}`);
  assert.ok(t.text.includes('4% of revenue'), `share not shown: ${t.text}`);
  assert.ok(t.text.includes(`${formatMoney(s.lastReport.brandMarketingSpend)} last wk`), `last week's spend not shown: ${t.text}`);
});

await test('2. fixed $: the tile shows the budget, says it is fixed, and what share of revenue that is', () => {
  const s = gameReducer(base, { type: 'SET_MARKETING_BUDGET', amount: 50_000 });
  const rep = projectWeek(s).report;
  const t = tile(render(s));
  assert.ok(t, 'no tile with a fixed budget');
  assert.equal(t.exact, 50_000);
  assert.ok(/\bfixed\b/.test(t.text), `fixed mode not named: ${t.text}`);
  const share = `${+((50_000 / rep.totalRevenue) * 100).toFixed(1)}% of revenue`;
  assert.ok(t.text.includes(share), `expected "${share}" in: ${t.text}`);
});

await test('3. targeted campaigns are named separately, not folded into the brand figure', () => {
  let s = gameReducer(base, { type: 'SET_MARKETING_PCT', pct: 0.02 });
  s = gameReducer(s, { type: 'SET_TARGETED_MARKETING', airport: 'ORD', amount: 20_000 });
  const rep = projectWeek(s).report;
  const t = tile(render(s));
  assert.ok(t, 'no tile');
  assert.equal(t.exact, rep.brandMarketingSpend, 'brand only');
  assert.ok(t.text.includes(`+${formatMoney(20_000)} campaigns`), `campaigns not shown: ${t.text}`);
});

await test('4. no marketing at all: no tile', () => {
  let s = gameReducer(base, { type: 'SET_MARKETING_BUDGET', amount: 0 });
  s = { ...s, targetedMarketing: {} };
  assert.equal(tile(render(s)), null);
});

await test('5. 0% held is still shown (it is a choice, and the next week will say so)', () => {
  const s = gameReducer(base, { type: 'SET_MARKETING_PCT', pct: 0 });
  const t = tile(render(s));
  assert.ok(t, 'pinned at 0%: tile hidden');
  assert.ok(t.text.includes('0% of revenue'), t.text);
});

await test('6. clicking it lands on Marketing in the map view, Crew otherwise', async () => {
  const { resolveMapPage } = await import('../src/components/MapShell.jsx');
  const { requestNav, consumeNavFilter } = await import('../src/utils/navIntent.js');
  requestNav('operations', { filter: { section: 'marketing' }, focus: 'marketing-budget' });
  assert.equal(resolveMapPage('operations'), 'marketing');
  assert.deepEqual(consumeNavFilter('operations'), { section: 'marketing' });
  assert.equal(resolveMapPage('operations'), 'operations', 'a later plain visit is not redirected');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
