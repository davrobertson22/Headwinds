import { useState, useMemo, useEffect, useRef } from 'react';
import { useGame, cometWithdrawn } from '../store/GameContext.jsx';
import { getAirport } from '../data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType, aircraftOrderable } from '../data/aircraft.js';
import { effectiveRangeKm, formatMoney, calendarYear, currentGameDate, maxWeeklyBlockHoursFor } from '../utils/simulation.js';
import { buildRouteMarket } from '../models/demand.js';
import {
  findCandidates, sortCandidates, SORTS, DEFAULT_SCORE_LIMIT,
  rivalTopologyKey, finderForecastContext, forecastCandidate, candidateFrequency, rowsToScore,
  laneServed, rankByDemandLeft,
} from '../models/routeFinder.js';
import ServedCell from './FinderServed.jsx';
import { REGION_LABELS, REGION_ORDER, regionLabel } from '../utils/market.js';
import { Glyph } from './Icons.jsx';
import InfoTip from './InfoTip.jsx';
import OriginPicker from './OriginPicker.jsx';
import { useSlotPosition, SlotCell, OriginSlotsLine } from './FinderSlots.jsx';
import BatchOpenReview from './BatchOpenReview.jsx';
import { useRememberedState, finderMemoryKey, finderForecastStore } from '../utils/finderMemory.js';
import { loadFigures, saveFigures } from '../utils/finderFigures.js';
import { getForecastPool } from '../utils/finderWorkerPool.js';
import { idleTailsOfType, pickKey, MAX_BATCH } from '../../packages/engine/src/models/routeBatch.js';

const PAGE_SIZE = 25;

// Forecasting is priced a few rows at a time, this many milliseconds of work per
// render, with the browser handed back control in between. Each forecast is a
// network-tick projection — ~50 ms a market in Node on a 450-route airline, a
// few times that in a browser — and the finder used to price its whole page
// (150 rows on a profit sort) in one synchronous pass: seconds of frozen page on
// every search change (Discord, 2026-10-16). A small airline still finishes
// inside the first slice, so for most players nothing visibly changes.
const FORECAST_SLICE_MS = 24;

