import { useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { getAircraftType, effectivePurchasePrice, buyDiscount } from '../data/aircraft.js';
import {
  formatMoney,
  CLASS_FARE_MULTIPLIERS,
  CLASS_SPACE_MULTIPLIERS,
  SEAT_QUALITY_COST_PER_ROUTE,
  SERVICE_QUALITY_COST_PER_ROUTE,
  weekToGameDate,
  configRangeMod,
} from '../utils/simulation.js';
import { absoluteWeek } from '../utils/fuel.js';
import { Glyph, GlyphLabel } from './Icons.jsx';
import CabinTemplatePicker from './CabinTemplatePicker.jsx';

const CAT_COLORS = {
  'Turboprop':    '#ffb43d',
  'Regional Jet': '#38d39f',
  'Narrow Body':  '#3ea6ff',
  'Wide Body':    '#a98bff',
};

const DELIVERY_LEAD = {
  'Wide Body':    4,
  'Narrow Body':  3,
  'Regional Jet': 2,
  'Turboprop':    1,
};

const QUALITY_OPTIONS = [
  { value: 'basic',    label: 'Basic',    desc: 'Budget fittings, no frills.' },
  { value: 'standard', label: 'Standard', desc: 'Comfortable, no-nonsense.' },
  { value: 'premium',  label: 'Premium',  desc: 'Enhanced seats, better meals.' },
  { value: 'luxury',   label: 'Luxury',   desc: 'Flagship product. Premium cost.' },
];

const CLASS_COLORS = {
  firstClass:     '#bc8cff',
  businessClass:  '#ffb43d',
  premiumEconomy: '#3ea6ff',
  economy:        '#38d39f',
};


function absWeekToDisplay(absWeek) {
  const year       = Math.floor((absWeek - 1) / 52) + 1;
  const weekInYear = ((absWeek - 1) % 52) + 1;
  const { monthName, weekInMonth } = weekToGameDate(weekInYear);
  return { displayYear: year, displayWeek: weekInYear, monthName, weekInMonth };
}

function AircraftPhoto({ src, alt, category }) {
  const [failed, setFailed] = useState(false);
  const color = CAT_COLORS[category] || '#93a4ba';
  if (failed || !src) {
    return (
      <div style={{
        width: '100%', height: 160,
        background: `linear-gradient(160deg, ${color}18 0%, transparent 100%)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: '10px 10px 0 0',
      }}>
        <span style={{ fontSize: 56, opacity: 0.2 }}><Glyph e="✈" /></span>
      </div>
    );
  }
  return (
    <img src={src} alt={alt}
      style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: '10px 10px 0 0', display: 'block' }}
      onError={() => setFailed(true)}
    />
  );
}

// ── Compact class row with inline +/- ────────────────────────────────────────
function ClassRow({ label, color, fareLabel, spaceLabel, value, max, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '7px 0',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
          {fareLabel} · {spaceLabel}
        </div>
      </div>
      {/* − / value / + */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <button
          onClick={() => onChange(Math.max(0, value - 1))}
          disabled={value === 0}
          style={{
            width: 26, height: 26, borderRadius: 5,
            border: '1px solid var(--border)', background: 'var(--surface2)',
            color: value === 0 ? 'var(--text-dim)' : 'var(--text)',
            cursor: value === 0 ? 'default' : 'pointer',
            fontSize: 16, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >−</button>
        <input
          type="number" min={0} max={max} value={value}
          onChange={e => onChange(Math.min(max, Math.max(0, parseInt(e.target.value, 10) || 0)))}
          style={{
            width: 50, textAlign: 'center', fontSize: 14, fontWeight: 600,
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 5, color: 'var(--text)', padding: '3px 4px',
          }}
        />
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          style={{
            width: 26, height: 26, borderRadius: 5,
            border: '1px solid var(--border)', background: 'var(--surface2)',
            color: value >= max ? 'var(--text-dim)' : 'var(--text)',
            cursor: value >= max ? 'default' : 'pointer',
            fontSize: 16, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >+</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', width: 30, textAlign: 'right', flexShrink: 0 }}>
        seats
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AircraftCheckout({ typeId, mode, onClose }) {
  const { state, dispatch, remote } = useGame();
  const { cash, fleet, pendingOrders = [], year, week } = state;

  // Headwinds multiplayer only: the first 2 aircraft a player ever takes deliver
  // instantly. `starterDeliveriesRemaining` > 0 means this order (and the next,
  // up to the cap) skips the delivery wait entirely.
  const STARTER_DELIVERY_CAP     = 2;
  const starterDeliveriesRemaining = remote
    ? Math.max(0, STARTER_DELIVERY_CAP - (state.starterDeliveriesUsed ?? 0))
    : 0;

  const type = getAircraftType(typeId);
  if (!type) return null;

  const isFreighter   = !!type.freighter;
  const catColor      = CAT_COLORS[type.category] || '#93a4ba';
  const configOptions = type.configOptions ?? {};
  const engines       = configOptions.engines ?? [];
  const wingtipDef    = configOptions.wingtips ?? null;
  const maxSeats      = type.seats;

  // ── Engine / wingtip ──────────────────────────────────────────────────────
  const defaultEngine = engines.find(e => e.default) ?? engines[0];
  const [selectedEngineId, setSelectedEngineId] = useState(defaultEngine?.id ?? null);
  const [hasWingtips, setHasWingtips]            = useState(false);

  // ── Quantity ──────────────────────────────────────────────────────────────
  const [quantity, setQuantity] = useState(1);

  // ── Custom name (optional) ────────────────────────────────────────────────
  const [customName, setCustomName] = useState('');

  // ── Cabin configuration ───────────────────────────────────────────────────
  const [first, setFirstRaw] = useState(0);
  const [biz,   setBizRaw]   = useState(0);
  const [prem,  setPremRaw]  = useState(0);
  const [eco,   setEcoRaw]   = useState(maxSeats);   // ← now user-controlled
  const [seatQ, setSeatQ]    = useState('standard');
  const [servQ, setServQ]    = useState('standard');

  // Clamp economy whenever premium classes change to avoid over-allocation
  function clampEco(f, b, p, currentEco) {
    const premUnits = f * CLASS_SPACE_MULTIPLIERS.firstClass
                    + b * CLASS_SPACE_MULTIPLIERS.businessClass
                    + p * CLASS_SPACE_MULTIPLIERS.premiumEconomy;
    const maxE = Math.max(0, Math.floor((maxSeats - premUnits) / CLASS_SPACE_MULTIPLIERS.economy));
    return Math.min(currentEco, maxE);
  }
  function setFirst(v) { setFirstRaw(v); setEcoRaw(e => clampEco(v,   biz,  prem, e)); }
  function setBiz(v)   { setBizRaw(v);   setEcoRaw(e => clampEco(first, v,   prem, e)); }
  function setPrem(v)  { setPremRaw(v);  setEcoRaw(e => clampEco(first, biz,  v,   e)); }
  function setEco(v)   { setEcoRaw(v); }

  // Apply a saved cabin template (clamped defensively to this type's floor space)
  function applyTemplate(cfg) {
    const f = Math.max(0, cfg.firstClass ?? 0);
    const b = Math.max(0, cfg.businessClass ?? 0);
    const p = Math.max(0, cfg.premiumEconomy ?? 0);
    setFirstRaw(f);
    setBizRaw(b);
    setPremRaw(p);
    setEcoRaw(clampEco(f, b, p, Math.max(0, cfg.economy ?? 0)));
    setSeatQ(cfg.seatQuality ?? 'standard');
    setServQ(cfg.serviceQuality ?? 'standard');
  }

  const usedUnits = first * CLASS_SPACE_MULTIPLIERS.firstClass
                  + biz   * CLASS_SPACE_MULTIPLIERS.businessClass
                  + prem  * CLASS_SPACE_MULTIPLIERS.premiumEconomy
                  + eco   * CLASS_SPACE_MULTIPLIERS.economy;
  const over = usedUnits > maxSeats;

  const maxFirst = Math.floor(
    (maxSeats - biz * CLASS_SPACE_MULTIPLIERS.businessClass - prem * CLASS_SPACE_MULTIPLIERS.premiumEconomy - eco * CLASS_SPACE_MULTIPLIERS.economy)
    / CLASS_SPACE_MULTIPLIERS.firstClass
  );
  const maxBiz = Math.floor(
    (maxSeats - first * CLASS_SPACE_MULTIPLIERS.firstClass - prem * CLASS_SPACE_MULTIPLIERS.premiumEconomy - eco * CLASS_SPACE_MULTIPLIERS.economy)
    / CLASS_SPACE_MULTIPLIERS.businessClass
  );
  const maxPrem = Math.floor(
    (maxSeats - first * CLASS_SPACE_MULTIPLIERS.firstClass - biz * CLASS_SPACE_MULTIPLIERS.businessClass - eco * CLASS_SPACE_MULTIPLIERS.economy)
    / CLASS_SPACE_MULTIPLIERS.premiumEconomy
  );
  const maxEco = Math.max(0, Math.floor(
    (maxSeats - first * CLASS_SPACE_MULTIPLIERS.firstClass - biz * CLASS_SPACE_MULTIPLIERS.businessClass - prem * CLASS_SPACE_MULTIPLIERS.premiumEconomy)
    / CLASS_SPACE_MULTIPLIERS.economy
  ));

  // Revenue index vs all-economy
  const totalPhysical = first + biz + prem + eco;
  const revenueIndex = totalPhysical > 0
    ? (first / totalPhysical) * CLASS_FARE_MULTIPLIERS.firstClass
    + (biz   / totalPhysical) * CLASS_FARE_MULTIPLIERS.businessClass
    + (prem  / totalPhysical) * CLASS_FARE_MULTIPLIERS.premiumEconomy
    + (eco   / totalPhysical) * CLASS_FARE_MULTIPLIERS.economy
    : 1;

  const extraQualityCost =
    (SEAT_QUALITY_COST_PER_ROUTE[seatQ] ?? 0) +
    (SERVICE_QUALITY_COST_PER_ROUTE[servQ] ?? 0);

  // Freighters carry cargo, not passengers — no cabin layout to choose. Pass null
  // so delivery falls back to the (irrelevant) default config.
  const cabinConfig = isFreighter ? null : {
    firstClass:     first,
    businessClass:  biz,
    premiumEconomy: prem,
    economy:        eco,
    seatQuality:    seatQ,
    serviceQuality: servQ,
  };

  // ── Engine / wingtip modifiers ────────────────────────────────────────────
  const selectedEngine    = engines.find(e => e.id === selectedEngineId) ?? defaultEngine;
  const engineFuelMod     = selectedEngine?.fuelMod  ?? 1.0;
  const enginePriceMod    = selectedEngine?.priceMod ?? 1.0;
  const engineMaintMod    = selectedEngine?.maintMod ?? 1.0;
  const wingtipFuelMod    = (hasWingtips && wingtipDef) ? (wingtipDef.fuelMod  ?? 1.0) : 1.0;
  const wingtipRangeMod   = (hasWingtips && wingtipDef) ? (wingtipDef.rangeMod ?? 1.0) : 1.0;
  const wingtipCost       = (hasWingtips && wingtipDef) ? (wingtipDef.cost     ?? 0)   : 0;
  const combinedFuelMod   = Math.round(engineFuelMod * wingtipFuelMod * 10000) / 10000;
  const fuelPctSaving     = Math.round((1 - combinedFuelMod) * 100);
  const rangePctGain      = Math.round((wingtipRangeMod - 1) * 100);
  const maintPctChange    = Math.round((engineMaintMod - 1) * 100);
  const effectiveRange    = Math.round(type.range * wingtipRangeMod);
  // Cabin-density range bonus (fewer passengers = more range)
  const cabinForRange     = { firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco };
  const cabinRangeMod     = configRangeMod(cabinForRange, type);
  const effectiveRangeFull = Math.round(type.range * wingtipRangeMod * cabinRangeMod);
  const cabinRangePctGain  = Math.round((cabinRangeMod - 1) * 100);
  const isSparse           = eco < maxEco || (first + biz + prem + eco) < maxSeats;

  // ── Delivery schedule ─────────────────────────────────────────────────────
  const lead           = DELIVERY_LEAD[type.category] ?? 2;
  const currentAbsWeek = absoluteWeek(year, week);
  const pendingOfType  = pendingOrders.filter(o => o.typeId === typeId);

  const deliveryWeeks = [];
  let runningMax = pendingOfType.length > 0
    ? Math.max(...pendingOfType.map(o => o.deliverAbsWeek))
    : null;
  for (let i = 0; i < quantity; i++) {
    const w = runningMax === null ? currentAbsWeek + 2 * lead : runningMax + lead;
    deliveryWeeks.push(w);
    runningMax = w;
  }
  const firstDelivery = deliveryWeeks[0];
  const lastDelivery  = deliveryWeeks[deliveryWeeks.length - 1];
  const { displayYear: firstYear, monthName: firstMon, weekInMonth: firstWIM } = absWeekToDisplay(firstDelivery);
  const { displayYear: lastYear,  monthName: lastMon,  weekInMonth: lastWIM  } = absWeekToDisplay(lastDelivery);

  // ── Pricing ───────────────────────────────────────────────────────────────
  const fleetCountNow   = fleet.filter(a => a.typeId === typeId).length;
  const pendingCountNow = pendingOfType.length;
  const alreadyOwned    = fleetCountNow + pendingCountNow;
  const discount        = buyDiscount(alreadyOwned);
  const discPct         = Math.round(discount * 100);
  const baseUnitPrice   = effectivePurchasePrice(type, alreadyOwned);
  const enginePriceAdj  = Math.round(baseUnitPrice * (enginePriceMod - 1));
  const unitBuyPrice    = Math.round(baseUnitPrice * enginePriceMod) + wingtipCost;
  const totalBuyPrice   = unitBuyPrice * quantity;

  const baseWeeklyLease  = type.weeklyLease;
  const engineLeaseAdj   = Math.round(baseWeeklyLease * (enginePriceMod - 1));
  const wingtipLeaseAdj  = (hasWingtips && wingtipDef) ? Math.round((wingtipDef.cost ?? 0) / 200) : 0;
  const unitWeeklyLease  = baseWeeklyLease + engineLeaseAdj + wingtipLeaseAdj;
  const totalWeeklyLease = unitWeeklyLease * quantity;
  const unitLeaseDeposit  = unitWeeklyLease * 12;   // 3 months (12 weeks) upfront
  const totalLeaseDeposit = unitLeaseDeposit * quantity;

  const canAfford     = mode === 'buy' ? cash >= totalBuyPrice : cash >= totalLeaseDeposit;
  const maxAffordable = mode === 'buy'
    ? Math.max(0, Math.floor(cash / unitBuyPrice))
    : Math.max(0, Math.floor(cash / unitLeaseDeposit));

  function setQty(n) { setQuantity(Math.max(1, Math.min(20, n))); }

  function handleConfirm() {
    dispatch({
      type:          'ORDER_AIRCRAFT',
      typeId,
      ownershipType: mode === 'buy' ? 'owned' : 'lease',
      engineId:      selectedEngine?.id ?? null,
      hasWingtips,
      quantity,
      config:        cabinConfig,
      name:          customName.trim() || null,
    });
    onClose();
  }

  // Shared section header style
  const sectionTitle = {
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10,
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--surface2)', borderRadius: 10,
        maxWidth: 540, width: '100%', maxHeight: '92vh', overflowY: 'auto',
        border: '1px solid var(--border)', boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
      }}>
        <AircraftPhoto src={type.image} alt={type.name} category={type.category} />

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{ padding: '14px 20px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 19 }}>{type.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                {type.manufacturer} · <span style={{ color: catColor }}>{type.category}</span>
                {' · '}{isFreighter ? `${type.payloadTonnes}t payload` : `${type.seats} seats`} · {type.range.toLocaleString()} km range
              </div>
            </div>
            <button className="btn btn-ghost" onClick={onClose} style={{ padding: '4px 10px', marginLeft: 8 }}><Glyph e="✕" /></button>
          </div>

          {/* Starter Fleet perk (multiplayer only) — first 2 aircraft ship instantly */}
          {starterDeliveriesRemaining > 0 && (
            <div style={{
              marginTop: 10, padding: '8px 12px',
              background: 'rgba(56,201,180,0.12)', borderRadius: 6,
              fontSize: 12.5, color: 'var(--accent)',
              border: '1px solid rgba(56,201,180,0.35)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span><Glyph e="🎁" /></span>
              <span>
                <strong>Starter Fleet:</strong> your first {STARTER_DELIVERY_CAP} aircraft are delivered instantly
                {' '}— {starterDeliveriesRemaining} {starterDeliveriesRemaining === 1 ? 'is' : 'are'} left.
                {' '}Only the wait is waived; you still pay the price. Later orders arrive on the normal schedule.
              </span>
            </div>
          )}

          {/* Delivery callout */}
          {(() => {
            const instantUnits = Math.min(quantity, starterDeliveriesRemaining);
            const queuedUnits  = quantity - instantUnits;
            return (
          <div style={{
            marginTop: 10, padding: '8px 12px',
            background: 'rgba(56,139,253,0.1)', borderRadius: 6,
            fontSize: 13, color: 'var(--accent)',
            border: '1px solid rgba(56,139,253,0.25)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span><Glyph e="📅" /></span>
              <span>
                {instantUnits > 0 && queuedUnits === 0 ? (
                  quantity === 1
                    ? <>Delivered <strong>instantly</strong> — ready to fly now</>
                    : <><strong>{quantity} aircraft</strong> delivered <strong>instantly</strong> — ready to fly now</>
                ) : instantUnits > 0 ? (
                  <><strong>{instantUnits}</strong> delivered <strong>instantly</strong>, then <strong>{queuedUnits}</strong> from <strong>{lead}w</strong> apart (last in <strong>{lastDelivery - currentAbsWeek}w</strong>)</>
                ) : quantity === 1 ? (
                  <>First delivery in <strong>{firstDelivery - currentAbsWeek}w</strong> (Wk {firstWIM} {firstMon} Y{firstYear})</>
                ) : (
                  <><strong>{quantity} aircraft</strong> — first in <strong>{firstDelivery - currentAbsWeek}w</strong> (Wk {firstWIM} {firstMon} Y{firstYear}), last in <strong>{lastDelivery - currentAbsWeek}w</strong> (Wk {lastWIM} {lastMon} Y{lastYear}) · every {lead}w</>
                )}
                {pendingOfType.length > 0 && (
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {pendingOfType.length} already queued</span>
                )}
              </span>
            </div>
            {quantity > 1 && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(56,139,253,0.2)', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {deliveryWeeks.map((absW, i) => {
                  if (i < instantUnits) {
                    return (
                      <span key={i} style={{
                        fontSize: 11, padding: '2px 7px', borderRadius: 4,
                        background: 'rgba(56,201,180,0.18)', color: 'var(--accent)',
                        border: '1px solid rgba(56,201,180,0.4)',
                      }}>#{i+1} — Now</span>
                    );
                  }
                  const { displayYear: dy, monthName: mn, weekInMonth: wim } = absWeekToDisplay(absW);
                  return (
                    <span key={i} style={{
                      fontSize: 11, padding: '2px 7px', borderRadius: 4,
                      background: 'rgba(56,139,253,0.15)', color: 'var(--accent)',
                      border: '1px solid rgba(56,139,253,0.25)',
                    }}>#{i+1} — {absW - currentAbsWeek}w (Wk {wim} {mn} Y{dy})</span>
                  );
                })}
              </div>
            )}
          </div>
            );
          })()}
        </div>

        <div style={{ padding: '14px 20px' }}>

          {/* ── Quantity ─────────────────────────────────────────────────── */}
          <section style={{ marginBottom: 18 }}>
            <div style={sectionTitle}>Quantity</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button onClick={() => setQty(quantity - 1)} disabled={quantity <= 1}
                style={{ width: 34, height: 34, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface2)', color: quantity <= 1 ? 'var(--text-dim)' : 'var(--text)', fontSize: 18, cursor: quantity <= 1 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
              <div style={{ textAlign: 'center', minWidth: 52 }}>
                <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{quantity}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>aircraft</div>
              </div>
              <button onClick={() => setQty(quantity + 1)} disabled={quantity >= 20 || (mode === 'buy' && quantity >= maxAffordable)}
                style={{ width: 34, height: 34, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface2)', color: (quantity >= 20 || (mode === 'buy' && quantity >= maxAffordable)) ? 'var(--text-dim)' : 'var(--text)', fontSize: 18, cursor: (quantity >= 20 || (mode === 'buy' && quantity >= maxAffordable)) ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
              <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
                {[1, 3, 5, 10].filter(n => n <= (mode === 'buy' ? maxAffordable : 20)).map(n => (
                  <button key={n} onClick={() => setQty(n)} style={{ padding: '4px 9px', borderRadius: 5, border: `1px solid ${quantity === n ? 'var(--accent)' : 'var(--border)'}`, background: quantity === n ? 'rgba(56,139,253,0.15)' : 'var(--surface2)', color: quantity === n ? 'var(--accent)' : 'var(--text-muted)', fontSize: 12, fontWeight: quantity === n ? 600 : 400, cursor: 'pointer' }}>{n}</button>
                ))}
              </div>
            </div>
          </section>

          {/* ── Custom name ──────────────────────────────────────────────── */}
          <section style={{ marginBottom: 18 }}>
            <div style={sectionTitle}>Aircraft Name <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></div>
            <input
              type="text"
              value={customName}
              maxLength={40}
              onChange={e => setCustomName(e.target.value)}
              placeholder={`e.g. "Spirit of ${type.manufacturer}" — defaults to ${type.name} #N`}
              style={{
                width: '100%', padding: '8px 12px', fontSize: 13,
                background: 'var(--surface2)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 7, outline: 'none',
              }}
              onFocus={e => { e.target.style.borderColor = 'var(--accent)'; }}
              onBlur={e => { e.target.style.borderColor = 'var(--border)'; }}
            />
            {customName.trim() && quantity > 1 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>
                Aircraft will be named “{customName.trim()} #1” through “{customName.trim()} #{quantity}”
              </div>
            )}
          </section>

          {/* ── Engine options ───────────────────────────────────────────── */}
          {engines.length > 1 && (
            <section style={{ marginBottom: 18 }}>
              <div style={sectionTitle}>Engine Options</div>
              {engines.map(eng => {
                const isSelected = selectedEngineId === eng.id;
                const fuelDelta  = Math.round((eng.fuelMod - 1) * 100);
                const priceDelta = Math.round((eng.priceMod - 1) * 100);
                const maintDelta = Math.round(((eng.maintMod ?? 1.0) - 1) * 100);
                return (
                  <label key={eng.id} style={{ display: 'flex', gap: 10, padding: '9px 12px', marginBottom: 5, borderRadius: 7, border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`, background: isSelected ? 'rgba(56,139,253,0.08)' : 'var(--surface2)', cursor: 'pointer', transition: 'all 0.15s' }}>
                    <input type="radio" name={`engine-${typeId}`} value={eng.id} checked={isSelected} onChange={() => setSelectedEngineId(eng.id)} style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{eng.label}</span>
                        {eng.default && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'rgba(56,139,253,0.15)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,0.3)' }}>default</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{eng.description}</div>
                      <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11, flexWrap: 'wrap' }}>
                        {fuelDelta !== 0 && <span style={{ color: fuelDelta < 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{fuelDelta < 0 ? '↓' : '↑'} {Math.abs(fuelDelta)}% fuel</span>}
                        {maintDelta !== 0 && <span style={{ color: maintDelta > 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{maintDelta > 0 ? '↑' : '↓'} {Math.abs(maintDelta)}% maint</span>}
                        {priceDelta > 0 && <span style={{ color: 'var(--text-muted)' }}>+{priceDelta}% {mode === 'buy' ? 'unit price' : 'lease rate'}</span>}
                        {fuelDelta === 0 && maintDelta === 0 && priceDelta === 0 && <span style={{ color: 'var(--text-muted)' }}>Standard — no premium</span>}
                      </div>
                    </div>
                  </label>
                );
              })}
            </section>
          )}

          {/* ── Wingtip ──────────────────────────────────────────────────── */}
          {wingtipDef && (
            <section style={{ marginBottom: 18 }}>
              <div style={sectionTitle}>Wingtip Package</div>
              <label style={{ display: 'flex', gap: 10, padding: '9px 12px', borderRadius: 7, border: `1px solid ${hasWingtips ? 'var(--accent)' : 'var(--border)'}`, background: hasWingtips ? 'rgba(56,139,253,0.08)' : 'var(--surface2)', cursor: 'pointer', transition: 'all 0.15s' }}>
                <input type="checkbox" checked={hasWingtips} onChange={e => setHasWingtips(e.target.checked)} style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{wingtipDef.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{wingtipDef.description}</div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11, flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--green)', fontWeight: 600 }}>↓ {Math.abs(Math.round((wingtipDef.fuelMod - 1) * 100))}% fuel</span>
                    {wingtipDef.rangeMod && wingtipDef.rangeMod !== 1.0 && (
                      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>↑ {Math.round((wingtipDef.rangeMod - 1) * 100)}% range ({type.range.toLocaleString()} → {effectiveRangeFull.toLocaleString()} km)</span>
                    )}
                    {mode === 'buy' && <span style={{ color: 'var(--text-muted)' }}>+{formatMoney(wingtipDef.cost ?? 0)} per aircraft</span>}
                    {mode === 'lease' && wingtipLeaseAdj > 0 && <span style={{ color: 'var(--text-muted)' }}>+{formatMoney(wingtipLeaseAdj)}/wk per aircraft</span>}
                  </div>
                </div>
              </label>
            </section>
          )}

          {/* ── Cabin configuration (passenger aircraft only) ────────────── */}
          {!isFreighter && (
          <section style={{ marginBottom: 18 }}>
            <div style={sectionTitle}>Cabin Configuration</div>

            {/* Saved templates */}
            <CabinTemplatePicker
              typeId={typeId}
              currentConfig={{ firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco, seatQuality: seatQ, serviceQuality: servQ }}
              onApply={applyTemplate}
            />

            {/* Seat bar */}
            <div style={{ height: 12, borderRadius: 4, overflow: 'hidden', display: 'flex', marginBottom: 6 }}>
              {[
                { units: first * CLASS_SPACE_MULTIPLIERS.firstClass,     color: CLASS_COLORS.firstClass },
                { units: biz   * CLASS_SPACE_MULTIPLIERS.businessClass,  color: CLASS_COLORS.businessClass },
                { units: prem  * CLASS_SPACE_MULTIPLIERS.premiumEconomy, color: CLASS_COLORS.premiumEconomy },
                { units: eco   * CLASS_SPACE_MULTIPLIERS.economy,        color: CLASS_COLORS.economy },
              ].map((seg, i) => seg.units > 0 && (
                <div key={i} style={{ width: `${(seg.units / maxSeats) * 100}%`, background: seg.color }} />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
              <span style={{ color: over ? 'var(--red)' : undefined }}>
                {over
                  ? <GlyphLabel size={11} text={`⚠ Over-allocated by ${(usedUnits - maxSeats).toFixed(1)} seat-units`} />
                  : `${usedUnits.toFixed(1)} / ${maxSeats} seat-units used`}
              </span>
              <span>{first + biz + prem + eco} physical seats</span>
            </div>

            {/* Class rows */}
            <ClassRow
              label="First Class" color={CLASS_COLORS.firstClass}
              fareLabel={`${CLASS_FARE_MULTIPLIERS.firstClass}× fare`}
              spaceLabel={`${CLASS_SPACE_MULTIPLIERS.firstClass}× space`}
              value={first} max={maxFirst} onChange={setFirst}
            />
            <ClassRow
              label="Business Class" color={CLASS_COLORS.businessClass}
              fareLabel={`${CLASS_FARE_MULTIPLIERS.businessClass}× fare`}
              spaceLabel={`${CLASS_SPACE_MULTIPLIERS.businessClass}× space`}
              value={biz} max={maxBiz} onChange={setBiz}
            />
            <ClassRow
              label="Premium Economy" color={CLASS_COLORS.premiumEconomy}
              fareLabel={`${CLASS_FARE_MULTIPLIERS.premiumEconomy}× fare`}
              spaceLabel={`${CLASS_SPACE_MULTIPLIERS.premiumEconomy}× space`}
              value={prem} max={maxPrem} onChange={setPrem}
            />

            <ClassRow
              label="Economy" color={CLASS_COLORS.economy}
              fareLabel={`${CLASS_FARE_MULTIPLIERS.economy}× fare`}
              spaceLabel={`${CLASS_SPACE_MULTIPLIERS.economy}× space`}
              value={eco} max={maxEco} onChange={setEco}
            />
            {/* Sparse-cabin range callout */}
            {isSparse && (
              <div style={{
                marginTop: 6, padding: '6px 10px',
                background: 'rgba(56,139,253,0.08)', borderRadius: 5,
                fontSize: 11, color: 'var(--accent)',
                border: '1px solid rgba(56,139,253,0.2)',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span><Glyph e="✈" /></span>
                <span>
                  Sparse cabin — effective range{' '}
                  <strong>{effectiveRangeFull.toLocaleString()} km</strong>
                  {cabinRangePctGain > 0 && <span style={{ color: 'var(--green)', marginLeft: 4 }}>(+{cabinRangePctGain}% vs full load)</span>}
                  {' · '}{first + biz + prem + eco} seats / {maxSeats} capacity
                </span>
              </div>
            )}

            {/* Seat & service quality */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Seat Quality</div>
                <select
                  value={seatQ} onChange={e => setSeatQ(e.target.value)}
                  style={{ width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer' }}
                >
                  {QUALITY_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
                  ))}
                </select>
                {SEAT_QUALITY_COST_PER_ROUTE[seatQ] > 0 && (
                  <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 3 }}>
                    +{formatMoney(SEAT_QUALITY_COST_PER_ROUTE[seatQ])}/route/wk
                  </div>
                )}
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Service Quality</div>
                <select
                  value={servQ} onChange={e => setServQ(e.target.value)}
                  style={{ width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer' }}
                >
                  {QUALITY_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
                  ))}
                </select>
                {SERVICE_QUALITY_COST_PER_ROUTE[servQ] > 0 && (
                  <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 3 }}>
                    +{formatMoney(SERVICE_QUALITY_COST_PER_ROUTE[servQ])}/route/wk
                  </div>
                )}
              </div>
            </div>

            {/* Revenue preview */}
            <div style={{
              marginTop: 10, padding: '8px 12px',
              background: 'var(--surface2)', borderRadius: 6,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              fontSize: 12,
            }}>
              <span style={{ color: 'var(--text-muted)' }}>Blended revenue index vs all-economy</span>
              <span style={{ fontWeight: 700, color: revenueIndex > 1.05 ? 'var(--green)' : revenueIndex > 1 ? 'var(--yellow)' : 'var(--text-muted)' }}>
                {revenueIndex.toFixed(2)}×
              </span>
            </div>
          </section>
          )}

          {/* ── Order summary ────────────────────────────────────────────── */}
          <section style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 14 }}>
            <div style={sectionTitle}>Order Summary</div>

            {mode === 'buy' ? (
              <div style={{ fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                  <span>Base price per aircraft{discPct > 0 && <span style={{ marginLeft: 5, fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>(−{discPct}% fleet)</span>}</span>
                  <span style={{ color: 'var(--text)' }}>{formatMoney(baseUnitPrice)}</span>
                </div>
                {enginePriceAdj !== 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>Engine: {selectedEngine?.label}</span>
                    <span style={{ color: 'var(--text)' }}>{enginePriceAdj > 0 ? '+' : ''}{formatMoney(enginePriceAdj)}</span>
                  </div>
                )}
                {wingtipCost > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>{wingtipDef?.label}</span>
                    <span style={{ color: 'var(--text)' }}>+{formatMoney(wingtipCost)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Unit price</span>
                  <span>{formatMoney(unitBuyPrice)}</span>
                </div>
                {quantity > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>× {quantity} aircraft</span>
                    <span style={{ color: 'var(--text)' }}>{formatMoney(unitBuyPrice)} × {quantity}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, borderTop: '1px solid var(--border)', fontWeight: 700, fontSize: 15 }}>
                  <span>Total{quantity > 1 ? ` (${quantity} aircraft)` : ''}</span>
                  <span style={{ color: canAfford ? 'var(--green)' : 'var(--red)' }}>{formatMoney(totalBuyPrice)}</span>
                </div>
                {!canAfford && (
                  <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, textAlign: 'right' }}>
                    Need {formatMoney(totalBuyPrice - cash)} more{maxAffordable > 0 ? ` · can afford ${maxAffordable}` : ''}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, textAlign: 'right' }}>Full payment due at order</div>
              </div>
            ) : (
              <div style={{ fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                  <span>Base weekly lease</span>
                  <span style={{ color: 'var(--text)' }}>{formatMoney(baseWeeklyLease)}/wk</span>
                </div>
                {engineLeaseAdj !== 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>Engine: {selectedEngine?.label}</span>
                    <span style={{ color: 'var(--text)' }}>{engineLeaseAdj > 0 ? '+' : ''}{formatMoney(engineLeaseAdj)}/wk</span>
                  </div>
                )}
                {wingtipLeaseAdj > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>{wingtipDef?.label}</span>
                    <span style={{ color: 'var(--text)' }}>+{formatMoney(wingtipLeaseAdj)}/wk</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Per aircraft / wk</span>
                  <span>{formatMoney(unitWeeklyLease)}</span>
                </div>
                {quantity > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>× {quantity} aircraft (when all delivered)</span>
                    <span style={{ color: 'var(--text)' }}>{formatMoney(unitWeeklyLease)} × {quantity}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, borderTop: '1px solid var(--border)', fontWeight: 700, fontSize: 15 }}>
                  <span>Total weekly lease</span>
                  <span style={{ color: 'var(--accent)' }}>{formatMoney(totalWeeklyLease)}/wk</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', fontWeight: 700, fontSize: 14 }}>
                  <span>3-month deposit (due now)</span>
                  <span style={{ color: canAfford ? 'var(--green)' : 'var(--red)' }}>{formatMoney(totalLeaseDeposit)}</span>
                </div>
                {!canAfford && (
                  <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, textAlign: 'right' }}>
                    Need {formatMoney(totalLeaseDeposit - cash)} more{maxAffordable > 0 ? ` · can afford ${maxAffordable}` : ''}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, textAlign: 'right' }}>
                  12 weeks × {formatMoney(unitWeeklyLease)}/wk · applied toward first months of lease
                </div>
              </div>
            )}

            {/* Fuel / range / maint callout */}
            {(fuelPctSaving > 0 || rangePctGain > 0 || maintPctChange !== 0) && (
              <div style={{ marginTop: 10, padding: '7px 10px', background: 'rgba(63,185,80,0.1)', borderRadius: 5, fontSize: 12, color: 'var(--green)', border: '1px solid rgba(63,185,80,0.25)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
                  {fuelPctSaving > 0 && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span><Glyph e="⛽" /></span>
                      <span>Saves <strong>{fuelPctSaving}%</strong> fuel vs standard build</span>
                    </span>
                  )}
                  {rangePctGain > 0 && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent)' }}>
                      <span><Glyph e="✈" /></span>
                      <span>Range extended to <strong>{effectiveRange.toLocaleString()} km</strong> (+{rangePctGain}%)</span>
                    </span>
                  )}
                  {maintPctChange !== 0 && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: maintPctChange > 0 ? 'var(--red)' : 'var(--green)' }}>
                      <span><Glyph e="🔧" /></span>
                      <span>Maintenance <strong>{maintPctChange > 0 ? '+' : ''}{maintPctChange}%</strong> vs standard engine</span>
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Cabin summary callout */}
            {(first + biz + prem > 0 || eco < maxEco || seatQ !== 'standard' || servQ !== 'standard') && (
              <div style={{ marginTop: 8, padding: '7px 10px', background: 'rgba(163,113,247,0.1)', borderRadius: 5, fontSize: 12, color: '#a98bff', border: '1px solid rgba(163,113,247,0.25)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span><Glyph e="💺" /></span>
                <span>
                  {[
                    first > 0 && `${first}F`,
                    biz   > 0 && `${biz}J`,
                    prem  > 0 && `${prem}W`,
                    `${eco}Y`,
                  ].filter(Boolean).join(' / ')}
                  {(seatQ !== 'standard' || servQ !== 'standard') && ` · ${seatQ} seats, ${servQ} service`}
                  {' · '}revenue index <strong>{revenueIndex.toFixed(2)}×</strong>
                  {extraQualityCost > 0 && <span style={{ color: 'var(--red)' }}> · +{formatMoney(extraQualityCost)}/route/wk quality costs</span>}
                </span>
              </div>
            )}
          </section>

          {/* ── Actions ──────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              style={{ flex: 2, ...(!canAfford || over ? { background: 'var(--surface3)', color: 'var(--text-dim)', cursor: 'not-allowed', border: '1px solid var(--border)' } : {}) }}
              disabled={!canAfford || over}
              onClick={handleConfirm}
            >
              <GlyphLabel size={13} text={over
                ? '⚠ Fix cabin layout'
                : mode === 'buy'
                  ? `🛒 Order ${quantity > 1 ? quantity + '× ' : ''}${type.name}`
                  : `✍️ Sign Lease${quantity > 1 ? ` × ${quantity}` : ''}`} />
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
