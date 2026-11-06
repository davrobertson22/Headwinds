import { useState, useMemo } from 'react';
import { useGame, cargoFrequencyChangeBlockReason } from '../store/GameContext.jsx';
import { useConfirm } from './ConfirmModal.jsx';
import AirportLink from './AirportLink.jsx';
import { getAircraftType } from '../data/aircraft.js';
import { getAirport } from '../data/airports.js';
import { groundedTitle } from '../data/maintenance.js';
import { simulateCargoRoute, simulateCargoNetwork, formatMoney, formatPercent, currentGameDate } from '../utils/simulation.js';
import { connectingFreightTitle } from '../utils/connectingFreight.js';
import { cargoPriceChokeFactor, CARGO_PRICE_CAP_MULTIPLE } from '../models/demand.js';
import { Glyph, GlyphLabel } from './Icons.jsx';
import OutOfRangeBadge from './OutOfRangeBadge.jsx';
import { useToast } from './ToastSystem.jsx';
import NumberStepper from './NumberStepper.jsx';
import RouteFrequencyControls from './FrequencyControls.jsx';
import { cargoReferenceYield } from '../utils/market.js';
import { planCargoYields, cargoYieldBatches, CARGO_BULK_PCT_MIN, CARGO_BULK_PCT_MAX } from '../../packages/engine/src/models/cargoYieldBulk.js';

const ACCENT = '#e8833a';
const CARGO_PAGE_SIZE = 60;

// ─── Freight badge (exported for reuse on passenger cards too) ──────────────────

export function FreightBadge() {
  return (
    <span style={{ background: `${ACCENT}22`, color: ACCENT, border: `1px solid ${ACCENT}55`, borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      <Glyph e="📦" /> Freight
    </span>
  );
}

export function PassengerBadge() {
  return (
    <span style={{ background: 'rgba(56,139,253,0.15)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,0.4)', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      <Glyph e="🧍" /> Passenger
    </span>
  );
}

// ─── Lane grouping ─────────────────────────────────────────────────────────────

/**
 * Group freight rows by city pair, direction-agnostic — the same rule the
 * passenger page uses (groupRoutes in Routes.jsx). NRT→SZX and SZX→NRT are one
 * service; the lane displays in the direction of its first route.
 *
 * Each group carries an aggregate `route` / `sim` in the SAME shape as a single
 * row, so the table's sorters work on lanes and freighters alike. The numbers
 * are plain sums of each freighter's own sim, and each sim already carries its
 * pooled slice (cargoLaneAllocations), so the lane total is what the tick books.
 *
 * Exported for tests.
 */
export function groupCargoRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const [a, b] = [r.route.origin, r.route.destination].sort();
    const key = `${a}-${b}`;
    if (!map.has(key)) map.set(key, { key, origin: r.route.origin, destination: r.route.destination, rows: [] });
    map.get(key).rows.push(r);
  }
  return [...map.values()].map(g => {
    const sims = g.rows.map(r => r.sim).filter(Boolean);
    const sum  = (f) => sims.reduce((s, x) => s + (x[f] ?? 0), 0);
    const tonnes = sum('tonnes');
    const cap    = sum('capacityTonnes');
    const freq   = g.rows.reduce((s, r) => s + (r.route.weeklyFrequency ?? 0), 0);
    // Capacity-weighted yield: what a tonne on this lane actually pays on average.
    const capW   = g.rows.reduce((s, r) => s + (r.sim?.capacityTonnes ?? 0), 0);
    const yieldAvg = capW > 0
      ? g.rows.reduce((s, r) => s + r.route.yieldPrice * (r.sim?.capacityTonnes ?? 0), 0) / capW
      : g.rows.reduce((s, r) => s + r.route.yieldPrice, 0) / g.rows.length;
    const yields = g.rows.map(r => r.route.yieldPrice);
    // Connecting freight across the lane's freighters, markets merged.
    const connectingTonnes = sum('connectingTonnes');
    const feedMap = new Map();
    for (const x of sims) for (const f of x.feeds ?? []) {
      const k = `${f.od}|${f.via}`;
      const e = feedMap.get(k) ?? { od: f.od, via: f.via, tonnes: 0, revenue: 0 };
      e.tonnes += f.tonnes; e.revenue += f.revenue;
      feedMap.set(k, e);
    }
    return {
      ...g,
      route: { origin: g.origin, destination: g.destination, weeklyFrequency: freq, yieldPrice: yieldAvg },
      sim: sims.length ? {
        distance:   sims[0].distance,
        tonnes,
        capacityTonnes: cap,
        loadFactor: cap > 0 ? tonnes / cap : 0,
        revenue:    sum('revenue'),
        profit:     sum('profit'),
        ...(connectingTonnes > 0 ? {
          connectingTonnes,
          connectingRevenue: sum('connectingRevenue'),
          localTonnes:       tonnes - connectingTonnes,
          feeds:             [...feedMap.values()].sort((x, y) => y.revenue - x.revenue),
        } : {}),
      } : null,
      yieldMin: Math.min(...yields),
      yieldMax: Math.max(...yields),
      pooled:   g.rows.some(r => r.pooled),
    };
  });
}

const SHARED_LANE_TITLE = 'This lane has one demand pool. Every freighter on it (yours, and any rival’s) carries a share sized by its capacity, so adding a freighter splits the market rather than adding a new one';

// Freight between two of your OTHER airports riding this lane through an
// airport where your freighter routes meet (simulateCargoNetwork).
export function ConnectingFreightChip({ sim, style }) {
  if (!(sim?.connectingTonnes > 0)) return null;
  return (
    <span
      style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: 'rgba(63,185,80,0.12)', color: 'var(--green)', border: '1px solid rgba(63,185,80,0.35)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap', ...style }}
      title={connectingFreightTitle(sim)}
    >
      <Glyph e="🔗" /> +{sim.connectingTonnes.toLocaleString()} t connecting
    </span>
  );
}

function SharedLaneBadge({ count, style }) {
  return (
    <span
      style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: `${ACCENT}18`, color: ACCENT, border: `1px solid ${ACCENT}44`, textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap', ...style }}
      title={SHARED_LANE_TITLE}
    >
      <Glyph e="⚖" /> Shared lane{count > 1 ? ` · ${count} freighters` : ''}
    </span>
  );
}

function yieldLabel(g) {
  return g.yieldMax - g.yieldMin < 0.0005
    ? `$${g.yieldMin.toFixed(3)}`
    : `$${g.yieldMin.toFixed(3)}–${g.yieldMax.toFixed(3)}`;
}

// ─── Cargo routes list ──────────────────────────────────────────────────────────

