import { useGame } from '../store/GameContext.jsx';
import {
  LABOR_GROUPS, LABOR_GROUP_MAP, DEFAULT_LABOR_STATE, DEFAULT_MAINTENANCE_BUDGET,
  moraleTarget, moraleColor,
  CREW_LEAD_WEEKS, CREW_SEVERE_SHORTFALL, CREW_INSTANT_AIRCRAFT, crewRequired,
  crewAvailable, crewInTraining, crewShortfall, crewHireCost, splitStarterHire,
} from '../data/labor.js';
import {
  DEFAULT_LABOR_RELATIONS, unrestBand, strikeProbability,
  counterOfferMultiplier, settlementPayMultiplier, UNREST_STRIKE_THRESHOLD,
} from '../data/laborRelations.js';
import {
  AIRCRAFT_FAMILY, FAMILY_INFO, FAMILY_CATEGORY_LABEL,
  activeFamilies as getActiveFamilies, weeklyFamilyBaseCost,
  fleetComplexityMultiplier, COMPLEXITY_AFFECTED_GROUPS,
  FLEET_COMPLEXITY_PCT_PER_EXTRA_FAMILY,
} from '../data/families.js';
import { formatMoney, weeklyBlockHours, routeDistanceKm } from '../utils/simulation.js';
import { getAircraftType } from '../data/aircraft.js';
import { dueInfo, autoSchedulingActive, AUTO_SCHEDULE_PAY_MIN, AUTO_SCHEDULE_BUDGET_MIN } from '../data/maintenance.js';
import { absoluteWeek } from '../utils/fuel.js';
import {
  calcHQCost, hqBracket, weeklyInsuranceCost,
  awarenessDemandMultiplier, marketingAwarenessGain,
  AWARENESS_PARITY, AWARENESS_FLOOR, AWARENESS_DECAY_RATE,
  campaignDemandBoostPct, campaignEquilibriumStrength,
  shareOfVoiceFactor, competitorPressureDrag,
} from '../data/overhead.js';
import { competitorMarketingSpend } from '../models/competitorAI.js';
import { getAirport } from '../data/airports.js';
import { useState, useEffect } from 'react';
import { normalizeCateringLevel } from '../data/catering.js';
import CateringSelector from './CateringSelector.jsx';
import { Glyph } from './Icons.jsx';

// ─── Headcount estimation ─────────────────────────────────────────────────────

// Market-rate weekly wage (fully loaded) assumed for one in-house ground
// staffer — used to derive a realistic headcount from the ground staff budget.
const GROUND_STAFF_MARKET_WAGE_WK = 900;

/**
 * Estimate headcount per labor group from actual fleet + route data.
 *
 * Pilots & cabin crew:  constrained by EASA/FAA block-hour limits.
 * Ground staff:         scales with weekly departures.
 * Maintenance:          scales with block hours + base staffing per airframe.
 */
export function estimateHeadcount(groupId, fleet, routes) {
  const n = fleet.length;
  if (n === 0) return 0;

  // Total weekly block hours across all routes on all aircraft
  const totalBlockHrs = fleet.reduce((sum, aircraft) => {
    const type = getAircraftType(aircraft.typeId);
    if (!type) return sum;
    return sum + routes
      .filter(r => r.aircraftId === aircraft.id)
      .reduce((s, r) => s + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, type), 0);
  }, 0);

  // Average economy-equivalent seats per aircraft (for cabin crew sizing)
  const avgSeats = fleet.reduce((sum, a) => sum + (getAircraftType(a.typeId)?.seats ?? 100), 0) / n;

  switch (groupId) {
    case 'pilots': {
      // Wide bodies need 3 on the flight deck (captain + FO + relief for rest requirements).
      // Narrow body / regional / turboprop: 2 (captain + FO).
      // Computed per-aircraft so mixed fleets get the right blend.
      // Each pilot certified for ~22 effective block hrs/wk; 15% scheduling buffer.
      return fleet.reduce((sum, aircraft) => {
        const type      = getAircraftType(aircraft.typeId);
        const deckCrew  = type?.category === 'Wide Body' ? 3 : 2;
        const acBlockHrs = routes
          .filter(r => r.aircraftId === aircraft.id)
          .reduce((s, r) => s + weeklyBlockHours(routeDistanceKm(r.origin, r.destination), r.weeklyFrequency, type), 0);
        const flying = Math.ceil((acBlockHrs / 22) * deckCrew * 1.15);
        return sum + Math.max(deckCrew, flying); // at least a full deck on retainer per aircraft
      }, 0);
    }
    case 'cabinCrew': {
      // Min 1 FA per 50 seats (FAA requirement); ~30 effective block hrs/wk per FA
      const crewPerFlight = Math.max(1, Math.ceil(avgSeats / 50));
      const minRetainer   = n * crewPerFlight;
      const flying        = Math.ceil((totalBlockHrs / 30) * crewPerFlight * 1.15);
      return Math.max(minRetainer, flying);
    }
    case 'groundStaff': {
      // In-house core team only (gate leads, ops control, supervisors) —
      // per-flight handling labor is outsourced and billed separately via the
      // ground handling fee on each departure. Headcount is what the base
      // (1.0×) budget employs at a market ground-staff wage (~$900/wk fully
      // loaded), so displayed per-person pay stays realistic and scales with
      // the pay slider instead of the fleet's departure count.
      const baseBudget = (LABOR_GROUP_MAP.groundStaff?.baseWeeklyPerAircraft ?? 4000) * n;
      return Math.max(n * 3, Math.round(baseBudget / GROUND_STAFF_MARKET_WAGE_WK));
    }
    case 'maintenanceTeam':
      // ~1 line technician per 5 block hours + base staffing of 5 per airframe
      return Math.max(n * 5, Math.ceil(totalBlockHrs / 5) + n * 3);
    default:
      return n * 5;
  }
}

