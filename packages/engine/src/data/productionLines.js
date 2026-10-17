// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION LINES — one shared factory line per aircraft family, per world.
//
// Design: claude/aircraft-production-lines.md (Discord: VodkaOnFire, 2026-10-16).
//
// Classic worlds give every airline a PRIVATE queue per type (data/delivery.js):
// rivals never affect your deliveries, and parallel variants dodge the stagger.
// Production-line worlds (state.productionLinesWorld, fixed at world creation)
// replace that with:
//
//   • one line per FAMILY (737NG, A320neo, 777 …), shared by every airline in
//     the world, building a fixed number of frames a week (by size class);
//   • one airline's deliveries off a line are spaced by the class gap (1–5
//     weeks: no four A380s in a month), owned + leased together;
//   • the earliest slots cost extra — +25% at now + lead, falling to list at
//     the standard week (now + 2 × lead, today's first-frame wait);
//   • cancelling forfeits more the closer the slot (5 / 10 / 20 / 30%);
//   • era worlds: types are ANNOUNCED two years before entry into service and
//     launch customers (strict terms) may order during the first 26 weeks.
//
// THE LEDGER IS THE ORDER BOOKS. There is no separate booking table: a slot is
// taken exactly when some ACTIVE airline holds a pending order on that line for
// that week. Cancelling releases it; a bankrupt airline's orders stop counting
// the moment it stops being ACTIVE. The server injects OTHER airlines' bookings
// as state.lineBook (rebuilt on every read, stripped before persistence) and
// re-checks them under a world lock inside the decision transaction, so two
// airlines can never both take the last slot of a week.
//
// Leaf module (aircraft.js, delivery.js, fuel.js only), so it can be copied into
// Tailwinds unchanged when the solo port happens.
// ─────────────────────────────────────────────────────────────────────────────

import { AIRCRAFT_TYPES, getAircraftType, orderDiscount, aircraftAvailability } from './aircraft.js';
import { deliveryClass, deliveryLead } from './delivery.js';
import { absoluteWeek } from '../utils/fuel.js';

