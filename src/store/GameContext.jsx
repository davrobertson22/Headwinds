import { createContext, useContext, useReducer, useEffect, useMemo } from 'react';
import { hydrateRoute } from '../utils/simulation.js';
import { gameReducer as reducer, freshState, reconcileState } from '../../packages/engine/src/reducer.mjs';

// The game logic — reducer, freshState, reconcileState — lives in @tailwinds/engine
// (packages/engine/src/reducer.mjs), the single source of truth shared by the solo
// app and the multiplayer server. This file is just the React binding.
export { reducer as gameReducer, freshState, reconcileState };

// ─────────────────────────────────────────────
// CONTEXT + PROVIDER
// ─────────────────────────────────────────────

const GameContext = createContext(null);
const SAVE_KEY = 'bbae_save_v2'; // bump version to avoid old-format conflicts


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

  // Expose routes already hydrated with their per-pair price, so every consumer can
  // keep reading route.classPrices / route.ticketPrice unchanged. The reducer stores
  // (and persists) the normalized form — price only in state.routePricing.
  const value = useMemo(() => ({
    state: {
      ...state,
      routes: (state.routes ?? []).map(r => hydrateRoute(r, state.routePricing, state.routeCatering)),
    },
    dispatch,
  }), [state]);

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
