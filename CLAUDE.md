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

`npm test` runs every suite in `tools/`, discovered from disk by `tools/run-tests.mjs` — there is no hand-maintained chain to append to, so a new `tools/*-test.mjs` is in the suite the moment it exists. It runs them in parallel, reports EVERY failure rather than stopping at the first, and exits non-zero if any failed. `npm run test:list` shows what would run; `npm run test:serial` runs one at a time; `node tools/run-tests.mjs <substring>` runs a subset. A file that prints a report and asserts nothing carries an `@not-a-test` marker in its header and is skipped (listed, never dropped in silence). Individual suites still have `test:*` aliases in `package.json`.

- New engine behaviour ships with a test that is **verified failing on HEAD** before the fix lands. If the new API doesn't exist on HEAD, prove the failure by reproducing the old call path in a throwaway probe rather than claiming the import error as evidence.
- `node tools/golden-master/run.mjs` must print `PARITY OK` for any change meant to be behaviour-preserving. Re-baseline with `--update` only when a balance change is intended and stated.
- SSR-render the real component when testing UI agreement. A helper tested in isolation can pass while the component that calls it fails — that is exactly how the hydrated-`stops` bug was caught.

## Generated data

`packages/engine/src/data/airportMarkets.js` (the Airports → All airports market columns) is **generated** — do not hand-edit. Regenerate with `node tools/generate-airport-markets.mjs` whenever airports, metros or the demand model change; `tools/airport-markets-test.mjs` fails when it is stale. Tailwinds has the same file and generator; with matching demand models the two tables are byte-identical.

## The public site (landing, guides, devlog)

AdSense has turned this site down for "low value content" more than once, so the pages Google reads are guarded by `tools/site-pages-test.mjs` (and `tools/adsense-readiness-test.mjs` for ad code and /play). Both name the fix when they fail.

- `apps/headwinds-web/public/` is **generated** on every build by `tools/headwinds-public.mjs` (gitignored). Edit the sources: hand-written pages in `apps/headwinds-web/pages/`, multiplayer sections for the aircraft pages in `apps/headwinds-web/sections/`, the landing in `apps/headwinds-web/index.html`. `--out <dir>` builds somewhere else and leaves the real one alone.
- **Devlog.** Add a new `<div class="entry">` at the top of `apps/headwinds-web/pages/devlog.html`, as before. The build splits it (`tools/site-devlog.mjs`) into an index at `/devlog.html`, month pages at `/devlog/YYYY-MM.html`, and a page of its own for any entry of 500+ words. It also refreshes the "Latest updates" block in `index.html`; commit that change with the entry.
- **Dates.** Never hand-edit a "Last updated" byline or the sitemap. After changing a page, the landing, the devlog or the aircraft pages, run `node tools/site-page-dates.mjs` and commit `apps/headwinds-web/page-dates.json`. A page is re-dated only when its content really changed (3+ paragraphs, rows or images), and the build prints that date in the byline and as the page's own `<lastmod>`. Stamping every page with the build date is what Google reads as bulk-produced content; do not bring it back.
- **Aircraft class pages** are generated into root `public/` by `node tools/generate-aircraft-pages.mjs` (re-run when aircraft data changes). Their two charts are deliberately different from the two on the Tailwinds pages.
- **The landing links every page.** A new page needs a card in the Guides section of `index.html`; the test fails until it has one.
- **Do not copy Tailwinds' articles or its real-aircraft sections here.** The same text on both domains is duplication Google holds against both sites. Headwinds content has to be Headwinds' own (multiplayer, live worlds). And do not cross-canonical pages to Tailwinds: see the history in `headwinds-public.mjs`.

## Working with git here

The desktop bridge cannot unlink files, so it leaves stale `.git/index.lock` files and locked worktree registrations behind. If git behaves strangely, check for `.git/index.lock` first. Never `git add -A` — both repos keep untracked scratch under `_to_delete/`.