// ── Lines ────────────────────────────────────────────────────────────────────
// Production generations, not maintenance families (data/families.js groups
// every 737 from the -200 to the MAX for tooling; Renton built them as three
// separate programmes). Factory freighters sit on their parent line; the true
// conversions (BCF / P2F / SF and the -300F/-400F/-73F conversions) come off a
// small conversion line of their own.
export const PRODUCTION_LINES = {
  concorde:        { name: 'Concorde',                    types: ['concorde'] },
  a220:            { name: 'Airbus A220',                 types: ['a220100', 'a220'] },
  a320ceo:         { name: 'Airbus A320ceo family',       types: ['a320ceo', 'a318', 'a319ceo', 'a321ceo'] },
  a320neo:         { name: 'Airbus A320neo family',       types: ['a320neo', 'a319neo', 'a321neo', 'a321xlr'] },
  a300:            { name: 'Airbus A300 / A310',          types: ['a300b4', 'a310200', 'a310300', 'a300600r', 'a300600f'] },
  a330:            { name: 'Airbus A330 / A340',          types: ['a330200', 'a330300', 'a340300', 'a340600', 'a330200f'] },
  a330neo:         { name: 'Airbus A330neo',              types: ['a330neo', 'a330800'] },
  a350:            { name: 'Airbus A350',                 types: ['a350900', 'a350900ulr', 'a3501000', 'a3501000ulr', 'a350f'] },
  a380:            { name: 'Airbus A380',                 types: ['a380'] },
  b707:            { name: 'Boeing 707 / 720',            types: ['b707120', 'b707320', 'b720b'] },
  b717:            { name: 'Boeing 717',                  types: ['b717'] },
  b727:            { name: 'Boeing 727',                  types: ['b727100', 'b727200', 'b727200f'] },
  b737orig:        { name: 'Boeing 737-200',              types: ['b737200'] },
  b737classic:     { name: 'Boeing 737 Classic',          types: ['b737300', 'b737400', 'b737500'] },
  b737ng:          { name: 'Boeing 737NG',                types: ['b737800', 'b737700', 'b737900er'] },
  b737max:         { name: 'Boeing 737 MAX',              types: ['b737max8', 'b737max7', 'b737max8200', 'b737max9', 'b737max10'] },
  b747:            { name: 'Boeing 747',                  types: ['b747400', 'b747100', 'b747200', 'b747sp', 'b747300', 'b747400d', 'b747400f'] },
  b7478:           { name: 'Boeing 747-8',                types: ['b7478i', 'b7478f'] },
  b757:            { name: 'Boeing 757',                  types: ['b757200', 'b757300', 'b757200pf'] },
  b767:            { name: 'Boeing 767',                  types: ['b767300', 'b767200er', 'b767400er', 'b767300f'] },
  b777:            { name: 'Boeing 777',                  types: ['b777300er', 'b777200er', 'b777200lr', 'b777f'] },
  b777x:           { name: 'Boeing 777X',                 types: ['b7779x', 'b7778x', 'b7778f'] },
  b787:            { name: 'Boeing 787',                  types: ['b7879', 'b7878', 'b787x10'] },
  crj:             { name: 'Bombardier CRJ',              types: ['crj900', 'crj200', 'crj700', 'crj1000'] },
  bae146:          { name: 'BAe 146 / Avro RJ',           types: ['bae146200', 'avrorj85'] },
  erj:             { name: 'Embraer ERJ',                 types: ['erj145', 'erj135'] },
  ejet:            { name: 'Embraer E-Jet',               types: ['e190', 'erj170', 'e175', 'e195'] },
  ejet_e2:         { name: 'Embraer E-Jet E2',            types: ['e195e2', 'e175e2', 'e190e2'] },
  embraer_tp:      { name: 'Embraer Bandeirante / Brasilia', types: ['emb120', 'emb110'] },
  atr:             { name: 'ATR 42 / 72',                 types: ['atr72', 'atr42', 'atr72f'] },
  dash8:           { name: 'De Havilland Dash 8',         types: ['q400', 'dhc8100', 'dhc8200', 'dhc8300'] },
  dash7:           { name: 'De Havilland Dash 7',         types: ['dash7'] },
  dhc6:            { name: 'Twin Otter',                  types: ['dhc6'] },
  saab340:         { name: 'Saab 340',                    types: ['saab340', 'saab340a'] },
  saab2000:        { name: 'Saab 2000',                   types: ['saab2000'] },
  jetstream:       { name: 'BAe Jetstream',               types: ['js41', 'js31'] },
  bac111:          { name: 'BAC One-Eleven',              types: ['bac111'] },
  fokker100:       { name: 'Fokker 70 / 100',             types: ['fokker100', 'fokker70'] },
  f28:             { name: 'Fokker F28',                  types: ['f28'] },
  f27:             { name: 'Fokker F27',                  types: ['f27'] },
  do328:           { name: 'Dornier 328',                 types: ['do328', 'do328jet'] },
  do228:           { name: 'Dornier 228',                 types: ['do228'] },
  dc9:             { name: 'Douglas DC-9',                types: ['dc930', 'dc910', 'dc950'] },
  md80:            { name: 'McDonnell Douglas MD-80 / MD-90', types: ['md80', 'md90'] },
  dc10:            { name: 'Douglas DC-10',               types: ['dc1030', 'dc1030f'] },
  md11:            { name: 'McDonnell Douglas MD-11',     types: ['md11', 'md11f'] },
  dc8:             { name: 'Douglas DC-8',                types: ['dc863', 'dc830'] },
  dc3:             { name: 'Douglas DC-3 / C-47',         types: ['dc3', 'c47'] },
  dc4:             { name: 'Douglas DC-4',                types: ['dc4'] },
  dc6:             { name: 'Douglas DC-6 / DC-7',         types: ['dc6b', 'dc7c'] },
  connie:          { name: 'Lockheed Constellation',      types: ['l1049', 'l749', 'l1049g', 'l1649'] },
  l188:            { name: 'Lockheed Electra',            types: ['l188'] },
  l1011:           { name: 'Lockheed TriStar',            types: ['l1011'] },
  convairliner:    { name: 'Convair-Liner',               types: ['cv240', 'cv440', 'cv580'] },
  cv990:           { name: 'Convair 990',                 types: ['cv990'] },
  northstar:       { name: 'Canadair North Star',         types: ['northstar'] },
  b377:            { name: 'Boeing Stratocruiser',        types: ['b377'] },
  m404:            { name: 'Martin 4-0-4',                types: ['m404'] },
  c46:             { name: 'Curtiss C-46',                types: ['c46'] },
  comet:           { name: 'de Havilland Comet',          types: ['comet4', 'comet1'] },
  viscount:        { name: 'Vickers Viscount',            types: ['viscount800', 'viscount700'] },
  vanguard:        { name: 'Vickers Vanguard',            types: ['vanguard'] },
  vc10:            { name: 'Vickers VC10',                types: ['vc10'] },
  britannia:       { name: 'Bristol Britannia',           types: ['britannia'] },
  caravelle:       { name: 'Sud Aviation Caravelle',      types: ['caravelle'] },
  trident:         { name: 'Hawker Siddeley Trident',     types: ['trident3b'] },
  hs748:           { name: 'Hawker Siddeley 748',         types: ['hs748'] },
  il14:            { name: 'Ilyushin Il-14',              types: ['il14'] },
  il18:            { name: 'Ilyushin Il-18',              types: ['il18'] },
  il62:            { name: 'Ilyushin Il-62',              types: ['il62m'] },
  il86:            { name: 'Ilyushin Il-86',              types: ['il86'] },
  il96:            { name: 'Ilyushin Il-96',              types: ['il96300'] },
  tu104:           { name: 'Tupolev Tu-104',              types: ['tu104'] },
  tu134:           { name: 'Tupolev Tu-134',              types: ['tu134'] },
  tu154:           { name: 'Tupolev Tu-154',              types: ['tu154m'] },
  tu204:           { name: 'Tupolev Tu-204',              types: ['tu204'] },
  yak40:           { name: 'Yakovlev Yak-40',             types: ['yak40'] },
  yak42:           { name: 'Yakovlev Yak-42',             types: ['yak42'] },
  an12:            { name: 'Antonov An-12',               types: ['an12'] },
  an24:            { name: 'Antonov An-24',               types: ['an24'] },
  an124:           { name: 'Antonov An-124 / An-225',     types: ['an124', 'an225'] },
  an148:           { name: 'Antonov An-148',              types: ['an148'] },
  ssj100:          { name: 'Sukhoi Superjet',             types: ['ssj100', 'sj100new'] },
  mc21:            { name: 'Irkut MC-21',                 types: ['mc21300', 'mc21310'] },
  arj21:           { name: 'COMAC ARJ21',                 types: ['arj21'] },
  c919:            { name: 'COMAC C919',                  types: ['c919'] },
  c929:            { name: 'COMAC C929',                  types: ['c929'] },
  spacejet:        { name: 'Mitsubishi SpaceJet',         types: ['spacejet'] },
  ma60:            { name: 'Xian MA60 / MA600',           types: ['ma60', 'ma600'] },
  cn235:           { name: 'CASA CN-235',                 types: ['casacn235'] },
  l410:            { name: 'Let L-410',                   types: ['l410'] },
  b1900:           { name: 'Beechcraft 1900',             types: ['b1900d'] },
  short360:        { name: 'Short 360',                   types: ['short360'] },
  islander:        { name: 'Britten-Norman Islander',     types: ['bn2islander'] },
  caravan:         { name: 'Cessna Caravan',              types: ['c208b'] },
  skycourier:      { name: 'Cessna SkyCourier',           types: ['c408'] },
  pc12:            { name: 'Pilatus PC-12',               types: ['pc12'] },
  // Conversion lines: freighter conversions of passenger frames.
  conv_b737ng:     { name: '737NG freighter conversions',  types: ['b737800bcf'], conversion: true },
  conv_b737classic:{ name: '737 Classic freighter conversions', types: ['b737400f', 'b737300f'], conversion: true },
  conv_a320:       { name: 'A321 freighter conversions',   types: ['a321p2f'], conversion: true },
  conv_b767:       { name: '767 freighter conversions',    types: ['b767200sf'], conversion: true },
  conv_dc8:        { name: 'DC-8 freighter conversions',   types: ['dc873f'], conversion: true },
  conv_ejet:       { name: 'E-Jet freighter conversions',  types: ['e190f'], conversion: true },
};

