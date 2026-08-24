// World news — the composed feed behind /worlds/:id/news (and the ticker).
// ----------------------------------------------------------------------------
// WHY THIS EXISTS
// The original /worlds/:id/feed merged six raw queries, sorted them by timestamp
// and sliced. That produced a feed with three problems players noticed:
//
//   1. One decision = one line, so a player opening eight routes in a sitting
//      filled the whole page. There was no notion of "these are one move".
//   2. The airline query was unwindowed, so EVERY airline in the world became a
//      "joined the world" event on EVERY page — in a 40-player world the joins
//      alone could fill the page and push real moves out.
//   3. Whole systems were invisible: the shared world economy, bankruptcies,
//      rank changes, the used-aircraft market and share dealings never appeared.
//
// This module fixes all three. It fetches wide, ROLLS UP related moves into one
// item, assigns an importance tier, and only then slices to the page size.
//
// RELEVANCE IS COMPUTED ON THE CLIENT, deliberately. Promoting "a rival just
// opened a route on a city pair you fly" needs the viewer's route list, and the
// client already holds it — asking the server would mean loading a save blob per
// request and would make the response un-cacheable. The server publishes a base
// tier; the client promotes what touches its own network.
import { PUBLIC_DECISIONS, publicPayload, isPublicDecision } from './publicDecisions.mjs';
import { isDevEmail } from './humanRivals.mjs';
import { WEEKS_PER_YEAR } from './worldConfig.mjs';

/** How far back news is readable, in game weeks. Older news is pruned/filtered. */
export const NEWS_WINDOW_WEEKS = 52;

/** Filterable categories. `world` and `standings` come from the WorldNews table. */
export const NEWS_CATEGORIES = [
  'world', 'routes', 'fleet', 'airports', 'market', 'standings', 'players', 'stocks',
];

/** Stake thresholds that make a share purchase headline news (percent of float). */
const STAKE_THRESHOLDS = [5, 10, 25];

/** A fleet order of this many frames or more is a tier-1 event. */
const BIG_ORDER_FRAMES = 5;

// Fetch this multiple of the page size from each source before rolling up, so a
// page's worth of rolled items still has enough raw material behind it.
const FETCH_MULTIPLIER = 3;

const CATEGORY_OF_DECISION = {
  ADD_ROUTE: 'routes', CLOSE_ROUTE: 'routes', CLOSE_ROUTES: 'routes',
  ADD_CARGO_ROUTE: 'routes', CLOSE_CARGO_ROUTE: 'routes', ADD_TAG_ROUTE: 'routes',
  BUY_AIRCRAFT: 'fleet', ORDER_AIRCRAFT: 'fleet',
  SELL_AIRCRAFT: 'fleet', RETIRE_AIRCRAFT: 'fleet',
  ADD_GATE: 'airports', REMOVE_GATE: 'airports',
  UPGRADE_HUB: 'airports', DESIGNATE_HUB: 'airports', DESIGNATE_FOCUS_CITY: 'airports',
  BUILD_LOUNGE: 'airports',
  JOIN_ALLIANCE: 'players', LEAVE_ALLIANCE: 'players',
  BUY_STOCK: 'stocks', SELL_STOCK: 'stocks',
};

// Decisions in the same family, by the same airline, in the same game week are
// ONE item. Anything absent here is never rolled: hub designations and alliance
// moves are rare and individually meaningful, so they always get their own line.
const FAMILY_OF_DECISION = {
  ADD_ROUTE: 'routes_opened', ADD_CARGO_ROUTE: 'routes_opened', ADD_TAG_ROUTE: 'routes_opened',
  CLOSE_ROUTE: 'routes_closed', CLOSE_ROUTES: 'routes_closed', CLOSE_CARGO_ROUTE: 'routes_closed',
  BUY_AIRCRAFT: 'fleet_in', ORDER_AIRCRAFT: 'fleet_in',
  SELL_AIRCRAFT: 'fleet_out', RETIRE_AIRCRAFT: 'fleet_out',
  ADD_GATE: 'gates_added', REMOVE_GATE: 'gates_removed',
  BUY_STOCK: 'stock_tape', SELL_STOCK: 'stock_tape',
};

// Within a family, roll separately per sub-key: gates per airport, share
// dealings per target airline. Routes and fleet roll across the whole week.
const SUBKEY_OF_FAMILY = {
  gates_added:   (p) => p.airportCode ?? '',
  gates_removed: (p) => p.airportCode ?? '',
  stock_tape:    (p) => p.targetId ?? '',
};

