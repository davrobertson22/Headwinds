/**
 * lounges.js — Airport lounges as a built, owned facility.
 *
 * Until now "lounge" meant two unrelated things in the engine, neither of which
 * you could actually build:
 *
 *   1. `LOUNGE_COST_PER_PAX` (overhead.js) charged $60 per business passenger
 *      and $110 per first passenger, every week, forever — the going rate for
 *      buying lounge access and premium ground handling from somebody else.
 *   2. The `lounge` ancillary product sold day passes to economy travellers
 *      into a lounge the airline did not own.
 *
 * This module adds the thing both of those were standing in for. A lounge is a
 * discrete facility you build at ONE airport, at an airport where you already
 * hold a gate. It costs capex, takes time to fit out, and carries a real weekly
 * running cost — staff, food and beverage, rent on the floor space — whether or
 * not anyone walks through the door.
 *
 * ── What owning one actually does ────────────────────────────────────────────
 *
 * APPEAL   Business travellers pick airlines on the ground experience as much as
 *          in the air. A lounge at an endpoint lifts this airline's weight in the
 *          BUSINESS segment only — the leisure passenger buying the cheapest fare
 *          in the market is unmoved by a lounge they cannot enter. It enters the
 *          choice model as `offer.loungeAppeal`, a multiplier carried into
 *          computeUtility as a log term (softmax share ∝ exp(utility), so log(x)
 *          multiplies this offer's weight by exactly x) AND into the monopoly
 *          path's business POOL. It must be in both or it silently vanishes on
 *          uncontested routes — and it must never be applied to revenue after the
 *          capacity cap, which is the mistake `brandReach` made for months (see
 *          the brandUtil note in demand.js).
 *
 * COST     A lounge you OWN replaces the contract you were buying. Premium
 *          ground cost at a covered endpoint falls to LOUNGE_OWNED_COST_FACTOR
 *          of the third-party rate — you still feed and staff the room, but you
 *          are no longer paying somebody else's margin on every passenger. This
 *          is the hard financial payback, and it scales with how much premium
 *          traffic you actually push through the station, which is why lounges
 *          pay at hubs and lose money at outstations.
 *
 * REVENUE  Day passes are the existing `lounge` ancillary product, now gated on
 *          coverage: you cannot sell access to a room you do not have. The price
 *          stays where it always was, on the airline-wide Ancillaries tab.
 *
 * ACCESS   Two switches. Letting your own loyalty members in free costs
 *          servicing on every guest and buys goodwill with the segment that
 *          matters. Letting alliance partners' members in costs servicing too
 *          and earns a settlement fee that does not quite cover it — what you
 *          are really buying is the reciprocal right for YOUR business
 *          travellers to use partner lounges at stations where you have no room
 *          of your own, which is where the alliance term in the appeal formula
 *          comes from.
 *
 * ── Deliberately flat ────────────────────────────────────────────────────────
 * One lounge type, one price, one effect. No tier ladder: the interesting
 * decision here is WHERE, not how big, and a tier ladder on top of the hub tier
 * ladder and the jet-base level ladder would be a third progression bar saying
 * roughly the same thing.
 *
 * ── Inactive by default ──────────────────────────────────────────────────────
 * `state.lounges` is `{}` and `state.loungePolicy` is null until the player
 * builds something. Every function here returns the neutral value (appeal 1,
 * contract factor 1, cost 0) for an empty network, so an airline that never
 * touches lounges is scored exactly as it was before this module existed.
 *
 * Pure module: no Date.now(), no Math.random(), so the reducer, the UI and the
 * golden master can all call it and agree.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── Building & running ────────────────────────────────────────────────────────

/** Capex to fit out one lounge. */
export const LOUNGE_BUILD_COST = 12_000_000;

/** Weeks of fit-out before the doors open. */
export const LOUNGE_BUILD_WEEKS = 10;

/** Weekly running cost of one open lounge — staff, F&B, rent, cleaning. */
export const LOUNGE_WEEKLY_OPEX = 85_000;

/** Fraction of capex recovered when a lounge is closed (fittings, lease exit). */
export const LOUNGE_CLOSE_REFUND = 0.20;

