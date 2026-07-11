-- Optimistic-concurrency guard for Airline.state: the worker tick and a
-- player decision both read-modify-write the whole state blob; a version
-- column lets each write compare-and-set so neither silently clobbers the
-- other. Backfills to 0 for existing rows.
ALTER TABLE "Airline" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
