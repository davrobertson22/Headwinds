import { useState, useCallback } from 'react';

/**
 * The Route Finder's search, kept while you go and open the route it found.
 *
 * Discord, 2026-10-14 (Brabus-G-Wagon, Kadicuss): deploying a big delivery is
 * "basically repeating the same thing over and over again". Most of the repeat
 * was this screen forgetting everything: Plan → is a tab switch, a tab switch
 * unmounts the finder, and on the way back the origin, aircraft, filters, sort
 * and paging had all reset to their defaults — so every tail started with
 * re-picking the aircraft and re-sorting the table.
 *
 * Module scope, like utils/navIntent.js: it outlives the tab switch and dies
 * with the page, which is the lifetime a search should have. Keyed by airline
 * (name + hub) so switching worlds in Headwinds, or re-founding, starts clean.
 */

const memory = new Map();

/** Memory slot for one finder panel ('passenger' | 'freight' | 'screen'). */
export function finderMemoryKey(state, panel) {
  return `${state?.airlineName ?? ''}|${state?.hub ?? ''}|${panel}`;
}

export function recallFinder(key) {
  return memory.get(key) ?? null;
}

export function rememberFinder(key, patch) {
  memory.set(key, { ...(memory.get(key) ?? {}), ...patch });
}

/**
 * The Route Finder's forecast cache, per panel key — same lifetime as the
 * search, so coming back from the planner does not re-price the table from
 * nothing. Owned by components/RouteFinder.jsx; kept here so the test seam
 * below clears it with the rest.
 */
const forecasts = new Map();
export function finderForecastStore() {
  return forecasts;
}

/** Test seam. */
export function clearFinderMemory() {
  memory.clear();
  forecasts.clear();
}

/**
 * useState that is read from, and written through to, the finder memory.
 * `valid(v)` rejects a remembered value that no longer makes sense (an airport
 * or aircraft type that is not in the data any more) and falls back to `init`.
 */
export function useRememberedState(key, field, init, valid = () => true) {
  const [value, setValue] = useState(() => {
    const m = memory.get(key);
    if (m && Object.prototype.hasOwnProperty.call(m, field) && valid(m[field])) return m[field];
    return typeof init === 'function' ? init() : init;
  });
  const set = useCallback((next) => {
    setValue(prev => {
      const v = typeof next === 'function' ? next(prev) : next;
      rememberFinder(key, { [field]: v });
      return v;
    });
  }, [key, field]);
  return [value, set];
}
