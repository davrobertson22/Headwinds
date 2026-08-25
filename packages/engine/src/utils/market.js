/**
 * market.js — Pure market utility functions shared by simulation.js and demand.js.
 *
 * Extracted here to break the circular dependency that would arise if both
 * simulation.js and demand.js imported from each other.
 *
 * Import chain:
 *   market.js        ← airports.js only
 *   demand.js        ← market.js
 *   simulation.js    ← market.js, demand.js
 */

import { getAirport, getAirportScores, getAirportCargoScore } from '../data/airports.js';
import {
  METROS,
  metroOf,
  metroPrimary,
  sameMetroCodes,
} from '../data/metros.js';

// Re-exported so every consumer of the metro model imports it through the same
// market/demand surface they already use (the registry itself lives in data/).
export {
  metroOf,
  metroPrimary,
  metroPairKeyOf,
  isMetroPair,
  memberPairKeysOf,
  airportAppeal,
  pairAppeal,
} from '../data/metros.js';

// ─── Distance ─────────────────────────────────────────────────────────────────

/** Haversine distance between two lat/lon points, in km */
export function distanceKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const x = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function toRad(d) { return d * Math.PI / 180; }

// ─── Gravity model ────────────────────────────────────────────────────────────

/**
 * Demand attractiveness multiplier for one airport endpoint.
 * Combines business and leisure appeal so that corporate hubs and tourist
 * destinations generate more traffic than their raw population would suggest.
 *
 * Normalised so a neutral airport (businessScore=50, leisureScore=50) → 1.0.
 * Examples:
 *   JFK (biz 72, lei 65) → 1.37   LAS Vegas (biz 15, lei 90) → 1.05
 *   LHR (biz 82, lei 55) → 1.37   CUN Cancún (biz  8, lei 92) → 1.00
 *   DXB (biz 80, lei 65) → 1.45   IAD DC govt (biz 78, lei 28) → 1.06
 *
 * @param {string} code
 * @returns {number}
 */
function demandMultiplier(code) {
  const { businessScore, leisureScore } = getAirportScores(code);
  return (businessScore + leisureScore) / 100;
}

// ─── Demand mass ───────────────────────────────────────────────────────────────
// The gravity model keys off a "demand mass" (in millions). Historically this was
// just metro population (with `effectivePop` as a manual override for big connecting
// hubs). Two kinds of airport are badly under-rated by population alone:
//
//   • Tourism magnets   – e.g. Malé/Maldives: ~0.4M residents but millions of
//                          annual visitors. Demand comes from tourism, not population.
//   • National gateways  – e.g. Ulaanbaatar: traffic is driven by being the only
//                          international gateway for a whole country, not city size.
//
// So demand mass = population + tourism term + gateway term, with two optional,
// data-driven airport fields and two tunable coefficients below.

/** Each 1M annual inbound visitors contributes this much demand mass (in millions). */
export const TOURISM_VISITOR_WEIGHT = 1.5;
/** Fraction of an airport's declared national catchment that becomes demand mass. */
export const GATEWAY_WEIGHT = 1.0;

/**
 * Effective demand mass (millions) for one airport.
 *  - `effectivePop` (if set) stays authoritative — it already bakes in connecting/
 *    gateway traffic for the calibrated mega-hubs, so we don't double-count it.
 *  - otherwise: population + visitors*TOURISM_VISITOR_WEIGHT + gateway*GATEWAY_WEIGHT
 *
 * Airport fields (all optional, in millions):
 *   visitors         – annual inbound visitors/tourists per year (any origin)
 *   domesticVisitors – annual inbound visitors who are overwhelmingly SAME-COUNTRY
 *                      travelers (Jeju, Sapporo, Okinawa...). Counts toward demand
 *                      mass only on domestic pairs — foreign traffic to these
 *                      places is a trickle compared to the domestic firehose.
 *   gateway          – extra national catchment that routes through this airport
 *                      (rule of thumb: national pop − metro pop, for a country's
 *                       primary international gateway)
 *
 * @param {object}  ap  airport record
 * @param {boolean} [domesticPair=true]  whether the pair being priced is
 *   domestic; single-airport contexts (hub sizing etc.) should keep the default
 *   and see full mass.
 * @returns {number} demand mass in millions
 */
export function getDemandMass(ap, domesticPair = true) {
  if (ap == null) return 0;
  if (ap.effectivePop != null) return ap.effectivePop;
  return (ap.population ?? 0)
    + (ap.visitors ?? 0) * TOURISM_VISITOR_WEIGHT
    + (domesticPair ? (ap.domesticVisitors ?? 0) * TOURISM_VISITOR_WEIGHT : 0)
    + (ap.gateway ?? 0) * GATEWAY_WEIGHT;
}

// ─── Country travel factors (2026-07 demand recalibration) ────────────────────
// Audit vs real-world O&D data (docs/DEMAND_MODEL_AUDIT.md) showed a ~400x
// relative spread between over- and under-modeled pairs. Three factors below
// close most of it: propensity-to-fly, border friction, and air-captivity.

/**
 * Propensity-to-fly index by country (US = 1.0). Roughly annual air trips per
 * capita. Applied at FULL strength to international pairs and softened to
 * p^DOMESTIC_PROPENSITY_EXP for domestic pairs (domestic flying is far less
 * income-sensitive: LCC fares, no visas). Missing country → DEFAULT_PROPENSITY.
 */
export const COUNTRY_PROPENSITY = {
  // Americas
  US:1.0, CA:0.9, PR:1.0, GL:0.8, BM:1.2, PM:0.8,
  MX:0.55, GT:0.3, HN:0.3, SV:0.35, NI:0.25, CR:0.6, PA:0.7, BZ:0.5,
  CU:0.25, DO:0.5, HT:0.15, JM:0.6, TT:0.7, BS:1.0, BB:0.9, AW:1.1, KY:1.2,
  CW:0.9, SX:1.0, AG:0.9, GD:0.7, KN:0.8, LC:0.7, VC:0.6, DM:0.5, AI:0.9,
  VG:1.0, TC:0.9, GP:0.8, MQ:0.8, BQ:0.9, BL:1.2,
  BR:0.55, AR:0.6, CL:0.7, UY:0.7, PY:0.4, BO:0.4, PE:0.45, EC:0.45,
  CO:0.5, VE:0.3, GY:0.4, SR:0.4,
  // Europe
  GB:1.1, IE:1.2, FR:0.85, DE:0.85, NL:0.9, BE:0.85, LU:1.1, CH:1.1, AT:0.9,
  ES:1.05, PT:1.0, IT:0.9, GR:1.0, MT:1.2, CY:1.1, DK:1.0, NO:1.3, SE:1.1,
  FI:1.1, IS:1.5, PL:0.7, CZ:0.8, SK:0.7, HU:0.75, RO:0.6, BG:0.65, HR:0.85,
  RS:0.6, MK:0.55, BA:0.5, ME:0.7, XK:0.5, AL:0.6, SI:0.8, MD:0.4, UA:0.4,
  BY:0.4, RU:0.6, LV:0.8, LT:0.8, EE:0.9, TR:0.75, GE:0.6, AM:0.6, AZ:0.55,
  JE:1.2, IM:1.2, FO:1.3, GI:1.2,
  // Middle East / North Africa
  AE:1.5, QA:1.5, KW:1.2, BH:1.3, OM:1.0, SA:1.2, YE:0.1, IQ:0.3, IR:0.4,
  IL:1.1, JO:0.6, LB:0.6, SY:0.15,
  EG:0.3, LY:0.4, TN:0.55, DZ:0.4, MA:0.4, MR:0.2, SD:0.15,
  // Sub-Saharan Africa
  ZA:0.65, NA:0.5, BW:0.5, ZW:0.25, ZM:0.25, MW:0.15, MZ:0.2, AO:0.3, CD:0.15,
  CG:0.3, GA:0.5, CM:0.2, NG:0.1, GH:0.2, CI:0.25, SN:0.3, ML:0.15, BF:0.12,
  NE:0.1, TD:0.12, TG:0.15, BJ:0.15, GM:0.2, GW:0.15, GN:0.15, SL:0.15,
  LR:0.15, KE:0.25, TZ:0.2, UG:0.15, RW:0.25, BI:0.1, ET:0.08, SO:0.1,
  DJ:0.4, ER:0.1, SS:0.1, CF:0.1, MG:0.15, MU:0.9, SC:1.2, KM:0.2, RE:0.9,
  CV:0.6, ST:0.3, SH:0.5, SZ:0.3, LS:0.2,
  // Central / South Asia
  KZ:0.7, UZ:0.35, TM:0.3, TJ:0.25, KG:0.35, MN:0.6, AF:0.1,
  IN:0.35, PK:0.15, BD:0.08, LK:0.3, NP:0.25, BT:0.4, MV:1.2,
  // East / Southeast Asia
  CN:0.55, JP:1.3, KR:1.3, TW:1.1, HK:1.2, MO:1.0, KP:0.05,
  SG:1.4, MY:0.9, TH:0.75, VN:0.65, ID:0.5, PH:0.55, KH:0.35, LA:0.3,
  MM:0.2, BN:1.0, TL:0.25,
  // Oceania
  AU:1.6, NZ:1.5, FJ:0.8, PF:1.0, NC:0.9, PG:0.25, SB:0.3, VU:0.5, WS:0.6,
  TO:0.6, KI:0.4, TV:0.4, NR:0.6, CK:0.9, PW:0.8, FM:0.4, MH:0.4, NF:0.9,
  GU:1.2, AS:1.0, MP:1.0,
};
export const DEFAULT_PROPENSITY = 0.4;
export const DOMESTIC_PROPENSITY_EXP = 0.35;

// ─── Demand growth over game time (2026-08) ───────────────────────────────────
// Air travel demand GROWS as a world ages, and it grows fastest where incomes
// are climbing: India and Southeast Asia compound at 7–8% a year while the
// mature US/EU/Japan markets crawl at 1–2%. Strategically this rewards planting
// a flag early in an emerging market — the route that breaks even in year one
// is printing money by year five, and the propensity gap between rich and poor
// countries (COUNTRY_PROPENSITY) slowly narrows the way it does in reality.
//
// Annual rates, loosely IATA/Boeing 20-year CAGR forecasts. Missing country →
// DEFAULT_DEMAND_GROWTH. Applied by buildRouteMarket() as a multiplier on the
// pair's demand pool: sqrt of the two ends' compounded growth (each end
// contributes half, like every other endpoint factor under the gravity sqrt),
// capped at DEMAND_GROWTH_CAP so a decade-old world stays playable rather than
// drowning every emerging-market route in demand.
export const COUNTRY_DEMAND_GROWTH = {
  // South & Central Asia — the fastest-growing air markets on Earth
  IN: 0.080, BD: 0.070, PK: 0.060, LK: 0.050, NP: 0.055, KZ: 0.050, UZ: 0.055,
  // Southeast Asia
  VN: 0.075, ID: 0.070, PH: 0.070, KH: 0.065, LA: 0.060, MM: 0.055,
  TH: 0.045, MY: 0.045, SG: 0.030, BN: 0.030,
  // East Asia
  CN: 0.050, TW: 0.020, HK: 0.020, KR: 0.015, JP: 0.010, MO: 0.020, MN: 0.050,
  // Middle East
  SA: 0.055, AE: 0.045, QA: 0.040, OM: 0.045, KW: 0.035, BH: 0.035,
  IQ: 0.050, IR: 0.035, IL: 0.030, JO: 0.040, TR: 0.050,
  // Africa
  EG: 0.055, NG: 0.060, ET: 0.065, KE: 0.055, TZ: 0.055, UG: 0.055, GH: 0.050,
  CI: 0.050, SN: 0.050, RW: 0.060, ZA: 0.035, MA: 0.040, DZ: 0.040, TN: 0.040,
  AO: 0.045, MZ: 0.050, ZM: 0.045, CD: 0.050, CM: 0.045,
  // Latin America
  BR: 0.040, MX: 0.040, CO: 0.045, PE: 0.045, CL: 0.035, AR: 0.035,
  EC: 0.040, BO: 0.045, PY: 0.045, UY: 0.030, GT: 0.045, DO: 0.040, PA: 0.040,
  // Mature markets
  US: 0.020, CA: 0.020, GB: 0.015, IE: 0.020, FR: 0.015, DE: 0.015, NL: 0.015,
  BE: 0.015, CH: 0.015, AT: 0.015, IT: 0.015, ES: 0.020, PT: 0.020, GR: 0.025,
  DK: 0.015, NO: 0.015, SE: 0.015, FI: 0.015, IS: 0.020,
  PL: 0.030, CZ: 0.025, SK: 0.025, HU: 0.025, RO: 0.035, BG: 0.030, HR: 0.025,
  RS: 0.030, UA: 0.030, RU: 0.020,
  AU: 0.025, NZ: 0.020,
};
export const DEFAULT_DEMAND_GROWTH = 0.030;
/** Hard ceiling on the compounded growth factor (≈ year 25+ for an 8% market). */
export const DEMAND_GROWTH_CAP = 3.0;

