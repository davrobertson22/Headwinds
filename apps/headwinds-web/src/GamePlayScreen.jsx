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
import { authedApi, SessionExpiredError } from './authedApi.js';
import { supabase } from './supabase.js';
import MessagesWidget from './Messages.jsx';
import FeedWidget from './Feed.jsx';
import '../../../src/index.css';

// Live countdown to the server's next weekly tick. Derived from worldClock
// .nextTickAt; when it crosses zero we show "landing…" and the poller (below)
// tightens up so the new week arrives promptly instead of "within 15s, maybe".
// Rendered inside the game topbar's DATE tile (via remoteChrome).
function TickCountdown({ nextTickAt, paceLabel }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!nextTickAt) return null;
  const ms = new Date(nextTickAt).getTime() - now;
  if (ms <= 0) return <span>next week landing…</span>;
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const label = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  return (
    <span title={paceLabel ? `World pace: ${paceLabel}` : undefined}>
      next week in <strong>{label}</strong>
    </span>
  );
}

// ── Statistics backfill ─────────────────────────────────────────────────────
// Finance ▸ Statistics is driven by state.statsHistory, a compact per-week KPI
// series the engine only started recording recently — and only ever builds it
// going FORWARD (nothing reconciles the statsHistory of already-running worlds
// server-side). So an airline that has been operating for weeks arrives with an
// empty or near-empty statsHistory and the page shows its "need 2 weeks of
// history" empty state, even though financialHistory is full. Seed the missing
// weeks from financialHistory here — the SAME partial-series shape the solo
// reducer's reconcileState uses on load — so the revenue/cost/profit and
// passenger charts render immediately. Real entries the server records (with the
// passenger split, network-size and efficiency detail) take precedence; the rest
// are flagged `partial` and fill in with detail as new weeks tick.
function withStatsBackfill(state) {
  if (!state) return state;
  const real = Array.isArray(state.statsHistory) ? state.statsHistory : [];
  const fin = Array.isArray(state.financialHistory) ? state.financialHistory : [];
  if (fin.length === 0) return state;
  const have = new Set(real.map((s) => `${s.year}-${s.week}`));
  const partials = fin
    .filter((h) => !have.has(`${h.year}-${h.week}`))
    .map((h) => ({
      label:          h.label,
      week:           h.week,
      year:           h.year,
      absWeek:        ((h.year ?? 1) - 1) * 52 + (h.week ?? 0),
      paxOrganic:     h.passengers     ?? 0,
      revenue:        (h.revenue ?? 0) + (h.cargoRevenue ?? 0),
      partnerRevenue: h.partnerRevenue ?? 0,
      cargoRevenue:   h.cargoRevenue   ?? 0,
      cost:           h.totalCost      ?? 0,
      profit:         h.profit         ?? 0,
      cash:           h.cash           ?? 0,
      partial:        true,
    }));
  if (partials.length === 0) return state;
  const merged = [...partials, ...real].sort((a, b) => (a.absWeek ?? 0) - (b.absWeek ?? 0));
  return { ...state, statsHistory: merged };
}

