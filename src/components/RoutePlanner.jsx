import { useState, useMemo, useEffect } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { AIRPORTS, getAirport } from '../data/airports.js';
import { AIRCRAFT_TYPES, getAircraftType } from '../data/aircraft.js';
import {
  baseCityPairDemand, referencePrice, distanceKm,
  simulateRoute, formatMoney, formatPercent, weekToGameDate,
  defaultConfig, configBodies, configSpaceQualityBonus, defaultClassPrices,
  CLASS_FARE_MULTIPLIERS, CLASS_SPACE_MULTIPLIERS, fleetAvgUtilization,
  buildEventDemandModel,
} from '../utils/simulation.js';
import { laborEffects } from '../data/labor.js';
import {
  buildRouteMarket, computeMarketShare,
  buildCompetitorOffer, computeQualityScore, cabinQualityPoints,
  computeConnectingDemand, AIRPORT_GATEWAY_SCORES,
} from '../models/demand.js';
import { routeLaunchCost } from '../data/overhead.js';
import { checkRouteRestrictions } from '../data/airportRestrictions.js';
import { cateringQualityBonus, normalizeCateringLevel } from '../data/catering.js';
import CateringSelector from './CateringSelector.jsx';
import CargoRoutePlanner, { ModeToggle } from './CargoRoutePlanner.jsx';
import TagRoutePlanner from './TagRoutePlanner.jsx';
import RouteFinder from './RouteFinder.jsx';
import InfoTip from './InfoTip.jsx';
import { Glyph, GlyphLabel } from './Icons.jsx';

function weekToMonth(week) {
  return weekToGameDate(week).monthIndex;
}

const MONTH_ABBR = ['', 'J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const SEASON_PRESETS = [
  { id: 'year',   label: 'Year-round', months: null },
  { id: 'summer', label: 'Summer (Jun–Sep)', months: [6, 7, 8, 9] },
  { id: 'winter', label: 'Winter (Dec–Mar)', months: [12, 1, 2, 3] },
];

// Lets the player restrict a route to certain months. Year-round = no season field.
// Off-season the route is dormant: no revenue/cost, and its aircraft + slots are
// free for a counter-seasonal route. Resuming each season costs 1/3 of launch.
function SeasonPicker({ value, onChange, currentMonth }) {
  const selected = new Set(value?.months ?? []);
  const isYearRound = !value || selected.size === 0;

  const toggleMonth = (m) => {
    const next = new Set(selected);
    next.has(m) ? next.delete(m) : next.add(m);
    onChange(next.size === 0 ? null : { months: [...next].sort((a, b) => a - b) });
  };
  const applyPreset = (p) => onChange(p.months ? { months: [...p.months] } : null);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        Operating window
        <InfoTip text="Restrict this route to certain months. Off-season it goes dormant — no revenue or cost, and its aircraft and gate slots free up for a counter-seasonal route. Resuming service each season costs 1/3 of the launch cost; gate fees are billed year-round." />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        {SEASON_PRESETS.map(p => {
          const active = (p.months === null && isYearRound) ||
            (p.months && !isYearRound && p.months.length === selected.size && p.months.every(m => selected.has(m)));
          return (
            <button key={p.id} type="button" className={`btn ${active ? 'btn-primary' : 'btn-ghost'}`}
              style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => applyPreset(p)}>
              {p.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
        {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
          const on = !isYearRound && selected.has(m);
          return (
            <button key={m} type="button" onClick={() => toggleMonth(m)} title={`Month ${m}`}
              style={{
                width: 26, height: 26, fontSize: 11, borderRadius: 5, cursor: 'pointer',
                border: m === currentMonth ? '2px solid var(--accent)' : '1px solid var(--border)',
                background: on ? 'var(--accent)' : 'transparent',
                color: on ? '#fff' : 'var(--text-dim, inherit)', fontWeight: on ? 700 : 400,
              }}>
              {MONTH_ABBR[m]}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
        {isYearRound ? 'Flies all 12 months.' : `Flies ${selected.size} month${selected.size !== 1 ? 's' : ''} · dormant the rest of the year.`}
      </div>
    </div>
  );
}

// ─── Airport search dropdown ──────────────────────────────────────────────────

function AirportPicker({ label, value, onChange, exclude }) {
  const [query, setQuery] = useState('');
  const [open, setOpen]   = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return AIRPORTS
      .filter(a => a.code !== exclude)
      .filter(a =>
        !q ||
        a.code.includes(q) ||
        a.city.toUpperCase().includes(q) ||
        a.name.toUpperCase().includes(q)
      )
      .slice(0, 12);
  }, [query, exclude]);

  const selected = getAirport(value);

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
      <div className="form-label" style={{ marginBottom: 6 }}>{label}</div>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--surface2)', border: `1px solid ${open ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 'var(--radius)', padding: '8px 12px', cursor: 'pointer',
        }}
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
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 100,
          background: 'var(--surface2)', border: '1px solid var(--accent)',
          borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', overflow: 'hidden',
        }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
            <input
              autoFocus
              className="form-input"
              placeholder="Search city or IATA code…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onClick={e => e.stopPropagation()}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.map(a => (
              <div
                key={a.code}
                onClick={() => { onChange(a.code); setQuery(''); setOpen(false); }}
                style={{
                  padding: '8px 12px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center',
                  background: a.code === value ? 'rgba(56,139,253,0.12)' : 'transparent',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface3)'}
                onMouseLeave={e => e.currentTarget.style.background = a.code === value ? 'rgba(56,139,253,0.12)' : 'transparent'}
              >
                <span style={{ fontWeight: 700, fontSize: 15, width: 36, flexShrink: 0 }}>{a.code}</span>
                <div>
                  <div style={{ fontSize: 13 }}>{a.city}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{a.name}</div>
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: 16, color: 'var(--text-dim)', fontSize: 13, textAlign: 'center' }}>No airports found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Stat tile ────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ minWidth: 80 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: color ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ─── Tier badge ───────────────────────────────────────────────────────────────

