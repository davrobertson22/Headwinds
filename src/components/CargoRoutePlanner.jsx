import { useState, useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../data/aircraft.js';
import { simulateCargoRoute, formatMoney, formatPercent } from '../utils/simulation.js';
import { cargoCityPairDemand, cargoReferenceYield, routeDistance } from '../utils/market.js';
import { routeLaunchCost } from '../data/overhead.js';
import { Glyph } from './Icons.jsx';

// ─── Passenger / Freight mode toggle (shared with RoutePlanner) ─────────────────

export function ModeToggle({ mode, setMode }) {
  const opts = [
    { id: 'passenger', label: 'Passenger',  icon: '🧍' },
    { id: 'tag',       label: 'Multi-stop', icon: '🔗' },
    { id: 'freight',   label: 'Freight',    icon: '📦' },
  ];
  return (
    <div style={{ display: 'inline-flex', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 3, gap: 3, marginBottom: 12 }}>
      {opts.map(o => {
        const active = mode === o.id;
        const accent = o.id === 'freight' ? '#e8833a' : o.id === 'tag' ? 'var(--purple)' : 'var(--accent)';
        return (
          <button
            key={o.id}
            onClick={() => setMode(o.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '7px 16px',
              borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              background: active ? `${accent}22` : 'transparent',
              color: active ? accent : 'var(--text-muted)',
              boxShadow: active ? `inset 0 0 0 1px ${accent}55` : 'none',
              transition: 'all 0.15s',
            }}
          >
            <span style={{ display: 'inline-flex', marginRight: 5 }}><Glyph e={o.icon} size={14} /></span>{o.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Compact airport picker (self-contained to avoid cross-imports) ─────────────

function AirportPicker({ label, value, onChange, exclude }) {
  const [query, setQuery] = useState('');
  const [open, setOpen]   = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return AIRPORTS
      .filter(a => a.code !== exclude)
      .filter(a => !q || a.code.includes(q) || a.city.toUpperCase().includes(q) || a.name.toUpperCase().includes(q))
      .slice(0, 12);
  }, [query, exclude]);

  const selected = getAirport(value);

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
      <div className="form-label" style={{ marginBottom: 6 }}>{label}</div>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface2)', border: `1px solid ${open ? '#e8833a' : 'var(--border)'}`, borderRadius: 'var(--radius)', padding: '8px 12px', cursor: 'pointer' }}
        onClick={() => setOpen(v => !v)}
      >
        {selected ? (
          <>
            <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: -0.5 }}>{selected.code}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{selected.city}</span>
          </>
        ) : (
          <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>Select airport…</span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 11 }}>▾</span>
      </div>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 100, background: 'var(--surface2)', border: '1px solid #e8833a', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', overflow: 'hidden' }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
            <input autoFocus className="form-input" placeholder="Search city or IATA code…" value={query}
              onChange={e => setQuery(e.target.value)} onClick={e => e.stopPropagation()} style={{ width: '100%' }} />
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.map(a => (
              <div key={a.code} onClick={() => { onChange(a.code); setQuery(''); setOpen(false); }}
                style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center', background: a.code === value ? 'rgba(232,131,58,0.12)' : 'transparent' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface3)'}
                onMouseLeave={e => e.currentTarget.style.background = a.code === value ? 'rgba(232,131,58,0.12)' : 'transparent'}>
                <span style={{ fontWeight: 700, fontSize: 15, width: 36, flexShrink: 0 }}>{a.code}</span>
                <div>
                  <div style={{ fontSize: 13 }}>{a.city}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{a.name}</div>
                </div>
              </div>
            ))}
            {filtered.length === 0 && <div style={{ padding: 16, color: 'var(--text-dim)', fontSize: 13, textAlign: 'center' }}>No airports found</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ minWidth: 80 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: color ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

const ACCENT = '#e8833a';

// ─── Main cargo planner ─────────────────────────────────────────────────────────

export default function CargoRoutePlanner({ mode, setMode }) {
  const { state, dispatch } = useGame();

  const [origin, setOrigin]   = useState('');
  const [dest,   setDest]     = useState('');
  const [selectedTypeId, setSelectedTypeId] = useState('');
  const [frequency, setFrequency] = useState(7);
  const [yieldPrice, setYieldPrice] = useState(null); // null = auto reference yield

  const originAirport = getAirport(origin);
  const destAirport   = getAirport(dest);
  const ready         = !!(originAirport && destAirport);

  const routeData = useMemo(() => {
    if (!ready) return null;
    const dist     = routeDistance(origin, dest);
    const refYield = cargoReferenceYield(origin, dest);
    const demand   = cargoCityPairDemand(origin, dest);
    return { dist, refYield, demand };
  }, [origin, dest, ready]);

  const effectiveYield = yieldPrice ?? routeData?.refYield ?? 0.5;

  const alreadyActive = useMemo(() =>
    (state.cargoRoutes ?? []).some(r =>
      (r.origin === origin && r.destination === dest) || (r.origin === dest && r.destination === origin)),
    [state.cargoRoutes, origin, dest]
  );

  // Freighter types that can reach this route
  const reachableTypes = useMemo(() => {
    if (!routeData) return [];
    return AIRCRAFT_TYPES.filter(t => t.freighter && t.range >= routeData.dist);
  }, [routeData]);

  useMemo(() => {
    if (reachableTypes.length && !reachableTypes.find(t => t.id === selectedTypeId)) {
      setSelectedTypeId(reachableTypes[0]?.id ?? '');
    }
  }, [reachableTypes]);

  // Idle freighters by type
  const idleByType = useMemo(() => {
    const map = {};
    state.fleet.filter(a => a.status === 'idle' && getAircraftType(a.typeId)?.freighter)
      .forEach(a => { (map[a.typeId] = map[a.typeId] ?? []).push(a); });
    return map;
  }, [state.fleet]);

  const simulation = useMemo(() => {
    if (!routeData || !selectedTypeId) return null;
    const type = getAircraftType(selectedTypeId);
    if (!type || routeData.dist > type.range) return null;
    const route = { id: 'p', origin, destination: dest, aircraftId: 'p', weeklyFrequency: frequency, yieldPrice: effectiveYield, weeksOpen: 20 };
    const ac    = { id: 'p', typeId: selectedTypeId, ageWeeks: 0 };
    const result       = simulateCargoRoute(route, ac, { month: 6 });
    const resultLaunch = simulateCargoRoute({ ...route, weeksOpen: 0 }, ac, { month: 6 });
    if (!result) return null;
    const netProfit = result.profit - type.weeklyLease; // approx (excludes landing/maint; shown separately)
    return { result, resultLaunch, type, netProfit };
  }, [routeData, selectedTypeId, frequency, effectiveYield, origin, dest]);

  function handleOpenRoute(aircraftId) {
    dispatch({ type: 'ADD_CARGO_ROUTE', origin, destination: dest, aircraftId, weeklyFrequency: frequency, yieldPrice: effectiveYield });
  }
  function handleSwap() { const o = origin; setOrigin(dest); setDest(o); setYieldPrice(null); }

  const yieldPct  = routeData ? Math.round((effectiveYield / routeData.refYield - 1) * 100) : 0;
  const perKg     = routeData ? (effectiveYield * routeData.dist / 1000) : 0;

  return (
    <div>
      <ModeToggle mode={mode} setMode={setMode} />

      {/* Route picker */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <AirportPicker label="From" value={origin} onChange={c => { setOrigin(c); setYieldPrice(null); }} exclude={dest} />
          <button className="btn btn-ghost" style={{ padding: '8px 10px', marginBottom: 2, fontSize: 18, flexShrink: 0 }} onClick={handleSwap} disabled={!origin || !dest} title="Swap airports">⇄</button>
          <AirportPicker label="To" value={dest} onChange={c => { setDest(c); setYieldPrice(null); }} exclude={origin} />
        </div>
      </div>

      {!ready && (
        <div className="empty-state" style={{ marginTop: 32 }}>
          <div className="empty-state-icon"><Glyph e="📦" /></div>
          <div className="empty-state-text">Select two airports to analyse a freight lane</div>
          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>
            Cargo demand is driven by trade, not tourism — manufacturing and gateway hubs ship the most.
          </div>
        </div>
      )}

      {ready && routeData && (
        <>
          {/* Cargo market overview */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.3 }}>
                  {origin} → {dest}
                  <span style={{ marginLeft: 10, fontSize: 12, background: `${ACCENT}22`, color: ACCENT, borderRadius: 4, padding: '2px 8px', fontWeight: 600, verticalAlign: 'middle' }}><Glyph e="📦" /> Freight</span>
                  {alreadyActive && (
                    <span style={{ marginLeft: 8, fontSize: 12, background: 'rgba(56,139,253,0.15)', color: 'var(--accent)', borderRadius: 4, padding: '2px 8px', fontWeight: 600, verticalAlign: 'middle' }}>Operating</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                  {originAirport.city} → {destAirport.city} · {routeData.dist.toLocaleString()} km
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <Stat label="Cargo Demand" value={`${routeData.demand.toLocaleString()} t`} sub="tonnes / wk one-way" color={ACCENT} />
              <Stat label="Ref Yield"    value={`$${routeData.refYield.toFixed(3)}`} sub="per tonne-km" />
              <Stat label="≈ Rate"       value={`$${(routeData.refYield * routeData.dist / 1000).toFixed(2)}`} sub="per kg (ref)" />
            </div>
          </div>

          {/* Economics */}
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: 14 }}>Your estimated freight economics</div>
            {reachableTypes.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                No freighter can reach {origin} → {dest} ({routeData.dist.toLocaleString()} km). Lease a longer-range freighter from the Market first.
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 20, alignItems: 'flex-end' }}>
                  {/* Freighter picker */}
                  <div style={{ flex: '1 1 220px', maxWidth: 340 }}>
                    <div className="form-label" style={{ marginBottom: 6 }}>Freighter type</div>
                    <select className="form-select" value={selectedTypeId} onChange={e => setSelectedTypeId(e.target.value)}>
                      {reachableTypes.map(t => {
                        const idle = idleByType[t.id]?.length ?? 0;
                        return <option key={t.id} value={t.id}>{t.name} ({t.payloadTonnes}t){idle > 0 ? ` — ${idle} idle` : ''}</option>;
                      })}
                    </select>
                  </div>
                  {/* Frequency */}
                  <div>
                    <div className="form-label" style={{ marginBottom: 6 }}>Flights / week</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="range" min="1" max="14" step="1" value={frequency} onChange={e => setFrequency(Number(e.target.value))} style={{ width: 110, accentColor: ACCENT }} />
                      <span style={{ fontWeight: 700, minWidth: 22 }}>{frequency}×</span>
                    </div>
                  </div>
                  {/* Yield */}
                  <div>
                    <div className="form-label" style={{ marginBottom: 6 }}>Yield ($/tonne-km)</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="range" min={+(routeData.refYield * 0.4).toFixed(3)} max={+(routeData.refYield * 2).toFixed(3)} step="0.005"
                        value={effectiveYield} onChange={e => setYieldPrice(Number(e.target.value))} style={{ width: 110, accentColor: ACCENT }} />
                      <span style={{ fontWeight: 700, minWidth: 46 }}>${effectiveYield.toFixed(3)}</span>
                      <span style={{ fontSize: 11, minWidth: 90, color: yieldPct > 10 ? 'var(--red)' : yieldPct < -10 ? 'var(--green)' : 'var(--text-muted)' }}>
                        {yieldPct >= 0 ? `+${yieldPct}` : yieldPct}% · ${perKg.toFixed(2)}/kg
                      </span>
                      {yieldPrice !== null && <button className="btn btn-ghost" style={{ padding: '2px 7px', fontSize: 11 }} onClick={() => setYieldPrice(null)}>Reset</button>}
                    </div>
                  </div>
                </div>

                {simulation && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, background: 'var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 16 }}>
                    {[
                      { label: 'Weekly Capacity', value: `${(simulation.type.payloadTonnes * frequency).toLocaleString()} t`, sub: 'one-way payload' },
                      { label: 'Tonnes Carried',  value: `${simulation.result.tonnes.toLocaleString()} t`, sub: 'one-way / wk' },
                      { label: 'Load Factor',
                        value: simulation.resultLaunch && simulation.resultLaunch.loadFactor < simulation.result.loadFactor
                          ? `${formatPercent(simulation.resultLaunch.loadFactor)} → ${formatPercent(simulation.result.loadFactor)}`
                          : formatPercent(simulation.result.loadFactor),
                        sub: simulation.resultLaunch && simulation.resultLaunch.loadFactor < simulation.result.loadFactor ? 'launch → mature' : undefined,
                        color: simulation.result.loadFactor >= 0.75 ? 'var(--green)' : simulation.result.loadFactor >= 0.45 ? 'var(--yellow)' : 'var(--red)' },
                      { label: 'Freight Revenue', value: formatMoney(simulation.result.revenue), color: 'var(--green)', sub: 'both directions' },
                      { label: 'Op Cost / wk',    value: formatMoney(simulation.result.totalOpCost), color: 'var(--red)', sub: 'fuel · crew · handling' },
                      { label: 'Var. Profit / wk', value: (simulation.result.profit >= 0 ? '+' : '') + formatMoney(simulation.result.profit),
                        color: simulation.result.profit >= 0 ? 'var(--green)' : 'var(--red)', sub: 'before lease & maint' },
                    ].map((cell, i) => (
                      <div key={i} style={{ background: 'var(--surface2)', padding: '10px 12px' }}>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 }}>{cell.label}</div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: cell.color ?? 'var(--text)' }}>{cell.value}</div>
                        {cell.sub && <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>{cell.sub}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {/* CTA */}
                {simulation && (() => {
                  const idle      = idleByType[selectedTypeId] ?? [];
                  const lCost     = routeLaunchCost(routeData.dist);
                  const canAfford = state.cash >= lCost;
                  return (
                    <div style={{ marginTop: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                        {idle.length > 0 ? (
                          <button className="btn btn-primary" style={{ padding: '8px 20px', background: ACCENT, borderColor: ACCENT, opacity: canAfford ? 1 : 0.5 }} disabled={!canAfford} onClick={() => handleOpenRoute(idle[0].id)}>
                            Open Cargo Route with {idle[0].name}
                          </button>
                        ) : (
                          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                            No idle {simulation.type.name} available — lease one from the Market first.
                          </div>
                        )}
                        {simulation.result.profit < 0 && <span style={{ fontSize: 12, color: 'var(--yellow)' }}><Glyph e="⚠" /> Unprofitable at these settings</span>}
                      </div>
                      <div style={{ fontSize: 12, color: canAfford ? 'var(--text-muted)' : 'var(--red)' }}>
                        <Glyph e={canAfford ? '💸' : '⚠'} size={12} /> One-time launch cost: <strong>{formatMoney(lCost)}</strong>{!canAfford && ' — insufficient cash'}
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
