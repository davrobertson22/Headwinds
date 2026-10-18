// Public-move allowlist + payload scrubber — ONE source of truth.
//
// Everything a player may learn about another player's actions passes through
// this file: the rival profile (/worlds/:id/rivals/:airlineId), the world news
// feed (/worlds/:id/news) and the legacy activity ticker (/worlds/:id/feed).
// Nothing outside this module decides what is public.
//
// The rule: an action is public if a real-world observer standing in an airport
// — or reading a market filing — could see it. Published schedules, fleet on the
// ramp, gates, hubs, alliance membership and share dealings all qualify. Cash,
// loans, hedges, budgets, marketing spend and per-route P&L never do, and must
// not appear in any field added below.

export const PUBLIC_DECISIONS = new Set([
  // ── Network: a published schedule is public by definition ──────────────────
  'ADD_ROUTE', 'CLOSE_ROUTE', 'CLOSE_ROUTES',
  'ADD_CARGO_ROUTE', 'CLOSE_CARGO_ROUTE',
  'ADD_TAG_ROUTE',
  // ── Fleet: deliveries and disposals are visible on the ramp ────────────────
  // NOTE: LEASE_AIRCRAFT is deliberately ABSENT. It is not in
  // ALLOWED_PLAYER_ACTIONS (multiplayer leasing goes through ORDER_AIRCRAFT), so
  // no Headwinds decision row can ever carry it — listing it here only misled
  // readers into thinking leases were being reported.
  //
  // TRANSFER_ROUTES is also absent, and deliberately: it moves routes between
  // two of your OWN tails. Nothing about the market changes, so it is not news.
  'BUY_AIRCRAFT', 'SELL_AIRCRAFT', 'RETIRE_AIRCRAFT', 'ORDER_AIRCRAFT',
  // Batched disposals are the same move as the single ones, just N at a time;
  // leaving them out meant a 30-tail fleet sale never reached the feed at all.
  // An order cancellation is public for the same reason the order was: it is
  // in the manufacturer's (or lessor's) order book. All three are only public
  // when journalled with their executed counts — see EXECUTED_ONLY below.
  'SELL_AIRCRAFT_BULK', 'RETIRE_AIRCRAFT_BULK', 'CANCEL_ORDER',
  // ── Airports & hubs ────────────────────────────────────────────────────────
  'ADD_GATE', 'REMOVE_GATE', 'UPGRADE_HUB', 'DESIGNATE_HUB', 'DESIGNATE_FOCUS_CITY',
  // A lounge is a room with your name over the door in a public terminal — you
  // cannot build one quietly, and rivals price against it. CLOSE_LOUNGE is
  // deliberately absent for the same reason RETIRE-style retreats are handled
  // carefully elsewhere: it is a withdrawal, and the airport notices soon enough.
  // SET_LOUNGE_POLICY is absent too — who you let in free is commercial policy,
  // not a public fact, and it is exactly the sort of thing rivals should have to
  // infer rather than read off a feed.
  'BUILD_LOUNGE',
  // ── Alliances ──────────────────────────────────────────────────────────────
  'JOIN_ALLIANCE', 'LEAVE_ALLIANCE',
  // ── Share dealings: Headwinds runs a FULL PUBLIC TAPE — every trade prints ──
  // Only world-priced, already-public figures are published (see the scrubber).
  // The reducer prices trades from the server-injected rival view, never from
  // the request, so the price on the tape is the world's price.
  'BUY_STOCK', 'SELL_STOCK',
]);

export const STOCK_DECISIONS = new Set(['BUY_STOCK', 'SELL_STOCK']);
const BULK_DISPOSALS = new Set(['SELL_AIRCRAFT_BULK', 'RETIRE_AIRCRAFT_BULK']);

const str = (v, max = 60) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);

