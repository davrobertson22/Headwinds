// Pop-ups seen and debriefs closed stay in the browser.
//
// In Headwinds every reducer action is a server decision. Two of them are only
// acknowledgements — CLEAR_TOASTS ("I have seen these pop-ups") and
// DISMISS_DEBRIEF — and CLEAR_TOASTS fires by itself whenever pop-ups arrive,
// which is every week. So every open tab posted a full decision the moment a
// week landed: the server rewrote the whole save and sent it back, and the
// browser ran the weekly projection twice on the main thread (measured
// 2026-11-10: a 2–4 s freeze per week on a 1,900-tail airline; 31,000 of
// 468,000 journalled decisions were these two).
//
// Now the server's pop-up list is left as the tick wrote it and the browser
// remembers what it has shown (apps/headwinds-web/src/screenMemory.js). This
// file holds the memory to its job — nothing shown twice, nothing new missed —
// and holds the three call sites to using it.
//
//   node --import ./tools/_register-loader.mjs tools/screen-memory-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';

globalThis.window = globalThis.window ?? {};
globalThis.window.matchMedia = globalThis.window.matchMedia
  ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
const lsMem = new Map();
globalThis.localStorage = globalThis.localStorage
  ?? { getItem: (k) => (lsMem.has(k) ? lsMem.get(k) : null), setItem: (k, v) => lsMem.set(k, String(v)), removeItem: (k) => lsMem.delete(k) };

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const mod = await import('../apps/headwinds-web/src/screenMemory.js').catch(() => null);
const { freshToasts, toastPrint, createScreenMemory, SCREEN_ONLY_ACTIONS } = mod ?? {};
const need = () => { if (!mod) throw new Error('apps/headwinds-web/src/screenMemory.js does not exist'); };

const T = (title, message = '', type = 'info') => ({ type, title, message, duration: 6000 });
const titles = (list) => list.map((t) => t.title).join(',');
const prints = (list) => list.map(toastPrint);
const fakeStorage = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

section('which pop-ups are new');

test('nothing remembered: everything is new', () => {
  need();
  assert.equal(titles(freshToasts([], [T('a'), T('b')])), 'a,b');
});
test('the same list again: nothing is new', () => {
  need();
  const list = [T('a'), T('b'), T('c')];
  assert.equal(titles(freshToasts(prints(list), list)), '');
});
test('a new week appends: only the appended ones', () => {
  need();
  const before = [T('a'), T('b')];
  assert.equal(titles(freshToasts(prints(before), [...before, T('c'), T('d')])), 'c,d');
});
test('the server dropped its oldest at the cap: still only the appended ones', () => {
  need();
  const before = [T('a'), T('b'), T('c'), T('d')];
  assert.equal(titles(freshToasts(prints(before), [T('c'), T('d'), T('e')])), 'e');
});
test('an optimistic pop-up the server refused: the rest is NOT shown again', () => {
  need();
  const shown = [T('a'), T('b'), T('c'), T('route opened')];   // what the screen last showed
  assert.equal(titles(freshToasts(prints(shown), [T('a'), T('b'), T('c')])), '');
});
test('the same pop-up twice is told apart by count', () => {
  need();
  assert.equal(freshToasts(prints([T('low cash')]), [T('low cash'), T('low cash')]).length, 1);
  assert.equal(freshToasts(prints([T('low cash'), T('x')]), [T('low cash'), T('x'), T('low cash')]).length, 1);
});
test('same title, different message or type: new', () => {
  need();
  assert.equal(freshToasts(prints([T('Delivery', '1 aircraft')]), [T('Delivery', '1 aircraft'), T('Delivery', '2 aircraft')]).length, 1);
  assert.equal(freshToasts(prints([T('x', 'm', 'info')]), [T('x', 'm', 'warning')]).length, 1);
});
test('a display-only field does not make a pop-up new', () => {
  need();
  assert.equal(freshToasts(prints([T('a')]), [{ ...T('a'), duration: 1, alert: true }]).length, 0);
});
test('the server list was emptied elsewhere (an older tab): the next week is all new', () => {
  need();
  assert.equal(titles(freshToasts(prints([T('a'), T('b')]), [T('c'), T('d')])), 'c,d');
  assert.equal(titles(freshToasts(prints([T('a'), T('b')]), [])), '');
});
test('order of the new ones is the list order', () => {
  need();
  assert.equal(titles(freshToasts(prints([T('b'), T('d')]), [T('a'), T('b'), T('c'), T('d'), T('e')])), 'a,c,e');
});
test('forty weeks of a sliding 40-entry window never repeats and never drops a pop-up', () => {
  need();
  const store = fakeStorage(); const memory = createScreenMemory('air1', store);
  let server = []; const shown = []; let n = 0;
  for (let week = 0; week < 40; week++) {
    const news = Array.from({ length: 3 + (week % 9) }, () => T(`t${n++}`, `week ${week}`));
    server = [...server, ...news].slice(-40);                  // the tick's carry rule
    shown.push(...memory.unseenToasts(server).map((t) => t.title));
    shown.push(...memory.unseenToasts(server).map((t) => t.title));   // a later state in the same week
  }
  assert.equal(new Set(shown).size, shown.length, 'a pop-up was shown twice');
  assert.equal(shown.length, n, `${n - shown.length} pop-ups were never shown`);
});

