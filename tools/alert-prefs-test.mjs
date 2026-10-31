// Pop-up alerts: clear all, the Delete key, and choosing which ones show.
//
// Discord, 2026-10-30 (tagged tailwinds): a button — "perhaps the Del key" — to
// close every pop-up at once, and "just a toggle to hide them all permanently
// or choose which ones to show. In later games, there's just so many alerts".
//
// Identical in Tailwinds and Headwinds. Covers:
//   1. the category of every pop-up title the engine can produce (scraped from
//      the source, so a NEW pop-up with no category fails here);
//   2. the filter: only weekly pop-ups can be hidden, save problems never;
//   3. stored settings, junk included;
//   4. the batch tagging App.jsx uses (weekly = arrived with a new week);
//   5. the REAL toast stack, settings panel and App chrome, SSR-rendered.
//
//   node --import ./tools/_register-loader.mjs tools/alert-prefs-test.mjs

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.document = globalThis.document ?? { addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, body: {} };

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

const A = await import('../src/utils/alertPrefs.js');
const TS = await import('../src/components/ToastSystem.jsx');
const strip = (h) => h.replace(/<!-- -->/g, '');

console.log('\nPop-up alerts\n');
console.log('── 1. Categories ──');

const CASES = [
  ['Mechanical Failure: Boeing 747-8F #22', 'maintenance'],
  ['☠️ Written off — A320 #3', 'maintenance'],
  ['✅ C check complete — A320 #3', 'maintenance'],
  ['🛡️ Reserve dispatched — 737 #9', 'maintenance'],
  ['Aircraft Delivered: A350-900 #4', 'fleet'],
  ['⏳ Lease expiring — 737 #2', 'fleet'],
  ['🔁 3 leases auto-renewed', 'fleet'],
  ['📏 2 routes are out of range', 'fleet'],
  ['SkyLink entered JFK–LHR', 'rivals'],
  ['🔥 Fare War — SkyLink', 'rivals'],
  ['Codeshare Expired — SkyLink', 'rivals'],
  ['⚠️ Cash Warning: 3 Weeks Negative', 'finance'],
  ['🚨 Missed Loan Payment (2/3)', 'finance'],
  ['Dividend paid', 'finance'],
  ['🛋 Lounge open — DXB', 'operations'],
  ['STRIKE — Pilots walk out', 'operations'],
  ['🔨 Auction won', 'operations'],
  ['🏗️ Hub Complete — DXB', 'operations'],
  ['🏅 Objective Complete — First 10 routes', 'events'],
  ['Volcanic Ash Cloud — ended', 'events'],
  ['⚠ Your game is not being saved', 'system'],
];
test('known titles land in the right category', () => {
  for (const [title, want] of CASES) assert.equal(A.alertCategory({ title }), want, title);
});
test('a random world event (it carries its own colour) is an event, whatever its name', () => {
  assert.equal(A.alertCategory({ title: 'Pilot Strike Across Europe', eventColor: '#f00' }), 'events');
});

// Every title the engine can put on a pop-up. Template holes become their
// `?? 'fallback'` text when there is one, else "X".
const ENGINE = ['packages/engine/src/reducer.mjs', 'src/store/GameContext.jsx']
  .map(p => join(ROOT, p)).filter(existsSync);
function engineTitles() {
  const out = new Set();
  for (const f of ENGINE) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\btitle:\s*([^\n]+)/g)) {
      // Only the title: cut at the next key on the same line (message, icon…).
      const expr = m[1].split(/,\s*[a-zA-Z]+\s*:/)[0];
      for (const s of expr.matchAll(/`((?:[^`\\]|\\.)*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
        let t = s[1] ?? s[2] ?? s[3] ?? '';
        t = t.replace(/\$\{[^}]*\?\?\s*'([^']*)'[^}]*\}/g, '$1').replace(/\$\{[^}]*\}/g, 'X');
        t = t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        if (/[A-Za-z]{3}/.test(t) && !/^[a-z]+$/.test(t)) out.add(t.trim());
      }
    }
  }
  return [...out];
}
test('the engine source was found and has pop-ups in it', () => {
  assert.ok(ENGINE.length > 0, 'no engine file found');
  assert.ok(engineTitles().length > 60, `only ${engineTitles().length} titles scraped`);
});
test('every engine pop-up title has a category (none fall into "Everything else")', () => {
  const orphans = engineTitles().filter(t => A.alertCategory({ title: t }) === 'other');
  assert.deepEqual(orphans, [], 'add a rule in src/utils/alertPrefs.js for these titles');
});

