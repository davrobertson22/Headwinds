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
  // ── Airports & hubs ────────────────────────────────────────────────────────
  'ADD_GATE', 'REMOVE_GATE', 'UPGRADE_HUB', 'DESIGNATE_HUB', 'DESIGNATE_FOCUS_CITY',
  // ── Alliances ──────────────────────────────────────────────────────────────
  'JOIN_ALLIANCE', 'LEAVE_ALLIANCE',
  // ── Share dealings: Headwinds runs a FULL PUBLIC TAPE — every trade prints ──
  // Only world-priced, already-public figures are published (see the scrubber).
  // The reducer prices trades from the server-injected rival view, never from
  // the request, so the price on the tape is the world's price.
  'BUY_STOCK', 'SELL_STOCK',
]);

export const STOCK_DECISIONS = new Set(['BUY_STOCK', 'SELL_STOCK']);

const str = (v, max = 60) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);

// Only the payload fields that describe a PUBLIC move — never echo payloads raw.
export function publicPayload(d) {
  const p = d?.payload ?? {};
  const quantity = Number.isFinite(p.quantity)
    ? Math.max(1, Math.min(100, Math.round(p.quantity)))
    : null;
  return {
    ...(p.origin ? { origin: p.origin } : {}),
    ...(p.destination ? { destination: p.destination } : {}),
    ...(p.typeId ? { typeId: p.typeId } : {}),
    ...(p.airportCode ? { airportCode: p.airportCode } : {}),
    ...(p.allianceId ? { allianceId: p.allianceId } : {}),
    // Batched route closes: pass through only scrubbed origin/destination
    // pairs (public info) and the count — never raw ids or anything else.
    ...(Array.isArray(p.routes) ? {
      routes: p.routes
        .filter((r) => r && r.origin && r.destination)
        .slice(0, 20)
        .map((r) => ({ origin: r.origin, destination: r.destination })),
    } : {}),
    ...(Number.isFinite(p.count) ? { count: p.count } : {}),
    // Multi-unit orders: ORDER_AIRCRAFT buys 1–100 frames in one decision
    // (reducer clamps to that range). Without this the feed reported a
    // twelve-frame order as "ordered a 737-800" — the count vanished entirely.
    // Omitted when 1 so single orders read naturally.
    ...(quantity && quantity > 1 ? { quantity } : {}),
    // Tag (multi-stop) routes: the stop list IS the schedule, so it is public.
    ...(Array.isArray(p.stops) ? {
      stops: p.stops.filter((s) => typeof s === 'string').slice(0, 8),
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
