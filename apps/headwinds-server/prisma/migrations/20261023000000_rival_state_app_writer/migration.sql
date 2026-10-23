-- The weekly tick writes Airline."rivalState" itself (outage 2026-10-22).
--
-- The trigger from 20261022000000_airline_rival_state ran rival_state_of() on
-- every `state` write: ~3.0 s for Scarce Assets' 20 MB airline, ~1.1 s for a
-- 14 MB one (EXPLAIN ANALYZE, production, 2026-10-23), ~10 s for the world's
-- whole weekly commit. That took the commit from ~20 s to ~31 s, past the
-- tick's 30 s budget; every attempt rolled back and the worker crash-looped.
--
-- The tick already holds every airline's new state in JS, and
-- projectRivalState() (humanRivals.mjs) is the JS twin of rival_state_of()
-- (tools/rival-state-column-test.mjs proves they agree). So the tick now marks
-- its own transaction with
--     set_config('headwinds.rival_state_writer', 'app', true)   -- SET LOCAL
-- and writes "rivalState" from JS in one statement after its airline writes
-- (lib/rivalStateWrite.mjs). Under that mark the trigger leaves the row alone.
-- Every other writer (decisions, joins, fire sales, admin tools) never sets it,
-- so they keep the trigger exactly as before. The setting is transaction-local:
-- it ends with the tick's COMMIT or ROLLBACK and cannot leak into a pooled
-- connection's next transaction.
--
-- Deploy order does not matter: a tick running before this migration still
-- fires the old trigger and then overwrites "rivalState" with the same value.

CREATE OR REPLACE FUNCTION public.airline_rival_state_sync()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF current_setting('headwinds.rival_state_writer', true) = 'app' THEN
    RETURN NEW;
  END IF;
  NEW."rivalState" := public.rival_state_of(NEW.state);
  RETURN NEW;
END
$fn$;
