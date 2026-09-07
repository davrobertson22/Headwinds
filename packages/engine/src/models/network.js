/**
 * network.js — O&D routing, cannibalization detection, and partner revenue model
 *
 * CORE CONCEPTS
 * ─────────────
 * 1. NetworkGraph       — adjacency index of player + partner routes keyed by airport
 * 2. Connection         — a (A→hub→C) itinerary sharing a hub airport
 * 3. Diversion          — when a direct A→C exists, demand shifts away from A→hub→C
 * 4. CannibalizationMap — per-routeKey multiplier on connecting demand (0–1)
 * 5. PartnerODRevenue   — actual O&D revenue from player+partner leg combos,
 *                         replacing the old flat interline rate model
 *
 * CANNIBALIZATION MECHANIC
 * ─────────────────────────
 * For each hub airport H the player operates, we look at every (A→H, H→C) pairing
 * (one or both legs may be partner metal). If the player also flies A→C direct, a
 * logit utility model splits the A→C demand pool between the direct and the connecting
 * option. The connection's share is returned as a multiplier applied to that route's
 * connecting demand in simulation.js.
 *
 * PARTNER REVENUE
 * ────────────────
 * For connections where one leg is a partner's (alliance or codeshare), the player
 * earns a prorate fraction of the ticket price proportional to the mileage they fly.
 * This replaces the old flat INTERLINE_RATE_BY_TIER model with something that scales
 * with the actual network.
 *
 * RELATIONSHIP HEALTH
 * ────────────────────
 * Each week, if the player operates a direct route that competes with a Joint Venture
 * partner's connecting traffic, the partnership health decays. This creates a real
 * trade-off between launching profitable direct routes and preserving alliance revenue.
 */

import { baseCityPairDemand, routeDistance, referencePrice } from '../utils/market.js';
import {
  buildRouteMarket,
  buildCompetitorOffer,
  computeMarketShare,
  BUSINESS_PRICE_MULTIPLIER,
  HUB_TIERS,
  hubCongestionFactor,
  TIER_SEAT_TARGET,
} from './demand.js';
import { getAircraftType } from '../data/aircraft.js';
import { allianceMembers } from '../data/alliances.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Utility penalty applied to a connecting itinerary vs a direct flight.
 * Higher value = passengers strongly prefer direct; connection loses more demand.
 * Scaled by partnership type: own metal is least punishing, bare interline most.
 */
export const CONNECTION_PENALTY = {
  ownMetal:      0.38,   // both legs on player aircraft — DEFAULT; overridden per hub
                         // tier via HUB_TIERS[tier].connPenalty when the hub is designated
  jointVenture:  0.38,   // JV: coordinated schedules, shared revenue pool
  alliance:      0.50,   // alliance: coordinated but separate revenue
  codeshare:     0.60,   // codeshare: one ticket, different metal
  interline:     0.75,   // basic interline: separate tickets, minimal cooperation
};

/**
 * Own-metal connection penalty at a hub, by designation tier.
 * Undesignated airports return null — own-metal connections there are not
 * monetized (no transfer product exists), though they still count for
 * cannibalization detection.
 */
export function ownMetalPenaltyAt(hubs, hubCode) {
  const tier = hubs?.[hubCode]?.tier;
  if (tier == null) return null;
  return HUB_TIERS[tier]?.connPenalty ?? CONNECTION_PENALTY.ownMetal;
}

/**
 * Prorate fraction the player earns on their leg of a codeshare/alliance itinerary.
 * These supplement the mileage-based prorate with a minimum floor.
 * (Actual prorate = max(mileage_fraction, floor below))
 */
export const PRORATE_FLOOR = {
  jointVenture:  0.50,   // revenue pooled — effective 50% on both legs
  alliance:      0.42,
  codeshare:     0.48,
  interline:     0.38,
};

/** Maximum connection layover for a valid itinerary (minutes). */
const MAX_LAYOVER_MINUTES  = 4 * 60;

/** Minimum connection time (minutes) — below this the connection is impossible. */
const MIN_LAYOVER_MINUTES  = 45;

/** Weekly demand ceiling beyond which we stop enumerating O&D pairs (performance). */
const MIN_OD_DEMAND_PAX    = 5;

/** Utility weight: how much price matters in the direct vs connect choice. */
const PRICE_WEIGHT         = 1.2;

/** Utility weight: how much frequency matters (log scale). */
const FREQ_WEIGHT          = 0.35;

// ─── Partner O&D revenue model ────────────────────────────────────────────────
// The player's connecting itinerary competes for each O&D market against any
// competitor nonstops AND a synthetic "outside option" that represents every
// other way to make the trip (other carriers' nonstops, connections over other
// hubs, rail/road, or simply not travelling). The outside option is what stops a
// single connecting itinerary from ever capturing 100% of a city-pair market.

/**
 * Utility bonus applied to the outside option, representing the breadth of
 * alternative itineraries a traveller always has. ~1.4 ≈ ln(4), i.e. all-else-
 * equal the field of alternatives is favoured ~4:1 over a single connecting
 * itinerary. This is the single biggest lever on partner-feed size: raise it to
 * shrink partner O&D revenue, lower it to grow it.
 */
const OUTSIDE_OPTION_CONN_BONUS = 1.4;

/** Quality score (0–100) assigned to the outside option (a generic nonstop alt). */
const OUTSIDE_OPTION_QUALITY    = 70;

/** Weekly frequency assumed for the aggregate outside option. */
const OUTSIDE_OPTION_FREQUENCY  = 35;

/** Quality score assigned to the player's connecting itinerary (partner-metal blend). */
const CONNECTION_QUALITY_SCORE  = 58;

/** Seats per flight assumed when sizing connecting-leg capacity. */
const ASSUMED_SEATS_PER_FLIGHT  = 180;

/**
 * Fraction of a leg's seats realistically available to *this* connecting O&D.
 * A spoke flight carries mostly local pax plus connections spread over many
 * onward markets, so any single O&D can only claim a small slice of the metal.
 */
const CONNECTING_SEAT_FRACTION  = 0.18;

/** Share of captured seat-intent that actually boards (no-show / spill buffer). */
const CONNECTION_LOAD_FACTOR    = 0.85;

// ─── Types (JSDoc) ────────────────────────────────────────────────────────────

/**
 * @typedef {object} NetworkRoute
 * A normalised route, covering both player and partner entries.
 * @property {string}  origin
 * @property {string}  destination
 * @property {string}  routeKey           - alphabetically sorted 'A-B'
 * @property {number}  weeklyFrequency    - one-way flights per week
 * @property {number}  price              - economy price ($), estimated for partner routes
 * @property {'player'|'partner'} owner
 * @property {string}  [partnerId]        - competitor id if owner === 'partner'
 * @property {string}  [partnershipType]  - 'jointVenture'|'alliance'|'codeshare'|'interline'
 */

/**
 * @typedef {object} Connection
 * A 1-stop itinerary through a hub airport.
 * @property {string}  hub
 * @property {string}  legOneOrigin       - O of leg 1
 * @property {string}  legOneDest         - hub
 * @property {string}  legTwoDest         - C (final destination)
 * @property {'player'|'partner'} leg1Owner
 * @property {'player'|'partner'} leg2Owner
 * @property {string}  [leg1PartnerId]
 * @property {string}  [leg2PartnerId]
 * @property {string}  partnershipType    - best applicable type for utility penalty
 * @property {number}  leg1Freq
 * @property {number}  leg2Freq
 * @property {number}  leg1Price
 * @property {number}  leg2Price
 * @property {number}  totalPrice         - combined fare estimate
 * @property {number}  odDemand           - gravity-model demand for origin→finalDest
 * @property {boolean} directExists       - does the player operate a direct on this O&D?
 * @property {number}  connectionShare    - 0–1 logit share that stays on the connection
 * @property {number}  directShare        - 1 - connectionShare
 */

/**
 * @typedef {object} CannibalizationMap
 * Maps routeKey → multiplier (0–1) to apply to that route's connecting demand.
 * A route can be a connecting leg in multiple O&D pairs, so multipliers compound.
 */

/**
 * @typedef {object} PartnerODEntry
 * Revenue earned by the player from one partner-leg O&D connection.
 * @property {string}  odKey              - 'origin-destination' sorted
 * @property {string}  hub
 * @property {string}  partnerLeg         - 'leg1'|'leg2' — which leg is partner metal
 * @property {number}  pax                - estimated connecting passengers
 * @property {number}  playerRevenue      - prorate revenue for the player's leg ($)
 * @property {number}  playerLegMileage
 * @property {number}  totalMileage
 * @property {string}  partnershipType
 */

// ─── Graph construction ───────────────────────────────────────────────────────

/**
 * Expand player routes into individual flown LEGS so the network model sees every
 * airport a multi-stop (tag) flight touches — not just its endpoints.
 *
 * A single-leg route passes through unchanged. A tag route A→B→C becomes two leg
 * routes (A→B, B→C), each priced from the route's per-segment economy fare and
 * tagged with `_tagParentId` so the connection enumerator can recognise (and skip)
 * a tag's OWN through service — that O&D is already sold directly by
 * simulateTagRoute, so re-counting it here would double-book the through market.
 *
 * Inline stop/leg derivation (no import from simulation.js) avoids a circular
 * dependency, since simulation.js imports runNetworkTick from this module.
 *
 * @param {Array} routes - game state passenger routes (single-leg and/or tag)
 * @returns {Array} leg-level pseudo-routes: { origin, destination, weeklyFrequency, ticketPrice, _tagParentId? }
 */
