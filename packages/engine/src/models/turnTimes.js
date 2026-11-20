// turnTimes.js — standard ground turn times the player sets (docs/turn-times-design.md).
//
// Every aircraft class has a standard turn (the table the game has always
// used) and limits either side of it. The player may set a fleet-wide turn
// per class (state.turnTimes.byClass) and override it on a route
// (route.schedule.turnMin). A short turn flies more rotations under the
// block-hour cap but costs on-time performance and ground-staff morale; a
// long turn the reverse, with diminishing returns.
//
// The default is the table itself. A value equal to the standard is never
// stored, so a save that never touches the setting runs exactly the maths it
// always did, to the last digit (the NB standard is 0.83 h, not 50/60).
//
// Pure module: no imports from utils/simulation.js (which imports this).

/** Ground turnaround time by passenger category (hours) — the standard. */
export const TURNAROUND_HOURS = {
  'Turboprop':    0.50,   // 30 min
  'Regional Jet': 0.67,   // 40 min
  'Narrow Body':  0.83,   // 50 min
  'Wide Body':    1.50,   // 90 min
  'Double Deck':  2.00,   // 120 min — two boarding doors, complex deplaning
  'Supersonic':   2.00,   // 120 min — complex servicing
};

// Freighters all share one category, so they can be stepped by neither the speed
// nor the turnaround table above — a 9-tonne ATR and a 250-tonne An-225 would
// otherwise both take the generic fallback. Turnaround steps by payload (loading
// and unloading main-deck ULDs is what takes the time); speed comes from each
// type's own `cruiseKmh` field.
export const FREIGHTER_TURNAROUND_HOURS = [
  { maxTonnes:  20, hours: 0.75, key: 'Freighter S',  label: 'Small freighters (up to 20 t)' },
  { maxTonnes:  50, hours: 1.00, key: 'Freighter M',  label: 'Medium freighters (20–50 t)' },
  { maxTonnes: 130, hours: 1.50, key: 'Freighter L',  label: 'Large freighters (50–130 t)' },
  { maxTonnes: Infinity, hours: 1.75, key: 'Freighter XL', label: 'Heavy freighters (over 130 t)' },
];

const FALLBACK_HOURS = 0.75;

/** Turn limits by passenger class, minutes: [min, max]. Floors sit near real
 *  quick turns (Ryanair's ~25-minute 737 turn). */
const PAX_LIMITS = {
  'Turboprop':    [20, 50],
  'Regional Jet': [25, 70],
  'Narrow Body':  [30, 80],
  'Wide Body':    [60, 150],
  'Double Deck':  [80, 180],
  'Supersonic':   [90, 180],
};
/** Freighters: 65% to 160% of their payload band's standard. */
const FREIGHTER_MIN_SHARE = 0.65;
const FREIGHTER_MAX_SHARE = 1.60;

export const TURN_STEP_MIN = 5;

/** Display order and labels for the Operations card. */
export const TURN_CLASSES = [
  { key: 'Turboprop',    label: 'Turboprops' },
  { key: 'Regional Jet', label: 'Regional jets' },
  { key: 'Narrow Body',  label: 'Narrowbodies' },
  { key: 'Wide Body',    label: 'Widebodies' },
  { key: 'Double Deck',  label: 'Double-deckers' },
  { key: 'Supersonic',   label: 'Supersonic' },
  ...FREIGHTER_TURNAROUND_HOURS.map(b => ({ key: b.key, label: b.label })),
];

const step = (m) => Math.round(m / TURN_STEP_MIN) * TURN_STEP_MIN;

function freighterBand(type) {
  const t = type?.payloadTonnes ?? 0;
  return FREIGHTER_TURNAROUND_HOURS.find(b => t <= b.maxTonnes);
}

/** The class a type's turn is set by: its category, or its freighter payload band. */
export function turnClassKey(type) {
  if (type?.freighter) return freighterBand(type).key;
  return type?.category ?? null;
}

/** The standard turn (hours) for a type — the table, unrounded. */
export function standardTurnHours(type) {
  if (type?.freighter) return freighterBand(type).hours;
  return TURNAROUND_HOURS[type?.category] ?? FALLBACK_HOURS;
}

/** Limits for a class key, minutes: { min, std, max }. */
export function turnLimitsForClass(key) {
  const band = FREIGHTER_TURNAROUND_HOURS.find(b => b.key === key);
  if (band) {
    const std = Math.round(band.hours * 60);
    return { min: step(std * FREIGHTER_MIN_SHARE), std, max: step(std * FREIGHTER_MAX_SHARE) };
  }
  const h = TURNAROUND_HOURS[key];
  if (h == null) {
    const std = Math.round(FALLBACK_HOURS * 60);
    return { min: std, std, max: std };
  }
  const [min, max] = PAX_LIMITS[key];
  return { min, std: Math.round(h * 60), max };
}

/** Limits for a type, minutes: { min, std, max }. */
export function turnLimits(type) {
  return turnLimitsForClass(turnClassKey(type));
}

/** A turn (minutes) stepped and clamped to a class's limits; null if unusable. */
export function clampTurnForClass(key, minutes) {
  const m = Number(minutes);
  if (minutes == null || minutes === '' || !Number.isFinite(m)) return null;
  const { min, max } = turnLimitsForClass(key);
  return Math.max(min, Math.min(max, step(m)));
}

const CLASS_KEYS = new Set(TURN_CLASSES.map(c => c.key));

