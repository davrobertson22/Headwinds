// Back to the previous screen (Discord, Nilla_wafer 2026-11-14: "Just a back
// button." VodkaOnFire: "And/or a way to hotkey it").
//
// An in-game history of the pages the player has opened: the ← Back button
// (classic nav bar, map-view panel header) and the B key step back through it.
// It is kept in React state, NOT the browser history: pushing a browser entry
// per page would leave dozens of dead Back presses behind once the player
// leaves the game for the lobby, and an in-game Back with nothing left must
// never navigate the browser off the site.
//
// Every page change is recorded, however it happened — a nav click, a number
// key, a Dashboard alert, the weekly jump to the Dashboard — because the hook
// watches activeTab rather than each caller. Switching layout (classic ⇄ map)
// or leaving the game clears it: the two layouts use different page ids.
//
// Kept identical in Headwinds and Tailwinds (src/utils/pageHistory.js).

import { useEffect, useRef, useState } from 'react';
import { isEditableTarget } from './alertPrefs.js';

export const HISTORY_LIMIT = 50;
export const BACK_KEY_LABEL = 'B';

/** The stack after leaving `prev` for another page. */
export function pushPage(stack, prev, limit = HISTORY_LIMIT) {
  if (prev == null) return stack;
  if (stack.length && stack[stack.length - 1] === prev) return stack;
  const next = [...stack, prev];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Where Back goes from `current`: the newest entry that is a different page
 *  and still valid (a page can disappear, e.g. a world without partnerships).
 *  Returns { target, stack } with the entries used up removed, or null. */
export function popPage(stack, current, isValid = () => true) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const id = stack[i];
    if (id !== current && isValid(id)) return { target: id, stack: stack.slice(0, i) };
  }
  return null;
}

/** The history after a render showing `activeTab` (null when unchanged):
 *  a new page records the one left behind; a new `resetKey` starts over. */
export function advanceHistory(hist, activeTab, resetKey) {
  if (hist.reset !== resetKey) return { prev: activeTab, stack: [], reset: resetKey };
  if (hist.prev !== activeTab) return { prev: activeTab, stack: pushPage(hist.stack, hist.prev), reset: resetKey };
  return null;
}

/** The history after Back from `activeTab`, or null when there is nowhere to go. */
export function backHistory(hist, activeTab, isValid = () => true) {
  const step = popPage(hist.stack, activeTab, isValid);
  return step ? { target: step.target, hist: { prev: step.target, stack: step.stack, reset: hist.reset } } : null;
}

/** Is this key press the Back key? B, unmodified, not while typing. Falls back
 *  to the physical key so it works on non-Latin layouts too. */
export function isBackKey(e) {
  if (!e || e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (isEditableTarget(e.target) || (typeof document !== 'undefined' && isEditableTarget(document.activeElement))) return false;
  return e.key === 'b' || e.key === 'B' || e.code === 'KeyB';
}

/**
 * The page history for one page state. `resetKey` clears it when it changes
 * (layout, game phase). Returns { canGoBack, backTarget, goBack }.
 * Must be called above any early return in the component (see App.jsx).
 */
export function usePageHistory(activeTab, setActiveTab, { resetKey = '', isValid = () => true, onBack } = {}) {
  const [hist, setHist] = useState(() => ({ prev: activeTab, stack: [], reset: resetKey }));
  // Recorded during render (React's "adjust state when a prop changes"), so the
  // button is right on the very render that shows the new page.
  const moved = advanceHistory(hist, activeTab, resetKey);
  if (moved) setHist(moved);
  const back = backHistory(moved ?? hist, activeTab, isValid);
  const goBack = () => {
    if (!back) return false;
    setHist(back.hist);
    setActiveTab(back.target);
    onBack?.(back.target);
    return true;
  };
  return { canGoBack: !!back, backTarget: back?.target ?? null, goBack };
}

/** Calls `onBack()` for the Back key; a handler that returns true has used
 *  the key (its default is then prevented). */
export function useBackKey(onBack) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    const onKey = (e) => {
      if (!isBackKey(e)) return;
      if (ref.current?.() === true) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