const TIER_STYLE = {
  budget:  { bg: 'rgba(210,153,34,0.15)',  color: 'var(--yellow)' },
  legacy:  { bg: 'rgba(56,139,253,0.15)',  color: 'var(--accent)' },
  premium: { bg: 'rgba(163,113,247,0.15)', color: 'var(--purple)' },
};

function TierBadge({ tier }) {
  const s = TIER_STYLE[tier] ?? TIER_STYLE.legacy;
  return (
    <span style={{
      background: s.bg, color: s.color,
      borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600,
      textTransform: 'capitalize',
    }}>
      {tier}
    </span>
  );
}

// ─── Cabin configuration helpers ───────────────────────────────────────────────

const CABIN_KEYS   = ['firstClass', 'businessClass', 'premiumEconomy', 'economy'];
const CABIN_LABELS = { firstClass: 'First', businessClass: 'Business', premiumEconomy: 'Prem. Eco', economy: 'Economy' };
const CABIN_CODE   = { firstClass: 'F', businessClass: 'J', premiumEconomy: 'W', economy: 'Y' };
const CABIN_COLORS = { firstClass: '#bc8cff', businessClass: '#ffb43d', premiumEconomy: '#3ea6ff', economy: '#38d39f' };

const QUALITY_OPTIONS = [
  { value: 'basic',    label: 'Basic' },
  { value: 'standard', label: 'Standard' },
  { value: 'premium',  label: 'Premium' },
  { value: 'luxury',   label: 'Luxury' },
];

/** Short cabin summary like "8F/24J/210Y". */
export function configSummary(cfg) {
  if (!cfg) return '—';
  const parts = CABIN_KEYS.filter(k => (cfg[k] ?? 0) > 0).map(k => `${cfg[k]}${CABIN_CODE[k]}`);
  return parts.length ? parts.join('/') : '—';
}

/** Build a preset cabin layout sized to a type's total floor units (= type.seats). */
export function makePreset(kind, seats) {
  const base = {
    firstClass: 0, businessClass: 0, premiumEconomy: 0, economy: seats,
    seatQuality: 'standard', serviceQuality: 'standard',
  };
  if (kind === 'twoClass') {
    const biz = Math.max(1, Math.floor((seats * 0.15) / CLASS_SPACE_MULTIPLIERS.businessClass));
    const eco = Math.max(0, Math.floor(seats - biz * CLASS_SPACE_MULTIPLIERS.businessClass));
    return { ...base, businessClass: biz, economy: eco };
  }
  if (kind === 'threeClass') {
    const biz  = Math.max(1, Math.floor((seats * 0.20) / CLASS_SPACE_MULTIPLIERS.businessClass));
    const prem = Math.max(1, Math.floor((seats * 0.15) / CLASS_SPACE_MULTIPLIERS.premiumEconomy));
    const used = biz * CLASS_SPACE_MULTIPLIERS.businessClass + prem * CLASS_SPACE_MULTIPLIERS.premiumEconomy;
    return { ...base, businessClass: biz, premiumEconomy: prem, economy: Math.max(0, Math.floor(seats - used)) };
  }
  if (kind === 'premiumHeavy') {
    const first = Math.max(1, Math.floor((seats * 0.08) / CLASS_SPACE_MULTIPLIERS.firstClass));
    const biz   = Math.max(1, Math.floor((seats * 0.30) / CLASS_SPACE_MULTIPLIERS.businessClass));
    const prem  = Math.max(1, Math.floor((seats * 0.20) / CLASS_SPACE_MULTIPLIERS.premiumEconomy));
    const used  = first * CLASS_SPACE_MULTIPLIERS.firstClass + biz * CLASS_SPACE_MULTIPLIERS.businessClass + prem * CLASS_SPACE_MULTIPLIERS.premiumEconomy;
    return { ...base, firstClass: first, businessClass: biz, premiumEconomy: prem, economy: Math.max(0, Math.floor(seats - used)) };
  }
  return base; // 'economy'
}

const PRESET_OPTIONS = [
  { id: 'economy',      label: 'All economy (default)' },
  { id: 'twoClass',     label: 'Two-class (business + economy)' },
  { id: 'threeClass',   label: 'Three-class (business + prem. eco + economy)' },
  { id: 'premiumHeavy', label: 'Premium-heavy (first + business + prem. eco)' },
];

// ─── Cabin configurator (Route Planner) ─────────────────────────────────────────

