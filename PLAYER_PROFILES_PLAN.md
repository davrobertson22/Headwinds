# Player Profiles — accounts you can click on

**Status: PLAN — not implemented.** Written 2026-08-24.

Players exist in Headwinds today only as airlines inside a world. The account behind
the airline — the thing that persists across seasons, wins championships, and comes
back for the next world — has no face. This plan gives it one: click any player's
name anywhere in the game and see who they are across ALL worlds — what they're
flying now, what they've won, and how many seasons they've survived.

Decisions already made (Dave, 2026-08-24):

- **Signed-in only.** You must be logged into Headwinds to view any profile. No
  anonymous/public web access, profiles stay off search engines.
- **Private worlds are invisible.** A profile never reveals membership in a PRIVATE
  world — not the current airline, not the finished season, not the trophy. Not
  even an anonymized "1 private world" entry.
- **Finished seasons show podium places only.** A season on someone's profile
  reads 🏆 1st / 🥈 2nd / 🥉 3rd — or just "Played". No "14th of 38" on public
  view (the server doesn't even send non-podium ranks; your own `/me` still
  shows you everything).
- **Unique, player-chosen usernames + a rename flow** — specified in §8, built
  in phase 2. Usernames double as the human-readable profile identity, so no
  separate vanity-URL feature is needed.
- **Podium trophies only for now.** No category trophies (most passengers,
  biggest comeback, etc.) — all derivable later from records already banked, so
  nothing is lost by waiting.
- **Messaging outside worlds is a later phase.** This plan sketches it (§7) so
  nothing built now precludes it, but it is explicitly not in scope.

---

## 1. What already exists (most of the foundation is built)

The career system shipped earlier this month did the heavy lifting. Inventory:

| Piece | Where | State |
|---|---|---|
| `Account` model — `displayName`, `careerStats Json`, `cosmetics`, `isOG`, ban fields | `apps/headwinds-server/prisma/schema.prisma` | live |
| Per-world career records + derived totals + badges (`worldRecord`, `careerTotals`, `CAREER_BADGES`, `serializeCareer`) | `apps/headwinds-server/src/lib/career.mjs` | live |
| Snapshot at world end (`snapshotWorldCareers`, idempotent, post-commit) | `apps/headwinds-server/src/lib/careerService.mjs` | live |
| `/me` returns `career` for the signed-in account | `apps/headwinds-server/src/routes/me.mjs` | live |
| Own-career UI (`CareerPanel.jsx` on the worlds screen) | `apps/headwinds-web/src/CareerPanel.jsx` | live |
| Per-world **airline** profile (`GET /worlds/:id/rivals/:airlineId`) | `apps/headwinds-server/src/routes/worlds.mjs` + `src/lib/rivalProfile.mjs` | live |
| Hash router (`useRoute`, `#/...`) in the web shell | `apps/headwinds-web/src/App.jsx` | live |

What a profile adds is the **account-level, cross-world** view, readable by *other*
players. The gaps, in order of importance:

1. **No public account endpoint.** `/me` is self-only; the rivals endpoint is
   airline-in-one-world only.
2. **`accountId` is never sent to the client.** Standings rows and rival profiles
   carry `og`/`dev` flags derived from the account, but not the account's id — so
   there is nothing to link *to*. (Deliberate so far; it becomes public now.)
3. **Career records don't know world visibility.** `worldRecord` stores
   `worldId/worldName/rank/...` but not whether the world was PRIVATE — the
   "hide private worlds" rule can't be enforced from `careerStats` alone.
4. **`displayName` is not unique** and there is no handle/slug. Profile URLs need a
   stable key.
5. **Messaging and blocking are world+airline scoped** (`Message`,
   `MessageBlock` key on `airlineId`). Fine for now; §7 is the account-level plan.

## 2. Design decisions

### Profile key: the Account cuid, no handle (yet)

Profile URL is `#/players/<accountId>`. Account ids are opaque cuids — safe to
expose, stable forever, no uniqueness work. Unique player-chosen usernames are
coming in phase 2 (§8) and will layer a pretty `@name` address on top; the cuid
stays the canonical key underneath. Don't overload `displayName`, which today is
neither unique nor immutable.

