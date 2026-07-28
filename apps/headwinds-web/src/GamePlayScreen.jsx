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
import { api, isTransientError } from './api.js';
import { shouldFastPoll, isStaleContact } from './connection.js';
import { authedApi, SessionExpiredError } from './authedApi.js';
import { isHidden } from './usePoll.js';
import { supabase } from './supabase.js';
import MessagesWidget from './Messages.jsx';
import FeedWidget from './Feed.jsx';
import '../../../src/index.css';

// Live countdown to the server's next weekly tick. Derived from worldClock
// .nextTickAt; when it crosses zero we show "landing…" and the poller (below)
// tightens up so the new week arrives promptly instead of "within 15s, maybe".
// Rendered inside the game topbar's DATE tile (via remoteChrome).
function TickCountdown({ nextTickAt, paceLabel, stale }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!nextTickAt) return null;
  const ms = new Date(nextTickAt).getTime() - now;
  // Overdue AND out of contact is not "landing" — it's us, not the world.
  if (ms <= 0) return <span>{stale ? 'waiting for the server…' : 'next week landing…'}</span>;
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

// The state blob's `week` is the week OF THE YEAR (1–52), so comparing raw
// weeks to decide "has the server moved on?" breaks at every New Year: week 52
// -> week 1 reads as going BACKWARDS, the client rejects the newer state, and the
// UI wedges on December W4 until the player reloads the page. Always compare the
// linear week index instead.
const absWeekOfState = (s) => (((s?.year ?? 1) - 1) * 52) + (s?.week ?? 0);

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
  // A decision the SERVER rejected (409 etc.). Kept separate from transport
  // `error` because a good poll wipes that one almost instantly — which made
  // rejection messages ("only N shares available…") flash for a fraction of a
  // second while the optimistic state visibly reversed, unreadable. This one
  // stays up until dismissed or replaced (auto-clears after 15s).
  const [actionNotice, setActionNotice] = useState(null);
  const actionNoticeTimer = useRef(null);
  const showActionNotice = useCallback((msg) => {
    setActionNotice(msg);
    if (actionNoticeTimer.current) clearTimeout(actionNoticeTimer.current);
    actionNoticeTimer.current = setTimeout(() => setActionNotice(null), 15000);
  }, []);
  useEffect(() => () => { if (actionNoticeTimer.current) clearTimeout(actionNoticeTimer.current); }, []);
  const [sessionExpired, setSessionExpired] = useState(false);
  const stateRef = useRef(null);
  stateRef.current = state;
  const metaRef = useRef(null);
  metaRef.current = meta;
  // Change stamp from the last response — sent back on every poll so the server
  // can answer "unchanged" from tiny reads instead of shipping the full state
  // blob (+ every rival's blob) each time. This is the Supabase egress fix.
  const stampRef = useRef(null);

  // Timestamp of the last poll that actually reached the server. Everything
  // about "are we still connected?" is derived from this.
  const lastOkRef = useRef(Date.now());
  const [connLost, setConnLost] = useState(false);
  // Authoritative writes in flight. A reconnect resync adopts the server blob
  // wholesale, so hold that off while a decision is still on the wire — its
  // response is about to replace local state anyway.
  const writesInFlight = useRef(0);

  // `full` drops the stamp (forcing a complete state fetch) and adopts whatever
  // the server returns, week comparison bypassed. Used after a gap in contact:
  // local state may be arbitrarily stale AND may still hold optimistic edits
  // whose writes never landed, so the server is the only trustworthy version.
  const load = useCallback(async ({ full = false } = {}) => {
    try {
      // `split=1` opts into halved responses: the server sends the state blob
      // only when OUR version moved, and the (small) rival overlay whenever any
      // rival moved. Between ticks the overwhelming majority of polls come back
      // as overlay-only, which is the whole point — we used to re-download the
      // entire save because somebody else changed a fare.
      const q = !full && stampRef.current && stateRef.current
        ? `?split=1&stamp=${encodeURIComponent(stampRef.current)}` : '?split=1';
      const d = await authedApi(`/worlds/${worldId}/airline${q}`, { token });
      lastOkRef.current = Date.now();
      setConnLost(false);
      setMeta({ status: d.status, worldStatus: d.worldStatus, worldClock: d.worldClock, airlineId: d.airlineId });
      if (d.stamp) stampRef.current = d.stamp;
      setError(null); // a good poll clears any stale transient error
      if (d.unchanged) return; // nothing moved server-side — keep what we have

      // The rival overlay is entirely server-derived (competitors, gate market,
      // stock pool, alliance, badges) and is stripped before persistence, so
      // adopting it can never stomp an optimistic local edit. Apply it on its
      // own whenever it arrives — including on polls that carry no blob.
      if (d.rivals) setState((cur) => (cur ? { ...cur, ...d.rivals } : cur));

      if (!d.state) return; // overlay-only poll — the common case between ticks

      // Only replace local state when the server has genuinely moved on (a tick
      // landed or first load) — don't stomp optimistic edits between polls.
      // The blob now arrives WITHOUT the overlay, so re-apply whatever overlay
      // came with it; otherwise adopting a blob would blank the Rivals tab.
      const local = stateRef.current;
      const incoming = d.rivals ? { ...d.state, ...d.rivals } : d.state;
      if (!local || full || absWeekOfState(incoming) > absWeekOfState(local)) {
        setState(withStatsBackfill(incoming));
      }
    } catch (e) {
      if (e instanceof SessionExpiredError) setSessionExpired(true);
      else {
        setError(e);
        // Transport failure — say so, but only once we've been out of contact
        // long enough that it isn't just one unlucky request.
        if (isTransientError(e) && isStaleContact(lastOkRef.current)) setConnLost(true);
      }
    }
  }, [worldId, token]);

  // Re-establish contact: a full resync if we've been dark, a cheap stamped
  // poll otherwise.
  const resync = useCallback(() => {
    const stale = isStaleContact(lastOkRef.current);
    // `<= 0` not `=== 0`: the counter must never be able to strand us on
    // shallow resyncs if a handler ever double-settles.
    load({ full: stale && writesInFlight.current <= 0 });
  }, [load]);

  useEffect(() => {
    if (sessionExpired) return; // dead session — stop hitting the server
    load();
    // Adaptive poll: every 25s normally (idle polls short-circuit server-side
    // via the stamp anyway), every 4s once the next tick is due — so the new
    // week (and its debrief) still lands moments after the server ticks.
    const t = setInterval(() => {
      // A backgrounded tab polls nothing. The visibilitychange handler below
      // resyncs the moment it comes back, so pausing costs no freshness — and
      // it stops a world left open in a spare tab billing egress all day.
      // The staleness check is skipped too: we are not out of contact, we
      // deliberately stopped talking, and flagging "connection lost" for that
      // would be a lie the user sees the instant they switch back.
      if (isHidden()) return;
      if (shouldFastPoll(metaRef.current?.worldClock?.nextTickAt)) load();
      // Nothing has reached the server in a while. Flag it here rather than
      // firing extra requests — the 25s poll below keeps retrying on its own,
      // and a wedged client that retries harder only wedges harder.
      else if (isStaleContact(lastOkRef.current)) setConnLost(true);
    }, 4000);
    const slow = setInterval(() => { if (!isHidden()) load(); }, 25000);
    return () => { clearInterval(t); clearInterval(slow); };
  }, [load, sessionExpired]);

  // Reconnect signals. The interval poll recovers on its own eventually — but
  // only eventually, and only if its request is answered. These make coming back
  // from a sleeping laptop, a dropped wifi or a backgrounded tab immediate, and
  // force a FULL resync when we've been out of contact, so the date on screen
  // can't sit a week (or five) behind the world.
  useEffect(() => {
    if (sessionExpired) return;
    const onOnline = () => resync();
    const onOffline = () => setConnLost(true);
    const onVisible = () => { if (document.visibilityState === 'visible') resync(); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [resync, sessionExpired]);

  // World-scoped capabilities for the shared UI (Rivals tab profiles, player
  // alliances). Passed through RemoteGameProvider as `remoteApi` — always null
  // in solo. Alliances are managed HERE, in the game's Alliances tab — the
  // lobby only shows world details and the leaderboard.
  // Gate scarcity: bid/listing responses carry a fresh personalized gateMarket —
  // merge it into local state immediately (the poll's stamp short-circuit would
  // otherwise hide our own bid/listing until something else changed).
  const adoptGateMarket = useCallback((gateMarket) => {
    if (!gateMarket) return;
    setState((s) => (s ? { ...s, gateMarket } : s));
  }, []);

  const remoteApi = useMemo(() => ({
    fetchRivalProfile: (airlineId) => authedApi(`/worlds/${worldId}/rivals/${airlineId}`, { token }),
    fetchWorldFeed: (params = '') => authedApi(`/worlds/${worldId}/feed${params}`, { token }),
    // World news (News tab + the topbar ticker). `airlineId` rides along so the
    // shared UI can mark your own moves and promote items that touch your
    // network without the server needing to know who is asking.
    fetchNews: (params = '') => authedApi(`/worlds/${worldId}/news${params}`, { token }),
    airlineId: meta?.airlineId ?? null,
    // Used aircraft market (all Headwinds worlds)
    fetchUsedAircraft: () => authedApi(`/worlds/${worldId}/used-aircraft`, { token }),
    buyUsedAircraft: (listingId) =>
      authedApi(`/worlds/${worldId}/used-aircraft/${listingId}/buy`, { method: 'POST', token })
        .then((res) => {
          if (res.state) setState((cur) => {
            if (res.state.week != null && cur?.week != null && absWeekOfState(res.state) < absWeekOfState(cur)) return cur;
            return withStatsBackfill(res.state);
          });
          return res;
        }),
    // ── Gate scarcity (worlds with the option on) ────────────────────────────
    placeGateBid: (airportCode, amount, quantity = 1) =>
      authedApi(`/worlds/${worldId}/gates/${airportCode}/bid`, { method: 'POST', token, body: { amount, quantity } })
        .then((res) => { adoptGateMarket(res.gateMarket); return res; }),
    withdrawGateBid: (airportCode) =>
      authedApi(`/worlds/${worldId}/gates/${airportCode}/bid`, { method: 'DELETE', token })
        .then((res) => { adoptGateMarket(res.gateMarket); return res; }),
    listGate: (airportCode, askPrice) =>
      authedApi(`/worlds/${worldId}/gates/listings`, { method: 'POST', token, body: { airportCode, askPrice } })
        .then((res) => { adoptGateMarket(res.gateMarket); return res; }),
    withdrawGateListing: (listingId) =>
      authedApi(`/worlds/${worldId}/gates/listings/${listingId}`, { method: 'DELETE', token })
        .then((res) => { adoptGateMarket(res.gateMarket); return res; }),
    buyGateListing: (listingId) =>
      authedApi(`/worlds/${worldId}/gates/listings/${listingId}/buy`, { method: 'POST', token })
        .then((res) => {
          // Full authoritative state (cash paid, gate added) — adopt it whole.
          if (res.state) setState((cur) => {
            if (res.state.week != null && cur?.week != null && absWeekOfState(res.state) < absWeekOfState(cur)) return cur;
            return withStatsBackfill({ ...res.state, gateMarket: res.gateMarket ?? res.state.gateMarket });
          });
          return res;
        }),
    fetchAlliances: () => authedApi(`/worlds/${worldId}/alliances`, { token }),
    createAlliance: (name) =>
      authedApi(`/worlds/${worldId}/alliances`, { method: 'POST', token, body: { name } }),
    requestJoinAlliance: (allianceId) =>
      authedApi(`/worlds/${worldId}/alliances/${allianceId}/join`, { method: 'POST', token }),
    decideAllianceRequest: (allianceId, airlineId, decision) =>
      authedApi(`/worlds/${worldId}/alliances/${allianceId}/requests/${airlineId}`, { method: 'POST', token, body: { decision } }),
    leaveAlliance: (allianceId) =>
      authedApi(`/worlds/${worldId}/alliances/${allianceId}/leave`, { method: 'POST', token }),
  }), [worldId, token, adoptGateMarket, meta?.airlineId]);

  const decisionSeq = useRef(0);
  // Serialize the authoritative writes. A burst of dispatches — bulk close/sell/
  // retire, or just fast clicks — must reach POST /decisions ONE AT A TIME. Fired in
  // parallel they all read the same airline `version` and race the server's
  // optimistic-concurrency check, so all but one come back 409 and those actions
  // silently no-op. The optimistic apply below still gives instant per-action
  // feedback; only the network writes queue, each adopting the previous write's new
  // version/stamp before the next goes out.
  const writeChain = useRef(Promise.resolve());
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
    writesInFlight.current += 1;
    writeChain.current = writeChain.current.then(() =>
      // A longer leash than a poll: a bulk close/sell can be a heavy write, and
      // timing out a decision the server actually applied is worse than waiting.
      authedApi(`/worlds/${worldId}/decisions`, { method: 'POST', token, body: { type, payload }, timeoutMs: 25000 })
        .then((res) => {
          writesInFlight.current -= 1;
          // Adopt the post-write stamp so the next poll short-circuits instead of
          // re-downloading the state we're about to render. A stale (out-of-order)
          // response is skipped — the next poll's full fetch reconciles.
          if (seq === decisionSeq.current && res.stamp) stampRef.current = res.stamp;
          setState((cur) => {
            if (seq !== decisionSeq.current) return cur;
            if (res.state?.week != null && cur?.week != null && absWeekOfState(res.state) < absWeekOfState(cur)) return cur;
            return withStatsBackfill(res.state);
          });
        })
        .catch((e) => {
          writesInFlight.current -= 1;
          if (e instanceof SessionExpiredError) { setSessionExpired(true); return; }
          // A real server rejection carries the reason the action reversed —
          // show it somewhere the player can actually read it. Transport
          // failures keep the transient-error / reconnecting treatment.
          if (isTransientError(e)) setError(e);
          else showActionNotice(String(e.message || e));
          // Rejected → resync from the server. If it failed on the wire we may
          // have missed ticks too, so let resync() decide how deep to go.
          if (isTransientError(e)) resync(); else load();
        })
    );
  }, [worldId, token, load, resync]);

  // Topbar content the shared App shell renders when remote — the game gets ONE
  // header (brand · airline · date+countdown · cash · lobby/feed/messages)
  // instead of a second bar stacked above its own topbar.
  const remoteChrome = useMemo(() => ({
    clock: meta?.worldStatus === 'RUNNING'
      ? <TickCountdown nextTickAt={meta?.worldClock?.nextTickAt} paceLabel={meta?.worldClock?.paceLabel} stale={connLost} />
      : (meta?.worldStatus ? <span>world {String(meta.worldStatus).toLowerCase()}</span> : null),
    right: (
      <>
        {/* Connection state beats the raw error text: "reconnecting" is what
            the player can act on (or wait out), and it used to be invisible. */}
        {actionNotice ? (
          <span
            className="error hw-topbar-err"
            title={actionNotice}
            style={{
              fontSize: 12, maxWidth: 340, display: 'inline-flex', alignItems: 'center', gap: 6,
              overflow: 'hidden', whiteSpace: 'nowrap',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{actionNotice}</span>
            <button
              onClick={() => setActionNotice(null)}
              aria-label="Dismiss"
              style={{
                background: 'none', border: 'none', color: 'inherit', cursor: 'pointer',
                padding: 0, fontSize: 12, lineHeight: 1, flexShrink: 0,
              }}
            >✕</button>
          </span>
        ) : null}
        {connLost ? (
          <span
            className="error hw-topbar-err hw-reconnecting"
            title="Not reaching the server. The game will catch up on its own as soon as the connection is back — no refresh needed."
            style={{ fontSize: 12, whiteSpace: 'nowrap' }}
          >
            ⚠ reconnecting…
          </span>
        ) : error ? (
          <span className="error hw-topbar-err" style={{ fontSize: 12, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {String(error.message || error)}
          </span>
        ) : null}
        <a className="hw-lobby-link" href={`#/w/${worldId}`} title="Back to the world lobby">← <span className="hw-btn-label">Lobby</span></a>
        <FeedWidget worldId={worldId} token={token} myAirlineId={meta?.airlineId} />
        <MessagesWidget worldId={worldId} token={token} />
      </>
    ),
  }), [meta, error, connLost, actionNotice, worldId, token]);

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