// ─── Shared slider styling ─────────────────────────────────────────────────────
// Visuals + hit area live in .hw-range (index.css); this only sets the width.

const sliderStyle = { width: '100%' };

// ─── Morale bar ───────────────────────────────────────────────────────────────

function MoraleBar({ morale, payMultiplier }) {
  const color  = moraleColor(morale);
  const target = moraleTarget(payMultiplier);
  const trend  = target > morale + 1 ? '↑' : target < morale - 1 ? '↓' : '↔';
  const trendColor = trend === '↑' ? 'var(--green)' : trend === '↓' ? 'var(--red)' : 'var(--text-dim)';

  const band = morale >= 90 ? 'Excellent'
    : morale >= 70 ? 'Good'
    : morale >= 50 ? 'Neutral'
    : morale >= 30 ? 'Poor'
    : 'Crisis';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ color }}>Morale: {Math.round(morale)}% — {band}</span>
        <span style={{ color: trendColor, fontSize: 11 }}>{trend} trending toward {target}%</span>
      </div>
      <div style={{ height: 6, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${morale}%`,
          background: color, borderRadius: 3, transition: 'width 0.4s',
        }} />
      </div>
    </div>
  );
}

// ─── Union unrest bar ─────────────────────────────────────────────────────────

function UnrestBar({ unrest }) {
  const band = unrestBand(unrest);
  const prob = strikeProbability(unrest);
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: band.color }}>Union unrest: {Math.round(unrest)} — {band.label}</span>
        {prob > 0 && (
          <span style={{ color: 'var(--red)', fontSize: 11, fontWeight: 600 }}>
            ⚠ ~{Math.round(prob * 100)}% strike chance each week
          </span>
        )}
      </div>
      <div style={{ height: 6, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
        <div style={{
          height: '100%', width: `${unrest}%`,
          background: band.color, borderRadius: 3, transition: 'width 0.4s',
        }} />
        {/* Strike-threshold marker */}
        <div style={{
          position: 'absolute', top: 0, left: `${UNREST_STRIKE_THRESHOLD}%`,
          width: 2, height: '100%', background: 'var(--border)',
        }} />
      </div>
    </div>
  );
}

// ─── Strike banner ────────────────────────────────────────────────────────────

function StrikeBanner({ strike, labor, dispatch }) {
  const group  = LABOR_GROUP_MAP[strike.group];
  const gs     = labor[strike.group] ?? { payMultiplier: 1.0, morale: 80 };
  const newPay = settlementPayMultiplier(gs.payMultiplier);
  return (
    <div className="card" style={{
      marginBottom: 14, padding: '14px 18px',
      border: '1px solid var(--red)', background: 'rgba(255,93,108,0.07)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--red)' }}>
            ✊ STRIKE — {group?.name ?? strike.group} on the picket line
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 5 }}>
            ~{Math.round(strike.severity * 100)}% of flights cancelled while the walkout lasts
            ({strike.weeksLeft} week{strike.weeksLeft !== 1 ? 's' : ''} remaining). Fixed costs keep
            running — every struck week burns cash. Settle now with a 15% raise, or hold the line
            and eat the losses.
          </div>
        </div>
        <button
          className="btn"
          style={{ background: 'var(--red)', color: '#fff', fontWeight: 700, whiteSpace: 'nowrap' }}
          onClick={() => dispatch({ type: 'SETTLE_STRIKE' })}
        >
          Settle — raise pay to {newPay.toFixed(2)}×
        </button>
      </div>
    </div>
  );
}

// ─── Contract negotiation banner ──────────────────────────────────────────────

function NegotiationBanner({ negotiation, labor, fleetSize, complexityMult, dispatch }) {
  const group   = LABOR_GROUP_MAP[negotiation.group];
  const gs      = labor[negotiation.group] ?? { payMultiplier: 1.0, morale: 80 };
  const demand  = negotiation.demandMultiplier;
  const counter = counterOfferMultiplier(gs.payMultiplier, demand);
  // The midpoint can round up to the full demand (1.95× vs a 2.00× demand).
  // That's not a counter — it's the union's own number — so drop the button
  // rather than offering an identical option that reads as a gamble.
  const canCounter = counter < demand - 1e-9;
  const famMult = COMPLEXITY_AFFECTED_GROUPS.includes(negotiation.group) ? complexityMult : 1.0;
  const weeklyDelta = (mult) =>
    Math.round(group.baseWeeklyPerAircraft * (mult - gs.payMultiplier) * fleetSize * famMult);

  const btn = {
    padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer',
    fontSize: 12, fontWeight: 600, textAlign: 'center', flex: 1, minWidth: 150,
  };

  return (
    <div className="card" style={{
      marginBottom: 14, padding: '14px 18px',
      border: '1px solid var(--yellow)', background: 'rgba(245,166,35,0.06)',
    }}>
      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--yellow)' }}>
        📜 Contract talks — {group?.name ?? negotiation.group}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 5, marginBottom: 12 }}>
        The union demands <b>{demand.toFixed(2)}× market rate</b> (currently {gs.payMultiplier.toFixed(2)}×).
        You have <b>{negotiation.weeksLeft} week{negotiation.weeksLeft !== 1 ? 's' : ''}</b> to respond —
        letting the demand lapse counts as a refusal. Refusals and rejected counters build union
        unrest; enough unrest and they walk.
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          style={{ ...btn, borderColor: 'var(--green)' }}
          onClick={() => dispatch({ type: 'RESOLVE_NEGOTIATION', response: 'accept' })}
        >
          <div style={{ color: 'var(--green)' }}>Accept {demand.toFixed(2)}×</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginTop: 2 }}>
            {fleetSize > 0 ? `${formatMoney(weeklyDelta(demand))}/wk extra` : 'Costs rise'} · morale +8 · union satisfied
          </div>
        </button>
        {canCounter && (
        <button
          style={{ ...btn, borderColor: 'var(--yellow)' }}
          onClick={() => dispatch({ type: 'RESOLVE_NEGOTIATION', response: 'counter' })}
        >
          <div style={{ color: 'var(--yellow)' }}>Counter at {counter.toFixed(2)}×</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginTop: 2 }}>
            {fleetSize > 0 ? `${formatMoney(weeklyDelta(counter))}/wk extra` : 'Half the raise'} · union may accept — or stay angry
          </div>
        </button>
        )}
        <button
          style={{ ...btn, borderColor: 'var(--red)' }}
          onClick={() => dispatch({ type: 'RESOLVE_NEGOTIATION', response: 'refuse' })}
        >
          <div style={{ color: 'var(--red)' }}>Refuse</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginTop: 2 }}>
            No cost now · morale −10 · unrest +30 — strike territory
          </div>
        </button>
      </div>
    </div>
  );
}

// ─── Negotiation outcome note (shown for a few weeks after resolving) ─────────

function NegotiationOutcomeNote({ outcome }) {
  const group = LABOR_GROUP_MAP[outcome.group];
  const text = {
    accepted:        `accepted their demand. Pay is now ${outcome.newPay.toFixed(2)}× and the union is satisfied.`,
    counterAccepted: `took your counter-offer of ${outcome.newPay.toFixed(2)}× · a fair deal, relations intact.`,
    counterRejected: `pocketed your ${outcome.newPay.toFixed(2)}× counter but rejected the deal. They wanted ${outcome.demand.toFixed(2)}× and will be back sooner, angrier.`,
    refused:         `were refused outright, morale took a hit and unrest is building.`,
  }[outcome.outcome];
  const color = outcome.outcome === 'accepted' || outcome.outcome === 'counterAccepted'
    ? 'var(--green)' : 'var(--red)';
  return (
    <div style={{
      fontSize: 12, color: 'var(--text-muted)', marginBottom: 14,
      padding: '8px 12px', background: 'var(--surface2)', borderRadius: 6,
      borderLeft: `3px solid ${color}`,
    }}>
      Last contract round: {group?.name ?? outcome.group} {text}
    </div>
  );
}

// ─── Labor group card ─────────────────────────────────────────────────────────

function LaborCard({ group, groupState, fleetSize, headcount, dispatch, complexityMult = 1.0, familyCount = 1, unrest = 0, onStrike = false, crew = null, cash = 0 }) {
  const { payMultiplier: committedPay, morale } = groupState;
  // Local draft so a pay-slider drag updates the label/cost preview live but only
  // dispatches SET_LABOR_PAY once, on release, instead of on every drag value.
  const [draftPay, setDraftPay] = useState(committedPay);
  useEffect(() => setDraftPay(committedPay), [committedPay]);
  const commitPay = (v) => dispatch({ type: 'SET_LABOR_PAY', group: group.id, payMultiplier: v });
  const payMultiplier = draftPay;
  const affectedByComplexity  = COMPLEXITY_AFFECTED_GROUPS.includes(group.id) && complexityMult > 1.0;
  const famMult               = affectedByComplexity ? complexityMult : 1.0;
  const weeklyCostPerAircraft = Math.round(group.baseWeeklyPerAircraft * payMultiplier * famMult);
  const totalWeeklyCost       = weeklyCostPerAircraft * fleetSize;
  const costPerHead           = headcount > 0 ? Math.round(totalWeeklyCost / headcount) : 0;
  const complexityPct         = Math.round((complexityMult - 1) * 100);

  return (
    <div className="card" style={{ marginBottom: 10, padding: '14px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18, display: 'inline-flex' }}><Glyph e={group.emoji} size={18} /></span>
            {group.name}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, maxWidth: 420 }}>
            {group.description}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--red)' }}>
            {fleetSize > 0 ? `−${formatMoney(totalWeeklyCost)}/wk` : '—'}
          </div>
          {fleetSize > 0 && headcount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
              ~{headcount} people · {formatMoney(costPerHead)}/person/wk
            </div>
          )}
          {fleetSize > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>
              {formatMoney(weeklyCostPerAircraft)} × {fleetSize} aircraft
            </div>
          )}
        </div>
      </div>

      {/* Note for pilots/cabin crew: clarify this is overhead, not flight duty pay */}
      {(group.id === 'pilots' || group.id === 'cabinCrew') && fleetSize > 0 && (
        <div style={{
          fontSize: 11, color: 'var(--text-dim)', background: 'var(--surface2)',
          borderRadius: 4, padding: '5px 10px', marginBottom: 10,
        }}>
          ℹ Variable flight duty pay (hourly wages while airborne) is charged separately under Direct Operating Costs. This line is fixed overhead only.
        </div>
      )}

      {/* Fleet-complexity surcharge note (pilots & maintenance) */}
      {affectedByComplexity && fleetSize > 0 && (
        <div style={{
          fontSize: 11, color: 'var(--yellow)', background: 'var(--surface2)',
          borderRadius: 4, padding: '5px 10px', marginBottom: 10,
        }}>
          ⚠ Fleet-complexity surcharge: +{complexityPct}% ({familyCount} aircraft families ·
          {' '}+{Math.round(FLEET_COMPLEXITY_PCT_PER_EXTRA_FAMILY * 100)}% per family beyond the first).
          Split pilot pools and extra type ratings raise this overhead.
        </div>
      )}

      {/* ── Crew pipeline: staffing, training, hiring ── */}
      {crew && (() => {
        const short = crew.short;
        const severe = short >= CREW_SEVERE_SHORTFALL;
        const tone = short <= 0 ? 'var(--green)' : severe ? 'var(--red)' : 'var(--yellow)';
        const shortUnits = Math.max(0, Math.ceil(crew.required - crew.available));
        const hire = (n) => dispatch({ type: 'HIRE_CREW', group: group.id, count: n });
        const opts = [...new Set([Math.max(1, shortUnits), 1, 5])].slice(0, 3).sort((a, b) => a - b);
        return (
          <div style={{
            marginBottom: 10, padding: '8px 10px', borderRadius: 4,
            background: 'var(--surface2)', border: `1px solid ${short > 0 ? tone : 'var(--border)'}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>Staffing</span>
              <span style={{ fontWeight: 600, color: tone }}>
                {crew.available.toFixed(1)} / {crew.required.toFixed(1)} crewed
                {short > 0 ? ` · ${Math.round(short * 100)}% short` : ' · fully staffed'}
              </span>
            </div>
            {crew.instantRoom > 0 && (
              <div style={{ fontSize: 11, color: 'var(--green)', marginBottom: 4 }}>
                ⚡ Starter crew — your first {CREW_INSTANT_AIRCRAFT} aircraft crew up instantly, no training wait
              </div>
            )}
            {crew.training > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
                🎓 {crew.training} in training
                {crew.nextReady != null && crew.nextReady > 0 ? ` · next ready in ${crew.nextReady} wk${crew.nextReady === 1 ? '' : 's'}` : ' · ready next week'}
              </div>
            )}
            {short > 0 && (
              <div style={{ fontSize: 11, color: tone, marginBottom: 6 }}>
                {severe
                  ? '⚠ Severely short — on-time performance and satisfaction are taking the maximum hit.'
                  : '⚠ Short-handed — on-time performance is suffering. Hire before it gets worse.'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {opts.map(n => {
                const cost = crewHireCost(group.id, n);
                return (
                  <button key={n} className="btn-small" disabled={cost > cash}
                    onClick={() => hire(n)}
                    title={cost > cash ? 'Not enough cash to train this many'
                      : n <= crew.instantRoom ? 'Starter crew — starts work immediately'
                      : `Trains in ${CREW_LEAD_WEEKS[group.id]} weeks`}>
                    Hire {n} · {formatMoney(cost)}{n <= crew.instantRoom ? ' · instant' : ''}
                  </button>
                );
              })}
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                {CREW_LEAD_WEEKS[group.id]}-week training
              </span>
            </div>
          </div>
        );
      })()}

      {/* Pay slider */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
          <span style={{ color: 'var(--text-muted)' }}>Pay rate</span>
          <span style={{ fontWeight: 600, color: payMultiplier > 1.05 ? 'var(--green)' : payMultiplier < 0.95 ? 'var(--red)' : 'var(--text)' }}>
            {payMultiplier.toFixed(2)}× market rate
          </span>
        </div>
        <div style={{ position: 'relative' }}>
          <input
            type="range"
            className="hw-range"
            min="0.5"
            max="2.0"
            step="0.05"
            value={payMultiplier}
            style={sliderStyle}
            draggable={false}
            onDragStart={e => e.preventDefault()}
            onChange={e => setDraftPay(parseFloat(e.target.value))}
            onMouseUp={e => commitPay(parseFloat(e.target.value))}
            onTouchEnd={e => commitPay(parseFloat(e.target.value))}
            onKeyUp={e => commitPay(parseFloat(e.target.value))}
          />
          {/* Market rate marker */}
          <div style={{
            position: 'absolute', top: -4,
            left: `${(1.0 - 0.5) / (2.0 - 0.5) * 100}%`,
            transform: 'translateX(-50%)',
            width: 2, height: 14,
            background: 'var(--border)',
            pointerEvents: 'none',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
          <span>0.5× cut-rate</span>
          <span style={{ color: 'var(--text-muted)' }}>1.0× market</span>
          <span>2.0× premium</span>
        </div>
      </div>

      {/* Morale */}
      <MoraleBar morale={morale} payMultiplier={payMultiplier} />

      {/* Union unrest (only worth showing once it exists, or during a strike) */}
      {(unrest >= 5 || onStrike) && <UnrestBar unrest={unrest} />}

      {/* Effect description */}
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>
        {group.effectDescription(morale)}
      </div>
    </div>
  );
}

// ─── Reusable money input ──────────────────────────────────────────────────────
// Keeps its own text while focused, so deleting a digit that momentarily makes
// the value 0 (or empty) never resets the field or unmounts its row. Commits the
// parsed dollar amount via onCommit. When allowZeroCommit is false (targeted
// campaigns, where a 0 deletes the campaign), a transient 0/empty is held locally
// and NOT committed — removal happens only via the explicit End button, and
// blurring an empty field restores the last committed value.
function MoneyInput({ value, onCommit, allowZeroCommit = true, ...rest }) {
  const [text, setText]       = useState(value ? String(value) : '');
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value ? String(value) : '');
  }, [value, focused]);
  return (
    <input
      type="number"
      value={text}
      onFocus={() => setFocused(true)}
      onChange={e => {
        const raw = e.target.value;
        setText(raw);
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) onCommit(n);
        else if (allowZeroCommit)        onCommit(0);
      }}
      onBlur={() => {
        setFocused(false);
        const n = parseInt(text, 10);
        if (!(Number.isFinite(n) && n > 0)) {
          if (allowZeroCommit) { onCommit(0); setText(''); }
          else                   setText(value ? String(value) : '');
        }
      }}
      {...rest}
    />
  );
}