function CabinConfigPanel({ type, config, onChange, source, onSourceChange, fleetOptions }) {
  const maxSeats = type?.seats ?? 0;
  const cfg = config ?? defaultConfig(maxSeats);

  // Floor-space math (mirrors FleetConfig): premium cabins consume >1 unit each.
  const premiumUnits =
      (cfg.firstClass     ?? 0) * CLASS_SPACE_MULTIPLIERS.firstClass
    + (cfg.businessClass  ?? 0) * CLASS_SPACE_MULTIPLIERS.businessClass
    + (cfg.premiumEconomy ?? 0) * CLASS_SPACE_MULTIPLIERS.premiumEconomy;
  const usedUnits  = premiumUnits + (cfg.economy ?? 0) * CLASS_SPACE_MULTIPLIERS.economy;
  const emptyUnits = Math.max(0, maxSeats - usedUnits);
  const over       = premiumUnits > maxSeats;
  const bodies     = configBodies(cfg);

  // Editing a seat count switches the source to "custom".
  function setSeat(key, raw) {
    let next = Math.max(0, parseInt(raw, 10) || 0);
    if (key === 'economy') {
      // economy capped by floor units left after premium cabins
      const cap = Math.max(0, Math.floor(maxSeats - premiumUnits));
      next = Math.min(next, cap);
    } else {
      const otherPremium = premiumUnits - (cfg[key] ?? 0) * CLASS_SPACE_MULTIPLIERS[key];
      const cap = Math.floor((maxSeats - otherPremium - (cfg.economy ?? 0) * CLASS_SPACE_MULTIPLIERS.economy) / CLASS_SPACE_MULTIPLIERS[key]);
      next = Math.min(next, Math.max(0, cap));
    }
    onChange({ ...cfg, [key]: next });
    if (source !== 'custom') onSourceChange('custom');
  }

  function setQuality(key, value) {
    onChange({ ...cfg, [key]: value });
    if (source !== 'custom') onSourceChange('custom');
  }

  // Revenue index vs all-economy (blended fare multiplier).
  const revenueIndex = maxSeats > 0
    ? CABIN_KEYS.reduce((s, k) => s + ((cfg[k] ?? 0) / maxSeats) * CLASS_FARE_MULTIPLIERS[k], 0)
    : 1;
  const spaceBonus = configSpaceQualityBonus(cfg, type);

  return (
    <div style={{ flexBasis: '100%', background: 'var(--surface2)', borderRadius: 'var(--radius)', padding: '14px 16px' }}>
      <div className="form-label" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        Cabin configuration
        <InfoTip text="Forecasts use this cabin layout, not a default all-economy fit. Start from one of your existing aircraft, pick a preset, or edit seat counts directly. Premium cabins earn more per seat but take more floor space and serve a smaller slice of demand." />
      </div>

      {/* Source selector: fleet aircraft + presets */}
      <select
        className="form-select"
        value={source}
        onChange={e => onSourceChange(e.target.value)}
        style={{ width: '100%', maxWidth: 420, marginBottom: 12 }}
      >
        {fleetOptions.length > 0 && (
          <optgroup label="Your aircraft of this type">
            {fleetOptions.map(a => (
              <option key={a.id} value={a.id}>
                {(a.tailNumber || a.name)} — {configSummary(a.config)}{a.status === 'idle' ? ' · idle' : ''}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Presets">
          {PRESET_OPTIONS.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </optgroup>
        <option value="custom">Custom (edited below)</option>
      </select>

      {/* Seat-count editors */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
        {CABIN_KEYS.map(k => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: CABIN_COLORS[k], flexShrink: 0 }} />
            <div style={{ fontSize: 12 }}>
              <div>{CABIN_LABELS[k]}</div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>×{CLASS_FARE_MULTIPLIERS[k]} fare</div>
            </div>
            <input
              type="number"
              min={0}
              value={cfg[k] ?? 0}
              onChange={e => setSeat(k, e.target.value)}
              className="form-input"
              style={{ width: 64, textAlign: 'center' }}
            />
          </div>
        ))}
      </div>

      {/* Floor-usage bar */}
      <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 6, background: 'var(--surface3)' }}>
        {CABIN_KEYS.map(k => {
          const units = (cfg[k] ?? 0) * CLASS_SPACE_MULTIPLIERS[k];
          return units > 0 && <div key={k} style={{ width: `${(units / maxSeats) * 100}%`, background: CABIN_COLORS[k] }} />;
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: over ? 'var(--red)' : 'var(--text-muted)', marginBottom: 10 }}>
        <span>
          {over
            ? <GlyphLabel size={11} text={`⚠ Over by ${(usedUnits - maxSeats).toFixed(1)} seat units — reduce a class`} />
            : `${usedUnits.toFixed(1)} / ${maxSeats} seat units${emptyUnits >= 1 ? ` · ${emptyUnits.toFixed(0)} empty` : ''}`}
        </span>
        <span>{bodies} seats · {revenueIndex.toFixed(2)}× rev/seat{spaceBonus > 0 ? ` · +${spaceBonus} comfort` : ''}</span>
      </div>

      {/* Quality selectors */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {[['seatQuality', 'Seat quality'], ['serviceQuality', 'Service quality']].map(([key, label]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
            <select
              className="form-select"
              value={cfg[key] ?? 'standard'}
              onChange={e => setQuality(key, e.target.value)}
              style={{ width: 120 }}
            >
              {QUALITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RoutePlanner() {
  const { state, dispatch } = useGame();

  const [mode, setMode] = useState('passenger');

  const [origin, setOrigin]       = useState('');
  const [dest,   setDest]         = useState('');
  const [selectedTypeId, setSelectedTypeId] = useState('');
  const [frequency, setFrequency] = useState(7);
  const [price, setPrice]         = useState(null); // null = auto reference price
  const [cateringLevel, setCateringLevel] = useState(normalizeCateringLevel(state.defaultCateringLevel));
  const [season, setSeason] = useState(null); // null = year-round; else { months:[..] }
  // Cabin configuration used for the forecast (defaults to an idle aircraft's real
  // layout when you own one of the selected type, otherwise all-economy).
  const [cabinConfig, setCabinConfig] = useState(null);
  const [configSource, setConfigSource] = useState('economy');

  const gameDate = { week: state.week, month: weekToMonth(state.week) };

  const originAirport = getAirport(origin);
  const destAirport   = getAirport(dest);
  const ready         = !!(originAirport && destAirport);

  // World-event demand shocks: previews must match what the engine will book
  // this week (a pandemic scare shrinks the pool the planner shows too).
  const eventDemand = useMemo(
    () => buildEventDemandModel(state.activeEvents),
    [state.activeEvents]
  );

  // Core market data
  const routeData = useMemo(() => {
    if (!ready) return null;
    const dist   = Math.round(distanceKm(originAirport, destAirport));
    const refP   = referencePrice(origin, dest);
    const market = buildRouteMarket(origin, dest, gameDate, 1, eventDemand.multFor(origin, dest));
    return { dist, refP, market };
  }, [origin, dest, gameDate.month, ready, eventDemand]);

  const effectivePrice = price ?? routeData?.refP ?? 200;

  // Already operating this pair?
  const alreadyActive = useMemo(() =>
    state.routes.some(r =>
      (r.origin === origin && r.destination === dest) ||
      (r.origin === dest   && r.destination === origin)
    ),
    [state.routes, origin, dest]
  );

  // Regulatory restriction check (depends on route, frequency, AND selected aircraft type)
  const routeRestriction = useMemo(() => {
    if (!routeData) return null;
    const selectedType = getAircraftType(selectedTypeId);
    const category = selectedType?.category ?? null;
    // Total proposed weekly frequency on this pair (existing routes + this assignment),
    // plus route context so DCA's perimeter exemption-slot / 7-per-week caps evaluate.
    const pairKey = [origin, dest].sort().join('-');
    const existingPairFreq = (state.routes ?? [])
      .filter(r => [r.origin, r.destination].sort().join('-') === pairKey)
      .reduce((s, r) => s + r.weeklyFrequency, 0);
    return checkRouteRestrictions(origin, dest, routeData.dist, existingPairFreq + frequency, category,
      { routes: state.routes, excludeKey: pairKey });
  }, [origin, dest, routeData, frequency, selectedTypeId, state.routes]);

  // Competitors on this route (use live state.competitors)
  const competitorsOnRoute = useMemo(() => {
    if (!ready || !routeData) return [];
    const routeKey = [origin, dest].sort().join('-');
    return (state.competitors ?? [])
      .filter(c => c.routes?.[routeKey])
      .map(c => {
        const cfg   = c.routes[routeKey];
        const offer = buildCompetitorOffer(c, routeData.market);
        return { competitor: c, cfg, offer };
      });
  }, [ready, routeData, origin, dest, state.competitors]);

  // Aircraft types that can reach this route
  const reachableTypes = useMemo(() => {
    if (!routeData) return [];
    return AIRCRAFT_TYPES.filter(t => t.range >= routeData.dist);
  }, [routeData]);

  // Auto-select first reachable type when route changes
  useMemo(() => {
    if (reachableTypes.length && !reachableTypes.find(t => t.id === selectedTypeId)) {
      setSelectedTypeId(reachableTypes[0]?.id ?? '');
    }
  }, [reachableTypes]);

  // Idle aircraft in fleet, by type
  const idleByType = useMemo(() => {
    const map = {};
    state.fleet.filter(a => a.status === 'idle').forEach(a => {
      (map[a.typeId] = map[a.typeId] ?? []).push(a);
    });
    return map;
  }, [state.fleet]);

  // All aircraft you own of the selected type (idle first) — used as config sources.
  const fleetOfType = useMemo(() => {
    if (!selectedTypeId) return [];
    return state.fleet
      .filter(a => a.typeId === selectedTypeId)
      .sort((a, b) => (a.status === 'idle' ? 0 : 1) - (b.status === 'idle' ? 0 : 1));
  }, [state.fleet, selectedTypeId]);

  // When the selected aircraft type changes, seed the cabin config: prefer the real
  // layout of an idle aircraft you own, else an idle one of any status, else default.
  useEffect(() => {
    const type = getAircraftType(selectedTypeId);
    if (!type) { setCabinConfig(null); return; }
    const seed = fleetOfType.find(a => a.config) ?? null;
    if (seed?.config) {
      setCabinConfig({ ...defaultConfig(type.seats), ...seed.config });
      setConfigSource(seed.id);
    } else {
      setCabinConfig(makePreset('economy', type.seats));
      setConfigSource('economy');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTypeId]);

  // Apply a chosen config source (fleet aircraft id or preset id) to the layout.
  function handleConfigSource(src) {
    setConfigSource(src);
    const type = getAircraftType(selectedTypeId);
    if (!type) return;
    if (src === 'custom') return; // keep current edited layout
    const fleetMatch = fleetOfType.find(a => a.id === src);
    if (fleetMatch?.config) {
      setCabinConfig({ ...defaultConfig(type.seats), ...fleetMatch.config });
    } else {
      setCabinConfig(makePreset(src, type.seats));
    }
  }

  // The cabin config actually fed into the simulation.
  const effectiveConfig = useMemo(() => {
    const type = getAircraftType(selectedTypeId);
    if (!type) return null;
    return cabinConfig ?? defaultConfig(type.seats);
  }, [cabinConfig, selectedTypeId]);

  // Pre-count player routes at each endpoint (for hub feed bonus)
  const routeCountAtOrigin = useMemo(
    () => state.routes.filter(r => r.origin === origin || r.destination === origin).length,
    [state.routes, origin]
  );
  const routeCountAtDest = useMemo(
    () => state.routes.filter(r => r.origin === dest || r.destination === dest).length,
    [state.routes, dest]
  );

  // Simulate the selected aircraft type
  const simulation = useMemo(() => {
    if (!routeData || !selectedTypeId) return null;
    const type = getAircraftType(selectedTypeId);
    if (!type || routeData.dist > type.range) return null;

    const simAircraft = { id:'p', typeId: selectedTypeId, ageWeeks: 0, config: effectiveConfig ?? undefined };
    // Premium cabins earn their multiplier fares (business 2.5×, first 5×, etc.) —
    // matching defaultClassPrices, which is what ADD_ROUTE assigns when the route is
    // opened. Without this the forecast would charge every cabin the economy fare.
    const classPrices = defaultClassPrices(effectivePrice);

    // Real operational inputs (morale, fleet utilization, earned satisfaction) so
    // the forecast quality matches what the engine will actually compute.
    const avgUtil = fleetAvgUtilization(state.fleet ?? [], [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]);
    const satisfaction = state.satisfaction ?? null;

    const result = simulateRoute(
      { id:'p', origin, destination: dest, aircraftId:'p', weeklyFrequency: frequency, ticketPrice: effectivePrice, classPrices, hub: state.hub, cateringLevel },
      simAircraft,
      gameDate,
      state.labor ?? null, 1.0, null, [], avgUtil, satisfaction,
      eventDemand.multFor(origin, dest),
    );
    if (!result) return null;

    // Also simulate week-0 (launch day) so the player sees the maturity ramp effect.
    const resultLaunch = simulateRoute(
      { id:'p', origin, destination: dest, aircraftId:'p', weeklyFrequency: frequency, ticketPrice: effectivePrice, classPrices, hub: state.hub, cateringLevel, weeksOpen: 0 },
      simAircraft,
      gameDate,
      state.labor ?? null, 1.0, null, [], avgUtil, satisfaction,
      eventDemand.multFor(origin, dest),
    );

    // Connecting passenger estimate
    const connecting = computeConnectingDemand(
      origin, dest, state.hubs ?? (state.hub ? { [state.hub]: { tier: 1 } } : {}),
      routeCountAtOrigin + 1, // +1 to include this planned route
      routeCountAtDest   + 1,
      effectivePrice,
    );

    const totalRevenue = result.revenue + connecting.totalRevenue;
    const netProfit    = totalRevenue - result.totalOpCost - type.weeklyLease;

    // Market share breakdown: player vs all competitors.
    // Seat counts and quality reflect the chosen cabin configuration so the
    // share estimate matches what simulateRoute computes internally.
    const cfg = effectiveConfig ?? defaultConfig(type.seats);
    const playerOffer = {
      airlineId: 'player',
      origin, destination: dest,
      economyPrice: effectivePrice,
      businessPrice: (cfg.businessClass ?? 0) > 0 ? classPrices.businessClass : null,
      weeklyFrequency: frequency,
      seatsPerFlight: configBodies(cfg),
      economySeats: (cfg.economy ?? type.seats) * frequency,
      businessSeats: (cfg.businessClass ?? 0) * frequency,
      totalSeats: configBodies(cfg) * frequency,
      qualityScore: Math.max(0, Math.min(100, (() => {
        const fx = laborEffects(state.labor ?? null, avgUtil, satisfaction);
        return computeQualityScore({ onTimeRate: fx.onTimeRate, cabinPoints: cabinQualityPoints(cfg), fleetAgeYears: 0, customerRating: fx.customerRating })
          + (fx.groundQualityBonus ?? 0);
      })()
        + configSpaceQualityBonus(cfg, type)
        + cateringQualityBonus(cateringLevel, routeData.dist))),
      connectivityBonus: (origin === state.hub || dest === state.hub) ? 0.20 : 0,
    };
    const competitorOffers = competitorsOnRoute.map(c => c.offer).filter(Boolean);
    const allOffers  = [playerOffer, ...competitorOffers];
    const shareResults = computeMarketShare(routeData.market, allOffers);
    const playerShare  = shareResults.find(s => s.airlineId === 'player');

    return { result, resultLaunch, type, netProfit, totalRevenue, connecting, playerOffer, shareResults, playerShare };
  }, [routeData, selectedTypeId, frequency, effectivePrice, cateringLevel, effectiveConfig, competitorsOnRoute, state.hub, origin, dest, gameDate, routeCountAtOrigin, routeCountAtDest]);

  function handleOpenRoute(aircraftId) {
    dispatch({ type: 'ADD_ROUTE', origin, destination: dest, aircraftId, weeklyFrequency: frequency, ticketPrice: effectivePrice, cateringLevel, season });
  }

  function handleSwap() {
    const o = origin; setOrigin(dest); setDest(o); setPrice(null);
  }

  const pricePct = routeData ? Math.round((effectivePrice / routeData.refP - 1) * 100) : 0;
  const totalDemand = routeData ? routeData.market.leisureDemand + routeData.market.businessDemand : 0;

  // Freight / multi-stop modes render their dedicated planners
  // (hooks above always run first, so this is safe).
  if (mode === 'freight') {
    return <CargoRoutePlanner mode={mode} setMode={setMode} />;
  }
  if (mode === 'tag') {
    return <TagRoutePlanner mode={mode} setMode={setMode} />;
  }

  return (
    <div>

      <ModeToggle mode={mode} setMode={setMode} />

      {/* ── Route Finder: discover unserved routes by demand ── */}
      <RouteFinder onPick={(o, d) => { setOrigin(o); setDest(d); setPrice(null); }} />

      {/* ── Route picker ── */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <AirportPicker label="From" value={origin} onChange={c => { setOrigin(c); setPrice(null); }} exclude={dest} />
          <button
            className="btn btn-ghost"
            style={{ padding: '8px 10px', marginBottom: 2, fontSize: 18, flexShrink: 0 }}
            onClick={handleSwap}
            disabled={!origin || !dest}
            title="Swap airports"
          >⇄</button>
          <AirportPicker label="To" value={dest} onChange={c => { setDest(c); setPrice(null); }} exclude={origin} />
        </div>
      </div>

      {!ready && (
        <div className="empty-state" style={{ marginTop: 32 }}>
          <div className="empty-state-icon"><Glyph e="🗺️" /></div>
          <div className="empty-state-text">Select two airports to analyse a route</div>
          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>
            You'll see market demand, competitor activity, and estimated economics.
          </div>
        </div>
      )}

      {ready && routeData && (
        <>
          {/* ── Market overview ── */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.3 }}>
                  {origin} → {dest}
                  {alreadyActive && (
                    <span style={{ marginLeft: 10, fontSize: 12, background: 'rgba(56,139,253,0.15)', color: 'var(--accent)', borderRadius: 4, padding: '2px 8px', fontWeight: 600, verticalAlign: 'middle' }}>
                      <Glyph e="✈" /> Operating
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                  {originAirport.city} → {destAirport.city} · {routeData.dist.toLocaleString()} km
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <Stat label="Market Demand" value={totalDemand.toLocaleString()} sub="pax / wk one-way" color="var(--accent)" />
              <Stat label="Leisure"       value={routeData.market.leisureDemand.toLocaleString()} sub="price-sensitive" />
              <Stat label="Business"      value={routeData.market.businessDemand.toLocaleString()} sub="quality-sensitive" />
              <Stat label="Ref Price"     value={`$${routeData.refP}`} sub="economy one-way" />
              <Stat label="Seasonality"   value={`×${routeData.market.seasonalityFactor.toFixed(2)}`} sub={`month ${gameDate.month}`} />
            </div>

            {/* Demand bar */}
            <div style={{ marginTop: 14 }}>
              <div style={{ height: 6, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
                <div style={{ flex: 85, background: 'var(--accent)', opacity: 0.6 }} />
                <div style={{ flex: 15, background: 'var(--purple)' }} />
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 4, fontSize: 11, color: 'var(--text-dim)' }}>
                <span><span style={{ color: 'var(--accent)' }}>■</span> Leisure 85%</span>
                <span><span style={{ color: 'var(--purple)' }}>■</span> Business 15%</span>
              </div>
            </div>
          </div>

          {/* ── Regulatory restriction banner ── */}
          {routeRestriction && (
            <div style={{
              background: 'rgba(220,53,69,0.10)',
              border: '1px solid rgba(220,53,69,0.40)',
              borderRadius: 'var(--radius)',
              padding: '12px 16px',
              marginBottom: 12,
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
            }}>
              <span style={{ fontSize: 20, flexShrink: 0 }}><Glyph e="🚫" /></span>
              <div>
                <div style={{ fontWeight: 700, color: 'var(--red)', fontSize: 14, marginBottom: 4 }}>
                  {routeRestriction.restriction.label}
                  <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, background: 'rgba(220,53,69,0.15)', borderRadius: 3, padding: '2px 6px' }}>
                    {routeRestriction.restriction.shortLabel}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {routeRestriction.restriction.description}
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--red)', fontWeight: 500 }}>
                  <Glyph e="⛔" /> This route cannot be launched: {routeRestriction.reason.split(': ')[1] ?? routeRestriction.reason}
                </div>
              </div>
            </div>
          )}

          {/* ── Competitors ── */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
              Competitors on this route
              {competitorsOnRoute.length === 0 && (
                <span style={{ fontSize: 12, color: 'var(--green)', fontWeight: 400 }}>— none yet, you'd have the market to yourself</span>
              )}
            </div>

            {competitorsOnRoute.length > 0 && (
              <div style={{ overflowX: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface2)' }}>
                      {['Airline', 'Tier', 'Flights/wk', 'Weekly Seats', 'Est. Price', 'Quality'].map((h, i) => (
                        <th key={i} style={{ padding: '7px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {competitorsOnRoute.map(({ competitor: c, cfg, offer }) => {
                      const estPrice = offer?.economyPrice ?? Math.round(routeData.refP * cfg.priceMultiplier);
                      const estSeats = offer?.economySeats ?? (150 * cfg.frequency);
                      const priceDiff = Math.round((estPrice / routeData.refP - 1) * 100);
                      return (
                        <tr key={c.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '8px 12px', fontWeight: 600 }}>{c.name}</td>
                          <td style={{ padding: '8px 12px' }}><TierBadge tier={c.tier} /></td>
                          <td style={{ padding: '8px 12px' }}>{cfg.frequency}× each way</td>
                          <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{(estSeats * 2).toLocaleString()} / wk</td>
                          <td style={{ padding: '8px 12px' }}>
                            ${estPrice}
                            <span style={{ fontSize: 11, marginLeft: 6, color: priceDiff > 0 ? 'var(--red)' : 'var(--green)' }}>
                              ({priceDiff >= 0 ? '+' : ''}{priceDiff}%)
                            </span>
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ width: 60, height: 5, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
                                <div style={{ width: `${c.baseQualityScore}%`, height: '100%', background: c.tier === 'premium' ? 'var(--purple)' : c.tier === 'budget' ? 'var(--yellow)' : 'var(--accent)' }} />
                              </div>
                              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.baseQualityScore}/100</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Your economics ── */}
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: 14 }}>Your estimated economics</div>

            {reachableTypes.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                None of your aircraft can reach {origin} → {dest} ({routeData.dist.toLocaleString()} km).
                Lease a longer-range aircraft from the Market first.
              </div>
            ) : (
              <>
                {/* Controls row */}
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 20, alignItems: 'flex-end' }}>

                  {/* Aircraft picker */}
                  <div style={{ flex: '1 1 200px', maxWidth: 320 }}>
                    <div className="form-label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      Aircraft type
                      <InfoTip text="Only aircraft that can reach this route are listed. The number after each type (e.g. “— 2 idle”) is how many unassigned planes of that type you own. Pick a type with idle planes and you can deploy one straight away with “Open Route”." />
                    </div>
                    <select
                      className="form-select"
                      value={selectedTypeId}
                      onChange={e => setSelectedTypeId(e.target.value)}
                    >
                      {reachableTypes.map(t => {
                        const idle = idleByType[t.id]?.length ?? 0;
                        return (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.seats} seats){idle > 0 ? ` — ${idle} idle` : ''}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  {/* Frequency */}
                  <div>
                    <div className="form-label" style={{ marginBottom: 6 }}>Flights / week</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="range" min="1" max="14" step="1"
                        value={frequency}
                        onChange={e => setFrequency(Number(e.target.value))}
                        style={{ width: 110, accentColor: 'var(--accent)' }}
                      />
                      <span style={{ fontWeight: 700, minWidth: 22 }}>{frequency}×</span>
                    </div>
                  </div>

                  {/* Price */}
                  <div>
                    <div className="form-label" style={{ marginBottom: 6 }}>Ticket price</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="range"
                        min={Math.round(routeData.refP * 0.4)}
                        max={Math.round(routeData.refP * 2.5)}
                        step="5"
                        value={effectivePrice}
                        onChange={e => setPrice(Number(e.target.value))}
                        style={{ width: 110, accentColor: 'var(--accent)' }}
                      />
                      <span style={{ fontWeight: 700, minWidth: 38 }}>${effectivePrice}</span>
                      <span style={{ fontSize: 11, minWidth: 52,
                        color: pricePct > 10 ? 'var(--red)' : pricePct < -10 ? 'var(--green)' : 'var(--text-muted)',
                      }}>
                        {pricePct >= 0 ? `+${pricePct}` : pricePct}% vs ref
                      </span>
                      {price !== null && (
                        <button className="btn btn-ghost" style={{ padding: '2px 7px', fontSize: 11 }} onClick={() => setPrice(null)}>Reset</button>
                      )}
                    </div>
                  </div>

                  {/* Cabin configuration */}
                  <CabinConfigPanel
                    type={getAircraftType(selectedTypeId)}
                    config={effectiveConfig}
                    onChange={cfg => { setCabinConfig(cfg); }}
                    source={configSource}
                    onSourceChange={handleConfigSource}
                    fleetOptions={fleetOfType}
                  />

                  {/* Catering */}
                  <div style={{ flexBasis: '100%' }}>
                    <CateringSelector value={cateringLevel} onChange={setCateringLevel} distKm={routeData.dist} />
                  </div>

                  {/* Seasonal operating window */}
                  <div style={{ flexBasis: '100%' }}>
                    <SeasonPicker value={season} onChange={setSeason} currentMonth={gameDate.month} />
                  </div>
                </div>

                {/* Results */}
                {simulation && (
                  <>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>

                      {/* Economics grid */}
                      <div style={{ flex: '1 1 320px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, background: 'var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', alignSelf: 'flex-start' }}>
                        {[
                          { label: 'Weekly Capacity', value: (configBodies(effectiveConfig ?? defaultConfig(simulation.type.seats)) * frequency * 2).toLocaleString(), sub: 'seats (both dirs)' },
                          { label: 'O&D Passengers',  value: simulation.result.passengers.toLocaleString(), sub: 'direct pax / wk' },
                          { label: 'Load Factor',
                            value: simulation.resultLaunch && simulation.resultLaunch.loadFactor < simulation.result.loadFactor
                              ? `${formatPercent(simulation.resultLaunch.loadFactor)} → ${formatPercent(simulation.result.loadFactor)}`
                              : formatPercent(simulation.result.loadFactor),
                            sub: simulation.resultLaunch && simulation.resultLaunch.loadFactor < simulation.result.loadFactor
                              ? 'launch → mature (12 wks)'
                              : undefined,
                            color: simulation.result.loadFactor >= 0.75 ? 'var(--green)' : simulation.result.loadFactor >= 0.45 ? 'var(--yellow)' : 'var(--red)',
                          },
                          { label: 'O&D Revenue',       value: formatMoney(simulation.result.revenue),           color: 'var(--green)' },
                          { label: 'Connecting Rev',    value: `+${formatMoney(simulation.connecting.totalRevenue)}`, color: 'var(--accent)',
                            sub: `${simulation.connecting.totalPax} connecting pax` },
                          { label: 'Total Revenue',     value: formatMoney(simulation.totalRevenue),             color: 'var(--green)' },
                          { label: 'Op Cost / wk',      value: formatMoney(simulation.result.totalOpCost),       color: 'var(--red)' },
                          { label: 'Lease / wk',        value: formatMoney(simulation.type.weeklyLease),         color: 'var(--text-muted)' },
                          { label: 'Net Profit / wk',
                            value: (simulation.netProfit >= 0 ? '+' : '') + formatMoney(simulation.netProfit),
                            color: simulation.netProfit >= 0 ? 'var(--green)' : 'var(--red)',
                          },
                        ].map((cell, i) => (
                          <div key={i} style={{ background: 'var(--surface2)', padding: '10px 12px' }}>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 }}>{cell.label}</div>
                            <div style={{ fontWeight: 700, fontSize: 14, color: cell.color ?? 'var(--text)' }}>{cell.value}</div>
                            {cell.sub && <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>{cell.sub}</div>}
                          </div>
                        ))}
                      </div>

                      {/* Right column: market share + connecting breakdown */}
                      <div style={{ flex: '0 0 210px', display: 'flex', flexDirection: 'column', gap: 12 }}>

                        {/* Market share */}
                        {competitorsOnRoute.length > 0 && simulation.shareResults && (
                          <div style={{ background: 'var(--surface2)', borderRadius: 'var(--radius)', padding: '12px 14px' }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>Est. Market Share</div>
                            {simulation.shareResults.map(s => {
                              const isPlayer = s.airlineId === 'player';
                              const name     = isPlayer ? 'You' : (state.competitors ?? []).find(c => c.id === s.airlineId)?.name ?? s.airlineId;
                              const sharePct = totalDemand > 0 ? Math.round(s.totalPax / totalDemand * 100) : 0;
                              return (
                                <div key={s.airlineId} style={{ marginBottom: 8 }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                                    <span style={{ color: isPlayer ? 'var(--text)' : 'var(--text-muted)', fontWeight: isPlayer ? 600 : 400 }}>{name}</span>
                                    <span style={{ color: isPlayer ? 'var(--green)' : 'var(--text-dim)' }}>{sharePct}%</span>
                                  </div>
                                  <div style={{ height: 5, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
                                    <div style={{ width: `${sharePct}%`, height: '100%', background: isPlayer ? 'var(--green)' : 'var(--accent)', opacity: isPlayer ? 1 : 0.4 }} />
                                  </div>
                                </div>
                              );
                            })}
                            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>price · quality · frequency</div>
                          </div>
                        )}

                        {/* Connecting breakdown */}
                        {simulation.connecting.totalPax > 0 && (
                          <div style={{ background: 'var(--surface2)', borderRadius: 'var(--radius)', padding: '12px 14px' }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>Connecting Pax</div>
                            {[
                              { label: origin,      side: simulation.connecting.origin      },
                              { label: dest,        side: simulation.connecting.destination  },
                            ].map(({ label, side }) => side.pax > 0 && (
                              <div key={label} style={{ marginBottom: 8 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                                  <span style={{ fontWeight: 600 }}>{label}</span>
                                  <span style={{ color: side.source === 'own-hub' ? 'var(--green)' : 'var(--accent)' }}>
                                    +{side.pax} pax
                                  </span>
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                                  {side.source === 'own-hub'
                                    ? `Hub feed · ${formatMoney(side.revenue)} (100% yield)`
                                    : `${side.source === 'partner-hub' ? 'Partner hub' : 'Gateway'} · ${formatMoney(side.revenue)} (80% yield)`
                                  }
                                </div>
                              </div>
                            ))}
                            <div style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                              <span style={{ color: 'var(--text-muted)' }}>Total connecting</span>
                              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{formatMoney(simulation.connecting.totalRevenue)}/wk</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}

                {/* Open route CTA */}
                {simulation && (() => {
                  const idle       = idleByType[selectedTypeId] ?? [];
                  // Deploy the aircraft you chose as the config source if it's idle,
                  // so the plane that flies matches the forecast above.
                  const preferred  = idle.find(a => a.id === configSource) ?? idle[0];
                  const lCost      = routeLaunchCost(routeData.dist);
                  const canAfford  = state.cash >= lCost;
                  const blocked    = !!routeRestriction;
                  return (
                    <div style={{ marginTop: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                        {blocked ? (
                          <button className="btn btn-primary" style={{ padding: '8px 20px', opacity: 0.35, cursor: 'not-allowed' }} disabled>
                            <Glyph e="🚫" /> Route Blocked by Regulation
                          </button>
                        ) : preferred ? (
                          <button
                            className="btn btn-primary"
                            style={{ padding: '8px 20px', opacity: canAfford ? 1 : 0.5 }}
                            disabled={!canAfford}
                            onClick={() => handleOpenRoute(preferred.id)}
                          >
                            Open Route with {preferred.tailNumber || preferred.name}
                          </button>
                        ) : (
                          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                            No idle {simulation.type.name} available — lease one from the Market first.
                          </div>
                        )}
                        {simulation.netProfit < 0 && (
                          <span style={{ fontSize: 12, color: 'var(--yellow)' }}>
                            <Glyph e="⚠" /> Route is currently unprofitable at these settings
                          </span>
                        )}
                      </div>
                      {!blocked && (
                        <div style={{ fontSize: 12, color: canAfford ? 'var(--text-muted)' : 'var(--red)' }}>
                          <Glyph e={canAfford ? '💸' : '⚠'} size={12} /> One-time launch cost: <strong>{formatMoney(lCost)}</strong>
                          {!canAfford && ' — insufficient cash'}
                          <span style={{ marginLeft: 8, color: 'var(--text-dim)' }}>
                            (regulatory filings, slot deposits, launch marketing)
                          </span>
                        </div>
                      )}
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
