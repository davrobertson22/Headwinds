// Saving must be honest about failing.
//
// The bug this locks out: both save paths swallowed a full browser store.
//
//   * The autosave was `try { localStorage.setItem(...) } catch (_) {}`. Once
//     the browser's storage for the site filled — which a long game does on its
//     own — every write threw QuotaExceededError, the catch ate it, and the
//     game carried on looking entirely normal while persisting nothing. The
//     player found out at the next refresh, having lost the session, while the
//     Save/Load screen still read "your game also auto-saves continuously in
//     the background".
//   * The manual slot write called setItem bare, so a full store threw straight
//     out of the click handler. The slot list re-read and showed the OLD
//     contents; no message appeared; the player believed they had saved.
//
// `tools/_probe-save-quota.mjs` reproduces both pre-fix call paths verbatim and
// prints what the player was told (nothing). Run it for the before-picture.
//
//   node --import ./tools/_register-loader.mjs tools/save-quota-test.mjs
//
// HEADWINDS NOTE — the reducer here is packages/engine/src/reducer.mjs, the
// engine shared with the multiplayer server, so PUSH_TOAST lives there rather
// than in GameContext.jsx as it does in Tailwinds. The autosave path itself is
// solo-only: the multiplayer client uses RemoteGameProvider, which touches no
// localStorage at all.

import assert from 'node:assert/strict';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }

// A localStorage stand-in that can be told to be full, and that can fail the
// three different ways real browsers report a full store.
function makeStorage() {
  const store = new Map();
  const s = {
    mode: 'ok',            // 'ok' | 'quota' | 'quota-code' | 'quota-firefox' | 'other'
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    removeItem: (k) => store.delete(k),
    setItem: (k, v) => {
      if (s.mode === 'ok') { store.set(k, String(v)); return; }
      const e = new Error('setItem failed');
      if (s.mode === 'quota')         e.name = 'QuotaExceededError';
      if (s.mode === 'quota-code')  { e.name = 'Error'; e.code = 22; }
      if (s.mode === 'quota-firefox') { e.name = 'NS_ERROR_DOM_QUOTA_REACHED'; e.code = 1014; }
      if (s.mode === 'other')         e.name = 'SecurityError';
      throw e;
    },
    _size: () => store.size,
  };
  return s;
}

globalThis.localStorage = makeStorage();
globalThis.window = { localStorage: globalThis.localStorage };

const { persistAutosave, gameReducer, freshState } = await import('../src/store/GameContext.jsx');
const { writeSlot } = await import('../src/components/SaveLoadModal.jsx');

const state = { ...freshState(), airlineName: 'Quota Air', cash: 1_000_000 };

console.log('\nSave-quota honesty\n');

// ── 1. The autosave ──────────────────────────────────────────────────────────
section('1. The autosave reports its own failure');

test('a healthy store saves and says so', () => {
  const st = makeStorage();
  const r = persistAutosave(state, st);
  assert.equal(r.ok, true, 'a working store did not report success');
  // Read back whatever key it chose rather than hardcoding one — the point of
  // this assertion is that SOMETHING was persisted, not which key it used.
  assert.equal(st._size(), 1, 'nothing was actually written');
});

test('a full store returns a failure instead of swallowing it', () => {
  const st = makeStorage(); st.mode = 'quota';
  const r = persistAutosave(state, st);
  assert.equal(r.ok, false, 'the quota error was swallowed — this is the bug');
  assert.equal(r.reason, 'quota');
});

test('the message names the problem and what to do about it', () => {
  const st = makeStorage(); st.mode = 'quota';
  const { message } = persistAutosave(state, st);
  assert.ok(/full/i.test(message), `message does not say the store is full: ${message}`);
  assert.ok(/slot/i.test(message), `message does not tell the player how to free space: ${message}`);
  assert.ok(/refresh|lost/i.test(message), `message does not warn what is at stake: ${message}`);
});

test('every way a browser reports a full store is recognised as quota', () => {
  for (const mode of ['quota', 'quota-code', 'quota-firefox']) {
    const st = makeStorage(); st.mode = mode;
    assert.equal(persistAutosave(state, st).reason, 'quota', `${mode} was not read as a quota failure`);
  }
});

