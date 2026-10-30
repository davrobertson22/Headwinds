// Travel partnerships — cruise lines, tour operators, hotel chains and ride
// share, each lifting ONE demand segment at the airports it works in, in return
// for requirements the airline has to keep meeting.
//
// Design: PARTNERSHIPS_PLAN.md (locked with Dave 2026-10-29).
//
//   Segment      Cruise lines and tour operators lift LEISURE demand; hotels and
//                ride share lift BUSINESS demand. The lift is a demand-model term
//                (offer.travelLeisureAppeal / travelBusinessAppeal), the same
//                log-identity lounges use for the business segment: a share term
//                on a contested pair, a pool term on a monopoly. Never revenue,
//                never quality score, never brandReach.
//   Requirements Each partner measures what the airline delivers to its airports
//                (segment passengers arriving, airports served, departures,
//                on-time, route quality, premium cabins). Combined attainment A
//                sets a target happiness; happiness moves 10%/week toward it.
//   Happiness    Fades the lift (full at ≥50, none at 20), prices the renewal,
//                feeds reputation, and below 15 for four weeks the partner walks.
//   Shared       Any airline can sign any partner — one book per world, prices
//                hashed from partner × 26-week window, no server state.
//   Term         Every contract and every renewal is 2 years, paid in two annual
//                instalments through the weekly report (so the P&L shows them).
//   Lost         A partner that walks out, or refuses to renew, will not work
//                with that airline again for 5 years (260 weeks).
//   New worlds   Only where state.partnershipsWorld is true.
//
// The word is "travel partner" throughout the code because `partner` already
// means alliance / codeshare / interline partners (partnerContestedKeys,
// totalPartnerFees, partnerHealthDecay).
//
// State, spread CONDITIONALLY everywhere so a world that never signs one is
// byte-identical (the golden master):
//   travelPartners:      { [partnerId]: contract }      (see makeTravelPartnerContract)
//   travelPartnerMemory: { [partnerId]: { cooldownUntil, rejoinHappiness } }
//
// Pure module: shared by the reducer (enforcement), weeklyTick (effects and the
// weekly settle) and the UI (display), so no screen quotes a number the engine
// will not charge.

import { AIRPORTS, getAirport, getRegion, getAirportScores } from './airports.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const TP_TERM_WEEKS          = 104;   // every contract, every renewal: 2 years
export const TP_INSTALMENT_WEEKS    = 52;    // one instalment per contract year
export const TP_INSTALMENTS         = 2;
export const TP_START_HAPPINESS     = 60;
export const TP_REJOIN_HAPPINESS    = 40;    // after a break, or after a cooldown ends
export const TP_GRACE_WEEKS         = 8;     // new signings: happiness can only rise
export const TP_ADAPT_RATE          = 0.10;  // weekly EWMA toward target happiness
export const TP_WALKOUT_LEVEL       = 15;
export const TP_WALKOUT_WEEKS       = 4;
export const TP_LOST_COOLDOWN_WEEKS = 260;   // 5 years
export const TP_RENEWAL_WINDOW      = 8;     // weeks before expiry the renewal opens
export const TP_APPEAL_CAP          = 1.15;  // per segment, all partners combined
export const TP_LIFT_FULL_AT        = 50;
export const TP_LIFT_ZERO_AT        = 20;
export const TP_BREAK_FRACTION      = 0.5;   // of the unpaid instalment(s)
export const TP_BOOK_WINDOW_WEEKS   = 26;
export const TP_BOOK_DRIFT          = 0.10;
export const TP_REP_WALKOUT_PER_PROM = 3;    // reputationPenalty per prominence point
export const TP_REP_BREAK_PER_PROM   = 1.5;
export const TP_REP_MIN = -8;
export const TP_REP_MAX = 2;
export const TP_AUTORENEW_MIN_HAPPINESS = 35;
/** Rate requirements: points short of target at which attainment hits 0. */
export const TP_RATE_BAND = 10;

export const TP_TYPES = {
  cruise:    { id: 'cruise',    label: 'Cruise line',    plural: 'Cruise lines',    segment: 'leisure',  icon: '🛳️' },
  tours:     { id: 'tours',     label: 'Tour operator',  plural: 'Tour operators',  segment: 'leisure',  icon: '🏝️' },
  hotel:     { id: 'hotel',     label: 'Hotel chain',    plural: 'Hotel chains',    segment: 'business', icon: '🏨' },
  rideshare: { id: 'rideshare', label: 'Ride share',     plural: 'Ride share',      segment: 'business', icon: '🚗' },
};
export const TP_TYPE_ORDER = ['cruise', 'tours', 'hotel', 'rideshare'];

