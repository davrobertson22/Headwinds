import { useState, useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../data/aircraft.js';
import { distanceKm, formatMoney, currentGameDate } from '../utils/simulation.js';
import { cargoCityPairDemand, cargoReferenceYield, cargoBackhaulFactor } from '../utils/market.js';
import { Glyph } from './Icons.jsx';
import InfoTip from './InfoTip.jsx';

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
 * Filters: distance band, freighter-range preset. Cargo demand is driven by
 * trade, not tourism, so the results look very different from passenger ones.
 */
export default function CargoRouteFinder({ onPick }) {
  const { state } = useGame();

  const [open, setOpen]         = useState(false);
  const [origin, setOrigin]     = useState(state.hub || '');
  const [query, setQuery]       = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
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

  // Apply filters + sort
  const results = useMemo(() => {
    const lo = parseInt(minDist, 10) || 0;
    const hi = parseInt(maxDist, 10) || Infinity;
    const rows = candidates.filter(c => {
      if (c.dist < lo || c.dist > hi) return false;
      const key = [origin, c.airport.code].sort().join('-');
      if (servedPairs.has(key)) return false; // unserved only
      return true;
    });
    rows.sort((x, y) =>
      sortBy === 'shortest' ? x.dist - y.dist :
      sortBy === 'longest'  ? y.dist - x.dist :
      sortBy === 'revenue'  ? y.revPotential - x.revPotential :
      y.demand - x.demand
    );
    return rows;
  }, [candidates, minDist, maxDist, sortBy, origin, servedPairs]);

  const shown = results.slice(0, limit);

  // Origin picker (compact inline search)
  const originMatches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return AIRPORTS.filter(a =>
      a.code.includes(q) || a.city.toUpperCase().includes(q) || a.name.toUpperCase().includes(q)
    ).slice(0, 8);
  }, [query]);

  function pickRangeType(id) {
    setRangeTypeId(id);
    const t = getAircraftType(id);
    if (t) setMaxDist(String(t.range));
  }

  function resetPaging() { setLimit(PAGE_SIZE); }

  return (
    <div className="card" style={{ marginBottom: 12, borderLeft: `3px solid ${ACCENT}` }}>
      {/* Header / toggle */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
        onClick={() => setOpen(v => !v)}
      >
        <span style={{ fontSize: 16 }}><Glyph e="🔍" /></span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            Cargo Route Finder
            <InfoTip text="Scans every airport reachable from a chosen origin and lists freight lanes you don't serve yet, ordered by cargo demand or revenue potential. Set a distance band (or pick a freighter to use its range) and click a result to load it into the freight planner below." />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Discover unserved freight lanes by tonnage from any airport
          </div>
        </div>
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{open ? '▴ Hide' : '▾ Show'}</span>
      </div>

      {open && (
        <div style={{ marginTop: 14 }}>
          {/* Controls */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>

            {/* Origin */}
            <div style={{ position: 'relative', minWidth: 180 }}>
              <div className="form-label" style={{ marginBottom: 6 }}>From</div>
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface2)',
                  border: `1px solid ${pickerOpen ? ACCENT : 'var(--border)'}`,
                  borderRadius: 'var(--radius)', padding: '7px 10px', cursor: 'pointer',
                }}
                onClick={() => setPickerOpen(v => !v)}
              >
                {originAirport ? (
                  <>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{originAirport.code}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{originAirport.city}</span>
                  </>
                ) : (
                  <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>Select airport…</span>
                )}
                <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 11 }}>▾</span>
              </div>
              {pickerOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 100,
                  background: 'var(--surface2)', border: `1px solid ${ACCENT}`,
                  borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', overflow: 'hidden',
                }}>
                  <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                    <input
                      autoFocus
                      className="form-input"
                      placeholder="Search city or code…"
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {(query ? originMatches : AIRPORTS.slice(0, 8)).map(a => (
                      <div
                        key={a.code}
                        onClick={() => { setOrigin(a.code); setQuery(''); setPickerOpen(false); resetPaging(); }}
                        style={{ padding: '7px 10px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface3)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <span style={{ fontWeight: 700, fontSize: 13, width: 34, flexShrink: 0 }}>{a.code}</span>
                        <span style={{ fontSize: 12 }}>{a.city}</span>
                      </div>
                    ))}
                    {query && originMatches.length === 0 && (
                      <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}>No airports found</div>
                    )}
                  </div>
                </div>
              )}
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
                  onChange={e => { setMaxDist(e.target.value); setRangeTypeId(''); resetPaging(); }}
                  className="form-input" style={{ width: 80, textAlign: 'center' }}
                />
              </div>
            </div>

            {/* Freighter-range preset */}
            <div>
              <div className="form-label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                Freighter range
                <InfoTip text="Pick a freighter type to cap the search at its maximum range." />
              </div>
              <select
                className="form-select"
                value={rangeTypeId}
                onChange={e => { pickRangeType(e.target.value); resetPaging(); }}
                style={{ width: 210 }}
              >
                <option value="">Any distance</option>
                {AIRCRAFT_TYPES.filter(t => t.freighter).map(t => (
                  <option key={t.id} value={t.id}>{t.name} — {t.range.toLocaleString()} km</option>
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
          ) : results.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              No unserved freight lanes match these filters.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                {results.length.toLocaleString()} unserved lane{results.length !== 1 ? 's' : ''} from {originAirport.code} · showing {shown.length}
              </div>
              <div style={{ overflowX: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface2)' }}>
                      {['Destination', 'Distance', 'Cargo Demand', 'Ref Yield', '≈ Rate', 'Rev Potential', ''].map((h, i) => (
                        <th key={i} style={{ padding: '7px 12px', textAlign: i >= 1 && i <= 5 ? 'right' : 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
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
                            <button
                              className="btn btn-ghost"
                              style={{ padding: '3px 10px', fontSize: 12, color: ACCENT }}
                              onClick={() => onPick(origin, a.code)}
                            >
                              Plan →
                            </button>
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
