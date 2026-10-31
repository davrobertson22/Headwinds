// loyaltyPools.js — contested frequent-flyer pools (loyalty v2, new worlds only).
// ----------------------------------------------------------------------------
// Design: claude/loyalty-rework-design.md (Headwinds project), as decided with
// Dave on 2026-10-30: zero-sum, an annual status year, elites who care about
// reliability, travel partners as places to earn. No co-brand card.
//
// Two sentences for players: frequent flyers in every city join the best
// program there. Make yours worth joining, fly them reliably, and don't cut it
// once they have — every December your elites requalify.
//
// The model, in the order the weekly tick runs it:
//
//   POOLS    Every city (a metro, or a lone airport) holds a fixed stock of
//            frequent flyers, F = residents × LP_FF_PER_RESIDENT. It comes from
//            the city, not from anyone's traffic, so no carrier can shrink a
//            rival's denominator by cutting capacity.
//   TARGET   Each carrier with a program and seats in the city pulls on the
//            pool with weight  coverage × e^(β·value), where coverage is its
//            weekly departing seats ÷ F (capped). The "no program" option pulls
//            with e^(β·v₀). Target members = F × weight ÷ Σ weights. So a lone
//            carrier with a thin program enrols a minority, and two carriers
//            split what both together are worth.
//   DRIFT    Members move LP_DRIFT of the way to target each week (members are
//            people; they re-sort over months, not days). After a devaluation,
//            or the January after a requalification, the city is "shopping" and
//            the drift runs faster.
//   ELITES   A slice of members holds status. It builds with maturity, leaves
//            fast when the flying is unreliable, and requalifies every December
//            against the service the airline kept up through the year.
//   EFFECT   On a pair, the airline's standing L = (W_o + W_d) ÷ (F_o + F_d),
//            W = members + LP_ELITE_EXTRA × elites. It enters the demand model
//            ONLY as a share term between carriers (offer.loyaltyAppeal in
//            computeUtility) and a price shield inside that same softmax
//            (offer.loyaltySensReduction). Neither reaches the monopoly pool,
//            the solo ceiling or brand capture: loyalty decides who people fly
//            with, never whether they fly. On a pair nobody contests it does
//            nothing at all.
//
// Pure module: data imports only, no simulation.js (that imports us).

import { getAirport } from '../data/airports.js';
import { metroOf, metroById } from '../data/metros.js';
import { isLoungeOpen, normalizeLoungePolicy } from '../data/lounges.js';
import { ANCILLARY_MAP, isAncillariesActive, resolveItem } from '../data/ancillaries.js';
import { TRAVEL_PARTNER_MAP, TP_TYPES, travelPartnerCovers, travelLiftScale } from '../data/travelPartners.js';

export const LOYALTY_POOLS_VERSION = 1;

/** Stamped on airlines in worlds created with tickConfig.loyaltyPools. */
export const isLoyaltyPoolsWorld = (state) => state?.loyaltyPoolsWorld === true;

// ── The dial ──────────────────────────────────────────────────────────────────
/** Generosity: the share of fare members get back as points. 0 = no program. */
export const LP_GEN_MIN     = 0.03;
export const LP_GEN_MAX     = 0.12;
export const LP_GEN_DEFAULT = 0.06;
export const LP_GEN_STEP    = 0.005;

export function normalizeGenerosity(g) {
  const v = Number(g);
  if (!Number.isFinite(v) || v <= 0) return 0;
  const clamped = Math.min(LP_GEN_MAX, Math.max(LP_GEN_MIN, v));
  return Math.round(clamped / LP_GEN_STEP) * LP_GEN_STEP;
}

export const loyaltyProgramOn = (loyalty) => (loyalty?.generosity ?? 0) > 0;

// ── Pools ─────────────────────────────────────────────────────────────────────
/** Share of a city's residents who fly often enough to hold a card that matters. */
export const LP_FF_PER_RESIDENT = 0.08;
export const LP_POOL_FLOOR      = 2_000;

/** The pool an airport belongs to: its metro, or the airport itself. */
export function loyaltyPoolOf(code) {
  return metroOf(code)?.id ?? code;
}

