// The FULL Tailwinds game UI, running on server-authoritative state.
//
// This mounts the solo app's entire interface (src/App.jsx — dashboard, routes,
// fleet, finance, alliances, all of it) inside RemoteGameProvider. The swap:
//
//   solo:       useReducer(engine) + localStorage
//   Headwinds:  state ← GET /worlds/:id/airline (polled to catch server ticks)
//               dispatch → optimistic local engine apply for instant feedback,
//                          then POST /worlds/:id/decisions; the server's result
//                          (same reducer, validated) replaces local state.
//
// Server-reserved actions (ADVANCE_WEEK — time belongs to the world clock) are
// swallowed: the weekly tick happens on the server whether or not you're here.
import { useState, useEffect, useRef, useCallback } from 'react';
import SoloApp from '../../../src/App.jsx';
import { RemoteGameProvider, gameReducer } from '../../../src/store/GameContext.jsx';
import { ALLOWED_PLAYER_ACTIONS } from '../../headwinds-server/src/world.mjs';
import { api } from './api.js';
import '../../../src/index.css';

export default function GamePlayScreen({ worldId, token }) {
  const [state, setState] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const stateRef = useRef(null);
  stateRef.current = state;

  const load = useCallback(async () => {
    try {
      const d = await api(`/worlds/${worldId}/airline`, { token });
      setMeta({ status: d.status, worldStatus: d.worldStatus, worldClock: d.worldClock });
      // Only replace local state when the server has genuinely moved on (a tick
      // landed or first load) — don't stomp optimistic edits between polls.
      const local = stateRef.current;
      if (!local || (d.state.week ?? 0) > (local.week ?? 0)) setState(d.state);
    } catch (e) { setError(e); }
  }, [worldId, token]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const dispatch = useCallback((action) => {
    const { type, ...payload } = action ?? {};
    if (!ALLOWED_PLAYER_ACTIONS.has(type)) return; // ADVANCE_WEEK etc. — server-owned
    // Optimistic: same reducer, instant UI.
    setState((s) => gameReducer(s, action));
    // Authoritative: server recomputes and its result wins.
    api(`/worlds/${worldId}/decisions`, { method: 'POST', token, body: { type, payload } })
      .then((res) => setState(res.state))
      .catch((e) => { setError(e); load(); }); // rejected → resync from server
  }, [worldId, token, load]);

  if (error && !state) {
    return (
      <div className="shell">
        <p className="error">{String(error.message || error)}</p>
        <a href={`#/w/${worldId}`}>← Back to world</a>
      </div>
    );
  }
  if (!state) return <div className="shell"><p className="muted">Loading your airline…</p></div>;

  return (
    <div className="hw-game">
      <div className="hw-gamebar">
        <a href={`#/w/${worldId}`}>← World lobby</a>
        <span className="muted">
          Multiplayer — server clock Y{meta?.worldClock?.year} W{meta?.worldClock?.week}; weeks advance automatically
          {meta?.worldStatus !== 'RUNNING' ? ` · world ${meta?.worldStatus}` : ''}
        </span>
        {error && <span className="error">{String(error.message || error)}</span>}
      </div>
      <RemoteGameProvider state={state} dispatch={dispatch}>
        <SoloApp />
      </RemoteGameProvider>
    </div>
  );
}