// ─── Marketing budget card ────────────────────────────────────────────────────

function MarketingCard({ budget, weeklyRevenue, weeklyPax, awareness, targetedMarketing, campaignStrength, routes, competitors, dispatch }) {
  const [newAirport, setNewAirport] = useState('');
  const rivalVoice = competitorMarketingSpend(competitors ?? []);

  // Brand (adstock): spend builds awareness over time; lift derives from awareness.
  // This MIRRORS the engine's weekly awareness step exactly (see the awareness
  // block in the reducer): next = current + organic + marketing − decay. Showing
  // only (marketing − decay) made a growing airline read as "−0.3 awareness/wk"
  // while its awareness was actually climbing.
  const reach        = awarenessDemandMultiplier(awareness);
  const diminishing  = 1 - awareness / 100;
  const organicCoef  = Math.min(1.0, (weeklyPax ?? 0) / 1000);   // pax flown → word of mouth
  const organicGain  = organicCoef * diminishing;
  const rawGain      = marketingAwarenessGain(budget, weeklyRevenue);
  const mktGain      = rawGain * diminishing;
  const decayBase    = Math.max(0, (awareness - AWARENESS_FLOOR) * AWARENESS_DECAY_RATE);
  const decay        = routes.length === 0 ? Math.max(0.5, decayBase) : decayBase;
  const netTrend     = organicGain + mktGain - decay;   // what the engine will apply

  // Steady state: awareness settles where (organic + marketing) gain balances
  // decay. Solving  (S)(1 − a/100) = decayRate·(a − floor)  for a, with S the
  // combined pre-diminishing gain. Assumes traffic holds at its current level.
  const settleAt = g => {
    const s = organicCoef + g;
    return Math.max(AWARENESS_FLOOR, Math.min(100,
      (s + AWARENESS_DECAY_RATE * AWARENESS_FLOOR) / (AWARENESS_DECAY_RATE + s / 100)
    ));
  };
  const settleNow  = settleAt(rawGain);
  const settleZero = settleAt(0);
  const fmtPts     = v => (Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));

  // Presets scale with airline size: the model costs ≈4% of weekly revenue for
  // ~63% of the maximum awareness gain, so a fixed $25k–$500k ladder is
  // meaningless once a carrier is doing nine figures a week. Floor keeps the
  // early-game ladder sane while revenue is still tiny.
  const presetBase = Math.max(weeklyRevenue, 2_000_000);
  const roundNice  = v => {
    const mag  = Math.pow(10, Math.floor(Math.log10(v)));
    const step = mag / 2;
    return Math.max(step, Math.round(v / step) * step);
  };
  const presets = [0, ...new Set([0.005, 0.01, 0.02, 0.04, 0.08].map(p => roundNice(presetBase * p)))];

  // Targeted campaigns
  const served = [...new Set(routes.flatMap(r => r.stops ?? [r.origin, r.destination]))].sort();
  const campaigns = Object.entries(targetedMarketing);
  const available = served.filter(c => !(c in targetedMarketing));

  return (
    <div className="card" style={{ padding: '14px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}><Glyph e="📣" /></span>
            Brand Marketing
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, maxWidth: 460 }}>
            Weekly spend on national advertising and brand campaigns. Builds <strong>awareness</strong> over
            weeks rather than boosting demand instantly — and awareness persists after spend stops, fading slowly.
            Demand reach: 40% when unknown, 100% at awareness {AWARENESS_PARITY}, up to 112% for a household name.
          </div>
        </div>
        {budget > 0 && (
          <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--red)' }}>
              −{formatMoney(budget)}/wk
            </div>
            <div style={{ fontSize: 11, color: mktGain > 0 ? 'var(--green)' : 'var(--text-muted)', marginTop: 1, fontWeight: 600 }}>
              +{fmtPts(mktGain)} awareness/wk from spend
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>
              lifts steady state to ≈{Math.round(settleNow)}
            </div>
          </div>
        )}
      </div>

      {/* Quick presets */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {presets.map(v => (
          <button
            key={v}
            className={`btn ${budget === v ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => dispatch({ type: 'SET_MARKETING_BUDGET', amount: v })}
          >
            {v === 0 ? 'None' : v >= 1_000_000 ? `$${v/1_000_000}M` : `$${v/1000}k`}
          </button>
        ))}
        <MoneyInput
          className="input"
          placeholder="Custom $"
          min="0"
          step="10000"
          value={budget}
          onCommit={amount => dispatch({ type: 'SET_MARKETING_BUDGET', amount })}
          style={{ width: 120, fontSize: 12, padding: '4px 8px' }}
        />
      </div>

      {/* Effect summary */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12 }}>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Brand awareness</div>
          <div style={{ fontWeight: 600 }}>{Math.round(awareness)} / 100</div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Demand reach</div>
          <div style={{ fontWeight: 600, color: reach >= 1 ? 'var(--green)' : 'var(--yellow)' }}>
            {(reach * 100).toFixed(0)}%
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Awareness trend</div>
          <div style={{ fontWeight: 600, color: netTrend > 0.005 ? 'var(--green)' : netTrend < -0.005 ? 'var(--red)' : 'var(--text-muted)' }}>
            {netTrend >= 0 ? '+' : '−'}{fmtPts(Math.abs(netTrend))}/wk net
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
            flying +{fmtPts(organicGain)} · ads +{fmtPts(mktGain)} · fade −{fmtPts(decay)}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Settles at</div>
          <div style={{ fontWeight: 600 }}>≈{Math.round(settleNow)} / 100</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
            {budget > 0
              ? `+${(settleNow - settleZero).toFixed(1)} vs no brand spend`
              : 'at zero brand spend'}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Spend as % revenue</div>
          <div style={{ fontWeight: 600, color: weeklyRevenue > 0 && budget / weeklyRevenue > 0.15 ? 'var(--yellow)' : 'var(--text-muted)' }}>
            {weeklyRevenue > 0 ? `${(budget / weeklyRevenue * 100).toFixed(1)}%` : '—'}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Adstock note</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Marketing works with a lag: spend compounds into awareness, and cutting the budget
            lets it fade at ~{(AWARENESS_DECAY_RATE * 100).toFixed(1)}%/wk rather than dropping demand overnight.
            Flying passengers also builds awareness organically — the trend above is the net weekly
            change the sim applies, and "settles at" is where it levels off if nothing changes.
          </div>
        </div>
      </div>

      {/* ── Targeted campaigns ── */}
      <div style={{ borderTop: '1px solid var(--border, rgba(128,128,128,0.25))', marginTop: 14, paddingTop: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>Targeted Campaigns</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, maxWidth: 460 }}>
          Tactical advertising in a single market — billboards, local media, fare promotions.
          Lifts demand up to ~+10% (sustained) on routes touching that airport.
          Builds in weeks but fades fast when unfunded. Bigger metros cost more to saturate.
          Effectiveness is <strong>share of voice</strong>: rival hub advertising dilutes your
          campaign and drags local demand — and carriers may counter-blitz when you invade their hub.
        </div>

        {campaigns.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: 8 }}>
            No active campaigns.
          </div>
        )}

        {campaigns.map(([code, spend]) => {
          const ap       = getAirport(code);
          const popM     = ap?.effectivePop ?? ap?.population ?? 1;
          const strength = campaignStrength?.[code] ?? 0;
          const rival    = rivalVoice[code] ?? 0;
          const sov      = shareOfVoiceFactor(spend, rival);
          const drag     = competitorPressureDrag(rival, spend, popM);
          const boostNow = (1 + campaignDemandBoostPct(strength)) * (1 - drag) - 1;
          const eqBoost  = (1 + campaignDemandBoostPct(campaignEquilibriumStrength(spend, popM, sov))) * (1 - drag) - 1;
          return (
            <div key={code} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, fontSize: 12, flexWrap: 'wrap' }}>
              <div style={{ width: 150, fontWeight: 600 }}>
                {code} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{ap?.city ?? ''}</span>
              </div>
              <MoneyInput
                className="input"
                min="0"
                step="10000"
                value={spend}
                allowZeroCommit={false}
                onCommit={amount => dispatch({ type: 'SET_TARGETED_MARKETING', airport: code, amount })}
                style={{ width: 110, fontSize: 12, padding: '3px 8px' }}
              />
              <span style={{ color: 'var(--text-dim)' }}>/wk</span>
              {/* strength bar */}
              <div style={{ flex: 1, minWidth: 90, maxWidth: 160, height: 6, background: 'rgba(128,128,128,0.2)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, strength)}%`, height: '100%', background: 'var(--green)', borderRadius: 3 }} />
              </div>
              <span style={{ color: boostNow > 0 ? 'var(--green)' : boostNow < 0 ? 'var(--red)' : 'var(--text-dim)', fontWeight: 600, minWidth: 56 }}>
                {boostNow >= 0 ? '+' : ''}{(boostNow * 100).toFixed(1)}%
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                sustained: {eqBoost >= 0 ? '+' : ''}{(eqBoost * 100).toFixed(1)}%
              </span>
              {rival > 0 && (
                <span style={{ color: 'var(--yellow)', fontSize: 11 }} title="Competitor marketing at this airport dilutes your campaign and drags demand">
                  rivals {formatMoney(rival)}/wk · SoV {(sov * 100).toFixed(0)}%
                </span>
              )}
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => dispatch({ type: 'SET_TARGETED_MARKETING', airport: code, amount: 0 })}
              >
                End
              </button>
            </div>
          );
        })}

        {available.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <select
              className="input"
              value={newAirport}
              onChange={e => setNewAirport(e.target.value)}
              style={{ fontSize: 12, padding: '3px 8px', width: 220 }}
            >
              <option value="">Add campaign at…</option>
              {available.map(c => {
                const ap = getAirport(c);
                return <option key={c} value={c}>{c} — {ap?.city ?? c}</option>;
              })}
            </select>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: '4px 10px' }}
              disabled={!newAirport}
              onClick={() => {
                if (!newAirport) return;
                dispatch({ type: 'SET_TARGETED_MARKETING', airport: newAirport, amount: 50_000 });
                setNewAirport('');
              }}
            >
              Start ($50k/wk)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Operations page ─────────────────────────────────────────────────────