// ─── Catalogue ───────────────────────────────────────────────────────────────
//
// Invented names only. `coverage` is a union of clauses:
//   { kind: 'airports', codes: [...] }
//   { kind: 'region', region }                 — airports.js getRegion
//   { kind: 'countries', countries: [...] }
//   { kind: 'scoreRegion', region, score: 'leisureScore'|'businessScore', min }
// `season` (cruise only): the game months (1–12) the partner sails. Out of
// season the lift is off and the requirements are not measured.
// `fee`: list price per contract year, before the book drift. Calibrated by
// tools/travel-partner-calibration.mjs (PARTNERSHIPS_PLAN.md §8): ≈40% of the
// yearly revenue the lift adds for an airline exactly on the partner's volume
// target, floored at $250K. Value grows with how much you fly into a partner's
// airports, so the same fee is a far better deal for a big airline.
//
// Requirement kinds (`min` is the base target; renewals can tighten it):
//   segmentPaxTo  { segment, min }   one-way pax of that segment ARRIVING at covered airports
//   serveCount    { min }            covered airports with ≥1 weekly passenger frequency
//   departures    { min }            weekly departures from covered airports
//   onTime        { min }            airline on-time rate, %
//   routeQuality  { min }            pax-weighted route quality on routes touching coverage
//   premiumCabin  { min }            % of routes touching coverage with business seats

