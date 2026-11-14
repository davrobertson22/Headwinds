// Preorders for aircraft still in development (Discord: Kat the Fox,
// "Preorders for progressing times", 2026-11-12). Design and decisions:
// claude/preorders.md.
//
// Era worlds only (a classic world's catalogue is timeless). A type is
// announced two years before it enters service; from then until its first
// delivery any airline may preorder it:
//   - bought outright, any quantity (no lessor carries an unflown type)
//   - PREORDER_DEPOSIT of the price now, the balance as each frame arrives;
//     a balance the airline cannot pay cancels that frame and loses its deposit
//   - an early-bird discount of up to PREORDER_EARLY_MAX, sliding to nothing
//     at entry into service, on top of the bulk discount (capped like launch
//     orders)
//   - cancelling forfeits the deposit, unless the programme has slipped
// Production-line worlds keep the strict launch-customer window (the first
// 26 weeks after the announcement); preorders open to everyone after it.
//
// Programme delays: about one programme in five slips by 26–52 weeks. The
// slip is decided per world from the world's seed (server side, never sent
// to clients) and revealed DELAY_REVEAL_WEEKS before entry into service. The
// server keeps the revealed table in the world's tickConfig and stamps it on
// every airline at the tick (ADVANCE_WEEK action.programmeDelays) and at
// join, so every airline in a world sees the same slips.

import { AIRCRAFT_TYPES, getAircraftType, orderDiscount } from './aircraft.js';
import { absoluteWeek } from '../utils/fuel.js';
import { launchWindow, MAX_TOTAL_DISCOUNT, LAUNCH_ANNOUNCE_YEARS } from './productionLines.js';

export const PREORDER_DEPOSIT = 0.20;
export const PREORDER_EARLY_MAX = 0.08;
export const DELAY_CHANCE = 0.20;
export const DELAY_MIN_WEEKS = 26;
export const DELAY_MAX_WEEKS = 52;
export const DELAY_REVEAL_WEEKS = 26;
// A revealed slip stays on the books this long after the delayed first
// delivery (for the record and the Orders tab), then drops off the blob.
const DELAY_KEEP_WEEKS = 52;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const isEra = (state) => Number.isInteger(state?.startYear);
const nowAbs = (state) => absoluteWeek(state?.year ?? 1, state?.week ?? 1);

/** Revealed slip for a type in this airline's world, in weeks (0 when none). */
export function programmeDelayWeeks(state, typeId) {
  const w = Number(state?.programmeDelays?.[typeId]?.weeks);
  return Number.isFinite(w) && w > 0 ? Math.round(w) : 0;
}

function timelineFor(startYear, type, delayWeeks = 0) {
  const yearIdx = (calYear) => calYear - startYear + 1;
  const announceAbs = absoluteWeek(yearIdx(type.eis - LAUNCH_ANNOUNCE_YEARS), 1);
  const eisAbs = absoluteWeek(yearIdx(type.eis), 1);
  return { announceAbs, eisAbs, delayWeeks, firstDeliveryAbs: eisAbs + delayWeeks };
}

/**
 * A type's development programme in an era world, or null.
 * { announceAbs, eisAbs, delayWeeks, firstDeliveryAbs }
 */
export function programmeTimeline(state, type) {
  if (!isEra(state) || !type || !Number.isInteger(type.eis)) return null;
  return timelineFor(state.startYear, type, programmeDelayWeeks(state, type.id));
}

/** Early-bird discount at this week: PREORDER_EARLY_MAX at the announcement, 0 at entry into service. */
export function earlyBirdDiscount(tl, absWeek) {
  if (!tl) return 0;
  const span = tl.eisAbs - tl.announceAbs;
  if (span <= 0) return 0;
  const f = Math.max(0, Math.min(1, (tl.eisAbs - absWeek) / span));
  return PREORDER_EARLY_MAX * f;
}

/**
 * Is this type open to preorders right now? Null when not.
 * { open, announceAbs, eisAbs, delayWeeks, firstDeliveryAbs, discount, deposit }
 */
