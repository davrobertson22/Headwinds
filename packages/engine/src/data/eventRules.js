// ─────────────────────────────────────────────────────────────────────────────
// EVENT RULES — the "weird rules" an event world can switch on
//
// Dave, 2026-10-17, for Headwinds event worlds (claude/event-worlds.md):
//   1. aircraft restricted to a category / family / type ("a 737-only world")
//   2. no leases — every frame is bought
//   3. hubs: none at all, regional airports only, or a set list of cities
//   4. domestic flights only / international flights only
//   5. each year X random airports pay double profit on routes touching them
//   6. alliances are ranked instead of airlines (server-side: the standings)
//
// One shape, `state.eventRules` (normalised by normalizeEventRules), stamped
// onto every airline in the world by the server — at join, on every tick and
// on every decision — exactly like the other world rule flags. ABSENT means a
// normal world: every function here returns null / passes, and the bonus set
// stays empty, so a world without rules is byte-identical to before (the
// golden master depends on it).
//
// Every rule is enforced in ONE place per action kind, and each of those is
// shared by the reducer (authoritative), the server's decision endpoint (a
// readable 400) and the UI (disabled buttons with the same sentence):
//   aircraft  → eventAircraftDenial  (read by orderDenial)
//   leases    → eventLeaseDenial     (read by leaseDenial)
//   hubs      → eventHubDenial       (read by hubUpgradeChecklist + join)
//   routes    → eventRouteDenial     (read by the three route block reasons)
//   catch-all → eventActionDenial    (the reducer's and the server's gate)
//   bonus     → withEventBonus       (inside simulateRoute/TagRoute/CargoRoute,
//                                     so every preview agrees with the tick)
// Nothing here reads who is playing; inside a world every airline is on
// identical terms.
// ─────────────────────────────────────────────────────────────────────────────
import { AIRCRAFT_TYPES, AIRCRAFT_CATEGORIES, getAircraftType } from './aircraft.js';
import { AIRCRAFT_FAMILY, FAMILY_INFO } from './families.js';
import { AIRPORTS, getAirport } from './airports.js';
import { sameSovereign, sovereignCountry } from './territories.js';

export const HUB_RULE_MODES = ['none', 'regional', 'assigned'];
export const ROUTE_RULE_MODES = ['domestic', 'international'];
export const ALLIANCE_SCORE_MODES = ['sum', 'average'];
export const MAX_BONUS_AIRPORTS = 20;
export const MAX_ASSIGNED_HUBS = 60;

const uniq = (xs) => [...new Set(xs)];
const cleanCodes = (xs) => uniq((Array.isArray(xs) ? xs : [])
  .map((c) => String(c ?? '').trim().toUpperCase()).filter(Boolean));

