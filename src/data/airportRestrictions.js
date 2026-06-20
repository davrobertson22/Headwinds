// ─── Airport Operational Restrictions ────────────────────────────────────────
// Real-world regulatory limits that block certain routes or aircraft types.
//
// Each restriction object exposes:
//   check(distKm, otherCode, weeklyFrequency, aircraftCategory) → string | null
//     Returns a human-readable reason string if the route is blocked, or null if OK.
//
// The registry maps airport code → array of restrictions (all are checked;
// the first violation wins).

import { getAirport } from './airports.js';
import { distanceKm } from '../utils/market.js';

const MILES_TO_KM = 1.60934;

/**
 * Counts the player's DISTINCT city-pair routes that touch `airportCode` and
 * exceed `maxDistanceKm` (i.e. routes that "break" that airport's perimeter rule).
 * `excludeKey` (an unordered "A-B" route key) is skipped so editing an existing
 * beyond-perimeter route doesn't count against itself.
 */
function countBeyondPerimeterRoutes(routes, airportCode, maxDistanceKm, excludeKey) {
  const keys = new Set();
  for (const r of routes ?? []) {
    if (r.origin !== airportCode && r.destination !== airportCode) continue;
    const key = [r.origin, r.destination].sort().join('-');
    if (key === excludeKey) continue;
    const o = getAirport(r.origin), d = getAirport(r.destination);
    if (!o || !d) continue;
    if (distanceKm(o, d) > maxDistanceKm) keys.add(key);
  }
  return keys.size;
}

// ─── Perimeter rules ──────────────────────────────────────────────────────────

/**
 * LGA Perimeter Rule (49 U.S.C. § 41714)
 * No scheduled service beyond 1,500 statute miles from LaGuardia.
 */
const LGA_PERIMETER = {
  label: 'LGA Perimeter Rule',
  shortLabel: '1,500-mile perimeter',
  description:
    'Federal law (49 U.S.C. § 41714) restricts LaGuardia to destinations within ' +
    '1,500 statute miles. Enacted in 1984 to preserve the airport\'s short-haul, ' +
    'high-frequency character and reduce slot congestion.',
  type: 'perimeter',
  maxDistanceKm: Math.round(1500 * MILES_TO_KM), // 2,414 km
  exceptions: [],
  check(distKm, otherCode) {
    if (this.exceptions.includes(otherCode)) return null;
    if (distKm > this.maxDistanceKm) {
      const miles = Math.round(distKm / MILES_TO_KM);
      return `LGA Perimeter Rule: LGA serves destinations within 1,500 mi only. ` +
             `This route is ${miles.toLocaleString()} mi — ${(miles - 1500).toLocaleString()} mi over the limit.`;
    }
    return null;
  },
};

/**
 * DCA Perimeter Rule (49 U.S.C. § 49109)
 * Reagan National: no scheduled service beyond 1,250 statute miles.
 */