export function preorderWindow(state, type) {
  const tl = programmeTimeline(state, type);
  if (!tl) return null;
  const now = nowAbs(state);
  if (now < tl.announceAbs || now >= tl.firstDeliveryAbs) return null;
  // Production-line worlds: the launch-customer window comes first.
  if (launchWindow(state, type)?.open) return null;
  return { open: true, ...tl, discount: earlyBirdDiscount(tl, now), deposit: PREORDER_DEPOSIT };
}

/** Bulk + early bird, capped like a launch order. */
export function preorderOrderDiscount(state, type, quantity) {
  const tl = programmeTimeline(state, type);
  return Math.min(MAX_TOTAL_DISCOUNT, orderDiscount(quantity) + earlyBirdDiscount(tl, nowAbs(state)));
}

/** Deposit on one frame whose full price is `unitPrice`. */
export function preorderDeposit(unitPrice) {
  return Math.round((Number(unitPrice) || 0) * PREORDER_DEPOSIT);
}

/** "March 1973" for an absolute week in an era world. */
export function absWeekLabel(state, absWeek) {
  if (!isEra(state)) return `week ${absWeek}`;
  const yearIdx = Math.floor((absWeek - 1) / 52);
  const week = absWeek - yearIdx * 52;
  return `${MONTHS[Math.min(11, Math.floor((week - 1) * 12 / 52))]} ${state.startYear + yearIdx}`;
}

// ── Programme delays (server side) ───────────────────────────────────────────

function seededRand(seedStr, salt) {
  let h = 2166136261 >>> 0;
  const s = `${seedStr}:${salt}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h += 0x6d2b79f5;
  let t = h >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** This world's slip for a type, in weeks (0 = on time). Deterministic per (seed, type). */
export function programmeDelayRoll(seed, typeId) {
  if (seededRand(seed, `programme:${typeId}`) >= DELAY_CHANCE) return 0;
  const span = DELAY_MAX_WEEKS - DELAY_MIN_WEEKS + 1;
  return DELAY_MIN_WEEKS + Math.min(span - 1, Math.floor(seededRand(seed, `programme-len:${typeId}`) * span));
}

/**
 * The world's revealed programme slips at `absWeek`: { [typeId]: { weeks } }.
 * Keeps every slip already in `prev` until DELAY_KEEP_WEEKS after its delayed
 * first delivery, and reveals a new one only for a type whose reveal week has
 * come and that has NOT yet entered service — so a type already flying when
 * the table is first stamped (a live world on the day this shipped) is never
 * delayed after the fact. Pure: the same inputs give the same table.
 */
export function revealProgrammeDelays({ seed, startYear, absWeek, prev = {}, types = AIRCRAFT_TYPES } = {}) {
  if (!Number.isInteger(startYear) || seed == null || !Number.isFinite(absWeek)) return {};
  const out = {};
  for (const [id, entry] of Object.entries(prev ?? {})) {
    const t = getAircraftType(id);
    const weeks = Number(entry?.weeks);
    if (!t || !Number.isInteger(t.eis) || !(weeks > 0)) continue;
    const tl = timelineFor(startYear, t, Math.round(weeks));
    if (absWeek < tl.firstDeliveryAbs + DELAY_KEEP_WEEKS) out[id] = { weeks: Math.round(weeks) };
  }
  for (const t of types) {
    if (!Number.isInteger(t?.eis) || out[t.id]) continue;
    const tl = timelineFor(startYear, t);
    if (absWeek < tl.eisAbs - DELAY_REVEAL_WEEKS || absWeek >= tl.eisAbs) continue;
    const weeks = programmeDelayRoll(seed, t.id);
    if (weeks > 0) out[t.id] = { weeks };
  }
  return out;
}

/** Types in `next` that `prev` did not have (newly announced slips). */
export function newlyDelayed(prev = {}, next = {}) {
  return Object.keys(next ?? {}).filter(id => !(prev ?? {})[id] && programmeDelayWeeks({ programmeDelays: next }, id) > 0);
}