/** Gates you must already hold at the airport to build there. */
export const LOUNGE_GATES_REQUIRED = 1;

// ── Business appeal ───────────────────────────────────────────────────────────

/**
 * Business-segment weight added per endpoint with an OWN open lounge. Two
 * covered endpoints on a route is the full-service configuration a corporate
 * traveller notices; one is half the story.
 */
export const LOUNGE_APPEAL_PER_END = 0.14;

/**
 * How much a PARTNER's lounge is worth relative to your own, when alliance
 * access is switched on. Less than your own: the room is not branded yours, the
 * agents are not yours, and reciprocal access is usually restricted to premium
 * cabins and top tiers.
 */
export const LOUNGE_ALLIANCE_END_WEIGHT = 0.45;

/** Extra appeal per covered endpoint when your own loyalty members get in free. */
export const LOUNGE_LOYALTY_APPEAL_PER_END = 0.06;

/**
 * Ceiling on the whole multiplier. A lounge network is a strong differentiator,
 * not a licence to own the business cabin outright — price, frequency and cabin
 * product still decide most of the fight.
 */
export const LOUNGE_APPEAL_MAX = 1.35;

// ── Guests & settlements ──────────────────────────────────────────────────────

/** Marginal cost of one guest walking in: food, drink, cleaning, staffing. */
export const LOUNGE_SERVICING_COST_PER_GUEST = 22;

/** What an alliance partner settles with you for one of their members' visits. */
export const LOUNGE_ALLIANCE_SETTLEMENT_PER_GUEST = 18;

/** Share of your loyalty members passing a lounge station who actually go in. */
export const LOUNGE_LOYALTY_USE_RATE = 0.35;

/** Partner guests as a fraction of your own throughput at lounge stations. */
export const LOUNGE_ALLIANCE_GUEST_RATE = 0.04;

/**
 * Premium ground cost at an endpoint where you own the lounge, as a fraction of
 * the third-party contract rate in overhead.js. You still run the room; you have
 * stopped paying a contractor's margin per head.
 */
export const LOUNGE_OWNED_COST_FACTOR = 0.35;

// ── Access policy ─────────────────────────────────────────────────────────────

/** No lounges built, or built with nothing switched on. */
export const DEFAULT_LOUNGE_POLICY = { loyaltyAccess: false, allianceAccess: false };

