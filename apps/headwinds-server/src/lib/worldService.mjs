// World service: create a world, join a world. One code path for world creation
// (the admin-only POST /worlds — the auto-spawner is gone). All gameplay
// state is produced by the SHARED engine — never reinvented here.
import { gameReducer, freshState } from '@tailwinds/engine/reducer';
import { NWR_FARE_INDEX } from '@tailwinds/engine/utils/market.js';
import {
  validateWorldConfig, deriveEndsAt, genJoinCode, genWorldSeed, genWorldName,
  DEFAULT_STARTING_CAPITAL, DEFAULT_DEMAND_MULT, DEFAULT_WORLD_STAGE,
} from './worldConfig.mjs';
import { rebaseStateCalendar } from './calendar.mjs';
import { splitLogo } from './logoColumn.mjs';
import { seedWorldMarket } from './marketService.mjs';
import { worldEconomyAt } from './worldEconomy.mjs';

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
  scheduledStartAt,
  gateScarcity,
  newWorldRestrictions,
  stage,
} = {}) {
  validateWorldConfig({ lengthYears, weeksPerDay, visibility, maxPlayers, startingCapital, demandMultiplier, scheduledStartAt, gateScarcity, newWorldRestrictions, stage });

  // Admin-tunable per-world knobs ride in tickConfig (JSON) — no schema change.
  // Read back at join (starting capital) and every tick (demand multiplier, via
  // the airline's baked-in state.worldDemandMult).
  const tickConfig = {
    startingCapital: startingCapital ?? DEFAULT_STARTING_CAPITAL,
    demandMultiplier: demandMultiplier ?? DEFAULT_DEMAND_MULT,
    // Optional gate scarcity: finite airport gate capacity, ownership caps,
    // yearly auctions, use-it-or-lose-it, and the player gate market. Fixed at
    // creation — flipping it mid-world would strand everyone's holdings.
    ...(gateScarcity === true ? { gateScarcity: true } : {}),
    // New World Restrictions: lessors carry single-deck, previous-generation
    // aircraft only, and the lease order book is capped at max(5, 25%) of the
    // fleet in service. Fixed at creation — turning it on mid-world would
    // strand order books already placed.
    //
    // ON BY DEFAULT for every new world (A12). The classic model is what let a
    // mid-table airline lease 196 A380s in two clicks; NWR is the balanced rule
    // set and is now the baseline. Pass `newWorldRestrictions: false` explicitly
    // to create a classic world — omitting the field no longer means "off".
    // Worlds created before this flip keep whatever their stored tickConfig
    // says (the join path reads the persisted row), so nothing retro-changes.
    ...(newWorldRestrictions !== false ? { newWorldRestrictions: true } : {}),
    // Cosmetic maturity label (alpha | beta | live) — see WORLD_STAGES. Only
    // written when it differs from the default, and affects no rules, so
    // POST /worlds/:id/stage can move it on a world that's already running.
    ...(stage && stage !== DEFAULT_WORLD_STAGE ? { stage } : {}),
    // Optional preset start instant (ISO). Present → the worker starts this world
    // at that time and joining does NOT start the clock (see joinWorld + tickService).
    ...(scheduledStartAt ? { scheduledStartAt: new Date(scheduledStartAt).toISOString() } : {}),
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

// "OG" and "DEV" are reserved markers — account-level badges the game renders
// itself (gold "✈ OG" veteran chip; teal "🛠 DEV" operator chip). Nobody gets to
// fake them in plain text, so airline names may not contain bracketed look-alikes:
// [OG], (og), {0G}, [ O.G ], [DEV], (d3v), <dev>, etc. Applies to EVERYONE
// (real OGs/devs get the rendered chip; it never lives in a name).
export const OG_NAME_PATTERN = /[[({<][\s._\-]*(?:[O0][\s._\-]*G|D[\s._\-]*[E3][\s._\-]*V)[\s._\-]*[\])}>]/i;

// ── Seeding an opening position ──────────────────────────────────────────────
// The exact solo-game opening, rebased onto a live world's calendar and economy.
//
// Extracted from joinWorld because a RESTART needs byte-identical seeding: a
// re-founded airline must land on the same fuel index, the same 52-week price
// history, the same demand multiplier and the same fare ladder as the rivals it
// is about to compete with. Duplicating any part of this would silently hand
// (or deny) an advantage — the fuel backfill alone was worth a free hedge at
// 1.0x, see the "One world, one economy" note below.
//
// PURE: no database access, no reads of world.status, no assumption about
// whether the airline row exists yet. Everything it needs is on `world`.
//
// `fareIndexOverride` exists for the restart path only. The index is seeded from
// tickConfig at join, but a live world's real ladder is read back off an
// existing airline's blob (humanRivals.mjs setFareIndex). If a world was ever
// retuned, re-seeding from tickConfig would give the re-founded airline a
// different ladder from everyone else, so restart carries the old blob's value
// forward instead.
export function seedAirlineState(world, { airlineName, hub, fareIndexOverride } = {}) {
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
    // Multiplayer starter board: 10 objectives with cash bonuses (see
    // MULTIPLAYER_OBJECTIVE_TEMPLATES in the engine's data/objectives.js).
    enableObjectives: true,
    objectiveSet: 'multiplayer',
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
    // Gate scarcity flag, baked in at join — the engine's capacity/cap/lockout
    // checks and use-it-or-lose-it only run when this is true.
    ...(tc.gateScarcity === true ? { gateScarcityWorld: true } : {}),
    // New World Restrictions flag, baked in at join — the engine's lease
    // eligibility and order-book checks only run when this is true.
    // Founding week: the airline's OWN age clock, set to the world's current week
    // at join. Drives the labour seniority scale — a player joining a year-17
    // world founded their airline today and must start on starting wages.
    foundedAbsWeek: (world.currentYear - 1) * 52 + world.currentWeek,
    ...(tc.newWorldRestrictions === true ? {
      newWorldRestrictions: true,
      // Trims the whole reference-fare ladder (passenger + cargo). Same demand,
      // lower prices — the fare-to-cost ratio is where the margin gap lives.
      // SEEDED AT JOIN: retuning a live world needs tools/rebase-world-fare-index.mjs.
      fareIndex: tc.fareIndex ?? NWR_FARE_INDEX,
    } : {}),
  };

  // ── One world, one calendar ─────────────────────────────────────────────────
  // Everyone in a world shares a date. A fresh blob is seeded at Year 1 Week 1
  // (the solo opening), so a player joining a world already at Y3W12 would
  // otherwise run their own private calendar for the rest of the season — the
  // top bar would read a different date to their rivals', and because the engine
  // derives seasonality from state.week, they would literally be flying a
  // different season in the same market. Rebase the seeded blob onto the world
  // clock instead: a late joiner starts in the world's here-and-now.
  //
  // rebaseStateCalendar also shifts anything scheduled in absolute weeks, which
  // costs nothing on a fresh blob (no orders, no hedges, no history yet) but
  // keeps this identical to the backfill path in tools/rebase-airline-calendars.mjs.
  const { state: rebasedState } = rebaseStateCalendar(state, {
    year: world.currentYear,
    week: world.currentWeek,
  });

  // ── One world, one economy ──────────────────────────────────────────────────
  // The fuel/market walks are world-level and deterministic (replayed from
  // worldSeed on every tick) but STORED per-airline, and a fresh blob is seeded
  // at fuel index 1.0 with no history. Without this backfill a late joiner saw
  // a fuel index of 1.000× and an empty price chart until their first tick —
  // and could lock hedges at 1.0× regardless of where world fuel actually was
  // (BUY_HEDGE prices off state.fuelPrice.index). Replay the walk up to the
  // world's current week so the joiner starts on exactly the economy their
  // rivals' blobs carry: same index, same 52-week history, same sentiment.
  const joinLinearWeek = (world.currentYear - 1) * 52 + world.currentWeek;
  const economy = worldEconomyAt(world.worldSeed ?? world.id, joinLinearWeek);
  const worldDatedState = {
    ...rebasedState,
    fuelPrice:   economy.fuelPrice,
    marketIndex: economy.marketIndex,
  };

  if (fareIndexOverride != null && worldDatedState.fareIndex != null) {
    worldDatedState.fareIndex = fareIndexOverride;
  }
  return worldDatedState;
}

// Join a world: create the caller's Airline, seeded from the shared engine's
// starting position (the exact solo-game opening). Enforces capacity, join codes,
// world lifecycle, and one-airline-per-account-per-world.
export async function joinWorld(prisma, { account, world, airlineName, hub, joinCode }) {
  if (OG_NAME_PATTERN.test(airlineName ?? '')) {
    throw httpError(400, 'OG and DEV tags are reserved — they appear automatically as badges, not in the airline name.');
  }
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

  // Only living airlines hold a seat: a world with 25 active carriers and 25
  // bankruptcies is half empty, not full. Re-foundings stay exempt from this
  // check (they resurrect a row that was admitted when it was created), so a
  // full world can briefly exceed maxPlayers if the dead rise — accepted:
  // maxPlayers exists to bound how many airlines FLY, and it still does.
  const count = await prisma.airline.count({ where: { worldId: world.id, status: 'ACTIVE' } });
  if (count >= world.maxPlayers) throw httpError(409, 'This world is full');

  // Seed the opening position — see seedAirlineState. Shared verbatim with the
  // restart path so a re-founded airline lands on the same economy as its rivals.
  const worldDatedState = seedAirlineState(world, { airlineName, hub });
  const tc = world.tickConfig ?? {};

  let airline;
  try {
    airline = await prisma.airline.create({
      data: {
        worldId: world.id,
        accountId: account.id,
        name: worldDatedState.airlineName,
        hub: worldDatedState.hub ?? hub,
        // splitLogo: the engine's fresh-state template carries customLogo: null —
        // the key never persists inside the blob (lib/logoColumn.mjs); the
        // column's default null is the same "no upload yet".
        state: splitLogo(worldDatedState).state,
        cash: BigInt(Math.round(worldDatedState.cash ?? 0)),
        marketCap: BigInt(Math.round(worldDatedState.marketCap ?? 0)),
        // Linear week index, matching what the tick writes (see tickService's
        // weekIndex) — NOT the week-of-year, which would read as week 1 for a
        // world in its first January of year 5.
        week: (world.currentYear - 1) * 52 + world.currentWeek,
        // Also the LINEAR index, so "joined at week 137 of a 520-week world" is
        // answerable. It used to store the week-of-year, which threw the year
        // away (a join in year 3 recorded as "week 12").
        joinedWeek: (world.currentYear - 1) * 52 + world.currentWeek,
        status: 'ACTIVE',
      },
    });
  } catch (e) {
    // A same-account double-submit races the (worldId, accountId) unique index —
    // return the clean 409 the pre-check would have, not a raw 500.
    if (e?.code === 'P2002') throw httpError(409, 'You already have an airline in this world');
    throw e;
  }

  // Gate scarcity: mirror the starter hub gate (seeded by START_GAME above)
  // into the world's gate ledger. Part of the home-hub guarantee, so it seeds
  // even at a full airport (the overshoot counts toward fullness).
  if (tc.gateScarcity === true) {
    const { seedHubGate } = await import('./gateService.mjs');
    await seedHubGate(prisma, world.id, worldDatedState.hub ?? hub, airline.id);
  }

  // First player starts the clock: LOBBY → RUNNING, startedAt = now. The
  // compare-and-set on status makes a race between two simultaneous first
  // joiners harmless — exactly one sets the clock, both airlines are in.
  // A scheduled world (tickConfig.scheduledStartAt) is NOT started by joining — the
  // worker flips it LOBBY→RUNNING at the preset time. Only classic "starts on first
  // join" worlds start their clock here.
  if (world.status === 'LOBBY' && !world.tickConfig?.scheduledStartAt) {
    const startedAt = new Date();
    await prisma.world.updateMany({
      where: { id: world.id, status: 'LOBBY' },
      data: {
        status: 'RUNNING',
        startedAt,
        endsAt: deriveEndsAt(startedAt, world.lengthYears, world.weeksPerDay),
      },
    });
    // Seed the world's float pool — the finite counterparty for share trading —
    // for the world's FULL capacity. This runs on the first join that starts the
    // clock, AFTER the joiner's row exists but before anyone else has joined, so
    // count(ACTIVE) here is 1: a 50-player world was seeding ~1/50th of the
    // intended liquidity and `poolCash`-short refusals then dominated stock and
    // capital actions all season. maxPlayers is the intended counterparty size
    // (scheduled-start worlds already seed lazily at real count in ensureWorldMarket).
    await seedWorldMarket(prisma, world.id, world.maxPlayers);
  }

  return airline;
}
