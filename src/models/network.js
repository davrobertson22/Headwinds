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
} from './demand.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Utility penalty applied to a connecting itinerary vs a direct flight.
 * Higher value = passengers strongly prefer direct; connection loses more demand.
 * Scaled by partnership type: own metal is least punishing, bare interline most.
 */
export const CONNECTION_PENALTY = {
  ownMetal:      0.30,   // both legs on player aircraft — lounge, bag transfer, seamless
  jointVenture:  0.38,   // JV: coordinated schedules, shared revenue pool
  alliance:      0.50,   // alliance: coordinated but separate revenue
  codeshare:     0.60,   // codeshare: one ticket, different metal
  interline:     0.75,   // basic interline: separate tickets, minimal cooperation
};

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
export function buildPartnershipMap(allianceMembership, codeshareAgreements, allianceDef, jvRoutes = {}) {
  const map = new Map();

  // Alliance members (weaker than codeshare)
  if (allianceDef) {
    for (const id of (allianceDef.memberIds ?? [])) {
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
function buildPlayerConnectionOffer(conn, market) {
  const penalty   = CONNECTION_PENALTY[conn.partnershipType] ?? CONNECTION_PENALTY.interline;
  const minFreq   = Math.min(conn.leg1Freq, conn.leg2Freq);
  // Seats this O&D can realistically claim on the thinner leg, over the week.
  const econSeats = Math.max(
    1,
    Math.round(minFreq * ASSUMED_SEATS_PER_FLIGHT * CONNECTING_SEAT_FRACTION),
  );
  const economyPrice = conn.totalPrice;
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
 * @returns {{ totalRevenue: number, entries: PartnerODEntry[] }}
 */
export function computePartnerODRevenue(connections, options = {}) {
  const {
    gameDate = { month: 6 },
    competitorRouteIndex = null,
  } = options;

  const entries = [];
  let totalRevenue = 0;

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
    const market = buildRouteMarket(origin, dest, gameDate, 1);
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

      const offer = buildPlayerConnectionOffer(conn, market);
      offer.airlineId = `__player_conn__${i++}`;
      offers.push(offer);
      routingMeta.set(offer.airlineId, {
        conn, prorate, playerMiles, totalMiles,
        hub: conn.hub, partnerType,
        partnerLeg: playerLeg === 'leg1' ? 'leg2' : 'leg1',
      });
    }
    if (offers.length === 0) continue;

    // Competitor nonstops on this O&D + the ever-present outside option.
    for (const competitor of (competitorRouteIndex?.get(odKey) ?? [])) {
      const offer = buildCompetitorOffer(competitor, market);
      if (offer) offers.push(offer);
    }
    offers.push(buildOutsideOptionOffer(market));

    // Score the whole market once; sum the player's routings.
    const results = computeMarketShare(market, offers);
    for (const r of results) {
      const meta = routingMeta.get(r.airlineId);
      if (!meta) continue;   // competitor / outside option

      const pax = Math.round(r.totalPax * CONNECTION_LOAD_FACTOR);
      if (pax <= 0) continue;

      const grossItinRevenue = r.totalRevenue * CONNECTION_LOAD_FACTOR;
      const playerRevenue    = Math.round(grossItinRevenue * meta.prorate);

      totalRevenue += playerRevenue;
      entries.push({
        odKey,
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

  return { totalRevenue, entries };
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
  } = state;

  const partnershipMap = buildPartnershipMap(
    allianceMembership,
    codeshareAgreements,
    allianceDef,
    jointVentures,
  );

  // Index every competitor by the O&D pairs they fly nonstop, so the partner-feed
  // model can pit the player's connections against real head-to-head competition.
  const competitorRouteIndex = buildCompetitorRouteIndex(competitors);

  const connections        = buildAllConnections(routes, competitors, partnershipMap);
  const cannibalizationMap = buildCannibalizationMap(connections);
  const partnerODRevenue   = computePartnerODRevenue(connections, {
    gameDate,
    competitorRouteIndex,
  });
  const partnerHealthDecay = computePartnerHealthDecay(connections, partnershipMap);

  return {
    connections,
    cannibalizationMap,
    partnerODRevenue,
    partnerHealthDecay,
  };
}
