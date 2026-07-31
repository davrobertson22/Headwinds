/**
 * mroBase.js — Jet bases (owned maintenance infrastructure).
 *
 * A jet base is a hangar an airline builds at a specific airport, certified for
 * specific aircraft FAMILIES. It is the spatial half of the maintenance system:
 * where line maintenance, unscheduled AOG repairs and heavy C/D checks actually
 * happen, and how much they cost when they do.
 *
 * Three levels, each a superset of the one below:
 *
 *   1  Line Station     — line maintenance and AOG cover
 *   2  Maintenance Base — the above plus C checks in-house
 *   3  Heavy MRO        — the above plus D checks, and capacity worth selling
 *
 * A base helps an aircraft when ALL of the following hold:
 *   (a) the base is certified for that aircraft's family,
 *   (b) the aircraft's network touches the base's airport,
 *   (c) a shop slot is free that week (own aircraft take priority over guests).
 *
 * Where the money goes:
 *   - Capex up front, weekly opex forever, plus a parts-pool carrying cost.
 *   - Against that: cheaper/faster checks and AOG repairs, a small line-
 *     maintenance discount, and — the big one — most of the family's outsourced
 *     MRO contract (data/families.js `weeklyBaseCost`) is offset, because you
 *     are now doing that work yourself.
 *
 * Gates at the airport are CONSUMED by the hangar: a gate holding a maintenance
 * base is not available for flying. At a congested airport that is a real trade.
 *
 * Every value here is a tuning constant — this is the single place to rebalance
 * the system. All functions are PURE (no Date.now / Math.random) so the reducer
 * and the multiplayer tick stay deterministic and replayable.
 */

import { aircraftFamily, FAMILY_INFO } from './families.js';

// ─── Level definitions ───────────────────────────────────────────────────────

export const MRO_LEVELS = {
  1: {
    level: 1,
    name: 'Line Station',
    blurb: 'Mechanics, tooling and a parts locker on the ramp. Fixes what breaks; cannot open an airframe.',
    capex: 4_000_000,
    weeklyOpex: 30_000,
    buildWeeks: 4,
    gatesRequired: 1,
    certsIncluded: 1,
    slots: 2,
    extraCertCapex: 1_500_000,
    extraCertOpex: 10_000,
    // Benefits (multipliers ≤ 1 are discounts; weeks are subtracted from downtime)
    aogCostMult: 0.70, aogWeeksSaved: 1,
    cCostMult: 1.00, cWeeksSaved: 0,
    dCostMult: 1.00, dWeeksSaved: 0,
    lineFactor: 0.98,
    contractOffset: 0.25,
  },
  2: {
    level: 2,
    name: 'Maintenance Base',
    blurb: 'A real hangar. C checks come home instead of going out to a third party.',
    capex: 25_000_000,
    weeklyOpex: 120_000,
    buildWeeks: 12,
    gatesRequired: 2,
    certsIncluded: 2,
    slots: 4,
    extraCertCapex: 4_000_000,
    extraCertOpex: 25_000,
    aogCostMult: 0.60, aogWeeksSaved: 1,
    cCostMult: 0.70, cWeeksSaved: 1,
    dCostMult: 1.00, dWeeksSaved: 0,
    lineFactor: 0.95,
    contractOffset: 0.60,
  },
  3: {
    level: 3,
    name: 'Heavy MRO',
    blurb: 'Full strip-down capability. D checks in-house, and enough capacity that alliance partners will pay to use it.',
    capex: 90_000_000,
    weeklyOpex: 350_000,
    buildWeeks: 24,
    gatesRequired: 3,
    certsIncluded: 4,
    slots: 8,
    extraCertCapex: 8_000_000,
    extraCertOpex: 40_000,
    aogCostMult: 0.55, aogWeeksSaved: 2,
    cCostMult: 0.65, cWeeksSaved: 1,
    dCostMult: 0.70, dWeeksSaved: 2,
    lineFactor: 0.90,
    contractOffset: 0.85,
  },
};