export const TRAVEL_PARTNERS = [
  // ── Cruise lines (leisure) ────────────────────────────────────────────────
  { id: 'azurehorizon', name: 'Azure Horizon Cruises', type: 'cruise', prominence: 3,
    coverage: [{ kind: 'airports', codes: ['MIA', 'FLL', 'MCO', 'TPA', 'SJU'] }],
    coverageLabel: 'Caribbean ports', season: [11, 12, 1, 2, 3, 4], lift: 0.07, fee: 250_000,
    requirements: [{ kind: 'segmentPaxTo', segment: 'leisure', min: 1500 }],
    blurb: 'The biggest fleet sailing the Caribbean. Wants its passengers flown in, all winter.' },
  { id: 'northernpassage', name: 'Northern Passage Line', type: 'cruise', prominence: 2,
    coverage: [{ kind: 'airports', codes: ['SEA', 'YVR', 'ANC', 'JNU'] }],
    coverageLabel: 'Alaska ports', season: [5, 6, 7, 8, 9], lift: 0.06, fee: 250_000,
    requirements: [
      { kind: 'segmentPaxTo', segment: 'leisure', min: 500 },
      { kind: 'serveCount', min: 2 },
    ],
    blurb: 'Glacier cruises out of Seattle and Vancouver, May to September.' },
  { id: 'marenostrum', name: 'Mare Nostrum Cruises', type: 'cruise', prominence: 3,
    coverage: [{ kind: 'airports', codes: ['BCN', 'FCO', 'VCE', 'ATH'] }],
    coverageLabel: 'Mediterranean ports', season: [4, 5, 6, 7, 8, 9, 10], lift: 0.07, fee: 250_000,
    requirements: [
      { kind: 'segmentPaxTo', segment: 'leisure', min: 1200 },
      { kind: 'routeQuality', min: 50 },
    ],
    blurb: 'Mediterranean itineraries from Barcelona, Rome, Venice and Athens.' },
  { id: 'southernstar', name: 'Southern Star Cruising', type: 'cruise', prominence: 1,
    coverage: [{ kind: 'airports', codes: ['SYD', 'BNE', 'AKL', 'SIN'] }],
    coverageLabel: 'Pacific & SE Asia ports', season: [10, 11, 12, 1, 2, 3], lift: 0.06, fee: 250_000,
    requirements: [{ kind: 'segmentPaxTo', segment: 'leisure', min: 400 }],
    blurb: 'Southern-summer cruising out of Sydney, Brisbane, Auckland and Singapore.' },

  // ── Tour / vacation operators (leisure) ───────────────────────────────────
  { id: 'solstice', name: 'Solstice Holidays', type: 'tours', prominence: 2,
    coverage: [{ kind: 'airports', codes: ['PMI', 'AGP', 'ALC', 'FAO', 'HER', 'TFS', 'LCA'] }],
    coverageLabel: 'European sun', season: null, lift: 0.06, fee: 550_000,
    requirements: [
      { kind: 'serveCount', min: 4 },
      { kind: 'segmentPaxTo', segment: 'leisure', min: 2000 },
    ],
    blurb: 'Package holidays to the Mediterranean and the Canaries.' },
  { id: 'farfield', name: 'Farfield Expeditions', type: 'tours', prominence: 2,
    coverage: [{ kind: 'airports', codes: ['DPS', 'MLE', 'CPT', 'HNL', 'CUN', 'BKK'] }],
    coverageLabel: 'Long-haul bucket list', season: null, lift: 0.08, fee: 1_150_000,
    reputationMin: 55,
    requirements: [
      { kind: 'serveCount', min: 3 },
      { kind: 'routeQuality', min: 60 },
    ],
    blurb: 'Premium long-haul tours. Picky about who flies its clients.' },
  { id: 'palmreef', name: 'Palm & Reef Vacations', type: 'tours', prominence: 1,
    coverage: [{ kind: 'airports', codes: ['AUA', 'NAS', 'MBJ', 'PUJ', 'OGG', 'NAN'] }],
    coverageLabel: 'Island resorts', season: null, lift: 0.07, fee: 300_000,
    requirements: [
      { kind: 'serveCount', min: 3 },
      { kind: 'segmentPaxTo', segment: 'leisure', min: 600 },
    ],
    blurb: 'All-inclusive island resorts in the Caribbean and the Pacific.' },
  { id: 'backroads', name: 'Backroads Budget Tours', type: 'tours', prominence: 1,
    coverage: [{ kind: 'scoreRegion', region: 'North America', score: 'leisureScore', min: 60 }],
    coverageLabel: 'North American holiday spots', season: null, lift: 0.03, fee: 450_000,
    requirements: [
      { kind: 'segmentPaxTo', segment: 'leisure', min: 3000 },
      { kind: 'onTime', min: 80 },
    ],
    blurb: 'Coach-and-flight bundles to every big North American holiday spot.' },

  // ── Hotel chains (business) ───────────────────────────────────────────────
  { id: 'aldgate', name: 'Aldgate Hotels & Resorts', type: 'hotel', prominence: 3,
    coverage: [{ kind: 'airports', codes: ['JFK', 'LHR', 'CDG', 'FRA', 'HKG', 'SIN', 'NRT', 'DXB'] }],
    coverageLabel: 'Global business capitals', season: null, lift: 0.06, fee: 400_000,
    reputationMin: 60,
    requirements: [
      { kind: 'segmentPaxTo', segment: 'business', min: 1500 },
      { kind: 'routeQuality', min: 65 },
    ],
    blurb: 'Flagship hotels in the world’s business capitals. Only works with the best.' },
  { id: 'lodestar', name: 'Lodestar Inns', type: 'hotel', prominence: 2,
    coverage: [{ kind: 'scoreRegion', region: 'North America', score: 'businessScore', min: 55 }],
    coverageLabel: 'North American business cities', season: null, lift: 0.04, fee: 250_000,
    requirements: [
      { kind: 'segmentPaxTo', segment: 'business', min: 1000 },
      { kind: 'onTime', min: 85 },
    ],
    blurb: 'Mid-scale business hotels across North America. Hates a late arrival.' },
  { id: 'kestrel', name: 'Kestrel Suites', type: 'hotel', prominence: 2,
    coverage: [{ kind: 'airports', codes: ['HKG', 'SIN', 'NRT', 'HND', 'ICN', 'PVG', 'TPE', 'KUL', 'BOM', 'DEL'] }],
    coverageLabel: 'Asian business cities', season: null, lift: 0.06, fee: 250_000,
    reputationMin: 50,
    requirements: [
      { kind: 'segmentPaxTo', segment: 'business', min: 800 },
      { kind: 'premiumCabin', min: 60 },
    ],
    blurb: 'Premium suites across Asia. Expects a proper business cabin.' },
  { id: 'harbourline', name: 'Harbourline Hotels', type: 'hotel', prominence: 2,
    coverage: [{ kind: 'airports', codes: ['LHR', 'FRA', 'CDG', 'AMS', 'ZRH', 'MUC', 'MAD'] }],
    coverageLabel: 'European business cities', season: null, lift: 0.05, fee: 250_000,
    requirements: [
      { kind: 'segmentPaxTo', segment: 'business', min: 1000 },
      { kind: 'onTime', min: 85 },
    ],
    blurb: 'Business hotels in Europe’s financial centres.' },

  // ── Ride share (business) ─────────────────────────────────────────────────
  { id: 'zipway', name: 'Zipway', type: 'rideshare', prominence: 1,
    coverage: [{ kind: 'countries', countries: ['US'] }],
    coverageLabel: 'United States', season: null, lift: 0.03, fee: 1_700_000,
    requirements: [
      { kind: 'departures', min: 400 },
      { kind: 'onTime', min: 82 },
    ],
    blurb: 'US ride hailing. Airport pickups are its best business — if you land on time.' },
  { id: 'velo', name: 'Velo Rides', type: 'rideshare', prominence: 1,
    coverage: [{ kind: 'region', region: 'Europe' }],
    coverageLabel: 'Europe', season: null, lift: 0.03, fee: 1_650_000,
    requirements: [
      { kind: 'departures', min: 300 },
      { kind: 'onTime', min: 85 },
    ],
    blurb: 'Europe-wide ride hailing.' },
  { id: 'lumo', name: 'Lumo Ride', type: 'rideshare', prominence: 1,
    coverage: [{ kind: 'region', region: 'Asia' }],
    coverageLabel: 'Asia', season: null, lift: 0.03, fee: 7_500_000,
    requirements: [
      { kind: 'departures', min: 300 },
      { kind: 'onTime', min: 82 },
    ],
    blurb: 'Asian super-app rides.' },
  { id: 'rumbo', name: 'Rumbo', type: 'rideshare', prominence: 1,
    coverage: [
      { kind: 'region', region: 'South America' },
      { kind: 'countries', countries: ['MX', 'GT', 'BZ', 'SV', 'HN', 'NI', 'CR', 'PA'] },
    ],
    coverageLabel: 'Latin America', season: null, lift: 0.03, fee: 3_600_000,
    requirements: [
      { kind: 'departures', min: 150 },
      { kind: 'onTime', min: 80 },
    ],
    blurb: 'Ride hailing from Mexico to Patagonia.' },
];

export const TRAVEL_PARTNER_MAP = Object.fromEntries(TRAVEL_PARTNERS.map(p => [p.id, p]));
export const getTravelPartner = (id) => TRAVEL_PARTNER_MAP[id] ?? null;

const RATE_KINDS = new Set(['onTime', 'routeQuality', 'premiumCabin']);
const RATE_CEILING = { onTime: 95, routeQuality: 90, premiumCabin: 100 };

