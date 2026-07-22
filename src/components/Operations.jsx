import { useGame } from '../store/GameContext.jsx';
import {
  LABOR_GROUPS, LABOR_GROUP_MAP, DEFAULT_LABOR_STATE, DEFAULT_MAINTENANCE_BUDGET,
  moraleTarget, moraleColor,
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
import {
  calcHQCost, hqBracket, weeklyInsuranceCost,
  awarenessDemandMultiplier, marketingAwarenessGain,
  AWARENESS_PARITY, AWARENESS_FLOOR, AWARENESS_DECAY_RATE,
  campaignDemandBoostPct, campaignEquilibriumStrength,
  shareOfVoiceFactor, competitorPressureDrag,
} from '../data/overhead.js';
import { competitorMarketingSpend } from '../models/competitorAI.js';
import { getAirport } from '../data/airports.js';
import { useState } from 'react';
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
        <button
          style={{ ...btn, borderColor: 'var(--yellow)' }}
          onClick={() => dispatch({ type: 'RESOLVE_NEGOTIATION', response: 'counter' })}
        >
          <div style={{ color: 'var(--yellow)' }}>Counter at {counter.toFixed(2)}×</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginTop: 2 }}>
            {fleetSize > 0 ? `${formatMoney(weeklyDelta(counter))}/wk extra` : 'Half the raise'} · union may accept — or stay angry
          </div>
        </button>
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

