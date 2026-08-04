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
import { referencePrice, cargoReferenceYield, TOTAL_SHARES, setFareIndex, setNwrYieldChoke } from '@tailwinds/engine/utils/market.js';
import { getAircraftType } from '@tailwinds/engine/data/aircraft.js';
import { calcPositioning } from '@tailwinds/engine/models/positioning.js';
import { stateBrandReach } from '@tailwinds/engine/utils/simulation.js';
import { HUB_TIERS } from '@tailwinds/engine/models/demand.js';
import { isGateScarcity, buildGateMarketViews } from './gateService.mjs';
import { poolSharesFor, poolSummary } from './marketService.mjs';

// ── Rival-facing identity, per GENERATION ────────────────────────────────────
// The id every other player sees this airline as, and the key their portfolio
// holdings, codeshare agreements and trades are filed under.
//
// A re-founded airline (see restartAirline) reuses its database row, so a bare
// `human:<dbId>` would make the new company indistinguishable from the one that
// just went under — rivals holding stock in the bankrupt carrier would silently
// wake up owning a stake in a brand-new, fully-funded airline, and a codeshare
// signed with the dead one would keep paying out.
//
// Appending the generation fixes that with no new settlement code, because the
// engine ALREADY force-liquidates any holding whose competitor id vanishes from
// the rival set: reducer.mjs's delisting sweep pays the holder out at
// STOCK_MARKET.DELIST_HAIRCUT and drops the position. Changing the id makes the
// old company delist exactly as if it had left the world, on the holder's very
// next tick, and closes the race where a player who restarts before their
// rivals tick would otherwise never delist at all.
//
// Generation 0 is spelled bare so that every airline that has never restarted —
// i.e. all of them, before this ship — keeps byte-identical ids and no stored
// holding, agreement or pool entry has to be migrated.
//
// The raw database id is recovered by marketService.poolKeyOf, which strips both
// the prefix and this suffix. Any new parser of a competitor id MUST go through
// it (or the client-side twin in Competition.jsx) rather than slicing 'human:'.
export function rivalIdOf(airlineRow) {
  const gen = Number(airlineRow?.restarts ?? 0) || 0;
  return gen > 0 ? `human:${airlineRow.id}~g${gen}` : `human:${airlineRow.id}`;
}


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

// Seats on the specific tail assigned to a route; falls back to a sane default.
// NOTE: a city pair can be flown by several aircraft of different sizes, so
// callers must weight this by each route's frequency rather than applying one
// tail's seat count to the pair's whole schedule.
function seatsForRoute(state, route) {
  return cabinForRoute(state, route).bodies;
}

// The real cabin flown on a route: total bodies and how many of them are premium
// seats. Rivals used to be modelled with the aircraft TYPE's max seat count and a
// business cabin invented from their tier — so a rival flying a premium-heavy
// config looked bigger than it is, and an all-economy rival was credited with a
// business cabin it doesn't sell. Both now come from the actual config.
function cabinForRoute(state, route) {
  const aircraft = (state.fleet ?? []).find((a) => a.id === route.aircraftId);
  const type = aircraft ? getAircraftType(aircraft.typeId) : null;
  const cfg = aircraft?.config ?? null;
  if (!cfg) return { bodies: type?.seats ?? DEFAULT_SEATS, business: 0, hasCabinData: false };
  const bodies = (cfg.firstClass ?? 0) + (cfg.businessClass ?? 0)
               + (cfg.premiumEconomy ?? 0) + (cfg.economy ?? 0);
  // "Business" for the demand model = every premium seat above economy, matching
  // how the engine builds the player's own businessSeats on a pair.
  const business = (cfg.firstClass ?? 0) + (cfg.businessClass ?? 0) + (cfg.premiumEconomy ?? 0);
  return {
    bodies: bodies > 0 ? bodies : (type?.seats ?? DEFAULT_SEATS),
    business,
    hasCabinData: bodies > 0,
  };
}

