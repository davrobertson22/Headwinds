// React SSR smoke test for the Headwinds web client (apps/headwinds-web).
//
// Server-renders the REAL App via the repo's JSX loader — no vite, no browser.
// Catches render-time crashes: bad hooks, undefined imports, JSX mistakes, and
// breakage of the @tailwinds/engine airport import the hub picker relies on.
//
//   node --import ./tools/_register-loader.mjs tools/headwinds-web-smoke-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

// ── Browser shims (SSR: effects don't run, but initializers touch these) ─────
globalThis.window = globalThis.window ?? {};
window.location = window.location ?? { hash: '', origin: 'http://localhost:5173' };
window.addEventListener = window.addEventListener ?? (() => {});
window.removeEventListener = window.removeEventListener ?? (() => {});
globalThis.fetch = globalThis.fetch ?? (() => Promise.reject(new Error('no network in SSR')));

const { default: App } = await import('../apps/headwinds-web/src/App.jsx');
const { AIRPORTS } = await import('../packages/engine/src/data/airports.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

console.log('\n── Headwinds web client SSR smoke ───────────────────────');

test('engine airports import works and has picker fields', () => {
  assert.ok(AIRPORTS.length > 100, 'expected a real airport list');
  assert.ok(AIRPORTS[0].code && AIRPORTS[0].city, 'hub picker needs code + city');
});

test('worlds screen renders (unconfigured → setup notice + world list shell)', () => {
  window.location.hash = '#/';
  const html = renderToString(React.createElement(App));
  assert.ok(html.includes('HEADWINDS'), 'brand header');
  assert.ok(html.includes('Setup needed'), 'setup notice when Supabase env is absent');
  assert.ok(html.includes('Open worlds'), 'world list section');
});

test('world detail route renders its loading state', () => {
  window.location.hash = '#/w/test-world-id';
  const html = renderToString(React.createElement(App));
  assert.ok(html.includes('Loading world'), 'world screen loading state');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