/** Airport codes in a pool. */
export function loyaltyPoolCodes(poolId) {
  const m = metroById(poolId);
  return m?._presentMembers ?? [poolId];
}

/** The airport a pool is drawn at on the map: the metro's primary, or itself. */
export function loyaltyPoolAnchor(poolId) {
  return metroById(poolId)?.primary ?? poolId;
}

/** Display name for a pool. */
export function loyaltyPoolName(poolId) {
  const m = metroById(poolId);
  if (m) return m.name ?? getAirport(m.primary)?.city ?? poolId;
  return getAirport(poolId)?.city ?? poolId;
}

const POOL_SIZE_MEMO = new Map();
/** Frequent flyers living in the pool's city. */
export function loyaltyPoolSize(poolId) {
  let f = POOL_SIZE_MEMO.get(poolId);
  if (f == null) {
    let pop = 0;
    for (const code of loyaltyPoolCodes(poolId)) {
      const ap = getAirport(code);
      pop = Math.max(pop, ap?.effectivePop ?? ap?.population ?? 0);
    }
    f = Math.max(LP_POOL_FLOOR, Math.round(pop * 1e6 * LP_FF_PER_RESIDENT));
    POOL_SIZE_MEMO.set(poolId, f);
  }
  return f;
}

// ── Program value (what makes a program worth joining in a city) ──────────────
export const LP_VALUE = {
  generosity: 0.35,   // at LP_GEN_MAX
  lounge:     0.15,   // an open lounge in the city that admits members
  bags:       0.10,   // checked bag included
  premium:    0.10,   // at LP_PREMIUM_FULL premium seats across the flying fleet
  alliance:   0.10,   // member of an alliance (more places to earn and burn)
  network:    0.10,   // at LP_NETWORK_FULL destinations from the city
  partners:   0.10,   // cap, travel partners working in the city
  reliableUp:   0.05, // on-time ≥ 85%
  reliableDown: 0.10, // on-time ≤ 65% (taken off)
};
export const LP_PREMIUM_FULL = 0.12;
export const LP_NETWORK_FULL = 15;
export const LP_PARTNER_VALUE = { hotel: 0.06, rideshare: 0.06, cruise: 0.03, tours: 0.03 };

/** Is a checked bag included in the fare? (No à la carte policy = bundled fares.) */
export function bagsIncluded(ancillaries) {
  if (!isAncillariesActive(ancillaries)) return true;
  const p = ANCILLARY_MAP.bags;
  if (!p) return true;
  const { offered, price } = resolveItem(p, ancillaries);
  return !offered || !(price > 0);
}

/** On-time → value adjustment: +0.05 at 85%+, 0 at 75%, −0.10 at 65% or worse. */
export function reliabilityValue(onTime) {
  if (!Number.isFinite(onTime)) return 0;
  const x = (onTime - 0.75) / 0.10;
  return x >= 0 ? Math.min(0.5, x) * LP_VALUE.reliableUp * 2 : Math.max(-1, x) * LP_VALUE.reliableDown;
}

/**
 * Value of the airline's program in one city, as a checklist. Every input is
 * something the airline already is; only `generosity` is a loyalty setting.
 *
 * ctx: { generosity, lounges, loungePolicy, ancillaries, premiumShare,
 *        allianceMember, destinations: {[poolId]: n}, travelPartners, onTime }
 * @returns {{ value: number, parts: Array<{id, label, got, max, ok}> }}
 */