// The premium fare a rival actually charges on a pair, or null when they sell no
// premium cabin. Mirrors the player's own classPrices lookup.
function businessFareFor(state, key, route) {
  const p = state.routePricing?.[key];
  return p?.businessClass ?? p?.firstClass ?? p?.premiumEconomy ?? route?.classPrices?.businessClass ?? null;
}

// ── Cargo network (public) ────────────────────────────────────────────────────
// A rival's freight lanes, folded to one entry per city pair — the same shape as
// the passenger `routes` map so the Rivals map/table can render both from one
// loop. Public under the same rule as passenger schedules: a freighter on the
// ramp and its published rate card are visible to anyone standing at the
// airport. What is NOT here (deliberately): tonnes actually carried, load
// factor, and per-lane P&L — those are the rival's own performance, not their
// published offer.
//
// Keyed by pairKeyOf() exactly like `routes`, so a consumer can ask "does this
// rival touch the pair I fly?" with one key format across both networks.
function cargoRoutesOf(state) {
  const out = {};
  for (const r of state.cargoRoutes ?? []) {
    if (!r?.origin || !r?.destination) continue;
    const key = pairKeyOf(r.origin, r.destination);
    const freq = r.weeklyFrequency ?? 0;
    const typeId = (state.fleet ?? []).find((a) => a.id === r.aircraftId)?.typeId ?? null;
    const type = typeId ? getAircraftType(typeId) : null;
    const prev = out[key];
    const frequency = (prev?.frequency ?? 0) + freq;
    // Capacity summed PER FREIGHTER for the same reason passenger seats are: one
    // lane can be flown by a 747F and an ATR 72F, and payload × totalFrequency
    // would be wrong for both.
    const tonnesPerWeek = (prev?.tonnesPerWeek ?? 0) + (type?.payloadTonnes ?? 0) * freq;
    // Frequency-weighted yield — a lane flown twice at different rates publishes
    // a blended rate, not whichever row happened to be last.
    const yieldFreq = (prev?._yieldFreq ?? 0) + (r.yieldPrice ?? 0) * freq;
    const aircraftTypes = prev?.aircraftTypes ? [...prev.aircraftTypes] : [];
    if (typeId && !aircraftTypes.includes(typeId)) aircraftTypes.push(typeId);
    const refYield = cargoReferenceYield(r.origin, r.destination);
    const blended = frequency > 0 ? yieldFreq / frequency : (r.yieldPrice ?? 0);
    out[key] = {
      frequency,
      tonnesPerWeek,
      // $/tonne-km, and the same figure as a share of the lane's reference yield
      // so the client can colour "undercutting" vs "premium" without re-deriving
      // the world's fare index.
      yieldPrice: blended > 0 ? +blended.toFixed(3) : null,
      yieldMultiplier: blended > 0 && refYield ? +(blended / refYield).toFixed(3) : null,
      aircraftTypes,
      aircraftType: aircraftTypes[0] ?? null,
      _yieldFreq: yieldFreq,
    };
  }
  // The running accumulator never leaves this function.
  for (const v of Object.values(out)) delete v._yieldFreq;
  return out;
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
    const typeId = (s.fleet ?? []).find((a) => a.id === r.aircraftId)?.typeId ?? null;
    const prev = routes[key];
    const frequency = (prev?.frequency ?? 0) + freq;
    const cabin = cabinForRoute(s, r);
    // Capacity has to be summed PER AIRCRAFT — one pair can be flown by a
    // widebody and a turboprop, and `seats × totalFrequency` is wrong for both.
    const seatsPerWeek = (prev?.seatsPerWeek ?? 0) + cabin.bodies * freq;
    const businessSeatsPerWeek = (prev?.businessSeatsPerWeek ?? 0) + cabin.business * freq;
    const bizFare = businessFareFor(s, key, r);
    const aircraftTypes = prev?.aircraftTypes ? [...prev.aircraftTypes] : [];
    if (typeId && !aircraftTypes.includes(typeId)) aircraftTypes.push(typeId);
    routes[key] = {
      frequency,
      priceMultiplier: econ && ref ? +(econ / ref).toFixed(3) : (prev?.priceMultiplier ?? 1),
      // Open book: rivals see the ACTUAL fare, not a reverse-engineered multiple.
      economyFare: econ != null ? Math.round(econ) : (prev?.economyFare ?? null),
      // Total weekly capacity on the pair, plus the blended seats-per-flight
      // (`seats`) kept for older clients that still do seats × frequency.
      seatsPerWeek,
      seats: frequency > 0 ? Math.round(seatsPerWeek / frequency) : (prev?.seats ?? DEFAULT_SEATS),
      // The REAL premium cabin — 0 when this rival sells none. Consumers must
      // treat `businessSeatsPerWeek: 0` as "no business class", not as missing
      // data to be filled in from the carrier's tier.
      businessSeatsPerWeek,
      businessFare: bizFare != null ? Math.round(bizFare) : (prev?.businessFare ?? null),
      aircraftTypes,
      aircraftType: aircraftTypes[0] ?? null,
    };
  }
  const history = (s.financialHistory ?? []).slice(-12);
  const profitHistory = history.map((w) => w.profit ?? 0);
  const lastWeek = history.length ? history[history.length - 1] : null;
  return {
    id: rivalIdOf(airlineRow),
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
    // Shares outstanding — per-airline since the capital-markets rework, so the
    // client's ownership caps and mark-to-market must read it rather than assume
    // a fixed float. Falls back to the founder count for pre-rework blobs.
    shares: Number(s.equity?.shares ?? TOTAL_SHARES),
    // Real equity structure, when the blob has one. Without these the engine's
    // freeFloatOf() falls back to assuming a 30% float — which invented a
    // tradeable float for PRIVATE airlines and misstated it for listed ones.
    ...(Number.isFinite(Number(s.equity?.founderShares))
      ? { founderShares: Number(s.equity.founderShares) } : {}),
    ...(s.equity ? { isPublic: s.equity.isPublic !== false } : {}),
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
    // Freight lanes, same pair-key shape as `routes`. Always an object (never
    // undefined) so consumers can iterate without a guard; solo AI carriers have
    // no cargo network at all, so client code must still tolerate its absence
    // there.
    cargoRoutes: cargoRoutesOf(s),
  };
}

