-- Float pool: the finite counterparty that closes the money loop.
--
-- Before this, SELL_STOCK minted cash and BUY_STOCK destroyed it against an
-- infinite off-world counterparty, so the stock market was a net money faucet
-- whose size was bounded only by how much players traded. Now each world has ONE
-- pool with finite cash and a finite share inventory: buys pay cash in, sells draw
-- cash out, and net exogenous cash entering a world is capped at the seed forever.
--
--   poolCash — cash the outside investors have left to buy equity with
--   seedCash — the pool's full-strength level (5 x players x starting capital),
--              also the ceiling the 2%/game-year refill heals back toward
--   holdings — { [airlineId]: sharesHeldByPool }, the tradable float ledger
--   version  — optimistic-concurrency guard, same pattern as WorldGate
--
-- Existing RUNNING worlds get a row lazily on first use (see ensureWorldMarket in
-- lib/marketService.mjs), seeded from their current player count, so no backfill
-- is required for this migration.

CREATE TABLE "WorldMarket" (
  "id"       TEXT NOT NULL,
  "worldId"  TEXT NOT NULL,
  "poolCash" BIGINT NOT NULL DEFAULT 0,
  "seedCash" BIGINT NOT NULL DEFAULT 0,
  "holdings" JSONB NOT NULL DEFAULT '{}',
  "version"  INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "WorldMarket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorldMarket_worldId_key" ON "WorldMarket"("worldId");

ALTER TABLE "WorldMarket" ADD CONSTRAINT "WorldMarket_worldId_fkey"
  FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;
