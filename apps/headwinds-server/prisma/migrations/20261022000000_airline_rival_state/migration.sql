-- Rival state column (outage 2026-10-21, Fix 2 from the 2026-10-18 note).
--
-- loadRivalRows (src/lib/humanRivals.mjs) used to trim every ACTIVE airline's
-- whole `state` blob in SQL on every rival rebuild. That detoasts the full blob
-- (Scarce Assets: ~70 MB across 32 airlines) inside one backend, which is what
-- kept pushing Postgres over its commit limit (crashes 2026-10-03, 10-18,
-- 10-21). The trimmed copy is now kept in its own column, written by a trigger
-- whenever `state` is written, so the rival query reads ~10x less.
--
-- rival_state_of() IS the projection. Its JS twin is projectRivalState() in
-- humanRivals.mjs; tools/rival-state-column-test.mjs runs this file in PGlite
-- and proves the two agree. Changing RIVAL_* constants means a new migration
-- that replaces this function AND a re-run of tools/backfill-rival-state.mjs.
--
-- The column is added empty (catalogue-only, no table rewrite). Rows fill as
-- they are next written; tools/backfill-rival-state.mjs fills the rest one row
-- at a time. Until then loadRivalRows falls back to rival_state_of(state).

ALTER TABLE "Airline" ADD COLUMN "rivalState" JSONB;

CREATE OR REPLACE FUNCTION public.rival_state_of(s jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT (s - 'financialHistory' - 'statsHistory' - 'fleet' - 'lastReport' - 'customLogo')
    || jsonb_build_object(
         'financialHistory',
           CASE WHEN jsonb_typeof(s->'financialHistory') = 'array'
                THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                               'profit', e->'profit', 'revenue', e->'revenue',
                               'passengers', e->'passengers',
                               'fuelIndex', e->'fuelIndex', 'fuelMultiplier', e->'fuelMultiplier',
                               'depreciation', e->'depreciation', 'loanPayments', e->'loanPayments',
                               'loanInterest', e->'loanInterest', 'leaseDepositReturned', e->'leaseDepositReturned') ORDER BY ord), '[]'::jsonb)
                        FROM jsonb_array_elements(jsonb_path_query_array(s, '$.financialHistory[last-12 to last]'::jsonpath))
                             WITH ORDINALITY AS fh(e, ord))
                ELSE '[]'::jsonb END,
         'statsHistory',
           CASE WHEN jsonb_typeof(s->'statsHistory') = 'array'
                THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                               'sharePrice', e->'sharePrice') ORDER BY ord), '[]'::jsonb)
                        FROM jsonb_array_elements(jsonb_path_query_array(s, '$.statsHistory[last-25 to last]'::jsonpath))
                             WITH ORDINALITY AS sh(e, ord))
                ELSE '[]'::jsonb END,
         'fleet',
           CASE WHEN jsonb_typeof(s->'fleet') = 'array'
                THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                               'id', e->'id', 'typeId', e->'typeId', 'config', e->'config',
                               'ageWeeks', e->'ageWeeks', 'status', e->'status') ORDER BY ord), '[]'::jsonb)
                        FROM jsonb_array_elements(s->'fleet') WITH ORDINALITY AS fl(e, ord))
                ELSE '[]'::jsonb END,
         'lastReport',
           CASE WHEN jsonb_typeof(s->'lastReport') = 'object'
                THEN jsonb_build_object(
                       'reputation',      s#>'{lastReport,reputation}',
                       'reputationScore', s#>'{lastReport,reputationScore}',
                       'totalPassengers', s#>'{lastReport,totalPassengers}'
                     )
                ELSE NULL END
       )
$fn$;

CREATE OR REPLACE FUNCTION public.airline_rival_state_sync()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  NEW."rivalState" := public.rival_state_of(NEW.state);
  RETURN NEW;
END
$fn$;

CREATE TRIGGER airline_rival_state_sync
  BEFORE INSERT OR UPDATE OF state ON "Airline"
  FOR EACH ROW EXECUTE FUNCTION public.airline_rival_state_sync();