// Route-level offer specs per city pair (encroachment-spec shape) for the
// demand model. One spec per rival per pair they fly.
export function toRivalSpecs(airlineRow) {
  const s = airlineRow.state ?? {};
  const quality = qualityOf(s);
  // The rival's hub. Carried on the spec so the demand model can grant them the
  // same connecting-feed bonus the player gets on their own hub routes — without
  // it, a rival flying out of its fortress was scored as if the route were an
  // outstation, and the client's share preview (which DID apply the bonus)
  // disagreed with the weekly tick.
  const homeHub = airlineRow.hub ?? s.hub ?? null;
  // Brand reach — awareness x reputation x loyalty, through the SAME helper the
  // weekly tick uses on the player. Computed ONCE per rival (calcReputation walks
  // their whole fleet, so this must not run per pair) as a hub and an off-hub
  // variant, since the loyalty term concentrates on hub-touching routes; the
  // right one is picked per pair below.
  // NOTE: the alliance term is deliberately omitted (false). partnerContestedKeys
  // is built from the VIEWER's alliance, not this rival's, and player alliances
  // ('hw:' ids) do not resolve in the static bank. An allied rival is therefore
  // rated a few points low rather than wrongly.
  const rivalHubs  = s.hubs ?? (s.hub ? { [s.hub]: { tier: 1 } } : {});
  const rivalHubQ  = (code) => {
    const t = rivalHubs[code]?.tier;
    return t != null ? (HUB_TIERS[t]?.qualityBonus ?? 0) : 0;
  };
  const reachOnHub  = stateBrandReach(s, 1, false);
  const reachOffHub = stateBrandReach(s, 0, false);
  const byPair = {};
  for (const r of s.routes ?? []) {
    const key = pairKeyOf(r.origin, r.destination);
    const econ = s.routePricing?.[key]?.economy ?? r.ticketPrice ?? null;
    const ref = referencePrice(r.origin, r.destination);
    const spec = byPair[key] ?? {
      competitorId: rivalIdOf(airlineRow),
      name: airlineRow.name ?? s.airlineName ?? 'Rival Airline',
      tier: 'legacy',
      qualityScore: quality,
      brandReach: (rivalHubQ(r.origin) > 0 || rivalHubQ(r.destination) > 0)
        ? reachOnHub : reachOffHub,
      homeHub,
      frequency: 0,
      priceMultiplier: econ && ref ? +(econ / ref).toFixed(3) : 1,
      // Open book: the fare they actually charge, not a reference multiple.
      economyFare: econ != null ? Math.round(econ) : null,
      businessFare: null,
      businessSeatsPerWeek: 0,
      seatsPerFlight: 0,
      _seatsPerWeek: 0,
    };
    const freq = r.weeklyFrequency ?? 0;
    const cabin = cabinForRoute(s, r);
    spec.frequency += freq;
    // Mixed fleets: blend seats-per-flight by frequency instead of letting the
    // first aircraft found stand in for every flight on the pair.
    spec._seatsPerWeek += cabin.bodies * freq;
    // Their REAL premium cabin. Stays 0 for an all-economy rival, which is the
    // whole point: they must not compete for business travelers they can't carry.
    spec.businessSeatsPerWeek += cabin.business * freq;
    if (spec.businessFare == null) {
      const bizFare = businessFareFor(s, key, r);
      if (bizFare != null) spec.businessFare = Math.round(bizFare);
    }
    byPair[key] = spec;
  }
  for (const spec of Object.values(byPair)) {
    spec.seatsPerFlight = spec.frequency > 0
      ? Math.round(spec._seatsPerWeek / spec.frequency)
      : DEFAULT_SEATS;
    delete spec._seatsPerWeek;
    // No premium seats → no premium fare, however their pricing table reads.
    if (!(spec.businessSeatsPerWeek > 0)) spec.businessFare = null;
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
      stockPool: null,   // filled in by attachStockPool (worlds with a float pool)
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
    ...rivalOverlay(view),
  };
}