export function expandRoutesToLegs(routes = []) {
  const out = [];
  for (const r of routes) {
    const stops = Array.isArray(r.stops) && r.stops.length >= 2 ? r.stops : [r.origin, r.destination];
    if (stops.length <= 2) { out.push(r); continue; }   // single leg — unchanged
    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i], to = stops[i + 1];
      const segPrice = r.segmentPrices?.[`${from}>${to}`]?.economy;
      out.push({
        origin:          from,
        destination:     to,
        weeklyFrequency: r.weeklyFrequency ?? 7,
        ticketPrice:     segPrice ?? referencePrice(from, to),
        _tagParentId:    r.id ?? `${stops.join('>')}`,
      });
    }
  }
  return out;
}

/**
 * Build an airport-keyed adjacency index from player routes + partner routes.
 *
 * @param {Array}  playerRoutes      - leg-level player routes (see expandRoutesToLegs)
 * @param {Array}  partnerRoutes     - partner NetworkRoute entries (built by buildPartnerRoutes)
 * @returns {Map<string, NetworkRoute[]>}  airport → all NetworkRoutes that touch it
 */
function buildAdjacencyIndex(playerRoutes, partnerRoutes) {
  const index = new Map();

  const addToIndex = (airport, route) => {
    if (!index.has(airport)) index.set(airport, []);
    index.get(airport).push(route);
  };

  for (const r of playerRoutes) {
    const nr = {
      origin:          r.origin,
      destination:     r.destination,
      routeKey:        [r.origin, r.destination].sort().join('-'),
      weeklyFrequency: r.weeklyFrequency ?? 7,
      price:           r.ticketPrice ?? referencePrice(r.origin, r.destination),
      owner:           'player',
      tagParentId:     r._tagParentId,   // present only for legs of a tag flight
    };
    addToIndex(r.origin,      nr);
    addToIndex(r.destination, nr);
  }

  for (const r of partnerRoutes) {
    addToIndex(r.origin,      r);
    addToIndex(r.destination, r);
  }

  return index;
}

/**
 * Convert competitor route data + partnership context into NetworkRoute objects.
 *
 * @param {Array}  competitors        - state.competitors
 * @param {object} partnershipMap     - { [competitorId]: 'jointVenture'|'alliance'|'codeshare'|'interline' }
 * @returns {NetworkRoute[]}
 */
export function buildPartnerRoutes(competitors, partnershipMap) {
  const routes = [];
  for (const comp of competitors) {
    const pType = partnershipMap[comp.id];
    if (!pType) continue;  // not a partner — skip

    for (const [routeKey, cfg] of Object.entries(comp.routes)) {
      const [a, b] = routeKey.split('-');
      const refP   = referencePrice(a, b) ?? 300;
      const price  = Math.round(refP * (cfg.priceMultiplier ?? 1.0));

      // Forward direction
      routes.push({
        origin:          a,
        destination:     b,
        routeKey,
        weeklyFrequency: cfg.frequency ?? 7,
        price,
        owner:           'partner',
        partnerId:       comp.id,
        partnershipType: pType,
      });
      // Reverse direction (bidirectional service)
      routes.push({
        origin:          b,
        destination:     a,
        routeKey,
        weeklyFrequency: cfg.frequency ?? 7,
        price,
        owner:           'partner',
        partnerId:       comp.id,
        partnershipType: pType,
      });
    }
  }
  return routes;
}

/**
 * Build a Map<competitorId, partnershipType> from game state.
 * Codeshare agreements take precedence over alliance membership for tier.
 * If a competitor is in a JV (joint venture) agreement, mark them specially.
 *
 * @param {object|null} allianceMembership   - state.allianceMembership
 * @param {Array}       codeshareAgreements  - state.codeshareAgreements
 * @param {object|null} allianceDef          - ALLIANCES entry or null
 * @param {object}      [jvRoutes]           - { [competitorId]: true } for JV partners
 * @returns {Map<string, string>}
 */
export function buildPartnershipMap(allianceMembership, codeshareAgreements, allianceDef, jvRoutes = {}, competitors = []) {
  const map = new Map();

  // Alliance members (weaker than codeshare). Membership is dynamic — read
  // from live competitor state, seeded by the founding memberIds list.
  if (allianceDef) {
    const liveIds = competitors.length
      ? allianceMembers(allianceDef.id, competitors).map(c => c.id)
      : (allianceDef.memberIds ?? []);
    for (const id of liveIds) {
      map.set(id, 'alliance');
    }
  }

  // Codeshare agreements override alliance (stronger cooperation)
  for (const ag of (codeshareAgreements ?? [])) {
    map.set(ag.competitorId, 'codeshare');
  }

  // Joint venture overrides everything (strongest)
  for (const id of Object.keys(jvRoutes)) {
    if (jvRoutes[id]) map.set(id, 'jointVenture');
  }

  return map;
}

// ─── Connection enumeration ───────────────────────────────────────────────────

/**
 * Find all valid 1-stop connections through a hub airport.
 * A connection is valid when:
 *   - The player has AT LEAST ONE of the two legs (own metal or meaningful partner)
 *   - The O&D demand is above the minimum threshold
 *
 * @param {string}                hub
 * @param {Map}                   adjacencyIndex    - from buildAdjacencyIndex
 * @param {Set<string>}           playerRouteKeys   - set of route keys the player operates
 * @param {Set<string>}           directRouteKeys   - same set (for checking if direct exists)
 * @returns {Connection[]}
 */
function findConnectionsAtHub(hub, adjacencyIndex, playerRouteKeys, directRouteKeys) {
  const touchingRoutes = adjacencyIndex.get(hub) ?? [];

  // Split into routes that arrive at hub (i.e., destination === hub)
  // and routes that depart from hub (i.e., origin === hub)
  const inbound  = touchingRoutes.filter(r => r.destination === hub);
  const outbound = touchingRoutes.filter(r => r.origin      === hub);

  const connections = [];

  for (const leg1 of inbound) {
    for (const leg2 of outbound) {
      const origin = leg1.origin;
      const dest   = leg2.destination;

      // Skip trivial (same O&D as the legs themselves)
      if (origin === dest) continue;

      // Skip a tag flight's OWN internal through service: both legs belong to the
      // same multi-stop route, whose through O&D simulateTagRoute already sells.
      // Counting it here would double-book that market.
      if (leg1.tagParentId && leg1.tagParentId === leg2.tagParentId) continue;

      // Require player to own at least one leg (otherwise irrelevant)
      if (leg1.owner !== 'player' && leg2.owner !== 'player') continue;

      // O&D demand check
      const odDemand = baseCityPairDemand(origin, dest);
      if (!odDemand || odDemand < MIN_OD_DEMAND_PAX) continue;

      // Determine best partnership type for penalty
      // If both legs are player metal → ownMetal
      // If one is partner → use the partner leg's type
      let partnershipType;
      if (leg1.owner === 'player' && leg2.owner === 'player') {
        partnershipType = 'ownMetal';
      } else {
        const partnerLeg = leg1.owner === 'partner' ? leg1 : leg2;
        partnershipType  = partnerLeg.partnershipType ?? 'interline';
      }

      const directKey    = [origin, dest].sort().join('-');
      const directExists = directRouteKeys.has(directKey);

      const totalPrice   = leg1.price + leg2.price;
      const refP         = referencePrice(origin, dest) ?? totalPrice;
      const minFreq      = Math.min(leg1.weeklyFrequency, leg2.weeklyFrequency);

      // Logit utility for connection vs direct
      const penalty        = CONNECTION_PENALTY[partnershipType] ?? CONNECTION_PENALTY.interline;
      const connectUtil    = -penalty
                             - PRICE_WEIGHT * (totalPrice / Math.max(refP, 1))
                             + FREQ_WEIGHT  * Math.log1p(minFreq);

      let connectionShare = 1.0;
      let directShare     = 0.0;

      if (directExists) {
        // Direct route utility (we don't have its exact price here, so use refPrice as proxy)
        const directUtil = -PRICE_WEIGHT * 1.0   // price at reference = normalised 1.0
                           + FREQ_WEIGHT * Math.log1p(7); // assume baseline 7 freq
        const expConn   = Math.exp(connectUtil - Math.max(connectUtil, directUtil));
        const expDirect = Math.exp(directUtil  - Math.max(connectUtil, directUtil));
        const total     = expConn + expDirect;
        connectionShare = expConn   / total;
        directShare     = expDirect / total;
      }

      connections.push({
        hub,
        legOneOrigin:    origin,
        legOneDest:      hub,
        legTwoDest:      dest,
        leg1Owner:       leg1.owner,
        leg2Owner:       leg2.owner,
        leg1PartnerId:   leg1.partnerId,
        leg2PartnerId:   leg2.partnerId,
        partnershipType,
        leg1Freq:        leg1.weeklyFrequency,
        leg2Freq:        leg2.weeklyFrequency,
        leg1Price:       leg1.price,
        leg2Price:       leg2.price,
        totalPrice,
        odDemand,
        directExists,
        connectionShare,
        directShare,
      });
    }
  }

  return connections;
}

