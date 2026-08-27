import { useState, useMemo, useEffect } from 'react';
import { useGame, slotCapAt, slotsUsedAt as slotsUsedAtEngine } from '../store/GameContext.jsx';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../data/aircraft.js';
import { isOutOfService } from '../data/maintenance.js';
import { simulateCargoRoute, cargoLaneAllocations, formatMoney, formatPercent, cargoSlotsUsedAt, maxFrequency, deployableFleetForRoute, maxWeeklyBlockHoursFor, currentGameDate, effectiveRangeKm } from '../utils/simulation.js';
import { cargoCityPairDemand, cargoReferenceYield, routeDistance } from '../utils/market.js';
import { cargoPriceChokeFactor, CARGO_PRICE_CAP_MULTIPLE } from '../models/demand.js';
import { routeLaunchCost } from '../data/overhead.js';
import AddGateButton from './AddGateButton.jsx';
import { Glyph } from './Icons.jsx';
import { consumeNavFilter, requestNav } from '../utils/navIntent.js';
import { navPathFor } from '../navPath.js';
import ReserveNotice from './ReserveNotice.jsx';

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

/**
 * @param {boolean}  [props.embedded]      rendered inside the Routes screen
 * @param {string}   [props.initialOrigin] pre-loaded lane — "add a freighter to
 * @param {string}   [props.initialDest]   this lane" from the freight routes list
 * @param {function} [props.onOpened]      called once the lane is opened
 */
