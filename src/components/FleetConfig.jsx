import { Glyph, GlyphLabel } from './Icons.jsx';
import { useState } from 'react';
import CabinTemplatePicker from './CabinTemplatePicker.jsx';
import InfoTip from './InfoTip.jsx';
import { useGame } from '../store/GameContext.jsx';
import { getAircraftType } from '../data/aircraft.js';
import {
  CLASS_FARE_MULTIPLIERS,
  CLASS_SPACE_MULTIPLIERS,
  SEAT_QUALITY_COST_PER_ROUTE,
  SEAT_QUALITY_FITTING_FEE,
  CABIN_INSTALL_FEE_PER_SEAT,
  defaultConfig,
  formatMoney,
  configRangeMod,
  configSpaceQualityBonus,
} from '../utils/simulation.js';

const QUALITY_OPTIONS = [
  { value: 'basic',    label: 'Basic',    desc: 'Slimline seats. The free baseline.' },
  { value: 'standard', label: 'Standard', desc: 'Comfortable seats. Fitting fee + weekly charge.' },
  { value: 'premium',  label: 'Premium',  desc: 'Enhanced product. Boosts quality, adds weekly cost.' },
  { value: 'luxury',   label: 'Luxury',   desc: 'Flagship product. Big quality boost, premium cost.' },
];

/**
 * Calculates the one-time cost to reconfigure a cabin.
 * Charged per seat moved between classes, plus per quality tier change.
 */
function calcReconfCost(current, next) {
  const seatChanges =
    Math.abs((next.firstClass     ?? 0) - (current.firstClass     ?? 0)) +
    Math.abs((next.businessClass  ?? 0) - (current.businessClass  ?? 0)) +
    Math.abs((next.premiumEconomy ?? 0) - (current.premiumEconomy ?? 0));

  // One-off fitting fee to UPGRADE seats above the current tier (downgrades are free).
  const fitUpgrade = Math.max(
    0,
    (SEAT_QUALITY_FITTING_FEE[next.seatQuality    ?? 'basic'] ?? 0) -
    (SEAT_QUALITY_FITTING_FEE[current.seatQuality ?? 'basic'] ?? 0)
  );

  // One-off install fee for premium seats ADDED in this reconfigure (removals are free).
  const premInstall =
    Math.max(0, (next.firstClass     ?? 0) - (current.firstClass     ?? 0)) * CABIN_INSTALL_FEE_PER_SEAT.firstClass +
    Math.max(0, (next.businessClass  ?? 0) - (current.businessClass  ?? 0)) * CABIN_INSTALL_FEE_PER_SEAT.businessClass +
    Math.max(0, (next.premiumEconomy ?? 0) - (current.premiumEconomy ?? 0)) * CABIN_INSTALL_FEE_PER_SEAT.premiumEconomy;

  if (seatChanges === 0 && fitUpgrade === 0 && premInstall === 0) return 0;

  // $2,500 per seat moved + premium-seat install fee + seat-quality fitting fee
  return Math.max(10_000, seatChanges * 2_500 + premInstall + fitUpgrade);
}