const LINE_OF_TYPE = (() => {
  const m = {};
  for (const [id, line] of Object.entries(PRODUCTION_LINES)) {
    for (const t of line.types) m[t] = id;
  }
  return m;
})();

/** Production line id for a type (or type id). Unmapped → a line of its own. */
export function lineOf(typeOrId) {
  const id = typeof typeOrId === 'string' ? typeOrId : typeOrId?.id;
  if (!id) return null;
  return LINE_OF_TYPE[id] ?? `type_${id}`;
}

/** { id, name, types, conversion, cls } for a line id. */
export function lineInfo(lineId) {
  const def = PRODUCTION_LINES[lineId];
  if (def) {
    const lead = getAircraftType(def.types[0]);
    return { id: lineId, ...def, conversion: def.conversion === true,
             cls: def.conversion ? 'Conversion' : deliveryClass(lead) };
  }
  const typeId = String(lineId ?? '').replace(/^type_/, '');
  const t = getAircraftType(typeId);
  return { id: lineId, name: t?.name ?? typeId, types: [typeId], conversion: false, cls: deliveryClass(t) };
}

/** Every type id with no explicit line (should be empty — asserted in tests). */
export function unmappedTypes() {
  return AIRCRAFT_TYPES.map(t => t.id).filter(id => !LINE_OF_TYPE[id]);
}