export default function CargoRoutePlanner({ mode, setMode, embedded = false, initialOrigin = '', initialDest = '', onOpened }) {
  const { state, dispatch } = useGame();
  const bhCap = maxWeeklyBlockHoursFor(state);

  // Prefill is read at mount only; the caller keys the element on the lane, so
  // picking a different route mounts a fresh planner rather than yanking the
  // airports out from under a half-finished one.
  const [origin, setOrigin]   = useState(initialOrigin);
  const [dest,   setDest]     = useState(initialDest);
  const [selectedTypeId, setSelectedTypeId] = useState('');
  const [frequency, setFrequency] = useState(7);
  const [yieldPrice, setYieldPrice] = useState(null); // null = auto reference yield

  // A lane handed over by the Route Finder's optional "Plan". The finder is its
  // own screen now, so the pair is parked as a nav intent and read once, on
  // mount — the component does not exist yet when the button is clicked. See
  // utils/navIntent.js. RoutePlanner peeks at the same intent to switch into
  // freight mode and deliberately leaves it for us.
  useEffect(() => {
    if (embedded) return;
    const nav = consumeNavFilter('planner');
    if (!nav || nav.mode !== 'freight') return;
    if (nav.origin) setOrigin(nav.origin);
    if (nav.dest) setDest(nav.dest);
    setYieldPrice(null);
  }, []);

  const originAirport = getAirport(origin);
  const destAirport   = getAirport(dest);
  // Project the week the player would actually launch into. Freight is
  // seasonal now, so a fixed "typical month" would disagree with the tick the
  // moment they pressed the button.
  const gd = currentGameDate(state);
  const ready         = !!(originAirport && destAirport);

  const routeData = useMemo(() => {
    if (!ready) return null;
    const dist     = routeDistance(origin, dest);
    const refYield = cargoReferenceYield(origin, dest);
    const demand   = cargoCityPairDemand(origin, dest, gd.month);
    return { dist, refYield, demand };
  }, [origin, dest, ready, gd.month]);

  const effectiveYield = yieldPrice ?? routeData?.refYield ?? 0.5;

  // Your freighters already flying this lane (either direction). New capacity
  // on the pair shares ONE demand pool with them — the projection below and the
  // weekly tick both use cargoLaneAllocations, so what you see is what you get.
  const laneRoutes = useMemo(() =>
    (state.cargoRoutes ?? []).filter(r =>
      (r.origin === origin && r.destination === dest) || (r.origin === dest && r.destination === origin)),
    [state.cargoRoutes, origin, dest]
  );
  const alreadyActive = laneRoutes.length > 0;
  const laneCapacity  = useMemo(() => laneRoutes.reduce((s, r) => {
    const ac = state.fleet.find(a => a.id === r.aircraftId);
    const t  = ac ? getAircraftType(ac.typeId) : null;
    return s + (t?.payloadTonnes ?? 0) * (r.weeklyFrequency ?? 0);
  }, 0), [laneRoutes, state.fleet]);

  // Range belongs to the AIRFRAME, not the catalogue entry: engine and wingtip
  // options raise `rangeMod` on the tail you bought, and ADD_CARGO_ROUTE's own
  // guard measures the lane with effectiveRangeKm. Comparing against the stock
  // `type.range` here hid modded freighters the engine would have accepted — the
  // passenger planner had the identical bug (ASAS, 8/19/26). Per type we credit
  // the longest-legged freighter owned; unowned types have no mods, so they keep
  // the book figure.
  const reachByType = useMemo(() => {
    const map = new Map();
    for (const a of state.fleet ?? []) {
      // The same fleet filter deployableFleetForRoute applies. A tail in a heavy
      // check cannot fly this lane, so letting its mods advertise the type would
      // list an aircraft with nothing behind it: the picker offers the type, counts
      // "0 ready", and the Open Route button has no airframe to reach for.
      if (a.status === 'retired' || isOutOfService(a)) continue;
      const t = getAircraftType(a.typeId);
      if (!t) continue;
      // The tail's FULL reach: engine/wingtip rangeMod AND the cabin-payload bonus
      // its own stored layout earns. Both are real on an airframe you own —
      // effectiveRangeKm is exactly what ADD_ROUTE measures the lane against — and
      // the payload bonus is the larger of the two (up to +15% against +4%), so
      // crediting only the mod still hid premium-cabin jets the engine accepts.
      const reach = effectiveRangeKm(a, t);
      if (reach > (map.get(a.typeId) ?? 0)) map.set(a.typeId, reach);
    }
    return map;
  }, [state.fleet]);

  const reachKmFor = (t) =>
    t ? (reachByType.get(t.id) ?? effectiveRangeKm({ typeId: t.id }, t)) : 0;

  // Freighter types that can reach this route
  const reachableTypes = useMemo(() => {
    if (!routeData) return [];
    return AIRCRAFT_TYPES.filter(t => t.freighter && reachKmFor(t) >= routeData.dist);
  }, [routeData, reachByType]);

  useMemo(() => {
    if (reachableTypes.length && !reachableTypes.find(t => t.id === selectedTypeId)) {
      setSelectedTypeId(reachableTypes[0]?.id ?? '');
    }
  }, [reachableTypes]);

  // Freighters that can be deployed to THIS lane, by type. Includes aircraft
  // already flying another route but with spare block-hours that touch an
  // endpoint — the engine lets one freighter fly several routes up to the
  // 140h/wk cap, so the planner should too (not idle-only).
  const deployableByType = useMemo(() => {
    if (!routeData) return {};
    const map = {};
    for (const t of reachableTypes) {
      map[t.id] = deployableFleetForRoute({
        fleet:          state.fleet,
        existingRoutes: state.cargoRoutes ?? [],
        typeId:         t.id,
        origin, dest,
        distKm:         routeData.dist,
        weeklyFrequency: frequency,
        capHours:       bhCap,
      });
    }
    return map;
  }, [state.fleet, state.cargoRoutes, reachableTypes, routeData, origin, dest, frequency]);

  const simulation = useMemo(() => {
    if (!routeData || !selectedTypeId) return null;
    const type = getAircraftType(selectedTypeId);
    if (!type) return null;
    const route = { id: 'p', origin, destination: dest, aircraftId: 'p', weeklyFrequency: frequency, yieldPrice: effectiveYield, weeksOpen: 20 };
    // Scale the forecast freighter's rangeMod so effectiveRangeKm reproduces the
    // reach the picker quoted (which includes the tail's payload bonus). rangeMod
    // feeds effectiveRangeKm only — fuel burn rides on fuelMod — so this moves the
    // range guard and no part of the economics.
    const quotedReach = reachKmFor(type);
    const ac    = { id: 'p', typeId: selectedTypeId, ageWeeks: 0,
      rangeMod: type.range > 0 ? quotedReach / type.range : 1.0 };
    if (routeData.dist > quotedReach) return null;
    // Joining a lane you already fly: project THIS aircraft's slice of the
    // shared pool, not the full market (the same math the weekly tick runs).
    let override = null, overrideLaunch = null;
    if (laneRoutes.length > 0) {
      const fleetPlus = [...state.fleet, ac];
      // Include rival freighters so the projected slice matches the contested
      // tick — a lane a rival already flies is not yours alone.
      const cargoOpts = { gameDate: gd, competitors: state.competitors };
      override       = cargoLaneAllocations([...laneRoutes, route], fleetPlus, 1.0, cargoOpts).get('p') ?? null;
      overrideLaunch = cargoLaneAllocations([...laneRoutes, { ...route, weeksOpen: 0 }], fleetPlus, 1.0, cargoOpts).get('p') ?? null;
    }
    const result       = simulateCargoRoute(route, ac, gd, null, 1.0, 1.0, override);
    const resultLaunch = simulateCargoRoute({ ...route, weeksOpen: 0 }, ac, gd, null, 1.0, 1.0, overrideLaunch);
    if (!result) return null;
    const netProfit = result.profit - type.weeklyLease; // approx (excludes landing/maint; shown separately)
    return { result, resultLaunch, type, netProfit, shared: laneRoutes.length > 0 };
  }, [routeData, selectedTypeId, frequency, effectiveYield, origin, dest, laneRoutes, state.fleet, gd.month]);

  // A single freighter's 140h weekly block-hour budget caps how many round trips
  // it can fly on this lane. On long-haul freight that ceiling lands near one
  // departure/day — so clamp the slider to it (and nudge the current pick down)
  // instead of letting players pick a frequency the engine will silently reject.
  const freqCap = useMemo(() => {
    if (!routeData || !selectedTypeId) return 14;
    const type = getAircraftType(selectedTypeId);
    if (!type) return 14;
    return Math.max(1, Math.min(14, maxFrequency(routeData.dist, type, bhCap)));
  }, [routeData, selectedTypeId]);

  // Clamp the chosen frequency down when a longer lane / different freighter
  // lowers the ceiling (mirrors this file's existing useMemo-as-effect pattern).
  useMemo(() => {
    if (frequency > freqCap) setFrequency(freqCap);
  }, [freqCap]);

  function handleOpenRoute(aircraftId) {
    dispatch({ type: 'ADD_CARGO_ROUTE', origin, destination: dest, aircraftId, weeklyFrequency: Math.min(frequency, freqCap), yieldPrice: effectiveYield });
    onOpened?.();
  }
  function handleSwap() { const o = origin; setOrigin(dest); setDest(o); setYieldPrice(null); }

  const yieldPct  = routeData ? Math.round((effectiveYield / routeData.refYield - 1) * 100) : 0;
  // The freight you forfeit for pricing above the lane's going rate, straight
  // from the engine's own choke — so the planner quotes the same ceiling the
  // tick enforces rather than leaving players to find it by trial and error.
  const yieldChokePct = routeData
    ? Math.round((1 - cargoPriceChokeFactor(effectiveYield, routeData.refYield)) * 100)
    : 0;
  const perKg     = routeData ? (effectiveYield * routeData.dist / 1000) : 0;

  // ── Gates & slots ───────────────────────────────────────────────────────────
  // Freighters use gates and slots exactly like passenger flights: a gate is
  // required at both ends, and each weekly departure consumes a slot.
  const gates = state.gates ?? {};
  // Through the engine's own helper so a passenger rotation calling here is
  // charged the two movements it makes, and the cap counts an alliance
  // partner's granted slots — the same reading addCargoRouteBlockReason uses.
  const slotsUsedAt = (code) =>
    slotsUsedAtEngine(state.routes ?? [], code)
    + cargoSlotsUsedAt(code, state.cargoRoutes);
  const gateInfo = (code) => {
    const cap   = slotCapAt(state, code);
    const used  = slotsUsedAt(code);
    return { hasGate: cap > 0, cap, used, free: cap - used, fits: cap > 0 && used + frequency <= cap };
  };
  const originGate = gateInfo(origin);
  const destGate   = gateInfo(dest);
  const gatesOk    = ready && originGate.hasGate && destGate.hasGate;
  const slotsOk    = gatesOk && originGate.fits && destGate.fits;

  return (
    <div>
      {!embedded && <ModeToggle mode={mode} setMode={setMode} />}

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
          {!embedded && (
            <button
              className="btn btn-ghost"
              style={{ marginTop: 14, fontSize: 13 }}
              title={navPathFor('finder')}
              onClick={() => requestNav('finder')}
            >
              <Glyph e="🔍" /> Don't know where yet? Browse the Route Finder
            </button>
          )}
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
                        // Reserves counted apart from "ready" — see RoutePlanner.
                        const pool  = (deployableByType[t.id] ?? []).filter(d => d.eligible);
                        const ready = pool.filter(d => !d.reserve).length;
                        const onRes = pool.filter(d => d.reserve).length;
                        return <option key={t.id} value={t.id}>{t.name} ({t.payloadTonnes}t){ready > 0 ? ` · ${ready} ready` : ''}{onRes > 0 ? ` · ${onRes} on reserve` : ''}</option>;
                      })}
                    </select>
                  </div>
                  {/* Frequency */}
                  <div>
                    <div className="form-label" style={{ marginBottom: 6 }}>Flights / week</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="range" className="hw-range" min="1" max={freqCap} step="1" value={Math.min(frequency, freqCap)} onChange={e => setFrequency(Number(e.target.value))} draggable={false} onDragStart={e => e.preventDefault()} style={{ width: 110, accentColor: ACCENT }} />
                      <span style={{ fontWeight: 700, minWidth: 22 }}>{Math.min(frequency, freqCap)}×</span>
                    </div>
                    {freqCap < 14 && (
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 5, maxWidth: 190, lineHeight: 1.4 }}>
                        Max <strong style={{ color: ACCENT }}>{freqCap}/wk</strong> for one {simulation?.type?.name ?? 'freighter'} on {routeData.dist.toLocaleString()} km — weekly block-hour limit. Add another freighter for more.
                      </div>
                    )}
                  </div>
                  {/* Yield */}
                  <div>
                    <div className="form-label" style={{ marginBottom: 6 }}>Yield ($/tonne-km)</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="range" className="hw-range" min={+(routeData.refYield * 0.4).toFixed(3)} max={+(routeData.refYield * 2).toFixed(3)} step="0.005"
                        value={effectiveYield} onChange={e => setYieldPrice(Number(e.target.value))} draggable={false} onDragStart={e => e.preventDefault()} style={{ width: 110, accentColor: ACCENT }} />
                      <span style={{ fontWeight: 700, minWidth: 46 }}>${effectiveYield.toFixed(3)}</span>
                      <span style={{ fontSize: 11, minWidth: 90, color: yieldPct > 10 ? 'var(--red)' : yieldPct < -10 ? 'var(--green)' : 'var(--text-muted)' }}>
                        {yieldPct >= 0 ? `+${yieldPct}` : yieldPct}% · ${perKg.toFixed(2)}/kg
                      </span>
                      {yieldPrice !== null && <button className="btn btn-ghost" style={{ padding: '2px 7px', fontSize: 11 }} onClick={() => setYieldPrice(null)}>Reset</button>}
                    </div>
                    {yieldChokePct > 0 && (
                      <div style={{ fontSize: 11, color: yieldChokePct >= 25 ? 'var(--red)' : 'var(--yellow)', marginTop: 5, maxWidth: 220, lineHeight: 1.4 }}>
                        Above the going rate: forwarders book elsewhere and you lose{' '}
                        <strong>{yieldChokePct}%</strong> of the freight you would win at
                        ${routeData.refYield.toFixed(3)}. Demand hits zero at {CARGO_PRICE_CAP_MULTIPLE}× reference.
                      </div>
                    )}
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

                {/* Shared-lane pool notice */}
                {simulation?.shared && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -6, marginBottom: 14, lineHeight: 1.5 }}>
                    <Glyph e="⚖" size={12} /> {laneRoutes.length} of your freighter{laneRoutes.length !== 1 ? 's' : ''} already fl{laneRoutes.length !== 1 ? 'y' : 'ies'} {origin}–{dest} ({laneCapacity.toLocaleString()} t/wk capacity). All freighters on a lane share <strong>one</strong> demand pool — the figures above are this aircraft's share, not the full market.
                  </div>
                )}

                {/* CTA */}
                {simulation && (() => {
                  const pool      = deployableByType[selectedTypeId] ?? [];
                  const target    = pool.find(d => d.eligible);
                  // A stationed reserve can still be deployed — it just stops
                  // standing by — so flag it rather than hiding it.
                  const reserveTail = target?.reserve ? target.aircraft : null;
                  const anySpare  = pool.some(d => d.hoursOk);   // has hours (network may not reach this lane)
                  const owned     = pool.length;
                  // Backstop — see the note in RoutePlanner. The picker's reach and the
                  // pool's rangeOk are the same measure taken in two files; if they ever
                  // drift, say "out of range" rather than "flying other networks", which
                  // is plainly false about a parked freighter.
                  const outOfRange = owned > 0 && pool.every(d => d.rangeOk === false);
                  const lCost     = routeLaunchCost(routeData.dist);
                  const canAfford = state.cash >= lCost;
                  const blocked   = !canAfford || !slotsOk;
                  // Airports missing a gate, and airports out of free slots.
                  const noGate    = [!originGate.hasGate && origin, !destGate.hasGate && dest].filter(Boolean);
                  const noSlot    = [
                    originGate.hasGate && !originGate.fits && origin,
                    destGate.hasGate && !destGate.fits && dest,
                  ].filter(Boolean);
                  return (
                    <div style={{ marginTop: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                        {target ? (
                          <button className="btn btn-primary" style={{ padding: '8px 20px', background: ACCENT, borderColor: ACCENT, opacity: blocked ? 0.5 : 1 }} disabled={blocked} onClick={() => handleOpenRoute(target.aircraft.id)}>
                            Open Cargo Route with {target.aircraft.name}{!target.idle ? ' · shares hours' : ''}{target.reserve ? ' · ends standby' : ''}
                          </button>
                        ) : (
                          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                            {owned === 0
                              ? <>No {simulation.type.name} in your fleet — lease one from the Market first.</>
                              : outOfRange
                                ? <>Your {simulation.type.name}{owned > 1 ? 's reach' : ' reaches'} {Math.round(reachKmFor(simulation.type)).toLocaleString()} km as configured — {origin}–{dest} is {routeData.dist.toLocaleString()} km. Lease a longer-legged freighter.</>
                              : anySpare
                                ? <>Your {simulation.type.name}{owned > 1 ? 's are' : ' is'} flying other networks and can't reach {origin}–{dest} directly — a freighter can only add a lane that touches an airport it already serves. Lease another, or first route one through {origin} or {dest}.</>
                                : <>Your {simulation.type.name}{owned > 1 ? 's are' : ' is'} at full utilisation ({bhCap}h/wk) — no spare hours for another lane. Lease another {simulation.type.name} to open this route.</>}
                          </div>
                        )}
                        {simulation.result.profit < 0 && <span style={{ fontSize: 12, color: 'var(--yellow)' }}><Glyph e="⚠" /> Unprofitable at these settings</span>}
                      </div>
                      {/* Reserve notice */}
                      {reserveTail && (
                        <ReserveNotice
                          aircraft={reserveTail}
                          fleet={state.fleet}
                          ops={[...(state.routes ?? []), ...(state.cargoRoutes ?? [])]}
                          action="Opening this lane"
                          typeName={simulation.type.name}
                        />
                      )}
                      {/* Gate requirement */}
                      {noGate.length > 0 && (
                        <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 4, display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                          <Glyph e="⛔" size={12} /> No gate at <strong>{noGate.join(' & ')}</strong> — freighters need a gate at both ends.
                          {noGate.map(c => <AddGateButton key={c} code={c} />)}
                        </div>
                      )}
                      {/* Slot capacity */}
                      {noGate.length === 0 && noSlot.length > 0 && (
                        <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 4, display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                          <Glyph e="⚠" size={12} /> Not enough free slots at <strong>{noSlot.join(' & ')}</strong> for {frequency} weekly flight{frequency !== 1 ? 's' : ''}
                          {originGate.hasGate && destGate.hasGate && ` (free: ${origin} ${Math.max(0, originGate.free)}, ${dest} ${Math.max(0, destGate.free)})`}.
                          {noSlot.map(c => <AddGateButton key={c} code={c} />)}
                        </div>
                      )}
                      {/* Slot usage summary when everything checks out */}
                      {slotsOk && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                          <Glyph e="🛫" size={12} /> Slots after launch: {origin} {originGate.used + frequency}/{originGate.cap} · {dest} {destGate.used + frequency}/{destGate.cap}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: canAfford ? 'var(--text-muted)' : 'var(--red)' }}>
                        <Glyph e={canAfford ? '💸' : '⚠'} size={12} /> One-time launch cost: <strong>{formatMoney(lCost)}</strong>{!canAfford && ' · insufficient cash'}
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
