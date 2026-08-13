// Throwaway probe: reproduce the OLD autosave and manual-save call paths against
// a full localStorage and show that a quota failure leaves NO signal anywhere.
//
// This exists because the fix introduces new exports, so a test importing them
// would fail on HEAD with a module error rather than with evidence of the bug.
// This probe reproduces the pre-fix code verbatim instead.
//
//   node tools/_probe-save-quota.mjs
//
// The two reproduced call paths are copied from Headwinds as they stand:
//   src/store/GameContext.jsx:67       — the autosave effect
//   src/components/SaveLoadModal.jsx:22 — the manual slot write

const store = new Map();
let full = false;
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (full) {
      const e = new Error("Failed to execute 'setItem' on 'Storage': Setting the value of 'bbae_save_v2' exceeded the quota.");
      e.name = 'QuotaExceededError';
      throw e;
    }
    store.set(k, String(v));
  },
  removeItem: (k) => store.delete(k),
};

// Headwinds' real keys (GameContext.jsx:18, SaveLoadModal.jsx:8).
const SAVE_KEY = 'bbae_save_v2';
const SLOT_PREFIX = 'bbae_slot_';
const state = { airlineName: 'Probe Air', cash: 1_000_000, week: 34, year: 3 };

// ── The pre-fix autosave effect, verbatim from GameContext.jsx ────────────────
let effectThrew = false;
function oldAutosave(s) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch (_) { /* ignore */ }
}

// ── The pre-fix manual slot write, verbatim from SaveLoadModal.jsx ────────────
function oldWriteSlot(i, s) {
  const record = { airlineName: s.airlineName, cash: s.cash, week: s.week, year: s.year, savedAt: 0, gameState: s };
  localStorage.setItem(SLOT_PREFIX + i, JSON.stringify(record));
}

console.log('\nProbe: what the player is told when storage is full\n');

console.log('── With storage available ──────────────────────────────────────');
oldAutosave(state);
console.log(`  autosave wrote:            ${localStorage.getItem(SAVE_KEY) ? 'yes' : 'NO'}`);
oldWriteSlot(0, state);
console.log(`  manual slot 0 wrote:       ${localStorage.getItem(SLOT_PREFIX + 0) ? 'yes' : 'NO'}`);

console.log('\n── With storage full ───────────────────────────────────────────');
full = true;
store.clear();

const advanced = { ...state, week: 35 };
oldAutosave(advanced);
console.log(`  autosave wrote:            ${localStorage.getItem(SAVE_KEY) ? 'yes' : 'NO'}`);
console.log(`  autosave threw to caller:  no  (swallowed by catch (_) {})`);
console.log(`  signal left in game state: none — the effect cannot reach the reducer`);
console.log(`  what the player sees:      nothing. The Save/Load screen still says`);
console.log(`                             "Your game also auto-saves continuously in`);
console.log(`                             the background." A refresh loses the session.`);

try {
  oldWriteSlot(1, advanced);
  console.log(`  manual slot 1 wrote:       yes`);
} catch (e) {
  effectThrew = true;
  console.log(`  manual slot 1 wrote:       NO  (${e.name})`);
  console.log(`  manual save threw out of the click handler, uncaught — the slot list`);
  console.log(`  re-read shows the OLD contents and no error is displayed:`);
  console.log(`      slot 1 now holds: ${localStorage.getItem(SLOT_PREFIX + 1) ?? 'null (still empty)'}`);
}

console.log(`\nVerdict: a full store silently stops the autosave, and a manual save`);
console.log(`fails ${effectThrew ? 'by throwing out of the handler' : 'quietly'} with no message. Both are invisible to the player.\n`);
