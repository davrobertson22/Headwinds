/**
 * talentMarket.js — pay sets how fast you can hire, and you hire against rivals.
 *
 * Discord, 2026-10-04 (VodkaOnFire): "Perhaps wages should determine how quickly
 * you are able to fill up your staff needs and be part of a market where you
 * compete with other airlines for talent."
 *
 * Before this, pay did two things: it set morale, and it set how fast people
 * QUIT. It did nothing for how fast they JOIN — HIRE_CREW took any number of
 * recruits on the spot at any pay, so a 0.8× airline could double its pilot
 * corps in one click exactly as quickly as a 1.5× one. And "1.0×" was a fixed
 * number in a vacuum: in Headwinds a rival paying 1.6× took nothing from you.
 *
 * Three pieces, all crew-pipeline only (worlds/saves with `crewPipeline: true`):
 *
 * 1. THE GOING RATE. Per labor group, what the industry pays right now, as a
 *    multiple of the base scale. Solo has no rival payrolls, so it is 1.0×.
 *    In Headwinds the server derives it from every OTHER airline in the world
 *    (goingRateFromRivals) and injects it as `state.laborMarket` alongside the
 *    rest of the rival view — never persisted. Rivals are weighted by fleet
 *    size against a fixed "rest of the industry" at 1.0×, so two startups in an
 *    empty world cannot drag the market around, while a few 300-tail carriers
 *    all paying 1.5× genuinely do.
 *
 * 2. RECRUITING SPEED. Each group can take on a limited number of recruits a
 *    week — a share of what the fleet needs, with a floor so a startup can
 *    still crew up — scaled by how attractive the offer is RELATIVE to the
 *    going rate. A hire beyond this week's intake is still paid for up front,
 *    and waits in a recruiting queue that fills, week by week, at that speed.
 *    Pay well and a big hire fills fast; pay under the going rate and it
 *    trickles in.
 *
 * 3. POACHING. Attrition already rose as pay fell. It now reads pay RELATIVE to
 *    the going rate, so a rival out-paying you takes your people. In solo the
 *    going rate is 1.0× and attrition is exactly what it was.
 *
 * Morale is deliberately untouched: it still follows your own pay, so on-time
 * performance, service and maintenance balance do not move with the market.
 *
 * Dependency-free leaf, shared by the engine, the UI and the Headwinds server.
 */

export const TALENT_GROUP_IDS = ['pilots', 'cabinCrew', 'groundStaff', 'maintenanceTeam'];

/** "The rest of the industry" — airlines outside the world, all at 1.0×,
 *  weighed in aircraft. It damps the going rate in small worlds. */
export const GOING_RATE_BASE_FLEET = 150;
export const GOING_RATE_MIN = 0.85;
export const GOING_RATE_MAX = 1.6;

/** Recruits a group can take on per week at the going rate: this share of the
 *  fleet's requirement, never fewer than the floor (narrowbody crew units). */
export const RECRUIT_SHARE_PER_WEEK = 0.04;
export const RECRUIT_FLOOR_UNITS = 2;
/** Appeal = relative pay ^ exponent, clamped. 0.8× → 0.57, 1.2× → 1.58, 1.5× → 2.76. */
export const RECRUIT_APPEAL_EXPONENT = 2.5;
export const RECRUIT_APPEAL_MIN = 0.3;
export const RECRUIT_APPEAL_MAX = 3;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * The going rate per group from the OTHER airlines in a world.
 * @param {{ fleetSize: number, labor: object }[]} rivals
 * @returns {Record<string, number>}
 */
export function goingRateFromRivals(rivals = []) {
  const out = {};
  for (const id of TALENT_GROUP_IDS) {
    let w = GOING_RATE_BASE_FLEET;
    let sum = GOING_RATE_BASE_FLEET * 1.0;
    for (const r of rivals ?? []) {
      const n = Math.max(0, Number(r?.fleetSize) || 0);
      if (n <= 0) continue;
      const pay = Number(r?.labor?.[id]?.payMultiplier);
      sum += n * clamp(Number.isFinite(pay) ? pay : 1.0, 0.5, 2.0);
      w += n;
    }
    out[id] = round3(clamp(sum / w, GOING_RATE_MIN, GOING_RATE_MAX));
  }
  return out;
}

/** The going rate for one group as this state sees it (1.0 in solo). */
export function goingRate(state, groupId) {
  const v = Number(state?.laborMarket?.[groupId]);
  return Number.isFinite(v) && v > 0 ? clamp(v, GOING_RATE_MIN, GOING_RATE_MAX) : 1.0;
}

/** Pay relative to the going rate: 1.0 means "paying what the market pays". */
export function relativePay(state, groupId, payMultiplier) {
  const pay = Number(payMultiplier);
  return (Number.isFinite(pay) ? pay : 1.0) / goingRate(state, groupId);
}

/** How attractive an offer is to recruits, from relative pay. */
export function recruitAppeal(relPay) {
  const r = Math.max(0.1, Number(relPay) || 1.0);
  return clamp(Math.pow(r, RECRUIT_APPEAL_EXPONENT), RECRUIT_APPEAL_MIN, RECRUIT_APPEAL_MAX);
}

/** Recruits (in crew units) a group can take on in one week. */
export function weeklyIntakeUnits(needUnits, relPay) {
  const need = Math.max(0, Number(needUnits) || 0);
  return Math.max(RECRUIT_FLOOR_UNITS, need * RECRUIT_SHARE_PER_WEEK) * recruitAppeal(relPay);
}

/** Intake already used in `absWeek` by a group's state (0 for another week). */
export function intakeUsed(groupState, absWeek) {
  const it = groupState?.intake;
  return it && it.absWeek === absWeek ? Math.max(0, Number(it.used) || 0) : 0;
}

/** Weeks to clear a recruiting queue at this intake (0 when nothing waits). */
export function weeksToRecruit(queuedUnits, intakePerWeek) {
  const q = Math.max(0, Number(queuedUnits) || 0);
  if (q <= 1e-9) return 0;
  return Math.ceil(q / Math.max(1e-6, Number(intakePerWeek) || 0));
}
