-- Performance indexes matching the real hot query shapes (2026-07-20 audit #15c).
-- Standings sort by marketCap; the world feed and rival profile filter by
-- createdAt; rank history filters by airlineId + week. Without these, those
-- queries degrade to per-world scans + sort as the tables grow.
--
-- On the LIVE database, run each as CREATE INDEX CONCURRENTLY (cannot run inside
-- a transaction) to avoid locking writes, then `prisma migrate resolve --applied
-- 20260720000000_perf_indexes`. The plain statements below are the Prisma-
-- canonical form (used by `migrate deploy` on a fresh DB).

-- CreateIndex
CREATE INDEX "Airline_worldId_marketCap_idx" ON "Airline"("worldId", "marketCap");

-- CreateIndex
CREATE INDEX "Decision_worldId_createdAt_idx" ON "Decision"("worldId", "createdAt");

-- CreateIndex
CREATE INDEX "Decision_airlineId_createdAt_idx" ON "Decision"("airlineId", "createdAt");

-- CreateIndex
CREATE INDEX "Standing_airlineId_week_idx" ON "Standing"("airlineId", "week");
