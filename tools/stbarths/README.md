# stbarths

Answers a Discord challenge — *"be my guest and make an airline who's only hub is
in st barths and we can see how long it lasts"* — by actually running it, instead
of arguing about it. Backs `docs/st-barths-simulation-2026-08-26.md`.

Needs no database. Everything here is the shipped engine plus the server's own
seeding and world-economy code, so the numbers are the game's, not a model of it.

    node tools/stbarths/0-probe.mjs      what can physically operate SBH
    node tools/stbarths/1-ceiling.mjs    the market's revenue ceiling, by fleet size
    node tools/stbarths/2-sim.mjs <scenario> <startSeed> <runs> <weeks> [priceMult] [fleetTarget] [outFile]
    node tools/stbarths/3-inspect.mjs <hub> <typeId> <freq|max> <fleetTarget> <priceMult>

`2-sim.mjs` with no arguments prints the scenario list. Env overrides: `VERBOSE=1`
(week-by-week P&L for seed 1, to stderr), `FREQ=`, `CAPTURE=`, `PRUDENT=0`.

## Why this is the real game and not a toy

* State comes from the server's own `seedAirlineState()`, so the NWR flag, the
  trimmed fare ladder, the calendar rebase and the fuel backfill are exactly what
  a joining player gets.
* Weeks advance through `gameReducer` `ADVANCE_WEEK` with the same payload
  `tickService` sends — world fuel index, world market index, shared world events.
* Every player action is on the `ALLOWED_PLAYER_ACTIONS` list. Leases go through
  `ORDER_AIRCRAFT` (deposit, fitting fee, delivery lead), never the solo-only
  `LEASE_AIRCRAFT` back door.
* Route opens are pre-checked with `addRouteBlockReason` and refusals are
  COUNTED, never swallowed. A run that reports 0 revenue with open routes is a
  finding, not a silent failure — that distinction is what the 2026-08-13 route
  bug cost us.

## Known limits — read before quoting a number

* The bot is a bot. It ranks markets, sizes schedules and stops growing when the
  last week was a loss; it does not use loyalty, alliances, cargo, hub upgrades,
  ancillaries or fare-class mix. Treat absolute survival weeks as a floor.
* One airline, no human rivals. `humanRivals` injects nothing here, so every
  result is the *uncontested* case — the friendliest possible world.
* `svo-saab` and `evn-cv580` exist as harness validation, not as findings: they
  reproduce the two profitable small operators seen in live data. If those ever
  stop coming out survivable, the harness has drifted and nothing else here can
  be trusted.
