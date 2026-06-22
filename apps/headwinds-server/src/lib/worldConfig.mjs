// World-tier config, derivations, and JSON serializers.
// Single home for the §3a rules so the API and the spawner agree.
import { randomBytes, randomUUID } from 'node:crypto';

export const WEEKS_PER_YEAR = 52;

// Allowed tiers (HEADWINDS_MULTIPLAYER_PLAN.md §3a).
export const LENGTH_YEARS = [50, 100];
export const WEEKS_PER_DAY = [6, 12, 24, 48];

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

// Human label for a pace, e.g. 48 → "1 week / 30 min".
export function paceLabel(weeksPerDay) {
  const hours = 24 / weeksPerDay;
  if (hours < 1) return `1 week / ${Math.round(hours * 60)} min`;
  return `1 week / ${hours} hr`;
}

export function validateWorldConfig({ lengthYears, weeksPerDay, visibility, maxPlayers }) {
  if (!LENGTH_YEARS.includes(lengthYears)) {
    throw badRequest(`lengthYears must be one of ${LENGTH_YEARS.join(', ')}`);
  }
  if (!WEEKS_PER_DAY.includes(weeksPerDay)) {
    throw badRequest(`weeksPerDay must be one of ${WEEKS_PER_DAY.join(', ')}`);
  }
  if (visibility && !['PUBLIC', 'PRIVATE'].includes(visibility)) {
    throw badRequest('visibility must be PUBLIC or PRIVATE');
  }
  if (maxPlayers != null && (maxPlayers < 1 || maxPlayers > 500)) {
    throw badRequest('maxPlayers must be between 1 and 500');
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
export function serializeWorld(world, { playerCount } = {}) {
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
    playerCount: playerCount ?? world._count?.airlines ?? undefined,
    joinCode: world.visibility === 'PRIVATE' ? world.joinCode : undefined,
    startedAt: world.startedAt,
    endsAt: world.endsAt,
    createdAt: world.createdAt,
  };
}

// Plain-JSON view of an airline (BigInt cash/marketCap → Number).
export function serializeAirline(a, { world } = {}) {
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
    world: world ? serializeWorld(world) : undefined,
  };
}
