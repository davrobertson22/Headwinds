// ─── Multi-airport metro registry ─────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for "these airports serve the same city".
//
// WHY THIS EXISTS (2026-08 metro demand rework)
// ---------------------------------------------
// Before this module, every member airport of a multi-airport metro carried the
// FULL metro demand mass (every NYC airport had population 20.1, every London
// airport an effective 22), and nothing connected the airport pairs they formed:
// JFK–LHR, EWR–LHR, JFK–LGW and EWR–STN each independently generated a
// near-full-size New York↔London market. The true city-to-city demand was
// multiplied by the number of airport pairs served — the worst documented case
// (docs/DEMAND_MODEL_AUDIT.md, open question 1) was Tokyo↔Osaka at 4x.
//
// The fix has two halves, and this registry powers both:
//
//   1. DEMAND — baseCityPairDemand() prices a pair of metros ONCE, at the
//      registry's primary airports, so every member pair of the same metro pair
//      returns the SAME total market (the metro↔metro market).
//   2. POOLING — weeklyTick and the pairShare previews run ONE share fight per
//      metro pair: all routes on all member airport pairs (yours, AI carriers',
//      other humans') compete in that single pool. See metroPairKeyOf() /
//      memberPairKeysOf() below and the pre-pass in simulation.js.
//
// Each member airport also carries an APPEAL — how attractive that airport is
// to the metro's travellers for a given mission (domestic vs international,
// with an optional perimeter distance past which the appeal collapses, for
// LGA/DCA/LCY-style rule-bound fields). Appeal enters the share fight as a
// utility term and caps what a monopolist at a secondary field can capture:
// a lone route from Newburgh cannot hoover up the whole New York market, but a
// lone route from JFK can. See airportAppeal() and the notes in demand.js.
//
// Appeal values are calibrated loosely against each airport's real share of its
// metro's O&D traffic and its haul mix (LGA perimeter rule, LCY city-jet range,
// ITM/SDU/CGH/GMP/TSA/SHA domestic-bias, DCA perimeter). 1.0 = a full-service
// primary airport. They are RELATIVE within a metro: softmax turns the ratios
// into shares when several member airports are served.
//
// The registry deliberately replaces the old city-string matching in
// isSameMetro(): "same city field" wrongly zeroed demand between Columbus OH
// and Columbus GA (CMH–CSG), the two Norfolks (ORF–OFK), the Albanys (ALB–ABY),
// the Augustas (AGS–AUG), the Watertowns (ART–ATY) and the three Greenvilles
// (GSP/PGV/GLH). Same-name-different-city pairs now price normally; the
// same-metro suppression comes from this registry plus a small distance
// backstop (SAME_METRO_MAX_KM in market.js).
//
// Fields per metro:
//   id       stable slug (used in lane keys — never rename casually)
//   name     display name
//   primary  IATA code demand is priced at (mass, scores, distance, country)
//   members  { CODE: { dom, intl, perimeterKm? } }
//              dom         appeal on domestic pairs (0–1-ish)
//              intl        appeal on international pairs
//              perimeterKm appeal collapses (×PERIMETER_COLLAPSE) beyond this
//   lift     optional demand multiplier for the metro↔metro totals this metro
//            anchors (see METRO_PAIR_LIFT note in market.js). Default 1.
//
// Codes missing from data/airports.js are tolerated and simply ignored.

export const PERIMETER_COLLAPSE = 0.05;