test('a non-quota failure is still reported, just not blamed on space', () => {
  const st = makeStorage(); st.mode = 'other';
  const r = persistAutosave(state, st);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
  assert.ok(!/full/i.test(r.message), 'a SecurityError should not be described as a full store');
});

test('no storage at all is reported, not crashed on', () => {
  const r = persistAutosave(state, null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
});

// ── 2. The warning reaches the player ────────────────────────────────────────
// Headwinds surfaces toasts the way Tailwinds does: the reducer queues them on
// state.pendingToasts, and App.jsx drains the queue into addToast() then
// dispatches CLEAR_TOASTS. PUSH_TOAST is what lets the autosave effect — which
// runs outside the weekly tick — put a message on that queue.
section('2. The failure can reach the screen');

test('CLEAR_TOASTS drains the queue App.jsx reads from', () => {
  const before = { ...freshState(), pendingToasts: [{ title: 'from the tick' }] };
  const after = gameReducer(before, { type: 'CLEAR_TOASTS' });
  assert.equal((after.pendingToasts ?? []).length, 0, 'CLEAR_TOASTS did not empty the queue');
});

test('PUSH_TOAST queues a toast the app layer will show', () => {
  const before = { ...freshState(), pendingToasts: [] };
  const after = gameReducer(before, { type: 'PUSH_TOAST', toast: { type: 'danger', title: 'x', message: 'y' } });
  assert.equal((after.pendingToasts ?? []).length, 1, 'the toast was not queued');
  assert.equal(after.pendingToasts[0].title, 'x');
});

test('PUSH_TOAST with no toast is a no-op, not a crash', () => {
  const before = { ...freshState(), pendingToasts: [] };
  const after = gameReducer(before, { type: 'PUSH_TOAST' });
  assert.equal((after.pendingToasts ?? []).length, 0);
});

test('PUSH_TOAST appends rather than replacing what the tick queued', () => {
  const before = { ...freshState(), pendingToasts: [{ title: 'from the tick' }] };
  const after = gameReducer(before, { type: 'PUSH_TOAST', toast: { title: 'from the autosave' } });
  assert.equal(after.pendingToasts.length, 2, 'the autosave warning ate the weekly toasts');
  assert.equal(after.pendingToasts[0].title, 'from the tick');
});

// ── 3. The manual save ───────────────────────────────────────────────────────
section('3. A manual save says when it did not happen');

test('a healthy store writes the slot and reports success', () => {
  const st = makeStorage();
  const r = writeSlot(0, state, st);
  assert.equal(r.ok, true);
  const raw = st.getItem('bbae_slot_0');
  assert.ok(raw, 'the slot was not written');
  assert.equal(JSON.parse(raw).airlineName, 'Quota Air');
});

test('a full store returns a failure instead of throwing out of the click', () => {
  const st = makeStorage(); st.mode = 'quota';
  let threw = null;
  let r;
  try { r = writeSlot(1, state, st); } catch (e) { threw = e; }
  assert.equal(threw, null, 'writeSlot threw — an uncaught throw in a click handler is exactly the silent failure');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'quota');
});

test('the manual-save message tells the player the slot is unchanged', () => {
  const st = makeStorage(); st.mode = 'quota';
  const { message } = writeSlot(1, state, st);
  assert.ok(/full/i.test(message), `message does not say the store is full: ${message}`);
  assert.ok(/slot/i.test(message), `message does not mention freeing a slot: ${message}`);
});

test('a failed slot write leaves the existing slot alone', () => {
  const st = makeStorage();
  writeSlot(2, { ...state, airlineName: 'Original' }, st);
  st.mode = 'quota';
  const r = writeSlot(2, { ...state, airlineName: 'Replacement' }, st);
  assert.equal(r.ok, false);
  assert.equal(JSON.parse(st.getItem('bbae_slot_2')).airlineName, 'Original',
    'a failed save damaged the slot it failed to overwrite');
});

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