export default function FleetConfig({ aircraftId, aircraftIds = null, onClose }) {
  const { state, dispatch } = useGame();

  // Bulk mode: aircraftIds is an array of same-type aircraft; the layout chosen
  // here is applied to all of them (each pays its own refit cost).
  const targetIds = aircraftIds ?? (aircraftId ? [aircraftId] : []);
  const targets   = state.fleet.filter(a => targetIds.includes(a.id));
  const isBulk    = targets.length > 1;

  const aircraft = targets[0];
  const type     = aircraft ? getAircraftType(aircraft.typeId) : null;

  const maxSeats = type?.seats ?? 0;
  const current  = aircraft?.config ?? defaultConfig(maxSeats);

  const [first,  setFirst]  = useState(current.firstClass     ?? 0);
  const [biz,    setBiz]    = useState(current.businessClass  ?? 0);
  const [prem,   setPrem]   = useState(current.premiumEconomy ?? 0);
  const [ecoSeats, setEcoSeats] = useState(current.economy    ?? maxSeats);
  const [seatQ,  setSeatQ]  = useState(current.seatQuality    ?? 'basic');

  // Apply a saved cabin template (economy clamped to remaining floor space)
  function applyTemplate(cfg) {
    const f = Math.max(0, cfg.firstClass ?? 0);
    const b = Math.max(0, cfg.businessClass ?? 0);
    const p = Math.max(0, cfg.premiumEconomy ?? 0);
    const premUnits = f * CLASS_SPACE_MULTIPLIERS.firstClass
                    + b * CLASS_SPACE_MULTIPLIERS.businessClass
                    + p * CLASS_SPACE_MULTIPLIERS.premiumEconomy;
    const maxE = Math.max(0, Math.floor(maxSeats - premUnits));
    setFirst(f);
    setBiz(b);
    setPrem(p);
    setEcoSeats(Math.min(Math.max(0, cfg.economy ?? 0), maxE));
    setSeatQ(cfg.seatQuality ?? 'basic');
  }

  // Premium classes take more floor space: First=2×, Business=1.5×, PremEco=1.25×.
  const premiumUnits = first * CLASS_SPACE_MULTIPLIERS.firstClass
                     + biz   * CLASS_SPACE_MULTIPLIERS.businessClass
                     + prem  * CLASS_SPACE_MULTIPLIERS.premiumEconomy;
  // Economy is player-set, but capped to the floor units left after premium cabins.
  const ecoMax = Math.max(0, Math.floor(maxSeats - premiumUnits));
  const eco    = Math.min(Math.max(0, ecoSeats), ecoMax);
  const usedUnits  = premiumUnits + eco * CLASS_SPACE_MULTIPLIERS.economy;
  const emptyUnits = Math.max(0, maxSeats - usedUnits);   // deliberately unfilled floor
  const over = premiumUnits > maxSeats;

  // Density dynamics preview (range + comfort from a lighter / roomier cabin).
  const previewConfig = { firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco };
  const baseRangeKm   = Math.round((type?.range ?? 0) * (aircraft?.rangeMod ?? 1.0));
  const cfgRangeKm     = Math.round(baseRangeKm * configRangeMod(previewConfig, type));
  const rangeGainPct   = baseRangeKm > 0 ? Math.round((cfgRangeKm / baseRangeKm - 1) * 100) : 0;
  const spaceQualityBonus = configSpaceQualityBonus(previewConfig, type);

  // Reconfiguration cost — in bulk mode each aircraft pays its own refit cost
  // (they may start from different current layouts).
  const nextConfig = { firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco, seatQuality: seatQ, serviceQuality: 'standard' };
  const perAircraftCosts = targets.map(a =>
    calcReconfCost(a.config ?? defaultConfig(maxSeats), nextConfig)
  );
  const reconfCost = perAircraftCosts.reduce((s, c) => s + c, 0);
  const canAfford  = state.cash >= reconfCost;
  const noChange   = reconfCost === 0;

  function handleSave() {
    if (over || !canAfford) return;
    targets.forEach((a, i) => {
      dispatch({
        type:       'CONFIGURE_AIRCRAFT',
        aircraftId: a.id,
        config:     nextConfig,
        reconfCost: perAircraftCosts[i],
      });
    });
    onClose();
  }

  // Revenue index: blended fare multiplier vs all-economy
  const revenueIndex = maxSeats > 0
    ? (first / maxSeats) * CLASS_FARE_MULTIPLIERS.firstClass     +
      (biz   / maxSeats) * CLASS_FARE_MULTIPLIERS.businessClass  +
      (prem  / maxSeats) * CLASS_FARE_MULTIPLIERS.premiumEconomy +
      (eco   / maxSeats) * CLASS_FARE_MULTIPLIERS.economy
    : 1;

  const extraQualityCost = SEAT_QUALITY_COST_PER_ROUTE[seatQ] ?? 0;

  if (!aircraft || !type) return null;

  return (
    <div className="bankrupt-overlay" onClick={onClose}>
      <div
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
                 padding: 28, width: '100%', maxWidth: 580, maxHeight: '90vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700 }}>
              {isBulk ? `Configure ${targets.length} × ${type.name}` : `Configure ${aircraft.name}`}
            </h2>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {type.name} · {maxSeats} total seats · Current cash: <strong style={{ color: 'var(--green)' }}>{formatMoney(state.cash)}</strong>
            </div>
            {isBulk && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, maxWidth: 420 }}>
                Applying to: {targets.slice(0, 6).map(a => a.name).join(', ')}{targets.length > 6 ? `, +${targets.length - 6} more` : ''}
              </div>
            )}
          </div>
          <button className="btn btn-ghost" style={{ padding: '4px 10px', flexShrink: 0 }} onClick={onClose}><Glyph e="✕" /></button>
        </div>

        {/* Cabin Layout */}
        <div style={{ marginBottom: 22 }}>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Cabin Layout
            <InfoTip text="Any mix works, including all-premium. Premium cabins earn more per seat but each route only has so many premium flyers: overdo it and those seats fly empty. Leaving floor space unused adds range and comfort." />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Set seats per cabin, or hit Max to fill the remaining floor with one class.
            Refits cost $2,500 per seat moved, plus an install fee for new premium seats
            ($200 prem-eco, $500 business, $1,000 first).
          </div>

          <CabinTemplatePicker
            typeId={aircraft.typeId}
            currentConfig={nextConfig}
            onApply={applyTemplate}
          />

          <ClassInput
            label="First Class"
            fareLabel={`${CLASS_FARE_MULTIPLIERS.firstClass}× fare`}
            spaceLabel={`${CLASS_SPACE_MULTIPLIERS.firstClass}× space`}
            revPerSpace={(CLASS_FARE_MULTIPLIERS.firstClass / CLASS_SPACE_MULTIPLIERS.firstClass).toFixed(1)}
            value={first}
            max={Math.floor((maxSeats - biz * CLASS_SPACE_MULTIPLIERS.businessClass - prem * CLASS_SPACE_MULTIPLIERS.premiumEconomy) / CLASS_SPACE_MULTIPLIERS.firstClass)}
            onChange={v => setFirst(v)}
            color="#bc8cff"
          />
          <ClassInput
            label="Business Class"
            fareLabel={`${CLASS_FARE_MULTIPLIERS.businessClass}× fare`}
            spaceLabel={`${CLASS_SPACE_MULTIPLIERS.businessClass}× space`}
            revPerSpace={(CLASS_FARE_MULTIPLIERS.businessClass / CLASS_SPACE_MULTIPLIERS.businessClass).toFixed(1)}
            value={biz}
            max={Math.floor((maxSeats - first * CLASS_SPACE_MULTIPLIERS.firstClass - prem * CLASS_SPACE_MULTIPLIERS.premiumEconomy) / CLASS_SPACE_MULTIPLIERS.businessClass)}
            onChange={v => setBiz(v)}
            color="#ffb43d"
          />
          <ClassInput
            label="Premium Economy"
            fareLabel={`${CLASS_FARE_MULTIPLIERS.premiumEconomy}× fare`}
            spaceLabel={`${CLASS_SPACE_MULTIPLIERS.premiumEconomy}× space`}
            revPerSpace={(CLASS_FARE_MULTIPLIERS.premiumEconomy / CLASS_SPACE_MULTIPLIERS.premiumEconomy).toFixed(1)}
            value={prem}
            max={Math.floor((maxSeats - first * CLASS_SPACE_MULTIPLIERS.firstClass - biz * CLASS_SPACE_MULTIPLIERS.businessClass) / CLASS_SPACE_MULTIPLIERS.premiumEconomy)}
            onChange={v => setPrem(v)}
            color="#3ea6ff"
          />

          {/* Economy (player-set, capped to floor units left after premium cabins) */}
          <ClassInput
            label="Economy"
            fareLabel="1× fare"
            spaceLabel="1× space"
            revPerSpace="1.0"
            value={eco}
            max={ecoMax}
            onChange={v => setEcoSeats(v)}
            color="#38d39f"
          />

          {/* Seat unit bar — width proportional to floor space used; empty floor shown grey */}
          <div style={{ marginTop: 4 }}>
            <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 6, background: 'var(--surface3)' }}>
              {[
                { units: first * CLASS_SPACE_MULTIPLIERS.firstClass,     color: '#bc8cff' },
                { units: biz   * CLASS_SPACE_MULTIPLIERS.businessClass,  color: '#ffb43d' },
                { units: prem  * CLASS_SPACE_MULTIPLIERS.premiumEconomy, color: '#3ea6ff' },
                { units: eco   * CLASS_SPACE_MULTIPLIERS.economy,        color: '#38d39f' },
              ].map((seg, i) => seg.units > 0 && (
                <div key={i} style={{ width: `${(seg.units / maxSeats) * 100}%`, background: seg.color }} />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ color: over ? 'var(--red)' : 'var(--text-muted)' }}>
                {over
                  ? <GlyphLabel size={12} text={`⚠ Over by ${(usedUnits - maxSeats).toFixed(2)} seat units, reduce a class`} />
                  : `${usedUnits.toFixed(1)} / ${maxSeats} seat units used${emptyUnits >= 1 ? ` · ${emptyUnits.toFixed(0)} empty` : ''}`}
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                {first + biz + prem + eco} physical seats total
              </span>
            </div>
          </div>

          {/* Density dynamics: range + comfort from a lighter, roomier cabin */}
          {(rangeGainPct > 0 || spaceQualityBonus > 0) && (
            <div style={{ display: 'flex', gap: 16, marginTop: 12, padding: '10px 12px', background: 'var(--surface2)', borderRadius: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>
                Range <strong style={{ color: 'var(--accent)' }}>+{rangeGainPct}%</strong>
                <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>({baseRangeKm.toLocaleString()} → {cfgRangeKm.toLocaleString()} km)</span>
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                Cabin comfort <strong style={{ color: 'var(--green)' }}>+{spaceQualityBonus}</strong> quality
              </span>
            </div>
          )}
        </div>

        {/* Seat quality */}
        <div style={{ marginBottom: 22 }}>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Seat Quality
            <InfoTip text="Classes decide the layout; seat quality decides the hardware in every one of those seats. A luxury-seat economy cabin beats a basic one for demand, at a cost. Think slimline vs. plush: same class, different seat." />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            The seat hardware fitted throughout this aircraft. Basic is free. Better seats
            lift demand but cost a one-off fitting fee plus a weekly charge per route.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
            <QualityPicker
              label="Seat Quality"
              value={seatQ}
              onChange={setSeatQ}
              current={current.seatQuality ?? 'basic'}
              hint={seatQ === 'basic'
                ? 'Free · no fitting fee, no weekly charge'
                : `One-off fit ${formatMoney(SEAT_QUALITY_FITTING_FEE[seatQ] ?? 0)} · +${formatMoney(SEAT_QUALITY_COST_PER_ROUTE[seatQ] ?? 0)}/route/wk`}
            />
          </div>
        </div>

        {/* Preview */}
        <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8 }}>
            <PreviewStat
              label="Revenue index vs all-economy"
              value={`${revenueIndex.toFixed(2)}×`}
              color={revenueIndex > 1 ? 'var(--green)' : 'var(--text-muted)'}
            />
            <PreviewStat
              label="Extra quality cost / route / wk"
              value={extraQualityCost > 0 ? `+${formatMoney(extraQualityCost)}` : 'None'}
              color={extraQualityCost > 0 ? 'var(--red)' : 'var(--text-muted)'}
            />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Premium seats earn more but draw from a smaller pool of flyers. Pack in too many and they fly empty.
          </div>
        </div>

        {/* Reconfiguration cost banner */}
        {!noChange && (
          <div style={{
            padding: '12px 16px',
            marginBottom: 16,
            borderRadius: 8,
            background: canAfford ? 'rgba(56,139,253,.08)' : 'rgba(248,81,73,.08)',
            border: `1px solid ${canAfford ? 'var(--accent-dim)' : 'rgba(248,81,73,.3)'}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  Reconfiguration cost: <span style={{ color: canAfford ? 'var(--accent)' : 'var(--red)' }}>{formatMoney(reconfCost)}</span>
                  {isBulk && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>across {targets.length} aircraft</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  Paid immediately. Aircraft {isBulk ? 'are' : 'is'} taken out of service for refitting.
                </div>
              </div>
              {!canAfford && (
                <span className="badge badge-red">Can't afford</span>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="btn btn-primary"
            style={{ flex: 1, padding: 10 }}
            onClick={handleSave}
            disabled={over || (!noChange && !canAfford)}
          >
            {noChange ? 'No Changes' : `Confirm Refit${isBulk ? ` (${targets.length} aircraft)` : ''} · ${formatMoney(reconfCost)}`}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ClassInput({ label, fareLabel, spaceLabel, revPerSpace, value, max, onChange, color }) {
  const clamp = v => Math.min(max, Math.max(0, v));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
      <div style={{ width: 12, height: 12, borderRadius: 2, background: color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {fareLabel} · {spaceLabel} ·{' '}
          <span title="Revenue potential per unit of floor space, higher is more efficient use of the cabin">
            {revPerSpace}× rev/space
          </span>
        </div>
      </div>
      <div className="seat-stepper">
        <button type="button" aria-label={`Fewer ${label} seats`} onClick={() => onChange(clamp(value - 1))} disabled={value <= 0}>−</button>
        <input
          type="number"
          min={0}
          max={max}
          value={value}
          onChange={e => onChange(clamp(parseInt(e.target.value, 10) || 0))}
        />
        <button type="button" aria-label={`More ${label} seats`} onClick={() => onChange(clamp(value + 1))} disabled={value >= max}>+</button>
      </div>
      <button
        type="button"
        className="seat-max-btn"
        title={`Fill the remaining floor space with ${label} (${max} seats max)`}
        onClick={() => onChange(max)}
        disabled={value >= max}
      >
        Max
      </button>
    </div>
  );
}

function QualityPicker({ label, value, onChange, current, hint }) {
  const changed = value !== current;
  return (
    <div>
      <div className="form-label">{label} {changed && <span style={{ color: 'var(--yellow)', fontSize: 10 }}>CHANGED</span>}</div>
      <select className="form-select" value={value} onChange={e => onChange(e.target.value)}>
        {QUALITY_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
        ))}
      </select>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{hint}</div>
    </div>
  );
}

function PreviewStat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color }}>{value}</div>
    </div>
  );
}