// The server-derived half of withRivals on its own: everything that depends on
// OTHER airlines rather than on this one's save blob.
//
// Split out so the airline read can ship it INDEPENDENTLY of the state blob. A
// rival's move changes exactly these fields and nothing else, and they weigh
// kilobytes against the blob's megabytes — so a player who is watching rather
// than acting (the common case between hourly ticks) no longer re-downloads
// their entire save because somebody else adjusted a fare.
//
// Keep this key set in lockstep with stripRivals: anything stripped before
// persistence because it is rebuilt from `view` belongs here.
export function rivalOverlay(view) {
  return {
    // Float-pool summary (investor cash left, liquidity state) so the Stocks tab
    // can explain sell-side liquidity BEFORE the server rejects a trade.
    stockPool: view?.stockPool ?? null,
    // Gate scarcity worlds only: the live gate-market view.
    ...(view?.gateMarket ? { gateMarket: view.gateMarket } : {}),
    // Alliance slot pool (scarcity worlds): per-airport grants/draws/money the
    // engine's slot checks, weekly fees and squeeze countdown consume. Injected
    // whenever the gate view exists — an EMPTY pool ({}) is meaningful: it is
    // how a departed member's grants read as withdrawn, which starts the
    // engine's wind-down countdown.
    ...(view?.gateMarket ? { allianceSlotPool: view.gateMarket.slotPool ?? {} } : {}),
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
    gateMarket, worldMarket, stockPool, allianceSlotPool,
    ...rest
  } = state;
  return rest;
}