export function programValueParts(ctx, poolId) {
  const parts = [];
  const g = ctx.generosity ?? 0;
  const genFrac = g > 0 ? Math.min(1, Math.max(0, (g - LP_GEN_MIN) / (LP_GEN_MAX - LP_GEN_MIN))) : 0;
  parts.push({ id: 'generosity', got: genFrac * LP_VALUE.generosity, max: LP_VALUE.generosity, ok: genFrac >= 0.5 });

  const policy = normalizeLoungePolicy(ctx.loungePolicy ?? null);
  const codes = loyaltyPoolCodes(poolId);
  const loungeHere = codes.some(c => isLoungeOpen(ctx.lounges?.[c]));
  const loungeGot = loungeHere && policy.loyaltyAccess ? LP_VALUE.lounge : 0;
  parts.push({ id: 'lounge', got: loungeGot, max: LP_VALUE.lounge, ok: loungeGot > 0,
    note: loungeHere && !policy.loyaltyAccess ? 'members not admitted' : null });

  const bags = bagsIncluded(ctx.ancillaries ?? null);
  parts.push({ id: 'bags', got: bags ? LP_VALUE.bags : 0, max: LP_VALUE.bags, ok: bags });

  const prem = Math.min(1, Math.max(0, (ctx.premiumShare ?? 0) / LP_PREMIUM_FULL));
  parts.push({ id: 'premium', got: prem * LP_VALUE.premium, max: LP_VALUE.premium, ok: prem >= 0.99 });

  const all = !!ctx.allianceMember;
  parts.push({ id: 'alliance', got: all ? LP_VALUE.alliance : 0, max: LP_VALUE.alliance, ok: all });

  const dests = ctx.destinations?.[poolId] ?? 0;
  const net = Math.min(1, dests / LP_NETWORK_FULL);
  parts.push({ id: 'network', got: net * LP_VALUE.network, max: LP_VALUE.network, ok: net >= 0.99, n: dests });

  let partners = 0;
  const names = [];
  for (const c of Object.values(ctx.travelPartners ?? {})) {
    const p = TRAVEL_PARTNER_MAP[c?.partnerId];
    if (!p || !codes.some(code => travelPartnerCovers(p, code))) continue;
    const v = (LP_PARTNER_VALUE[p.type] ?? 0) * travelLiftScale(c.happiness);
    if (v > 0) { partners += v; names.push(p.name ?? p.id); }
  }
  partners = Math.min(LP_VALUE.partners, partners);
  parts.push({ id: 'partners', got: partners, max: LP_VALUE.partners, ok: partners > 0, names });

  const rel = reliabilityValue(ctx.onTime);
  parts.push({ id: 'reliability', got: rel, max: LP_VALUE.reliableUp, ok: rel >= 0, onTime: ctx.onTime ?? null });

  const value = Math.max(0, Math.min(1, parts.reduce((s, p) => s + p.got, 0)));
  return { value, parts };
}

export const programValue = (ctx, poolId) => programValueParts(ctx, poolId).value;

// ── Target share ──────────────────────────────────────────────────────────────
export const LP_BETA         = 2.5;
export const LP_NONE_VALUE   = 0.35;
export const LP_COVERAGE_CAP = 1.5;

/** One carrier's pull on a pool. 0 without seats or a program. */
export function loyaltyPoolWeight(seats, poolSize, value) {
  if (!(seats > 0) || !(poolSize > 0)) return 0;
  const cov = Math.min(LP_COVERAGE_CAP, seats / poolSize);
  return cov * Math.exp(LP_BETA * Math.max(0, Math.min(1, value ?? 0)));
}

export const LP_NONE_WEIGHT = Math.exp(LP_BETA * LP_NONE_VALUE);

/** Share of the pool this carrier is heading for. */
export function loyaltyTargetShare(myWeight, rivalWeight = 0) {
  if (!(myWeight > 0)) return 0;
  return myWeight / (LP_NONE_WEIGHT + myWeight + Math.max(0, rivalWeight));
}

// ── Members, elites and the status year ───────────────────────────────────────
export const LP_DRIFT          = 0.04;   // weekly share of the gap to target
export const LP_SHOP_DRIFT     = 0.10;   // while a city is shopping around
export const LP_LAPSE_OFF      = 0.06;   // program switched off
export const LP_ELITE_FRAC_MIN = 0.04;   // elite share of members, new program
export const LP_ELITE_FRAC_MAX = 0.15;   // … fully mature
export const LP_ELITE_BUILD    = 0.03;   // weekly, toward the elite share
export const LP_ELITE_FALL     = 0.15;   // weekly, when members shrink under them
export const LP_ELITE_EXTRA    = 2;      // an elite counts 3× in standing
export const LP_SEAT_EMA       = 1 - Math.pow(0.5, 1 / 26);
export const LP_ONTIME_EMA     = 1 - Math.pow(0.5, 1 / 13);
export const LP_RELIABLE_AT    = 0.80;   // below this, elites start to leave
export const LP_ELITE_DEFECT   = 0.02;   // weekly per 10 points under LP_RELIABLE_AT
export const LP_REQUAL_CHURN   = 0.10;   // elites who'd drop a tier anyway
export const LP_SHOP_WEEKS     = 12;     // after requalification
export const LP_DEVALUE_SHOP_WEEKS = 8;
export const LP_DEVALUE_K      = 3;      // members lost per point of generosity cut
export const LP_DEVALUE_ELITE_K = 4.5;
export const LP_DEVALUE_REP_WEEKS = 12;
export const LP_PROMO_GRACE_WEEKS = 4;
export const LP_REQUAL_WEEK    = 52;     // the tick that plays the year's last week
export const LP_MATURITY_WEEKS = 80;
export const LP_MATURITY_DECAY = 1 / 20;