// ─── Primary exports ──────────────────────────────────────────────────────────

/**
 * Compute the full set of 1-stop connections in the player's network,
 * including partner route pairings.
 *
 * Returns all Connection objects for inspection / UI display.
 *
 * @param {Array}   playerRoutes       - state.routes
 * @param {Array}   competitors        - state.competitors
 * @param {Map}     partnershipMap     - from buildPartnershipMap
 * @returns {Connection[]}
 */
export function buildAllConnections(playerRoutes, competitors, partnershipMap) {
  // Expand tag flights into their legs so every airport they touch (including
  // intermediate stops) is a real network node that can form/feed connections.
  const legRoutes        = expandRoutesToLegs(playerRoutes);
  // Feed onto the player's legs comes from PARTNERS only — alliance, codeshare,
  // joint venture — at their real partnership tier. A stranger's passengers do
  // not through-connect onto you; the residual self-connect and unmodeled-world
  // traffic is the gateway pool (demand.js connectingAtEndpoint). Decided
  // 2026-09-05 (HUB_CONNECTIVITY_PLAN.md Phase 2): feed is what agreements buy.
  const partnerRoutes    = buildPartnerRoutes(competitors, Object.fromEntries(partnershipMap));
  const playerRouteKeys  = new Set(legRoutes.map(r => [r.origin, r.destination].sort().join('-')));
  const adjacencyIndex   = buildAdjacencyIndex(legRoutes, partnerRoutes);

  // Hub airports = every airport a player leg touches (intermediate stops included)
  const hubCandidates = new Set();
  for (const r of legRoutes) {
    hubCandidates.add(r.origin);
    hubCandidates.add(r.destination);
  }

  const allConnections = [];
  for (const hub of hubCandidates) {
    const conns = findConnectionsAtHub(hub, adjacencyIndex, playerRouteKeys, playerRouteKeys);
    allConnections.push(...conns);
  }

  return allConnections;
}

/**
 * Build a CannibalizationMap: for each player route, what fraction of its
 * connecting demand survives after the direct routes steal their share?
 *
 * A route may appear as leg 1 in multiple connections — the factors compound
 * multiplicatively (each direct route independently siphons a portion).
 * We cap compounding so a single route can't be reduced below 20% of connecting demand.
 *
 * @param {Connection[]} connections   - from buildAllConnections
 * @returns {Object}  { [routeKey]: number }  0.2–1.0
 */
export function buildCannibalizationMap(connections) {
  const factors = {};   // routeKey → accumulated factor

  for (const conn of connections) {
    if (!conn.directExists) continue;  // no direct competitor — no cannibalization

    const leg1Key = [conn.legOneOrigin, conn.legOneDest].sort().join('-');
    const leg2Key = [conn.legOneDest,   conn.legTwoDest].sort().join('-');
    const share   = conn.connectionShare;  // fraction that stays on the connection

    // Multiply into each leg's factor (compound across multiple competing directs)
    factors[leg1Key] = (factors[leg1Key] ?? 1.0) * share;
    factors[leg2Key] = (factors[leg2Key] ?? 1.0) * share;
  }

  // Enforce floor of 0.20 so a route always keeps at least 20% of connecting pax
  for (const key of Object.keys(factors)) {
    factors[key] = Math.max(0.20, factors[key]);
  }

  return factors;
}

/**
 * Index competitors by the sorted O&D route-keys they operate nonstop.
 * Used by the partner-feed model to find head-to-head nonstop competition.
 *
 * @param {object[]} competitors  - live competitor airline objects (with .routes)
 * @returns {Map<string, object[]>}  sorted routeKey → competitors serving it
 */
export function buildCompetitorRouteIndex(competitors = []) {
  const index = new Map();
  for (const comp of competitors) {
    for (const routeKey of Object.keys(comp.routes ?? {})) {
      // competitor route keys are already sorted 'A-B', but normalise defensively
      const key = routeKey.split('-').sort().join('-');
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(comp);
    }
  }
  return index;
}

/**
 * Build the synthetic "outside option" offer for an O&D market: the aggregate of
 * every alternative itinerary a traveller can choose instead of the player's
 * connection (other carriers' nonstops, connections over other hubs, not flying).
 * Priced at the market reference fare, high frequency, effectively unlimited
 * capacity, plus a utility bonus so it dominates unless the connection is
 * genuinely attractive. This is what prevents a single connection from ever
 * capturing 100% of a city-pair market.
 *
 * @param {RouteMarket} market
 * @returns {AirlineOffer}
 */
function buildOutsideOptionOffer(market) {
  const economyPrice = market.referencePrice;
  return {
    airlineId:         '__outside__',
    origin:            market.origin,
    destination:       market.destination,
    economyPrice,
    businessPrice:     Math.round(economyPrice * BUSINESS_PRICE_MULTIPLIER),
    weeklyFrequency:   OUTSIDE_OPTION_FREQUENCY,
    seatsPerFlight:    1e9,
    economySeats:      1e12,   // never capacity-capped — absorbs all residual demand
    businessSeats:     1e12,
    qualityScore:      OUTSIDE_OPTION_QUALITY,
    connectivityBonus: OUTSIDE_OPTION_CONN_BONUS,
  };
}

/**
 * Build the player's connecting-itinerary offer for an O&D market.
 * Carries the connection penalty (as a negative connectivity bonus), the
 * combined two-leg fare, and a capacity ceiling derived from the thinner of the
 * two legs — a single O&D can only claim a small slice of each spoke flight.
 *
 * @param {Connection}  conn
 * @param {RouteMarket} market
 * @returns {AirlineOffer}
 */
function buildPlayerConnectionOffer(conn, market, legacy = false) {
  const basePenalty = CONNECTION_PENALTY[conn.partnershipType] ?? CONNECTION_PENALTY.interline;
  const penalty   = legacy ? basePenalty : connectionPenaltyFor(
    basePenalty, connectionTimeRatio(conn.legOneOrigin, conn.hub, conn.legTwoDest));
  const minFreq   = Math.min(conn.leg1Freq, conn.leg2Freq);
  // Seats this O&D can realistically claim on the thinner leg, over the week.
  const econSeats = Math.max(
    1,
    Math.round(minFreq * ASSUMED_SEATS_PER_FLIGHT * CONNECTING_SEAT_FRACTION),
  );
  const economyPrice = legacy ? conn.totalPrice : throughFare(conn.totalPrice, conn.legOneOrigin, conn.legTwoDest);
  return {
    airlineId:         '__player_conn__',
    origin:            market.origin,
    destination:       market.destination,
    economyPrice,
    businessPrice:     Math.round(economyPrice * BUSINESS_PRICE_MULTIPLIER),
    weeklyFrequency:   minFreq,
    seatsPerFlight:    ASSUMED_SEATS_PER_FLIGHT,
    economySeats:      econSeats,
    businessSeats:     Math.max(1, Math.round(econSeats * 0.13)),
    qualityScore:      CONNECTION_QUALITY_SCORE,
    connectivityBonus: -penalty,    // connections are less attractive than nonstops
  };
}

/**
 * Compute partner O&D revenue: the player's prorate share of the revenue from
 * connecting itineraries where exactly one leg is partner metal.
 *
 * Unlike the old model — which booked ~100% of every city-pair market onto the
 * player's connection — this runs each O&D through the same discrete-choice
 * market-share model the direct routes use. The player's connecting itinerary
 * competes against any competitor nonstops on that O&D plus an outside option
 * representing all other itineraries, so its captured share is realistically
 * bounded and further capped by the connecting capacity of the thinner leg.
 *
 * @param {Connection[]}  connections
 * @param {object}        [options]
 * @param {object}        [options.gameDate={month:6}]       - { month } for seasonality
 * @param {Map<string,object[]>} [options.competitorRouteIndex]
 *        sorted-routeKey → array of competitor airline objects serving that O&D nonstop
 * @returns {{ totalRevenue: number, totalPax: number, entries: PartnerODEntry[] }}
 */
