import { useState, useMemo } from 'react';
import { useGame, transferCompatibility } from '../store/GameContext.jsx';
import { getAircraftType } from '../data/aircraft.js';
import { getAirport } from '../data/airports.js';
import {
  formatMoney, formatPercent,
  maintenanceMultiplier, ageLabel,
  simulateRoute, weeklyBlockHours, currentGameDate,
  fleetAvgUtilization, buildEventDemandModel,
  MAX_WEEKLY_BLOCK_HOURS, CLASS_FARE_MULTIPLIERS, routeDistanceKm, weekToGameDate,
} from '../utils/simulation.js';
import { projectWeek } from '../utils/financeProjection.js';
import { absoluteWeek } from '../utils/fuel.js';
import { DEPRECIATION_YEARS } from '../data/overhead.js';
import InfoTip from './InfoTip.jsx';
import FleetConfig from './FleetConfig.jsx';
import { Glyph, GlyphLabel } from './Icons.jsx';

const CAT_COLORS = {
  'Turboprop':    '#ffb43d',
  'Regional Jet': '#38d39f',
  'Narrow Body':  '#3ea6ff',
  'Wide Body':    '#a98bff',
};

const CABIN_COLORS = {
  firstClass:     '#a98bff',
  businessClass:  '#3ea6ff',
  premiumEconomy: '#ffb43d',
  economy:        '#38d39f',
};
const CABIN_LABELS = {
  firstClass: 'First', businessClass: 'Business',
  premiumEconomy: 'Prem-Eco', economy: 'Economy',
};