export const METROS = [
  {
    id: 'nyc', name: 'New York', primary: 'JFK', lift: 1.8,
    members: {
      JFK: { dom: 0.95, intl: 1.0 },
      EWR: { dom: 0.90, intl: 0.85 },
      LGA: { dom: 1.0,  intl: 0.25, perimeterKm: 2400 },  // perimeter rule
      HPN: { dom: 0.20, intl: 0.05, perimeterKm: 2000 },
      SWF: { dom: 0.12, intl: 0.05 },
      ISP: { dom: 0.15, intl: 0.03 },
    },
  },
  {
    id: 'london', name: 'London', primary: 'LHR', lift: 1.6,
    members: {
      LHR: { dom: 0.90, intl: 1.0 },
      LGW: { dom: 0.85, intl: 0.75 },
      STN: { dom: 0.70, intl: 0.55 },
      LTN: { dom: 0.65, intl: 0.50 },
      LCY: { dom: 0.50, intl: 0.35, perimeterKm: 1600 },  // city-jet field
      SEN: { dom: 0.30, intl: 0.20 },
    },
  },
  {
    id: 'tokyo', name: 'Tokyo', primary: 'HND', lift: 1.25,
    members: {
      HND: { dom: 1.0,  intl: 0.95 },
      NRT: { dom: 0.35, intl: 0.85 },
    },
  },
  {
    id: 'seoul', name: 'Seoul', primary: 'GMP', lift: 1.1,
    members: {
      GMP: { dom: 1.0,  intl: 0.40, perimeterKm: 2100 },  // short-haul intl shuttle only
      ICN: { dom: 0.50, intl: 1.0 },
    },
  },
  {
    id: 'osaka', name: 'Osaka', primary: 'KIX', lift: 1.25,
    members: {
      KIX: { dom: 0.70, intl: 1.0 },
      ITM: { dom: 1.0,  intl: 0.05 },                     // domestic-only by policy
      UKB: { dom: 0.45, intl: 0.05 },
    },
  },
  {
    id: 'paris', name: 'Paris', primary: 'CDG', lift: 1.4,
    members: {
      CDG: { dom: 0.85, intl: 1.0 },
      ORY: { dom: 1.0,  intl: 0.60 },
      BVA: { dom: 0.15, intl: 0.25 },
    },
  },
  {
    id: 'chicago', name: 'Chicago', primary: 'ORD', lift: 1.3,
    members: {
      ORD: { dom: 1.0,  intl: 1.0 },
      MDW: { dom: 0.75, intl: 0.15 },
    },
  },
  {
    id: 'dallas', name: 'Dallas–Fort Worth', primary: 'DFW', lift: 1.15,
    members: {
      DFW: { dom: 1.0,  intl: 1.0 },
      DAL: { dom: 0.60, intl: 0.05 },
    },
  },
  {
    id: 'houston', name: 'Houston', primary: 'IAH', lift: 1.15,
    members: {
      IAH: { dom: 1.0,  intl: 1.0 },
      HOU: { dom: 0.75, intl: 0.20 },
    },
  },
  {
    id: 'washington', name: 'Washington–Baltimore', primary: 'IAD', lift: 1.3,
    members: {
      IAD: { dom: 0.80, intl: 1.0 },
      DCA: { dom: 1.0,  intl: 0.25, perimeterKm: 2000 },  // perimeter rule
      BWI: { dom: 0.90, intl: 0.35 },
      WAS: { dom: 0.10, intl: 0.05 },                      // legacy metro placeholder
    },
  },
  {
    id: 'sfbay', name: 'San Francisco Bay Area', primary: 'SFO', lift: 1.35,
    members: {
      SFO: { dom: 1.0,  intl: 1.0 },
      OAK: { dom: 0.60, intl: 0.15 },
      SJC: { dom: 0.65, intl: 0.20 },
    },
  },
  {
    id: 'losangeles', name: 'Greater Los Angeles', primary: 'LAX', lift: 1.5,
    members: {
      LAX: { dom: 1.0,  intl: 1.0 },
      BUR: { dom: 0.45, intl: 0.05 },
      SNA: { dom: 0.55, intl: 0.08 },
      ONT: { dom: 0.45, intl: 0.10 },
      LGB: { dom: 0.30, intl: 0.03 },
    },
  },
  {
    id: 'southflorida', name: 'South Florida', primary: 'MIA', lift: 1.3,
    members: {
      MIA: { dom: 0.85, intl: 1.0 },
      FLL: { dom: 1.0,  intl: 0.60 },
      PBI: { dom: 0.45, intl: 0.15 },
    },
  },
  {
    id: 'toronto', name: 'Toronto', primary: 'YYZ', lift: 1.15,
    members: {
      YYZ: { dom: 1.0,  intl: 1.0 },
      YTZ: { dom: 0.55, intl: 0.15, perimeterKm: 1500 },  // island field, props/regional
    },
  },
  {
    id: 'montreal', name: 'Montreal', primary: 'YUL',
    members: {
      YUL: { dom: 1.0,  intl: 1.0 },
      YHU: { dom: 0.10, intl: 0.05 },
    },
  },
  {
    id: 'riodejaneiro', name: 'Rio de Janeiro', primary: 'GIG', lift: 1.15,
    members: {
      GIG: { dom: 0.70, intl: 1.0 },
      SDU: { dom: 1.0,  intl: 0.05, perimeterKm: 1500 },  // downtown shuttle field
    },
  },
  {
    id: 'saopaulo', name: 'São Paulo', primary: 'GRU', lift: 1.2,
    members: {
      GRU: { dom: 0.90, intl: 1.0 },
      CGH: { dom: 1.0,  intl: 0.05, perimeterKm: 2500 },  // domestic shuttle field
      VCP: { dom: 0.55, intl: 0.15 },
    },
  },
  {
    id: 'buenosaires', name: 'Buenos Aires', primary: 'EZE', lift: 1.1,
    members: {
      EZE: { dom: 0.60, intl: 1.0 },
      AEP: { dom: 1.0,  intl: 0.30, perimeterKm: 3200 },  // downtown field, regional intl
    },
  },
  {
    id: 'moscow', name: 'Moscow', primary: 'SVO', lift: 1.25,
    members: {
      SVO: { dom: 1.0,  intl: 1.0 },
      DME: { dom: 0.90, intl: 0.85 },
      VKO: { dom: 0.70, intl: 0.60 },
    },
  },
  {
    id: 'istanbul', name: 'Istanbul', primary: 'IST', lift: 1.2,
    members: {
      IST: { dom: 1.0,  intl: 1.0 },
      SAW: { dom: 0.85, intl: 0.55 },
    },
  },
  {
    id: 'bangkok', name: 'Bangkok', primary: 'BKK', lift: 1.2,
    members: {
      BKK: { dom: 0.90, intl: 1.0 },
      DMK: { dom: 1.0,  intl: 0.45 },                     // LCC field
    },
  },
  {
    id: 'beijing', name: 'Beijing', primary: 'PEK', lift: 1.35,
    members: {
      PEK: { dom: 1.0,  intl: 1.0 },
      PKX: { dom: 0.90, intl: 0.85 },
    },
  },
  {
    id: 'shanghai', name: 'Shanghai', primary: 'SHA', lift: 1.35,
    members: {
      SHA: { dom: 1.0,  intl: 0.30, perimeterKm: 2400 },  // domestic + short intl shuttle
      PVG: { dom: 0.70, intl: 1.0 },
    },
  },
  {
    id: 'chengdu', name: 'Chengdu', primary: 'CTU', lift: 1.1,
    members: {
      CTU: { dom: 1.0,  intl: 0.60 },
      TFU: { dom: 0.95, intl: 0.90 },
    },
  },
  {
    id: 'taipei', name: 'Taipei', primary: 'TPE', lift: 1.1,
    members: {
      TPE: { dom: 0.50, intl: 1.0 },
      TSA: { dom: 1.0,  intl: 0.25, perimeterKm: 2200 },  // downtown field
    },
  },
  {
    id: 'sydney', name: 'Sydney', primary: 'SYD', lift: 1.1,
    members: {
      SYD: { dom: 1.0,  intl: 1.0 },
      WSI: { dom: 0.50, intl: 0.30 },
    },
  },
  {
    id: 'stockholm', name: 'Stockholm', primary: 'ARN', lift: 1.1,
    members: {
      ARN: { dom: 1.0,  intl: 1.0 },
      NYO: { dom: 0.25, intl: 0.30 },
    },
  },
  {
    id: 'milan', name: 'Milan', primary: 'MXP', lift: 1.25,
    members: {
      MXP: { dom: 0.70, intl: 1.0 },
      LIN: { dom: 1.0,  intl: 0.35, perimeterKm: 1500 },  // city field
      BGY: { dom: 0.60, intl: 0.50 },
    },
  },
  {
    id: 'rome', name: 'Rome', primary: 'FCO', lift: 1.1,
    members: {
      FCO: { dom: 1.0,  intl: 1.0 },
      CIA: { dom: 0.40, intl: 0.35 },
    },
  },
  {
    id: 'jakarta', name: 'Jakarta', primary: 'CGK', lift: 1.15,
    members: {
      CGK: { dom: 1.0,  intl: 1.0 },
      HLP: { dom: 0.50, intl: 0.10 },
    },
  },
  {
    id: 'dubai', name: 'Dubai', primary: 'DXB', lift: 1.05,
    members: {
      DXB: { dom: 1.0,  intl: 1.0 },
      DWC: { dom: 0.30, intl: 0.25 },
    },
  },
  {
    id: 'kualalumpur', name: 'Kuala Lumpur', primary: 'KUL', lift: 1.05,
    members: {
      KUL: { dom: 1.0,  intl: 1.0 },
      SZB: { dom: 0.35, intl: 0.10 },
    },
  },
  {
    id: 'melbourne', name: 'Melbourne', primary: 'MEL', lift: 1.1,
    members: {
      MEL: { dom: 1.0,  intl: 1.0 },
      AVV: { dom: 0.30, intl: 0.15 },
    },
  },
  {
    id: 'tripoli', name: 'Tripoli', primary: 'MJI',
    members: {
      MJI: { dom: 1.0,  intl: 1.0 },
      TIP: { dom: 0.70, intl: 0.60 },
    },
  },
  {
    id: 'dakar', name: 'Dakar', primary: 'DSS',
    members: {
      DSS: { dom: 1.0,  intl: 1.0 },
      DKR: { dom: 0.50, intl: 0.30 },
    },
  },
  {
    id: 'portharcourt', name: 'Port Harcourt', primary: 'PHC',
    members: {
      PHC: { dom: 1.0,  intl: 1.0 },
      PHG: { dom: 0.30, intl: 0.10 },
    },
  },
  {
    id: 'kilimanjaro', name: 'Kilimanjaro–Arusha', primary: 'JRO',
    members: {
      JRO: { dom: 1.0,  intl: 1.0 },
      ARK: { dom: 0.60, intl: 0.30 },
    },
  },
];