// performance.now where there is one (browsers, Node), Date.now otherwise.
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Same inputs, same order, by identity — the forecast cache's validity test. */
function sameDeps(a, b) {
  return !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

// The forecast cache, per finder panel (finderMemoryKey), at module scope like
// the search itself (utils/finderMemory.js), so a trip to the planner and back
// does not start the pricing over.
//
// Discord, 2026-10-17 (Kadicuss): "+ Gate" on a row reset a profit sort to
// most-demand and started "forecasting 2 of 150…" again. The lease is a network
// change, so every forecast WAS out of date — but the cache simply dropped
// them, and a forecast sort with nothing priced holds demand order until all
// 150 are back. Now the previous figures are kept as STALE: they stand in,
// dimmed, while the fresh ones are priced, so the table keeps its order and
// re-ranks in place. Stale figures only carry over while the forecast is for
// the same airframe — a different aircraft is a different question.
// The store itself lives in utils/finderMemory.js (clearFinderMemory clears it).
const forecastCaches = finderForecastStore();
const MAX_STALE = 3000;

/** Which airframe a forecast context prices — stale figures are only reused for the same one. */
function ctxIdentity(ctx) {
  return ctx ? `${ctx.type.id}|${ctx.frame.id}|${ctx.frameLease}|${ctx.weeklyFrequency}` : '';
}

/** finderForecastContext's input for a context — what a worker rebuilds it from. */
function ctxInput(ctx) {
  return {
    aircraftTypeId: ctx.type.id,
    aircraft: ctx.frame.id === '__finder__' ? null : ctx.frame,
    weeklyFrequency: ctx.weeklyFrequency,
    gameDate: ctx.gameDate,
    capHours: ctx.capHours,
  };
}

/** Tooltip for a dimmed (stale) forecast cell. */
function staleTip(r) {
  if (!r.refreshing) return undefined;
  return r.staleAsOf
    ? `Updating — this is your last forecast for this route (${r.staleAsOf})`
    : 'Updating — your network changed, this is the previous forecast';
}

/** "week 12, 2031" — the week a saved figure was priced in. */
function asOfLabel(asOf) {
  return asOf && asOf.week != null && asOf.year != null ? `week ${asOf.week}, ${asOf.year}` : 'an earlier visit';
}

/**
 * Route Finder — scans every airport reachable from a chosen origin and ranks
 * the markets you don't serve yet.
 *
 * The search is built around an AIRCRAFT, not a distance box. Picking one out of
 * your own fleet is what lets the finder answer the three questions a demand
 * table cannot: can this metal land there (range AND runway, via the engine's own
 * guard), have you already taken that traffic from the other airport in the same
 * city, and what would the route actually clear. All three came out of one
 * Discord thread — see models/routeFinder.js for the quotes and the reasoning.
 *
 * `standalone` is the Route Finder tab (components/RouteFinderScreen.jsx): the
 * panel is the whole screen, so it opens expanded and drops the show/hide header.
 * Collapsed-by-default is for when it is one card among many.
 *
 * `onPick` is optional in every sense — a finder with no planner attached is a
 * perfectly good market browser, and the button that calls it is one exit from
 * this screen rather than the next step of a form.
 */
export default function RouteFinder({ onPick, standalone = false }) {
  const { state, remoteChrome } = useGame();
  // Free gate slots per airport, counted the way the engine's guards count them.
  const slotPosition = useSlotPosition();

  const [open, setOpen]         = useState(!!standalone);
  // The search survives the trip to the planner and back (utils/finderMemory.js):
  // opening routes for a delivery of twelve A320s used to mean re-picking the
  // aircraft and re-sorting this table twelve times.
  const mem = finderMemoryKey(state, 'passenger');
  const [origin, setOrigin]     = useRememberedState(mem, 'origin', state.hub || '', c => !c || !!getAirport(c));
  const [minDist, setMinDist]   = useRememberedState(mem, 'minDist', '');
  const [maxDist, setMaxDist]   = useRememberedState(mem, 'maxDist', '');
  const [region, setRegion]     = useRememberedState(mem, 'region', '');
  const [soloOnly, setSoloOnly] = useRememberedState(mem, 'soloOnly', false);
  const [showUnflyable, setShowUnflyable] = useRememberedState(mem, 'showUnflyable', false);
  const [showServed, setShowServed]       = useRememberedState(mem, 'showServed', false);
  const [splitMetros, setSplitMetros]     = useRememberedState(mem, 'splitMetros', false);
  const [sortBy, setSortBy]     = useRememberedState(mem, 'sortBy', 'demand', v => !!SORTS[v]);
  const [limit, setLimit]       = useRememberedState(mem, 'limit', PAGE_SIZE, v => Number.isFinite(v) && v > 0);
  // The shortlist: rows ticked to open together, one idle tail each
  // (models/routeBatch.js). Kept with the search, so a Plan → detour to look
  // at one route closely does not drop the other picks.
  const [picks, setPicks]       = useRememberedState(mem, 'picks', [], Array.isArray);
  const [reviewing, setReviewing] = useState(false);

  // currentGameDate carries absWeek — the finder's forecasts grow with the world.
  const gameDate = currentGameDate(state);
  const originAirport = getAirport(origin);

  // ── Your fleet, as the picker sees it ──────────────────────────────────────
  // "you always have to find the aircraft you own for its max range etc — it
  // would be nice if there was a section like in the route planner thats like
  // the aircraft you own" (ASAS). The planner has had that split for months; the
  // finder was still offering the whole catalogue in raw catalogue order.
  //
  // The tail that matters per type is the LONGEST-LEGGED one you own: range mods
  // (engines, wingtips, a cabin light enough to trade payload for fuel) are per
  // airframe, so quoting the catalogue figure would hide markets your best jet of
  // that type can genuinely reach.
  const fleetTypes = useMemo(() => {
    const byType = new Map();
    for (const a of state.fleet ?? []) {
      const t = getAircraftType(a.typeId);
      if (!t || t.freighter) continue;
      const reach = Math.round(effectiveRangeKm(a, t));
      const cur = byType.get(t.id);
      if (!cur) byType.set(t.id, { type: t, count: 1, best: a, reach, idle: 0 });
      else {
        cur.count += 1;
        if (reach > cur.reach) { cur.best = a; cur.reach = reach; }
      }
    }
    // Idle as the batch counts it — reserves are parked on purpose, a tail in the
    // shop cannot fly — so "6 idle" here is the number a shortlist can fill.
    for (const f of byType.values()) f.idle = idleTailsOfType(state.fleet, f.type.id).length;
    return [...byType.values()].sort((x, y) => y.count - x.count || x.type.name.localeCompare(y.type.name));
  }, [state.fleet]);

  // Default to the type you own the most of — the plane you are actually going to
  // fly the next route with. An empty selection is still available ("Any
  // aircraft"), it just isn't what a fleet owner wants on arrival.
  const [typeId, setTypeId] = useRememberedState(mem, 'typeId', () => fleetTypes[0]?.type.id ?? '',
    id => id === '' || !!getAircraftType(id));
  const owned = fleetTypes.find(f => f.type.id === typeId) ?? null;
  const selectedType = typeId ? getAircraftType(typeId) : null;
  const reach = selectedType
    ? (owned?.reach ?? Math.round(effectiveRangeKm({ typeId }, selectedType)))
    : 0;

  const catalogueTypes = useMemo(
    () => AIRCRAFT_TYPES.filter(t => !t.freighter && aircraftOrderable(t, calendarYear(state)) && !cometWithdrawn(state, t.id) && !fleetTypes.some(f => f.type.id === t.id)),
    [fleetTypes]
  );

  function resetPaging() { setLimit(PAGE_SIZE); }

  // Who flies what, as one stable string — see rivalTopologyKey. Cheap enough to
  // run every render (it is memoised per rival object in the engine).
  const rivalKey = rivalTopologyKey(state);

  // ── Candidates (cheap: no demand model, safe to re-run on every keystroke) ──
  const rows = useMemo(() => {
    if (!originAirport || !open) return [];
    return findCandidates(state, {
      origin,
      aircraftTypeId: typeId,
      aircraft: owned?.best ?? null,
      minDistKm: parseInt(minDist, 10) || 0,
      maxDistKm: parseInt(maxDist, 10) || Infinity,
      region,
      hideUnflyable: !showUnflyable,
      hideServedLanes: !showServed,
      soloOnly,
      groupMetros: !splitMetros,
    });
    // `rivalKey` rather than the three rival objects themselves. In Headwinds
    // those are replaced wholesale by every rival-overlay poll — every few
    // seconds, whenever ANY player in the world moves — so depending on their
    // identity rebuilt this list, and the bounded forecast pass below with it,
    // on a timer. The key changes when the competitive map changes and holds
    // still when rivals merely re-price, which is all the finder reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.routes, rivalKey,
      origin, open, typeId, owned?.best, minDist, maxDist, region, showUnflyable, showServed,
      soloOnly, splitMetros]);

  // ── How much of each market is already flown ───────────────────────────────
  // models/routeFinder.js laneServed: the tick's share fight with everyone on
  // the lane, at maturity. Under a millisecond a lane, so it is priced for the
  // rows on screen (and, under "Most demand left", as far down as that ranking
  // needs) and cached until your network, the rival map or the week moves —
  // keyed on rivalKey like the rows, not on the rival overlay's identity, so a
  // fare nudge somewhere in the world does not re-price the column on a timer.
  // It does not depend on the aircraft picked.
  const servedCache = useMemo(
    () => new Map(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.routes, rivalKey, state.fleet, state.hubs, state.routePricing, state.activeEvents,
     state.week, gameDate.month]);
  const servedOf = (r) => {
    const k = `${r.origin}|${r.code}|${r.yourLanePairs?.[0] ?? ''}`;
    if (!servedCache.has(k)) servedCache.set(k, laneServed(state, r, { gameDate }));
    return servedCache.get(k);
  };

  // ── Forecasts, bounded and progressive ─────────────────────────────────────
  // The engine's real launch projection, so "Plan →" cannot contradict the row it
  // was clicked on. Bounded two ways, as before:
  //
  //   ranking by a forecast   the field has to be priced before it can be ranked,
  //                           so the biggest DEFAULT_SCORE_LIMIT markets get one
  //                           and the footer says out loud which rows did not —
  //                           a silent cap reads as "nothing below is worth flying".
  //   ranking by anything else  only the page you are looking at is priced.
  //
  // And now priced progressively (FORECAST_SLICE_MS a render) into a cache that
  // belongs to the NETWORK, not the search: it is dropped when your routes,
  // fleet, gates, hubs, the rivals' map, the aircraft or the month change, and
  // kept through everything else — so typing in the distance boxes, flipping a
  // filter or paging re-prices only rows it hasn't seen.
  const forecastReady  = !!typeId;
  const forecastSort   = !!SORTS[sortBy]?.needsForecast;
  // The block-hour ceiling the planner and ADD_ROUTE use, so a long sector is
  // forecast at the frequency it could actually open at, not the catalogue cap.
  const capNow = maxWeeklyBlockHoursFor(state);
  const forecastCtx = useMemo(
    () => (forecastReady
      ? finderForecastContext({ aircraftTypeId: typeId, aircraft: owned?.best ?? null, weeklyFrequency: 7, gameDate,
                                capHours: maxWeeklyBlockHoursFor(state) })
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [forecastReady, typeId, owned?.best, gameDate.month, capNow]);

  // The context by VALUE, not identity: forecastCtx is rebuilt on every mount,
  // and the cache is meant to outlive one (the trip to the planner and back).
  const ctxId = ctxIdentity(forecastCtx);
  const cacheDeps = [state.routes, rivalKey, state.fleet, state.gates, state.hubs, state.allianceSlotPool,
                     `${ctxId}|${gameDate.month}|${capNow}`];
  // Saved figures belong to one airline (Headwinds' airline id is unique across
  // worlds; solo has one airline) and one finder panel.
  const figureScope = `${remoteChrome?.airlineId ?? ''}|${mem}`;
  let entry = forecastCaches.get(mem);
  if (!entry || !sameDeps(entry.deps, cacheDeps)) {
    // Out of date: start a fresh map, and keep what we had as stale figures
    // when it is still the same airframe being priced.
    let stale = new Map();
    const savedAsOf = new Map();
    if (entry && ctxId && entry.ctxId === ctxId) {
      stale = entry.stale.size + entry.map.size > MAX_STALE ? new Map(entry.map) : new Map(entry.stale);
      for (const [k, v] of entry.map) stale.set(k, v);
      for (const [k, label] of entry.savedAsOf ?? []) if (!entry.map.has(k) && stale.has(k)) savedAsOf.set(k, label);
    }
    // The last visit's figures (utils/finderFigures.js) — a reload, a new week,
    // or this aircraft priced earlier — stand in behind anything priced since,
    // so the finder opens ranked instead of "forecasting 0 of 150…".
    const saved = ctxId ? loadFigures(figureScope, ctxId) : null;
    if (saved) {
      const label = asOfLabel(saved.asOf);
      for (const [k, v] of saved.map) {
        if (stale.size >= MAX_STALE) break;
        if (stale.has(k)) continue;
        stale.set(k, v);
        savedAsOf.set(k, label);
      }
    }
    entry = { deps: cacheDeps, ctxId, map: new Map(), stale, savedAsOf, savedSize: 0 };
    forecastCaches.set(mem, entry);
  }
  const cache = entry.map;
  const stale = entry.stale;
  const keyOf = (r) => (forecastCtx ? `${r.origin}|${r.code}|${candidateFrequency(r, forecastCtx)}|${r.refPrice}` : '');
  // A figure to show: the fresh one, else the previous one while it is re-priced.
  const known = (k) => cache.has(k) || stale.has(k);

  // Which rows this view needs priced, in the order to price them.
  const sortedRows = useMemo(
    () => (sortBy === 'room' ? rankByDemandLeft(rows, servedOf, limit) : sortCandidates(rows, sortBy)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, sortBy, sortBy === 'room' ? limit : 0, servedCache]);
  const targets = useMemo(() => {
    if (!forecastCtx || rows.length === 0) return [];
    const list = forecastSort
      ? rowsToScore(rows, { limit: DEFAULT_SCORE_LIMIT, order: 'demand' }).map(i => rows[i])
      : sortedRows.slice(0, limit);
    return list.filter(r => !r.block);
  }, [forecastCtx, rows, sortedRows, forecastSort, limit]);

  // Who prices: the worker pool (utils/finderWorkerPool.js) where the browser
  // has one — off the main thread, on several cores — else this render, a
  // slice at a time. A pool that breaks hands back to the slices.
  const pool = forecastCtx ? getForecastPool() : null;

  // Price what's missing, up to the slice budget.
  if (!pool) {
    const t0 = now();
    for (const r of targets) {
      const k = keyOf(r);
      if (cache.has(k)) continue;
      if (now() - t0 > FORECAST_SLICE_MS) break;
      cache.set(k, forecastCandidate(state, r, forecastCtx));
    }
  }
  const pending = targets.reduce((n, r) => n + (cache.has(keyOf(r)) ? 0 : 1), 0);

  // More to do: hand the browser back a frame, then render again to price the
  // next slice. A change of search simply re-targets; nothing priced is lost.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (pool || pending === 0) return undefined;
    const t = setTimeout(() => setTick(v => v + 1), 0);
    return () => clearTimeout(t);
  });

  // Worker results arrive a few rows at a time; repaint at most once a frame.
  const repaint = useRef(null);
  const bump = () => {
    if (repaint.current) return;
    const later = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16);
    repaint.current = later(() => { repaint.current = null; setTick(v => v + 1); });
  };
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!pool || !forecastCtx) return;
    const e = entry;
    const tasks = [];
    for (const r of targets) {
      const k = keyOf(r);
      if (e.map.has(k)) continue;
      tasks.push({ key: k, row: { origin: r.origin, code: r.code, distKm: r.distKm, refPrice: r.refPrice, block: r.block } });
    }
    // Replaces this panel's queue: a new search drops the old one's rows.
    pool.submit(mem, {
      state: stateRef.current, ctx: ctxInput(forecastCtx), token: e,
      onResult: (k, projection) => { e.map.set(k, projection); bump(); },
      onFail: () => bump(),
    }, tasks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, entry, targets, forecastCtx]);

  // Everything this view needs is priced: keep it for the next visit.
  useEffect(() => {
    if (!ctxId || pending > 0 || cache.size === 0 || entry.savedSize === cache.size) return;
    entry.savedSize = cache.size;
    saveFigures(figureScope, ctxId, cache, { year: calendarYear(state), week: state.week ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, pending, cache.size, ctxId, figureScope]);

  const withForecast = (r) => {
    if (!forecastCtx || r.block) return r;
    const k = keyOf(r);
    if (cache.has(k)) {
      const projection = cache.get(k);
      return projection ? { ...r, scored: true, projection } : r;
    }
    if (!stale.has(k)) return r;
    const projection = stale.get(k);
    return projection ? { ...r, scored: true, projection, refreshing: true, staleAsOf: entry.savedAsOf?.get(k) ?? null } : r;
  };
  // Under a forecast sort the order is only meaningful once the field is
  // priced; until then the list holds its demand order and says it's working.
  // Rows with a stale figure count as priced: re-pricing after a network change
  // (a gate, a new route) re-ranks the table in place rather than resetting it.
  const unknown = targets.reduce((n, r) => n + (known(keyOf(r)) ? 0 : 1), 0);
  const ranking = forecastSort && unknown > 0;
  // Every row has a figure, some only the previous one: say "updating", not "forecasting".
  const refreshing = pending > 0 && unknown === 0;
  const results = forecastSort
    ? (ranking ? sortCandidates(rows, 'demand').map(withForecast) : sortCandidates(rows.map(withForecast), sortBy))
    : sortedRows.map(withForecast);

  const shown    = results.slice(0, limit);
  const unscored = forecastSort && !ranking ? results.filter(r => !r.scored && !r.block).length : 0;

  // ── Shortlist ──────────────────────────────────────────────────────────────
  // Only offered for a type you own with an idle tail to spare: a pick is a
  // route for one of THOSE planes, and the review assigns them.
  const canPick      = !!owned && owned.idle > 0;
  const pickedKeys   = new Set(picks.map(p => pickKey(p.origin, p.destination)));
  const pickedOfType = picks.filter(p => p.typeId === typeId).length;
  const idleUnpicked = owned ? Math.max(0, owned.idle - pickedOfType) : 0;
  const pickFull     = idleUnpicked === 0 || picks.length >= MAX_BATCH;
  function togglePick(r) {
    const k = pickKey(origin, r.code);
    setPicks(prev => prev.some(p => pickKey(p.origin, p.destination) === k)
      ? prev.filter(p => pickKey(p.origin, p.destination) !== k)
      : [...prev, { origin, destination: r.code, typeId }]);
  }

  // Seasonality only for visible rows (cheap: <= limit calls). Keyed on the codes
  // shown — `shown` is a new array on every render, and the progressive
  // forecast renders several times in a row.
  const shownCodes = shown.map(r => r.code).join(',');
  const seasonalByCode = useMemo(() => {
    const m = new Map();
    for (const r of shown) {
      m.set(r.code, buildRouteMarket(origin, r.code, gameDate).seasonalityFactor);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownCodes, origin, gameDate.month]);

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      {/* Header / toggle */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: standalone ? 'default' : 'pointer' }}
        onClick={standalone ? undefined : () => setOpen(v => !v)}
      >
        <span style={{ fontSize: 16 }}><Glyph e="🔍" /></span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            Route Finder
            <InfoTip text="Scans every airport reachable from a chosen origin and lists the markets you don't serve yet. Pick an aircraft and the search narrows to what that plane can legally fly — range and runway both — and each row is forecast with the same projection the Route Planner uses. Airports in one city share a single market, so a lane you already fly from a sibling airport is not listed as new. Looking costs nothing and commits nothing." />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Unserved markets your aircraft can actually fly, ranked
          </div>
        </div>
        {!standalone && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{open ? '▴ Hide' : '▾ Show'}</span>}
      </div>

      {open && (
        <div style={{ marginTop: 14 }}>
          {/* Controls */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>

            {/* Origin — your own network first (components/OriginPicker.jsx) */}
            <OriginPicker
              value={origin}
              onChange={code => { setOrigin(code); resetPaging(); }}
            />

            {/* Aircraft — your fleet first, catalogue after */}
            <div>
              <div className="form-label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                Aircraft
                <InfoTip text="Search with a specific aircraft and the finder hides everything it cannot legally fly — beyond its range, or a runway too short for it — and forecasts each remaining market on that type. Aircraft you own come first, and their range is the range of your best-equipped tail, not the catalogue figure. “Any aircraft” goes back to browsing raw demand." />
              </div>
              <select
                className="form-select"
                value={typeId}
                onChange={e => { setTypeId(e.target.value); resetPaging(); }}
                style={{ width: 260 }}
              >
                <option value="">Any aircraft — just show me demand</option>
                {fleetTypes.length > 0 && (
                  <optgroup label="In your fleet">
                    {fleetTypes.map(f => (
                      <option key={f.type.id} value={f.type.id}>
                        {f.type.name} — {f.count} owned{f.idle > 0 ? ` · ${f.idle} idle` : ''} · {f.reach.toLocaleString()} km
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Not in your fleet">
                  {catalogueTypes.map(t => (
                    <option key={t.id} value={t.id}>{t.name} — {t.range.toLocaleString()} km</option>
                  ))}
                </optgroup>
              </select>
              {selectedType && (
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>
                  {reach.toLocaleString()} km · needs {selectedType.runwayFt ? `${selectedType.runwayFt.toLocaleString()} ft` : 'no listed'} runway
                  {owned ? '' : ' · lease required'}
                </div>
              )}
            </div>

            {/* Region */}
            <div>
              <div className="form-label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                Region
                <InfoTip text="Narrow the search to one part of the world. These are the same regions the demand model uses to price international traffic — travellers cross a border inside their own region far more readily than they leave it — so the region on a row is also part of why that market is the size it is." />
              </div>
              <select
                className="form-select"
                value={region}
                onChange={e => { setRegion(e.target.value); resetPaging(); }}
                style={{ width: 210 }}
              >
                <option value="">Any region — the whole world</option>
                {REGION_ORDER.map(code => (
                  <option key={code} value={code}>{REGION_LABELS[code]}</option>
                ))}
              </select>
            </div>

            {/* Distance band */}
            <div>
              <div className="form-label" style={{ marginBottom: 6 }}>Distance (km)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="number" min={0} placeholder="min" value={minDist}
                  onChange={e => { setMinDist(e.target.value); resetPaging(); }}
                  className="form-input" style={{ width: 80, textAlign: 'center' }}
                />
                <span style={{ color: 'var(--text-dim)' }}>–</span>
                <input
                  type="number" min={0} placeholder="max" value={maxDist}
                  onChange={e => { setMaxDist(e.target.value); resetPaging(); }}
                  className="form-input" style={{ width: 80, textAlign: 'center' }}
                />
              </div>
            </div>

            {/* Sort */}
            <div>
              <div className="form-label" style={{ marginBottom: 6 }}>Sort by</div>
              <select
                className="form-select"
                value={sortBy}
                onChange={e => { setSortBy(e.target.value); resetPaging(); }}
                style={{ width: 180 }}
              >
                {Object.entries(SORTS).map(([id, o]) => (
                  <option key={id} value={id} disabled={o.needsForecast && !forecastReady}>
                    {o.label}{o.needsForecast && !forecastReady ? ' (pick an aircraft)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Filter toggles */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12, fontSize: 12, color: 'var(--text-muted)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={soloOnly} onChange={e => { setSoloOnly(e.target.checked); resetPaging(); }} style={{ accentColor: 'var(--accent)' }} />
              No competitors only
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: selectedType ? 'pointer' : 'not-allowed', opacity: selectedType ? 1 : 0.45 }}
                   title={selectedType ? 'Include markets this aircraft is barred from — out of range, or the runway is too short for it' : 'Pick an aircraft first'}>
              <input type="checkbox" disabled={!selectedType} checked={showUnflyable} onChange={e => { setShowUnflyable(e.target.checked); resetPaging(); }} style={{ accentColor: 'var(--accent)' }} />
              Show what this aircraft can't fly
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                   title="Airports in one city share a single market. By default a lane you already fly is hidden even when you'd be flying it from the other airport in that city.">
              <input type="checkbox" checked={showServed} onChange={e => { setShowServed(e.target.checked); resetPaging(); }} style={{ accentColor: 'var(--accent)' }} />
              Show lanes I already serve
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                   title="One row per market by default, at the airport the city's travellers actually prefer. Washington is four airports and one pool of people — listed separately they read as four opportunities.">
              <input type="checkbox" checked={splitMetros} onChange={e => { setSplitMetros(e.target.checked); resetPaging(); }} style={{ accentColor: 'var(--accent)' }} />
              List every airport in a city
            </label>
          </div>

          {reviewing && picks.length > 0 && (
            <BatchOpenReview
              picks={picks}
              setPicks={setPicks}
              onClose={() => setReviewing(false)}
            />
          )}

          {/* Results */}
          {!originAirport ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              Choose an origin airport to search from.
            </div>
          ) : results.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              No unserved routes match these filters.
              {region && <> Nothing in {REGION_LABELS[region]} is left — try “Any region”.</>}
              {selectedType && !showUnflyable && <> Try “Show what this aircraft can't fly” to see what {selectedType.name} is being kept out of.</>}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                {results.length.toLocaleString()} market{results.length !== 1 ? 's' : ''} from {originAirport.code}{region ? ` in ${REGION_LABELS[region]}` : ''} · showing {shown.length}
                {forecastReady && <> · forecast on {selectedType.name} at 7 flights/wk, reference fares</>}
                {pending > 0 && (
                  <span data-forecast-progress="" style={{ color: 'var(--accent)' }}>
                    {' '}· {refreshing ? 'updating forecasts' : 'forecasting'} {targets.length - pending} of {targets.length}…
                    {ranking && ` ranked by ${SORTS[sortBy].label.toLowerCase()} once all are in`}
                  </span>
                )}
                {canPick && (
                  <> · <span style={{ color: 'var(--yellow)' }}>{owned.idle} idle {selectedType.name}{owned.idle !== 1 ? 's' : ''}</span> — tick rows to open several at once</>
                )}
              </div>
              <OriginSlotsLine code={originAirport.code} freq={7} position={slotPosition} />
              <div style={{ overflowX: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface2)' }}>
                      {canPick && (
                        <th style={{ padding: '7px 4px 7px 12px', width: 1 }}>
                          <InfoTip text={`Tick the routes you want and open them together, one idle ${selectedType.name} each. Nothing opens until you review the list — every pick is checked and forecast after the ones above it, so they can't double-book a plane, a slot or your cash.`} />
                        </th>
                      )}
                      {[
                        { h: 'Destination', right: false },
                        { h: 'Distance',    right: true  },
                        { h: 'Market',      right: true, tip: "The whole city-pair market per week. Airports in one metro share it: JFK–LHR and EWR–LHR are one New York↔London market, not two." },
                        { h: 'Served',      right: true, tip: "How much of the market is already flown — everyone on the lane, rivals' one-stops over their hubs and your own services included, from the same share fight the weekly results run (at maturity, this month). Low is room for you; near 100% means a new route mostly takes passengers from someone. Hover a figure for who carries what." },
                        { h: 'Ref fare',    right: true  },
                        { h: 'Rivals',      right: false, tip: 'Carriers flying this market from any airport in either city.' },
                        { h: 'Est. load',   right: true, tip: 'Projected mature load factor for the selected aircraft at 7 flights a week — the same projection the Route Planner runs.' },
                        { h: 'Est. profit', right: true, tip: 'Weekly net after operating cost, landing fees and the lease on the aircraft flying it.' },
                        { h: 'Your slots',  right: true, tip: 'Weekly gate slots you have free at the destination. A route at 7 flights a week needs 7 at each end — lease a gate here without leaving the finder.' },
                        { h: '',            right: true  },
                      ].map((c, i) => (
                        <th key={i} style={{ padding: '7px 12px', textAlign: c.right ? 'right' : 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {c.h}{c.tip && <InfoTip text={c.tip} />}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(r => {
                      const a        = r.airport;
                      const seasonal = seasonalByCode.get(r.code) ?? 1;
                      const proj     = r.projection;
                      const picked   = pickedKeys.has(pickKey(origin, r.code));
                      return (
                        <tr key={r.code} style={{ borderTop: '1px solid var(--border-subtle)', opacity: r.block ? 0.55 : 1, background: picked ? 'rgba(56,139,253,0.08)' : undefined }}>
                          {canPick && (
                            <td style={{ padding: '7px 4px 7px 12px', width: 1 }}>
                              {!r.block && (
                                <input
                                  type="checkbox"
                                  data-pick={r.code}
                                  checked={picked}
                                  disabled={!picked && pickFull}
                                  onChange={() => togglePick(r)}
                                  aria-label={`Shortlist ${origin} to ${a.code}`}
                                  title={!picked && pickFull
                                    ? (picks.length >= MAX_BATCH ? `A batch opens up to ${MAX_BATCH} routes` : `All ${owned.idle} idle ${selectedType.name}s are picked`)
                                    : `Shortlist ${origin} → ${a.code}`}
                                  style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                                />
                              )}
                            </td>
                          )}
                          <td style={{ padding: '7px 12px' }}>
                            <span style={{ fontWeight: 700 }}>{a.code}</span>
                            <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>{a.city}, {a.country}</span>
                            <span style={{ color: 'var(--text-dim)', marginLeft: 6, fontSize: 11 }}>{regionLabel(r.region)}</span>
                            {r.block && (
                              <span title={r.block.reason} style={{ marginLeft: 8, fontSize: 10, color: 'var(--red)', border: '1px solid rgba(220,53,69,0.4)', borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}>
                                {r.block.short}
                              </span>
                            )}
                            {r.altCodes.length > 0 && (
                              <span
                                title={`Same market, other airports: ${r.altCodes.join(', ')}. They share one pool of travellers with ${r.code}, so this is one opportunity, not ${r.altCodes.length + 1}. Shown at ${r.code} because that is the field this city's travellers prefer for a route like this.`}
                                style={{ marginLeft: 8, fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}
                              >
                                +{r.altCodes.length} airport{r.altCodes.length !== 1 ? 's' : ''}
                              </span>
                            )}
                            {r.servesLane && (
                              <span
                                title={`You already fly this market as ${r.yourLanePairs.join(', ')} — the airports share one pool of travellers, so a second route here splits it rather than adding to it.`}
                                style={{ marginLeft: 8, fontSize: 10, color: 'var(--yellow)', border: '1px solid rgba(210,153,34,0.4)', borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}
                              >
                                you fly {r.yourLanePairs[0]}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.distKm.toLocaleString()} km</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <div style={{ fontWeight: 700, color: 'var(--accent)' }}>
                              {r.demand.toLocaleString()}<span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-dim)' }}> /wk</span>
                            </div>
                            <div style={{ fontSize: 10, color: seasonal > 1.05 ? 'var(--green)' : seasonal < 0.95 ? 'var(--yellow)' : 'var(--text-dim)' }}>
                              ×{seasonal.toFixed(2)} season
                            </div>
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                            <ServedCell served={r.served ?? servedOf(r)} />
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>${r.refPrice}</td>
                          <td style={{ padding: '7px 12px' }}>
                            {r.laneRivalCount === 0
                              ? <span style={{ fontSize: 12, color: 'var(--green)' }}>None</span>
                              : <span style={{ fontSize: 12, color: 'var(--yellow)' }}>{r.laneRivalCount} airline{r.laneRivalCount !== 1 ? 's' : ''}</span>}
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', whiteSpace: 'nowrap', opacity: r.refreshing ? 0.55 : 1 }}
                              title={staleTip(r)}>
                            {proj
                              ? <span style={{ color: proj.loadFactor >= 0.75 ? 'var(--green)' : proj.loadFactor >= 0.45 ? 'var(--yellow)' : 'var(--red)' }}>
                                  {Math.round(proj.loadFactor * 100)}%
                                </span>
                              : <span style={{ color: 'var(--text-dim)' }} title={r.block ? 'This aircraft cannot fly here' : forecastReady && !known(keyOf(r)) && pending > 0 ? 'Forecasting…' : forecastReady ? `Outside the ${DEFAULT_SCORE_LIMIT} markets forecast — narrow the search to price it` : 'Pick an aircraft to forecast this market'}>{forecastReady && !r.block && !known(keyOf(r)) && pending > 0 ? '…' : '–'}</span>}
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600, opacity: r.refreshing ? 0.55 : 1 }}
                              title={staleTip(r)}>
                            {proj
                              ? <span style={{ color: proj.netProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                  {proj.netProfit >= 0 ? '+' : ''}{formatMoney(proj.netProfit)}
                                </span>
                              : <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>–</span>}
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                            <SlotCell code={a.code} freq={7} position={slotPosition} />
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                            {onPick && !r.block && (
                              <button
                                className="btn btn-ghost"
                                style={{ padding: '3px 10px', fontSize: 12, color: 'var(--accent)' }}
                                title={`Take ${origin} → ${a.code} to the Route Planner — nothing is booked until you open the route there`}
                                onClick={() => onPick(origin, a.code, typeId || undefined)}
                              >
                                Plan →
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* A cap the player cannot see is a cap that reads as a verdict. */}
              {unscored > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                  The {DEFAULT_SCORE_LIMIT} biggest markets here are forecast; {unscored.toLocaleString()} smaller
                  {' '}one{unscored !== 1 ? 's are' : ' is'} listed without one. Tighten the distance band to price them.
                </div>
              )}
              {results.length > shown.length && (
                <button
                  className="btn btn-ghost"
                  style={{ marginTop: 8, padding: '5px 14px', fontSize: 12 }}
                  onClick={() => setLimit(l => l + PAGE_SIZE)}
                >
                  Show {Math.min(PAGE_SIZE, results.length - shown.length)} more
                </button>
              )}
            </>
          )}

          {/* The shortlist tray. Sticky, so it stays in reach while you tick
              down a long table; it commits nothing on its own. */}
          {picks.length > 0 && !reviewing && (
            <div
              data-shortlist-tray=""
              style={{
                position: 'sticky', bottom: 0, zIndex: 2, marginTop: 10, padding: '10px 12px',
                background: 'var(--surface2)', border: '1px solid var(--accent)', borderRadius: 'var(--radius)',
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 180, fontSize: 13 }}>
                <strong>{picks.length}</strong> route{picks.length !== 1 ? 's' : ''} shortlisted
                {owned && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}· {idleUnpicked} idle {selectedType.name}{idleUnpicked !== 1 ? 's' : ''} not yet picked
                  </span>
                )}
              </div>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => setPicks([])}>
                Clear
              </button>
              <button className="btn btn-primary" style={{ fontSize: 13, padding: '6px 16px' }} onClick={() => setReviewing(true)}>
                Review &amp; open →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