export function computePartnerODRevenue(connections, options = {}) {
  const {
    gameDate = { month: 6 },
    competitorRouteIndex = null,
    demandMultFor = null,   // (origin, dest) → world-event demand multiplier
    rivalIndex = undefined, // rivalIndexFor(state): RIVALS_OFF = old rules, undefined = modern, no rivals
  } = options;
  const legacy = isLegacy(rivalIndex);

  const entries = [];
  let totalRevenue = 0;
  let totalPax     = 0;   // partner-fed (interline/codeshare/alliance) connecting pax

  // ── Group mixed-leg connections by directional O&D market ────────────────────
  // Every distinct routing that serves the same origin→destination direction
  // competes for ONE shared market. Scoring them together (rather than once per
  // routing) prevents the same demand being booked several times over. Grouping
  // is directional — matching how the rest of the sim treats each travel
  // direction as its own one-way market — so outbound and return don't cannibalise
  // each other.
  const byOD = new Map();   // dirKey → { origin, dest, routings: Map<sig, conn> }
  for (const conn of connections) {
    const mixedLegs = (conn.leg1Owner === 'player') !== (conn.leg2Owner === 'player');
    if (!mixedLegs) continue;

    const origin = conn.legOneOrigin;
    const dest   = conn.legTwoDest;
    const dirKey = `${origin}-${dest}`;            // directional

    if (!byOD.has(dirKey)) byOD.set(dirKey, { dirKey, origin, dest, routings: new Map() });
    // Collapse exact-duplicate enumerations of the same routing (same hub/metal).
    const sig = `${conn.hub}|${conn.leg1Owner}`;
    const group = byOD.get(dirKey);
    if (!group.routings.has(sig)) group.routings.set(sig, conn);
  }

  for (const { origin, dest, routings } of byOD.values()) {
    const odKey = [origin, dest].sort().join('-');   // display key (unordered)
    const market = buildRouteMarket(origin, dest, gameDate, 1,
      demandMultFor ? demandMultFor(origin, dest) : 1);
    if (!market.baseWeeklyDemand) continue;

    // One offer per distinct player routing, all competing in the same market.
    const offers   = [];
    const routingMeta = new Map();   // offerId → { conn, prorate, hub, playerLeg }
    let i = 0;
    for (const conn of routings.values()) {
      const playerLeg    = conn.leg1Owner === 'player' ? 'leg1' : 'leg2';
      const playerOrigin = playerLeg === 'leg1' ? conn.legOneOrigin : conn.hub;
      const playerDest   = playerLeg === 'leg1' ? conn.hub          : conn.legTwoDest;
      const playerMiles  = routeDistance(playerOrigin, playerDest);
      const totalMiles   = routeDistance(origin, dest);
      if (!playerMiles || !totalMiles) continue;

      const partnerType = conn.partnershipType;
      const prorate = Math.max(
        playerMiles / totalMiles,
        PRORATE_FLOOR[partnerType] ?? PRORATE_FLOOR.interline,
      );

      const offer = buildPlayerConnectionOffer(conn, market, legacy);
      offer.airlineId = `__player_conn__${i++}`;
      offers.push(offer);
      routingMeta.set(offer.airlineId, {
        conn, prorate, playerMiles, totalMiles,
        hub: conn.hub, partnerType,
        partnerLeg: playerLeg === 'leg1' ? 'leg2' : 'leg1',
      });
    }
    if (offers.length === 0) continue;

    // Competitor nonstops on this O&D, rival one-stops over their hubs, and
    // the ever-present outside option.
    for (const competitor of (competitorRouteIndex?.get(odKey) ?? [])) {
      const offer = buildCompetitorOffer(competitor, market);
      if (offer) offers.push(offer);
    }
    if (rivalsOn(rivalIndex)) offers.push(...rivalOneStopOffersFor(rivalIndex, market));
    offers.push(buildOutsideOptionOffer(market));

    // Score the whole market once; sum the player's routings.
    const results = computeMarketShare(market, offers, { legacy });
    for (const r of results) {
      const meta = routingMeta.get(r.airlineId);
      if (!meta) continue;   // competitor / outside option

      const pax = Math.round(r.totalPax * CONNECTION_LOAD_FACTOR);
      if (pax <= 0) continue;

      const grossItinRevenue = r.totalRevenue * CONNECTION_LOAD_FACTOR;
      const playerRevenue    = Math.round(grossItinRevenue * meta.prorate);

      totalRevenue += playerRevenue;
      totalPax     += pax;
      entries.push({
        odKey,
        ...(legacy ? {} : { origin, dest }),   // direction — the tick seats feed on the player leg
        hub:               meta.hub,
        partnerLeg:        meta.partnerLeg,
        pax,
        playerRevenue,
        capturedShare:     +(r.leisureShare ?? 0).toFixed(4),
        playerLegMileage:  Math.round(meta.playerMiles),
        totalMileage:      Math.round(meta.totalMiles),
        partnershipType:   meta.partnerType,
      });
    }
  }

  return { totalRevenue, totalPax, entries };
}

/**
 * Compute how much partnership health decay to apply this week.
 * Decay fires when the player operates a direct route that competes with a
 * joint-venture partner's connecting traffic.
 *
 * @param {Connection[]}  connections
 * @param {Map}           partnershipMap   - { competitorId → type }
 * @returns {{ [competitorId]: number }}  health points to subtract (0–10 per route)
 */
export function computePartnerHealthDecay(connections, partnershipMap) {
  const decay = {};

  for (const conn of connections) {
    if (!conn.directExists) continue;

    // Only matters when a partner is involved
    const partnerIds = [conn.leg1PartnerId, conn.leg2PartnerId].filter(Boolean);
    if (partnerIds.length === 0) continue;

    for (const pid of partnerIds) {
      const pType = partnershipMap.get(pid);
      if (!pType) continue;

      // Stronger partnerships feel more betrayed by a competing direct
      const decayPerRoute = {
        jointVenture: 8,   // JV partners lose serious trust
        codeshare:    4,
        alliance:     2,
        interline:    1,
      }[pType] ?? 1;

      // Scale by how much demand the direct actually siphons
      const siphonedFraction = conn.directShare;
      const effectiveDecay   = Math.round(decayPerRoute * siphonedFraction);

      decay[pid] = (decay[pid] ?? 0) + effectiveDecay;
    }
  }

  return decay;
}

// ─── Preview helper (for RoutePlanner UI) ────────────────────────────────────

/**
 * getCannibalizationPreview
 *
 * Call this BEFORE the player commits to launching a new direct route.
 * Returns a summary of which existing connections would be affected, how much
 * connecting pax would shift to the direct, and the estimated revenue impact.
 *
 * @param {object}  prospectiveRoute   - { origin, destination, ticketPrice?, weeklyFrequency? }
 * @param {Array}   playerRoutes       - current state.routes
 * @param {Array}   competitors        - state.competitors
 * @param {Map}     partnershipMap     - from buildPartnershipMap
 * @returns {{
 *   affectedConnections: Connection[],
 *   totalStealPax:       number,
 *   totalStealRevenue:   number,
 *   partnerRisk:         { competitorId: string, type: string, decayPoints: number }[],
 *   summary:             string,
 * }}
 */
export function getCannibalizationPreview(
  prospectiveRoute,
  playerRoutes,
  competitors,
  partnershipMap
) {
  const { origin, destination } = prospectiveRoute;
  const directKey = [origin, destination].sort().join('-');

  // Temporarily add the prospective route to the player network
  const augmentedRoutes = [
    ...playerRoutes,
    {
      origin,
      destination,
      weeklyFrequency: prospectiveRoute.weeklyFrequency ?? 7,
      ticketPrice:     prospectiveRoute.ticketPrice ?? referencePrice(origin, destination),
    },
  ];

  // Build connections with the new route included
  const connections    = buildAllConnections(augmentedRoutes, competitors, partnershipMap);

  // Filter to only connections that are affected by THIS new direct route
  const affected = connections.filter(
    c => c.directExists && [c.legOneOrigin, c.legTwoDest].sort().join('-') === directKey
  );

  const LOAD_FACTOR = 0.72;
  let totalStealPax     = 0;
  let totalStealRevenue = 0;

  for (const c of affected) {
    const stolenPax = Math.round(c.odDemand * c.directShare * LOAD_FACTOR);
    const price     = prospectiveRoute.ticketPrice ?? referencePrice(origin, destination) ?? c.totalPrice;
    totalStealPax     += stolenPax;
    totalStealRevenue += stolenPax * price;
  }

  // Partner risk
  const partnerRisk = [];
  const decayMap    = computePartnerHealthDecay(affected, partnershipMap);
  for (const [pid, pts] of Object.entries(decayMap)) {
    const pType = partnershipMap.get(pid);
    partnerRisk.push({ competitorId: pid, type: pType, decayPoints: pts });
  }

  // Human-readable summary
  const hasPartnerRisk = partnerRisk.length > 0;
  const summary = affected.length === 0
    ? 'No existing connections compete with this route.'
    : `This route competes with ${affected.length} connection(s) through your hubs, `
      + `diverting ~${totalStealPax} pax/week to the direct. `
      + (hasPartnerRisk
        ? `⚠️ Strains relationship with ${partnerRisk.map(r => r.competitorId).join(', ')}.`
        : 'No partner relationships affected.');

  return {
    affectedConnections: affected,
    totalStealPax,
    totalStealRevenue,
    partnerRisk,
    summary,
  };
}

// ─── Hub competition ──────────────────────────────────────────────────────────

/** Competitor quality factor by carrier tier for presence weighting. */
const COMP_TIER_FACTOR = { budget: 0.7, legacy: 1.0, premium: 1.2 };

/** Routes a competitor operates touching an airport. */
function competitorRoutesAt(comp, code) {
  let n = 0;
  for (const key of Object.keys(comp.routes ?? {})) {
    const [a, b] = key.split('-');
    if (a === code || b === code) n++;
  }
  return n;
}

