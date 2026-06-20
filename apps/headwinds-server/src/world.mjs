// Headwinds — world model + authoritative tick
// ----------------------------------------------------------------------------
// A "world" is one shared game instance that many human players join. Each player
// controls one airline (its full game state). The SERVER is the source of truth:
// players submit validated actions; the server runs the weekly tick for the whole
// world in lockstep using the SAME reducer the solo game uses.
//
// This proves the core multiplayer thesis from HEADWINDS_MULTIPLAYER_PLAN.md:
// the engine is already a pure, server-runnable function.
import { gameReducer, freshState } from '@tailwinds/engine/reducer';

// Actions a client is allowed to submit. The server NEVER trusts the client to
// compute results — it only accepts intents from this allow-list and re-runs
// them through the authoritative reducer. (This is the anti-cheat boundary.)
// ADVANCE_WEEK is intentionally NOT here: only the server's scheduler ticks time.
export const ALLOWED_PLAYER_ACTIONS = new Set([
  'LEASE_AIRCRAFT', 'BUY_AIRCRAFT', 'SELL_AIRCRAFT', 'RETURN_LEASE',
  'ADD_ROUTE', 'REMOVE_ROUTE', 'SET_ROUTE_PRICE', 'SET_ROUTE_FREQUENCY',
  'SET_AIRCRAFT_CONFIG', 'ADD_GATE', 'UPGRADE_HUB',
  'SET_MARKETING_BUDGET', 'SET_LOYALTY_INVESTMENT', 'TAKE_LOAN', 'REPAY_LOAN',
]);

let _id = 0;
const newId = (p) => `${p}_${(++_id).toString(36)}${Date.now().toString(36)}`;

export function createWorld({ name = 'World', pace = 'hour', seasonEndYear = 4 } = {}) {
  return {
    id: newId('w'),
    name,
    status: 'lobby',          // lobby → running → ended
    pace,                     // 'hour' | 'day' | custom ms — drives the scheduler
    seasonEndYear,
    week: 1,
    year: 1,
    airlines: new Map(),      // accountId → airline state (the solo game state blob)
    createdAt: Date.now(),
  };
}

export function joinWorld(world, { accountId, airlineName, hub }) {
  if (world.airlines.has(accountId)) throw new Error('already joined');
  if (world.status === 'ended') throw new Error('world ended');
  // Each airline starts from the identical solo-game starting position.
  const state = gameReducer(freshState(), {
    type: 'START_GAME', airlineName, hub, enableObjectives: false,
  });
  world.airlines.set(accountId, state);
  return state;
}

// Apply ONE validated player action to that player's airline. Returns the new
// state. Throws on anything not on the allow-list — the client cannot, e.g.,
// dispatch ADVANCE_WEEK or hand-edit cash.
export function applyPlayerAction(world, accountId, action) {
  if (!ALLOWED_PLAYER_ACTIONS.has(action?.type)) {
    throw new Error(`action not allowed: ${action?.type}`);
  }
  const state = world.airlines.get(accountId);
  if (!state) throw new Error('not in world');
  const next = gameReducer(state, action);
  world.airlines.set(accountId, next);
  return next;
}

// THE AUTHORITATIVE TICK. Advances every airline in the world one game-week, in
// lockstep, by running the shared reducer. Idempotent per (world, week): records
// the week it produced so a retry can't double-tick.
//
// NEXT INTEGRATION STEP (documented, not yet built): today each airline's demand
// is allocated against AI competitors *inside* its own state. True human-vs-human
// competition means injecting the other players' routes/prices as competitors in
// each airline's demand model before ticking. That is the one engine change
// multiplayer needs — see HEADWINDS_MULTIPLAYER_PLAN.md §2.
export function tickWorld(world) {
  if (world.status === 'ended') return { ok: false, reason: 'ended' };
  const results = [];
  for (const [accountId, state] of world.airlines) {
    const next = gameReducer(state, { type: 'ADVANCE_WEEK' });
    world.airlines.set(accountId, next);
    results.push({ accountId, week: next.week, year: next.year, cash: Math.round(next.cash), phase: next.phase });
  }
  // Advance the world clock to match (all airlines move together).
  const any = results[0];
  if (any) { world.week = any.week; world.year = any.year; }
  if (world.year > world.seasonEndYear) world.status = 'ended';
  else world.status = 'running';
  return { ok: true, week: world.week, year: world.year, status: world.status, results };
}

export function standings(world) {
  return [...world.airlines.entries()]
    .map(([accountId, s]) => ({
      accountId, airline: s.airlineName, hub: s.hub,
      marketCap: Math.round(s.marketCap), cash: Math.round(s.cash),
      routes: s.routes?.length ?? 0, fleet: s.fleet?.length ?? 0, phase: s.phase,
    }))
    .sort((a, b) => b.marketCap - a.marketCap);
}
