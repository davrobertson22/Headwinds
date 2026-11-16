// Back to the previous screen (src/utils/pageHistory.js). Discord
// (Nilla_wafer, 2026-11-14): "Just a back button." VodkaOnFire: "And/or a way
// to hotkey it could be absolute fire".
//
// Kept identical in Headwinds and Tailwinds.
//
//   node --import ./tools/_register-loader.mjs tools/page-history-test.mjs

import assert from 'node:assert/strict';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const store = new Map();
globalThis.window = globalThis.window ?? {};
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = window.matchMedia;
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.dispatchEvent = () => true;
window.innerWidth = 1440; window.innerHeight = 900;
globalThis.CustomEvent = globalThis.CustomEvent ?? class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const H = await import('../src/utils/pageHistory.js').catch(() => null);
const need = () => assert.ok(H, 'src/utils/pageHistory.js does not exist');

console.log('\nBack to the previous screen\n');

// Drive the history the way the hook does: one render per page shown.
function session(first, resetKey = 'classic|playing') {
  let hist = { prev: first, stack: [], reset: resetKey };
  let tab = first;
  return {
    show(next, key = hist.reset) { tab = next; hist = H.advanceHistory(hist, tab, key) ?? hist; return this; },
    back(isValid) { const b = H.backHistory(hist, tab, isValid); if (!b) return null; hist = b.hist; tab = b.target; return tab; },
    get tab() { return tab; },
  };
}

await test('Back retraces the pages opened, newest first, then stops', () => {
  need();
  const s = session('dashboard').show('fleet').show('market').show('routes');
  assert.equal(s.back(), 'market');
  assert.equal(s.back(), 'fleet');
  assert.equal(s.back(), 'dashboard');
  assert.equal(s.back(), null, 'nothing left: Back does nothing (never leaves the site)');
  assert.equal(s.tab, 'dashboard');
});

await test('opening a page after going back continues from there', () => {
  need();
  const s = session('dashboard').show('fleet').show('market');
  assert.equal(s.back(), 'fleet');
  s.show('finance');
  assert.equal(s.back(), 'fleet');
  assert.equal(s.back(), 'dashboard');
});

await test('map view: the map itself is a step, so Back from a page can land on it', () => {
  need();
  const s = session('map', 'map|playing').show('fleet').show('map').show('routes');
  assert.equal(s.back(), 'map');
  assert.equal(s.back(), 'fleet');
  assert.equal(s.back(), 'map');
});

await test('switching layout or leaving the game starts over', () => {
  need();
  const s = session('dashboard').show('fleet');
  s.show('map', 'map|playing');
  assert.equal(s.back(), null, 'classic page ids mean nothing in the map view');
});

await test('a page that has gone is skipped', () => {
  need();
  const s = session('dashboard').show('partners').show('fleet');
  assert.equal(s.back((id) => id !== 'partners'), 'dashboard');
});

await test('the same page twice in a row is one step; the history is capped', () => {
  need();
  assert.deepEqual(H.pushPage(['a', 'b'], 'b'), ['a', 'b']);
  let st = [];
  for (let i = 0; i < H.HISTORY_LIMIT + 20; i++) st = H.pushPage(st, `p${i}`);
  assert.equal(st.length, H.HISTORY_LIMIT);
  assert.equal(st[st.length - 1], `p${H.HISTORY_LIMIT + 19}`, 'the oldest are dropped, not the newest');
});

await test('B is the Back key — not while typing, not with a modifier, not on repeat', () => {
  need();
  const press = (over = {}) => ({ key: 'b', code: 'KeyB', target: { tagName: 'BODY' }, ...over });
  assert.equal(H.isBackKey(press()), true);
  assert.equal(H.isBackKey(press({ key: 'и' })), true, 'Cyrillic layout: the physical B key');
  assert.equal(H.isBackKey(press({ key: 'n', code: 'KeyN' })), false);
  for (const mod of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey', 'repeat', 'defaultPrevented']) {
    assert.equal(H.isBackKey(press({ [mod]: true })), false, mod);
  }
  for (const target of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(H.isBackKey(press({ target })), false, JSON.stringify(target));
  }
});

// ── The real screens carry the button ────────────────────────────────────────
const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { default: App } = await import('../src/App.jsx');
const GC = await import('../src/store/GameContext.jsx');
const { LAYOUT_KEY } = await import('../src/components/MapShell.jsx');
function Hydrated({ children }) {
  if (!GC.GameContext) return children;
  const ctx = React.useContext(GC.GameContext);
  return React.createElement(GC.GameContext.Provider, { value: { ...ctx, hydrated: true } }, children);
}
store.set('bbae_save_v2', JSON.stringify({
  ...GC.freshState(), phase: 'playing', week: 5, year: 1, hub: 'SFO', cash: 12_345_678, airlineName: 'Pacific Gold',
  hubs: { SFO: { tier: 1, tierSince: 0 } }, gates: { SFO: 4 },
}));
store.set('bbae_tour_seen_v3', '1');
const render = () => renderToString(React.createElement(GC.GameProvider, null,
  React.createElement(Hydrated, null, React.createElement(App)))).replaceAll('<!-- -->', '').replaceAll('&#x27;', "'");
const tag = (html, sel) => (new RegExp(`<[^>]*${sel}[^>]*>`).exec(html) ?? [''])[0];

await test('classic: a Back button leads the nav bar, disabled until there is somewhere to go', () => {
  store.set(LAYOUT_KEY, 'classic');
  const html = render();
  const btn = tag(html, 'data-nav-back');
  assert.ok(btn, 'no Back button in the classic nav bar');
  assert.match(btn, /disabled/);
  assert.ok(html.indexOf('data-nav-back') < html.indexOf('data-nav-key="1"'), 'Back sits before tab 1');
});

await test('map view: the Settings key list names B', async () => {
  store.set(LAYOUT_KEY, 'map');
  const html = render();
  assert.ok(html.includes('ms-root'), 'map view rendered');
  const src = (await import('node:fs')).readFileSync(new URL('../src/components/MapShell.jsx', import.meta.url), 'utf8');
  assert.match(src, /data-nav-back/, 'the panel header has a Back button');
  assert.match(src, /<kbd>B<\/kbd> back/, 'the Settings key list names B');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
