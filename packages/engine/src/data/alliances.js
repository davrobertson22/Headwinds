/**
 * alliances.js — Alliance and codeshare configuration data
 *
 * THREE ALLIANCES
 * ───────────────
 * SkyBridge Alliance  — Legacy, Europe/Americas heavy
 * Pacific Pact        — Legacy/Premium, Asia-Pacific
 * Apex Network        — Premium only, Middle East/Global
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
      minQuality:   65,
      allowedTiers: ['premium'],   // premium carriers only
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
