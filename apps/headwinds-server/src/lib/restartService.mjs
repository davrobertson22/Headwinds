// Second chances: re-found a bankrupt or abandoned airline in the same world.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Bankruptcy used to be terminal per world. The engine sets phase:'bankrupt'
// after three missed loan payments or six consecutive negative weeks, the tick
// writes status:'BANKRUPT', every write route 409s, and the overlay told the
// player "this world carries on without you" — over a topbar it also covered,
// so even the suggested exit was unreachable. An abandoned player had it worse:
// the world screen showed them a join form that could only ever 409, because
// Airline carries @@unique([worldId, accountId]) and joinWorld's duplicate check
// is status-blind.
//
// ── Why the row is reused rather than replaced ──────────────────────────────
// Around fifteen tables carry a bare `airlineId` STRING with no foreign key:
// Decision, Standing, Message, MessageBlock, MessageCursor, AllianceMember,
// GateBid, GateListing, DividendCredit, WorldNews and Report, plus airline ids
// embedded in the JSON of WorldGate.holdings, WorldMarket.holdings and
// GateAuction.outcomes. Inserting a second row would orphan every one of them
// silently — nothing would error, the data would just stop meaning anything.
//
// The cost of reuse is that everything above SURVIVES the re-founding, so this
// module's real job is not seeding (worldService.seedAirlineState does that
// verbatim, shared with join) but demolition. Each item in purgeAirlineFootprint
// is there because leaving it behind is an exploit, a permanent leak, or a
// visible lie about who did what.
//
// ── What is deliberately NOT handled here ───────────────────────────────────
// Two kinds of stale reference live inside OTHER players' state blobs, which
// this request must not write to: the tick holds row locks on every airline for
// up to 30 seconds, so a cross-blob write from a decision-time request would
// either lose a compare-and-set or stomp someone's optimistic edit. Both are
// instead handled by making the re-founded airline a NEW IDENTITY to the engine
// (humanRivals.rivalIdOf appends the generation):
//
//   • Rival share positions — the engine already force-liquidates any holding
//     whose competitor id leaves the rival set, paying out at
//     STOCK_MARKET.DELIST_HAIRCUT. Changing the id makes the dead company
//     delist on each holder's next tick, exactly as if it had left the world,
//     with no duplicated settlement math and no window in which a rival holds
//     stock in a company that has been replaced underneath them.
//   • Codeshare agreements — reducer.mjs's weekly countdown now also drops any
//     agreement whose partner is no longer in the rival set, which fixes the
//     older bug where a deal outlived a bankrupt partner by up to a year.
import { releaseAllFor, seedHubGate } from './gateService.mjs';
import { poolKeyOf } from './marketService.mjs';
import { seedAirlineState, OG_NAME_PATTERN } from './worldService.mjs';
import { splitLogo } from './logoColumn.mjs';
import { svpsOf, svpsScore } from '@tailwinds/engine/utils/market.js';
// The cap lives in worldConfig (bottom of the import graph) so serializeAirline
// can publish restartsLeft without importing this module and creating a cycle.
import { MAX_RESTARTS } from './worldConfig.mjs';

/** Second chances per world. Four lives total: the original plus three. */
export { MAX_RESTARTS };

/** Which statuses may be re-founded. ACTIVE airlines are explicitly not on it. */
export const RESTARTABLE = new Set(['BANKRUPT', 'ABANDONED']);

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

/** Linear week index — the same arithmetic joinWorld and the tick use. */
function linearWeek(world) {
  return (world.currentYear - 1) * 52 + world.currentWeek;
}

/**
 * How many restarts this airline has left.
 *
 * Exported so the guard, the route's 409 message and the client's button label
 * all read the same number rather than three copies of `3 - restarts`.
 */
export function restartsLeft(airline) {
  return Math.max(0, MAX_RESTARTS - (Number(airline?.restarts ?? 0) || 0));
}

/**
 * Drop the world-level footprint of one airline.
 *
 * Ordered so that anything which could double-count runs before the re-seed:
 * gates are released BEFORE seedHubGate adds the new hub back, or a player who
 * re-founds at a different airport permanently inflates `taken` at the old one.
 *
 * Best-effort by design and never throws: a failure here must not strand the
 * player in a world they cannot re-enter. Every branch logs, and each leftover
 * is independently repairable (tools/reconcile-gates.mjs for the ledger, the
 * unconsumed-credit sweep on the next tick for dividends).
 */
