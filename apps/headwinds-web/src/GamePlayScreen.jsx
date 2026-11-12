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
import { useState, useEffect, useRef, useCallback, useMemo, startTransition } from 'react';
import SoloApp from '../../../src/App.jsx';
import { RemoteGameProvider, gameReducer, hydrateState, newIdSeed } from '../../../src/store/GameContext.jsx';
import { ALLOWED_PLAYER_ACTIONS } from '../../headwinds-server/src/world.mjs';
import { api, isTransientError, readableError } from './api.js';
import { shouldFastPoll, isStaleContact, sameMeta } from './connection.js';
import { authedApi, SessionExpiredError } from './authedApi.js';
import { isHidden } from './usePoll.js';
import {
  runDecisionWrite, shouldRollback, isRetryableRollback, wantsFullResync, DECISION_TIMEOUT_MS,
} from './decisionPolicy.js';
import { supabase } from './supabase.js';
import { createPortal } from 'react-dom';
import PlayerProfileScreen from './PlayerProfile.jsx';
import MessagesWidget from './Messages.jsx';
import FeedWidget from './Feed.jsx';
import { brandIndex } from '../../../src/utils/airlineBrands.js';
import AccountInboxWidget from './AccountInbox.jsx';
import SeasonResults from './SeasonResults.jsx';
import TickCountdown from './TickCountdown.jsx';
import SeasonProgress from '../../../src/components/SeasonProgress.jsx';
import { EventRulesBanner } from './EventRules.jsx';
import InviteButton from './InviteButton.jsx';
import { projectOffThread, offThreadReady } from './projectionOffThread.js';
import { carryProjectWeek } from '../../../src/utils/financeProjection.js';
import { compareDecisionResult, overlayOf } from './decisionAdoption.js';
import { applyStatePatch } from '../../../packages/engine/src/utils/statePatch.js';
import { selfVersionOf, withSelfVersion, advanceShadow } from './leanDecisions.js';
import { applyRivalsPatch, worldHalfOf } from './rivalDelta.js';
import { createScreenMemory, SCREEN_ONLY_ACTIONS, withScreenFields } from './screenMemory.js';
import { borrowProjection, hasBorrowedProjection, settleBorrowed, inheritBorrowed } from './ownProjection.js';
import '../../../src/index.css';

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

// A used-aircraft purchase (single or batch) returns the buyer's new state: adopt
// it, unless a tick has already moved us past the week it was computed in.
function adoptUsedPurchase(setState, res) {
  if (res?.state) setState((cur) => {
    if (res.state.week != null && cur?.week != null && absWeekOfState(res.state) < absWeekOfState(cur)) return cur;
    return withStatsBackfill(res.state);
  });
  return res;
}

