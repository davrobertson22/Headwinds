import { Glyph, GlyphLabel } from './Icons.jsx';
import { useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { getAircraftType } from '../data/aircraft.js';
import {
  CLASS_FARE_MULTIPLIERS,
  CLASS_SPACE_MULTIPLIERS,
  SEAT_QUALITY_COST_PER_ROUTE,
  SERVICE_QUALITY_COST_PER_ROUTE,
  defaultConfig,
  formatMoney,
  configRangeMod,
  configSpaceQualityBonus,
} from '../utils/simulation.js';

const QUALITY_LEVELS = { basic: 0, standard: 1, premium: 2, luxury: 3 };

const QUALITY_OPTIONS = [
  { value: 'basic',    label: 'Basic',    desc: 'Budget fittings, no frills.' },
  { value: 'standard', label: 'Standard', desc: 'Comfortable and no-nonsense.' },
  { value: 'premium',  label: 'Premium',  desc: 'Enhanced seats, better meals.' },
  { value: 'luxury',   label: 'Luxury',   desc: 'Flagship product. Premium cost.' },
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

  const seatQDiff = Math.abs(
    (QUALITY_LEVELS[next.seatQuality    ?? 'standard'] ?? 1) -
    (QUALITY_LEVELS[current.seatQuality ?? 'standard'] ?? 1)
  );
  const servQDiff = Math.abs(
    (QUALITY_LEVELS[next.serviceQuality    ?? 'standard'] ?? 1) -
    (QUALITY_LEVELS[current.serviceQuality ?? 'standard'] ?? 1)
  );

  const anyChange = seatChanges > 0 || seatQDiff > 0 || servQDiff > 0;
  if (!anyChange) return 0;

  // $2,500 per seat moved + $30,000 per quality tier changed (both axes)
  return Math.max(10_000, seatChanges * 2_500 + (seatQDiff + servQDiff) * 30_000);
}

export default function FleetConfig({ aircraftId, onClose }) {
  const { state, dispatch } = useGame();
  const aircraft = state.fleet.find(a => a.id === aircraftId);
  const type     = aircraft ? getAircraftType(aircraft.typeId) : null;

  const maxSeats = type?.seats ?? 0;
  const current  = aircraft?.config ?? defaultConfig(maxSeats);

  const [first,  setFirst]  = useState(current.firstClass     ?? 0);
  const [biz,    setBiz]    = useState(current.businessClass  ?? 0);
  const [prem,   setPrem]   = useState(current.premiumEconomy ?? 0);
  const [ecoSeats, setEcoSeats] = useState(current.economy    ?? maxSeats);
  const [seatQ,  setSeatQ]  = useState(current.seatQuality    ?? 'standard');
  const [servQ,  setServQ]  = useState(current.serviceQuality ?? 'standard');

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

  // Reconfiguration cost
  const nextConfig = { firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco, seatQuality: seatQ, serviceQuality: servQ };
  const reconfCost = calcReconfCost(current, nextConfig);
  const canAfford  = state.cash >= reconfCost;
  const noChange   = reconfCost === 0;

  function handleSave() {
    if (over || !canAfford) return;
    dispatch({
      type:       'CONFIGURE_AIRCRAFT',
      aircraftId,
      config:     nextConfig,
      reconfCost,
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

  const extraQualityCost =
    (SEAT_QUALITY_COST_PER_ROUTE[seatQ]  ?? 0) +
    (SERVICE_QUALITY_COST_PER_ROUTE[servQ] ?? 0);

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
            <h2 style={{ fontSize: 18, fontWeight: 700 }}>Configure {aircraft.name}</h2>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {type.name} · {maxSeats} total seats · Current cash: <strong style={{ color: 'var(--green)' }}>{formatMoney(state.cash)}</strong>
            </div>
          </div>
          <button className="btn btn-ghost" style={{ padding: '4px 10px', flexShrink: 0 }} onClick={onClose}><Glyph e="✕" /></button>
        </div>

        {/* Cabin Layout */}
        <div style={{ marginBottom: 22 }}>
          <div className="card-title">Cabin Layout</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Set each cabin's seat count. Leaving floor space empty trades seats for more
            range and a roomier, higher-quality cabin. Each seat moved costs $2,500 to refit.
          </div>

          <ClassInput
            label="First Class"
            fareLabel={`${CLASS_FARE_MULTIPLIERS.firstClass}× fare`}
            spaceLabel={`${CLASS_SPACE_MULTIPLIERS.firstClass}× floor space`}
            value={first}
            max={Math.floor((maxSeats - biz * CLASS_SPACE_MULTIPLIERS.businessClass - prem * CLASS_SPACE_MULTIPLIERS.premiumEconomy) / CLASS_SPACE_MULTIPLIERS.firstClass)}
            onChange={v => setFirst(v)}
            color="#bc8cff"
          />
          <ClassInput
            label="Business Class"
            fareLabel={`${CLASS_FARE_MULTIPLIERS.businessClass}× fare`}
            spaceLabel={`${CLASS_SPACE_MULTIPLIERS.businessClass}× floor space`}
            value={biz}
            max={Math.floor((maxSeats - first * CLASS_SPACE_MULTIPLIERS.firstClass - prem * CLASS_SPACE_MULTIPLIERS.premiumEconomy) / CLASS_SPACE_MULTIPLIERS.businessClass)}
            onChange={v => setBiz(v)}
            color="#ffb43d"
          />
          <ClassInput
            label="Premium Economy"
            fareLabel={`${CLASS_FARE_MULTIPLIERS.premiumEconomy}× fare`}
            spaceLabel={`${CLASS_SPACE_MULTIPLIERS.premiumEconomy}× floor space`}
            value={prem}
            max={Math.floor((maxSeats - first * CLASS_SPACE_MULTIPLIERS.firstClass - biz * CLASS_SPACE_MULTIPLIERS.businessClass) / CLASS_SPACE_MULTIPLIERS.premiumEconomy)}
            onChange={v => setPrem(v)}
            color="#3ea6ff"
          />

          {/* Economy (player-set, capped to floor units left after premium cabins) */}
          <ClassInput
            label="Economy"
            fareLabel="1× fare"
            spaceLabel="1× floor space"
            value={eco}
            max={ecoMax}
            onChange={v => setEcoSeats(v)}
            color="#38d39f"
          />
          {eco < ecoMax && (
            <button
              onClick={() => setEcoSeats(ecoMax)}
              style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 8px 24px' }}
            >
              ↥ Fill remaining floor ({ecoMax - eco} more economy seats)
            </button>
          )}

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
                  ? <GlyphLabel size={12} text={`⚠ Over by ${(usedUnits - maxSeats).toFixed(2)} seat units — reduce a class`} />
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

        {/* Quality */}
        <div style={{ marginBottom: 22 }}>
          <div className="card-title">Cabin Quality</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Upgrading or downgrading quality costs $30,000 per tier change and affects passenger demand.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <QualityPicker
              label="Seat Quality"
              value={seatQ}
              onChange={setSeatQ}
              current={current.seatQuality ?? 'standard'}
              hint={`Weekly cost per route: ${extraQualityCost > 0 ? '+' + formatMoney(SEAT_QUALITY_COST_PER_ROUTE[seatQ] ?? 0) : 'none'}`}
            />
            <QualityPicker
              label="Service Quality"
              value={servQ}
              onChange={setServQ}
              current={current.serviceQuality ?? 'standard'}
              hint={`Weekly cost per route: ${extraQualityCost > 0 ? '+' + formatMoney(SERVICE_QUALITY_COST_PER_ROUTE[servQ] ?? 0) : 'none'}`}
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
            Premium classes earn more per seat but serve a smaller share of total route demand — pack too many and they'll fly empty.
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
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  Paid immediately. Aircraft is taken out of service for refitting.
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
            {noChange ? 'No Changes' : `Confirm Refit · ${formatMoney(reconfCost)}`}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ClassInput({ label, fareLabel, spaceLabel, value, max, onChange, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
      <div style={{ width: 12, height: 12, borderRadius: 2, background: color, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fareLabel} · {spaceLabel}</div>
      </div>
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={e => onChange(Math.min(max, Math.max(0, parseInt(e.target.value, 10) || 0)))}
        className="form-input"
        style={{ width: 72, textAlign: 'center', flexShrink: 0 }}
      />
      <div style={{ fontSize: 11, color: 'var(--text-muted)', width: 40, flexShrink: 0 }}>seats</div>
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
