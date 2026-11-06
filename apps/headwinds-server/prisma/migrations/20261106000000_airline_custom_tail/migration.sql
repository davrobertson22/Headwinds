-- Custom tails (2026-11-06): the player's uploaded tail fin, as its own
-- Airline column — the same treatment as customLogo (migration 20260824000000,
-- lib/logoColumn.mjs): written once on SET_BRANDING, never re-TOASTed by the
-- tick, served to rivals as a /tails/<id>?v=<hash> URL rather than the bytes.
--
-- Additive and nullable: no table rewrite, no backfill (nothing has ever
-- stored a tail in the blob). Run `npx prisma migrate deploy` after deploying
-- — the server selects the column on every airline read (see the 2026-10-15
-- missing-migrations outage).
ALTER TABLE "Airline" ADD COLUMN "customTail" TEXT;

-- rival_state_of() is the SQL twin of projectRivalState() (humanRivals.mjs
-- RIVAL_DROPPED_KEYS); the two must subtract the same keys, so the tail joins
-- the logo in the subtraction. Only the subtraction line changes. The trigger
-- functions (20261024000000) call this by name and need no change. No
-- rivalState backfill is needed: a key the blob never carries projects the
-- same before and after.
CREATE OR REPLACE FUNCTION public.rival_state_of(s jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT (s - 'financialHistory' - 'statsHistory' - 'fleet' - 'lastReport' - 'customLogo' - 'customTail')
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