export default function GamePlayScreen({ worldId, token, me = null }) {
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
  // Poll responses are numbered as they arrive; one is adopted only if no later
  // one has been already (adoption waits on the projection worker).
  const overlaySeq = useRef(0);
  const adoptedSeq = useRef(0);
  const latestRivals = useRef(null);
  const metaRef = useRef(null);
  metaRef.current = meta;
  // Change stamp from the last response — sent back on every poll so the server
  // can answer "unchanged" from tiny reads instead of shipping the full state
  // blob (+ every rival's blob) each time. This is the Supabase egress fix.
  const stampRef = useRef(null);
  // The server's copy of our airline as last confirmed, and its version
  // (leanDecisions.js): what a lean decision reply is a patch against.
  const shadow = useRef(null);
  // The last whole rival overlay a poll brought, and the world stamp it
  // reflected (rivalDelta.js): what a rival patch is applied to.
  const rivalShadow = useRef(null);

  // Timestamp of the last poll that actually reached the server. Everything
  // about "are we still connected?" is derived from this.
  const lastOkRef = useRef(Date.now());
  const [connLost, setConnLost] = useState(false);
  // Authoritative writes in flight. A reconnect resync adopts the server blob
  // wholesale, so hold that off while a decision is still on the wire — its
  // response is about to replace local state anyway.
  const writesInFlight = useRef(0);
  // A rollback we owe the player but have not managed to deliver: set when a
  // write fails, cleared only when authoritative state is actually adopted.
  // Until then every load is a full one (Rule 4, decisionPolicy.js) — the
  // rollback's own load usually fails for the same reason the write did.
  const resyncOwed = useRef(false);

  // `full` drops the stamp (forcing a complete state fetch) and adopts whatever
  // the server returns, week comparison bypassed. Used after a gap in contact:
  // local state may be arbitrarily stale AND may still hold optimistic edits
  // whose writes never landed, so the server is the only trustworthy version.
  const load = useCallback(async ({ full: fullRequested = false } = {}) => {
    const full = wantsFullResync({
      requested: fullRequested, pending: resyncOwed.current, writesInFlight: writesInFlight.current,
    });
    try {
      // `split=1` opts into halved responses: the server sends the state blob
      // only when OUR version moved, and the (small) rival overlay whenever any
      // rival moved. Between ticks the overwhelming majority of polls come back
      // as overlay-only, which is the whole point — we used to re-download the
      // entire save because somebody else changed a fare.
      //
      // `rbase` names the rival overlay we hold (rivalShadow) so a rival's move
      // comes back as what it changed, not 3 MB of every rival (rivalDelta.js).
      const held = !full ? rivalShadow.current : null;
      const q = !full && stampRef.current && stateRef.current
        ? `?split=1&stamp=${encodeURIComponent(stampRef.current)}${held ? `&rbase=${encodeURIComponent(held.served)}` : ''}` : '?split=1';
      const d = await authedApi(`/worlds/${worldId}/airline${q}`, { token });
      if (d.rivalsPatch) {
        // Rebuild the overlay from the one it was cut against. A patch that does
        // not fit what we hold is dropped WITHOUT taking its stamp, so the next
        // poll asks again — and, holding nothing, gets the whole overlay.
        let rebuilt = null;
        try {
          if (held && held === rivalShadow.current && held.served === d.rivalsPatch.base) rebuilt = applyRivalsPatch(held.overlay, d.rivalsPatch);
        } catch { rebuilt = null; }
        if (!rebuilt) { rivalShadow.current = null; return; }
        d.rivals = rebuilt;
      }
      if (d.rivals) rivalShadow.current = { served: worldHalfOf(d.stamp), overlay: d.rivals };
      lastOkRef.current = Date.now();
      setConnLost(false);
      // Keep the SAME meta object when the poll says nothing new. A fresh object
      // every poll rebuilt remoteChrome, which re-rendered every screen in the
      // game on a timer — on a big airline that is the Routes table, the Route
      // Finder and the projection behind them, every 4–25 s (Discord, Barca,
      // 2026-10-16). sameMeta compares the few fields by value.
      const nextMeta = { status: d.status, worldStatus: d.worldStatus, worldClock: d.worldClock, airlineId: d.airlineId,
                         restartsLeft: d.restartsLeft };
      setMeta((cur) => (sameMeta(cur, nextMeta) ? cur : nextMeta));
      if (d.stamp) stampRef.current = d.stamp;
      setError(null); // a good poll clears any stale transient error
      if (d.unchanged) return; // nothing moved server-side — keep what we have

      // The rival overlay is entirely server-derived (competitors, gate market,
      // stock pool, alliance, badges) and is stripped before persistence, so
      // adopting it can never stomp an optimistic local edit. Apply it on its
      // own whenever it arrives — including on polls that carry no blob.
      //
      // Each new state's weekly projection is worked out in a Web Worker FIRST
      // (projectOffThread) and the state adopted once it's ready, so no screen
      // runs a full weekly tick on the main thread for it. `overlaySeq` keeps a
      // slower, older response from landing on top of a newer one.
      const seq = ++overlaySeq.current;

      // Only replace local state when the server has genuinely moved on (a tick
      // landed or first load) — don't stomp optimistic edits between polls.
      // The blob now arrives WITHOUT the overlay, so re-apply whatever overlay
      // came with it; otherwise adopting a blob would blank the Rivals tab.
      const local = stateRef.current;
      const incoming = d.state ? (d.rivals ? { ...d.state, ...d.rivals } : d.state) : null;
      const adoptBlob = (s) => !stateRef.current || full || absWeekOfState(s) > absWeekOfState(stateRef.current);
      if (incoming && (!local || full || absWeekOfState(incoming) > absWeekOfState(local))) {
        const next = withStatsBackfill(incoming);
        await projectOffThread(next);
        if (!adoptBlob(next)) return;
        // A newer overlay-only poll landed while this was projected: keep its
        // rivals on top (a new week must never be dropped for an overlay).
        const newerRivals = seq < adoptedSeq.current ? latestRivals.current : null;
        if (!newerRivals) { adoptedSeq.current = seq; if (d.rivals) latestRivals.current = d.rivals; }
        setState(newerRivals ? { ...next, ...newerRivals } : next);
        // This IS the server's airline at the version the stamp names.
        const v = selfVersionOf(d.stamp);
        shadow.current = v != null ? { state: next, version: v } : null;
        if (full) resyncOwed.current = false;
        return;
      }
      if (!d.rivals) return;
      if (local) {
        const next = { ...local, ...d.rivals };
        await projectOffThread(next, { base: local, overlay: d.rivals, fromHeld: true });
        if (seq < adoptedSeq.current) return;
        adoptedSeq.current = seq;
        latestRivals.current = d.rivals;
        setState((cur) => (cur === local ? next : (cur ? { ...cur, ...d.rivals } : cur)));
      } else {
        adoptedSeq.current = seq;
        latestRivals.current = d.rivals;
        setState((cur) => (cur ? { ...cur, ...d.rivals } : cur));
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

  // A codeshare write returns the authoritative blob for OUR side. Same
  // older-week guard the gate purchases use: a response that raced a tick must
  // not drag the client back a week.
  const adoptCodeshareState = useCallback((res) => {
    if (!res?.state) return;
    setState((cur) => {
      if (res.state.week != null && cur?.week != null
          && absWeekOfState(res.state) < absWeekOfState(cur)) return cur;
      return withStatsBackfill(res.state);
    });
  }, []);

  // Player-profile overlay (phase 2): profiles open OVER the game rather than
  // hash-navigating the shell away from it — a navigation would unmount the
  // play screen and throw away open tabs, scroll and drawer state.
  const [profileAccountId, setProfileAccountId] = useState(null);
  const openProfile = useCallback((accountId) => {
    if (accountId) setProfileAccountId(accountId);
  }, []);

  // Account-level DM plumbing, mirrored from the lobby (App.jsx): the topbar
  // inbox opens straight onto a thread when `messageTo` is set, and a rival's
  // in-game profile can start one. `meAccountId` gates the profile's Message
  // button so it never offers to DM yourself (a feed/roster item can link your
  // own account). One `/me` read on mount — this is NOT polled.
  const [messageTo, setMessageTo] = useState(null);
  const [meAccountId, setMeAccountId] = useState(null);

  // End-of-season ceremony: when the world has ENDED, open the honours-roll
  // overlay once on arrival (the player can dismiss it to browse the frozen
  // game, and reopen it from the topbar). `ceremonySeen` keeps a later poll from
  // popping it back up after a manual dismiss.
  const [showCeremony, setShowCeremony] = useState(false);
  const [ceremonySeen, setCeremonySeen] = useState(false);
  useEffect(() => {
    if (meta?.worldStatus === 'ENDED' && !ceremonySeen) {
      setShowCeremony(true);
      setCeremonySeen(true);
    }
  }, [meta?.worldStatus, ceremonySeen]);
  useEffect(() => {
    if (!token) return;
    let live = true;
    authedApi('/me', { token })
      .then((d) => { if (live) setMeAccountId(d?.account?.id ?? null); })
      .catch(() => {});
    return () => { live = false; };
  }, [token]);

  // Pop-ups shown and debriefs closed are remembered by the browser, per
  // airline, instead of being written to the server as decisions
  // (screenMemory.js). The shared UI reaches it through remoteApi.
  const airlineIdForMemory = meta?.airlineId ?? null;
  const screenMemory = useMemo(() => createScreenMemory(airlineIdForMemory), [airlineIdForMemory]);
  const screenMemoryRef = useRef(screenMemory);
  screenMemoryRef.current = screenMemory;

  const remoteApi = useMemo(() => ({
    unseenToasts: (toasts) => screenMemory.unseenToasts(toasts),
    debriefDismissed: (weekKey) => screenMemory.debriefDismissed(weekKey),
    dismissDebrief: (weekKey) => screenMemory.dismissDebrief(weekKey),
    fetchRivalProfile: (airlineId) => authedApi(`/worlds/${worldId}/rivals/${airlineId}`, { token }),
    fetchWorldFeed: (params = '') => authedApi(`/worlds/${worldId}/feed${params}`, { token }),
    // World news (News tab + the topbar ticker). `airlineId` rides along so the
    // shared UI can mark your own moves and promote items that touch your
    // network without the server needing to know who is asking.
    fetchNews: (params = '') => authedApi(`/worlds/${worldId}/news${params}`, { token }),
    airlineId: meta?.airlineId ?? null,
    // Player profiles: opens the account-level profile as an overlay over the
    // game (see above). Injected as a callback so the shared Competition.jsx
    // stays inert in solo Tailwinds, where neither this callback nor
    // accountId exists.
    onViewPlayer: openProfile,
    // ── Second chances ───────────────────────────────────────────────────────
    // A bankrupt airline's every write is refused, so the shared bankruptcy
    // overlay needs a way out that is not a decision. `restartsLeft` is null on
    // a server that predates the feature, which the overlay reads as "restarts
    // unavailable" and falls back to the old lobby-only copy.
    //
    // The response carries the airline ROW, not the state blob, so adopt the new
    // company with a full reload rather than trying to reconstruct it: `full`
    // bypasses the newer-week guard in load(), which would otherwise refuse to
    // replace a same-week blob and leave the dead airline on screen. See
    // decisionPolicy.js for why that guard exists and why `full` is mandatory
    // for any re-read meant to REPLACE state.
    restartsLeft: meta?.restartsLeft ?? null,
    // The bankruptcy overlay is position:fixed over the topbar, so the "head
    // back to the lobby" copy it used to show pointed at a link the overlay
    // itself covered. Carry the href so the way out lives INSIDE the card.
    lobbyHref: `#/w/${worldId}`,
    restartAirline: (airlineName, hub) =>
      authedApi(`/worlds/${worldId}/restart`, {
        method: 'POST', token, body: { airlineName, hub },
      }).then(async (res) => { await load({ full: true }); return res; }),
    // Used aircraft market (all Headwinds worlds)
    fetchUsedAircraft: () => authedApi(`/worlds/${worldId}/used-aircraft`, { token }),
    buyUsedAircraft: (listingId) =>
      authedApi(`/worlds/${worldId}/used-aircraft/${listingId}/buy`, { method: 'POST', token })
        .then((res) => adoptUsedPurchase(setState, res)),
    // Several at once: one request, one transaction. The response adds
    // `bought` and `skipped` (each skip carries its reason).
    buyUsedAircraftBatch: (listingIds) =>
      authedApi(`/worlds/${worldId}/used-aircraft/buy`, { method: 'POST', token, body: { listingIds } })
        .then((res) => adoptUsedPurchase(setState, res)),
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
    // Alliance slot pool: the owner's per-airport share switch. The response
    // carries the fresh gate view (incl. slotPool) so the toggle reads back
    // instantly instead of waiting for the next poll.
    setGateSlotShare: (airportCode, { sharing, reservedSlots = 0 } = {}) =>
      authedApi(`/worlds/${worldId}/gates/${airportCode}/share`, {
        method: 'PUT', token, body: { sharing, reservedSlots },
      }).then((res) => { adoptGateMarket(res.gateMarket); return res; }),
    fetchAlliances: () => authedApi(`/worlds/${worldId}/alliances`, { token }),
    // ── Codeshares ───────────────────────────────────────────────────────────
    // A codeshare binds two real players, so signing one is a negotiation, not
    // a decision. Responses that change your own state carry it back whole —
    // waiting a poll to see a deal you just struck reads as the click failing.
    fetchCodeshares: () => authedApi(`/worlds/${worldId}/codeshares`, { token }),
    offerCodeshare: (toAirlineId) =>
      authedApi(`/worlds/${worldId}/codeshares/offer`, {
        method: 'POST', token, body: { toAirlineId },
      }).then((res) => { adoptCodeshareState(res); return res; }),
    decideCodeshareOffer: (offerId, decision) =>
      authedApi(`/worlds/${worldId}/codeshares/offers/${offerId}`, {
        method: 'POST', token, body: { decision },
      }).then((res) => { adoptCodeshareState(res); return res; }),
    cancelCodeshare: (partnerId) =>
      authedApi(`/worlds/${worldId}/codeshares/cancel`, {
        method: 'POST', token, body: { partnerId },
      }).then((res) => { adoptCodeshareState(res); return res; }),
    createAlliance: (name) =>
      authedApi(`/worlds/${worldId}/alliances`, { method: 'POST', token, body: { name } }),
    requestJoinAlliance: (allianceId) =>
      authedApi(`/worlds/${worldId}/alliances/${allianceId}/join`, { method: 'POST', token }),
    decideAllianceRequest: (allianceId, airlineId, decision) =>
      authedApi(`/worlds/${worldId}/alliances/${allianceId}/requests/${airlineId}`, { method: 'POST', token, body: { decision } }),
    leaveAlliance: (allianceId) =>
      authedApi(`/worlds/${worldId}/alliances/${allianceId}/leave`, { method: 'POST', token }),
  }), [worldId, token, adoptGateMarket, adoptCodeshareState, meta?.airlineId, meta?.restartsLeft, load, screenMemory]);

  const decisionSeq = useRef(0);
  // Serialize the authoritative writes. A burst of dispatches — bulk close/sell/
  // retire, or just fast clicks — must reach POST /decisions ONE AT A TIME. Fired in
  // parallel they all read the same airline `version` and race the server's
  // optimistic-concurrency check, so all but one come back 409 and those actions
  // silently no-op. The optimistic apply below still gives instant per-action
  // feedback; only the network writes queue, each adopting the previous write's new
  // version/stamp before the next goes out.
  const writeChain = useRef(Promise.resolve());

  // ── Reprojection off the main thread ──────────────────────────────────────
  // Two things leave the state on screen needing a projection it should not
  // work out itself: the player's own edit, which went up carrying the
  // previous projection (ownProjection.js), and a rival view that came back
  // with a decision (`owedRivals`). One runner serves both, one job at a time:
  // it takes the state on screen, applies any owed rival view, has the worker
  // project the result, and proposes it. The proposal stands only if the state
  // it was made from is still the one on screen; the effect below confirms it
  // or lets it go, and starts again if something is still owed. A newer click
  // therefore never waits behind an older one's figures — it replaces them.
  const owedRivals = useRef(null);        // { rivals, oseq, week } from a decision response
  const reprojection = useRef({ running: false, proposal: null });
  const reproject = useCallback(async () => {
    const job = reprojection.current;
    if (job.running || job.proposal) return;
    const target = stateRef.current;
    if (!target) return;
    let owed = owedRivals.current;
    // A newer poll's overlay has been adopted since, or the week has moved on.
    if (owed && (owed.oseq < adoptedSeq.current || owed.week < absWeekOfState(target))) { owedRivals.current = null; owed = null; }
    if (!owed && !hasBorrowedProjection(target)) return;
    job.running = true;
    const fresh = owed ? { ...target, ...owed.rivals } : { ...target };
    try { await projectOffThread(fresh, { fromHeld: true }); }
    finally { job.running = false; }
    // Unprojected (no worker, a timeout) `fresh` is still right: the screens
    // work its projection out themselves, as they always could.
    if (stateRef.current !== target) { reproject(); return; }   // superseded while projecting
    job.proposal = { target, fresh, owed };
    // Not urgent: the click has already been answered on screen.
    startTransition(() => setState((cur) => (cur === target ? fresh : cur)));
  }, []);
  useEffect(() => {
    const job = reprojection.current;
    const p = job.proposal;
    if (p) {
      if (state === p.fresh) {
        settleBorrowed(p.target);
        if (p.owed) {
          if (p.owed.oseq >= adoptedSeq.current) { adoptedSeq.current = p.owed.oseq; latestRivals.current = p.owed.rivals; }
          if (owedRivals.current === p.owed) owedRivals.current = null;
        }
        job.proposal = null;
      } else if (state !== p.target) {
        job.proposal = null;   // something else took the screen first
      }
    }
    if (!job.proposal) reproject();
  }, [state, reproject]);
  // Figures on screen are one edit old until the worker answers.
  const figuresPending = hasBorrowedProjection(state);

  // The state a decision came back with: adopt only what is actually news
  // (decisionAdoption.js). Runs OUTSIDE the write chain — the next queued write
  // must not wait on a projection.
  const settleDecision = useCallback(async (serverState, seq) => {
    if (seq !== decisionSeq.current || !serverState) return;
    const local = stateRef.current;
    // The fields a screen-only action changes (SCREEN_ONLY_FIELDS: the pop-up
    // queue, whether the debrief is open) are this browser's, not the
    // server's. Without this, one dismissal left the screen "different" from
    // the server for good, and every later click was adopted — and projected
    // on this thread, 1 s at 4,000 routes — instead of matching.
    const server = withScreenFields(serverState, local);
    // A pre-tick response landing after the weekly poll advanced us: never
    // roll the week backwards.
    const olderWeek = (cur) => server.week != null && cur?.week != null && absWeekOfState(server) < absWeekOfState(cur);
    if (olderWeek(local)) return;
    const verdict = compareDecisionResult(local, server);
    // Equal airlines: let the shadow be the state on screen, so the two share
    // their memory instead of holding a second copy of whatever was patched.
    if (verdict !== 'state' && shadow.current?.state === server) shadow.current = { ...shadow.current, state: local };
    if (verdict === 'same') return;   // the screen already shows exactly this
    if (verdict === 'overlay') {
      // The airline is as the click left it; only the rivals have moved since
      // the last poll. Hand the new rival view to the reprojection runner: it
      // is applied to whatever is on screen by then (the click's own figures
      // may still be on their way back from the worker), projected in the
      // worker first, and a newer poll's overlay still wins.
      owedRivals.current = { rivals: overlayOf(server), oseq: ++overlaySeq.current, week: absWeekOfState(server) };
      reproject();
      return;
    }
    // The server's airline differs from the optimistic one (a generated id, a
    // clamp, a refusal): its state wins, at once, as it always has.
    setState((cur) => {
      if (seq !== decisionSeq.current) return cur;
      if (olderWeek(cur)) return cur;
      return server;
    });
  }, [reproject]);

  const dispatch = useCallback((action) => {
    const { type, ...payload } = action ?? {};
    if (!ALLOWED_PLAYER_ACTIONS.has(type)) return; // ADVANCE_WEEK etc. — server-owned
    // "I have seen these pop-ups" and "I have closed the debrief" change this
    // screen and nothing else: they stay in the browser (screenMemory.js). The
    // shared UI no longer dispatches them under Headwinds; this is the net for
    // anything that still does. The projection is carried over — it reads
    // neither field — so the screens do not re-run the week for it.
    if (SCREEN_ONLY_ACTIONS.has(type)) {
      const cur = stateRef.current;
      if (type === 'CLEAR_TOASTS') screenMemoryRef.current.unseenToasts(cur?.pendingToasts);
      if (type === 'DISMISS_DEBRIEF' && cur) screenMemoryRef.current.dismissDebrief(`${cur.year}:${cur.week}`);
      setState((s) => {
        const next = gameReducer(s, action);
        if (next !== s) { carryProjectWeek(hydrateState(s), hydrateState(next)); inheritBorrowed(s, next); }
        return next;
      });
      return;
    }
    const seq = ++decisionSeq.current;
    // One id seed for both ends: the route, aircraft or order this action
    // creates gets the same id here and on the server (engine reducer `uid`),
    // so the server's answer is the state already on screen and nothing has to
    // be adopted — and projected — a second time.
    const idSeed = newIdSeed();
    const seeded = { ...action, idSeed };
    // The engine error as it stood BEFORE this action, so the response can be
    // checked for a NEWLY set one. state.error is sticky (the reducer never
    // clears it), so "res.error is truthy" is not the same as "this decision was
    // rejected" — the server applies the same test, this is the client's guard
    // for a tab talking to an older build.
    const errBefore = stateRef.current?.error ?? null;
    // Optimistic: same reducer, instant UI. When the edit leaves the airline
    // the same shape, the new state borrows the projection already on screen
    // and the worker works out its own (the reprojection runner above) — so
    // the click is answered without running the engine's week on this thread.
    setState((s) => {
      const next = gameReducer(s, seeded);
      if (next !== s && offThreadReady()) borrowProjection(s, next);
      return next;
    });
    // Authoritative: server result wins — but only the MOST RECENT decision may
    // overwrite local state, and never roll the week backwards (a pre-tick
    // response landing after the weekly poll advanced us). Stale/out-of-order
    // responses are dropped; the next poll reconciles.
    writesInFlight.current += 1;
    // A longer leash than a poll: a bulk close/sell can be a heavy write, and
    // timing out a decision the server actually applied is worse than waiting.
    // `lean`: ask for what the action changed rather than the whole airline,
    // naming the version of it we hold (leanDecisions.js). Read when the
    // request is actually sent — earlier writes in the chain move it.
    const post = () => authedApi(
      `/worlds/${worldId}/decisions${shadow.current ? `?lean=1&base=${shadow.current.version}` : ''}`,
      { method: 'POST', token, body: { type, payload: { ...payload, idSeed } }, timeoutMs: DECISION_TIMEOUT_MS },
    );
    writeChain.current = writeChain.current.then(async () => {
      // Retry rule lives in decisionPolicy.js: a lost compare-and-set (almost
      // always the weekly tick mid-commit, which holds row locks on every
      // airline for up to 30s) rolled the transaction back and wrote nothing, so
      // re-submitting the identical intent is safe and lands on the post-tick
      // state — exactly where the player wanted their new fare. A 503 the
      // server marked `retryable` (transient tx/pool failure — also wrote
      // nothing, guaranteed) is re-submitted too, after a backoff. A timeout is
      // never retried: it may already have been applied.
      const outcome = await runDecisionWrite({ post, errorBefore: errBefore });
      writesInFlight.current -= 1;

      if (outcome.ok) {
        const { res } = outcome;
        // Adopt the post-write stamp so the next poll short-circuits instead of
        // re-downloading the state we're about to render. A stale (out-of-order)
        // response is skipped — the next poll's full fetch reconciles.
        if (seq === decisionSeq.current && res.stamp) stampRef.current = res.stamp;
        // The server's airline after this write. A whole-state reply is it; a
        // lean reply is a patch on the copy we hold (the shadow). Every reply
        // moves the shadow, in order, whether or not it is the newest decision:
        // the newest one is then compared against everything that landed.
        let serverState = null;
        if (res.patch) {
          const moved = advanceShadow(shadow.current, res, applyStatePatch);
          shadow.current = moved.shadow;
          // Our half of the stamp is the version this write produced; the world
          // half stays the one our rival overlay reflects.
          if (res.version != null) stampRef.current = withSelfVersion(stampRef.current, res.version);
          if (moved.lost) {
            // The patch does not fit what we hold: fetch the airline whole.
            resyncOwed.current = true;
            if (shouldRollback(writesInFlight.current)) load({ full: true });
          } else if (moved.applied) {
            const patched = withStatsBackfill(moved.shadow.state);
            if (patched !== moved.shadow.state) shadow.current = { ...moved.shadow, state: patched };
            // Compared as the whole state used to be, with the overlay on
            // screen: a lean reply carries no rivals, the poll brings those.
            serverState = { ...patched, ...overlayOf(stateRef.current) };
            shadow.current = { ...shadow.current, state: serverState };
          }
        } else if (res.state) {
          serverState = withStatsBackfill(res.state);
          const v = selfVersionOf(res.stamp);
          shadow.current = v != null ? { state: serverState, version: v } : null;
        }
        // The server's post-write state includes every write that DID land and
        // none that did not, so adopting it settles any rollback still owed.
        if (seq === decisionSeq.current && writesInFlight.current <= 0 && serverState) resyncOwed.current = false;
        settleDecision(serverState, seq);
        // The engine accepted the request but refused the action (no cash for a
        // heavy check, an MRO base already at its certification limit). The
        // server returns 201 with the reason; before this it was thrown away, so
        // the UI just snapped back to the pre-action state with no explanation.
        if (outcome.rejection && seq === decisionSeq.current) showActionNotice(outcome.rejection);
        return;
      }

      {
        const e = outcome.error;
        if (e instanceof SessionExpiredError) { setSessionExpired(true); return; }
        // A real server rejection carries the reason the action reversed —
        // show it somewhere the player can actually read it. Transport
        // failures keep the transient-error / reconnecting treatment.
        if (isTransientError(e)) {
          setError(e);
          // A retryable 503 that exhausted its backoff retries (Rule 3,
          // decisionPolicy.js): the edit is about to be rolled back, and the
          // reconnecting banner alone reads as a network blip — the player
          // deserves to be told, in words, that the change did NOT save.
          // Without this, the revert is silent again — exactly the complaint
          // ("it's still just rolling back", Discord 2026-08-03).
          if (isRetryableRollback(e) && seq === decisionSeq.current) {
            showActionNotice(
              'That change could not be saved — the world was busy committing a game week. '
              + 'Your screen has been restored to the last saved state; please try again.',
            );
          } else if (seq === decisionSeq.current) {
            // Timeout / dropped connection: no answer at all. Say so rather
            // than let the edit quietly vanish when the rollback lands.
            showActionNotice(
              'The server did not answer, so that change may not have saved. '
              + 'Your screen will show exactly what was saved as soon as the connection is back.',
            );
          }
        } else {
          showActionNotice(String(e.message || e));
          // A real server refusal is the loudest hint that this tab is running
          // an older build than the server's rules — ask UpdatePrompt to check
          // now rather than at its next 15-minute poll.
          try { window.dispatchEvent(new Event('app:server-rejected')); } catch { /* non-DOM env */ }
        }
        // This write did not land (or, on a timeout, MIGHT not have), so the
        // optimistic apply above is now a lie and only the server knows the
        // truth. `full` is load-bearing: a shallow load() refuses to replace
        // local state unless the server's week is strictly newer, so the phantom
        // edit would sit on screen looking saved until the next tick wiped it.
        // That is the whole of "price and other route settings reset ... I only
        // notice it when I make minus" (Discord, 2026-07-30).
        //
        // Only once the chain has drained: writes are serialized, and adopting
        // the server blob while later decisions are still on the wire would
        // discard THEIR optimistic edits — the same bug in reverse.
        resyncOwed.current = true;
        if (shouldRollback(writesInFlight.current)) load({ full: true });
      }
    });
  }, [worldId, token, load, showActionNotice, settleDecision]);

  // Topbar content the shared App shell renders when remote — the game gets ONE
  // header (brand · airline · date+countdown · cash · lobby/feed/messages)
  // instead of a second bar stacked above its own topbar.
  // Logos for the Activity ticker — you and every human rival, from the state
  // this screen already polls. Keyed on the fields it reads, not the whole
  // state, so a tick doesn't rebuild the ticker.
  const brands = useMemo(
    () => brandIndex(state, meta?.airlineId ?? null),
    [state?.competitors, state?.logoId, state?.logoColor, state?.logoBg, state?.customLogo, meta?.airlineId],
  );
  const remoteChrome = useMemo(() => ({
    // Maturity label for the shared top bar: alpha | beta | live (live shows
    // no chip at all). Defaults to beta until the first state read lands.
    stage: meta?.worldStage ?? 'beta',
    // A scheduled world in LOBBY is playable before its start; its clock counts
    // down to week 1 instead of reading "world lobby".
    clock: (meta?.worldStatus === 'RUNNING' || (meta?.worldStatus === 'LOBBY' && meta?.worldClock?.nextTickAt))
      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <TickCountdown nextTickAt={meta?.worldClock?.nextTickAt} paceLabel={meta?.worldClock?.paceLabel} stale={connLost}
            preStart={meta?.worldStatus === 'LOBBY'} startsAt={meta?.worldClock?.startsAt}
            weeksPerDay={meta?.worldClock?.weeksPerDay ?? null} />
          {/* Lit while the figures on screen are one edit old and the worker is
              working out the new ones (ownProjection.js). Always in the layout,
              so the bar does not shift when it comes and goes. */}
          <span
            className="hw-figures-pending"
            role="status"
            aria-label={figuresPending ? 'Updating figures' : undefined}
            title={figuresPending ? 'Updating figures…' : undefined}
            style={{
              width: 6, height: 6, borderRadius: '50%', flex: 'none', background: 'var(--accent)',
              opacity: figuresPending ? 0.9 : 0, transition: 'opacity 0.12s',
            }}
          />
          {/* Season progress: week of the world's length, final stretch shaded. */}
          {meta?.worldStatus === 'RUNNING' && meta?.worldClock?.totalWeeks > 0 && (
            <SeasonProgress compact totalWeeks={meta.worldClock.totalWeeks}
              weeksFlown={((meta.worldClock.year ?? 1) - 1) * 52 + (meta.worldClock.week ?? 1) - 1} />
          )}
        </span>
      : (meta?.worldStatus ? <span>world {String(meta.worldStatus).toLowerCase()}</span> : null),
    // The same clock as data, for the globe's day/night and planes
    // (src/components/gameClock.js). Null when the world isn't ticking.
    gameClock: (meta?.worldStatus === 'RUNNING' || (meta?.worldStatus === 'LOBBY' && meta?.worldClock?.nextTickAt))
      ? { nextTickAt: meta?.worldClock?.nextTickAt ?? null, weeksPerDay: meta?.worldClock?.weeksPerDay ?? null,
          preStart: meta?.worldStatus === 'LOBBY' }
      : null,
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
            {readableError(error)}
          </span>
        ) : null}
        {meta?.worldStatus === 'ENDED' && (
          <button
            className="hw-lobby-link" onClick={() => setShowCeremony(true)}
            title="See the final results and season awards"
            style={{ background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
          >🏁 <span className="hw-btn-label">Results</span></button>
        )}
        <a className="hw-lobby-link" href={`#/w/${worldId}`} title="Back to the world lobby">← <span className="hw-btn-label">Lobby</span></a>
        {meta?.worldStatus !== 'ENDED' && <InviteButton worldId={worldId} token={token} variant="topbar" airlineId={meta?.airlineId ?? null} />}
        <FeedWidget worldId={worldId} token={token} myAirlineId={meta?.airlineId} brands={brands} />
        <MessagesWidget worldId={worldId} token={token} onViewPlayer={openProfile} />
        {/* Account-level DMs (cross-world). The widget was lobby-only, so a DM to
            an actively-playing player was unreachable until they left the game.
            It self-polls /me/messages for its own unread badge. */}
        <AccountInboxWidget
          token={token}
          requestThread={messageTo}
          onConsumeRequest={() => setMessageTo(null)}
        />
      </>
    ),
  }), [meta, error, connLost, actionNotice, worldId, token, openProfile, messageTo, brands, figuresPending]);

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
        <p className="error">{readableError(error)}</p>
        <a href={`#/w/${worldId}`}>← Back to world</a>
      </div>
    );
  }
  if (!state) return <div style={{ padding: 24 }}><p className="muted">Loading your airline…</p></div>;

  return (
    <div className="hw-game">
      {/* Event worlds: the weird rules, one tap away for the whole game
          (EventRules.jsx). Renders nothing in a normal world. */}
      {state?.eventRules && (
        <div style={{ padding: '0 12px' }}>
          <EventRulesBanner rules={state.eventRules} year={state.year ?? 1} />
        </div>
      )}
      <RemoteGameProvider state={state} dispatch={dispatch} remoteApi={remoteApi} remoteChrome={remoteChrome}>
        <SoloApp />
      </RemoteGameProvider>
      {/* Player-profile overlay. Portal to <body> for the same reason the
          messages drawer does: the topbar's backdrop-filter makes the game a
          containing block for position:fixed. */}
      {profileAccountId && createPortal(
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setProfileAccountId(null); }}
          style={{ position: 'fixed', inset: 0, zIndex: 1000,
                   background: 'rgba(0,0,0,.55)', overflowY: 'auto',
                   padding: '32px 16px' }}
        >
          <div className="shell" style={{ maxWidth: 720, margin: '0 auto' }}>
            <PlayerProfileScreen
              accountId={profileAccountId} token={token}
              onClose={() => setProfileAccountId(null)}
              onMessage={meAccountId && meAccountId !== profileAccountId
                ? (id) => { setProfileAccountId(null); setMessageTo(id); } : null}
            />
          </div>
        </div>,
        document.body
      )}
      {/* End-of-season ceremony overlay — same portal treatment as the profile,
          because the topbar's backdrop-filter makes the game a containing block
          for position:fixed. */}
      {showCeremony && createPortal(
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setShowCeremony(false); }}
          style={{ position: 'fixed', inset: 0, zIndex: 1000,
                   background: 'rgba(0,0,0,.55)', overflowY: 'auto',
                   padding: '32px 16px' }}
        >
          <div className="shell" style={{ maxWidth: 720, margin: '0 auto' }}>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn small" onClick={() => setShowCeremony(false)}>✕ Close</button>
            </div>
            <SeasonResults worldId={worldId} token={token} myAirlineId={meta?.airlineId ?? null} me={me} />
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