export const MRO_MAX_LEVEL = 3;

/** Hard ceiling on certifications at one base, however much you're willing to pay. */
export const MRO_MAX_CERTS_PER_BASE = 8;

/** Premium on the capex difference when upgrading an existing base in place. */
export const MRO_UPGRADE_PREMIUM = 0.15;

/** Fraction of cumulative capex refunded when a base is closed. */
export const MRO_CLOSE_REFUND = 0.25;

// ─── Efficiency ramp ─────────────────────────────────────────────────────────
// A new base opens at a fraction of its stated benefits and works up to full
// effectiveness as the team beds in. This is what stops a cash-rich airline
// buying instant immunity the week its fleet starts to wear out.

export const MRO_RAMP_WEEKS = 26;
export const MRO_RAMP_FLOOR = 0.60;

// ─── Parts pool ──────────────────────────────────────────────────────────────
// Spares inventory held at the base. Ties up cash; shortens AOG downtime.

export const PARTS_POOL_MIN = 0.5;
export const PARTS_POOL_MAX = 2.0;
export const PARTS_POOL_DEFAULT = 1.0;
/**
 * Weekly carrying cost as a fraction of base capex, per point of pool.
 * Deliberately small: at 0.4% a Heavy MRO's parts pool cost as much as the whole
 * base's opex, which made the dial the dominant cost instead of a lever.
 */
export const PARTS_POOL_WEEKLY_PCT_OF_CAPEX = 0.0015;

// ─── Alliance hosting (world-set rate — no player pricing) ───────────────────

/** Host earns this fraction of the UNDISCOUNTED job cost when a partner uses the base. */
export const ALLIANCE_HOST_FEE_PCT = 0.15;
/** A guest receives this fraction of the host's own cost discount. */
export const ALLIANCE_GUEST_DISCOUNT_FRACTION = 0.5;
/** Downtime weeks a guest saves (flat, regardless of level). */
export const ALLIANCE_GUEST_WEEKS_SAVED = 1;

// ─── Reserve synergy ─────────────────────────────────────────────────────────
/** Readiness-premium discount for a reserve stationed at one of your own bases. */
export const RESERVE_AT_BASE_READINESS_DISCOUNT = 0.10;

// ─── Level helpers ───────────────────────────────────────────────────────────

/** Definition for a level (1–3). Returns null for anything else. */
export function mroLevelDef(level) {
  return MRO_LEVELS[level] ?? null;
}

/**
 * Capex to build a brand-new base at `level`, optionally certified for more
 * families than the level includes. Extras are priced at the level's
 * `extraCertCapex` each and clamped to MRO_MAX_CERTS_PER_BASE — quoting a ninth
 * certification would charge for something the reducer will not keep.
 */
export function buildCapex(level, certCount = null) {
  const def = mroLevelDef(level);
  if (!def) return 0;
  const want  = Math.min(MRO_MAX_CERTS_PER_BASE, certCount ?? def.certsIncluded);
  const extra = Math.max(0, want - def.certsIncluded);
  return def.capex + extra * def.extraCertCapex;
}

/** Capex to upgrade an existing base from `fromLevel` to `toLevel`. */
export function upgradeCapex(fromLevel, toLevel) {
  const from = mroLevelDef(fromLevel);
  const to   = mroLevelDef(toLevel);
  if (!from || !to || to.level <= from.level) return 0;
  return Math.round((to.capex - from.capex) * (1 + MRO_UPGRADE_PREMIUM));
}

/** Cumulative capex sunk into a base, used for the close refund and pool cost. */
export function sunkCapex(base) {
  const def = mroLevelDef(base?.level);
  if (!def) return 0;
  const extra = Math.max(0, (base?.families?.length ?? 0) - def.certsIncluded);
  return def.capex + extra * def.extraCertCapex;
}

