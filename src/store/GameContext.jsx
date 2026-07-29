import { createContext, useContext, useReducer, useEffect, useMemo } from 'react';
import { hydrateRoute } from '../utils/simulation.js';
import { gameReducer as reducer, freshState, reconcileState } from '../../packages/engine/src/reducer.mjs';
import { setFareIndex, getFareIndex } from '../../packages/engine/src/utils/market.js';

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
const SAVE_KEY = 'bbae_save_v2'; // bump version to avoid old-format conflicts

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
    // World fare index (New World Restrictions) on FIRST RENDER. The reducer sets
    // this on every action, but useReducer's lazy initialiser does not run the
    // reducer — so without this a restricted world would render the Marketplace,
    // FareEditor and route planners on the CLASSIC fare ladder until the player's
    // first action corrected it.
    setFareIndex(init?.fareIndex ?? 1);
    return init;
  });

  // Keep it in step when the world's state is adopted from the server (Headwinds
  // multiplayer replaces the whole blob without a local action).
  useEffect(() => { setFareIndex(state?.fareIndex ?? 1); }, [state?.fareIndex]);

  useEffect(() => {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
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
  // World fare index (New World Restrictions). The engine's referencePrice() reads
  // a module-scoped index that the reducer sets on every action — but in
  // multiplayer the server owns the state and NO reducer call happens on load, so
  // until the player's first action the whole fare ladder rendered unrestricted.
  // Worse, it then snapped to the real index the moment they touched anything:
  // reported as "it shows the new reference, I edit a price, and when I click off
  // it reverts to the old one". Set it whenever the adopted state's index changes,
  // and synchronously during render so the FIRST paint is already correct.
  const fareIndex = state?.fareIndex ?? 1;
  if (getFareIndex() !== fareIndex) setFareIndex(fareIndex);
  useEffect(() => { setFareIndex(fareIndex); }, [fareIndex]);

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
