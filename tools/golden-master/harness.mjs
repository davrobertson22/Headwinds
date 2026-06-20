// Golden-master harness
// ----------------------------------------------------------------------------
// Runs a fixed, scripted game through the engine with ALL randomness seeded and
// the clock stubbed, so the result is byte-for-byte reproducible. The point:
// when you later relocate the engine into @tailwinds/engine (Phase 0), re-running
// this must produce the IDENTICAL snapshot — proving the move changed nothing.
//
// It imports the reducer through the shared engine package, so it always tests
// whatever the package currently points at.
import { gameReducer, freshState } from '../../packages/engine/index.mjs';

// ── Seeded RNG (mulberry32) — same algorithm the strategy-sim harness uses ───
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stub Math.random AND Date.now so uid()/event-ids are deterministic too.
function installDeterminism(seed) {
  const rng = makeRng(seed);
  const origRandom = Math.random;
  const origNow = Date.now;
  let clock = 1_700_000_000_000;           // fixed epoch
  Math.random = rng;
  Date.now = () => (clock += 1000);        // monotonic, deterministic per call
  return () => { Math.random = origRandom; Date.now = origNow; };
}

// ── The fixed scenario ───────────────────────────────────────────────────────
// Deterministic: start an airline, lease an aircraft, open a gate + a route,
// then advance many weeks. Exercises competitors, fuel, events, finance, market
// cap, demand allocation, route economics — a broad slice of the engine.
export function runScenario({ seed = 0xC0FFEE, weeks = 60 } = {}) {
  const restore = installDeterminism(seed);
  try {
    let s = gameReducer(freshState(), {
      type: 'START_GAME', airlineName: 'GoldenAir', hub: 'JFK', enableObjectives: true,
    });
    s = gameReducer(s, { type: 'LEASE_AIRCRAFT', typeId: 'a320ceo' });
    const aircraftId = s.fleet[0]?.id;
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'LAX' });
    s = gameReducer(s, {
      type: 'ADD_ROUTE', aircraftId, origin: 'JFK', destination: 'LAX', weeklyFrequency: 7,
    });
    for (let w = 0; w < weeks; w++) {
      s = gameReducer(s, { type: 'ADVANCE_WEEK' });
    }
    return s;
  } finally {
    restore();
  }
}

// A curated, human-readable projection of the final state for diffing.
export function projection(s) {
  const r = s.lastReport ?? {};
  return {
    week: s.week, year: s.year,
    phase: s.phase,
    cash: round(s.cash),
    marketCap: round(s.marketCap),
    sharePrice: round4(s.sharePrice),
    awareness: round4(s.awareness),
    fuelIndex: round4(s.fuelPrice?.index),
    fleetCount: s.fleet?.length ?? 0,
    routeCount: s.routes?.length ?? 0,
    competitorCount: s.competitors?.length ?? 0,
    activeEvents: s.activeEvents?.length ?? 0,
    report: {
      revenue: round(r.revenue ?? r.totalRevenue),
      expenses: round(r.expenses ?? r.totalExpenses),
      profit: round(r.profit ?? r.netProfit),
    },
  };
}

const round  = (n) => (typeof n === 'number' ? Math.round(n) : n);
const round4 = (n) => (typeof n === 'number' ? Math.round(n * 1e4) / 1e4 : n);
