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

export const pairKeyOf = (a, b) => [a, b].sort().join('-');

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
export function toHumanCompetitor(airlineRow, { allianceId = null } = {}) {
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
      aircraftType: prev?.aircraftType ?? (s.fleet ?? []).find((a) => a.id === r.aircraftId)?.typeId ?? null,
    };
  }
  const profitHistory = (s.financialHistory ?? []).slice(-12).map((w) => w.profit ?? 0);
  return {
    id: `human:${airlineRow.id}`,
    human: true,                     // marker — never treated as an AI carrier
    name: airlineRow.name ?? s.airlineName ?? 'Rival Airline',
    homeHub: airlineRow.hub ?? s.hub ?? null,
    tier: 'legacy',                  // humans set real prices; tier only styles fallbacks
    logoId: s.logoId ?? 'compass',
    baseQualityScore: qualityOf(s),
    cash: Math.round(s.cash ?? 0),
    marketCap: Math.round(s.marketCap ?? 0),
    profitHistory,
    weeklyStats: profitHistory.length
      ? { weeklyProfit: profitHistory[profitHistory.length - 1] }
      : null,
    // DB-authoritative (player alliances); a stale blob value never leaks in.
    allianceId,
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
    toHumanCompetitor(a, { allianceId: allianceMap.get(a.id)?.membership.allianceId ?? null }),
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
    views.set(me.id, { competitors, humanRivals, alliance: allianceMap.get(me.id) ?? null });
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
    competitors: view?.competitors ?? [],
    humanRivals: view?.humanRivals ?? {},
    encroachments: {},               // AI encroachment never exists in Headwinds
    allianceMembership: view?.alliance?.membership ?? null,
    allianceDef: view?.alliance?.def ?? null,
  };
}

// One-stop world view builder for API/tick call sites: loads active airlines
// and the alliance graph, returns the per-airline view map.
export async function buildWorldRivalViews(prisma, worldId, { airlines = null } = {}) {
  const rows = airlines ?? await prisma.airline.findMany({
    where: { worldId, status: 'ACTIVE' },
  });
  const allianceMap = await loadAllianceMap(prisma, worldId);
  return buildRivalViews(rows, allianceMap);
}
