import { useState, useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { getAircraftType, AIRCRAFT_TYPES } from '../data/aircraft.js';
import { routeLaunchCost } from '../data/overhead.js';
import { normalizeCateringLevel } from '../data/catering.js';
import {
  simulateTagRoute, referencePrice, distanceKm, formatMoney, formatPercent,
  currentGameDate, effectiveRangeKm, defaultClassPrices,
  routeLegs, routeSegments, routeSegmentKey, routeMaxLegKm, routeBlockHours,
  routeLandingFee, routeStops, MAX_WEEKLY_BLOCK_HOURS, SLOTS_PER_GATE, MAX_ROUTE_STOPS,
  cargoSlotsUsedAt, fleetAvgUtilization,
} from '../utils/simulation.js';
import { ModeToggle } from './CargoRoutePlanner.jsx';
import AddGateButton from './AddGateButton.jsx';
import { Glyph } from './Icons.jsx';

// ─── Region-grouped airport <select> (only airports with a gate) ───────────────

const REGION_MAP = {
  US: 'North America', CA: 'North America', MX: 'North America',
  GB: 'Europe', FR: 'Europe', DE: 'Europe', NL: 'Europe', ES: 'Europe', IT: 'Europe', TR: 'Europe',
  AE: 'Middle East & Asia', SG: 'Middle East & Asia', HK: 'Middle East & Asia', JP: 'Middle East & Asia',
  KR: 'Middle East & Asia', CN: 'Middle East & Asia', IN: 'Middle East & Asia', AU: 'Middle East & Asia',
  BR: 'South America', AR: 'South America',
};
const REGION_ORDER = ['North America', 'Europe', 'Middle East & Asia', 'South America', 'Other'];
const regionOf = (a) => REGION_MAP[a?.country] ?? 'Other';

function StopSelect({ value, onChange, gates, placeholder }) {
  return (
    <select className="form-select" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{placeholder ?? '— Select airport —'}</option>
      {REGION_ORDER.map(region => {
        const list = AIRPORTS.filter(a => (gates[a.code] ?? 0) > 0 && regionOf(a) === region);
        if (!list.length) return null;
        return (
          <optgroup key={region} label={region}>
            {list.map(a => (
              <option key={a.code} value={a.code}>{a.code} — {a.city}</option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function TagRoutePlanner({ mode, setMode }) {
  const { state, dispatch } = useGame();
  const { fleet, routes, gates = {}, hub, cash, cargoRoutes = [] } = state;
  const gd = currentGameDate(state);

  // Ordered stops: a tag flight needs ≥3 (origin + ≥1 stop + destination).
  const [stops, setStops] = useState([hub || '', '', '']);
  const [aircraftId, setAircraftId] = useState('');
  const [frequency, setFrequency]   = useState(5);
  const [cateringLevel, setCateringLevel] = useState(normalizeCateringLevel(state.defaultCateringLevel));
  const [fareOverrides, setFareOverrides] = useState({}); // { [segKey]: economy$ }

  const setStop = (i, code) => setStops(s => s.map((c, j) => (j === i ? code : c)));
  const addStop = () => setStops(s => (s.length >= MAX_ROUTE_STOPS ? s : [...s.slice(0, -1), '', s[s.length - 1]])); // insert before destination
  const removeStop = (i) => setStops(s => (s.length > 3 ? s.filter((_, j) => j !== i) : s));
  const atStopLimit = stops.length >= MAX_ROUTE_STOPS;

  const validStops = stops.filter(Boolean);
  const distinct   = new Set(validStops).size === validStops.length;
  const ready      = validStops.length >= 3 && validStops.length === stops.length && distinct;

  // Build the prospective route (segment fares default to reference price).
  const route = useMemo(() => {
    if (!ready) return null;
    const proto = { stops: validStops, origin: validStops[0], destination: validStops[validStops.length - 1] };
    const segmentPrices = {};
    for (const seg of routeSegments(proto)) {
      const key = routeSegmentKey(seg.from, seg.to);
      const eco = Math.max(1, Math.round(fareOverrides[key] ?? referencePrice(seg.from, seg.to)));
      segmentPrices[key] = defaultClassPrices(eco);
    }
    return { ...proto, weeklyFrequency: frequency, hub, cateringLevel, segmentPrices };
  }, [ready, stops.join('-'), frequency, hub, cateringLevel, fareOverrides]); // eslint-disable-line

  const aircraft = fleet.find(a => a.id === aircraftId);
  const type     = aircraft ? getAircraftType(aircraft.typeId) : null;

  const legs    = route ? routeLegs(route) : [];
  const maxLeg  = route ? routeMaxLegKm(route) : 0;
  const totalDist = legs.reduce((s, l) => s + Math.round(distanceKm(getAirport(l.from), getAirport(l.to))), 0);
  const effRange = type && aircraft ? effectiveRangeKm(aircraft, type) : 0;
  const inRange  = type ? maxLeg <= effRange : true;

  // Aircraft that can fly the longest leg.
  const reachable = useMemo(() => {
    if (!route) return fleet;
    return fleet.filter(a => {
      const t = getAircraftType(a.typeId);
      return t && !t.freighter && effectiveRangeKm(a, t) >= maxLeg;
    });
  }, [fleet, route, maxLeg]);

  // Auto-pick a reachable aircraft when needed.
  useMemo(() => {
    if (reachable.length && !reachable.find(a => a.id === aircraftId)) {
      setAircraftId(reachable[0]?.id ?? '');
    }
  }, [reachable]); // eslint-disable-line

  const preview = useMemo(() => {
    if (!route || !aircraft || !inRange) return null;
    // Include the prospective route in the utilization estimate so the preview
    // reflects the schedule pressure this flight would add.
    const avgUtil = fleetAvgUtilization(fleet, [...routes, ...cargoRoutes, { ...route, aircraftId: aircraft.id }]);
    return simulateTagRoute(route, aircraft, gd, state.labor ?? null, 1.0, avgUtil, state.satisfaction ?? null);
  }, [route, aircraft, inRange, gd.month, state.labor]); // eslint-disable-line

  // ── Validation (mirrors the reducer; advisory only) ──
  const blockHrsExisting = aircraft && type
    ? routes.filter(r => r.aircraftId === aircraft.id).reduce((s, r) => s + routeBlockHours(r, type, r.weeklyFrequency), 0)
    : 0;
  const blockHrsNew  = route && type ? routeBlockHours(route, type, frequency) : 0;
  const blockOk      = !type || blockHrsExisting + blockHrsNew <= MAX_WEEKLY_BLOCK_HOURS;

  const incident = {};
  for (const l of legs) { incident[l.from] = (incident[l.from] ?? 0) + 1; incident[l.to] = (incident[l.to] ?? 0) + 1; }
  const incidentCount = (r, code) => routeLegs(r).reduce((n, l) => n + (l.from === code ? 1 : 0) + (l.to === code ? 1 : 0), 0);
  const slotsUsedAt = (code) => routes.reduce((s, r) => s + incidentCount(r, code) * (r.weeklyFrequency ?? 0), 0)
    + cargoSlotsUsedAt(code, cargoRoutes);
  const gateProblem = ready ? validStops.find(c => !(gates[c] > 0)) : null;
  const slotProblem = ready ? validStops.find(c => slotsUsedAt(c) + (incident[c] ?? 0) * frequency > (gates[c] ?? 0) * SLOTS_PER_GATE) : null;

  const aircraftRoutes = aircraft ? routes.filter(r => r.aircraftId === aircraft.id) : [];
  const served = new Set(aircraftRoutes.flatMap(r => routeStops(r)));
  const connectivityOk = !aircraft || aircraftRoutes.length === 0 || validStops.some(c => served.has(c));

  const launchCost = route ? routeLaunchCost(totalDist) : 0;
  const canAfford  = cash >= launchCost;

  const canOpen = ready && aircraft && inRange && blockOk && !gateProblem && !slotProblem && connectivityOk && canAfford;

  function handleOpen() {
    if (!canOpen) return;
    dispatch({
      type: 'ADD_TAG_ROUTE',
      aircraftId,
      stops: validStops,
      weeklyFrequency: frequency,
      cateringLevel,
      segmentPrices: route.segmentPrices,
    });
    // Reset the intermediate stops but keep the hub as a convenient origin.
    setStops([hub || '', '', '']);
    setFareOverrides({});
  }

  const segList = route ? routeSegments(route) : [];
  const segMeta = (seg) => preview?.segments?.find(s => s.from === seg.from && s.to === seg.to);

  return (
    <div>
      <ModeToggle mode={mode} setMode={setMode} />

      {/* ── Stops builder ── */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Multi-stop route</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
          One aircraft flies every stop in order (and back). It sells each local leg <em>and</em> the through markets — a passenger
          can fly the whole way or hop on/off at any stop. Each leg must be within range; the total trip can exceed it.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {stops.map((code, i) => {
            const role = i === 0 ? 'Origin' : i === stops.length - 1 ? 'Destination' : `Stop ${i}`;
            const isInterior = i > 0 && i < stops.length - 1;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 92, fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>
                  {role}
                </div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <StopSelect value={code} onChange={(c) => setStop(i, c)} gates={gates} />
                </div>
                {isInterior && stops.length > 3 && (
                  <button className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 13 }}
                    onClick={() => removeStop(i)} title="Remove this stop"><Glyph e="✕" /></button>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 10 }}>
          <button className="btn btn-ghost" style={{ fontSize: 13, opacity: atStopLimit ? 0.4 : 1, cursor: atStopLimit ? 'not-allowed' : 'pointer' }}
            onClick={addStop} disabled={atStopLimit}>+ Add stop</button>
          <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--text-dim)' }}>
            Up to {MAX_ROUTE_STOPS - 2} intermediate stop{MAX_ROUTE_STOPS - 2 === 1 ? '' : 's'} ({MAX_ROUTE_STOPS} airports).
          </span>
          {!distinct && (
            <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--red)' }}><Glyph e="⚠" /> Each airport can appear only once.</span>
          )}
        </div>
      </div>

      {!ready && (
        <div className="empty-state" style={{ marginTop: 24 }}>
          <div className="empty-state-icon"><Glyph e="🧭" /></div>
          <div className="empty-state-text">Pick at least three airports to plan a tag flight.</div>
        </div>
      )}

      {ready && route && (
        <>
          {/* ── Aircraft + frequency ── */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 240px' }}>
                <div className="form-label" style={{ marginBottom: 6 }}>Aircraft (must reach the longest leg · {Math.round(maxLeg).toLocaleString()} km)</div>
                <select className="form-select" value={aircraftId} onChange={e => setAircraftId(e.target.value)}>
                  {reachable.length === 0 && <option value="">— none in fleet can fly the longest leg —</option>}
                  {reachable.map(a => {
                    const t = getAircraftType(a.typeId);
                    return <option key={a.id} value={a.id}>{a.name} ({t?.seats} seats · {a.status})</option>;
                  })}
                </select>
              </div>
              <div>
                <div className="form-label" style={{ marginBottom: 6 }}>Flights / week</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="range" min="1" max="14" step="1" value={frequency}
                    onChange={e => setFrequency(Number(e.target.value))}
                    style={{ width: 120, accentColor: 'var(--accent)' }} />
                  <span style={{ fontWeight: 700, minWidth: 24 }}>{frequency}×</span>
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Total trip <strong>{totalDist.toLocaleString()} km</strong> · {legs.length} legs
              </div>
            </div>

            {/* Blockers */}
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              {!inRange && type && (
                <span style={{ color: 'var(--red)' }}><Glyph e="⚠" /> {type.name} range {effRange.toLocaleString()} km &lt; longest leg {Math.round(maxLeg).toLocaleString()} km.</span>
              )}
              {!blockOk && <span style={{ color: 'var(--red)' }}><Glyph e="⚠" /> Exceeds the {MAX_WEEKLY_BLOCK_HOURS}h/wk block-hour cap for this aircraft.</span>}
              {gateProblem && <span style={{ color: 'var(--red)', display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}><Glyph e="⚠" /> No gate at {gateProblem}<AddGateButton code={gateProblem} /></span>}
              {slotProblem && <span style={{ color: 'var(--yellow)', display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}><Glyph e="⚠" /> Not enough slots at {slotProblem}<AddGateButton code={slotProblem} /></span>}
              {!connectivityOk && <span style={{ color: 'var(--red)' }}><Glyph e="⚠" /> {aircraft?.name} can only extend from an airport it already serves.</span>}
            </div>
          </div>

          {/* ── Per-segment fares ── */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Fares by market</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              You set the economy fare for every market this flight sells — including the through fares. Premium cabins scale automatically.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
              {segList.map(seg => {
                const key = routeSegmentKey(seg.from, seg.to);
                const ref = Math.round(referencePrice(seg.from, seg.to));
                const val = Math.round(fareOverrides[key] ?? ref);
                const meta = segMeta(seg);
                const through = seg.legSpan > 1;
                return (
                  <div key={key} style={{
                    background: 'var(--surface2)', borderRadius: 'var(--radius)', padding: '10px 12px',
                    borderLeft: `3px solid ${through ? 'var(--purple)' : 'var(--accent)'}`,
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {seg.from} → {seg.to}
                      {through && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--purple)', fontWeight: 600 }}>THROUGH</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>$</span>
                      <input className="form-input" type="number" min="1" value={val}
                        onChange={e => setFareOverrides(o => ({ ...o, [key]: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                        style={{ width: 80, padding: '3px 6px', fontSize: 12 }} />
                      <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>ref ${ref}</span>
                    </div>
                    {meta && (
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 5 }}>
                        {meta.pax.toLocaleString()} pax/wk · {formatMoney(meta.pax * 2 * (meta.ecoFare ?? val))}/wk
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Live economics ── */}
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: 12 }}>Estimated economics</div>
            {!aircraft ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Select an aircraft that can fly the longest leg.</div>
            ) : !preview ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>This aircraft can’t fly one of the legs.</div>
            ) : (() => {
              const landingFee = routeLandingFee(route, type, frequency);
              const profit = preview.profit - landingFee;
              return (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 1, background: 'var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 14 }}>
                    {[
                      { label: 'Boarded pax', value: preview.passengers.toLocaleString(), sub: 'one-way / wk' },
                      { label: 'Blended load', value: formatPercent(preview.loadFactor), color: preview.loadFactor >= 0.75 ? 'var(--green)' : preview.loadFactor >= 0.45 ? 'var(--yellow)' : 'var(--red)' },
                      { label: 'Revenue / wk', value: formatMoney(preview.revenue), color: 'var(--green)' },
                      { label: 'Op cost / wk', value: formatMoney(preview.totalOpCost), color: 'var(--red)' },
                      { label: 'Landing fees', value: formatMoney(landingFee), color: 'var(--red)', sub: 'all stops' },
                      { label: 'Op profit / wk', value: (profit >= 0 ? '+' : '') + formatMoney(profit), color: profit >= 0 ? 'var(--green)' : 'var(--red)' },
                    ].map((c, i) => (
                      <div key={i} style={{ background: 'var(--surface2)', padding: '10px 12px' }}>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 3 }}>{c.label}</div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: c.color ?? 'var(--text)' }}>{c.value}</div>
                        {c.sub && <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>{c.sub}</div>}
                      </div>
                    ))}
                  </div>

                  {/* Per-leg load */}
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                    {preview.legs.map((l, i) => {
                      const c = l.loadFactor >= 0.75 ? 'var(--green)' : l.loadFactor >= 0.45 ? 'var(--yellow)' : 'var(--red)';
                      return (
                        <div key={i} style={{ flex: '1 1 120px', background: 'var(--surface2)', borderRadius: 'var(--radius)', padding: '10px 12px', borderTop: `3px solid ${c}` }}>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Leg {l.from} → {l.to} · {l.distance.toLocaleString()} km</div>
                          <div style={{ fontWeight: 700, fontSize: 16, color: c }}>{formatPercent(l.loadFactor)}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{(l.ecoUsed + l.bizUsed).toLocaleString()} / {l.seats.toLocaleString()} seats one-way</div>
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}

            {/* Open button */}
            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" style={{ padding: '8px 20px', opacity: canOpen ? 1 : 0.4, cursor: canOpen ? 'pointer' : 'not-allowed' }}
                disabled={!canOpen} onClick={handleOpen}>
                Open Multi-stop Route
              </button>
              <span style={{ fontSize: 12, color: canAfford ? 'var(--text-muted)' : 'var(--red)' }}>
                <Glyph e={canAfford ? '💸' : '⚠'} size={12} /> Launch cost {formatMoney(launchCost)}{!canAfford ? ' — insufficient cash' : ''}
              </span>
              {preview && preview.profit - routeLandingFee(route, type, frequency) < 0 && (
                <span style={{ fontSize: 12, color: 'var(--yellow)' }}><Glyph e="⚠" /> Unprofitable at these settings</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