/**
 * Build the hub contest map: for each player-designated airport, how contested
 * is the connecting-traffic pool? A competitor "hubs" at an airport when it's
 * their homeHub or they operate 6+ routes there.
 *
 *   playerWeight = playerRoutesAt × (1 + captureRate(tier))
 *   compWeight   = competitorRoutesAt × tierFactor (budget 0.7 / legacy 1.0 / premium 1.2)
 *   contestFactor = playerWeight / (playerWeight + Σ compWeights)
 *
 * @returns {{ [code]: { playerShare, contestFactor, compWeight, rivals: [{id,name,weight}] } }}
 */
export function buildHubContestMap(competitors = [], routeCountByAirport = {}, hubs = {}) {
  const map = {};
  for (const [code, hubData] of Object.entries(hubs)) {
    const tierDef      = HUB_TIERS[hubData?.tier] ?? HUB_TIERS[1];
    const playerRoutes = routeCountByAirport[code] ?? 0;
    const playerWeight = Math.max(0.5, playerRoutes) * (1 + (tierDef.captureRate ?? 0));

    let compSum = 0;
    const rivals = [];
    for (const comp of competitors) {
      const routesAt = competitorRoutesAt(comp, code);
      if (routesAt === 0) continue;
      const isHubbed = comp.homeHub === code || routesAt >= 6;
      if (!isHubbed) continue;
      const w = routesAt * (COMP_TIER_FACTOR[comp.tier] ?? 1.0);
      compSum += w;
      rivals.push({ id: comp.id, name: comp.name, weight: +w.toFixed(1) });
    }

    const share = playerWeight / (playerWeight + compSum);
    map[code] = {
      playerShare:   +share.toFixed(3),
      contestFactor: +share.toFixed(3),
      compWeight:    +compSum.toFixed(1),
      rivals:        rivals.sort((a, b) => b.weight - a.weight),
    };
  }
  return map;
}


// ─── Itinerary quality (HUB_CONNECTIVITY_PLAN.md Phase 3) ────────────────────
//
// What a stop costs the traveller, and what a connection sells for. Both
// apply to EVERY connecting offer — own-metal, partner-fed and rival one-stop —
// so no carrier's connection is scored by a different rule.

/** The trip-time ratio the per-tier connection penalties were calibrated for: a
 *  typical long-haul stop (JFK–AMS via FRA ≈ 1.37). */
export const CONNECTION_TIME_BASE = 1.35;
/** Hours a connection adds at the hub: minimum connect time plus the second leg's taxi and climb. */
export const CONNECT_TIME_HOURS = 1.5;
/** Clamp on the penalty scaling — an on-the-way stop earns a small discount, a doubling stop pays up to 2.5×. */
export const CONNECTION_TIME_FACTOR_MIN = 0.8;
export const CONNECTION_TIME_FACTOR_MAX = 2.5;
/** A connection sells at no more than this × the nonstop reference fare (decision 2, Phase 3). */
export const THROUGH_FARE_INDEX = 1.0;

const APPROX_CRUISE_KMH = 800, APPROX_LEG_OVERHEAD_H = 0.5;
/** Fleet-independent block time for pricing a stop — not the scheduling model. */
export function approxBlockHours(km) {
  return (km || 0) / APPROX_CRUISE_KMH + APPROX_LEG_OVERHEAD_H;
}

/**
 * (block A→H + connect time + block H→C) ÷ block A→C. Circuity lives inside
 * this: a longer path is a longer trip. MIA–ATL via MCO ≈ 2.2 (the stop doubles
 * a 90-minute sector); JFK–AMS via FRA ≈ 1.4.
 */
export function connectionTimeRatio(origin, hub, dest) {
  const direct = routeDistance(origin, dest);
  if (!(direct > 0)) return CONNECTION_TIME_BASE;
  const via = approxBlockHours(routeDistance(origin, hub)) + CONNECT_TIME_HOURS + approxBlockHours(routeDistance(hub, dest));
  return via / approxBlockHours(direct);
}

/** The tier / partnership penalty scaled by how much of the traveller's time the stop costs. */
/**
 * How much more a connection is disliked than the tier/partnership base
 * penalties say. Those bases date from when the only connections in the game
 * were the player's own, priced at the sum of their legs and so rarely
 * competitive; at equal fare they let a one-stop over a Major Hub take ~42%
 * of a pair against a nonstop. Airline QSI practice puts a one-stop at a
 * fifth to a third of a nonstop's preference. ×2 lands at ~35% for a typical
 * stop and ~15% for one that doubles the trip. Measured balance-neutral on a
 * dense network (connections there are seat-bound, not preference-bound —
 * HUB_CONNECTIVITY_PLAN.md §0); it bites where seats are not scarce, which is
 * where a connection beating a half-empty nonstop was visibly wrong.
 * Modern rule only — the legacy path never calls this.
 */
export const CONNECTION_PENALTY_SCALE = 2;

export function connectionPenaltyFor(basePenalty, timeRatio) {
  const f = Math.min(CONNECTION_TIME_FACTOR_MAX, Math.max(CONNECTION_TIME_FACTOR_MIN, timeRatio / CONNECTION_TIME_BASE));
  return basePenalty * f * CONNECTION_PENALTY_SCALE;
}

/**
 * A connection is priced against the NONSTOP market, not additively: the sum
 * of two leg fares on a triangle is structurally above the through reference,
 * and real carriers do not sell it that way. Never above the sum of legs.
 */
export function throughFare(sumOfLegs, origin, dest) {
  const ref = referencePrice(origin, dest);
  if (!(ref > 0)) return sumOfLegs;
  return Math.min(sumOfLegs, Math.round(ref * THROUGH_FARE_INDEX));
}

// ─── Rival one-stop itineraries (HUB_CONNECTIVITY_PLAN.md Phase 1b) ─────────
//
// Until this, the only airline in the game that sold a connection was the
// player. Rival hubs were three fudges (a connectivity bump on their nonstops,
// a contest factor on the player's external pool, a bump to the outside option
// in the player's connecting markets). Now a rival with a declared hub H flying
// A–H and H–C puts a real A→H→C offer into the A–C market — the player's
// nonstop market, their own-metal markets and their partner markets — through
// the same logit that books everyone else. Gated on state.rivalItineraries.

/** Routings longer than this × the nonstop distance are not sold (DOH between JFK and CDG). */
export const MAX_CIRCUITY = 1.5;

/** The prefix every rival one-stop offer id carries; the UI attributes share by it. */
export const RIVAL_CONN_PREFIX = '__rival_conn__';

/**
 * A rival airport's hub tier from its spoke count, on the PLAYER's own
 * `HUB_TIERS[t].routesRequired` thresholds (4 / 20 / 50) — null below tier 1.
 * The rule you live under is the rule they live under.
 */
export function rivalHubTierForSpokes(spokes) {
  let tier = null;
  for (const t of [1, 2, 3]) {
    if (spokes >= (HUB_TIERS[t]?.routesRequired ?? Infinity)) tier = t;
  }
  return tier;
}

/**
 * Index every rival's declared hubs and the legs radiating from them.
 *
 *   Map<competitorId, {
 *     rival,
 *     legs:   Map<hub, Map<spoke, routeConfig>>,   // every hub the rival declares
 *     tierAt: Map<hub, tier>,                      // only hubs that qualify
 *   }>
 *
 * Declared hubs only (decision 1): an AI carrier's `homeHub` and earned
 * `secondaryHub`; a human rival's designated `hubs` map when the rival view
 * carries one (Phase 5), else its `homeHub`. A human hub keeps its real
 * designated tier (a focus city is a tier-0 connection point, as it is for you);
 * an AI hub is tiered by spoke count. Built once per tick; ~0.2 ms for a full
 * AI bank.
 */
export function buildRivalHubIndex(competitors = []) {
  const idx = new Map();
  for (const c of competitors ?? []) {
    if (!c?.id || !c.routes) continue;
    const declared = c.hubs && typeof c.hubs === 'object'
      ? Object.keys(c.hubs)
      : [c.homeHub, c.secondaryHub].filter(Boolean);
    if (declared.length === 0) continue;
    const hubSet = new Set(declared);
    const legs = new Map();
    for (const [key, cfg] of Object.entries(c.routes)) {
      if (!cfg) continue;
      const [a, b] = key.split('-');
      for (const h of [a, b]) {
        if (!hubSet.has(h)) continue;
        const spoke = h === a ? b : a;
        if (!legs.has(h)) legs.set(h, new Map());
        // Leg fare resolved ONCE here, not per market lookup: a 75-carrier
        // world asks for ~1,500 O&Ds a tick and referencePrice is the cost.
        legs.get(h).set(spoke, { ...cfg, legPrice: rivalLegPrice(cfg, h, spoke) });
      }
    }
    const tierAt = new Map();
    for (const [h, m] of legs) {
      const designated = c.hubs?.[h]?.tier;
      const tier = designated != null ? designated : rivalHubTierForSpokes(m.size);
      if (tier != null && m.size >= 2) tierAt.set(h, tier);
    }
    idx.set(c.id, { rival: c, legs, tierAt });
  }
  // Second key: spoke → the (rival, hub) pairs that fly it. A market lookup then
  // walks only the hubs its ORIGIN is a spoke of, not every hub in the world.
  const bySpoke = new Map();
  for (const entry of idx.values()) {
    for (const [h] of entry.tierAt) {
      for (const spoke of entry.legs.get(h).keys()) {
        if (!bySpoke.has(spoke)) bySpoke.set(spoke, []);
        bySpoke.get(spoke).push({ entry, hub: h });
      }
    }
  }
  idx.bySpoke = bySpoke;
  return idx;
}