// ── Capacity ─────────────────────────────────────────────────────────────────
// Frames a week. Calibrated 2026-10-16 against every live world's order books:
// the most airlines ever waiting on one family at once was 8 (A350, Lunar
// Gateway, 74 airlines); 7 on A320neo, 6 on 787, 5 on 777/777X; nearly every
// other line 1–4. With one slot per airline per week, capacity only binds when
// that many DIFFERENT airlines want the same line in the same week.
export const LINE_CAPACITY = {
  'Turboprop':    { base: 10, floor: 4, ceiling: 16 },
  'Regional Jet': { base: 8,  floor: 3, ceiling: 12 },
  'Narrow Body':  { base: 8,  floor: 3, ceiling: 12 },
  'Wide Body':    { base: 5,  floor: 2, ceiling: 8 },
  'Supersonic':   { base: 3,  floor: 1, ceiling: 5 },
  'Double Deck':  { base: 3,  floor: 1, ceiling: 5 },
  'Outsize':      { base: 3,  floor: 1, ceiling: 5 },
  'Conversion':   { base: 2,  floor: 1, ceiling: 3 },
};

export const SCALE_REF_PLAYERS = 50;
export const SCALE_MIN = 0.6;
export const SCALE_MAX = 1.5;
/** A line ramps up once its booked backlog exceeds this many weeks of output … */
export const RAMP_START_WEEKS = 26;
/** … gaining one frame a week per further block of this many weeks. */
export const RAMP_STEP_WEEKS = 13;

/** World-size multiplier on every line's base rate, from the world's player cap. */
export function capacityScale(maxPlayers) {
  const n = Number(maxPlayers);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n / SCALE_REF_PLAYERS));
}

/**
 * Frames a week this line builds. Scaled by world size, then ramped by the
 * manufacturer when the backlog runs long: past RAMP_START_WEEKS of booked
 * output, +1 a week per RAMP_STEP_WEEKS more, up to the (scaled) ceiling.
 * Stateless on purpose — derived from the order books every time, so there is
 * no rate history to persist, migrate or drift.
 */
export function lineCapacity(lineId, { scale = 1, backlogFrames = 0, rates = null } = {}) {
  const cls = lineInfo(lineId).cls;
  const spec = LINE_CAPACITY[cls] ?? LINE_CAPACITY['Narrow Body'];
  const custom = customLineRate(rates, lineId, cls);
  // A rate the world's creator typed is the rate: no player scale on top. It
  // keeps the class's ramp headroom (ceiling ÷ base), so a long backlog still
  // speeds the line up in proportion.
  const base = custom ?? Math.max(spec.floor, Math.round(spec.base * scale));
  const ceiling = custom != null
    ? Math.max(base, Math.round(custom * spec.ceiling / spec.base))
    : Math.max(base, Math.round(spec.ceiling * scale));
  const backlogWeeks = Math.max(0, backlogFrames) / base;
  const extra = backlogWeeks > RAMP_START_WEEKS
    ? Math.floor((backlogWeeks - RAMP_START_WEEKS) / RAMP_STEP_WEEKS) + 1
    : 0;
  return Math.min(ceiling, base + extra);
}

// ── Per-world rates ──────────────────────────────────────────────────────────
// Whoever creates a world may set the frames a week for a whole size class and,
// below that, for any single line. Stored in tickConfig.productionLineRates as
// { classes: { 'Wide Body': 3 }, lines: { a380: 1 } } — only what was set — and
// baked into each airline at join (state.productionLineRates), carried in the
// rival view (lineBook.rates) and the server's race check. Line beats class;
// anything unset keeps the default × the world's player scale.
export const MIN_LINE_RATE = 1;
export const MAX_LINE_RATE = 50;
/** Size classes in the order the create-world form lists them. */
export const RATE_CLASSES = ['Turboprop', 'Regional Jet', 'Narrow Body', 'Wide Body', 'Double Deck', 'Supersonic', 'Outsize', 'Conversion'];

function customLineRate(rates, lineId, cls) {
  const ok = (v) => (Number.isInteger(v) && v >= MIN_LINE_RATE && v <= MAX_LINE_RATE ? v : null);
  return ok(rates?.lines?.[lineId]) ?? ok(rates?.classes?.[cls]) ?? null;
}

/** The world's rates from wherever this state carries them (null = all defaults). */
export function ratesFor(state) {
  return state?.lineBook?.rates ?? state?.productionLineRates ?? null;
}

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');

/**
 * What's wrong with a rates object from the create-world form, in words, or null.
 * Blanks are fine (they mean "default").
 */
