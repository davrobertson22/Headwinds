import { useState, useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../data/aircraft.js';
import { weekToGameDate, effectiveRangeKm, formatMoney } from '../utils/simulation.js';
import { buildRouteMarket } from '../models/demand.js';
import {
  findCandidates, scoreCandidates, sortCandidates, SORTS, DEFAULT_SCORE_LIMIT,
} from '../models/routeFinder.js';
import { Glyph } from './Icons.jsx';
import InfoTip from './InfoTip.jsx';

const PAGE_SIZE = 25;

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
  const { state } = useGame();

  const [open, setOpen]         = useState(!!standalone);
  const [origin, setOrigin]     = useState(state.hub || '');
  const [query, setQuery]       = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [minDist, setMinDist]   = useState('');
  const [maxDist, setMaxDist]   = useState('');
  const [soloOnly, setSoloOnly] = useState(false);
  const [showUnflyable, setShowUnflyable] = useState(false);
  const [showServed, setShowServed]       = useState(false);
  const [splitMetros, setSplitMetros]     = useState(false);
  const [sortBy, setSortBy]     = useState('demand');
  const [limit, setLimit]       = useState(PAGE_SIZE);

  const gameDate = { week: state.week, month: weekToGameDate(state.week).monthIndex };
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
      if (!cur) byType.set(t.id, { type: t, count: 1, best: a, reach });
      else {
        cur.count += 1;
        if (reach > cur.reach) { cur.best = a; cur.reach = reach; }
      }
    }
    return [...byType.values()].sort((x, y) => y.count - x.count || x.type.name.localeCompare(y.type.name));
  }, [state.fleet]);

  // Default to the type you own the most of — the plane you are actually going to
  // fly the next route with. An empty selection is still available ("Any
  // aircraft"), it just isn't what a fleet owner wants on arrival.
  const [typeId, setTypeId] = useState(() => fleetTypes[0]?.type.id ?? '');
  const owned = fleetTypes.find(f => f.type.id === typeId) ?? null;
  const selectedType = typeId ? getAircraftType(typeId) : null;
  const reach = selectedType
    ? (owned?.reach ?? Math.round(effectiveRangeKm({ typeId }, selectedType)))
    : 0;

  const catalogueTypes = useMemo(
    () => AIRCRAFT_TYPES.filter(t => !t.freighter && !fleetTypes.some(f => f.type.id === t.id)),
    [fleetTypes]
  );

  function resetPaging() { setLimit(PAGE_SIZE); }

  // ── Candidates (cheap: no demand model, safe to re-run on every keystroke) ──
  const rows = useMemo(() => {
    if (!originAirport || !open) return [];
    return findCandidates(state, {
      origin,
      aircraftTypeId: typeId,
      aircraft: owned?.best ?? null,
      minDistKm: parseInt(minDist, 10) || 0,
      maxDistKm: parseInt(maxDist, 10) || Infinity,
      hideUnflyable: !showUnflyable,
      hideServedLanes: !showServed,
      soloOnly,
      groupMetros: !splitMetros,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.routes, state.competitors, state.humanRivals, state.encroachments,
      origin, open, typeId, owned?.best, minDist, maxDist, showUnflyable, showServed,
      soloOnly, splitMetros]);

  // ── Forecasts, bounded ─────────────────────────────────────────────────────
  // The engine's real launch projection, so "Plan →" cannot contradict the row it
  // was clicked on. It costs about a millisecond a market on a busy save, which
  // is why it is bounded two different ways:
  //
  //   ranking by a forecast   the field has to be priced before it can be ranked,
  //                           so the biggest DEFAULT_SCORE_LIMIT markets get one
  //                           and the footer says out loud which rows did not —
  //                           a silent cap reads as "nothing below is worth flying".
  //   ranking by anything else  only the page you are looking at is priced, so
  //                           typing in the distance boxes costs 25 forecasts
  //                           rather than 150.
  const forecastReady  = !!typeId;
  const forecastSort   = !!SORTS[sortBy]?.needsForecast;
  const results = useMemo(() => {
    if (!forecastReady || rows.length === 0) return sortCandidates(rows, sortBy);
    const opts = { aircraftTypeId: typeId, aircraft: owned?.best ?? null, weeklyFrequency: 7, gameDate };
    if (forecastSort) {
      return sortCandidates(scoreCandidates(state, rows, { ...opts, limit: DEFAULT_SCORE_LIMIT }), sortBy);
    }
    return scoreCandidates(state, sortCandidates(rows, sortBy), { ...opts, limit, order: 'asGiven' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortBy, forecastSort, forecastReady, typeId, owned?.best, limit,
      gameDate.month, state.fleet, state.cash]);

  const shown    = results.slice(0, limit);
  const unscored = forecastSort ? results.filter(r => !r.scored && !r.block).length : 0;

  // Seasonality only for visible rows (cheap: <= limit calls)
  const seasonalByCode = useMemo(() => {
    const m = new Map();
    for (const r of shown) {
      m.set(r.code, buildRouteMarket(origin, r.code, gameDate).seasonalityFactor);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, origin, gameDate.month]);

  // Origin picker (compact inline search)
  const originMatches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return AIRPORTS.filter(a =>
      a.code.includes(q) || a.city.toUpperCase().includes(q) || a.name.toUpperCase().includes(q)
    ).slice(0, 8);
  }, [query]);

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
                        {f.type.name} — {f.count} owned · {f.reach.toLocaleString()} km
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

          {/* Results */}
          {!originAirport ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              Choose an origin airport to search from.
            </div>
          ) : results.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              No unserved routes match these filters.
              {selectedType && !showUnflyable && <> Try “Show what this aircraft can't fly” to see what {selectedType.name} is being kept out of.</>}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                {results.length.toLocaleString()} market{results.length !== 1 ? 's' : ''} from {originAirport.code} · showing {shown.length}
                {forecastReady && <> · forecast on {selectedType.name} at 7 flights/wk, reference fares</>}
              </div>
              <div style={{ overflowX: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface2)' }}>
                      {[
                        { h: 'Destination', right: false },
                        { h: 'Distance',    right: true  },
                        { h: 'Market',      right: true, tip: "The whole city-pair market per week. Airports in one metro share it: JFK–LHR and EWR–LHR are one New York↔London market, not two." },
                        { h: 'Ref fare',    right: true  },
                        { h: 'Rivals',      right: false, tip: 'Carriers flying this market from any airport in either city.' },
                        { h: 'Est. load',   right: true, tip: 'Projected mature load factor for the selected aircraft at 7 flights a week — the same projection the Route Planner runs.' },
                        { h: 'Est. profit', right: true, tip: 'Weekly net after operating cost, landing fees and the lease on the aircraft flying it.' },
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
                      return (
                        <tr key={r.code} style={{ borderTop: '1px solid var(--border-subtle)', opacity: r.block ? 0.55 : 1 }}>
                          <td style={{ padding: '7px 12px' }}>
                            <span style={{ fontWeight: 700 }}>{a.code}</span>
                            <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>{a.city}, {a.country}</span>
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
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>${r.refPrice}</td>
                          <td style={{ padding: '7px 12px' }}>
                            {r.laneRivalCount === 0
                              ? <span style={{ fontSize: 12, color: 'var(--green)' }}>None</span>
                              : <span style={{ fontSize: 12, color: 'var(--yellow)' }}>{r.laneRivalCount} airline{r.laneRivalCount !== 1 ? 's' : ''}</span>}
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {proj
                              ? <span style={{ color: proj.loadFactor >= 0.75 ? 'var(--green)' : proj.loadFactor >= 0.45 ? 'var(--yellow)' : 'var(--red)' }}>
                                  {Math.round(proj.loadFactor * 100)}%
                                </span>
                              : <span style={{ color: 'var(--text-dim)' }} title={r.block ? 'This aircraft cannot fly here' : forecastReady ? `Outside the ${DEFAULT_SCORE_LIMIT} markets forecast — narrow the search to price it` : 'Pick an aircraft to forecast this market'}>–</span>}
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600 }}>
                            {proj
                              ? <span style={{ color: proj.netProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                  {proj.netProfit >= 0 ? '+' : ''}{formatMoney(proj.netProfit)}
                                </span>
                              : <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>–</span>}
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
        </div>
      )}
    </div>
  );
}
