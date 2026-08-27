# startup-survival

Forensics for the question "do small-aircraft starts actually die more, and why?".
Backs `docs/startup-survival-audit-2026-08-26.md`.

Read-only. Opens no transaction, writes nothing to the database. Reads
`DATABASE_URL` out of `apps/headwinds-server/.env`.

Uses `pg` rather than Prisma deliberately: these were written and run from the
desktop bridge, where the generated Prisma client is the wrong platform binary.
`pg` has no schema coupling, so this keeps working when the schema moves.

Install the one dependency, then run in order. `1-pull.mjs` writes `data.json`
(one row per airline, opening strategy reconstructed from the Decision log);
`0-cache-states.mjs` writes `states.json` (financial history and fleet per
airline, ~11MB) so the later scripts do not re-query per airline.

    cd tools/startup-survival
    npm init -y
    npm install pg
    node 1-pull.mjs
    node 0-cache-states.mjs
    node 2-buckets.mjs
    node 3-significance-and-churn.mjs
    node 4-cost-structure.mjs
    node 5-per-airline-and-regime.mjs
    node 6-hubs-and-small-operators.mjs
    node 7-era-split.mjs
    node 8-overhead-arithmetic.mjs

`8-overhead-arithmetic.mjs` needs no database at all — it runs the engine's own
overhead functions against the revenue-per-departure calibration table in
`packages/engine/src/data/overhead.js` and prints HQ cost as a share of gross
revenue for a two-aircraft startup, by body class and by overhead regime.

Two things to know before trusting any number these print:

`statsHistory` is a rolling 260-week window and `financialHistory` a rolling 52.
Anything measured from founding is therefore only valid for airlines whose window
still covers their founding — the scripts filter on that (`histCovered`) and print
the surviving subset size. Do not quote a rate without it.

Opening strategy comes from the `Decision` log, never from current state:
bankruptcy wipes the fleet, so a dead airline's blob says nothing about what it
started with. Generation start is `restartedWeek ?? joinedWeek`, so a re-founded
airline is not credited with its predecessor's opening.
