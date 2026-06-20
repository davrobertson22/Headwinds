import { Glyph, GlyphLabel } from './Icons.jsx';
import { useState, useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import RouteDetail from './RouteDetail.jsx';
import AirportLink from './AirportLink.jsx';
import CargoRoutesList, { FreightBadge, PassengerBadge } from './CargoRoutesList.jsx';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { getAircraftType } from '../data/aircraft.js';
import { normalizeCateringLevel } from '../data/catering.js';
import CateringSelector from './CateringSelector.jsx';
import InfoTip from './InfoTip.jsx';
import {
  distanceKm, referencePrice, simulateRoute, formatMoney, formatPercent,
  weeklyBlockHours, blockTimeHours, maxFrequency, MAX_WEEKLY_BLOCK_HOURS, SLOTS_PER_GATE,
  routeDistanceKm, currentGameDate, effectiveRangeKm,
  isMultiStop, simulateTagRoute, routeStops, routeBlockHours, routeLandingFee,
  maxClassPrice, isRouteActive, routeActiveMonths,
} from '../utils/simulation.js';

const SEASON_MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SEASON_PRESETS = [
  { id: 'year',   label: 'Year-round', months: null },
  { id: 'summer', label: 'Summer', months: [6, 7, 8, 9] },
  { id: 'winter', label: 'Winter', months: [12, 1, 2, 3] },
];

// Month-window picker used in the add-route form (counter-seasonal reassignment path).
function FormSeasonPicker({ value, onChange, currentMonth }) {
  const selected = new Set(value?.months ?? []);
  const isYearRound = !value || selected.size === 0;
  const toggleMonth = (m) => {
    const next = new Set(selected);
    next.has(m) ? next.delete(m) : next.add(m);
    onChange(next.size === 0 ? null : { months: [...next].sort((a, b) => a - b) });
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
        Operating window
        <InfoTip text="Restrict this route to certain months. Off-season it's dormant (no revenue or cost) and frees its aircraft and slots for a counter-seasonal route. Resuming each season costs 1/3 of launch; gate fees bill year-round." />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        {SEASON_PRESETS.map(p => {
          const active = (p.months === null && isYearRound) ||
            (p.months && !isYearRound && p.months.length === selected.size && p.months.every(m => selected.has(m)));
          return (
            <button key={p.id} type="button" className={`btn ${active ? 'btn-primary' : 'btn-ghost'}`}
              style={{ padding: '3px 10px', fontSize: 11 }}
              onClick={() => onChange(p.months ? { months: [...p.months] } : null)}>
              {p.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
        {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
          const on = !isYearRound && selected.has(m);
          return (
            <button key={m} type="button" onClick={() => toggleMonth(m)}
              style={{
                width: 30, height: 26, fontSize: 11, borderRadius: 5, cursor: 'pointer',
                border: m === currentMonth ? '2px solid var(--accent)' : '1px solid var(--border)',
                background: on ? 'var(--accent)' : 'transparent',
                color: on ? '#fff' : 'var(--text-muted)', fontWeight: on ? 700 : 400,
              }}>
              {SEASON_MONTH_ABBR[m].slice(0, 1)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Compact badge shown on seasonal routes: green "Seasonal" when operating this
// month, grey "Dormant" (with resume month) when out of season.
function SeasonBadge({ route, month }) {
  if (!route?.season) return null;
  const active = isRouteActive(route, month);
  const months = routeActiveMonths(route);
  // Next active month (for the dormant resume hint)
  let resume = months[0];
  for (let i = 0; i < 12; i++) {
    const m = ((month - 1 + i) % 12) + 1;
    if (months.includes(m)) { resume = m; break; }
  }
  const style = {
    fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
    textTransform: 'uppercase', letterSpacing: '.04em',
    background: active ? 'rgba(63,185,80,0.15)' : 'rgba(139,148,158,0.15)',
    color: active ? 'var(--green)' : 'var(--text-muted)',
    border: `1px solid ${active ? 'rgba(63,185,80,0.3)' : 'rgba(139,148,158,0.3)'}`,
  };
  return (
    <span style={style} title={`Operates: ${months.map(m => SEASON_MONTH_ABBR[m]).join(', ')}`}>
      <Glyph e="🗓" /> {active ? 'Seasonal' : `Dormant · ${SEASON_MONTH_ABBR[resume]}`}
    </span>
  );
}

// ─── Route grouping ───────────────────────────────────────────────────────────

/**
 * Group route records by city pair, direction-agnostic.
 * JFK→ORD and ORD→JFK are the same physical service (the sim already handles
 * both directions internally), so they collapse into one card.
 * The display uses the direction of the first route added.
 */
function groupRoutes(routes) {
  const map = {};
  for (const r of routes) {
    const [a, b] = [r.origin, r.destination].sort();
    const key = `${a}-${b}`;
    if (!map[key]) map[key] = { key, origin: r.origin, destination: r.destination, routes: [] };
    map[key].routes.push(r);
  }
  return Object.values(map);
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Routes() {
  const { state, dispatch } = useGame();
  const { fleet, routes, hub, pendingOrders = [], cargoRoutes = [] } = state;

  // Detail view: null = list, { origin, destination } = route detail page
  const [detailPair, setDetailPair] = useState(null);

  // Form mode: null = hidden; { origin, destination } = "add flights" to existing pair;
  // 'new' = open brand-new route
  const [formMode, setFormMode] = useState(null);

  // Search / filter / sort
  const [search,    setSearch]    = useState('');
  const [sortBy,    setSortBy]    = useState('profit');
  const [filterTab, setFilterTab] = useState('all');

  // Passenger vs Freight view
  const [typeFilter, setTypeFilter] = useState('all');

  // View mode: 'cards' | 'compare'
  const [viewMode, setViewMode] = useState('cards');

  const usedHrsFor = (a) => {
    const t = getAircraftType(a.typeId);
    if (!t) return 0;
    return routes.filter(r => r.aircraftId === a.id)
      .reduce((s, r) => s + routeBlockHours(r, t, r.weeklyFrequency), 0);
  };
  const availableFleet = fleet.filter(a => usedHrsFor(a) < MAX_WEEKLY_BLOCK_HOURS);
  const idleCount      = fleet.filter(a => a.status === 'idle').length;

  // Tag (multi-stop) routes are rendered in their own section; single-leg routes
  // collapse into direction-agnostic city-pair groups as before.
  const tagRoutes   = routes.filter(isMultiStop);
  const flatRoutes  = routes.filter(r => !isMultiStop(r));
  const routeGroups = groupRoutes(flatRoutes);

  // Per-group stats for filtering + sorting (runs simulation once per group here)
  const gd = currentGameDate(state);
  const groupsWithStats = useMemo(() => routeGroups.map(group => {
    const sims = group.routes.map(route => {
      const ac     = fleet.find(a => a.id === route.aircraftId);
      const result = ac ? simulateRoute(route, ac, gd) : null;
      return { route, result };
    });
    const totalProfit  = sims.reduce((s, { result }) => s + (result?.profit    ?? 0), 0);
    const totalRevenue = sims.reduce((s, { result }) => s + (result?.revenue   ?? 0), 0);
    const totalPax     = sims.reduce((s, { result }) => s + (result?.passengers ?? 0), 0);
    const totalSeats   = sims.reduce((s, { result }) => s + (result?.configuredSeatsOneWay ?? 0), 0);
    const avgLoad = totalSeats > 0 ? totalPax / totalSeats : 0;  // totalPax is one-way; totalSeats is configured one-way capacity
    const distance = sims[0]?.result?.distance ?? 0;
    return { ...group, totalProfit, totalRevenue, avgLoad, distance };
  }), [routes, fleet, state.week]); // eslint-disable-line react-hooks/exhaustive-deps

  // If a route detail is selected, render that instead of the list
  if (detailPair) {
    return (
      <RouteDetail
        origin={detailPair.origin}
        dest={detailPair.destination}
        onBack={() => setDetailPair(null)}
      />
    );
  }

  // Search
  const searchTerm = search.trim().toLowerCase();
  const afterSearch = searchTerm
    ? groupsWithStats.filter(g => {
        const oa = getAirport(g.origin);
        const da = getAirport(g.destination);
        return (
          g.origin.toLowerCase().includes(searchTerm) ||
          g.destination.toLowerCase().includes(searchTerm) ||
          oa?.city.toLowerCase().includes(searchTerm) ||
          da?.city.toLowerCase().includes(searchTerm)
        );
      })
    : groupsWithStats;

  // Tab counts (based on search results, not filtered, so each tab shows a sensible number)
  const tabCounts = {
    all:          afterSearch.length,
    profitable:   afterSearch.filter(g => g.totalProfit >= 0).length,
    unprofitable: afterSearch.filter(g => g.totalProfit < 0).length,
    lowload:      afterSearch.filter(g => g.avgLoad < 0.5).length,
  };

  // Filter
  const afterFilter = afterSearch.filter(g => {
    if (filterTab === 'profitable')   return g.totalProfit >= 0;
    if (filterTab === 'unprofitable') return g.totalProfit < 0;
    if (filterTab === 'lowload')      return g.avgLoad < 0.5;
    return true;
  });

  // Sort
  const visibleGroups = [...afterFilter].sort((a, b) => {
    if (sortBy === 'revenue')  return b.totalRevenue - a.totalRevenue;
    if (sortBy === 'load')     return b.avgLoad      - a.avgLoad;
    if (sortBy === 'distance') return b.distance     - a.distance;
    return b.totalProfit - a.totalProfit; // default
  });

  function handleClose(routeId) {
    if (window.confirm('Remove this aircraft from the route? It will be freed for other assignments.')) {
      dispatch({ type: 'CLOSE_ROUTE', routeId });
    }
  }

  function handlePriceChange(routeId, value) {
    const price = parseInt(value, 10);
    if (!isNaN(price) && price > 0) {
      dispatch({ type: 'UPDATE_TICKET_PRICE', routeId, ticketPrice: price });
    }
  }

  function openNewRoute() {
    setFormMode('new');
  }

  function addFlightsTo(origin, destination) {
    setFormMode({ origin, destination });
  }

  function closeForm() {
    setFormMode(null);
  }

  const showForm = formMode !== null;
  const isAddingFlights = showForm && formMode !== 'new';
  const formInitialOrigin = isAddingFlights ? formMode.origin : null;
  const formInitialDest   = isAddingFlights ? formMode.destination : null;

  const cargoCount = cargoRoutes.length;
  const typeToggle = (
    <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 3, marginBottom: 14, width: 'fit-content' }}>
      {[{ id: 'all', label: 'All' }, { id: 'passenger', label: '🧍 Passenger' }, { id: 'freight', label: '📦 Freight' }].map(o => {
        const active = typeFilter === o.id;
        const accent = o.id === 'freight' ? '#e8833a' : 'var(--accent)';
        return (
          <button key={o.id} onClick={() => setTypeFilter(o.id)}
            style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontWeight: 600,
              background: active ? `${accent}22` : 'transparent', color: active ? accent : 'var(--text-muted)' }}>
            <GlyphLabel text={o.label} size={12} />{o.id === 'freight' && cargoCount > 0 ? ` (${cargoCount})` : ''}
          </button>
        );
      })}
    </div>
  );

  // Freight-only view: show just the cargo routes list.
  if (typeFilter === 'freight') {
    return (<div>{typeToggle}<CargoRoutesList /></div>);
  }

  return (
    <div>
      {typeToggle}
      {/* Header bar */}
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {routeGroups.length} city pair{routeGroups.length !== 1 ? 's' : ''}
          {' · '}
          {routes.length} aircraft deployment{routes.length !== 1 ? 's' : ''}
          {idleCount > 0 && (
            <span style={{ color: 'var(--yellow)', marginLeft: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {idleCount} idle aircraft
              <InfoTip side="bottom" text="Idle aircraft earn nothing. Click '+ Open Route', pick two airports and an aircraft type, then 'Open Route' to deploy one. The aircraft picker shows how many idle planes you have of each type." />
            </span>
          )}
          {availableFleet.length > idleCount && (
            <span style={{ color: 'var(--accent)', marginLeft: 12 }}>
              {availableFleet.length - idleCount} with spare hours
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* View mode toggle — only shown when routes exist */}
          {routeGroups.length > 0 && (
            <div style={{ display: 'flex', gap: 2, background: 'var(--surface2)', borderRadius: 'var(--radius)', padding: 2 }}>
              {[{ id: 'cards', label: '⊞ Cards' }, { id: 'compare', label: '⊟ Compare' }].map(v => (
                <button
                  key={v.id}
                  className={`btn ${viewMode === v.id ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ fontSize: 12, padding: '4px 10px' }}
                  onClick={() => setViewMode(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}
          <button
            className="btn btn-primary"
            onClick={showForm && !isAddingFlights ? closeForm : openNewRoute}
            disabled={fleet.length === 0 || availableFleet.length === 0}
            title={
              fleet.length === 0 && pendingOrders.length > 0
                ? `Your aircraft is being delivered — advance time to receive it`
                : fleet.length === 0
                ? 'Lease an aircraft first'
                : availableFleet.length === 0
                ? 'All aircraft at full utilisation'
                : 'Open a new route'
            }
          >
            <GlyphLabel size={12} text={showForm && !isAddingFlights ? '✕ Cancel' : '+ Open Route'} />
          </button>
        </div>
      </div>

      {/* Pending delivery notice */}
      {fleet.length === 0 && pendingOrders.length > 0 && (
        <div style={{
          background: 'var(--color-warning-bg, #fffbeb)',
          border: '1px solid var(--color-warning, #f59e0b)',
          borderRadius: 8,
          padding: '10px 14px',
          marginBottom: 14,
          fontSize: 13,
          color: 'var(--color-warning-text, #92400e)',
        }}>
          <Glyph e="✈️" /> Your aircraft {pendingOrders.length === 1 ? 'is' : 'are'} on the way — advance time to receive {pendingOrders.length === 1 ? 'it' : 'them'} and open routes.
        </div>
      )}

      {/* Search / filter / sort controls — only when routes exist */}
      {routeGroups.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="form-input"
            placeholder="Search airport or city…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 210, flexShrink: 0 }}
          />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[
              { id: 'all',          label: 'All'         },
              { id: 'profitable',   label: '▲ Profit'   },
              { id: 'unprofitable', label: '▼ Losing'   },
              { id: 'lowload',      label: '⚠ Low Load' },
            ].map(t => (
              <button
                key={t.id}
                className={`btn ${filterTab === t.id ? 'btn-primary' : 'btn-ghost'}`}
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => setFilterTab(t.id)}
              >
                <GlyphLabel text={t.label} size={12} />
                {tabCounts[t.id] > 0 && (
                  <span style={{ marginLeft: 5, opacity: 0.65, fontSize: 11 }}>{tabCounts[t.id]}</span>
                )}
              </button>
            ))}
          </div>
          <select
            className="form-select"
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            style={{ width: 'auto', fontSize: 12, marginLeft: 'auto' }}
          >
            <option value="profit">Sort: Profit ↓</option>
            <option value="revenue">Sort: Revenue ↓</option>
            <option value="load">Sort: Load ↓</option>
            <option value="distance">Sort: Distance ↓</option>
          </select>
        </div>
      )}

      {/* Form (new route or add-flights, keyed so it resets on mode change) */}
      {showForm && (
        <AddRouteForm
          key={isAddingFlights ? `${formMode.origin}→${formMode.destination}` : 'new'}
          onClose={closeForm}
          initialOrigin={formInitialOrigin}
          initialDest={formInitialDest}
        />
      )}

      {/* Route groups / compare table */}
      {routeGroups.length === 0 && tagRoutes.length === 0 && !showForm ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Glyph e="🗺️" /></div>
          <div className="empty-state-text">No routes yet.</div>
          <div style={{ marginTop: 8, fontSize: 13 }}>
            {fleet.length > 0
              ? 'Click "Open Route" to launch your first service.'
              : 'Lease an aircraft from the Market first.'}
          </div>
        </div>
      ) : routeGroups.length > 0 && visibleGroups.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Glyph e="🔍" /></div>
          <div className="empty-state-text">No routes match</div>
          <div style={{ marginTop: 8, fontSize: 13 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setSearch(''); setFilterTab('all'); }}>
              Clear filters
            </button>
          </div>
        </div>
      ) : viewMode === 'compare' ? (
        <RouteCompareTable
          groups={visibleGroups}
          onViewDetail={(g) => setDetailPair({ origin: g.origin, destination: g.destination })}
        />
      ) : (
        visibleGroups.map(group => (
          <RouteGroupCard
            key={group.key}
            group={group}
            onClose={handleClose}
            onPriceChange={handlePriceChange}
            onAddFlights={() => addFlightsTo(group.origin, group.destination)}
            onViewDetail={() => setDetailPair({ origin: group.origin, destination: group.destination })}
          />
        ))
      )}

      {/* Multi-stop (tag) routes — own section, since they span several airports */}
      {typeFilter !== 'freight' && tagRoutes.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--purple)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            <Glyph e="🔗" /> Multi-stop Routes
          </div>
          {tagRoutes.map(route => (
            <TagRouteCard key={route.id} route={route} onClose={handleClose} />
          ))}
        </div>
      )}

      {/* Cargo routes (shown in the All view; the Freight tab shows them on their own) */}
      {typeFilter === 'all' && cargoCount > 0 && (
        <div style={{ marginTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#e8833a', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            <Glyph e="📦" /> Cargo Routes
          </div>
          <CargoRoutesList />
        </div>
      )}
    </div>
  );
}

// ─── Multi-stop (tag) route card ──────────────────────────────────────────────

function TagRouteCard({ route, onClose }) {
  const { state } = useGame();
  const { fleet } = state;
  const gd = currentGameDate(state);

  const aircraft = fleet.find(a => a.id === route.aircraftId);
  const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
  const stops    = routeStops(route);
  const sim      = aircraft ? simulateTagRoute(route, aircraft, gd, state.labor ?? null, 1.0) : null;
  const landingFee = type ? routeLandingFee(route, type, route.weeklyFrequency) : 0;
  const profit   = sim ? sim.profit - landingFee : 0;

  const loadColor = (lf) => lf >= 0.75 ? 'var(--green)' : lf >= 0.45 ? 'var(--yellow)' : 'var(--red)';

  return (
    <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--purple)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 2 }}>
            {stops.map((c, i) => (
              <span key={i}>
                <AirportLink code={c} />
                {i < stops.length - 1 && <span style={{ color: 'var(--text-muted)', margin: '0 8px', fontWeight: 400 }}>→</span>}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {aircraft?.name ?? '—'}{type ? ` · ${type.name}` : ''}
            {sim ? ` · ${sim.distance.toLocaleString()} km total · ${sim.legs.length} legs` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: 'rgba(163,113,247,0.14)', color: 'var(--purple)', border: '1px solid rgba(163,113,247,0.35)' }}>
            {route.weeklyFrequency}× / wk
          </span>
          <button className="btn" style={{ padding: '3px 10px', fontSize: 11, background: 'rgba(248,81,73,0.1)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.3)' }}
            onClick={() => onClose(route.id)}>Remove</button>
        </div>
      </div>

      {sim ? (
        <>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', padding: '10px 14px', marginBottom: 12, background: 'var(--surface2)', borderRadius: 'var(--radius)', fontSize: 13 }}>
            {[
              { label: 'Pax / wk', value: sim.passengers.toLocaleString() },
              { label: 'Blended load', value: formatPercent(sim.loadFactor), color: loadColor(sim.loadFactor) },
              { label: 'Revenue / wk', value: '+' + formatMoney(sim.revenue), color: 'var(--green)' },
              { label: 'Op cost / wk', value: '−' + formatMoney(sim.totalOpCost + landingFee), color: 'var(--red)' },
              { label: 'Op profit / wk', value: (profit >= 0 ? '+' : '') + formatMoney(profit), color: profit >= 0 ? 'var(--green)' : 'var(--red)' },
            ].map((c, i) => (
              <div key={i}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{c.label}</div>
                <div style={{ fontWeight: 700, color: c.color ?? 'var(--text)' }}>{c.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {sim.legs.map((l, i) => (
              <div key={i} style={{ flex: '1 1 130px', background: 'var(--surface2)', borderRadius: 'var(--radius)', padding: '8px 12px', borderTop: `3px solid ${loadColor(l.loadFactor)}` }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{l.from} → {l.to} · {l.distance.toLocaleString()} km</div>
                <div style={{ fontWeight: 700, color: loadColor(l.loadFactor) }}>{formatPercent(l.loadFactor)}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Aircraft unavailable — this route isn’t flying.</div>
      )}
    </div>
  );
}

// ─── Route comparison table ───────────────────────────────────────────────────

function RouteCompareTable({ groups, onViewDetail }) {
  const totalRev    = groups.reduce((s, g) => s + g.totalRevenue, 0);
  const totalProfit = groups.reduce((s, g) => s + g.totalProfit,  0);
  const totalPax    = groups.reduce((s, g) => s + (g.totalPax ?? 0), 0);

  const COL_HEADER = { padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid var(--border)' };
  const COL_RIGHT  = { ...COL_HEADER, textAlign: 'right' };

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Totals row */}
      <div style={{
        display: 'flex', gap: 24, padding: '10px 14px',
        background: 'var(--surface2)', borderBottom: '1px solid var(--border)',
        fontSize: 12, flexWrap: 'wrap',
      }}>
        <span style={{ color: 'var(--text-muted)' }}>{groups.length} city pairs</span>
        <span style={{ color: 'var(--green)', fontWeight: 600 }}>Total revenue: +{formatMoney(totalRev)}/wk</span>
        <span style={{ color: totalProfit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
          Op profit: {totalProfit >= 0 ? '+' : ''}{formatMoney(totalProfit)}/wk
        </span>
        {totalRev > 0 && (
          <span style={{ color: 'var(--text-muted)' }}>
            Margin: {Math.round((totalProfit / totalRev) * 100)}%
          </span>
        )}
        <span style={{ color: 'var(--text-muted)' }}>Pax: {totalPax.toLocaleString()}/wk</span>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={COL_HEADER}>Route</th>
              <th style={COL_HEADER}>Cities</th>
              <th style={COL_RIGHT}>Dist</th>
              <th style={COL_RIGHT}>Freq</th>
              <th style={COL_RIGHT}>Load</th>
              <th style={COL_RIGHT}>Pax/wk</th>
              <th style={COL_RIGHT}>Revenue/wk</th>
              <th style={COL_RIGHT}>Op Profit/wk</th>
              <th style={COL_RIGHT}>Margin</th>
              <th style={COL_RIGHT}>Rev/km</th>
              <th style={{ ...COL_HEADER, textAlign: 'center' }}></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g, i) => {
              const oa = getAirport(g.origin);
              const da = getAirport(g.destination);
              const margin = g.totalRevenue > 0 ? g.totalProfit / g.totalRevenue : 0;
              const revPerKm = g.distance > 0 ? g.totalRevenue / g.distance : 0;
              const totalFreq = g.routes.reduce((s, r) => s + r.weeklyFrequency, 0);

              const profColor  = g.totalProfit >= 0 ? 'var(--green)' : 'var(--red)';
              const loadColor  = g.avgLoad > 0.7 ? 'var(--green)' : g.avgLoad > 0.4 ? 'var(--yellow)' : 'var(--red)';
              const margColor  = margin > 0.15 ? 'var(--green)' : margin > 0 ? 'var(--yellow)' : 'var(--red)';

              return (
                <tr
                  key={g.key}
                  style={{
                    borderBottom: '1px solid var(--border-subtle)',
                    background: i % 2 === 1 ? 'var(--surface2)' : undefined,
                    cursor: 'pointer',
                  }}
                  onClick={() => onViewDetail(g)}
                >
                  <td style={{ padding: '8px 10px', fontWeight: 700, fontFamily: 'monospace', fontSize: 13, color: 'var(--accent)', whiteSpace: 'nowrap' }}>
                    {g.origin} → {g.destination}
                  </td>
                  <td style={{ padding: '8px 10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {oa?.city} → {da?.city}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>
                    {g.distance ? `${g.distance.toLocaleString()} km` : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    {totalFreq}×/wk
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: loadColor }}>
                    {formatPercent(g.avgLoad)}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>
                    {(g.totalPax ?? 0).toLocaleString()}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: 'var(--green)' }}>
                    +{formatMoney(g.totalRevenue)}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: profColor }}>
                    {g.totalProfit >= 0 ? '+' : ''}{formatMoney(g.totalProfit)}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: margColor }}>
                    {Math.round(margin * 100)}%
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>
                    {revPerKm > 0 ? `$${revPerKm.toFixed(0)}` : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>→</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Route group card ─────────────────────────────────────────────────────────

function RouteGroupCard({ group, onClose, onPriceChange, onAddFlights, onViewDetail }) {
  const { state, dispatch } = useGame();
  const { fleet } = state;
  const { origin, destination, routes } = group;
  const gd = currentGameDate(state);

  const originAirport = getAirport(origin);
  const destAirport   = getAirport(destination);
  const refP          = referencePrice(origin, destination);

  // Simulate each aircraft on this route
  const sims = routes.map(route => {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
    const result   = aircraft ? simulateRoute(route, aircraft, gd) : null;
    const bh       = type && result ? weeklyBlockHours(result.distance, route.weeklyFrequency, type) : 0;
    return { route, aircraft, type, result, blockHrs: bh };
  });

  const dist        = sims[0]?.result?.distance;
  const totalFreq   = routes.reduce((s, r) => s + r.weeklyFrequency, 0);
  const totalRev    = sims.reduce((s, { result }) => s + (result?.revenue    ?? 0), 0);
  const totalOp     = sims.reduce((s, { result }) => s + (result?.totalOpCost ?? 0), 0);
  const totalPax    = sims.reduce((s, { result }) => s + (result?.passengers  ?? 0), 0);
  const totalProfit = totalRev - totalOp;

  // Blended load factor: one-way pax / configured one-way seat capacity
  const totalSeatsOneWay = sims.reduce((s, { result }) => s + (result?.configuredSeatsOneWay ?? 0), 0);
  const blendedLoad = totalSeatsOneWay > 0 ? totalPax / totalSeatsOneWay : 0;  // totalPax is already one-way

  const profitColor = totalProfit >= 0 ? 'var(--green)' : 'var(--red)';
  const loadColor   = blendedLoad > 0.7 ? 'var(--green)' : blendedLoad > 0.4 ? 'var(--yellow)' : 'var(--red)';

  // ── Catering (per route, shown/edited at the city-pair level) ──────────────
  const catLevels      = [...new Set(routes.map(r => normalizeCateringLevel(r.cateringLevel)))];
  const groupCatLevel  = catLevels.length === 1 ? catLevels[0] : null;  // null = mixed
  const totalCatRev    = sims.reduce((s, { result }) => s + (result?.cateringRevenue ?? 0), 0);
  const totalCatCost   = sims.reduce((s, { result }) => s + (result?.cateringCost    ?? 0), 0);
  const setGroupCatering = (level) =>
    dispatch({ type: 'SET_ROUTE_CATERING', routeIds: routes.map(r => r.id), level });

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      {/* ── Route header ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 2 }}>
            <AirportLink code={origin} />
            <span style={{ color: 'var(--text-muted)', margin: '0 8px', fontWeight: 400 }}>→</span>
            <AirportLink code={destination} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {originAirport?.city} → {destAirport?.city}
            {dist ? ` · ${dist.toLocaleString()} km` : ''}
            {' · '}ref ${refP}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {sims.some(({ aircraft }) => aircraft?.status === 'grounded') && (
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
              background: 'rgba(248,81,73,0.12)', color: 'var(--red)',
              border: '1px solid rgba(248,81,73,0.35)',
            }}>
              <Glyph e="⚠️" /> Disrupted
            </span>
          )}
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
            background: 'rgba(56,139,253,0.12)', color: 'var(--accent)',
            border: '1px solid rgba(56,139,253,0.3)',
          }}>
            {routes.length} aircraft · {totalFreq}× / wk
          </span>
        </div>
      </div>

      {/* ── Combined stats ────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 20, flexWrap: 'wrap',
        padding: '10px 14px', marginBottom: 14,
        background: 'var(--surface2)', borderRadius: 'var(--radius)',
        fontSize: 13,
      }}>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Avg Load</div>
          <div style={{ fontWeight: 700, color: loadColor }}>
            {formatPercent(blendedLoad)}
            <span style={{ display: 'inline-block', marginLeft: 8, width: 60, height: 6, background: 'var(--surface3)', borderRadius: 3, verticalAlign: 'middle', overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${Math.min(100, blendedLoad * 100)}%`, background: loadColor, borderRadius: 3 }} />
            </span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Pax / wk</div>
          <div style={{ fontWeight: 700 }}>{totalPax.toLocaleString()}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Revenue / wk</div>
          <div style={{ fontWeight: 700, color: 'var(--green)' }}>+{formatMoney(totalRev)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Op Cost / wk</div>
          <div style={{ fontWeight: 700, color: 'var(--red)' }}>−{formatMoney(totalOp)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Op Profit / wk</div>
          <div style={{ fontWeight: 700, color: profitColor }}>
            {totalProfit >= 0 ? '+' : ''}{formatMoney(totalProfit)}
          </div>
        </div>
      </div>

      {/* ── Catering service ──────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap',
        gap: 12, padding: '10px 14px', marginBottom: 14,
        background: 'var(--surface2)', borderRadius: 'var(--radius)',
      }}>
        <div style={{ minWidth: 220, flex: '1 1 260px' }}>
          <CateringSelector
            value={groupCatLevel ?? 'full'}
            onChange={setGroupCatering}
            distKm={dist}
            compact
            label={groupCatLevel ? 'Catering service' : 'Catering service · mixed across aircraft'}
          />
        </div>
        <div style={{ textAlign: 'right', fontSize: 12, whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
            Catering net / wk
          </div>
          <div>
            <span style={{ color: 'var(--green)' }}>+{formatMoney(totalCatRev)}</span>
            <span style={{ color: 'var(--text-dim)', margin: '0 4px' }}>·</span>
            <span style={{ color: 'var(--red)' }}>−{formatMoney(totalCatCost)}</span>
          </div>
          <div style={{ fontWeight: 700, color: (totalCatRev - totalCatCost) >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {(totalCatRev - totalCatCost) >= 0 ? '+' : ''}{formatMoney(totalCatRev - totalCatCost)}
          </div>
        </div>
      </div>

      {/* ── Per-aircraft table ────────────────────────────────────────────── */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Aircraft', 'Tail', 'Freq', 'Seats/wk', 'Load', 'Revenue/wk', 'Op Cost/wk', 'Block hrs', 'Ticket', ''].map(h => (
                <th key={h} style={{ padding: '4px 8px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sims.map(({ route, aircraft, type, result, blockHrs }) => (
              <AircraftRow
                key={route.id}
                route={route}
                aircraft={aircraft}
                type={type}
                result={result}
                blockHrs={blockHrs}
                onClose={onClose}
                onPriceChange={onPriceChange}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Footer actions ────────────────────────────────────────────────── */}
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={onViewDetail}>
          Details →
        </button>
        <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={onAddFlights}>
          + Add Flights
        </button>
      </div>
    </div>
  );
}

// ─── Per-aircraft table row ───────────────────────────────────────────────────

// ─── Class metadata ───────────────────────────────────────────────────────────

const CLASS_ORDER = ['firstClass', 'businessClass', 'premiumEconomy', 'economy'];
const CLASS_LABELS = {
  economy:        'Economy',
  premiumEconomy: 'Premium Eco',
  businessClass:  'Business',
  firstClass:     'First',
};
const CLASS_COLORS = {
  economy:        'var(--text-muted)',
  premiumEconomy: 'var(--yellow)',
  businessClass:  'var(--accent)',
  firstClass:     'var(--purple)',
};

// ─── Per-class pricing panel ──────────────────────────────────────────────────

function PricingPanel({ route, aircraft, type }) {
  const { dispatch } = useGame();
  const config = aircraft?.config ?? (type ? { economy: type.seats } : {});
  const refP   = referencePrice(route.origin, route.destination);

  const refPrices = {
    economy:        refP,
    premiumEconomy: Math.round(refP * 1.7),
    businessClass:  Math.round(refP * 3.5),
    firstClass:     Math.round(refP * 8.0),
  };

  // Only show classes the aircraft actually has seats in
  const activeClasses = CLASS_ORDER.filter(cls => (config[cls] ?? 0) > 0);

  const [draft, setDraft] = useState(() => {
    const cp = route.classPrices ?? {};
    const result = {};
    for (const cls of activeClasses) {
      result[cls] = String(cp[cls] ?? Math.round(refPrices[cls]));
    }
    return result;
  });

  // Per-class fare ceiling (3× the class's reference fare). The reducer clamps
  // too, but clamping here gives the player immediate feedback in the field.
  const maxPrices = {};
  for (const cls of activeClasses) maxPrices[cls] = maxClassPrice(refP, cls);

  function handleBlur(cls) {
    const val = parseInt(draft[cls], 10);
    if (!isNaN(val) && val > 0) {
      const clamped = Math.min(val, maxPrices[cls]);
      if (clamped !== val) setDraft(d => ({ ...d, [cls]: String(clamped) }));
      dispatch({ type: 'UPDATE_CLASS_PRICES', routeId: route.id, updates: { [cls]: clamped } });
    }
  }

  return (
    <div style={{
      display: 'flex', gap: 12, flexWrap: 'wrap', padding: '10px 12px',
      background: 'var(--surface3)', borderRadius: 'var(--radius)', marginTop: 4,
    }}>
      {activeClasses.map(cls => {
        const current = parseInt(draft[cls], 10) || refPrices[cls];
        const pct     = Math.round((current / refPrices[cls] - 1) * 100);
        return (
          <div key={cls} style={{ minWidth: 110 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: CLASS_COLORS[cls], textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
              {CLASS_LABELS[cls]}
              <span style={{ color: 'var(--text-dim)', fontWeight: 400, marginLeft: 4 }}>
                ({config[cls]} seats)
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>$</span>
              <input
                className="form-input"
                type="number"
                min="1"
                max={maxPrices[cls]}
                title={`Max $${maxPrices[cls].toLocaleString()} (cap: 3× reference)`}
                style={{ width: 72, padding: '3px 6px', fontSize: 12 }}
                value={draft[cls]}
                onChange={e => setDraft(d => ({ ...d, [cls]: e.target.value }))}
                onBlur={() => handleBlur(cls)}
              />
            </div>
            <div style={{ fontSize: 10, color: pct > 0 ? 'var(--red)' : pct < 0 ? 'var(--green)' : 'var(--text-dim)', marginTop: 2 }}>
              ref ${refPrices[cls]} {pct !== 0 && `(${pct > 0 ? '+' : ''}${pct}%)`}
              <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>· max ${maxPrices[cls].toLocaleString()}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Per-aircraft table row ───────────────────────────────────────────────────

function AircraftRow({ route, aircraft, type, result, blockHrs, onClose, onPriceChange }) {
  const { state } = useGame();
  const curMonth = currentGameDate(state).month;
  const isDormant = !!route.season && !isRouteActive(route, curMonth);
  const [showPricing, setShowPricing] = useState(false);
  const econPrice = route.classPrices?.economy ?? route.ticketPrice;

  const loadColor = result
    ? (result.loadFactor > 0.7 ? 'var(--green)' : result.loadFactor > 0.4 ? 'var(--yellow)' : 'var(--red)')
    : 'var(--text-muted)';
  const bhPct   = blockHrs / MAX_WEEKLY_BLOCK_HOURS;
  const bhColor = bhPct >= 0.95 ? 'var(--red)' : bhPct >= 0.75 ? 'var(--yellow)' : 'var(--text-muted)';
  const seatsPerWk = (type?.seats ?? 0) * route.weeklyFrequency;

  const isGrounded = aircraft?.status === 'grounded';

  return (
    <>
      <tr style={{
        borderBottom: showPricing ? 'none' : '1px solid var(--border-subtle)',
        opacity: (isGrounded || isDormant) ? 0.6 : 1,
        background: isGrounded ? 'rgba(248,81,73,0.04)' : undefined,
      }}>
        <td style={{ padding: '7px 8px', fontWeight: 600 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {aircraft?.name ?? '—'}
            <SeasonBadge route={route} month={curMonth} />
            {isGrounded && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                background: 'rgba(248,81,73,0.15)', color: 'var(--red)',
                border: '1px solid rgba(248,81,73,0.3)',
                textTransform: 'uppercase', letterSpacing: '.04em',
              }}>
                <Glyph e="🔧" /> {aircraft.groundedWeeksLeft}w
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{type?.name ?? ''}</div>
        </td>
        <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontSize: 11, color: 'var(--accent)' }}>
          {aircraft?.tailNumber ?? '—'}
        </td>
        <td style={{ padding: '7px 8px' }}>{route.weeklyFrequency}×</td>
        <td style={{ padding: '7px 8px', color: 'var(--text-muted)' }}>{seatsPerWk.toLocaleString()}</td>
        <td style={{ padding: '7px 8px' }}>
          {result ? (
            <span style={{ fontWeight: 600, color: loadColor }}>{formatPercent(result.loadFactor)}</span>
          ) : '—'}
        </td>
        <td style={{ padding: '7px 8px', color: 'var(--green)', fontWeight: 600 }}>
          {result ? `+${formatMoney(result.revenue)}` : '—'}
        </td>
        <td style={{ padding: '7px 8px', color: 'var(--red)' }}>
          {result ? `−${formatMoney(result.totalOpCost)}` : '—'}
        </td>
        <td style={{ padding: '7px 8px', color: bhColor, fontWeight: 600 }}>
          {blockHrs > 0 ? `${blockHrs.toFixed(1)}h` : '—'}
        </td>
        <td style={{ padding: '7px 8px' }}>
          {/* Pricing toggle — shows economy price, click to expand all classes */}
          <button
            onClick={() => setShowPricing(v => !v)}
            style={{
              background: showPricing ? 'rgba(56,139,253,0.12)' : 'var(--surface3)',
              border: `1px solid ${showPricing ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 'var(--radius)', padding: '3px 8px', cursor: 'pointer',
              color: showPricing ? 'var(--accent)' : 'var(--text)', fontSize: 12,
              display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
            }}
          >
            ${econPrice}
            <span style={{ fontSize: 10, opacity: 0.7 }}>{showPricing ? '▴' : '▾'}</span>
          </button>
        </td>
        <td style={{ padding: '7px 8px' }}>
          <button
            className="btn"
            style={{ padding: '3px 8px', fontSize: 11, background: 'rgba(248,81,73,0.1)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.3)' }}
            onClick={() => onClose(route.id)}
          >
            Remove
          </button>
        </td>
      </tr>
      {showPricing && (
        <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <td colSpan={10} style={{ padding: '0 8px 10px' }}>
            <PricingPanel route={route} aircraft={aircraft} type={type} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Region helpers for grouped selects ──────────────────────────────────────

const REGION_MAP = {
  US: 'North America', CA: 'North America', MX: 'North America',
  GB: 'Europe', FR: 'Europe', DE: 'Europe', NL: 'Europe',
  ES: 'Europe', IT: 'Europe', TR: 'Europe',
  AE: 'Middle East & Asia', SG: 'Middle East & Asia', HK: 'Middle East & Asia',
  JP: 'Middle East & Asia', KR: 'Middle East & Asia', CN: 'Middle East & Asia',
  IN: 'Middle East & Asia', AU: 'Middle East & Asia',
  BR: 'South America', AR: 'South America',
};
const REGION_ORDER = ['North America', 'Europe', 'Middle East & Asia', 'South America', 'Other'];

function airportRegion(airport) {
  return REGION_MAP[airport?.country] ?? 'Other';
}

// ─── Add-route / add-flights form ─────────────────────────────────────────────

function AddRouteForm({ onClose, initialOrigin, initialDest }) {
  const { state, dispatch } = useGame();
  const { fleet, routes, hub, gates = {} } = state;

  const isAddingFlights = initialOrigin != null && initialDest != null;

  // Helper: total block hours already assigned to an aircraft
  const usedBlockHrsFor = (a) => {
    const t = getAircraftType(a?.typeId);
    if (!a || !t) return 0;
    return routes.filter(r => r.aircraftId === a.id)
      .reduce((s, r) => s + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, t), 0);
  };

  const defaultAircraft = fleet.find(a => usedBlockHrsFor(a) < MAX_WEEKLY_BLOCK_HOURS);

  const [origin, setOrigin] = useState(initialOrigin ?? hub);
  const [dest,   setDest]   = useState(initialDest   ?? '');
  const [aircraftId,  setAircraftId]  = useState(defaultAircraft?.id ?? '');
  const [frequency,   setFrequency]   = useState(7);
  const [ticketPrice, setTicketPrice] = useState('');
  const [season,      setSeason]      = useState(null); // null = year-round

  const aircraft = fleet.find(a => a.id === aircraftId);
  const type     = aircraft ? getAircraftType(aircraft.typeId) : null;

  const gd        = currentGameDate(state);
  const validDest = dest && dest !== origin && AIRPORTS.find(a => a.code === dest);
  const preview   = validDest && aircraft
    ? simulateRoute({ origin, destination: dest, aircraftId, weeklyFrequency: frequency,
        ticketPrice: Number(ticketPrice) || referencePrice(origin, dest) }, aircraft, gd)
    : null;
  const dist    = validDest ? Math.round(distanceKm(getAirport(origin), getAirport(dest))) : null;
  const refP    = validDest ? referencePrice(origin, dest) : null;
  const effRange = type && aircraft ? effectiveRangeKm(aircraft, type) : (type?.range ?? 0);
  const inRange  = type && dist ? dist <= effRange : true;

  // Block hours — checked PER MONTH so a dormant route's hours don't count against
  // a counter-seasonal route on the same aircraft (mirrors the reducer's logic).
  const newMonths   = routeActiveMonths({ season });
  const acRoutes    = aircraft ? routes.filter(r => r.aircraftId === aircraft.id) : [];
  const existingBlockHrs = type ? Math.max(0, ...newMonths.map(m =>
    acRoutes.filter(r => isRouteActive(r, m))
      .reduce((s, r) => s + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, type), 0))) : 0;
  const newBlockHrs      = type && dist ? weeklyBlockHours(dist, Number(frequency), type) : 0;
  const totalBlockHrs    = existingBlockHrs + newBlockHrs;
  const blockOk          = newBlockHrs === 0 || totalBlockHrs <= MAX_WEEKLY_BLOCK_HOURS;
  const routeMaxFreq     = type && dist ? maxFrequency(dist, type) : 21;
  const remainingHrs     = MAX_WEEKLY_BLOCK_HOURS - existingBlockHrs;
  const capacityMaxFreq  = type && dist
    ? Math.floor(remainingHrs / (blockTimeHours(dist, type) * 2))
    : 21;
  const freqLimit  = Math.min(routeMaxFreq, Math.max(0, capacityMaxFreq));
  const blockPct   = totalBlockHrs / MAX_WEEKLY_BLOCK_HOURS;
  const blockColor = blockPct >= 1 ? 'var(--red)' : blockPct >= 0.8 ? 'var(--yellow)' : 'var(--green)';

  // Gate / slot checks
  const gateAtOrigin   = (gates[origin] ?? 0) > 0;
  const gateAtDest     = validDest && (gates[dest] ?? 0) > 0;
  // Per-month peak so a dormant route frees its slots for a counter-seasonal route.
  const slotsUsedAt    = (code) => Math.max(0, ...newMonths.map(m =>
    routes.filter(r => (r.origin === code || r.destination === code) && isRouteActive(r, m))
      .reduce((s, r) => s + r.weeklyFrequency, 0)));
  const originSlotCap  = (gates[origin] ?? 0) * SLOTS_PER_GATE;
  const originSlotsUsed = slotsUsedAt(origin);
  const originSlotsOk  = gateAtOrigin && (originSlotsUsed + Number(frequency) <= originSlotCap);
  const destSlotCap    = validDest ? (gates[dest] ?? 0) * SLOTS_PER_GATE : 0;
  const destSlotsUsed  = validDest ? slotsUsedAt(dest) : 0;
  const destSlotsOk    = gateAtDest && (destSlotsUsed + Number(frequency) <= destSlotCap);

  // Network-connectivity check: aircraft with existing routes can only extend
  // from airports they already serve — no teleporting between unconnected cities.
  const aircraftRoutes   = aircraft ? routes.filter(r => r.aircraftId === aircraft.id) : [];
  const servedAirports   = new Set(aircraftRoutes.flatMap(r => [r.origin, r.destination]));
  const connectivityOk   = aircraftRoutes.length === 0 ||
    servedAirports.has(origin) || (validDest && servedAirports.has(dest));

  const canSubmit = validDest && aircraft && inRange && blockOk &&
    gateAtOrigin && gateAtDest && originSlotsOk && destSlotsOk && connectivityOk;

  function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    dispatch({
      type: 'ADD_ROUTE',
      origin,
      destination: dest,
      aircraftId,
      weeklyFrequency: Number(frequency),
      ticketPrice: Number(ticketPrice) || refP,
      season,
    });
    onClose();
  }

  return (
    <div className="card" style={{ borderColor: 'var(--accent)', marginBottom: 16 }}>
      <div className="card-title">
        {isAddingFlights
          ? <>Add Flights — <span style={{ color: 'var(--accent)' }}>{initialOrigin} → {initialDest}</span></>
          : 'Open New Route'}
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>

          {/* Origin / destination — locked in add-flights mode */}
          {isAddingFlights ? (
            <div className="form-group" style={{ marginBottom: 0, gridColumn: 'span 2' }}>
              <label className="form-label">Route (locked)</label>
              <div style={{
                padding: '8px 12px', borderRadius: 'var(--radius)',
                background: 'var(--surface2)', border: '1px solid var(--border)',
                fontSize: 14, fontWeight: 600, color: 'var(--accent)',
              }}>
                {initialOrigin} → {initialDest}
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 10 }}>
                  {getAirport(initialOrigin)?.city} → {getAirport(initialDest)?.city}
                </span>
              </div>
            </div>
          ) : (
            <>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Origin</label>
                <select className="form-select" value={origin} onChange={e => setOrigin(e.target.value)}>
                  {REGION_ORDER.map(region => {
                    const airports = AIRPORTS.filter(a => (gates[a.code] ?? 0) > 0 && airportRegion(a) === region);
                    if (!airports.length) return null;
                    return (
                      <optgroup key={region} label={region}>
                        {airports.map(a => (
                          <option key={a.code} value={a.code}>
                            {a.code} — {a.city} ({gates[a.code]} {gates[a.code] === 1 ? 'gate' : 'gates'})
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Destination</label>
                <select className="form-select" value={dest} onChange={e => setDest(e.target.value)} required>
                  <option value="">— Select destination —</option>
                  {REGION_ORDER.map(region => {
                    const airports = AIRPORTS.filter(a =>
                      a.code !== origin && (gates[a.code] ?? 0) > 0 && airportRegion(a) === region
                    );
                    if (!airports.length) return null;
                    return (
                      <optgroup key={region} label={region}>
                        {airports.map(a => (
                          <option key={a.code} value={a.code}>
                            {a.code} — {a.city} ({gates[a.code]} {gates[a.code] === 1 ? 'gate' : 'gates'})
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              </div>
            </>
          )}

          {/* Aircraft */}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Aircraft</label>
            <select className="form-select" value={aircraftId} onChange={e => setAircraftId(e.target.value)} required>
              {fleet.map(a => {
                const t    = getAircraftType(a.typeId);
                const used = usedBlockHrsFor(a);
                const rem  = MAX_WEEKLY_BLOCK_HOURS - used;
                const full = rem <= 0;
                const cfg  = a.config;
                const seats = cfg
                  ? (cfg.firstClass ?? 0) + (cfg.businessClass ?? 0) + (cfg.premiumEconomy ?? 0) + (cfg.economy ?? 0)
                  : (t?.seats ?? '?');
                return (
                  <option key={a.id} value={a.id} disabled={full}>
                    {a.name} ({seats} seats) — {full ? 'full' : `${rem.toFixed(0)}h free`}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Frequency */}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">
              Flights / week{freqLimit < 21 && freqLimit > 0 ? ` (max ${freqLimit})` : ''}
            </label>
            <input
              className="form-input"
              type="number"
              min="1"
              max={Math.max(1, freqLimit) || 21}
              value={frequency}
              onChange={e => setFrequency(e.target.value)}
            />
          </div>

          {/* Ticket price */}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Ticket Price ($) {refP ? `(ref: $${refP})` : ''}</label>
            <input
              className="form-input"
              type="number"
              min="1"
              placeholder={refP ? String(refP) : 'Auto'}
              value={ticketPrice}
              onChange={e => setTicketPrice(e.target.value)}
            />
          </div>
        </div>

        {/* Range warning */}
        {dist && !inRange && (
          <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>
            <Glyph e="⚠" /> {type?.name} has a range of {effRange.toLocaleString()} km (as configured) — this route is {dist.toLocaleString()} km.
          </div>
        )}

        {/* Connectivity warning */}
        {aircraft && !connectivityOk && (
          <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>
            <Glyph e="⚠" /> {aircraft.name} already flies from {[...servedAirports].join(', ')} — new routes must connect to one of those airports. Aircraft can't teleport.
          </div>
        )}

        {/* Block-hours bar */}
        {newBlockHrs > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>
                Aircraft utilisation after adding
                {existingBlockHrs > 0 && (
                  <span style={{ color: 'var(--text-dim)' }}>
                    {' '}(existing {existingBlockHrs.toFixed(1)}h + new {newBlockHrs.toFixed(1)}h)
                  </span>
                )}
              </span>
              <span style={{ color: blockColor, fontWeight: 600 }}>
                {totalBlockHrs.toFixed(1)} / {MAX_WEEKLY_BLOCK_HOURS}h
                {!blockOk && ` — max freq: ${freqLimit}×`}
              </span>
            </div>
            <div style={{ height: 4, borderRadius: 2, background: 'var(--surface3)', overflow: 'hidden', position: 'relative' }}>
              <div style={{ position: 'absolute', height: '100%', width: `${Math.min(100, blockPct * 100)}%`, background: blockColor, borderRadius: 2 }} />
              {existingBlockHrs > 0 && (
                <div style={{ position: 'absolute', height: '100%', width: `${Math.min(100, (existingBlockHrs / MAX_WEEKLY_BLOCK_HOURS) * 100)}%`, background: 'var(--text-dim)', borderRadius: 2 }} />
              )}
            </div>
          </div>
        )}

        {/* Gate / slot status */}
        {validDest && (
          <div style={{ fontSize: 12, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {!gateAtOrigin ? (
              <span style={{ color: 'var(--red)' }}><Glyph e="⚠" /> No gate at {origin} — go to Gates tab</span>
            ) : !originSlotsOk ? (
              <span style={{ color: 'var(--yellow)' }}><Glyph e="⚠" /> Not enough slots at {origin} ({originSlotsUsed}/{originSlotCap}) — add another gate</span>
            ) : (
              <span style={{ color: 'var(--green)' }}><Glyph e="✓" /> {origin}: {originSlotsUsed + Number(frequency)}/{originSlotCap} slots</span>
            )}
            {!gateAtDest ? (
              <span style={{ color: 'var(--red)' }}><Glyph e="⚠" /> No gate at {dest} — go to Gates tab</span>
            ) : !destSlotsOk ? (
              <span style={{ color: 'var(--yellow)' }}><Glyph e="⚠" /> Not enough slots at {dest} ({destSlotsUsed}/{destSlotCap}) — add another gate</span>
            ) : (
              <span style={{ color: 'var(--green)' }}><Glyph e="✓" /> {dest}: {destSlotsUsed + Number(frequency)}/{destSlotCap} slots</span>
            )}
          </div>
        )}

        <FormSeasonPicker value={season} onChange={setSeason} currentMonth={currentGameDate(state).month} />

        {/* Live preview */}
        {preview && inRange && (
          <div style={{ background: 'var(--surface2)', borderRadius: 'var(--radius)', padding: '10px 14px', marginBottom: 14, fontSize: 13, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <span><Glyph e="📏" /> {dist?.toLocaleString()} km</span>
            <span><Glyph e="👥" /> {preview.passengers.toLocaleString()} pax/wk</span>
            <span><Glyph e="📊" /> {formatPercent(preview.loadFactor)} load</span>
            <span style={{ color: 'var(--green)' }}>+{formatMoney(preview.revenue)}/wk</span>
            <span style={{ color: preview.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {preview.profit >= 0 ? '+' : ''}{formatMoney(preview.profit)}/wk op profit
            </span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {isAddingFlights ? 'Add Flights' : 'Open Route'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