/**
 * Freight routes, grouped by city pair like the passenger page, as either a
 * compact sortable table (default on desktop) or the roomier cards (default on
 * phones). A lane flown by one freighter looks exactly as it always has; a lane
 * flown by several is one row that expands to lane-wide controls and the
 * individual freighters.
 *
 * @param {string}   airportFilter  'all' | airport code — only routes touching this airport
 * @param {boolean}  hideViewToggle suppress the Table/Cards switch (when the parent owns it)
 * @param {function} [onAddFreighter] (origin, destination) — the parent opens its
 *                   freight planner on that lane. Without it the "+ Add Freighter"
 *                   control is not rendered, so an embedder that has no planner to
 *                   open never shows a button that does nothing.
 */
export default function CargoRoutesList({ airportFilter = 'all', hideViewToggle = false, onAddFreighter }) {
  const { state, dispatch } = useGame();
  const confirm = useConfirm();
  const addToast = useToast();
  const { cargoRoutes = [], fleet } = state;
  const gd = currentGameDate(state);

  // View mode mirrors the passenger table: phones get the touch-friendly cards,
  // desktop gets the compact sortable table.
  const [viewMode, setViewMode] = useState(() => {
    try { return window.matchMedia('(max-width: 640px)').matches ? 'cards' : 'table'; }
    catch { return 'table'; }
  });
  // Mass pricing: lanes ticked for the selection bar (keyed like the groups),
  // and the load-factor modal behind the summary bar's Bulk Pricing button.
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [showBulk, setShowBulk] = useState(false);

  const allRows = useMemo(() => {
    // Same-lane pooling: mirror the weekly tick so the list shows each route's
    // SHARE of a shared lane, not N copies of the full market.
    // The whole network in one pass (the tick's own simulateCargoNetwork), so
    // freight connecting through your airports shows on the legs that carry it.
    const net   = simulateCargoNetwork(cargoRoutes, fleet, { gameDate: gd, competitors: state.competitors });
    const alloc = net.allocations;
    return cargoRoutes.map(route => {
      const aircraft = fleet.find(a => a.id === route.aircraftId);
      const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
      // A tail in a check flies nothing this week; the row still shows what the
      // route earns when it is back, as before.
      const sim      = net.results.get(route.id)
        ?? (aircraft ? simulateCargoRoute(route, aircraft, gd, null, 1.0, 1.0, alloc.get(route.id) ?? null) : null);
      return { route, aircraft, type, sim, pooled: alloc.has(route.id) };
    });
  }, [cargoRoutes, fleet, gd, state.competitors]);

  // Scope to the airport filter, then group into lanes, profit descending.
  const rows = useMemo(() => (
    airportFilter === 'all'
      ? allRows
      : allRows.filter(({ route }) => route.origin === airportFilter || route.destination === airportFilter)
  ), [allRows, airportFilter]);

  const groups = useMemo(() => {
    const g = groupCargoRows(rows);
    for (const x of g) x.rows.sort((a, b) => (b.sim?.profit ?? -Infinity) - (a.sim?.profit ?? -Infinity));
    return g.sort((a, b) => (b.sim?.profit ?? -Infinity) - (a.sim?.profit ?? -Infinity));
  }, [rows]);
  const totalLanes = useMemo(() => groupCargoRows(allRows).length, [allRows]);

  if (cargoRoutes.length === 0) {
    return (
      <div className="empty-state" style={{ marginTop: 8 }}>
        <div className="empty-state-icon"><Glyph e="📦" /></div>
        <div className="empty-state-text">No cargo routes yet.</div>
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>
          Buy a freighter from the Market, then click <strong><Glyph e="📦" /> Open Freight Route</strong> above (or use the Route Planner in Freight mode).
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="empty-state" style={{ marginTop: 8 }}>
        <div className="empty-state-icon"><Glyph e="🔍" /></div>
        <div className="empty-state-text">No cargo routes touch {airportFilter}</div>
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>
          {cargoRoutes.length} freight route{cargoRoutes.length !== 1 ? 's' : ''} elsewhere in the network.
        </div>
      </div>
    );
  }

  // Typed or stepped values from the NumberStepper — already clamped and
  // run through the engine guard, so these just dispatch.
  function setFreq(route, n) {
    dispatch({ type: 'UPDATE_CARGO_FREQUENCY', routeId: route.id, weeklyFrequency: n });
  }
  function setYield(route, y) {
    dispatch({ type: 'UPDATE_CARGO_YIELD', routeId: route.id, yieldPrice: Math.max(0.01, +y.toFixed(3)) });
  }
  // Many freighters at once: one BULK_SET_CARGO_YIELD per server-sized batch
  // (models/cargoYieldBulk.js), never one write per freighter.
  function bulkYield(routeIds, change) {
    for (const ids of cargoYieldBatches(routeIds)) {
      dispatch({ type: 'BULK_SET_CARGO_YIELD', routeIds: ids, mode: change.mode, value: change.value });
    }
  }
  const idsOf = (groups) => groups.flatMap(g => g.rows.map(r => r.route.id));
  // Lane-wide yield: every freighter on the lane moves together. Each one's
  // yield only prices ITS slice of the pool, so a lane priced unevenly is
  // usually an accident, not a strategy.
  function adjLaneYield(group, delta) {
    bulkYield(idsOf([group]), { mode: 'delta', value: delta });
  }
  function alignLaneYield(group) {
    const y = Math.max(0.01, +group.route.yieldPrice.toFixed(3));
    bulkYield(idsOf([group]), { mode: 'set', value: y });
    addToast({ type: 'success', title: 'Lane yield aligned', message: `${group.rows.length} freighters on ${group.origin} ↔ ${group.destination} now at $${y.toFixed(3)}/t-km` });
  }
  // Selection bar and Bulk Pricing modal.
  function applyYieldToGroups(groupsToPrice, change) {
    const plan = planCargoYields(state, idsOf(groupsToPrice), change);
    if (plan.changed === 0) return;
    bulkYield(idsOf(groupsToPrice), change);
    addToast({
      type: 'success',
      title: change.mode === 'reference' ? 'Freight back to the going rate' : 'Freight repriced',
      message: `${plan.changed} freighter${plan.changed !== 1 ? 's' : ''} on ${groupsToPrice.length} lane${groupsToPrice.length !== 1 ? 's' : ''}`
        + (change.mode === 'pct' ? ` · ${change.value > 0 ? '+' : ''}${change.value}%` : ''),
    });
  }
  async function closeGroups(groupsToClose) {
    const n = groupsToClose.reduce((s, g) => s + g.rows.length, 0);
    if (!(await confirm({
      title: `Close ${groupsToClose.length} freight lane${groupsToClose.length !== 1 ? 's' : ''}?`,
      body: `${n} freighter${n !== 1 ? 's' : ''} return${n === 1 ? 's' : ''} to idle.`,
      danger: true, confirmLabel: `Close ${n} route${n !== 1 ? 's' : ''}`,
    }))) return;
    for (const g of groupsToClose) for (const { route } of g.rows) dispatch({ type: 'CLOSE_CARGO_ROUTE', routeId: route.id });
    setSelectedKeys(new Set());
  }
  function toggleSelect(key) {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  function setManySelected(keys, on) {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      for (const k of keys) on ? next.add(k) : next.delete(k);
      return next;
    });
  }
  async function close(route) {
    if (await confirm({ title: `Close cargo route ${route.origin} → ${route.destination}?`, body: 'The freighter returns to idle.', danger: true, confirmLabel: 'Close route' })) {
      dispatch({ type: 'CLOSE_CARGO_ROUTE', routeId: route.id });
    }
  }
  async function closeLane(group) {
    const n = group.rows.length;
    if (await confirm({ title: `Close ${group.origin} ↔ ${group.destination}?`, body: `All ${n} freighters on this lane return to idle.`, danger: true, confirmLabel: `Close ${n} routes` })) {
      for (const { route } of group.rows) dispatch({ type: 'CLOSE_CARGO_ROUTE', routeId: route.id });
    }
  }

  // Ticked lanes that still exist (a closed lane drops out of the selection).
  const selectedGroups = groups.filter(g => selectedKeys.has(g.key));
  const selection = { has: (k) => selectedKeys.has(k), toggle: toggleSelect, setMany: setManySelected };
  const controls = { setFreq, setYield, adjLaneYield, alignLaneYield, close, closeLane, state, onAddFreighter, selection };

  const totalRev    = rows.reduce((s, r) => s + (r.sim?.revenue ?? 0), 0);
  const totalProfit = rows.reduce((s, r) => s + (r.sim?.profit ?? 0), 0);
  const totalTonnes = rows.reduce((s, r) => s + (r.sim?.tonnes ?? 0), 0);
  const totalConnRev = rows.reduce((s, r) => s + (r.sim?.connectingRevenue ?? 0), 0);

  return (
    <div>
      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 14, padding: '10px 14px', background: 'var(--surface2)', borderRadius: 'var(--radius)', border: `1px solid ${ACCENT}33`, alignItems: 'center' }}>
        <div>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Freight lanes</span>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {groups.length}
            {groups.length !== totalLanes && (
              <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 400 }}> of {totalLanes}</span>
            )}
            <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 400 }}> · {rows.length} freighter route{rows.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div><span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Tonnes / wk</span><div style={{ fontWeight: 700, fontSize: 15, color: ACCENT }}>{totalTonnes.toLocaleString()}</div></div>
        <div><span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Freight revenue</span><div style={{ fontWeight: 700, fontSize: 15, color: 'var(--green)' }}>{formatMoney(totalRev)}</div></div>
        {totalConnRev > 0 && (
          <div title="Freight connecting between two of your freighter routes at an airport they share — it fills payload the local freight leaves empty">
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>of which connecting</span>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--green)' }}>{formatMoney(totalConnRev)}</div>
          </div>
        )}
        <div><span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Var. profit / wk</span><div style={{ fontWeight: 700, fontSize: 15, color: totalProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>{(totalProfit >= 0 ? '+' : '') + formatMoney(totalProfit)}</div></div>
        <button
          className="btn btn-ghost"
          style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 10px' }}
          onClick={() => setShowBulk(true)}
          title="Reprice many freight lanes at once, filtered by load factor"
        >
          <GlyphLabel size={12} text="⚖️ Bulk Pricing" />
        </button>
        {!hideViewToggle && (
          <div style={{ display: 'flex', gap: 2, background: 'var(--surface)', borderRadius: 'var(--radius)', padding: 2 }}>
            {[{ id: 'table', label: '⊟ Table' }, { id: 'cards', label: '⊞ Cards' }].map(v => (
              <button
                key={v.id}
                className={`btn ${viewMode === v.id ? 'btn-primary' : 'btn-ghost'}`}
                style={{ fontSize: 12, padding: '4px 10px', ...(viewMode === v.id ? { background: ACCENT, borderColor: ACCENT } : null) }}
                onClick={() => setViewMode(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedGroups.length > 0 && (
        <CargoSelectionBar
          groups={selectedGroups}
          onApplyYield={applyYieldToGroups}
          onCloseGroups={closeGroups}
          onClear={() => setSelectedKeys(new Set())}
        />
      )}

      {viewMode === 'cards' && groups.length > 1 && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            style={{ accentColor: ACCENT }}
            checked={groups.every(g => selectedKeys.has(g.key))}
            onChange={e => setManySelected(groups.map(g => g.key), e.target.checked)}
          />
          Select all {groups.length} lanes
        </label>
      )}

      {viewMode === 'table'
        ? <CargoTable groups={groups} controls={controls} />
        : groups.map(g => g.rows.length === 1
            ? <CargoRouteCard key={g.key} {...g.rows[0]} selectKey={g.key} controls={controls} />
            : <CargoLaneCard key={g.key} group={g} controls={controls} />)}

      {showBulk && (
        <CargoBulkPricingModal
          allGroups={groups}
          onApply={applyYieldToGroups}
          onClose={() => setShowBulk(false)}
        />
      )}
    </div>
  );
}

// ─── Table view ────────────────────────────────────────────────────────────────

const CARGO_COLUMNS = [
  { id: 'route',  label: 'Route',        align: 'left'  },
  { id: 'dist',   label: 'Distance',     align: 'right' },
  { id: 'freq',   label: 'Freq',         align: 'right' },
  { id: 'load',   label: 'Load',         align: 'right' },
  { id: 'tonnes', label: 'Tonnes/wk',    align: 'right' },
  { id: 'yield',  label: 'Yield $/t-km', align: 'right' },
  { id: 'rev',    label: 'Revenue',      align: 'right' },
  { id: 'profit', label: 'Var. profit',  align: 'right' },
];

// Work on single rows AND lane groups — groups carry the same route/sim shape.
const CARGO_SORTERS = {
  route:  (a, b) => `${a.route.origin}${a.route.destination}`.localeCompare(`${b.route.origin}${b.route.destination}`),
  dist:   (a, b) => (a.sim?.distance ?? 0)         - (b.sim?.distance ?? 0),
  freq:   (a, b) => (a.route.weeklyFrequency ?? 0) - (b.route.weeklyFrequency ?? 0),
  load:   (a, b) => (a.sim?.loadFactor ?? 0)       - (b.sim?.loadFactor ?? 0),
  tonnes: (a, b) => (a.sim?.tonnes ?? 0)           - (b.sim?.tonnes ?? 0),
  yield:  (a, b) => (a.route.yieldPrice ?? 0)      - (b.route.yieldPrice ?? 0),
  rev:    (a, b) => (a.sim?.revenue ?? 0)          - (b.sim?.revenue ?? 0),
  profit: (a, b) => (a.sim?.profit ?? 0)           - (b.sim?.profit ?? 0),
};

function CargoTable({ groups, controls }) {
  const [sortCol, setSortCol] = useState('profit');
  const [sortDir, setSortDir] = useState('desc');   // 'asc' | 'desc'
  const [shown,   setShown]   = useState(CARGO_PAGE_SIZE);
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  const sorted = useMemo(() => {
    const cmp = CARGO_SORTERS[sortCol] ?? CARGO_SORTERS.profit;
    const s = [...groups].sort(cmp);
    if (sortDir === 'desc') s.reverse();
    return s;
  }, [groups, sortCol, sortDir]);

  const visible = sorted.slice(0, shown);
  const { selection } = controls;
  const allSelected  = groups.length > 0 && groups.every(g => selection.has(g.key));
  const someSelected = groups.some(g => selection.has(g.key));

  function clickHeader(colId) {
    if (sortCol === colId) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(colId); setSortDir(colId === 'route' ? 'asc' : 'desc'); }
  }

  function toggleExpand(id) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const COL_HEADER = {
    padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600,
    fontSize: 11, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em',
    borderBottom: '1px solid var(--border)', cursor: 'pointer', userSelect: 'none',
  };

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', borderLeft: `3px solid ${ACCENT}` }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ ...COL_HEADER, cursor: 'default', width: 28, paddingRight: 0 }}>
                <input
                  type="checkbox"
                  data-cargo-select-all=""
                  style={{ accentColor: ACCENT, cursor: 'pointer' }}
                  checked={allSelected}
                  ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
                  onChange={e => selection.setMany(groups.map(g => g.key), e.target.checked)}
                  title={allSelected ? 'Deselect all' : `Select all ${groups.length} lanes for bulk pricing`}
                />
              </th>
              {CARGO_COLUMNS.map(c => (
                <th
                  key={c.id}
                  style={{ ...COL_HEADER, textAlign: c.align }}
                  onClick={() => clickHeader(c.id)}
                  title="Click to sort"
                >
                  {c.label}
                  {sortCol === c.id && (
                    <span style={{ marginLeft: 4, color: ACCENT }}>{sortDir === 'desc' ? '▾' : '▴'}</span>
                  )}
                </th>
              ))}
              <th style={{ ...COL_HEADER, cursor: 'default', width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((g, i) => g.rows.length === 1 ? (
              <CargoTableRow
                key={g.key}
                row={g.rows[0]}
                selectKey={g.key}
                zebra={i % 2 === 1}
                expanded={expandedIds.has(g.rows[0].route.id)}
                onToggleExpand={() => toggleExpand(g.rows[0].route.id)}
                controls={controls}
              />
            ) : (
              <CargoLaneRows
                key={g.key}
                group={g}
                zebra={i % 2 === 1}
                expanded={expandedIds.has(g.key)}
                onToggleExpand={() => toggleExpand(g.key)}
                expandedIds={expandedIds}
                toggleExpand={toggleExpand}
                controls={controls}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Incremental paging keeps the DOM small with very large freight networks */}
      {sorted.length > shown && (
        <div style={{ padding: '10px 14px', textAlign: 'center', borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setShown(s => s + CARGO_PAGE_SIZE)}>
            Show {Math.min(CARGO_PAGE_SIZE, sorted.length - shown)} more ({shown} of {sorted.length})
          </button>
        </div>
      )}
    </div>
  );
}

// The tick box that puts a lane into the selection bar. Its own cell stops the
// click, so ticking never expands the row.
function SelectCell({ selectKey, controls, nested = false }) {
  const { selection } = controls;
  return (
    <td style={{ padding: '0 0 0 10px', width: 28 }} onClick={e => e.stopPropagation()}>
      {!nested && selectKey && (
        <input
          type="checkbox"
          data-cargo-select={selectKey}
          style={{ accentColor: ACCENT, cursor: 'pointer' }}
          checked={selection.has(selectKey)}
          onChange={() => selection.toggle(selectKey)}
          title="Select this lane for bulk pricing"
        />
      )}
    </td>
  );
}

// Yield, editable where it is shown ("the feature to edit the prices on a
// route after you've created it is also missing", Dunno23, Discord 2026-11-05:
// it lived behind a row you had to open first). One freighter gets the same
// stepper as its controls; a lane gets the lane-wide −/+.
function YieldCell({ route, group, controls, style }) {
  const stop = e => e.stopPropagation();
  if (group) {
    return (
      <td style={style} onClick={stop} data-cargo-lane-yield="">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" style={{ padding: '0 6px', fontSize: 12 }} title="Lower every freighter on this lane by $0.02" onClick={() => controls.adjLaneYield(group, -0.02)}>−</button>
          <span>{yieldLabel(group)}</span>
          <button className="btn btn-ghost" style={{ padding: '0 6px', fontSize: 12 }} title="Raise every freighter on this lane by $0.02" onClick={() => controls.adjLaneYield(group, +0.02)}>+</button>
        </span>
      </td>
    );
  }
  return (
    <td style={style} onClick={stop} data-cargo-yield-cell="">
      <span style={{ display: 'inline-flex', justifyContent: 'flex-end' }}>
        <NumberStepper
          size="sm"
          value={+route.yieldPrice.toFixed(3)}
          min={0.01}
          step={0.02}
          decimals={3}
          inputWidth={50}
          onChange={y => controls.setYield(route, y)}
          ariaLabel={`yield, ${route.origin} to ${route.destination}`}
          decTitle="Lower by $0.02"
          incTitle="Raise by $0.02"
        />
      </span>
    </td>
  );
}

const lfColorOf = (lf) => lf >= 0.75 ? 'var(--green)' : lf >= 0.45 ? 'var(--yellow)' : 'var(--red)';

/** A lane flown by several freighters: one aggregate row, expanding to the lane
 *  controls and one nested row per freighter (each expandable to its own). */
function CargoLaneRows({ group, zebra, expanded, onToggleExpand, expandedIds, toggleExpand, controls }) {
  const { route, sim, rows } = group;
  const oa = getAirport(route.origin);
  const da = getAirport(route.destination);
  const CELL  = { padding: '7px 10px' };
  const RIGHT = { ...CELL, textAlign: 'right' };
  const grounded = rows.filter(r => r.aircraft?.status === 'grounded').length;

  return (
    <>
      <tr
        style={{
          borderBottom: expanded ? 'none' : '1px solid var(--border-subtle)',
          background: expanded ? 'var(--surface2)' : zebra ? 'var(--surface2)' : undefined,
          cursor: 'pointer',
        }}
        onClick={onToggleExpand}
      >
        <SelectCell selectKey={group.key} controls={controls} />
        <td style={{ ...CELL, whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: 13, color: ACCENT }}>
            {route.origin} → {route.destination}
          </span>
          <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11 }}>
            {oa?.city} → {da?.city}
          </span>
          <SharedLaneBadge count={rows.length} style={{ marginLeft: 6 }} />
          <ConnectingFreightChip sim={sim} style={{ marginLeft: 6 }} />
          {grounded > 0 && (
            <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: 'rgba(248,81,73,0.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.3)', textTransform: 'uppercase' }}>
              <Glyph e="🔧" /> {grounded} grounded
            </span>
          )}
        </td>
        <td style={{ ...RIGHT, color: 'var(--text-muted)' }}>{sim ? `${sim.distance.toLocaleString()} km` : '—'}</td>
        <td style={RIGHT}>{route.weeklyFrequency}×</td>
        <td style={{ ...RIGHT, fontWeight: 700, color: lfColorOf(sim?.loadFactor ?? 0) }}>{sim ? formatPercent(sim.loadFactor) : '—'}</td>
        <td style={{ ...RIGHT, fontWeight: 700, color: ACCENT }}>{sim ? sim.tonnes.toLocaleString() : '—'}</td>
        <YieldCell group={group} controls={controls} style={{ ...RIGHT, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} />
        <td style={{ ...RIGHT, fontWeight: 600, color: 'var(--green)' }}>{sim ? `+${formatMoney(sim.revenue)}` : '—'}</td>
        <td style={{ ...RIGHT, fontWeight: 700, color: (sim?.profit ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
          {sim ? `${sim.profit >= 0 ? '+' : ''}${formatMoney(sim.profit)}` : '—'}
        </td>
        <td style={{ ...CELL, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          {expanded ? '▴' : '▾'}
        </td>
      </tr>
      {expanded && (
        <>
          <tr style={{ background: 'var(--surface2)' }}>
            <td colSpan={CARGO_COLUMNS.length + 2} style={{ padding: '0 14px 10px' }}>
              <CargoLaneControls group={group} controls={controls} />
            </td>
          </tr>
          {rows.map(r => (
            <CargoTableRow
              key={r.route.id}
              row={r}
              nested
              laneOrigin={route.origin}
              expanded={expandedIds.has(r.route.id)}
              onToggleExpand={() => toggleExpand(r.route.id)}
              controls={{ ...controls, onAddFreighter: null }}
            />
          ))}
        </>
      )}
    </>
  );
}

function CargoTableRow({ row, zebra, expanded, onToggleExpand, controls, nested = false, laneOrigin = null, selectKey = null }) {
  const { route, aircraft, type, sim, pooled } = row;
  const oa = getAirport(route.origin);
  const da = getAirport(route.destination);

  const lf = sim?.loadFactor ?? 0;
  const lfColor   = lfColorOf(lf);
  const profColor = (sim?.profit ?? 0) >= 0 ? 'var(--green)' : 'var(--red)';

  const CELL  = { padding: nested ? '5px 10px' : '7px 10px' };
  const RIGHT = { ...CELL, textAlign: 'right' };
  const bg = nested ? 'var(--surface)' : expanded ? 'var(--surface2)' : zebra ? 'var(--surface2)' : undefined;

  return (
    <>
      <tr
        style={{
          borderBottom: expanded ? 'none' : '1px solid var(--border-subtle)',
          background: bg,
          cursor: 'pointer',
        }}
        onClick={onToggleExpand}
      >
        <SelectCell selectKey={selectKey} controls={controls} nested={nested} />
        <td style={{ ...CELL, whiteSpace: 'nowrap', ...(nested ? { paddingLeft: 28 } : null) }}>
          {nested ? (
            <>
              <span style={{ color: 'var(--text-dim)', marginRight: 6 }}>↳</span>
              <span style={{ fontWeight: 600 }}>
                {aircraft ? `${aircraft.name}${aircraft.tailNumber ? ` · ${aircraft.tailNumber}` : ''}` : 'No freighter'}
              </span>
              {type && <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11 }}>{type.payloadTonnes}t</span>}
              {laneOrigin && route.origin !== laneOrigin && (
                <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11, fontFamily: 'monospace' }}>
                  {route.origin} → {route.destination}
                </span>
              )}
            </>
          ) : (
            <>
              <span style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: 13, color: ACCENT }}>
                {route.origin} → {route.destination}
              </span>
              <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11 }}>
                {oa?.city} → {da?.city}
              </span>
            </>
          )}
          {aircraft?.status === 'grounded' && (
            <span
              style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: 'rgba(248,81,73,0.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.3)', textTransform: 'uppercase' }}
              title={groundedTitle(aircraft)}
            >
              <Glyph e="🔧" /> {aircraft.groundedWeeksLeft}w
            </span>
          )}
          <OutOfRangeBadge route={route} style={{ marginLeft: 6 }} />
          {!aircraft && !nested && (
            <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: 'rgba(248,81,73,0.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.3)', textTransform: 'uppercase' }}>
              No freighter
            </span>
          )}
          {pooled && !nested && <SharedLaneBadge style={{ marginLeft: 6 }} />}
          {!nested && <ConnectingFreightChip sim={sim} style={{ marginLeft: 6 }} />}
        </td>
        <td style={{ ...RIGHT, color: 'var(--text-muted)' }}>{nested ? '' : sim ? `${sim.distance.toLocaleString()} km` : '—'}</td>
        <td style={RIGHT}>{route.weeklyFrequency}×</td>
        <td style={{ ...RIGHT, fontWeight: 700, color: lfColor }}>{sim ? formatPercent(lf) : '—'}</td>
        <td style={{ ...RIGHT, fontWeight: 700, color: ACCENT }}>{sim ? sim.tonnes.toLocaleString() : '—'}</td>
        <YieldCell route={route} controls={controls} style={{ ...RIGHT, color: 'var(--text-muted)' }} />
        <td style={{ ...RIGHT, fontWeight: 600, color: 'var(--green)' }}>{sim ? `+${formatMoney(sim.revenue)}` : '—'}</td>
        <td style={{ ...RIGHT, fontWeight: 700, color: profColor }}>
          {sim ? `${sim.profit >= 0 ? '+' : ''}${formatMoney(sim.profit)}` : '—'}
        </td>
        <td style={{ ...CELL, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          {expanded ? '▴' : '▾'}
        </td>
      </tr>
      {expanded && (
        <tr style={{ borderBottom: '1px solid var(--border)', background: nested ? 'var(--surface)' : 'var(--surface2)' }}>
          <td colSpan={CARGO_COLUMNS.length + 2} style={{ padding: nested ? '0 14px 10px 28px' : '0 14px 12px' }}>
            {!nested && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0 10px' }}>
                {aircraft ? `${aircraft.name}${aircraft.tailNumber ? ` · ${aircraft.tailNumber}` : ''}` : <GlyphLabel size={12} text="⚠ no freighter assigned" />}
                {type && ` · ${type.payloadTonnes}t payload`}
              </div>
            )}
            <CargoRouteControls route={route} sim={sim} controls={controls} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Lane-wide controls (lanes with more than one freighter) ────────────────────

function CargoLaneControls({ group, controls }) {
  const { adjLaneYield, alignLaneYield, closeLane, onAddFreighter } = controls;
  const uneven = group.yieldMax - group.yieldMin >= 0.0005;
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', paddingTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Lane yield $/t-km</span>
        <button className="btn btn-ghost" style={{ padding: '2px 9px' }} title="Lower every freighter on this lane by $0.02" onClick={() => adjLaneYield(group, -0.02)}>−</button>
        <span style={{ fontWeight: 700, minWidth: 48, textAlign: 'center' }}>{yieldLabel(group)}</span>
        <button className="btn btn-ghost" style={{ padding: '2px 9px' }} title="Raise every freighter on this lane by $0.02" onClick={() => adjLaneYield(group, +0.02)}>+</button>
        {uneven && (
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, color: ACCENT }}
            title={`Set every freighter on this lane to the capacity-weighted average, $${group.route.yieldPrice.toFixed(3)}`}
            onClick={() => alignLaneYield(group)}
          >Align all to ${group.route.yieldPrice.toFixed(3)}</button>
        )}
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        {group.rows.length} freighters · open one below to change its own flights or yield
      </span>
      {onAddFreighter && (
        <button
          className="btn btn-ghost"
          style={{ marginLeft: 'auto', fontSize: 12, color: ACCENT }}
          title={`Open the freight planner on ${group.origin} → ${group.destination}`}
          onClick={() => onAddFreighter(group.origin, group.destination)}
        >+ Add Freighter</button>
      )}
      <button className="btn btn-ghost" style={{ marginLeft: onAddFreighter ? 0 : 'auto', color: 'var(--red)', fontSize: 12 }} onClick={() => closeLane(group)}>Close lane</button>
    </div>
  );
}

