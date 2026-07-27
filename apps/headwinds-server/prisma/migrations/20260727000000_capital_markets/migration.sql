-- Capital markets: per-airline share counts and the SVPS leaderboard metric.
--
-- Every existing airline is incorporated at the founder share count (100,000,000),
-- which is exactly what the pre-rework engine assumed, so no share price changes
-- and the standings order is UNCHANGED at migration time: with an identical share
-- count for everyone, ranking on per-share value is arithmetically the same as
-- ranking on market cap. Ranks only begin to diverge once players issue or retire
-- shares, which needs the capital actions that ship later.
--
-- svps is stored in ten-thousandths of a dollar (see SVPS_SCALE in the engine) so a
-- fractional per-share figure survives an integer column. It is backfilled here
-- from marketCap / 100,000,000 for continuity; the tick recomputes it every week.

ALTER TABLE "Airline" ADD COLUMN "shares" BIGINT NOT NULL DEFAULT 100000000;
ALTER TABLE "Airline" ADD COLUMN "svps"   BIGINT NOT NULL DEFAULT 0;

UPDATE "Airline"
   SET "svps" = GREATEST(0, ROUND(("marketCap"::numeric / 100000000::numeric) * 10000))::bigint
 WHERE "marketCap" > 0;

-- Standings order by this; the world detail endpoint orders its table by it too.
CREATE INDEX "Airline_worldId_svps_idx" ON "Airline"("worldId", "svps");