/** Refund paid out when a base is closed. */
export function closeRefund(base) {
  return Math.round(sunkCapex(base) * MRO_CLOSE_REFUND);
}

/** How many family certifications a level INCLUDES in its price. */
export function certCapacity(level) {
  return mroLevelDef(level)?.certsIncluded ?? 0;
}

// ─── Certification economics for an existing base ────────────────────────────
// A level's `certsIncluded` is an allowance, not a ceiling. Past it a base can
// still be certified for more families — up to MRO_MAX_CERTS_PER_BASE — for
// `extraCertCapex` once and `extraCertOpex` every week after. These helpers are
// what the UI needs to make that offer, which for a long time it never did: a
// base upgraded to a level with a bigger allowance had no way to spend it.

/** One-off capex to certify this base for one more family (0 while included). */
export function addCertCapex(base) {
  const def = mroLevelDef(base?.level);
  if (!def) return 0;
  return (base?.families?.length ?? 0) >= def.certsIncluded ? def.extraCertCapex : 0;
}

/** Weekly opex one more certification would add to this base (0 while included). */
export function addCertOpex(base) {
  const def = mroLevelDef(base?.level);
  if (!def) return 0;
  return (base?.families?.length ?? 0) >= def.certsIncluded ? def.extraCertOpex : 0;
}

/** Included certifications this base has not spent yet. */
export function certsIncludedLeft(base) {
  const def = mroLevelDef(base?.level);
  if (!def) return 0;
  return Math.max(0, def.certsIncluded - (base?.families?.length ?? 0));
}

/** True when this base holds as many certifications as it ever can. */
export function certsFull(base) {
  return (base?.families?.length ?? 0) >= MRO_MAX_CERTS_PER_BASE;
}

// ─── Weekly cost ─────────────────────────────────────────────────────────────

/** Weekly carrying cost of a base's parts pool. */
export function partsPoolCost(base) {
  const pool = clampPartsPool(base?.partsPool);
  return Math.round(sunkCapex(base) * PARTS_POOL_WEEKLY_PCT_OF_CAPEX * pool);
}

/** Clamp a parts-pool value into the legal band. */
export function clampPartsPool(pool) {
  const p = Number(pool);
  if (!Number.isFinite(p)) return PARTS_POOL_DEFAULT;
  return Math.max(PARTS_POOL_MIN, Math.min(PARTS_POOL_MAX, p));
}

/**
 * Total weekly cost of one base: opex + extra-certification opex + parts pool.
 * A base still under construction pays opex from day one (staff are hired and
 * trained before the doors open) but carries no parts pool.
 */
export function baseWeeklyCost(base) {
  const def = mroLevelDef(base?.level);
  if (!def) return 0;
  const extra = Math.max(0, (base?.families?.length ?? 0) - def.certsIncluded);
  const opex  = def.weeklyOpex + extra * def.extraCertOpex;
  return opex + (isBaseOpen(base) ? partsPoolCost(base) : 0);
}

/** Total weekly cost of every base an airline owns. */
export function totalBaseWeeklyCost(bases = {}) {
  let total = 0;
  for (const base of Object.values(bases ?? {})) total += baseWeeklyCost(base);
  return total;
}

/** Total gates consumed by an airline's bases at a given airport. */
export function gatesConsumedAt(bases = {}, code) {
  const base = bases?.[code];
  return base ? (mroLevelDef(base.level)?.gatesRequired ?? 0) : 0;
}

/** Total gates consumed by every base an airline owns. */
export function totalGatesConsumed(bases = {}) {
  let n = 0;
  for (const base of Object.values(bases ?? {})) n += mroLevelDef(base.level)?.gatesRequired ?? 0;
  return n;
}

// ─── State helpers ───────────────────────────────────────────────────────────

/** True once construction has finished and the base is actually working. */
export function isBaseOpen(base) {
  return !!base && (base.buildWeeksLeft ?? 0) <= 0;
}