console.log('── 2. The filter ──');

const failure = { title: 'Mechanical Failure: A320 #1', alert: true };
const refusal = { title: 'Not enough cash', type: 'danger' };
test('default settings show everything', () => {
  assert.equal(A.shouldShowToast(failure, A.DEFAULT_ALERT_PREFS), true);
});
test('switching a category off hides only that kind of weekly pop-up', () => {
  const p = { showAlerts: true, hidden: { maintenance: true } };
  assert.equal(A.shouldShowToast(failure, p), false);
  assert.equal(A.shouldShowToast({ title: 'Aircraft Delivered: A320 #2', alert: true }, p), true);
});
test('the master switch hides every weekly pop-up', () => {
  const p = { showAlerts: false, hidden: {} };
  assert.equal(A.shouldShowToast(failure, p), false);
  assert.equal(A.shouldShowToast({ title: 'Fare War — X', alert: true }, p), false);
});
test('a pop-up about the player\'s own action always shows', () => {
  assert.equal(A.shouldShowToast(refusal, { showAlerts: false, hidden: { finance: true } }), true);
});
test('a save problem always shows, even weekly, even with everything off', () => {
  assert.equal(A.shouldShowToast({ title: '⚠ Your game is not being saved', alert: true }, { showAlerts: false, hidden: {} }), true);
});

console.log('── 3. Stored settings ──');

test('round-trip through localStorage', () => {
  store.clear();
  A.saveAlertPrefs({ showAlerts: true, hidden: { rivals: true } });
  assert.deepEqual(A.loadAlertPrefs(), { showAlerts: true, hidden: { rivals: true } });
});
test('junk falls back to defaults; unknown categories are dropped', () => {
  store.clear();
  store.set(A.ALERT_PREFS_KEY, '{not json');
  assert.deepEqual(A.loadAlertPrefs(), { showAlerts: true, hidden: {} });
  store.set(A.ALERT_PREFS_KEY, JSON.stringify({ showAlerts: 'yes', hidden: { nope: true, fleet: 'true', finance: true } }));
  assert.deepEqual(A.loadAlertPrefs(), { showAlerts: true, hidden: { finance: true } });
});

console.log('── 4. Weekly tagging ──');