// ── Rival-view row projection (Supabase egress) ───────────────────────────────
// The rival view is derived from every ACTIVE airline's save blob, so a plain
// `findMany` ships EVERY player's whole save on every rebuild — and a rebuild is
// triggered by ANY player's action. Measured against PRODUCTION on 2026-08-04:
// the average stored blob is 523 kB (max 5.9 MB), and this one query was 90% of
// the project's Supabase egress bill AND 89% of all database execution time.
//
// What a real blob is made of (jsonb_each over all ACTIVE airlines, 2026-08-04):
//
//   lastReport        291 kB avg (56%!)  — the full weekly debrief, per-route
//   financialHistory   99 kB             — 52 weekly entries, ~1.9 kB each
//   statsHistory       81 kB             — up to 260 compact KPI entries
//   fleet              26 kB             — entries carry maintenance/mods/value
//   everything else   ~26 kB combined
//
// The projection trims in Postgres, at two depths, so only what the rival path
// actually reads crosses the wire (~25–30 kB/row instead of 523 kB):
//
//   whole keys   lastReport → its three read fields; customLogo dropped
//   inside keys  fleet / financialHistory / statsHistory entries reduced to the
//                fields below, with the histories also bounded to their tails
//
// Every retained field is pinned to a consumer:
//
//   fleet.id/typeId/config   cabinForRoute, cargoRoutesOf, calcPositioning,
//                            calcReputation (service score, assigned filter)
//   fleet.ageWeeks           calcReputation fleet-freshness score
//   fleet.status             fleetAvgUtilization's isOutOfService filter
//   fin.profit               toHumanCompetitor profitHistory (slice(-12), the
//                            deepest read), calcReputation slice(-4)
//   fin.revenue              toHumanCompetitor weeklyStats
//   fin.passengers           loyaltyPaxBase slice(-8)
//   stats.sharePrice         toHumanCompetitor sharePriceHistory (slice(-26))
//   lastReport.reputation    qualityOf's preferred (legacy) shape
//   lastReport.reputationScore  what the CURRENT engine writes — kept so a
//                            future qualityOf that reads it is never starved
//   lastReport.totalPassengers  loyaltyPaxBase
//
// This started life as a pure deny-list (pass through everything unrecognised,
// so a new engine field cannot silently arrive `undefined`). Top-level keys
// still work that way — only the five named ones are touched. The named keys
// switch to allow-lists because production taught us the deny-list failure
// mode: it faithfully ships 291 kB nobody reads. The safety net for both is
// tools/rival-projection-test.mjs, which proves the derived views are
// byte-identical with and without the projection, and that each trim has teeth.
export const RIVAL_FIN_KEEP = 12;    // deepest read: profitHistory slice(-12)
export const RIVAL_STATS_KEEP = 26;  // sharePriceHistory slice(-26)
export const RIVAL_FLEET_FIELDS = ['id', 'typeId', 'config', 'ageWeeks', 'status'];
export const RIVAL_FIN_FIELDS = ['profit', 'revenue', 'passengers'];
export const RIVAL_STATS_FIELDS = ['sharePrice'];
// Keys the rival path provably never reads, removed outright. customLogo is the
// player's uploaded logo payload — rivals render `logoId`, never this.
export const RIVAL_DROPPED_KEYS = ['customLogo'];

// Element projector shared by the twin's three array trims. Mirrors the SQL's
// jsonb_build_object over jsonb_array_elements: any non-object element (scalar,
// array, null) yields the same field set with explicit nulls, because
// `e->'field'` is SQL NULL for all of them.
const pickFields = (fields) => (e) =>
  Object.fromEntries(fields.map((f) => [f, (e?.[f] ?? null)]));

