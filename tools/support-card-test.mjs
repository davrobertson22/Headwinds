// Render smoke test for the Ko-fi support card + season prompt (multiplayer).
//
//   node --import ./tools/_register-loader.mjs tools/support-card-test.mjs
//
// This is the money path and it keys off a /me payload whose shape is null at
// several stages of sign-in, so every face of it is rendered here: the ask, the
// supporter thank-you, the signed-out silence, and a browser whose localStorage
// throws. It also pins the two promises that must stay on the card itself
// rather than only on /support.html — that the badge is what you get, and that
// nothing bought touches the simulation. Those are the claims that keep this
// feature honest, and a copy edit should have to fail a test to remove them.
//
// Tailwinds has its own twin of this file for the solo card. They are separate
// because importing a component across the two repos loads a second copy of
// React and every hook call fails.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

// SSR shims. `store` is swapped per test to simulate a fresh browser, one that
// has already dismissed the card, and one where localStorage throws outright.
let store = new Map();
let throwOnStorage = false;
globalThis.window = globalThis.window ?? {};
const storage = {
  getItem: (k) => { if (throwOnStorage) throw new Error('SecurityError'); return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => { if (throwOnStorage) throw new Error('SecurityError'); store.set(k, String(v)); },
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.localStorage = storage;
globalThis.window.localStorage = storage;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const KOFI = 'https://ko-fi.com/E2V226S4CD';
const mod = await import('../apps/headwinds-web/src/SupportCard.jsx');
const SupportCard = mod.default;
const { SeasonSupportPrompt } = mod;
const me = (over = {}) => ({ account: { id: 'a1', displayName: 'Dave', ...over } });
const render = (el) => renderToString(el);

console.log('\n── the lobby card ────────────────────────────────────────');

test('asks a signed-in non-supporter, and links to Ko-fi', () => {
  store = new Map(); throwOnStorage = false;
  const html = render(React.createElement(SupportCard, { me: me() }));
  assert.ok(html.includes(KOFI), 'Ko-fi link missing');
});

test('names the badge as the perk', () => {
  store = new Map();
  const html = render(React.createElement(SupportCard, { me: me() }));
  assert.ok(/SUPPORTER badge/i.test(html), 'the badge is the perk — it should be named on the card');
});

test('promises on the card that nothing bought affects the game', () => {
  store = new Map();
  const html = render(React.createElement(SupportCard, { me: me() }));
  assert.ok(/no cash, no gates, no speed/i.test(html),
    'the no-pay-to-win promise must live on the card, not only on /support.html');
});

test('thanks a supporter instead of asking again', () => {
  store = new Map();
  const html = render(React.createElement(SupportCard, { me: me({ isSupporter: true }) }));
  assert.ok(/thank you/i.test(html), 'a supporter should get the thank-you face');
  assert.ok(!/Not now/.test(html), 'the thank-you is not a dismissible ask');
});

test('says nothing at all when signed out', () => {
  store = new Map();
  assert.equal(render(React.createElement(SupportCard, { me: null })), '');
  assert.equal(render(React.createElement(SupportCard, { me: {} })), '');
});

test('honours a dismissal, and lets it expire after 30 days', () => {
  store = new Map([['hw.support.dismissedAt', String(Date.now())]]);
  assert.equal(render(React.createElement(SupportCard, { me: me() })), '', 'a fresh dismissal should hide it');
  store = new Map([['hw.support.dismissedAt', String(Date.now() - 31 * 24 * 3600 * 1000)]]);
  assert.ok(render(React.createElement(SupportCard, { me: me() })).includes(KOFI), 'a 31-day-old dismissal should have expired');
});

test('renders when localStorage throws (private window)', () => {
  store = new Map(); throwOnStorage = true;
  assert.ok(render(React.createElement(SupportCard, { me: me() })).includes(KOFI));
  throwOnStorage = false;
});

console.log('\n── the season-end prompt ─────────────────────────────────');

test('asks a player who just finished a season', () => {
  store = new Map();
  assert.ok(render(React.createElement(SeasonSupportPrompt, { me: me() })).includes(KOFI));
});

test('never asks a supporter, or a signed-out visitor browsing a dead world', () => {
  store = new Map();
  assert.equal(render(React.createElement(SeasonSupportPrompt, { me: me({ isSupporter: true }) })), '');
  assert.equal(render(React.createElement(SeasonSupportPrompt, { me: null })), '');
});

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
