-- The weekly report moves out of `state` into its own column (2026-10-23).
--
-- Postgres was killed ~12 times on 2026-10-23, every time while Time Flies'
-- biggest airlines were playing. Each decision rewrote the WHOLE `state` jsonb
-- (Ajax Air: 15 MB, 10.9 MB of it `lastReport`), and the rivalState trigger ran
-- rival_state_of() over all of it. Only the weekly tick produces a report, so
-- it now lives in "report" (lib/reportColumn.mjs is the read/write contract):
-- the tick writes it, a decision writes `state` without it, and an UPDATE that
-- leaves a TOASTed column out of its SET list does not rewrite it.
--
-- rivalState keeps three report fields (reputation, reputationScore,
-- totalPassengers). Once a row's `state` has no `lastReport` key they come from
-- the column instead:
--   * a `state` write keeps the row's CURRENT rivalState report fields (a
--     decision does not change the report; reading OLD."rivalState" costs
--     bytes, reading NEW.report would detoast megabytes on every decision);
--   * a "report" write (trigger named to fire AFTER the state one, alphabetical
--     order) sets them from the new report.
-- A `state` that still carries `lastReport` (a legacy row, a fresh template's
-- null) projects exactly as before — so code deployed BEFORE this migration,
-- which never writes the column and always keeps the key, is unaffected, and
-- deploy order does not matter.
--
-- The tick marks its transaction and writes rivalState from JS (migration
-- 20261023000000_rival_state_app_writer); both triggers stand aside for it.
-- The column is added empty (catalogue-only, no table rewrite). Rows move their
-- report out on their next tick; no backfill is needed.

ALTER TABLE "Airline" ADD COLUMN "report" JSONB;

-- The rival-facing slice of a report. Same three fields, same null handling as
-- the 'lastReport' arm of rival_state_of().
CREATE OR REPLACE FUNCTION public.rival_report_of(r jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT CASE WHEN jsonb_typeof(r) = 'object'
              THEN jsonb_build_object(
                     'reputation',      r->'reputation',
                     'reputationScore', r->'reputationScore',
                     'totalPassengers', r->'totalPassengers')
              ELSE 'null'::jsonb END
$fn$;

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
  IF jsonb_typeof(NEW.state) = 'object' AND NOT (NEW.state ? 'lastReport') THEN
    NEW."rivalState" := jsonb_set(NEW."rivalState", '{lastReport}',
      CASE WHEN TG_OP = 'UPDATE'
           THEN COALESCE(OLD."rivalState"->'lastReport', public.rival_report_of(OLD.report))
           ELSE public.rival_report_of(NEW.report) END);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.airline_rival_report_sync()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF current_setting('headwinds.rival_state_writer', true) = 'app' THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.state) = 'object' AND NOT (NEW.state ? 'lastReport') THEN
    NEW."rivalState" := jsonb_set(COALESCE(NEW."rivalState", public.rival_state_of(NEW.state)),
      '{lastReport}', public.rival_report_of(NEW.report));
  END IF;
  RETURN NEW;
END
$fn$;

-- Fires after airline_rival_state_sync when one UPDATE sets both columns
-- (same-event triggers run in name order).
CREATE TRIGGER airline_rival_state_sync_report
  BEFORE UPDATE OF report ON "Airline"
  FOR EACH ROW EXECUTE FUNCTION public.airline_rival_report_sync();
