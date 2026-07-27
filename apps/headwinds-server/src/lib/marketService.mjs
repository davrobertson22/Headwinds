// marketService — the world's float pool: the finite counterparty for share trading.
//
// Why it exists: before this, SELL_STOCK minted cash and BUY_STOCK destroyed it
// against an infinite off-world counterparty, so the stock market was a net money
// faucet whose size was bounded only by how much players traded. Now every world
// has ONE pool with finite cash and a finite share inventory:
//
//   • a buy  pays cash INTO the pool and takes shares OUT of its inventory
//   • a sell draws cash OUT of the pool and puts shares BACK into inventory
//   • commission and capital gains tax leave the world entirely (the sinks)
//
// So net exogenous cash entering a world is bounded by seedCash forever, healed
// at POOL_REFILL_PER_YEAR and never above the seed. When the pool runs low,
// sellers get progressively worse fills (poolLiquidityDiscount in the engine) and
// eventually cannot sell at all — a market that has run out of buyers.
//
// Concurrency follows the WorldGate pattern exactly: a version column, and every
// mutation happens inside the caller's transaction with a compare-and-set, so two
// simultaneous trades can never both spend the same pool cash.

import {
  poolSeedFor, poolRefill, freeFloatOf, sharesOf, STOCK_MARKET,
} from '@tailwinds/engine/utils/market.js';
import { STARTING_CASH } from '@tailwinds/engine/reducer';

/** Thrown for pool-rule violations; carries an HTTP status like GateError. */
export class MarketError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'MarketError';
    this.status = status;
  }
}

/**
 * Canonical pool-ledger key for an airline.
 *
 * The same airline is addressed by TWO ids depending on the caller: rival-view
 * payloads (and therefore trades, whose targetId comes off a competitor entry)
 * use `human:<dbId>`, while capital actions and dividend plumbing use the raw
 * DB id. The pool ledger MUST NOT split one airline's inventory across two
 * keys — that made buybacks invisible to trades and vice versa — so every read
 * and write normalises to the raw DB id here.
 */
export function poolKeyOf(id) {
  return String(id ?? '').replace(/^human:/, '');
}

/**
 * The pool's share inventory for one airline.
 *
 * The pool starts holding every airline's entire free float (everything outside
 * the founder block) and hands it out as players buy. A missing entry therefore
 * means "untouched", not "empty" — otherwise no airline would ever be buyable.
 *
 * Reads are prefix-tolerant: ledgers written before key normalisation hold
 * entries under `human:<id>`, which stay readable (canonical key wins if both
 * somehow exist) until a write migrates them.
 */
export function poolSharesFor(market, airlineId, shareState) {
  const holdings = (market?.holdings && typeof market.holdings === 'object') ? market.holdings : {};
  const key = airlineId != null ? poolKeyOf(airlineId) : null;
  const recorded = key != null ? Number(holdings[key] ?? holdings[`human:${key}`]) : NaN;
  if (Number.isFinite(recorded)) return Math.max(0, recorded);
  return Math.max(0, Math.round(freeFloatOf(shareState)));
}

/**
 * Build the view the engine reads off `state.worldMarket`.
 *
 * Server-owned and injected onto state (like `competitors`), never client-supplied
 * and never persisted — stripRivals drops it before the blob is written.
 *
 * `sharesAvailable` is the pool's inventory of the RIVAL being traded (what a buy
 * can take). `selfSharesHeld` is its inventory of the ACTING airline's own stock —
 * what a buyback can retire, and what a dividend has to pay out to outside
 * investors. Both are needed because a capital action's counterparty is yourself.
 *
 * @param {object|null} market  the WorldMarket row, or null in a world without one
 * @param {object|null} target  the rival being traded, as a rival-view payload
 * @param {object|null} self    { id, shares, founderShares } for the acting airline
 */
export function marketViewFor(market, target, self = null) {
  if (!market) return null;
  return {
    poolCash:        Number(market.poolCash ?? 0),
    seedCash:        Number(market.seedCash ?? 0),
    sharesAvailable: target ? poolSharesFor(market, target.id, target) : 0,
    selfSharesHeld:  self ? poolSharesFor(market, self.id, self) : 0,
  };
}

/**
 * Read (or lazily create) a world's pool row.
 *
 * Worlds that were already RUNNING when the pool shipped have no row, so the seed
 * is derived from their CURRENT active player count on first touch. That is why
 * the migration needs no backfill.
 */
export async function ensureWorldMarket(prisma, worldId) {
  const existing = await prisma.worldMarket.findUnique({ where: { worldId } });
  if (existing) return existing;

  const players = await prisma.airline.count({ where: { worldId, status: 'ACTIVE' } });
  const seed = poolSeedFor(players, STARTING_CASH);
  try {
    return await prisma.worldMarket.create({
      data: { worldId, poolCash: BigInt(seed), seedCash: BigInt(seed), holdings: {} },
    });
  } catch {
    // Lost a race to another request creating the same row — read theirs.
    return prisma.worldMarket.findUnique({ where: { worldId } });
  }
}