export const eliteFraction = (maturity) =>
  LP_ELITE_FRAC_MIN + (LP_ELITE_FRAC_MAX - LP_ELITE_FRAC_MIN) * Math.min(1, Math.max(0, maturity ?? 0));

/** Requalification pass rate in a city: service kept up × reliability. */
export function requalPassRate(seatsNow, seatEma, onTimeEma) {
  const service = seatEma > 0 ? Math.min(1, Math.max(0, seatsNow / seatEma)) : 0;
  const ot = Number.isFinite(onTimeEma) ? onTimeEma : LP_RELIABLE_AT;
  const reliability = Math.min(1, Math.max(0.7, 0.7 + 0.3 * (ot - 0.65) / 0.25));
  return { service, reliability, pass: service * reliability * (1 - LP_REQUAL_CHURN) };
}

/** Weekly share of elites who give up on an unreliable airline. */
export function eliteDefectionRate(onTime) {
  if (!Number.isFinite(onTime) || onTime >= LP_RELIABLE_AT) return 0;
  return Math.min(0.10, LP_ELITE_DEFECT * (LP_RELIABLE_AT - onTime) / 0.10);
}

// Pool entry, compact (lives in every save): [members, elites, seatEma, shopUntilAbsWeek]
const P_M = 0, P_E = 1, P_EMA = 2, P_SHOP = 3;

export function poolEntry(pools, poolId) {
  const p = pools?.[poolId];
  return { members: p?.[P_M] ?? 0, elites: p?.[P_E] ?? 0, seatEma: p?.[P_EMA] ?? 0, shopUntil: p?.[P_SHOP] ?? 0 };
}

/**
 * One week of the member stock. Pure.
 *
 * @param {object} prev   loyalty.pools
 * @param {object} ctx
 *   on            program running
 *   maturity      program maturity (before this week's step)
 *   seats         { [poolId]: departing seats this week }
 *   values        { [poolId]: program value }
 *   rivals        { [poolId]: Σ rival pull }
 *   onTime        this week's on-time rate
 *   onTimeEma     smoothed on-time (for requalification)
 *   requal        run the December requalification this week
 *   devaluation   { cut } generosity points cut (fraction, e.g. 0.02), or null
 *   absWeek       current absolute week
 * @returns {{ pools, members, elites, requal: object|null, defected: number, joined: number }}
 */
