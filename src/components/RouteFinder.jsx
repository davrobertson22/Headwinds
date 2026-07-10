import { useState, useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../data/aircraft.js';
import { baseCityPairDemand, distanceKm, referencePrice, weekToGameDate } from '../utils/simulation.js';
import { buildRouteMarket } from '../models/demand.js';
import { Glyph } from './Icons.jsx';
import InfoTip from './InfoTip.jsx';

const PAGE_SIZE = 25;

const SORT_OPTIONS = [
  { id: 'demand',   label: 'Highest demand' },
  { id: 'shortest', label: 'Shortest distance' },
  { id: 'longest',  label: 'Longest distance' },
];

/**
 * Route Finder — scans every airport pair from a chosen origin and lists
 * unserved routes (ones you don't fly yet) ordered by market demand.
 * Filters: distance range, aircraft-range preset, competition.
 */
export default function RouteFinder({ onPick }) {
  const { state } = useGame();

  const [open, setOpen]         = useState(false);
  const [origin, setOrigin]     = useState(state.hub || '');
  const [query, setQuery]       = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [minDist, setMinDist]   = useState('');
  const [maxDist, setMaxDist]   = useState('');
  const [rangeTypeId, setRangeTypeId] = useState('');
  const [noCompetition, setNoCompetition] = useState(false);
  const [sortBy, setSortBy]     = useState('demand');
  const [limit, setLimit]       = useState(PAGE_SIZE);

  const gameDate = { week: state.week, month: weekToGameDate(state.week).monthIndex };
  const originAirport = getAirport(origin);

  // Longest reach of any aircraft in the fleet (for the "in fleet range" badge)
  const maxFleetRange = useMemo(() => {
    let max = 0;
    for (const a of state.fleet ?? []) {
      const t = getAircraftType(a.typeId);
      if (t) max = Math.max(max, Math.round(t.range * (a.rangeMod ?? 1)));
    }
    return max;
  }, [state.fleet]);

  // Pairs the player already serves (either direction, passenger routes)
  const servedPairs = useMemo(() => {
    const s = new Set();
    for (const r of state.routes ?? []) s.add([r.origin, r.destination].sort().join('-'));
    return s;
  }, [state.routes]);

  // Competitor count per pair touching the origin
  const compCounts = useMemo(() => {
    if (!origin) return new Map();
    const m = new Map();
    for (const c of state.competitors ?? []) {
      for (const key of Object.keys(c.routes ?? {})) {
        if (key.startsWith(`${origin}-`) || key.endsWith(`-${origin}`)) {
          m.set(key, (m.get(key) ?? 0) + 1);
        }
      }
    }
    return m;
  }, [state.competitors, origin]);

  // Demand + distance for every destination from the origin (heavy — origin-keyed memo)
  const candidates = useMemo(() => {
    if (!originAirport || !open) return [];
    const out = [];
    for (const a of AIRPORTS) {
      if (a.code === originAirport.code) continue;
      const demand = baseCityPairDemand(originAirport.code, a.code);
      if (demand <= 0) continue; // same-metro or unknown
      out.push({ airport: a, dist: Math.round(distanceKm(originAirport, a)), demand });
    }
    return out;
  }, [originAirport, open]);

  // Apply filters + sort
  const results = useMemo(() => {
    const lo = parseInt(minDist, 10) || 0;
    const hi = parseInt(maxDist, 10) || Infinity;
    const rows = candidates.filter(c => {
      if (c.dist < lo || c.dist > hi) return false;
      const key = [origin, c.airport.code].sort().join('-');
      if (servedPairs.has(key)) return false; // unserved only
      if (noCompetition && (compCounts.get(key) ?? 0) > 0) return false;
      return true;
    });
    rows.sort((x, y) =>
      sortBy === 'shortest' ? x.dist - y.dist :
      sortBy === 'longest'  ? y.dist - x.dist :
      y.demand - x.demand
    );
    return rows;
  }, [candidates, minDist, maxDist, noCompetition, sortBy, origin, servedPairs, compCounts]);

  const shown = results.slice(0, limit);

  // Seasonality only for visible rows (cheap: ≤ limit calls)
  const seasonalByCode = useMemo(() => {
    const m = new Map();
    for (const r of shown) {
      m.set(r.airport.code, buildRouteMarket(origin, r.airport.code, gameDate).seasonalityFactor);
    }
    return m;
  }, [shown, origin, gameDate.month]);

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
    <div className="card" style={{ marginBottom: 12 }}>
      {/* Header / toggle */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
        onClick={() => setOpen(v => !v)}
      >
        <span style={{ fontSize: 16 }}><Glyph e="🔍" /></span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            Route Finder
            <InfoTip text="Scans every airport reachable from a chosen origin and lists routes you don't serve yet, ordered by estimated market demand. Set a distance band (or pick an aircraft to use its range) and click a result to load it into the planner below." />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Discover unserved routes by demand from any airport
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
                  border: `1px solid ${pickerOpen ? 'var(--accent)' : 'var(--border)'}`,
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
                  background: 'var(--surface2)', border: '1px solid var(--accent)',
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

            {/* Aircraft-range preset */}
            <div>
              <div className="form-label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                Aircraft range
                <InfoTip text="Pick an aircraft type to cap the search at its maximum range." />
              </div>
              <select
                className="form-select"
                value={rangeTypeId}
                onChange={e => { pickRangeType(e.target.value); resetPaging(); }}
                style={{ width: 210 }}
              >
                <option value="">Any distance</option>
                {AIRCRAFT_TYPES.filter(t => !t.freighter).map(t => (
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
                style={{ width: 160 }}
              >
                {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>

            {/* Competition filter */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', paddingBottom: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={noCompetition}
                onChange={e => { setNoCompetition(e.target.checked); resetPaging(); }}
                style={{ accentColor: 'var(--accent)' }}
              />
              No competitors only
            </label>
          </div>

          {/* Results */}
          {!originAirport ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              Choose an origin airport to search from.
            </div>
          ) : results.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              No unserved routes match these filters.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                {results.length.toLocaleString()} unserved route{results.length !== 1 ? 's' : ''} from {originAirport.code} · showing {shown.length}
              </div>
              <div style={{ overflowX: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface2)' }}>
                      {['Destination', 'Distance', 'Demand', 'Season', 'Ref Price', 'Competitors', ''].map((h, i) => (
                        <th key={i} style={{ padding: '7px 12px', textAlign: i >= 1 && i <= 4 ? 'right' : 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(({ airport: a, dist, demand }) => {
                      const key      = [origin, a.code].sort().join('-');
                      const comps    = compCounts.get(key) ?? 0;
                      const seasonal = seasonalByCode.get(a.code) ?? 1;
                      const inRange  = maxFleetRange >= dist;
                      return (
                        <tr key={a.code} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '7px 12px' }}>
                            <span style={{ fontWeight: 700 }}>{a.code}</span>
                            <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>{a.city}, {a.country}</span>
                            {inRange && maxFleetRange > 0 && (
                              <span title="Within range of an aircraft in your fleet" style={{ marginLeft: 6, fontSize: 11, color: 'var(--green)' }}><Glyph e="✈" /></span>
                            )}
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{dist.toLocaleString()} km</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--accent)', whiteSpace: 'nowrap' }}>{demand.toLocaleString()}<span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-dim)' }}> /wk</span></td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', fontSize: 12, color: seasonal > 1.05 ? 'var(--green)' : seasonal < 0.95 ? 'var(--yellow)' : 'var(--text-muted)' }}>×{seasonal.toFixed(2)}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>${referencePrice(origin, a.code)}</td>
                          <td style={{ padding: '7px 12px' }}>
                            {comps === 0
                              ? <span style={{ fontSize: 12, color: 'var(--green)' }}>None</span>
                              : <span style={{ fontSize: 12, color: 'var(--yellow)' }}>{comps} airline{comps !== 1 ? 's' : ''}</span>}
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                            <button
                              className="btn btn-ghost"
                              style={{ padding: '3px 10px', fontSize: 12, color: 'var(--accent)' }}
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