/** True if this base is certified for the given family. */
export function baseCovers(base, familyId) {
  return !!familyId && Array.isArray(base?.families) && base.families.includes(familyId);
}

/**
 * Efficiency of a base this week: 0 while building, then ramping from
 * MRO_RAMP_FLOOR to 1.0 over MRO_RAMP_WEEKS from the week it opened.
 */
export function baseEfficiency(base, absWeek) {
  if (!isBaseOpen(base)) return 0;
  const opened = base?.openedWeek ?? absWeek;
  const weeks  = Math.max(0, (absWeek ?? 0) - opened);
  const ramp   = Math.min(1, weeks / MRO_RAMP_WEEKS);
  return MRO_RAMP_FLOOR + (1 - MRO_RAMP_FLOOR) * ramp;
}

/**
 * Scale a discount multiplier by efficiency. At eff = 1 the full discount
 * applies; at eff = 0.6 only 60% of the gap below 1.0 is realised.
 */
export function scaledMult(mult, eff) {
  return 1 - (1 - mult) * eff;
}

/** Scale a whole-week downtime saving by efficiency (rounded, never negative). */
export function scaledWeeks(weeks, eff) {
  return Math.max(0, Math.round((weeks ?? 0) * eff));
}

/** Parts-pool multiplier on AOG downtime — a deeper pool gets the jet back sooner. */
export function partsPoolDurationMult(pool) {
  return 1 / Math.sqrt(clampPartsPool(pool));
}

// ─── Network resolution ──────────────────────────────────────────────────────

/** Every airport an aircraft's routes touch (multi-stop legs included). */
export function aircraftNetworkAirports(aircraftId, routes = [], cargoRoutes = []) {
  const codes = new Set();
  for (const r of [...(routes ?? []), ...(cargoRoutes ?? [])]) {
    if (r.aircraftId !== aircraftId) continue;
    const stops = Array.isArray(r.stops) && r.stops.length >= 2 ? r.stops : [r.origin, r.destination];
    for (const c of stops) if (c) codes.add(c);
  }
  return codes;
}

/**
 * The best base available to an aircraft: highest level among open, certified
 * bases whose airport the aircraft's network touches. Ties break on efficiency,
 * so an established base beats a brand-new one of the same level.
 *
 * Returns null when nothing qualifies. Does NOT consider slot availability —
 * that is the caller's job, because slots are allocated across the whole fleet.
 */
export function resolveBaseFor(aircraft, bases = {}, routes = [], cargoRoutes = [], absWeek = 0) {
  const familyId = aircraftFamily(aircraft?.typeId);
  if (!familyId) return null;
  const network = aircraftNetworkAirports(aircraft?.id, routes, cargoRoutes);
  // A stationed reserve flies nothing, so its own base airport counts as network.
  if (aircraft?.reserveBase) network.add(aircraft.reserveBase);

  let best = null;
  for (const [code, base] of Object.entries(bases ?? {})) {
    if (!network.has(code)) continue;
    if (!isBaseOpen(base)) continue;
    if (!baseCovers(base, familyId)) continue;
    const eff = baseEfficiency(base, absWeek);
    if (!best || base.level > best.level || (base.level === best.level && eff > best.eff)) {
      best = { code, base, level: base.level, eff, def: mroLevelDef(base.level) };
    }
  }
  return best;
}

/**
 * The concrete factors an aircraft gets from a resolved base. `guest` applies
 * the reduced alliance-partner benefit. Returns the neutral set when `resolved`
 * is null, so callers can use the result unconditionally.
 */
