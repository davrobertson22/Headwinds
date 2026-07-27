// /worlds/:id/airline + /worlds/:id/decisions — Phase 2 gameplay.
//
// The client never computes outcomes. It reads its authoritative state blob from
// GET /worlds/:id/airline and submits INTENTS to POST /worlds/:id/decisions; the
// server validates the action type against the allow-list and re-runs it through
// the shared engine reducer. Every accepted decision is also journaled to the
// Decision table (audit trail + Phase-3 replay/anti-abuse analysis).
import { requireAuth } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { ALLOWED_PLAYER_ACTIONS } from '../world.mjs';
import { gameReducer, gateLeaseDenial } from '@tailwinds/engine/reducer';
import { weekIndex, nextTickAt } from '../lib/tickService.mjs';
import { paceLabel } from '../lib/worldConfig.mjs';
import { buildWorldRivalViews, withRivals, stripRivals, loadAllianceMap } from '../lib/humanRivals.mjs';
import { guardDecision } from '../lib/decisionGuard.mjs';
import { isGateScarcity, applyGateDecisionTx } from '../lib/gateService.mjs';
import { listSoldAircraftTx } from '../lib/aircraftMarketService.mjs';
import { allow } from '../lib/rateLimit.mjs';
import { sharesOf, svpsScore } from '@tailwinds/engine/utils/market.js';
import {
  ensureWorldMarket, marketViewFor, applyTradeToPoolTx, applyCapitalActionToPoolTx,
  MarketError,
} from '../lib/marketService.mjs';

// Per-account decision throttle. Generous enough that no human bursting through
// the UI is ever affected (60 in 10s ≈ 6/s), but a scripted flood hits 429 fast,
// so it can't bloat the Decision table / Supabase egress or hammer rivals' locks.
const DECISION_LIMIT   = 60;
const DECISION_WINDOWMS = 10_000;

// A cheap change detector for a whole world: any decision or tick bumps an
// airline's version, and joins/abandons change the active count, so this pair
// moves whenever ANYTHING a client could see has changed. It costs one tiny
// aggregate row from the DB — vs. the full state blobs it lets us skip.
async function worldStampOf(worldId) {
  const agg = await prisma.airline.aggregate({
    where: { worldId, status: 'ACTIVE' },
    _sum: { version: true },
    _count: { _all: true },
  });
  return `${agg._sum.version ?? 0}.${agg._count._all}`;
}

// Live rival view for one airline (validated by the world stamp — never
// stale-from-blob, and shared across every player polling this world).
async function rivalViewFor(airline, worldStamp) {
  const views = await buildWorldRivalViews(prisma, airline.worldId, { stamp: worldStamp });
  return views.get(airline.id) ?? { competitors: [], humanRivals: {}, alliance: null };
}

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// The action TYPE is allow-listed, but payload fields were previously trusted
// verbatim. Reject non-finite / absurd numbers (any depth) so a crafted decision
// can't overflow cash or feed NaN into the reducer.
function assertFinitePayload(v, path = 'payload') {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Math.abs(v) > 1e10) throw httpError(400, `Invalid numeric value at ${path}`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => assertFinitePayload(x, `${path}[${i}]`));
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) assertFinitePayload(val, `${path}.${k}`);
  }
}

// Thrown inside the decision transaction when the optimistic version check fails
// (the worker tick or another decision changed this airline first).
class DecisionConflict extends Error {}
const toBig = (v) => { const n = Math.round(Number(v)); return BigInt(Number.isFinite(n) ? n : 0); };

async function loadMyAirline(request) {
  const airline = await prisma.airline.findUnique({
    where: {
      worldId_accountId: {
        worldId: request.params.id,
        accountId: request.account.id,
      },
    },
    include: { world: true },
  });
  if (!airline) throw httpError(404, 'You have no airline in this world');
  return airline;
}

