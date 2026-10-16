-- Rankings rework: live standings stats on Airline, written by every tick.
-- All nullable, no defaults: an ADD COLUMN with no default is a catalogue-only
-- change in Postgres (no table rewrite, no long lock on a hot table).
ALTER TABLE "Airline" ADD COLUMN "rankScore" BIGINT;
ALTER TABLE "Airline" ADD COLUMN "weeklyProfit" BIGINT;
ALTER TABLE "Airline" ADD COLUMN "netAssets" BIGINT;
ALTER TABLE "Airline" ADD COLUMN "paxWeek" INTEGER;
ALTER TABLE "Airline" ADD COLUMN "flightsWeek" INTEGER;
ALTER TABLE "Airline" ADD COLUMN "fleetSize" INTEGER;

CREATE INDEX "Airline_worldId_rankScore_idx" ON "Airline"("worldId", "rankScore");