/**
 * A stored turnTimes object, cleaned: { byClass: { key: minutes } } with only
 * known classes, stepped and clamped, standard values dropped. Returns null
 * when nothing differs from standard (so the state key can be left off).
 */
export function cleanTurnTimes(tt) {
  const src = tt?.byClass;
  if (!src || typeof src !== 'object') return null;
  const byClass = {};
  for (const [k, v] of Object.entries(src)) {
    if (!CLASS_KEYS.has(k)) continue;
    const m = clampTurnForClass(k, v);
    if (m == null || m === turnLimitsForClass(k).std) continue;
    byClass[k] = m;
  }
  return Object.keys(byClass).length ? { byClass } : null;
}

// ── This game's settings (module state, like the demand model) ────────────────
// Set at the reducer's door, by the tick, and in workers — the same places
// setDemandModel is — so every block-hour reading in the app uses this game's
// turns. AI rivals never read it: their sizing has its own turn (rivalTurnScale).
let _byClass = null;

/** Install a game's turnTimes (state.turnTimes). Idempotent and cheap. */
export function setPlayerTurnTimes(tt) {
  const next = tt?.byClass && Object.keys(tt.byClass).length ? tt.byClass : null;
  _byClass = next;
}

/** The live class table (or null): an identity a memo can key on. */
export function playerTurnTable() { return _byClass; }

/** The route's own override (minutes), or null. Charters are never overridden. */
export function routeTurnOverride(route) {
  if (!route || route.charter) return null;
  const v = route.schedule?.turnMin;
  return v == null ? null : Number(v);
}

/** Pass as `src` for the standard turn whatever the player has set (rivals,
 *  reference operators). */
export const STANDARD_TURN = Object.freeze({ standardTurn: true });

/**
 * Turn (hours) a player's aircraft of `type` takes on `src`:
 *   · a number  → that many MINUTES, as given (callers asking for a fixed turn);
 *   · a route   → its override, else the class setting, else standard;
 *   · STANDARD_TURN → the standard table value;
 *   · nothing   → the class setting, else standard.
 * Untouched settings return the standard table value exactly.
 */
export function turnHoursFor(type, src = null, byClass = _byClass) {
  if (typeof src === 'number') return Math.max(0, src) / 60;
  if (src === STANDARD_TURN) return standardTurnHours(type);
  const key = turnClassKey(type);
  const ov = routeTurnOverride(src);
  if (ov != null && Number.isFinite(ov)) {
    const m = clampTurnForClass(key, ov);
    if (m != null) return m / 60;
  }
  const cls = byClass?.[key];
  if (cls != null) {
    const m = clampTurnForClass(key, cls);
    if (m != null) return m / 60;
  }
  return standardTurnHours(type);
}

/** Turn in whole minutes (display / timetable). */
export function turnMinutesFor(type, src = null, byClass = _byClass) {
  return Math.round(turnHoursFor(type, src, byClass) * 60);
}

/**
 * Where a turn sits in its class's range: −1 at the floor, 0 at standard,
 * +1 at the ceiling.
 */
export function turnDeviation(type, minutes) {
  const { min, std, max } = turnLimits(type);
  const m = Number(minutes);
  if (!Number.isFinite(m) || m === std) return 0;
  if (m < std) return std > min ? Math.max(-1, (m - std) / (std - min)) : 0;
  return max > std ? Math.min(1, (m - std) / (max - std)) : 0;
}

// ── Effects ──────────────────────────────────────────────────────────────────
/** On-time rate at a fleet flown entirely at the floor / ceiling. */
export const TURN_OTP_SHORT = 0.08;
export const TURN_OTP_LONG  = 0.04;
/** Ground-staff morale-target change at the floor / ceiling (cabin crew a third). */
export const TURN_MORALE_SHORT = 12;
export const TURN_MORALE_LONG  = 6;
export const TURN_CABIN_SHARE  = 1 / 3;
/** Diminishing returns on padding. */
const LONG_EXP = 0.6;

/**
 * Effects of a fleet's turn mix. `short` and `long` are block-hour-weighted
 * shares in [0, 1] (see fleetTurnMix in utils/simulation.js): the average of
 * max(0, −d) and of max(0, d) over every flying hour.
 */
export function turnEffects({ short = 0, long = 0 } = {}) {
  const s = Math.max(0, Math.min(1, Number(short) || 0));
  const l = Math.max(0, Math.min(1, Number(long) || 0));
  const lp = l > 0 ? Math.pow(l, LONG_EXP) : 0;
  const ground = -TURN_MORALE_SHORT * s + TURN_MORALE_LONG * lp;
  return {
    otpDelta: -TURN_OTP_SHORT * s + TURN_OTP_LONG * lp,
    moraleLift: { groundStaff: ground, cabinCrew: ground * TURN_CABIN_SHARE },
  };
}

// ── AI rivals ────────────────────────────────────────────────────────────────
/** Budget carriers run quick turns; others the standard. A multiplier on the
 *  rivals' own turn allowance (models/demand.js tailsForRoute).
 *
 *  1 in Headwinds: there are no AI rivals here — every rival is a real
 *  airline (or a bot playing as one) with its own turn-time settings — so the
 *  solo rivals' quick turns (0.8 in Tailwinds) stay off and the engine's
 *  golden master is unchanged. */
export const RIVAL_BUDGET_TURN_SCALE = 1;
export function rivalTurnScale(tier) {
  return tier === 'budget' ? RIVAL_BUDGET_TURN_SCALE : 1;
}