/**
 * Compounded demand-growth factor for a pair, `absWeek` weeks into a world's
 * life (absWeek 1 = the world's first week → factor 1). Callers without a
 * calendar pass null/undefined and get exactly 1 — every historical fixture
 * and preview built from a bare { week, month } gameDate is unchanged.
 *
 * Metro members grow at their metro primary's country rate (identical country
 * in practice), so member pairs keep returning identical totals.
 *
 * @param {string} originCode
 * @param {string} destCode
 * @param {number|null} absWeek  absolute world week (year 1 week 1 → 1)
 * @returns {number} 1 … DEMAND_GROWTH_CAP
 */
export function pairDemandGrowth(originCode, destCode, absWeek) {
  if (absWeek == null || !(absWeek > 1)) return 1;
  const o = getAirport(metroPrimary(originCode));
  const d = getAirport(metroPrimary(destCode));
  if (!o || !d) return 1;
  const gO = COUNTRY_DEMAND_GROWTH[o.country] ?? DEFAULT_DEMAND_GROWTH;
  const gD = COUNTRY_DEMAND_GROWTH[d.country] ?? DEFAULT_DEMAND_GROWTH;
  const years = (absWeek - 1) / 52;
  const factor = Math.pow(Math.sqrt((1 + gO) * (1 + gD)), years);
  return Math.min(DEMAND_GROWTH_CAP, factor);
}

/** World regions for border-friction defaults. */
export const COUNTRY_REGION = {
  US:'NA', CA:'NA', GL:'NA', PM:'NA', BM:'NA', PR:'NA',
  MX:'CARIB', GT:'CARIB', HN:'CARIB', SV:'CARIB', NI:'CARIB', CR:'CARIB', PA:'CARIB',
  BZ:'CARIB', CU:'CARIB', DO:'CARIB', HT:'CARIB', JM:'CARIB', TT:'CARIB', BS:'CARIB',
  BB:'CARIB', AW:'CARIB', KY:'CARIB', CW:'CARIB', SX:'CARIB', AG:'CARIB', GD:'CARIB',
  KN:'CARIB', LC:'CARIB', VC:'CARIB', DM:'CARIB', AI:'CARIB', VG:'CARIB', TC:'CARIB',
  GP:'CARIB', MQ:'CARIB', BQ:'CARIB', BL:'CARIB',
  BR:'SAM', AR:'SAM', CL:'SAM', UY:'SAM', PY:'SAM', BO:'SAM', PE:'SAM', EC:'SAM',
  CO:'SAM', VE:'SAM', GY:'SAM', SR:'SAM',
  GB:'EUR', IE:'EUR', FR:'EUR', DE:'EUR', NL:'EUR', BE:'EUR', LU:'EUR', CH:'EUR',
  AT:'EUR', ES:'EUR', PT:'EUR', IT:'EUR', GR:'EUR', MT:'EUR', CY:'EUR', DK:'EUR',
  NO:'EUR', SE:'EUR', FI:'EUR', IS:'EUR', PL:'EUR', CZ:'EUR', SK:'EUR', HU:'EUR',
  RO:'EUR', BG:'EUR', HR:'EUR', RS:'EUR', MK:'EUR', BA:'EUR', ME:'EUR', XK:'EUR',
  AL:'EUR', SI:'EUR', MD:'EUR', UA:'EUR', BY:'EUR', RU:'EUR', LV:'EUR', LT:'EUR',
  EE:'EUR', TR:'EUR', GE:'EUR', AM:'EUR', AZ:'EUR', JE:'EUR', IM:'EUR', FO:'EUR', GI:'EUR',
  AE:'ME', QA:'ME', KW:'ME', BH:'ME', OM:'ME', SA:'ME', YE:'ME', IQ:'ME', IR:'ME',
  IL:'ME', JO:'ME', LB:'ME', SY:'ME',
  EG:'NAF', LY:'NAF', TN:'NAF', DZ:'NAF', MA:'NAF', MR:'NAF', SD:'NAF',
  ZA:'SSA', NA:'SSA', BW:'SSA', ZW:'SSA', ZM:'SSA', MW:'SSA', MZ:'SSA', AO:'SSA',
  CD:'SSA', CG:'SSA', GA:'SSA', CM:'SSA', NG:'SSA', GH:'SSA', CI:'SSA', SN:'SSA',
  ML:'SSA', BF:'SSA', NE:'SSA', TD:'SSA', TG:'SSA', BJ:'SSA', GM:'SSA', GW:'SSA',
  GN:'SSA', SL:'SSA', LR:'SSA', KE:'SSA', TZ:'SSA', UG:'SSA', RW:'SSA', BI:'SSA',
  ET:'SSA', SO:'SSA', DJ:'SSA', ER:'SSA', SS:'SSA', CF:'SSA', MG:'SSA', MU:'SSA',
  SC:'SSA', KM:'SSA', RE:'SSA', CV:'SSA', ST:'SSA', SH:'SSA', SZ:'SSA', LS:'SSA',
  KZ:'CAS', UZ:'CAS', TM:'CAS', TJ:'CAS', KG:'CAS', MN:'CAS', AF:'CAS',
  IN:'SAS', PK:'SAS', BD:'SAS', LK:'SAS', NP:'SAS', BT:'SAS', MV:'SAS',
  CN:'EAS', JP:'EAS', KR:'EAS', TW:'EAS', HK:'EAS', MO:'EAS', KP:'EAS',
  SG:'SEA', MY:'SEA', TH:'SEA', VN:'SEA', ID:'SEA', PH:'SEA', KH:'SEA', LA:'SEA',
  MM:'SEA', BN:'SEA', TL:'SEA',
  AU:'OCE', NZ:'OCE', PG:'OCE', FJ:'OCE', NC:'OCE', VU:'OCE', SB:'OCE', WS:'OCE',
  TO:'OCE', KI:'OCE', TV:'OCE', NR:'OCE', CK:'OCE', PF:'OCE', GU:'OCE', AS:'OCE',
  MP:'OCE', NF:'OCE', PW:'OCE', FM:'OCE', MH:'OCE',
};

/**
 * Border friction. Domestic = 1.0. International defaults:
 *   same region                              → 0.70
 *   cross region, both propensity ≥ 0.8      → 0.70 (wealthy/open ties)
 *   cross region otherwise                   → 0.45
 * Country-pair overrides capture special corridors (VFR/diaspora/treaty).
 */
export const INTL_SAME_REGION = 0.70;
export const INTL_CROSS_HIGH  = 0.70;
export const INTL_CROSS_LOW   = 0.45;

export const COUNTRY_AFFINITY = {
  'GB-IE':1.0, 'AU-NZ':1.0, 'US-CA':0.65, 'US-MX':0.8, 'CA-MX':0.75,
  'US-GB':0.85, 'US-FR':0.8, 'US-DE':0.8, 'US-IT':0.8, 'US-IL':0.85,
  'US-JP':0.7, 'US-KR':0.8, 'US-CN':0.6, 'US-HK':0.75, 'US-TW':0.75,
  'US-IN':0.7, 'US-PH':0.75, 'US-VN':0.7, 'US-AU':0.8, 'US-BR':0.7,
  'US-CO':0.7, 'US-DO':0.9, 'US-JM':0.9, 'US-BS':0.9, 'US-CU':0.5,
  'CA-GB':0.8, 'CA-FR':0.75, 'CA-IN':0.7, 'CA-PH':0.75, 'CA-HK':0.75, 'CA-CN':0.6,
  'GB-ES':0.9, 'GB-PT':0.9, 'GB-AE':0.8, 'GB-SG':0.85, 'GB-IN':0.7, 'GB-PK':0.7,
  'GB-HK':0.85, 'GB-AU':0.85, 'GB-NZ':0.85, 'GB-ZA':0.75, 'GB-NG':0.6,
  'DE-TR':0.9, 'FR-MA':0.9, 'FR-DZ':0.9, 'FR-TN':0.9, 'ES-MA':0.8,
  'EG-SA':1.0, 'EG-AE':0.85, 'EG-KW':0.85,
  'IN-AE':0.9, 'IN-QA':0.85, 'IN-SA':0.8, 'IN-OM':0.85, 'IN-KW':0.85, 'IN-BH':0.85,
  'IN-BD':0.45, 'IN-SG':0.75, 'PK-AE':0.85, 'PK-SA':0.8, 'BD-AE':0.7, 'BD-SA':0.7,
  'PH-AE':0.85, 'PH-SA':0.8, 'LK-AE':0.8, 'NP-AE':0.7, 'NP-QA':0.7, 'ID-SA':0.75,
  'HK-TW':0.95, 'CN-HK':0.95, 'CN-TW':0.65, 'CN-MO':0.95, 'KR-JP':0.9, 'JP-TW':0.85,
  'TH-HK':0.7, 'JP-TH':0.8, 'KR-TH':0.8, 'KR-VN':0.8, 'CN-TH':0.75, 'CN-SG':0.8,
  'SG-MY':0.95, 'SG-ID':0.9, 'SG-TH':0.85, 'SG-PH':0.8, 'SG-VN':0.8, 'SG-AU':0.8,
  'MY-ID':0.85, 'NZ-FJ':0.95, 'AU-FJ':0.85, 'AU-ID':0.75,
};

/** Softer defaults for a few region pairs that behave like shared markets. */
export const REGION_PAIR_AFFINITY = {
  'EAS-SEA':0.70, 'CARIB-NA':0.70, 'EUR-NAF':0.70,
};

export function borderFactor(o, d) {
  if (!o || !d || o.country === d.country) return 1.0;
  const aff = COUNTRY_AFFINITY[`${o.country}-${d.country}`]
           ?? COUNTRY_AFFINITY[`${d.country}-${o.country}`];
  if (aff != null) return aff;
  const rO = COUNTRY_REGION[o.country], rD = COUNTRY_REGION[d.country];
  if (rO != null && rO === rD) return INTL_SAME_REGION;
  const rp = rO && rD
    ? (REGION_PAIR_AFFINITY[`${rO}-${rD}`] ?? REGION_PAIR_AFFINITY[`${rD}-${rO}`])
    : null;
  if (rp != null) return rp;
  const pO = COUNTRY_PROPENSITY[o.country] ?? DEFAULT_PROPENSITY;
  const pD = COUNTRY_PROPENSITY[d.country] ?? DEFAULT_PROPENSITY;
  return (pO >= 0.8 && pD >= 0.8) ? INTL_CROSS_HIGH : INTL_CROSS_LOW;
}

// ─── Air captivity ─────────────────────────────────────────────────────────────
// Routes where flying is the only practical option carry far more traffic than
// gravity alone predicts (Jeju, Sapporo, Sydney–Melbourne, Jeddah–Riyadh...).
// Two flavours, and we take the MAX (they proxy the same thing — never stack):
//   1. isolated endpoints (islands / no ground link)  → up to CAPTIVITY_BOOST,
//      fading to 1 beyond ~7,000 km where every mode is air anyway.
//   2. domestic pairs in air-reliant countries (no rail, vast distances).

export const CAPTIVITY_BOOST      = 2.8;
/**
 * International pairs get a smaller island boost. Domestic resort islands
 * (Jeju, Sapporo, Hawaii) are captive corridors for their OWN country's
 * travelers; foreign visitors mostly route via the national gateways, so a
 * full 2.8x on e.g. Tokyo–Jeju would invent traffic that doesn't exist.
 */
export const CAPTIVITY_BOOST_INTL = 1.6;
export const CAPTIVITY_FULL_KM = 3000;
export const CAPTIVITY_ZERO_KM = 7000;

/** Airports with no practical ground link to their wider market. */
export const ISOLATED_AIRPORTS = new Set([
  'CJU', 'CTS', 'OKA', 'DPS',                       // Jeju, Sapporo, Okinawa, Bali
  'FUK',                                            // Kyushu — air owns Tokyo-Fukuoka (~90% share)
  'HNL', 'OGG', 'KOA', 'LIH', 'ITO',                // Hawaii
  'JNU', 'SIT', 'KTN', 'WRG', 'PSG', 'YAK', 'CDV',  // SE Alaska (no roads)
  'PER',                                            // Perth (isolated by distance)
]);

/** Island nations / territories with no external ground links. */
export const ISLAND_COUNTRIES = new Set([
  'NZ','TW','IS','MV','LK','MG','MU','SC','RE','KM','CV','ST','SH','FO',
  'CU','DO','JM','HT','BS','BB','AW','KY','CW','SX','AG','GD','KN','LC','VC',
  'DM','AI','VG','TC','GP','MQ','BQ','BL','BM','TT','PR','MT','CY',
  'FJ','PF','NC','VU','SB','WS','TO','KI','TV','NR','CK','PW','FM','MH','GU','AS','MP',
]);

function isIsolated(ap) {
  return ISOLATED_AIRPORTS.has(ap.code) || ISLAND_COUNTRIES.has(ap.country);
}

