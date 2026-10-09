import { useState, useMemo } from 'react';
import { useGame, cometWithdrawn } from '../store/GameContext.jsx';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType, aircraftOrderable } from '../data/aircraft.js';
import { distanceKm, formatMoney, currentGameDate, calendarYear, effectiveRangeKm } from '../utils/simulation.js';
import { cargoCityPairDemand, cargoReferenceYield, cargoBackhaulFactor } from '../utils/market.js';
import { laneBlockFor } from '../models/routeFinder.js';
import { isOutOfService } from '../data/maintenance.js';
import { Glyph } from './Icons.jsx';
import InfoTip from './InfoTip.jsx';
import OriginPicker from './OriginPicker.jsx';
import { useSlotPosition, SlotCell, OriginSlotsLine } from './FinderSlots.jsx';

const PAGE_SIZE = 25;
const ACCENT    = '#e8833a';

const SORT_OPTIONS = [
  { id: 'demand',   label: 'Highest demand' },
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
 */
export default function CargoRouteFinder({ onPick, standalone = false }) {
  const { state } = useGame();
  // Free gate slots per airport, counted the way the engine's guards count them.
  const slotPosition = useSlotPosition();

  const [open, setOpen]         = useState(!!standalone);
  const [origin, setOrigin]     = useState(state.hub || '');
  const [minDist, setMinDist]   = useState('');
  const [maxDist, setMaxDist]   = useState('');
  const [rangeTypeId, setRangeTypeId] = useState('');
  const [sortBy, setSortBy]     = useState('demand');
  const [limit, setLimit]       = useState(PAGE_SIZE);

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

  // Freight lanes the player already flies (either direction)
  const servedPairs = useMemo(() => {
    const s = new Set();
    for (const r of state.cargoRoutes ?? []) s.add([r.origin, r.destination].sort().join('-'));
    return s;
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
      out.push({ airport: a, dist, demand, refYield, revPotential });
    }
    return out;
  }, [originAirport, open, gd.month]);

  // Apply filters + sort. `barred` counts what the chosen freighter cannot fly,
  // by reason, so the list can say what it left out instead of going quiet.
  const { results, barred } = useMemo(() => {
    const lo = parseInt(minDist, 10) || 0;
    const hi = parseInt(maxDist, 10) || Infinity;
    const ops = [...(state.routes ?? []), ...(state.cargoRoutes ?? [])];
    const aircraft = searchType ? (bestTailByType.get(searchType.id) ?? null) : null;
    const barred = { range: 0, runway: 0, restriction: 0 };
    const rows = candidates.filter(c => {
      if (c.dist < lo || c.dist > hi) return false;
      const key = [origin, c.airport.code].sort().join('-');
      if (servedPairs.has(key)) return false; // unserved only
      if (searchType) {
        // The engine's own verdict, with the freighter's body class and every
        // passenger and cargo op on the pair — what addCargoRouteBlockReason asks.
        const block = laneBlockFor({
          origin, destination: c.airport.code, distKm: c.dist, type: searchType,
          aircraft, weeklyFrequency: 7, routes: ops,
        });
        if (block) { barred[block.kind] = (barred[block.kind] ?? 0) + 1; return false; }
      }
      return true;
    });
    rows.sort((x, y) =>
      sortBy === 'shortest' ? x.dist - y.dist :
      sortBy === 'longest'  ? y.dist - x.dist :
      sortBy === 'revenue'  ? y.revPotential - x.revPotential :
      y.demand - x.demand
    );
    return { results: rows, barred };
  }, [candidates, minDist, maxDist, sortBy, origin, servedPairs, searchType, bestTailByType, state.routes, state.cargoRoutes]);
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
                style={{ width: 210 }}
              >
                <option value="">Any freighter</option>
                {AIRCRAFT_TYPES.filter(t => t.freighter && aircraftOrderable(t, calendarYear(state)) && !cometWithdrawn(state, t.id)).map(t => (
                  <option key={t.id} value={t.id}>{t.name} — {Math.round(bestTailByType.has(t.id) ? effectiveRangeKm(bestTailByType.get(t.id), t) : t.range).toLocaleString()} km{t.runwayFt ? ` · ${t.runwayFt.toLocaleString()} ft` : ''}</option>
                ))}
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
              No unserved freight lanes match these filters.
              {barredTotal > 0 && <> <BarredNote barred={barred} type={searchType} /></>}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                {results.length.toLocaleString()} unserved lane{results.length !== 1 ? 's' : ''} from {originAirport.code} · showing {shown.length}
                {barredTotal > 0 && <> · <BarredNote barred={barred} type={searchType} /></>}
              </div>
              <OriginSlotsLine code={originAirport.code} freq={7} position={slotPosition} />
              <div style={{ overflowX: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface2)' }}>
                      {['Destination', 'Distance', 'Cargo Demand', 'Ref Yield', '≈ Rate', 'Rev Potential', 'Your slots', ''].map((h, i) => (
                        <th key={i} style={{ padding: '7px 12px', textAlign: i >= 1 && i <= 6 ? 'right' : 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(({ airport: a, dist, demand, refYield, revPotential }) => {
                      const inRange = maxFleetRange >= dist;
                      return (
                        <tr key={a.code} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '7px 12px' }}>
                            <span style={{ fontWeight: 700 }}>{a.code}</span>
                            <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>{a.city}, {a.country}</span>
                            {inRange && maxFleetRange > 0 && (
                              <span title="Within range of a freighter in your fleet" style={{ marginLeft: 6, fontSize: 11, color: 'var(--green)' }}><Glyph e="✈" /></span>
                            )}
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{dist.toLocaleString()} km</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 700, color: ACCENT, whiteSpace: 'nowrap' }}>{demand.toLocaleString()} t<span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-dim)' }}> /wk</span></td>
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
