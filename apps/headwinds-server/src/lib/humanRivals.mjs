// Human rivals — the multiplayer competition model.
// ----------------------------------------------------------------------------
// In Headwinds there are NO AI airlines: every player's market rivals are the
// OTHER HUMAN PLAYERS in the world. Before each weekly tick (and on state
// reads), the server derives two views of "everyone else" and injects them
// into each airline's state:
//
//   state.competitors  — competitor-shaped objects (same shape the solo engine
//                        uses for AI carriers) so the Competition/Rivals tab,
//                        marketing share-of-voice, alliances and codeshares all
//                        work unchanged — but showing real people.
//   state.humanRivals  — { [pairKey]: [spec] } route-level offers, in the same
//                        spec shape as encroachment entrants, so the demand
//                        model splits every contested city pair between the
//                        humans actually flying it (see engine weeklyTick).
//   state.multiplayer  — true; tells the engine to skip AI competitor
//                        evolution, AI startups, and AI route encroachment.
//
// Injection is idempotent and rebuilt from scratch every time — a rival's
// view is never trusted from the stored blob.
import { referencePrice } from '@tailwinds/engine/utils/market.js';
import { getAircraftType } from '@tailwinds/engine/data/aircraft.js';
import { calcPositioning } from '@tailwinds/engine/models/positioning.js';
import { isGateScarcity, buildGateMarketViews } from './gateService.mjs';

export const pairKeyOf = (a, b) => [a, b].sort().join('-');