// ─── Shared controls (used by both the expanded table row and the card view) ────

function CargoRouteControls({ route, sim, controls }) {
  const { setFreq, setYield, close, state, onAddFreighter } = controls;
  const perKg = (route.yieldPrice * (sim?.distance ?? 0) / 1000);
  // Rate vs the going rate for this lane, and what pricing above it actually
  // costs. Both come from the same function the tick uses, so the number here
  // can never drift from the number the engine charges you. Players used to
  // discover the ceiling by walking the yield in $0.02 steps and watching load
  // factor — dozens of probes per route. Show it instead.
  const refYield = sim?.refYield ?? null;
  const ratio    = refYield ? route.yieldPrice / refYield : null;
  const chokePct = refYield
    ? Math.round((1 - cargoPriceChokeFactor(route.yieldPrice, refYield)) * 100)
    : 0;
  const yieldColor = ratio == null || ratio <= 1.05 ? 'var(--text-dim)'
                   : chokePct >= 25 ? 'var(--red)'
                   : chokePct >= 5  ? 'var(--yellow)'
                   : 'var(--text-dim)';
  const yieldTitle = ratio == null ? ''
    : chokePct <= 0
      ? `At or below the going rate for this lane ($${refYield.toFixed(3)}/t-km). No demand penalty.`
      : `${(ratio).toFixed(2)}x the going rate ($${refYield.toFixed(3)}/t-km). Forwarders book elsewhere: you are losing ${chokePct}% of the freight you would win at the reference rate, on top of ordinary elasticity. Demand reaches zero at ${CARGO_PRICE_CAP_MULTIPLE}x.`;

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Flights/wk</span>
        <NumberStepper
          size="sm"
          value={route.weeklyFrequency}
          min={1}
          max={99}
          onChange={n => setFreq(route, n)}
          blockReason={n => cargoFrequencyChangeBlockReason(state, route.id, n)}
          blockedTitle="Can’t add a flight"
          ariaLabel={`flights per week, ${route.origin} to ${route.destination}`}
          decTitle={route.weeklyFrequency > 1 ? 'One fewer flight per week' : 'At the minimum. Use Close route to stand the freighter down'}
          incTitle="One more flight per week"
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Yield $/t-km</span>
        <NumberStepper
          size="sm"
          value={+route.yieldPrice.toFixed(3)}
          min={0.01}
          step={0.02}
          decimals={3}
          inputWidth={50}
          onChange={y => setYield(route, y)}
          ariaLabel={`yield, ${route.origin} to ${route.destination}`}
          decTitle="Lower by $0.02"
          incTitle="Raise by $0.02"
        />
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>≈ ${perKg.toFixed(2)}/kg</span>
        {ratio != null && (
          <span style={{ fontSize: 11, color: yieldColor, fontWeight: chokePct >= 5 ? 700 : 400 }} title={yieldTitle}>
            {ratio.toFixed(2)}× ref{chokePct > 0 ? ` · −${chokePct}% freight` : ''}
          </span>
        )}
      </div>
      {/* One freighter is one freighter. The only way to put a second one on a
          lane you already fly used to be the planner on the other side of the
          page — the frequency stepper caps out at this airframe's block hours,
          and then the lane is simply full (Knightmare, Discord 2026-08-26). */}
      {onAddFreighter && (
        <button
          className="btn btn-ghost"
          style={{ marginLeft: 'auto', fontSize: 12, color: ACCENT }}
          title={`Open the freight planner on ${route.origin} → ${route.destination}`}
          onClick={() => onAddFreighter(route.origin, route.destination)}
        >+ Add Freighter</button>
      )}
      <button className="btn btn-ghost" style={{ marginLeft: onAddFreighter ? 0 : 'auto', color: 'var(--red)', fontSize: 12 }} onClick={() => close(route)}>Close route</button>
    </div>
  );
}