export function mroFactorsFor(resolved, { guest = false } = {}) {
  if (!resolved?.def) {
    return {
      code: null, level: 0, eff: 0, guest: false,
      aogCostMult: 1, aogWeeksSaved: 0,
      cCostMult: 1, cWeeksSaved: 0,
      dCostMult: 1, dWeeksSaved: 0,
      lineFactor: 1, contractOffset: 0,
    };
  }
  const { def, eff, code, level } = resolved;
  const share = guest ? ALLIANCE_GUEST_DISCOUNT_FRACTION : 1;
  const disc  = (mult) => scaledMult(1 - (1 - mult) * share, eff);
  const weeks = (w) => guest ? Math.min(ALLIANCE_GUEST_WEEKS_SAVED, scaledWeeks(w, eff)) : scaledWeeks(w, eff);
  return {
    code, level, eff, guest,
    aogCostMult:   disc(def.aogCostMult),
    aogWeeksSaved: weeks(def.aogWeeksSaved),
    cCostMult:     disc(def.cCostMult),
    cWeeksSaved:   weeks(def.cWeeksSaved),
    dCostMult:     disc(def.dCostMult),
    dWeeksSaved:   weeks(def.dWeeksSaved),
    // Line maintenance and the contract offset are ownership benefits — a guest
    // gets neither; they only ever buy a single job at a time.
    lineFactor:     guest ? 1 : scaledMult(def.lineFactor, eff),
    contractOffset: guest ? 0 : def.contractOffset * eff,
  };
}

/** The hosting fee a guest owes the base's owner for one job. */
export function allianceHostFee(undiscountedCost) {
  return Math.round(Math.max(0, undiscountedCost ?? 0) * ALLIANCE_HOST_FEE_PCT);
}

// ─── Family contract offsets ─────────────────────────────────────────────────

/**
 * Best contract offset per family across all of an airline's open bases.
 * Returns { [familyId]: 0..1 } for feeding into weeklyFamilyBaseCost().
 */
export function familyContractOffsets(bases = {}, absWeek = 0) {
  const out = {};
  for (const base of Object.values(bases ?? {})) {
    if (!isBaseOpen(base)) continue;
    const def = mroLevelDef(base.level);
    if (!def) continue;
    const offset = def.contractOffset * baseEfficiency(base, absWeek);
    for (const famId of base.families ?? []) {
      if (!(famId in out) || offset > out[famId]) out[famId] = offset;
    }
  }
  return out;
}

/** Weekly saving in dollars from contract offsets, for display. */
export function contractOffsetSavings(offsets = {}, activeFamilyIds = []) {
  let saved = 0;
  for (const famId of activeFamilyIds) {
    const off = offsets?.[famId] ?? 0;
    saved += (FAMILY_INFO[famId]?.weeklyBaseCost ?? 0) * off;
  }
  return Math.round(saved);
}

// ─── Shop slots ──────────────────────────────────────────────────────────────

/** Concurrent airframes a base can hold. */
export function baseSlots(base) {
  return isBaseOpen(base) ? (mroLevelDef(base?.level)?.slots ?? 0) : 0;
}

/**
 * A fresh slot ledger for one week: { [code]: remaining }.
 * The tick decrements this as it assigns work, so an airline can never route
 * more jobs through a base than it has capacity for.
 */
export function newSlotLedger(bases = {}) {
  const ledger = {};
  for (const [code, base] of Object.entries(bases ?? {})) ledger[code] = baseSlots(base);
  return ledger;
}

/** Is a slot free at `code`? Peek only — does not consume. */
export function hasSlot(ledger, code) {
  return !!code && !!ledger && (ledger[code] ?? 0) > 0;
}

/** Hand a slot back (used when a job is costed but then can't be paid for). */
export function releaseSlot(ledger, code) {
  if (code && ledger && code in ledger) ledger[code] += 1;
}

/** Claim a slot at `code`. Returns true if one was free (and consumes it). */
export function claimSlot(ledger, code) {
  if (!code || !ledger || !(code in ledger)) return false;
  if (ledger[code] <= 0) return false;
  ledger[code] -= 1;
  return true;
}

// ─── Build / validation ──────────────────────────────────────────────────────