// JS twin of the SQL projection in loadRivalRows(). Two jobs: it IS the
// implementation for callers that hand us a prisma double with no $queryRaw
// (the test harnesses), and it is what tools/rival-projection-test.mjs drives to
// prove that trimming changes no rival view. Keep the two in lockstep — each
// branch here mirrors a jsonb_typeof guard in the SQL.
export function projectRivalState(state) {
  if (!state || typeof state !== 'object') return state;
  const out = { ...state };
  out.financialHistory = Array.isArray(state.financialHistory)
    ? state.financialHistory.slice(-RIVAL_FIN_KEEP).map(pickFields(RIVAL_FIN_FIELDS)) : [];
  out.statsHistory = Array.isArray(state.statsHistory)
    ? state.statsHistory.slice(-RIVAL_STATS_KEEP).map(pickFields(RIVAL_STATS_FIELDS)) : [];
  out.fleet = Array.isArray(state.fleet)
    ? state.fleet.map(pickFields(RIVAL_FLEET_FIELDS)) : [];
  const lr = state.lastReport;
  out.lastReport = (lr && typeof lr === 'object' && !Array.isArray(lr))
    ? {
        reputation: lr.reputation ?? null,
        reputationScore: lr.reputationScore ?? null,
        totalPassengers: lr.totalPassengers ?? null,
      }
    : null;
  for (const k of RIVAL_DROPPED_KEYS) delete out[k];
  return out;
}

// Columns the rival path reads off the ROW (as opposed to the blob):
// rivalIdOf → id/restarts; toHumanCompetitor → name/hub/account; buildRivalViews
// → status; buildGateMarketViews → id/name. `version` rides along because the
// caller's stamp arithmetic is derived from it and a future call site will want
// it. Anything else is deliberately not fetched.
async function loadRivalRows(prisma, worldId) {
  if (typeof prisma.$queryRaw !== 'function') {
    // Test double (tools/headwinds-rivals-test.mjs). Take the ORM path and trim
    // in JS so both branches yield byte-identical rows.
    const rows = await prisma.airline.findMany({
      where: { worldId, status: 'ACTIVE' },
      // OG + DEV badges. The email never leaves the server — it's only compared
      // against ADMIN_EMAILS here; payloads carry booleans.
      include: { account: { select: { isOG: true, email: true } } },
    });
    return rows.map((r) => ({ ...r, state: projectRivalState(r.state) }));
  }
  // `last-N to last` is clamped by Postgres on short arrays (a 3-entry series
  // returns all 3, not an error), and lax mode means a missing key yields no
  // rows rather than throwing — but a non-array value would be auto-wrapped into
  // a 1-element array, so the jsonb_typeof guards keep this exactly equal to the
  // JS twin above. `WITH ORDINALITY ... ORDER BY ord` pins element order —
  // jsonb_agg over unordered SRF output is not guaranteed to preserve it. Paths
  // are built from module constants, never user input, and are passed as bound
  // parameters regardless.
  const finTail = `[last-${RIVAL_FIN_KEEP - 1} to last]`;
  const statsTail = `[last-${RIVAL_STATS_KEEP - 1} to last]`;
  const rows = await prisma.$queryRaw`
    SELECT a.id, a."worldId", a.name, a.hub, a.status, a.restarts, a.version,
           acc."isOG" AS "accountIsOG", acc.email AS "accountEmail",
           (a.state - 'financialHistory' - 'statsHistory' - 'fleet' - 'lastReport' - 'customLogo')
             || jsonb_build_object(
                  'financialHistory',
                    CASE WHEN jsonb_typeof(a.state->'financialHistory') = 'array'
                         THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                        'profit', e->'profit', 'revenue', e->'revenue',
                                        'passengers', e->'passengers') ORDER BY ord), '[]'::jsonb)
                                 FROM jsonb_array_elements(jsonb_path_query_array(a.state, ${'$.financialHistory' + finTail}::jsonpath))
                                      WITH ORDINALITY AS fh(e, ord))
                         ELSE '[]'::jsonb END,
                  'statsHistory',
                    CASE WHEN jsonb_typeof(a.state->'statsHistory') = 'array'
                         THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                        'sharePrice', e->'sharePrice') ORDER BY ord), '[]'::jsonb)
                                 FROM jsonb_array_elements(jsonb_path_query_array(a.state, ${'$.statsHistory' + statsTail}::jsonpath))
                                      WITH ORDINALITY AS sh(e, ord))
                         ELSE '[]'::jsonb END,
                  'fleet',
                    CASE WHEN jsonb_typeof(a.state->'fleet') = 'array'
                         THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                        'id', e->'id', 'typeId', e->'typeId', 'config', e->'config',
                                        'ageWeeks', e->'ageWeeks', 'status', e->'status') ORDER BY ord), '[]'::jsonb)
                                 FROM jsonb_array_elements(a.state->'fleet') WITH ORDINALITY AS fl(e, ord))
                         ELSE '[]'::jsonb END,
                  'lastReport',
                    CASE WHEN jsonb_typeof(a.state->'lastReport') = 'object'
                         THEN jsonb_build_object(
                                'reputation',      a.state#>'{lastReport,reputation}',
                                'reputationScore', a.state#>'{lastReport,reputationScore}',
                                'totalPassengers', a.state#>'{lastReport,totalPassengers}'
                              )
                         ELSE NULL END
                ) AS state
      FROM "Airline" a
      JOIN "Account" acc ON acc.id = a."accountId"
     WHERE a."worldId" = ${worldId} AND a.status = 'ACTIVE'
  `;
  return rows.map((r) => ({
    id: r.id,
    worldId: r.worldId,
    name: r.name,
    hub: r.hub,
    status: r.status,
    restarts: r.restarts,
    version: r.version,
    state: r.state,
    account: { isOG: r.accountIsOG === true, email: r.accountEmail },
  }));
}

