// Server-renders the REAL Operations screen with brand marketing pinned to a
// share of revenue — the UI half of tools/marketing-pct-test.mjs.
//
//   1. Fixed mode looks as before, with a mode switch offered.
//   2. % mode shows the pinned share, the % presets and the ≈ weekly figure
//      computed as pct × last week's revenue (the tick charges pct × that
//      week's revenue — the closest honest preview).
//   3. The awareness preview runs on the effective spend, not the stale $.
//
//   node --import ./tools/_register-loader.mjs tools/marketing-pct-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { formatMoney } from '../src/utils/simulation.js';
import { marketingAwarenessGain } from '../src/data/overhead.js';

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

console.log('\nBrand marketing % of revenue — Operations renders it\n');

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Operations = (await import('../src/components/Operations.jsx')).default;

const REVENUE = 8_000_000;
function seed(extra = {}) {
  const save = {
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 100_000_000,
    awareness: 30, marketingBudget: 50_000,
    lastReport: { totalRevenue: REVENUE, totalPassengers: 40_000 },
    ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
}
const render = () => renderToString(React.createElement(GameProvider, null, React.createElement(Operations))).replace(/<!--.*?-->/g, '');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('fixed mode: the $ figure, and both mode buttons', () => {
  seed();
  const t = text(render());
  assert.match(t, /Fixed \$\/wk/);
  assert.match(t, /% of revenue/);
  assert.ok(t.includes(`−${formatMoney(50_000)}/wk`), 'shows the fixed weekly spend');
  assert.ok(!/resized every week/.test(t), 'no % wording in fixed mode');
  assert.match(t, /0\.6%/, '50k of 8M = 0.6% in the share cell');
});

test('% mode: the pinned share, the ≈ weekly figure, the % presets', () => {
  seed({ marketingPctOfRevenue: 0.04 });
  const html = render();
  const t = text(html);
  const est = Math.round(0.04 * REVENUE);
  assert.ok(t.includes(`≈−${formatMoney(est)}/wk`), `≈ pct × last week's revenue (${formatMoney(est)})`);
  assert.match(t, /4% of revenue · resized every week/);
  assert.match(t, /4% held/);
  for (const p of ['0.5%', '1%', '2%', '6%', '8%']) assert.ok(t.includes(p), `preset ${p}`);
  assert.match(html, /aria-label="Brand spend as % of revenue"/);
});

test('% mode: the awareness preview uses the effective spend, not the stale $', () => {
  seed({ marketingPctOfRevenue: 0.04 });
  const t = text(render());
  const gain = marketingAwarenessGain(Math.round(0.04 * REVENUE), REVENUE) * (1 - 30 / 100);
  const fmt = v => (Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));
  assert.ok(t.includes(`+${fmt(gain)} awareness/wk from spend`), `expects +${fmt(gain)}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