// ── Identifier scrubbing ─────────────────────────────────────────────────────
// Every string below is attacker-chosen: the decision endpoint validates the
// action TYPE against an allow-list and rejects non-finite NUMBERS, but a
// payload STRING was passed through verbatim. `airportCode`, `typeId`, `origin`,
// `destination` and `allianceId` all reached the world news feed and the rival
// profile raw and unbounded — so any player could compose a decision the reducer
// would refuse (see journalledPayload below) whose payload nevertheless printed
// arbitrary text, at arbitrary length, into every other player's news drawer.
//
// These are identifiers, not prose: an IATA/ICAO code is 3–4 uppercase letters,
// an aircraft type id is a short slug from the engine's data tables, and an
// alliance id is a cuid (or the 'hw:'-prefixed form the rival views use). So
// they are matched against a charset, not merely truncated — a truncated
// sentence is still a sentence, and truncation alone would have let
// "BUY GOLD AT..." through as a 40-character headline.
const matching = (re) => (v) => (typeof v === 'string' && re.test(v) ? v : null);
// 3–4 alphanumerics, upper-cased first so a legitimate lower-case code from an
// older client still publishes.
const airportish = (v) => {
  if (typeof v !== 'string') return null;
  const up = v.trim().toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(up) ? up : null;
};
const typeIdish    = matching(/^[A-Za-z0-9_-]{1,24}$/);

// { typeId: count } with every key a type-id and every value a positive int.
function typeCounts(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [k, n] of Object.entries(v).slice(0, 20)) {
    if (!typeIdish(k) || !Number.isFinite(n) || n <= 0) continue;
    out[k] = Math.min(500, Math.round(n));
  }
  return Object.keys(out).length ? out : null;
}
const allianceIdish = matching(/^[A-Za-z0-9:_-]{1,40}$/);

// Only the payload fields that describe a PUBLIC move — never echo payloads raw.
export function publicPayload(d) {
  const p = d?.payload ?? {};
  // Bounded by what the move can actually be: an order is 1–100 frames (the
  // reducer's range); a bulk sale/retire is up to 500 tails (the guard's batch).
  const maxQty = BULK_DISPOSALS.has(d?.type) ? 500 : 100;
  const quantity = Number.isFinite(p.quantity)
    ? Math.max(1, Math.min(maxQty, Math.round(p.quantity)))
    : null;
  const cancelled = Number.isFinite(p.cancelled) && p.cancelled > 0
    ? Math.min(100, Math.round(p.cancelled))
    : null;
  const byType = typeCounts(p.byType);
  const origin      = airportish(p.origin);
  const destination = airportish(p.destination);
  const airportCode = airportish(p.airportCode);
  const code        = airportish(p.code);
  const typeId      = typeIdish(p.typeId);
  const allianceId  = allianceIdish(p.allianceId);
  return {
    ...(origin ? { origin } : {}),
    ...(destination ? { destination } : {}),
    ...(typeId ? { typeId } : {}),
    ...(airportCode ? { airportCode } : {}),
    // Facility actions name their airport as `code`. Public by definition — it
    // is the same airport identifier `airportCode` carries, under the key the
    // engine action uses.
    ...(code ? { code } : {}),
    ...(allianceId ? { allianceId } : {}),
    // Batched route closes: pass through only scrubbed origin/destination
    // pairs (public info) and the count — never raw ids or anything else.
    ...(Array.isArray(p.routes) ? {
      routes: p.routes
        .map((r) => ({ origin: airportish(r?.origin), destination: airportish(r?.destination) }))
        .filter((r) => r.origin && r.destination)
        .slice(0, 20),
    } : {}),
    ...(Number.isFinite(p.count) ? { count: p.count } : {}),
    // Multi-unit orders: ORDER_AIRCRAFT buys 1–100 frames in one decision
    // (reducer clamps to that range). Without this the feed reported a
    // twelve-frame order as "ordered a 737-800" — the count vanished entirely.
    // Omitted when 1 so single orders read naturally.
    ...(quantity && quantity > 1 ? { quantity } : {}),
    // Frames an order cancellation took off the book (CANCEL_ORDER only).
    ...(cancelled ? { cancelled } : {}),
    // A batched disposal can span types: { typeId: frames }, scrubbed.
    ...(byType ? { byType } : {}),
    // Tag (multi-stop) routes: the stop list IS the schedule, so it is public.
    ...(Array.isArray(p.stops) ? {
      stops: p.stops.map(airportish).filter(Boolean).slice(0, 8),
    } : {}),
    // ── Stock tape ───────────────────────────────────────────────────────────
    // Enriched at journal time in routes/decisions.mjs from the POST-reducer
    // state, because the request payload knows neither the executed size nor the
    // resulting stake. Every field here is world-public: the share price is the
    // world's published price, and the stake is a percentage of a fixed float.
    // `shares: 0` marks a trade the reducer rejected (cap/funds/dust) — the news
    // builder drops those rather than printing a phantom trade.
    ...(p.targetId ? { targetId: str(p.targetId, 40) } : {}),
    ...(p.targetName ? { targetName: str(p.targetName, 40) } : {}),
    ...(Number.isFinite(p.shares) ? { shares: Math.max(0, int(p.shares)) } : {}),
    ...(Number.isFinite(p.pricePerShare) ? { pricePerShare: Math.max(0, int(p.pricePerShare)) } : {}),
    ...(Number.isFinite(p.value) ? { value: Math.max(0, int(p.value)) } : {}),
    ...(Number.isFinite(p.stakePct) ? { stakePct: Math.max(0, Math.min(100, p.stakePct)) } : {}),
    ...(Number.isFinite(p.stakePctBefore) ? { stakePctBefore: Math.max(0, Math.min(100, p.stakePctBefore)) } : {}),
  };
}