// ── Rival-view cache (API process) ────────────────────────────────────────────
// Every open game polls its airline read, and each uncached build loads a row
// per ACTIVE airline (projected — see loadRivalRows; the blobs used to be sent
// whole, and were the single biggest Supabase egress driver).
// A world's rival views are identical for all its players, so build once and
// share. Entries are validated by `stamp` (the caller's cheap sum-of-versions
// aggregate — any decision, tick, join or abandon changes it) plus a short TTL
// fallback for changes that don't bump an airline version (alliance moves).
// The worker bypasses the cache entirely by passing preloaded `airlines`, and
// runs in its own process anyway.
export const RIVAL_VIEW_CACHE_TTL_MS = 30_000;

// ── Rebuild FLOOR, for callers that opt in via `maxStaleMs` ──────────────────
// The stamp is the sum of every active airline's version, so ANY player's
// action invalidates it. Production, 2026-08-04: decisions land about every
// 22s across the deployment, so the cache rebuilt about every 26s, all day —
// the frequency half of the egress bill (the projection above is the size
// half). The poll read opts into serving a view up to this old.
//
// The dangerous way to do this is to serve a stale overlay while echoing the
// CURRENT stamp: the client would record itself as up to date on a view it was
// never given, and the rival move that moved the stamp would go undelivered
// until the next tick. So a served view carries `builtFromStamp` — the stamp it
// actually reflects — and the read path echoes THAT. The client keeps polling
// (its next poll still sees a stamp difference) and picks up the fresh overlay
// as soon as the floor expires.
//
// 60s: rivals' fares/frequencies landing up to a minute late is invisible in a
// game whose real cadence is the 30-minute tick, and the player's OWN state is
// unaffected (a tick bumps self-version, and the self-changed path always
// ships the blob). Call sites that must observe their OWN just-committed
// write — gate bids, aircraft trades, the decision POST — pass nothing and
// keep the strict stamp check.
export const RIVAL_VIEW_POLL_MAX_STALE_MS = 60_000;
const viewCache = new Map(); // worldId → { stamp, at, promise }

