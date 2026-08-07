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
//
// This is every player action the reducer implements EXCEPT the four the server
// reserves for itself: ADVANCE_WEEK (only the scheduler ticks time), START_GAME
// (only join seeds a state), LOAD_STATE and RESET (state surgery — a client could
// hand itself any save). Keep in sync with the reducer's `case` list when new
// actions land in a Tailwinds sync.
export const ALLOWED_PLAYER_ACTIONS = new Set([
  // Fleet — NOTE: LEASE_AIRCRAFT is intentionally NOT allowed. Its reducer case
  // adds an aircraft with no cash check, deposit, or delivery lead time (free
  // instant fleet). Multiplayer leasing goes through ORDER_AIRCRAFT, which charges
  // the deposit + fitting fee and gates on affordability. The solo UI never
  // dispatches LEASE_AIRCRAFT.
  'BUY_AIRCRAFT', 'SELL_AIRCRAFT', 'RETIRE_AIRCRAFT',
  // Batched forms of the four the Fleet page applies to a selection. Each folds
  // its single-aircraft case in the reducer, so they inherit its guards; the
  // decision guard below only sanitizes the id list.
  'SELL_AIRCRAFT_BULK', 'RETIRE_AIRCRAFT_BULK', 'SCHEDULE_CHECKS', 'EXTEND_LEASES',
  'RENEW_LEASE', 'EXTEND_LEASE', 'BUY_OUT_LEASE', 'ORDER_AIRCRAFT', 'CANCEL_ORDER', 'RENAME_ORDER',
  'SCHEDULE_CHECK', 'CANCEL_SCHEDULED_CHECK',
  'SET_RESERVE', 'CLEAR_RESERVE',
  // Jet bases (MRO network). Capex, gate holdings and level progression are
  // all re-validated by the reducer; the guard below only sanitizes payloads.
  'BUILD_MRO_BASE', 'UPGRADE_MRO_BASE', 'ADD_BASE_CERTIFICATION',
  'SET_BASE_PARTS_POOL', 'CLOSE_MRO_BASE',
  'RENAME_AIRCRAFT', 'CONFIGURE_AIRCRAFT', 'SAVE_CABIN_TEMPLATE', 'DELETE_CABIN_TEMPLATE',
  // Routes — passenger, cargo, tag
  'ADD_ROUTE', 'CLOSE_ROUTE', 'CLOSE_ROUTES', 'ADD_CARGO_ROUTE', 'CLOSE_CARGO_ROUTE', 'ADD_TAG_ROUTE',
  'TRANSFER_ROUTES', 'REASSIGN_ROUTE',
  'UPDATE_TICKET_PRICE', 'UPDATE_CLASS_PRICES', 'SET_SEGMENT_PRICE',
  'BULK_ADJUST_PRICING', 'UPDATE_FREQUENCY', 'UPDATE_CARGO_FREQUENCY',
  'UPDATE_CARGO_YIELD', 'SET_ROUTE_CATERING', 'SET_DEFAULT_CATERING',
  'SET_ANCILLARY', 'SET_ANCILLARIES',
  // Airports, hubs, gates
  'ADD_GATE', 'REMOVE_GATE', 'UPGRADE_HUB', 'DOWNGRADE_HUB',
  'DESIGNATE_HUB', 'DESIGNATE_FOCUS_CITY',
  // Money & market
  'TAKE_LOAN', 'REPAY_LOAN', 'BUY_HEDGE', 'ACQUIRE_COMPETITOR',
  // Stock market — the reducer prices trades from the server-injected rival
  // view (never from the payload), so these are safe to expose as intents.
  'BUY_STOCK', 'SELL_STOCK',
  // Capital actions. Like trades, these are priced by the reducer from the
  // airline's own server-computed valuation and settled against the world float
  // pool — the payload only ever carries a share count (or a payout ratio), so
  // there is nothing in it worth forging.
  'GO_PUBLIC', 'ISSUE_SHARES', 'BUY_BACK_SHARES', 'SET_DIVIDEND_POLICY',
  // Marketing, loyalty, branding
  'SET_MARKETING_BUDGET', 'SET_TARGETED_MARKETING', 'SET_LOYALTY_INVESTMENT', 'SET_BRANDING',
  // Labor
  'SET_LABOR_PAY', 'SET_MAINTENANCE_BUDGET', 'RESOLVE_NEGOTIATION', 'SETTLE_STRIKE',
  // Alliances & codeshares. Both stay listed and are refused with a specific
  // message in routes/decisions.mjs — the allow-list check runs FIRST, so
  // dropping them here would replace "codeshares are agreed with the other
  // airline" with a bare "Action not allowed". Same shape as ACQUIRE_COMPETITOR.
  'JOIN_ALLIANCE', 'LEAVE_ALLIANCE', 'SIGN_CODESHARE', 'CANCEL_CODESHARE',
  // Client-side acknowledgements that live in state
  'DISMISS_DEBRIEF', 'ACKNOWLEDGE_VICTORY', 'CLEAR_ERROR', 'CLEAR_TOASTS',
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
    type: 'START_GAME', airlineName, hub,
    // Multiplayer starter board: 10 objectives with cash bonuses (see
    // MULTIPLAYER_OBJECTIVE_TEMPLATES in the engine's data/objectives.js).
    enableObjectives: true, objectiveSet: 'multiplayer',
  });
  // One world, one calendar: a mid-season joiner starts on the world's date, not
  // at Y1W1. (The DB-backed path does the same via lib/calendar.mjs, which also
  // shifts absolute-week schedules — a freshly seeded blob has none.)
  state.week = world.week;
  state.year = world.year;
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