function LaborCard({ group, groupState, fleetSize, headcount, dispatch, complexityMult = 1.0, familyCount = 1, unrest = 0, onStrike = false }) {
  const { payMultiplier, morale } = groupState;
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
            onChange={e => dispatch({
              type: 'SET_LABOR_PAY',
              group: group.id,
              payMultiplier: parseFloat(e.target.value),
            })}
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

// ─── Maintenance budget card ──────────────────────────────────────────────────

function MaintenanceCard({ budget, fleetMaintTotal, maintBudgetUsed, dispatch }) {
  // Aging rate: 0.5→1.25 faster, 1.0→1.0 normal, 2.0→0.5 slower
  const agingRate = Math.max(0.5, 1 + (1 - budget) * 0.5);
  const agingColor = agingRate > 1.1 ? 'var(--red)' : agingRate < 0.9 ? 'var(--green)' : 'var(--text-muted)';

  // Live projection: last week's actual maintenance scaled to the current slider.
  // Maintenance cost is ~linear in the budget multiplier, so projected next-week
  // spend ≈ lastActual × (currentBudget / budgetThatProducedLastActual). This
  // makes the headline figure respond to the slider instead of showing a static
  // historical number (which only refreshes on the weekly tick).
  const baselineBudget = maintBudgetUsed > 0 ? maintBudgetUsed : 1.0;
  const projectedMaint = fleetMaintTotal * (budget / baselineBudget);
  const projMoved = Math.abs(budget - baselineBudget) > 0.001;

  const budgetLabel = budget < 0.75 ? 'Cut-rate'
    : budget < 0.95 ? 'Below standard'
    : budget < 1.1  ? 'Standard'
    : budget < 1.5  ? 'Enhanced'
    : 'Full overhaul';

  return (
    <div className="card" style={{ padding: '14px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}><Glyph e="🛠️" /></span>
            Maintenance Budget
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, maxWidth: 420 }}>
            Controls spending on parts, components, and scheduled checks. Low budget cuts costs now but
            accelerates airframe aging — raising future maintenance bills.
          </div>
        </div>
        {fleetMaintTotal > 0 && (
          <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--red)' }}>
              −{formatMoney(projectedMaint)}/wk
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
              projected next week · all aircraft
            </div>
            {projMoved && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>
                was −{formatMoney(fleetMaintTotal)}/wk last week
              </div>
            )}
          </div>
        )}
      </div>

      {/* Budget slider */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
          <span style={{ color: 'var(--text-muted)' }}>Budget level</span>
          <span style={{ fontWeight: 600, color: budget < 0.9 ? 'var(--red)' : budget > 1.1 ? 'var(--green)' : 'var(--text)' }}>
            {budget.toFixed(2)}× — {budgetLabel}
          </span>
        </div>
        <div style={{ position: 'relative' }}>
          <input
            type="range"
            className="hw-range"
            min="0.5"
            max="2.0"
            step="0.05"
            value={budget}
            style={sliderStyle}
            draggable={false}
            onDragStart={e => e.preventDefault()}
            onChange={e => dispatch({ type: 'SET_MAINTENANCE_BUDGET', multiplier: parseFloat(e.target.value) })}
          />
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
          <span>0.5× deferred</span>
          <span style={{ color: 'var(--text-muted)' }}>1.0× standard</span>
          <span>2.0× overhaul</span>
        </div>
      </div>

      {/* Effects */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 8, fontSize: 12 }}>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Aging rate</div>
          <div style={{ fontWeight: 600, color: agingColor }}>{agingRate.toFixed(2)}× per week</div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Maint cost multiplier</div>
          <div style={{ fontWeight: 600, color: budget < 1 ? 'var(--green)' : 'var(--red)' }}>{budget.toFixed(2)}×</div>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Impact</div>
          <div style={{ color: agingColor, fontSize: 11, fontStyle: 'italic' }}>
            {agingRate > 1.15
              ? 'Aircraft aging significantly faster, higher maintenance costs ahead'
              : agingRate > 1.05
              ? 'Slightly faster aging, monitor fleet condition'
              : agingRate < 0.85
              ? 'Aircraft condition well-maintained, extended service life'
              : agingRate < 0.95
              ? 'Slightly slowed aging, good for long-term economics'
              : 'Standard schedule, balanced cost and longevity'}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Marketing budget card ────────────────────────────────────────────────────

function MarketingCard({ budget, weeklyRevenue, awareness, targetedMarketing, campaignStrength, routes, competitors, dispatch }) {
  const [newAirport, setNewAirport] = useState('');
  const rivalVoice = competitorMarketingSpend(competitors ?? []);

  // Brand (adstock): spend builds awareness over time; lift derives from awareness.
  const reach        = awarenessDemandMultiplier(awareness);
  const rawGain      = marketingAwarenessGain(budget, weeklyRevenue) * (1 - awareness / 100);
  const decay        = Math.max(0, (awareness - AWARENESS_FLOOR) * AWARENESS_DECAY_RATE);
  const netGain      = rawGain - decay;   // excludes organic (passenger) gain

  const presets = [0, 25_000, 50_000, 100_000, 200_000, 500_000].filter(
    v => v === 0 || v <= Math.max(weeklyRevenue * 0.25, 200_000)
  );

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
            <div style={{ fontSize: 11, color: netGain > 0 ? 'var(--green)' : 'var(--text-muted)', marginTop: 1, fontWeight: 600 }}>
              {netGain > 0 ? `+${netGain.toFixed(1)}` : netGain.toFixed(1)} awareness/wk
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
        <input
          type="number"
          className="input"
          placeholder="Custom $"
          min="0"
          step="10000"
          value={budget || ''}
          onChange={e => dispatch({ type: 'SET_MARKETING_BUDGET', amount: parseInt(e.target.value) || 0 })}
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
          <div style={{ fontWeight: 600, color: netGain > 0 ? 'var(--green)' : 'var(--text-muted)' }}>
            {netGain >= 0 ? '+' : ''}{netGain.toFixed(1)}/wk from marketing
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
            Flying passengers also builds awareness organically.
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
              <input
                type="number"
                className="input"
                min="0"
                step="10000"
                value={spend || ''}
                onChange={e => dispatch({ type: 'SET_TARGETED_MARKETING', airport: code, amount: parseInt(e.target.value) || 0 })}
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
        />
      ))}

      {/* Maintenance budget section */}
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: 20, marginBottom: 10,
      }}>
        Maintenance Budget
      </div>

      <MaintenanceCard
        budget={maintenanceBudget}
        fleetMaintTotal={fleetMaintTotal}
        maintBudgetUsed={state.lastReport?.maintenanceBudgetUsed ?? 1.0}
        dispatch={dispatch}
      />

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

      {/* Fleet complexity section */}
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: 20, marginBottom: 10,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span>Fleet Complexity · MRO Base Costs</span>
        {familyCost > 0 && (
          <span style={{ color: 'var(--red)', fontWeight: 700, fontSize: 13, textTransform: 'none', letterSpacing: 0 }}>
            −{formatMoney(familyCost)}/wk total
          </span>
        )}
      </div>

      <div className="card" style={{ padding: '14px 18px' }}>
        {famEntries.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
            No aircraft in fleet yet. Each aircraft family you operate requires a dedicated maintenance base.
          </div>
        ) : (
          <>
            {/* Family rows */}
            {famEntries.map(({ id, info, count }) => {
              const catLabel = FAMILY_CATEGORY_LABEL[info.category] ?? info.category;
              const catColors = {
                widebody: '#a98bff', narrowBody: '#3ea6ff',
                regional: '#38d39f', turboprop: '#ffb43d', utility: '#93a4ba',
              };
              const color = catColors[info.category] ?? '#93a4ba';
              return (
                <div key={id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: '1px solid var(--border-subtle)',
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{info.name}</span>
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                        background: `${color}20`, color, border: `1px solid ${color}40`,
                        textTransform: 'uppercase', letterSpacing: '0.05em',
                      }}>
                        {catLabel}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {count} aircraft
                      </span>
                    </div>
                    {info.note && (
                      <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 2, fontStyle: 'italic' }}>
                        <Glyph e="⚠" /> {info.note}
                      </div>
                    )}
                  </div>
                  <div style={{ fontWeight: 600, color: 'var(--red)', fontSize: 13, flexShrink: 0 }}>
                    −{formatMoney(info.weeklyBaseCost)}/wk
                  </div>
                </div>
              );
            })}

            {/* Standardisation tip */}
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {famEntries.length === 1 ? (
                <span style={{ color: 'var(--green)' }}>
                  <Glyph e="✓" /> Single-family fleet — you pay the minimum possible MRO base cost.
                </span>
              ) : (
                <>
                  <span style={{ color: 'var(--yellow)' }}>
                    {famEntries.length} families active.
                  </span>
                  {' '}Retiring all aircraft of one type eliminates its base cost. A uniform fleet saves{' '}
                  <strong style={{ color: 'var(--text)' }}>
                    {formatMoney(familyCost - Math.min(...famEntries.map(e => e.info.weeklyBaseCost)))}/wk
                  </strong>
                  {' '}if you consolidate to one family.
                </>
              )}
            </div>
          </>
        )}
      </div>

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
