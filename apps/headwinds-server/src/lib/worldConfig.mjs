// World-tier config, derivations, and JSON serializers.
// Single home for the §3a rules (admin world creation + the tick worker).
import { randomBytes, randomUUID } from 'node:crypto';

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
// STARTING_CASH ($15M); market cap seeds at 1.5× as always. Admin may override
// per world to make a world easier (more runway) or harder.
export const DEFAULT_STARTING_CAPITAL = 15_000_000;
export const MIN_STARTING_CAPITAL = 1_000_000;
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
  newWorldRestrictions, stage,
}) {
  if (stage != null && !WORLD_STAGES.includes(stage)) {
    throw badRequest(`stage must be one of: ${WORLD_STAGES.join(', ')}`);
  }
  if (gateScarcity != null && typeof gateScarcity !== 'boolean') {
    throw badRequest('gateScarcity must be true or false');
  }
  if (newWorldRestrictions != null && typeof newWorldRestrictions !== 'boolean') {
    throw badRequest('newWorldRestrictions must be true or false');
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
export function worldProgress(world) {
  const total = totalWeeks(world.lengthYears);
  const done = (world.currentYear - 1) * WEEKS_PER_YEAR + world.currentWeek;
  return {
    year: world.currentYear,
    week: world.currentWeek,
    totalYears: world.lengthYears,
    percent: Math.min(100, Math.round((done / total) * 100)),
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
    demandMultiplier: world.tickConfig?.demandMultiplier ?? DEFAULT_DEMAND_MULT,
    scheduledStartAt: world.tickConfig?.scheduledStartAt ?? null,
    // Optional gate scarcity (finite airport capacity, auctions, gate market).
    gateScarcity: world.tickConfig?.gateScarcity === true,
    // Optional New World Restrictions (old-gen single-deck leasing only +
    // a lease order book capped against the operating fleet).
    newWorldRestrictions: world.tickConfig?.newWorldRestrictions === true,
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
