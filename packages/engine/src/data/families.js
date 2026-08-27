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
 *
 * ── INVARIANT: every AIRCRAFT_TYPES id has a family ──────────────────────────
 * An unmapped type is invisible to activeFamilies(), so it pays $0
 * weeklyFamilyBaseCost, contributes nothing to fleetComplexityMultiplier, and
 * resolveBaseFor() (data/mroBase.js) returns null for it — no jet-base line
 * discount, no AOG reduction, and no family a base can be certified for.
 *
 * FAMILY_COVERAGE_2026_08: for a long time only 92 of the 164 types were
 * mapped. The 72 orphans included ALL 23 freighters, so a cargo-only airline
 * paid nothing for MRO infrastructure AND opened the MRO Network page to an
 * empty certification list — the whole feature was dead for freight. The gap
 * also let a 737 MAX 8-200 ride free next to a MAX 8, and an E195 ride free
 * next to an E190. Both halves of the invariant are now asserted in
 * tools/aircraft-consistency-test.mjs; do not add a type without a family.
 *
 * ── How a freighter is classified ────────────────────────────────────────────
 * A freighter conversion or purpose-built freighter belongs to its AIRFRAME's
 * family — same tube, same engines, same tooling, same type rating. A 777F is
 * boeing_777, an A330-200F is airbus_a330, a 737-800BCF is boeing_737, an E190F
 * is embraer_ejet. It reuses the existing FAMILY_INFO entry rather than adding
 * a parallel "freighter" one.
 *
 * ── How a NEW family's weeklyBaseCost is chosen ──────────────────────────────
 * By interpolating THIS table, never by inventing a scale. The existing entries
 * define a size anchor (twin-engine, Western, mainstream support):
 *
 *   ≤19 seats utility turboprop ........  8,000   (utility_tp)
 *   20-36 seats turboprop .............. 11,000   (let_l410, beechcraft_1900, short_360)
 *   37-45 seats turboprop .............. 13,000   (casa_cn235)
 *   46-80 seats turboprop .............. 15,000   (atr, dhc_q, saab)
 *   81-110 seats turboprop ............. 19,000   (extrapolated: same +4k step as 11→15)
 *   37-50 seats regional jet ........... 19,000   (embraer_erj, bombardier_crj)
 *   76-124 seats regional jet .......... 23,000   (embraer_ejet)
 *   100-134 seats narrowbody ........... 34,000   (boeing_717)
 *   110-160 seats narrowbody ........... 38,000   (airbus_a220)
 *   130-240 seats narrowbody ........... 42,000   (boeing_737, airbus_a320)
 *   200-290 seats narrowbody ........... 46,000   (boeing_757)
 *   220-345 seats widebody ............. 53,000   (airbus_a300)
 *   200-300 seats widebody ............. 66,000   (boeing_767)
 *   250-440 seats widebody ............. 72,000   (airbus_a330)
 *   300-425 seats widebody ............. 80,000   (boeing_777, airbus_a350)
 *   400-660 seats widebody quad ........ 95,000   (boeing_747)
 *   550 seats double-deck quad ........ 104,000   (airbus_a380)
 *
 * and three modifiers, read off the deltas the table already contains:
 *
 *   × 1.15  out of production with genuinely scarce parts (pre-1990 design).
 *           Precedent: bae_146 27k and fokker 27k vs embraer_ejet 23k (+17%);
 *           mcd_md80 38k vs boeing_717 34k (+12%).
 *           NOT applied in the ≤36-seat turboprop band: the table holds that
 *           band flat at 11k even for long-dead types (Short 360, Beech 1900).
 *   × 1.10  three or more engines against the twin anchor.
 *           Precedent: airbus_a340 80k vs airbus_a330 72k (+11%).
 *   × 1.15  orphaned type certificate / tiny production run / no OEM support.
 *           Precedent: sukhoi_ssj and mitsubishi_msj at 34k vs embraer_ejet 23k;
 *           comac_arj21 27k vs 23k.
 *
 * Compounded ceiling ≈ 1.45. Flagship in-production programmes are held at
 * PARITY with the Western type they compete against, following comac_c919 = 42k
 * = boeing_737 — that is why comac_c929 is 80k, not 80k × 1.15.
 *
 * Each new entry below carries its arithmetic and a cross-check against an
 * existing family of comparable size.
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
  a321p2f: 'airbus_a320',                                   // P2F conversion of the A321ceo

  // Airbus A300 / A310 ───────────────────────────────────────────────────────
  a300b4: 'airbus_a300', a300600r: 'airbus_a300', a300600f: 'airbus_a300',
  a310200: 'airbus_a300', a310300: 'airbus_a300',

  // Airbus A330 ─────────────────────────────────────────────────────────────
  a330200: 'airbus_a330', a330300: 'airbus_a330',
  a330800: 'airbus_a330', a330neo: 'airbus_a330',           // -800/-900neo are the same airframe
  a330200f: 'airbus_a330',                                  // purpose-built A330 freighter

  // Airbus A340 ─────────────────────────────────────────────────────────────
  a340300: 'airbus_a340', a340600: 'airbus_a340',

  // Airbus A350 ─────────────────────────────────────────────────────────────
  a350900: 'airbus_a350', a350900ulr: 'airbus_a350', a3501000: 'airbus_a350',
  a350f: 'airbus_a350',                                     // A350F = -1000 airframe, freight door

  // Airbus A380 ─────────────────────────────────────────────────────────────
  a380: 'airbus_a380',

  // Boeing 737 (Original + Classic + NG + MAX all share significant commonality)
  // The file's long-standing policy is to hold every 737 in one family; the
  // -200Adv joins on the same basis as the Classics.
  b737200: 'boeing_737',
  b737300: 'boeing_737', b737400: 'boeing_737', b737500: 'boeing_737',
  b737700: 'boeing_737', b737800: 'boeing_737', b737900er: 'boeing_737',
  b737max7: 'boeing_737', b737max8: 'boeing_737', b737max8200: 'boeing_737',
  b737max9: 'boeing_737', b737max10: 'boeing_737',
  b737300f: 'boeing_737', b737400f: 'boeing_737', b737800bcf: 'boeing_737',

  // Boeing 717 ──────────────────────────────────────────────────────────────
  b717: 'boeing_717',

  // Boeing 727 ──────────────────────────────────────────────────────────────
  b727200: 'boeing_727', b727200f: 'boeing_727',

  // Boeing 707 / 720 ────────────────────────────────────────────────────────
  // The 720 is a shortened, lightened 707 — same cockpit, same JT3D core.
  b707320: 'boeing_707', b720b: 'boeing_707',

  // Boeing 757 ──────────────────────────────────────────────────────────────
  b757200: 'boeing_757', b757300: 'boeing_757', b757200pf: 'boeing_757',

  // Boeing 767 ──────────────────────────────────────────────────────────────
  b767200er: 'boeing_767', b767300: 'boeing_767', b767400er: 'boeing_767',
  b767200sf: 'boeing_767', b767300f: 'boeing_767',

  // Boeing 787 Dreamliner ───────────────────────────────────────────────────
  b7878: 'boeing_787', b7879: 'boeing_787', b787x10: 'boeing_787',

  // Boeing 777 ──────────────────────────────────────────────────────────────
  b777200er: 'boeing_777', b777200lr: 'boeing_777', b777300er: 'boeing_777',
  b7778x: 'boeing_777', b7779x: 'boeing_777',
  b777f: 'boeing_777', b7778f: 'boeing_777',

  // Boeing 747 ──────────────────────────────────────────────────────────────
  b747100: 'boeing_747', b747200: 'boeing_747', b747300: 'boeing_747',
  b747sp:  'boeing_747',                                    // short-body 747, same systems
  b747400: 'boeing_747', b747400d: 'boeing_747',
  b7478i:  'boeing_747',
  b747400f: 'boeing_747', b7478f: 'boeing_747',

  // Embraer ERJ (135 / 145) ─────────────────────────────────────────────────
  erj135: 'embraer_erj', erj145: 'embraer_erj',

  // Embraer E-Jet (170 / E175 / E190 / E195 + E2 + E190F) ───────────────────
  erj170: 'embraer_ejet', e175: 'embraer_ejet', e175e2: 'embraer_ejet',
  e190: 'embraer_ejet', e195: 'embraer_ejet',
  e190e2: 'embraer_ejet', e195e2: 'embraer_ejet',
  e190f: 'embraer_ejet',                                    // P2F conversion of the E190

  // Embraer turboprops (EMB-110 / EMB-120) ─────────────────────────────────
  emb110: 'embraer_turboprop', emb120: 'embraer_turboprop',

  // Bombardier CRJ ──────────────────────────────────────────────────────────
  crj200: 'bombardier_crj', crj700: 'bombardier_crj',
  crj900: 'bombardier_crj', crj1000: 'bombardier_crj',

  // ATR ─────────────────────────────────────────────────────────────────────
  atr42: 'atr', atr72: 'atr', atr72f: 'atr',

  // De Havilland Canada Dash 8 / Q series ───────────────────────────────────
  dhc8100: 'dhc_q', dhc8200: 'dhc_q', dhc8300: 'dhc_q', q400: 'dhc_q',

  // De Havilland Canada Dash 7 (four turboprops — not a Dash 8) ─────────────
  dash7: 'dhc_dash7',

  // Saab (340 and 2000 share systems) ───────────────────────────────────────
  saab340a: 'saab', saab340: 'saab', saab2000: 'saab',

  // BAe 146 / Avro RJ ───────────────────────────────────────────────────────
  avrorj85: 'bae_146', bae146200: 'bae_146',

  // BAe Jetstream (41 is a stretched 31) ────────────────────────────────────
  js31: 'bae_jetstream', js41: 'bae_jetstream',

  // BAC One-Eleven ──────────────────────────────────────────────────────────
  bac111: 'bac_111',

  // Fokker — F28 is the direct ancestor of the F70/F100 stretch ─────────────
  f28: 'fokker', fokker70: 'fokker', fokker100: 'fokker',
  f27: 'fokker_f27',                                        // turboprop, unrelated tooling

  // Dornier 328 (the 328JET is the same airframe with turbofans) ────────────
  do328: 'dornier_328', do328jet: 'dornier_328',

  // McDonnell Douglas / Douglas ─────────────────────────────────────────────
  md80: 'mcd_md80', dc950: 'mcd_md80', md90: 'mcd_md80',   // DC-9 / MD-80 family
  dc1030: 'mcd_dc10', md11: 'mcd_dc10',                     // DC-10 / MD-11 family
  dc1030f: 'mcd_dc10', md11f: 'mcd_dc10',
  dc863: 'mcd_dc8', dc873f: 'mcd_dc8',                      // DC-8 family
  dc830: 'mcd_dc8',                                         // early -30 shares line and tooling
  dc3: 'douglas_dc3',

  // Propliner era (era worlds phase 4) ─────────────────────────────────────
  dc4:  'douglas_piston', dc6b: 'douglas_piston', dc7c: 'douglas_piston',   // one evolutionary line, shared tooling
  l749: 'lockheed_connie', l1049g: 'lockheed_connie', l1649: 'lockheed_connie',
  cv240: 'convair_pistonliner', cv440: 'convair_pistonliner',
  b377:  'boeing_377',
  m404:  'martin_404',
  comet1: 'dh_comet', comet4: 'dh_comet',
  viscount700: 'vickers_viscount', viscount800: 'vickers_viscount',
  vanguard: 'vickers_vanguard',
  britannia: 'bristol_britannia',
  il14: 'ilyushin_il14',
  il18: 'ilyushin_il18',
  tu104: 'tupolev_tu104',
  hs748: 'hawker_748',
  b707120: 'boeing_707',                                    // same line as the -320B / 720B

  // Lockheed ────────────────────────────────────────────────────────────────
  l1011: 'lockheed_l1011',
  l188:  'lockheed_l188',

  // Convair ─────────────────────────────────────────────────────────────────
  cv580: 'convair_cv580',                                   // turboprop conversion
  cv990: 'convair_cv990',                                   // 880/990 jet

  // Other Western legacy ────────────────────────────────────────────────────
  caravelle: 'sud_caravelle',
  trident3b: 'hs_trident',
  vc10:      'vickers_vc10',

  // Supersonic ──────────────────────────────────────────────────────────────
  concorde: 'concorde_sst',

  // Russian / Soviet / Eastern European ────────────────────────────────────
  il86:     'ilyushin',        // Il-96 is a re-winged, re-engined Il-86 derivative
  il96300:  'ilyushin',
  il62m:    'ilyushin_il62',   // 1960s quad narrowbody — no Il-86/96 commonality
  ssj100:   'sukhoi_ssj',
  sj100new: 'sukhoi_ssj',      // import-substituted SJ-100, same airframe
  tu204:    'tupolev',
  tu154m:   'tupolev_tu154',
  tu134:    'tupolev_tu134',
  yak42:    'yakovlev_yak42',
  yak40:    'yakovlev_yak40',
  an148:    'antonov',
  an24:     'antonov_an24',
  an12:     'antonov_an12',
  an124:    'antonov_an124',
  an225:    'antonov_an124',   // An-225 is a stretched An-124 on the same D-18T

  // Chinese ─────────────────────────────────────────────────────────────────
  c919:    'comac_c919',
  c929:    'comac_c929',
  arj21:   'comac_arj21',
  ma60:    'xian_ma60', ma600: 'xian_ma60',   // MA600 is an upgraded MA60
  mc21300: 'irkut_mc21', mc21310: 'irkut_mc21',

  // Japanese ────────────────────────────────────────────────────────────────
  spacejet: 'mitsubishi_msj',

  // Smaller turboprops ──────────────────────────────────────────────────────
  casacn235: 'casa_cn235',
  l410:      'let_l410',
  b1900d:    'beechcraft_1900',
  short360:  'short_360',

  // Utility / single and light-twin turboprops ──────────────────────────────
  // Grouped together — similar basic turboprop / piston MRO skill set.
  // The Do 228 and Cessna 408 are unpressurised utility twins in the Twin
  // Otter's class, so they join rather than each carrying a family of their own.
  bn2islander: 'utility_tp',
  c208b:       'utility_tp',
  pc12:        'utility_tp',
  dhc6:        'utility_tp',
  do228:       'utility_tp',
  c408:        'utility_tp',
};

