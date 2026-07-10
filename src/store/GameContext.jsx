import { createContext, useContext, useReducer, useEffect, useMemo } from 'react';
import { hydrateRoute } from '../utils/simulation.js';
import { gameReducer as reducer, freshState, reconcileState } from '../../packages/engine/src/reducer.mjs';

// The game logic lives in @tailwinds/engine (packages/engine/src/reducer.mjs),
// the single source of truth shared by the solo app and the multiplayer server.
export { reducer as gameReducer, freshState, reconcileState };

// ─────────────────────────────────────────────
// CONTEXT + PROVIDER
// ─────────────────────────────────────────────

const GameContext = createContext(null);
const SAVE_KEY = 'bbae_save_v2'; // bump version to avoid old-format conflicts

// Routes hydrated with their per-pair price so every consumer can keep reading
// route.classPrices / route.ticketPrice unchanged (the reducer stores the
// normalized form — price only in state.routePricing).
function hydratedValue(state, dispatch, remote = false) {
  return {
    state: {
      ...state,
      routes: (state.routes ?? []).map((r) => hydrateRoute(r, state.routePricing, state.routeCatering)),
    },
    dispatch,
    remote, // true only under RemoteGameProvider — hides solo-only chrome
  };
}

export function GameProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, null, () => {
    try {
      const saved = localStorage.getItem(SAVE_KEY);
      if (saved) return reconcileState(JSON.parse(saved));
    } catch (_) { /* ignore */ }
    return freshState();
  });

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
export function RemoteGameProvider({ state, dispatch, children }) {
  const value = useMemo(() => hydratedValue(state, dispatch, true), [state, dispatch]);
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