export const REQUIREMENT_LABEL = {
  segmentPaxTo: (r) => `${r.segment === 'business' ? 'Business' : 'Leisure'} passengers a week into its airports`,
  serveCount:   () => 'Its airports you serve',
  departures:   () => 'Weekly departures from its airports',
  onTime:       () => 'On-time rate',
  routeQuality: () => 'Route quality on routes to its airports',
  premiumCabin: () => 'Routes to its airports with a business cabin',
};
export function requirementLabel(req) {
  return REQUIREMENT_LABEL[req?.kind]?.(req) ?? req?.kind ?? '';
}
export function isRateRequirement(req) { return RATE_KINDS.has(req?.kind); }
/** "1,500" / "85%" / "60" — how a target or an actual reads. */
export function formatRequirementValue(req, v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (req?.kind === 'onTime' || req?.kind === 'premiumCabin') return `${Math.round(v)}%`;
  return Math.round(v).toLocaleString('en-US');
}

// ─── Coverage ────────────────────────────────────────────────────────────────

const COVERAGE_MEMO = new Map();

function clauseCovers(clause, ap) {
  if (!clause || !ap) return false;
  switch (clause.kind) {
    case 'airports':  return clause.codes.includes(ap.code);
    case 'region':    return getRegion(ap.country) === clause.region;
    case 'countries': return clause.countries.includes(ap.country);
    case 'scoreRegion':
      return getRegion(ap.country) === clause.region
        && (getAirportScores(ap.code)?.[clause.score] ?? 0) >= clause.min;
    default: return false;
  }
}

/** Every airport code a partner covers (memoised; the catalogue is static). */
export function travelPartnerAirports(partnerOrId) {
  const p = typeof partnerOrId === 'string' ? TRAVEL_PARTNER_MAP[partnerOrId] : partnerOrId;
  if (!p) return new Set();
  const hit = COVERAGE_MEMO.get(p.id);
  if (hit) return hit;
  const out = new Set();
  const explicit = p.coverage.every(c => c.kind === 'airports');
  if (explicit) {
    for (const c of p.coverage) for (const code of c.codes) if (getAirport(code)) out.add(code);
  } else {
    for (const ap of AIRPORTS) if (p.coverage.some(c => clauseCovers(c, ap))) out.add(ap.code);
  }
  COVERAGE_MEMO.set(p.id, out);
  return out;
}

export function travelPartnerCovers(partnerOrId, code) {
  return !!code && travelPartnerAirports(partnerOrId).has(code);
}

/** Is the partner active this game month? Non-seasonal partners always are. */
export function travelPartnerInSeason(partnerOrId, month) {
  const p = typeof partnerOrId === 'string' ? TRAVEL_PARTNER_MAP[partnerOrId] : partnerOrId;
  if (!p) return false;
  if (!p.season?.length) return true;
  return p.season.includes(month);
}

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** "Nov–Apr" for display. */
export function seasonLabel(p) {
  if (!p?.season?.length) return 'Year-round';
  return `${MONTH_ABBR[p.season[0] - 1]}–${MONTH_ABBR[p.season[p.season.length - 1] - 1]}`;
}

// ─── Book (shared, deterministic) ────────────────────────────────────────────

function hash01(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 100000) / 100000;
}

/** This window's list price per contract year for a partner. */
export function travelPartnerListFee(partnerId, absWeek) {
  const p = TRAVEL_PARTNER_MAP[partnerId];
  if (!p) return null;
  const window = Math.floor(Math.max(0, absWeek ?? 0) / TP_BOOK_WINDOW_WEEKS);
  const drift = (hash01(`tp|${partnerId}|${window}`) * 2 - 1) * TP_BOOK_DRIFT;
  return Math.round(p.fee * (1 + drift) / 1000) * 1000;
}

export function weeksToNextTravelReprice(absWeek) {
  const w = Math.max(0, absWeek ?? 0);
  return TP_BOOK_WINDOW_WEEKS - (w % TP_BOOK_WINDOW_WEEKS);
}

// ─── Happiness bands, renewal, lift fade ─────────────────────────────────────

export const TP_MOODS = [
  { min: 75, id: 'delighted',  label: 'Delighted',  priceMult: 0.60, tighten: 0, refuses: false },
  { min: 55, id: 'content',    label: 'Content',    priceMult: 0.85, tighten: 0, refuses: false },
  { min: 35, id: 'lukewarm',   label: 'Lukewarm',   priceMult: 1.00, tighten: 0, refuses: false },
  { min: 15, id: 'frustrated', label: 'Frustrated', priceMult: 1.35, tighten: 1, refuses: false },
  { min: -Infinity, id: 'hostile', label: 'Walking out', priceMult: null, tighten: 0, refuses: true },
];

export function travelPartnerMood(h) {
  const v = Number.isFinite(h) ? h : TP_START_HAPPINESS;
  return TP_MOODS.find(m => v >= m.min) ?? TP_MOODS[TP_MOODS.length - 1];
}

/** Share of the lift a partner still gives at this happiness (0–1). */
export function travelLiftScale(h) {
  if (!Number.isFinite(h)) return 1;
  if (h >= TP_LIFT_FULL_AT) return 1;
  if (h <= TP_LIFT_ZERO_AT) return 0;
  return (h - TP_LIFT_ZERO_AT) / (TP_LIFT_FULL_AT - TP_LIFT_ZERO_AT);
}