export function lineRatesProblem(rates) {
  if (rates == null) return null;
  if (typeof rates !== 'object' || Array.isArray(rates)) return 'Production rates must be an object of classes and lines';
  const check = (label, v) => {
    if (blank(v)) return null;
    const n = Number(v);
    if (!Number.isInteger(n)) return `${label}: the rate must be a whole number of frames a week`;
    if (n < MIN_LINE_RATE || n > MAX_LINE_RATE) return `${label}: the rate must be between ${MIN_LINE_RATE} and ${MAX_LINE_RATE} frames a week`;
    return null;
  };
  for (const key of Object.keys(rates)) {
    if (key !== 'classes' && key !== 'lines') return `Unknown production-rate group "${key}"`;
    const group = rates[key];
    if (group != null && (typeof group !== 'object' || Array.isArray(group))) return `Production rates "${key}" must be an object`;
  }
  for (const [cls, v] of Object.entries(rates.classes ?? {})) {
    if (!RATE_CLASSES.includes(cls)) return `Unknown aircraft class "${cls}"`;
    const p = check(cls, v); if (p) return p;
  }
  for (const [id, v] of Object.entries(rates.lines ?? {})) {
    if (!PRODUCTION_LINES[id]) return `Unknown production line "${id}"`;
    const p = check(PRODUCTION_LINES[id].name, v); if (p) return p;
  }
  return null;
}

