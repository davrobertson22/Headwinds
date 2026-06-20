/**
 * families.js — Aircraft family groupings and MRO base costs.
 *
 * Each aircraft family in active use requires a dedicated maintenance
 * infrastructure: tooling, spare-parts inventory, type-rated technicians,
 * and simulator access. This is charged as a fixed weekly base cost
 * regardless of how many aircraft of that family you operate.
 *
 * Consequence: a mixed fleet of 737s + A320s pays two narrow-body base
 * costs; a uniform 737-only fleet pays one. Standardisation is rewarded.
 */

// ─── Aircraft ID → family key ─────────────────────────────────────────────────

export const AIRCRAFT_FAMILY = {
  // Airbus A220 ─────────────────────────────────────────────────────────────
  a220100: 'airbus_a220',
  a220:    'airbus_a220',

  // Airbus A320 family ───────────────────────────────────────────────────────
  a318: 'airbus_a320', a319ceo: 'airbus_a320', a319neo: 'airbus_a320',
  a320ceo: 'airbus_a320', a320neo: 'airbus_a320',
  a321ceo: 'airbus_a320', a321neo: 'airbus_a320', a321xlr: 'airbus_a320',

  // Airbus A300 / A310 ───────────────────────────────────────────────────────
  a310300: 'airbus_a300', a300600r: 'airbus_a300',

  // Airbus A330 ─────────────────────────────────────────────────────────────
  a330200: 'airbus_a330', a330300: 'airbus_a330', a330neo: 'airbus_a330',

  // Airbus A340 ─────────────────────────────────────────────────────────────
  a340300: 'airbus_a340', a340600: 'airbus_a340',

  // Airbus A350 ─────────────────────────────────────────────────────────────
  a350900: 'airbus_a350', a350900ulr: 'airbus_a350', a3501000: 'airbus_a350',

  // Airbus A380 ─────────────────────────────────────────────────────────────
  a380: 'airbus_a380',

  // Boeing 737 (Classic + NG + MAX all share significant commonality) ────────
  b737300: 'boeing_737', b737400: 'boeing_737', b737500: 'boeing_737',
  b737700: 'boeing_737', b737800: 'boeing_737', b737900er: 'boeing_737',
  b737max7: 'boeing_737', b737max8: 'boeing_737',
  b737max9: 'boeing_737', b737max10: 'boeing_737',

  // Boeing 717 ──────────────────────────────────────────────────────────────
  b717: 'boeing_717',

  // Boeing 727 ──────────────────────────────────────────────────────────────
  b727200: 'boeing_727',

  // Boeing 757 ──────────────────────────────────────────────────────────────
  b757200: 'boeing_757', b757300: 'boeing_757',

  // Boeing 767 ──────────────────────────────────────────────────────────────
  b767200er: 'boeing_767', b767300: 'boeing_767', b767400er: 'boeing_767',

  // Boeing 787 Dreamliner ───────────────────────────────────────────────────
  b7878: 'boeing_787', b7879: 'boeing_787', b787x10: 'boeing_787',

  // Boeing 777 ──────────────────────────────────────────────────────────────
  b777200er: 'boeing_777', b777200lr: 'boeing_777', b777300er: 'boeing_777',
  b7778x: 'boeing_777', b7779x: 'boeing_777',

  // Boeing 747 ──────────────────────────────────────────────────────────────
  b747200: 'boeing_747', b747400: 'boeing_747', b7478i: 'boeing_747',

  // Embraer ERJ (135 / 145) ─────────────────────────────────────────────────
  erj135: 'embraer_erj', erj145: 'embraer_erj',

  // Embraer E-Jet (170 / E175 / E190 / E195) ────────────────────────────────
  erj170: 'embraer_ejet', e175: 'embraer_ejet', e175e2: 'embraer_ejet',
  e190: 'embraer_ejet', e190e2: 'embraer_ejet', e195e2: 'embraer_ejet',

  // Bombardier CRJ ──────────────────────────────────────────────────────────
  crj200: 'bombardier_crj', crj700: 'bombardier_crj',
  crj900: 'bombardier_crj', crj1000: 'bombardier_crj',

  // ATR ─────────────────────────────────────────────────────────────────────
  atr42: 'atr', atr72: 'atr',

  // De Havilland Canada Q series ────────────────────────────────────────────
  q400: 'dhc_q',

  // Saab (340 and 2000 share systems) ───────────────────────────────────────
  saab340: 'saab', saab2000: 'saab',

  // BAe 146 / Avro RJ ───────────────────────────────────────────────────────
  avrorj85: 'bae_146', bae146200: 'bae_146',

  // Fokker ──────────────────────────────────────────────────────────────────
  fokker70: 'fokker', fokker100: 'fokker',

  // McDonnell Douglas / Douglas ─────────────────────────────────────────────
  md80: 'mcd_md80', dc950: 'mcd_md80', md90: 'mcd_md80',   // DC-9 / MD-80 family
  dc1030: 'mcd_dc10', md11: 'mcd_dc10',                     // DC-10 / MD-11 family

  // Russian / Soviet / Eastern European ────────────────────────────────────
  il96300:  'ilyushin',
  ssj100:   'sukhoi_ssj',
  tu204:    'tupolev',
  an148:    'antonov',

  // Chinese ─────────────────────────────────────────────────────────────────
  c919:    'comac_c919',
  arj21:   'comac_arj21',
  mc21300: 'irkut_mc21',

  // Japanese ────────────────────────────────────────────────────────────────
  spacejet: 'mitsubishi_msj',

  // Smaller turboprops ──────────────────────────────────────────────────────
  casacn235: 'casa_cn235',
  l410:      'let_l410',
  b1900d:    'beechcraft_1900',
  short360:  'short_360',

  // Utility / single and light-twin turboprops ──────────────────────────────
  // Grouped together — similar basic turboprop / piston MRO skill set
  bn2islander: 'utility_tp',
  c208b:       'utility_tp',
  pc12:        'utility_tp',
  dhc6:        'utility_tp',
};