// One index per competitors array per tick / render. The array's identity is
// stable within a tick and changes on every new state, which is exactly the
// cache lifetime we want.
const RIVAL_INDEX_CACHE = new WeakMap();

/**
 * The hub-connectivity package (HUB_CONNECTIVITY_PLAN.md) is ONE switch,
 * `state.rivalItineraries`. Off means the whole package is off — rival
 * one-stops, through-fares, the time-scaled connection penalty, partner feed
 * in real seats, AND the spill/choke rewrite of computeMarketShare — and a
 * world ticks byte-for-byte as it did before the package existed
 * (tools/golden-master/beta-world.mjs locks that). The existing beta worlds
 * run that way; the alphas and every new world run the package.
 */
export function hubPackageOn(state) {
  return state?.rivalItineraries === true;
}

/**
 * The value rivalIndexFor hands out when the package is OFF. A real object,
 * not null, so "the caller passed nothing" (tests, tools: modern rules, no
 * rivals) and "the world is off" (legacy rules) can never be confused.
 */
export const RIVALS_OFF = Object.freeze({ off: true, size: 0, bySpoke: new Map() });
const EMPTY_RIVAL_INDEX = Object.freeze({ off: false, size: 0, bySpoke: new Map() });

/** True when `rivalIndex` says the world runs the OLD rules (came from an off world). */
export function isLegacy(rivalIndex) { return rivalIndex?.off === true; }
/** True when the package is on and a rival index (possibly empty) was supplied. */
export function rivalsOn(rivalIndex) { return rivalIndex != null && rivalIndex.off !== true; }

/**
 * The rival hub index for this state: RIVALS_OFF when the package is off, an
 * empty index when it is on but nobody else is in the world yet (still the
 * modern rules), else the built index. Every call site that can put a rival
 * offer into a market takes this.
 */
export function rivalIndexFor(state) {
  if (!hubPackageOn(state)) return RIVALS_OFF;
  const comps = state.competitors;
  if (!Array.isArray(comps) || comps.length === 0) return EMPTY_RIVAL_INDEX;
  let idx = RIVAL_INDEX_CACHE.get(comps);
  if (!idx) { idx = buildRivalHubIndex(comps); RIVAL_INDEX_CACHE.set(comps, idx); }
  return idx;
}

/** Seats per flight a rival leg carries, from whatever its config publishes. */
function rivalLegSeats(rival, cfg) {
  if (cfg.seatsPerWeek != null && cfg.frequency > 0) return Math.round(cfg.seatsPerWeek / cfg.frequency);
  if (cfg.seats != null) return cfg.seats;
  const t = cfg.aircraftType ? getAircraftType(cfg.aircraftType) : null;
  return t?.seats ?? TIER_SEAT_TARGET[rival.tier] ?? 180;
}

/** A rival leg's economy fare: the published fare for a human, ref × multiplier for an AI. */
function rivalLegPrice(cfg, a, b) {
  if (cfg.economyFare != null) return Math.max(1, Math.round(cfg.economyFare));
  return Math.round(referencePrice(a, b) * (cfg.priceMultiplier ?? 1));
}

/**
 * The rival one-stop offer for one routing — §3.3 of the plan. Mirrors the
 * player's own `__own_conn__` offer line for line: sum-of-legs fare (decision 2;
 * through-fares are Phase 3), the thinner leg's frequency, the tier's
 * connecting seat fraction of the thinner leg's seats, the rival's own quality
 * plus half the tier bonus, and the tier's connection penalty as the
 * connectivity term. `via` carries what the UI needs to name the routing.
 */
export function buildRivalConnectionOffer(rival, hub, tier, legIn, legOut, market, circuity) {
  const tierDef = HUB_TIERS[tier] ?? HUB_TIERS[1];
  const pIn  = legIn.legPrice  ?? rivalLegPrice(legIn,  market.origin, hub);
  const pOut = legOut.legPrice ?? rivalLegPrice(legOut, hub, market.destination);
  const economyPrice = throughFare(pIn + pOut, market.origin, market.destination);
  const timeRatio = connectionTimeRatio(market.origin, hub, market.destination);
  const freq = Math.min(legIn.frequency ?? 0, legOut.frequency ?? 0);
  if (!(freq > 0)) return null;
  const seatFraction = ({ 0: 0.10, 1: 0.15, 2: 0.18, 3: 0.22 })[tier] ?? CONNECTING_SEAT_FRACTION;
  const thinnerSeats = Math.min(
    (legIn.frequency ?? 0)  * rivalLegSeats(rival, legIn),
    (legOut.frequency ?? 0) * rivalLegSeats(rival, legOut));
  const econSeats = Math.max(1, Math.round(thinnerSeats * seatFraction));
  const bizSeats  = Math.max(1, Math.round(econSeats * 0.13));
  return {
    airlineId:         `${RIVAL_CONN_PREFIX}${rival.id}__${hub}`,
    origin:            market.origin,
    destination:       market.destination,
    economyPrice,
    businessPrice:     Math.round(economyPrice * BUSINESS_PRICE_MULTIPLIER),
    weeklyFrequency:   freq,
    seatsPerFlight:    ASSUMED_SEATS_PER_FLIGHT,
    economySeats:      econSeats,
    businessSeats:     bizSeats,
    totalSeats:        econSeats + bizSeats,
    qualityScore:      (rival.baseQualityScore ?? 60) + Math.round((tierDef.qualityBonus ?? 0) / 2) + (rival.allianceId ? 3 : 0),
    connectivityBonus: -connectionPenaltyFor(tierDef.connPenalty ?? CONNECTION_PENALTY.ownMetal, timeRatio),
    via: { competitorId: rival.id, name: rival.name, hub, tier, circuity, timeRatio, legInPrice: pIn, legOutPrice: pOut },
  };
}

/**
 * Every rival one-stop routing sold in this market. For each rival, for each
 * qualifying hub H not at either end: it must fly both A–H and H–C, must NOT fly
 * A–C nonstop (its nonstop already speaks for it), and the routing must not
 * exceed MAX_CIRCUITY. ~140 set probes per market against a full AI bank.
 */
export function rivalOneStopOffersFor(rivalIndex, market) {
  if (!rivalIndex || rivalIndex.size === 0) return [];
  const A = market.origin, C = market.destination;
  const key = [A, C].sort().join('-');
  const direct = routeDistance(A, C) || 0;
  const out = [];
  for (const { entry, hub: h } of (rivalIndex.bySpoke?.get(A) ?? [])) {
    const { rival, legs, tierAt } = entry;
    if (h === A || h === C) continue;
    if (rival.routes?.[key]) continue;                // their nonstop speaks
    const m = legs.get(h);
    const legIn = m.get(A), legOut = m.get(C);
    if (!legIn || !legOut) continue;
    const tier = tierAt.get(h);
    const circuity = direct > 0
      ? ((routeDistance(A, h) || 0) + (routeDistance(h, C) || 0)) / direct
      : Infinity;
    if (!(circuity <= MAX_CIRCUITY)) continue;
    const offer = buildRivalConnectionOffer(rival, h, tier, legIn, legOut, market, circuity);
    if (offer) out.push(offer);
  }
  return out;
}

// ─── Own-metal itinerary revenue ─────────────────────────────────────────────

/** Max own-metal O&D markets scored per hub per tick (perf guard; sorted by demand). */
const MAX_OWN_METAL_ODS_PER_HUB = 150;

/**
 * How many own-metal itineraries the weekly report keeps for the UI, per hub and
 * in total. The full list is far too big to persist inside lastReport.
 */
export const OWN_METAL_ENTRIES_PER_HUB = 15;
export const OWN_METAL_ENTRIES_CAP     = 120;

/**
 * Trim ownMetalOD.entries for storage WITHOUT starving a hub.
 *
 * A flat global top-N sorted by revenue is what the report used to do, and it
 * silently emptied secondary hubs: one long-haul market out-earns a dozen
 * regional ones, so a mega-hub's markets fill the whole quota and a domestic hub
 * carrying thousands of connecting pax keeps ZERO entries. Every UI that lists
 * itineraries (AirportDetail's transit card, the HubManagement hub card) reads
 * this array, so those hubs were told "no passengers connected here last week"
 * while byHub reported thousands.
 *
 * Round-robin instead: every hub gets its best market before any hub gets its
 * second, so the cap costs a hub depth, never presence. Output stays sorted by
 * revenue — callers filter by hub and slice.
 */
export function trimOwnMetalEntries(entries = [], perHub = OWN_METAL_ENTRIES_PER_HUB, cap = OWN_METAL_ENTRIES_CAP) {
  const byHub = new Map();
  for (const e of entries) {                 // input is already revenue-sorted
    const list = byHub.get(e?.hub) ?? [];
    if (list.length < perHub) { list.push(e); byHub.set(e?.hub, list); }
  }
  const kept = [];
  for (let round = 0; round < perHub && kept.length < cap; round++) {
    for (const list of byHub.values()) {
      if (round < list.length && kept.length < cap) kept.push(list[round]);
    }
  }
  return kept.sort((a, b) => (b?.revenue ?? 0) - (a?.revenue ?? 0));
}