/**
 * Can this airline build (or upgrade to) `level` at `code`?
 * Pure and shared by the reducer (enforcement) and the UI (display), so the
 * player always sees exactly what the reducer will check.
 *
 * @param {object} snap - { bases, gates, cash, absWeek, routes, cargoRoutes }
 */
export function canBuildBase(code, level, snap = {}, certCount = null) {
  const { bases = {}, gates = {}, cash = 0 } = snap;
  const def = mroLevelDef(level);
  const reasons = [];

  if (!def) {
    return { ok: false, reasons: ['Unknown base level'], capex: 0 };
  }

  const existing = bases[code] ?? null;
  const upgrade  = !!existing;
  const capex    = upgrade ? upgradeCapex(existing.level, level) : buildCapex(level, certCount);

  if (upgrade) {
    if (!isBaseOpen(existing)) reasons.push('This base is still under construction');
    if (existing.upgradeTo) reasons.push('An upgrade is already under way here');
    if (level <= existing.level) reasons.push(`Already a ${mroLevelDef(existing.level)?.name ?? 'base'} — pick a higher level`);
  }

  // Gates the hangar needs, over and above any it already consumes here.
  const held    = gates?.[code] ?? 0;
  const already = upgrade ? (mroLevelDef(existing.level)?.gatesRequired ?? 0) : 0;
  const needed  = def.gatesRequired - already;
  if (held < def.gatesRequired) {
    reasons.push(`Needs ${def.gatesRequired} gates at ${code} (you hold ${held})`);
  }

  if (cash < capex) reasons.push(`Needs ${capex.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} in cash`);

  return { ok: reasons.length === 0, reasons, capex, gatesNeeded: Math.max(0, needed), def };
}

/**
 * Create a base record. The caller prices the certifications — the level's
 * included allowance plus any extras paid for at build time — and anything past
 * the hard MRO_MAX_CERTS_PER_BASE ceiling is dropped here as a backstop.
 */
export function makeBase(code, level, families, absWeek) {
  const def = mroLevelDef(level);
  const capped = (families ?? []).filter(Boolean).slice(0, def ? MRO_MAX_CERTS_PER_BASE : 0);
  return {
    code,
    level,
    families: capped,
    openedWeek: (absWeek ?? 0) + (def?.buildWeeks ?? 0),
    buildWeeksLeft: def?.buildWeeks ?? 0,
    partsPool: PARTS_POOL_DEFAULT,
  };
}

/**
 * Tick one week of construction on every base.
 *
 * Two kinds of build run through here: a brand-new base (buildWeeksLeft, no
 * benefits until it opens) and an in-place upgrade (upgradeWeeksLeft — the
 * EXISTING level keeps working throughout, so upgrading never takes a working
 * hangar offline). Pure; returns a new map plus what finished this week.
 */
export function tickBaseConstruction(bases = {}, absWeek = 0) {
  const out = {};
  const opened = [];
  const upgraded = [];
  for (const [code, base] of Object.entries(bases ?? {})) {
    const left = base.buildWeeksLeft ?? 0;
    if (left > 0) {
      const next = Math.max(0, left - 1);
      out[code] = { ...base, buildWeeksLeft: next, openedWeek: next === 0 ? absWeek : base.openedWeek };
      if (next === 0) opened.push({ code, level: base.level, families: base.families ?? [] });
      continue;
    }
    const upLeft = base.upgradeWeeksLeft ?? 0;
    if (upLeft > 0) {
      const next = Math.max(0, upLeft - 1);
      if (next === 0) {
        const newLevel = base.upgradeTo ?? base.level;
        out[code] = { ...base, level: newLevel, upgradeTo: null, upgradeWeeksLeft: 0 };
        upgraded.push({ code, level: newLevel });
      } else {
        out[code] = { ...base, upgradeWeeksLeft: next };
      }
      continue;
    }
    out[code] = base;
  }
  return { bases: out, opened, upgraded };
}
