import { useGame } from '../store/GameContext.jsx';
import {
  LABOR_GROUPS, LABOR_GROUP_MAP, DEFAULT_LABOR_STATE, DEFAULT_MAINTENANCE_BUDGET,
  moraleTarget, moraleColor,
  CREW_LEAD_WEEKS, CREW_SEVERE_SHORTFALL, CREW_INSTANT_AIRCRAFT, crewRequired,
  crewAvailable, crewInTraining, crewRecruiting, crewShortfall, crewHireCost, splitStarterHire,
  CREW_PER_UNIT, crewBodies, crewRequiredAhead, deliveriesWithinLeadTime,
  crewRequiredForOrderBook, weeksUntilHiringDue, nextDeliveryQueueWeeks,
  crewHiresNeeded, crewExpectedLeavers, weeksToOrderBookComplete,
  crewStatus,
  erodePayPremium, PAY_MARKET_CATCHUP_PER_YEAR,
  crewSpare, reserveTarget, crewReserveRatio, reserveBenefit, reserveMoraleBonus, reserveOtpBonus,
  laborBillUnits, crewHireAllPlan, releaseSeveranceBase, crewUnitsForBodies, crewScaleFor,
  RESERVE_PAY_RATE, RESERVE_LEVELS, RESERVE_FULL_BENEFIT, RESERVE_MORALE_MAX, RESERVE_OTP_MAX,
  RELEASE_SEVERANCE_WEEKS, seniorityFor,
} from '../data/labor.js';
import {
  DEFAULT_LABOR_RELATIONS, unrestBand, strikeProbability,
  settlementPayMultiplier, UNREST_STRIKE_THRESHOLD,
} from '../data/laborRelations.js';
import { goingRate, relativePay, weeklyIntakeUnits, intakeUsed, weeksToRecruit } from '../models/talentMarket.js';
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
  calcHQCost, fleetHQScale, hqBracket, weeklyInsuranceCost,
  getEraCostScale,
} from '../data/overhead.js';
import { useState, useEffect } from 'react';
import { normalizeCateringRef } from '../data/cateringPlans.js';
import CateringPlans from './CateringPlans.jsx';
import CateringSelector from './CateringSelector.jsx';
import CateringContracts from './CateringContracts.jsx';
import InfoTip from './InfoTip.jsx';
import Departures, { takeDepartureBoardRequest } from './Departures.jsx';
import { consumeNavFilter } from '../utils/navIntent.js';
import ScheduleTimeline from './ScheduleTimeline.jsx';
import { Glyph } from './Icons.jsx';

// ─── Headcount ────────────────────────────────────────────────────────────────
//
// One source of truth: the crew requirement the pipeline already computes, in
// narrowbody-equivalents, converted to people by CREW_PER_UNIT. This replaces
// the old `estimateHeadcount`, which derived a headcount from block hours and
// therefore disagreed with the requirement printed a few lines below it — two
// different answers to "how many people work here" on one screen.
//
// It also means a parked aircraft still shows its crew, which is right: you are
// paying them whether or not the tail flies this week.
export function headcountFor(groupId, fleet, typeOf) {
  return crewBodies(groupId, crewRequired(groupId, fleet, typeOf));
}

const SUB_TABS = [
  { id: 'labor',      label: 'Labour & Costs' },
  { id: 'departures', label: 'Departure Board' },
  { id: 'schedule',   label: 'Schedule' },
];

// ─── Shared slider styling ─────────────────────────────────────────────────────
// Visuals + hit area live in .hw-range (index.css); this only sets the width.

const sliderStyle = { width: '100%' };

// ─── Morale bar ───────────────────────────────────────────────────────────────

