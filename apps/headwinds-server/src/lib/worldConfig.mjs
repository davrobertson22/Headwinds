// World-tier config, derivations, and JSON serializers.
// Single home for the §3a rules (admin world creation + the tick worker).
import { randomBytes, randomUUID } from 'node:crypto';
import { eraJoinCapital } from '@tailwinds/engine/data/era.js';

/**
 * Second chances per world: the original airline plus this many re-foundings.
 *
 * Defined HERE rather than in restartService because worldConfig sits at the
 * bottom of the import graph — restartService imports worldService which imports
 * worldConfig, so the reverse edge would be a cycle. restartService re-exports it
 * as MAX_RESTARTS so gameplay code has one obvious place to read it from.
 */
export const MAX_RESTARTS = 3;


export const WEEKS_PER_YEAR = 52;

// Preset quick-picks shown in the admin create form's dropdowns. Admins may also
// enter a custom value (the "custom…" option) — anything within the MIN/MAX
// bounds below is accepted, so these arrays are convenience presets, NOT the
// authoritative allow-list. (Originally §3a fixed these to [50,100] / [6,12,24,48].)
export const LENGTH_YEARS = [10, 25, 50, 100, 200];
export const WEEKS_PER_DAY = [1, 2, 4, 6, 12, 24, 48, 96];

// Custom-value bounds (admin-only create form). weeksPerDay is weeks advanced per
// real day: 1 → one game-week per day (very slow, casual), 96 → one every 15 min.
export const MIN_LENGTH_YEARS = 5;
export const MAX_LENGTH_YEARS = 300;
export const MIN_WEEKS_PER_DAY = 1;
export const MAX_WEEKS_PER_DAY = 96;

// Per-world starting capital (founders' equity). Default matches the solo game's
// STARTING_CASH ($10M); market cap seeds at a fixed multiple as always. Admin may
// override per world to make a world easier (more runway) or harder.
export const DEFAULT_STARTING_CAPITAL = 10_000_000;
export const MIN_STARTING_CAPITAL = 1_000_000;

// Era worlds: the world's week 1 of year 1 is January of this real calendar
// year. Null/absent = classic ordinal "Year N" world — EVERY era code path in
// the engine short-circuits when startYear is null, which is the parity
// invariant (see ERA_MODE_PLAN.md). Fixed at creation like the rule flags:
// the whole design keys demand, fuel and aircraft availability off
// "week 1 = startYear", so flipping it on a running world would teleport the
// economy. Presets are quick-picks; any year in bounds is accepted.
export const ERA_START_YEARS = [1950, 1958, 1970, 1978, 2000];
export const MIN_START_YEAR = 1930;
export const MAX_START_YEAR = 2100;
export const MAX_STARTING_CAPITAL = 500_000_000;

// A world's maturity label. Cosmetic ONLY — no rule reads it, which is why
// (unlike gateScarcity / newWorldRestrictions) it can be changed on a world
// that's already running.
//   alpha → loud ⚗ ALPHA chip: a testbed, expect rough edges
//   beta  → muted BETA chip: the standard ruleset, still changing week to week
//   live  → NO chip at all: a settled production world
// Beta is the default so every world that predates this reads as it always did.
export const WORLD_STAGES = ['alpha', 'beta', 'live'];
export const DEFAULT_WORLD_STAGE = 'beta';

// Resolve a world's stage from its tickConfig, tolerating both the absent key
// (worlds created before stages existed) and the short-lived `alpha: true`
// boolean this replaced.
export function worldStageOf(tickConfig) {
  const s = tickConfig?.stage;
  if (WORLD_STAGES.includes(s)) return s;
  return tickConfig?.alpha === true ? 'alpha' : DEFAULT_WORLD_STAGE;
}