export default function Operations() {
  const { state, dispatch } = useGame();
  const {
    fleet, routes = [], labor = DEFAULT_LABOR_STATE,
    maintenanceBudget = DEFAULT_MAINTENANCE_BUDGET,
    marketingBudget = 0,
  } = state;
  const fleetSize = fleet.length;
  const laborRelations = state.laborRelations ?? DEFAULT_LABOR_RELATIONS;
  const currentAbsWeek = ((state.year ?? 1) - 1) * 52 + (state.week ?? 1);

  // ── Crew pipeline (A7) ──────────────────────────────────────────────────
  // Only in worlds/saves running the pipeline. `required` and `available` are
  // in narrowbody-equivalents — the same unit the wage bill uses — so they are
  // directly comparable and need no translation.
  const crewOn = state.crewPipeline === true;
  const typeOfAircraft = (a) => getAircraftType(a.typeId);
  const crew = crewOn ? Object.fromEntries(LABOR_GROUPS.map(g => {
    const required  = crewRequired(g.id, fleet, typeOfAircraft);
    const available = crewAvailable(labor, g.id);
    const training  = crewInTraining(labor, g.id);
    const batches   = labor?.[g.id]?.pipeline ?? [];
    const nextReady = batches.length
      ? Math.min(...batches.map(b => (b?.readyAbsWeek ?? 0))) - currentAbsWeek
      : null;
    // How much of the NEXT hire would start work immediately (starter crew).
    const instantRoom = splitStarterHire(g.id, Number.MAX_SAFE_INTEGER, available, fleet, typeOfAircraft).instant;
    return [g.id, { required, available, training, nextReady, instantRoom,
                    short: required > 0 ? Math.max(0, (required - available) / required) : 0 }];
  })) : null;
  const crewGap = crewOn ? crewShortfall(labor, fleet, typeOfAircraft) : null;

  // Pre-compute headcount estimates for all groups
  const headcounts = Object.fromEntries(
    LABOR_GROUPS.map(g => [g.id, estimateHeadcount(g.id, fleet, routes)])
  );
  const totalHeadcount = Object.values(headcounts).reduce((s, n) => s + n, 0);

  // Fleet complexity — families currently in use
  const familySet  = getActiveFamilies(fleet);
  const familyCost = weeklyFamilyBaseCost(fleet);
  const complexityMult = fleetComplexityMultiplier(fleet);

  // Total labor overhead per week (pilots & maintenance carry the complexity surcharge)
  const totalLaborWeekly = LABOR_GROUPS.reduce((sum, g) => {
    const payMult = labor[g.id]?.payMultiplier ?? 1.0;
    const famMult = COMPLEXITY_AFFECTED_GROUPS.includes(g.id) ? complexityMult : 1.0;
    return sum + Math.round(g.baseWeeklyPerAircraft * payMult * fleetSize * famMult);
  }, 0);

  // Count aircraft per family
  const familyCount = {};
  for (const a of fleet) {
    const fam = AIRCRAFT_FAMILY[a.typeId];
    if (fam) familyCount[fam] = (familyCount[fam] ?? 0) + 1;
  }
  const famEntries = [...familySet]
    .map(id => ({ id, info: FAMILY_INFO[id] ?? { name: id, category: 'regional', weeklyBaseCost: 0 }, count: familyCount[id] ?? 0 }))
    .sort((a, b) => b.info.weeklyBaseCost - a.info.weeklyBaseCost);

  // Use last tick's maintenance total for display
  const fleetMaintTotal = state.lastReport?.totalMaintenance ?? 0;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Manage pay rates and maintenance spending. Changes take effect next week.
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 13 }}>
          {fleetSize > 0 && (
            <>
              <div>
                Labor overhead:
                <span style={{ color: 'var(--red)', fontWeight: 600, marginLeft: 6 }}>
                  −{formatMoney(totalLaborWeekly)}/wk
                </span>
              </div>
              {totalHeadcount > 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  ~{totalHeadcount.toLocaleString()} employees across {fleetSize} aircraft
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Active strike / open contract negotiation */}
      {laborRelations.strike && (
        <StrikeBanner strike={laborRelations.strike} labor={labor} dispatch={dispatch} />
      )}
      {laborRelations.negotiation && (
        <NegotiationBanner
          negotiation={laborRelations.negotiation}
          labor={labor}
          fleetSize={fleetSize}
          complexityMult={complexityMult}
          dispatch={dispatch}
        />
      )}
      {!laborRelations.negotiation && laborRelations.lastOutcome
        && (currentAbsWeek - laborRelations.lastOutcome.absWeek) <= 4 && (
        <NegotiationOutcomeNote outcome={laborRelations.lastOutcome} />
      )}

      {/* Labor section */}
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10,
      }}>
        Labor Groups
      </div>

      {crewGap && crewGap.worst > 0 && (
        <div style={{
          marginBottom: 10, padding: '9px 12px', borderRadius: 4, fontSize: 12,
          background: 'var(--surface2)',
          border: `1px solid ${crewGap.severe ? 'var(--red)' : 'var(--yellow)'}`,
          color: crewGap.severe ? 'var(--red)' : 'var(--yellow)',
        }}>
          <strong>{crewGap.severe ? 'Severely understaffed' : 'Short-handed'}</strong>
          {' — '}
          {LABOR_GROUPS.filter(g => (crew?.[g.id]?.short ?? 0) > 0)
            .map(g => `${g.name} ${Math.round((crew[g.id].short) * 100)}% short`)
            .join(' · ')}
          . Flying short-handed costs on-time performance and passenger satisfaction; crew take
          {' '}{Math.min(...LABOR_GROUPS.map(g => CREW_LEAD_WEEKS[g.id]))}–{Math.max(...LABOR_GROUPS.map(g => CREW_LEAD_WEEKS[g.id]))} weeks to train, so hire ahead of your deliveries.
        </div>
      )}

      {LABOR_GROUPS.map(group => (
        <LaborCard
          key={group.id}
          group={group}
          groupState={labor[group.id] ?? { payMultiplier: 1.0, morale: 80 }}
          fleetSize={fleetSize}
          headcount={headcounts[group.id] ?? 0}
          dispatch={dispatch}
          complexityMult={complexityMult}
          familyCount={familySet.size}
          unrest={laborRelations.unrest?.[group.id] ?? 0}
          onStrike={laborRelations.strike?.group === group.id}
          crew={crew?.[group.id] ?? null}
          cash={state.cash ?? 0}
        />
      ))}

      {/* Maintenance moved to its own page — see components/Maintenance.jsx */}
      <div className="card" style={{ padding: '12px 18px', marginTop: 16 }}>
        <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Glyph e="🛠️" />
          <span style={{ fontWeight: 600 }}>Maintenance has its own page.</span>
          <span style={{ color: 'var(--text-muted)' }}>
            Budget, heavy checks, jet bases, the shop board and your outsourced MRO contracts all live
            under Company ▸ Maintenance.
          </span>
        </div>
      </div>

      {/* Reserve coverage — hub-based standby covers (docs/reserve-aircraft-design.md) */}
      {(() => {
        const fleet   = state.fleet ?? [];
        const allOps  = [...(state.routes ?? []), ...(state.cargoRoutes ?? [])];
        const reserves = fleet.filter(a => a.reserveBase && a.status !== 'retired');
        const covering = new Map(); // reserveId -> covered route count
        for (const r of allOps) {
          if (r.coverForAircraftId) covering.set(r.aircraftId, (covering.get(r.aircraftId) ?? 0) + 1);
        }
        const gaps = state.lastReport?.coverage?.gaps ?? [];
        if (reserves.length === 0 && covering.size === 0 && gaps.length === 0) return null;
        return (
          <div className="card" style={{ padding: '12px 18px', marginTop: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}><Glyph e="🛡️" /> Reserve Coverage</div>
            {reserves.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No reserves stationed. Station an idle aircraft at a hub (Fleet tab) and it will automatically cover same-type aircraft in the shop there.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {reserves.map(a => {
                  const n = covering.get(a.id) ?? 0;
                  const t = getAircraftType(a.typeId);
                  return (
                    <div key={a.id} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600 }}>{a.name}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{t?.name} @ {a.reserveBase}</span>
                      {n > 0
                        ? <span style={{ color: 'var(--accent)' }}>covering {n} route{n !== 1 ? 's' : ''}</span>
                        : <span style={{ color: 'var(--green)' }}>standing by</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {gaps.length > 0 && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                {gaps.map((g, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--yellow)' }}>
                    <Glyph e="⚠" size={11} /> {g.original?.name}: {g.routes} route{g.routes !== 1 ? 's' : ''} uncovered (~{formatMoney(g.revenueAtRisk)}/wk) — {g.reason === 'no-reserve' ? 'no same-type reserve based where they fly' : 'matching reserve is out of block hours'}.
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Marketing budget section */}
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: 20, marginBottom: 10,
      }}>
        Marketing Budget
      </div>

      <MarketingCard
        budget={marketingBudget}
        weeklyRevenue={state.lastReport?.totalRevenue ?? 0}
        weeklyPax={state.lastReport?.totalPassengers ?? 0}
        awareness={state.awareness ?? 5}
        targetedMarketing={state.targetedMarketing ?? {}}
        campaignStrength={state.campaignStrength ?? {}}
        routes={routes}
        competitors={state.competitors ?? []}
        dispatch={dispatch}
      />

      {/* Default catering section */}
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: 20, marginBottom: 10,
      }}>
        Default Catering Service
      </div>

      <div className="card" style={{ padding: '14px 18px' }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          The catering level applied to every newly-opened route. You can still override it
          per route on the Routes page. Existing routes are unaffected.
        </div>
        <CateringSelector
          value={normalizeCateringLevel(state.defaultCateringLevel)}
          onChange={(level) => dispatch({ type: 'SET_DEFAULT_CATERING', level })}
          label={null}
        />
      </div>

      {/* HQ & Corporate overhead section */}
      {fleet.length > 0 && (() => {
        const hqInfo = hqBracket(fleet.length);
        const hqCost = calcHQCost(fleet.length);
        const totalInsurance = fleet.reduce((s, a) => {
          const t = getAircraftType(a.typeId);
          return s + weeklyInsuranceCost(a, t);
        }, 0);
        return (
          <>
            <div style={{
              fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
              textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: 20, marginBottom: 10,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>Corporate Overhead</span>
              <span style={{ color: 'var(--red)', fontWeight: 700, fontSize: 13, textTransform: 'none', letterSpacing: 0 }}>
                −{formatMoney(hqCost + totalInsurance)}/wk
              </span>
            </div>
            <div className="card" style={{ padding: '14px 18px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span><Glyph e="🏢" /></span> HQ &amp; Administration
                </div>
                <div style={{ fontSize: 13, color: 'var(--red)', fontWeight: 600, marginBottom: 4 }}>
                  −{formatMoney(hqCost)}/wk
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  <strong style={{ color: 'var(--accent)' }}>{hqInfo.label}</strong> · {fleet.length} aircraft
                  <br />{hqInfo.description}
                  <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-dim)' }}>
                    Scales continuously: ~$45K × fleet<sup>0.85</sup>
                  </div>
                </div>
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span><Glyph e="🛡️" /></span> Insurance
                </div>
                <div style={{ fontSize: 13, color: 'var(--red)', fontWeight: 600, marginBottom: 4 }}>
                  −{formatMoney(totalInsurance)}/wk
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Hull insurance on {fleet.filter(a => a.ownershipType === 'owned').length} owned aircraft
                  + liability on all {fleet.length} aircraft.
                  <br />Hull rate 0.5% p.a. of book value; liability $3,000/wk per aircraft.
                </div>
              </div>
            </div>
          </>
        );
      })()}

      {/* Footnote */}
      <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Pay cuts reduce costs immediately but morale falls gradually over several weeks (≈12% per week toward target).
        Morale recovery is equally slow — underpaying now has lasting consequences.
        Low maintenance budget accelerates aging: aircraft with higher {'>'}ageWeeks trigger steeper maintenance cost multipliers,
        compounding over time.
      </div>
    </div>
  );
}