// ─── Card view (same layout as before, sharing the controls with the table) ─────

function CardSelectBox({ selectKey, controls }) {
  return (
    <input
      type="checkbox"
      data-cargo-select={selectKey}
      style={{ accentColor: ACCENT, cursor: 'pointer', width: 15, height: 15 }}
      checked={controls.selection.has(selectKey)}
      onChange={() => controls.selection.toggle(selectKey)}
      title="Select this lane for bulk pricing"
    />
  );
}

function CargoRouteCard({ route, aircraft, type, sim, pooled, controls, selectKey }) {
  const lf = sim?.loadFactor ?? 0;
  const lfColor = lf >= 0.75 ? 'var(--green)' : lf >= 0.45 ? 'var(--yellow)' : 'var(--red)';

  return (
    <div className="card" style={{ marginBottom: 10, borderLeft: `3px solid ${ACCENT}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        {/* Left: identity */}
        <div style={{ minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 17, fontWeight: 700 }}>
            {selectKey && <CardSelectBox selectKey={selectKey} controls={controls} />}
            <AirportLink code={route.origin} /> <span style={{ color: ACCENT }}>→</span> <AirportLink code={route.destination} />
            <FreightBadge />
            {pooled && <SharedLaneBadge />}
            <ConnectingFreightChip sim={sim} />
            {aircraft?.status === 'grounded' && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                background: 'rgba(248,81,73,0.15)', color: 'var(--red)',
                border: '1px solid rgba(248,81,73,0.3)',
                textTransform: 'uppercase', letterSpacing: '.04em',
              }} title={groundedTitle(aircraft)}>
                <Glyph e="🔧" /> {aircraft.groundedWeeksLeft}w
              </span>
            )}
            <OutOfRangeBadge route={route} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            {aircraft ? `${aircraft.name}${aircraft.tailNumber ? ` · ${aircraft.tailNumber}` : ''}` : <GlyphLabel size={12} text="⚠ no freighter assigned" />}
            {type && ` · ${type.payloadTonnes}t payload`}
            {sim && ` · ${sim.distance.toLocaleString()} km`}
          </div>
        </div>

        {/* Middle: stats */}
        {sim && (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Tonnes/wk</div><div style={{ fontWeight: 700, color: ACCENT }}>{sim.tonnes.toLocaleString()}</div></div>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Load</div><div style={{ fontWeight: 700, color: lfColor }}>{formatPercent(lf)}</div></div>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Revenue</div><div style={{ fontWeight: 700, color: 'var(--green)' }}>{formatMoney(sim.revenue)}</div></div>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Var. profit</div><div style={{ fontWeight: 700, color: sim.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{(sim.profit >= 0 ? '+' : '') + formatMoney(sim.profit)}</div></div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
        <CargoRouteControls route={route} sim={sim} controls={controls} />
      </div>
    </div>
  );
}

// ─── Lane card (cards view, lanes with more than one freighter) ─────────────────

function CargoLaneCard({ group, controls }) {
  const [open, setOpen] = useState(false);
  const [openId, setOpenId] = useState(null);
  const { route, sim, rows } = group;
  const lf = sim?.loadFactor ?? 0;
  const subControls = { ...controls, onAddFreighter: null };

  return (
    <div className="card" style={{ marginBottom: 10, borderLeft: `3px solid ${ACCENT}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 17, fontWeight: 700, flexWrap: 'wrap' }}>
            <CardSelectBox selectKey={group.key} controls={controls} />
            <AirportLink code={route.origin} /> <span style={{ color: ACCENT }}>→</span> <AirportLink code={route.destination} />
            <FreightBadge />
            <SharedLaneBadge count={rows.length} />
            <ConnectingFreightChip sim={sim} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            {route.weeklyFrequency} flights/wk
            {sim && ` · ${sim.distance.toLocaleString()} km`}
            {` · ${yieldLabel(group)}/t-km`}
          </div>
        </div>
        {sim && (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Tonnes/wk</div><div style={{ fontWeight: 700, color: ACCENT }}>{sim.tonnes.toLocaleString()}</div></div>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Load</div><div style={{ fontWeight: 700, color: lfColorOf(lf) }}>{formatPercent(lf)}</div></div>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Revenue</div><div style={{ fontWeight: 700, color: 'var(--green)' }}>{formatMoney(sim.revenue)}</div></div>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Var. profit</div><div style={{ fontWeight: 700, color: sim.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{(sim.profit >= 0 ? '+' : '') + formatMoney(sim.profit)}</div></div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
        <CargoLaneControls group={group} controls={controls} />
      </div>

      <button
        className="btn btn-ghost"
        style={{ marginTop: 10, fontSize: 12, padding: '4px 0', color: 'var(--text-muted)' }}
        onClick={() => setOpen(v => !v)}
      >
        {open ? '▴ Hide' : '▾ Show'} {rows.length} freighters
      </button>

      {open && (
        <div style={{ marginTop: 6 }}>
          {rows.map(r => {
            const rlf = r.sim?.loadFactor ?? 0;
            const isOpen = openId === r.route.id;
            return (
              <div key={r.route.id} style={{ borderTop: '1px solid var(--border-subtle)', padding: '8px 0' }}>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', cursor: 'pointer', fontSize: 12 }}
                  onClick={() => setOpenId(isOpen ? null : r.route.id)}
                >
                  <span style={{ fontWeight: 600 }}>
                    {r.aircraft ? `${r.aircraft.name}${r.aircraft.tailNumber ? ` · ${r.aircraft.tailNumber}` : ''}` : 'No freighter'}
                    {r.route.origin !== route.origin && (
                      <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontFamily: 'monospace', fontWeight: 400 }}>{r.route.origin} → {r.route.destination}</span>
                    )}
                    {r.aircraft?.status === 'grounded' && (
                      <span style={{ marginLeft: 6, color: 'var(--red)' }} title={groundedTitle(r.aircraft)}><Glyph e="🔧" /> {r.aircraft.groundedWeeksLeft}w</span>
                    )}
                    <OutOfRangeBadge route={r.route} style={{ marginLeft: 6 }} />
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {r.route.weeklyFrequency}× · <span style={{ color: lfColorOf(rlf), fontWeight: 700 }}>{r.sim ? formatPercent(rlf) : '—'}</span>
                    {' · '}${r.route.yieldPrice.toFixed(3)}
                    {' · '}<span style={{ color: (r.sim?.profit ?? 0) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{r.sim ? `${r.sim.profit >= 0 ? '+' : ''}${formatMoney(r.sim.profit)}` : '—'}</span>
                    {' '}{isOpen ? '▴' : '▾'}
                  </span>
                </div>
                {isOpen && (
                  <div style={{ marginTop: 8 }}>
                    <CargoRouteControls route={r.route} sim={r.sim} controls={subControls} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Mass pricing (Barca, Discord 2026-11-05: "Most importantly mass pricing") ─
//
// The passenger page's selection bar and Bulk Pricing modal, for freight. Both
// preview with planCargoYields and apply through BULK_SET_CARGO_YIELD, so the
// line under the controls is exactly what Apply writes. Freight has one rate per
// freighter rather than four cabins, so it is one % box, not a row of them.

/** "12 freighters → $0.412–$0.455 · 3 above the going rate" for a planned change. */
function CargoYieldPreview({ plan }) {
  if (!plan) return null;
  if (plan.changed === 0) {
    return <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Nothing would change.</span>;
  }
  const moved = plan.rows.filter(r => plan.yields.has(r.route.id));
  const lo = Math.min(...moved.map(r => r.to));
  const hi = Math.max(...moved.map(r => r.to));
  // Past the going rate forwarders start booking elsewhere (cargoPriceChokeFactor,
  // the tick's own curve); count the freighters that would lose 5% or more.
  const choked = moved.filter(r => (1 - cargoPriceChokeFactor(r.to, r.ref)) >= 0.05).length;
  const range = hi - lo < 0.0005 ? `$${lo.toFixed(3)}` : `$${lo.toFixed(3)}–$${hi.toFixed(3)}`;
  return (
    <span data-cargo-yield-preview="" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
      <b>{plan.changed}</b> freighter{plan.changed !== 1 ? 's' : ''} → {range}/t-km
      {choked > 0 && (
        <span style={{ color: 'var(--yellow)', fontWeight: 700 }}
              title={`Priced past the lane's going rate, forwarders book elsewhere: these lose 5% or more of their freight. Demand reaches zero at ${CARGO_PRICE_CAP_MULTIPLE}x reference.`}>
          {' '}· {choked} lose freight to price
        </span>
      )}
    </span>
  );
}

const parsePct = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.max(CARGO_BULK_PCT_MIN, Math.min(CARGO_BULK_PCT_MAX, n)) : 0;
};

export function CargoSelectionBar({ groups, onApplyYield, onCloseGroups, onClear }) {
  const { state } = useGame();
  const [pct, setPct] = useState('');
  const routeIds = groups.flatMap(g => g.rows.map(r => r.route.id));
  const n = parsePct(pct);
  const plan = n !== 0 ? planCargoYields(state, routeIds, { mode: 'pct', value: n }) : null;
  const freighters = routeIds.length;

  return (
    <div data-cargo-selection-bar="" style={{
      position: 'sticky', top: 8, zIndex: 50, marginBottom: 14,
      display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap',
      padding: '12px 16px', borderRadius: 10,
      background: 'var(--surface2)', border: `1px solid ${ACCENT}`,
      boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>
        {groups.length} lane{groups.length !== 1 ? 's' : ''} selected
        <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>{freighters} freighter{freighters !== 1 ? 's' : ''}</div>
      </div>

      <div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Yield change</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="number"
            className="form-input"
            data-cargo-bulk-pct=""
            placeholder="±%"
            value={pct}
            onChange={e => setPct(e.target.value)}
            style={{ width: 70, textAlign: 'center' }}
            aria-label="yield change, percent"
          />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>%</span>
          <button
            className="btn btn-primary"
            style={{ fontSize: 12, padding: '4px 12px', background: ACCENT, borderColor: ACCENT }}
            disabled={!plan || plan.changed === 0}
            onClick={() => { onApplyYield(groups, { mode: 'pct', value: n }); setPct(''); }}
          >Apply</button>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '4px 10px' }}
            title="Every selected freighter back to its own lane's going rate — the undo for a change that went wrong"
            onClick={() => onApplyYield(groups, { mode: 'reference' })}
          >Reset to ref</button>
        </div>
        <div style={{ marginTop: 4, minHeight: 14 }}><CargoYieldPreview plan={plan} /></div>
      </div>

      <div style={{ minWidth: 260 }}>
        <RouteFrequencyControls routeIds={routeIds} noun="freighter" each="each freighter" />
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }} onClick={() => onCloseGroups(groups)}>Close</button>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={onClear}>Clear</button>
      </div>
    </div>
  );
}

// Both exported for tests (tools/cargo-bulk-yield-ui-test.mjs).
const RATE_FILTERS = [
  { id: 'any',   label: 'Any rate' },
  { id: 'above', label: 'Above the going rate' },
  { id: 'below', label: 'At or below the going rate' },
];

export function CargoBulkPricingModal({ allGroups, onApply, onClose }) {
  const { state } = useGame();
  const [lfOn, setLfOn]   = useState(false);
  const [lfMin, setLfMin] = useState(0);
  const [lfMax, setLfMax] = useState(60);
  const [rate, setRate]   = useState('any');
  const [mode, setMode]   = useState('pct');
  const [pct, setPct]     = useState('');

  // A lane's rate against ITS going rate: the capacity-weighted lane yield over
  // the reference the tick prices it against.
  const ratioOf = (g) => g.route.yieldPrice / Math.max(0.01, cargoReferenceYield(g.origin, g.destination));
  const matching = allGroups.filter(g => {
    if (lfOn) {
      const lf = (g.sim?.loadFactor ?? 0) * 100;
      if (lf < lfMin || lf > lfMax) return false;
    }
    if (rate === 'above' && !(ratioOf(g) > 1.0005)) return false;
    if (rate === 'below' && ratioOf(g) > 1.0005) return false;
    return true;
  });
  const routeIds = matching.flatMap(g => g.rows.map(r => r.route.id));
  const n = parsePct(pct);
  const change = mode === 'reference' ? { mode: 'reference' } : { mode: 'pct', value: n };
  const plan = routeIds.length > 0 && (mode === 'reference' || n !== 0) ? planCargoYields(state, routeIds, change) : null;

  function apply() {
    if (!plan || plan.changed === 0) return;
    onApply(matching, change);
    onClose();
  }

  const label = { fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 };
  const seg = (on) => ({
    padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
    background: on ? ACCENT : 'transparent', color: on ? '#fff' : 'var(--text-muted)',
  });

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
        data-cargo-bulk-modal=""
        style={{ width: 520, maxWidth: '100%', maxHeight: '88vh', overflowY: 'auto', borderTop: `3px solid ${ACCENT}` }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}><Glyph e="⚖️" /> Freight Bulk Pricing</div>
          <button className="btn btn-ghost" style={{ padding: '2px 8px' }} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
          Pick lanes by how full they fly and how they are priced against the going rate, then move every
          freighter on them at once. Raise full lanes; cut or reset the empty ones.
        </div>

        <div style={label}>Which lanes</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '8px 0 16px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
            <input type="checkbox" checked={lfOn} onChange={e => setLfOn(e.target.checked)} style={{ accentColor: ACCENT }} />
            Load factor between
            <input type="number" className="form-input" min={0} max={100} value={lfMin} disabled={!lfOn}
                   onChange={e => setLfMin(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} style={{ width: 60, textAlign: 'center' }} aria-label="minimum load factor" />
            and
            <input type="number" className="form-input" min={0} max={100} value={lfMax} disabled={!lfOn}
                   onChange={e => setLfMax(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} style={{ width: 60, textAlign: 'center' }} aria-label="maximum load factor" />
            %
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            Priced
            <select className="form-select" value={rate} onChange={e => setRate(e.target.value)} style={{ width: 220 }}>
              {RATE_FILTERS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            <b style={{ color: 'var(--text)' }}>{matching.length}</b> of {allGroups.length} lane{allGroups.length !== 1 ? 's' : ''} match
            {' · '}{routeIds.length} freighter{routeIds.length !== 1 ? 's' : ''}
          </div>
        </div>

        <div style={label}>Change</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0 10px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <button type="button" style={seg(mode === 'pct')} onClick={() => setMode('pct')}>By %</button>
            <button type="button" style={seg(mode === 'reference')} onClick={() => setMode('reference')}>Reset to going rate</button>
          </div>
          {mode === 'pct' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="number" className="form-input" placeholder="±%" value={pct} onChange={e => setPct(e.target.value)}
                     style={{ width: 70, textAlign: 'center' }} aria-label="yield change, percent" />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>%</span>
            </span>
          )}
        </div>
        <div style={{ minHeight: 16, marginBottom: 14 }}><CargoYieldPreview plan={plan} /></div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            style={{ background: ACCENT, borderColor: ACCENT }}
            disabled={!plan || plan.changed === 0}
            onClick={apply}
          >
            {plan?.changed ? `Reprice ${plan.changed} freighter${plan.changed !== 1 ? 's' : ''}` : 'Reprice'}
          </button>
        </div>
      </div>
    </div>
  );
}