export function advanceLoyaltyPools(prev, ctx) {
  const out = {};
  const ids = new Set([...Object.keys(prev ?? {}), ...Object.keys(ctx.seats ?? {})]);
  const efrac = eliteFraction(ctx.maturity);
  const defect = eliteDefectionRate(ctx.onTime);
  const cut = Math.max(0, ctx.devaluation?.cut ?? 0);
  let members = 0, elites = 0, defected = 0, joined = 0;
  const rq = ctx.requal ? { kept: 0, dropped: 0, left: 0, cities: [] } : null;

  for (const id of ids) {
    const F = loyaltyPoolSize(id);
    let { members: m, elites: e, seatEma: ema, shopUntil } = poolEntry(prev, id);
    const m0 = m;
    const seats = ctx.seats?.[id] ?? 0;
    ema = ema > 0 ? ema + LP_SEAT_EMA * (seats - ema) : seats;

    if (ctx.on) {
      const w = loyaltyPoolWeight(seats, F, ctx.values?.[id] ?? 0);
      const target = F * loyaltyTargetShare(w, ctx.rivals?.[id] ?? 0);
      const rate = shopUntil > (ctx.absWeek ?? 0) ? LP_SHOP_DRIFT : LP_DRIFT;
      m += rate * (target - m);
      const eTarget = m * efrac;
      e += (e < eTarget ? LP_ELITE_BUILD : LP_ELITE_FALL) * (eTarget - e);
    } else {
      m *= 1 - LP_LAPSE_OFF;
      e *= 1 - LP_ELITE_FALL;
    }

    // Unreliable flying: elites leave first, ordinary members a quarter as fast.
    if (defect > 0 && m > 0) {
      const lostE = e * defect;
      const lostM = Math.max(0, m - e) * defect / 4;
      e -= lostE; m -= lostE + lostM; defected += lostE + lostM;
    }

    // A devaluation lands on every city at once, and sets them all shopping.
    if (cut > 0 && m > 0) {
      const lostM = m * Math.min(0.5, LP_DEVALUE_K * cut);
      e *= 1 - Math.min(0.7, LP_DEVALUE_ELITE_K * cut);
      m -= lostM; defected += lostM;
      shopUntil = Math.max(shopUntil, (ctx.absWeek ?? 0) + LP_DEVALUE_SHOP_WEEKS);
    }

    // December: elites requalify against the service kept up through the year.
    if (rq && e > 0) {
      const { service, pass } = requalPassRate(seats, ema, ctx.onTimeEma);
      const keep = e * pass;
      const dropped = e - keep;
      const left = dropped * (1 - service);      // their routes went away: gone
      rq.kept += keep; rq.dropped += dropped - left; rq.left += left;
      if (dropped >= 1) rq.cities.push({ pool: id, kept: Math.round(keep), dropped: Math.round(dropped - left), left: Math.round(left), service: +service.toFixed(3) });
      m -= left; e = keep; defected += left;
      shopUntil = Math.max(shopUntil, (ctx.absWeek ?? 0) + LP_SHOP_WEEKS);
    }

    m = Math.max(0, m); e = Math.max(0, Math.min(e, m));
    if (m - m0 > 0) joined += m - m0;
    if (m < 1 && seats <= 0) continue;       // nothing left to remember
    const entry = [Math.round(m), Math.round(e), Math.round(ema)];
    if (shopUntil > (ctx.absWeek ?? 0)) entry.push(shopUntil);
    out[id] = entry;
    members += entry[P_M]; elites += entry[P_E];
  }
  if (rq) {
    rq.kept = Math.round(rq.kept); rq.dropped = Math.round(rq.dropped); rq.left = Math.round(rq.left);
    rq.cities.sort((a, b) => (b.dropped + b.left) - (a.dropped + a.left));
    rq.cities = rq.cities.slice(0, 8);
  }
  return { pools: out, members, elites, requal: rq, defected: Math.round(defected), joined: Math.round(joined) };
}

// ── Standing and the demand-model fields ──────────────────────────────────────
export const LP_APPEAL_K   = 1.0;
export const LP_APPEAL_CAP = 0.5;
export const LP_SENS_K     = 0.35;
export const LP_SENS_CAP   = 0.15;

export const loyaltyMatFactor = (maturity) => 0.25 + 0.75 * Math.min(1, Math.max(0, maturity ?? 0));

/** [weighted members W, pool size F] for an airport's pool. */
export function poolStanding(pools, code) {
  const id = loyaltyPoolOf(code);
  const { members, elites } = poolEntry(pools, id);
  return [members + LP_ELITE_EXTRA * elites, loyaltyPoolSize(id)];
}

/** Standing in one city, 0–1. */
export function cityStanding(pools, code) {
  const [W, F] = poolStanding(pools, code);
  return F > 0 ? Math.min(1, W / F) : 0;
}

/** Pool-weighted standing on a pair, 0–1. */
export function pairStandingFrom(standO, standD) {
  const [Wo, Fo] = standO, [Wd, Fd] = standD;
  if (!(Fo + Fd > 0)) return 0;
  return Math.min(1, (Wo + Wd) / (Fo + Fd));
}

export function pairLoyaltyStanding(pools, origin, destination) {
  const po = loyaltyPoolOf(origin), pd = loyaltyPoolOf(destination);
  if (po === pd) return cityStanding(pools, origin);
  return pairStandingFrom(poolStanding(pools, origin), poolStanding(pools, destination));
}

