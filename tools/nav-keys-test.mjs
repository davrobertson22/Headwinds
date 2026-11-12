// Number keys for the main pages (src/utils/navKeys.js). Discord (Xen,
// 2026-11-12): "Just as you can use the 'Del' key to clear pop-ups, you could
// also assign keys such as: 1 for the Dashboard, 2 for Search, 3 for Network,
// and so on, and, for example, 0 for Settings."
//
// Kept identical in Headwinds and Tailwinds.
//
//   node --import ./tools/_register-loader.mjs tools/nav-keys-test.mjs

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

const K = await import('../src/utils/navKeys.js').catch(() => null);
const need = () => assert.ok(K, 'src/utils/navKeys.js does not exist');

console.log('\nNumber keys for the main pages\n');

// ── 1. Which key presses count ───────────────────────────────────────────────
const press = (over = {}) => ({ key: '3', code: 'Digit3', target: { tagName: 'BODY' }, ...over });

await test('the number row and the keypad both count', () => {
  need();
  assert.equal(K.navDigit(press()), '3');
  assert.equal(K.navDigit(press({ key: '7', code: 'Numpad7' })), '7');
  assert.equal(K.navDigit(press({ key: '0', code: 'Digit0' })), '0');
});

await test('AZERTY: the unshifted number-row key counts (it types "&", not "1")', () => {
  need();
  assert.equal(K.navDigit(press({ key: '&', code: 'Digit1' })), '1');
  assert.equal(K.navDigit(press({ key: '1', code: 'Digit1', shiftKey: true })), '1', 'Shift+& is 1 on AZERTY');
  assert.equal(K.navDigit(press({ key: '!', code: 'Digit1', shiftKey: true })), null, 'Shift+1 on US is "!"');
});

await test('not while typing, not with Cmd/Ctrl/Alt, not on auto-repeat', () => {
  need();
  for (const target of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT', type: 'number' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(K.navDigit(press({ target })), null, JSON.stringify(target));
  }
  assert.equal(K.navDigit(press({ target: { tagName: 'INPUT', type: 'checkbox' } })), '3', 'a ticked box is not typing');
  for (const mod of ['metaKey', 'ctrlKey', 'altKey', 'repeat', 'defaultPrevented']) {
    assert.equal(K.navDigit(press({ [mod]: true })), null, mod);
  }
  assert.equal(K.navDigit(press({ key: 'a', code: 'KeyA' })), null);
});

// ── 2. Numbers and cycling ───────────────────────────────────────────────────
await test("map view: Xen's numbering — 1 Dashboard, 2 Search, 3 Network … 0 Settings", async () => {
  need();
  const { MAP_GROUPS } = await import('../src/components/MapShell.jsx');
  const byKey = Object.fromEntries(MAP_GROUPS.map((g, i) => [K.mapGroupKey(i), g.id]));
  assert.equal(K.MAP_KEY_DASHBOARD, '1');
  assert.equal(byKey['2'], 'search');
  assert.equal(byKey['3'], 'network');
  assert.equal(byKey['4'], 'fleet');
  assert.equal(byKey['8'], 'finance');
  assert.equal(MAP_GROUPS.length, 7, 'seven dock groups fit 2–8');
  assert.equal(K.MAP_KEY_GUIDE, '9');
  assert.equal(K.MAP_KEY_SETTINGS, '0');
});

await test('a group key again moves to its next page, and wraps', () => {
  need();
  const p = ['routes', 'airports', 'hubs'];
  assert.equal(K.cyclePage(p, null), 'routes');
  assert.equal(K.cyclePage(p, 'routes'), 'airports');
  assert.equal(K.cyclePage(p, 'hubs'), 'routes');
  assert.equal(K.cyclePage(p, 'finance'), 'routes', 'from another group: its first page');
  assert.equal(K.cyclePage([], 'x'), null);
});

// ── 3. Not through a dialog ──────────────────────────────────────────────────
await test('a key acts only when its button could be clicked', () => {
  need();
  const btn = { getBoundingClientRect: () => ({ left: 100, top: 800, width: 60, height: 40 }), contains: (n) => n === inner };
  const inner = { closest: () => null };
  const overlay = { closest: () => null };
  const menuBackdrop = { closest: (sel) => (sel.includes('.ms-menu-backdrop') ? menuBackdrop : null) };
  const doc = (hit, modal = false) => ({ querySelector: () => (modal ? {} : null), elementFromPoint: () => hit });
  globalThis.document = doc(inner);
  assert.equal(K.reachable(btn), true, 'nothing on top');
  globalThis.document = doc(overlay);
  assert.equal(K.reachable(btn), false, 'a checkout or debrief covers the dock');
  globalThis.document = doc(menuBackdrop);
  assert.equal(K.reachable(btn), true, 'an open dropdown just closes');
  globalThis.document = doc(inner, true);
  assert.equal(K.reachable(btn), false, 'a confirm or the alert settings is open');
  delete globalThis.document;
});

// ── 4. The real screens say which key is which ───────────────────────────────
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
const attr = (html, sel) => (new RegExp(`<[^>]*${sel}[^>]*>`).exec(html) ?? [''])[0];

await test('map view: every dock button, the Dashboard, Guide and Settings show their key', () => {
  store.set(LAYOUT_KEY, 'map');
  const html = render();
  assert.ok(html.includes('ms-root'), 'map view rendered');
  assert.match(attr(html, 'data-shell="dashboard"'), /\(key 1\)/);
  assert.match(attr(html, 'data-shell="group:search"'), /\(key 2\)/);
  assert.match(attr(html, 'data-shell="group:network"'), /\(key 3\)/);
  assert.match(attr(html, 'data-shell="group:finance"'), /\(key 8\)/);
  assert.match(attr(html, 'data-shell="wiki"'), /\(key 9\)/);
  assert.match(attr(html, 'data-shell="settings"'), /\(key 0\)/);
});

await test('classic: the nav bar is numbered 1, 2, 3 … left to right', () => {
  store.set(LAYOUT_KEY, 'classic');
  const html = render();
  const keys = [...html.matchAll(/data-nav-key="(\d)"/g)].map(m => m[1]);
  assert.ok(keys.length >= 7, `numbered tabs: ${keys.join(',')}`);
  assert.deepEqual(keys, keys.map((_, i) => String(i + 1)));
  assert.match(attr(html, 'data-nav-key="1"'), /Dashboard \(key 1\)/);
  assert.match(html, /Pop-up alerts[^"]*key 0/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
