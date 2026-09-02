import { createContext, useContext, useReducer, useEffect, useMemo, useRef } from 'react';
import { hydrateRoute } from '../utils/simulation.js';
import { gameReducer as reducer, freshState, reconcileState } from '../../packages/engine/src/reducer.mjs';
import { setFareIndex, getFareIndex, setNwrYieldChoke, getNwrYieldChoke, setEraStartYear, getEraStartYear } from '../../packages/engine/src/utils/market.js';
import { setEraCostScale, getEraCostScale } from '../../packages/engine/src/data/overhead.js';
import { setEraPriceYear, getEraPriceYear } from '../../packages/engine/src/data/aircraft.js';
import { eraFareIndex, eraOverheadScale } from '../../packages/engine/src/data/era.js';
import { calendarYear } from '../../packages/engine/src/utils/simulation.js';

// The game logic lives in @tailwinds/engine (packages/engine/src/reducer.mjs),
// the single source of truth shared by the solo app and the multiplayer server.
// `export *` forwards EVERYTHING the reducer module exports (gameReducer,
// freshState, reconcileState, plus helpers like transferCompatibility) so new
// upstream exports keep working here without touching this file.
export * from '../../packages/engine/src/reducer.mjs';

// ─────────────────────────────────────────────
// CONTEXT + PROVIDER
// ─────────────────────────────────────────────

const GameContext = createContext(null);

// ── World-level engine module state, derived from the adopted blob ───────────
// The engine keeps four module-scoped knobs that every referencePrice() /
// pairDemandGrowth() / overhead call reads: the fare index, the NWR yield
// choke, the era start year and the era cost scale. gameReducer sets all four
// at its entry (reducer.mjs, "World fare index") — but a provider that ADOPTS a
// state (localStorage on first render, or the server blob in Headwinds) never
// runs the reducer, so until the player's first action the planners rendered
// on the classic 2026 economy: an 18x demand overstatement in a 1950 world,
// and the modern fare ladder against a tick pricing at 1.55x. Worse, the old
// sync check compared getFareIndex() to the STORED index, so after the reducer
// composed the era index the next render snapped it back to 1.0 — the
// "reference reverts when I click off" report, now in era worlds.
//
// This is the one place the derivation lives on the client, and it MUST match
// the reducer's entry block: era fare index x stored index, era start year,
// era overhead scale. Idempotent, so it is safe to call synchronously during
// render (the first paint is already right) and again from an effect.
export function effectiveFareIndex(state) {
  const eraFi = eraFareIndex(calendarYear(state));
  const stored = state?.fareIndex ?? 1;
  return eraFi != null ? eraFi * stored : stored;
}

export function syncEngineWorldState(state) {
  const fareIndex = effectiveFareIndex(state);
  const nwrOn     = state?.newWorldRestrictions === true;
  const eraStart  = Number.isInteger(state?.startYear) ? state.startYear : null;
  const costScale = eraOverheadScale(calendarYear(state)) ?? 1;
  if (getFareIndex() !== fareIndex) setFareIndex(fareIndex);
  if (getNwrYieldChoke() !== nwrOn) setNwrYieldChoke(nwrOn);
  if (getEraStartYear() !== eraStart) setEraStartYear(eraStart);
  if (getEraCostScale() !== costScale) setEraCostScale(costScale);
  const priceYear = calendarYear(state);
  if (getEraPriceYear() !== priceYear) setEraPriceYear(priceYear);
}
const SAVE_KEY = 'bbae_save_v2'; // bump version to avoid old-format conflicts

/**
 * Write the autosave, and SAY whether it worked.
 *
 * This used to be `try { localStorage.setItem(...) } catch (_) {}` inline in the
 * provider's effect. Once the browser's storage for the site filled up — which a
 * long game does on its own — every subsequent write threw QuotaExceededError,
 * the catch swallowed it, and the game carried on looking completely normal
 * while persisting nothing. The player found out at the next refresh, having
 * lost the session, and the Save/Load screen was still telling them "your game
 * also auto-saves continuously in the background". A failure the player cannot
 * see is worse than no autosave at all.
 *
 * Returns a result rather than throwing so the caller can surface it, and takes
 * the storage explicitly so it is testable outside a browser.
 *
 * @returns {{ok: boolean, reason?: 'quota'|'unavailable'|'error', message?: string}}
 */
export function persistAutosave(state, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return { ok: false, reason: 'unavailable', message: 'This browser is not allowing the game to store data. Private browsing usually causes this.' };
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(state));
    return { ok: true };
  } catch (err) {
    // Quota is the case worth naming precisely, because the player can act on
    // it. Browsers disagree on how they report it: name, legacy code 22, and
    // Firefox's 1014 are all in the wild.
    const quota = err && (
      err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err.code === 22 || err.code === 1014
    );
    return quota
      ? { ok: false, reason: 'quota', message: 'Your browser’s storage for this game is full, so your progress is no longer being saved automatically. Delete a save slot to free space — anything you do until then will be lost if you refresh.' }
      : { ok: false, reason: 'error', message: 'Your progress could not be saved. Anything you do from here will be lost if you refresh.' };
  }
}

