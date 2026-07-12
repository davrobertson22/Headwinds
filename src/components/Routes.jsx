import { Glyph, GlyphLabel } from './Icons.jsx';
import { useState, useMemo } from 'react';
import { useGame, frequencyChangeBlockReason } from '../store/GameContext.jsx';
import RouteDetail from './RouteDetail.jsx';
import AirportLink from './AirportLink.jsx';
import CargoRoutesList, { FreightBadge, PassengerBadge } from './CargoRoutesList.jsx';
import CargoRoutePlanner from './CargoRoutePlanner.jsx';
import { AIRPORTS, getAirport, getRegion, REGIONS } from '../data/airports.js';
import { checkRouteRestrictions } from '../data/airportRestrictions.js';
import { routeLaunchCost } from '../data/overhead.js';
import AddGateButton from './AddGateButton.jsx';
import { getAircraftType } from '../data/aircraft.js';
import { normalizeCateringLevel, CATERING_LEVELS, CATERING_LEVEL_ORDER } from '../data/catering.js';
import CateringSelector from './CateringSelector.jsx';
import InfoTip from './InfoTip.jsx';
import { useToast } from './ToastSystem.jsx';
import { projectWeek } from '../utils/financeProjection.js';
import {
  distanceKm, referencePrice, simulateRoute, formatMoney, formatPercent,
  weeklyBlockHours, blockTimeHours, maxFrequency, MAX_WEEKLY_BLOCK_HOURS, SLOTS_PER_GATE, cargoSlotsUsedAt,
  routeDistanceKm, currentGameDate, effectiveRangeKm,
  isMultiStop, simulateTagRoute, routeStops, routeBlockHours, routeLandingFee,
  maxClassPrice, isRouteActive, routeActiveMonths, fleetAvgUtilization,
  buildEventDemandModel,
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
  const addToast = useToast();
  const { fleet, routes, hub, pendingOrders = [], cargoRoutes = [] } = state;

  // Bulk pricing: explicit card selection + the occupancy-filter modal
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [showBulkModal, setShowBulkModal] = useState(false);

  // Detail view: null = list, { origin, destination } = route detail page
  const [detailPair, setDetailPair] = useState(null);

  // Form mode: null = hidden; { origin, destination } = "add flights" to existing pair;
  // 'new' = open brand-new route
  const [formMode, setFormMode] = useState(null);

  // Search / filter / sort
  const [search,    setSearch]    = useState('');
  const [sortBy,    setSortBy]    = useState('profit');
  const [filterTab, setFilterTab] = useState('all');

  // Extra scoping filters for large networks
  const [regionFilter, setRegionFilter] = useState('all');  // route touches this region
  const [acTypeFilter, setAcTypeFilter] = useState('all');  // aircraft type id
  const [haulFilter,   setHaulFilter]   = useState('all');  // short | medium | long

  // Passenger vs Freight view
  const [typeFilter, setTypeFilter] = useState('all');

  // Freight planner toggle (inline "Open Freight Route" form in the Freight view)
  const [showCargoForm, setShowCargoForm] = useState(false);

  // View mode: 'table' (default — scales to hundreds of routes) | 'cards'
  const [viewMode, setViewMode] = useState('table');

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

  // ── Single source of truth ──────────────────────────────────────────────────
  // Every per-route number on this screen (cards, filters, detail page) must come
  // from the SAME canonical engine projection the Finance tab uses. Re-simulating
  // standalone here ignores competitor encroachment, labor, fuel and revenue
  // boosts, which made routes look profitable on the Routes screen while Finance
  // correctly showed them losing money.
  const gd = currentGameDate(state);
  const proj = useMemo(() => projectWeek(state), [state]);
  const rrById = useMemo(() => {
    const m = {};
    for (const rr of proj.report?.routeResults ?? []) m[rr.routeId] = rr;
    return m;
  }, [proj]);

  // Authoritative per-route result. Prefer the engine's routeResult (includes
  // encroachment, marketing/loyalty lifts, landing fees). Routes the engine skips
  // (grounded or dormant-seasonal) aren't in the report, so fall back to a
  // standalone sim run with the same labor + fuel the engine used.
  const engineResultFor = (route, aircraft) => {
    if (!aircraft) return null;
    const rr = rrById[route.id];
    if (rr) return rr;
    const avgUtil = fleetAvgUtilization(state.fleet ?? [], [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]);
    const evMult  = buildEventDemandModel(state.activeEvents).multFor(route.origin, route.destination);
    return simulateRoute(route, aircraft, gd, state.labor ?? null, proj.fuelMultiplier, null, [], avgUtil, state.satisfaction ?? null, evMult);
  };

  // Per-group stats for filtering + sorting
  const groupsWithStats = useMemo(() => routeGroups.map(group => {
    const sims = group.routes.map(route => {
      const ac     = fleet.find(a => a.id === route.aircraftId);
      const result = engineResultFor(route, ac);
      return { route, result };
    });
    // Direct cost = operating cost + landing fee, so profit matches Finance "By Route".
    const totalRevenue = sims.reduce((s, { result }) => s + (result?.revenue   ?? 0), 0);
    const totalCost    = sims.reduce((s, { result }) => s + (result?.totalOpCost ?? 0) + (result?.landingFee ?? 0), 0);
    const totalProfit  = totalRevenue - totalCost;
    const totalPax     = sims.reduce((s, { result }) => s + (result?.passengers ?? 0), 0);
    const totalSeats   = sims.reduce((s, { result }) => s + (result?.configuredSeatsOneWay ?? 0), 0);
    const avgLoad = totalSeats > 0 ? totalPax / totalSeats : 0;  // totalPax is one-way; totalSeats is configured one-way capacity
    const distance = sims[0]?.result?.distance ?? 0;

    // Per-class occupancy across every aircraft on the pair: sum one-way pax and
    // weekly one-way capacity per cabin, then divide. classSummary[cls].seats is
    // per-flight, so weekly capacity = seats × that aircraft's frequency.
    // classLoads[cls] is null when the pair has no seats in that cabin, so the
    // filter can skip it rather than treat it as 0%.
    const classPax = { economy: 0, premiumEconomy: 0, businessClass: 0, firstClass: 0 };
    const classCap = { economy: 0, premiumEconomy: 0, businessClass: 0, firstClass: 0 };
    for (const { route, result } of sims) {
      const cs = result?.classSummary;
      if (!cs) continue;
      const freq = route.weeklyFrequency ?? 1;
      for (const cls of Object.keys(classPax)) {
        classPax[cls] += cs[cls]?.passengers ?? 0;
        classCap[cls] += (cs[cls]?.seats ?? 0) * freq;
      }
    }
    const classLoads = {};
    for (const cls of Object.keys(classPax)) {
      classLoads[cls] = classCap[cls] > 0 ? classPax[cls] / classCap[cls] : null;
    }

    // Status + scoping metadata (drives the health chips and the region /
    // aircraft-type / haul filters in the table view).
    const acs = group.routes.map(r => fleet.find(a => a.id === r.aircraftId)).filter(Boolean);
    const hasDisrupted = acs.some(a => a.status === 'grounded');
    const hasDormant   = group.routes.some(r => r.season && !isRouteActive(r, gd.month));
    const regions = new Set([
      getRegion(getAirport(group.origin)?.country),
      getRegion(getAirport(group.destination)?.country),
    ]);
    const typeIds   = new Set(acs.map(a => a.typeId));
    const margin    = totalRevenue > 0 ? totalProfit / totalRevenue : 0;
    const totalFreq = group.routes.reduce((s, r) => s + r.weeklyFrequency, 0);

    return {
      ...group, totalProfit, totalRevenue, totalPax, avgLoad, distance, classLoads,
      hasDisrupted, hasDormant, regions, typeIds, margin, totalFreq,
    };
  }), [routes, fleet, rrById]); // eslint-disable-line react-hooks/exhaustive-deps

  // Aircraft types present across all groups (for the type filter dropdown).
  // NOTE: must stay above the detailPair early-return — hooks can't be conditional.
  const typesInUse = useMemo(() => {
    const ids = new Set();
    for (const g of groupsWithStats) for (const t of g.typeIds) ids.add(t);
    return [...ids].map(id => ({ id, name: getAircraftType(id)?.name ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [groupsWithStats]);

  // If a route detail is selected, render that instead of the list
  if (detailPair) {
    return (
      <RouteDetail
        origin={detailPair.origin}
        dest={detailPair.destination}
        rrById={rrById}
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

  // Scoping filters (applied before the status tabs so tab counts reflect scope)
  const haulOf = (d) => d < 1500 ? 'short' : d <= 4500 ? 'medium' : 'long';
  const afterScope = afterSearch.filter(g => {
    if (regionFilter !== 'all' && !g.regions.has(regionFilter)) return false;
    if (acTypeFilter !== 'all' && !g.typeIds.has(acTypeFilter)) return false;
    if (haulFilter   !== 'all' && haulOf(g.distance) !== haulFilter) return false;
    return true;
  });

  // Tab counts (based on scoped results, not status-filtered, so each tab shows a sensible number)
  const tabCounts = {
    all:          afterScope.length,
    profitable:   afterScope.filter(g => g.totalProfit >= 0).length,
    unprofitable: afterScope.filter(g => g.totalProfit < 0).length,
    lowload:      afterScope.filter(g => g.avgLoad < 0.5).length,
    disrupted:    afterScope.filter(g => g.hasDisrupted).length,
    dormant:      afterScope.filter(g => g.hasDormant).length,
  };

  // Status filter
  const afterFilter = afterScope.filter(g => {
    if (filterTab === 'profitable')   return g.totalProfit >= 0;
    if (filterTab === 'unprofitable') return g.totalProfit < 0;
    if (filterTab === 'lowload')      return g.avgLoad < 0.5;
    if (filterTab === 'disrupted')    return g.hasDisrupted;
    if (filterTab === 'dormant')      return g.hasDormant;
    return true;
  });

  // Sort (cards view only — the table sorts by its own column headers)
  const visibleGroups = [...afterFilter].sort((a, b) => {
    if (sortBy === 'revenue')  return b.totalRevenue - a.totalRevenue;
    if (sortBy === 'load')     return b.avgLoad      - a.avgLoad;
    if (sortBy === 'distance') return b.distance     - a.distance;
    return b.totalProfit - a.totalProfit; // default
  });

  // Groups the player has explicitly ticked (across the full list, not just the
  // current filter view, so a selection survives a filter change).
  const selectedGroups = groupsWithStats.filter(g => selectedKeys.has(g.key));

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

  // Apply a per-class % fare change to a set of route groups (one dispatch covers
  // every aircraft on each pair). `pctRaw` maps class → string from the % inputs.
  function applyPctToGroups(groupsToAdjust, pctRaw) {
    const pct = {};
    for (const [cls, v] of Object.entries(pctRaw ?? {})) {
      const n = parseFloat(v);
      if (!isNaN(n) && n !== 0) pct[cls] = n;
    }
    const routeIds = groupsToAdjust.flatMap(g => g.routes.map(r => r.id));
    if (routeIds.length === 0 || Object.keys(pct).length === 0) return;
    dispatch({ type: 'BULK_ADJUST_PRICING', routeIds, pct });
    const parts = Object.entries(pct).map(([cls, n]) => `${CLASS_LABELS[cls]} ${n > 0 ? '+' : ''}${n}%`);
    addToast({
      type: 'success',
      title: 'Pricing updated',
      message: `${groupsToAdjust.length} route${groupsToAdjust.length !== 1 ? 's' : ''}: ${parts.join(', ')}`,
    });
  }

  // Bulk: set catering level on every selected pair at once.
  function bulkSetCatering(groupsToSet, level) {
    const routeIds = groupsToSet.flatMap(g => g.routes.map(r => r.id));
    if (routeIds.length === 0) return;
    dispatch({ type: 'SET_ROUTE_CATERING', routeIds, level });
    addToast({
      type: 'success',
      title: 'Catering updated',
      message: `${groupsToSet.length} route${groupsToSet.length !== 1 ? 's' : ''} set to ${CATERING_LEVELS[normalizeCateringLevel(level)].name}`,
    });
    clearSelection();
  }

  // Bulk: close every selected pair (all aircraft deployments on them).
  function bulkCloseGroups(groupsToClose) {
    const routeIds = groupsToClose.flatMap(g => g.routes.map(r => r.id));
    if (routeIds.length === 0) return;
    const ok = window.confirm(
      `Close ${groupsToClose.length} route${groupsToClose.length !== 1 ? 's' : ''} ` +
      `(${routeIds.length} aircraft deployment${routeIds.length !== 1 ? 's' : ''})? ` +
      `Aircraft will be freed for other assignments.`
    );
    if (!ok) return;
    for (const id of routeIds) dispatch({ type: 'CLOSE_ROUTE', routeId: id });
    addToast({
      type: 'success',
      title: 'Routes closed',
      message: `${groupsToClose.length} route${groupsToClose.length !== 1 ? 's' : ''} closed.`,
    });
    clearSelection();
  }

  function toggleSelect(key) {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  function clearSelection() { setSelectedKeys(new Set()); }

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

  // Freight-only view: cargo routes list + an inline freight planner.
  if (typeFilter === 'freight') {
    return (
      <div>
        {typeToggle}
        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            {cargoCount} cargo route{cargoCount !== 1 ? 's' : ''}
          </div>
          <button
            className="btn btn-primary"
            style={{ background: '#e8833a', borderColor: '#e8833a' }}
            onClick={() => setShowCargoForm(v => !v)}
          >
            <GlyphLabel size={12} text={showCargoForm ? '✕ Cancel' : '📦 Open Freight Route'} />
          </button>
        </div>
        {showCargoForm && (
          <div style={{ marginBottom: 16 }}>
            <CargoRoutePlanner embedded onOpened={() => setShowCargoForm(false)} />
          </div>
        )}
        <CargoRoutesList />
      </div>
    );
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
              {[{ id: 'table', label: '⊟ Table' }, { id: 'cards', label: '⊞ Cards' }].map(v => (
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
          {routeGroups.length > 0 && (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => setShowBulkModal(true)}
              title="Adjust fares across many routes at once, filtered by cabin occupancy"
            >
              <GlyphLabel size={12} text="⚖️ Bulk Pricing" />
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={showForm && !isAddingFlights ? closeForm : openNewRoute}
            disabled={fleet.length === 0 || availableFleet.length === 0}
            title={
              fleet.length === 0 && pendingOrders.length > 0
                ? `Your aircraft is being delivered — it arrives with an upcoming week`
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

      {/* Network health strip — click a chip to filter */}
      {routeGroups.length > 3 && (
        <NetworkHealthStrip
          groups={groupsWithStats}
          activeTab={filterTab}
          onSelectTab={t => setFilterTab(cur => cur === t ? 'all' : t)}
        />
      )}

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
          <Glyph e="✈️" /> Your aircraft {pendingOrders.length === 1 ? 'is' : 'are'} on the way — {pendingOrders.length === 1 ? 'it arrives' : 'they arrive'} with an upcoming week, ready to open routes.
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
              ...(tabCounts.disrupted > 0 ? [{ id: 'disrupted', label: '🔧 Disrupted' }] : []),
              ...(tabCounts.dormant   > 0 ? [{ id: 'dormant',   label: '🗓 Dormant'   }] : []),
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
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="form-select"
              value={regionFilter}
              onChange={e => setRegionFilter(e.target.value)}
              style={{ width: 'auto', fontSize: 12 }}
              title="Only routes touching this region"
            >
              <option value="all">Region: All</option>
              {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            {typesInUse.length > 1 && (
              <select
                className="form-select"
                value={acTypeFilter}
                onChange={e => setAcTypeFilter(e.target.value)}
                style={{ width: 'auto', fontSize: 12, maxWidth: 170 }}
                title="Only routes flown by this aircraft type"
              >
                <option value="all">Aircraft: All</option>
                {typesInUse.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            <select
              className="form-select"
              value={haulFilter}
              onChange={e => setHaulFilter(e.target.value)}
              style={{ width: 'auto', fontSize: 12 }}
              title="Filter by route length"
            >
              <option value="all">Haul: All</option>
              <option value="short">Short (&lt;1,500 km)</option>
              <option value="medium">Medium (1,500–4,500)</option>
              <option value="long">Long (&gt;4,500 km)</option>
            </select>
            {viewMode === 'cards' && (
              <select
                className="form-select"
                value={sortBy}
                onChange={e => setSortBy(e.target.value)}
                style={{ width: 'auto', fontSize: 12 }}
              >
                <option value="profit">Sort: Profit ↓</option>
                <option value="revenue">Sort: Revenue ↓</option>
                <option value="load">Sort: Load ↓</option>
                <option value="distance">Sort: Distance ↓</option>
              </select>
            )}
          </div>
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

      {/* Bulk-edit selection bar — appears when one or more cards are ticked */}
      {selectedGroups.length > 0 && (
        <SelectionActionBar
          groups={selectedGroups}
          onApplyToGroups={(g, pct) => { applyPctToGroups(g, pct); clearSelection(); }}
          onSetCatering={bulkSetCatering}
          onCloseGroups={bulkCloseGroups}
          onClear={clearSelection}
        />
      )}

      {/* Select-all helper — only in cards view when there are visible routes */}
      {viewMode === 'cards' && visibleGroups.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12, color: 'var(--text-muted)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={visibleGroups.every(g => selectedKeys.has(g.key))}
              ref={el => { if (el) el.indeterminate = !visibleGroups.every(g => selectedKeys.has(g.key)) && visibleGroups.some(g => selectedKeys.has(g.key)); }}
              onChange={e => {
                setSelectedKeys(prev => {
                  const next = new Set(prev);
                  if (e.target.checked) visibleGroups.forEach(g => next.add(g.key));
                  else visibleGroups.forEach(g => next.delete(g.key));
                  return next;
                });
              }}
            />
            Select all {visibleGroups.length} shown
          </label>
        </div>
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
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setSearch(''); setFilterTab('all'); setRegionFilter('all'); setAcTypeFilter('all'); setHaulFilter('all'); }}>
              Clear filters
            </button>
          </div>
        </div>
      ) : viewMode === 'table' ? (
        <RouteTable
          groups={afterFilter}
          getResult={engineResultFor}
          selectedKeys={selectedKeys}
          onToggleSelect={toggleSelect}
          onSelectMany={(keys, checked) => setSelectedKeys(prev => {
            const next = new Set(prev);
            keys.forEach(k => checked ? next.add(k) : next.delete(k));
            return next;
          })}
          onClose={handleClose}
          onPriceChange={handlePriceChange}
          onAddFlights={(g) => addFlightsTo(g.origin, g.destination)}
          onViewDetail={(g) => setDetailPair({ origin: g.origin, destination: g.destination })}
        />
      ) : (
        visibleGroups.map(group => (
          <RouteGroupCard
            key={group.key}
            group={group}
            getResult={engineResultFor}
            selected={selectedKeys.has(group.key)}
            onToggleSelect={() => toggleSelect(group.key)}
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

      {/* Filter-based bulk pricing modal */}
      {showBulkModal && (
        <BulkPricingModal
          allGroups={groupsWithStats}
          onApplyToGroups={applyPctToGroups}
          onClose={() => setShowBulkModal(false)}
        />
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
  const sim      = aircraft ? simulateTagRoute(route, aircraft, gd, state.labor ?? null, 1.0,
    fleetAvgUtilization(state.fleet ?? [], [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]),
    state.satisfaction ?? null, buildEventDemandModel(state.activeEvents).multFor) : null;
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

// ─── Network health strip ─────────────────────────────────────────────────────
//
// At-a-glance totals plus clickable "problem" chips. Clicking a chip applies the
// matching status filter (click again to clear), so with hundreds of routes the
// player can jump straight to what needs attention.
function NetworkHealthStrip({ groups, activeTab, onSelectTab }) {
  const totalRev    = groups.reduce((s, g) => s + g.totalRevenue, 0);
  const totalProfit = groups.reduce((s, g) => s + g.totalProfit,  0);
  const losing    = groups.filter(g => g.totalProfit < 0);
  const losingSum = losing.reduce((s, g) => s + g.totalProfit, 0);
  const lowload   = groups.filter(g => g.avgLoad < 0.5).length;
  const disrupted = groups.filter(g => g.hasDisrupted).length;
  const dormant   = groups.filter(g => g.hasDormant).length;

  const chips = [
    { tab: 'unprofitable', count: losing.length, color: 'var(--red)',
      label: `▼ ${losing.length} losing (${formatMoney(losingSum)}/wk)` },
    { tab: 'lowload',   count: lowload,   color: 'var(--yellow)',     label: `⚠ ${lowload} low load` },
    { tab: 'disrupted', count: disrupted, color: 'var(--red)',        label: `🔧 ${disrupted} disrupted` },
    { tab: 'dormant',   count: dormant,   color: 'var(--text-muted)', label: `🗓 ${dormant} dormant` },
  ].filter(c => c.count > 0);

  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      padding: '8px 12px', marginBottom: 12, fontSize: 12,
      background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    }}>
      <span style={{ fontWeight: 700, color: totalProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
        {totalProfit >= 0 ? '+' : ''}{formatMoney(totalProfit)}/wk
      </span>
      {totalRev > 0 && (
        <span style={{ color: 'var(--text-muted)' }}>margin {Math.round((totalProfit / totalRev) * 100)}%</span>
      )}
      {chips.length > 0 && <span style={{ color: 'var(--border)' }}>|</span>}
      {chips.map(c => {
        const active = activeTab === c.tab;
        return (
          <button
            key={c.tab}
            onClick={() => onSelectTab(c.tab)}
            style={{
              fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 12, cursor: 'pointer',
              background: active ? `color-mix(in srgb, ${c.color} 18%, transparent)` : 'transparent',
              color: c.color, border: `1px solid ${active ? c.color : 'var(--border)'}`,
            }}
            title={active ? 'Click to clear this filter' : 'Click to show only these routes'}
          >
            <GlyphLabel text={c.label} size={11} />
          </button>
        );
      })}
      {chips.length === 0 && (
        <span style={{ color: 'var(--green)' }}><Glyph e="✓" /> No problem routes</span>
      )}
    </div>
  );
}

// ─── Route table (default view) ───────────────────────────────────────────────
//
// Dense, sortable, selectable table built to handle hundreds of city pairs:
// click a column header to sort, tick rows for bulk pricing, click a row to
// expand its per-aircraft detail inline (pricing, catering, actions).
const TABLE_PAGE_SIZE = 100;

const TABLE_COLUMNS = [
  { id: 'route',  label: 'Route',        align: 'left'  },
  { id: 'dist',   label: 'Dist',         align: 'right' },
  { id: 'freq',   label: 'Freq',         align: 'right' },
  { id: 'load',   label: 'Load',         align: 'right' },
  { id: 'pax',    label: 'Pax/wk',       align: 'right' },
  { id: 'rev',    label: 'Revenue/wk',   align: 'right' },
  { id: 'profit', label: 'Profit/wk',    align: 'right' },
  { id: 'margin', label: 'Margin',       align: 'right' },
];

const TABLE_SORTERS = {
  route:  (a, b) => `${a.origin}${a.destination}`.localeCompare(`${b.origin}${b.destination}`),
  dist:   (a, b) => a.distance     - b.distance,
  freq:   (a, b) => a.totalFreq    - b.totalFreq,
  load:   (a, b) => a.avgLoad      - b.avgLoad,
  pax:    (a, b) => a.totalPax     - b.totalPax,
  rev:    (a, b) => a.totalRevenue - b.totalRevenue,
  profit: (a, b) => a.totalProfit  - b.totalProfit,
  margin: (a, b) => a.margin       - b.margin,
};

function RouteTable({ groups, getResult, selectedKeys, onToggleSelect, onSelectMany, onClose, onPriceChange, onAddFlights, onViewDetail }) {
  const { state: gameState } = useGame();
  const [sortCol, setSortCol] = useState('profit');
  const [sortDir, setSortDir] = useState('desc');   // 'asc' | 'desc'
  const [shown,   setShown]   = useState(TABLE_PAGE_SIZE);
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());

  const sorted = useMemo(() => {
    const cmp = TABLE_SORTERS[sortCol] ?? TABLE_SORTERS.profit;
    const s = [...groups].sort(cmp);
    if (sortDir === 'desc') s.reverse();
    return s;
  }, [groups, sortCol, sortDir]);

  const visible = sorted.slice(0, shown);
  const allSelected  = groups.length > 0 && groups.every(g => selectedKeys.has(g.key));
  const someSelected = groups.some(g => selectedKeys.has(g.key));

  const totalRev    = groups.reduce((s, g) => s + g.totalRevenue, 0);
  const totalProfit = groups.reduce((s, g) => s + g.totalProfit,  0);
  const totalPax    = groups.reduce((s, g) => s + (g.totalPax ?? 0), 0);

  function clickHeader(colId) {
    if (sortCol === colId) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortCol(colId);
      setSortDir(colId === 'route' ? 'asc' : 'desc');
    }
  }

  function toggleExpand(key) {
    setExpandedKeys(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const COL_HEADER = {
    padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600,
    fontSize: 11, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em',
    borderBottom: '1px solid var(--border)', cursor: 'pointer', userSelect: 'none',
  };

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Totals row */}
      <div style={{
        display: 'flex', gap: 24, padding: '10px 14px',
        background: 'var(--surface2)', borderBottom: '1px solid var(--border)',
        fontSize: 12, flexWrap: 'wrap',
      }}>
        <span style={{ color: 'var(--text-muted)' }}>{groups.length} city pairs</span>
        {(() => {
          // World-event demand banner: these figures already include the shock,
          // so tell the player WHY demand looks soft (or hot) this week.
          const evMult = buildEventDemandModel(gameState.activeEvents).globalMult;
          if (Math.abs(evMult - 1) < 0.005) return null;
          const pct = Math.round(Math.abs(evMult - 1) * 100);
          return (
            <span style={{ color: evMult < 1 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
              {evMult < 1 ? `▼ Events cutting demand ~${pct}%` : `▲ Events boosting demand ~${pct}%`}
            </span>
          );
        })()}
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
              <th style={{ ...COL_HEADER, cursor: 'default', width: 30 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
                  onChange={e => onSelectMany(groups.map(g => g.key), e.target.checked)}
                  title={allSelected ? 'Deselect all' : `Select all ${groups.length} filtered routes`}
                  style={{ cursor: 'pointer' }}
                />
              </th>
              {TABLE_COLUMNS.map(c => (
                <th
                  key={c.id}
                  style={{ ...COL_HEADER, textAlign: c.align }}
                  onClick={() => clickHeader(c.id)}
                  title="Click to sort"
                >
                  {c.label}
                  {sortCol === c.id && (
                    <span style={{ marginLeft: 4, color: 'var(--accent)' }}>{sortDir === 'desc' ? '▾' : '▴'}</span>
                  )}
                </th>
              ))}
              <th style={{ ...COL_HEADER, cursor: 'default', width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((g, i) => (
              <RouteTableRow
                key={g.key}
                group={g}
                zebra={i % 2 === 1}
                selected={selectedKeys.has(g.key)}
                expanded={expandedKeys.has(g.key)}
                onToggleSelect={() => onToggleSelect(g.key)}
                onToggleExpand={() => toggleExpand(g.key)}
                getResult={getResult}
                onClose={onClose}
                onPriceChange={onPriceChange}
                onAddFlights={() => onAddFlights(g)}
                onViewDetail={() => onViewDetail(g)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Incremental paging keeps the DOM small with very large networks */}
      {sorted.length > shown && (
        <div style={{ padding: '10px 14px', textAlign: 'center', borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setShown(s => s + TABLE_PAGE_SIZE)}>
            Show {Math.min(TABLE_PAGE_SIZE, sorted.length - shown)} more ({shown} of {sorted.length})
          </button>
        </div>
      )}
    </div>
  );
}

function RouteTableRow({ group: g, zebra, selected, expanded, onToggleSelect, onToggleExpand, getResult, onClose, onPriceChange, onAddFlights, onViewDetail }) {
  const oa = getAirport(g.origin);
  const da = getAirport(g.destination);

  const profColor = g.totalProfit >= 0 ? 'var(--green)' : 'var(--red)';
  const loadColor = g.avgLoad > 0.7 ? 'var(--green)' : g.avgLoad > 0.4 ? 'var(--yellow)' : 'var(--red)';
  const margColor = g.margin > 0.15 ? 'var(--green)' : g.margin > 0 ? 'var(--yellow)' : 'var(--red)';

  const CELL = { padding: '7px 10px' };
  const RIGHT = { ...CELL, textAlign: 'right' };

  return (
    <>
      <tr
        style={{
          borderBottom: expanded ? 'none' : '1px solid var(--border-subtle)',
          background: selected ? 'rgba(56,139,253,0.07)' : expanded ? 'var(--surface2)' : zebra ? 'var(--surface2)' : undefined,
          cursor: 'pointer',
        }}
        onClick={onToggleExpand}
      >
        <td style={{ ...CELL, width: 30 }} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            title="Select for bulk actions"
            style={{ cursor: 'pointer' }}
          />
        </td>
        <td style={{ ...CELL, whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: 13, color: 'var(--accent)' }}>
            {g.origin} → {g.destination}
          </span>
          <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11 }}>
            {oa?.city} → {da?.city}
          </span>
          {g.hasDisrupted && (
            <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: 'rgba(248,81,73,0.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.3)', textTransform: 'uppercase' }}>
              <Glyph e="🔧" /> Disrupted
            </span>
          )}
          {g.hasDormant && (
            <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: 'rgba(139,148,158,0.15)', color: 'var(--text-muted)', border: '1px solid rgba(139,148,158,0.3)', textTransform: 'uppercase' }}>
              <Glyph e="🗓" /> Dormant
            </span>
          )}
        </td>
        <td style={{ ...RIGHT, color: 'var(--text-muted)' }}>
          {g.distance ? `${g.distance.toLocaleString()} km` : '—'}
        </td>
        <td style={RIGHT}>
          {g.totalFreq}×
          {g.routes.length > 1 && (
            <span style={{ color: 'var(--text-dim)', marginLeft: 3, fontSize: 10 }}>({g.routes.length} ac)</span>
          )}
        </td>
        <td style={{ ...RIGHT, fontWeight: 700, color: loadColor }}>{formatPercent(g.avgLoad)}</td>
        <td style={{ ...RIGHT, color: 'var(--text-muted)' }}>{(g.totalPax ?? 0).toLocaleString()}</td>
        <td style={{ ...RIGHT, fontWeight: 600, color: 'var(--green)' }}>+{formatMoney(g.totalRevenue)}</td>
        <td style={{ ...RIGHT, fontWeight: 700, color: profColor }}>
          {g.totalProfit >= 0 ? '+' : ''}{formatMoney(g.totalProfit)}
        </td>
        <td style={{ ...RIGHT, fontWeight: 700, color: margColor }}>{Math.round(g.margin * 100)}%</td>
        <td style={{ ...CELL, textAlign: 'center', color: 'var(--text-dim)', fontSize: 10 }}>
          {expanded ? '▴' : '▾'}
        </td>
      </tr>
      {expanded && (
        <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <td colSpan={TABLE_COLUMNS.length + 2} style={{ padding: '0 14px 12px' }}>
            <ExpandedGroupPanel
              group={g}
              getResult={getResult}
              onClose={onClose}
              onPriceChange={onPriceChange}
              onAddFlights={onAddFlights}
              onViewDetail={onViewDetail}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// Inline detail shown when a table row is expanded: the same per-aircraft table
// the card view uses, plus catering and the card's footer actions.
function ExpandedGroupPanel({ group, getResult, onClose, onPriceChange, onAddFlights, onViewDetail }) {
  const { state, dispatch } = useGame();
  const { fleet } = state;

  const sims = group.routes.map(route => {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
    const result   = aircraft ? getResult(route, aircraft) : null;
    const bh       = type && result ? weeklyBlockHours(result.distance, route.weeklyFrequency, type) : 0;
    return { route, aircraft, type, result, blockHrs: bh };
  });

  const dist = sims[0]?.result?.distance;
  const catLevels     = [...new Set(group.routes.map(r => normalizeCateringLevel(r.cateringLevel)))];
  const groupCatLevel = catLevels.length === 1 ? catLevels[0] : null;

  return (
    <div>
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
      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 220, flex: '1 1 260px' }}>
          <CateringSelector
            value={groupCatLevel ?? 'full'}
            onChange={(level) => dispatch({ type: 'SET_ROUTE_CATERING', routeIds: group.routes.map(r => r.id), level })}
            distKm={dist}
            compact
            label={groupCatLevel ? 'Catering service' : 'Catering service · mixed across aircraft'}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={onViewDetail}>
            Details →
          </button>
          <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={onAddFlights}>
            + Add Flights
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Route group card ─────────────────────────────────────────────────────────

function RouteGroupCard({ group, getResult, selected, onToggleSelect, onClose, onPriceChange, onAddFlights, onViewDetail }) {
  const { state, dispatch } = useGame();
  const { fleet } = state;
  const { origin, destination, routes } = group;

  const originAirport = getAirport(origin);
  const destAirport   = getAirport(destination);
  const refP          = referencePrice(origin, destination);

  // Pull each aircraft's authoritative result from the engine projection (same
  // source as the Finance tab) so this card never disagrees with it.
  const sims = routes.map(route => {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
    const result   = aircraft ? getResult(route, aircraft) : null;
    const bh       = type && result ? weeklyBlockHours(result.distance, route.weeklyFrequency, type) : 0;
    return { route, aircraft, type, result, blockHrs: bh };
  });

  const dist        = sims[0]?.result?.distance;
  const totalFreq   = routes.reduce((s, r) => s + r.weeklyFrequency, 0);
  const totalRev    = sims.reduce((s, { result }) => s + (result?.revenue    ?? 0), 0);
  // Direct cost = operating cost + landing fee, matching Finance "By Route".
  const totalOp     = sims.reduce((s, { result }) => s + (result?.totalOpCost ?? 0) + (result?.landingFee ?? 0), 0);
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
    <div className="card" style={{ marginBottom: 12, borderLeft: selected ? '3px solid var(--accent)' : undefined }}>
      {/* ── Route header ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelect}
            title="Select this route for bulk pricing"
            style={{ marginTop: 4, cursor: 'pointer', flexShrink: 0 }}
          />
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

// ─── Bulk pricing helpers ─────────────────────────────────────────────────────

// Union of cabins that actually carry seats across a set of route groups, in the
// canonical first→economy order. Used to decide which class controls to show.
function classesPresentIn(groups) {
  const present = new Set();
  for (const g of groups) {
    for (const cls of CLASS_ORDER) {
      if (g.classLoads?.[cls] != null) present.add(cls);
    }
  }
  return CLASS_ORDER.filter(cls => present.has(cls));
}

// Sum of aircraft deployments across a set of groups (for "N aircraft" labels).
function aircraftCountIn(groups) {
  return groups.reduce((s, g) => s + g.routes.length, 0);
}

// A row of per-class percentage inputs. `values` maps class → string; empty/0 means
// "leave this cabin unchanged". onChange(cls, rawString) bubbles edits up.
function PerClassPercentRow({ classes, values, onChange }) {
  if (classes.length === 0) {
    return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No priced cabins in this selection.</div>;
  }
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {classes.map(cls => {
        const v = values[cls] ?? '';
        const n = parseFloat(v);
        const tint = !isNaN(n) && n !== 0 ? (n > 0 ? 'var(--green)' : 'var(--red)') : 'var(--border)';
        return (
          <label key={cls} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
            <span style={{ color: CLASS_COLORS[cls], fontWeight: 600 }}>{CLASS_LABELS[cls]}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <input
                type="number"
                inputMode="numeric"
                step="1"
                placeholder="0"
                value={v}
                onChange={e => onChange(cls, e.target.value)}
                style={{
                  width: 64, padding: '5px 7px', fontSize: 13, textAlign: 'right',
                  background: 'var(--surface)', color: 'var(--text)',
                  border: `1px solid ${tint}`, borderRadius: 6,
                }}
              />
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>%</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

// ─── Filter-based bulk pricing modal ──────────────────────────────────────────
//
// Lets the player target routes by per-class occupancy (load-factor) range, then
// shift fares by a percentage on every matching route at once.
function BulkPricingModal({ allGroups, onApplyToGroups, onClose }) {
  const presentClasses = classesPresentIn(allGroups);

  // Per-class occupancy filter: { enabled, min, max } as percentages (0–100).
  const [filters, setFilters] = useState(() => {
    const f = {};
    for (const cls of presentClasses) f[cls] = { enabled: false, min: 0, max: 60 };
    return f;
  });
  // Per-class percentage adjustments (string inputs).
  const [pct, setPct] = useState({});

  const enabledClasses = presentClasses.filter(cls => filters[cls]?.enabled);

  // A group matches when, for every enabled class filter, the group has seats in
  // that cabin and its occupancy falls within [min, max]. No filters ⇒ match all.
  const matching = allGroups.filter(g => {
    if (enabledClasses.length === 0) return true;
    return enabledClasses.every(cls => {
      const lf = g.classLoads?.[cls];
      if (lf == null) return false;
      const pctLf = lf * 100;
      return pctLf >= filters[cls].min && pctLf <= filters[cls].max;
    });
  });

  const adjustedClasses = Object.entries(pct)
    .filter(([, v]) => { const n = parseFloat(v); return !isNaN(n) && n !== 0; })
    .map(([k]) => k);

  const canApply = matching.length > 0 && adjustedClasses.length > 0;

  const setFilter = (cls, patch) =>
    setFilters(f => ({ ...f, [cls]: { ...f[cls], ...patch } }));

  const label = { fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2500,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="card"
        style={{ width: 560, maxWidth: '100%', maxHeight: '88vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}><Glyph e="⚖️" /> Bulk Pricing by Occupancy</div>
          <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={onClose}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          Target routes by how full each cabin is, then shift those fares by a percentage.
          A typical move: find cabins running under ~50% full and cut fares to fill them, or
          raise fares on cabins running hot.
        </div>

        {/* ── Occupancy criteria ─────────────────────────────────────────── */}
        <div style={{ ...label, marginBottom: 8 }}>1 · Match by cabin occupancy</div>
        {presentClasses.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>No passenger routes to filter.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
            {presentClasses.map(cls => {
              const f = filters[cls];
              return (
                <div key={cls} style={{
                  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                  padding: '8px 10px', borderRadius: 8,
                  background: f.enabled ? 'var(--surface2)' : 'transparent',
                  border: `1px solid ${f.enabled ? CLASS_COLORS[cls] : 'var(--border)'}`,
                  opacity: f.enabled ? 1 : 0.7,
                }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 120, cursor: 'pointer' }}>
                    <input type="checkbox" checked={f.enabled} onChange={e => setFilter(cls, { enabled: e.target.checked })} />
                    <span style={{ color: CLASS_COLORS[cls], fontWeight: 700, fontSize: 13 }}>{CLASS_LABELS[cls]}</span>
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: f.enabled ? 1 : 0.5 }}>
                    <span style={{ color: 'var(--text-muted)' }}>load</span>
                    <input type="number" min="0" max="100" value={f.min} disabled={!f.enabled}
                      onChange={e => setFilter(cls, { min: Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)) })}
                      style={{ width: 56, padding: '4px 6px', textAlign: 'right', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
                    <span style={{ color: 'var(--text-muted)' }}>%–</span>
                    <input type="number" min="0" max="100" value={f.max} disabled={!f.enabled}
                      onChange={e => setFilter(cls, { max: Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)) })}
                      style={{ width: 56, padding: '4px 6px', textAlign: 'right', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
                    <span style={{ color: 'var(--text-muted)' }}>%</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Matching count ─────────────────────────────────────────────── */}
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 18, fontSize: 13,
          background: matching.length > 0 ? 'rgba(56,139,253,0.10)' : 'var(--surface2)',
          border: `1px solid ${matching.length > 0 ? 'rgba(56,139,253,0.3)' : 'var(--border)'}`,
        }}>
          {enabledClasses.length === 0
            ? <><b>{matching.length}</b> city pair{matching.length !== 1 ? 's' : ''} ({aircraftCountIn(matching)} aircraft) — all routes, no occupancy filter set.</>
            : <><b>{matching.length}</b> city pair{matching.length !== 1 ? 's' : ''} ({aircraftCountIn(matching)} aircraft) match your occupancy criteria.</>}
        </div>

        {/* ── Adjustment ─────────────────────────────────────────────────── */}
        <div style={{ ...label, marginBottom: 8 }}>2 · Adjust fares by %</div>
        <div style={{ marginBottom: 18 }}>
          <PerClassPercentRow
            classes={presentClasses}
            values={pct}
            onChange={(cls, v) => setPct(p => ({ ...p, [cls]: v }))}
          />
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
            Positive raises fares, negative cuts them. Blank cabins are left unchanged. New fares are capped at the per-cabin ceiling.
          </div>
        </div>

        {/* ── Actions ────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!canApply}
            title={!canApply ? 'Set at least one fare adjustment and match at least one route' : ''}
            onClick={() => { onApplyToGroups(matching, pct); onClose(); }}
          >
            Apply to {matching.length} route{matching.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Selection action bar ─────────────────────────────────────────────────────
//
// Appears when the player has ticked one or more route cards. Offers the same
// per-class % adjustment, applied only to the explicitly selected routes.
function SelectionActionBar({ groups, onApplyToGroups, onSetCatering, onCloseGroups, onClear }) {
  const [pct, setPct] = useState({});
  const [catering, setCatering] = useState('');
  const classes = classesPresentIn(groups);

  const adjustedClasses = Object.entries(pct)
    .filter(([, v]) => { const n = parseFloat(v); return !isNaN(n) && n !== 0; })
    .map(([k]) => k);

  const apply = () => {
    onApplyToGroups(groups, pct);
    setPct({});
  };

  return (
    <div style={{
      position: 'sticky', top: 8, zIndex: 50, marginBottom: 14,
      display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap',
      padding: '12px 16px', borderRadius: 10,
      background: 'var(--surface2)', border: '1px solid var(--accent)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>
        {groups.length} selected
        <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>{aircraftCountIn(groups)} aircraft</div>
      </div>
      <PerClassPercentRow
        classes={classes}
        values={pct}
        onChange={(cls, v) => setPct(p => ({ ...p, [cls]: v }))}
      />
      <button
        className="btn btn-primary"
        style={{ fontSize: 13 }}
        disabled={adjustedClasses.length === 0}
        onClick={apply}
      >
        Apply %
      </button>

      {/* Bulk catering */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Catering</span>
        <span style={{ display: 'flex', gap: 4 }}>
          <select
            className="form-select"
            value={catering}
            onChange={e => setCatering(e.target.value)}
            style={{ width: 'auto', fontSize: 12, padding: '4px 6px' }}
          >
            <option value="">— unchanged —</option>
            {CATERING_LEVEL_ORDER.map(id => (
              <option key={id} value={id}>{CATERING_LEVELS[id].name}</option>
            ))}
          </select>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12 }}
            disabled={!catering}
            onClick={() => { onSetCatering(groups, catering); setCatering(''); }}
          >
            Set
          </button>
        </span>
      </label>

      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
        <button
          className="btn"
          style={{ fontSize: 13, background: 'rgba(248,81,73,0.1)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.3)' }}
          onClick={() => onCloseGroups(groups)}
          title="Close every selected route and free their aircraft"
        >
          Close routes
        </button>
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={onClear}>Clear</button>
      </div>
    </div>
  );
}

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

// Inline weekly-frequency stepper — nudge one aircraft's weekly frequency up or
// down in place, without closing and re-opening the route. Reductions free
// capacity and are always allowed (down to 1 — below that, use Remove to close
// the route). Increases run through frequencyChangeBlockReason (the exact guard
// the engine enforces: per-month peak block-hours, gate slots, regulatory caps),
// so when blocked the + explains why on hover / via a toast and nothing is
// silently rejected.
function FrequencyStepper({ route }) {
  const { state, dispatch } = useGame();
  const addToast = useToast();
  const freq = route.weeklyFrequency ?? 1;
  const blockUp = frequencyChangeBlockReason(state, route.id, freq + 1); // null => allowed
  const canDown = freq > 1;

  const setFreq = (next) =>
    dispatch({ type: 'UPDATE_FREQUENCY', routeId: route.id, weeklyFrequency: next });

  const stepDown = () => { if (canDown) setFreq(freq - 1); };
  const stepUp = () => {
    if (blockUp) { addToast({ type: 'warning', title: 'Can’t add a flight', message: blockUp }); return; }
    setFreq(freq + 1);
  };

  const btnStyle = (enabled) => ({
    width: 22, height: 22, padding: 0, display: 'inline-flex', alignItems: 'center',
    justifyContent: 'center', borderRadius: 'var(--radius)', fontSize: 15, fontWeight: 700,
    lineHeight: 1, cursor: enabled ? 'pointer' : 'not-allowed',
    border: '1px solid ' + (enabled ? 'var(--border)' : 'var(--border-subtle)'),
    background: enabled ? 'var(--surface3)' : 'var(--surface2)',
    color: enabled ? 'var(--text)' : 'var(--text-dim)',
  });

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <button
        type="button"
        style={btnStyle(canDown)}
        onClick={stepDown}
        disabled={!canDown}
        title={canDown ? 'One fewer flight per week' : 'At the minimum — use Remove to close this route'}
      >−</button>
      <span style={{ minWidth: 26, textAlign: 'center', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {freq}×
      </span>
      <button
        type="button"
        style={btnStyle(!blockUp)}
        onClick={stepUp}
        title={blockUp ? blockUp : 'One more flight per week'}
      >+</button>
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
        <td style={{ padding: '7px 8px' }}><FrequencyStepper route={route} /></td>
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
          {result ? `−${formatMoney(result.totalOpCost + (result.landingFee ?? 0))}` : '—'}
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
  const { fleet, routes, hub, gates = {}, cargoRoutes = [] } = state;

  const isAddingFlights = initialOrigin != null && initialDest != null;

  // Helper: total block hours already assigned to an aircraft
  const usedBlockHrsFor = (a) => {
    const t = getAircraftType(a?.typeId);
    if (!a || !t) return 0;
    return routes.filter(r => r.aircraftId === a.id)
      .reduce((s, r) => s + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, t), 0);
  };

  // Freighters can't fly passenger routes (the reducer rejects them) — keep them
  // out of this form entirely; they're managed in the cargo planner.
  const paxFleet = fleet.filter(a => !getAircraftType(a.typeId)?.freighter);
  const hasHours = (a) => usedBlockHrsFor(a) < MAX_WEEKLY_BLOCK_HOURS;

  // Default aircraft. In add-flights mode, prefer one already flying this pair
  // (merges frequency, no launch cost), then one whose network touches an endpoint
  // (passes the connectivity rule), then any idle passenger aircraft.
  const pairAircraftIds = isAddingFlights
    ? new Set(routes.filter(r =>
        (r.origin === initialOrigin && r.destination === initialDest) ||
        (r.origin === initialDest && r.destination === initialOrigin)
      ).map(r => r.aircraftId))
    : new Set();
  const connectsToPair = (a) => {
    const acRoutes = routes.filter(r => r.aircraftId === a.id);
    return acRoutes.length === 0 ||
      acRoutes.some(r => [r.origin, r.destination].some(c => c === initialOrigin || c === initialDest));
  };
  const defaultAircraft = isAddingFlights
    ? (paxFleet.find(a => pairAircraftIds.has(a.id) && hasHours(a))
        ?? paxFleet.find(a => hasHours(a) && connectsToPair(a)))
    : paxFleet.find(hasHours);

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
        ticketPrice: Number(ticketPrice) || referencePrice(origin, dest) }, aircraft, gd,
        null, 1.0, null, [], null, null,
        buildEventDemandModel(state.activeEvents).multFor(origin, dest))
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
      .reduce((s, r) => s + r.weeklyFrequency, 0)))
    + cargoSlotsUsedAt(code, cargoRoutes);
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

  // Regulatory restrictions (perimeter rules, per-pair frequency caps) — mirror
  // the reducer's check so a submit is never silently rejected.
  const pairKey = validDest ? [origin, dest].sort().join('-') : null;
  const restriction = (validDest && type) ? (() => {
    const pairRoutes = routes.filter(r => [r.origin, r.destination].sort().join('-') === pairKey);
    const peakPairFreq = Math.max(0, ...newMonths.map(m =>
      pairRoutes.filter(r => isRouteActive(r, m)).reduce((s, r) => s + r.weeklyFrequency, 0)));
    return checkRouteRestrictions(origin, dest, dist, peakPairFreq + Number(frequency), type.category,
      { routes, excludeKey: pairKey });
  })() : null;

  // Launch cost applies only when this opens a NEW route; adding frequency to a
  // route the same aircraft already flies (same season window) merges for free.
  const sameSeasonAs = (r) => {
    const a = routeActiveMonths(r);
    return a.length === newMonths.length && a.every((m, i) => m === newMonths[i]);
  };
  const mergesExisting = validDest && aircraft && routes.some(r =>
    r.aircraftId === aircraft.id && sameSeasonAs(r) &&
    ((r.origin === origin && r.destination === dest) || (r.origin === dest && r.destination === origin)));
  const launchCost = (validDest && dist && !mergesExisting) ? routeLaunchCost(dist) : 0;
  const canAfford  = state.cash >= launchCost;

  const canSubmit = validDest && aircraft && inRange && blockOk &&
    gateAtOrigin && gateAtDest && originSlotsOk && destSlotsOk && connectivityOk &&
    !restriction && canAfford;

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
              {aircraftId === '' && <option value="">— Select aircraft —</option>}
              {paxFleet.map(a => {
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

        {/* Regulatory restriction warning */}
        {restriction && (
          <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>
            <Glyph e="⛔" /> {restriction.reason.split(': ')[1] ?? restriction.reason}
          </div>
        )}

        {/* Launch cost (new routes only — merging into an existing route is free) */}
        {validDest && launchCost > 0 && (
          <div style={{ fontSize: 12, color: canAfford ? 'var(--text-muted)' : 'var(--red)', marginBottom: 10 }}>
            <Glyph e={canAfford ? '💸' : '⚠'} /> One-time launch cost: {formatMoney(launchCost)}
            {!canAfford && ' — insufficient cash'}
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
            {[
              { code: origin, hasGate: gateAtOrigin, slotsOk: originSlotsOk, used: originSlotsUsed, cap: originSlotCap },
              { code: dest,   hasGate: gateAtDest,   slotsOk: destSlotsOk,   used: destSlotsUsed,   cap: destSlotCap },
            ].map(({ code, hasGate, slotsOk, used, cap }) => (
              !hasGate ? (
                <span key={code} style={{ color: 'var(--red)', display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Glyph e="⚠" /> No gate at {code}
                  <AddGateButton code={code} />
                </span>
              ) : !slotsOk ? (
                <span key={code} style={{ color: 'var(--yellow)', display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Glyph e="⚠" /> Not enough slots at {code} ({used}/{cap})
                  <AddGateButton code={code} />
                </span>
              ) : (
                <span key={code} style={{ color: 'var(--green)' }}><Glyph e="✓" /> {code}: {used + Number(frequency)}/{cap} slots</span>
              )
            ))}
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
