// World service: create a world, join a world. Shared by the API routes and the
// worker's spawner so there's one code path for world creation. All gameplay
// state is produced by the SHARED engine — never reinvented here.
import { gameReducer, freshState } from '@tailwinds/engine/reducer';
import {
  validateWorldConfig, deriveEndsAt, genJoinCode, genWorldSeed, genWorldName,
  DEFAULT_STARTING_CAPITAL, DEFAULT_DEMAND_MULT,
} from './worldConfig.mjs';

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// Create a world row — parked in LOBBY at Year 1, Week 1. The clock does NOT
// start at creation: startedAt/endsAt stay null and the tick scheduler skips
// non-RUNNING worlds, so a world waits (at year 1) however long it takes for
// its first player. The first join starts the clock (see joinWorld) — every
// fresh world is therefore joined at Y1W1, never mid-season.
export async function createWorld(prisma, {
  name,
  lengthYears,
  weeksPerDay,
  visibility = 'PUBLIC',
  maxPlayers = 50,
  startingCapital,
  demandMultiplier,
} = {}) {
  validateWorldConfig({ lengthYears, weeksPerDay, visibility, maxPlayers, startingCapital, demandMultiplier });

  // Admin-tunable per-world knobs ride in tickConfig (JSON) — no schema change.
  // Read back at join (starting capital) and every tick (demand multiplier, via
  // the airline's baked-in state.worldDemandMult).
  const tickConfig = {
    startingCapital: startingCapital ?? DEFAULT_STARTING_CAPITAL,
    demandMultiplier: demandMultiplier ?? DEFAULT_DEMAND_MULT,
  };

  return prisma.world.create({
    data: {
      name: name?.trim() || genWorldName(),
      status: 'LOBBY',
      visibility,
      lengthYears,
      weeksPerDay,
      currentWeek: 1,
      currentYear: 1,
      maxPlayers,
      tickConfig,
      joinCode: visibility === 'PRIVATE' ? genJoinCode() : null,
      worldSeed: genWorldSeed(),
      startedAt: null,
      endsAt: null,
    },
  });
}

// Join a world: create the caller's Airline, seeded from the shared engine's
// starting position (the exact solo-game opening). Enforces capacity, join codes,
// world lifecycle, and one-airline-per-account-per-world.
export async function joinWorld(prisma, { account, world, airlineName, hub, joinCode }) {
  if (world.status === 'ENDED' || world.status === 'ARCHIVED') {
    throw httpError(409, 'This world has ended');
  }
  if (world.visibility === 'PRIVATE' && world.joinCode && joinCode !== world.joinCode) {
    throw httpError(403, 'Invalid join code for this private world');
  }

  const existing = await prisma.airline.findUnique({
    where: { worldId_accountId: { worldId: world.id, accountId: account.id } },
  });
  if (existing) throw httpError(409, 'You already have an airline in this world');

  const count = await prisma.airline.count({ where: { worldId: world.id } });
  if (count >= world.maxPlayers) throw httpError(409, 'This world is full');

  // Per-world admin knobs (default when the world predates them / tickConfig empty).
  const tc = world.tickConfig ?? {};
  const startingCapital = tc.startingCapital ?? DEFAULT_STARTING_CAPITAL;
  const demandMultiplier = tc.demandMultiplier ?? DEFAULT_DEMAND_MULT;

  // Seed the airline from the SHARED engine — identical to the solo opening,
  // EXCEPT: no AI competitors. In Headwinds your rivals are the other humans;
  // the tick injects them fresh every week (see humanRivals.mjs).
  const seeded = gameReducer(freshState(), {
    type: 'START_GAME',
    airlineName: airlineName?.trim() || 'New Airline',
    hub,
    enableObjectives: false,
  });

  // Scale the seeded opening balances to this world's starting capital. The engine
  // seeds cash=$15M with marketCap/sharePrice at fixed multiples of it, so scaling
  // marketCap/sharePrice by the same factor keeps them internally consistent.
  const capitalScale = seeded.cash > 0 ? startingCapital / seeded.cash : 1;
  const state = {
    ...seeded,
    cash: startingCapital,
    marketCap: (seeded.marketCap ?? 0) * capitalScale,
    sharePrice: (seeded.sharePrice ?? 0) * capitalScale,
    multiplayer: true,
    competitors: [],
    humanRivals: {},
    encroachments: {},
    // World-level demand multiplier, baked in at join (fixed at creation).
    worldDemandMult: demandMultiplier,
  };

  const airline = await prisma.airline.create({
    data: {
      worldId: world.id,
      accountId: account.id,
      name: state.airlineName,
      hub: state.hub ?? hub,
      state,
      cash: BigInt(Math.round(state.cash ?? 0)),
      marketCap: BigInt(Math.round(state.marketCap ?? 0)),
      week: state.week ?? world.currentWeek,
      joinedWeek: world.currentWeek,
      status: 'ACTIVE',
    },
  });

  // First player starts the clock: LOBBY → RUNNING, startedAt = now. The
  // compare-and-set on status makes a race between two simultaneous first
  // joiners harmless — exactly one sets the clock, both airlines are in.
  if (world.status === 'LOBBY') {
    const startedAt = new Date();
    await prisma.world.updateMany({
      where: { id: world.id, status: 'LOBBY' },
      data: {
        status: 'RUNNING',
        startedAt,
        endsAt: deriveEndsAt(startedAt, world.lengthYears, world.weeksPerDay),
      },
    });
  }

  return airline;
}