/**
 * Domestic air-reliance by country: how much domestic intercity travel funnels
 * into aviation (no rail network, hostile driving distances, archipelagos).
 * Baseline 1.0 = US-style (interstates + some rail). Default for unlisted: 1.2.
 */
export const AIR_RELIANT_DOMESTIC = {
  SA:2.4, AU:2.2, PG:2.2, PF:2.2, BS:2.0, ZA:1.9, VN:1.9, ID:1.9, PH:1.9,
  NZ:1.8, CD:1.8, FJ:1.8, MG:1.6, RU:1.6, GR:1.5, NO:1.5, CO:1.5,
  PE:1.5, CL:1.5, KZ:1.5, MN:1.5, IN:1.5, BR:1.4, AR:1.4, BO:1.4, AO:1.4,
  MM:1.4, CA:1.3, EC:1.3, MZ:1.3, ET:1.3, LA:1.3, JP:1.3, MX:1.2, PK:1.2,
  TR:1.1, US:1.0, GB:0.9, KR:0.9, ES:0.9, IT:0.9, CN:0.85, FR:0.8, DE:0.8,
  DK:0.8, AT:0.7, CH:0.6, BE:0.6, NL:0.6,
  // JP is 1.3 (not higher) because Shinkansen owns the Honshu corridors; the
  // huge air markets (Sapporo, Okinawa, Fukuoka) get the island boost instead.
};
export const DEFAULT_AIR_RELIANCE = 1.2;

/**
 * Ground-competition ramp for very short hops (< 200 km): nobody flies 120 km
 * when driving takes two hours. Applies only in countries with contiguous
 * road/rail networks — archipelago and fjord countries (ID, PH, GR, NO, NZ...)
 * are excluded because their sub-200 km hops are genuine overwater routes, as
 * are pairs touching an isolated airport (Hawaii inter-island, Alaska milk run).
 */
export const GROUND_RAMP_KM = 200;
const CONTIGUOUS_GROUND = new Set([
  'US','CA','MX','BR','AR','CN','IN','PK','BD','TR','SA','EG','ZA','NG','ET',
  'KE','RU','KZ','UA','PL','DE','FR','ES','IT','CZ','SK','HU','AT','CH','BE',
  'NL','RO','BG','RS','LT','LV','EE','BY','MD','DK','SE','KR','JP','VN','TH',
  'MY','AU','GB','IE','PT','MA','DZ','TN','IQ','IR','UZ','TM','AF','MN',
]);
function groundRampFactor(o, d, dist) {
  if (dist >= GROUND_RAMP_KM) return 1;
  if (isIsolated(o) || isIsolated(d)) return 1;
  if (!CONTIGUOUS_GROUND.has(o.country) || !CONTIGUOUS_GROUND.has(d.country)) return 1;
  const t = Math.max(0, (dist - 80) / (GROUND_RAMP_KM - 80));
  return 0.2 + 0.8 * t * t;
}

/**
 * Combined captivity/air-reliance multiplier for a pair.
 * max(islandCaptivity, domesticAirReliance) — see note above.
 */
export function captivityFactor(o, d, dist) {
  const domestic = o.country === d.country;
  let island = 1;
  if (isIsolated(o) || isIsolated(d)) {
    const boost = domestic ? CAPTIVITY_BOOST : CAPTIVITY_BOOST_INTL;
    const t = Math.max(0, Math.min(1,
      (CAPTIVITY_ZERO_KM - dist) / (CAPTIVITY_ZERO_KM - CAPTIVITY_FULL_KM)));
    island = 1 + (boost - 1) * t;
  }
  const reliance = domestic
    ? (AIR_RELIANT_DOMESTIC[o.country] ?? DEFAULT_AIR_RELIANCE)
    : 1;
  return Math.max(island, reliance);
}

/**
 * Base weekly one-way demand for a city pair at the reference price.
 * Airport populations are in millions (metro area).
 */
/**
 * Same-metro airport groups, kept as a derived view of data/metros.js for any
 * external consumer that still wants the raw code lists. The registry is the
 * single source of truth — edit metros.js, not this.
 */
export const METRO_GROUPS = METROS.map((m) => Object.keys(m.members));

/**
 * Two airports serve the same metro area when the metro registry says so, or as
 * a backstop when they sit within a few km of each other. Same-metro pairs
 * carry no real origin–destination air demand — nobody flies across town — so
 * their demand is suppressed entirely. Examples: JFK–EWR–LGA, LHR–LGW–LCY.
 *
 * The old city-string rule ("same country + same city field") is deliberately
 * GONE: it zeroed demand between same-NAME different-CITY pairs — Columbus OH
 * vs Columbus GA (CMH–CSG), the Norfolks (ORF–OFK), the Albanys (ALB–ABY), the
 * Augustas (AGS–AUG), the Watertowns (ART–ATY) and the three Greenvilles
 * (GSP/PGV/GLH). Every genuine shared-city metro is in the registry instead.
 * The distance backstop is deliberately small so genuine short water/island
 * hops (which have no road alternative) keep their demand.
 */
export const SAME_METRO_MAX_KM = 35;
export function isSameMetro(o, d, dist) {
  if (!o || !d) return false;
  if (o.code && d.code && sameMetroCodes(o.code, d.code)) return true;
  const km = dist != null ? dist : distanceKm(o, d);
  return km < SAME_METRO_MAX_KM;
}

// ─── Surface-connected city pairs (H18) ───────────────────────────────────────
// Two DIFFERENT cities close enough that road or rail is the real way between
// them carry no meaningful air O&D — nobody books a 45 km flight when a train or
// a 40-minute drive exists. These are NOT "same metro": they price and pool as
// distinct cities for every OTHER route they fly (HKG keeps all its long-haul,
// SZX keeps all of its) — only the DIRECT hop between the two is suppressed.
//
// The 35 km same-metro backstop above is deliberately too tight to catch them
// (HKG–SZX 38 km, SIN–JHB 47 km, BWI–DCA 48 km, AMS–RTM 45 km, EDI–GLA 67 km…),
// and simply widening that backstop would wrongly kill genuine short WATER and
// ISLAND hops in the same band (Nantucket–Hyannis, Saba–St Maarten, Vancouver–
// Nanaimo) which have no road alternative and ARE real flights. So the rule is:
// suppress a sub-60 km different-city pair UNLESS it is an explicit water-hop
// exception below.
export const SURFACE_CONNECTED_MAX_KM = 65;