export const linearWeekOf = (world) =>
  ((Number(world?.currentYear) || 1) - 1) * WEEKS_PER_YEAR + (Number(world?.currentWeek) || 1);

export const yearWeek = (linear) => {
  const i = Math.max(1, Math.round(Number(linear) || 1));
  return { year: Math.floor((i - 1) / WEEKS_PER_YEAR) + 1, week: ((i - 1) % WEEKS_PER_YEAR) + 1 };
};

/**
 * The retention window, in both of the forms the sources need.
 *
 * Rows that carry a game week (Decision, WorldNews, UsedAircraftListing) filter
 * on `minWeek`. Rows that only carry a wall-clock timestamp (Alliance,
 * AllianceMember, GateAuction, GateListing, Airline) filter on `minAt`, derived
 * from the world's tick pace — 52 game weeks is 52/weeksPerDay real days.
 *
 * An ENDED world anchors on `endedAt` rather than now, so its final year of news
 * stays readable instead of ageing out the moment the world stops ticking.
 */
export function newsWindow(world) {
  const minWeek = Math.max(0, linearWeekOf(world) - NEWS_WINDOW_WEEKS);
  const anchor = world?.endedAt ? new Date(world.endedAt).getTime() : Date.now();
  const days = NEWS_WINDOW_WEEKS / Math.max(1, Number(world?.weeksPerDay) || 1);
  return { minWeek, minAt: new Date(anchor - days * 86_400_000) };
}

const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

// ── Tiering ──────────────────────────────────────────────────────────────────
// 1 = headline, 2 = ordinary news, 3 = background. The client additionally
// promotes anything touching the viewer's own network to tier 1.
function baseTier(item) {
  switch (item.kind) {
    case 'event_started': case 'event_ended':
    case 'bankruptcy': case 'abandoned': case 'rank_change':
    case 'alliance_founded': case 'gate_auction_won':
    case 'gate_auction_unsold': case 'gate_forfeited':
    case 'hub_designated': case 'hub_upgraded':
    case 'world_ended': case 'year_in_review':
      return 1;
    case 'joined':
      return 3;
    case 'fleet_in':
      return (item.data?.total ?? 0) >= BIG_ORDER_FRAMES ? 1 : 2;
    case 'stock_tape':
      return item.data?.crossedThreshold ? 1 : 2;
    default:
      return 2;
  }
}

// Did this week's dealing take the holder through 5%, 10% or 25% of the float?
// Both sides come from the journal (written against the target's own share count
// at execution time), so this needs no assumption about float size.
function crossedStakeThreshold(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
  return STAKE_THRESHOLDS.some((t) => (before < t && after >= t) || (before >= t && after < t));
}

// ── Rollup ───────────────────────────────────────────────────────────────────
function rollDecisions(decisions, nameOf, ogOf, devOf, acctOf = new Map()) {
  const groups = new Map();
  const singles = [];

  for (const d of decisions) {
    // A decision the reducer refused changed nothing, so there is nothing to
    // report. The DB query can only filter on `type` (the index is on
    // worldId+createdAt), so the no-op mark is checked here. See
    // journalledPayload() in publicDecisions.mjs.
    if (!isPublicDecision(d)) continue;
    const p = publicPayload(d);
    const family = FAMILY_OF_DECISION[d.type];
    const common = {
      at: iso(d.createdAt),
      ...yearWeek(d.week),
      linearWeek: d.week,
      airlineId: d.airlineId,
      accountId: acctOf.get(d.airlineId) ?? null,
      airline: nameOf.get(d.airlineId) ?? 'An airline',
      og: ogOf.get(d.airlineId) ?? false,
      dev: devOf.get(d.airlineId) ?? false,
      category: CATEGORY_OF_DECISION[d.type] ?? 'players',
    };

    if (!family) {
      // Never rolled — hub moves and alliance changes stand alone.
      singles.push({
        ...common,
        id: `dec:${d.id}`,
        kind: kindOfSingleDecision(d.type),
        data: p,
      });
      continue;
    }

    // A rejected share trade is journalled with shares:0 so it can be told apart
    // from a real one. Print nothing rather than a phantom trade.
    if (family === 'stock_tape' && !(p.shares > 0)) continue;

    const sub = SUBKEY_OF_FAMILY[family] ? SUBKEY_OF_FAMILY[family](p) : '';
    const key = `${family}|${d.airlineId}|${d.week}|${sub}`;
    if (!groups.has(key)) {
      groups.set(key, { key, family, sub, common, members: [] });
    }
    const g = groups.get(key);
    g.members.push({ type: d.type, payload: p, at: iso(d.createdAt), id: d.id });
  }

  const rolled = [...groups.values()].map((g) => composeGroup(g));
  return [...singles, ...rolled];
}