export default async function decisionRoutes(fastify) {
  // ── Your authoritative airline state (the full save blob) ─────────────────
  // Egress-aware: the client passes back the `stamp` from its last response;
  // when nothing in the world has changed (the overwhelmingly common case — the
  // game polls every ~25s, worlds tick hourly) we answer from three tiny reads
  // and never touch a state blob. Only a changed stamp pays for the full load.
  fastify.get('/worlds/:id/airline', {
    preHandler: requireAuth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        properties: { stamp: { type: 'string', maxLength: 80 } },
      },
    },
  }, async (request) => {
    const slim = await prisma.airline.findUnique({
      where: {
        worldId_accountId: { worldId: request.params.id, accountId: request.account.id },
      },
      select: { id: true, worldId: true, version: true, status: true, week: true },
    });
    if (!slim) throw httpError(404, 'You have no airline in this world');

    const world = await prisma.world.findUnique({ where: { id: slim.worldId } });
    const worldStamp = await worldStampOf(slim.worldId);
    const stamp = `${slim.version}:${worldStamp}`;
    const dueAt = nextTickAt(world);
    const base = {
      airlineId: slim.id,
      status: slim.status,
      week: slim.week,
      worldStatus: world.status,
      worldClock: {
        week: world.currentWeek,
        year: world.currentYear,
        // Countdown material for the game bar: when the next week lands (null
        // for LOBBY/ENDED worlds) and the world's human-readable pace.
        nextTickAt: dueAt ? dueAt.toISOString() : null,
        paceLabel: paceLabel(world.weeksPerDay),
      },
      stamp,
    };
    if (request.query.stamp && request.query.stamp === stamp) {
      return { ...base, unchanged: true };
    }

    // Something changed (or first load): full blob + the CURRENT rival view so
    // the Rivals tab and demand previews show other humans as they are right
    // now, not as of the last tick.
    const airline = await prisma.airline.findUnique({ where: { id: slim.id } });
    const view = await rivalViewFor(airline, worldStamp);
    return { ...base, state: withRivals(airline.state, view) };
  });

  // ── Submit a decision (validated intent → authoritative reducer) ───────────
  fastify.post('/worlds/:id/decisions', {
    preHandler: requireAuth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', maxLength: 40 },
          payload: { type: 'object', additionalProperties: true },
        },
      },
    },
  }, async (request, reply) => {
    const { type, payload = {} } = request.body;

    if (!allow(`dec:${request.account.id}`, DECISION_LIMIT, DECISION_WINDOWMS)) {
      throw httpError(429, 'You are submitting actions too quickly — slow down a moment.');
    }

    if (!ALLOWED_PLAYER_ACTIONS.has(type)) {
      throw httpError(403, `Action not allowed: ${type}`);
    }
    // You can't buy out a human. Acquisitions were a solo-game mechanic against
    // AI carriers; in Headwinds every competitor is a real player.
    if (type === 'ACQUIRE_COMPETITOR') {
      throw httpError(403, 'Acquisitions are disabled in multiplayer — your rivals are real people.');
    }
    // Alliance membership is server-governed in Headwinds (create/join/approve
    // in the world lobby) — the solo reducer actions would bypass the founder.
    if (type === 'JOIN_ALLIANCE' || type === 'LEAVE_ALLIANCE') {
      throw httpError(403, 'Alliances in Headwinds are managed from the world lobby, not in-game.');
    }
    // Defense in depth: a payload can't override the validated type.
    if ('type' in payload) delete payload.type;
    assertFinitePayload(payload);

    const airline = await loadMyAirline(request);
    if (airline.status !== 'ACTIVE') throw httpError(409, `Your airline is ${airline.status}`);
    if (airline.world.status !== 'RUNNING') throw httpError(409, `This world is ${airline.world.status}`);

    // Server-authoritative validation of economic values the solo client would
    // normally clamp in its UI (loan terms, cabin layout, reconfigure cost). The
    // client is untrusted in multiplayer; re-derive/bound these before the reducer.
    // Guards may also SANITIZE: the returned payload (e.g. stock trades come
    // back whitelisted to { targetId, shares }) is what actually runs & journals.
    const guarded = guardDecision(type, payload, airline.state) ?? payload;

    // Journal enrichment: route-close payloads only carry ids, which mean
    // nothing once the routes are gone. Resolve ids to origin/destination pairs
    // from the PRE-reducer state so the world feed can say "closed SFO–MSP"
    // instead of "closed ?–?". The enriched copy is journalled only; the
    // reducer still runs on `guarded` untouched.
    let journalled = guarded;
    if (type === 'CLOSE_ROUTE' || type === 'CLOSE_ROUTES' || type === 'CLOSE_CARGO_ROUTE') {
      const pool = type === 'CLOSE_CARGO_ROUTE'
        ? (airline.state?.cargoRoutes ?? [])
        : (airline.state?.routes ?? []);
      const ids = type === 'CLOSE_ROUTES'
        ? (guarded.routeIds ?? (guarded.routeId != null ? [guarded.routeId] : []))
        : (guarded.routeId != null ? [guarded.routeId] : []);
      const pairs = pool
        .filter((r) => ids.includes(r.id))
        .map((r) => ({ origin: r.origin, destination: r.destination }));
      if (pairs.length === 1 && type !== 'CLOSE_ROUTES') {
        journalled = { ...guarded, origin: pairs[0].origin, destination: pairs[0].destination };
      } else if (pairs.length > 0) {
        journalled = { ...guarded, routes: pairs.slice(0, 20), count: pairs.length };
      }
    }

    // Authoritative computation — same reducer as the solo game and the tick.
    // Run it over the rival-injected view so (a) the stored blob is scrubbed of
    // any pre-humans-only AI competitors, and (b) the response the client
    // re-renders from shows the same rivals the read path does.
    const view = await rivalViewFor(airline, await worldStampOf(airline.worldId));
    const injected = withRivals(airline.state, view);

    // Gate scarcity worlds: surface a FRIENDLY reason instead of a silent no-op
    // when a lease is not allowed (capacity / caps / lockout). The engine's own
    // ADD_GATE check would just return state unchanged.
    const scarcity = isGateScarcity(airline.world);
    if (scarcity && type === 'ADD_GATE') {
      const denial = gateLeaseDenial(injected, guarded.airportCode);
      if (denial) throw httpError(400, denial);
    }

    // Float pool: share trades settle against the world's finite pool, so the
    // engine needs to see how much cash and inventory it has left. Injected onto
    // STATE (server-owned, like `competitors`) rather than the action, so a client
    // can never forge it — and stripped again by stripRivals before the blob write.
    const isStockTrade = type === 'BUY_STOCK' || type === 'SELL_STOCK';
    // Capital actions settle against the pool too: an issue draws its proceeds from
    // investor cash, a buyback hands cash back and retires stock out of inventory.
    const isCapitalAction = type === 'GO_PUBLIC' || type === 'ISSUE_SHARES'
                         || type === 'BUY_BACK_SHARES';
    let market = null;
    if (isStockTrade || isCapitalAction) {
      market = await ensureWorldMarket(prisma, airline.worldId);
      const tradeTarget = (injected.competitors ?? []).find((c) => c.id === guarded.targetId);
      injected.worldMarket = marketViewFor(market, tradeTarget, {
        id: airline.id, ...(injected.equity ?? {}),
      });
    }

    const next = gameReducer(injected, { type, ...guarded });

    // A capital action the pool could not fund comes back unchanged. Explain it
    // rather than leaving the player with a button that appears to do nothing.
    if (isCapitalAction && market && next === injected) {
      const view = injected.worldMarket;
      if (type === 'BUY_BACK_SHARES' && view && view.selfSharesHeld <= 0) {
        throw httpError(409, 'None of your shares are in public hands to buy back.');
      }
      if (type !== 'BUY_BACK_SHARES' && view && view.poolCash <= 0) {
        throw httpError(409, 'The equity window is shut — there is no investor capital left in this world.');
      }
    }

    // A trade the pool could not support comes back as an unchanged state. Say why
    // instead of returning a silent no-op the player reads as a broken button.
    if (isStockTrade && market && next === injected) {
      const view = injected.worldMarket;
      if (type === 'SELL_STOCK' && view && view.poolCash <= 0) {
        throw httpError(409, 'There are no buyers left in this market right now.');
      }
      if (type === 'BUY_STOCK' && view && view.sharesAvailable <= 0) {
        throw httpError(409, 'None of that airline\'s float is available — other investors hold it all.');
      }
    }

    // Journal enrichment (post-reducer): the public share tape needs the size the
    // trade actually executed at and the resulting stake, and NEITHER is in the
    // request — the guard whitelists stock payloads down to { targetId, shares },
    // and the reducer may fill less than asked (ownership cap, portfolio cap,
    // funds, minimum ticket) or nothing at all. Read the truth off `next`.
    //
    // A rejected trade is journalled with shares: 0 so the news builder can tell
    // it apart from a real one and print nothing, rather than reporting a trade
    // that never happened.
    if (type === 'BUY_STOCK' || type === 'SELL_STOCK') {
      const target      = (injected.competitors ?? []).find((c) => c.id === guarded.targetId);
      const heldBefore  = injected.portfolio?.holdings?.[guarded.targetId]?.shares ?? 0;
      const heldAfter   = next.portfolio?.holdings?.[guarded.targetId]?.shares ?? 0;
      const traded      = Math.abs(heldAfter - heldBefore);
      // Divide by the TARGET's own share count, not a global constant: since the
      // capital-markets rework each airline's float moves with issuance and
      // buybacks, so a fixed divisor would misstate the stake.
      const float       = sharesOf(target);
      const price       = target?.sharePrice ?? ((target?.marketCap ?? 0) / float);
      const pct         = (n) => Math.round((n / float) * 1000) / 10;   // 0.1% resolution
      journalled = traded > 0
        ? {
            ...journalled,
            targetId:       guarded.targetId,
            targetName:     target?.name ?? null,
            shares:         traded,
            pricePerShare:  Math.round(price),
            value:          Math.round(traded * price),
            // Stake before and after, so the news layer can tell whether this
            // dealing crossed a disclosure threshold without re-deriving the
            // float (which may have changed since).
            stakePctBefore: pct(heldBefore),
            stakePct:       pct(heldAfter),
          }
        : { ...journalled, shares: 0 };
    }

    // Did this decision actually change the airline's gate count? (The reducer
    // no-ops rejected leases/removals — no ledger entry must be written then.)
    const gateDelta = (type === 'ADD_GATE' || type === 'REMOVE_GATE')
      ? ((next.gates?.[guarded.airportCode] ?? 0) - (airline.state?.gates?.[guarded.airportCode] ?? 0))
      : 0;
    const allianceMap = (scarcity && type === 'ADD_GATE' && gateDelta !== 0)
      ? await loadAllianceMap(prisma, airline.worldId)
      : new Map();

    // Keep the DB `name` column in sync with the in-game airline name. Renames
    // (SET_BRANDING) only mutate the save blob's `airlineName`; the world feed,
    // standings and rival views all read the top-level `airline.name` column, so
    // without this they keep showing the ORIGINAL name after a rename. Heal on
    // any decision whenever the two diverge (covers players who already renamed).
    const nextName = typeof next.airlineName === 'string' ? next.airlineName.trim().slice(0, 40) : '';
    const nameChanged = nextName && nextName !== airline.name;

    try {
      await prisma.$transaction(async (tx) => {
        // Gate scarcity: the world's gate ledger is the arbiter of availability.
        // Same transaction as the blob write, version-guarded — two airlines can
        // never both take the last gate. Throws GateError (400/409) on violation.
        if (scarcity && gateDelta !== 0) {
          await applyGateDecisionTx(tx, {
            worldId: airline.worldId,
            airportCode: guarded.airportCode,
            type,
            airline,
            allianceMap,
          });
        }
        // Optimistic concurrency: only write if the airline is still at the version
        // we read. If the worker tick (or another decision) got there first, bail
        // with a 409 instead of silently clobbering it — the client re-GETs + retries.
        const updated = await tx.airline.updateMany({
          where: { id: airline.id, version: airline.version },
          data: {
            // Persist WITHOUT the injected rival views (rebuilt on every read/tick).
            // The client still gets the full `next` (with rivals) in the response.
            state: stripRivals(next),
            cash: toBig(next.cash),
            marketCap: toBig(next.marketCap),
            // Issuance and buybacks move the share count, and the share count is the
            // SVPS divisor — so the denormalised columns the standings read must move
            // with them, not wait for the next tick.
            ...(next.equity?.shares > 0 ? { shares: BigInt(Math.round(next.equity.shares)) } : {}),
            ...(Number.isFinite(next.svps) ? { svps: BigInt(svpsScore(next.svps)) } : {}),
            ...(nameChanged ? { name: nextName } : {}),
            version: { increment: 1 },
          },
        });
        if (updated.count === 0) throw new DecisionConflict();

        // Settle the executed trade against the pool in the SAME transaction, so
        // two simultaneous sells can never both spend the same pool cash. Keyed off
        // next.lastStockTrade (what actually executed) — never the request, which
        // the reducer may have filled short or rejected outright.
        if (isStockTrade && market && next.lastStockTrade?.shares > 0) {
          const tradeTarget = (injected.competitors ?? []).find((c) => c.id === guarded.targetId);
          await applyTradeToPoolTx(tx, {
            market, trade: next.lastStockTrade, targetState: tradeTarget,
          });
        }

        // Same for an executed capital action. `selfBefore` is the share state as it
        // was BEFORE the reducer ran, because that is what the pool's inventory
        // fallback is derived from.
        if (isCapitalAction && market && next.lastEquityAction?.shares > 0) {
          await applyCapitalActionToPoolTx(tx, {
            market,
            action: next.lastEquityAction,
            airlineId: airline.id,
            selfBefore: { id: airline.id, ...(airline.state?.equity ?? {}) },
          });
        }
        await tx.decision.create({
          data: {
            worldId: airline.worldId,
            airlineId: airline.id,
            week: weekIndex(airline.world),
            type,
            payload: journalled,
          },
        });
        // Used-aircraft market: a completed SELL_AIRCRAFT lists that exact tail in
        // the world Used Market at the NAV the sale was valued at (the reducer
        // exposes it as next.lastSale). The seller already received NAV - 5%; the
        // 5% spread is the shop's cut.
        if (type === 'SELL_AIRCRAFT' && next.lastSale && next.lastSale.aircraftId === guarded.aircraftId) {
          const sold = (airline.state?.fleet ?? []).find((a) => a.id === guarded.aircraftId);
          if (sold && sold.ownershipType === 'owned') {
            await listSoldAircraftTx(tx, {
              worldId: airline.worldId,
              sellerName: airline.name ?? airline.state?.airlineName ?? null,
              aircraft: sold,
              navPrice: next.lastSale.nav,
              weekIdx: weekIndex(airline.world),
            });
          }
        }
      });
    } catch (e) {
      if (e instanceof DecisionConflict) {
        throw httpError(409, 'Your airline just changed (a new week ticked) — reload and try again.');
      }
      // Float-pool violations lose a compare-and-set against another trade that
      // landed first. Same contract as DecisionConflict: tell the client to
      // re-read and retry rather than leaking a 500.
      if (e instanceof MarketError) throw httpError(e.status ?? 409, e.message);
      throw e;
    }

    return reply.code(201).send({
      ok: true,
      // The client re-renders from the authoritative result — no local guessing.
      state: next,
      // Engine convention: rejected/no-op intents leave state unchanged and often
      // set state.error / a toast. Surface a hint so the UI can show it.
      error: next.error ?? null,
      // Post-write stamp (our version bumped by the transaction) so the client's
      // next poll short-circuits instead of re-downloading what it already has.
      stamp: `${airline.version + 1}:${await worldStampOf(airline.worldId)}`,
    });
  });
}