section('the memory');

test('shown once, then remembered — also by a second tab on the same device', () => {
  need();
  const store = fakeStorage();
  const tabA = createScreenMemory('air1', store), tabB = createScreenMemory('air1', store);
  const list = [T('a'), T('b')];
  assert.equal(tabA.unseenToasts(list).length, 2);
  assert.equal(tabA.unseenToasts(list).length, 0);
  assert.equal(tabB.unseenToasts(list).length, 0, 'the second tab showed what the first already had');
  assert.equal(tabB.unseenToasts([...list, T('c')]).length, 1);
  assert.equal(tabA.unseenToasts([...list, T('c')]).length, 0);
});
test('another airline has its own memory', () => {
  need();
  const store = fakeStorage();
  createScreenMemory('air1', store).unseenToasts([T('a')]);
  assert.equal(createScreenMemory('air2', store).unseenToasts([T('a')]).length, 1);
});
test('a player click: the optimistic pop-up is shown, and the server copy is not shown again', () => {
  need();
  const memory = createScreenMemory('air1', fakeStorage());
  const week = [T('w1'), T('w2')];
  memory.unseenToasts(week);
  assert.equal(titles(memory.unseenToasts([...week, T('Not enough cash')])), 'Not enough cash');   // optimistic
  assert.equal(memory.unseenToasts([...week, { ...T('Not enough cash'), duration: 8000 }]).length, 0);   // server's copy
});
test('an unchanged list does not write to storage again', () => {
  need();
  const store = fakeStorage(); let writes = 0;
  const counting = { getItem: store.getItem, setItem: (k, v) => { writes++; store.setItem(k, v); } };
  const memory = createScreenMemory('air1', counting);
  const list = [T('a'), T('b')];
  memory.unseenToasts(list); memory.unseenToasts(list); memory.unseenToasts(list);
  assert.equal(writes, 1);
});
test('storage that throws (private mode, quota) falls back to remembering for the page', () => {
  need();
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const memory = createScreenMemory('air1', broken);
  const list = [T('a')];
  assert.equal(memory.unseenToasts(list).length, 1);
  assert.equal(memory.unseenToasts(list).length, 0);
  memory.dismissDebrief('3:12');
  assert.equal(memory.debriefDismissed('3:12'), true);
});
test('no storage at all works the same way', () => {
  need();
  const memory = createScreenMemory('air1', null);
  assert.equal(memory.unseenToasts([T('a')]).length, 1);
  assert.equal(memory.unseenToasts([T('a')]).length, 0);
});
test('garbage in storage is ignored, not thrown on', () => {
  need();
  const store = fakeStorage(); store.setItem('hw.screen.air1', '{"toasts":"nope","debrief":7}');
  const memory = createScreenMemory('air1', store);
  assert.equal(memory.unseenToasts([T('a')]).length, 1);
  assert.equal(memory.debriefDismissed('7'), false);
  store.setItem('hw.screen.air1', 'not json');
  assert.equal(createScreenMemory('air1', store).unseenToasts([T('a')]).length, 1);
});
test('a debrief closed for one week is open again the next', () => {
  need();
  const store = fakeStorage(); const memory = createScreenMemory('air1', store);
  assert.equal(memory.debriefDismissed('3:12'), false);
  memory.dismissDebrief('3:12');
  assert.equal(memory.debriefDismissed('3:12'), true);
  assert.equal(createScreenMemory('air1', store).debriefDismissed('3:12'), true, 'a reload forgot the debrief was closed');
  assert.equal(memory.debriefDismissed('3:13'), false);
  assert.equal(memory.unseenToasts([T('a')]).length, 1, 'closing the debrief must not disturb the pop-up memory');
});
test('the two acknowledgements are the screen-only actions, and only those', () => {
  need();
  assert.deepEqual([...SCREEN_ONLY_ACTIONS].sort(), ['CLEAR_TOASTS', 'DISMISS_DEBRIEF']);
});

section('the weekly debrief (rendered)');