function kindOfSingleDecision(type) {
  switch (type) {
    case 'DESIGNATE_HUB': return 'hub_designated';
    case 'UPGRADE_HUB': return 'hub_upgraded';
    case 'DESIGNATE_FOCUS_CITY': return 'focus_city';
    // Never rolled: a lounge is a once-in-a-long-while capital commitment, not
    // something you do five of in a week, so it always gets its own line.
    case 'BUILD_LOUNGE': return 'lounge_built';
    case 'JOIN_ALLIANCE': return 'alliance_joined';
    case 'LEAVE_ALLIANCE': return 'alliance_left';
    default: return 'move';
  }
}

function composeGroup(g) {
  const { family, common, sub } = g;
  // Sort explicitly rather than trusting arrival order. The query asks for
  // createdAt desc, but "newest member" decides both the group's position in the
  // feed and which stake figure is current — too load-bearing to leave implicit.
  const members = [...g.members].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const base = {
    ...common,
    id: `roll:${family}:${common.airlineId}:${common.linearWeek}${sub ? `:${sub}` : ''}`,
    kind: family,
    at: members[0].at,
  };

  if (family === 'routes_opened' || family === 'routes_closed') {
    const raw = [];
    for (const m of members) {
      const p = m.payload;
      if (Array.isArray(p.routes) && p.routes.length) raw.push(...p.routes);
      else if (p.origin && p.destination) raw.push({ origin: p.origin, destination: p.destination });
    }

    // COUNT CITY PAIRS, NOT DECISIONS. A player putting three aircraft on
    // JFK–LHR files three ADD_ROUTE decisions — the engine keeps one route
    // record per tail — but to everyone else that is ONE route, flown three
    // times. Reporting it as "opened 4 routes from JFK · JFK–LHR, JFK–LHR,
    // JFK–LHR, JFK–NRT" read as a bug. Repeats fold into a `count` the client
    // renders as "JFK–LHR ×3".
    //
    // Direction-agnostic, like the Routes page airport filter: a pair entered
    // as LHR–JFK is the same route as JFK–LHR. The first orientation seen wins
    // the label, so the line reads the way the airline flew it first.
    const byPair = new Map();
    for (const r of raw) {
      const key = [r.origin, r.destination].sort().join('-');
      const seen = byPair.get(key);
      if (seen) seen.count += 1;
      else byPair.set(key, { origin: r.origin, destination: r.destination, count: 1 });
    }
    const pairs = [...byPair.values()];

    // A batched close journals `count` even when the pair list was trimmed at
    // 20. Pairs beyond the list are unknown, so assume the worst case (all
    // distinct) rather than under-reporting the size of the move.
    const declared = members.reduce((s, m) => s + (m.payload.count ?? 0), 0);
    const untrimmed = Math.max(0, declared - raw.length);
    const total = pairs.length + untrimmed;
    // "opened 6 routes from DEN" only when they genuinely share one endpoint.
    const origins = new Set(pairs.map((r) => r.origin));
    return {
      ...base,
      data: {
        total,
        // Every service flown, repeats included — what `total` used to count.
        services: Math.max(raw.length, declared),
        pairs: pairs.slice(0, 20),
        commonOrigin: origins.size === 1 ? [...origins][0] : null,
        cargo: members.every((m) => m.type.includes('CARGO')),
      },
      detail: pairs.slice(0, 20),
    };
  }

  if (family === 'fleet_in' || family === 'fleet_out') {
    const byType = {};
    let total = 0;
    for (const m of members) {
      const qty = m.payload.quantity ?? 1;
      total += qty;
      const t = m.payload.typeId ?? 'unknown';
      byType[t] = (byType[t] ?? 0) + qty;
    }
    return {
      ...base,
      data: {
        total,
        byType,
        ordered: members.some((m) => m.type === 'ORDER_AIRCRAFT'),
        retired: members.every((m) => m.type === 'RETIRE_AIRCRAFT'),
      },
    };
  }

  if (family === 'gates_added' || family === 'gates_removed') {
    return {
      ...base,
      data: {
        airportCode: sub || null,
        total: members.reduce((s, m) => s + (m.payload.count ?? 1), 0),
      },
    };
  }

  if (family === 'stock_tape') {
    // Net the week's dealings in one name: twenty scale-in buys are one line.
    let net = 0;
    let value = 0;
    for (const m of members) {
      const sign = m.type === 'BUY_STOCK' ? 1 : -1;
      net += sign * (m.payload.shares ?? 0);
      value += m.payload.value ?? 0;
    }
    const newest = members[0].payload;
    const oldest = members[members.length - 1].payload;
    const stakePct = newest.stakePct ?? null;
    const data = {
      targetId: sub || null,
      targetName: newest.targetName ?? null,
      netShares: net,
      grossValue: value,
      pricePerShare: newest.pricePerShare ?? null,
      stakePct,
      direction: net >= 0 ? 'buy' : 'sell',
      crossedThreshold: crossedStakeThreshold(oldest.stakePctBefore, stakePct),
    };
    return { ...base, data };
  }

  return { ...base, data: {} };
}

