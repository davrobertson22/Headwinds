// GET /worlds/:id/rivals/:airlineId — what the endpoint actually needs to read.
//
// The handler used to load the rival's row with `findUnique({ include: ... })`
// and no `select`, which pulls every column including `state` — the whole save
// blob, averaging ~523 kB in production — to serve a few kB of public network
// data. The endpoint was reachable without authentication, so that was an
// unmetered egress lever: a loop over a world's airline ids pulled tens of MB
// out of Supabase per pass. (The visibility gate in lib/access.mjs closes the
// PRIVATE-world half of the same hole; this closes the volume half, which
// applies to public worlds too.)
//
// Two reads instead of one:
//   1. the row, with an explicit column list — everything serializeAirline()
//      emits plus the account badges and the world's visibility, and NOT `state`;
//   2. the five state subtrees the response renders, projected IN POSTGRES so
//      the blob never crosses the wire. Same idiom as humanRivals.loadRivalRows,
//      including its `$queryRaw`-less fallback for the test doubles.
//
// What the response renders off the blob, and nothing else:
//   state.routes         → routeNetwork (origin, destination, frequency, fare)
//   state.routePricing   → the economy fare per pair
//   state.cargoRoutes    → cargoNetwork
//   state.hubs           → hubs (keys only)
//   state.fleet[].typeId → fleetByType + the fleet count
// Cash, loans, hedges, budgets, per-route P&L and history are NOT read here and
// are not fetched — the same rule lib/publicDecisions.mjs enforces for moves.

/** Columns the rival-profile response is built from. `state` is deliberately absent. */
export const RIVAL_PROFILE_SELECT = {
  id: true,
  worldId: true,
  name: true,
  hub: true,
  cash: true,
  marketCap: true,
  week: true,
  status: true,
  joinedWeek: true,
  restarts: true,
  restartedWeek: true,
  // The profile link target (#/players/:accountId) — public by design since
  // the 2026-08-24 player-profiles feature.
  accountId: true,
  // OG + DEV badges. The email never leaves the server — it is only compared
  // against ADMIN_EMAILS. `careerStats` drives the cross-world career badges
  // (Champion / Veteran / Phoenix …) shown on the dossier — computed through
  // publicCareer so a private-world championship never leaks.
  account: { select: { isOG: true, email: true, careerStats: true } },
  // The visibility gate (lib/access.mjs) needs the world on this same read
  // rather than a second round trip.
  world: { select: { id: true, visibility: true } },
};

/** The subtree shape both the SQL projection and the JS fallback produce. */
function shapeProfileState(raw) {
  const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const fleet = Array.isArray(raw?.fleet) ? raw.fleet : [];
  return {
    routes:       Array.isArray(raw?.routes) ? raw.routes : [],
    routePricing: isPlainObject(raw?.routePricing) ? raw.routePricing : {},
    cargoRoutes:  Array.isArray(raw?.cargoRoutes) ? raw.cargoRoutes : [],
    hubs:         isPlainObject(raw?.hubs) ? raw.hubs : {},
    // Only the type id is read (fleetByType + the count), so only the type id
    // is carried — a rival's cabin layouts and tail ages are not this
    // endpoint's business.
    fleet:        fleet.map((a) => ({ typeId: a?.typeId ?? null })),
  };
}

/**
 * JS twin of the SQL projection below. It IS the implementation for callers
 * holding a prisma double with no $queryRaw (the test harnesses), and it is what
 * tools/server-hardening-test.mjs drives to prove the trim keeps everything the
 * response renders and drops everything it does not.
 */
export function projectRivalProfileState(state) {
  return shapeProfileState(state && typeof state === 'object' ? state : {});
}

/**
 * The rival's public network, projected in Postgres. Never selects `state`
 * whole. Returns the same shape as projectRivalProfileState().
 */
export async function loadRivalProfileState(prisma, airlineId) {
  if (typeof prisma.$queryRaw !== 'function') {
    // Test double: take the ORM path and trim in JS so both branches agree.
    const row = await prisma.airline.findUnique({
      where: { id: airlineId },
      select: { state: true },
    });
    return projectRivalProfileState(row?.state);
  }
  // `->` on a missing key yields SQL NULL (→ JS null), which shapeProfileState
  // turns back into the empty array/object the handler already tolerated. The
  // jsonb_typeof guard + `WITH ORDINALITY ... ORDER BY ord` on the fleet mirror
  // loadRivalRows(): jsonb_agg over unordered SRF output does not guarantee
  // element order, and a non-array `fleet` would otherwise raise.
  const rows = await prisma.$queryRaw`
    SELECT a.state->'routes'       AS "routes",
           a.state->'routePricing' AS "routePricing",
           a.state->'cargoRoutes'  AS "cargoRoutes",
           a.state->'hubs'         AS "hubs",
           CASE WHEN jsonb_typeof(a.state->'fleet') = 'array'
                THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('typeId', e->'typeId') ORDER BY ord), '[]'::jsonb)
                        FROM jsonb_array_elements(a.state->'fleet') WITH ORDINALITY AS fl(e, ord))
                ELSE '[]'::jsonb END AS "fleet"
      FROM "Airline" a
     WHERE a.id = ${airlineId}
     LIMIT 1`;
  return shapeProfileState(rows?.[0] ?? {});
}
