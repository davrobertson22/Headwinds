/**
 * alliances.js — Alliance and codeshare configuration data
 *
 * FIVE ALLIANCES
 * ──────────────
 * SkyBridge Alliance  — Legacy, Europe/Americas heavy
 * Pacific Pact        — Legacy/Premium, Asia-Pacific
 * Apex Network        — Premium only, Middle East/Global
 * Horizon Coalition   — Budget/value, low-cost carriers worldwide
 * Meridian Alliance   — Legacy/Premium, emerging markets (Africa/South Asia/LatAm)
 *
 * CODESHARE AGREEMENTS
 * ─────────────────────
 * Bilateral deals with any competitor (independent of alliance).
 * Fee scales by competitor tier. Revenue scales by network overlap
 * (how many of their routes touch airports you serve).
 */

// ─── Alliance definitions ─────────────────────────────────────────────────────

export const ALLIANCES = [
  {
    id:       'skybridge',
    name:     'SkyBridge Alliance',
    color:    '#3b82f6',
    icon:     '🌉',
    tagline:  'The world\'s legacy carrier network',
    description:
      'Europe and Americas-focused legacy network. Members cooperate on trans-Atlantic routes, '
      + 'share lounges, and cross-sell each other\'s connections.',
    memberIds: ['globalair', 'euroconnect', 'rhineair', 'eaglewings'],

    // Costs
    initiationFee: 250_000,
    weeklyFee:     60_000,

    // Benefits
    demandBoostPct: 0.06,   // +6% revenue on routes where any member also competes
    qualityBonus:   4,      // flat quality-score points on all player routes

    // Interline share: fraction of direct bilateral rate (pooled with other members)
    interlineFraction: 0.65,

    // Eligibility
    requirements: {
      minRoutes:    8,
      minQuality:   55,
      allowedTiers: ['legacy', 'premium'],
    },
  },
  {
    id:       'pacificpact',
    name:     'Pacific Pact',
    color:    '#10b981',
    icon:     '🌏',
    tagline:  'Asia-Pacific\'s premier aviation partnership',
    description:
      'Connects major Asia-Pacific hubs with coordinated schedules and joint lounges. '
      + 'Strong connecting demand through gateway airports.',
    memberIds: ['pacificrim', 'southerncross', 'orientprestige', 'silkroute'],

    initiationFee: 350_000,
    weeklyFee:     70_000,

    demandBoostPct: 0.05,
    qualityBonus:   5,
    interlineFraction: 0.60,

    requirements: {
      minRoutes:    6,
      minQuality:   50,
      allowedTiers: ['legacy', 'premium'],
    },
  },
  {
    id:       'apexnetwork',
    name:     'Apex Network',
    color:    '#a78bfa',
    icon:     '💎',
    tagline:  'Premium travel redefined',
    description:
      'Elite alliance of premium carriers. Delivers the highest quality-score bonus '
      + 'and strongest business-traveller interline revenue.',
    memberIds: ['apexair', 'gulfpearl', 'nordicelite', 'pampapremium'],

    initiationFee: 500_000,
    weeklyFee:     90_000,

    demandBoostPct: 0.04,
    qualityBonus:   8,
    interlineFraction: 0.70,

    requirements: {
      minRoutes:    10,
      minQuality:   80,
      allowedTiers: ['premium'],   // premium carriers only
    },
  },
  {
    id:       'horizoncoalition',
    name:     'Horizon Coalition',
    color:    '#f59e0b',
    icon:     '🧭',
    tagline:  'The low-cost carriers\' network',
    description:
      'A value alliance of low-cost carriers spanning every continent. Low dues and an easy '
      + 'entry bar, with the strongest revenue lift on contested routes — LCCs win on price and volume.',
    memberIds: ['zoomjet', 'fastfly', 'wingit', 'asiaexpress'],

    initiationFee: 120_000,
    weeklyFee:     30_000,

    demandBoostPct: 0.07,   // highest revenue boost — LCC volume play
    qualityBonus:   2,      // modest quality lift
    interlineFraction: 0.55,

    requirements: {
      minRoutes:    5,
      minQuality:   35,
      // Open to every tier — the value bloc welcomes any carrier.
    },
  },
  {
    id:       'meridianalliance',
    name:     'Meridian Alliance',
    color:    '#14b8a6',
    icon:     '🌍',
    tagline:  'Connecting the emerging world',
    description:
      'Fast-growing carriers across Africa, South Asia and Latin America. Coordinated schedules '
      + 'open connecting demand through emerging-market gateways underserved by the legacy blocs.',
    memberIds: ['transafrica', 'indiastar', 'aztecair', 'dragoneast'],

    initiationFee: 300_000,
    weeklyFee:     65_000,

    demandBoostPct: 0.05,
    qualityBonus:   5,
    interlineFraction: 0.62,

    requirements: {
      minRoutes:    7,
      minQuality:   52,
      allowedTiers: ['legacy', 'premium'],
    },
  },
];