const DCA_PERIMETER = {
  label: 'DCA Perimeter Rule',
  shortLabel: '1,250-mile perimeter',
  description:
    'Federal law (49 U.S.C. § 49109) restricts Reagan National to destinations within ' +
    '1,250 statute miles. Enacted in 1966 to steer long-haul traffic to Dulles (IAD). ' +
    'A limited number of beyond-perimeter exemption slots exist — modeled here as up to ' +
    '5 beyond-perimeter routes, each capped at 1 daily departure (7/week).',
  type: 'perimeter',
  maxDistanceKm: Math.round(1250 * MILES_TO_KM), // 2,012 km
  exceptions: [],                 // hard-coded always-allowed destinations (none)
  exemptionSlots: 5,              // max simultaneous beyond-perimeter routes
  exemptionMaxWeeklyFrequency: 7, // each exemption route limited to 1 daily
  check(distKm, otherCode, weeklyFreq, aircraftCategory, ctx = {}) {
    if (this.exceptions.includes(otherCode)) return null;
    if (distKm <= this.maxDistanceKm) return null; // within perimeter — always fine

    const miles = Math.round(distKm / MILES_TO_KM);
    const over  = (miles - 1250).toLocaleString();
    const slots = this.exemptionSlots ?? 0;
    if (slots <= 0) {
      return `DCA Perimeter Rule: DCA serves destinations within 1,250 mi only. ` +
             `This route is ${miles.toLocaleString()} mi — ${over} mi over the limit.`;
    }

    // Beyond perimeter: only allowed if a slot is free (excluding this route itself).
    const used = countBeyondPerimeterRoutes(ctx.routes, ctx.restrictedAirport ?? 'DCA', this.maxDistanceKm, ctx.excludeKey);
    if (used >= slots) {
      return `DCA Perimeter Rule: all ${slots} beyond-perimeter exemption slots are in use ` +
             `(this route is ${miles.toLocaleString()} mi, ${over} mi over the 1,250-mi limit). ` +
             `Drop an existing beyond-perimeter DCA route to free a slot.`;
    }
    // Slot available — but exemption routes are capped at 1 daily (7/week).
    const fcap = this.exemptionMaxWeeklyFrequency ?? Infinity;
    if (weeklyFreq != null && weeklyFreq > fcap) {
      return `DCA Perimeter Rule: beyond-perimeter exemption routes are limited to ` +
             `${fcap} departures/week (1 daily). Reduce frequency to ${fcap} or fewer.`;
    }
    return null; // permitted under an exemption slot
  },
};

// ─── Aircraft size / type restrictions ───────────────────────────────────────

/**
 * No widebody aircraft at LGA.
 * Gate infrastructure, ramp space, and runway geometry at LaGuardia cannot
 * accommodate twin-aisle jets. The Port Authority has enforced this for decades.
 */
const LGA_NO_WIDEBODY = {
  label: 'LGA Widebody Ban',
  shortLabel: 'No widebody aircraft',
  description:
    'LaGuardia\'s compact terminal layout and short taxi infrastructure cannot accommodate ' +
    'widebody (twin-aisle) jets. Gate bridges, ramp spacing, and apron weight limits ' +
    'all preclude twin-aisle operations.',
  type: 'aircraft_size',
  blockedCategories: ['Wide Body'],
  check(distKm, otherCode, weeklyFreq, aircraftCategory) {
    if (this.blockedCategories.includes(aircraftCategory)) {
      return `LGA Widebody Ban: LaGuardia cannot accommodate ${aircraftCategory} aircraft. Use a narrowbody or regional jet.`;
    }
    return null;
  },
};

/**
 * No widebody aircraft at DCA.
 * Reagan National has the same physical constraints as LGA — short gates,
 * limited ramp depth, and weight-bearing limits on the pier structures.
 */
const DCA_NO_WIDEBODY = {
  label: 'DCA Widebody Ban',
  shortLabel: 'No widebody aircraft',
  description:
    'Reagan National\'s terminal piers and ramp infrastructure cannot support widebody ' +
    '(twin-aisle) jets. Gate jetbridge geometry, apron weight limits, and the ' +
    'constrained riverside site all preclude twin-aisle operations.',
  type: 'aircraft_size',
  blockedCategories: ['Wide Body'],
  check(distKm, otherCode, weeklyFreq, aircraftCategory) {
    if (this.blockedCategories.includes(aircraftCategory)) {
      return `DCA Widebody Ban: Reagan National cannot accommodate ${aircraftCategory} aircraft. Use a narrowbody or regional jet.`;
    }
    return null;
  },
};

/**
 * LCY Aircraft Size Restriction
 * London City Airport sits in the Royal Docks with a 1,508m runway and a
 * demanding 5.5° instrument approach (vs the standard 3°). Only aircraft with
 * steep-approach (SAp) type certification are permitted. In practice this means
 * regional jets (E170/E190, Avro RJ, CRJ) and turboprops. The A318 held a
 * special SAp exemption for BA's JFK service but that route has ended.
 */