/**
 * The renewal a partner offers at this happiness, priced from this week's book.
 * { refuses, mood, annualFee, tighten } — tighten is the NEW cumulative count.
 */
export function travelRenewalOffer(contract, absWeek) {
  const mood = travelPartnerMood(contract?.happiness);
  if (!contract || mood.refuses) return { refuses: true, mood };
  const list = travelPartnerListFee(contract.partnerId, absWeek) ?? 0;
  return {
    refuses: false, mood,
    annualFee: Math.round(list * mood.priceMult / 1000) * 1000,
    tighten:   (contract.tighten ?? 0) + mood.tighten,
  };
}

/** The target for a requirement after `tighten` frustrated renewals. */
export function requirementTarget(req, tighten = 0, partner = null) {
  const n = Math.max(0, tighten | 0);
  if (!n) return req.min;
  if (RATE_KINDS.has(req.kind)) return Math.min(RATE_CEILING[req.kind] ?? 100, req.min + 3 * n);
  if (req.kind === 'serveCount') {
    const cap = partner ? travelPartnerAirports(partner).size : Infinity;
    return Math.min(cap, req.min + n);
  }
  return Math.round(req.min * Math.pow(1.15, n));
}

export function contractTargets(contract) {
  const p = TRAVEL_PARTNER_MAP[contract?.partnerId];
  if (!p) return [];
  return p.requirements.map(r => requirementTarget(r, contract.tighten ?? 0, p));
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function hasTravelPartners(partners) {
  return !!partners && Object.keys(partners).length > 0;
}

export function travelContractEndWeek(c) { return (c?.signedWeek ?? 0) + (c?.termWeeks ?? TP_TERM_WEEKS); }
export function travelContractWeeksLeft(c, absWeek) {
  return Math.max(0, travelContractEndWeek(c) - (absWeek ?? 0));
}
export function inTravelRenewalWindow(c, absWeek) {
  const left = travelContractWeeksLeft(c, absWeek);
  return left > 0 && left <= TP_RENEWAL_WINDOW;
}

/**
 * A new contract. The first instalment is due the week it is signed and is
 * charged by that week's tick (so it lands on the P&L, not as a silent cash
 * move). `happiness` defaults to the starting level, or what the partner
 * remembers.
 */
export function makeTravelPartnerContract(partnerId, absWeek, { annualFee, happiness, tighten = 0, grace = true, autoRenew = true } = {}) {
  const p = TRAVEL_PARTNER_MAP[partnerId];
  if (!p) return null;
  return {
    partnerId,
    signedWeek:      absWeek,
    termWeeks:       TP_TERM_WEEKS,
    annualFee:       annualFee ?? travelPartnerListFee(partnerId, absWeek),
    instalmentsPaid: 0,
    tighten,
    happiness:       happiness ?? TP_START_HAPPINESS,
    lowWeeks:        0,
    graceUntil:      grace ? absWeek + TP_GRACE_WEEKS : absWeek,
    autoRenew,
  };
}

/**
 * Can this airline sign this partner now? Shared by the reducer, the server
 * guard and the button. ctx: { partners, memory, absWeek, reputation, cash, worldOn }.
 */
export function canSignTravelPartner(partnerId, ctx = {}) {
  const p = TRAVEL_PARTNER_MAP[partnerId];
  if (!p) return { ok: false, reasons: ['Unknown partner.'] };
  if (!ctx.worldOn) return { ok: false, reasons: ['Travel partnerships are not available in this world.'] };
  const reasons = [];
  if (ctx.partners?.[partnerId]) reasons.push(`You already work with ${p.name}.`);
  const mem = ctx.memory?.[partnerId];
  if (mem?.cooldownUntil != null && (ctx.absWeek ?? 0) < mem.cooldownUntil) {
    reasons.push(`${p.name} won’t work with you again until week ${mem.cooldownUntil}.`);
  }
  if (p.reputationMin != null && (ctx.reputation ?? 0) < p.reputationMin) {
    reasons.push(`${p.name} only signs airlines with a reputation of ${p.reputationMin}+ (you: ${Math.round(ctx.reputation ?? 0)}).`);
  }
  const fee = travelPartnerListFee(partnerId, ctx.absWeek ?? 0);
  if (ctx.cash != null && ctx.cash < fee) reasons.push('Not enough cash for the first year’s fee.');
  return { ok: reasons.length === 0, reasons, fee };
}

/** Happiness a partner starts at when (re)signed. */
export function travelSignHappiness(memory, partnerId) {
  const r = memory?.[partnerId]?.rejoinHappiness;
  return Number.isFinite(r) ? r : TP_START_HAPPINESS;
}

/** Cost to break early: half of the instalment(s) not yet paid. */
export function travelBreakCost(contract) {
  if (!contract) return 0;
  const unpaid = Math.max(0, TP_INSTALMENTS - (contract.instalmentsPaid ?? 0));
  return Math.round(unpaid * (contract.annualFee ?? 0) * TP_BREAK_FRACTION);
}

// ─── Lift: what a route gets ─────────────────────────────────────────────────

/**
 * Per-airport partner contributions for a set of stops, this month:
 *   { [code]: [{ partnerId, segment, lift }] } — only covered stops appear.
 * Lift is already scaled by the partner's happiness. Null when nothing applies.
 */
export function travelPartnerAt(partners, stops, month) {
  if (!hasTravelPartners(partners) || !stops?.length) return null;
  let out = null;
  for (const c of Object.values(partners)) {
    const p = TRAVEL_PARTNER_MAP[c.partnerId];
    if (!p || !travelPartnerInSeason(p, month)) continue;
    const lift = p.lift * travelLiftScale(c.happiness);
    if (!(lift > 0)) continue;
    const segment = TP_TYPES[p.type].segment;
    for (const code of new Set(stops)) {
      if (!travelPartnerCovers(p, code)) continue;
      out = out ?? {};
      (out[code] = out[code] ?? []).push({ partnerId: p.id, segment, lift });
    }
  }
  return out;
}

/**
 * The two appeal multipliers for a pair, from a travelPartnerAt map. Each
 * partner counts once however many of the pair's ends it covers; lifts add
 * within a segment and the total is capped.
 */
export function travelAppealForPair(at, a, b) {
  if (!at) return { leisure: 1, business: 1 };
  const seen = new Map();
  for (const code of [a, b]) for (const e of at[code] ?? []) seen.set(e.partnerId, e);
  let l = 0, bz = 0;
  for (const e of seen.values()) { if (e.segment === 'business') bz += e.lift; else l += e.lift; }
  return {
    leisure:  +Math.min(TP_APPEAL_CAP, 1 + l).toFixed(4),
    business: +Math.min(TP_APPEAL_CAP, 1 + bz).toFixed(4),
  };
}

/**
 * The offer fields for a pair — spread into a route or an offer. Returns {}
 * when no partner lifts the pair, so a partner-less airline's route objects and
 * offers stay byte-identical to before.
 */
export function travelPartnerFieldsFor(partners, origin, destination, month) {
  const at = travelPartnerAt(partners, [origin, destination], month);
  if (!at) return {};
  const { leisure, business } = travelAppealForPair(at, origin, destination);
  const out = {};
  if (leisure !== 1) out.travelLeisureAppeal = leisure;
  if (business !== 1) out.travelBusinessAppeal = business;
  return out;
}

// ─── Measurement ─────────────────────────────────────────────────────────────

/**
 * What the airline delivered this week against every requirement of every
 * partner. Pure over the tick's results.
 *
 * ctx:
 *   routes        the routes flown (season-adjusted), with stops via stopsOf
 *   routeResults  weeklyTick's per-route results (segmentPax on single-leg
 *                 results in partnership worlds; segments[] on tag results)
 *   fleet         to read business seats
 *   onTimeRate    0–1, the airline's rate this week
 *   month         game month (season gate)
 *   stopsOf       routeStops
 *
 * Returns { [partnerId]: { inForce, actuals: number[], attain: number[], A } }.
 */
export function measureTravelPartners(partnerIds, ctx = {}) {
  const ids = [...new Set(partnerIds ?? [])].filter(id => TRAVEL_PARTNER_MAP[id]);
  if (!ids.length) return {};
  const { routes = [], routeResults = [], fleet = [], onTimeRate = 1, month = 1 } = ctx;
  const stopsOf = typeof ctx.stopsOf === 'function' ? ctx.stopsOf : (r) => [r.origin, r.destination];
  const resultById = new Map(routeResults.map(rr => [rr.routeId, rr]));
  const bizSeatsOf = new Map(fleet.map(a => [a.id, (a.config?.businessClass ?? 0) + (a.config?.firstClass ?? 0)]));

  // Arrivals by airport and segment, one-way pax per direction: a pair's
  // one-way figure arrives at EACH end once a week.
  const arrive = { leisure: {}, business: {} };
  const add = (seg, code, n) => { if (n > 0) arrive[seg][code] = (arrive[seg][code] ?? 0) + n; };
  const flown = [];
  for (const r of routes) {
    if (!r || r.seasonState === 'dormant' || !(Number(r.weeklyFrequency) > 0)) continue;
    const rr = resultById.get(r.id);
    const stops = stopsOf(r).filter(Boolean);
    flown.push({ r, rr, stops });
    if (!rr) continue;
    if (Array.isArray(rr.segments) && rr.segments.length) {
      for (const s of rr.segments) {
        for (const code of [s.from, s.to]) { add('leisure', code, s.ecoPax ?? 0); add('business', code, s.bizPax ?? 0); }
      }
    } else if (rr.segmentPax) {
      for (const code of [r.origin, r.destination]) {
        add('leisure', code, rr.segmentPax.leisure ?? 0);
        add('business', code, rr.segmentPax.business ?? 0);
      }
    }
  }

  const out = {};
  for (const id of ids) {
    const p = TRAVEL_PARTNER_MAP[id];
    const covered = travelPartnerAirports(p);
    const inForce = travelPartnerInSeason(p, month);
    const touching = flown.filter(f => f.stops.some(c => covered.has(c)));
    const actuals = p.requirements.map(req => {
      switch (req.kind) {
        case 'segmentPaxTo': {
          let n = 0;
          for (const [code, v] of Object.entries(arrive[req.segment] ?? {})) if (covered.has(code)) n += v;
          return Math.round(n);
        }
        case 'serveCount': {
          const served = new Set();
          for (const f of flown) for (const c of f.stops) if (covered.has(c)) served.add(c);
          return served.size;
        }
        case 'departures': {
          let n = 0;
          for (const f of flown) {
            const freq = Number(f.r.weeklyFrequency) || 0;
            for (const c of new Set(f.stops)) if (covered.has(c)) n += freq;
          }
          return n;
        }
        case 'onTime': return Math.round((onTimeRate ?? 0) * 1000) / 10;
        case 'routeQuality': {
          let num = 0, den = 0;
          for (const f of touching) {
            const q = f.rr?.qualityScore;
            if (q == null) continue;
            const w = Math.max(1, f.rr?.passengers ?? 0);
            num += q * w; den += w;
          }
          return den > 0 ? Math.round(num / den * 10) / 10 : 0;
        }
        case 'premiumCabin': {
          if (!touching.length) return 0;
          const withJ = touching.filter(f => (bizSeatsOf.get(f.r.aircraftId) ?? 0) > 0).length;
          return Math.round(withJ / touching.length * 1000) / 10;
        }
        default: return 0;
      }
    });
    out[id] = { inForce, actuals };
  }
  return out;
}

/** Attainment of one requirement, 0–1.25. */
export function requirementAttainment(req, actual, target) {
  const a = Number(actual) || 0;
  const t = Number(target) || 0;
  if (RATE_KINDS.has(req.kind)) {
    if (a >= t) return Math.min(1.25, 1 + (a - t) / TP_RATE_BAND * 0.25);
    return Math.max(0, 1 - (t - a) / TP_RATE_BAND);
  }
  if (t <= 0) return 1.25;
  return Math.max(0, Math.min(1.25, a / t));
}

/** Combined attainment: an average that can't hide one big miss. */
export function combinedAttainment(attain) {
  if (!attain?.length) return null;
  const min = Math.min(...attain);
  const mean = attain.reduce((s, v) => s + v, 0) / attain.length;
  return 0.5 * min + 0.5 * mean;
}

/** Happiness a partner heads toward at this combined attainment. */
export function targetHappiness(A) {
  if (A == null) return null;
  if (A <= 0.4) return 0;
  if (A <= 1.0) return (A - 0.4) / 0.6 * 80;
  return Math.min(100, 80 + (A - 1.0) / 0.25 * 20);
}

/**
 * Score a contract against measured actuals: per-requirement targets and
 * attainment, combined A and target happiness T (null when out of season).
 */
export function scoreTravelContract(contract, measured) {
  const p = TRAVEL_PARTNER_MAP[contract?.partnerId];
  if (!p || !measured) return null;
  const targets = contractTargets(contract);
  const attain = p.requirements.map((req, i) => requirementAttainment(req, measured.actuals[i], targets[i]));
  const A = measured.inForce ? combinedAttainment(attain) : null;
  return {
    inForce: measured.inForce,
    actuals: measured.actuals,
    targets,
    attain: attain.map(v => +v.toFixed(3)),
    A: A == null ? null : +A.toFixed(3),
    T: A == null ? null : +targetHappiness(A).toFixed(1),
  };
}

// ─── The weekly cycle ────────────────────────────────────────────────────────

/**
 * Before the week is simulated: contracts that reached their end renew (a
 * queued renewal, else auto-renew if happy enough and the cash is there), lapse,
 * or — when the partner refuses (happiness < 15) — are LOST for 5 years. Pure.
 *
 * Returns { partners, memory, events }; events:
 *   { type: 'renewed', partnerId, annualFee, auto }
 *   { type: 'lapsed',  partnerId, reason }
 *   { type: 'lost',    partnerId, reason: 'refused', cooldownUntil }
 */
export function rolloverTravelPartners(partners = {}, memory = {}, absWeek = 0, { cash = Infinity } = {}) {
  const outP = {};
  const outM = { ...(memory ?? {}) };
  const events = [];
  let cashLeft = cash;
  for (const [id, c] of Object.entries(partners ?? {})) {
    if (travelContractWeeksLeft(c, absWeek) > 0) { outP[id] = c; continue; }
    const end = travelContractEndWeek(c);
    const h = c.happiness ?? TP_START_HAPPINESS;
    const offer = travelRenewalOffer(c, absWeek);
    const queued = c.renewal ?? null;
    if (offer.refuses && !queued) {
      const cooldownUntil = absWeek + TP_LOST_COOLDOWN_WEEKS;
      outM[id] = { cooldownUntil, rejoinHappiness: TP_REJOIN_HAPPINESS };
      events.push({ type: 'lost', partnerId: id, reason: 'refused', cooldownUntil });
      continue;
    }
    const plan = queued
      ? { annualFee: queued.annualFee, tighten: queued.tighten, auto: false }
      : (c.autoRenew !== false && h >= TP_AUTORENEW_MIN_HAPPINESS
          ? { annualFee: offer.annualFee, tighten: offer.tighten, auto: true }
          : null);
    if (plan && cashLeft >= plan.annualFee) {
      cashLeft -= plan.annualFee;
      const { renewal: _r, ...rest } = c;
      outP[id] = {
        ...rest,
        signedWeek: end, termWeeks: TP_TERM_WEEKS,
        annualFee: plan.annualFee, instalmentsPaid: 0,
        tighten: plan.tighten, lowWeeks: 0, graceUntil: end,
      };
      events.push({ type: 'renewed', partnerId: id, annualFee: plan.annualFee, auto: plan.auto });
      continue;
    }
    outM[id] = { ...(outM[id] ?? {}), rejoinHappiness: Math.min(TP_START_HAPPINESS, Math.round(h)) };
    delete outM[id].cooldownUntil;
    events.push({ type: 'lapsed', partnerId: id,
      reason: plan ? 'cash' : (c.autoRenew === false ? 'not-renewed' : 'unhappy') });
  }
  return { partners: outP, memory: outM, events };
}

/** Instalments due this week: [{ partnerId, amount }]. */
export function dueTravelInstalments(partners = {}, absWeek = 0) {
  const out = [];
  for (const [id, c] of Object.entries(partners ?? {})) {
    const paid = c.instalmentsPaid ?? 0;
    if (paid >= TP_INSTALMENTS) continue;
    if (absWeek >= (c.signedWeek ?? 0) + paid * TP_INSTALMENT_WEEKS) out.push({ partnerId: id, amount: c.annualFee ?? 0 });
  }
  return out;
}

/**
 * After the week is simulated: score every partner, move happiness, count low
 * weeks, and walk out the ones that have had enough. Marks this week's
 * instalments paid. Pure.
 *
 * Returns { partners, memory, events, repHit, scores }; events:
 *   { type: 'lost', partnerId, reason: 'walkout', cooldownUntil }
 *   { type: 'frustrated', partnerId, worst }      crossed below 35 this week
 *   { type: 'expiring', partnerId, weeksLeft }    entered the renewal window
 */
export function settleTravelPartners(partners = {}, memory = {}, measured = {}, absWeek = 0, paidIds = []) {
  const outP = {};
  const outM = { ...(memory ?? {}) };
  const events = [];
  const scores = {};
  let repHit = 0;
  const paid = new Set(paidIds);
  for (const [id, c0] of Object.entries(partners ?? {})) {
    const p = TRAVEL_PARTNER_MAP[id];
    if (!p) continue;
    const c = paid.has(id) ? { ...c0, instalmentsPaid: (c0.instalmentsPaid ?? 0) + 1 } : c0;
    const score = scoreTravelContract(c, measured[id]);
    scores[id] = score;
    const h0 = c.happiness ?? TP_START_HAPPINESS;
    let h = h0;
    if (score?.T != null) {
      h = h0 + TP_ADAPT_RATE * (score.T - h0);
      if (absWeek < (c.graceUntil ?? 0)) h = Math.max(h0, h);
      h = Math.round(Math.max(0, Math.min(100, h)) * 10) / 10;
    }
    const inGrace = absWeek < (c.graceUntil ?? 0);
    const lowWeeks = (!inGrace && h < TP_WALKOUT_LEVEL) ? (c.lowWeeks ?? 0) + 1 : 0;
    if (lowWeeks >= TP_WALKOUT_WEEKS) {
      const cooldownUntil = absWeek + TP_LOST_COOLDOWN_WEEKS;
      outM[id] = { cooldownUntil, rejoinHappiness: TP_REJOIN_HAPPINESS };
      repHit += TP_REP_WALKOUT_PER_PROM * (p.prominence ?? 1);
      events.push({ type: 'lost', partnerId: id, reason: 'walkout', cooldownUntil });
      continue;
    }
    if (h0 >= 35 && h < 35 && score) {
      let worst = 0;
      score.attain.forEach((v, i) => { if (v < score.attain[worst]) worst = i; });
      events.push({ type: 'frustrated', partnerId: id, worst,
        actual: score.actuals[worst], target: score.targets[worst] });
    }
    if (travelContractWeeksLeft(c, absWeek + 1) === TP_RENEWAL_WINDOW) {
      events.push({ type: 'expiring', partnerId: id, weeksLeft: TP_RENEWAL_WINDOW });
    }
    outP[id] = { ...c, happiness: h, lowWeeks };
  }
  return { partners: outP, memory: outM, events, repHit, scores };
}

// ─── Reputation ──────────────────────────────────────────────────────────────

/**
 * The Partners term in calcReputation: delighted partners add a little, sour
 * ones subtract, weighted by prominence, clamped to [−8, +2]. 0 with no
 * partners, so every existing reputation figure is unchanged.
 */
export function travelPartnerReputation(partners) {
  if (!hasTravelPartners(partners)) return 0;
  let s = 0;
  for (const c of Object.values(partners)) {
    const p = TRAVEL_PARTNER_MAP[c.partnerId];
    if (!p) continue;
    const h = c.happiness ?? TP_START_HAPPINESS;
    const g = h >= 75 ? 0.25 : (h >= 35 ? 0 : -(35 - h) / 35);
    s += (p.prominence ?? 1) * g;
  }
  return Math.round(Math.max(TP_REP_MIN, Math.min(TP_REP_MAX, s)) * 10) / 10;
}

/** Memory entries whose cooldown has ended and that say nothing else, dropped. */
export function pruneTravelPartnerMemory(memory, absWeek) {
  if (!memory) return memory;
  const out = {};
  for (const [id, m] of Object.entries(memory)) {
    if (m?.cooldownUntil != null && absWeek >= m.cooldownUntil) {
      out[id] = { rejoinHappiness: m.rejoinHappiness ?? TP_REJOIN_HAPPINESS };
    } else out[id] = m;
  }
  return out;
}