// ─── Lookup tables (built once) ───────────────────────────────────────────────
// Members that don't exist in data/airports.js (SEN, UKB, AEP, DWC, SZB, AVV,
// WSI, HLP, WAS… depending on the airport set) are dropped here, so lane keys,
// member scans and appeal lookups only ever see real airports. The registry can
// safely stay ahead of the airport data.

import { getAirport } from './airports.js';

const METRO_BY_ID = new Map(METROS.map((m) => [m.id, m]));
const METRO_OF_CODE = new Map();
for (const m of METROS) {
  const present = Object.keys(m.members).filter((code) => getAirport(code));
  if (present.length < 2) continue;           // a one-airport "metro" is not one
  if (!getAirport(m.primary)) m.primary = present[0];
  for (const code of present) METRO_OF_CODE.set(code, m);
  m._presentMembers = present;
}

/** The metro record an airport belongs to, or null. */
export function metroOf(code) {
  return METRO_OF_CODE.get(code) ?? null;
}

export function metroById(id) {
  return METRO_BY_ID.get(id) ?? null;
}

/** True when two DIFFERENT airport codes serve the same metro. */
export function sameMetroCodes(a, b) {
  if (!a || !b || a === b) return false;
  const m = METRO_OF_CODE.get(a);
  return m != null && m === METRO_OF_CODE.get(b);
}