const LCY_SMALL_AIRCRAFT = {
  label: 'LCY Steep Approach Certification',
  shortLabel: 'SAp cert required',
  description:
    'London City\'s 5.5° instrument approach — nearly twice the standard glideslope — and ' +
    '1,508m runway require aircraft with Steep Approach (SAp) type certification. Only ' +
    'regional jets and turboprops currently hold this certification for LCY operations. ' +
    'No narrowbody or widebody jets may operate here.',
  type: 'aircraft_size',
  allowedCategories: ['Regional Jet', 'Turboprop'],
  check(distKm, otherCode, weeklyFreq, aircraftCategory) {
    if (aircraftCategory && !this.allowedCategories.includes(aircraftCategory)) {
      return `LCY SAp Restriction: Only regional jets and turboprops hold steep-approach certification ` +
             `for London City. ${aircraftCategory} aircraft are not permitted.`;
    }
    return null;
  },
};

/**
 * ASE Aircraft Size Restriction
 * Aspen/Pitkin County sits at 7,820ft elevation, has a 7,006ft runway, and is
 * surrounded by mountains requiring a non-standard visual approach. Gross weight
 * limits cap operations at narrowbody or smaller; widebody performance margins
 * are insufficient at this altitude.
 */
const ASE_NO_WIDEBODY = {
  label: 'ASE High-Altitude Runway Limit',
  shortLabel: 'No widebody aircraft',
  description:
    'At 7,820ft elevation, Aspen\'s 7,006ft runway provides insufficient performance ' +
    'margins for widebody jets. High-density altitude dramatically reduces lift and ' +
    'engine thrust, and the surrounding terrain demands a non-standard visual approach. ' +
    'Operations are limited to narrowbodies, regional jets, and turboprops.',
  type: 'aircraft_size',
  blockedCategories: ['Wide Body'],
  check(distKm, otherCode, weeklyFreq, aircraftCategory) {
    if (this.blockedCategories.includes(aircraftCategory)) {
      return `ASE Altitude Restriction: Aspen's high-elevation, short runway cannot support ${aircraftCategory} aircraft.`;
    }
    return null;
  },
};

/**
 * SXM Aircraft Size Restriction
 * Princess Juliana's 2,301m runway and the famous low-altitude final approach
 * over Maho Beach preclude heavy widebody operations. The 747 once served SXM
 * but payload restrictions made it uneconomic; the airport's runway end safety
 * area cannot meet standards for aircraft over ~250 seats.
 */
const SXM_NO_WIDEBODY = {
  label: 'SXM Runway Length Limit',
  shortLabel: 'No widebody aircraft',
  description:
    'Princess Juliana\'s 2,301m runway and the obstacle-clearance requirements of the ' +
    'low-altitude Maho Beach approach restrict operations to narrowbody and smaller aircraft. ' +
    'Widebody jets cannot meet required accelerate-stop distances or RESA standards ' +
    'at this airport.',
  type: 'aircraft_size',
  blockedCategories: ['Wide Body'],
  check(distKm, otherCode, weeklyFreq, aircraftCategory) {
    if (this.blockedCategories.includes(aircraftCategory)) {
      return `SXM Runway Restriction: Princess Juliana's short runway cannot safely support ${aircraftCategory} aircraft.`;
    }
    return null;
  },
};

// ─── Frequency / slot caps ────────────────────────────────────────────────────

const LGB_SLOT_CAP = {
  label: 'LGB Slot Restriction',
  shortLabel: 'Airport slot cap',
  description:
    'The City of Long Beach caps commercial departures at 41 per day to limit ' +
    'noise impacts on surrounding neighbourhoods. Slots are allocated to carriers; ' +
    'new entrants face severe access constraints.',
  type: 'frequency_cap',
  maxWeeklyFrequency: 14,
  check(distKm, otherCode, weeklyFreq) {
    if (weeklyFreq > this.maxWeeklyFrequency) {
      return `LGB Slot Cap: Long Beach limits a single carrier to ${this.maxWeeklyFrequency} departures/week on any one route.`;
    }
    return null;
  },
};