// One-stop world view builder for API/tick call sites: loads active airlines
// and the alliance graph, returns the per-airline view map.
export async function buildWorldRivalViews(prisma, worldId, { airlines = null, stamp = null, world = null, maxStaleMs = 0 } = {}) {
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

  // Float pool visibility: every competitor entry carries `poolShares` (how many
  // of its shares the pool can still sell to a buyer) and each view carries a
  // `stockPool` summary. Without this the CLIENT had no idea what was buyable —
  // the trade ticket happily submitted orders for shares other investors already
  // held, which came back as a confusing 409 and a reverted purchase. Competitor
  // objects are shared across views, so one pass over the map covers everyone.
  // No pool row yet (no trade ever happened) → poolShares falls back to the free
  // float, which is exactly what the settle path assumes too.
  const attachStockPool = async (views) => {
    const market = await prisma.worldMarket.findUnique({ where: { worldId } }).catch(() => null);
    const summary = poolSummary(market);
    const seen = new Set();
    for (const view of views.values()) {
      view.stockPool = summary;
      for (const c of view.competitors) {
        if (!c || seen.has(c.id)) continue;
        seen.add(c.id);
        c.poolShares = poolSharesFor(market, c.id, c);
      }
    }
    return views;
  };

  // ── World fare index, set from the rows we are about to price ───────────────
  // buildRivalViews() prices rival fares via referencePrice() and calcPositioning(),
  // both of which read the module-scoped fare index the engine reducer normally
  // sets. This function runs BEFORE the reducer on every decision request, so
  // without this a rival view would be priced with whatever index the PREVIOUS
  // request left behind — a restricted world read on the classic ladder, or vice
  // versa, feeding a 15%-wrong price ratio into the contested-route demand split.
  // Set immediately before pricing, from the rows themselves: every airline in a
  // world shares the index, and on the cache-miss path the rows do not exist until
  // after the findMany below.
  const priced = (rows, allianceMap) => {
    setFareIndex(rows?.[0]?.state?.fareIndex ?? 1);
    setNwrYieldChoke(rows?.[0]?.state?.newWorldRestrictions === true);
    return buildRivalViews(rows, allianceMap);
  };

  if (airlines) {
    const allianceMap = await loadAllianceMap(prisma, worldId);
    return attachStockPool(await attachGates(airlines, allianceMap, priced(airlines, allianceMap)));
  }
  const hit = viewCache.get(worldId);
  if (hit && stamp != null) {
    const age = Date.now() - hit.at;
    // Nothing moved: serve until the TTL fallback expires.
    if (hit.stamp === stamp && age < RIVAL_VIEW_CACHE_TTL_MS) return hit.promise;
    // Something moved, but this caller tolerates staleness and will echo the
    // served view's own stamp. Never fires with the default maxStaleMs of 0.
    if (age < maxStaleMs) return hit.promise;
  }
  const promise = (async () => {
    const rows = await loadRivalRows(prisma, worldId);
    const allianceMap = await loadAllianceMap(prisma, worldId);
    const views = await attachStockPool(await attachGates(rows, allianceMap, priced(rows, allianceMap)));
    // Which world stamp this view actually reflects. Non-enumerable so it can
    // never leak into iteration or a JSON payload — it exists purely so a caller
    // serving a stale view can tell the client the truth about what it holds.
    Object.defineProperty(views, 'builtFromStamp', { value: stamp, configurable: true });
    return views;
  })();
  viewCache.set(worldId, { stamp, at: Date.now(), promise });
  promise.catch(() => viewCache.delete(worldId)); // never cache a failed read
  return promise;
}
