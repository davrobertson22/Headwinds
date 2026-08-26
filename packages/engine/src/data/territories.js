/**
 * territories.js — which country codes belong to the same STATE.
 *
 * The airport table stores a territory's own ISO code, so San Juan is `PR` and
 * Papeete is `PF`. That is right for labelling a city, and wrong for every rule
 * phrased as "your home country": a US player based at MIA was refused a hub at
 * SJU because Puerto Rico read as a foreign country (Discord, Knightmare
 * 2026-08-25), and the same refusal waits for a French player at PTP and a
 * Danish one at Nuuk.
 *
 * SOVEREIGN_OF maps a dependent territory to the state whose flag, registry and
 * domestic air services it belongs to. The bar for an entry is deliberately
 * high: flights between the territory and the mainland are DOMESTIC and the
 * aircraft carry the mainland's registration prefix. Constituent countries with
 * their own registry and their own air-services agreements — Aruba, Curaçao,
 * Sint Maarten, Hong Kong, Macau, the British Overseas Territories — are NOT
 * here: for an airline they behave like separate countries, which is what the
 * airport table already says.
 *
 * Scope: this is a SOVEREIGNTY reading, used by the rules that ask "is this
 * mine / at home" — hub eligibility, the foreign focus-city cap, registration
 * prefixes. Demand, affinity and the domestic/international split in market.js
 * deliberately keep reading `airport.country`, because a SJU–MIA passenger mix
 * is a balance question, not a legal one. Changing those is a balance decision.
 */

/** territory ISO code → sovereign state ISO code. */
export const SOVEREIGN_OF = {
  // United States — unincorporated territories, N-registered, domestic services.
  PR: 'US',   // Puerto Rico
  VI: 'US',   // US Virgin Islands
  GU: 'US',   // Guam
  MP: 'US',   // Northern Mariana Islands
  AS: 'US',   // American Samoa
  UM: 'US',   // US Minor Outlying Islands

  // France — overseas departments and collectivities, F-registered.
  GP: 'FR',   // Guadeloupe
  MQ: 'FR',   // Martinique
  GF: 'FR',   // French Guiana
  RE: 'FR',   // Réunion
  YT: 'FR',   // Mayotte
  BL: 'FR',   // Saint Barthélemy
  MF: 'FR',   // Saint Martin
  PM: 'FR',   // Saint Pierre & Miquelon
  PF: 'FR',   // French Polynesia
  NC: 'FR',   // New Caledonia
  WF: 'FR',   // Wallis & Futuna

  // Kingdom of Denmark — OY-registered, Copenhagen services are domestic.
  GL: 'DK',   // Greenland
  FO: 'DK',   // Faroe Islands

  // Netherlands proper — the Caribbean special municipalities (Bonaire, Saba,
  // Sint Eustatius). Aruba/Curaçao/Sint Maarten are NOT here: separate
  // constituent countries with their own registries.
  BQ: 'NL',

  // United Kingdom — Crown dependencies only (G-registered, domestic services).
  // The Overseas Territories (BM, KY, TC, AI, VG, GI, SH…) are not.
  IM: 'GB',   // Isle of Man
  JE: 'GB',   // Jersey
  GG: 'GB',   // Guernsey

  // Norway, Finland, Australia, New Zealand outliers.
  SJ: 'NO',   // Svalbard & Jan Mayen
  AX: 'FI',   // Åland
  CX: 'AU',   // Christmas Island
  CC: 'AU',   // Cocos (Keeling) Islands
  NF: 'AU',   // Norfolk Island
};

/**
 * The state a country code belongs to. Unknown or already-sovereign codes come
 * back unchanged, so this is safe to wrap around any `airport.country`.
 * @param {string|null|undefined} code
 * @returns {string|null}
 */
export function sovereignCountry(code) {
  if (!code) return code ?? null;
  return SOVEREIGN_OF[code] ?? code;
}

/**
 * True when two country codes belong to the same state — the question every
 * "home country" rule is actually asking. Null/undefined on either side is
 * false, never a silent match.
 */
export function sameSovereign(a, b) {
  if (!a || !b) return false;
  return sovereignCountry(a) === sovereignCountry(b);
}