function pairKey2(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

// Sub-65 km different-city pairs that ARE real flights because water or terrain
// leaves no road/rail link between them. Keyed by the two IATA codes sorted and
// joined '|'. Add a pair here to spare it from surface suppression.
// data-integrity-test.mjs re-derives the in-band different-city set and fails if
// a NEW unclassified pair appears, so this list cannot silently fall out of date.
export const WATER_HOP_PAIRS = new Set([
  pairKey2('ACK', 'HYA'), pairKey2('ACK', 'MVY'), pairKey2('HYA', 'MVY'), // Nantucket / Martha's Vineyard / Cape Cod
  pairKey2('AXA', 'SBH'), pairKey2('SAB', 'SBH'), pairKey2('SAB', 'SXM'), // NE Caribbean islands: Anguilla / St Barth /
  pairKey2('SAB', 'SKB'), pairKey2('SAB', 'AXA'),                         //   Saba / St Maarten / St Kitts
  pairKey2('MCD', 'PLN'), pairKey2('CIU', 'MCD'),                         // Mackinac Island, MI
  pairKey2('PSG', 'WRG'),                                                 // Petersburg / Wrangell, AK inside passage
  pairKey2('YCD', 'YVR'), pairKey2('YVR', 'YYJ'),                         // Georgia Strait: Vancouver / Nanaimo / Victoria
  pairKey2('EFL', 'ZTH'),                                                 // Kefalonia / Zakynthos (Ionian)
  pairKey2('KOI', 'WIC'),                                                 // Orkney / Wick
  pairKey2('BCD', 'ILO'),                                                 // Bacolod (Negros) / Iloilo (Panay)
  pairKey2('IAO', 'SUG'),                                                 // Siargao / Surigao
  pairKey2('BTH', 'TNJ'),                                                 // Batam / Tanjung Pinang (Riau islands)
  pairKey2('KOS', 'PQC'),                                                 // Sihanoukville / Phu Quoc island
  pairKey2('CUN', 'CZM'),                                                 // Cancún / Cozumel island
  pairKey2('SJU', 'VQS'),                                                 // San Juan / Vieques island
  pairKey2('HKG', 'MFM'), pairKey2('MFM', 'SZX'), pairKey2('HKG', 'ZUH'), // Pearl River estuary crossings
  pairKey2('TJS', 'TRK'),                                                 // Tarakan island / Tanjung Selor, Borneo
  pairKey2('ACE', 'FUE'),                                                 // Lanzarote / Fuerteventura (Canaries)
  pairKey2('GIB', 'TTU'),                                                 // Gibraltar / Tetouan across the Strait
  pairKey2('CAB', 'SZA'),                                                 // Cabinda exclave / Soyo (Congo river mouth)
]);

// True when o and d are different-city airports whose real link is surface
// transport (see the note above). Same-airport-complex and same-metro-registry
// pairs are handled by isSameMetro; this covers only the 35–65 km band.
export function isSurfaceConnected(o, d, dist) {
  if (!o || !d || !o.code || !d.code || o.code === d.code) return false;
  const km = dist != null ? dist : distanceKm(o, d);
  if (km < SAME_METRO_MAX_KM || km >= SURFACE_CONNECTED_MAX_KM) return false;
  if (WATER_HOP_PAIRS.has(pairKey2(o.code, d.code))) return false;
  return true;
}

// ─── Duplicate-location airports (DKR/DSS) ────────────────────────────────────
// Two DISTINCT codes at (near-)identical coordinates — a data duplicate such as
// DKR/DSS (both "Blaise Diagne Intl", Dakar, 14.67,-17.07). No route can be
// flown between them: the route guards reject it and their demand is already
// zero via the same-metro backstop. Kept as a tested helper so the guards and
// data-integrity-test.mjs agree on the threshold.
export const SAME_LOCATION_MAX_KM = 2;
export function isSameLocation(o, d, dist) {
  if (!o || !d || !o.code || !d.code || o.code === d.code) return false;
  const km = dist != null ? dist : distanceKm(o, d);
  return km < SAME_LOCATION_MAX_KM;
}

// ─── Metro-level demand endpoints ─────────────────────────────────────────────
// A multi-airport metro is priced as ONE demand endpoint: the largest member
// mass and the strongest member attractiveness stand in for the whole metro.
// Priced at the members' shared data rather than any single field's, so
// baseCityPairDemand(EWR, LGW) === baseCityPairDemand(JFK, LHR): one member
// pair per metro pair, one market. The tick then runs ONE share fight over that
// market for all member pairs (see the metro pre-pass in simulation.js) —
// which is what kills the old N-airport-pairs × full-metro-demand duplication.

/** Cached member airport records per metro id (data never changes at runtime). */
const _metroMembersCache = new Map();
function metroMemberRecords(metro) {
  let recs = _metroMembersCache.get(metro.id);
  if (!recs) {
    recs = Object.keys(metro.members)
      .map((code) => getAirport(code))
      .filter(Boolean);
    _metroMembersCache.set(metro.id, recs);
  }
  return recs;
}

/** Demand mass of a metro: its heaviest member (masses are metro-wide already). */
function metroDemandMass(metro, domesticPair) {
  let best = 0;
  for (const ap of metroMemberRecords(metro)) {
    const m = getDemandMass(ap, domesticPair);
    if (m > best) best = m;
  }
  return best;
}

/** Attractiveness of a metro: its strongest member profile. */
function metroDemandMultiplier(metro) {
  let best = 0;
  for (const ap of metroMemberRecords(metro)) {
    const m = demandMultiplier(ap.code);
    if (m > best) best = m;
  }
  return best;
}

export function baseCityPairDemand(originCode, destCode) {
  const o = getAirport(originCode);
  const d = getAirport(destCode);
  if (!o || !d) return 0;
  // No real O&D demand between two airports serving the same metro area, or
  // between two different cities linked by road/rail (a sub-65 km surface hop).
  // (Checked on the REAL airports — the primaries of two different metros are
  // never same-metro, and same-metro members must short-circuit before pricing.)
  const odDist = distanceKm(o, d);
  if (isSameMetro(o, d, odDist) || isSurfaceConnected(o, d, odDist)) return 0;

  // Price the pair at the metro primaries: every member pair of the same metro
  // pair must return the SAME total market. Distance, country, captivity and
  // border all use the primaries so the total is exactly member-independent.
  const mO = metroOf(originCode);
  const mD = metroOf(destCode);
  const po = mO ? getAirport(mO.primary) ?? o : o;
  const pd = mD ? getAirport(mD.primary) ?? d : d;
  const dist = distanceKm(po, pd);

  // Demand mass generalises population: it adds tourism + national-gateway pull for
  // airports that population alone under-rates. `effectivePop` overrides stay intact,
  // and any airport without the new fields keeps mass === population (no change).
  // Metro endpoints take their heaviest member's mass (each member already
  // carried the metro-wide figure) and their strongest member's attractiveness.
  const domesticPair = po.country === pd.country;
  const popO = mO ? metroDemandMass(mO, domesticPair) : getDemandMass(o, domesticPair);
  const popD = mD ? metroDemandMass(mD, domesticPair) : getDemandMass(d, domesticPair);

  // Business/leisure attractiveness multiplier — cities that are strong corporate
  // or tourism destinations generate more demand than population alone implies.
  const multO = mO ? metroDemandMultiplier(mO) : demandMultiplier(originCode);
  const multD = mD ? metroDemandMultiplier(mD) : demandMultiplier(destCode);

  // Metro demand lift. Benchmarked against metro-AGGREGATED real O&D (sum over
  // member airport pairs — bench.mjs `metroX` column), pairs between big
  // multi-airport metros systematically undershot at 0.44–0.60: a metro that
  // needed five airports built generates more travel than even its largest
  // member's mass implies. Each side contributes sqrt(lift), like every other
  // endpoint factor under the gravity sqrt. Single-airport endpoints lift 1.

  // Country propensity-to-fly: full strength on international pairs, softened
  // on domestic ones (see COUNTRY_PROPENSITY). Enters under the sqrt so the
  // effective pair factor is sqrt(pO·pD).
  const domestic = domesticPair;
  let pO = COUNTRY_PROPENSITY[po.country] ?? DEFAULT_PROPENSITY;
  let pD = COUNTRY_PROPENSITY[pd.country] ?? DEFAULT_PROPENSITY;
  if (domestic) {
    pO = Math.pow(pO, DOMESTIC_PROPENSITY_EXP);
    pD = Math.pow(pD, DOMESTIC_PROPENSITY_EXP);
  }

  // Border friction (1.0 domestic), air-captivity boost, short-hop ground ramp —
  // all at the primaries, so member pairs cannot disagree about the total.
  const border  = borderFactor(po, pd);
  const captive = captivityFactor(po, pd, dist);
  const ground  = groundRampFactor(po, pd, dist);

  // Gravity model with softened distance decay (exponent 1.1 vs. the classic 1.5).
  // The gentler exponent reflects that above ~5,000 km there are no alternatives to
  // flying, so demand doesn't decay as steeply as in short-haul markets where trains
  // and driving compete. (Audited 2026-07 — the distance curve matched real long-haul
  // vs short-haul ratios well and was deliberately left unchanged.)
  //
  // Multiplier 1,900 calibrated against real-world 2025 O&D benchmarks
  // (docs/DEMAND_MODEL_AUDIT.md; 47 pairs, geometric-mean model/real ≈ 1.0).
  // Reference points (one-way pax/wk, total market across all carriers):
  //   GMP-CJU  (451 km, captive island + 13M visitors)   → ~104,000  (real ~111,000)
  //   HND-CTS  (819 km, captive island)                  → ~105,000  (real ~91,000)
  //   JED-RUH  (853 km, SA air-reliant domestic)         →  ~66,000  (real ~73,000)
  //   SGN-HAN  (1,160 km, VN air-reliant + gateway mass) →  ~84,000  (real ~75,000)
  //   ORD-LGA  (1,177 km)                                →  ~21,000  (real ~24,000)
  //   JFK-LAX  (3,975 km)                                →  ~16,600  (real ~23,000)
  //   JFK-LHR  (5,540 km, US-GB affinity 0.85)           →  ~15,400  (real ~21,000)
  //   SIN-LHR  (10,880 km)                               →  ~11,300  (real ~9,700)
  //   DAC-DEL  (1,426 km, low propensity + IN-BD 0.45)   →   ~3,500  (real ~2,400)
  const lift = Math.sqrt((mO?.lift ?? 1) * (mD?.lift ?? 1));

  return Math.round(
    (Math.sqrt(popO * multO * pO * popD * multD * pD) * 1900 * border * captive * ground * lift)
      / Math.pow(1 + dist / 3000, 1.1)
  );
}

/** Distance in km between two airport codes. Returns 0 if either unknown. */
export function routeDistance(originCode, destCode) {
  const o = getAirport(originCode);
  const d = getAirport(destCode);
  return o && d ? Math.round(distanceKm(o, d)) : 0;
}

/**
 * Market reference price for a route ($ one-way, economy).
 * Players can price above or below this — demand adjusts via elasticity.
 */
// ── World fare index (New World Restrictions) ────────────────────────────────
// Scales the whole reference-fare ladder for a world. Restricted worlds run at
// 0.85 — same demand, 15% lower prices — which is the lever that moves margins,
// because the gap is in the fare-to-cost ratio rather than in any missing cost
// line (a leased 737-800 at 85% load runs 62.5% costs; real carriers run 92-97%).
//
// Scaling the REFERENCE rather than realised revenue matters: the demand model
// prices elasticity off playerPrice / referencePrice, so moving both together
// leaves demand untouched and simply lowers the whole ladder. Cutting revenue
// directly would show players a fare they don't actually receive.
//
// Module-scoped rather than threaded because referencePrice() is a pure
// (origin, dest) function called from ~12 sites across the demand model,
// competitor AI, encroachment, positioning and network layers — none of which
// carry world context. gameReducer sets this from state on EVERY action and the
// reducer is synchronous, so no two airlines can interleave.
//
// KNOWN LIMIT: server code that calls referencePrice OUTSIDE the reducer (rival
// view building) reads whatever the last reducer call set. Harmless while every
// world in a process shares an index; revisit if restricted and classic worlds
// are ever ticked in the same process without a reducer call in between.
// The index restricted worlds run at.
//
// CALIBRATION (learned the hard way, 2026-07-29). A fare cut does NOT lower
// margins by its own size — it multiplies the BREAK-EVEN LOAD FACTOR by 1/f,
// because costs don't fall with fares. Measured on a real Old Metal route
// (757-200, DFW-JFK, 2,235 km, no catering):
//
//   fareIndex   margin at full load   break-even load
//     1.00            16.5%                82.5%
//     0.95            12.1%                86.9%
//     0.90             7.3%                91.7%
//     0.85             1.8%                97.1%   <- shipped first, far too deep
//
// At 0.85 the player was flying 98.9% load with fares 30% over reference and
// clearing 2%: every route below 97% load lost money.
//
// SETTLED AT 0.95 — a flat 5% trim, identical for every airline in the world.
//
// It has to be flat. A fare index is a MARKET price: every airline flying
// JFK-LAX faces the same reference, so an index that varies by who is asking is
// incoherent. (A maturity ramp was tried and scrapped for exactly this.)
//
// Know what a flat revenue cut does, because it is not symmetric. At margin m,
// a cut of c leaves 1 - (1-m)/(1-c):
//
//   airline at   4% margin  ->   -1.1% after a 5% cut
//   airline at  10% margin  ->   +5.3%
//   airline at  15% margin  ->  +10.5%
//   airline at  33% margin  ->  +29.5%
//
// It is deliberately SMALL now. The trim used to carry the whole burden of
// pulling mature margins down, which it could never do without killing startups
// — it is flat, so it bites hardest exactly where margins are thinnest. The
// labour seniority scale (data/labor.js) does that job properly: it targets
// maturity by construction and cannot be dodged by re-pricing. The trim is now
// just a light thumb on the scale that says "this world is tighter", and the two
// together land a mature carrier near 15%:
//
//   airline age    seniority    mature margin (with this 5% trim)
//        0            x1.00          29.7%
//       10            x1.63          23.4%
//       20+           x2.50          14.6%
//
// So it bites hardest on thin operators and softest on fat ones. It lands softer
// still on a big airline because ~12.8% of a mature carrier's revenue is
// ANCILLARY (bags, seats, catering upsell), which no fare index touches — a
// "5% fare cut" is a 4.4% revenue cut for them.
//
// The practical read: this makes a restricted world unforgiving of a badly
// configured airline (four-class cabins and full catering on short-haul will not
// survive it) while a well-run one keeps a real, thinner margin. That is the
// intent. Watch a live world before moving it — and note it is SEEDED INTO
// AIRLINE STATE AT JOIN, so tickConfig alone will not move existing players.
// Use tools/rebase-world-fare-index.mjs to retune a live world.
//
// Tunable per world via tickConfig.fareIndex, but note it is SEEDED INTO AIRLINE
// STATE AT JOIN — changing tickConfig alone will not move existing players.
// Use tools/rebase-world-fare-index.mjs to retune a live world.
export const NWR_FARE_INDEX = 0.95;

let _fareIndex = 1;

/** Set the active world's fare index (1 = classic). Clamped to a sane band. */
export function setFareIndex(v) {
  const n = Number(v);
  _fareIndex = (Number.isFinite(n) && n > 0.25 && n <= 2) ? n : 1;
}

/** The fare index currently in effect. */
export function getFareIndex() { return _fareIndex; }

// ─── NWR yield choke (monopoly pricing has a ceiling) ─────────────────────────
//
// WHY: Headwinds has no AI encroachment — competition is humans only — so on a
// lightly-populated world every route is a monopoly. Elasticity alone
// ((ref/price)^2 leisure) can't discipline pricing when the city-pair pool is
// 3-10x a small airline's seats: the fare equilibrium ("raise fares until the
// post-elasticity pool shrinks to my capacity") lands at 1.3-3x reference with
// the aircraft still full. Real airlines can't live there because a rival
// undercuts within a season; this choke stands in for that missing rival.
//
// Above a threshold ratio of reference, demand takes an extra exp(-k·overage)
// penalty on top of elasticity. The threshold scales with quality — a genuinely
// premium product (quality 100) earns pricing headroom to 1.25x reference,
// a mediocre one gets 1.10x. Below the threshold the factor is exactly 1, so
// startups pricing at or near reference feel literally nothing.
//
//   pool vs seats     old fare equilibrium     with choke
//        3x                 ~1.7x ref           ~1.18x ref
//       10x                 ~3.0x ref           ~1.23x ref
//
// Module-scoped like _fareIndex, set from state at the same choke points
// (reducer top, providers, humanRivals). Off (false) in classic worlds, where
// priceChokeFactor must return bit-identical values — asserted by test and by
// the golden master.
export const NWR_CHOKE_THRESHOLD_BASE = 1.10;  // quality <= 50
export const NWR_CHOKE_THRESHOLD_MAX  = 1.25;  // quality 100
export const NWR_CHOKE_STEEPNESS      = 15;

let _nwrYieldChoke = false;

/** Enable/disable the restricted-world yield choke (set from state, like the fare index). */
export function setNwrYieldChoke(on) { _nwrYieldChoke = on === true; }
export function getNwrYieldChoke() { return _nwrYieldChoke; }

/**
 * Extra demand multiplier for pricing above the quality-scaled threshold.
 * Exactly 1 when the choke is off, or at/below the threshold.
 * @param {number} ratio    price / reference for the class being priced
 * @param {number} quality  offer quality score 0-100 (headroom scales with it)
 */
export function nwrYieldChokeFactor(ratio, quality = 50) {
  if (!_nwrYieldChoke) return 1;
  const q   = Math.max(0, Math.min(100, Number(quality) || 50));
  const thr = NWR_CHOKE_THRESHOLD_BASE +
    (NWR_CHOKE_THRESHOLD_MAX - NWR_CHOKE_THRESHOLD_BASE) * Math.max(0, (q - 50) / 50);
  return ratio > thr ? Math.exp(-NWR_CHOKE_STEEPNESS * (ratio - thr)) : 1;
}

// ─── NWR load-factor realism (spill + weekly variance) ────────────────────────
//
// WHY: every route simulator fills seats with a flat min(demand, capacity), so
// the moment weekly demand exceeds weekly seats the airline banks EVERY seat —
// 100.0% load factor, forever, in both directions. Real airlines sit at ~83%
// system LF *while* their best flights sell out, because demand arrives per
// departure / per day / per direction and you size for the peak: Friday is
// full, Tuesday is 60%. A weekly demand pool erases that entirely, and it is
// the single biggest term in mature margins running 3-4x reality (revenue per
// aircraft ~$122M/yr vs a real $25-40M). No cost rate fixes that — the per-unit
// costs are already right; the denominator is inflated.
//
// THE MODEL, applied only in restricted worlds:
//
//   1. A structural ceiling: only NWR_LF_CEILING of weekly seats are
//      *achievable*, representing day-of-week peaking and directional
//      imbalance that more demand never cures.
//   2. Spill against that ceiling: per-departure demand is treated as
//      Normal(D, NWR_DEMAND_CV·D) and the seats sold are E[min(N, C)] via the
//      standard normal loss function — closed form, no RNG, replay-safe.
//      Deep-oversubscribed routes asymptote to the ceiling; a route at
//      demand ≈ capacity lands ~87%; a 60%-LF route loses well under a point.
//      It only bites full aircraft — the progressive lever the flat fare trim
//      never was.
//   3. Weekly variance: a deterministic per-route-per-week jitter of up to
//      ±NWR_LF_JITTER in either direction, hashed from (route key, absolute
//      week). No Math.random() — the same state replays to the same bytes on
//      client, server and golden master. A sold-out route breathes between
//      ~92.6% and ~97.4% instead of pinning at a constant.
//
// Classic worlds never attach the jitter field, so their simulation path is
// byte-identical to before — asserted by test and by the golden master.
export const NWR_LF_CEILING = 0.95;
export const NWR_LF_JITTER  = 0.025;
// Per-departure demand spread (coefficient of variation). 0.30 put a
// demand-equals-capacity route at 85.4%, which read as too harsh; 0.25 lands
// parity at ~87% and leaves the oversubscribed asymptote (~95%) unchanged.
export const NWR_DEMAND_CV  = 0.25;

/** Standard normal pdf. */
const _phi = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

/** Standard normal cdf (Abramowitz–Stegun 7.1.26, |err| < 1.5e-7). */
function _Phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
               t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - _phi(Math.abs(z)) * poly;
  return z >= 0 ? p : 1 - p;
}

