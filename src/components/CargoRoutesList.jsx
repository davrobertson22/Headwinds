import { useState, useMemo } from 'react';
import { useGame, cargoFrequencyChangeBlockReason } from '../store/GameContext.jsx';
import { useConfirm } from './ConfirmModal.jsx';
import AirportLink from './AirportLink.jsx';
import { getAircraftType } from '../data/aircraft.js';
import { getAirport } from '../data/airports.js';
import { simulateCargoRoute, cargoLaneAllocations, formatMoney, formatPercent, currentGameDate } from '../utils/simulation.js';
import { Glyph, GlyphLabel } from './Icons.jsx';
import { useToast } from './ToastSystem.jsx';

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

// ─── Cargo routes list ──────────────────────────────────────────────────────────

/**
 * Freight routes, as either a compact sortable table (default on desktop) or the
 * roomier cards (default on phones). Table rows expand to reveal the same
 * frequency / yield / close-route controls the cards show inline.
 *
 * @param {string}  airportFilter  'all' | airport code — only routes touching this airport
 * @param {boolean} hideViewToggle suppress the Table/Cards switch (when the parent owns it)
 */
export default function CargoRoutesList({ airportFilter = 'all', hideViewToggle = false }) {
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

  const allRows = useMemo(() => {
    // Same-lane pooling: mirror the weekly tick so the list shows each route's
    // SHARE of a shared lane, not N copies of the full market.
    const alloc = cargoLaneAllocations(cargoRoutes, fleet, 1.0, { gameDate: gd });
    return cargoRoutes.map(route => {
      const aircraft = fleet.find(a => a.id === route.aircraftId);
      const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
      const sim      = aircraft ? simulateCargoRoute(route, aircraft, gd, null, 1.0, 1.0, alloc.get(route.id) ?? null) : null;
      return { route, aircraft, type, sim, pooled: alloc.has(route.id) };
    });
  }, [cargoRoutes, fleet, gd]);

  // Scope to the airport filter, then sort by profit descending (the old card order).
  const rows = useMemo(() => {
    const scoped = airportFilter === 'all'
      ? allRows
      : allRows.filter(({ route }) => route.origin === airportFilter || route.destination === airportFilter);
    return [...scoped].sort((a, b) => (b.sim?.profit ?? -Infinity) - (a.sim?.profit ?? -Infinity));
  }, [allRows, airportFilter]);

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

  function adjFreq(route, delta) {
    // Increases run through the exact engine guard so a blocked bump explains
    // itself (block-hours / gate slots) instead of silently no-opping.
    if (delta > 0) {
      const reason = cargoFrequencyChangeBlockReason(state, route.id, route.weeklyFrequency + delta);
      if (reason) { addToast({ type: 'warning', title: 'Can’t add a flight', message: reason }); return; }
    }
    dispatch({ type: 'UPDATE_CARGO_FREQUENCY', routeId: route.id, weeklyFrequency: Math.max(1, route.weeklyFrequency + delta) });
  }
  function adjYield(route, delta) {
    dispatch({ type: 'UPDATE_CARGO_YIELD', routeId: route.id, yieldPrice: Math.max(0.01, +(route.yieldPrice + delta).toFixed(3)) });
  }
  async function close(route) {
    if (await confirm({ title: `Close cargo route ${route.origin} → ${route.destination}?`, body: 'The freighter returns to idle.', danger: true, confirmLabel: 'Close route' })) {
      dispatch({ type: 'CLOSE_CARGO_ROUTE', routeId: route.id });
    }
  }

  const controls = { adjFreq, adjYield, close, state };

  const totalRev    = rows.reduce((s, r) => s + (r.sim?.revenue ?? 0), 0);
  const totalProfit = rows.reduce((s, r) => s + (r.sim?.profit ?? 0), 0);
  const totalTonnes = rows.reduce((s, r) => s + (r.sim?.tonnes ?? 0), 0);

  return (
    <div>
      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 14, padding: '10px 14px', background: 'var(--surface2)', borderRadius: 'var(--radius)', border: `1px solid ${ACCENT}33`, alignItems: 'center' }}>
        <div>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Cargo routes</span>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {rows.length}
            {rows.length !== cargoRoutes.length && (
              <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 400 }}> of {cargoRoutes.length}</span>
            )}
          </div>
        </div>
        <div><span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Tonnes / wk</span><div style={{ fontWeight: 700, fontSize: 15, color: ACCENT }}>{totalTonnes.toLocaleString()}</div></div>
        <div><span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Freight revenue</span><div style={{ fontWeight: 700, fontSize: 15, color: 'var(--green)' }}>{formatMoney(totalRev)}</div></div>
        <div><span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Var. profit / wk</span><div style={{ fontWeight: 700, fontSize: 15, color: totalProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>{(totalProfit >= 0 ? '+' : '') + formatMoney(totalProfit)}</div></div>
        {!hideViewToggle && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, background: 'var(--surface)', borderRadius: 'var(--radius)', padding: 2 }}>
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

      {viewMode === 'table'
        ? <CargoTable rows={rows} controls={controls} />
        : rows.map(r => <CargoRouteCard key={r.route.id} {...r} controls={controls} />)}
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

function CargoTable({ rows, controls }) {
  const [sortCol, setSortCol] = useState('profit');
  const [sortDir, setSortDir] = useState('desc');   // 'asc' | 'desc'
  const [shown,   setShown]   = useState(CARGO_PAGE_SIZE);
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  const sorted = useMemo(() => {
    const cmp = CARGO_SORTERS[sortCol] ?? CARGO_SORTERS.profit;
    const s = [...rows].sort(cmp);
    if (sortDir === 'desc') s.reverse();
    return s;
  }, [rows, sortCol, sortDir]);

  const visible = sorted.slice(0, shown);

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
            {visible.map((r, i) => (
              <CargoTableRow
                key={r.route.id}
                row={r}
                zebra={i % 2 === 1}
                expanded={expandedIds.has(r.route.id)}
                onToggleExpand={() => toggleExpand(r.route.id)}
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

function CargoTableRow({ row, zebra, expanded, onToggleExpand, controls }) {
  const { route, aircraft, type, sim, pooled } = row;
  const oa = getAirport(route.origin);
  const da = getAirport(route.destination);

  const lf = sim?.loadFactor ?? 0;
  const lfColor   = lf >= 0.75 ? 'var(--green)' : lf >= 0.45 ? 'var(--yellow)' : 'var(--red)';
  const profColor = (sim?.profit ?? 0) >= 0 ? 'var(--green)' : 'var(--red)';

  const CELL  = { padding: '7px 10px' };
  const RIGHT = { ...CELL, textAlign: 'right' };

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
        <td style={{ ...CELL, whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: 13, color: ACCENT }}>
            {route.origin} → {route.destination}
          </span>
          <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11 }}>
            {oa?.city} → {da?.city}
          </span>
          {aircraft?.status === 'grounded' && (
            <span
              style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: 'rgba(248,81,73,0.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.3)', textTransform: 'uppercase' }}
              title="In repair, automatically resumes this route when fixed"
            >
              <Glyph e="🔧" /> {aircraft.groundedWeeksLeft}w
            </span>
          )}
          {!aircraft && (
            <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: 'rgba(248,81,73,0.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.3)', textTransform: 'uppercase' }}>
              No freighter
            </span>
          )}
          {pooled && (
            <span
              style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: `${ACCENT}18`, color: ACCENT, border: `1px solid ${ACCENT}44`, textTransform: 'uppercase' }}
              title="Several of your freighters fly this lane — they share one demand pool, so this route's tonnage is its share of the market, not the full market"
            >
              <Glyph e="⚖" /> Shared lane
            </span>
          )}
        </td>
        <td style={{ ...RIGHT, color: 'var(--text-muted)' }}>{sim ? `${sim.distance.toLocaleString()} km` : '—'}</td>
        <td style={RIGHT}>{route.weeklyFrequency}×</td>
        <td style={{ ...RIGHT, fontWeight: 700, color: lfColor }}>{sim ? formatPercent(lf) : '—'}</td>
        <td style={{ ...RIGHT, fontWeight: 700, color: ACCENT }}>{sim ? sim.tonnes.toLocaleString() : '—'}</td>
        <td style={{ ...RIGHT, color: 'var(--text-muted)' }}>${route.yieldPrice.toFixed(3)}</td>
        <td style={{ ...RIGHT, fontWeight: 600, color: 'var(--green)' }}>{sim ? `+${formatMoney(sim.revenue)}` : '—'}</td>
        <td style={{ ...RIGHT, fontWeight: 700, color: profColor }}>
          {sim ? `${sim.profit >= 0 ? '+' : ''}${formatMoney(sim.profit)}` : '—'}
        </td>
        <td style={{ ...CELL, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          {expanded ? '▴' : '▾'}
        </td>
      </tr>
      {expanded && (
        <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <td colSpan={CARGO_COLUMNS.length + 1} style={{ padding: '0 14px 12px' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0 10px' }}>
              {aircraft ? `${aircraft.name}${aircraft.tailNumber ? ` · ${aircraft.tailNumber}` : ''}` : <GlyphLabel size={12} text="⚠ no freighter assigned" />}
              {type && ` · ${type.payloadTonnes}t payload`}
            </div>
            <CargoRouteControls route={route} sim={sim} controls={controls} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Shared controls (used by both the expanded table row and the card view) ────

function CargoRouteControls({ route, sim, controls }) {
  const { adjFreq, adjYield, close, state } = controls;
  const perKg = (route.yieldPrice * (sim?.distance ?? 0) / 1000);
  const upBlock = cargoFrequencyChangeBlockReason(state, route.id, route.weeklyFrequency + 1);

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Flights/wk</span>
        <button
          className="btn btn-ghost"
          style={{ padding: '2px 9px', opacity: route.weeklyFrequency > 1 ? 1 : 0.4, cursor: route.weeklyFrequency > 1 ? 'pointer' : 'not-allowed' }}
          disabled={route.weeklyFrequency <= 1}
          title={route.weeklyFrequency > 1 ? 'One fewer flight per week' : 'At the minimum. Use Close route to stand the freighter down'}
          onClick={() => adjFreq(route, -1)}
        >−</button>
        <span style={{ fontWeight: 700, minWidth: 22, textAlign: 'center' }}>{route.weeklyFrequency}</span>
        <button
          className="btn btn-ghost"
          style={{ padding: '2px 9px', opacity: upBlock ? 0.4 : 1, cursor: upBlock ? 'not-allowed' : 'pointer' }}
          title={upBlock || 'One more flight per week'}
          onClick={() => adjFreq(route, +1)}
        >+</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Yield $/t-km</span>
        <button className="btn btn-ghost" style={{ padding: '2px 9px' }} onClick={() => adjYield(route, -0.02)}>−</button>
        <span style={{ fontWeight: 700, minWidth: 48, textAlign: 'center' }}>${route.yieldPrice.toFixed(3)}</span>
        <button className="btn btn-ghost" style={{ padding: '2px 9px' }} onClick={() => adjYield(route, +0.02)}>+</button>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>≈ ${perKg.toFixed(2)}/kg</span>
      </div>
      <button className="btn btn-ghost" style={{ marginLeft: 'auto', color: 'var(--red)', fontSize: 12 }} onClick={() => close(route)}>Close route</button>
    </div>
  );
}

// ─── Card view (same layout as before, sharing the controls with the table) ─────

function CargoRouteCard({ route, aircraft, type, sim, pooled, controls }) {
  const lf = sim?.loadFactor ?? 0;
  const lfColor = lf >= 0.75 ? 'var(--green)' : lf >= 0.45 ? 'var(--yellow)' : 'var(--red)';

  return (
    <div className="card" style={{ marginBottom: 10, borderLeft: `3px solid ${ACCENT}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        {/* Left: identity */}
        <div style={{ minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 17, fontWeight: 700 }}>
            <AirportLink code={route.origin} /> <span style={{ color: ACCENT }}>→</span> <AirportLink code={route.destination} />
            <FreightBadge />
            {pooled && (
              <span
                style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: `${ACCENT}18`, color: ACCENT, border: `1px solid ${ACCENT}44`, textTransform: 'uppercase', letterSpacing: '.04em' }}
                title="Several of your freighters fly this lane — they share one demand pool, so this route's tonnage is its share of the market, not the full market"
              >
                <Glyph e="⚖" /> Shared lane
              </span>
            )}
            {aircraft?.status === 'grounded' && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                background: 'rgba(248,81,73,0.15)', color: 'var(--red)',
                border: '1px solid rgba(248,81,73,0.3)',
                textTransform: 'uppercase', letterSpacing: '.04em',
              }} title="In repair, automatically resumes this route when fixed">
                <Glyph e="🔧" /> {aircraft.groundedWeeksLeft}w
              </span>
            )}
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