test('a batch that arrives with a new week is weekly; one in the same week is not', () => {
  const batch = [{ title: 'A' }, { title: 'B' }];
  assert.ok(A.tagWeeklyBatch('1:4', '1:5', batch).every(t => t.alert === true));
  assert.ok(A.tagWeeklyBatch('1:5', '1:5', batch).every(t => !t.alert));
  assert.ok(A.tagWeeklyBatch(null, '1:5', batch).every(t => t.alert === true), 'first batch after mount');
  assert.equal(batch[0].alert, undefined, 'the reducer\'s objects are not mutated');
});
test('typing keys never clear pop-ups', () => {
  assert.equal(A.isEditableTarget({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(A.isEditableTarget({ tagName: 'INPUT', type: 'number' }), true);
  assert.equal(A.isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(A.isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(A.isEditableTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(A.isEditableTarget({ tagName: 'BUTTON' }), false);
  assert.equal(A.isEditableTarget(null), false);
});

console.log('── 5. Rendered ──');

const stack = (toasts, prefs = A.DEFAULT_ALERT_PREFS) => strip(renderToString(
  React.createElement(TS.ToastContainer, { toasts: toasts.map((t, i) => ({ id: i + 1, message: 'm', ...t })), dispatch() {}, onClearAll() {}, prefs })));

test('one pop-up from a click: no bar, just the ×', () => {
  const html = stack([{ title: 'Route opened', type: 'success' }]);
  assert.ok(!html.includes('data-clear-all'), 'bar drawn for a lone action pop-up');
});
test('two or more pop-ups: a "Clear all" bar with the count', () => {
  const html = stack([{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
  assert.ok(html.includes('data-clear-all'), 'no Clear all');
  assert.ok(html.includes('3 pop-ups'), 'no count');
  assert.ok(html.indexOf('data-clear-all') > html.lastIndexOf('Dismiss'), 'the bar should be last in the DOM (top of the stack)');
});
test('a single weekly alert gets the bar (so its kind can be switched off)', () => {
  const html = stack([{ title: 'Mechanical Failure: X', alert: true }]);
  assert.ok(html.includes('data-alert-settings'), 'no settings button');
});
test('the bell shows how many kinds are off', () => {
  const html = stack([{ title: 'A' }, { title: 'B' }], { showAlerts: true, hidden: { rivals: true, fleet: true } });
  assert.ok(/2 off/.test(html), 'no "2 off"');
});

const panel = (prefs, recent = []) => strip(renderToString(
  React.createElement(TS.AlertSettings, { prefs, setPrefs() {}, recent, onClose() {} })));
const checked = (html, attr) => new RegExp(`<input[^>]*${attr}[^>]*checked`).test(html)
  || new RegExp(`<input[^>]*checked[^>]*${attr}`).test(html);

test('the panel lists every category, reflecting the settings', () => {
  const html = panel({ showAlerts: true, hidden: { maintenance: true } });
  for (const c of A.ALERT_CATEGORIES) assert.ok(html.includes(`data-alert-cat="${c.id}"`), `missing ${c.id}`);
  assert.equal(checked(html, 'data-alert-cat="maintenance"'), false, 'maintenance should be unticked');
  assert.equal(checked(html, 'data-alert-cat="fleet"'), true, 'fleet should be ticked');
  assert.equal(checked(html, 'data-alert-master'), true);
});
test('master off: every category unticked and disabled', () => {
  const html = panel({ showAlerts: false, hidden: {} });
  assert.equal(checked(html, 'data-alert-master'), false);
  for (const c of A.ALERT_CATEGORIES) {
    assert.equal(checked(html, `data-alert-cat="${c.id}"`), false, c.id);
    assert.ok(new RegExp(`<input[^>]*data-alert-cat="${c.id}"[^>]*disabled|<input[^>]*disabled[^>]*data-alert-cat="${c.id}"`).test(html), `${c.id} not disabled`);
  }
});
test('recent pop-ups are listed, hidden ones marked', () => {
  const html = panel(A.DEFAULT_ALERT_PREFS, [
    { rid: 2, title: 'Mechanical Failure: A320 #1', message: 'Avionics', hidden: true, category: 'maintenance' },
    { rid: 1, title: 'Aircraft Delivered: A350 #4', message: 'Ready', hidden: false, category: 'fleet' },
  ]);
  assert.ok(html.includes('Mechanical Failure: A320 #1') && html.includes('Aircraft Delivered: A350 #4'));
  assert.equal((html.match(/>hidden</g) ?? []).length, 1);
});

// The real App: the bell sits in the classic top bar.
const { GameProvider, GameContext, freshState } = await import('../src/store/GameContext.jsx');
const { LAYOUT_KEY } = await import('../src/components/MapShell.jsx');
const App = (await import('../src/App.jsx')).default;
// Tailwinds holds its first paint for a hydration flag (an effect SSR never
// runs); Headwinds paints straight from the provider and exports no context.
function Hydrated({ children }) {
  if (!GameContext) return children;
  const ctx = React.useContext(GameContext);
  return React.createElement(GameContext.Provider, { value: { ...ctx, hydrated: true } }, children);
}
test('the classic layout has a pop-up alerts button', () => {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify({ ...freshState(), phase: 'playing', week: 5, year: 1, hub: 'JFK', airlineName: 'Bell Air', cash: 5e7 }));
  store.set(LAYOUT_KEY, 'classic');
  const html = strip(renderToString(React.createElement(GameProvider, null, React.createElement(Hydrated, null, React.createElement(App)))));
  assert.ok(html.includes('nav-tabs'), 'the app did not render');
  assert.ok(html.includes('data-alert-settings'), 'no pop-up alerts button in the top bar');
});
test('the map layout\'s Settings menu has a Pop-up alerts item', () => {
  const src = readFileSync(join(ROOT, 'src/components/MapShell.jsx'), 'utf8');
  const i = src.indexOf("{menu?.key === 'settings' && (");
  assert.ok(i > 0, 'settings menu not found');
  assert.ok(src.slice(i, i + 2000).includes('openAlertSettings'), 'no Pop-up alerts item in the map Settings menu');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