/**
 * Expected seats sold when demand ~ Normal(demand, cv·demand) meets a hard
 * capacity `cap`: E[min(X, cap)] = D − σ·L(z), L(z) = φ(z) − z·(1 − Φ(z)).
 * Always ≤ min(demand, cap); ≈ demand when demand ≪ cap.
 */
export function expectedCarried(demand, cap, cv = NWR_DEMAND_CV) {
  const D = Math.max(0, Number(demand) || 0);
  const C = Math.max(0, Number(cap) || 0);
  if (D <= 0 || C <= 0) return 0;
  const sigma = cv * D;
  if (sigma <= 0) return Math.min(D, C);
  const z = (C - D) / sigma;
  const loss = _phi(z) - z * (1 - _Phi(z));
  return Math.max(0, Math.min(C, D - sigma * loss));
}

/**
 * Deterministic weekly jitter in [1 − NWR_LF_JITTER, 1 + NWR_LF_JITTER],
 * keyed on (route key, absolute week) via FNV-1a. Same inputs → same factor
 * on every machine, so optimistic client apply, server replay and the golden
 * master all agree.
 */
export function weeklyLoadJitter(routeKey, absWeek) {
  const s = `${routeKey}|${Math.floor(Number(absWeek) || 0)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // FNV-1a alone clusters: for near-identical keys ("r|31" vs "r|32") the
  // difference never leaves the low bits, and the division below reads the
  // HIGH bits — every week lands at ~0.5 and nothing varies. A murmur3-style
  // finalizer avalanches the low bits across the whole word.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  const u = (h >>> 0) / 0xffffffff;          // [0, 1]
  return 1 - NWR_LF_JITTER + 2 * NWR_LF_JITTER * u;
}

/**
 * The factor a route's demand should be scaled by under the NWR load model:
 * spill against the achievable ceiling, times this week's jitter, never
 * exceeding physical capacity. Returns 1 when the model is off (no jitter
 * attached) so classic worlds are untouched.
 */
export function nwrDemandScale(demand, capacity, jitter) {
  if (jitter == null) return 1;               // model off — classic world
  const D = Math.max(0, Number(demand) || 0);
  const C = Math.max(0, Number(capacity) || 0);
  if (D <= 0 || C <= 0) return 1;
  const carried = expectedCarried(D, C * NWR_LF_CEILING) * jitter;
  return Math.min(carried, C) / D;
}

export function referencePrice(originCode, destCode) {
  const o = getAirport(originCode);
  const d = getAirport(destCode);
  if (!o || !d) return Math.round(200 * _fareIndex);
  const dist = distanceKm(o, d);
  // Reference fares trimmed 8% below baseline to tighten yields and make
  // sustained profitability harder (was −5%, originally +10%).
  return Math.round((80 + dist * 0.09) * 0.87 * _fareIndex);
}

// ─── Market capitalisation ─────────────────────────────────────────────────────

/**
 * Founder share count every airline is incorporated with.
 *
 * This is no longer "the" share count — since the capital-markets rework each
 * airline carries its OWN count in `state.equity.shares`, which share issuance
 * and buybacks move. TOTAL_SHARES remains the universal starting value (and the
 * migration default for saves written before `state.equity` existed), so it is
 * still the right fallback wherever a share count is missing.
 *
 * Deliberately kept at 100M for every airline, new and migrated: a uniform
 * founder count means share prices are directly comparable inside a world with
 * no per-world configuration, no reverse-split migration, and no need for stock
 * splits later (a $12.75M startup opens near $0.13 and a mature $2.7B carrier
 * lands near $27 — a realistic range for a whole airline's life).
 */
export const TOTAL_SHARES = 100_000_000;

/** Scale factor for packing a per-share dollar figure into an integer score. */
export const SVPS_SCALE = 10_000;

/**
 * Equity block for a NEWLY INCORPORATED airline: private, and entirely closely
 * held. There is no tradable float until it lists — GO_PUBLIC creates one by
 * issuing new shares on top of the founder block — and a private airline has no
 * traded share price, so it takes no place in the standings until it does.
 */
export function emptyEquity() {
  return {
    shares:               TOTAL_SHARES,  // shares outstanding
    // Founder block — the part NOT publicly traded. All of it, to begin with.
    founderShares:        TOTAL_SHARES,
    isPublic:             false,
    cumDividendsPerShare: 0,             // lifetime dividends per share ($)
    ipoWeek:              null,          // absolute week of listing
    offeringsThisYear:    0,             // secondary-offering throttle (per game year)
    buybacksThisYear:     0,             // buyback throttle (per game year)
    buybacksEver:         0,             // ever returned capital? (better offering price)
    dividendPolicy:       0,             // payout ratio of trailing-quarter profit
  };
}

/**
 * Equity block for an airline that PREDATES the capital-markets rework.
 *
 * Those airlines were already trading against a fixed 100M-share float, so they
 * migrate as listed, with the default free float already in public hands. That is
 * what keeps a live world's market working through the deploy and keeps the
 * standings order unchanged at migration time — see tools/backfill-equity.mjs.
 */
export function migratedEquity() {
  return {
    ...emptyEquity(),
    isPublic:      true,
    founderShares: Math.round(TOTAL_SHARES * (1 - STOCK_MARKET.DEFAULT_FREE_FLOAT_PCT)),
  };
}

/** Shares outstanding for an airline state / rival payload, with safe fallback. */
export function sharesOf(x) {
  const n = Number(x?.equity?.shares ?? x?.shares);
  return Number.isFinite(n) && n > 0 ? n : TOTAL_SHARES;
}

/**
 * Shareholder Value Per Share — the world leaderboard metric.
 *
 * SVPS = share price + lifetime dividends per share.
 *
 * Market cap measures how BIG an airline got, which is why it rewarded raising
 * capital and punished ever returning it (a dividend or a buyback spends cash,
 * so it shrinks the cap and therefore the old score). SVPS measures value
 * created per unit of ownership instead, so issuing shares only wins if the
 * capital out-earns the dilution, buybacks win when the stock is cheap, and
 * dividends are rank-neutral by construction via the add-back term.
 *
 * Because every airline is incorporated with the same founder share count and
 * the same starting capital, SVPS is equivalent to a total-return index on a
 * common base — a late joiner starts where everyone started and simply has less
 * time to compound.
 */
export function svpsOf(x) {
  const price = Number(x?.sharePrice);
  const divs  = Number(x?.equity?.cumDividendsPerShare ?? x?.cumDividendsPerShare ?? 0);
  return (Number.isFinite(price) ? price : 0) + (Number.isFinite(divs) ? divs : 0);
}

/** SVPS packed as an integer for the standings table (ten-thousandths of $1). */
export function svpsScore(svps) {
  const n = Math.round((Number.isFinite(svps) ? svps : 0) * SVPS_SCALE);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Valuation model v2 — tunable constants (single source of truth; the stock
 * market plan and any balance work reference these names).
 */
export const VALUATION = {
  BOOK_WEIGHT:       0.85,     // fraction of net book value the market credits
  FLEET_NAV_WEIGHT:  0.90,     // owned-fleet NAV haircut (illiquid asset)
  BOOK_FLOOR:        0.40,     // fair value never drops below 40% of net book
  // Earnings multiple band. Real airlines are the lowest-multiple, most cyclical
  // sector there is (P/E 6-10, EV/Sales well under 1.5). The old 12 + (-5..+15)
  // + (0..+5) band topped out at 32x, which meant every extra $100k/week of
  // profit added ~$166M of market cap — one good route was worth a quarter
  // billion. Band is now 5..13.
  PE_BASE:           8,
  PE_GROWTH_SPAN:    3,        // growth contributes -3..+3
  PE_REP_SPAN:       2,        // reputation contributes 0..+2
  // Hard backstop: the earnings term can never exceed this multiple of
  // annualized revenue, so a valuation cannot run away from the actual
  // business however implausible the margin. This is the single change that
  // kills the money printer (a 53%-net-margin carrier re-rates ~8x down).
  EARNINGS_SALES_CAP: 1.20,
  // Lazy-balance-sheet penalty: cash beyond what an airline of this size would
  // sensibly hold is credited at a fraction of face value. Idle cash stops
  // being free market cap, which is what gives buybacks and dividends a reason
  // to exist. Never applied to cold valuations (revenueHint 0) or below the
  // floor, so startup capital is never treated as idle.
  IDLE_CASH_REV_FRAC: 0.20,    // "sensible" = 20% of annualized revenue...
  IDLE_CASH_FLOOR:   25_000_000,  // ...but never less than $25M
  IDLE_CASH_WEIGHT:  0.25,     // excess credited at 25c on the dollar
  MIN_EARNINGS_WEEKS: 4,       // earnings ignored entirely below this much history
  EARNINGS_CONF_POW: 2,        // quadratic confidence ramp — short records barely count
  LOSS_MULTIPLE:     4,        // distressed multiple on annualized losses
  CONVERGENCE:       0.30,     // weekly convergence toward fair value
  // Weekly move band, applied to the published market cap before noise. 8% is
  // the RESTING band — enough to stop a single-week windfall or a loan draw from
  // teleporting the price. It is deliberately NOT a hard governor: a flat 8%
  // meant an airline whose fair value had genuinely re-rated (a startup that
  // compounds 100x in three game years is normal here) could never catch up —
  // the print stayed pinned to the ramp, sometimes two orders of magnitude below
  // fair value, which made the share price carry no information about the
  // business and let rivals buy a stake for a rounding error. The band now
  // WIDENS with the size of the gap (see moveClampFor), so ordinary weeks are
  // unchanged and a real re-rating converges in weeks instead of years.
  WEEKLY_MOVE_CLAMP: 0.08,     // resting band: max ±move per week (before noise)
  MOVE_CLAMP_MAX:    0.35,     // widest catch-up band, however far off the print is
  MOVE_CLAMP_GAP_POW: 0.5,     // band scales with gap^this (sqrt: gentle, unbounded input)
  NOISE_PCT:         0.035,    // ±3.5% weekly noise band
  MIN_MARKET_CAP:    500_000,  // absolute floor ($), regardless of size
  // Asset-proportional equity floor. A flat $500k floor is meaningless for an
  // airline that owns aircraft: a leveraged startup whose debt exceeds its
  // credited assets has a NEGATIVE net book for its first weeks, so both
  // fair-value terms go negative and it pins at $500k — which, against the 100M
  // founder share count, is a $0.0050 share price. It then teleports by two
  // orders of magnitude the week the earnings term switches on. Floor the
  // valuation at a fraction of GROSS assets instead (what the airline owns,
  // before what it owes), so a real balance sheet keeps a real, if distressed,
  // equity value and the price never has to climb out of a hole it should never
  // have been in. Distressed equity is cheap, not free.
  ASSET_FLOOR_FRAC:  0.08,     // equity floor = 8% of gross assets
};

/**
 * Weekly move band for the published market cap, given how far the print sits
 * from fair value.
 *
 *   gap  1x  ->  8.0%   (an ordinary week — behaviour is unchanged)
 *   gap  2x  -> 11.3%
 *   gap  4x  -> 16.0%
 *   gap 10x  -> 25.3%
 *   gap 19x+ -> 35.0%   (MOVE_CLAMP_MAX)
 *
 * The gap is measured symmetrically (a print 10x too HIGH widens the band just
 * as much as one 10x too low) so a collapse reprices as fast as a re-rating.
 *
 * @param {number} prevMarketCap  last week's published cap
 * @param {number} fairValue      this week's fair value
 * @returns {number} max fractional move for the week, before noise
 */
export function moveClampFor(prevMarketCap, fairValue) {
  const V = VALUATION;
  const p = Number(prevMarketCap), f = Number(fairValue);
  if (!(p > 0) || !(f > 0)) return V.WEEKLY_MOVE_CLAMP;
  const gap = Math.max(f / p, p / f);
  return Math.min(V.MOVE_CLAMP_MAX,
                  V.WEEKLY_MOVE_CLAMP * Math.pow(gap, V.MOVE_CLAMP_GAP_POW));
}

/**
 * Republish price and cap after the SHARE COUNT changes (IPO, secondary
 * offering, buyback).
 *
 * Why this exists: the published market cap is a smoothed, path-dependent series
 * (converge + clamp + noise), but a share issue changes the divisor INSTANTLY.
 * Without rebasing the cap in the same step, selling 25% of the company divided
 * the price by 1.333 while the cap could only climb its weekly band, so a raise
 * cost ~17% of the share price on the spot — and, since the leaderboard ranks on
 * value per share, cost the player rank for doing something value-neutral. The
 * cash the market just handed over is added to the cap at face value at the same
 * instant the shares appear, so a raise moves the price only by its discount
 * (and a buyback only by its premium), which is the honest per-share result.
 *
 * @param {object} prev              airline state (reads marketCap)
 * @param {object} p
 * @param {number} p.shares          share count AFTER the action
 * @param {number} [p.cashDelta]     cash the company received (+) or paid out (−)
 * @returns {{ marketCap: number, sharePrice: number }}
 */
export function repriceForShareChange(prev, { shares, cashDelta = 0 }) {
  const base = Number(prev?.marketCap);
  const cap  = Math.max(
    VALUATION.MIN_MARKET_CAP,
    (Number.isFinite(base) && base > 0 ? base : 0) + (Number(cashDelta) || 0),
  );
  const n = Number(shares) > 0 ? Number(shares) : TOTAL_SHARES;
  return { marketCap: cap, sharePrice: cap / n };
}

/**
 * Outstanding balance of a loan book (present-value of remaining payments —
 * the same math REPAY_LOAN and the weekly tick use). Pure over the engine's
 * loan shape: { interestRate (annual), weeklyPayment, weeksRemaining }.
 */
export function loanOutstanding(loans) {
  let total = 0;
  for (const loan of loans ?? []) {
    const n = loan.weeksRemaining ?? 0;
    if (n <= 0) continue;
    const weeklyRate = (loan.interestRate ?? 0) / 52;
    total += weeklyRate > 0
      ? Math.round(loan.weeklyPayment * (1 - Math.pow(1 + weeklyRate, -n)) / weeklyRate)
      : Math.round((loan.weeklyPayment ?? 0) * n);
  }
  return total;
}

/**
 * Compute market capitalisation and share price for an airline (valuation v2).
 *
 * Fundamentals: net book value (cash + discounted fleet NAV + stock portfolio
 * − outstanding debt) plus an earnings component (annualized trailing profit ×
 * a growth/quality P/E, scaled by a history-confidence ramp). The published
 * price then CONVERGES toward that fair value — clamped to ±20% a week, with a
 * small noise term — instead of teleporting, so single-week windfalls, loan
 * draws, and asset shuffles can't spike the price (or the leaderboard, or the
 * stock market) in one tick.
 *
 * Backward compatible: called with only (profitHistory, cash, qualityScore) it
 * returns the pure fair value (no smoothing) — used for cold valuations such
 * as save-load fallbacks and acquisition pricing.
 *
 * @param {number[]} profitHistory  Weekly profit figures, most-recent last (up to last 12 used).
 * @param {number}   cash           Current cash balance.
 * @param {number}   [qualityScore] 0–100 quality/reputation score; defaults to 50.
 * @param {object}   [extras]
 * @param {number}   [extras.fleetNAV]       Depreciated value of OWNED aircraft ($).
 * @param {number}   [extras.debt]           Outstanding loan balance ($) — see loanOutstanding().
 * @param {number}   [extras.portfolioValue] Mark-to-market value of stock held in rivals ($).
 * @param {number}   [extras.prevMarketCap]  Last week's market cap — enables convergence/clamp.
 * @param {number}   [extras.noise]          Pre-rolled noise fraction (e.g. ±0.015). Multiplayer
 *                                           passes a server-seeded value; solo rolls locally.
 * @param {number}   [extras.revenueHint]    Recent avg weekly revenue ($) — stabilises the growth
 *                                           denominator and the loss-cliff interpolation width, and
 *                                           sets the idle-cash threshold + earnings sales cap.
 * @param {number}   [extras.marketFactor]   World market overlay (see marketValuationFactor);
 *                                           1 = neutral. Defaults to 1 for cold valuations.
 * @param {number}   [extras.shares]         Shares outstanding, for the share-price divisor.
 *                                           Defaults to TOTAL_SHARES (the founder count).
 * @returns {{ marketCap: number, sharePrice: number, peMultiple: number|null,
 *             annualizedProfit: number|null, growthRate: number|null,
 *             fairValue: number, netBook: number }}
 */
export function computeMarketCap(profitHistory, cash, qualityScore = 50, extras = {}) {
  const {
    fleetNAV = 0, debt = 0, portfolioValue = 0,
    prevMarketCap = null, noise = 0, revenueHint = 0, marketFactor = 1,
    shares = TOTAL_SHARES,
  } = extras;
  const V = VALUATION;

  // ── Net book value: what the airline is worth if it stopped flying ──────────
  // Cash counts at face value up to a sensible working balance; anything beyond
  // that is idle and credited at IDLE_CASH_WEIGHT. Skipped entirely when there's
  // no revenue signal (cold valuations, brand-new airlines) so the 3-argument
  // call path and fresh saves are unaffected.
  const rawCash    = cash ?? 0;
  const annualRev  = Math.max(0, revenueHint) * 52;
  const idleFloor  = annualRev > 0
    ? Math.max(V.IDLE_CASH_REV_FRAC * annualRev, V.IDLE_CASH_FLOOR)
    : Infinity;
  const creditedCash = rawCash > idleFloor
    ? idleFloor + V.IDLE_CASH_WEIGHT * (rawCash - idleFloor)
    : rawCash;

  // Gross assets — everything the airline OWNS, before what it owes. This is the
  // base for the asset-proportional floor below; net book (which subtracts debt)
  // is what the valuation itself is built on.
  const grossAssets = Math.max(0, creditedCash)
                    + V.FLEET_NAV_WEIGHT * Math.max(0, fleetNAV)
                    + Math.max(0, portfolioValue);

  const netBook = creditedCash
                + V.FLEET_NAV_WEIGHT * Math.max(0, fleetNAV)
                + Math.max(0, portfolioValue)
                - Math.max(0, debt);

  // The floor this airline's equity cannot print below: the absolute minimum, or
  // a fraction of its gross assets, whichever is larger (see ASSET_FLOOR_FRAC).
  const valueFloor = Math.max(V.MIN_MARKET_CAP, V.ASSET_FLOOR_FRAC * grossAssets);

  const weeks = (profitHistory ?? []).slice(-12);

  let peMultiple = null, annualizedProfit = null, growthRate = null, earningsValue = 0;
  if (weeks.length >= V.MIN_EARNINGS_WEEKS) {
    const trailingAvg = weeks.reduce((s, p) => s + p, 0) / weeks.length;
    annualizedProfit  = Math.round(trailingAvg * 52);

    // Confidence ramp (quadratic, min 4 weeks): a young airline is valued on
    // book, not on (a few good weeks) × 52 × P/E — earnings only dominate once
    // there's a real record. 4wks → 0.11, 6wks → 0.25, 12wks → 1.0.
    const confidence = Math.pow(weeks.length / 12, V.EARNINGS_CONF_POW);

    // Growth: recent 6 weeks vs the prior window, with the denominator floored
    // (5% of weekly revenue, min $50k) so a near-zero prior can't explode it.
    const recentSlice = weeks.slice(-6);
    const priorSlice  = weeks.slice(0, Math.max(0, weeks.length - 6));
    const recentAvg   = recentSlice.reduce((s, p) => s + p, 0) / recentSlice.length;
    const priorAvg    = priorSlice.length > 0
      ? priorSlice.reduce((s, p) => s + p, 0) / priorSlice.length
      : 0;
    const growthDenom = Math.max(Math.abs(priorAvg), 0.05 * Math.max(0, revenueHint), 50_000);
    growthRate = Math.max(-1, Math.min(1, (recentAvg - priorAvg) / growthDenom));

    // P/E multiple: base 8, growth bonus (−3..+3), quality bonus (0..+2) → 5..13.
    const growthBonus     = Math.max(-V.PE_GROWTH_SPAN,
                                     Math.min(V.PE_GROWTH_SPAN, growthRate * V.PE_GROWTH_SPAN));
    const reputationBonus = (Math.max(0, Math.min(100, qualityScore)) / 100) * V.PE_REP_SPAN;
    peMultiple            = V.PE_BASE + growthBonus + reputationBonus;

    // Smooth the profitable↔loss cliff: the effective multiple interpolates
    // from LOSS_MULTIPLE (deep loss) to full P/E (solid profit) across a band
    // of ±4 weeks' revenue, so crossing zero re-rates over several weeks
    // instead of stepping 5× → 30× in one tick. Continuous at zero by
    // construction (earnings term is 0 there regardless of multiple).
    const band = Math.max(4 * Math.max(0, revenueHint), 1_000_000);
    const t    = Math.max(0, Math.min(1, (annualizedProfit + band) / (2 * band)));
    const mult = V.LOSS_MULTIPLE + (peMultiple - V.LOSS_MULTIPLE) * t;

    earningsValue = annualizedProfit * mult * confidence;

    // Sales backstop: however good the margin, the earnings term is capped at a
    // multiple of actual revenue. Only bites on the upside — a loss-making
    // carrier keeps its full (negative) earnings term.
    if (earningsValue > 0 && annualRev > 0) {
      earningsValue = Math.min(earningsValue, V.EARNINGS_SALES_CAP * annualRev);
    }
  }

  // ── Fair value, market-adjusted and floored ────────────────────────────────
  // marketFactor is the world's shared sentiment/fuel overlay (see
  // marketValuationFactor) — one number every airline in the world is multiplied
  // by, so sector-wide drawdowns exist and a rising price can mean the market
  // rose rather than that you did well.
  const fairValue = Math.max(
    Math.max(0, marketFactor) * Math.max(
      V.BOOK_WEIGHT * netBook + earningsValue,
      V.BOOK_FLOOR * netBook,
    ),
    valueFloor,
  );

  // ── Path-dependent price: converge, clamp, noise ───────────────────────────
  // Without a previous cap (cold valuation) the fair value is published as-is.
  let marketCap;
  if (Number.isFinite(prevMarketCap) && prevMarketCap > 0) {
    const target  = prevMarketCap + V.CONVERGENCE * (fairValue - prevMarketCap);
    const band    = moveClampFor(prevMarketCap, fairValue);
    const clamped = Math.min(
      prevMarketCap * (1 + band),
      Math.max(prevMarketCap * (1 - band), target),
    );
    const n = Math.max(-V.NOISE_PCT, Math.min(V.NOISE_PCT, Number.isFinite(noise) ? noise : 0));
    // NOTE the floor here is the ABSOLUTE one, not the asset-aware valueFloor.
    // The asset floor belongs to fair value — it says what the business is worth.
    // Applying it to the PUBLISHED cap as well would let it jump the move clamp
    // (buy a fleet, gross assets leap, the floor drags the print past its band in
    // one tick), which is the same class of defect as the one this file fixes. The
    // print converges up to a floored fair value inside the band like anything else.
    marketCap = Math.max(clamped * (1 + n), V.MIN_MARKET_CAP);
  } else {
    marketCap = fairValue;
  }

  return {
    marketCap,
    sharePrice: marketCap / (Number.isFinite(shares) && shares > 0 ? shares : TOTAL_SHARES),
    peMultiple: peMultiple != null ? Math.round(peMultiple * 10) / 10 : null,
    annualizedProfit,
    growthRate,
    fairValue,
    netBook,
    grossAssets,
    valueFloor,
  };
}

// ─── World market index ────────────────────────────────────────────────────────
// A single sentiment number per world, shared by every airline, so the stock
// market has correlated risk instead of being N uncorrelated savings accounts.
// Deliberately zero-drift: over a long world it neither creates nor destroys
// value, it just makes timing matter.
//
// Structured exactly like the fuel index (utils/fuel.js): an Ornstein-Uhlenbeck
// walk the caller can seed. Multiplayer replays it per world-week from the world
// seed in tickService so every player sees the same market; solo ticks its own.

export const MARKET_BASE_INDEX     = 1.00;   // long-run equilibrium
export const MARKET_MIN_INDEX      = 0.70;   // deep bear market
export const MARKET_MAX_INDEX      = 1.30;   // frothy bull market
export const MARKET_MEAN_REVERSION = 0.05;   // θ: weekly pull toward base
export const MARKET_VOLATILITY     = 0.025;  // σ: weekly shock magnitude

/**
 * Sensitivity of airline valuations to the fuel price. Airline equities are
 * famously fuel-levered: every 10% that fuel sits above baseline knocks ~4% off
 * sector valuations. This is an overlay rather than part of the walk, so a
 * sustained fuel crisis keeps depressing prices instead of being mean-reverted
 * away after a few weeks.
 */
export const MARKET_FUEL_BETA = 0.40;

/** Combined overlay is clamped to this band so no scenario zeroes a company out. */
export const MARKET_FACTOR_MIN = 0.55;
export const MARKET_FACTOR_MAX = 1.45;

/**
 * Advance the world market index by one week.
 *
 * @param {number} currentIndex  this week's index
 * @param {number} [rand]        uniform [0,1); pass a seeded value in multiplayer
 * @returns {number}             next week's index, clamped to [MIN, MAX]
 */
export function tickMarketIndex(currentIndex, rand = Math.random()) {
  const base  = Number.isFinite(currentIndex) ? currentIndex : MARKET_BASE_INDEX;
  const drift = MARKET_MEAN_REVERSION * (MARKET_BASE_INDEX - base);
  const shock = (rand * 2 - 1) * MARKET_VOLATILITY * 2.5;
  const next  = base + drift + shock;
  return parseFloat(Math.max(MARKET_MIN_INDEX, Math.min(MARKET_MAX_INDEX, next)).toFixed(4));
}

/**
 * The number every airline's fair value is multiplied by: market sentiment,
 * levered by how far fuel sits from baseline.
 *
 * @param {number} marketIndex  world market index (MARKET_BASE_INDEX if unknown)
 * @param {number} fuelIndex    world fuel index (FUEL_BASE_INDEX 1.0 = baseline)
 * @returns {number}            multiplier in [MARKET_FACTOR_MIN, MARKET_FACTOR_MAX]
 */
export function marketValuationFactor(marketIndex, fuelIndex = 1) {
  const m = Number.isFinite(marketIndex) ? marketIndex : MARKET_BASE_INDEX;
  const f = Number.isFinite(fuelIndex)   ? fuelIndex   : 1;
  const raw = m * (1 - MARKET_FUEL_BETA * (f - 1));
  return parseFloat(Math.max(MARKET_FACTOR_MIN, Math.min(MARKET_FACTOR_MAX, raw)).toFixed(4));
}

/** Human-readable label for the market index (UI). */
export function marketIndexStatus(index) {
  const i = Number.isFinite(index) ? index : MARKET_BASE_INDEX;
  if (i >= 1.18) return { label: 'Bull market',   tone: 'good' };
  if (i >= 1.06) return { label: 'Optimistic',    tone: 'good' };
  if (i >  0.94) return { label: 'Steady',        tone: 'neutral' };
  if (i >  0.82) return { label: 'Cautious',      tone: 'warn' };
  return { label: 'Bear market', tone: 'bad' };
}

// ─── Stock market (trading rivals' shares) ─────────────────────────────────────
// Constants shared by the engine reducer (BUY_STOCK / SELL_STOCK), the server
// decision guard, and the trading UI. Round trip ≈ 3% (spread + commission both
// ways) so churn and wash-trading are lossy by construction.
export const STOCK_MARKET = {
  SPREAD_HALF:              0.01,      // buy at price×1.01, sell at price×0.99
  COMMISSION:               0.005,     // 0.5% of gross, each way
  MAX_OWNERSHIP_PCT:        0.20,      // max fraction of one rival's shares you may own
  // Fraction of an airline's shares that are publicly held (and therefore
  // buyable) at incorporation. The rest is the founder block. Set above
  // MAX_OWNERSHIP_PCT so one player taking their full 20% still leaves float
  // for everybody else.
  DEFAULT_FREE_FLOAT_PCT:   0.30,
  // Price impact: an order's own weight moves the price against it, in
  // proportion to how much of the free float it represents. Buying two thirds
  // of a carrier's float costs ~23% in slippage on top of the spread, which is
  // what stops large stakes from being accumulated at the marked price.
  IMPACT_K:                 0.35,
  IMPACT_MAX:               0.25,      // slippage is capped so a fat order can't price absurdly
  // Tax on REALIZED gains. Money leaves the world entirely — the sink that
  // offsets the float pool. Losses are untaxed and carry no credit.
  CAPITAL_GAINS_TAX:        0.25,
  MAX_PORTFOLIO_PCT_OF_CAP: 0.40,      // portfolio cost basis ≤ 40% of your own market cap
  MIN_TICKET:               100_000,   // minimum gross per trade ($)
  DELIST_HAIRCUT:           0.75,      // forced-liquidation payout when a held carrier delists
  // ── Float pool (the money loop) ──────────────────────────────────────────
  // Trades no longer face an infinite off-world counterparty. Each world has ONE
  // pool with finite cash and a finite share inventory: your buys pay cash INTO
  // it, your sells draw cash OUT of it. Net exogenous cash entering a world is
  // therefore bounded by the pool's seed forever, which is the whole fix for
  // "the cash comes from outside the game".
  POOL_SEED_MULT:           5,         // seed = 5 x (players x starting capital)
  POOL_REFILL_PER_YEAR:     0.02,      // heals 2% of seed a game year, capped at seed
  // As the pool's cash runs down, sellers get worse fills — a market that has
  // run out of buyers. At a fully drained pool this is the whole discount.
  POOL_LIQUIDITY_K:         0.20,
  SHARE_PRICE_HISTORY_WEEKS: 26,       // rival price history exposed to clients
};

// ─── Capital actions ───────────────────────────────────────────────────────────
// The company side of the market: raising equity, returning it, and paying it out.
// This is what makes the issuer a real participant rather than a scoreboard entry —
// and under the SVPS leaderboard each of these is a genuine trade-off rather than
// the free score (issue) or self-harm (return) that market-cap ranking made them.

export const CAPITAL = {
  // ── IPO ──────────────────────────────────────────────────────────────────
  // You have to have a business before the market will price one.
  IPO_MIN_ABS_WEEK:        26,
  IPO_MIN_HISTORY_WEEKS:   12,
  IPO_MIN_FRACTION:        0.10,   // of post-issue shares
  IPO_MAX_FRACTION:        0.35,
  // Real IPOs are underpriced, and more so for a short or shaky track record.
  IPO_DISCOUNT_MIN:        0.05,
  IPO_DISCOUNT_MAX:        0.15,
  IPO_CONFIDENCE_WEEKS:    52,     // history length at which you get the best price

  // ── Selling shareholders (secondary tranche) ────────────────────────────
  // An IPO may sell EXISTING founder shares alongside newly issued ones. Those
  // shares are not new capital: the founder is cashing out part of their own
  // holding, so the company's share count never moves and nobody is diluted.
  //
  // The catch is that it IS a realised gain, taxed at the same rate and into the
  // same off-world sink as a gain on a rival's stock. That tax is the whole
  // reason a non-dilutive raise does not simply dominate a dilutive one: you
  // keep your per-share value intact and pay for it in cash raised.
  //
  // Cost basis is what the founders subscribed at incorporation — STARTING_CASH
  // (reducer.mjs) spread over TOTAL_SHARES. Held as a literal because market.js
  // is imported BY the reducer and must never import back; capital-test.mjs
  // asserts the two stay in step.
  FOUNDER_BASIS_PER_SHARE: 0.15,

  // ── Secondary offerings ─────────────────────────────────────────────────
  OFFERING_MAX_PCT_PER_YEAR: 0.15, // of shares outstanding, per game year
  OFFERING_DISCOUNT_BASE:    0.04,
  // The discount WIDENS the more you have already tapped the market this year:
  // going back repeatedly is progressively more expensive.
  OFFERING_DISCOUNT_SLOPE:   0.50,
  // ...and NARROWS with a record of returning capital. Dividends and buybacks buy
  // you cheaper equity later, which is the long-game reason to bother with them.
  OFFERING_LOYALTY_CREDIT:   0.03,

  // ── Buybacks ────────────────────────────────────────────────────────────
  BUYBACK_MAX_PCT_PER_YEAR:  0.15,
  BUYBACK_PREMIUM:           0.01, // you cross the spread to retire stock
  // Never buy back (or pay a dividend) down to the point of insolvency.
  MIN_CASH_WEEKS_COVER:      4,

  // ── Dividends ───────────────────────────────────────────────────────────
  DIVIDEND_MAX_PAYOUT:       0.60, // of trailing-quarter net profit
  DIVIDEND_PERIOD_WEEKS:     13,
  DIVIDEND_TRAILING_WEEKS:   13,
};

/**
 * IPO discount for an airline: worst case for a raw startup, best for a carrier
 * with a year of trading behind it.
 *
 * @param {number} historyWeeks  weeks of financial history
 * @param {number} profitable    fraction of recent weeks that were profitable (0..1)
 */
export function ipoDiscount(historyWeeks, profitable = 0.5) {
  const C = CAPITAL;
  const tenure = Math.max(0, Math.min(1, (Number(historyWeeks) || 0) / C.IPO_CONFIDENCE_WEEKS));
  const record = Math.max(0, Math.min(1, Number(profitable) || 0));
  const confidence = 0.6 * tenure + 0.4 * record;
  return C.IPO_DISCOUNT_MAX - (C.IPO_DISCOUNT_MAX - C.IPO_DISCOUNT_MIN) * confidence;
}

/**
 * Size a listing.
 *
 * Returns the offering that leaves exactly `frac` of the POST-issue company in
 * outside hands, built from new shares and founder shares in the ratio `mix`
 * (0 = all newly issued, 1 = a pure founder sell-down):
 *
 *   O = fS / (1 - f(1 - m))
 *
 * Only the new half enlarges the register, so a sell-down reaches the same float
 * with a smaller offering. This lives here, not in the IPO card, because the size
 * the UI offers has to be a size the reducer accepts — a solver that lands a
 * rounding error outside the band produces a button that silently does nothing,
 * which is exactly what the 10% and 35% chips used to do.
 *
 * @param {number} shares  shares outstanding before the listing
 * @param {number} frac    target float, clamped to the IPO band
 * @param {number} [mix]   0..1 — how much of the offering comes out of the founder block
 */
export function ipoOffering(shares, frac, mix = 0) {
  const S = Number(shares) > 0 ? Number(shares) : TOTAL_SHARES;
  const f = Math.min(CAPITAL.IPO_MAX_FRACTION,
                     Math.max(CAPITAL.IPO_MIN_FRACTION, Number(frac) || 0));
  const m = Math.max(0, Math.min(1, Number(mix) || 0));
  const total = Math.round((S * f) / (1 - f * (1 - m)));
  const secondaryShares = Math.round(total * m);
  return { total, newShares: total - secondaryShares, secondaryShares };
}

/**
 * Split the proceeds of a SELLING-SHAREHOLDER tranche — founder shares sold at
 * an IPO rather than new shares issued.
 *
 * The company banks the cash (the player is the founder and the company both),
 * but the gain over the incorporation basis is taxed at
 * STOCK_MARKET.CAPITAL_GAINS_TAX and that money leaves the world entirely,
 * exactly as it does on a realised trading gain. A sale at or below basis is
 * untaxed — there is no gain, and losses carry no credit.
 *
 * @param {number} shares          founder shares sold
 * @param {number} pricePerShare   the offer price (the pool pays this in full)
 * @param {number} [basisPerShare] incorporation cost basis
 * @returns {{gross:number, tax:number, net:number}} what the pool pays, what the
 *          taxman takes, and what actually reaches the treasury
 */
export function founderSaleProceeds(shares, pricePerShare, basisPerShare = CAPITAL.FOUNDER_BASIS_PER_SHARE) {
  const n     = Math.max(0, Math.floor(Number(shares) || 0));
  const p     = Math.max(0, Number(pricePerShare) || 0);
  const basis = Math.max(0, Number(basisPerShare) || 0);
  // Floored, never rounded: a listing bills the float pool for the sum of its
  // tranches, and two rounded halves can add up to a dollar more than the pool
  // agreed to spend — which the server's re-check would reject as a 409.
  const gross = Math.floor(n * p);
  const gain  = Math.max(0, (p - basis) * n);
  const tax   = Math.round(gain * STOCK_MARKET.CAPITAL_GAINS_TAX);
  return { gross, tax, net: Math.max(0, gross - tax) };
}

/**
 * Discount on a secondary offering. Widens with how much of the annual allowance
 * you have already used, narrows with a record of returning capital.
 *
 * @param {number} issuedFracThisYear  shares issued this year / shares outstanding
 * @param {number} returnedCapital     1 if you have ever paid a dividend or bought
 *                                     back stock, else 0 (or a 0..1 blend)
 */
export function offeringDiscount(issuedFracThisYear, returnedCapital = 0) {
  const C = CAPITAL;
  const used = Math.max(0, Number(issuedFracThisYear) || 0);
  const loyal = Math.max(0, Math.min(1, Number(returnedCapital) || 0));
  const raw = C.OFFERING_DISCOUNT_BASE
            + C.OFFERING_DISCOUNT_SLOPE * used
            - C.OFFERING_LOYALTY_CREDIT * loyal;
  return Math.max(0, Math.min(0.30, raw));
}

/**
 * Dividend per share for a payout, given the trailing profit and who actually
 * gets paid.
 *
 * The founder block is NOT paid — paying yourself is a wash, and skipping it means
 * a dividend costs you in proportion to how much of yourself you have sold. So the
 * total cash leaving the company is `perShare x (shares - founderShares)`.
 *
 * @param {number} trailingProfit  net profit over the trailing quarter
 * @param {number} payoutRatio     0..DIVIDEND_MAX_PAYOUT
 * @param {number} shares          shares outstanding
 * @returns {number} dividend per share ($)
 */
export function dividendPerShare(trailingProfit, payoutRatio, shares) {
  const profit = Number(trailingProfit) || 0;
  const ratio = Math.max(0, Math.min(CAPITAL.DIVIDEND_MAX_PAYOUT, Number(payoutRatio) || 0));
  const n = Number(shares);
  if (profit <= 0 || ratio <= 0 || !(n > 0)) return 0;
  return (profit * ratio) / n;
}

/** Fresh empty portfolio (also the migration default for old saves). */
export function emptyPortfolio() {
  return { holdings: {}, realizedPnL: 0, lastValuation: 0, taxPaid: 0 };
}

/**
 * Publicly held (buyable) shares of an airline — everything outside the founder
 * block. Reads a player state or a rival payload.
 */
export function freeFloatOf(x) {
  const shares  = sharesOf(x);
  const founder = Number(x?.equity?.founderShares ?? x?.founderShares);
  const held    = Number.isFinite(founder) && founder >= 0 && founder <= shares
    ? founder
    : shares * (1 - STOCK_MARKET.DEFAULT_FREE_FLOAT_PCT);
  return Math.max(0, shares - held);
}

/**
 * Slippage fraction for an order of `shares` against a free float of `float`.
 * Zero for a zero-size order, capped at IMPACT_MAX.
 */
export function priceImpact(shares, float) {
  const n = Number(shares), f = Number(float);
  if (!(n > 0) || !(f > 0)) return 0;
  return Math.min(STOCK_MARKET.IMPACT_MAX, STOCK_MARKET.IMPACT_K * (n / f));
}

/**
 * Execution price for a trade, including half-spread and the order's own impact.
 *
 * @param {number}  price   last published price
 * @param {number}  shares  order size
 * @param {number}  float   the carrier's free float
 * @param {boolean} isBuy   true to pay up, false to sell down
 */
export function executionPrice(price, shares, float, isBuy) {
  const edge = STOCK_MARKET.SPREAD_HALF + priceImpact(shares, float);
  return price * (isBuy ? 1 + edge : Math.max(0, 1 - edge));
}

/**
 * Extra discount a SELLER eats because the pool is short of cash — a market with
 * no buyers left. 0 when the pool is full, POOL_LIQUIDITY_K when fully drained.
 *
 * Buys are unaffected: putting money in never needs the pool to have any.
 *
 * @param {number} poolCash  cash the pool has left
 * @param {number} seedCash  the pool's seed (its full-strength level)
 */
export function poolLiquidityDiscount(poolCash, seedCash) {
  const cash = Number(poolCash), seed = Number(seedCash);
  if (!(seed > 0)) return 0;                      // no pool configured → no discount
  const drawn = Math.max(0, Math.min(1, 1 - Math.max(0, cash) / seed));
  return STOCK_MARKET.POOL_LIQUIDITY_K * drawn;
}

/**
 * The world's float pool as injected onto state by the server (never persisted,
 * never client-supplied). Absent in solo, where trading keeps its legacy
 * unbounded counterparty.
 *
 * @typedef {{ poolCash: number, seedCash: number, sharesAvailable: number }} WorldMarketView
 */

/** Pool seed for a world: POOL_SEED_MULT x players x starting capital. */
export function poolSeedFor(playerCount, startingCash) {
  const n = Math.max(1, Number(playerCount) || 1);
  const c = Math.max(0, Number(startingCash) || 0);
  return Math.round(STOCK_MARKET.POOL_SEED_MULT * n * c);
}

/** Weekly refill amount for a pool, capped so it can never exceed its seed. */
export function poolRefill(poolCash, seedCash) {
  const cash = Math.max(0, Number(poolCash) || 0);
  const seed = Math.max(0, Number(seedCash) || 0);
  if (!(seed > 0) || cash >= seed) return 0;
  const weekly = (seed * STOCK_MARKET.POOL_REFILL_PER_YEAR) / 52;
  return Math.round(Math.min(weekly, seed - cash));
}

/**
 * Capital gains tax on a realized gain. Gains only — a loss is untaxed and earns
 * no credit against future gains (deliberately simple, and it means churning a
 * position is never a tax strategy).
 */
export function capitalGainsTax(grossRealized) {
  const g = Number(grossRealized);
  return g > 0 ? Math.round(g * STOCK_MARKET.CAPITAL_GAINS_TAX) : 0;
}

// ─── Cargo demand ───────────────────────────────────────────────────────────────
//
// A parallel gravity model for air freight, deliberately structured like the
// passenger model above but with three differences (see docs/cargo-design.md):
//
//   1. Mass driver is TRADE, not population/tourism — keyed off cargoScore.
//   2. Distance behaves differently: short-haul air freight is SUPPRESSED (trucks
//      compete under ~1,500 km), while long-haul decays only gently (a box doesn't
//      care about a 14-hour flight). So demand peaks in the medium-to-long range.
//   3. Output unit is tonnes/week, not passengers.
//
// Demand is computed symmetrically for v1 but the function is DIRECTIONAL by
// signature (o,d are not sorted) so headhaul/backhaul imbalance can be layered in
// later without changing call sites or storage.

/** Gravity constant — calibrated so HKG–LAX ≈ 1,500 tonnes/week one-way. */
export const CARGO_GRAVITY_K = 23;

/** Short-haul half-saturation (km): trucking competition halves air demand here. */
export const CARGO_TRUCK_HALF_KM = 1500;

/** Long-haul decay scale (km) and exponent — gentle, freight is time-insensitive. */
export const CARGO_DECAY_KM  = 6000;
export const CARGO_DECAY_EXP = 0.5;

/**
 * Cargo "mass" for one airport: how much air freight it generates/attracts.
 * Primarily its cargoScore (0–100), modestly scaled by the size of the surrounding
 * economy (a high-score airport in a huge metro ships more than the same score in a
 * small one). Pure-freight hubs with tiny populations (ANC, MEM) keep most of their
 * weight via the 0.5 floor.
 *
 * @param {string} code
 * @returns {number}
 */
export function getCargoMass(code) {
  const ap    = getAirport(code);
  if (!ap) return 0;
  const score = getAirportCargoScore(code);
  // Economy factor uses RESIDENT mass only (population / effectivePop) — the
  // tourism `visitors` terms in getDemandMass drive passenger demand, not
  // freight. Tourists don't ship cargo (Las Vegas is not a freight hub).
  const residentMass = Math.max(ap.population ?? 0, ap.effectivePop ?? 0);
  const econ  = Math.max(0.5, Math.min(1.8, Math.sqrt(residentMass / 8)));
  return score * econ;
}

// ─── Cargo seasonality ──────────────────────────────────────────────────────
// Air freight has a season, and it is not the passenger one. Peak is Q4 — the
// retail build for Christmas moves by air from roughly September, tops out in
// November and tails off once the shelves are full. The deep trough is
// February: Asian factories shut for New Year and the biggest single source of
// airfreight in the world stops for a fortnight. Summer, when passenger demand
// is at its highest, is a quiet month on the freight deck.
//
// Multipliers average to exactly 1.0 across the year, so the annual tonnage a
// lane produces is unchanged — only its distribution.

/** Freight seasonality by month (1-indexed). Mean = 1.000. */
export const CARGO_SEASONAL_PROFILE =
  [null, 0.86, 0.78, 0.93, 0.97, 1.00, 0.96, 0.90, 0.92, 1.08, 1.20, 1.30, 1.10];

/**
 * Freight seasonal multiplier for a month. Out-of-range or missing → 1 (the
 * annual average), so a caller that has no calendar isn't punished for it.
 *
 * @param {number} month 1–12
 * @returns {number}
 */
export function cargoSeasonalFactor(month) {
  const m = Math.round(Number(month));
  if (!Number.isFinite(m) || m < 1 || m > 12) return 1;
  return CARGO_SEASONAL_PROFILE[m];
}

// ─── Backhaul imbalance ─────────────────────────────────────────────────────
// Freight is directional in a way passengers are not: a passenger who flies out
// flies home, a television does not. Lanes out of a manufacturing centre into a
// consuming one run full one way and hunt for anything at all on the return —
// which is why belly rates on the headhaul and the backhaul of the same lane
// can differ by a factor of three. A lane between two comparable freight
// economies is close to balanced.
//
// The imbalance falls out of the same cargo masses that generate the demand:
// the closer the two ends are in freight weight, the fuller the return leg.

/** Return-leg revenue fraction on the most lopsided lane in the world. */
export const CARGO_BACKHAUL_MIN = 0.30;
/** …and on a perfectly matched pair. */
export const CARGO_BACKHAUL_MAX = 0.80;

/**
 * Return-leg revenue fraction for one lane. Symmetric (a lane is as imbalanced
 * viewed from either end), and falls back to CARGO_BACKHAUL_FACTOR's historical
 * 0.65 when either end's freight mass is unknown.
 *
 * @param {string} originCode
 * @param {string} destCode
 * @returns {number} CARGO_BACKHAUL_MIN … CARGO_BACKHAUL_MAX
 */
export function cargoBackhaulFactor(originCode, destCode) {
  const mo = getCargoMass(originCode);
  const md = getCargoMass(destCode);
  if (!(mo > 0) || !(md > 0)) return 0.65;
  const ratio = Math.min(mo, md) / Math.max(mo, md);   // 1 = perfectly matched
  return Math.round(
    (CARGO_BACKHAUL_MIN + (CARGO_BACKHAUL_MAX - CARGO_BACKHAUL_MIN) * ratio) * 1000) / 1000;
}

/**
 * Base weekly one-way cargo demand for a city pair, in tonnes, at reference yield.
 * Symmetric (o,d order does not change the result) — the DIRECTIONAL half of
 * freight lives in cargoBackhaulFactor, not here.
 *
 * @param {string} originCode
 * @param {string} destCode
 * @param {number} [month]  game month 1–12 for freight seasonality. Omit for the
 *                          annual average (route-finder scans, unit tests).
 * @returns {number} tonnes/week (one-way)
 */
export function cargoCityPairDemand(originCode, destCode, month = null) {
  const o = getAirport(originCode);
  const d = getAirport(destCode);
  if (!o || !d) return 0;

  const dist = distanceKm(o, d);
  // No air-cargo demand within a single metro area, or between two cities a
  // truck run apart (trucked, not flown).
  if (isSameMetro(o, d, dist) || isSurfaceConnected(o, d, dist)) return 0;
  const massO = getCargoMass(originCode);
  const massD = getCargoMass(destCode);

  // Short-haul suppression (trucks compete) × gentle long-haul gravity decay.
  const truckFactor = dist / (dist + CARGO_TRUCK_HALF_KM);
  const decay       = Math.pow(1 + dist / CARGO_DECAY_KM, CARGO_DECAY_EXP);
  const distFactor  = truckFactor / decay;

  const seasonal = month == null ? 1 : cargoSeasonalFactor(month);
  return Math.round(Math.sqrt(massO * massD) * CARGO_GRAVITY_K * distFactor * seasonal);
}

// ─── Cargo pricing ──────────────────────────────────────────────────────────────

/** Reference yield bounds and curve ($ per tonne-km). */
export const CARGO_YIELD_BASE  = 1.19;     // intercept of the linear curve
export const CARGO_YIELD_SLOPE = 6.8e-5;   // $/tonne-km lost per km of stage length
export const CARGO_YIELD_CAP   = 1.10;     // short-haul ceiling
export const CARGO_YIELD_FLOOR = 0.40;     // long-haul floor

/**
 * Market reference yield for a route, in $ per tonne-km (one-way).
 * Yield is HIGHER on short routes (fixed handling cost amortised over fewer km) and
 * lower on long-haul — the inverse of the passenger fare curve. Total reference
 * revenue per tonne = cargoReferenceYield(o,d) × distanceKm.
 *
 *   e.g.  ~1,300 km → ~$1.10/tonne-km → ~$1,430/tonne (~$1.43/kg)
 *        ~11,640 km → ~$0.40/tonne-km → ~$4,656/tonne (~$4.66/kg)
 *
 * @param {string} originCode
 * @param {string} destCode
 * @returns {number} $/tonne-km
 */
export function cargoReferenceYield(originCode, destCode) {
  const dist = routeDistance(originCode, destCode);
  const raw  = CARGO_YIELD_BASE - CARGO_YIELD_SLOPE * dist;
  // Same world fare index as passenger fares — otherwise a restricted world would
  // leave freight yields untouched and hand cargo an easy margin advantage.
  const clamped = Math.max(CARGO_YIELD_FLOOR, Math.min(CARGO_YIELD_CAP, raw));
  return Math.round(clamped * _fareIndex * 1000) / 1000;
}

/** Convenience: reference revenue per tonne ($, one-way) on a route. */
export function cargoReferenceRevenuePerTonne(originCode, destCode) {
  return Math.round(cargoReferenceYield(originCode, destCode) * routeDistance(originCode, destCode));
}