/**
 * Compute own-metal connecting revenue from real A→hub→C itineraries.
 *
 * Replaces the old abstract "internal feed" pool: each own-metal connection
 * (both legs player metal) over a DESIGNATED hub/focus city competes for its
 * O&D market against competitor nonstops and the outside option, through the
 * same discrete-choice model the partner-feed path uses. Captured revenue is
 * split across the two legs by mileage; captured pax occupy seats on BOTH legs
 * (simulation.js applies per-leg capacity coupling).
 *
 * Tier effects: connection penalty (HUB_TIERS[tier].connPenalty), a quality
 * nudge from the tier bonus, gate congestion at the hub, and competitor hub
 * contest (stronger outside option at contested hubs).
 *
 * @param {Connection[]} connections     - from buildAllConnections
 * @param {object}   options
 * @param {object}   options.hubs                  - { [code]: { tier } } designated only
 * @param {object}   [options.gameDate]
 * @param {Map}      [options.competitorRouteIndex]
 * @param {object}   [options.contestMap]          - from buildHubContestMap
 * @param {object}   [options.routeCountByAirport]
 * @param {object}   [options.gates]               - { [code]: gateCount }
 * @returns {{
 *   totalRevenue: number,
 *   totalPax:     number,
 *   byRouteKey:   { [routeKey]: { pax, revenue, feeds: [{od, viaHub, pax, revenue}] } },
 *   byHub:        { [hub]: { pax, revenue, markets: number } },
 *   entries:      [{ od, hub, pax, revenue, share }],
 * }}
 */
/**
 * Bi-directional own-metal connection enumeration.
 *
 * A player route is a ROUND TRIP: the aircraft flies origin→dest AND dest→origin
 * every week, and simulateRoute already sells both directions (revenue ×2,
 * flights = weeklyFrequency × 2). The direct-passenger model therefore treats
 * every route as bidirectional — but buildAllConnections / findConnectionsAtHub
 * classify a leg as inbound- OR outbound-only by its STORED origin/destination.
 * That makes own-metal connecting itineraries vanish whenever a player's spokes
 * are stored with a consistent orientation (e.g. every route as hub→spoke): the
 * hub then has zero "inbound" legs, so no A→hub→C markets are formed and the
 * connecting-pax KPI collapses to the tiny external-gateway feed alone.
 *
 * This helper lets every player route serve as EITHER leg at a hub, aggregates
 * frequency/price per (hub, spoke), and emits each unordered A↔hub↔C market once
 * (demand + price are symmetric between two airports), keeping the connecting
 * count one-way-consistent with the direct model. It feeds computeOwnMetalODRevenue
 * only; partner/interline feed is unchanged and still flows through buildAllConnections.
 */
export function buildOwnMetalConnections(playerRoutes = []) {
  const legs = expandRoutesToLegs(playerRoutes);
  const directRouteKeys = new Set(legs.map(r => [r.origin, r.destination].sort().join('-')));

  // Aggregate hub-adjacent frequency/price per (airport, spoke). Each round-trip
  // leg contributes to BOTH of its endpoints' spoke lists.
  const atAirport = new Map(); // airport -> Map(spoke -> { freq, priceFreqSum, tagParents:Set })
  const add = (airport, spoke, freq, price, tagId) => {
    if (!atAirport.has(airport)) atAirport.set(airport, new Map());
    const m = atAirport.get(airport);
    const e = m.get(spoke) ?? { freq: 0, priceFreqSum: 0, tagParents: new Set() };
    e.freq += freq;
    e.priceFreqSum += price * freq;
    if (tagId) e.tagParents.add(tagId);
    m.set(spoke, e);
  };
  for (const leg of legs) {
    const f = leg.weeklyFrequency ?? 7;
    const p = leg.ticketPrice ?? referencePrice(leg.origin, leg.destination);
    add(leg.origin,      leg.destination, f, p, leg._tagParentId);
    add(leg.destination, leg.origin,      f, p, leg._tagParentId);
  }

  const connections = [];
  for (const [hub, spokeMap] of atAirport) {
    const spokes = [...spokeMap.entries()].map(([spoke, e]) => ({
      spoke, freq: e.freq, price: e.priceFreqSum / Math.max(e.freq, 1), tagParents: e.tagParents,
    }));
    if (spokes.length < 2) continue;
    for (let i = 0; i < spokes.length; i++) {
      for (let j = i + 1; j < spokes.length; j++) {
        const a = spokes[i], b = spokes[j];
        if (a.spoke === b.spoke) continue;
        // A through tag service already sells this O&D — don't double-book it.
        let sharedTag = false;
        for (const t of a.tagParents) { if (b.tagParents.has(t)) { sharedTag = true; break; } }
        if (sharedTag) continue;

        // Canonical (sorted) O&D so each market is emitted exactly once.
        const [origin, dest] = a.spoke < b.spoke ? [a.spoke, b.spoke] : [b.spoke, a.spoke];
        const legO = origin === a.spoke ? a : b;
        const legD = dest   === a.spoke ? a : b;

        const odDemand = baseCityPairDemand(origin, dest);
        if (!odDemand || odDemand < MIN_OD_DEMAND_PAX) continue;

        const directKey    = [origin, dest].sort().join('-');
        const directExists = directRouteKeys.has(directKey);
        const totalPrice   = legO.price + legD.price;
        const refP         = referencePrice(origin, dest) || totalPrice;
        const minFreq      = Math.min(legO.freq, legD.freq);

        const penalty     = CONNECTION_PENALTY.ownMetal;
        const connectUtil = -penalty
                            - PRICE_WEIGHT * (totalPrice / Math.max(refP, 1))
                            + FREQ_WEIGHT  * Math.log1p(minFreq);
        let connectionShare = 1.0;
        if (directExists) {
          const directUtil = -PRICE_WEIGHT * 1.0 + FREQ_WEIGHT * Math.log1p(7);
          const mx = Math.max(connectUtil, directUtil);
          const eC = Math.exp(connectUtil - mx);
          const eD = Math.exp(directUtil  - mx);
          connectionShare = eC / (eC + eD);
        }

        connections.push({
          hub,
          legOneOrigin: origin, legOneDest: hub, legTwoDest: dest,
          leg1Owner: 'player', leg2Owner: 'player', partnershipType: 'ownMetal',
          leg1Freq: legO.freq, leg2Freq: legD.freq,
          leg1Price: legO.price, leg2Price: legD.price,
          totalPrice, odDemand, directExists,
          connectionShare, directShare: 1 - connectionShare,
        });
      }
    }
  }
  return connections;
}

