// Dashboard: compact profit waterfall (visual & engagement plan, 2026-11-05).
//
// "Where the money went" — route revenue, seven cost buckets, net cash — is
// Finance's Cost Bridge (engine utils/pnlBridge.js costBridge) folded into a
// few bars (src/utils/compactBridge.js). This proves the fold loses nothing:
// the walk lands on the bridge's net to the dollar, unknown rows go to Other,
// and the REAL Dashboard, server-rendered over states built by the REAL
// reducer, draws bars that end on the real cash change — the same figure the
// Weekly P&L card beside it shows.
//
//   node --import ./tools/_register-loader.mjs tools/compact-waterfall-test.mjs

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

console.log('\nDashboard: compact profit waterfall\n');

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


const { costBridge, bridgeInputsFromReport } = await import('../packages/engine/src/utils/pnlBridge.js');
const { compactWaterfall, projectedWaterfall, lastWeekWaterfall, COMPACT_BUCKETS } = await import('../src/utils/compactBridge.js');

// Every step the card drew: key → exact value, in order.
function steps(html) {
  const at = html.indexOf('Where the money went');
  if (at === -1) return null;
  const frag = html.slice(at, html.indexOf('Full cost bridge', at) + 1 || undefined);
  return [...frag.matchAll(/data-cwf-step="([^"]+)" data-cwf-value="(-?\d+)"/g)].map(m => [m[1], Number(m[2])]);
}

const base = tick(airline(), 3);

await test('1. the walk lands on the bridge\'s net cash to the dollar — this week and last', () => {
  for (const [label, wf, bridge] of [
    ['projected', projectedWaterfall(projectWeek(base), base), costBridge(projectWeek(base), base)],
    ['last week', lastWeekWaterfall(base), costBridge(bridgeInputsFromReport(base.lastReport), base)],
  ]) {
    assert.equal(Math.round(wf.walkEnd), Math.round(bridge.netProfit), `${label}: walk ${wf.walkEnd} vs net ${bridge.netProfit}`);
    assert.equal(wf.steps[0].value, bridge.rows.find(r => r.key === 'revenue').value, `${label}: starts at route revenue`);
    assert.equal(wf.steps.at(-1).value, bridge.netProfit, `${label}: ends at net cash`);
  }
  assert.equal(Math.round(lastWeekWaterfall(base).net), Math.round(base.lastReport.cashDelta), 'last week ends on the real cash change');
  assert.equal(Math.round(projectedWaterfall(projectWeek(base), base).net), Math.round(projectWeek(base).netCash), 'this week ends on the projection Finance shows');
});

await test('2. every bridge row lands in exactly one bucket; an unknown row goes to Other, not missing', () => {
  const keys = COMPACT_BUCKETS.flatMap(b => b.rows);
  assert.equal(new Set(keys).size, keys.length, 'no row in two buckets');
  const bridge = {
    revenue: 1000, netProfit: 1000 - 300 - 50 + 20,
    rows: [
      { key: 'revenue', value: 1000, kind: 'income' },
      { key: 'direct', value: -300, kind: 'cost' },
      { key: 'contribution', value: 700, kind: 'subtotal' },
      { key: 'brandNewCost', label: 'Something new', value: -50, kind: 'cost' },
      { key: 'partnerRev', value: 20, kind: 'income' },
      { key: 'net', value: 670, kind: 'total' },
    ],
  };
  const wf = compactWaterfall(bridge);
  assert.equal(wf.walkEnd, 670);
  const other = wf.steps.find(s => s.key === 'other');
  assert.equal(other.value, -30, 'partner +20 and the unknown −50');
  assert.ok(other.parts.some(p => p.key === 'brandNewCost'));
});

await test('3. Dashboard (SSR): the card draws last week by default, ending on the real cash change', () => {
  const st = steps(render(base));
  assert.ok(st, 'no "Where the money went" card on the Dashboard');
  assert.equal(st[0][0], 'revenue');
  assert.equal(st.at(-1)[0], 'net');
  assert.equal(st.at(-1)[1], Math.round(base.lastReport.cashDelta));
  const mid = st.slice(1, -1).reduce((s, [, v]) => s + v, 0);
  assert.ok(Math.abs(st[0][1] + mid - st.at(-1)[1]) <= st.length, 'bars add up (to rounding) to the net bar');
});

await test('4. Dashboard (SSR): before the first week it shows this week\'s projection', () => {
  const fresh = airline();
  assert.ok(!fresh.lastReport, 'fixture: no week run yet');
  const st = steps(render(fresh));
  assert.ok(st, 'card shown for a new airline with routes');
  assert.equal(st.at(-1)[1], Math.round(projectWeek(fresh).netCash));
});

await test('5. the card agrees with the Weekly P&L card\'s net cash beside it', () => {
  const html = render(base);
  const m = html.match(/data-pnl-col="lw" data-pnl-row="net" data-pnl-kind="total" data-pnl-exact="(-?[\d.]+)"/);
  assert.ok(m, 'Weekly P&L last-week net found');
  assert.equal(Math.round(Number(m[1])), steps(html).at(-1)[1]);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