const SNA_RESTRICTIONS = {
  label: 'SNA Noise & Slot Restriction',
  shortLabel: 'Noise curfew & slot cap',
  description:
    'John Wayne Airport operates under a strict FAA Record of Decision noise programme. ' +
    'Night flights are banned (10pm–7am), total annual Commercial Air Carrier departures ' +
    'are capped, and individual carriers hold fixed slot allocations.',
  type: 'frequency_cap',
  maxWeeklyFrequency: 10,
  check(distKm, otherCode, weeklyFreq) {
    if (weeklyFreq > this.maxWeeklyFrequency) {
      return `SNA Noise Programme: SNA's slot cap limits a single carrier to ${this.maxWeeklyFrequency} departures/week on any one route.`;
    }
    return null;
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────
// Maps airport code → array of restrictions. All are checked; first violation wins.

export const AIRPORT_RESTRICTIONS = {
  LGA: [LGA_PERIMETER, LGA_NO_WIDEBODY],
  DCA: [DCA_PERIMETER, DCA_NO_WIDEBODY],
  LCY: [LCY_SMALL_AIRCRAFT],
  LGB: [LGB_SLOT_CAP],
  SNA: [SNA_RESTRICTIONS],
  ASE: [ASE_NO_WIDEBODY],
  SXM: [SXM_NO_WIDEBODY],
};

/**
 * Returns the first violated restriction for a proposed route, or null if clear.
 *
 * @param {string} originCode
 * @param {string} destCode
 * @param {number} distKm            great-circle distance in km
 * @param {number} weeklyFreq        proposed TOTAL weekly departures on this city-pair
 * @param {string} [aircraftCategory] e.g. 'Wide Body', 'Narrow Body', 'Regional Jet', 'Turboprop'
 * @param {object} [context]         { routes, excludeKey } — the player's current routes and the
 *                                   unordered "A-B" key of the route being edited (so slot/freq
 *                                   caps that depend on existing routes can be evaluated)
 * @returns {{ restriction, reason } | null}
 */
export function checkRouteRestrictions(originCode, destCode, distKm, weeklyFreq, aircraftCategory, context = {}) {
  for (const code of [originCode, destCode]) {
    const list = AIRPORT_RESTRICTIONS[code];
    if (!list) continue;
    const other = code === originCode ? destCode : originCode;
    const ctx = { ...context, restrictedAirport: code };
    for (const r of list) {
      const reason = r.check(distKm, other, weeklyFreq, aircraftCategory ?? null, ctx);
      if (reason) return { restriction: r, reason };
    }
  }
  return null;
}

/**
 * Returns all restrictions that apply to a given airport (for display purposes).
 */
export function getAirportRestrictions(code) {
  return AIRPORT_RESTRICTIONS[code] ?? [];
}

/**
 * UI helper: how many beyond-perimeter exemption slots are used / available at an
 * airport. Returns null if the airport has no slot-limited perimeter rule.
 * @returns {{ used:number, total:number, maxWeeklyFrequency:number|null } | null}
 */
export function getPerimeterExemptionStatus(routes, airportCode, excludeKey) {
  const rule = (AIRPORT_RESTRICTIONS[airportCode] ?? [])
    .find(r => r.type === 'perimeter' && (r.exemptionSlots ?? 0) > 0);
  if (!rule) return null;
  return {
    used: countBeyondPerimeterRoutes(routes, airportCode, rule.maxDistanceKm, excludeKey),
    total: rule.exemptionSlots,
    maxWeeklyFrequency: rule.exemptionMaxWeeklyFrequency ?? null,
  };
}
