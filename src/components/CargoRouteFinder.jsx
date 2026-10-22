import { useState, useMemo } from 'react';
import { useGame, cometWithdrawn } from '../store/GameContext.jsx';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType, aircraftOrderable } from '../data/aircraft.js';
import { distanceKm, formatMoney, currentGameDate, calendarYear, effectiveRangeKm } from '../utils/simulation.js';
import { cargoCityPairDemand, cargoReferenceYield, cargoBackhaulFactor } from '../utils/market.js';
import { laneBlockFor, cargoLaneServed, rankByDemandLeft } from '../models/routeFinder.js';
import { isOutOfService } from '../data/maintenance.js';
import { idleTailsOfType } from '../../packages/engine/src/models/routeBatch.js';
import { Glyph } from './Icons.jsx';
import ServedCell from './FinderServed.jsx';
import InfoTip from './InfoTip.jsx';
import OriginPicker from './OriginPicker.jsx';
import { useSlotPosition, SlotCell, OriginSlotsLine } from './FinderSlots.jsx';
import { useRememberedState, finderMemoryKey } from '../utils/finderMemory.js';

const PAGE_SIZE = 25;
const ACCENT    = '#e8833a';

const SORT_OPTIONS = [
  { id: 'demand',   label: 'Highest demand' },
  { id: 'room',     label: 'Most demand left' },
  { id: 'revenue',  label: 'Revenue potential' },
  { id: 'shortest', label: 'Shortest distance' },
  { id: 'longest',  label: 'Longest distance' },
];

/**
 * Cargo Route Finder — the freight sibling of the passenger RouteFinder.
 * Scans every airport pair from a chosen origin and lists unserved FREIGHT
 * lanes ordered by cargo demand (tonnes/week) or revenue potential.
 * Filters: distance band, and a freighter. Cargo demand is driven by trade,
 * not tourism, so the results look very different from passenger ones.
 *
 * Picking a freighter used to do one thing: write its catalogue range into the
 * max-distance box. So a lane the type could reach but never land at stayed on
 * the list — an MD-11F search out of BOM offered PNQ, and the planner then said
 * "PNQ offers only 10,000 ft" ("would be really nice if airports with a runway
 * too short would not show up when selecting a plane", Matthijs, Discord
 * 2026-10-04). The passenger finder already asks the engine; this one now asks
 * the same question, laneBlockFor — range on the freighter you actually own
 * (mods included), the runway at both ends, and the airport rules ADD_CARGO_ROUTE
 * enforces — and hides the lanes it would refuse.
 *
 * Then it fell behind the passenger finder in three more ways (VodkaOnFire,
 * Discord 2026-10-21: "Freight has some key missing features"):
 *
 *   "can't see which planes you have idle"     The freighter picker listed the
 *       catalogue, never your fleet. Your freighters now come first, with how
 *       many you own, how many sit idle and the reach of your best tail — the
 *       passenger finder's picker, row for row.
 *   "can't see/toggle routes already flown"    Lanes you fly were always
 *       hidden. They can be shown, tagged with the route you already fly.
 *   "the same 0-x% demand satisfied"           The Served column
 *       (models/routeFinder.js cargoLaneServed) and a "Most demand left" sort.
 */