// ── The builder ──────────────────────────────────────────────────────────────
// Categories stored in the worldNews table. Everything else in NEWS_CATEGORIES
// is derived from a domain table (gate auctions, used-aircraft sales...), so a
// category missing from this list means rows written under it are never read.
const WORLD_NEWS_CATEGORIES = ['world', 'standings', 'airports'];

/**
 * Compose a page of world news.
 *
 * @param {object} prisma
 * @param {object} opts
 * @param {object} opts.world     the World row (needs currentWeek/currentYear/weeksPerDay/endedAt)
 * @param {string[]} [opts.categories]  subset of NEWS_CATEGORIES; default all
 * @param {number} [opts.tier]    return only items at this tier or better (1 = big moves only)
 * @param {string} [opts.before]  ISO cursor — return items strictly older than this
 * @param {number} [opts.limit]   page size (1–100)
 * @returns {Promise<{items: object[], nextBefore: string|null, window: object}>}
 */
export async function buildNews(prisma, { world, categories, tier, before, limit = 40 }) {
  const want = new Set(
    (Array.isArray(categories) && categories.length ? categories : NEWS_CATEGORIES)
      .filter((c) => NEWS_CATEGORIES.includes(c)),
  );
  const size = Math.max(1, Math.min(100, Math.round(limit) || 40));
  const take = size * FETCH_MULTIPLIER;
  const cursor = before ? new Date(before) : null;
  const cutoff = cursor && !Number.isNaN(cursor.getTime()) ? cursor : null;
  const { minWeek, minAt } = newsWindow(world);

  // Every source is bounded by BOTH the page cursor and the retention window.
  const at = (field = 'createdAt') => ({
    [field]: cutoff ? { lt: cutoff, gte: minAt } : { gte: minAt },
  });

  const needDecisions = ['routes', 'fleet', 'airports', 'stocks', 'players'].some((c) => want.has(c));
  const needAirports = want.has('airports');

  const [decisions, airlines, joins, alliances, allianceJoins, gateAuctions, gateSales, usedSales, worldNews] =
    await Promise.all([
      needDecisions ? prisma.decision.findMany({
        where: {
          worldId: world.id,
          type: { in: [...PUBLIC_DECISIONS] },
          week: { gte: minWeek },
          ...at(),
        },
        orderBy: { createdAt: 'desc' },
        take,
      }) : [],
      // Label map ONLY — every airline, but three columns, no state blob. This is
      // NOT the source of "joined" events (see the windowed query below); mixing
      // the two is what used to flood the feed with stale joins.
      prisma.airline.findMany({
        where: { worldId: world.id },
        select: { id: true, name: true, accountId: true, account: { select: { isOG: true, email: true } } },
      }),
      want.has('players') ? prisma.airline.findMany({
        where: { worldId: world.id, ...at() },
        select: { id: true, name: true, hub: true, createdAt: true, joinedWeek: true },
        orderBy: { createdAt: 'desc' },
        take,
      }) : [],
      want.has('players') ? prisma.alliance.findMany({
        where: { worldId: world.id, ...at() },
        orderBy: { createdAt: 'desc' },
        take,
      }) : [],
      want.has('players') ? prisma.allianceMember.findMany({
        where: { status: 'ACTIVE', role: { not: 'FOUNDER' }, alliance: { worldId: world.id }, ...at() },
        include: { alliance: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take,
      }) : [],
      // Gate scarcity tables are empty — and so free to query — in other worlds.
      needAirports ? prisma.gateAuction.findMany({
        where: { worldId: world.id, ...at() },
        orderBy: { createdAt: 'desc' },
        take,
      }) : [],
      needAirports ? prisma.gateListing.findMany({
        where: { worldId: world.id, status: 'SOLD', ...at('soldAt') },
        orderBy: { soldAt: 'desc' },
        take,
      }) : [],
      want.has('market') ? prisma.usedAircraftListing.findMany({
        where: { worldId: world.id, status: 'SOLD', ...at('soldAt') },
        orderBy: { soldAt: 'desc' },
        take,
      }) : [],
      // Categories that live in the worldNews table rather than being derived
      // from a domain table. 'airports' belongs here as well as in the gate
      // auction/lease queries above: a rule-5 forfeiture has no row of its own
      // anywhere else, so omitting it here wrote the notice and never read it.
      WORLD_NEWS_CATEGORIES.some((c) => want.has(c)) ? prisma.worldNews.findMany({
        where: {
          worldId: world.id,
          category: { in: WORLD_NEWS_CATEGORIES.filter((c) => want.has(c)) },
          week: { gte: minWeek },
          ...at(),
        },
        orderBy: { createdAt: 'desc' },
        take,
      }) : [],
    ]);

  const nameOf = new Map(airlines.map((a) => [a.id, a.name]));
  const ogOf = new Map(airlines.map((a) => [a.id, a.account?.isOG === true]));
  const devOf = new Map(airlines.map((a) => [a.id, isDevEmail(a.account?.email)]));
  const acctOf = new Map(airlines.map((a) => [a.id, a.accountId ?? null]));
  const who = (id) => ({
    airlineId: id,
    accountId: acctOf.get(id) ?? null,
    airline: nameOf.get(id) ?? 'An airline',
    og: ogOf.get(id) ?? false,
    dev: devOf.get(id) ?? false,
  });

  const items = [
    ...rollDecisions(decisions, nameOf, ogOf, devOf, acctOf),

    ...joins.map((a) => ({
      id: `join:${a.id}`,
      at: iso(a.createdAt),
      ...yearWeek(a.joinedWeek),
      linearWeek: a.joinedWeek,
      category: 'players',
      kind: 'joined',
      ...who(a.id),
      data: { hub: a.hub },
    })),

    ...alliances.map((al) => ({
      id: `alli:${al.id}`,
      at: iso(al.createdAt),
      category: 'players',
      kind: 'alliance_founded',
      airlineId: null,
      airline: null,
      data: { alliance: al.name },
    })),

    ...allianceJoins.map((m) => ({
      id: `am:${m.id}`,
      at: iso(m.createdAt),
      category: 'players',
      kind: 'alliance_joined',
      ...who(m.airlineId),
      data: { alliance: m.alliance.name },
    })),

    ...gateAuctions.map((a) => ({
      id: `ga:${a.id}`,
      at: iso(a.createdAt),
      category: 'airports',
      kind: 'gate_auction_opened',
      airlineId: null,
      airline: null,
      data: { airport: a.airportCode, lots: a.lots, reserve: a.reserve },
    })),

    ...gateAuctions
      .filter((a) => a.status === 'RESOLVED' && Array.isArray(a.results) && a.resolvedAt
        && (cutoff ? a.resolvedAt < cutoff : true) && a.resolvedAt >= minAt)
      .flatMap((a) => a.results.map((r) => ({
        id: `gaw:${a.id}:${r.airlineId}`,
        at: iso(a.resolvedAt),
        category: 'airports',
        kind: 'gate_auction_won',
        ...who(r.airlineId),
        data: { airport: a.airportCode, gates: r.gates, pricePerGate: r.pricePerGate },
      }))),

    // An auction that sold nothing used to be pure silence: the "opened" item
    // stayed in the feed forever with no sequel, and the airport's gate count
    // never moved. Close the loop explicitly.
    ...gateAuctions
      .filter((a) => a.status === 'RESOLVED' && a.resolvedAt
        && (cutoff ? a.resolvedAt < cutoff : true) && a.resolvedAt >= minAt
        && (!Array.isArray(a.results) || a.results.length === 0))
      .map((a) => ({
        id: `gau:${a.id}`,
        at: iso(a.resolvedAt),
        category: 'airports',
        kind: 'gate_auction_unsold',
        airlineId: null,
        airline: null,
        data: {
          airport: a.airportCode,
          lots: a.lots,
          bids: Array.isArray(a.outcomes) ? a.outcomes.length : null,
        },
      })),

    ...gateSales.map((l) => ({
      id: `gs:${l.id}`,
      at: iso(l.soldAt ?? l.createdAt),
      category: 'airports',
      kind: 'gate_sold',
      ...who(l.sellerId),
      data: {
        airport: l.airportCode,
        price: l.askPrice,
        buyer: nameOf.get(l.buyerId) ?? 'another airline',
      },
    })),

    ...usedSales.map((l) => ({
      id: `used:${l.id}`,
      at: iso(l.soldAt ?? l.createdAt),
      ...yearWeek(l.listedWeek),
      linearWeek: l.listedWeek,
      category: 'market',
      kind: 'used_aircraft_sold',
      ...who(l.buyerId),
      data: { typeId: l.typeId, price: l.navPrice, exOperator: l.origin ?? null },
    })),

    ...worldNews.map((n) => ({
      id: `wn:${n.id}`,
      at: iso(n.createdAt),
      ...yearWeek(n.week),
      linearWeek: n.week,
      category: n.category,
      kind: n.kind,
      ...(n.airlineId ? who(n.airlineId) : { airlineId: null, airline: null }),
      data: n.payload ?? {},
    })),
  ]
    .filter((it) => want.has(it.category))
    .map((it) => ({ ...it, tier: it.tier ?? baseTier(it) }));

  const wanted = Number.isFinite(tier)
    ? items.filter((it) => it.tier <= tier)
    : items;

  wanted.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  const page = wanted.slice(0, size);

  // Only offer another page when this one filled AND the oldest item is still
  // inside the retention window — otherwise the client shows the end marker.
  const oldest = page.length ? page[page.length - 1].at : null;
  const more = page.length === size && oldest && new Date(oldest) > minAt;

  return {
    items: page,
    nextBefore: more ? oldest : null,
    window: { weeks: NEWS_WINDOW_WEEKS, minWeek, minAt: minAt.toISOString() },
  };
}

// ── Writing news the tick owns ───────────────────────────────────────────────
// The world's shared economy events, bankruptcies and top-5 rank changes have no
// other durable home: `world.tickConfig.runtimeEvents` holds only the CURRENT
// event set, so once a fuel spike expires it is gone. These helpers build rows
// for the tick to insert inside its own transaction, so the news is atomic with
// the week it describes.

/**
 * Rows for rule-5 gate forfeitures (use-it-or-lose-it).
 *
 * A forfeiture used to leave exactly ONE trace: a toast in the airline's blob.
 * Headwinds ticks server-side on a schedule, and ADVANCE_WEEK REPLACES
 * `pendingToasts` rather than appending to it — so the next week's tick wiped
 * it and a player who was not looking at the tab when it happened never learned
 * that their gates were gone, or why they were suddenly locked out. This is the
 * durable record: it survives every subsequent tick and sits in the feed for
 * the whole retention window.
 *
 * @param {Array<{airlineId, airportCode, count}>} releases  diffed pre/post tick
 */
/**
 * The one-off over-cap schedule trim, one row per AIRCRAFT (never one per
 * frequency decrement). This migration edits schedules players paid launch
 * costs for, so the record has to outlive the session — a toast is replaced by
 * the next tick, and the player may not be logged in when the tick runs.
 *
 * category is 'world', not 'fleet'/'routes', because the worldNews query only
 * fetches the 'world' and 'standings' buckets — a row written under any other
 * category is stored and never read.
 */
export function scheduleTrimNewsRows({ worldId, week, notices }) {
  return (notices ?? [])
    .filter((n) => n?.airlineId && (n.cuts ?? []).length > 0)
    .map((n) => ({
      worldId, week, category: 'world', kind: 'schedule_trim', tier: 1,
      airlineId: n.airlineId,
      payload: {
        aircraft:   n.tailNumber || n.name || null,
        aircraftId: n.aircraftId ?? null,
        name:       n.name ?? null,
        tailNumber: n.tailNumber ?? null,
        capHours:   n.capHours ?? null,
        peakBefore: n.peakBefore ?? null,
        peakAfter:  n.peakAfter ?? null,
        cuts: (n.cuts ?? []).map((c) => ({
          origin:        c.origin,
          destination:   c.destination,
          cargo:         !!c.cargo,
          fromFrequency: c.fromFrequency,
          toFrequency:   c.toFrequency,
          closed:        !!c.closed,
        })),
      },
    }));
}

export function gateForfeitureNewsRows({ worldId, week, releases, lockoutWeeks, nameOf }) {
  // One item per airport, not per gate.
  const byKey = new Map();
  for (const r of releases ?? []) {
    if (!r?.airlineId || !r?.airportCode || !(r.count > 0)) continue;
    const key = `${r.airlineId}:${r.airportCode}`;
    byKey.set(key, (byKey.get(key) ?? 0) + r.count);
  }
  return [...byKey.entries()].map(([key, gates]) => {
    const [airlineId, airport] = key.split(':');
    return {
      worldId, week, category: 'airports', kind: 'gate_forfeited', tier: 1,
      airlineId,
      payload: {
        airport,
        gates,
        lockoutWeeks: lockoutWeeks ?? null,
        lockedUntilWeek: lockoutWeeks ? week + lockoutWeeks : null,
        name: nameOf?.get?.(airlineId) ?? null,
      },
    };
  });
}

/** Rows for events that started or ended this week. */
export function worldEventNewsRows({ worldId, week, prevEvents, nextEvents }) {
  const prevIds = new Set((prevEvents ?? []).map((e) => e.id));
  const nextIds = new Set((nextEvents ?? []).map((e) => e.id));
  const rows = [];
  for (const e of nextEvents ?? []) {
    if (prevIds.has(e.id)) continue;
    rows.push({
      worldId, week, category: 'world', kind: 'event_started', tier: 1,
      payload: {
        eventId: e.id, name: e.name, icon: e.icon, type: e.type, color: e.color,
        description: e.resolvedDesc ?? e.description ?? null,
        weeksRemaining: e.weeksRemaining ?? null,
      },
    });
  }
  for (const e of prevEvents ?? []) {
    if (nextIds.has(e.id)) continue;
    rows.push({
      worldId, week, category: 'world', kind: 'event_ended', tier: 1,
      payload: { eventId: e.id, name: e.name, icon: e.icon, type: e.type },
    });
  }
  return rows;
}

/** A row per airline that failed this week. */
export function bankruptcyNewsRows({ worldId, week, bankrupt }) {
  return (bankrupt ?? []).map((b) => ({
    worldId, week, category: 'standings', kind: 'bankruptcy', tier: 1,
    airlineId: b.airlineId,
    payload: { name: b.name ?? null, rank: b.rank ?? null, routes: b.routes ?? null, fleet: b.fleet ?? null },
  }));
}

/**
 * Rows for airlines entering or leaving the top 5.
 *
 * Only the top 5 is newsworthy: in a 40-player world every other shuffle is
 * noise, and a "moved from 27th to 26th" item would bury the real news.
 *
 * @param {string[]} prevTop5  airline ids, best first, from last week
 * @param {string[]} nextTop5  airline ids, best first, this week
 */
export function rankChangeNewsRows({ worldId, week, prevTop5, nextTop5, nameOf }) {
  const before = new Set(prevTop5 ?? []);
  const after = new Set(nextTop5 ?? []);
  const rows = [];
  for (const id of nextTop5 ?? []) {
    if (before.has(id)) continue;
    rows.push({
      worldId, week, category: 'standings', kind: 'rank_change', tier: 1,
      airlineId: id,
      payload: {
        direction: 'in',
        rank: (nextTop5 ?? []).indexOf(id) + 1,
        previousRank: null,
        name: nameOf?.get?.(id) ?? null,
      },
    });
  }
  for (const id of prevTop5 ?? []) {
    if (after.has(id)) continue;
    rows.push({
      worldId, week, category: 'standings', kind: 'rank_change', tier: 1,
      airlineId: id,
      payload: {
        direction: 'out',
        rank: null,
        previousRank: (prevTop5 ?? []).indexOf(id) + 1,
        name: nameOf?.get?.(id) ?? null,
      },
    });
  }
  return rows;
}