export async function purgeAirlineFootprint(prisma, worldId, airlineId, { log = console } = {}) {
  const problems = [];
  const step = async (what, fn) => {
    try { await fn(); } catch (err) {
      problems.push(what);
      log.error?.(`[restart] ${worldId}/${airlineId} ${what} failed: ${err?.message ?? err}`);
    }
  };

  // ── Gates ─────────────────────────────────────────────────────────────────
  // Clears WorldGate.holdings[airlineId] at every airport (decrementing `taken`)
  // and withdraws the airline's OPEN listings. Called unconditionally, not only
  // on gate-scarcity worlds: the bankruptcy hook in tickService is gated on
  // isGateScarcity AND best-effort AND post-commit, so a world that had scarcity
  // toggled, or a hook that threw, can leave rows behind. On a world with no
  // ledger this is a no-op findMany.
  await step('gate release', () => releaseAllFor(prisma, worldId, airlineId, { log }));

  // ── Sealed auction bids ───────────────────────────────────────────────────
  // Bids are NOT cleared by bankruptcy — resolution merely records the bidder as
  // AIRLINE_INACTIVE. That is fine while the airline stays dead, but a restart
  // before the auction resolves makes it ACTIVE again, and resolveDueAuctions
  // re-reads the row fresh: the new company would be charged amount x quantity
  // for gates the player it replaced bid on, with no way to withdraw in between.
  await step('gate bids', () => prisma.gateBid.deleteMany({
    where: { airlineId, auction: { worldId, status: 'OPEN' } },
  }));

  // ── Alliance seat ─────────────────────────────────────────────────────────
  // A non-ACTIVE airline cannot call the leave route (alliances.mjs rejects it),
  // so the membership row outlives the airline. loadAllianceMap does not filter
  // by status, so a dead member keeps consuming a seat against
  // PLAYER_ALLIANCE_MAX_MEMBERS and keeps counting toward the alliance gate cap
  // — and if it was the FOUNDER, nobody can ever approve a join request again.
  // Succession mirrors the leave route: longest-standing active member inherits,
  // and an alliance with no one left disbands.
  await step('alliance membership', async () => {
    const mine = await prisma.allianceMember.findUnique({ where: { airlineId } });
    if (!mine) return;
    await prisma.allianceMember.delete({ where: { id: mine.id } });
    if (mine.role !== 'FOUNDER' || mine.status !== 'ACTIVE') return;
    const siblings = await prisma.allianceMember.findMany({
      where: { allianceId: mine.allianceId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (siblings.length > 0) {
      await prisma.allianceMember.update({ where: { id: siblings[0].id }, data: { role: 'FOUNDER' } });
    } else {
      await prisma.alliance.delete({ where: { id: mine.allianceId } });
    }
  });

  // ── Float-pool inventory ──────────────────────────────────────────────────
  // The pool's recorded share count for an airline is never zeroed on
  // bankruptcy, and poolSharesFor PREFERS the recorded number over the free
  // float derived from the blob. A fresh blob is private with zero real float,
  // so leaving the old entry means the pool still believes it holds tens of
  // millions of shares in the new company — and the moment that company IPOs,
  // applyCapitalActionToPoolTx adds the issue on top of the stale number and
  // the pool can sell more shares than exist. Deleting the entry restores the
  // "missing means untouched, derive from the blob" default.
  //
  // Both spellings go, and the write is guarded on the row version the same way
  // every other pool mutation is, so a trade landing concurrently is not lost.
  await step('float pool inventory', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const market = await prisma.worldMarket.findUnique({ where: { worldId } });
      if (!market) return;
      const holdings = { ...(market.holdings && typeof market.holdings === 'object' ? market.holdings : {}) };
      const key = poolKeyOf(airlineId);
      const doomed = Object.keys(holdings).filter((k) => poolKeyOf(k) === key);
      if (doomed.length === 0) return;
      for (const k of doomed) delete holdings[k];
      const res = await prisma.worldMarket.updateMany({
        where: { id: market.id, version: market.version },
        data: { holdings, version: { increment: 1 } },
      });
      if (res.count > 0) return;
    }
    throw new Error('worldMarket version conflict after 3 attempts');
  });

  // ── Unconsumed dividends ──────────────────────────────────────────────────
  // Credits are only consumed when the RECIPIENT's own tick write lands, and the
  // tick reads only ACTIVE airlines — so every dividend owed to this airline
  // from before it died is still sitting unconsumed with no expiry. Flip the row
  // back to ACTIVE and the very next tick injects the whole backlog as
  // incomingDividends: free cash, booked as investment income, that the new
  // company never earned.
  await step('unconsumed dividends', () => prisma.dividendCredit.deleteMany({
    where: { worldId, airlineId, consumed: false },
  }));

  // ── Alliance-chat read cursor ─────────────────────────────────────────────
  // Cosmetic, but a stale cursor makes the new airline's alliance channel open
  // at zero unread on a conversation it has never seen.
  await step('message cursor', () => prisma.messageCursor.deleteMany({ where: { airlineId } }));

  return { ok: problems.length === 0, problems };
}

/**
 * Re-found a bankrupt or abandoned airline in place.
 *
 * Returns the updated Airline row. Throws httpError for every refusal so the
 * route can surface it verbatim.
 */
export async function restartAirline(prisma, { account, world, airline, airlineName, hub, log = console }) {
  if (!airline) throw httpError(404, 'You are not in this world');
  if (airline.accountId !== account.id) throw httpError(403, 'That is not your airline');

  if (world.status === 'ENDED' || world.status === 'ARCHIVED') {
    throw httpError(409, 'This world has ended');
  }
  if (!RESTARTABLE.has(airline.status)) {
    // The common case is a double-submit from a client that already restarted.
    throw httpError(409, airline.status === 'ACTIVE'
      ? 'Your airline is still flying — there is nothing to restart.'
      : `Your airline is ${airline.status}`);
  }
  if (restartsLeft(airline) <= 0) {
    throw httpError(409, `You have used all ${MAX_RESTARTS} restarts in this world.`);
  }
  if (OG_NAME_PATTERN.test(airlineName ?? '')) {
    throw httpError(400, 'OG and DEV tags are reserved — they appear automatically as badges, not in the airline name.');
  }

  // Capacity is deliberately NOT re-checked. The row already exists and already
  // counts toward the world's player total (airline.count filters no status), so
  // re-founding consumes no new seat — and refusing a restart because the world
  // filled up while the player was bankrupt would strand them permanently.

  const tc = world.tickConfig ?? {};
  const previous = airline.state ?? {};

  // The world's real fare ladder, not the one tickConfig was created with. A
  // retuned world reads its index back off an existing airline's blob
  // (humanRivals setFareIndex), so re-seeding from tickConfig could hand the
  // re-founded airline a ladder 15% away from everyone else's.
  const state = seedAirlineState(world, {
    airlineName,
    hub,
    fareIndexOverride: previous.fareIndex,
  });

  // Demolish before rebuilding — gate release in particular MUST precede the
  // hub-gate seed below, or a player re-founding at a new airport leaves a
  // phantom gate held at the old one forever.
  const purge = await purgeAirlineFootprint(prisma, world.id, airline.id, { log });

  const week = linearWeek(world);
  const svps = svpsOf(state);
  const updated = await prisma.airline.update({
    where: { id: airline.id },
    data: {
      name: state.airlineName,
      hub: state.hub ?? hub,
      homeCountry: state.homeCountry ?? null,
      // The re-founded company is a fresh airline: strip the template's
      // customLogo key from the blob (lib/logoColumn.mjs — the key never
      // persists) and null the column so the dead company's upload does not
      // survive onto the new one. Same net behaviour as before the column
      // existed, when the fresh blob's customLogo: null did the clearing.
      state: splitLogo(state).state,
      customLogo: null,
      cash: BigInt(Math.round(state.cash ?? 0)),
      marketCap: BigInt(Math.round(state.marketCap ?? 0)),
      // Both denormalised columns must be rewritten here. The tick is what
      // normally maintains them, and it will not touch this row until the next
      // week lands — so without these the standings would keep showing the dead
      // company's share count and leaderboard score on a live airline.
      shares: BigInt(100_000_000),
      svps: BigInt(svpsScore(svps)),
      week,
      status: 'ACTIVE',
      restarts: { increment: 1 },
      restartedWeek: week,
      // Invalidates any decision the player had in flight against the old blob,
      // and moves the world stamp so every open client refetches.
      version: { increment: 1 },
    },
  });

  // Mirror the starter hub gate into the world ledger — after the release above,
  // never before. Part of the home-hub guarantee, so it seeds even at a full
  // airport (the overshoot counts toward fullness), exactly as at join.
  if (tc.gateScarcity === true) {
    try {
      await seedHubGate(prisma, world.id, state.hub ?? hub, airline.id);
    } catch (err) {
      log.error?.(`[restart] ${world.id}/${airline.id} hub gate seed failed: ${err?.message ?? err}`);
    }
  }

  // A comeback is the best story a persistent world produces, and until now it
  // left no trace: `joined` news keys on the row's original createdAt, which a
  // reused airline row predates, so a re-founding was silent. This durable
  // tier-1 row is the record — and it feeds the Phoenix career badge's story.
  // Best-effort: a news failure must never fail the restart itself.
  try {
    await prisma.worldNews.create({
      data: {
        worldId: world.id,
        week,
        category: 'world',
        kind: 'refounded',
        airlineId: airline.id,
        payload: { name: state.airlineName, hub: state.hub ?? hub, restarts: updated.restarts },
        tier: 1,
      },
    });
  } catch (err) {
    log.error?.(`[restart] ${world.id}/${airline.id} refounded news write failed: ${err?.message ?? err}`);
  }

  log.info?.(`[restart] ${world.id}/${airline.id} re-founded as "${state.airlineName}" at ${state.hub} `
    + `(restart ${updated.restarts}/${MAX_RESTARTS}, week ${week})`
    + (purge.ok ? '' : ` — PARTIAL PURGE: ${purge.problems.join(', ')}`));

  return updated;
}