// ── No-op decisions are not moves ────────────────────────────────────────────
// routes/decisions.mjs journalled EVERY accepted request, including the ones the
// reducer refused outright. The engine signals a refusal by returning the SAME
// state object, so the endpoint could tell — it just never asked. The result:
// any player could pick a PUBLIC_DECISIONS type, aim it at a state that
// guarantees refusal (a hub upgrade at an airport they hold nothing at, a route
// on an aircraft they do not own), and have its payload rendered into every
// other player's news feed. Nothing happened in the game, and everybody read
// about it. Combined with the raw string fields above, that was an
// arbitrary-text broadcast channel.
//
// WHAT IS KEPT, AND WHY. The Decision row itself is still written. Its only
// consumers are the two PUBLIC ones (lib/newsService.mjs and the rival profile
// in routes/worlds.mjs) — nothing in recovery, the tick or the debrief reads it,
// and the schema documents it as "audit trail + Phase-3 replay/anti-abuse
// analysis". Dropping the row would therefore delete exactly the evidence an
// abuse investigation wants: how many refused decisions an account fired, of
// what type, in which week. What gets dropped is the attacker-controlled
// PAYLOAD, which describes an event that did not happen and is the part with no
// audit value and all of the risk. The row keeps type, week, airline and
// timestamp; `noop: true` marks it so the two public consumers skip it.
//
// This is deliberately narrower than "skip the row when nothing changed":
// idempotent settings (re-sending a fare you already charge, a lounge policy
// that already reads that way) are legitimate no-ops, and this rule treats them
// the same way — the row records that you asked, the feed does not claim you
// changed something. Neither case is news, so neither is reported.

/**
 * The payload to store on the Decision row.
 * @param {object} payload  the enriched/guarded payload
 * @param {{changed: boolean}} opts  did the reducer return a DIFFERENT state?
 */
export function journalledPayload(payload, { changed } = {}) {
  return changed ? payload : { noop: true };
}

// Types that became public only once the journal carried what EXECUTED. Rows
// written before that hold the raw request (a bulk sale's id list, a cancel's
// order id) with no count, so they are not reported rather than guessed at.
const EXECUTED_ONLY = new Set(['SELL_AIRCRAFT_BULK', 'RETIRE_AIRCRAFT_BULK', 'CANCEL_ORDER']);

