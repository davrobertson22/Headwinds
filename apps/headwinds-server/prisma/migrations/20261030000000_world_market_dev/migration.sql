-- Market development: a city pair's market grows with the service it gets and
-- fades when that service leaves (engine models/marketDev.js). D is a world
-- fact, so it lives here, one row per market-development world:
--
--   pairs — { "JFK-LHR": { "d": 1.04, "t": 1.01 } }, metro-primary pair keys
--   week  — the world-clock index this table is for; the tick writes it in the
--           same transaction as the clock advance
--
-- Only worlds created with tickConfig.marketDev get a row, lazily on their
-- first tick. Existing worlds never do, so no backfill.

CREATE TABLE "WorldMarketDev" (
  "id"      TEXT NOT NULL,
  "worldId" TEXT NOT NULL,
  "week"    INTEGER NOT NULL DEFAULT 0,
  "pairs"   JSONB NOT NULL DEFAULT '{}',

  CONSTRAINT "WorldMarketDev_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorldMarketDev_worldId_key" ON "WorldMarketDev"("worldId");

ALTER TABLE "WorldMarketDev" ADD CONSTRAINT "WorldMarketDev_worldId_fkey"
  FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;