/**
 * The airport code a metro's demand is priced at: the registry primary for
 * members, the airport itself for everything else. baseCityPairDemand() maps
 * both endpoints through this so every member pair of the same metro pair
 * returns the SAME metro↔metro total.
 */
export function metroPrimary(code) {
  return METRO_OF_CODE.get(code)?.primary ?? code;
}

/**
 * Canonical lane key for the metro-pair pool a route belongs to. Sorted, like
 * every pair key in the engine. For a pair with no metro member this is exactly
 * the ordinary sorted pair key, so non-metro lanes are untouched.
 */
export function metroPairKeyOf(a, b) {
  return [metroPrimary(a), metroPrimary(b)].sort().join('-');
}

/** True when either endpoint belongs to a multi-airport metro. */
export function isMetroPair(a, b) {
  return METRO_OF_CODE.has(a) || METRO_OF_CODE.has(b);
}

/**
 * Every sorted member-pair key between the metros of `a` and `b` — the keys the
 * tick must scan for rivals when pooling the metro pair (competitor route maps,
 * state.encroachments, state.humanRivals are all keyed by airport pair).
 * For a non-metro pair this is just [the pair's own key].
 */
export function memberPairKeysOf(a, b) {
  const membersA = METRO_OF_CODE.get(a)?._presentMembers ?? [a];
  const membersB = METRO_OF_CODE.get(b)?._presentMembers ?? [b];
  const keys = new Set();
  for (const ma of membersA) {
    for (const mb of membersB) {
      if (ma === mb) continue;
      keys.add([ma, mb].sort().join('-'));
    }
  }
  return [...keys];
}

/**
 * Appeal of ONE airport for a given mission. 1.0 for any airport that is not a
 * registry member (including a metro's primary when it carries appeal 1.0).
 *
 * @param {string}  code
 * @param {boolean} domestic  is the pair domestic?
 * @param {number}  [distKm]  great-circle distance of the pair, for perimeter rules
 * @returns {number}
 */
export function airportAppeal(code, domestic, distKm) {
  const m = METRO_OF_CODE.get(code);
  const entry = m?.members?.[code];
  if (!entry) return 1;
  let appeal = domestic ? (entry.dom ?? 1) : (entry.intl ?? 1);
  if (entry.perimeterKm != null && distKm != null && distKm > entry.perimeterKm) {
    appeal *= PERIMETER_COLLAPSE;
  }
  return appeal;
}

/**
 * Combined appeal of an airport PAIR — the product of both endpoints' appeal.
 * This is what rides on an offer as `airportAppeal`:
 *   · contested pools: log(appeal) joins the utility, so an offer's softmax
 *     weight is multiplied by exactly `appeal` (the brandReach identity).
 *   · monopolies: min(1, appeal) scales the pool — a lone route from a
 *     secondary field reaches only that field's slice of the metro's travellers.
 *
 * @param {string} a
 * @param {string} b
 * @param {boolean} domestic
 * @param {number}  [distKm]
 * @returns {number}
 */
export function pairAppeal(a, b, domestic, distKm) {
  return airportAppeal(a, domestic, distKm) * airportAppeal(b, domestic, distKm);
}
