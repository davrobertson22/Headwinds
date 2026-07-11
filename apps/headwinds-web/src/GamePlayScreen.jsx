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
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import SoloApp from '../../../src/App.jsx';
import { RemoteGameProvider, gameReducer } from '../../../src/store/GameContext.jsx';
import { ALLOWED_PLAYER_ACTIONS } from '../../headwinds-server/src/world.mjs';
import { api } from './api.js';
import MessagesWidget from './Messages.jsx';
import FeedWidget from './Feed.jsx';
import '../../../src/index.css';

// Live countdown to the server's next weekly tick. Derived from worldClock
// .nextTickAt; when it crosses zero we show "landing…" and the poller (below)
// tightens up so the new week arrives promptly instead of "within 15s, maybe".
function TickCountdown({ nextTickAt, paceLabel }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!nextTickAt) return null;
  const ms = new Date(nextTickAt).getTime() - now;
  if (ms <= 0) return <span> · next week landing…</span>;
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const label = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  return (
    <span title={paceLabel ? `World pace: ${paceLabel}` : undefined}>
      {' '}· next week in <strong>{label}</strong>
    </span>
  );
}

export default function GamePlayScreen({ worldId, token }) {
  const [state, setState] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const stateRef = useRef(null);
  stateRef.current = state;
  const metaRef = useRef(null);
  metaRef.current = meta;

  const load = useCallback(async () => {
    try {
      const d = await api(`/worlds/${worldId}/airline`, { token });
      setMeta({ status: d.status, worldStatus: d.worldStatus, worldClock: d.worldClock, airlineId: d.airlineId });
      // Only replace local state when the server has genuinely moved on (a tick
      // landed or first load) — don't stomp optimistic edits between polls.
      const local = stateRef.current;
      if (!local || (d.state.week ?? 0) > (local.week ?? 0)) setState(d.state);
    } catch (e) { setError(e); }
  }, [worldId, token]);

  useEffect(() => {
    load();
    // Adaptive poll: every 15s normally, every 4s once the next tick is due —
    // so the new week (and its debrief) lands moments after the server ticks.
    const t = setInterval(() => {
      const due = metaRef.current?.worldClock?.nextTickAt;
      const nearTick = due && new Date(due).getTime() - Date.now() < 5000;
      if (nearTick) load();
    }, 4000);
    const slow = setInterval(load, 15000);
    return () => { clearInterval(t); clearInterval(slow); };
  }, [load]);

  // World-scoped capabilities for the shared UI (Rivals tab profiles, player
  // alliances). Passed through RemoteGameProvider as `remoteApi` — always null
  // in solo. Alliances are managed HERE, in the game's Alliances tab — the
  // lobby only shows world details and the leaderboard.
  const remoteApi = useMemo(() => ({
    fetchRivalProfile: (airlineId) => api(`/worlds/${worldId}/rivals/${airlineId}`, { token }),
    fetchWorldFeed: (params = '') => api(`/worlds/${worldId}/feed${params}`, { token }),
    fetchAlliances: () => api(`/worlds/${worldId}/alliances`, { token }),
    createAlliance: (name) =>
      api(`/worlds/${worldId}/alliances`, { method: 'POST', token, body: { name } }),
    requestJoinAlliance: (allianceId) =>
      api(`/worlds/${worldId}/alliances/${allianceId}/join`, { method: 'POST', token }),
    decideAllianceRequest: (allianceId, airlineId, decision) =>
      api(`/worlds/${worldId}/alliances/${allianceId}/requests/${airlineId}`, { method: 'POST', token, body: { decision } }),
    leaveAlliance: (allianceId) =>
      api(`/worlds/${worldId}/alliances/${allianceId}/leave`, { method: 'POST', token }),
  }), [worldId, token]);

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
      <div style={{ padding: 24 }}>
        <p className="error">{String(error.message || error)}</p>
        <a href={`#/w/${worldId}`}>← Back to world</a>
      </div>
    );
  }
  if (!state) return <div style={{ padding: 24 }}><p className="muted">Loading your airline…</p></div>;

  return (
    <div className="hw-game">
      <div className="hw-gamebar">
        <a href={`#/w/${worldId}`}>← World lobby</a>
        <span className="muted">
          Multiplayer — Y{meta?.worldClock?.year} W{meta?.worldClock?.week}
          {meta?.worldStatus === 'RUNNING' && (
            <TickCountdown
              nextTickAt={meta?.worldClock?.nextTickAt}
              paceLabel={meta?.worldClock?.paceLabel}
            />
          )}
          {meta?.worldStatus !== 'RUNNING' ? ` · world ${meta?.worldStatus}` : ''}
        </span>
        {error && <span className="error">{String(error.message || error)}</span>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
          <FeedWidget worldId={worldId} token={token} myAirlineId={meta?.airlineId} />
          <MessagesWidget worldId={worldId} token={token} />
        </span>
      </div>
      <RemoteGameProvider state={state} dispatch={dispatch} remoteApi={remoteApi}>
        <SoloApp />
      </RemoteGameProvider>
    </div>
  );
}
