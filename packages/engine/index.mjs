// @tailwinds/engine
// ----------------------------------------------------------------------------
// Single shared entrypoint for the simulation engine and reference data.
// Consumed by BOTH games:
//   • Tailwinds (solo)      — runs this in the browser (today, via src/ directly)
//   • Headwinds (multiplayer) — runs this on the server as the authoritative tick
//
// Submodules are namespaced to avoid name collisions (e.g. `referencePrice`
// exists in both simulation and market). Usage:
//
//   import { gameReducer, freshState, simulation, demand } from '@tailwinds/engine';
//   const report = simulation.weeklyTick(state);
//
// PHASE 0 EXTRACTION (done): the pure simulation + reference-data modules now
// physically live in ./src/{utils,models,data}/ inside this package, and the old
// src/ paths are thin re-export shims that forward here (kept so the solo app's
// existing import sites work unchanged). The reducer (./reducer.mjs) is still a
// facade over src/store/_engine.generated.mjs — extracting that is the remaining
// Phase 0 step. The public surface below is unchanged.

// ── Authoritative reducer (the game "tick") ─────────────────────────────────
export { gameReducer, freshState } from './reducer.mjs';

// ── Core simulation ─────────────────────────────────────────────────────────
export * as simulation from './src/utils/simulation.js';
export * as market      from './src/utils/market.js';
export * as fuel        from './src/utils/fuel.js';
export * as finance     from './src/utils/financeProjection.js';

// ── World models ────────────────────────────────────────────────────────────
export * as network      from './src/models/network.js';
export * as encroachment from './src/models/encroachment.js';
export * as demand       from './src/models/demand.js';

// ── Reference data ──────────────────────────────────────────────────────────
export * as airports            from './src/data/airports.js';
export * as aircraft            from './src/data/aircraft.js';
export * as labor               from './src/data/labor.js';
export * as families            from './src/data/families.js';
export * as catering            from './src/data/catering.js';
export * as alliances           from './src/data/alliances.js';
export * as overhead            from './src/data/overhead.js';
export * as objectives          from './src/data/objectives.js';
export * as events              from './src/data/events.js';
export * as airportRestrictions from './src/data/airportRestrictions.js';