function bad(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

/**
 * Validate and normalise rules from the create/edit form. Unknown keys are
 * dropped; anything malformed throws a 400 with a sentence. Returns null when
 * no rule is switched on.
 *
 * @param {object|null} raw
 * @param {{ seed?: string }} [opts]  seed for the bonus-airport draw (the world seed)
 */
export function normalizeEventRules(raw, { seed = null } = {}) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('Event rules must be an object');
  const out = {};

  // 1. Aircraft allow-list (union of categories, families and exact types).
  if (raw.aircraft) {
    const a = raw.aircraft;
    const categories = uniq((a.categories ?? []).map(String)).filter((c) => AIRCRAFT_CATEGORIES.includes(c));
    const families = uniq((a.families ?? []).map(String)).filter((f) => FAMILY_INFO[f]);
    const types = uniq((a.types ?? []).map(String)).filter((t) => getAircraftType(t));
    const asked = (a.categories?.length ?? 0) + (a.families?.length ?? 0) + (a.types?.length ?? 0);
    if (categories.length + families.length + types.length === 0) {
      if (asked > 0) throw bad('None of the chosen aircraft categories, families or types exist');
    } else {
      if (!AIRCRAFT_TYPES.some((t) => typeAllowed({ categories, families, types }, t))) {
        throw bad('That aircraft restriction allows no aircraft at all');
      }
      out.aircraft = {
        ...(categories.length ? { categories } : {}),
        ...(families.length ? { families } : {}),
        ...(types.length ? { types } : {}),
      };
    }
  }

  // 2. No leases.
  if (raw.noLeases === true) out.noLeases = true;

  // 3. Hubs.
  if (raw.hubs && raw.hubs.mode) {
    const mode = String(raw.hubs.mode);
    if (!HUB_RULE_MODES.includes(mode)) throw bad(`Hub rule must be one of: ${HUB_RULE_MODES.join(', ')}`);
    if (mode === 'assigned') {
      const airports = cleanCodes(raw.hubs.airports);
      const unknown = airports.filter((c) => !getAirport(c));
      if (unknown.length) throw bad(`Unknown airport code${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
      if (airports.length === 0) throw bad('Pick at least one airport for the set hub cities');
      if (airports.length > MAX_ASSIGNED_HUBS) throw bad(`At most ${MAX_ASSIGNED_HUBS} hub cities`);
      out.hubs = { mode, airports };
    } else {
      out.hubs = { mode };
    }
  }

  // 4. Domestic / international.
  if (raw.routes) {
    const r = String(raw.routes);
    if (!ROUTE_RULE_MODES.includes(r)) throw bad(`Route rule must be one of: ${ROUTE_RULE_MODES.join(', ')}`);
    out.routes = r;
  }

  // 5. Double-profit airports.
  if (raw.bonusAirports && raw.bonusAirports.count != null) {
    const count = Math.round(Number(raw.bonusAirports.count));
    if (!Number.isInteger(count) || count < 1 || count > MAX_BONUS_AIRPORTS) {
      throw bad(`Double-profit airports per year must be 1–${MAX_BONUS_AIRPORTS}`);
    }
    out.bonusAirports = { count, seed: String(raw.bonusAirports.seed ?? seed ?? 'headwinds') };
  }

  // 6. Alliances ranked instead of airlines.
  if (raw.allianceRanking) {
    const score = String(raw.allianceRanking.score ?? 'sum');
    if (!ALLIANCE_SCORE_MODES.includes(score)) throw bad(`Alliance score must be one of: ${ALLIANCE_SCORE_MODES.join(', ')}`);
    out.allianceRanking = { score };
  }

  return Object.keys(out).length ? out : null;
}

/** The rules in force for this airline's world, or null. */
export const eventRulesOf = (state) => state?.eventRules ?? null;

// ── 1. Aircraft ──────────────────────────────────────────────────────────────

function typeAllowed(rule, type) {
  if (!rule || !type) return true;
  const fam = AIRCRAFT_FAMILY[type.id];
  return (rule.categories ?? []).includes(type.category)
    || (rule.families ?? []).includes(fam)
    || (rule.types ?? []).includes(type.id);
}

/** Is this type allowed under these rules (rules object, not state)? */
export function aircraftAllowedByRules(rules, typeId) {
  if (!rules?.aircraft) return true;
  return typeAllowed(rules.aircraft, getAircraftType(typeId));
}

/** One line naming what IS allowed, e.g. "Boeing 737 family". */
export function aircraftRuleLabel(rule) {
  if (!rule) return null;
  const parts = [
    ...(rule.families ?? []).map((f) => `${FAMILY_INFO[f]?.name ?? f} family`),
    ...(rule.categories ?? []).map((c) => c),
    ...(rule.types ?? []).map((t) => getAircraftType(t)?.name ?? t),
  ];
  return parts.join(', ');
}

export function eventAircraftDenial(state, typeId) {
  const rules = eventRulesOf(state);
  if (!rules?.aircraft) return null;
  const type = getAircraftType(typeId);
  if (!type || typeAllowed(rules.aircraft, type)) return null;
  return {
    code: 'event_aircraft', typeId,
    message: `Event rules: only the ${aircraftRuleLabel(rules.aircraft)} may be flown in this world — not the ${type.name}.`,
  };
}

// ── 2. Leases ────────────────────────────────────────────────────────────────

export function eventLeaseDenial(state) {
  if (!eventRulesOf(state)?.noLeases) return null;
  return { code: 'event_no_leases', message: 'Event rules: no leasing in this world — every aircraft is bought, new or used.' };
}

// ── 3. Hubs ──────────────────────────────────────────────────────────────────

/**
 * Why `code` may not be a hub (or, with `founding`, the airline's base), or
 * null. Accepts a state or a bare rules object. `focus` is a focus-city
 * designation, which the hub rules treat the same as a hub.
 */
export function eventHubDenial(stateOrRules, code, { founding = false } = {}) {
  const rules = stateOrRules?.eventRules !== undefined ? stateOrRules.eventRules : stateOrRules;
  const h = rules?.hubs;
  if (!h) return null;
  const ap = getAirport(code);
  if (h.mode === 'none') {
    return founding ? null : 'Event rules: no hubs or focus cities in this world — every airline flies point to point.';
  }
  if (h.mode === 'regional') {
    if (ap?.tier === 'regional') return null;
    return founding
      ? `Event rules: airlines must be based at a regional airport — ${code} is a ${ap?.tier ?? 'major'} airport.`
      : `Event rules: hubs only at regional airports — ${code} is a ${ap?.tier ?? 'major'} airport.`;
  }
  if (h.mode === 'assigned') {
    if ((h.airports ?? []).includes(code)) return null;
    const list = (h.airports ?? []).join(', ');
    return founding
      ? `Event rules: airlines must be based at one of ${list}.`
      : `Event rules: hubs only at ${list}.`;
  }
  return null;
}

/** May an airline be founded at `code` in this world? (join + restart + hub picker) */
export const foundingHubAllowed = (rules, code) => !eventHubDenial(rules ?? null, code, { founding: true });

// ── 4. Domestic / international ──────────────────────────────────────────────

/**
 * Why a route over these stops breaks the route rule, or null. Every LEG is
 * checked. Domestic means inside the airline's home country (sovereign state —
 * San Juan is US soil, see data/territories.js); international means each leg
 * crosses a border.
 */
export function eventRouteDenial(state, stops) {
  const mode = eventRulesOf(state)?.routes;
  if (!mode) return null;
  const codes = (stops ?? []).filter(Boolean);
  const home = state?.homeCountry ?? getAirport(state?.hub)?.country ?? null;
  for (let i = 0; i + 1 < codes.length; i++) {
    const a = getAirport(codes[i])?.country, b = getAirport(codes[i + 1])?.country;
    if (!a || !b) continue;
    if (mode === 'domestic') {
      if (!(sameSovereign(a, home) && sameSovereign(b, home))) {
        return `Event rules: domestic flights only — ${codes[i]}–${codes[i + 1]} leaves ${sovereignCountry(home) ?? 'your home country'}.`;
      }
    } else if (mode === 'international') {
      if (sameSovereign(a, b)) {
        return `Event rules: international flights only — ${codes[i]}–${codes[i + 1]} stays inside ${sovereignCountry(a)}.`;
      }
    }
  }
  return null;
}

// ── 5. Double-profit airports ────────────────────────────────────────────────

// Deterministic PRNG (mulberry32) seeded from a string — the same draw on every
// airline, the server and the client.
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Major and mega airports only: a double-profit Yakutat would be a prize nobody
// can collect. Sorted so the draw never depends on table order.
let _pool = null;
const bonusPool = () => (_pool ??= AIRPORTS
  .filter((a) => a.tier === 'major' || a.tier === 'mega')
  .map((a) => a.code).sort());

/** This game-year's double-profit airports (game year index, 1-based). */
export function bonusAirportsFor(rules, year) {
  const b = rules?.bonusAirports;
  if (!b?.count) return [];
  const pool = [...bonusPool()];
  const rand = mulberry32(hashSeed(`${b.seed}:${year}`));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(b.count, pool.length)).sort();
}

export const bonusAirportsForState = (state) => bonusAirportsFor(eventRulesOf(state), state?.year ?? 1);

// Module knob, like the fare index and the NWR yield choke: set by the reducer
// prelude and by weeklyTick from the state they run on, read by the route
// simulators. Null in every normal world.
let _bonusSet = null;
export function setEventBonusAirports(codes) {
  _bonusSet = codes && codes.length ? new Set(codes) : null;
}
export const getEventBonusAirports = () => (_bonusSet ? [..._bonusSet] : []);
/** Pin the knob from a state (reducer prelude, weeklyTick, projections). */
export const pinEventBonusFrom = (state) => setEventBonusAirports(bonusAirportsForState(state));

/**
 * Double a route result's operating profit when it touches a bonus airport.
 * A loss is not doubled. Returns the SAME object when nothing applies, so a
 * normal world's results are byte-identical.
 */
export function withEventBonus(result, stops) {
  if (!_bonusSet || !result) return result;
  if (!(stops ?? []).some((c) => _bonusSet.has(c))) return result;
  const p = (result.revenue ?? 0) - (result.totalOpCost ?? 0);
  if (!(p > 0)) return result;
  const bonus = Math.round(p);
  return { ...result, revenue: result.revenue + bonus, profit: (result.profit ?? p) + bonus, eventBonus: bonus };
}

// ── Catch-all gate (reducer + server) ────────────────────────────────────────

/**
 * Why the event rules refuse this player action, or null. The reducer turns a
 * refusal into a toast; the decisions endpoint into a 400.
 */
export function eventActionDenial(state, action) {
  if (!eventRulesOf(state) || !action) return null;
  switch (action.type) {
    case 'ORDER_AIRCRAFT':
    case 'BUY_AIRCRAFT':
    case 'LEASE_AIRCRAFT': {
      const t = eventAircraftDenial(state, action.typeId);
      if (t) return t.message;
      if (action.type === 'LEASE_AIRCRAFT' || action.ownershipType === 'lease') return eventLeaseDenial(state)?.message ?? null;
      return null;
    }
    case 'BUY_USED_AIRCRAFT':
      return eventAircraftDenial(state, action.snapshot?.typeId)?.message ?? null;
    case 'RENEW_LEASE':
    case 'EXTEND_LEASE':
    case 'EXTEND_LEASES':
      return eventLeaseDenial(state)?.message ?? null;
    case 'DESIGNATE_HUB':
    case 'UPGRADE_HUB':
    case 'DESIGNATE_FOCUS_CITY':
      return eventHubDenial(state, action.airportCode);
    case 'ADD_ROUTE':
    case 'ADD_CARGO_ROUTE':
      return eventRouteDenial(state, [action.origin, action.destination]);
    case 'ADD_TAG_ROUTE':
      return eventRouteDenial(state, action.stops);
    default:
      return null;
  }
}

// ── Description (world page, create form summary, in-game card) ─────────────

/** [{ id, icon, title, detail }] — one line per rule switched on. */
export function describeEventRules(rules, { year = null } = {}) {
  if (!rules) return [];
  const out = [];
  if (rules.aircraft) out.push({ id: 'aircraft', icon: '✈', title: 'Restricted fleet', detail: `Only the ${aircraftRuleLabel(rules.aircraft)}.` });
  if (rules.noLeases) out.push({ id: 'noLeases', icon: '💵', title: 'No leases', detail: 'Every aircraft is bought — new or used.' });
  if (rules.hubs?.mode === 'none') out.push({ id: 'hubs', icon: '⊘', title: 'No hubs', detail: 'No hubs or focus cities — every airline flies point to point.' });
  if (rules.hubs?.mode === 'regional') out.push({ id: 'hubs', icon: '🛩', title: 'Regional hubs only', detail: 'Your base and every hub must be a regional airport.' });
  if (rules.hubs?.mode === 'assigned') out.push({ id: 'hubs', icon: '📍', title: 'Set hub cities', detail: `Bases and hubs only at ${(rules.hubs.airports ?? []).join(', ')}.` });
  if (rules.routes === 'domestic') out.push({ id: 'routes', icon: '🏠', title: 'Domestic only', detail: 'Every flight stays inside your home country.' });
  if (rules.routes === 'international') out.push({ id: 'routes', icon: '🌍', title: 'International only', detail: 'Every flight crosses a border.' });
  if (rules.bonusAirports) {
    const now = year != null ? bonusAirportsFor(rules, year) : [];
    out.push({
      id: 'bonusAirports', icon: '💰', title: 'Double-profit airports',
      detail: `Each year ${rules.bonusAirports.count} major airport${rules.bonusAirports.count === 1 ? '' : 's'} pay double profit on every route touching them.`
        + (now.length ? ` This year: ${now.join(', ')}.` : ''),
      airports: now,
    });
  }
  if (rules.allianceRanking) {
    out.push({
      id: 'allianceRanking', icon: '🤝', title: 'Alliances ranked',
      detail: rules.allianceRanking.score === 'average'
        ? "Alliances are ranked, not airlines — by their members' average weekly profit. No alliance? You're a team of one."
        : "Alliances are ranked, not airlines — by their members' combined average weekly profit. No alliance? You're a team of one.",
    });
  }
  return out;
}

// ── 6. Alliance standings (server + admin panel) ─────────────────────────────

/**
 * Rank teams from airline standings. `rows` are [{ id, accountId, name, alliance,
 * avgProfit }] (the world standings); an airline with no alliance is its own team.
 * → [{ rank, name, alliance: bool, score, members: [...] }] best first.
 */
export function allianceStandings(rows, { score = 'sum' } = {}) {
  const teams = new Map();
  for (const r of rows ?? []) {
    const key = r.alliance ? `a:${r.alliance}` : `s:${r.id}`;
    if (!teams.has(key)) teams.set(key, { name: r.alliance ?? r.name, alliance: Boolean(r.alliance), members: [] });
    teams.get(key).members.push(r);
  }
  const list = [...teams.values()].map((t) => {
    const total = t.members.reduce((s, m) => s + (Number(m.avgProfit) || 0), 0);
    return { ...t, score: score === 'average' ? Math.round(total / t.members.length) : Math.round(total) };
  });
  list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return list.map((t, i) => ({ rank: i + 1, ...t }));
}