/** Clean a policy from a save or a client action. Null/garbage → defaults. */
export function normalizeLoungePolicy(policy) {
  if (!policy || typeof policy !== 'object') return { ...DEFAULT_LOUNGE_POLICY };
  return {
    loyaltyAccess:  !!policy.loyaltyAccess,
    allianceAccess: !!policy.allianceAccess,
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/** Record factory. A brand-new lounge is under construction, not open. */
export function makeLounge(code, absWeek = 0) {
  return {
    code,
    openedWeek:     absWeek,
    buildWeeksLeft: LOUNGE_BUILD_WEEKS,
    capex:          LOUNGE_BUILD_COST,
  };
}

/** Open for business? A lounge still fitting out is not. */
export function isLoungeOpen(lounge) {
  return !!lounge && !(lounge.buildWeeksLeft > 0);
}

/** Every open lounge in the network, as an array of codes. */
export function openLoungeCodes(lounges = {}) {
  return Object.keys(lounges ?? {}).filter(code => isLoungeOpen(lounges[code]));
}

/** Cash back when a lounge is closed. Half rate while it is still being built. */
export function loungeCloseRefund(lounge) {
  if (!lounge) return 0;
  const capex = lounge.capex ?? LOUNGE_BUILD_COST;
  // A half-finished fit-out has bought fittings nobody wants and a lease that
  // still has to be broken; recover less of it, not more.
  const rate = isLoungeOpen(lounge) ? LOUNGE_CLOSE_REFUND : LOUNGE_CLOSE_REFUND * 0.5;
  return Math.round(capex * rate);
}

/**
 * Weekly running cost of the lounge network. Only OPEN lounges cost money —
 * a fit-out is capex, already paid.
 */
export function totalLoungeWeeklyOpex(lounges = {}) {
  let n = 0;
  for (const code of Object.keys(lounges ?? {})) {
    if (isLoungeOpen(lounges[code])) n++;
  }
  return n * LOUNGE_WEEKLY_OPEX;
}

/**
 * Advance construction one week. Pure — returns a NEW map plus the list of
 * lounges that opened this week, so the reducer can toast them.
 * Mirrors tickBaseConstruction in mroBase.js.
 */
export function tickLoungeConstruction(lounges = {}, absWeek = 0) {
  const out    = {};
  const opened = [];
  for (const [code, lounge] of Object.entries(lounges ?? {})) {
    if (!lounge) continue;
    const left = lounge.buildWeeksLeft ?? 0;
    if (left > 0) {
      const next = left - 1;
      out[code] = { ...lounge, buildWeeksLeft: next, ...(next <= 0 ? { openedWeek: absWeek } : {}) };
      if (next <= 0) opened.push(code);
    } else {
      out[code] = lounge;
    }
  }
  return { lounges: out, opened };
}

/**
 * Can a lounge be built here, and what does it cost?
 *
 * Shared by the reducer (enforcement) and the UI (display), so the player is
 * always shown exactly what the reducer will check — the convention canBuildBase
 * and hubUpgradeChecklist already follow. A UI that computes its own answer
 * eventually disagrees with the engine, and the player is the one who finds out.
 *
 * @param {string} code  airport
 * @param {{lounges: object, gates: object, cash: number}} snap
 */
export function canBuildLounge(code, snap = {}) {
  const { lounges = {}, gates = {}, cash = 0 } = snap;
  const reasons = [];
  const capex   = LOUNGE_BUILD_COST;
  if (!code) {
    reasons.push('Pick an airport.');
    return { ok: false, reasons, capex, gatesNeeded: LOUNGE_GATES_REQUIRED };
  }
  if (lounges[code]) reasons.push('You already have a lounge at this airport.');
  const held = gates[code] ?? 0;
  if (held < LOUNGE_GATES_REQUIRED) {
    reasons.push(`You need at least ${LOUNGE_GATES_REQUIRED} gate at ${code} to build a lounge there.`);
  }
  if (cash < capex) reasons.push('Not enough cash to build a lounge.');
  return { ok: reasons.length === 0, reasons, capex, gatesNeeded: LOUNGE_GATES_REQUIRED };
}

// ── Route-level effects ───────────────────────────────────────────────────────

/**
 * Fraction of a route's ENDPOINTS covered by an open own lounge: 0, 0.5 or 1.
 * Drives day-pass sales (you cannot sell access to a room you do not have) and
 * the premium ground-cost discount.
 */
export function loungeEndpointCoverage(lounges = {}, origin, destination) {
  let n = 0;
  if (isLoungeOpen(lounges?.[origin]))      n++;
  if (isLoungeOpen(lounges?.[destination])) n++;
  return n / 2;
}

/** How many of a route's endpoints have an open own lounge: 0, 1 or 2. */
export function loungeEndpointCount(lounges = {}, origin, destination) {
  let n = 0;
  if (isLoungeOpen(lounges?.[origin]))      n++;
  if (isLoungeOpen(lounges?.[destination])) n++;
  return n;
}

/**
 * Business-segment appeal multiplier for one route. 1 = no lounge anywhere, i.e.
 * scored exactly as this engine scored every route before lounges existed.
 *
 * Partner lounges only ever count at endpoints you do NOT cover yourself: your
 * own room is strictly better, and a passenger cannot use two lounges at one
 * airport. Their contribution is scaled by the alliance's interline fraction,
 * because a bloc that barely interlines barely honours each other's cards.
 *
 * Alliance reciprocity requires you to run at least one lounge SOMEWHERE — you
 * cannot trade access you do not have.
 *
 * @param {object}  opts.lounges         state.lounges
 * @param {object}  opts.policy          state.loungePolicy
 * @param {string}  opts.origin
 * @param {string}  opts.destination
 * @param {object?} opts.alliance        resolved ALLIANCES entry, or null
 */
export function routeLoungeAppeal({ lounges = {}, policy = null, origin, destination, alliance = null } = {}) {
  const own = loungeEndpointCount(lounges, origin, destination);
  const p   = normalizeLoungePolicy(policy);

  let appeal = 1 + LOUNGE_APPEAL_PER_END * own;

  if (p.loyaltyAccess && own > 0) {
    appeal += LOUNGE_LOYALTY_APPEAL_PER_END * own;
  }

  // Reciprocity is a TRADE, not a subscription: partners honour your members
  // because you honour theirs, which you cannot do without a room of your own.
  // Without this gate the alliance term paid out MOST to an airline that owned
  // nothing (partnerEnds = 2 - own), for free and forever — and because the
  // policy flag outlives the lounges, you could build one, switch the policy on,
  // close the lounge for a partial refund and keep the demand boost with no
  // weekly cost at all.
  if (alliance && p.allianceAccess && openLoungeCodes(lounges).length > 0) {
    const partnerEnds = 2 - own;                       // only where you have no room
    const interline   = alliance.interlineFraction ?? 0.5;
    appeal += LOUNGE_APPEAL_PER_END * LOUNGE_ALLIANCE_END_WEIGHT * partnerEnds * interline;
  }

  return clamp(appeal, 1, LOUNGE_APPEAL_MAX);
}

/**
 * Multiplier on the third-party premium ground contract (overhead.js
 * LOUNGE_COST_PER_PAX) for one route. Each covered endpoint drops to
 * LOUNGE_OWNED_COST_FACTOR; the uncovered one still pays full contract rate.
 * Both covered → LOUNGE_OWNED_COST_FACTOR. Neither → 1 (unchanged).
 */
export function loungeContractFactor(lounges = {}, origin, destination) {
  const own = loungeEndpointCount(lounges, origin, destination);
  if (own <= 0) return 1;
  const covered = own / 2;
  return clamp(1 + covered * (LOUNGE_OWNED_COST_FACTOR - 1), LOUNGE_OWNED_COST_FACTOR, 1);
}

// ── Network-level weekly economics ────────────────────────────────────────────

/**
 * Guests who walk in free, and what that nets out at, for the whole network in
 * one week.
 *
 * `throughputPax` is the number of NON-premium passengers (economy and premium
 * economy, both directions) the airline boarded at stations where it has an open
 * lounge. Premium passengers are deliberately excluded: they are already paid
 * for on the per-passenger premium ground line in overhead.js, which the
 * contract-factor discount above has already cut for exactly these airports.
 * Counting them here as well would charge the same passenger twice.
 *
 * @returns {{ loyaltyGuests, allianceGuests, servicingCost, settlementRevenue, netCost }}
 */
export function loungeGuestEconomics({
  throughputPax = 0,
  loyaltyPenetration = 0,
  policy = null,
  allianceActive = false,
  hasOpenLounge = true,
} = {}) {
  const p = normalizeLoungePolicy(policy);
  if (!hasOpenLounge || !(throughputPax > 0)) {
    return { loyaltyGuests: 0, allianceGuests: 0, servicingCost: 0, settlementRevenue: 0, netCost: 0 };
  }

  const loyaltyGuests = p.loyaltyAccess
    ? throughputPax * clamp(loyaltyPenetration, 0, 1) * LOUNGE_LOYALTY_USE_RATE
    : 0;
  const allianceGuests = (allianceActive && p.allianceAccess)
    ? throughputPax * LOUNGE_ALLIANCE_GUEST_RATE
    : 0;

  const servicingCost     = Math.round((loyaltyGuests + allianceGuests) * LOUNGE_SERVICING_COST_PER_GUEST);
  const settlementRevenue = Math.round(allianceGuests * LOUNGE_ALLIANCE_SETTLEMENT_PER_GUEST);

  return {
    loyaltyGuests:  Math.round(loyaltyGuests),
    allianceGuests: Math.round(allianceGuests),
    servicingCost,
    settlementRevenue,
    // Netted into ONE cost line rather than a cost and a revenue. Settlement
    // income is not route revenue and is not partner revenue in the alliance
    // sense; presenting it as either puts a phantom row on the Finance page and
    // breaks the P&L bridge's residual check.
    netCost: servicingCost - settlementRevenue,
  };
}
