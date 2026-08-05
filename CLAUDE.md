# Headwinds — multiplayer Tailwinds

Multiplayer version of the Tailwinds airline management game. Monorepo: shared engine in `packages/engine`, web client in `apps/headwinds-web`, server in `apps/headwinds-server`. The single-player game lives in a separate repo (`Airline Management Game`) and shares most of the engine by convention, not by package — changes to demand, simulation or market models usually need porting to both.

## Shell blocks — commands only

Any shell/bash block written for Dave to run must contain **commands only**: no inline `#` comments, no `#` header lines, no explanatory prose, no annotations like `npm test   # exit 0`. Put every word of explanation in prose before or after the block.

He copy-pastes the whole block into Terminal, and he runs **zsh**, where `INTERACTIVE_COMMENTS` is off — a trailing `#` is an ARGUMENT, not a comment. This is not a style preference; it silently corrupts commands. Real example: `git status   # eight staged` parsed as `git status '#' eight staged`, i.e. three pathspecs matching nothing, so git printed "nothing to commit, working tree clean" on a tree with eight staged files.

Applies to Tailwinds too.

## Previews must agree with the tick

Any screen that forecasts a route or a market share must route through the shared helpers, never a bare `simulateRoute(route, aircraft, gameDate)`. A bare call asks "what would this aircraft carry *alone* in this market?", which on a pair the player already flies means the whole demand pool — it has produced the same class of bug at least three times (the route map, the cargo planner, the route-launch forms).

- Pair share and route projections: `packages/engine/src/models/pairShare.js` (`pairMarketShare`, `projectRouteAddition`).
- A preview that disagrees with `weeklyTick` is a bug in one of them. Fix the disagreement, don't paper over it.
- When building a player offer by hand, carry `brandReach`, `marketingBoost` and `priceSensitivityReduction`. An omitted `brandReach` is scored as parity, so a week-one airline previews the share of an established carrier.
- Tag routes are `isMultiStop(route)` (`routeStops(route).length > 2`) — never `!route.stops?.length`. Hydration gives every single-leg route `stops: [origin, destination]`, so the latter matches only un-hydrated routes.

## Testing

`npm test` runs the full chain. Individual suites have `test:*` aliases in `package.json`.

- New engine behaviour ships with a test that is **verified failing on HEAD** before the fix lands. If the new API doesn't exist on HEAD, prove the failure by reproducing the old call path in a throwaway probe rather than claiming the import error as evidence.
- `node tools/golden-master/run.mjs` must print `PARITY OK` for any change meant to be behaviour-preserving. Re-baseline with `--update` only when a balance change is intended and stated.
- SSR-render the real component when testing UI agreement. A helper tested in isolation can pass while the component that calls it fails — that is exactly how the hydrated-`stops` bug was caught.

## Working with git here

The desktop bridge cannot unlink files, so it leaves stale `.git/index.lock` files and locked worktree registrations behind. If git behaves strangely, check for `.git/index.lock` first. Never `git add -A` — both repos keep untracked scratch under `_to_delete/`.