function AircraftThumb({ type, size = 'sm' }) {
  const [failed, setFailed] = useState(false);
  const color  = CAT_COLORS[type?.category] || '#93a4ba';
  const isLarge = size === 'lg';

  if (failed || !type?.image) {
    return (
      <div
        className={isLarge ? '' : 'fleet-thumb-placeholder'}
        style={{
          background: `${color}18`, border: `1px solid ${color}30`,
          ...(isLarge ? {
            width: 120, height: 80, borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          } : {}),
        }}
      >
        <span style={{ fontSize: isLarge ? 36 : 18, opacity: 0.5 }}><Glyph e="✈" /></span>
      </div>
    );
  }

  if (isLarge) {
    return (
      <img
        src={type.image} alt={type.name}
        style={{ width: 120, height: 80, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <img
      src={type.image} alt={type.name}
      className="fleet-thumb"
      onError={() => setFailed(true)}
    />
  );
}

// ─── Transfer routes modal ────────────────────────────────────────────────────
// Move every route (pax + cargo) from this tail to a compatible idle aircraft.
// Routes keep their ramp, pricing and season — handy for swapping a new owned
// delivery in for a leased plane before returning it.

function TransferRoutesModal({ aircraft, onClose }) {
  const { state, dispatch } = useGame();
  const type = getAircraftType(aircraft.typeId);

  const candidates = state.fleet
    .filter(a => a.id !== aircraft.id)
    .map(a => ({ a, t: getAircraftType(a.typeId), compat: transferCompatibility(state, aircraft.id, a.id) }))
    .sort((x, y) => (y.compat.ok ? 1 : 0) - (x.compat.ok ? 1 : 0));

  function transferTo(toId) {
    dispatch({ type: 'TRANSFER_ROUTES', fromAircraftId: aircraft.id, toAircraftId: toId });
    onClose();
  }

  return (
    <div className="saveload-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="saveload-modal" style={{ width: 'min(520px, 94vw)' }}>
        <div className="saveload-header">
          <h2 style={{ margin: 0, fontSize: 17 }}>Transfer Routes</h2>
          <button className="btn" onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '4px 0 16px', lineHeight: 1.5 }}>
          Move every route from <strong>{aircraft.name}</strong> ({type?.name}) to another aircraft.
          Routes keep their maturity, pricing and season — the old aircraft goes idle, ready to
          sell or return.
        </p>
        {candidates.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-dim)', fontStyle: 'italic' }}>No other aircraft in the fleet.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {candidates.map(({ a, t, compat }) => (
            <div
              key={a.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                border: '1px solid var(--border)', borderRadius: 8,
                opacity: compat.ok ? 1 : 0.55,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {a.name}
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {t?.name}</span>
                </div>
                <div style={{ fontSize: 11, color: compat.ok ? 'var(--text-muted)' : 'var(--red)' }}>
                  {compat.ok
                    ? `${a.ownershipType === 'owned' ? 'Owned' : 'Leased'} · ${ageLabel(a.ageWeeks ?? 0)}`
                    : compat.reason}
                </div>
              </div>
              <button className="btn btn-primary" disabled={!compat.ok} onClick={() => transferTo(a.id)}>
                Transfer
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function AircraftDetail({ aircraft, onClose, onConfigure, onRetire, onSell }) {
  const { state, dispatch } = useGame();
  const { routes } = state;

  // Inline rename
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft]     = useState('');
  const [showTransfer, setShowTransfer] = useState(false);

  function startRename() {
    setNameDraft(aircraft.name);
    setEditingName(true);
  }
  function commitRename() {
    const name = nameDraft.trim();
    if (name && name !== aircraft.name) {
      dispatch({ type: 'RENAME_AIRCRAFT', aircraftId: aircraft.id, name });
    }
    setEditingName(false);
  }

  const type = getAircraftType(aircraft.typeId);

  // All routes for this aircraft, with simulation results and block hours.
  // Numbers MUST come from the canonical engine projection (projectWeek) — the
  // same source the Routes and Finance tabs use — so this panel reflects real
  // competitor encroachment, labor, fuel and revenue lifts. Re-simulating
  // standalone here (simulateRoute with no competition context) reported the
  // uncontested demand, which showed routes at 100% load while Routes/Finance
  // correctly showed them contested and often losing money.
  const gd             = currentGameDate(state);
  const proj           = useMemo(() => projectWeek(state), [state]);
  const rrById         = useMemo(() => {
    const m = {};
    for (const rr of proj.report?.routeResults ?? []) m[rr.routeId] = rr;
    return m;
  }, [proj]);
  const aircraftRoutes = routes.filter(r => r.aircraftId === aircraft.id);
  const routeResults   = aircraftRoutes.map(r => {
    // Prefer the engine's authoritative routeResult. Routes the engine skips
    // (grounded or dormant-seasonal) aren't in the report, so fall back to a
    // standalone sim run with the same labor + fuel the engine used.
    let result = rrById[r.id];
    if (!result) {
      const avgUtil = fleetAvgUtilization(state.fleet ?? [], [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]);
      const evMult  = buildEventDemandModel(state.activeEvents).multFor(r.origin, r.destination);
      result = simulateRoute(r, aircraft, gd, state.labor ?? null, proj.fuelMultiplier, null, [], avgUtil, state.satisfaction ?? null, evMult);
    }
    if (!result) return null;
    const bh = type ? weeklyBlockHours(result.distance, r.weeklyFrequency, type) : 0;
    return { route: r, result, blockHrs: bh };
  }).filter(Boolean);

  const ageWks   = aircraft.ageWeeks ?? 0;
  const ageYrs   = ageWks / 52;
  const maintMlt = maintenanceMultiplier(ageWks);
  const weeklyMaint = Math.round((type?.baseMaintenancePerWk ?? 0) * maintMlt);
  const weeklyLease = aircraft.ownershipType === 'owned' ? 0 : (type?.weeklyLease ?? 0);
  const ageColor    = ageYrs < 5 ? 'var(--green)' : ageYrs < 12 ? 'var(--yellow)' : 'var(--red)';

  // Aggregate across all routes
  const totalBlockHrs  = routeResults.reduce((s, { blockHrs }) => s + blockHrs, 0);
  const totalRevenue   = routeResults.reduce((s, { result }) => s + result.revenue, 0);
  const totalOpCost    = routeResults.reduce((s, { result }) => s + result.totalOpCost, 0);
  const blockPct       = totalBlockHrs / MAX_WEEKLY_BLOCK_HOURS;
  const blockColor     = blockPct >= 0.95 ? 'var(--red)' : blockPct >= 0.75 ? 'var(--yellow)' : 'var(--accent)';

  const weeklyTotal   = weeklyLease + weeklyMaint + totalOpCost;
  const weeklyProfit  = totalRevenue - weeklyTotal;
  const profitColor   = weeklyProfit >= 0 ? 'var(--green)' : 'var(--red)';

  const cfg = aircraft.config ?? {};
  const cabinKeys = Object.keys(CLASS_FARE_MULTIPLIERS);
  const totalConfigSeats = cabinKeys.reduce((s, k) => s + (cfg[k] ?? 0), 0) || type?.seats || 0;

  return (
    <div
      className="card"
      style={{ marginTop: 0, border: '1px solid var(--accent-dim)', borderRadius: 'var(--radius-lg)', padding: '20px 24px' }}
    >
      {/* ── Header ───────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
        <AircraftThumb type={type} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {editingName ? (
                  <input
                    autoFocus
                    value={nameDraft}
                    maxLength={40}
                    onChange={e => setNameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setEditingName(false);
                    }}
                    style={{
                      fontWeight: 700, fontSize: 20, padding: '2px 8px',
                      background: 'var(--surface2)', color: 'var(--text)',
                      border: '1px solid var(--accent)', borderRadius: 6,
                      outline: 'none', minWidth: 0, width: 260, maxWidth: '100%',
                    }}
                  />
                ) : (
                  <>
                    <span style={{ fontWeight: 700, fontSize: 20 }}>{aircraft.name}</span>
                    <button
                      onClick={startRename}
                      title="Rename aircraft"
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--text-muted)', fontSize: 14, padding: '2px 4px',
                        display: 'inline-flex', alignItems: 'center',
                      }}
                    >
                      <Glyph e="✏️" size={14} />
                    </button>
                  </>
                )}
                {aircraft.tailNumber && (
                  <span style={{
                    fontFamily: 'monospace', fontSize: 13, fontWeight: 700,
                    letterSpacing: '0.1em', padding: '2px 8px', borderRadius: 4,
                    background: 'rgba(56,139,253,0.12)',
                    color: 'var(--accent)',
                    border: '1px solid rgba(56,139,253,0.35)',
                  }}>
                    {aircraft.tailNumber}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
                {type?.name} · {type?.manufacturer}
                {' · '}
                <span style={{ color: CAT_COLORS[type?.category] || 'var(--text-muted)' }}>
                  {type?.category}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {aircraft.status === 'grounded' && (
                <span className="badge" style={{
                  background: 'rgba(248,81,73,.15)',
                  color: 'var(--red)',
                  border: '1px solid rgba(248,81,73,.4)',
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}>
                  <Glyph e="🔧" /> Grounded {aircraft.groundedWeeksLeft > 0 ? `(${aircraft.groundedWeeksLeft}w)` : ''}
                </span>
              )}
              <span className="badge" style={{
                background: aircraft.ownershipType === 'owned' ? 'rgba(63,185,80,.15)' : 'rgba(56,139,253,.15)',
                color: aircraft.ownershipType === 'owned' ? 'var(--green)' : 'var(--accent)',
                border: `1px solid ${aircraft.ownershipType === 'owned' ? 'rgba(63,185,80,.4)' : 'rgba(56,139,253,.4)'}`,
              }}>
                {aircraft.ownershipType === 'owned' ? 'Owned' : 'Leased'}
              </span>
              <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 16 }} onClick={onClose}><Glyph e="✕" /></button>
            </div>
          </div>

          {/* Specs strip */}
          <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
            <span>⟣ {type?.seats ?? '?'} seats max</span>
            <span>↔ {type?.range?.toLocaleString() ?? '?'} km range</span>
            <span><Glyph e="⛽" /> {type?.fuelBurnPer100km?.toFixed(0)} L/100km fuel burn</span>
            {aircraft.engineLabel && <span><Glyph e="🔧" /> {aircraft.engineLabel}</span>}
            {aircraft.hasWingtips  && <span style={{ color: 'var(--green)' }}>◇ Wingtips</span>}
            {aircraft.fuelMod && aircraft.fuelMod !== 1.0 && (
              <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                −{Math.round((1 - aircraft.fuelMod) * 100)}% fuel
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Key metrics ──────────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        gap: 10,
        marginBottom: 20,
      }}>
        {/* Utilisation */}
        <div className="stat-box" style={{ padding: '12px 14px' }}>
          <div className="stat-label">Utilisation ({aircraftRoutes.length} route{aircraftRoutes.length !== 1 ? 's' : ''})</div>
          <div style={{ fontWeight: 700, fontSize: 17, color: totalBlockHrs > 0 ? blockColor : 'var(--text-muted)', marginTop: 4 }}>
            {totalBlockHrs.toFixed(1)}h
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}> / {MAX_WEEKLY_BLOCK_HOURS}h</span>
          </div>
          <div style={{ height: 4, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden', marginTop: 6 }}>
            <div style={{ height: '100%', width: `${Math.min(100, blockPct * 100)}%`, background: totalBlockHrs > 0 ? blockColor : 'var(--surface3)', borderRadius: 2, transition: 'width 0.3s' }} />
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>block hrs/wk across all routes</div>
        </div>

        {/* Age */}
        <div className="stat-box" style={{ padding: '12px 14px' }}>
          <div className="stat-label">Age</div>
          <div style={{ fontWeight: 700, fontSize: 17, color: ageColor, marginTop: 4 }}>
            {ageLabel(ageWks)}
          </div>
          {maintMlt > 1 && (
            <div style={{ fontSize: 10, color: maintMlt > 1.5 ? 'var(--red)' : 'var(--yellow)', marginTop: 4 }}>
              +{((maintMlt - 1) * 100).toFixed(0)}% maint penalty
            </div>
          )}
        </div>

        {/* Lease / ownership */}
        <div className="stat-box" style={{ padding: '12px 14px' }}>
          <div className="stat-label">{aircraft.ownershipType === 'owned' ? 'Ownership' : 'Lease / wk'}</div>
          {aircraft.ownershipType === 'owned' ? (
            <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--green)', marginTop: 4 }}>Owned</div>
          ) : (
            <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--red)', marginTop: 4 }}>
              −{formatMoney(weeklyLease)}
            </div>
          )}
        </div>

        {/* Maintenance */}
        <div className="stat-box" style={{ padding: '12px 14px' }}>
          <div className="stat-label">Maintenance / wk</div>
          <div style={{ fontWeight: 700, fontSize: 17, color: maintMlt > 1.5 ? 'var(--yellow)' : 'var(--red)', marginTop: 4 }}>
            −{formatMoney(weeklyMaint)}
          </div>
        </div>

        {/* Weekly P&L */}
        <div className="stat-box" style={{ padding: '12px 14px' }}>
          <div className="stat-label">Net / wk (incl. fixed)</div>
          {routeResults.length > 0 ? (
            <div style={{ fontWeight: 700, fontSize: 17, color: profitColor, marginTop: 4 }}>
              {weeklyProfit >= 0 ? '+' : ''}{formatMoney(weeklyProfit)}
            </div>
          ) : (
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-dim)', marginTop: 4 }}>Idle</div>
          )}
          {routeResults.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>
              rev {formatMoney(totalRevenue)} − costs {formatMoney(weeklyTotal)}
            </div>
          )}
        </div>
      </div>

      {/* ── Route breakdown ───────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
          Route Performance {routeResults.length > 1 && `(${routeResults.length} routes)`}
        </div>

        {routeResults.length > 0 ? routeResults.map(({ route: r, result: res, blockHrs: bh }) => {
          const org = getAirport(r.origin);
          const dst = getAirport(r.destination);
          const rhColor = bh / MAX_WEEKLY_BLOCK_HOURS >= 0.75 ? 'var(--yellow)' : 'var(--text-dim)';
          return (
            <div key={r.id} className="card" style={{ background: 'var(--surface2)', padding: '12px 16px', borderRadius: 'var(--radius)', marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{r.origin} → {r.destination}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>
                    {org?.city} → {dst?.city}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
                  {r.weeklyFrequency}× / wk · {res.distance?.toLocaleString()} km
                  <div style={{ color: rhColor }}>{bh.toFixed(1)}h block</div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
                {[
                  { label: 'Revenue/wk',    value: `+${formatMoney(res.revenue)}`,    color: 'var(--green)' },
                  { label: 'Op Cost/wk',    value: `−${formatMoney(res.totalOpCost)}`, color: 'var(--red)'  },
                  { label: 'Pax/wk',        value: res.passengers.toLocaleString(),    color: 'var(--text)' },
                  { label: 'Load Factor',   value: formatPercent(res.loadFactor),
                    color: res.loadFactor > .7 ? 'var(--green)' : res.loadFactor > .4 ? 'var(--yellow)' : 'var(--red)' },
                  { label: 'Ticket',        value: `$${r.ticketPrice}`,               color: 'var(--text)' },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                    <div style={{ fontWeight: 600, color, marginTop: 2, fontSize: 13 }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        }) : (
          <div style={{
            padding: '14px 16px', background: 'var(--surface2)', borderRadius: 'var(--radius)',
            color: 'var(--text-muted)', fontSize: 13, textAlign: 'center',
          }}>
            Aircraft is idle — assign it to a route to start earning.
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
              Open the <strong>Route Planner</strong> (or <strong>Routes → + Open Route</strong>), pick two airports, choose this aircraft's type, and hit <strong>Open Route</strong> to deploy it.
            </div>
          </div>
        )}

        {/* All-routes total row when there are 2+ routes */}
        {routeResults.length > 1 && (
          <div style={{
            display: 'flex', gap: 16, padding: '10px 16px', borderRadius: 'var(--radius)',
            background: 'var(--surface3)', fontSize: 12, flexWrap: 'wrap', marginTop: 4,
          }}>
            <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>Total across all routes:</span>
            <span style={{ color: 'var(--green)' }}>+{formatMoney(totalRevenue)} revenue</span>
            <span style={{ color: 'var(--red)' }}>−{formatMoney(totalOpCost)} op cost</span>
            <span>{routeResults.reduce((s, { result }) => s + result.passengers, 0).toLocaleString()} pax/wk</span>
          </div>
        )}
      </div>

      {/* ── Cabin configuration ───────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
          Cabin Configuration
        </div>
        {/* Seat bar */}
        <div style={{ display: 'flex', height: 20, borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
          {cabinKeys.map(cls => {
            const seats = cfg[cls] ?? 0;
            if (!seats) return null;
            const pct = (seats / totalConfigSeats) * 100;
            return (
              <div
                key={cls}
                style={{
                  width: `${pct}%`, background: CABIN_COLORS[cls],
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700, color: '#fff',
                  overflow: 'hidden', whiteSpace: 'nowrap',
                }}
                title={`${CABIN_LABELS[cls]}: ${seats} seats`}
              >
                {pct > 8 ? seats : ''}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {cabinKeys.map(cls => {
            const seats = cfg[cls] ?? 0;
            if (!seats) return null;
            return (
              <div key={cls} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: CABIN_COLORS[cls] }} />
                <span>{CABIN_LABELS[cls]}: {seats}</span>
                <span style={{ color: 'var(--text-muted)' }}>(×{CLASS_FARE_MULTIPLIERS[cls]})</span>
              </div>
            );
          })}
        </div>
        {cfg?.seatQuality && cfg.seatQuality !== 'standard' && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
            Seat quality: <span style={{ color: 'var(--yellow)', fontWeight: 600, textTransform: 'capitalize' }}>{cfg.seatQuality}</span>
            {' · '}
            Service: <span style={{ color: 'var(--yellow)', fontWeight: 600, textTransform: 'capitalize' }}>{cfg.serviceQuality}</span>
          </div>
        )}
      </div>

      {/* ── Actions ───────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, paddingTop: 16, borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={onConfigure}>Configure Cabin</button>
        {(aircraftRoutes.length > 0 || (state.cargoRoutes ?? []).some(r => r.aircraftId === aircraft.id)) && (
          <button className="btn" onClick={() => setShowTransfer(true)}>
            Transfer Routes
          </button>
        )}
        {aircraft.ownershipType === 'owned' && (
          <button
            className="btn"
            style={{ background: 'rgba(255,180,61,.1)', color: 'var(--yellow)', border: '1px solid rgba(255,180,61,.3)' }}
            onClick={onSell}
          >
            Sell Aircraft
          </button>
        )}
        <button
          className="btn"
          style={{ background: 'rgba(248,81,73,.1)', color: 'var(--red)', border: '1px solid rgba(248,81,73,.3)' }}
          onClick={onRetire}
        >
          {aircraft.ownershipType === 'owned' ? 'Scrap / Write Off' : 'Return Aircraft'}
        </button>
      </div>

      {showTransfer && <TransferRoutesModal aircraft={aircraft} onClose={() => setShowTransfer(false)} />}
    </div>
  );
}

// ─── Main Fleet page ──────────────────────────────────────────────────────────

const DELIVERY_LEAD = { 'Wide Body': 4, 'Narrow Body': 3, 'Regional Jet': 2, 'Turboprop': 1 };
const CATEGORY_ORDER = ['Turboprop', 'Regional Jet', 'Narrow Body', 'Wide Body'];

// ─── By Type view ─────────────────────────────────────────────────────────────

function FleetByType({ fleet, routes, cargoRoutes = [] }) {
  const gd = { year: 1, week: 1 }; // just for label purposes
  // Group by typeId
  const groups = {};
  for (const aircraft of fleet) {
    if (!groups[aircraft.typeId]) groups[aircraft.typeId] = [];
    groups[aircraft.typeId].push(aircraft);
  }
  // Sort groups: by category order then name
  const sorted = Object.entries(groups).sort(([aId, aList], [bId, bList]) => {
    const aType = getAircraftType(aId);
    const bType = getAircraftType(bId);
    const aCat  = CATEGORY_ORDER.indexOf(aType?.category);
    const bCat  = CATEGORY_ORDER.indexOf(bType?.category);
    if (aCat !== bCat) return aCat - bCat;
    return (aType?.name ?? '').localeCompare(bType?.name ?? '');
  });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
      {sorted.map(([typeId, aircraft]) => {
        const type     = getAircraftType(typeId);
        const catColor = CAT_COLORS[type?.category] || '#93a4ba';
        const count    = aircraft.length;
        const owned    = aircraft.filter(a => a.ownershipType === 'owned').length;
        const leased   = count - owned;
        const idle     = aircraft.filter(a => a.status === 'idle').length;
        const grounded = aircraft.filter(a => a.status === 'grounded').length;
        const avgAgeWks = aircraft.reduce((s, a) => s + (a.ageWeeks ?? 0), 0) / count;
        const avgAgeYrs = avgAgeWks / 52;
        const ageColor  = avgAgeYrs < 5 ? 'var(--green)' : avgAgeYrs < 12 ? 'var(--yellow)' : 'var(--red)';

        // Total seats across fleet
        const totalSeats = aircraft.reduce((s, a) => {
          const cfg = a.config;
          const seats = cfg
            ? Object.values(cfg).filter(v => typeof v === 'number').reduce((x, y) => x + y, 0) || (type?.seats ?? 0)
            : (type?.seats ?? 0);
          return s + seats;
        }, 0);

        // Total weekly fixed costs
        const totalFixed = aircraft.reduce((s, a) => {
          const lease = a.ownershipType === 'owned' ? 0 : (type?.weeklyLease ?? 0);
          const maint = Math.round((type?.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(a.ageWeeks ?? 0));
          return s + lease + maint;
        }, 0);

        // Avg utilisation
        const allBlockHrs = aircraft.map(a => {
          const aRoutes = [...routes, ...cargoRoutes].filter(r => r.aircraftId === a.id);
          return type
            ? aRoutes.reduce((s, r) => s + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, type), 0)
            : 0;
        });
        const avgBlock  = allBlockHrs.reduce((s, h) => s + h, 0) / count;
        const avgPct    = avgBlock / MAX_WEEKLY_BLOCK_HOURS;
        const blockColor = avgPct >= 0.8 ? 'var(--red)' : avgPct >= 0.5 ? 'var(--yellow)' : avgPct > 0 ? 'var(--accent)' : 'var(--surface3)';

        return (
          <div key={typeId} className="card" style={{ padding: '16px 18px', borderTop: `3px solid ${catColor}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <AircraftThumb type={type} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{type?.name ?? typeId}</div>
                <div style={{ fontSize: 12, color: catColor, fontWeight: 600 }}>{type?.category}</div>
              </div>
              <div style={{
                fontWeight: 700, fontSize: 28, color: catColor, lineHeight: 1,
                background: `${catColor}14`, borderRadius: 8, padding: '4px 10px',
              }}>{count}</div>
            </div>

            {/* Utilisation bar */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                <span>Avg utilisation</span>
                <span style={{ color: blockColor, fontWeight: 600 }}>{avgBlock.toFixed(1)}h / {MAX_WEEKLY_BLOCK_HOURS}h</span>
              </div>
              <div style={{ height: 5, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, avgPct * 100)}%`, background: blockColor, borderRadius: 3, transition: 'width 0.3s' }} />
              </div>
            </div>

            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Avg age</div>
                <div style={{ fontWeight: 600, color: ageColor }}>{avgAgeYrs < 1 ? '<1 yr' : `${avgAgeYrs.toFixed(1)} yrs`}</div>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Total seats</div>
                <div style={{ fontWeight: 600 }}>{totalSeats.toLocaleString()}</div>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Ownership</div>
                <div style={{ fontWeight: 600 }}>
                  {owned > 0 && <span style={{ color: 'var(--green)' }}>{owned} owned</span>}
                  {owned > 0 && leased > 0 && <span style={{ color: 'var(--text-dim)' }}> / </span>}
                  {leased > 0 && <span style={{ color: 'var(--accent)' }}>{leased} leased</span>}
                </div>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Fixed / wk</div>
                <div style={{ fontWeight: 600, color: 'var(--red)' }}>−{formatMoney(totalFixed)}</div>
              </div>
            </div>

            {/* Status badges */}
            {(idle > 0 || grounded > 0) && (
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {idle > 0 && (
                  <span className="badge badge-yellow">{idle} idle</span>
                )}
                {grounded > 0 && (
                  <span className="badge" style={{ background: 'rgba(248,81,73,.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,.4)' }}>
                    <Glyph e="🔧" /> {grounded} grounded
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── By Category view ─────────────────────────────────────────────────────────

function FleetByCategory({ fleet, routes, cargoRoutes = [] }) {
  const categories = CATEGORY_ORDER.filter(cat =>
    fleet.some(a => getAircraftType(a.typeId)?.category === cat)
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Fleet composition bar */}
      <div className="card" style={{ padding: '16px 18px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
          Fleet Composition
        </div>
        <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', marginBottom: 10 }}>
          {categories.map(cat => {
            const count = fleet.filter(a => getAircraftType(a.typeId)?.category === cat).length;
            const pct = (count / fleet.length) * 100;
            return (
              <div
                key={cat}
                style={{
                  width: `${pct}%`, background: CAT_COLORS[cat],
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, color: '#fff', overflow: 'hidden', whiteSpace: 'nowrap',
                  transition: 'width 0.3s',
                }}
                title={`${cat}: ${count}`}
              >
                {pct > 10 ? `${cat} (${count})` : pct > 5 ? count : ''}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {categories.map(cat => {
            const count = fleet.filter(a => getAircraftType(a.typeId)?.category === cat).length;
            return (
              <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: CAT_COLORS[cat] }} />
                <span>{cat}: <strong>{count}</strong></span>
                <span style={{ color: 'var(--text-muted)' }}>({((count / fleet.length) * 100).toFixed(0)}%)</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-category breakdown */}
      {categories.map(cat => {
        const catFleet  = fleet.filter(a => getAircraftType(a.typeId)?.category === cat);
        const catColor  = CAT_COLORS[cat];
        const owned     = catFleet.filter(a => a.ownershipType === 'owned').length;
        const leased    = catFleet.length - owned;
        const idle      = catFleet.filter(a => a.status === 'idle').length;
        const grounded  = catFleet.filter(a => a.status === 'grounded').length;
        const avgAgeWks = catFleet.reduce((s, a) => s + (a.ageWeeks ?? 0), 0) / catFleet.length;

        // Types within category
        const typeGroups = {};
        for (const a of catFleet) {
          typeGroups[a.typeId] = (typeGroups[a.typeId] ?? 0) + 1;
        }

        // Total weekly fixed
        const totalFixed = catFleet.reduce((s, a) => {
          const t = getAircraftType(a.typeId);
          const lease = a.ownershipType === 'owned' ? 0 : (t?.weeklyLease ?? 0);
          const maint = Math.round((t?.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(a.ageWeeks ?? 0));
          return s + lease + maint;
        }, 0);

        // Avg utilisation
        const avgBlock = catFleet.reduce((s, a) => {
          const t = getAircraftType(a.typeId);
          const aRoutes = [...routes, ...cargoRoutes].filter(r => r.aircraftId === a.id);
          const bh = t ? aRoutes.reduce((x, r) => x + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, t), 0) : 0;
          return s + bh;
        }, 0) / catFleet.length;
        const avgPct    = avgBlock / MAX_WEEKLY_BLOCK_HOURS;
        const blockColor = avgPct >= 0.8 ? 'var(--red)' : avgPct >= 0.5 ? 'var(--yellow)' : avgPct > 0 ? 'var(--accent)' : 'var(--surface3)';

        return (
          <div key={cat} className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {/* Category header */}
            <div style={{
              padding: '12px 18px', background: `${catColor}12`,
              borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{
                width: 12, height: 12, borderRadius: '50%', background: catColor, flexShrink: 0,
              }} />
              <span style={{ fontWeight: 700, fontSize: 16, color: catColor }}>{cat}</span>
              <span style={{ fontWeight: 700, fontSize: 22, color: catColor, marginLeft: 'auto' }}>{catFleet.length}</span>
            </div>

            <div style={{ padding: '14px 18px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Avg utilisation</div>
                  <div style={{ fontWeight: 600, color: blockColor, marginTop: 2 }}>{avgBlock.toFixed(1)}h / wk</div>
                  <div style={{ height: 3, background: 'var(--surface3)', borderRadius: 2, marginTop: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, avgPct * 100)}%`, background: blockColor, borderRadius: 2 }} />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Avg age</div>
                  <div style={{ fontWeight: 600, marginTop: 2 }}>{(avgAgeWks / 52).toFixed(1)} yrs</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Ownership</div>
                  <div style={{ fontWeight: 600, marginTop: 2, fontSize: 13 }}>
                    {owned > 0 && <span style={{ color: 'var(--green)' }}>{owned}× owned</span>}
                    {owned > 0 && leased > 0 && ' · '}
                    {leased > 0 && <span style={{ color: 'var(--accent)' }}>{leased}× leased</span>}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Fixed / wk</div>
                  <div style={{ fontWeight: 600, color: 'var(--red)', marginTop: 2 }}>−{formatMoney(totalFixed)}</div>
                </div>
              </div>

              {/* Aircraft types within category */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(typeGroups).map(([tid, cnt]) => {
                  const t = getAircraftType(tid);
                  return (
                    <div key={tid} style={{
                      fontSize: 12, padding: '4px 10px', borderRadius: 20,
                      background: `${catColor}14`, border: `1px solid ${catColor}30`,
                      color: 'var(--text)',
                    }}>
                      <span style={{ color: catColor, fontWeight: 700 }}>{cnt}×</span> {t?.name ?? tid}
                    </div>
                  );
                })}
              </div>

              {(idle > 0 || grounded > 0) && (
                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  {idle > 0     && <span className="badge badge-yellow">{idle} idle</span>}
                  {grounded > 0 && (
                    <span className="badge" style={{ background: 'rgba(248,81,73,.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,.4)' }}>
                      <Glyph e="🔧" /> {grounded} grounded
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Fleet page ──────────────────────────────────────────────────────────

export default function Fleet() {
  const { state, dispatch } = useGame();
  const { fleet, routes, cargoRoutes = [], pendingOrders = [], year, week } = state;
  const [selectedId,    setSelectedId]    = useState(null);
  const [configuringId, setConfiguringId] = useState(null);
  const [checkedIds,    setCheckedIds]    = useState([]);   // bulk selection
  const [bulkConfigIds, setBulkConfigIds] = useState(null); // array of ids → bulk configure modal
  const [search,        setSearch]        = useState('');
  const [filterChip,    setFilterChip]    = useState('all'); // all | idle | grounded | leased | owned
  const [filterTypeId,  setFilterTypeId]  = useState(null); // null = all types, or a typeId string
  const [viewMode,      setViewMode]      = useState('list'); // list | byType | byCategory

  function handleSell(aircraftId) {
    const aircraft     = fleet.find(a => a.id === aircraftId);
    const type         = getAircraftType(aircraft?.typeId);
    const activeRoutes = routes.filter(r => r.aircraftId === aircraftId);
    const ageYears     = (aircraft?.ageWeeks ?? 0) / 52;
    const remaining    = Math.max(0.1, 1 - ageYears / DEPRECIATION_YEARS);
    const nav          = Math.round((type?.purchasePrice ?? 0) * remaining);
    const fee          = Math.round(nav * 0.05);
    const proceeds     = nav - fee;

    let msg = activeRoutes.length > 0
      ? `${aircraft.name} is flying ${activeRoutes.length} route${activeRoutes.length > 1 ? 's' : ''} — selling it will close all of them.\n\n`
      : '';

    msg += `Sale price (NAV):  ${formatMoney(nav)}\n`;
    msg += `Selling & admin fee (5%):  −${formatMoney(fee)}\n`;
    msg += `Net proceeds:  ${formatMoney(proceeds)}\n\n`;
    msg += `Sell ${aircraft.name}?`;

    if (window.confirm(msg)) {
      dispatch({ type: 'SELL_AIRCRAFT', aircraftId });
      setSelectedId(null);
    }
  }

  function handleRetire(aircraftId) {
    const aircraft     = fleet.find(a => a.id === aircraftId);
    const type         = getAircraftType(aircraft?.typeId);
    const activeRoutes = routes.filter(r => r.aircraftId === aircraftId);
    const weeksLeft    = aircraft?.leaseRemainingWeeks ?? 0;
    const penalty      = (aircraft?.ownershipType === 'lease' && weeksLeft > 0)
      ? Math.round((type?.weeklyLease ?? 0) * weeksLeft * 0.5)
      : 0;

    let msg = activeRoutes.length > 0
      ? `${aircraft.name} is flying ${activeRoutes.length} route${activeRoutes.length > 1 ? 's' : ''} — returning it will close all of them.\n\n`
      : '';

    if (aircraft?.ownershipType === 'lease' && weeksLeft > 0) {
      msg += `Early termination penalty: ${formatMoney(penalty)} (${weeksLeft} weeks remaining × 50% of lease rate).\n\nReturn ${aircraft.name} and pay ${formatMoney(penalty)}?`;
    } else if (aircraft?.ownershipType === 'lease') {
      msg += `Lease has run its full term — no penalty. Return ${aircraft.name}?`;
    } else {
      msg += `Retire ${aircraft.name}? Weekly charges will stop.`;
    }

    if (window.confirm(msg)) {
      dispatch({ type: 'RETIRE_AIRCRAFT', aircraftId });
      setSelectedId(null);
    }
  }

  function handleCancelOrder(order) {
    const hasRefund = order.ownershipType === 'owned' && order.totalPrice > 0;
    const refund    = hasRefund ? Math.round(order.totalPrice * 0.95) : 0;
    const msg = hasRefund
      ? `Cancel order for ${order.name}? You will receive a refund of ${formatMoney(refund)} (5% cancellation fee).`
      : `Cancel lease order for ${order.name}? Free to cancel before delivery.`;
    if (window.confirm(msg)) {
      dispatch({ type: 'CANCEL_ORDER', orderId: order.id });
    }
  }

  if (fleet.length === 0 && pendingOrders.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon"><Glyph e="🛩️" /></div>
        <div className="empty-state-text">No aircraft yet.</div>
        <div style={{ marginTop: 8, fontSize: 13 }}>Head to <strong>Market</strong> to lease or buy your first aircraft.</div>
      </div>
    );
  }

  const weeklyLeaseTotal = fleet.reduce((s, a) => {
    const t = getAircraftType(a.typeId);
    return s + (a.ownershipType === 'owned' ? 0 : (t?.weeklyLease ?? 0));
  }, 0);
  const weeklyMaintTotal = fleet.reduce((s, a) => {
    const t = getAircraftType(a.typeId);
    return s + Math.round((t?.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(a.ageWeeks));
  }, 0);

  const selectedAircraft = fleet.find(a => a.id === selectedId);

  const currentAbsWeek = absoluteWeek(year, week);

  // Search + filter
  const searchTerm = search.trim().toLowerCase();
  const visibleFleet = fleet.filter(a => {
    const type = getAircraftType(a.typeId);
    if (searchTerm) {
      const hit = (
        a.name.toLowerCase().includes(searchTerm) ||
        (a.tailNumber ?? '').toLowerCase().includes(searchTerm) ||
        (type?.name ?? '').toLowerCase().includes(searchTerm) ||
        (type?.category ?? '').toLowerCase().includes(searchTerm)
      );
      if (!hit) return false;
    }
    if (filterTypeId && a.typeId !== filterTypeId) return false;
    if (filterChip === 'idle')     return a.status === 'idle';
    if (filterChip === 'grounded') return a.status === 'grounded';
    if (filterChip === 'leased')   return a.ownershipType !== 'owned';
    if (filterChip === 'owned')    return a.ownershipType === 'owned';
    return true;
  });

  // ── Bulk selection ──────────────────────────────────────────────────────
  const checkedAircraft   = fleet.filter(a => checkedIds.includes(a.id));
  const allVisibleChecked = visibleFleet.length > 0 && visibleFleet.every(a => checkedIds.includes(a.id));
  const checkedTypeIds    = [...new Set(checkedAircraft.map(a => a.typeId))];
  const canBulkConfigure  = checkedAircraft.length > 0 && checkedTypeIds.length === 1;
  const checkedOwned      = checkedAircraft.filter(a => a.ownershipType === 'owned');

  function toggleChecked(id) {
    setCheckedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  }

  function toggleAllVisible() {
    setCheckedIds(ids => allVisibleChecked
      ? ids.filter(id => !visibleFleet.some(a => a.id === id))
      : [...new Set([...ids, ...visibleFleet.map(a => a.id)])]);
  }

  function sellValue(a) {
    const type      = getAircraftType(a.typeId);
    const ageYears  = (a.ageWeeks ?? 0) / 52;
    const remaining = Math.max(0.1, 1 - ageYears / DEPRECIATION_YEARS);
    const nav       = Math.round((type?.purchasePrice ?? 0) * remaining);
    return nav - Math.round(nav * 0.05);
  }

  function handleBulkSell() {
    if (checkedOwned.length === 0) return;
    const proceeds   = checkedOwned.reduce((s, a) => s + sellValue(a), 0);
    const routeCount = checkedOwned.reduce((s, a) =>
      s + routes.filter(r => r.aircraftId === a.id).length
        + cargoRoutes.filter(r => r.aircraftId === a.id).length, 0);
    const names = checkedOwned.slice(0, 8).map(a => a.name).join(', ')
                + (checkedOwned.length > 8 ? `, +${checkedOwned.length - 8} more` : '');

    let msg = '';
    if (routeCount > 0) msg += `These aircraft fly ${routeCount} route${routeCount > 1 ? 's' : ''} — selling will close all of them.\n\n`;
    msg += `${names}\n\n`;
    msg += `Net proceeds (after 5% fee): ${formatMoney(proceeds)}\n\n`;
    msg += `Sell ${checkedOwned.length} owned aircraft?`;

    if (window.confirm(msg)) {
      for (const a of checkedOwned) dispatch({ type: 'SELL_AIRCRAFT', aircraftId: a.id });
      setCheckedIds([]);
      setSelectedId(null);
    }
  }

  function handleBulkRetire() {
    if (checkedAircraft.length === 0) return;
    let totalPenalty = 0;
    let routeCount   = 0;
    for (const a of checkedAircraft) {
      const type      = getAircraftType(a.typeId);
      const weeksLeft = a.leaseRemainingWeeks ?? 0;
      if (a.ownershipType === 'lease' && weeksLeft > 0) {
        totalPenalty += Math.round((type?.weeklyLease ?? 0) * weeksLeft * 0.5);
      }
      routeCount += routes.filter(r => r.aircraftId === a.id).length
                  + cargoRoutes.filter(r => r.aircraftId === a.id).length;
    }
    const leasedCount = checkedAircraft.filter(a => a.ownershipType !== 'owned').length;
    const ownedCount  = checkedAircraft.length - leasedCount;
    const names = checkedAircraft.slice(0, 8).map(a => a.name).join(', ')
                + (checkedAircraft.length > 8 ? `, +${checkedAircraft.length - 8} more` : '');

    let msg = '';
    if (routeCount > 0) msg += `These aircraft fly ${routeCount} route${routeCount > 1 ? 's' : ''} — removing them will close all of them.\n\n`;
    msg += `${names}\n\n`;
    if (leasedCount > 0) msg += `${leasedCount} leased aircraft will be returned.\n`;
    if (ownedCount  > 0) msg += `${ownedCount} owned aircraft will be retired (no sale proceeds — use Sell to get cash back).\n`;
    if (totalPenalty > 0) msg += `\nTotal early lease termination penalties: ${formatMoney(totalPenalty)}\n`;
    msg += `\nRemove ${checkedAircraft.length} aircraft from the fleet?`;

    if (window.confirm(msg)) {
      for (const a of checkedAircraft) dispatch({ type: 'RETIRE_AIRCRAFT', aircraftId: a.id });
      setCheckedIds([]);
      setSelectedId(null);
    }
  }

  const chipCounts = {
    all:      fleet.length,
    idle:     fleet.filter(a => a.status === 'idle').length,
    grounded: fleet.filter(a => a.status === 'grounded').length,
    leased:   fleet.filter(a => a.ownershipType !== 'owned').length,
    owned:    fleet.filter(a => a.ownershipType === 'owned').length,
  };

  return (
    <div>
      {/* Summary stats */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 16 }}>
        <div className="stat-box">
          <div className="stat-label">Fleet Size</div>
          <div className="stat-value blue">{fleet.length}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Weekly Leases</div>
          <div className="stat-value red">−{formatMoney(weeklyLeaseTotal)}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Weekly Maintenance</div>
          <div className="stat-value red">−{formatMoney(weeklyMaintTotal)}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            Idle Aircraft
            <InfoTip side="bottom" text="Planes not assigned to any route. They still cost lease & maintenance but earn nothing — assign them via the Route Planner or Routes → Open Route." />
          </div>
          <div className="stat-value yellow">{fleet.filter(a => a.status === 'idle').length}</div>
        </div>
        {pendingOrders.length > 0 && (
          <div className="stat-box">
            <div className="stat-label">On Order</div>
            <div className="stat-value" style={{ color: 'var(--yellow)' }}>{pendingOrders.length}</div>
          </div>
        )}
      </div>

      {/* ── By-type summary strip ─────────────────────────────────────────── */}
      {fleet.length > 0 && (() => {
        // Build per-type summaries for the strip
        const typeMap = {};
        for (const a of fleet) {
          if (!typeMap[a.typeId]) typeMap[a.typeId] = [];
          typeMap[a.typeId].push(a);
        }
        const typeSummaries = Object.entries(typeMap).sort(([aId], [bId]) => {
          const at = getAircraftType(aId), bt = getAircraftType(bId);
          const ac = CATEGORY_ORDER.indexOf(at?.category), bc = CATEGORY_ORDER.indexOf(bt?.category);
          return ac !== bc ? ac - bc : (at?.name ?? '').localeCompare(bt?.name ?? '');
        }).map(([typeId, aircraft]) => {
          const type = getAircraftType(typeId);
          const catColor = CAT_COLORS[type?.category] || '#93a4ba';
          const count = aircraft.length;
          const avgAgeYrs = aircraft.reduce((s, a) => s + (a.ageWeeks ?? 0), 0) / count / 52;
          const allBH = aircraft.map(a => {
            const aRoutes = [...routes, ...cargoRoutes].filter(r => r.aircraftId === a.id);
            return type ? aRoutes.reduce((s, r) => s + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, type), 0) : 0;
          });
          const avgUtil = allBH.reduce((s, h) => s + h, 0) / count / MAX_WEEKLY_BLOCK_HOURS;
          const idle = aircraft.filter(a => a.status === 'idle').length;
          return { typeId, type, catColor, count, avgAgeYrs, avgUtil, idle };
        });
        const isActive = (tid) => filterTypeId === tid;
        return (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {typeSummaries.map(({ typeId, type, catColor, count, avgAgeYrs, avgUtil, idle }) => {
              const active = isActive(typeId);
              const utilColor = avgUtil >= 0.8 ? 'var(--red)' : avgUtil >= 0.5 ? 'var(--yellow)' : avgUtil > 0 ? 'var(--accent)' : 'var(--text-dim)';
              return (
                <button
                  key={typeId}
                  onClick={() => { setFilterTypeId(active ? null : typeId); setFilterChip('all'); }}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 4,
                    padding: '8px 12px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                    background: active ? `${catColor}20` : 'var(--surface2)',
                    border: `1px solid ${active ? catColor : 'var(--border)'}`,
                    transition: 'all 0.15s', minWidth: 120,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: catColor, flexShrink: 0 }} />
                    <span style={{ fontWeight: 700, fontSize: 13, color: active ? catColor : 'var(--text)' }}>
                      {type?.name ?? typeId}
                    </span>
                    <span style={{
                      marginLeft: 'auto', fontWeight: 700, fontSize: 15,
                      color: active ? catColor : 'var(--text-muted)',
                    }}>×{count}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                    <span style={{ color: utilColor, fontWeight: 600 }}>{(avgUtil * 100).toFixed(0)}% util</span>
                    <span>{avgAgeYrs < 1 ? '<1yr' : `${avgAgeYrs.toFixed(1)}yr`} avg</span>
                    {idle > 0 && <span style={{ color: 'var(--yellow)' }}>{idle} idle</span>}
                  </div>
                  {/* Mini util bar */}
                  <div style={{ height: 3, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, avgUtil * 100)}%`, background: utilColor, borderRadius: 2 }} />
                  </div>
                </button>
              );
            })}
            {filterTypeId && (
              <button
                onClick={() => setFilterTypeId(null)}
                className="btn btn-ghost"
                style={{ alignSelf: 'center', fontSize: 12 }}
              >
                <Glyph e="✕" /> Clear type filter
              </button>
            )}
          </div>
        );
      })()}

      {/* Toolbar: view switcher + search/filter */}
      {fleet.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Left: search + filter (only for list view) */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {viewMode === 'list' && (
              <>
                <input
                  className="form-input"
                  placeholder="Search name, type, tail…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ width: 210, flexShrink: 0 }}
                />
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {[
                    { id: 'all',      label: 'All'      },
                    { id: 'idle',     label: '⏸ Idle'  },
                    { id: 'grounded', label: '🔧 Grnd'  },
                    { id: 'leased',   label: 'Leased'   },
                    { id: 'owned',    label: 'Owned'    },
                  ].filter(c => chipCounts[c.id] > 0 || c.id === 'all').map(c => (
                    <button
                      key={c.id}
                      className={`btn ${filterChip === c.id ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => setFilterChip(c.id)}
                    >
                      <GlyphLabel text={c.label} size={12} />
                      {c.id !== 'all' && chipCounts[c.id] > 0 && (
                        <span style={{ marginLeft: 5, opacity: 0.65, fontSize: 11 }}>{chipCounts[c.id]}</span>
                      )}
                      {c.id === 'all' && (
                        <span style={{ marginLeft: 5, opacity: 0.65, fontSize: 11 }}>{chipCounts.all}</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Right: view mode switcher */}
          <div style={{ display: 'flex', gap: 2, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
            {[
              { id: 'list',        label: '☰ List'       },
              { id: 'byType',      label: '✈ By Type'    },
              { id: 'byCategory',  label: '◈ By Category'},
            ].map(v => (
              <button
                key={v.id}
                className={`btn ${viewMode === v.id ? 'btn-primary' : 'btn-ghost'}`}
                style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6 }}
                onClick={() => setViewMode(v.id)}
              >
                <GlyphLabel text={v.label} size={12} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── On Order panel ─────────────────────────────────────────────────── */}
      {pendingOrders.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
          <div style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--border)',
            fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.07em',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span><Glyph e="📦" /></span><span>On Order ({pendingOrders.length})</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Aircraft</th>
                <th>Engine</th>
                <th>Type</th>
                <th>Delivery</th>
                <th>Progress</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pendingOrders.map(order => {
                const type       = getAircraftType(order.typeId);
                const catColor   = CAT_COLORS[type?.category] || '#93a4ba';
                const weeksLeft  = order.deliverAbsWeek - currentAbsWeek;
                const lead       = DELIVERY_LEAD[type?.category] ?? 2;
                // Use this order's ACTUAL total lead (first-of-type = 2×lead, stacked = +lead),
                // not the flat category constant, so progress isn't stuck at 0% early on.
                const totalLead  = (order.orderedWeek != null && order.orderedYear != null)
                  ? Math.max(1, order.deliverAbsWeek - absoluteWeek(order.orderedYear, order.orderedWeek))
                  : lead;
                const progress   = Math.max(0, Math.min(1, 1 - (weeksLeft / totalLead)));
                const deliverY   = Math.floor((order.deliverAbsWeek - 1) / 52) + 1;
                const _dWIY      = ((order.deliverAbsWeek - 1) % 52) + 1;
                const { monthName: deliverMon, weekInMonth: deliverWIM } = weekToGameDate(_dWIY);
                return (
                  <tr key={order.id}>
                    <td>
                      <strong>{order.name}</strong>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>
                        <span style={{
                          color: order.ownershipType === 'owned' ? 'var(--green)' : 'var(--accent)',
                          fontWeight: 600, marginRight: 4,
                        }}>
                          {order.ownershipType === 'owned' ? 'Purchase' : 'Lease'}
                        </span>
                        {order.hasWingtips && '· Wingtips'}
                      </div>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {order.engineLabel ?? '—'}
                    </td>
                    <td>
                      <span style={{ fontSize: 12, color: catColor, fontWeight: 600 }}>
                        {type?.category ?? '?'}
                      </span>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <span style={{ color: weeksLeft <= 1 ? 'var(--green)' : 'var(--text)', fontWeight: 600 }}>
                        {weeksLeft <= 0 ? 'Arriving…' : `${weeksLeft}w`}
                      </span>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>
                        Wk {deliverWIM} {deliverMon} Y{deliverY}
                      </div>
                    </td>
                    <td style={{ minWidth: 100 }}>
                      <div style={{ height: 4, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', width: `${progress * 100}%`,
                          background: catColor, borderRadius: 2, transition: 'width 0.3s',
                        }} />
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>
                        {Math.round(progress * 100)}% complete
                      </div>
                    </td>
                    <td>
                      <button
                        className="btn"
                        style={{
                          padding: '3px 10px', fontSize: 11,
                          background: 'rgba(248,81,73,0.08)',
                          color: 'var(--red)',
                          border: '1px solid rgba(248,81,73,0.3)',
                        }}
                        onClick={() => handleCancelOrder(order)}
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* By Type view */}
      {viewMode === 'byType' && (
        <FleetByType fleet={fleet} routes={routes} cargoRoutes={cargoRoutes} />
      )}

      {/* By Category view */}
      {viewMode === 'byCategory' && (
        <FleetByCategory fleet={fleet} routes={routes} cargoRoutes={cargoRoutes} />
      )}

      {/* Aircraft list + detail panel */}
      {viewMode === 'list' && <>
      {/* Bulk action bar */}
      {checkedAircraft.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '10px 14px', marginBottom: 10, borderRadius: 8,
          background: 'rgba(56,139,253,0.08)', border: '1px solid var(--accent-dim)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
            {checkedAircraft.length} selected
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {checkedOwned.length} owned · {checkedAircraft.length - checkedOwned.length} leased
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn"
              style={{
                fontSize: 12, padding: '5px 12px',
                background: canBulkConfigure ? 'rgba(56,139,253,0.15)' : 'var(--surface3)',
                color: canBulkConfigure ? 'var(--accent)' : 'var(--text-dim)',
                border: `1px solid ${canBulkConfigure ? 'rgba(56,139,253,0.4)' : 'var(--border)'}`,
                cursor: canBulkConfigure ? 'pointer' : 'not-allowed',
              }}
              disabled={!canBulkConfigure}
              title={canBulkConfigure ? 'Apply one cabin layout to all selected aircraft' : 'Select aircraft of a single type to bulk-configure'}
              onClick={() => canBulkConfigure && setBulkConfigIds(checkedAircraft.map(a => a.id))}
            >
              <Glyph e="⚙" /> Configure ({checkedAircraft.length})
            </button>
            <button
              className="btn"
              style={{
                fontSize: 12, padding: '5px 12px',
                background: checkedOwned.length > 0 ? 'rgba(63,185,80,0.12)' : 'var(--surface3)',
                color: checkedOwned.length > 0 ? 'var(--green)' : 'var(--text-dim)',
                border: `1px solid ${checkedOwned.length > 0 ? 'rgba(63,185,80,0.35)' : 'var(--border)'}`,
                cursor: checkedOwned.length > 0 ? 'pointer' : 'not-allowed',
              }}
              disabled={checkedOwned.length === 0}
              title={checkedOwned.length > 0 ? 'Sell all selected owned aircraft at NAV minus 5% fee' : 'Only owned aircraft can be sold'}
              onClick={handleBulkSell}
            >
              Sell owned ({checkedOwned.length})
            </button>
            <button
              className="btn"
              style={{
                fontSize: 12, padding: '5px 12px',
                background: 'rgba(248,81,73,0.08)', color: 'var(--red)',
                border: '1px solid rgba(248,81,73,0.3)', cursor: 'pointer',
              }}
              title="Return leased / retire owned aircraft"
              onClick={handleBulkRetire}
            >
              Return / Retire ({checkedAircraft.length})
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: '5px 10px' }}
              onClick={() => setCheckedIds([])}
            >
              <Glyph e="✕" /> Clear
            </button>
          </div>
        </div>
      )}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 34, textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={allVisibleChecked}
                  onChange={toggleAllVisible}
                  title={allVisibleChecked ? 'Deselect all' : 'Select all visible'}
                  style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                />
              </th>
              <th style={{ width: 88 }}></th>
              <th>Aircraft</th>
              <th>Type</th>
              <th>Cabin</th>
              <th>Age</th>
              <th>Util.</th>
              <th>Fixed/wk</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleFleet.length === 0 ? (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: 13 }}>
                No aircraft match — <button className="btn btn-ghost" style={{ fontSize: 12, display: 'inline' }} onClick={() => { setSearch(''); setFilterChip('all'); }}>clear filters</button>
              </td></tr>
            ) : null}
            {visibleFleet.map(aircraft => {
              const type   = getAircraftType(aircraft.typeId);
              const route  = routes.find(r => r.aircraftId === aircraft.id);
              const ageWks = aircraft.ageWeeks ?? 0;
              const maintM = maintenanceMultiplier(ageWks);
              const maint  = Math.round((type?.baseMaintenancePerWk ?? 0) * maintM);
              const lease  = aircraft.ownershipType === 'owned' ? 0 : (type?.weeklyLease ?? 0);
              const ageYrs = ageWks / 52;
              const ageColor = ageYrs < 5 ? 'var(--green)' : ageYrs < 12 ? 'var(--yellow)' : 'var(--red)';

              // Block hours — sum across ALL routes (passenger + cargo) for this aircraft
              const allRoutes = routes.filter(r => r.aircraftId === aircraft.id);
              const allCargo  = cargoRoutes.filter(r => r.aircraftId === aircraft.id);
              const assignedRoutes = [...allRoutes, ...allCargo];
              const blockHrs = type
                ? assignedRoutes.reduce((s, r) => {
                    const dist = routeDistanceKm(r.origin, r.destination);
                    return s + weeklyBlockHours(dist, r.weeklyFrequency, type);
                  }, 0)
                : 0;
              const blockPct   = blockHrs / MAX_WEEKLY_BLOCK_HOURS;
              const blockColor = blockPct >= 0.95 ? 'var(--red)' : blockPct >= 0.75 ? 'var(--yellow)' : 'var(--accent)';

              // Cabin summary
              const cfg = aircraft.config;
              const cabinParts = [];
              if (cfg?.firstClass     > 0) cabinParts.push(`${cfg.firstClass}F`);
              if (cfg?.businessClass  > 0) cabinParts.push(`${cfg.businessClass}J`);
              if (cfg?.premiumEconomy > 0) cabinParts.push(`${cfg.premiumEconomy}W`);
              if (cfg?.economy        > 0) cabinParts.push(`${cfg.economy}Y`);
              const cabinStr = cabinParts.length > 0 ? cabinParts.join('/') : `${type?.seats ?? '?'}Y`;

              const isSelected      = selectedId === aircraft.id;
              const leaseRemaining  = aircraft.ownershipType === 'lease' ? (aircraft.leaseRemainingWeeks ?? null) : null;
              const leaseTerm       = aircraft.leaseTermWeeks ?? null;
              const leaseUrgent     = leaseRemaining !== null && leaseRemaining <= 4;
              const leaseWarning    = leaseRemaining !== null && leaseRemaining <= 8 && leaseRemaining > 4;
              const leaseRowBg      = leaseUrgent   ? 'rgba(248,81,73,0.06)'
                                    : leaseWarning  ? 'rgba(210,153,34,0.06)'
                                    : undefined;

              return (
                <tr
                  key={aircraft.id}
                  style={{
                    cursor: 'pointer',
                    background: isSelected ? 'rgba(56,139,253,0.08)' : leaseRowBg,
                    borderLeft: isSelected ? '2px solid var(--accent)'
                              : leaseUrgent ? '2px solid var(--red)'
                              : leaseWarning ? '2px solid var(--yellow)'
                              : '2px solid transparent',
                    transition: 'background 0.15s',
                  }}
                  onClick={() => setSelectedId(isSelected ? null : aircraft.id)}
                >
                  <td
                    style={{ textAlign: 'center', padding: '6px 4px' }}
                    onClick={e => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={checkedIds.includes(aircraft.id)}
                      onChange={() => toggleChecked(aircraft.id)}
                      style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                    />
                  </td>
                  <td style={{ padding: '6px 8px 6px 12px' }}>
                    <AircraftThumb type={type} />
                  </td>
                  <td>
                    <strong>{aircraft.name}</strong>
                    {aircraft.tailNumber && (
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'monospace', marginTop: 1, letterSpacing: '0.05em' }}>
                        {aircraft.tailNumber}
                      </div>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{type?.name ?? '?'}</td>
                  <td style={{ fontSize: 12 }}>{cabinStr}</td>
                  <td>
                    <span style={{ color: ageColor, fontWeight: 600 }}>{ageLabel(ageWks)}</span>
                  </td>
                  <td>
                    {blockHrs > 0 ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 44, height: 4, borderRadius: 2, background: 'var(--surface3)', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.min(100, blockPct * 100)}%`, background: blockColor, borderRadius: 2 }} />
                        </div>
                        <span style={{ fontSize: 11, color: blockColor }}>{blockHrs.toFixed(0)}h</span>
                      </div>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>—</span>
                    )}
                  </td>
                  <td style={{ color: 'var(--red)', fontSize: 12 }}>
                    {formatMoney(lease + maint)}
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {aircraft.status === 'grounded' ? (
                        <span className="badge" style={{ background: 'rgba(248,81,73,.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,.4)' }}>
                          <Glyph e="🔧" /> Grounded {aircraft.groundedWeeksLeft > 0 ? `(${aircraft.groundedWeeksLeft}w)` : ''}
                        </span>
                      ) : assignedRoutes.length > 0 ? (
                        assignedRoutes.length === 1 ? (
                          allCargo.length === 1
                            ? <span className="badge" style={{ background: 'rgba(232,131,58,.15)', color: '#e8833a', border: '1px solid rgba(232,131,58,.4)' }}><Glyph e="📦" /> {allCargo[0].origin}→{allCargo[0].destination}</span>
                            : <span className="badge badge-green">{allRoutes[0].origin}→{allRoutes[0].destination}</span>
                        ) : (
                          <span className="badge badge-green">{assignedRoutes.length} routes</span>
                        )
                      ) : (
                        <span className="badge badge-yellow">Idle</span>
                      )}
                      {leaseRemaining !== null && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{
                            fontSize: 10, fontWeight: 600,
                            color: leaseUrgent ? 'var(--red)' : leaseWarning ? 'var(--yellow)' : 'var(--text-dim)',
                          }}>
                            {leaseUrgent && <><Glyph e="⚠" size={10} /> </>}{leaseRemaining}w lease
                          </span>
                          {leaseRemaining <= 8 && (
                            <button
                              className="btn btn-ghost"
                              style={{ fontSize: 10, padding: '1px 6px', color: 'var(--accent)' }}
                              onClick={e => { e.stopPropagation(); dispatch({ type: 'RENEW_LEASE', aircraftId: aircraft.id }); }}
                            >
                              Renew
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>
        F = First · J = Business · W = Prem-Eco · Y = Economy · Click any row to see details
      </div>

      {/* Detail panel */}
      {selectedAircraft && (
        <div style={{ marginTop: 16 }}>
          <AircraftDetail
            aircraft={selectedAircraft}
            onClose={() => setSelectedId(null)}
            onConfigure={() => setConfiguringId(selectedAircraft.id)}
            onRetire={() => handleRetire(selectedAircraft.id)}
            onSell={() => handleSell(selectedAircraft.id)}
          />
        </div>
      )}
      </>}

      {/* FleetConfig modal */}
      {configuringId && (
        <FleetConfig
          aircraftId={configuringId}
          onClose={() => setConfiguringId(null)}
        />
      )}

      {/* Bulk FleetConfig modal */}
      {bulkConfigIds && (
        <FleetConfig
          aircraftIds={bulkConfigIds}
          onClose={() => { setBulkConfigIds(null); setCheckedIds([]); }}
        />
      )}
    </div>
  );
}
