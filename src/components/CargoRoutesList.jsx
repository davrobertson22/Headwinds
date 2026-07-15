import { useGame, cargoFrequencyChangeBlockReason } from '../store/GameContext.jsx';
import AirportLink from './AirportLink.jsx';
import { getAircraftType } from '../data/aircraft.js';
import { simulateCargoRoute, formatMoney, formatPercent, currentGameDate } from '../utils/simulation.js';
import { Glyph, GlyphLabel } from './Icons.jsx';
import { useToast } from './ToastSystem.jsx';

const ACCENT = '#e8833a';

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

export default function CargoRoutesList() {
  const { state, dispatch } = useGame();
  const addToast = useToast();
  const { cargoRoutes = [], fleet } = state;
  const gd = currentGameDate(state);

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
  function close(route) {
    if (window.confirm(`Close cargo route ${route.origin} → ${route.destination}? The freighter will return to idle.`)) {
      dispatch({ type: 'CLOSE_CARGO_ROUTE', routeId: route.id });
    }
  }

  // Sort by profit descending
  const rows = cargoRoutes.map(route => {
    const aircraft = fleet.find(a => a.id === route.aircraftId);
    const type     = aircraft ? getAircraftType(aircraft.typeId) : null;
    const sim      = aircraft ? simulateCargoRoute(route, aircraft, gd) : null;
    return { route, aircraft, type, sim };
  }).sort((a, b) => (b.sim?.profit ?? -Infinity) - (a.sim?.profit ?? -Infinity));

  const totalRev    = rows.reduce((s, r) => s + (r.sim?.revenue ?? 0), 0);
  const totalProfit = rows.reduce((s, r) => s + (r.sim?.profit ?? 0), 0);
  const totalTonnes = rows.reduce((s, r) => s + (r.sim?.tonnes ?? 0), 0);

  return (
    <div>
      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 14, padding: '10px 14px', background: 'var(--surface2)', borderRadius: 'var(--radius)', border: `1px solid ${ACCENT}33` }}>
        <div><span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Cargo routes</span><div style={{ fontWeight: 700, fontSize: 15 }}>{cargoRoutes.length}</div></div>
        <div><span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Tonnes / wk</span><div style={{ fontWeight: 700, fontSize: 15, color: ACCENT }}>{totalTonnes.toLocaleString()}</div></div>
        <div><span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Freight revenue</span><div style={{ fontWeight: 700, fontSize: 15, color: 'var(--green)' }}>{formatMoney(totalRev)}</div></div>
        <div><span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Var. profit / wk</span><div style={{ fontWeight: 700, fontSize: 15, color: totalProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>{(totalProfit >= 0 ? '+' : '') + formatMoney(totalProfit)}</div></div>
      </div>

      {rows.map(({ route, aircraft, type, sim }) => {
        const perKg = (route.yieldPrice * (sim?.distance ?? 0) / 1000);
        const lf    = sim?.loadFactor ?? 0;
        const lfColor = lf >= 0.75 ? 'var(--green)' : lf >= 0.45 ? 'var(--yellow)' : 'var(--red)';
        return (
          <div key={route.id} className="card" style={{ marginBottom: 10, borderLeft: `3px solid ${ACCENT}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              {/* Left: identity */}
              <div style={{ minWidth: 220 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 17, fontWeight: 700 }}>
                  <AirportLink code={route.origin} /> <span style={{ color: ACCENT }}>→</span> <AirportLink code={route.destination} />
                  <FreightBadge />
                  {aircraft?.status === 'grounded' && (
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                      background: 'rgba(248,81,73,0.15)', color: 'var(--red)',
                      border: '1px solid rgba(248,81,73,0.3)',
                      textTransform: 'uppercase', letterSpacing: '.04em',
                    }} title="In repair — automatically resumes this route when fixed">
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
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Flights/wk</span>
                <button
                  className="btn btn-ghost"
                  style={{ padding: '2px 9px', opacity: route.weeklyFrequency > 1 ? 1 : 0.4, cursor: route.weeklyFrequency > 1 ? 'pointer' : 'not-allowed' }}
                  disabled={route.weeklyFrequency <= 1}
                  title={route.weeklyFrequency > 1 ? 'One fewer flight per week' : 'At the minimum — use Close route to stand the freighter down'}
                  onClick={() => adjFreq(route, -1)}
                >−</button>
                <span style={{ fontWeight: 700, minWidth: 22, textAlign: 'center' }}>{route.weeklyFrequency}</span>
                {(() => {
                  const upBlock = cargoFrequencyChangeBlockReason(state, route.id, route.weeklyFrequency + 1);
                  return (
                    <button
                      className="btn btn-ghost"
                      style={{ padding: '2px 9px', opacity: upBlock ? 0.4 : 1, cursor: upBlock ? 'not-allowed' : 'pointer' }}
                      title={upBlock || 'One more flight per week'}
                      onClick={() => adjFreq(route, +1)}
                    >+</button>
                  );
                })()}
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
          </div>
        );
      })}
    </div>
  );
}
