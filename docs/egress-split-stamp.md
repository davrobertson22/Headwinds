# Server cost: the split-stamp airline read

*2026-07-27*

## What prompted it

A Discord reply to a question about reducing server costs: *"likely an entire
recode by hand. Gen AI does not write efficient code."*

The codebase did not support that diagnosis — conditional fetching, response
compression, column-selected reads and SQL-side aggregation were all already in
place. But looking for the real driver turned up a genuine defect in the
conditional-fetch layer, and it was a design mistake rather than a coding one.

## The defect

`GET /worlds/:id/airline` gates its response on a change stamp the client echoes
back. The stamp was a single value combining two unrelated facts:

| half | moves when | gates |
|---|---|---|
| `self` | we act, or a tick lands | the state blob — **3.66 MB** |
| `world` | *anybody* in the world acts | the rival overlay — kilobytes |

`worldStampOf()` computes the world half as the **sum of every active airline's
`version`**. So any player adjusting a single fare bumped their own version,
changed the sum, and invalidated the cached state of *every other player in the
world* — each of whom then re-downloaded their entire save to pick up a few
kilobytes of rival deltas.

The original code comment read:

> when nothing in the world has changed (the overwhelmingly common case — the
> game polls every ~25s, worlds tick hourly)

That is true of an idle world and of a single-player world. It is false of a
busy multiplayer world. **The optimisation switched itself off precisely when it
was needed** — and the busier a world got, the harder it worked against itself.

Worse, the client was already throwing the blob away. `GamePlayScreen.load()`
only adopted `d.state` when the absolute week had advanced; on a same-week poll
it pulled out `gateMarket` and discarded the rest. So the megabytes were being
downloaded, parsed, and dropped.

## The fix

Split the stamp. `state` ships only when `self` moved; `rivals` ships when
`world` moved. A player watching rather than acting — the common case between
hourly ticks — now pays kilobytes per poll instead of megabytes.

- `lib/stamp.mjs` — `splitStamp` / `stampDelta`, pure and DB-free so they are
  testable without `DATABASE_URL`.
- `lib/humanRivals.mjs` — `rivalOverlay(view)` extracted from `withRivals`, which
  now composes it. Base + overlay is asserted byte-identical to the old whole
  payload, so split and legacy clients cannot diverge.
- `routes/decisions.mjs` — `split=1` opt-in. Old tabs keep the whole-blob path.
- `GamePlayScreen.jsx` — applies each half independently.

### Two traps worth recording

**`rivals` always ships alongside `state`.** `state` is sent stripped of the
overlay. Omitting `rivals` on a self-only change would hand the client a base
carrying empty `competitors`/`humanRivals` and blank its Rivals tab. Bumping our
own version normally moves the world sum too — but the world stamp is memoised,
so a poll inside that window really can observe self-changed/world-unchanged.

**The world stamp is memoised, not counted.** A hand-bumped `World.stateVersion`
column was the obvious alternative and is the wrong call here: there are a dozen
`version: { increment: 1 }` sites across the gate, market, aircraft and tick
services, several outside the decision transaction, so the counter goes stale the
first time one is missed — and bumping a single World row on every airline write
would serialise all of a tick's writes behind one row. A 2.5s memo of the derived
aggregate is correct by construction. It also incidentally bounds how often
`buildWorldRivalViews` rebuilds, since that cache is keyed on the same stamp.

## Backgrounded tabs

Separately: nothing stopped the poll timers when a tab was hidden. Five pollers
(10s–60s) kept running in tabs nobody was looking at — and this is a game people
park in a spare tab all day. `usePoll.js` adds `useVisibleInterval`, which pauses
while hidden and refetches on return.

## Still open

- `buildWorldRivalViews` loads every active airline's full blob on rebuild. It is
  cached and shared across a world's players, and the stamp memo now bounds the
  rebuild rate, but this is the largest remaining Supabase read.
- Routes and fleet still live inside the JSONB blob, so editing one route
  rewrites the whole save. Normalising them into real tables is the structural
  fix and has not been attempted.
- Supavisor session-pooler connection ceiling (from the 2026-07-27 auth outage).

## Verification

`tools/airline-stamp-split-test.mjs` — 16 assertions covering stamp parsing, the
branch table, base+overlay reconstruction, and the overlay/`stripRivals` lockstep
invariant. Wired into `npm test`; full suite green (418).
