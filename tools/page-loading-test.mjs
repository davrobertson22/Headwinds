// Pages load on first open, and long lists build a slice per frame.
//
//   node --import ./tools/_register-loader.mjs tools/page-loading-test.mjs
//
// 2026-11-05, measured in headless Chromium on a 600-route / 600-tail airline:
//   - every page sat in the one start-up script (3.2 MB); the Dashboard waited
//     on the Market, the Rivals tab and the Wiki to download and compile;
//   - opening the Market built ~200 aircraft cards and fetched ~200 photos in
//     one go (1.8 s of main thread, a 229 ms longest task), the Fleet 600 rows
//     in one 195 ms task.
// Also: a page that loaded while open must keep its state across a re-render
// (a version that switched tree shape after loading remounted the Fleet page
// on the next rival poll and wiped the search box — caught in the browser).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const { lazyPage, preloadPages } = await import('../src/utils/lazyPage.jsx');
const { useProgressiveCount } = await import('../src/utils/useProgressiveCount.js');

console.log('\nPage loading\n');

await test('a page not loaded yet renders its placeholder; once loaded it renders synchronously', async () => {
  let loads = 0;
  const Hello = lazyPage(async () => { loads++; return { default: ({ who }) => React.createElement('b', null, `hello ${who}`) }; }, 'Hello');
  assert.match(renderToString(React.createElement(Hello, { who: 'a' })), /Loading…/);
  await preloadPages();
  assert.match(renderToString(React.createElement(Hello, { who: 'b' })), /<b>hello b<\/b>/);
  assert.equal(loads, 1, 'the code is fetched once');
});

await test('a page always renders the same tree shape (no remount when its code arrives)', () => {
  const s = src('../src/utils/lazyPage.jsx');
  const body = s.slice(s.indexOf('function Page(props)'), s.indexOf('Page.displayName'));
  assert.doesNotMatch(body, /\bif\s*\(/, 'Page must not branch between two shapes');
  assert.match(body, /<Suspense fallback=\{.*\}>\s*<Lazy \{\.\.\.props\} \/>\s*<\/Suspense>/s);
});

await test('the start-up script keeps only the Dashboard, the map and Finance; other pages are split', () => {
  const app = src('../src/App.jsx');
  for (const p of ['Fleet', 'Routes', 'Marketplace', 'Competition', 'StockMarket', 'News', 'UsedMarket', 'RoutePlanner',
    'RouteFinderScreen', 'Airports', 'Operations', 'Maintenance', 'Ancillaries', 'Loyalty', 'Partnerships', 'Alliances',
    'Wiki', 'HubManagement', 'Reputation']) {
    assert.match(app, new RegExp(`const ${p} = lazyPage\\(\\(\\) => import\\('\\./components/${p}\\.jsx'\\)`), p);
    assert.doesNotMatch(app, new RegExp(`^import ${p} from`, 'm'), `${p} is still imported eagerly`);
  }
  assert.match(app, /^import Dashboard from '\.\/components\/Dashboard\.jsx';/m);
  assert.match(app, /useEffect\(\(\) => \{ preloadPagesWhenIdle\(\); \}, \[\]\);/);
});

// ── useProgressiveCount ──────────────────────────────────────────────────────
function Probe({ total, opts }) {
  const n = useProgressiveCount(total, opts);
  return React.createElement('i', null, String(n));
}
const shown = (total, opts) => Number(renderToString(React.createElement(Probe, { total, opts })).replace(/<[^>]+>/g, ''));

await test('off the browser (server rendering, these tests) the whole list renders', () => {
  assert.equal(shown(600, { first: 60 }), 600);
});

await test('in a browser the first frame renders only the first slice', () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
  globalThis.document = { createElement() {} };
  try {
    assert.equal(shown(600, { first: 60 }), 60);
    assert.equal(shown(20, { first: 60 }), 20);
  } finally { globalThis.window = saved.window; globalThis.document = saved.document; }
});

await test('the Market and Fleet render through it, and photos load lazily', () => {
  const m = src('../src/components/Marketplace.jsx'), f = src('../src/components/Fleet.jsx');
  assert.match(m, /filtered\.slice\(0, shownCards\)\.map\(type =>/);
  assert.match(m, /className="aircraft-photo"\s*\n\s*loading="lazy"/);
  // Short fleets still build progressively; past 150 rows the list is windowed
  // instead (fleet-window-test.mjs).
  assert.match(f, /: sortedFleet\.slice\(0, shownRows\)\)\.map\(aircraft =>/);
  assert.equal((f.match(/loading="lazy" decoding="async"/g) ?? []).length, 2);
  // The hook sits above the Fleet's early return (rules of hooks).
  assert.ok(f.indexOf('const shownRows = useProgressiveCount(') < f.indexOf('if (fleet.length === 0 && pendingOrders.length === 0) {'));
});

console.log(`\npage-loading-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