/** Valid rates with blanks dropped and numbers made numbers; null when nothing is set. */
export function normalizeLineRates(rates) {
  if (rates == null || typeof rates !== 'object') return null;
  const out = {};
  for (const key of ['classes', 'lines']) {
    for (const [k, v] of Object.entries(rates[key] ?? {})) {
      if (blank(v)) continue;
      const n = Number(v);
      if (Number.isInteger(n) && n >= MIN_LINE_RATE && n <= MAX_LINE_RATE) (out[key] ??= {})[k] = n;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * What a blank box means, for the form's placeholders: each class's default at
 * this scale, and each line's rate given the classes typed so far.
 */
export function lineRateDefaults({ scale = 1, rates = null } = {}) {
  const classes = {};
  for (const cls of RATE_CLASSES) {
    const spec = LINE_CAPACITY[cls];
    classes[cls] = Math.max(spec.floor, Math.round(spec.base * scale));
  }
  const classOnly = rates?.classes ? { classes: normalizeLineRates({ classes: rates.classes })?.classes } : null;
  const lines = {};
  for (const id of Object.keys(PRODUCTION_LINES)) lines[id] = lineCapacity(id, { scale, rates: classOnly });
  return { classes, lines };
}

/** Lines grouped by class, for the form: [{ cls, lines: [{ id, name }] }]. */
export function linesByClass() {
  const groups = new Map(RATE_CLASSES.map((c) => [c, []]));
  for (const id of Object.keys(PRODUCTION_LINES)) {
    const info = lineInfo(id);
    (groups.get(info.cls) ?? groups.set(info.cls, []).get(info.cls)).push({ id, name: info.name });
  }
  return [...groups].filter(([, l]) => l.length).map(([cls, l]) => ({ cls, lines: l.sort((a, b) => a.name.localeCompare(b.name)) }));
}

// ── Bookings ────────────────────────────────────────────────────────────────
const isLineOrder = (o) => o && !o.used && o.typeId && Number.isFinite(o.deliverAbsWeek);

/**
 * Bookings per line per week from a set of airline states (server side: every
 * OTHER active airline). { [lineId]: { [absWeek]: frames } }, future weeks only.
 */
export function bookingsFromStates(states, fromAbsWeek = 0) {
  const out = {};
  for (const s of states ?? []) {
    for (const o of s?.pendingOrders ?? []) {
      if (!isLineOrder(o) || o.deliverAbsWeek < fromAbsWeek) continue;
      const line = o.lineId ?? lineOf(o.typeId);
      const byWeek = (out[line] ??= {});
      byWeek[o.deliverAbsWeek] = (byWeek[o.deliverAbsWeek] ?? 0) + 1;
    }
  }
  return out;
}

/** Sum several { [lineId]: { [week]: n } } booking maps. */
export function sumBookings(list) {
  const out = {};
  for (const b of list ?? []) {
    for (const [line, weeks] of Object.entries(b ?? {})) {
      const o = (out[line] ??= {});
      for (const [w, n] of Object.entries(weeks)) o[w] = (o[w] ?? 0) + n;
    }
  }
  return out;
}

/** total − mine, dropping zeroes (the "everyone but me" view). */
export function minusBookings(total, mine) {
  const out = {};
  for (const [line, weeks] of Object.entries(total ?? {})) {
    for (const [w, n] of Object.entries(weeks)) {
      const left = n - (mine?.[line]?.[w] ?? 0);
      if (left > 0) (out[line] ??= {})[w] = left;
    }
  }
  return out;
}

/** Map<absWeek, frames> on one line: injected rival bookings + this airline's own. */
export function lineBookings(state, lineId, fromAbsWeek = 0) {
  const m = new Map();
  const others = state?.lineBook?.bookings?.[lineId] ?? {};
  for (const [w, n] of Object.entries(others)) {
    const wk = Number(w);
    if (wk >= fromAbsWeek && n > 0) m.set(wk, (m.get(wk) ?? 0) + n);
  }
  for (const o of state?.pendingOrders ?? []) {
    if (!isLineOrder(o) || (o.lineId ?? lineOf(o.typeId)) !== lineId) continue;
    if (o.deliverAbsWeek < fromAbsWeek) continue;
    m.set(o.deliverAbsWeek, (m.get(o.deliverAbsWeek) ?? 0) + 1);
  }
  return m;
}

/**
 * Minimum weeks between two of ONE airline's deliveries off a line — the
 * classic per-type stagger (data/delivery.js: turboprop 1, regional 2, narrow
 * body 3, wide body 4, double deck / supersonic / outsize 5), now applied to
 * the whole family. No airline takes four A380s in a month (Dave, 2026-10-16).
 */
export function lineGapWeeks(lineId) {
  return deliveryLead(getAircraftType(lineInfo(lineId).types[0]));
}

/** Is `week` within `gap` weeks of one of this airline's slots on the line? */
export function tooCloseToOwn(mine, week, gap) {
  for (let d = -(gap - 1); d <= gap - 1; d++) if (mine.has(week + d)) return true;
  return false;
}

/** Weeks on this line where THIS airline already holds a slot. */
export function ownLineWeeks(state, lineId) {
  const s = new Set();
  for (const o of state?.pendingOrders ?? []) {
    if (isLineOrder(o) && (o.lineId ?? lineOf(o.typeId)) === lineId) s.add(o.deliverAbsWeek);
  }
  return s;
}

const sumMap = (m) => { let n = 0; for (const v of m.values()) n += v; return n; };

/** The line's capacity as this airline sees it right now. */
export function capacityFor(state, lineId, absWeek) {
  return lineCapacity(lineId, {
    scale: state?.lineBook?.scale ?? state?.productionLineScale ?? 1,
    rates: ratesFor(state),
    backlogFrames: sumMap(lineBookings(state, lineId, absWeek + 1)),
  });
}

// ── Slot timing and price ────────────────────────────────────────────────────
export const EARLY_SLOT_MAX_PREMIUM = 0.25;
/**
 * The furthest ahead a player may ASK to start (slotFromWeek), past the standard
 * week. A big order still spills as far as it needs; this only stops a lease
 * being parked a year out to hold a slot for free (a lease cancelled 26+ weeks
 * out is refunded in full) — review finding, 2026-10-16.
 */
export const MAX_START_AHEAD_WEEKS = 26;

/** earliest = now + lead (build time); standard = now + 2 × lead (no premium). */
export function slotWindow(type, absWeek) {
  const lead = deliveryLead(type);
  return { lead, earliest: absWeek + lead, standard: absWeek + 2 * lead };
}

/** Premium as a share of list price for a frame delivered in `week`. */
export function slotPremiumPct(type, week, absWeek) {
  const { earliest, standard } = slotWindow(type, absWeek);
  if (week >= standard) return 0;
  const span = Math.max(1, standard - earliest);
  const ahead = Math.min(span, standard - Math.max(earliest, week));
  return Math.round(EARLY_SLOT_MAX_PREMIUM * (ahead / span) * 10000) / 10000;
}

/**
 * Hands out slots one frame at a time: the first week at or after `fromWeek`
 * (never before the earliest buildable week) where the line has room AND this
 * airline holds no slot yet. `take()` books it so the next frame moves on.
 */
export function makeSlotAllocator(state, type, { absWeek, fromWeek = null, notBefore = null } = {}) {
  const lineId = lineOf(type);
  const { earliest, standard } = slotWindow(type, absWeek);
  const floor = Math.max(earliest, notBefore ?? earliest);
  const requested = Number.isFinite(fromWeek)
    ? Math.min(Math.floor(fromWeek), Math.max(floor, standard) + MAX_START_AHEAD_WEEKS)
    : Math.max(floor, standard);
  const start = Math.max(floor, requested);
  const booked = lineBookings(state, lineId, absWeek);
  const mine = ownLineWeeks(state, lineId);
  const capacity = capacityFor(state, lineId, absWeek);
  const gap = lineGapWeeks(lineId);
  let cursor = start;
  const scan = () => {
    let w = cursor;
    for (let guard = 0; guard < 52 * 200; guard++, w++) {
      if (!tooCloseToOwn(mine, w, gap) && (booked.get(w) ?? 0) < capacity) return w;
    }
    return w;
  };
  return {
    lineId, capacity, gap, earliest: floor, standard: Math.max(floor, standard),
    peek: scan,
    take() {
      const w = scan();
      booked.set(w, (booked.get(w) ?? 0) + 1);
      mine.add(w);
      cursor = w + 1;
      return w;
    },
  };
}

/** Summary for the market and checkout: rate, how busy, and the next open slots. */
export function lineStatus(state, typeOrId, absWeek) {
  const type = typeof typeOrId === 'string' ? getAircraftType(typeOrId) : typeOrId;
  if (!type) return null;
  const lineId = lineOf(type);
  const info = lineInfo(lineId);
  const booked = lineBookings(state, lineId, absWeek);
  const capacity = capacityFor(state, lineId, absWeek);
  const { earliest, standard } = slotWindow(type, absWeek);
  const firstFree = (from) => makeSlotAllocator(state, type, { absWeek, fromWeek: from }).peek();
  let next26 = 0;
  for (let w = absWeek + 1; w <= absWeek + 26; w++) next26 += booked.get(w) ?? 0;
  return {
    lineId, name: info.name, cls: info.cls, capacity, gap: lineGapWeeks(lineId),
    backlog: sumMap(booked),
    utilisation26: Math.min(1, next26 / (capacity * 26)),
    earliest, standard,
    nextOpen: firstFree(earliest),
    nextStandard: firstFree(standard),
  };
}

/** Open slots per week over the next `weeks` weeks, for the checkout calendar. */
export function slotCalendar(state, type, absWeek, weeks = 26) {
  const lineId = lineOf(type);
  const booked = lineBookings(state, lineId, absWeek);
  const mine = ownLineWeeks(state, lineId);
  const capacity = capacityFor(state, lineId, absWeek);
  const gap = lineGapWeeks(lineId);
  const { earliest } = slotWindow(type, absWeek);
  const rows = [];
  for (let w = earliest; w < earliest + weeks; w++) {
    rows.push({
      week: w,
      booked: booked.get(w) ?? 0,
      free: Math.max(0, capacity - (booked.get(w) ?? 0)),
      mine: mine.has(w),
      // Too close to one of your own frames on this line to take another.
      gapBlocked: tooCloseToOwn(mine, w, gap),
      premiumPct: slotPremiumPct(type, w, absWeek),
    });
  }
  return { capacity, gap, rows };
}

// ── Cancelling ───────────────────────────────────────────────────────────────
/** Forfeit of the price paid (owned frames), by weeks until the slot. */
export function cancelForfeitPct(weeksOut) {
  if (weeksOut > 52) return 0.05;
  if (weeksOut >= 26) return 0.10;
  if (weeksOut >= 13) return 0.20;
  return 0.30;
}
/** Lease deposits (and any early-slot fee) come back only this far out. */
export const LEASE_REFUND_MIN_WEEKS = 26;

/**
 * What cancelling a pending order returns on a production-line world.
 * { allowed, refund, forfeit, forfeitPct, weeksOut, reason }
 */
export function cancelTerms(order, absWeek) {
  const weeksOut = Math.max(0, (order?.deliverAbsWeek ?? absWeek) - absWeek);
  if (order?.launch) {
    return { allowed: false, refund: 0, forfeit: 0, forfeitPct: 0, weeksOut,
      reason: 'Launch-customer orders are firm — they cannot be cancelled.' };
  }
  if (order?.ownershipType === 'lease') {
    const paid = (order.leaseDeposit ?? 0) + (order.slotPremium ?? 0);
    const back = weeksOut >= LEASE_REFUND_MIN_WEEKS;
    return { allowed: true, refund: back ? paid : 0, forfeit: back ? 0 : paid,
      forfeitPct: back ? 0 : 1, weeksOut, reason: null };
  }
  const paid = order?.totalPrice ?? 0;
  const pct = cancelForfeitPct(weeksOut);
  const forfeit = Math.round(paid * pct);
  return { allowed: true, refund: paid - forfeit, forfeit, forfeitPct: pct, weeksOut, reason: null };
}

// ── Launch customers (era worlds) ────────────────────────────────────────────
export const LAUNCH_ANNOUNCE_YEARS = 2;
export const LAUNCH_WINDOW_WEEKS = 26;
export const LAUNCH_MIN_LARGE = 20;   // wide bodies and bigger
export const LAUNCH_MIN_SMALL = 30;   // narrow bodies, regionals, turboprops
export const LAUNCH_DISCOUNT = 0.08;
export const LAUNCH_LOYALTY_STEP = 0.02;
export const MAX_TOTAL_DISCOUNT = 0.25;

const LARGE_CLASSES = new Set(['Wide Body', 'Double Deck', 'Supersonic', 'Outsize']);

export function launchMinQty(type) {
  return LARGE_CLASSES.has(deliveryClass(type)) ? LAUNCH_MIN_LARGE : LAUNCH_MIN_SMALL;
}

/** Earlier launch programmes this airline joined with the same manufacturer. */
export function priorLaunchPrograms(state, type) {
  const progs = state?.launchPrograms ?? {};
  return Object.entries(progs)
    .filter(([typeId, p]) => typeId !== type?.id && p?.manufacturer === type?.manufacturer)
    .length;
}

/** Launch-customer discount (before the bulk discount), loyalty included. */
export function launchDiscount(state, type) {
  return LAUNCH_DISCOUNT + LAUNCH_LOYALTY_STEP * priorLaunchPrograms(state, type);
}

/** Bulk + launch + loyalty, capped. */
export function launchOrderDiscount(state, type, quantity) {
  return Math.min(MAX_TOTAL_DISCOUNT, orderDiscount(quantity) + launchDiscount(state, type));
}

/**
 * Era production-line worlds: is this not-yet-flying type announced, and is the
 * launch-customer window open? Null when not applicable.
 * { open, announceAbs, closesAbs, eisAbs, minQty, discount }
 */
export function launchWindow(state, type) {
  if (!state?.productionLinesWorld || !type) return null;
  const startYear = state?.startYear;
  if (!Number.isInteger(startYear) || !Number.isInteger(type.eis)) return null;
  const cy = startYear + ((state?.year ?? 1) - 1);
  if (aircraftAvailability(type, cy) !== 'future') return null;
  const yearIdx = (calYear) => calYear - startYear + 1;
  const announceAbs = absoluteWeek(yearIdx(type.eis - LAUNCH_ANNOUNCE_YEARS), 1);
  const eisAbs = absoluteWeek(yearIdx(type.eis), 1);
  const now = absoluteWeek(state.year ?? 1, state.week ?? 1);
  if (now < announceAbs) return null;
  const closesAbs = announceAbs + LAUNCH_WINDOW_WEEKS;
  return {
    open: now < closesAbs,
    announceAbs, closesAbs, eisAbs,
    minQty: launchMinQty(type),
    discount: launchDiscount(state, type),
  };
}

// ── Server-side race check ───────────────────────────────────────────────────
/**
 * Given fresh OTHER-airline bookings (read under the world lock) and this
 * airline's post-decision pending orders, which of the NEW orders' weeks are
 * over capacity? Empty array = safe to commit.
 */
export function lineConflicts({ othersBookings = {}, pendingOrders = [], newOrderIds = [], scale = 1, rates = null, absWeek = 0 }) {
  const fresh = new Set(newOrderIds);
  const conflicts = [];
  const byLine = new Map();
  for (const o of pendingOrders) {
    if (!isLineOrder(o) || !fresh.has(o.id)) continue;
    const line = o.lineId ?? lineOf(o.typeId);
    (byLine.get(line) ?? byLine.set(line, []).get(line)).push(o);
  }
  for (const [line, orders] of byLine) {
    const state = { lineBook: { scale, rates, bookings: othersBookings }, pendingOrders };
    const booked = lineBookings(state, line, absWeek);
    const cap = capacityFor(state, line, absWeek);
    const gap = lineGapWeeks(line);
    const own = pendingOrders.filter(o => isLineOrder(o) && (o.lineId ?? lineOf(o.typeId)) === line);
    for (const o of orders) {
      const w = o.deliverAbsWeek;
      const crowded = own.some(x => x !== o && Math.abs(x.deliverAbsWeek - w) < gap);
      if ((booked.get(w) ?? 0) > cap || crowded) conflicts.push({ lineId: line, week: w });
    }
  }
  return conflicts;
}

// ── Order board (every world) ────────────────────────────────────────────────
/** This airline's contribution: { [typeId]: [inService, onOrder] }. */
export function fleetCounts(state) {
  const out = {};
  for (const a of state?.fleet ?? []) {
    if (!a?.typeId || a.status === 'retired') continue;
    (out[a.typeId] ??= [0, 0])[0] += 1;
  }
  for (const o of state?.pendingOrders ?? []) {
    if (!o?.typeId || o.used) continue;
    (out[o.typeId] ??= [0, 0])[1] += 1;
  }
  return out;
}

/**
 * World totals per type: every rival's fleetMix (server-built from its save,
 * the same shape fleetCounts returns) plus this airline's own fleet and orders.
 * → { [typeId]: { inService, onOrder, customers: [{ id, name, inService, onOrder, self }] } }
 */
export function worldFleetBoard(state) {
  const out = {};
  const add = (typeId, row) => {
    const e = (out[typeId] ??= { inService: 0, onOrder: 0, customers: [] });
    e.inService += row.inService;
    e.onOrder += row.onOrder;
    e.customers.push(row);
  };
  for (const c of state?.competitors ?? []) {
    for (const [typeId, [inService, onOrder]] of Object.entries(c?.fleetMix ?? {})) {
      add(typeId, { id: c.id, name: c.name ?? 'Rival airline', inService, onOrder, self: false });
    }
  }
  for (const [typeId, [inService, onOrder]] of Object.entries(fleetCounts(state))) {
    add(typeId, { id: 'self', name: state?.airlineName ?? 'You', inService, onOrder, self: true });
  }
  for (const e of Object.values(out)) {
    e.customers.sort((a, b) => (b.inService + b.onOrder) - (a.inService + a.onOrder) || a.name.localeCompare(b.name));
  }
  return out;
}