/** Standing → the two offer fields. {} when there is nothing to carry. */
export function loyaltyOfferFields(L, maturity) {
  if (!(L > 0)) return {};
  const x = L * loyaltyMatFactor(maturity);
  const appeal = 1 + Math.min(LP_APPEAL_CAP, LP_APPEAL_K * x);
  const sens = Math.min(LP_SENS_CAP, LP_SENS_K * x);
  return { loyaltyAppeal: +appeal.toFixed(4), loyaltySensReduction: +sens.toFixed(4) };
}

/**
 * The fields for a pair, straight from a loyalty object. THE single
 * implementation: weeklyTick (via stateLoyaltyFields), the pair-share
 * previews, RouteDetail and the server's rival specs all come through here.
 */
export function loyaltyFieldsFromLoyalty(loyalty, origin, destination) {
  if (!loyalty?.pools || !((loyalty.members ?? 0) > 0)) return {};
  return loyaltyOfferFields(pairLoyaltyStanding(loyalty.pools, origin, destination), loyalty.maturity ?? 0);
}

/** Per-stop standings for a tag route, so each segment resolves its own pair. */
export function loyaltyStandingAt(loyalty, stops) {
  if (!loyalty?.pools || !((loyalty.members ?? 0) > 0) || !stops?.length) return null;
  const at = {};
  for (const c of new Set(stops)) at[c] = poolStanding(loyalty.pools, c);
  return { at, maturity: loyalty.maturity ?? 0 };
}

export function loyaltyFieldsForSegment(standingAt, from, to) {
  if (!standingAt?.at?.[from] || !standingAt.at[to]) return {};
  const L = loyaltyPoolOf(from) === loyaltyPoolOf(to)
    ? Math.min(1, standingAt.at[from][0] / Math.max(1, standingAt.at[from][1]))
    : pairStandingFrom(standingAt.at[from], standingAt.at[to]);
  return loyaltyOfferFields(L, standingAt.maturity);
}

// ── Money ─────────────────────────────────────────────────────────────────────
export const LP_REDEEM_RATE      = 0.035;
export const LP_ADMIN_PER_MEMBER = 0.30;   // $/member/week at 2020s costs

/** Points that expire unused: 25% for a new program, 10% for a mature one. */
export const loyaltyBreakage = (maturity) => 0.25 - 0.15 * Math.min(1, Math.max(0, maturity ?? 0));

/**
 * Weekly points and admin. Members earn `generosity` of the fare on the share
 * of revenue they fly (memberShare = loyaltyPenetration). Raising generosity
 * never reprices the outstanding liability; neither does cutting it.
 */
export function loyaltyPoolFlows({ liability = 0, revenue = 0, memberShare = 0, generosity = 0, maturity = 0, members = 0, costScale = 1 }) {
  const lia     = Math.max(0, liability);
  const earned  = Math.round(Math.max(0, revenue) * Math.max(0, memberShare) * Math.max(0, generosity));
  const drawn   = Math.round(lia * LP_REDEEM_RATE);
  const expired = Math.round(drawn * loyaltyBreakage(maturity));
  const redeemedCost = drawn - expired;
  const admin   = Math.round(Math.max(0, members) * LP_ADMIN_PER_MEMBER * (costScale || 1));
  return { earned, redeemedCost, expired, admin, newLiability: Math.max(0, lia + earned - drawn) };
}

// ── Devaluation ───────────────────────────────────────────────────────────────
/**
 * What setting generosity from `prev` to `next` costs. Raising is free; a cut
 * back inside the promo window (to no lower than where the promo started) is
 * free too. Everything else is a devaluation of `cut` points of fare.
 */
export function generosityChange(loyalty, next, absWeek) {
  const prev = loyalty?.generosity ?? 0;
  if (!(next < prev) || !(prev > 0)) return { cut: 0, promo: next > prev && prev > 0 };
  if (next <= 0) return { cut: 0, off: true };
  const promo = loyalty?.promo;
  if (promo && (promo.until ?? 0) >= absWeek && next >= (promo.from ?? prev)) return { cut: 0, graced: true };
  const floor = promo && (promo.until ?? 0) >= absWeek ? Math.min(prev, promo.from ?? prev) : prev;
  return { cut: +Math.max(0, floor - next).toFixed(4) };
}