export function computeOwnMetalODRevenue(connections, options = {}) {
  const {
    hubs = {},
    gameDate = { month: 6 },
    competitorRouteIndex = null,
    contestMap = {},
    routeCountByAirport = {},
    slotsByAirport = {},
    gates = {},
    demandMultFor = null,   // (origin, dest) → world-event demand multiplier
    rivalIndex = undefined, // rivalIndexFor(state): RIVALS_OFF = old rules, undefined = modern, no rivals
  } = options;
  const legacy = isLegacy(rivalIndex);

  const byRouteKey = {};
  const byHub      = {};
  const entries    = [];
  let totalRevenue = 0;
  let totalPax     = 0;

  // Own-metal connections over designated hubs only.
  const eligible = connections.filter(c =>
    c.leg1Owner === 'player' && c.leg2Owner === 'player' && hubs[c.hub]?.tier != null
  );
  if (eligible.length === 0) {
    return { totalRevenue, totalPax, byRouteKey, byHub, entries };
  }

  // Perf guard: keep only the top-N ODs per hub by gravity demand.
  const perHubCount = {};
  const kept = [];
  const sorted = [...eligible].sort((a, b) => b.odDemand - a.odDemand);
  for (const c of sorted) {
    const n = perHubCount[c.hub] ?? 0;
    if (n >= MAX_OWN_METAL_ODS_PER_HUB) continue;
    perHubCount[c.hub] = n + 1;
    kept.push(c);
  }

  // Group by directional O&D so multiple routings (different hubs) share one market.
  const byOD = new Map();
  for (const conn of kept) {
    const dirKey = `${conn.legOneOrigin}-${conn.legTwoDest}`;
    if (!byOD.has(dirKey)) byOD.set(dirKey, []);
    // Dedupe same hub+OD enumerations
    const group = byOD.get(dirKey);
    if (!group.some(c => c.hub === conn.hub)) group.push(conn);
  }

  for (const [dirKey, conns] of byOD) {
    const [origin, dest] = dirKey.split('-');
    const odKey  = [origin, dest].sort().join('-');
    const market = buildRouteMarket(origin, dest, gameDate, 1,
      demandMultFor ? demandMultFor(origin, dest) : 1);
    if (!market.baseWeeklyDemand) continue;

    // One offer per routing (per hub), all competing in the same market.
    const offers = [];
    const meta   = new Map();
    const economyPriceOf = new Map();
    let i = 0;
    // Contest raises the outside option once per market: use the strongest
    // rival presence among the hubs involved.
    let maxCompWeight = 0;

    for (const conn of conns) {
      const tier    = hubs[conn.hub].tier;
      const tierDef = HUB_TIERS[tier] ?? HUB_TIERS[1];
      const basePenalty = tierDef.connPenalty ?? CONNECTION_PENALTY.ownMetal;
      const penalty = legacy ? basePenalty : connectionPenaltyFor(basePenalty,
        connectionTimeRatio(conn.legOneOrigin, conn.hub, conn.legTwoDest));

      const minFreq = Math.min(conn.leg1Freq, conn.leg2Freq);
      // Better transfer products reserve more of each leg's inventory for
      // connections (banked schedules, protected connect blocks) — this keeps
      // tiers differentiated even in capacity-capped markets.
      const seatFraction = ({ 0: 0.10, 1: 0.15, 2: 0.18, 3: 0.22 })[tier] ?? CONNECTING_SEAT_FRACTION;
      const econSeats = Math.max(1, Math.round(minFreq * ASSUMED_SEATS_PER_FLIGHT * seatFraction));
      const economyPrice = legacy ? conn.totalPrice : throughFare(conn.totalPrice, conn.legOneOrigin, conn.legTwoDest);

      const offer = {
        airlineId:         `__own_conn__${i++}`,
        origin:            market.origin,
        destination:       market.destination,
        economyPrice,
        businessPrice:     Math.round(economyPrice * BUSINESS_PRICE_MULTIPLIER),
        weeklyFrequency:   minFreq,
        seatsPerFlight:    ASSUMED_SEATS_PER_FLIGHT,
        economySeats:      econSeats,
        businessSeats:     Math.max(1, Math.round(econSeats * 0.13)),
        qualityScore:      CONNECTION_QUALITY_SCORE + Math.round((tierDef.qualityBonus ?? 0) / 2),
        connectivityBonus: -penalty,
      };
      offers.push(offer);
      meta.set(offer.airlineId, { conn, tier });
      economyPriceOf.set(offer.airlineId, economyPrice);

      maxCompWeight = Math.max(maxCompWeight, contestMap[conn.hub]?.compWeight ?? 0);
    }
    if (offers.length === 0) continue;

    // Competitor nonstops, rival one-stops over THEIR hubs, and the outside
    // option. Without rival itineraries the outside option is bumped at
    // contested hubs to stand in for the rival connections it cannot see; with
    // them, those connections are real offers and the bump would count twice.
    for (const competitor of (competitorRouteIndex?.get(odKey) ?? [])) {
      const compOffer = buildCompetitorOffer(competitor, market);
      if (compOffer) offers.push(compOffer);
    }
    if (rivalsOn(rivalIndex)) offers.push(...rivalOneStopOffersFor(rivalIndex, market));
    const outside = buildOutsideOptionOffer(market);
    if (!rivalsOn(rivalIndex)) outside.connectivityBonus += 0.15 * Math.log1p(maxCompWeight / 10);
    offers.push(outside);

    const results = computeMarketShare(market, offers, { legacy });
    for (const r of results) {
      const m = meta.get(r.airlineId);
      if (!m) continue;
      const { conn, tier } = m;

      // Player's own direct on this O&D steals per the logit split (this replaces
      // the blunt per-routeKey cannibalization multiplier for own-metal flows).
      const directFactor = conn.directExists ? conn.connectionShare : 1.0;
      // Gate congestion at the hub throttles transfer capacity (slot-based:
      // weekly departures vs gate slot capacity, not raw route count).
      const congestion = hubCongestionFactor(
        slotsByAirport[conn.hub] ?? 0, gates[conn.hub] ?? 0, tier
      );

      const pax = Math.round(r.totalPax * CONNECTION_LOAD_FACTOR * directFactor * congestion);
      if (pax <= 0) continue;
      const revenue = Math.round(r.totalRevenue * CONNECTION_LOAD_FACTOR * directFactor * congestion);

      // Split revenue across legs by mileage; pax occupy BOTH legs.
      const leg1Miles = routeDistance(conn.legOneOrigin, conn.hub) || 1;
      const leg2Miles = routeDistance(conn.hub, conn.legTwoDest)   || 1;
      const leg1Share = leg1Miles / (leg1Miles + leg2Miles);
      const leg1Key   = [conn.legOneOrigin, conn.hub].sort().join('-');
      const leg2Key   = [conn.hub, conn.legTwoDest].sort().join('-');
      const od        = `${conn.legOneOrigin}→${conn.legTwoDest}`;

      const addLeg = (key, legRevenue) => {
        if (!byRouteKey[key]) byRouteKey[key] = { pax: 0, revenue: 0, feeds: [] };
        byRouteKey[key].pax     += pax;
        byRouteKey[key].revenue += legRevenue;
        byRouteKey[key].feeds.push({ od, viaHub: conn.hub, pax, revenue: legRevenue });
      };
      addLeg(leg1Key, Math.round(revenue * leg1Share));
      addLeg(leg2Key, Math.round(revenue * (1 - leg1Share)));

      if (!byHub[conn.hub]) byHub[conn.hub] = { pax: 0, revenue: 0, markets: 0 };
      byHub[conn.hub].pax     += pax;
      byHub[conn.hub].revenue += revenue;
      byHub[conn.hub].markets += 1;

      totalRevenue += revenue;
      totalPax     += pax;
      entries.push({ od, hub: conn.hub, pax, revenue, ...(legacy ? {} : { fare: economyPriceOf.get(r.airlineId) ?? null }), share: +(r.leisureShare ?? 0).toFixed(4) });
    }
  }

  // Trim + sort feeds for UI friendliness
  for (const key of Object.keys(byRouteKey)) {
    byRouteKey[key].feeds.sort((a, b) => b.pax - a.pax);
    byRouteKey[key].feeds = byRouteKey[key].feeds.slice(0, 8);
  }
  entries.sort((a, b) => b.revenue - a.revenue);

  return { totalRevenue, totalPax, byRouteKey, byHub, entries };
}

// ─── Convenience: run all network calculations for a weekly tick ──────────────

/**
 * runNetworkTick
 *
 * Single entry point called by simulation.js once per ADVANCE_WEEK.
 * Returns everything the simulation needs to:
 *   1. Apply cannibalization to connecting demand (cannibalizationMap)
 *   2. Add partner O&D revenue (partnerODRevenue)
 *   3. Decay partnership health (partnerHealthDecay)
 *
 * @param {object}  state   - subset: { routes, competitors, allianceMembership,
 *                                      codeshareAgreements, allianceDef, jointVentures,
 *                                      gameDate }
 * @returns {{
 *   connections:        Connection[],
 *   cannibalizationMap: object,
 *   partnerODRevenue:   { totalRevenue: number, entries: PartnerODEntry[] },
 *   partnerHealthDecay: object,
 * }}
 */
export function runNetworkTick(state) {
  const {
    routes               = [],
    competitors          = [],
    allianceMembership   = null,
    codeshareAgreements  = [],
    allianceDef          = null,
    jointVentures        = {},
    gameDate             = { month: 6 },
    hubs                 = {},   // { [code]: { tier } } — designated hubs/focus cities
    gates                = {},   // { [code]: gateCount } — for congestion
    routeCountByAirport  = {},   // player routes per airport (contest / hub feed)
    slotsByAirport       = {},   // player weekly departures per airport (congestion)
    demandMultFor        = null, // (origin, dest) → world-event demand multiplier
    rivalIndex           = undefined, // rivalIndexFor(state): RIVALS_OFF = old rules, undefined = modern, no rivals
  } = state;

  const partnershipMap = buildPartnershipMap(
    allianceMembership,
    codeshareAgreements,
    allianceDef,
    jointVentures,
    competitors,
  );

  // Index every competitor by the O&D pairs they fly nonstop, so the partner-feed
  // model can pit the player's connections against real head-to-head competition.
  const competitorRouteIndex = buildCompetitorRouteIndex(competitors);

  const connections        = buildAllConnections(routes, competitors, partnershipMap);
  const cannibalizationMap = buildCannibalizationMap(connections);
  const partnerODRevenue   = computePartnerODRevenue(connections, {
    gameDate,
    competitorRouteIndex,
    demandMultFor,
    rivalIndex,
  });
  const partnerHealthDecay = computePartnerHealthDecay(connections, partnershipMap);

  // Hub competition: contested connecting pools at player-designated airports.
  const hubContestMap = buildHubContestMap(competitors, routeCountByAirport, hubs);

  // Own-metal itinerary revenue: real A→hub→C markets over designated hubs.
  // Enumerated bidirectionally (routes are round trips) so hub connectivity does
  // NOT depend on the stored origin/destination orientation of each spoke route.
  const ownMetalConnections = buildOwnMetalConnections(routes);
  const ownMetalOD = computeOwnMetalODRevenue(ownMetalConnections, {
    hubs,
    gameDate,
    competitorRouteIndex,
    contestMap: hubContestMap,
    routeCountByAirport,
    slotsByAirport,
    gates,
    demandMultFor,
    rivalIndex,
  });

  return {
    connections,
    cannibalizationMap,
    partnerODRevenue,
    partnerHealthDecay,
    hubContestMap,
    ownMetalOD,
  };
}