Exposing the cuid is a one-way door worth naming: once account ids are public,
they're public. They authorize nothing (every endpoint checks the bearer token, and
`requireAuth` maps token → account server-side), so the only thing an id enables is
looking up the profile we're deliberately serving.

### Who can look: any signed-in account

`GET /players/:accountId` runs behind `requireAuth` — same gate as `/me`. No
world-membership requirement: profiles are the community-wide layer, and the data
served is strictly the public-world subset. A **banned** account's profile returns
404 to other players (a ban already blocks the account everywhere; its profile
shouldn't remain standing).

### Private worlds: fail closed

The rule is *hide entirely*, and it has to hold in three places:

- **Current games** — filter `world.visibility === 'PUBLIC'` on the Airline join.
  Trivial: visibility is on the World row we're already joining.
- **Finished seasons + trophies** — `careerStats` records need visibility. Two-part
  fix:
  - Going forward: `worldRecord()` gains a `visibility` field and
    `snapshotWorldCareers` passes `world.visibility` in. Additive, tolerant-read
    schema, no `CAREER_VERSION` bump needed.
  - Already-banked records (any world that ended before this ships): at profile
    read time, batch-look-up the record `worldId`s missing a visibility field
    (`world.findMany({ where: { id: { in } }, select: { id, visibility } })` — PK
    lookup, cheap). **A world that can't be found is treated as PRIVATE.** Fail
    closed, never open.
- **Badges and totals** — recomputed from the *filtered* world map, not read from
  `careerStats.totals`. `careerTotals()` and `careerBadges()` are already pure
  functions of the per-world map, so this is
  `careerTotals(publicWorldsOnly)` — no new math. Otherwise a "Champion 🏆" badge
  earned in a private world leaks the very fact we're hiding.

New pure helper in `career.mjs`:

```js
publicCareer(raw, visibilityByWorldId) // → { totals, badges, worlds } — PUBLIC only
```

so the filtering rule is unit-testable without a database. `/me` is untouched — you
always see your own full career, private seasons included, exactly as today.

### Trophies are derived, not stored

Same philosophy as badges (see the block comment in `career.mjs`): a trophy is a
pure function of the per-world records. Rank 1 → 🏆 gold with world name and end
date; rank 2 → 🥈; rank 3 → 🥉. No new storage, no migration, rule changes need no
backfill. The trophy case is just `worlds.filter(w => w.rank <= 3)` rendered
nicely, newest first.

## 3. Server work

### 3a. `GET /players/:accountId` (new route file `src/routes/players.mjs`)

`preHandler: requireAuth`. Response:

```jsonc
{
  "player": {
    "id": "…",                 // the account cuid
    "displayName": "Dave",
    "isOG": true,
    "dev": false,               // isDevEmail(account.email) — email itself never leaves the server
    "memberSince": "2026-06-01T…" // Account.createdAt
  },
  "badges":  [ { "id": "champion", "label": "Champion", "icon": "🏆", "description": "…" } ],
  "trophies": [ { "worldId": "…", "worldName": "…", "rank": 1, "of": 38,
                  "airlineName": "…", "endedAt": "…" } ],
  "totals":  { "worldsFinished": 4, "championships": 1, "podiums": 2, "…": "…" },
  "seasons": [ /* public-world seasons, newest first — REDACTED shape, see below */ ],
  "current": [ { "worldId": "…", "worldName": "…", "worldStatus": "RUNNING",
                 "airlineId": "…", "airlineName": "…", "hub": "JFK",
                 "status": "ACTIVE", "week": 214, "rank": 3, "svps": 41230000 } ]
}
```

**Season redaction (Dave's rule):** each `seasons` entry carries
`worldName / airlineName / endedAt / place` where `place` is 1, 2, 3, or null —
null renders as "Played". `rank`, `of`, `bestRank`, `svps`, `marketCap`, and
`status` are stripped server-side for the public view, not hidden client-side,
so a curious player can't read a 14th-place finish (or a bankruptcy) out of the
network tab. Same rule for `totals`: `bestFinish` and `bankruptcies` are omitted
from the public payload — `championships`/`podiums` already tell the podium
story, and the Phoenix badge remains the only (opt-out-free, but positive)
bankruptcy signal. Your own `/me` career is untouched and still carries full
ranks and finances.

Queries (all scalar-only — never touch the `state` blob, per the `/me` and
rival-profile precedent):

1. `account.findUnique` — identity fields + `careerStats`. `bannedAt` set → 404.
2. `airline.findMany({ where: { accountId, world: { visibility: 'PUBLIC', status: { in: ['LOBBY','RUNNING'] } } }, select: scalars + world name/status })`
   → `current`. Include BANKRUPT/ABANDONED airlines in running worlds (a bust in
   progress is part of the story and is already visible in that world's
   standings) — the `status` field lets the UI badge it.
3. Current rank per airline: latest `Standing` row each — `standing.findMany` per
   airline id with `orderBy: { week: 'desc' }, take: 1` (indexed
   `[airlineId, week]`; a handful of point queries). Null rank (private airline /
   pre-first-tick) renders as a dash, same convention as career records.
4. Visibility backfill lookup for legacy career records (§2), then
   `publicCareer()`.

Load characteristics match the rivals endpoint: a few kB, no auth-provider round
trips, safe to poll-free (it's fetched on click, not on a timer).

### 3b. Expose `accountId` where players are rendered

The link target has to exist wherever a player name appears. The `isOG` chip
already rides every one of these joins — the schema comment on `isOG` warns it
propagates through six separate `include: { account }` sites, one of which is a
raw-SQL/JS twin pair that must stay byte-identical. **`accountId` rides exactly
the same joins**, as a sibling of the existing `og`/`dev` flags:

- World detail standings (`GET /worlds/:id`): the raw-SQL standings query
  **already selects `a."accountId"`** — it just isn't in the `standings.map`
  serializer next to `og`/`dev`. One added line.
- Rival profile (`RIVAL_PROFILE_SELECT` in `lib/rivalProfile.mjs` already selects
  `account`; add `id: true` to that select and `accountId` to the response's
  `airline` object).
- Alliance member lists, world messages (sender), news/feed items that name an
  airline — audit for the full set; the six `include: { account }` sites plus the
  raw-SQL twin are the checklist. Anywhere `og` is sent, `accountId` goes too.
  Ship the raw-SQL twin and its JS fallback in the same commit.

`Airline.accountId` is already a plain column on every airline row, so most sites
need no new join at all — just add the field to the serializer.

### 3c. Career record gains `visibility`

- `career.mjs worldRecord()`: `visibility: row.visibility ?? null`.
- `careerService.mjs snapshotWorldCareers()`: pass `visibility: world.visibility`.
- New `publicCareer(raw, visibilityByWorldId)` per §2.
- Optional one-shot backfill: the same idempotent-snapshot property that lets the
  backfill script re-visit ended worlds means re-running it against ENDED worlds
  stamps visibility into every legacy record; the read-time fallback makes this
  optional rather than required.

**No Prisma migration in phase 1.** `careerStats` is JSONB and everything
else is serialization. The feature set's first migrations arrive with the
username flow in phase 2 (§8).

## 4. Web client work

### 4a. Profile screen

New `apps/headwinds-web/src/PlayerProfile.jsx`, wired into `useRoute` as
`#/players/:accountId` and rendered in the signed-in shell in `App.jsx` alongside
`worlds`/`world`/`admin`/`report`. Layout, top to bottom:

1. **Header** — display name, OG/DEV chips (reuse `OgBadge.jsx`), "member since",
   and badge row (same rendering `CareerPanel.jsx` uses — extract the shared bits
   rather than duplicating).
2. **Trophy case** — 🏆/🥈/🥉 cards: world name, airline name, "1st of 38",
   season end date. Empty state: "No trophies yet — seasons are long."
3. **Currently flying** — one row per public-world airline: airline name, hub,
   world name (→ links to `#/world/:id`), week, current rank, status chip for
   BANKRUPT/ABANDONED.
4. **Career totals** — the `CareerPanel` stat grid (seasons, championships,
   podiums, best finish, lifetime passengers, weeks flown).
5. **Finished seasons** — table of public-world seasons, newest first: world
   name, airline, ended date, and either the podium place (🏆/🥈/🥉) or the word
   "Played". Nothing else — no rank column, no financials.

`CareerPanel.jsx` gets a "View my public profile" link (`#/players/<me.account.id>`)
— which doubles as the honest preview of what *others* see, i.e. with your private
worlds hidden. Cosmetics/liveries showcase (`Account.cosmetics` is still an empty
array for everyone) is a natural later addition to the header — noted, not planned.

### 4b. Entry points — making names clickable

- **Standings table** (WorldScreen in `App.jsx`, the row that renders
  `a.name` + `OgBadge`/`DevBadge`): name becomes a link to `#/players/<a.accountId>`.
- **Rival profile panel** (`src/components/Competition.jsx`, shared engine UI):
  this component ships in **both repos** — Tailwinds has no accounts, so it must
  not grow a hard dependency on profiles. Follow the existing adapter pattern:
  `GamePlayScreen.jsx` already injects `fetchRivalProfile` into the game; add an
  optional `onViewPlayer(accountId)` alongside it. `Competition.jsx` renders a
  "View player profile →" link only when the callback exists and the payload
  carries `accountId` — in solo Tailwinds neither is true and nothing renders.
  Port the (inert) `Competition.jsx` change to the Tailwinds repo as usual.
- **Phase 2 entry points**: world DM senders (`Messages.jsx`), alliance member
  lists, feed/news items. Same one-liner once `accountId` is in each payload.

Navigation note: from inside the play screen (`route.screen === 'play'`), a hash
navigation to `#/players/:id` leaves the game screen; game state is all
server-side so nothing is lost, but in-game UI state (open tabs, scroll) resets on
return. Acceptable for phase 1; if it grates, phase 2 renders the same
`PlayerProfile` component in an overlay/modal over the play screen instead —
component is written once either way.

## 5. Tests (house rules apply: verified failing on HEAD first)

New suite `apps/headwinds-server/tools/player-profile-test.mjs` + a `test:profiles`
alias, folded into the full chain:

1. **Private-world blindness** (the test that matters): an account with one PUBLIC
   and one PRIVATE finished world + one PRIVATE running airline →
   `publicCareer`/profile response contains **zero** trace of the private world:
   not in `seasons`, `trophies`, `current`, and — the subtle one — a championship
   won in the private world does not appear in `totals.championships` or earn the
   Champion badge. Verified failing on HEAD by reproducing the old path:
   `serializeCareer` on the same fixture happily returns the private season.
2. **Fail closed**: a career record whose `worldId` no longer resolves to a World
   row is treated as private and dropped.
3. **Visibility stamping**: `snapshotWorldCareers` on a fixture world writes
   `visibility` into the record; running it twice is byte-identical (extends the
   existing idempotency guarantee).
4. **`accountId` exposure**: rival-profile and world-standings payloads carry
   `accountId`; raw-SQL twin and JS fallback agree (extend whatever harness the
   twin-pair already has).
5. **Auth + bans**: unauthenticated `GET /players/:id` → 401; banned account's
   profile → 404; own `/me` still returns private seasons.
6. **UI agreement**: SSR-render `PlayerProfile.jsx` against a fixture payload —
   trophies render for ranks 1–3 only, private-world fixtures never appear in the
   HTML. (Same SSR-the-real-component discipline that caught the hydrated-`stops`
   bug.)
7. **Season redaction**: the public payload for a 14th-place, later-bankrupt
   season contains no `rank`, `of`, `svps`, `marketCap`, or `status` field at
   all (assert on the serialized JSON, not the rendered UI), and `place` is null;
   a 2nd-place season carries `place: 2` and nothing more.

`node tools/golden-master/run.mjs` must still print `PARITY OK` — nothing here
touches the engine, so any drift is a mistake.

## 6. Phasing

**Phase 1 — the clickable profile** (this plan's build scope, one session):
§3a route + §3c career changes + `accountId` on standings & rival payloads +
`PlayerProfile.jsx` + the two phase-1 entry points + §5 tests. Zero migrations.

**Phase 2 — usernames + reach**: the username claim/rename flow (§8 — the
feature set's first migrations), remaining entry points (messages, alliances,
feed), profile overlay inside the play screen, cosmetics showcase. Each piece is
an independent afternoon.

**Phase 3 — account-level messaging**: below.

## 7. Phase 3 sketch: messaging outside worlds (NOT in scope now)

Recorded so phases 1–2 don't paint us into a corner. Today's `Message` is
world-scoped and airline-keyed; account DMs are a parallel system, not a retrofit:

- **`AccountMessage`**: `fromAccountId`, `toAccountId`, `body`, `createdAt`,
  `readAt`; indexes mirroring `Message`'s inbox/unread and rate-limit indexes.
- **`AccountMessageBlock`**: `(accountId, blockedAccountId)` unique — the
  account-level twin of `MessageBlock`. Existing airline-level blocks stay; an
  account block outranks everything.
- **DM policy** on Account: `EVERYONE | SHARED_WORLD | NOBODY` (default
  `SHARED_WORLD` — you can DM anyone you share a world with, which keeps
  cold-contact spam off new players by default).
- **Reports**: `Report.worldId` is required today; account DMs need it nullable
  (or a `context` discriminator) so "report this message" works from a
  world-less conversation. The moderation panel already handles account bans, so
  the back half of the pipeline exists.
- **Surface**: send button on the profile header; inbox in the shell header with
  an unread count piggybacked on `/me` (no new polling loop).
- Rate limits copied from `messages.mjs`; same body-length caps.

The only phase-1 obligations this imposes are already in the plan: profiles keyed
by `accountId`, and `accountId` exposed wherever a player is named.

## 8. Usernames + rename flow (phase 2, spec'd — Dave's call 2026-08-24)

Players choose their own username; usernames must be unique. Design:

### New `username` column, not a retrofit of `displayName`

`displayName` comes from sign-up and is full of duplicates; forcibly renaming
existing players in a dedup migration ("Dave" → "Dave-2") is hostile. Instead:

- New nullable `Account.username String?` + **case-insensitive** uniqueness —
  Prisma `@unique` is case-sensitive, so the real guard is a raw-SQL migration
  adding a unique index on `lower(username)` (keep the `@unique` too for the
  client's benefit; the functional index is the authority). "Dave" and "dave"
  are the same name.
- Display everywhere becomes `username ?? displayName`. Nobody is renamed out
  from under themselves; profiles work on day one with `displayName` as today.
- **Claim flow**: a "Choose your username" card on the profile/worlds screen for
  accounts with `username: null` — first set is free. That nudge is how the
  population converges to all-unique without a forced migration.

### Rules

- 3–20 chars, `A–Z a–z 0–9 _ -`, must start alphanumeric. Stored as typed,
  compared lowercased.
- Reserved list (`admin`, `headwinds`, `system`, `mod`, dev names…) rejected
  server-side.
- No profanity filter — offensive names go through the existing
  `OFFENSIVE_NAME` report category and the moderation panel, which already
  handles exactly this for airline names.
- **Renames rate-limited** (one per 30 days) so a scammer can't churn
  identities between incidents.
- **`NameChange` audit table** (`accountId`, `oldName`, `newName`, `createdAt`)
  — the moderation trail, shown in the admin panel next to the ban controls.
  Written on every set/rename, including the first claim.

### API + migrations

- `POST /me/username` (requireAuth): validate → 409 `taken` on the
  lower-cased unique index → write + audit row. The 409 must come from the
  DB constraint, not a pre-check alone (two claims can race).
- Migrations: `username` column + functional unique index + `NameChange` table.
  These are phase 2's (and the feature set's first) migrations — phase 1 still
  ships with none.
- Later, usernames become the pretty profile address (`#/players/@dave`
  resolving through the unique index) and the DM address for phase-3 messaging.
  The account cuid stays the canonical key underneath either way.

## 9. Resolved questions (Dave, 2026-08-24)

1. **Finished seasons on a profile**: show the place for 1st–3rd, otherwise just
   "Played" — folded into §3a (server-side redaction) and §4a.
2. **Rename flow**: yes — player-chosen unique usernames, spec above (§8),
   phase 2.
3. **Category trophies**: not yet — podium trophies only.
4. **Vanity URLs**: subsumed by usernames (§8); no separate feature. ENDED
   worlds appear only in the finished-seasons table, never under "currently
   flying" — LOBBY/RUNNING are "current".