function MoraleBar({ morale, payMultiplier, reserveLift = 0 }) {
  const color  = moraleColor(morale);
  // Reserve staff add to what pay alone buys — the same sum the weekly tick uses.
  const lift   = Math.round(reserveLift * 10) / 10;
  const target = Math.min(100, Math.round(moraleTarget(payMultiplier) + reserveLift));
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
        <span style={{ color: trendColor, fontSize: 11 }}>{trend} trending toward {target}%{lift >= 0.5 ? ` (+${lift % 1 === 0 ? lift : lift.toFixed(1)} from reserves)` : ''}</span>
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

// ─── Labor group card ─────────────────────────────────────────────────────────

function LaborCard({ group, groupState, fleetSize, headcount, dispatch, complexityMult = 1.0, familyCount = 1, unrest = 0, onStrike = false, crew = null, cash = 0, lineUnits = null, autoStaff = false, seniority = 1 }) {
  const { payMultiplier: committedPay, morale } = groupState;
  // With "Keep me fully staffed" on, the game does the hiring and the card is a
  // status line; the hiring tools sit behind "Show details". Without it they
  // are the player's job, so they stay open.
  const [showDetails, setShowDetails] = useState(!autoStaff || (crew?.short ?? 0) > 0);
  // Local draft so a pay-slider drag updates the label/cost preview live but only
  // dispatches SET_LABOR_PAY once, on release, instead of on every drag value.
  const [draftPay, setDraftPay] = useState(committedPay);
  // Custom hire amount, in people. Empty until the player types one.
  const [customHire, setCustomHire] = useState('');
  useEffect(() => setDraftPay(committedPay), [committedPay]);
  const commitPay = (v) => dispatch({ type: 'SET_LABOR_PAY', group: group.id, payMultiplier: v });
  const payMultiplier = draftPay;
  const affectedByComplexity  = COMPLEXITY_AFFECTED_GROUPS.includes(group.id) && complexityMult > 1.0;
  const famMult               = affectedByComplexity ? complexityMult : 1.0;
  // `seniority`: the airline's wage scale in a restricted world (1 elsewhere),
  // which the tick charges and this card used to leave out.
  const weeklyCostPerAircraft = Math.round(group.baseWeeklyPerAircraft * payMultiplier * famMult * seniority * getEraCostScale());
  // The bill is sized in narrowbody crews (a widebody is more than one, a
  // turboprop less) plus reserve staff at the reserve rate — the same units
  // the weekly tick charges.
  const units                 = lineUnits ?? fleetSize;
  const lineWeeklyCost        = Math.round(weeklyCostPerAircraft * units);
  const reserveWeeklyCost     = crew ? Math.round(weeklyCostPerAircraft * crew.spare * RESERVE_PAY_RATE) : 0;
  const totalWeeklyCost       = lineWeeklyCost + reserveWeeklyCost;
  const costPerHead           = headcount > 0 ? Math.round(lineWeeklyCost / headcount) : 0;
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
            {fleetSize > 0 || totalWeeklyCost > 0 ? `−${formatMoney(totalWeeklyCost)}/wk` : '—'}
          </div>
          {fleetSize > 0 && headcount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
              ~{headcount} people · {formatMoney(costPerHead)}/person/wk
            </div>
          )}
          {fleetSize > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>
              {Math.abs(units - fleetSize) < 0.05
                ? <>{formatMoney(weeklyCostPerAircraft)} × {fleetSize} aircraft</>
                : <span title="Staff are sized on aircraft size: one 160-seat narrowbody is one crew; a widebody needs more, a turboprop fewer.">
                    {formatMoney(weeklyCostPerAircraft)} × {units.toFixed(1)} narrowbody crews ({fleetSize} aircraft)
                  </span>}
            </div>
          )}
          {reserveWeeklyCost > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>
              incl. {formatMoney(reserveWeeklyCost)} reserve pay
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
        const perUnit = CREW_PER_UNIT[group.id] ?? 1;
        // How many to HIRE — not simply how many are missing. Crew leave while
        // the order is in the air and a trainee is not usable for weeks, so this
        // is grossed up for both (see crewHiresNeeded). Everything urgent on this
        // card keys off it, because it is the only number that knows whether the
        // player still has something to DO.
        const gapBodies = crewBodies(group.id, crew.hireAhead);
        // A shortfall whose people are ALREADY IN TRAINING is not an emergency,
        // it is a wait. The engine is right that they cannot fly yet — the
        // on-time penalty stays — but the screen was reporting an airline that
        // had hired four times over identically to one that had hired nobody,
        // in max-severity red, directly above a button offering nine more
        // ("I now have 59 pilots instead of the 15 needed", Discord 2026-09-11).
        // Severity now means "you still have to act", never "you are behind".
        const covered = short > 0 && gapBodies <= 0;
        const severe = !covered && short >= CREW_SEVERE_SHORTFALL;
        const hireTitle = (n) => n <= startNowBodies
          ? `Trains in ${CREW_LEAD_WEEKS[group.id]} weeks`
          : `${startNowBodies.toLocaleString()} start training now; the rest are recruited at ≈${Math.max(1, crewBodies(group.id, crew.intakePerWeek)).toLocaleString()} a week, then train for ${CREW_LEAD_WEEKS[group.id]} weeks. Paid for up front.`;
        const tone = short <= 0 ? 'var(--green)' : severe ? 'var(--red)' : 'var(--yellow)';
        // Everything below this line is in PEOPLE. The engine works in
        // narrowbody-equivalents (1.0 = one 160-seat narrowbody's full crew
        // establishment) and keeps doing so; showing that index raw is what had
        // players reading "0.9 pilots" off an A319 and concluding the game was
        // broken.
        const haveBodies  = crewBodies(group.id, crew.available);
        const needBodies  = crewBodies(group.id, crew.required);
        const aheadBodies = crewBodies(group.id, crew.requiredAhead);
        const bookBodies  = crewBodies(group.id, crew.orderBookRequired);
        const trainBodies = crewBodies(group.id, crew.training);
        const recruitBodies = crewBodies(group.id, crew.recruiting);
        const intakeBodies  = Math.max(1, crewBodies(group.id, crew.intakePerWeek));
        // People this week's intake can still start training straight away; a
        // hire beyond it goes into the recruiting queue.
        const startNowBodies = crewBodies(group.id, crew.intakeLeft);
        // Size the gap off the forward requirement: the point of showing it is
        // that you can hire for a delivery before it lands, not after.
        // Missing PEOPLE, not a percentage. A percentage rounds to "0% short"
        // long before the gap stops being reported, which is how the card came
        // to warn about a shortfall it was simultaneously printing as zero.
        const missingBodies = Math.max(0, needBodies - haveBodies);
        // Trained people above the requirement: reserve staff.
        const spareBodies = Math.max(0, haveBodies - needBodies);
        const bookGap    = crewBodies(group.id, crew.hireBook);
        // Nothing left to do for this group: neither today's fleet nor the order
        // book needs another body. Hiring is still OFFERED — a pilot takes ten
        // weeks, so hiring ahead of an order you have not placed yet is a real
        // move — but the button must stop presenting itself as the remedy for
        // the shortfall printed above it.
        const nothingNeeded = gapBodies <= 0 && bookGap <= 0;
        const leaversWk  = crewBodies(group.id, crew.leaversPerWeek);
        const costPerHead = crewHireCost(group.id, 1 / perUnit);
        const hireBodies = (n) => dispatch({ type: 'HIRE_CREW', group: group.id, bodies: n });
        const customN = Math.max(0, Math.floor(Number(customHire) || 0));
        const customCost = crewHireCost(group.id, customN / perUnit);
        const presets = [...new Set([gapBodies || bookGap || perUnit, perUnit])]
          .filter(n => n > 0).slice(0, 2);
        return (
          <div style={{
            marginBottom: 10, padding: '8px 10px', borderRadius: 4,
            background: 'var(--surface2)', border: `1px solid ${short > 0 ? tone : 'var(--border)'}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>Staffing</span>
              <span style={{ fontWeight: 600, color: tone }}>
                {haveBodies.toLocaleString()} / {needBodies.toLocaleString()} {group.name.toLowerCase()}
                {short > 0 ? ` · ${missingBodies.toLocaleString()} short`
                  : missingBodies > 0 ? ` · ${missingBodies.toLocaleString()} short, covered by reserves`
                  : spareBodies > 0 ? ` · fully staffed, ${spareBodies.toLocaleString()} in reserve`
                  : ' · fully staffed'}
              </span>
            </div>
            {/* One line that says what is happening, whatever is open below. */}
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4, display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <span>
                {crew.onTheWay > 1e-9
                  ? `${crewBodies(group.id, crew.onTheWay).toLocaleString()} on the way`
                  : 'Nobody in training'}
                {crew.reserveLevel > 0 ? ` · reserve level ${Math.round(crew.reserveLevel * 100)}%` : ''}
                {autoStaff ? ' · hiring is automatic' : ''}
              </span>
              <button type="button" className="btn-small" onClick={() => setShowDetails(v => !v)}
                aria-expanded={showDetails}>
                {showDetails ? 'Hide details' : 'Show details'}
              </button>
            </div>
            {showDetails && (<>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4 }}>
              ≈{perUnit} per narrowbody — enough to fly it all week with leave, training and reserve cover,
              scaled by aircraft size.
            </div>

            {/* Aircraft on order. EVERY group says something whenever anything is
                on order — the line used to appear only once a delivery was inside
                this group's training window, so with a delivery 6-10 weeks out
                pilots and maintenance spoke and cabin crew and ground staff went
                silent, which reads as a broken indicator rather than "not yet".

                ONE line, ONE colour rule, for all four groups. It was two
                differently-styled branches, and the not-yet branch was dim grey
                even when it was telling you to hire fourteen people — so the
                cards looked like different features and the quiet one looked
                unimportant ("it shows now but it is in gray text, also the
                styling is inconsistent", 2026-09-07). Urgency now comes from
                whether crew are actually MISSING, never from which branch
                rendered: a gap is amber on every card, covered is dim on every
                card. */}
            {crew.onOrder > 0 && (() => {
              const covered = bookGap <= 0;
              return (
                <div style={{ fontSize: 11, color: covered ? 'var(--text-dim)' : 'var(--yellow)', marginBottom: 4 }}>
                  🛬 {crew.hiringDueIn === 0 && crew.arriving.length > 0
                    ? <>{crew.arriving.length} of {crew.onOrder} aircraft arriving inside the {CREW_LEAD_WEEKS[group.id]}-week training window</>
                    : <>{crew.onOrder} aircraft on order</>}
                  {' — '}
                  {covered
                    ? `you have the ${bookBodies.toLocaleString()} ${group.name.toLowerCase()} they need`
                    : <>you will need {bookBodies.toLocaleString()} {group.name.toLowerCase()}, <strong>hire {bookGap.toLocaleString()}
                        {crew.hiringDueIn === 0 ? ' now' : ` by week ${crew.hiringDueIn}`}</strong></>}
                </div>
              );
            })()}

            {/* Attrition, made visible. It is the answer to "does staff required
                scale with age" — the requirement does not, but the workforce
                shrinks every week, faster when underpaid, so an airline that
                hired exactly enough is short again a month later. Shown only
                once it rounds to a whole person a week, or the line would read
                "0 leave each week" on a small airline. */}
            {leaversWk >= 1 && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
                ↩ ≈{leaversWk.toLocaleString()} leave each week at {payMultiplier.toFixed(2)}× pay
                {crew.onOrder > 0 ? ' — the hire figures above already cover those lost before delivery.'
                  : (groupState.autoReplace || autoStaff) ? ' — replaced automatically; their cover is already in training.'
                  : crew.relPay >= 1.995 ? ' — as low as it goes: at top pay this is retirements and moves. Tick "Replace leavers automatically" below.'
                  : ' — pay more to slow it, or tick "Replace leavers automatically" below.'}
              </div>
            )}
            {!autoStaff && <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!groupState.autoReplace}
                onChange={e => dispatch({ type: 'SET_AUTO_REPLACE', group: group.id, enabled: e.target.checked })}
              />
              Replace leavers automatically
              <span style={{ color: 'var(--text-dim)' }}>· hires ahead of leavers so you stay fully staffed — normal training cost, only up to what the fleet needs</span>
            </label>}
            {crew.instantRoom > 0 && (
              <div style={{ fontSize: 11, color: 'var(--green)', marginBottom: 4 }}>
                ⚡ Starter crew — your first {CREW_INSTANT_AIRCRAFT} aircraft crew up instantly, no training wait
              </div>
            )}
            {crew.training > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
                🎓 {trainBodies.toLocaleString()} in training
                {crew.nextReady != null && crew.nextReady > 0 ? ` · next ready in ${crew.nextReady} wk${crew.nextReady === 1 ? '' : 's'}` : ' · ready next week'}
              </div>
            )}
            {/* Talent market: the recruiting queue and how fast this pay fills it. */}
            {crew.recruiting > 1e-9 ? (
              <div style={{ fontSize: 11, color: 'var(--yellow)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>
                  🧲 {recruitBodies.toLocaleString()} still being recruited · ≈{intakeBodies.toLocaleString()} a week at {payMultiplier.toFixed(2)}×
                  {' '}— about {crew.recruitWeeks} wk{crew.recruitWeeks === 1 ? '' : 's'} to fill, then {CREW_LEAD_WEEKS[group.id]} weeks' training.
                  {' '}Pay more to recruit faster.
                </span>
                <button className="btn-small" onClick={() => dispatch({ type: 'CANCEL_RECRUITING', group: group.id })}
                  title="Stop recruiting the people still in the queue and get their training cost back. Anyone already in training stays.">
                  Cancel · refund {formatMoney(crewHireCost(group.id, crew.recruiting))}
                </button>
              </div>
            ) : (
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4 }}>
                🧲 Can recruit ≈{intakeBodies.toLocaleString()} {group.name.toLowerCase()} a week at {payMultiplier.toFixed(2)}×
                {crew.relPay < 0.995 ? ' — under the going rate, so recruits are scarce' : crew.relPay > 1.005 ? ' — above the going rate, so recruits come faster' : ''}.
                {' '}Bigger hires queue and fill week by week.
              </div>
            )}
            {short > 0 && (
              <div style={{ fontSize: 11, color: tone, marginBottom: 6 }}>
                {covered
                  ? `⏳ Short-handed until training finishes — on-time performance is suffering until then, but ${crewBodies(group.id, crew.onTheWay).toLocaleString()} are on the way: no further hiring needed.`
                  : severe
                  ? '⚠ Severely short — on-time performance and satisfaction are taking the maximum hit.'
                  : '⚠ Short-handed — on-time performance is suffering. Hire before it gets worse.'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {presets.map(n => {
                const cost = crewHireCost(group.id, n / perUnit);
                const instant = (n / perUnit) <= crew.instantRoom;
                return (
                  <button key={n} className="btn-small" disabled={cost > cash}
                    onClick={() => hireBodies(n)}
                    title={cost > cash ? 'Not enough cash to train this many'
                      : nothingNeeded ? `You already have enough ${group.name.toLowerCase()} for your fleet and everything on order — this hires ${n.toLocaleString()} more for growth`
                      : instant ? 'Starter crew — starts work immediately'
                      : hireTitle(n)}>
                    Hire {n.toLocaleString()} · {formatMoney(cost)}{instant ? ' · instant' : ''}
                  </button>
                );
              })}
              {/* Hire any number you like — asked for directly (2026-09-07): the
                  fixed buttons cannot express "I want 40 cabin crew". Typed in
                  PEOPLE and converted to the engine's units on dispatch. */}
              <input
                type="number" min="1" step="1" placeholder="Custom"
                value={customHire}
                onChange={e => setCustomHire(e.target.value)}
                style={{ width: 96 }}
                className="form-input"
                aria-label={`Number of ${group.name.toLowerCase()} to hire`}
              />
              <button className="btn-small" disabled={customN <= 0 || customCost > cash}
                onClick={() => { hireBodies(customN); setCustomHire(''); }}
                title={customN <= 0 ? 'Enter how many people to hire'
                  : customCost > cash ? 'Not enough cash to train this many'
                  : hireTitle(customN)}>
                Hire{customN > 0 ? ` ${customN.toLocaleString()} · ${formatMoney(customCost)}` : ''}
              </button>
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                {formatMoney(costPerHead)} each · {CREW_LEAD_WEEKS[group.id]}-week training
              </span>
            </div>
            </>)}
          </div>
        );
      })()}

      {/* Pay slider */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
          <span style={{ color: 'var(--text-muted)' }}>Pay rate</span>
          <span style={{ fontWeight: 600, color: payMultiplier > 1.05 ? 'var(--green)' : payMultiplier < 0.95 ? 'var(--red)' : 'var(--text)' }}>
            {payMultiplier.toFixed(2)}× market rate
            {crew && Math.abs((crew.market ?? 1) - 1) >= 0.005 && (
              <span style={{ fontWeight: 400, color: payMultiplier >= crew.market ? 'var(--green)' : 'var(--yellow)' }}
                    title="What rival airlines in this world pay this group, weighted by fleet size and damped by the rest of the industry at 1.0×. Recruiting speed and resignations follow your pay against this figure.">
                {' '}· rivals pay {crew.market.toFixed(2)}×
              </span>
            )}
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
        {/* Wage lock (Discord, 2026-10-04: "being able to lock it at x% would be
            nice"). Locked, the multiplier stays where the player set it and the
            premium is paid in full every week; unlocked, a premium drifts back
            toward market ~6%/yr as it always has. */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', marginTop: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!groupState.indexed}
            onChange={e => dispatch({ type: 'SET_PAY_INDEXED', group: group.id, indexed: e.target.checked })}
          />
          🔒 Hold this rate
          <span style={{ color: 'var(--text-dim)' }}>· keep {committedPay.toFixed(2)}× as market wages rise, instead of letting it slip back</span>
        </label>
        {committedPay > 1.0005 && !groupState.indexed && (() => {
          // Where the drift takes this group's pay in a year if nothing changes —
          // the same function the weekly tick applies, so the number is exact.
          const inAYear = erodePayPremium(committedPay, 52);
          return (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
              <span style={{ color: 'var(--yellow)', fontWeight: 600 }}>
                ↘ Market catching up: {committedPay.toFixed(2)}× → about {inAYear.toFixed(2)}× in a year
              </span>
              <span style={{ color: 'var(--text-dim)' }}>
                {' '}· Wages across the industry keep rising, so a premium you don't hold slips back toward market by
                about {Math.round(PAY_MARKET_CATCHUP_PER_YEAR * 100)}% a year, and morale follows it. Tick
                “Hold this rate” to keep it — you pay the full premium every week.
              </span>
            </div>
          );
        })()}
      </div>

      {/* Morale */}
      <MoraleBar morale={morale} payMultiplier={payMultiplier} reserveLift={crew?.moraleLift ?? 0} />

      {/* Union unrest (only worth showing once it exists, or during a strike) */}
      {(unrest >= 5 || onStrike) && <UnrestBar unrest={unrest} />}

      {/* Effect description */}
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>
        {group.effectDescription(morale)}
      </div>
    </div>
  );
}

// ─── Staffing summary ─────────────────────────────────────────────────────────
//
// The whole workforce on one card (2026-11-11). Four cards of eight status
// lines each answered every question except the two a player actually has:
// "am I staffed?" and "what do I have to do?". And staff above the requirement
// were invisible — "fully staffed" — which is how a player who had bought an
// airline and sold its aircraft came to ask what the crew "just sitting
// around" were for (Discord, 2026-11-10).
//
// One row per group, in people; one switch that does the hiring; a reserve
// level per group; and spare staff priced and translated into aircraft.
function StaffingSummary({ crew, labor, dispatch, autoStaff, autoRelease = false, plan, cash, wagePerUnit, commonType, reserveOtp, seniority = 1 }) {
  const rows = LABOR_GROUPS.map(g => {
    const c = crew[g.id];
    const have = crewBodies(g.id, c.available);
    const need = crewBodies(g.id, c.required);
    const spare = Math.max(0, have - need);
    const missing = Math.max(0, need - have);
    const levelBodies = crewBodies(g.id, c.required * c.reserveLevel);
    const over = Math.max(0, spare - levelBodies);              // above the chosen level
    const reserveCost = Math.round(wagePerUnit(g) * c.spare * RESERVE_PAY_RATE);
    const severance = Math.round(releaseSeveranceBase(g.id, crewUnitsForBodies(g.id, over))
      * (labor[g.id]?.payMultiplier ?? 1) * getEraCostScale() * seniority);
    // Spare crews as aircraft of the type this airline mostly flies.
    const perAircraft = crewScaleFor(g.id, commonType);
    const aircraft = perAircraft > 0 ? c.spare / perAircraft : Infinity;
    return { g, c, have, need, spare, missing, levelBodies, over, reserveCost, severance, aircraft };
  });
  const totalReserve = rows.reduce((s, r) => s + r.reserveCost, 0);
  const spareAircraft = Math.floor(Math.min(...rows.map(r => r.aircraft)) + 1e-6);
  const anySpare = rows.some(r => r.spare > 0);
  const typeName = commonType?.name ?? 'narrowbody';
  const hires = plan?.hires ?? [];
  const hireList = hires.map(h => `${h.bodies.toLocaleString()} ${LABOR_GROUP_MAP[h.group].name.toLowerCase()}`).join(', ');
  const th = { textAlign: 'left', fontWeight: 600, fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 8px 4px 0', whiteSpace: 'nowrap' };
  const td = { padding: '6px 8px 6px 0', fontSize: 12, verticalAlign: 'middle', borderTop: '1px solid var(--border)' };
  return (
    <div className="card" data-staffing-summary style={{ marginBottom: 12, padding: '14px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>Staffing</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 520 }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={autoStaff} style={{ marginTop: 2 }}
            onChange={e => dispatch({ type: 'SET_AUTO_STAFF', enabled: e.target.checked })} />
          <span>
            <strong>Keep me fully staffed</strong>
            <span style={{ color: 'var(--text-muted)' }}>
              {' '}· hires each group up to its reserve level for you: leavers are replaced and aircraft on order
              are crewed in time for delivery, at the normal training cost.
            </span>
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={autoRelease} style={{ marginTop: 2 }}
            onChange={e => dispatch({ type: 'SET_AUTO_RELEASE', enabled: e.target.checked })} />
          <span>
            <strong>Release staff above my reserve level</strong>
            <span style={{ color: 'var(--text-muted)' }}>
              {' '}· at the end of each week, staff your fleet and aircraft on order no longer need are let go
              for {RELEASE_SEVERANCE_WEEKS} weeks' pay each. Leave it off to keep them on reserve pay for growth.
            </span>
          </span>
        </label>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Group</th>
              <th style={th}>On the line</th>
              <th style={th}>Status</th>
              <th style={th}>On the way</th>
              <th style={th}>Reserve level</th>
              <th style={{ ...th, textAlign: 'right' }}>Reserve pay</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ g, c, have, need, spare, missing, levelBodies, over, reserveCost, severance }) => {
              const short = c.short > 0;
              const tone = short ? (c.short >= CREW_SEVERE_SHORTFALL ? 'var(--red)' : 'var(--yellow)') : 'var(--green)';
              const training = crewBodies(g.id, c.training);
              const recruiting = crewBodies(g.id, c.recruiting);
              return (
                <tr key={g.id}>
                  <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    <Glyph e={g.emoji} size={14} /> {g.name}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {have.toLocaleString()} <span style={{ color: 'var(--text-dim)' }}>/ {need.toLocaleString()} needed</span>
                  </td>
                  <td style={{ ...td, color: tone }}>
                    {short ? `${missing.toLocaleString()} short`
                      : spare > 0 ? `${spare.toLocaleString()} in reserve (${Math.round(c.reserveRatio * 100)}%)`
                      : 'Fully staffed'}
                    {over > 0 && (
                      <button type="button" className="btn-small" style={{ marginLeft: 8 }}
                        disabled={severance > cash}
                        onClick={() => dispatch({ type: 'RELEASE_CREW', group: g.id, bodies: over })}
                        title={severance > cash ? 'Not enough cash for the severance'
                          : `Let go the ${over.toLocaleString()} ${g.name.toLowerCase()} above your reserve level. Each is owed ${RELEASE_SEVERANCE_WEEKS} weeks' pay. Nobody your aircraft need is released.`}>
                        Release {over.toLocaleString()} · {formatMoney(severance)}
                      </button>
                    )}
                  </td>
                  <td style={{ ...td, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {training + recruiting <= 0 ? '—'
                      : [training > 0 ? `${training.toLocaleString()} training${c.nextReady != null ? ` (next in ${Math.max(1, c.nextReady)} wk)` : ''}` : null,
                         recruiting > 0 ? `${recruiting.toLocaleString()} recruiting` : null].filter(Boolean).join(' · ')}
                  </td>
                  <td style={td}>
                    <select className="form-select" value={String(c.reserveLevel)}
                      aria-label={`Reserve level for ${g.name.toLowerCase()}`}
                      style={{ padding: '2px 6px', fontSize: 12, width: 'auto' }}
                      onChange={e => dispatch({ type: 'SET_RESERVE_TARGET', group: g.id, target: Number(e.target.value) })}>
                      {[...new Set([...RESERVE_LEVELS, c.reserveLevel])].sort((a, b) => a - b).map(l => (
                        <option key={l} value={String(l)}>
                          {l === 0 ? 'None' : `${Math.round(l * 100)}% · ${crewBodies(g.id, c.required * l).toLocaleString()} people`}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', color: reserveCost > 0 ? 'var(--red)' : 'var(--text-dim)' }}>
                    {reserveCost > 0 ? `−${formatMoney(reserveCost)}/wk` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {anySpare && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          {spareAircraft >= 1
            ? <>Your reserve staff could crew <strong style={{ color: 'var(--text)' }}>about {spareAircraft.toLocaleString()} more {typeName}{spareAircraft === 1 ? '' : 's'}</strong> today, with no training wait. </>
            : <>Your reserve staff do not yet add up to a full crew for one more {typeName}: that takes spare people in all four groups. </>}
          {totalReserve > 0 && <>Reserve pay is {formatMoney(totalReserve)}/wk in all. </>}
          {reserveOtp >= 0.0005 && <>They are adding {(reserveOtp * 100).toFixed(1)} points of on-time performance. </>}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.5 }}>
        Reserve staff are trained people above what your fleet needs, paid {Math.round(RESERVE_PAY_RATE * 100)}% of a normal wage.
        They lift morale (up to +{RESERVE_MORALE_MAX} at a {Math.round(RESERVE_FULL_BENEFIT * 100)}% reserve) and on-time
        performance (up to +{Math.round(RESERVE_OTP_MAX * 100)} points), cut meltdown risk, and can fly a new aircraft the week
        it arrives. Past {Math.round(RESERVE_FULL_BENEFIT * 100)}% a bigger reserve only buys room to grow.
        Staff above your level are not replaced when they leave, or can be released for {RELEASE_SEVERANCE_WEEKS} weeks' pay.
      </div>

      {hires.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
          {autoStaff ? (
            plan.cost > cash ? (
              <span style={{ color: 'var(--yellow)' }}>
                ⚠ Not enough cash to hire everyone needed ({hireList} · {formatMoney(plan.cost)}). Hiring resumes as cash allows.
              </span>
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>
                Next hire, made for you when the week ends: {hireList} · {formatMoney(plan.cost)}.
              </span>
            )
          ) : (<>
            <button type="button" className="btn btn-primary" style={{ padding: '6px 12px', fontSize: 12 }}
              disabled={plan.cost > cash}
              onClick={() => { for (const h of hires) dispatch({ type: 'HIRE_CREW', group: h.group, bodies: h.bodies }); }}
              title={plan.cost > cash ? 'Not enough cash to train this many' : 'One hire for every group: your fleet, the aircraft arriving inside each training window, your reserve level, and cover for people who leave while the new hires train.'}>
              Hire everything needed · {formatMoney(plan.cost)}
            </button>
            <span style={{ color: 'var(--text-muted)' }}>{hireList}</span>
          </>)}
        </div>
      )}
      {hires.length === 0 && !autoStaff && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--green)' }}>
          Nothing to hire: every group has the people it needs, including for aircraft arriving inside its training window.
        </div>
      )}
    </div>
  );
}

// ─── Main Operations page ─────────────────────────────────────────────────────

// One tooltip that explains the whole crew pipeline. It trips people up because
// nothing about it is visible on a route: crew shortfall shows up as late flights,
// unhappy passengers and — past the severe line — aircraft quietly parked
// (Discord 2026-09-29).
const CREW_HOW_IT_WORKS =
  'Every aircraft needs pilots, cabin crew, ground staff and maintenance staff — bigger aircraft need more. '
  + 'New hires train before they can work (pilots ~10 weeks, cabin crew ~5), and a few leave every week, more if pay or morale is low. '
  + 'You can only recruit so many a week: a big hire is paid for up front and fills week by week, faster the better you pay against the going rate. '
  + 'Where other airlines compete for the same people, the going rate follows what they pay — out-pay them to recruit faster and keep your staff. '
  + 'A little short: on-time performance and passenger satisfaction drop. '
  + `${Math.round(CREW_SEVERE_SHORTFALL * 100)}% or more short on pilots or cabin crew: aircraft are parked — their routes earn nothing while lease and maintenance still bill. `
  + 'Hire ahead of new deliveries; the hire buttons already allow for training time and attrition. '
  + `Staff above what the fleet needs are reserves on ${Math.round(RESERVE_PAY_RATE * 100)}% pay: they lift morale and on-time performance and can crew a new aircraft at once. `
  + 'Tick "Keep me fully staffed" and all of this is done for you, to the reserve level you set for each group.';

/**
 * `section` (map view only — App.jsx's map pages) shows one part of the page:
 *   'crew'       Labour & Costs without marketing or catering
 *   'board'      the Departure Board and Schedule tabs
 *   'marketing'  the marketing card
 *   'catering'   default catering + catering contracts
 * Omitted, it is the classic page with all three sub-tabs.
 */
export default function Operations({ section = null } = {}) {
  const { state, dispatch } = useGame();
  const {
    fleet, routes = [], labor = DEFAULT_LABOR_STATE,
    maintenanceBudget = DEFAULT_MAINTENANCE_BUDGET,
  } = state;
  const fleetSize = fleet.length;
  const laborRelations = state.laborRelations ?? DEFAULT_LABOR_RELATIONS;
  const currentAbsWeek = ((state.year ?? 1) - 1) * 52 + (state.week ?? 1);
  // An airport screen may have asked for the board on a specific airport.
  const [requestedAirport] = useState(() => takeDepartureBoardRequest());
  // Take any filter parked for this tab so a later visit is not redirected.
  useEffect(() => { consumeNavFilter('operations'); }, []);
  const [subTab, setSubTab] = useState(requestedAirport || section === 'board' ? 'departures' : 'labor');
  const subTabs = section === 'board' ? SUB_TABS.filter(t => t.id !== 'labor') : SUB_TABS;
  const showSubTabs = !section || section === 'board';

  // ── Crew pipeline (A7) ──────────────────────────────────────────────────
  // Only in worlds/saves running the pipeline. `required` and `available` are
  // in narrowbody-equivalents — the same unit the wage bill uses — so they are
  // directly comparable and need no translation.
  const crewOn = state.crewPipeline === true;
  const typeOfAircraft = (a) => getAircraftType(a.typeId);
  // Computed FIRST so every card reads its shortfall from the same place the
  // engine does. The card used to derive its own, which is how one screen came
  // to say "156 / 156 cabin crew · 0% short" and "⚠ Short-handed" at once.
  const crewGapEngine = crewOn ? crewShortfall(labor, fleet, typeOfAircraft) : null;
  const crew = crewOn ? Object.fromEntries(LABOR_GROUPS.map(g => {
    const required  = crewRequired(g.id, fleet, typeOfAircraft);
    const available = crewAvailable(labor, g.id);
    const training  = crewInTraining(labor, g.id);
    // Talent market (models/talentMarket.js): hires beyond this week's intake
    // wait in a recruiting queue, and how fast it fills depends on pay against
    // the going rate. The queue is a hire already made, so every "how many to
    // hire" figure below counts it as on the way.
    const recruiting = crewRecruiting(labor, g.id);
    const onTheWay  = training + recruiting;
    const batches   = labor?.[g.id]?.pipeline ?? [];
    const nextReady = batches.length
      ? Math.min(...batches.map(b => (b?.readyAbsWeek ?? 0))) - currentAbsWeek
      : null;
    // How much of the NEXT hire would start work immediately (starter crew).
    const instantRoom = splitStarterHire(g.id, Number.MAX_SAFE_INTEGER, available, fleet, typeOfAircraft).instant;
    // What the fleet will need once aircraft arriving inside this group's own
    // training lead time have landed. Hire buttons size off THIS, because a
    // pilot hired today is only usable in ten weeks.
    const requiredAhead = crewRequiredAhead(g.id, fleet, state.pendingOrders, typeOfAircraft, currentAbsWeek);
    const arriving = deliveriesWithinLeadTime(g.id, state.pendingOrders, currentAbsWeek);
    // Where the airline is heading once EVERY order lands, plus when hiring for
    // the next one should start. Without these a group whose training window is
    // shorter than the wait for the next delivery showed nothing at all, which
    // reads as a missing indicator rather than "not yet".
    const orderBookRequired = crewRequiredForOrderBook(g.id, fleet, state.pendingOrders, typeOfAircraft);
    // Hiring recommendations are ATTRITION-AWARE. Crew leave every week, so a
    // hire sized to today's gap is already short by the time an aircraft ten
    // weeks out arrives — which is what "i order staff for my whole orderbook
    // and it ends up needing more by the time my order finishes" describes.
    const pay = labor?.[g.id]?.payMultiplier ?? 1.0;
    const mor = labor?.[g.id]?.morale ?? 80;
    // Retention and recruiting both read pay RELATIVE to the going rate (1.0×
    // in solo), exactly as the tick does.
    const market = goingRate(state, g.id);
    const relPay = relativePay(state, g.id, pay);
    const intakePerWeek = weeklyIntakeUnits(required, relPay);
    const intakeLeft = recruiting > 1e-9 ? 0 : Math.max(0, intakePerWeek - intakeUsed(labor?.[g.id], currentAbsWeek));
    const recruitWeeks = weeksToRecruit(recruiting, intakePerWeek);
    const weeksToBook = weeksToOrderBookComplete(state.pendingOrders, currentAbsWeek);
    const weeksToArriving = arriving.length
      ? Math.max(...arriving.map(o => (Number(o?.deliverAbsWeek) || 0) - currentAbsWeek))
      : 0;
    const hireAhead = crewHiresNeeded(g.id, {
      need: requiredAhead, onLine: available, inTraining: onTheWay,
      payMultiplier: relPay, morale: mor, weeksToTarget: weeksToArriving,
    });
    const hireBook = crewHiresNeeded(g.id, {
      need: orderBookRequired, onLine: available, inTraining: onTheWay,
      payMultiplier: relPay, morale: mor, weeksToTarget: weeksToBook,
    });
    // When to start hiring for the next delivery. A hire bigger than one week's
    // intake waits in the recruiting queue before it can start training, so
    // "hire by week N" counts that wait too: the crew the NEXT delivery needs,
    // behind anyone already queued. Hiring exactly on the old date landed the
    // crew a week or two after the aircraft (Discord 2026-10-21).
    const hiringDueIn = weeksUntilHiringDue(g.id, state.pendingOrders, currentAbsWeek,
      nextDeliveryQueueWeeks(g.id, { fleet, pendingOrders: state.pendingOrders, typeOf: typeOfAircraft,
        absWeek: currentAbsWeek, onLine: available, onTheWay, recruiting, relPay, morale: mor, intakePerWeek }));
    const leaversPerWeek = crewExpectedLeavers(available, relPay, mor, 1);
    // Reserve staff: trained people above the requirement, and the level the
    // player has asked this group to be kept at.
    const spare = crewSpare(labor, g.id, fleet, typeOfAircraft);
    const reserveLevel = reserveTarget(labor, g.id);
    const reserveRatio = crewReserveRatio(labor, g.id, fleet, typeOfAircraft);
    const moraleLift = reserveMoraleBonus(labor, g.id, fleet, typeOfAircraft);
    return [g.id, { spare, reserveLevel, reserveRatio, moraleLift,
                    required, available, training, recruiting, onTheWay, nextReady, instantRoom,
                    market, relPay, intakePerWeek, intakeLeft, recruitWeeks,
                    requiredAhead, arriving, orderBookRequired, hiringDueIn,
                    hireAhead, hireBook, leaversPerWeek, weeksToBook,
                    onOrder: (state.pendingOrders ?? []).length,
                    short: crewGapEngine?.byGroup?.[g.id] ?? 0 }];
  })) : null;
  const crewGap = crewGapEngine;

  // Headcount, in people, from the same requirement the crew box shows.
  const headcounts = Object.fromEntries(
    LABOR_GROUPS.map(g => [g.id, headcountFor(g.id, fleet, typeOfAircraft)])
  );
  const totalHeadcount = Object.values(headcounts).reduce((s, n) => s + n, 0);

  // Fleet complexity — families currently in use
  const familySet  = getActiveFamilies(fleet);
  const familyCost = weeklyFamilyBaseCost(fleet);
  const complexityMult = fleetComplexityMultiplier(fleet);

  // Total labor overhead per week (pilots & maintenance carry the complexity surcharge)
  // A group's weekly wage for one narrowbody crew, and the units it is billed
  // for (requirement + reserves at the reserve rate) — the tick's own sums.
  const seniority = seniorityFor(state, currentAbsWeek);
  const wagePerUnit = (g) => {
    const payMult = labor[g.id]?.payMultiplier ?? 1.0;
    const famMult = COMPLEXITY_AFFECTED_GROUPS.includes(g.id) ? complexityMult : 1.0;
    return g.baseWeeklyPerAircraft * payMult * famMult * seniority * getEraCostScale();
  };
  const billUnits = Object.fromEntries(LABOR_GROUPS.map(g =>
    [g.id, laborBillUnits(g.id, labor, fleet, typeOfAircraft, crewOn)]));
  const totalLaborWeekly = LABOR_GROUPS.reduce((sum, g) =>
    sum + Math.round(wagePerUnit(g) * billUnits[g.id].line) + Math.round(wagePerUnit(g) * billUnits[g.id].reserve * RESERVE_PAY_RATE), 0);
  // "Keep me fully staffed", and what one click (or the switch) would hire now.
  const autoStaff = crewOn && state.crewAutoStaff === true;
  const hirePlan = crewOn ? crewHireAllPlan(labor, fleet, typeOfAircraft,
    (id) => relativePay(state, id, labor?.[id]?.payMultiplier),
    { pendingOrders: state.pendingOrders ?? [], absWeek: currentAbsWeek }) : null;
  // The type this airline mostly flies: spare crews are quoted in these.
  const commonType = (() => {
    const n = {};
    for (const a of fleet) n[a.typeId] = (n[a.typeId] ?? 0) + 1;
    const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0];
    return top ? getAircraftType(top) : null;
  })();

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

  // Catering: part of the Labour & Costs page in the classic layout; its own
  // tab under Service in the map view (section prop). Marketing lives on the
  // Brand page (Reputation.jsx) beside the awareness it buys.
  const cateringBlock = (<>
      {/* Default catering section */}
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: 20, marginBottom: 10,
      }}>
        Default Catering Service
      </div>

      <div className="card" style={{ padding: '14px 18px' }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          The catering level{state.cateringPlansWorld === true ? ' or service plan' : ''} applied to every newly-opened route. You can still override it
          per route on the Routes page. Existing routes are unaffected.
        </div>
        <CateringSelector
          value={normalizeCateringRef(state.defaultCateringLevel, state.cateringPlans)}
          onChange={(level) => dispatch({ type: 'SET_DEFAULT_CATERING', level })}
          plans={state.cateringPlans}
          label={null}
        />
      </div>

      {/* New worlds only: the airline carries cateringPlansWorld when its world
          was created with custom catering. */}
      {state.cateringPlansWorld === true && (<>
        <div style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: 20, marginBottom: 10,
        }}>
          Service Plans
        </div>
        <CateringPlans />
      </>)}

      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: 20, marginBottom: 10,
      }}>
        Catering Contracts
      </div>
      <CateringContracts />
  </>);

  return (
    <div>
      {/* Sub-tabs. Labour and the departure board are both "how the operation is
          running", and the board needs a home with room for an airport picker —
          the airport screen shows one airport, this shows any of them. */}
      {showSubTabs && <div style={{ display: 'flex', gap: 6, marginBottom: 16, borderBottom: '1px solid var(--border)' }}>
        {subTabs.map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '7px 12px', fontSize: 13,
              fontWeight: subTab === t.id ? 600 : 400,
              color: subTab === t.id ? 'var(--text)' : 'var(--text-muted)',
              borderBottom: `2px solid ${subTab === t.id ? 'var(--blue)' : 'transparent'}`,
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>}

      {section === 'catering' ? cateringBlock
        : subTab === 'schedule' ? <ScheduleTimeline /> : subTab === 'departures' ? <Departures initialAirport={requestedAirport} /> : (<>
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

      {/* Active strike. (Union pay demands were removed 2026-10-04 — pay is
          the player's call; unrest still builds from low pay and morale.) */}
      {laborRelations.strike && (
        <StrikeBanner strike={laborRelations.strike} labor={labor} dispatch={dispatch} />
      )}

      {/* Labor section */}
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10,
      }}>
        Labor Groups
        {crewOn && (
          <InfoTip
            style={{ marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}
            text={CREW_HOW_IT_WORKS}
          />
        )}
      </div>

      {/* Severity here means "you still have something to DO", not "you are
          behind". A group whose gap is already sitting in the training queue is
          reported as a wait, in amber, with the queue visible — the banner used
          to render it in the same max-severity red as an airline that had hired
          nobody, which is what sent a player to 59 pilots for a 15-pilot
          airline (Discord 2026-09-11). The engine is untouched: those trainees
          still cannot fly and the on-time penalty still bites, which is why the
          banner keeps saying so rather than going quiet. */}
      {crewGap && crewGap.worst > 0 && (() => {
        const crewSt = crewStatus(state, typeOfAircraft);
        const parkedCount = crewSt?.parkedIds.length ?? 0;
        const parkedOnRoutes = crewSt?.parkedOnRoutes ?? 0;
        const shortGroups = LABOR_GROUPS.filter(g => (crew?.[g.id]?.short ?? 0) > 0);
        // Covered = the engine's own attrition-aware recommendation for this
        // group is zero. Same number the card's hire buttons read, so the banner
        // and the card can never disagree about whether hiring is needed.
        const isCovered = (g) => crewBodies(g.id, crew?.[g.id]?.hireAhead ?? 0) <= 0;
        const needHiring = shortGroups.filter(g => !isCovered(g));
        const severe = needHiring.some(g => (crew?.[g.id]?.short ?? 0) >= CREW_SEVERE_SHORTFALL);
        const tone = needHiring.length === 0 ? 'var(--yellow)'
                   : severe ? 'var(--red)' : 'var(--yellow)';
        const title = needHiring.length === 0 ? 'Crewing up'
                    : severe ? 'Severely understaffed' : 'Short-handed';
        const describe = (g) => {
          const missing = Math.max(0, crewBodies(g.id, crew[g.id].required) - crewBodies(g.id, crew[g.id].available));
          const training = crewBodies(g.id, crew[g.id].onTheWay);
          return isCovered(g)
            ? `${g.name} ${missing.toLocaleString()} short · ${training.toLocaleString()} on the way`
            : `${g.name} ${missing.toLocaleString()} short`;
        };
        return (
          <div style={{
            marginBottom: 10, padding: '9px 12px', borderRadius: 4, fontSize: 12,
            background: 'var(--surface2)',
            border: `1px solid ${tone}`, color: tone,
          }}>
            <strong>{title}</strong>
            {' — '}
            {shortGroups.map(describe).join(' · ')}
            {parkedCount > 0 && (
              <div style={{ margin: '4px 0', fontWeight: 600 }}>
                {parkedCount} aircraft {parkedCount === 1 ? 'is' : 'are'} parked this week for lack of crew
                {parkedOnRoutes > 0 ? ` — ${parkedOnRoutes} of them fly routes, which earn nothing until crew qualify` : ''}.
                {' '}They still cost their lease and maintenance (marked "No crew" on the Fleet page).
              </div>
            )}
            {needHiring.length === 0
              ? '. Flying short-handed costs on-time performance and passenger satisfaction until they qualify — but everyone you need is already in training, so no further hiring needed.'
              : <>. Flying short-handed costs on-time performance and passenger satisfaction; crew take
                  {' '}{Math.min(...LABOR_GROUPS.map(g => CREW_LEAD_WEEKS[g.id]))}–{Math.max(...LABOR_GROUPS.map(g => CREW_LEAD_WEEKS[g.id]))} weeks to train{autoStaff ? '. Keep me fully staffed is hiring for you; a deeper reserve level would have covered this.' : ', so hire ahead of your deliveries.'}</>}
          </div>
        );
      })()}

      {crewOn && crew && (
        <StaffingSummary
          crew={crew} labor={labor} dispatch={dispatch} autoStaff={autoStaff} autoRelease={crewOn && state.crewAutoRelease === true}
          plan={hirePlan} cash={state.cash ?? 0} wagePerUnit={wagePerUnit}
          commonType={commonType} seniority={seniority}
          reserveOtp={reserveOtpBonus(labor, fleet, typeOfAircraft)}
        />
      )}

      {LABOR_GROUPS.map(group => (
        <LaborCard
          key={`${group.id}-${autoStaff ? 'auto' : 'manual'}`}
          lineUnits={billUnits[group.id].line}
          autoStaff={autoStaff}
          seniority={seniority}
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

      {!section && cateringBlock}

      {/* HQ & Corporate overhead section */}
      {fleet.length > 0 && (() => {
        const hqInfo = hqBracket(fleet.length);
        // The tick is the only authority on this number. In a restricted world it
        // is base + per-departure fees, which needs the season and the
        // out-of-service set to reproduce — so read what the tick actually
        // charged rather than re-deriving it here and drifting. The curve is the
        // fallback for a fleet that has not been ticked yet, and it is measured
        // in narrowbody-equivalents, not airframes, exactly as weeklyTick does.
        const hqCost = state.lastReport?.totalHQCost
          ?? calcHQCost(fleetHQScale(fleet, a => getAircraftType(a.typeId)));
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
      </>)}
    </div>
  );
}