/** Reputation hit while a devaluation is remembered (negative points). */
export function devaluationRepPenalty(loyalty, absWeek) {
  const d = loyalty?.devaluation;
  if (!d || !((d.until ?? 0) > absWeek)) return 0;
  return -Math.round((2 + 4 * Math.min(1, d.maturity ?? 0)) * Math.min(1, (d.cut ?? 0) / 0.02));
}

// ── Status match ──────────────────────────────────────────────────────────────
// When a rival devalues, its members are angry and shopping. For a few weeks
// any airline flying the same cities may STATUS-MATCH: honour those members'
// status on its own program, at a real cost (lounge guests, upgrade seats,
// service desk), and take half of the rival's walk-outs at once. After that the
// ordinary drift decides whether they stay — a match buys tempo, not a city.
export const LP_MATCH_WINDOW_WEEKS   = 3;     // after the rival's cut
export const LP_MATCH_CAPTURE        = 0.5;   // of the rival's walk-outs, per city
export const LP_MATCH_COST_PER_MEMBER = 40;   // × (1 + your value there), 2020s $
export const LP_MATCH_MEMORY_WEEKS   = 26;

/** A rival's devaluation as other airlines see it, or null once it is old news. */
export function devaluationNotice(loyalty, absWeek) {
  const d = loyalty?.devaluation;
  if (!d || !((d.cut ?? 0) > 0) || !Number.isFinite(d.absWeek)) return null;
  if (absWeek - d.absWeek > LP_MATCH_WINDOW_WEEKS) return null;
  return { cut: d.cut, absWeek: d.absWeek };
}

/**
 * The match on offer against one rival, or null.
 *   rival   { id, name, devaluation: {cut, absWeek}, pools: {pool: [seats, v‰, members, elites]} }
 *   mine    { on, seats: {pool: n}, values: {pool: v}, matched: {rivalId: absWeek}, absWeek, costScale }
 */
export function statusMatchOffer(rival, mine) {
  const dev = rival?.devaluation;
  if (!mine?.on || !dev || !((dev.cut ?? 0) > 0)) return null;
  if ((mine.absWeek ?? 0) - dev.absWeek > LP_MATCH_WINDOW_WEEKS) return null;
  if ((mine.matched?.[rival.id] ?? -Infinity) >= dev.absWeek) return null;   // already matched this one
  const walkout = Math.min(0.5, LP_DEVALUE_K * dev.cut) * LP_MATCH_CAPTURE;
  const cities = [];
  let members = 0, cost = 0;
  for (const [pool, row] of Object.entries(rival.pools ?? {})) {
    if (!((mine.seats?.[pool] ?? 0) > 0)) continue;
    const n = Math.round((row?.[2] ?? 0) * walkout);
    if (n < 1) continue;
    const c = n * LP_MATCH_COST_PER_MEMBER * (1 + (mine.values?.[pool] ?? 0)) * (mine.costScale || 1);
    cities.push({ pool, members: n, cost: Math.round(c) });
    members += n; cost += c;
  }
  if (!cities.length) return null;
  cities.sort((a, b) => b.members - a.members);
  return {
    rivalId: rival.id, name: rival.name ?? 'A rival', cut: dev.cut, devaluedAbsWeek: dev.absWeek,
    until: dev.absWeek + LP_MATCH_WINDOW_WEEKS, cities, members, cost: Math.round(cost),
  };
}

/**
 * Add a paid match's members to the pools. Pure. They join as ordinary members
 * (their old status is honoured, not your elite count) and from then on drift
 * like everyone else — toward your target in their city, which is the test of
 * whether your program is actually the better one there. Matching does NOT set
 * your own members shopping.
 */
export function applyStatusMatch(pools, match) {
  if (!match?.cities?.length) return pools ?? {};
  const out = { ...(pools ?? {}) };
  for (const { pool, members } of match.cities) {
    const row = [...(out[pool] ?? [0, 0, 0])];
    row[0] = (row[0] ?? 0) + members;
    out[pool] = row;
  }
  return out;
}