// ─── Family metadata ──────────────────────────────────────────────────────────

/** Category labels used for display and grouping in the UI. */
export const FAMILY_CATEGORY_LABEL = {
  widebody:   'Wide Body',
  narrowBody: 'Narrow Body',
  regional:   'Regional Jet',
  turboprop:  'Turboprop',
  utility:    'Utility',
};

/**
 * @typedef {object} FamilyInfo
 * @property {string} name              - Human-readable family name
 * @property {string} category          - 'widebody' | 'narrowBody' | 'regional' | 'turboprop' | 'utility'
 * @property {number} weeklyBaseCost    - Weekly MRO infrastructure cost ($) charged if ≥1 aircraft in fleet
 * @property {string} [note]            - Optional warning (e.g. parts-supply issues)
 */

/** @type {Record<string, FamilyInfo>} */
export const FAMILY_INFO = {
  // ── Airbus ────────────────────────────────────────────────────────────────
  airbus_a220: { name: 'Airbus A220',       category: 'narrowBody', weeklyBaseCost: 20_000 },
  airbus_a320: { name: 'Airbus A320 / A321',category: 'narrowBody', weeklyBaseCost: 22_000 },
  airbus_a300: { name: 'Airbus A300 / A310',category: 'widebody',   weeklyBaseCost: 28_000 },
  airbus_a330: { name: 'Airbus A330',       category: 'widebody',   weeklyBaseCost: 38_000 },
  airbus_a340: { name: 'Airbus A340',       category: 'widebody',   weeklyBaseCost: 42_000, note: '4-engine complexity premium' },
  airbus_a350: { name: 'Airbus A350',       category: 'widebody',   weeklyBaseCost: 42_000 },
  airbus_a380: { name: 'Airbus A380',       category: 'widebody',   weeklyBaseCost: 55_000, note: 'Superjumbo — highly specialised tooling' },

  // ── Boeing ────────────────────────────────────────────────────────────────
  boeing_737:  { name: 'Boeing 737',        category: 'narrowBody', weeklyBaseCost: 22_000 },
  boeing_717:  { name: 'Boeing 717',        category: 'narrowBody', weeklyBaseCost: 18_000 },
  boeing_727:  { name: 'Boeing 727',        category: 'narrowBody', weeklyBaseCost: 26_000, note: 'Ageing trijet — scarce parts' },
  boeing_757:  { name: 'Boeing 757',        category: 'narrowBody', weeklyBaseCost: 24_000 },
  boeing_767:  { name: 'Boeing 767',        category: 'widebody',   weeklyBaseCost: 35_000 },
  boeing_787:  { name: 'Boeing 787',        category: 'widebody',   weeklyBaseCost: 40_000 },
  boeing_777:  { name: 'Boeing 777',        category: 'widebody',   weeklyBaseCost: 42_000 },
  boeing_747:  { name: 'Boeing 747',        category: 'widebody',   weeklyBaseCost: 50_000, note: '4-engine complexity premium' },

  // ── Embraer ───────────────────────────────────────────────────────────────
  embraer_erj:  { name: 'Embraer ERJ',      category: 'regional',   weeklyBaseCost: 10_000 },
  embraer_ejet: { name: 'Embraer E-Jet',    category: 'regional',   weeklyBaseCost: 12_000 },

  // ── Bombardier ───────────────────────────────────────────────────────────
  bombardier_crj: { name: 'Bombardier CRJ', category: 'regional',   weeklyBaseCost: 10_000 },

  // ── Turboprops ───────────────────────────────────────────────────────────
  atr:    { name: 'ATR 42 / 72',        category: 'turboprop', weeklyBaseCost: 8_000 },
  dhc_q:  { name: 'Dash 8 Q Series',   category: 'turboprop', weeklyBaseCost: 8_000 },
  saab:   { name: 'Saab 340 / 2000',   category: 'turboprop', weeklyBaseCost: 8_000 },

  // ── Legacy regional ──────────────────────────────────────────────────────
  bae_146: { name: 'BAe 146 / Avro RJ',  category: 'regional', weeklyBaseCost: 14_000, note: 'Out of production — parts availability declining' },
  fokker:  { name: 'Fokker 70 / 100',   category: 'regional', weeklyBaseCost: 14_000, note: 'Out of production — parts availability declining' },

  // ── Legacy narrow / widebody ─────────────────────────────────────────────
  mcd_md80: { name: 'DC-9 / MD-80',   category: 'narrowBody', weeklyBaseCost: 20_000, note: 'Ageing fleet — rising maintenance overhead' },
  mcd_dc10: { name: 'DC-10 / MD-11',  category: 'widebody',   weeklyBaseCost: 30_000, note: 'Ageing fleet — rising maintenance overhead' },

  // ── Specialist / Eastern ─────────────────────────────────────────────────
  ilyushin:      { name: 'Ilyushin IL-96',     category: 'widebody',   weeklyBaseCost: 38_000, note: 'Specialist supply chain' },
  sukhoi_ssj:    { name: 'Sukhoi Superjet',    category: 'regional',   weeklyBaseCost: 18_000, note: 'Specialist supply chain' },
  tupolev:       { name: 'Tupolev Tu-204',      category: 'narrowBody', weeklyBaseCost: 22_000, note: 'Specialist supply chain' },
  antonov:       { name: 'Antonov AN-148',      category: 'regional',   weeklyBaseCost: 15_000, note: 'Specialist supply chain' },
  comac_c919:    { name: 'COMAC C919',          category: 'narrowBody', weeklyBaseCost: 22_000 },
  comac_arj21:   { name: 'COMAC ARJ21',         category: 'regional',   weeklyBaseCost: 14_000 },
  irkut_mc21:    { name: 'Irkut MC-21',         category: 'narrowBody', weeklyBaseCost: 22_000 },
  mitsubishi_msj:{ name: 'Mitsubishi SpaceJet', category: 'regional',   weeklyBaseCost: 18_000, note: 'Programme cancelled — parts supply uncertain' },

  // ── Small turboprops ─────────────────────────────────────────────────────
  casa_cn235:    { name: 'CASA CN-235',        category: 'turboprop', weeklyBaseCost: 7_000 },
  let_l410:      { name: 'Let L-410',          category: 'turboprop', weeklyBaseCost: 6_000 },
  beechcraft_1900: { name: 'Beechcraft 1900', category: 'turboprop', weeklyBaseCost: 6_000 },
  short_360:     { name: 'Short 360',          category: 'turboprop', weeklyBaseCost: 6_000 },

  // ── Utility turboprops ────────────────────────────────────────────────────
  utility_tp: { name: 'Utility turboprop (mixed)', category: 'utility', weeklyBaseCost: 4_000 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Look up which family an aircraft type belongs to. Returns null if unknown. */
export function aircraftFamily(typeId) {
  return AIRCRAFT_FAMILY[typeId] ?? null;
}

/** Get the set of distinct family keys active in a fleet. */
export function activeFamilies(fleet) {
  const s = new Set();
  for (const aircraft of fleet) {
    const f = aircraftFamily(aircraft.typeId);
    if (f) s.add(f);
  }
  return s;
}

/**
 * Total weekly MRO base cost for all active families.
 * @param {object[]} fleet  - array of aircraft from game state
 * @returns {number}
 */
export function weeklyFamilyBaseCost(fleet) {
  let total = 0;
  for (const famId of activeFamilies(fleet)) {
    total += FAMILY_INFO[famId]?.weeklyBaseCost ?? 0;
  }
  return total;
}