// ─── Family metadata ──────────────────────────────────────────────────────────

/** Category labels used for display and grouping in the UI. */
export const FAMILY_CATEGORY_LABEL = {
  widebody:   'Wide Body',
  narrowBody: 'Narrow Body',
  regional:   'Regional Jet',
  turboprop:  'Turboprop',
  utility:    'Utility',
  supersonic: 'Supersonic',
};

/**
 * @typedef {object} FamilyInfo
 * @property {string} name              - Human-readable family name
 * @property {string} category          - 'widebody' | 'narrowBody' | 'regional' | 'turboprop' | 'utility' | 'supersonic'
 * @property {number} weeklyBaseCost    - Weekly MRO infrastructure cost ($) charged if ≥1 aircraft in fleet
 *                                     (MRO_COST_REBALANCE_2026_07: these are the outsourced-MRO
 *                                     contract rates. A certified jet base for the family offsets
 *                                     most of this — see data/mroBase.js.)
 * @property {string} [note]            - Optional warning (e.g. parts-supply issues)
 */

/** @type {Record<string, FamilyInfo>} */
export const FAMILY_INFO = {
  // ── Airbus ────────────────────────────────────────────────────────────────
  airbus_a220: { name: 'Airbus A220',       category: 'narrowBody', weeklyBaseCost: 38_000 },
  airbus_a320: { name: 'Airbus A320 / A321',category: 'narrowBody', weeklyBaseCost: 42_000 },
  airbus_a300: { name: 'Airbus A300 / A310',category: 'widebody',   weeklyBaseCost: 53_000 },
  airbus_a330: { name: 'Airbus A330',       category: 'widebody',   weeklyBaseCost: 72_000 },
  airbus_a340: { name: 'Airbus A340',       category: 'widebody',   weeklyBaseCost: 80_000, note: '4-engine complexity premium' },
  airbus_a350: { name: 'Airbus A350',       category: 'widebody',   weeklyBaseCost: 80_000 },
  airbus_a380: { name: 'Airbus A380',       category: 'widebody',   weeklyBaseCost: 104_000, note: 'Superjumbo — highly specialised tooling' },

  // ── Boeing ────────────────────────────────────────────────────────────────
  boeing_737:  { name: 'Boeing 737',        category: 'narrowBody', weeklyBaseCost: 42_000 },
  boeing_717:  { name: 'Boeing 717',        category: 'narrowBody', weeklyBaseCost: 34_000 },
  boeing_727:  { name: 'Boeing 727',        category: 'narrowBody', weeklyBaseCost: 49_000, note: 'Ageing trijet — scarce parts' },
  boeing_757:  { name: 'Boeing 757',        category: 'narrowBody', weeklyBaseCost: 46_000 },
  boeing_767:  { name: 'Boeing 767',        category: 'widebody',   weeklyBaseCost: 66_000 },
  boeing_787:  { name: 'Boeing 787',        category: 'widebody',   weeklyBaseCost: 76_000 },
  boeing_777:  { name: 'Boeing 777',        category: 'widebody',   weeklyBaseCost: 80_000 },
  boeing_747:  { name: 'Boeing 747',        category: 'widebody',   weeklyBaseCost: 95_000, note: '4-engine complexity premium' },
  // 707/720: 189-seat narrowbody anchor 42k × 1.15 ageing × 1.10 quad = 53.1k.
  // Cross-check: lands beside boeing_727's 49k, and the 707 is the older,
  // four-engine, JT3D-specific airframe of the two.
  boeing_707:  { name: 'Boeing 707 / 720',  category: 'narrowBody', weeklyBaseCost: 53_000, note: 'Ageing quad — scarce parts' },

  // ── Embraer ───────────────────────────────────────────────────────────────
  embraer_erj:  { name: 'Embraer ERJ',      category: 'regional',   weeklyBaseCost: 19_000 },
  embraer_ejet: { name: 'Embraer E-Jet',    category: 'regional',   weeklyBaseCost: 23_000 },
  // EMB-110 (1973) / EMB-120 (1985): 20-36 seat turboprop anchor 11k. The band
  // is flat for out-of-production types, but the newest member here is pre-1990
  // and the Bandeirante is a 1970s design, so the ageing modifier applies:
  // 11k × 1.15 = 12.65k. Cross-check: sits just above short_360's 11k.
  embraer_turboprop: { name: 'Embraer EMB-110 / EMB-120', category: 'turboprop', weeklyBaseCost: 13_000 },

  // ── Bombardier ───────────────────────────────────────────────────────────
  bombardier_crj: { name: 'Bombardier CRJ', category: 'regional',   weeklyBaseCost: 19_000 },

  // ── Turboprops ───────────────────────────────────────────────────────────
  atr:    { name: 'ATR 42 / 72',        category: 'turboprop', weeklyBaseCost: 15_000 },
  dhc_q:  { name: 'Dash 8 Q Series',   category: 'turboprop', weeklyBaseCost: 15_000 },
  saab:   { name: 'Saab 340 / 2000',   category: 'turboprop', weeklyBaseCost: 15_000 },
  // Dash 7: 54 seats → 46-80 turboprop anchor 15k × 1.10 (four engines, where
  // every other type in that band is a twin) × 1.15 (≈110 built, orphaned line)
  // = 18.98k. Cross-check: just under the 19k regional-jet anchor, which is
  // right for a four-engine STOL type nobody supports any more.
  dhc_dash7: { name: 'Dash 7',         category: 'turboprop', weeklyBaseCost: 19_000, note: 'Four turboprops, orphaned line — parts made to order' },
  // Fokker F27: 52 seats → 15k × 1.15 ageing (1958 design) = 17.25k.
  fokker_f27: { name: 'Fokker F27',    category: 'turboprop', weeklyBaseCost: 17_000, note: 'Out of production — parts availability declining' },
  // Jetstream 31/41: 19-29 seats → 11k anchor, no modifier. The ≤36-seat band is
  // held flat for out-of-production types (Short 360, Beech 1900 both 11k) and
  // the J41 is a 1992 airframe, so nothing compounds. Cross-check: 11k exactly.
  bae_jetstream: { name: 'BAe Jetstream 31 / 41', category: 'turboprop', weeklyBaseCost: 11_000 },
  // Convair 580: 56 seats → 15k × 1.15 (1960) × 1.15 (turboprop conversion of a
  // 1947 piston airframe, no OEM at all) = 19.8k.
  convair_cv580: { name: 'Convair 580', category: 'turboprop', weeklyBaseCost: 20_000, note: 'Turboprop conversion of a piston airframe — no OEM support' },
  // An-24: 52 seats → 15k × 1.15 (1962) × 1.15 (Soviet supply chain) = 19.8k.
  antonov_an24: { name: 'Antonov An-24', category: 'turboprop', weeklyBaseCost: 20_000, note: 'Specialist supply chain' },
  // MA60/MA600: 60 seats → 15k × 1.15 (limited support network outside China).
  // Cross-check: comac_arj21 carries the same +17% over its Western anchor.
  xian_ma60: { name: 'Xian MA60 / MA600', category: 'turboprop', weeklyBaseCost: 17_000, note: 'Specialist supply chain' },
  // L-188 Electra: 104 seats → 81-110 turboprop anchor 19k × 1.15 (1959) × 1.10
  // (four engines) × 1.15 (170 built, dead OEM) = 27.6k. Cross-check: 28k lands
  // one notch above bae_146's 27k, which is the same idea — a four-engine
  // out-of-production type of similar size.
  lockheed_l188: { name: 'Lockheed L-188 Electra', category: 'turboprop', weeklyBaseCost: 28_000, note: 'Four turboprops, dead OEM — scarce parts' },
  // An-12: a 1959 four-turboprop 20-tonne freighter, the Electra's size and era
  // class. Same arithmetic, same result.
  antonov_an12: { name: 'Antonov An-12', category: 'turboprop', weeklyBaseCost: 28_000, note: 'Ageing Soviet quad — scarce parts' },
  // DC-3: 32 seats → 11k anchor × 1.15 (1936) × 1.15 (radial piston tooling and
  // skills no modern shop keeps) = 14.5k. It genuinely costs an ATR-72's family
  // to keep a DC-3 airworthy, and that is the point of the entry.
  douglas_dc3: { name: 'Douglas DC-3', category: 'turboprop', weeklyBaseCost: 15_000, note: 'Radial piston airframe — vintage tooling and skills' },

  // ── Propliner era (era worlds phase 4) ─────────────────────────────────────
  // Costs interpolated from the table above, per its own rules: band anchor
  // × 1.15 pre-1990 scarce parts where the band applies it, × 1.10 for 3+
  // engines, × 1.15 orphaned certificate. Cross-checks named per entry.
  douglas_piston:      { name: 'Douglas DC-4/6/7',   category: 'turboprop', weeklyBaseCost: 19_000, note: 'One evolutionary quad-piston line; 46-80 seat band 15k × 1.15 vintage × 1.10 quad — beside lockheed_l188 28k which also carries the orphan bump' },
  lockheed_connie:     { name: 'Lockheed Constellation', category: 'turboprop', weeklyBaseCost: 24_000, note: 'Triple-tail quads, Wright R-3350s; 81-110 band 19k × 1.15 × 1.10 — under lockheed_l188 28k (smaller support ecosystem there)' },
  convair_pistonliner: { name: 'Convair 240/440',    category: 'turboprop', weeklyBaseCost: 15_000, note: 'Piston twins, huge production run; 37-45 band 13k × 1.15 — beside convair_cv580 20k whose conversion has no OEM' },
  boeing_377:          { name: 'Boeing 377 Stratocruiser', category: 'turboprop', weeklyBaseCost: 26_000, note: 'R-4360 quad, tiny run; 81-110 band 19k × 1.15 vintage × 1.10 quad × orphan rounding — the maintenance hangar queen of the era' },
  martin_404:          { name: 'Martin 4-0-4',       category: 'turboprop', weeklyBaseCost: 15_000, note: '40-seat piston twin; 37-45 band 13k × 1.15 — matches convair_pistonliner, its direct competitor' },
  dh_comet:            { name: 'de Havilland Comet', category: 'narrowBody', weeklyBaseCost: 39_000, note: 'First jet airliner; 100-134 narrowbody 34k × 1.15 vintage — beside boeing_717 34k in-production anchor' },
  vickers_viscount:    { name: 'Vickers Viscount',   category: 'turboprop', weeklyBaseCost: 17_000, note: 'Dart turboprops, enormous run; 46-80 band 15k × 1.15 — beside atr/dhc_q 15k in-production anchors' },
  vickers_vanguard:    { name: 'Vickers Vanguard',   category: 'turboprop', weeklyBaseCost: 22_000, note: 'Big Tyne turboprop, tiny run; 81-110 band 19k × 1.15 — beside ilyushin_il18 24k which adds the quad bump' },
  bristol_britannia:   { name: 'Bristol Britannia',  category: 'turboprop', weeklyBaseCost: 26_000, note: '139-seat long-range turboprop; extrapolated 23k anchor × 1.15 — beside lockheed_connie 24k' },
  ilyushin_il14:       { name: 'Ilyushin Il-14',     category: 'turboprop', weeklyBaseCost: 11_000, note: '≤36-seat band held flat at 11k even for long-dead types, per the table\'s own rule (Short 360 precedent)' },
  ilyushin_il18:       { name: 'Ilyushin Il-18',     category: 'turboprop', weeklyBaseCost: 24_000, note: 'Soviet quad turboprop; 81-110 band 19k × 1.15 × 1.10 — beside antonov_an24 20k' },
  tupolev_tu104:       { name: 'Tupolev Tu-104',     category: 'narrowBody', weeklyBaseCost: 45_000, note: 'Orphaned early Soviet jet; 100-134 band 34k × 1.15 vintage × 1.15 orphan — beside tupolev_tu134 30k (regional band)' },
  hawker_748:          { name: 'Hawker Siddeley 748', category: 'turboprop', weeklyBaseCost: 15_000, note: '46-80 band held at anchor: 26-year production run and wide operator base — the well-supported exception, like the ATRs' },

  // ── Legacy regional ──────────────────────────────────────────────────────
  bae_146: { name: 'BAe 146 / Avro RJ',  category: 'regional', weeklyBaseCost: 27_000, note: 'Out of production — parts availability declining' },
  fokker:  { name: 'Fokker F28 / 70 / 100', category: 'regional', weeklyBaseCost: 27_000, note: 'Out of production — parts availability declining' },
  // Dornier 328 / 328JET: 33-34 seats, between the 46-80 turboprop anchor (15k)
  // and the 37-50 regional-jet anchor (19k) → 17k, × 1.15 (type certificate has
  // passed through Fairchild → AvCraft → Deutsche Aircraft) = 19.55k.
  dornier_328: { name: 'Dornier 328 / 328JET', category: 'regional', weeklyBaseCost: 20_000, note: 'Orphaned type certificate — support has changed hands repeatedly' },
  // Yak-40: 40 seats → 19k regional anchor × 1.15 (1968) × 1.15 (Soviet chain)
  // = 25.1k. Cross-check: below sukhoi_ssj's 34k, which is the larger type.
  yakovlev_yak40: { name: 'Yakovlev Yak-40', category: 'regional', weeklyBaseCost: 25_000, note: 'Ageing Soviet trijet — scarce parts' },
  // Tu-134: 96 seats → 23k regional anchor × 1.15 (1967) × 1.15 = 30.4k.
  tupolev_tu134: { name: 'Tupolev Tu-134', category: 'regional', weeklyBaseCost: 30_000, note: 'Ageing Soviet type — scarce parts' },

  // ── Legacy narrow / widebody ─────────────────────────────────────────────
  mcd_md80: { name: 'DC-9 / MD-80',   category: 'narrowBody', weeklyBaseCost: 38_000, note: 'Ageing fleet — rising maintenance overhead' },
  mcd_dc10: { name: 'DC-10 / MD-11',  category: 'widebody',   weeklyBaseCost: 57_000, note: 'Ageing fleet — rising maintenance overhead' },
  // DC-8-63/-73F: 259 seats → 46k (200-290 narrowbody) × 1.15 × 1.10 (quad) = 58.2k.
  mcd_dc8:  { name: 'Douglas DC-8',   category: 'narrowBody', weeklyBaseCost: 58_000, note: 'Ageing quad — scarce parts' },
  // BAC 1-11: 119 seats → 34k (100-134) × 1.15 (1968) × 1.15 (244 built, dead
  // OEM) = 44.9k. Cross-check: below boeing_727's 49k, the larger ageing type.
  bac_111:  { name: 'BAC One-Eleven', category: 'narrowBody', weeklyBaseCost: 45_000, note: 'Out of production — parts made to order' },
  // Caravelle: 140 seats → 38k (110-160) × 1.15 (1959) × 1.15 (282 built, no
  // OEM) = 50.2k. Cross-check: just above boeing_727's 49k, and the Caravelle
  // is both older and a fraction as numerous.
  sud_caravelle: { name: 'Sud Caravelle', category: 'narrowBody', weeklyBaseCost: 50_000, note: 'Out of production — parts made to order' },
  // VC10: 151 seats → 38k × 1.15 (1964) × 1.10 (quad) × 1.15 (54 built) = 55.3k.
  vickers_vc10: { name: 'Vickers VC10', category: 'narrowBody', weeklyBaseCost: 55_000, note: 'Fifty-four built — every part is bespoke' },
  // CV-990: 149 seats → 38k × 1.15 (1962) × 1.10 (quad) × 1.15 (37 built) = 55.3k.
  convair_cv990: { name: 'Convair 990 Coronado', category: 'narrowBody', weeklyBaseCost: 55_000, note: 'Thirty-seven built — every part is bespoke' },
  // Trident 3B: 180 seats → 42k (130-240) × 1.15 (1971) × 1.10 (trijet) × 1.15
  // (117 built, dead OEM) = 61.0k. This is the table's ceiling for the modifier
  // stack and is meant to be a trap type — cheap to buy, brutal to support.
  hs_trident: { name: 'HS Trident', category: 'narrowBody', weeklyBaseCost: 61_000, note: 'Ageing trijet, dead OEM — every part is bespoke' },
  // Tu-154: 180 seats → 42k × 1.15 (1984) × 1.10 (trijet) = 53.1k. Cross-check:
  // above boeing_727's 49k, which is the same shape of aircraft with a far
  // deeper parts market.
  tupolev_tu154: { name: 'Tupolev Tu-154', category: 'narrowBody', weeklyBaseCost: 53_000, note: 'Ageing Soviet trijet — scarce parts' },
  // Il-62: 186 seats → 42k × 1.15 (1974) × 1.10 (quad) = 53.1k.
  ilyushin_il62: { name: 'Ilyushin Il-62', category: 'narrowBody', weeklyBaseCost: 53_000, note: 'Ageing Soviet quad — scarce parts' },
  // Yak-42: 120 seats → 34k (100-134) × 1.15 (1980) × 1.10 (trijet) = 43.0k.
  // Cross-check: sits beside tupolev's 42k, which is the right neighbourhood
  // for an Eastern narrowbody of this size.
  yakovlev_yak42: { name: 'Yakovlev Yak-42', category: 'narrowBody', weeklyBaseCost: 43_000, note: 'Ageing Soviet trijet — scarce parts' },
  // L-1011: the DC-10's exact contemporary, rival and size class, so it anchors
  // directly on mcd_dc10's 57k rather than re-deriving from seats. × 1.15
  // (250 built against 646 DC-10/MD-11, and RB211-only) = 65.6k. Cross-check:
  // still under boeing_767's 66k, which is a live, supported widebody.
  lockheed_l1011: { name: 'Lockheed L-1011 TriStar', category: 'widebody', weeklyBaseCost: 65_000, note: 'Ageing trijet, dead OEM — RB211-specific tooling' },

  // ── Specialist / Eastern ─────────────────────────────────────────────────
  ilyushin:      { name: 'Ilyushin Il-86 / Il-96', category: 'widebody',   weeklyBaseCost: 72_000, note: 'Specialist supply chain' },
  sukhoi_ssj:    { name: 'Sukhoi Superjet',    category: 'regional',   weeklyBaseCost: 34_000, note: 'Specialist supply chain' },
  tupolev:       { name: 'Tupolev Tu-204',      category: 'narrowBody', weeklyBaseCost: 42_000, note: 'Specialist supply chain' },
  antonov:       { name: 'Antonov An-148',      category: 'regional',   weeklyBaseCost: 28_000, note: 'Specialist supply chain' },
  // An-124 / An-225: 120t and 250t strategic airlifters on the same D-18T and
  // the same systems lineage (the -225 is a stretched -124). Anchor on
  // boeing_747's 95k — the only comparable class in the table, and the An-124
  // out-lifts a 747-400F — × 1.15 (Antonov's line is gone; every heavy check is
  // a bespoke project). = 109.3k. This is the dearest family in the game, above
  // airbus_a380's 104k, which is the correct ordering.
  antonov_an124: { name: 'Antonov An-124 / An-225', category: 'widebody', weeklyBaseCost: 109_000, note: 'Outsize airlifter — bespoke heavy checks, no production line' },
  comac_c919:    { name: 'COMAC C919',          category: 'narrowBody', weeklyBaseCost: 42_000 },
  // C929: 440-seat widebody → parity with boeing_777 / airbus_a350 at 80k,
  // following the precedent that comac_c919 sits at boeing_737's 42k rather
  // than carrying a specialist premium.
  comac_c929:    { name: 'COMAC C929',          category: 'widebody',   weeklyBaseCost: 80_000 },
  comac_arj21:   { name: 'COMAC ARJ21',         category: 'regional',   weeklyBaseCost: 27_000 },
  irkut_mc21:    { name: 'Irkut MC-21',         category: 'narrowBody', weeklyBaseCost: 42_000 },
  mitsubishi_msj:{ name: 'Mitsubishi SpaceJet', category: 'regional',   weeklyBaseCost: 34_000, note: 'Programme cancelled — parts supply uncertain' },

  // ── Supersonic ───────────────────────────────────────────────────────────
  // Concorde: 20 airframes ever, four afterburning Olympus turbojets, and a
  // bespoke supply chain for every system on it. Airbus withdrawing support in
  // 2003 is the literal reason it stopped flying. Anchor on airbus_a380's
  // 104k — the table's existing "highly specialised tooling" ceiling — × 1.15
  // (a fleet a thousandth the size, with no OEM at all) = 119.6k.
  concorde_sst: { name: 'Concorde', category: 'supersonic', weeklyBaseCost: 120_000, note: 'Twenty ever built — bespoke everything, no OEM support' },

  // ── Small turboprops ─────────────────────────────────────────────────────
  casa_cn235:    { name: 'CASA CN-235',        category: 'turboprop', weeklyBaseCost: 13_000 },
  let_l410:      { name: 'Let L-410',          category: 'turboprop', weeklyBaseCost: 11_000 },
  beechcraft_1900: { name: 'Beechcraft 1900', category: 'turboprop', weeklyBaseCost: 11_000 },
  short_360:     { name: 'Short 360',          category: 'turboprop', weeklyBaseCost: 11_000 },

  // ── Utility turboprops ────────────────────────────────────────────────────
  utility_tp: { name: 'Utility turboprop (mixed)', category: 'utility', weeklyBaseCost: 8_000 },
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

// ─── Fleet complexity penalty ───────────────────────────────────────────────────
//
// Operating multiple aircraft families splits pilot pools and multiplies type
// ratings, recurrent sim training and maintenance type-skills. We model this as a
// surcharge on the affected labor groups: +2% per family BEYOND the first, so a
// single-family carrier (e.g. all-737) pays no penalty, two families +2%, etc.

/** Surcharge added to affected labor groups for each family beyond the first. */
export const FLEET_COMPLEXITY_PCT_PER_EXTRA_FAMILY = 0.02;

/** Labor groups whose fixed overhead is affected by fleet complexity. */
export const COMPLEXITY_AFFECTED_GROUPS = ['pilots', 'maintenanceTeam'];

/**
 * Multiplier (≥ 1.0) applied to affected labor groups' fixed overhead.
 * 1 family → 1.00, 2 → 1.02, 3 → 1.04, …
 * @param {object[]} fleet - array of aircraft from game state
 */
export function fleetComplexityMultiplier(fleet) {
  const extra = Math.max(0, activeFamilies(fleet).size - 1);
  return 1 + FLEET_COMPLEXITY_PCT_PER_EXTRA_FAMILY * extra;
}

/**
 * Total weekly MRO base cost for all active families, net of any jet-base
 * contract offsets.
 * @param {object[]} fleet            - array of aircraft from game state
 * @param {object}   offsetsByFamily  - { [familyId]: 0..1 } from familyContractOffsets()
 * @returns {number}
 */
export function weeklyFamilyBaseCost(fleet, offsetsByFamily = null) {
  let total = 0;
  for (const famId of activeFamilies(fleet)) {
    const gross  = FAMILY_INFO[famId]?.weeklyBaseCost ?? 0;
    // A certified jet base does this family's work in-house, so most of the
    // outsourced contract falls away (see data/mroBase.js contractOffset).
    const offset = Math.max(0, Math.min(1, offsetsByFamily?.[famId] ?? 0));
    total += gross * (1 - offset);
  }
  return Math.round(total);
}
