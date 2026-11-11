// What this browser has already shown the player.
//
// Two things in the game are acknowledgements, not decisions: "I have seen
// these pop-ups" and "I have closed this week's debrief". In single-player they
// are reducer actions (CLEAR_TOASTS, DISMISS_DEBRIEF) and cost nothing. In
// Headwinds every reducer action is a server decision, so each one was a full
// round trip: load the airline, rebuild the world's rival views, rewrite the
// whole save in Postgres, journal a Decision row, send the whole save back —
// and on the client, two weekly projections on the main thread.
//
// CLEAR_TOASTS fires by itself whenever pop-ups arrive, which is every week
// for an airline of any size. So every open tab in a world made that round
// trip the moment a week landed, all at once (measured 2026-11-10: a 2–4 s
// freeze per week on a 1,900-tail airline, and 31,000 of 468,000 journalled
// decisions were these two actions).
//
// Neither needs the server. The server's pop-up list is left exactly as the
// tick wrote it (the tick already carries the last 40 forward for a player who
// was away); this module remembers which of them this browser has shown, and
// which week's debrief was closed here. A second device shows them once more,
// which is what a second device should do.
//
// Storage is localStorage per airline, shared by every tab on the device. When
// it is unavailable (private mode, quota) the memory lives for the page only.

const KEY_PREFIX = 'hw.screen.';
const MAX_PRINTS = 80;   // the server keeps at most 40; headroom for a week's own actions

/** The part of a pop-up a player would recognise it by. */
export function toastPrint(t) {
  return `${t?.type ?? ''}\u0001${t?.title ?? ''}\u0001${t?.message ?? ''}`;
}

/**
 * The pop-ups in `toasts` this browser has not shown, in order.
 *
 * `seenPrints` is the list as it stood the last time it was shown. The server's
 * list changes by appending (the tick, the player's own actions), by dropping
 * its oldest entries at the cap, and occasionally by losing its newest (an
 * optimistic action the server refused). All three leave the already-seen
 * entries as a common subsequence, so what is new is whatever a longest common
 * subsequence does not account for. Two identical pop-ups are told apart by
 * count, not position: seen once, listed twice, one is new.
 */
export function freshToasts(seenPrints, toasts) {
  const list = Array.isArray(toasts) ? toasts : [];
  const seen = Array.isArray(seenPrints) ? seenPrints : [];
  if (list.length === 0 || seen.length === 0) return list.slice();
  const prints = list.map(toastPrint);
  const n = seen.length, m = prints.length;
  // lcs[i][j] = length of the LCS of seen[i:] and prints[j:]
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = seen[i] === prints[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const fresh = [];
  let i = 0, j = 0;
  while (j < m) {
    if (i < n && seen[i] === prints[j]) { i++; j++; }
    else if (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else { fresh.push(list[j]); j++; }
  }
  return fresh;
}

function browserStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/**
 * The memory for one airline.
 *   unseenToasts(toasts)   → the ones to show now; the whole list is then remembered
 *   debriefDismissed(key)  → was the debrief for week `key` ("year:week") closed here?
 *   dismissDebrief(key)
 * `storage` is injectable for tests; null means page-lifetime memory only.
 */
export function createScreenMemory(airlineId, storage = browserStorage()) {
  const key = `${KEY_PREFIX}${airlineId ?? 'anon'}`;
  let fallback = { toasts: [], debrief: null };
  const read = () => {
    if (!storage) return fallback;
    try {
      const raw = storage.getItem(key);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return {
        toasts: Array.isArray(v?.toasts) ? v.toasts.filter((p) => typeof p === 'string') : [],
        debrief: typeof v?.debrief === 'string' ? v.debrief : null,
      };
    } catch { return fallback; }
  };
  const write = (v) => {
    fallback = v;
    if (!storage) return;
    try { storage.setItem(key, JSON.stringify(v)); } catch { /* quota / private mode: page-lifetime memory */ }
  };
  return {
    unseenToasts(toasts) {
      const list = Array.isArray(toasts) ? toasts : [];
      const mem = read();
      const fresh = freshToasts(mem.toasts, list);
      const prints = list.map(toastPrint).slice(-MAX_PRINTS);
      // Skip the write when nothing changed: this runs on every adopted state.
      if (prints.length !== mem.toasts.length || prints.some((p, k) => p !== mem.toasts[k])) {
        write({ ...mem, toasts: prints });
      }
      return fresh;
    },
    debriefDismissed(weekKey) {
      return weekKey != null && read().debrief === String(weekKey);
    },
    dismissDebrief(weekKey) {
      if (weekKey == null) return;
      write({ ...read(), debrief: String(weekKey) });
    },
  };
}

/** Reducer actions that only change what is on this player's screen. */
export const SCREEN_ONLY_ACTIONS = new Set(['CLEAR_TOASTS', 'DISMISS_DEBRIEF']);