// ─── Codeshare configuration ──────────────────────────────────────────────────

/**
 * Weekly fee charged to the player for a bilateral codeshare agreement.
 * The competitor gets a small benefit from this (access to our brand/network).
 */
export const CODESHARE_WEEKLY_FEE_BY_TIER = {
  budget:  20_000,
  legacy:  35_000,
  premium: 55_000,
};

/**
 * Weekly interline revenue per adjacent route.
 * "Adjacent" = one of the competitor's route endpoints is an airport the player serves.
 * Budget partners send fewer high-yield passengers; premium partners send more.
 */
export const INTERLINE_RATE_BY_TIER = {
  budget:  2_500,
  legacy:  5_000,
  premium: 8_500,
};

/**
 * Standard codeshare duration in weeks (1 year).
 * After this the agreement expires and must be renewed.
 */
export const CODESHARE_DURATION_WEEKS = 52;

/**
 * Maximum simultaneous bilateral codeshare agreements.
 */
export const MAX_CODESHARE_AGREEMENTS = 6;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Look up an alliance by id. Returns undefined if not found. */
export function getAlliance(id) {
  return ALLIANCES.find(a => a.id === id);
}

/**
 * A competitor's CURRENT alliance. Membership is dynamic — carriers join and
 * leave blocs via the adaptive AI (competitor.allianceId). The static
 * memberIds lists above only seed founding members for carriers that haven't
 * been touched by the AI yet (fresh games / old saves).
 *
 * @param {object} competitor
 * @returns {string|null} alliance id
 */
export function effectiveAllianceId(competitor) {
  if (!competitor) return null;
  if (competitor.allianceId !== undefined) return competitor.allianceId;
  return ALLIANCES.find(a => a.memberIds.includes(competitor.id))?.id ?? null;
}

/**
 * Live member list of an alliance: every surviving competitor whose effective
 * membership matches. Replaces reading alliance.memberIds directly.
 *
 * @param {string} allianceId
 * @param {object[]} competitors  state.competitors
 * @returns {object[]} competitor objects
 */
export function allianceMembers(allianceId, competitors = []) {
  return competitors.filter(c => effectiveAllianceId(c) === allianceId);
}

/**
 * Check whether a player meets the eligibility requirements to join an alliance.
 *
 * @param {object} alliance      - Alliance definition from ALLIANCES
 * @param {object} playerState   - { routes, playerTier, avgQualityScore }
 * @returns {{ eligible: boolean, reasons: string[] }}
 */
export function checkAllianceEligibility(alliance, { routes, playerTier, avgQualityScore }) {
  const reasons = [];
  const req = alliance.requirements;

  if (routes < req.minRoutes)
    reasons.push(`Need at least ${req.minRoutes} routes (you have ${routes})`);

  if (avgQualityScore < req.minQuality)
    reasons.push(`Need average quality ≥ ${req.minQuality} (yours is ${avgQualityScore})`);

  if (req.allowedTiers && playerTier && !req.allowedTiers.includes(playerTier))
    reasons.push(`Open to ${req.allowedTiers.join(' / ')} carriers only`);

  return { eligible: reasons.length === 0, reasons };
}

/**
 * Compute how many of a competitor's routes are "adjacent" to the player's network —
 * i.e., at least one endpoint is an airport the player already serves.
 *
 * @param {object} competitor  - competitor object from state.competitors (has .routes)
 * @param {Set<string>} servedAirports - set of IATA codes the player serves
 * @returns {number}
 */
export function countAdjacentRoutes(competitor, servedAirports) {
  let count = 0;
  for (const routeKey of Object.keys(competitor.routes)) {
    const [a, b] = routeKey.split('-');
    if (servedAirports.has(a) || servedAirports.has(b)) count++;
  }
  return count;
}

/**
 * Weekly interline revenue from a single partner (competitor).
 * Used for both alliance members and bilateral codeshare agreements.
 *
 * @param {object}  competitor       - competitor from state.competitors
 * @param {Set}     servedAirports   - airports the player serves
 * @param {number}  fraction         - multiplier (1.0 for codeshare, 0.6-0.7 for alliance)
 * @returns {number}  revenue in $
 */
export function partnerInterlineRevenue(competitor, servedAirports, fraction = 1.0) {
  const adjacent = countAdjacentRoutes(competitor, servedAirports);
  const rate     = INTERLINE_RATE_BY_TIER[competitor.tier] ?? INTERLINE_RATE_BY_TIER.legacy;
  return Math.round(adjacent * rate * fraction);
}