/** Is this journal row a move other players may be told about? */
export function isPublicDecision(d) {
  if (!PUBLIC_DECISIONS.has(d?.type) || d?.payload?.noop === true) return false;
  return !EXECUTED_ONLY.has(d.type) || d.payload?.executed === true;
}

// ── Fleet moves: journal what HAPPENED, not what was asked for ───────────────
// The fleet rows used to carry the REQUEST. But the reducer routinely does less
// than asked: a lease order is clamped to the free order-book slots, an order is
// trimmed to what the airline can afford, and an order against a full book is
// refused outright with a toast — and a toast is a state change, so the refusal
// passed `changed` and was published as an order. Time Flies, week 1 (Discord,
// 2026-10-18): Air Canada asked for 5 + 2 + 5 lease frames against a 5-slot
// book, cancelled two, held 5 — and every player read "ordered 12× 777-200ER".
//
// So every fleet decision is measured off the before/after states:
//   ORDER_AIRCRAFT / BUY_AIRCRAFT  frames placed = new order-book lines + new
//                                  tails (multiplayer starter deliveries skip
//                                  the book and land straight in the fleet)
//   SELL / RETIRE (single + bulk)  tails that left the active fleet, by type
//   CANCEL_ORDER                   the frames on the order that is now gone
// A decision that moved no frames is not a move (`moved: false`) and is
// journalled as a no-op, whatever else its state change was.
const FLEET_MOVES = new Set([
  'ORDER_AIRCRAFT', 'BUY_AIRCRAFT',
  'SELL_AIRCRAFT', 'RETIRE_AIRCRAFT', 'SELL_AIRCRAFT_BULK', 'RETIRE_AIRCRAFT_BULK',
  'CANCEL_ORDER',
]);

const activeFleet = (s) => (s?.fleet ?? []).filter((a) => a && a.status !== 'retired');

/**
 * Measure a fleet decision from the states either side of the reducer.
 * @returns {{ journalled: object, moved: boolean }}  the payload to journal and
 *   whether any frames actually moved. Non-fleet types pass through untouched.
 */
export function withFleetFacts(type, journalled, before, after) {
  if (!FLEET_MOVES.has(type)) return { journalled, moved: true };
  if (after === before) return { journalled, moved: false };

  if (type === 'ORDER_AIRCRAFT' || type === 'BUY_AIRCRAFT') {
    const hadOrder = new Set((before?.pendingOrders ?? []).map((o) => o?.id));
    const placed = (after?.pendingOrders ?? [])
      .filter((o) => o && !hadOrder.has(o.id))
      .reduce((n, o) => n + (o.quantity ?? 1), 0);
    const hadTail = new Set((before?.fleet ?? []).map((a) => a?.id));
    const delivered = (after?.fleet ?? []).filter((a) => a && !hadTail.has(a.id)).length;
    const quantity = placed + delivered;
    return quantity > 0
      ? { journalled: { ...journalled, quantity, executed: true }, moved: true }
      : { journalled, moved: false };
  }

  if (type === 'CANCEL_ORDER') {
    const order = (before?.pendingOrders ?? []).find((o) => o?.id === journalled.orderId);
    const gone = order && !(after?.pendingOrders ?? []).some((o) => o?.id === order.id);
    return gone
      ? { journalled: { ...journalled, typeId: order.typeId, cancelled: order.quantity ?? 1, executed: true }, moved: true }
      : { journalled, moved: false };
  }

  // Disposals: tails that were active before and are not now.
  const still = new Set(activeFleet(after).map((a) => a.id));
  const left = activeFleet(before).filter((a) => !still.has(a.id));
  if (left.length === 0) return { journalled, moved: false };
  const byType = {};
  for (const a of left) byType[a.typeId] = (byType[a.typeId] ?? 0) + 1;
  const types = Object.keys(byType);
  return {
    journalled: {
      ...journalled,
      quantity: left.length,
      ...(types.length === 1 ? { typeId: types[0] } : { byType }),
      executed: true,
    },
    moved: true,
  };
}