/**
 * Settle one executed trade against the pool, inside the caller's transaction.
 *
 * `trade` is the engine's `next.lastStockTrade` — the truth about what actually
 * executed, which is NOT the request (the reducer may fill less than asked, or
 * nothing, once the ownership cap, portfolio cap, funds and minimum ticket are
 * applied). Callers must skip this entirely when the reducer produced no trade.
 *
 * Throws MarketError(409) if the compare-and-set loses, so the client re-reads and
 * retries rather than silently double-spending the pool.
 */
export async function applyTradeToPoolTx(tx, { market, trade, targetState }) {
  if (!market || !trade || !(trade.shares > 0)) return;

  const gross = Math.round(Number(trade.gross) || 0);
  const isBuy = trade.side === 'buy';
  const available = poolSharesFor(market, trade.targetId, targetState);
  const poolCash = Number(market.poolCash ?? 0);

  // Re-check the invariants here, not just in the engine: the engine validated
  // against a view read BEFORE the transaction, and another trade may have landed
  // in between. This is the authoritative check.
  if (isBuy && trade.shares > available) {
    throw new MarketError(409, 'Another investor took those shares — reload and try again.');
  }
  if (!isBuy && gross > poolCash) {
    throw new MarketError(409, 'The market cannot absorb that sale right now — try a smaller size.');
  }

  const nextCash = isBuy ? poolCash + gross : poolCash - gross;
  const nextShares = isBuy ? available - trade.shares : available + trade.shares;

  const holdings = { ...(market.holdings && typeof market.holdings === 'object' ? market.holdings : {}) };
  const key = poolKeyOf(trade.targetId);
  holdings[key] = Math.max(0, Math.round(nextShares));
  delete holdings[`human:${key}`];   // migrate any pre-normalisation entry

  const res = await tx.worldMarket.updateMany({
    where: { id: market.id, version: market.version },
    data: {
      poolCash: BigInt(Math.max(0, Math.round(nextCash))),
      holdings,
      version: { increment: 1 },
    },
  });
  if (res.count === 0) {
    throw new MarketError(409, 'The market moved while your order was placed — reload and try again.');
  }
}

/**
 * Settle a capital action (IPO, secondary offering, buyback) against the pool.
 *
 * The counterparty is the pool in every case, and the direction is the mirror of a
 * trade: issuing shares takes cash OUT of the pool and puts new shares INTO its
 * inventory; a buyback pays cash IN and retires shares out of inventory.
 *
 * Keyed off the engine's `next.lastEquityAction` — what actually executed.
 *
 * @param {object} tx
 * @param {object} p
 * @param {object} p.market     the WorldMarket row read before the transaction
 * @param {object} p.action     next.lastEquityAction
 * @param {string} p.airlineId  the acting airline
 * @param {object} p.selfBefore { shares, founderShares } BEFORE the action
 */
export async function applyCapitalActionToPoolTx(tx, { market, action, airlineId, selfBefore }) {
  if (!market || !action || !(action.shares > 0)) return;

  const gross = Math.round(Number(action.gross) || 0);
  const isBuyback = action.kind === 'buyback';
  const poolCash = Number(market.poolCash ?? 0);
  const held = poolSharesFor(market, airlineId, selfBefore);

  // Authoritative re-check: the engine validated against a view read before the
  // transaction, and another action may have landed in between.
  if (isBuyback && action.shares > held) {
    throw new MarketError(409, 'Some of those shares were traded away — reload and try again.');
  }
  if (!isBuyback && gross > poolCash) {
    throw new MarketError(409, 'There is not enough investor capital available right now.');
  }

  const nextCash   = isBuyback ? poolCash + gross : poolCash - gross;
  const nextShares = isBuyback ? held - action.shares : held + action.shares;

  const holdings = { ...(market.holdings && typeof market.holdings === 'object' ? market.holdings : {}) };
  const key = poolKeyOf(airlineId);
  holdings[key] = Math.max(0, Math.round(nextShares));
  delete holdings[`human:${key}`];   // migrate any pre-normalisation entry

  const res = await tx.worldMarket.updateMany({
    where: { id: market.id, version: market.version },
    data: {
      poolCash: BigInt(Math.max(0, Math.round(nextCash))),
      holdings,
      version: { increment: 1 },
    },
  });
  if (res.count === 0) {
    throw new MarketError(409, 'The market moved while your order was placed — reload and try again.');
  }
}