const { RemoteGameProvider, GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const { default: WeeklyDebrief } = await import('../src/components/WeeklyDebrief.jsx');
const { resetAwayDigest } = await import('../src/utils/awayDigest.js');
const debriefState = () => ({
  ...freshState(), phase: 'playing', multiplayer: true, year: 3, week: 12, showDebrief: true,
  lastReport: { cashDelta: 1234567, totalRevenue: 5e6, totalCosts: 3.7e6, routeResults: [] },
});
const renderDebrief = (remoteApi) => {
  resetAwayDigest?.();
  return renderToString(React.createElement(RemoteGameProvider, { state: debriefState(), dispatch() {}, remoteApi },
    React.createElement(WeeklyDebrief)));
};

test('open when the server says so and it has not been closed here', () => {
  const html = renderDebrief({ debriefDismissed: () => false, dismissDebrief() {} });
  assert.ok(html.length > 200, 'the debrief did not render');
});
test('stays closed for a week this browser already closed it for', () => {
  const asked = [];
  const html = renderDebrief({ debriefDismissed: (k) => { asked.push(k); return true; }, dismissDebrief() {} });
  assert.equal(html, '', 'the debrief came back although it was closed for this week');
  assert.deepEqual([...new Set(asked)], ['3:12'], 'it must ask about the week on screen');
});
test('a server that offers no memory (an older remoteApi) still shows it', () => {
  assert.ok(renderDebrief({}).length > 200);
  assert.ok(renderDebrief(null).length > 200);
});

section('the call sites');

test('App.jsx shows only unseen pop-ups under Headwinds and does not post CLEAR_TOASTS', () => {
  const src = read('src/App.jsx');
  const effect = src.slice(src.indexOf('const toastWeekRef'), src.indexOf('}, [state.pendingToasts, toastWeekKey]'));
  assert.ok(effect.length > 0, 'the toast effect was not found');
  assert.match(effect, /remoteApi\.unseenToasts\(state\.pendingToasts\)/);
  const dispatches = effect.match(/^.*dispatch\(\{ type: 'CLEAR_TOASTS' \}\).*$/gm) ?? [];
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0], /if \(!keepsOwnRecord\)/, 'CLEAR_TOASTS must be solo-only');
});
test('WeeklyDebrief closes through remoteApi.dismissDebrief before it would dispatch', () => {
  const src = read('src/components/WeeklyDebrief.jsx');
  const fn = src.slice(src.indexOf('function dismiss()'), src.indexOf('return (', src.indexOf('function dismiss()')));
  assert.ok(fn.indexOf('remoteApi.dismissDebrief(weekKey)') > 0);
  assert.ok(fn.indexOf('remoteApi.dismissDebrief(weekKey)') < fn.indexOf("dispatch({ type: 'DISMISS_DEBRIEF' })"));
  assert.match(fn, /remoteApi\.dismissDebrief\(weekKey\);[\s\S]*?return;[\s\S]*?dispatch\(/);
});
test('GamePlayScreen offers the memory and never posts a screen-only action', () => {
  const src = read('apps/headwinds-web/src/GamePlayScreen.jsx');
  for (const name of ['unseenToasts', 'debriefDismissed', 'dismissDebrief']) {
    assert.match(src, new RegExp(`${name}: \\(`), `remoteApi.${name} is missing`);
  }
  const dispatch = src.slice(src.indexOf('const dispatch = useCallback((action) => {'));
  const guard = dispatch.indexOf('if (SCREEN_ONLY_ACTIONS.has(type)) {');
  const post = dispatch.indexOf('/decisions`');
  assert.ok(guard > 0 && post > 0 && guard < post, 'the screen-only guard must come before the POST');
  const branch = dispatch.slice(guard, dispatch.indexOf('const seq = ++decisionSeq.current'));
  assert.match(branch, /return;\s*\}\s*$/, 'the screen-only branch must return before a write is queued');
  assert.match(branch, /carryProjectWeek\(hydrateState\(s\), hydrateState\(next\)\)/, 'the projection must be carried, not re-run');
});
test('the server still accepts both actions (tabs on the previous build keep working)', async () => {
  const { ALLOWED_PLAYER_ACTIONS } = await import('../apps/headwinds-server/src/world.mjs');
  assert.ok(ALLOWED_PLAYER_ACTIONS.has('CLEAR_TOASTS') && ALLOWED_PLAYER_ACTIONS.has('DISMISS_DEBRIEF'));
});

section('carrying the projection across a screen-only change');

const { projectWeek, carryProjectWeek } = await import('../src/utils/financeProjection.js');
test('carryProjectWeek hands over the cached result and never overwrites one', () => {
  if (typeof carryProjectWeek !== 'function') throw new Error('carryProjectWeek is not exported');
  const a = { ...freshState(), phase: 'playing' };
  const b = { ...a, pendingToasts: [] }, c = { ...a, showDebrief: false }, d = { ...a };
  assert.equal(carryProjectWeek(a, b), false, 'nothing cached yet — nothing to carry');
  const pa = projectWeek(a);
  assert.equal(carryProjectWeek(a, b), true);
  assert.equal(projectWeek(b), pa, 'the carried projection must be the same object');
  const pc = projectWeek(c);
  assert.equal(carryProjectWeek(a, c), false, 'an existing projection must not be replaced');
  assert.equal(projectWeek(c), pc);
  assert.equal(carryProjectWeek(null, d), false);
  assert.equal(carryProjectWeek(a, null), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