// Rival one-stop itineraries (HUB_CONNECTIVITY_PLAN.md). Rollout decision
// (Dave, 2026-09-07): the alpha worlds get it, every world created from now on
// gets it, and the existing beta worlds — the standard ruleset players are in
// the middle of — do NOT. So: an explicit `rivalItineraries` on the world wins
// (createWorld always writes one, the admin toggle rewrites it); a world with
// no key predates the feature and is on only if it is an alpha.
// Fuel-ops rule version (FUEL_OPERATIONS_PLAN.md §7.4). 2 = station fuel
// pricing and tankering. createWorld writes it for every new world; a world
// with no key predates the feature and stays on world-flat fuel (1) until an
// admin sets tickConfig.fuelOpsV — the tick reads it LIVE, so the flip lands
// on every airline at the next tick and persists into their blobs.
export const FUEL_OPS_VERSION = 2;
export function fuelOpsVOf(tickConfig) {
  const v = Number(tickConfig?.fuelOpsV);
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

export function rivalItinerariesOf(tickConfig) {
  if (typeof tickConfig?.rivalItineraries === 'boolean') return tickConfig.rivalItineraries;
  return worldStageOf(tickConfig) === 'alpha';
}

// Per-world global demand multiplier — scales the whole passenger pool so worlds
// with more players can carry more surviving airlines. 1.0 = identical to solo.
export const DEFAULT_DEMAND_MULT = 1;
export const MIN_DEMAND_MULT = 0.5;
export const MAX_DEMAND_MULT = 3;

// Optional scheduled start — admin "list a game that starts at a preset time".
// A world with tickConfig.scheduledStartAt sits open in LOBBY (players may join)
// and the worker flips it LOBBY→RUNNING automatically at that instant; joining
// never starts the clock. Null = classic "starts on first join". Capped ~1 year
// out as a typo guard.
export const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

// Pre-start setup. Between joining a scheduled world and its start, the airline
// is fully playable — open routes, lease aircraft, set fares — and only the clock
// waits: nothing ticks until the worker flips the world to RUNNING, and week 1
// flies one interval after the scheduled instant. A classic lobby never holds an
// airline (the first join starts the clock), so it isn't pre-start.
export const isPreStart = (world) =>
  world?.status === 'LOBBY' && Boolean(world?.tickConfig?.scheduledStartAt);

// Share trading and capital actions settle against the world's float pool, which
// is seeded lazily from the ACTIVE player count on first touch. Seeding it from a
// handful of early joiners would starve the whole season of liquidity, so these
// wait for the start.
export const PRE_START_BLOCKED_ACTIONS = new Set([
  'BUY_STOCK', 'SELL_STOCK', 'GO_PUBLIC', 'ISSUE_SHARES', 'BUY_BACK_SHARES',
]);

// Why a player decision of `type` is refused in this world right now, or null
// when it may run. The single gate for POST /decisions.
export function decisionDenialFor(world, type) {
  if (world?.status === 'RUNNING') return null;
  if (isPreStart(world)) {
    return PRE_START_BLOCKED_ACTIONS.has(type)
      ? 'The share market opens when the world starts.'
      : null;
  }
  return `This world is ${world?.status}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Total game-weeks in a world of this length.
export const totalWeeks = (lengthYears) => lengthYears * WEEKS_PER_YEAR;

// Real-time tick interval: one game-week every (24h / weeksPerDay).
export const tickIntervalMs = (weeksPerDay) => DAY_MS / weeksPerDay;

// Real-time duration in days: years × 52 ÷ weeksPerDay.
export const realTimeDays = (lengthYears, weeksPerDay) =>
  (lengthYears * WEEKS_PER_YEAR) / weeksPerDay;

// When a world that started at `startedAt` will end.
export const deriveEndsAt = (startedAt, lengthYears, weeksPerDay) =>
  new Date(startedAt.getTime() + realTimeDays(lengthYears, weeksPerDay) * DAY_MS);

// Human label for a pace, e.g. 48 → "1 week / 30 min", 1 → "1 week / 1 day".
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
export function paceLabel(weeksPerDay) {
  const hours = 24 / weeksPerDay;
  if (hours < 1) return `1 week / ${Math.round(hours * 60)} min`;
  if (hours < 24) return `1 week / ${fmtNum(hours)} hr`;
  const days = hours / 24;
  return `1 week / ${fmtNum(days)} day${days === 1 ? '' : 's'}`;
}

// Admins may pass custom length/pace/capital/demand — validated to bounds, not to
// the preset arrays (those are just dropdown quick-picks in the UI).
export function validateWorldConfig({
  lengthYears, weeksPerDay, visibility, maxPlayers, startingCapital, demandMultiplier, scheduledStartAt, gateScarcity,
  newWorldRestrictions, crewPipeline, stage, startYear, rivalItineraries,
}) {
  if (startYear != null
    && (!Number.isInteger(startYear) || startYear < MIN_START_YEAR || startYear > MAX_START_YEAR)) {
    throw badRequest(`startYear must be a whole year between ${MIN_START_YEAR} and ${MAX_START_YEAR}`);
  }
  if (stage != null && !WORLD_STAGES.includes(stage)) {
    throw badRequest(`stage must be one of: ${WORLD_STAGES.join(', ')}`);
  }
  if (gateScarcity != null && typeof gateScarcity !== 'boolean') {
    throw badRequest('gateScarcity must be true or false');
  }
  if (newWorldRestrictions != null && typeof newWorldRestrictions !== 'boolean') {
    throw badRequest('newWorldRestrictions must be true or false');
  }
  if (crewPipeline != null && typeof crewPipeline !== 'boolean') {
    throw badRequest('crewPipeline must be true or false');
  }
  if (rivalItineraries != null && typeof rivalItineraries !== 'boolean') {
    throw badRequest('rivalItineraries must be true or false');
  }
  if (!Number.isInteger(lengthYears) || lengthYears < MIN_LENGTH_YEARS || lengthYears > MAX_LENGTH_YEARS) {
    throw badRequest(`lengthYears must be a whole number between ${MIN_LENGTH_YEARS} and ${MAX_LENGTH_YEARS}`);
  }
  if (!Number.isInteger(weeksPerDay) || weeksPerDay < MIN_WEEKS_PER_DAY || weeksPerDay > MAX_WEEKS_PER_DAY) {
    throw badRequest(`weeksPerDay must be a whole number between ${MIN_WEEKS_PER_DAY} and ${MAX_WEEKS_PER_DAY}`);
  }
  if (visibility && !['PUBLIC', 'PRIVATE'].includes(visibility)) {
    throw badRequest('visibility must be PUBLIC or PRIVATE');
  }
  if (maxPlayers != null && (maxPlayers < 1 || maxPlayers > 500)) {
    throw badRequest('maxPlayers must be between 1 and 500');
  }
  if (startingCapital != null
    && (!Number.isFinite(startingCapital) || startingCapital < MIN_STARTING_CAPITAL || startingCapital > MAX_STARTING_CAPITAL)) {
    throw badRequest(`startingCapital must be between ${MIN_STARTING_CAPITAL} and ${MAX_STARTING_CAPITAL}`);
  }
  if (demandMultiplier != null
    && (!Number.isFinite(demandMultiplier) || demandMultiplier < MIN_DEMAND_MULT || demandMultiplier > MAX_DEMAND_MULT)) {
    throw badRequest(`demandMultiplier must be between ${MIN_DEMAND_MULT} and ${MAX_DEMAND_MULT}`);
  }
  if (scheduledStartAt != null) {
    const t = new Date(scheduledStartAt).getTime();
    if (Number.isNaN(t)) throw badRequest('scheduledStartAt must be a valid date/time');
    if (t <= Date.now()) throw badRequest('scheduledStartAt must be in the future');
    if (t > Date.now() + MAX_SCHEDULE_AHEAD_MS) throw badRequest('scheduledStartAt is more than a year out');
  }
}

function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

export const genWorldSeed = () => randomUUID();

// ── Supporter worlds ─────────────────────────────────────────────────────────
// A ♥ SUPPORTER account may create private worlds for its own group (see
// World.ownerAccountId in schema.prisma). Two dials, both here so the client
// and the tests read the same numbers.
//
// How many LIVE (LOBBY or RUNNING) supporter worlds one account may be in at
// once — owning one counts as being in it. Dave, 2026-09-19: "max 2 private
// worlds they can participate in per user". Ended and archived worlds free
// their slot; operator-created private worlds never count.
export const MAX_SUPPORTER_WORLD_MEMBERSHIPS = 2;

// The owner's password for the world. Stored in World.joinCode, plaintext,
// exactly like the generated admin codes (members read it back from /me to
// pass on). Compared trimmed and case-insensitively — the web client has
// always upper-cased the typed code before sending it, and a password a group
// shares over Discord should not fail on someone's phone auto-capitalising.
export const PASSWORD_MIN_LENGTH = 4;
export const PASSWORD_MAX_LENGTH = 32;

export function validatePassword(password) {
  if (typeof password !== 'string') throw badRequest('A password is required for a private world');
  const p = password.trim();
  if (p.length < PASSWORD_MIN_LENGTH || p.length > PASSWORD_MAX_LENGTH) {
    throw badRequest(`The password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`);
  }
  return p;
}

// Does a typed join code / password open this world? ONE comparison for both
// the generated admin codes and owner-chosen passwords (joinWorld and the
// tests call this — never compare the strings inline).
export function joinCodeMatches(typed, stored) {
  if (typeof typed !== 'string' || typeof stored !== 'string') return false;
  const norm = (v) => v.trim().toUpperCase();
  return norm(typed).length > 0 && norm(typed) === norm(stored);
}

// 6-char uppercase join code (no ambiguous chars), e.g. "K7P2QF".
export function genJoinCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

const NAME_ADJ = ['Azure', 'Crimson', 'Golden', 'Silver', 'Northern', 'Pacific',
  'Atlantic', 'Solar', 'Lunar', 'Polar', 'Emerald', 'Cobalt', 'Amber', 'Onyx'];
const NAME_NOUN = ['Skies', 'Horizon', 'Meridian', 'Currents', 'Expanse',
  'Frontier', 'Gateway', 'Aurora', 'Zephyr', 'Passage', 'Summit', 'Wake'];

export function genWorldName() {
  const a = NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)];
  const n = NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)];
  return `${a} ${n}`;
}

// Progress through a world's lifetime.
// The clock points at the week about to be flown, so a finished world parks
// on year L+1 week 1 (tickService completeIndex). Progress is reported as
// weeks FLOWN, and a finished world reads as year L week 52, 100% — never
// "year 101 of 100".
export function worldProgress(world) {
  const total = totalWeeks(world.lengthYears);
  const flown = Math.min(total, (world.currentYear - 1) * WEEKS_PER_YEAR + world.currentWeek - 1);
  const complete = flown >= total;
  return {
    year: complete ? world.lengthYears : world.currentYear,
    week: complete ? WEEKS_PER_YEAR : world.currentWeek,
    totalYears: world.lengthYears,
    percent: Math.min(100, Math.round((flown / total) * 100)),
  };
}

const toNum = (v) => (v == null ? v : Number(v));

// Plain-JSON view of a world for API responses (BigInt-safe, with derivations).
export function serializeWorld(world, { playerCount, includeJoinCode = false } = {}) {
  return {
    id: world.id,
    name: world.name,
    status: world.status,
    visibility: world.visibility,
    lengthYears: world.lengthYears,
    weeksPerDay: world.weeksPerDay,
    paceLabel: paceLabel(world.weeksPerDay),
    progress: worldProgress(world),
    maxPlayers: world.maxPlayers,
    // Admin-tunable knobs live in tickConfig (JSON); fall back to the defaults so
    // worlds created before these existed serialize sensibly.
    startingCapital: world.tickConfig?.startingCapital ?? DEFAULT_STARTING_CAPITAL,
    // What a player joining NOW actually receives: the knob (the literal founding
    // amount), scaled by how far the era has moved since the world opened
    // (seedAirlineState applies the same rule). Equals startingCapital at
    // founding and in classic worlds.
    seedCapital: eraJoinCapital(world.tickConfig?.startingCapital ?? DEFAULT_STARTING_CAPITAL,
      Number.isInteger(world.tickConfig?.startYear) ? world.tickConfig.startYear : null,
      Number.isInteger(world.tickConfig?.startYear) ? world.tickConfig.startYear + (world.currentYear ?? 1) - 1 : null),
    demandMultiplier: world.tickConfig?.demandMultiplier ?? DEFAULT_DEMAND_MULT,
    scheduledStartAt: world.tickConfig?.scheduledStartAt ?? null,
    // Optional gate scarcity (finite airport capacity, auctions, gate market).
    gateScarcity: world.tickConfig?.gateScarcity === true,
    // Optional New World Restrictions (old-gen single-deck leasing only +
    // a lease order book capped against the operating fleet).
    newWorldRestrictions: world.tickConfig?.newWorldRestrictions === true,
    // Optional crew pipeline (A7): hiring has a lead time and understaffing
    // degrades the operation. Opt-in, independent of newWorldRestrictions.
    crewPipeline: world.tickConfig?.crewPipeline === true,
    // Station fuel pricing + tankering (fuel-ops v2).
    fuelStations: fuelOpsVOf(world.tickConfig) >= 2,
    // Rival one-stop itineraries (HUB_CONNECTIVITY_PLAN.md): rivals sell
    // connections over their hubs in every passenger market. ON for every
    // world — existing ones included — unless an admin has switched it off
    // (POST /worlds/:id/rival-itineraries {enabled:false}); takes effect at
    // the world's next tick.
    rivalItineraries: rivalItinerariesOf(world.tickConfig),
    // Era world: real calendar year of week 1 (null = classic ordinal world).
    startYear: Number.isInteger(world.tickConfig?.startYear) ? world.tickConfig.startYear : null,
    // Maturity label — see WORLD_STAGES. Changes no rules, so the admin panel
    // can move it on a live world.
    stage: worldStageOf(world.tickConfig),
    // Kept for one release so a browser tab still running the previous bundle
    // (which reads `alpha`) doesn't lose the chip until it reloads.
    alpha: worldStageOf(world.tickConfig) === 'alpha',
    playerCount: playerCount ?? world._count?.airlines ?? undefined,
    // Never leak a private world's join code to non-members: only the create
    // response, /me, and member views of /worlds/:id opt in.
    joinCode: includeJoinCode && world.visibility === 'PRIVATE' ? world.joinCode : undefined,
    // Supporter world (created by a ♥ SUPPORTER account for its own group, see
    // schema.prisma). The owner id is public within the world: the world screen
    // uses it to show the owner their password controls, and the lobby to say
    // "your world". It is a cuid, not an email.
    supporterWorld: Boolean(world.ownerAccountId),
    ownerAccountId: world.ownerAccountId ?? null,
    startedAt: world.startedAt,
    endsAt: world.endsAt,
    createdAt: world.createdAt,
  };
}

// Plain-JSON view of an airline (BigInt cash/marketCap → Number).
export function serializeAirline(a, { world, includeJoinCode = false } = {}) {
  return {
    id: a.id,
    worldId: a.worldId,
    name: a.name,
    hub: a.hub,
    cash: toNum(a.cash),
    marketCap: toNum(a.marketCap),
    week: a.week,
    status: a.status,
    joinedWeek: a.joinedWeek,
    // Second chances. Both are sent so the client can render "Start over
    // (2 left)" without hardcoding the cap, and so a player who has run out
    // sees why the button is gone rather than it silently vanishing.
    restarts: a.restarts ?? 0,
    restartsLeft: Math.max(0, MAX_RESTARTS - (a.restarts ?? 0)),
    restartedWeek: a.restartedWeek ?? null,
    world: world ? serializeWorld(world, { includeJoinCode }) : undefined,
  };
}