export default function CargoRouteFinder({ onPick, standalone = false }) {
  const { state } = useGame();
  // Free gate slots per airport, counted the way the engine's guards count them.
  const slotPosition = useSlotPosition();

  const [open, setOpen]         = useState(!!standalone);
  // Kept across the trip to the planner and back, like the passenger finder
  // (utils/finderMemory.js).
  const mem = finderMemoryKey(state, 'freight');
  const [origin, setOrigin]     = useRememberedState(mem, 'origin', state.hub || '', c => !c || !!getAirport(c));
  const [minDist, setMinDist]   = useRememberedState(mem, 'minDist', '');
  const [maxDist, setMaxDist]   = useRememberedState(mem, 'maxDist', '');
  const [rangeTypeId, setRangeTypeId] = useRememberedState(mem, 'rangeTypeId', '', id => id === '' || !!getAircraftType(id));
  const [showServed, setShowServed] = useRememberedState(mem, 'showServed', false);
  const [sortBy, setSortBy]     = useRememberedState(mem, 'sortBy', 'demand', v => SORT_OPTIONS.some(o => o.id === v));
  const [limit, setLimit]       = useRememberedState(mem, 'limit', PAGE_SIZE, v => Number.isFinite(v) && v > 0);

  const originAirport = getAirport(origin);
  // Freight has a season (see CARGO_SEASONAL_PROFILE) — scan on the month the
  // player would actually launch into, not an annual average they never fly.
  const gd = currentGameDate(state);

  // Longest reach of any FREIGHTER in the fleet (for the "in fleet range" badge)
  const maxFleetRange = useMemo(() => {
    let max = 0;
    for (const a of state.fleet ?? []) {
      const t = getAircraftType(a.typeId);
      if (t?.freighter) max = Math.max(max, Math.round(t.range * (a.rangeMod ?? 1)));
    }
    return max;
  }, [state.fleet]);

  // The longest-legged airworthy tail you own of each freighter type — the one
  // laneBlockFor measures range against, as the passenger finder does. A type
  // you don't own is measured on its catalogue figure.
  const bestTailByType = useMemo(() => {
    const map = new Map();
    for (const a of state.fleet ?? []) {
      if (a.status === 'retired' || isOutOfService(a)) continue;
      const t = getAircraftType(a.typeId);
      if (!t?.freighter) continue;
      const cur = map.get(t.id);
      if (!cur || effectiveRangeKm(a, t) > effectiveRangeKm(cur, t)) map.set(t.id, a);
    }
    return map;
  }, [state.fleet]);

  const searchType = rangeTypeId ? getAircraftType(rangeTypeId) : null;

  // ── Your freighters, as the picker sees them ───────────────────────────────
  // Same shape as the passenger finder's fleetTypes: per type, how many you
  // own, how many are idle (as the shortlist counts them — reserves and tails
  // in the shop are not idle), and the reach of the longest-legged one.
  const fleetTypes = useMemo(() => {
    const byType = new Map();
    for (const a of state.fleet ?? []) {
      const t = getAircraftType(a.typeId);
      if (!t?.freighter || a.status === 'retired') continue;
      const cur = byType.get(t.id);
      if (!cur) byType.set(t.id, { type: t, count: 1, idle: 0 });
      else cur.count += 1;
    }
    for (const f of byType.values()) {
      f.idle  = idleTailsOfType(state.fleet, f.type.id).length;
      f.reach = Math.round(bestTailByType.has(f.type.id) ? effectiveRangeKm(bestTailByType.get(f.type.id), f.type) : f.type.range);
    }
    return [...byType.values()].sort((x, y) => y.count - x.count || x.type.name.localeCompare(y.type.name));
  }, [state.fleet, bestTailByType]);
  const ownedFreighter = fleetTypes.find(f => f.type.id === rangeTypeId) ?? null;

  // Freight lanes the player already flies (either direction), with the route.
  const servedPairs = useMemo(() => {
    const m = new Map();
    for (const r of state.cargoRoutes ?? []) {
      const k = [r.origin, r.destination].sort().join('-');
      if (!m.has(k)) m.set(k, `${r.origin}–${r.destination}`);
    }
    return m;
  }, [state.cargoRoutes]);

  // Demand + distance + yield for every destination from the origin
  // (heavy — origin-keyed memo, only computed while the panel is open)
  const candidates = useMemo(() => {
    if (!originAirport || !open) return [];
    const out = [];
    for (const a of AIRPORTS) {
      if (a.code === originAirport.code) continue;
      const demand = cargoCityPairDemand(originAirport.code, a.code, gd.month);
      if (demand <= 0) continue; // same-metro (trucked) or unknown
      const dist     = Math.round(distanceKm(originAirport, a));
      const refYield = cargoReferenceYield(originAirport.code, a.code);
      // Lane revenue potential at reference yield: headhaul tonnes priced over
      // both directions with THIS lane's backhaul factor — the ceiling IF you
      // carried the whole pool. A scale for comparing lanes, not a promise.
      const backhaul = cargoBackhaulFactor(originAirport.code, a.code);
      const revPotential = Math.round(demand * (1 + backhaul) * dist * refYield);
      out.push({ airport: a, code: a.code, origin: originAirport.code, dist, demand, refYield, revPotential });
    }
    return out;
  }, [originAirport, open, gd.month]);

  // ── How much of each lane is already flown (models/routeFinder.js) ─────────
  // Cached until your freight network, the rivals' freight or the week moves.
  const rivalCargoKey = (state.competitors ?? [])
    .map(c => `${c.id}:${Object.keys(c?.cargoRoutes ?? {}).length}`).join(',');
  const servedCache = useMemo(
    () => new Map(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.cargoRoutes, state.fleet, rivalCargoKey, state.week, gd.month, origin]);
  const servedOf = (r) => {
    if (!servedCache.has(r.code)) servedCache.set(r.code, cargoLaneServed(state, r.origin, r.code, { gameDate: gd }));
    return servedCache.get(r.code);
  };

  // Apply filters + sort. `barred` counts what the chosen freighter cannot fly,
  // by reason, so the list can say what it left out instead of going quiet.
  const { results: filtered, barred } = useMemo(() => {
    const lo = parseInt(minDist, 10) || 0;
    const hi = parseInt(maxDist, 10) || Infinity;
    const ops = [...(state.routes ?? []), ...(state.cargoRoutes ?? [])];
    const aircraft = searchType ? (bestTailByType.get(searchType.id) ?? null) : null;
    const barred = { range: 0, runway: 0, restriction: 0 };
    const rows = [];
    for (const c of candidates) {
      if (c.dist < lo || c.dist > hi) continue;
      const key = [origin, c.airport.code].sort().join('-');
      const flown = servedPairs.get(key) ?? null;
      if (flown && !showServed) continue;   // unserved only, unless asked
      if (searchType) {
        // The engine's own verdict, with the freighter's body class and every
        // passenger and cargo op on the pair — what addCargoRouteBlockReason asks.
        const block = laneBlockFor({
          origin, destination: c.airport.code, distKm: c.dist, type: searchType,
          aircraft, weeklyFrequency: 7, routes: ops,
        });
        if (block) { barred[block.kind] = (barred[block.kind] ?? 0) + 1; continue; }
      }
      rows.push(flown ? { ...c, flown } : c);
    }
    return { results: rows, barred };
  }, [candidates, minDist, maxDist, origin, servedPairs, showServed, searchType, bestTailByType, state.routes, state.cargoRoutes]);
  const results = useMemo(() => {
    if (sortBy === 'room') return rankByDemandLeft(filtered, servedOf, limit);
    return [...filtered].sort((x, y) =>
      sortBy === 'shortest' ? x.dist - y.dist :
      sortBy === 'longest'  ? y.dist - x.dist :
      sortBy === 'revenue'  ? y.revPotential - x.revPotential :
      y.demand - x.demand
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortBy, sortBy === 'room' ? limit : 0, servedCache]);
  const barredTotal = barred.range + barred.runway + barred.restriction;
  // The origin itself too short for the freighter bars every lane at once —
  // say that, not "no lanes match".
  const originShort = searchType?.runwayFt && originAirport?.runwayFt
    && searchType.runwayFt > originAirport.runwayFt;

  const shown = results.slice(0, limit);

  // The freighter no longer writes its range into the max box: laneBlockFor
  // already measures range — on your own best tail, mods included, which the
  // catalogue figure undercounted — and the distance band stays yours to set.
  function pickRangeType(id) { setRangeTypeId(id); }

  function resetPaging() { setLimit(PAGE_SIZE); }

  return (
    <div className="card" style={{ marginBottom: 12, borderLeft: `3px solid ${ACCENT}` }}>
      {/* Header / toggle */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: standalone ? 'default' : 'pointer' }}
        onClick={standalone ? undefined : () => setOpen(v => !v)}
      >
        <span style={{ fontSize: 16 }}><Glyph e="🔍" /></span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            Cargo Route Finder
            <InfoTip text="Scans every airport reachable from a chosen origin and lists freight lanes you don't serve yet, ordered by cargo demand or revenue potential. Set a distance band, or pick a freighter to search only what it can legally fly — within its range, and with a runway long enough at both ends. Looking commits nothing — Plan hands a lane to the freight planner only if you want it." />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Discover unserved freight lanes by tonnage from any airport
          </div>
        </div>
        {!standalone && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{open ? '▴ Hide' : '▾ Show'}</span>}
      </div>

      {open && (
        <div style={{ marginTop: 14 }}>
          {/* Controls */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>

            {/* Origin — your own network first (components/OriginPicker.jsx) */}
            <OriginPicker
              value={origin}
              onChange={code => { setOrigin(code); resetPaging(); }}
              accent={ACCENT}
            />

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

            {/* Freighter-range preset */}
            <div>
              <div className="form-label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                Freighter
                <InfoTip text="Search with a specific freighter and the finder hides every lane it cannot fly — beyond its range (your best-equipped tail's, if you own one), a runway too short for it at either end, or an airport rule that refuses it. “Any freighter” goes back to browsing raw demand." />
              </div>
              <select
                className="form-select"
                value={rangeTypeId}
                onChange={e => { pickRangeType(e.target.value); resetPaging(); }}
                style={{ width: 260 }}
              >
                <option value="">Any freighter</option>
                {fleetTypes.length > 0 && (
                  <optgroup label="In your fleet">
                    {fleetTypes.map(f => (
                      <option key={f.type.id} value={f.type.id}>
                        {f.type.name} — {f.count} owned{f.idle > 0 ? ` · ${f.idle} idle` : ''} · {f.reach.toLocaleString()} km{f.type.runwayFt ? ` · ${f.type.runwayFt.toLocaleString()} ft` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Not in your fleet">
                  {AIRCRAFT_TYPES.filter(t => t.freighter && aircraftOrderable(t, calendarYear(state)) && !cometWithdrawn(state, t.id)
                    && !fleetTypes.some(f => f.type.id === t.id)).map(t => (
                    <option key={t.id} value={t.id}>{t.name} — {Math.round(t.range).toLocaleString()} km{t.runwayFt ? ` · ${t.runwayFt.toLocaleString()} ft` : ''}</option>
                  ))}
                </optgroup>
              </select>
            </div>

            {/* Sort */}
            <div>
              <div className="form-label" style={{ marginBottom: 6 }}>Sort by</div>
              <select
                className="form-select"
                value={sortBy}
                onChange={e => { setSortBy(e.target.value); resetPaging(); }}
                style={{ width: 170 }}
              >
                {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
          </div>

          {/* Filter toggles */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12, fontSize: 12, color: 'var(--text-muted)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                   title="Lanes you already fly freight on are hidden by default. Show them to see how much of each is left — the Served column counts your own freighters too.">
              <input type="checkbox" data-show-served="" checked={showServed} onChange={e => { setShowServed(e.target.checked); resetPaging(); }} style={{ accentColor: ACCENT }} />
              Show lanes I already serve
            </label>
          </div>

          {/* Results */}
          {!originAirport ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              Choose an origin airport to search from.
            </div>
          ) : originShort ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              The {searchType.name} needs {searchType.runwayFt.toLocaleString()} ft of runway; {originAirport.code}'s longest
              is {originAirport.runwayFt.toLocaleString()} ft, so it cannot fly any lane from here. Pick another freighter or origin.
            </div>
          ) : results.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              No {showServed ? '' : 'unserved '}freight lanes match these filters.
              {barredTotal > 0 && <> <BarredNote barred={barred} type={searchType} /></>}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                {results.length.toLocaleString()} {showServed ? '' : 'unserved '}lane{results.length !== 1 ? 's' : ''} from {originAirport.code} · showing {shown.length}
                {barredTotal > 0 && <> · <BarredNote barred={barred} type={searchType} /></>}
                {ownedFreighter && ownedFreighter.idle > 0 && (
                  <> · <span style={{ color: 'var(--yellow)' }}>{ownedFreighter.idle} idle {searchType.name}{ownedFreighter.idle !== 1 ? 's' : ''}</span></>
                )}
              </div>
              <OriginSlotsLine code={originAirport.code} freq={7} position={slotPosition} />
              <div style={{ overflowX: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface2)' }}>
                      {[
                        { h: 'Destination' },
                        { h: 'Distance',      right: true },
                        { h: 'Cargo Demand',  right: true },
                        { h: 'Served',        right: true, tip: "How much of the lane's weekly freight is already flown — your freighters (the freight table's own figure) and other airlines' published freighter capacity, at maturity, this month. Low is room for you; near 100% means a new freighter mostly splits the tonnage already there. Hover a figure for who carries what." },
                        { h: 'Ref Yield',     right: true },
                        { h: '≈ Rate',        right: true },
                        { h: 'Rev Potential', right: true },
                        { h: 'Your slots',    right: true },
                        { h: '' },
                      ].map((c, i) => (
                        <th key={i} style={{ padding: '7px 12px', textAlign: c.right ? 'right' : 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {c.h}{c.tip && <InfoTip text={c.tip} />}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(r => {
                      const { airport: a, dist, demand, refYield, revPotential } = r;
                      const inRange = maxFleetRange >= dist;
                      return (
                        <tr key={a.code} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '7px 12px' }}>
                            <span style={{ fontWeight: 700 }}>{a.code}</span>
                            <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>{a.city}, {a.country}</span>
                            {inRange && maxFleetRange > 0 && (
                              <span title="Within range of a freighter in your fleet" style={{ marginLeft: 6, fontSize: 11, color: 'var(--green)' }}><Glyph e="✈" /></span>
                            )}
                            {r.flown && (
                              <span
                                title={`You already fly freight on this lane (${r.flown}). Another freighter here shares the lane's one pool of tonnage with it.`}
                                style={{ marginLeft: 8, fontSize: 10, borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap', color: 'var(--yellow)', border: '1px solid rgba(210,153,34,0.4)' }}
                              >
                                you fly {r.flown}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{dist.toLocaleString()} km</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 700, color: ACCENT, whiteSpace: 'nowrap' }}>{demand.toLocaleString()} t<span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-dim)' }}> /wk</span></td>
                          <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                            <ServedCell served={r.served ?? servedOf(r)} cargo />
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>${refYield.toFixed(3)}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>${(refYield * dist / 1000).toFixed(2)}/kg</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--green)', whiteSpace: 'nowrap' }} title="Weekly lane revenue at reference yield IF you carried the whole pool — a comparison scale, not a promise">{formatMoney(revPotential)}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                            <SlotCell code={a.code} freq={7} position={slotPosition} />
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                            {onPick && (
                              <button
                                className="btn btn-ghost"
                                style={{ padding: '3px 10px', fontSize: 12, color: ACCENT }}
                                title={`Take ${origin} → ${a.code} to the freight planner — nothing is booked until you open the route there`}
                                onClick={() => onPick(origin, a.code, rangeTypeId || undefined)}
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
        </div>
      )}
    </div>
  );
}

// "312 hidden — 290 runway too short, 22 out of range for the MD-11F": the
// lanes a freighter search left out, so a short list never reads as a thin market.
function BarredNote({ barred, type }) {
  const parts = [
    barred.runway      && `${barred.runway.toLocaleString()} runway too short`,
    barred.range       && `${barred.range.toLocaleString()} out of range`,
    barred.restriction && `${barred.restriction.toLocaleString()} barred by airport rules`,
  ].filter(Boolean);
  const total = barred.runway + barred.range + barred.restriction;
  return (
    <span title={`Lanes the ${type?.name ?? 'freighter'} cannot legally fly are not listed`}>
      {total.toLocaleString()} hidden ({parts.join(', ')}) for the {type?.name ?? 'freighter'}
    </span>
  );
}
