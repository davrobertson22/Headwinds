-- Rival state keeps each tail's Wi-Fi fit (2026-11-08).
--
-- Every human rival is now scored on other players' screens and in their ticks
-- with the same route quality they score on their own (toRivalSpecs →
-- buildPlayerPairOffer; tools/rival-share-symmetry-test.mjs). Route quality
-- counts Wi-Fi coverage per tail (routeQualityBreakdown → wifiCoverageFor reads
-- fleet[].hasWifi), so the trimmed fleet entries carry that one boolean too —
-- otherwise a fitted rival would be scored a few quality points lower on
-- everyone else's screen than on their own.
--
-- rival_state_of() is the SQL twin of projectRivalState() (humanRivals.mjs
-- RIVAL_FLEET_FIELDS); only the fleet element gains a key. The trigger
-- functions (20261024000000) call this by name and need no change.
--
-- No backfill, deliberately: a mass UPDATE re-detoasts every save blob, which
-- is what ran Postgres out of memory (2026-10-03, 10-18, 10-21). Each airline's
-- "rivalState" picks the key up on its next state write — the weekly tick
-- rewrites it every week — so at most one tick scores a fitted rival without
-- its Wi-Fi. Run `npx prisma migrate deploy` with this deploy.
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
                               'ageWeeks', e->'ageWeeks', 'status', e->'status',
                               'hasWifi', e->'hasWifi') ORDER BY ord), '[]'::jsonb)
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
