// Number keys for the main pages (Discord, Xen, 2026-11-12: "just as you can
// use the Del key to clear pop-ups, you could also assign keys such as 1 for
// the Dashboard, 2 for Search, 3 for Network … 0 for Settings").
//
// The numbers follow the bar on screen, left to right, so what you see is what
// you press:
//   map view      1 Dashboard · 2–8 the dock (Search … Finance) · 9 Guide ·
//                 0 Settings · Esc back to the map
//   classic       1, 2, 3 … the nav bar left to right · 0 pop-up alert settings
// Pressing a group's number again moves to its next page (3, 3, 3: Routes,
// Gates, Hubs …), the way the page tabs would.
//
// A key acts only when the button it stands for could be clicked: not while
// the player is typing, not with Cmd/Ctrl/Alt held, and not while a dialog
// (checkout, a confirm, the weekly debrief …) covers the bar. That last check
// asks the browser what is under the button rather than keeping a list of
// every modal in the game.
//
// Kept identical in Headwinds and Tailwinds (src/utils/navKeys.js).

import { useEffect, useRef } from 'react';
import { isEditableTarget } from './alertPrefs.js';

/** The digit a key press means ('0'–'9'), or null. Number row or keypad; on a
 *  layout whose number row needs Shift (AZERTY), the unshifted key counts too. */
export function navDigit(e) {
  if (!e || e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (isEditableTarget(e.target) || (typeof document !== 'undefined' && isEditableTarget(document.activeElement))) return null;
  if (typeof e.key === 'string' && /^[0-9]$/.test(e.key)) return e.key;
  const m = !e.shiftKey && typeof e.code === 'string' && /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  return m ? m[1] : null;
}

/** Map view: the key for MAP_GROUPS[index] (2–8). */
export const mapGroupKey = (index) => (index >= 0 && index < 7 ? String(index + 2) : null);
export const MAP_KEY_DASHBOARD = '1';
export const MAP_KEY_GUIDE = '9';
export const MAP_KEY_SETTINGS = '0';

/** Classic layout: the key for the nav bar's index-th entry (1–9). */
export const classicKey = (index) => (index >= 0 && index < 9 ? String(index + 1) : null);
export const CLASSIC_KEY_SETTINGS = '0';

/** The page after `current` in a group, wrapping; the first page when the
 *  group is not open. */
export function cyclePage(pages, current) {
  if (!pages?.length) return null;
  const i = pages.indexOf(current);
  return i < 0 ? pages[0] : pages[(i + 1) % pages.length];
}

/** " (key 3)" for a tooltip, or '' when there is no key. */
export const keyHint = (key) => (key ? ` (key ${key})` : '');

// Backdrops that only close a dropdown: a key press may go straight through
// them (the menu closes as the page changes).
const LIGHT_BACKDROPS = '.ms-menu-backdrop, .nav-group-backdrop, .topbar-menu-backdrop';

/** Could the player click `el` right now? False when a dialog covers it. */
export function reachable(el) {
  if (typeof document === 'undefined') return true;
  if (document.querySelector('[aria-modal="true"], [role="alertdialog"]')) return false;
  if (!el) return true;
  if (typeof el.getBoundingClientRect !== 'function' || typeof document.elementFromPoint !== 'function') return true;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  // Scrolled out of view (the classic bar on a narrow window): nothing to hit-test.
  if (!(r.width > 0 && r.height > 0) || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return true;
  const hit = document.elementFromPoint(x, y);
  if (!hit || el === hit || el.contains(hit)) return true;
  return !!hit.closest?.(LIGHT_BACKDROPS);
}

/** Calls `onDigit(digit)` for number keys; a handler that returns true has
 *  used the key (its default is then prevented). */
export function useNavKeys(onDigit) {
  const ref = useRef(onDigit);
  ref.current = onDigit;
  useEffect(() => {
    const onKey = (e) => {
      const d = navDigit(e);
      if (d == null) return;
      if (ref.current?.(d) === true) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