/**
 * Weekly refill, applied by the world tick. Heals POOL_REFILL_PER_YEAR of the seed
 * per game year (spread weekly) and never takes the pool above its seed, so the
 * pool is a revolving facility rather than a growing faucet.
 *
 * Best-effort by design: a failed refill must never abort a world's week, and it
 * is not version-guarded because the increment is monotonic and idempotent enough
 * that losing one week's heal is harmless.
 */
export async function refillWorldMarket(prisma, worldId, { log = console } = {}) {
  try {
    const market = await prisma.worldMarket.findUnique({ where: { worldId } });
    if (!market) return 0;
    const add = poolRefill(Number(market.poolCash), Number(market.seedCash));
    if (add <= 0) return 0;
    await prisma.worldMarket.update({
      where: { id: market.id },
      data: { poolCash: BigInt(Number(market.poolCash) + add) },
    });
    return add;
  } catch (err) {
    log.error?.(`[market] refill failed for world ${worldId}:`, err?.message ?? err);
    return 0;
  }
}

/** Seed a pool for a world that is starting, if it has none yet. */
export async function seedWorldMarket(prisma, worldId, playerCount) {
  const seed = poolSeedFor(playerCount, STARTING_CASH);
  try {
    await prisma.worldMarket.upsert({
      where:  { worldId },
      update: {},                       // never re-seed an existing pool
      create: { worldId, poolCash: BigInt(seed), seedCash: BigInt(seed), holdings: {} },
    });
  } catch { /* non-fatal: ensureWorldMarket will create it on first trade */ }
  return seed;
}

// ─── Dividends ────────────────────────────────────────────────────────────────

/**
 * Split one airline's dividend between the people who actually hold its stock.
 *
 * Three destinations, and the split is what makes a dividend incapable of creating
 * money — it can only move it or destroy it:
 *
 *   • the founder block   — NOT paid at all (the reducer already excluded it from
 *                           the payable share count, so it never appears here)
 *   • rival players       — a real cross-player transfer, conserved
 *   • outside investors   — the slice held by the float pool leaves the world (sink)
 *
 * Any rounding remainder is treated as leaving the world too, so the credits can
 * never total more than the payer actually paid.
 *
 * @param {object} p
 * @param {number} p.perShare      dividend per share, from the engine
 * @param {number} p.totalPaid     what the payer's blob was actually debited
 * @param {string} p.payerId
 * @param {Array}  p.holders       [{ airlineId, shares }] rival players' stakes
 * @returns {{ credits: Array<{airlineId: string, amount: number}>, toOutside: number }}
 */
export function splitDividend({ perShare, totalPaid, payerId, holders }) {
  const rate = Number(perShare) || 0;
  const paid = Math.max(0, Math.round(Number(totalPaid) || 0));
  const credits = [];
  let allocated = 0;

  for (const h of holders ?? []) {
    if (!h || h.airlineId === payerId || !(h.shares > 0)) continue;
    const amount = Math.round(h.shares * rate);
    if (amount <= 0) continue;
    // Never distribute more than was debited, whatever the rounding does.
    const capped = Math.min(amount, paid - allocated);
    if (capped <= 0) break;
    credits.push({ airlineId: h.airlineId, amount: capped });
    allocated += capped;
  }

  return { credits, toOutside: Math.max(0, paid - allocated) };
}

/**
 * Who holds stock in `payerId`, read from the other airlines' portfolio blobs.
 *
 * @param {Array} airlines  [{ id, state }] every active airline in the world
 */
export function holdersOf(airlines, payerId) {
  // Portfolio holdings are keyed by the COMPETITOR id the holder traded against
  // (`human:<dbId>`), while payers are identified by raw DB id — so the lookup
  // must try both spellings or it finds no holders at all (which silently sent
  // every dividend's rival-holder slice out of the world).
  const key = poolKeyOf(payerId);
  const out = [];
  for (const a of airlines ?? []) {
    if (!a || poolKeyOf(a.id) === key) continue;
    const holdings = a.state?.portfolio?.holdings;
    const held = holdings?.[key] ?? holdings?.[`human:${key}`];
    if (held?.shares > 0) out.push({ airlineId: a.id, shares: Number(held.shares) });
  }
  return out;
}

/** Player-facing summary for the Stocks tab. */
export function poolSummary(market) {
  if (!market) return null;
  const cash = Number(market.poolCash ?? 0);
  const seed = Number(market.seedCash ?? 0);
  const frac = seed > 0 ? Math.max(0, Math.min(1, cash / seed)) : 0;
  return {
    poolCash: cash,
    seedCash: seed,
    // What a seller currently gives up on top of spread and impact.
    liquidityDiscount: Math.round(STOCK_MARKET.POOL_LIQUIDITY_K * (1 - frac) * 10_000) / 10_000,
    status: frac > 0.66 ? 'deep' : frac > 0.33 ? 'thinning' : frac > 0 ? 'thin' : 'closed',
  };
}