export default function GamePlayScreen({ worldId, token }) {
  const [state, setState] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const stateRef = useRef(null);
  stateRef.current = state;
  const metaRef = useRef(null);
  metaRef.current = meta;
  // Change stamp from the last response — sent back on every poll so the server
  // can answer "unchanged" from tiny reads instead of shipping the full state
  // blob (+ every rival's blob) each time. This is the Supabase egress fix.
  const stampRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const q = stampRef.current && stateRef.current
        ? `?stamp=${encodeURIComponent(stampRef.current)}` : '';
      const d = await authedApi(`/worlds/${worldId}/airline${q}`, { token });
      setMeta({ status: d.status, worldStatus: d.worldStatus, worldClock: d.worldClock, airlineId: d.airlineId });
      if (d.stamp) stampRef.current = d.stamp;
      setError(null); // a good poll clears any stale transient error
      if (d.unchanged) return; // nothing moved server-side — keep what we have
      // Only replace local state when the server has genuinely moved on (a tick
      // landed or first load) — don't stomp optimistic edits between polls.
      const local = stateRef.current;
      if (!local || (d.state.week ?? 0) > (local.week ?? 0)) setState(withStatsBackfill(d.state));
    } catch (e) {
      if (e instanceof SessionExpiredError) setSessionExpired(true);
      else setError(e);
    }
  }, [worldId, token]);

  useEffect(() => {
    if (sessionExpired) return; // dead session — stop hitting the server
    load();
    // Adaptive poll: every 25s normally (idle polls short-circuit server-side
    // via the stamp anyway), every 4s once the next tick is due — so the new
    // week (and its debrief) still lands moments after the server ticks.
    const t = setInterval(() => {
      const due = metaRef.current?.worldClock?.nextTickAt;
      const nearTick = due && new Date(due).getTime() - Date.now() < 5000;
      if (nearTick) load();
    }, 4000);
    const slow = setInterval(load, 25000);
    return () => { clearInterval(t); clearInterval(slow); };
  }, [load, sessionExpired]);

  // World-scoped capabilities for the shared UI (Rivals tab profiles, player
  // alliances). Passed through RemoteGameProvider as `remoteApi` — always null
  // in solo. Alliances are managed HERE, in the game's Alliances tab — the
  // lobby only shows world details and the leaderboard.
  const remoteApi = useMemo(() => ({
    fetchRivalProfile: (airlineId) => authedApi(`/worlds/${worldId}/rivals/${airlineId}`, { token }),
    fetchWorldFeed: (params = '') => authedApi(`/worlds/${worldId}/feed${params}`, { token }),
    fetchAlliances: () => authedApi(`/worlds/${worldId}/alliances`, { token }),
    createAlliance: (name) =>
      authedApi(`/worlds/${worldId}/alliances`, { method: 'POST', token, body: { name } }),
    requestJoinAlliance: (allianceId) =>
      authedApi(`/worlds/${worldId}/alliances/${allianceId}/join`, { method: 'POST', token }),
    decideAllianceRequest: (allianceId, airlineId, decision) =>
      authedApi(`/worlds/${worldId}/alliances/${allianceId}/requests/${airlineId}`, { method: 'POST', token, body: { decision } }),
    leaveAlliance: (allianceId) =>
      authedApi(`/worlds/${worldId}/alliances/${allianceId}/leave`, { method: 'POST', token }),
  }), [worldId, token]);

  const decisionSeq = useRef(0);
  const dispatch = useCallback((action) => {
    const { type, ...payload } = action ?? {};
    if (!ALLOWED_PLAYER_ACTIONS.has(type)) return; // ADVANCE_WEEK etc. — server-owned
    const seq = ++decisionSeq.current;
    // Optimistic: same reducer, instant UI.
    setState((s) => gameReducer(s, action));
    // Authoritative: server result wins — but only the MOST RECENT decision may
    // overwrite local state, and never roll the week backwards (a pre-tick
    // response landing after the weekly poll advanced us). Stale/out-of-order
    // responses are dropped; the next poll reconciles.
    authedApi(`/worlds/${worldId}/decisions`, { method: 'POST', token, body: { type, payload } })
      .then((res) => {
        // Adopt the post-write stamp so the next poll short-circuits instead of
        // re-downloading the state we're about to render. A stale (out-of-order)
        // response is skipped — the next poll's full fetch reconciles.
        if (seq === decisionSeq.current && res.stamp) stampRef.current = res.stamp;
        setState((cur) => {
          if (seq !== decisionSeq.current) return cur;
          if (res.state?.week != null && cur?.week != null && res.state.week < cur.week) return cur;
          return withStatsBackfill(res.state);
        });
      })
      .catch((e) => {
        if (e instanceof SessionExpiredError) { setSessionExpired(true); return; }
        setError(e); load(); // rejected → resync from server
      });
  }, [worldId, token, load]);

  // Topbar content the shared App shell renders when remote — the game gets ONE
  // header (brand · airline · date+countdown · cash · lobby/feed/messages)
  // instead of a second bar stacked above its own topbar.
  const remoteChrome = useMemo(() => ({
    clock: meta?.worldStatus === 'RUNNING'
      ? <TickCountdown nextTickAt={meta?.worldClock?.nextTickAt} paceLabel={meta?.worldClock?.paceLabel} />
      : (meta?.worldStatus ? <span>world {String(meta.worldStatus).toLowerCase()}</span> : null),
    right: (
      <>
        {error && (
          <span className="error" style={{ fontSize: 12, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {String(error.message || error)}
          </span>
        )}
        <a className="hw-lobby-link" href={`#/w/${worldId}`} title="Back to the world lobby">← Lobby</a>
        <FeedWidget worldId={worldId} token={token} myAirlineId={meta?.airlineId} />
        <MessagesWidget worldId={worldId} token={token} />
      </>
    ),
  }), [meta, error, worldId, token]);

  if (sessionExpired) {
    return (
      <div style={{ padding: 24 }}>
        <p className="error">Your session ended. Please sign in again to keep playing.</p>
        <div className="row">
          <button className="btn primary" onClick={() => supabase?.auth.signOut()}>Sign in again</button>
          <a href={`#/w/${worldId}`}>← World lobby</a>
        </div>
      </div>
    );
  }
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
      <RemoteGameProvider state={state} dispatch={dispatch} remoteApi={remoteApi} remoteChrome={remoteChrome}>
        <SoloApp />
      </RemoteGameProvider>
    </div>
  );
}