// ── DEV badge ─────────────────────────────────────────────────────────────────
// The game's operators — accounts in ADMIN_EMAILS — wear a teal "🛠 DEV" chip so
// players can see when a dev is flying in their world. Parsed straight from
// process.env (lazily) rather than env.mjs, so this module stays importable with
// no env at all (the engine test harnesses run it that way). Emails are only
// ever compared server-side; payloads carry the boolean, never the address.
const devEmails = () => (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
export const isDevEmail = (email) => devEmails().includes((email ?? '').trim().toLowerCase());

const DEFAULT_QUALITY = 62;
const DEFAULT_SEATS = 170;

// Average configured seats per flight across the rival's fleet assigned to a
// route; falls back to the aircraft type's seat count, then a sane default.
function seatsForRoute(state, route) {
  const aircraft = (state.fleet ?? []).find((a) => a.id === route.aircraftId);
  const type = aircraft ? getAircraftType(aircraft.typeId) : null;
  return type?.seats ?? DEFAULT_SEATS;
}

// Best-effort quality score for a human airline (used for demand share and the
// Rivals tab). Prefers the engine's own last-computed report figures.
function qualityOf(state) {
  const rep = state.lastReport?.reputation?.overall
    ?? state.reputation?.overall
    ?? null;
  if (rep != null) return Math.max(30, Math.min(95, Math.round(rep)));
  return DEFAULT_QUALITY;
}

// ── Player alliances ──────────────────────────────────────────────────────────
// Headwinds has no static AI blocs: alliances are founded and governed by
// players (rows in the Alliance/AllianceMember tables — the DB is the ONLY
// authority on membership; whatever a state blob says is overwritten here).
// Every player alliance grants the same standard benefits, mirroring the solo
// game's alliance economics.

export const PLAYER_ALLIANCE_WEEKLY_FEE = 60_000;
export const PLAYER_ALLIANCE_MAX_MEMBERS = 8;

// Engine-shaped alliance definition for a player alliance. The `hw:` id
// namespace never collides with the solo game's static alliance ids.
export function playerAllianceDef(alliance, activeMemberCount = 0) {
  return {
    id: `hw:${alliance.id}`,
    name: alliance.name,
    color: '#38c9b4',
    icon: '🤝',
    tagline: 'Player alliance',
    description: `A player-founded alliance (${activeMemberCount} member${activeMemberCount === 1 ? '' : 's'}). Members feed each other connecting traffic and share demand on contested routes.`,
    memberIds: [],                     // membership is dynamic — never seeded
    initiationFee: 0,                  // joining is governed by the founder, not cash
    weeklyFee: PLAYER_ALLIANCE_WEEKLY_FEE,
    demandBoostPct: 0.06,
    qualityBonus: 4,
    interlineFraction: 0.65,
    requirements: { minRoutes: 0, minQuality: 0, allowedTiers: ['budget', 'legacy', 'premium'] },
  };
}

// Load a world's alliance graph once: Map<airlineId, { membership, def }> for
// ACTIVE members only (pending requests grant nothing).
export async function loadAllianceMap(prisma, worldId) {
  const alliances = await prisma.alliance.findMany({
    where: { worldId },
    include: { members: true },
  });
  const byAirline = new Map();
  for (const alliance of alliances) {
    const active = alliance.members.filter((m) => m.status === 'ACTIVE');
    const def = playerAllianceDef(alliance, active.length);
    for (const m of active) {
      byAirline.set(m.airlineId, {
        membership: { allianceId: def.id, weeklyFee: def.weeklyFee, role: m.role },
        def,
      });
    }
  }
  return byAirline;
}

// One competitor-shaped object for a human rival (consumed by the Competition
// tab, marketing voice, alliances, codeshares — everywhere state.competitors
// flows in the engine).
export function toHumanCompetitor(airlineRow, { allianceId = null, allianceName = null } = {}) {
  const s = airlineRow.state ?? {};
  const routes = {};
  for (const r of s.routes ?? []) {
    const key = pairKeyOf(r.origin, r.destination);
    const econ = s.routePricing?.[key]?.economy ?? r.ticketPrice ?? null;
    const ref = referencePrice(r.origin, r.destination);
    const freq = r.weeklyFrequency ?? 0;
    const prev = routes[key];
    routes[key] = {
      frequency: (prev?.frequency ?? 0) + freq,
      priceMultiplier: econ && ref ? +(econ / ref).toFixed(3) : (prev?.priceMultiplier ?? 1),
      // Open book: rivals see the ACTUAL fare, not a reverse-engineered multiple.
      economyFare: econ != null ? Math.round(econ) : (prev?.economyFare ?? null),
      seats: prev?.seats ?? seatsForRoute(s, r),
      aircraftType: prev?.aircraftType ?? (s.fleet ?? []).find((a) => a.id === r.aircraftId)?.typeId ?? null,
    };
  }
  const history = (s.financialHistory ?? []).slice(-12);
  const profitHistory = history.map((w) => w.profit ?? 0);
  const lastWeek = history.length ? history[history.length - 1] : null;
  return {
    id: `human:${airlineRow.id}`,
    human: true,                     // marker — never treated as an AI carrier
    // OG veteran badge (playing since the original Tailwinds) — account-level,
    // present only when the airline row was loaded with its account included.
    og: airlineRow.account?.isOG === true,
    // DEV badge — this rival is one of the game's operators (ADMIN_EMAILS).
    dev: isDevEmail(airlineRow.account?.email),
    name: airlineRow.name ?? s.airlineName ?? 'Rival Airline',
    homeHub: airlineRow.hub ?? s.hub ?? null,
    tier: 'legacy',                  // humans set real prices; tier only styles fallbacks
    logoId: s.logoId ?? 'compass',
    baseQualityScore: qualityOf(s),
    cash: Math.round(s.cash ?? 0),
    marketCap: Math.round(s.marketCap ?? 0),
    sharePrice: s.sharePrice ?? null,
    // Markets tab: last 26 weekly share prices (tiny — ~26 floats per rival) so
    // clients can chart every listed airline without extra reads.
    sharePriceHistory: (s.statsHistory ?? [])
      .slice(-26)
      .map((e) => (typeof e.sharePrice === 'number' ? e.sharePrice : null)),
    profitHistory,
    weeklyStats: lastWeek
      ? {
          weeklyProfit: lastWeek.profit ?? 0,
          ...(lastWeek.revenue != null ? { weeklyRevenue: lastWeek.revenue } : {}),
        }
      : null,
    // DB-authoritative (player alliances); a stale blob value never leaks in.
    allianceId,
    allianceName, // display name — 'hw:' ids never resolve in the static bank
    // Market-positioning coordinates (Leisure↔Business, Budget↔Premium), computed
    // with the SAME shared engine formula the player sees for itself, so the
    // Reputation positioning chart can plot this human rival as a real dot.
    positioning: calcPositioning(s),
    routes,
  };
}

// Route-level offer specs per city pair (encroachment-spec shape) for the
// demand model. One spec per rival per pair they fly.
export function toRivalSpecs(airlineRow) {
  const s = airlineRow.state ?? {};
  const quality = qualityOf(s);
  const byPair = {};
  for (const r of s.routes ?? []) {
    const key = pairKeyOf(r.origin, r.destination);
    const econ = s.routePricing?.[key]?.economy ?? r.ticketPrice ?? null;
    const ref = referencePrice(r.origin, r.destination);
    const spec = byPair[key] ?? {
      competitorId: `human:${airlineRow.id}`,
      name: airlineRow.name ?? s.airlineName ?? 'Rival Airline',
      tier: 'legacy',
      qualityScore: quality,
      frequency: 0,
      priceMultiplier: econ && ref ? +(econ / ref).toFixed(3) : 1,
      seatsPerFlight: seatsForRoute(s, r),
    };
    spec.frequency += r.weeklyFrequency ?? 0;
    byPair[key] = spec;
  }
  return byPair;
}

// Build, for EVERY active airline in a world, the pair of views of everyone
// else. Returns Map<airlineId, { competitors, humanRivals, alliance }>.
// `allianceMap` (from loadAllianceMap) makes rivals carry their alliance ids
// and each member's own view carry its membership + def.
export function buildRivalViews(airlines, allianceMap = new Map()) {
  const active = airlines.filter((a) => a.status === 'ACTIVE');
  const comps = new Map(active.map((a) => [
    a.id,
    toHumanCompetitor(a, {
      allianceId: allianceMap.get(a.id)?.membership.allianceId ?? null,
      allianceName: allianceMap.get(a.id)?.def?.name ?? null,
    }),
  ]));
  const specs = new Map(active.map((a) => [a.id, toRivalSpecs(a)]));

  const views = new Map();
  for (const me of airlines) {
    const competitors = [];
    const humanRivals = {};
    for (const other of active) {
      if (other.id === me.id) continue;
      competitors.push(comps.get(other.id));
      for (const [key, spec] of Object.entries(specs.get(other.id))) {
        (humanRivals[key] ??= []).push(spec);
      }
    }
    views.set(me.id, {
      competitors,
      humanRivals,
      alliance: allianceMap.get(me.id) ?? null,
      // The player's OWN badges (shown on their leaderboard row in-game).
      selfOG: me.account?.isOG === true,
      selfDev: isDevEmail(me.account?.email),
    });
  }
  return views;
}

// Inject a rival view into one airline's state blob (pure — returns a copy).
// Alliance membership is DB-authoritative: it's set OR CLEARED on every
// injection, so leaving an alliance takes effect next read/tick and the old
// solo-style JOIN_ALLIANCE state can never linger.
export function withRivals(state, view) {
  return {
    ...state,
    multiplayer: true,
    // Gate scarcity worlds only: the live gate-market view (airport capacities,
    // holdings, open auctions + your sealed bid, marketplace listings). Rebuilt
    // on every read/tick like the rival views; stripped before persistence.
    ...(view?.gateMarket ? { gateMarket: view.gateMarket } : {}),
    // Starter Fleet perk gating. Airlines created before the perk shipped (and
    // any other blob that never recorded the counter) arrive with
    // starterDeliveriesUsed === undefined. Seed it the SAME way the solo
    // reducer's reconcileState does — from the established fleet + pending
    // orders — so a mid-game airline that already has aircraft is NOT handed the
    // "first 2 aircraft deliver instantly" newbie perk. A brand-new airline
    // (empty fleet, no pending) still seeds to 0 and keeps the perk, and a
    // player who has already consumed it carries their real counter (?? keeps it).
    starterDeliveriesUsed: state.starterDeliveriesUsed
      ?? Math.min(2, (state.fleet?.length ?? 0) + (state.pendingOrders?.length ?? 0)),
    competitors: view?.competitors ?? [],
    humanRivals: view?.humanRivals ?? {},
    encroachments: {},               // AI encroachment never exists in Headwinds
    allianceMembership: view?.alliance?.membership ?? null,
    allianceDef: view?.alliance?.def ?? null,
    // The player's own account badges — rebuilt on every injection (like the
    // views above), so a grant/revoke shows up on the next read/tick.
    accountOG: view?.selfOG === true,
    accountDev: view?.selfDev === true,
  };
}

// Inverse of withRivals for PERSISTENCE. The competitor/alliance/badge fields
// injected above are rebuilt from scratch on every read and tick, so persisting
// them bloats each airline's stored blob with a full copy of all its rivals'
// state — O(P^2) storage and egress that grows with the player count. Strip them
// before writing to the DB. withRivals always runs again before the reducer next
// touches this blob, so the stripped fields are always re-injected in time.
// Real gameplay fields that withRivals seeds (multiplayer, starterDeliveriesUsed)
// are intentionally preserved.
export function stripRivals(state) {
  if (!state || typeof state !== 'object') return state;
  const {
    competitors, humanRivals, encroachments,
    allianceMembership, allianceDef, accountOG, accountDev,
    gateMarket,
    ...rest
  } = state;
  return rest;
}

// ── Rival-view cache (API process) ────────────────────────────────────────────
// Every open game polls its airline read, and each uncached build loads EVERY
// active airline's FULL state blob — the single biggest Supabase egress driver.
// A world's rival views are identical for all its players, so build once and
// share. Entries are validated by `stamp` (the caller's cheap sum-of-versions
// aggregate — any decision, tick, join or abandon changes it) plus a short TTL
// fallback for changes that don't bump an airline version (alliance moves).
// The worker bypasses the cache entirely by passing preloaded `airlines`, and
// runs in its own process anyway.
export const RIVAL_VIEW_CACHE_TTL_MS = 30_000;
const viewCache = new Map(); // worldId → { stamp, at, promise }

// One-stop world view builder for API/tick call sites: loads active airlines
// and the alliance graph, returns the per-airline view map.
export async function buildWorldRivalViews(prisma, worldId, { airlines = null, stamp = null, world = null } = {}) {
  // Attach per-airline gate-market views on scarcity worlds (one extra world
  // read when the caller didn't pass the row; non-scarcity worlds skip the
  // gate tables entirely).
  const attachGates = async (rows, allianceMap, views) => {
    const w = world ?? await prisma.world.findUnique({ where: { id: worldId } });
    if (!isGateScarcity(w)) return views;
    const gateViews = await buildGateMarketViews(prisma, worldId, { airlines: rows, allianceMap, world: w });
    for (const [id, view] of views) view.gateMarket = gateViews.get(id) ?? null;
    return views;
  };

  if (airlines) {
    const allianceMap = await loadAllianceMap(prisma, worldId);
    return attachGates(airlines, allianceMap, buildRivalViews(airlines, allianceMap));
  }
  const hit = viewCache.get(worldId);
  if (hit && stamp != null && hit.stamp === stamp && Date.now() - hit.at < RIVAL_VIEW_CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = (async () => {
    const rows = await prisma.airline.findMany({
      where: { worldId, status: 'ACTIVE' },
      // OG + DEV badges. The email never leaves the server — it's only compared
      // against ADMIN_EMAILS here; payloads carry booleans.
      include: { account: { select: { isOG: true, email: true } } },
    });
    const allianceMap = await loadAllianceMap(prisma, worldId);
    return attachGates(rows, allianceMap, buildRivalViews(rows, allianceMap));
  })();
  viewCache.set(worldId, { stamp, at: Date.now(), promise });
  promise.catch(() => viewCache.delete(worldId)); // never cache a failed read
  return promise;
}