// Routes hydrated with their per-pair price so every consumer can keep reading
// route.classPrices / route.ticketPrice unchanged (the reducer stores the
// normalized form — price only in state.routePricing).
function hydratedValue(state, dispatch, remote = false, remoteApi = null, remoteChrome = null) {
  return {
    state: {
      ...state,
      routes: (state.routes ?? []).map((r) => hydrateRoute(r, state.routePricing, state.routeCatering)),
    },
    dispatch,
    remote, // true only under RemoteGameProvider — hides solo-only chrome
    // Multiplayer-only capabilities (world-scoped reads the shared UI can call
    // without importing the Headwinds API): { fetchRivalProfile(airlineId) }.
    // Always null in solo.
    remoteApi,
    // Multiplayer-only topbar content rendered by the shared App shell so the
    // game has ONE header instead of a separate bar stacked on the topbar:
    // { clock, right } — React nodes supplied by GamePlayScreen. Null in solo.
    remoteChrome,
  };
}

export function GameProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, null, () => {
    let init;
    try {
      const saved = localStorage.getItem(SAVE_KEY);
      init = saved ? reconcileState(JSON.parse(saved)) : freshState();
    } catch (_) { init = freshState(); }
    // World fare index / era knobs on FIRST RENDER. The reducer sets these on
    // every action, but useReducer's lazy initialiser does not run the reducer —
    // so without this a restricted or era save would render the Marketplace,
    // FareEditor and route planners on the CLASSIC economy until the player's
    // first action corrected it (see syncEngineWorldState).
    syncEngineWorldState(init);
    return init;
  });

  // Keep it in step when the world's state is adopted from the server (Headwinds
  // multiplayer replaces the whole blob without a local action).
  // The era fare index and cost scale move every January, so state.year is a
  // dependency too.
  useEffect(() => {
    syncEngineWorldState(state);
  }, [state?.fareIndex, state?.newWorldRestrictions, state?.startYear, state?.year]);

  // Latched so the warning fires on the transition, not on every state change —
  // a broken autosave would otherwise queue a toast on every click.
  const autosaveBroken = useRef(false);

  useEffect(() => {
    // persistAutosave() returns {ok, reason, message} instead of swallowing the
    // failure, so the quota path is describable, testable, and — via PUSH_TOAST
    // in the engine reducer — visible to the player
    // (tools/save-quota-test.mjs).
    const result = persistAutosave(state);
    if (!result.ok && !autosaveBroken.current) {
      autosaveBroken.current = true;
      dispatch({ type: 'PUSH_TOAST', toast: {
        type: 'danger', title: '⚠ Your game is not being saved',
        message: result.message, duration: 20000,
      } });
    } else if (result.ok && autosaveBroken.current) {
      autosaveBroken.current = false;
      dispatch({ type: 'PUSH_TOAST', toast: {
        type: 'success', title: '✓ Saving again',
        message: 'Your progress is being saved automatically once more.', duration: 8000,
      } });
    }
  }, [state]);

  const value = useMemo(() => hydratedValue(state, dispatch), [state]);

  return (
    <GameContext.Provider value={value}>
      {children}
    </GameContext.Provider>
  );
}

// ── Multiplayer (Headwinds) binding ───────────────────────────────────────────
// The SAME context, but state and dispatch are supplied by the caller — the
// Headwinds web client passes server-authoritative state and a dispatch that
// submits validated intents to the API. Every screen that calls useGame() works
// unchanged on top of it. No localStorage: the server owns persistence.
export function RemoteGameProvider({ state, dispatch, remoteApi = null, remoteChrome = null, children }) {
  // World fare index / era knobs. The engine's referencePrice() and
  // pairDemandGrowth() read module-scoped state that the reducer sets on every
  // action — but in multiplayer the server owns the state and NO reducer call
  // happens on load, so until the player's first action the whole fare ladder
  // rendered unrestricted (and, in an era world, the planners quoted 2026
  // demand). Worse, it then snapped to the real index the moment they touched
  // anything: reported as "it shows the new reference, I edit a price, and
  // when I click off it reverts to the old one". Sync whenever the adopted
  // state's world inputs change, and synchronously during render so the FIRST
  // paint is already correct. syncEngineWorldState is idempotent and compares
  // against the COMPOSED era index, so a render can no longer undo the reducer.
  syncEngineWorldState(state);
  useEffect(() => { syncEngineWorldState(state); },
    [state?.fareIndex, state?.newWorldRestrictions, state?.startYear, state?.year]);

  const value = useMemo(
    () => hydratedValue(state, dispatch, true, remoteApi, remoteChrome),
    [state, dispatch, remoteApi, remoteChrome]
  );
  return (
    <GameContext.Provider value={value}>
      {children}
    </GameContext.Provider>
  );
}

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}
