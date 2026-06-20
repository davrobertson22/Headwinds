# Tailwinds — Mobile / PWA Plan

**Goal:** Make the game usable and installable on phones without compromising the desktop experience.
**Approach:** Additive only. All mobile rules live behind `@media (max-width: 640px)` plus a small JS hook for inline-styled views. Base styles are never edited, so desktop renders pixel-identical to today.

---

## Audit findings (current state)

The codebase is well-positioned for this:

- **Single class-based stylesheet** (`src/index.css`, ~1,257 lines). No utility framework to fight — one appended media block can override anything.
- **Layout already flex-column** (`.app-layout`, `height:100vh`). Reflows naturally.
- **Nav tabs already scroll horizontally** (`overflow-x:auto`). Half-working on mobile already.
- **Most grids already fluid** — `auto-fit` / `auto-fill, minmax(...)`. Only one rigid `repeat(4, 1fr)` (line 738) needs overriding.

Friction points to address:

1. **Topbar density** — logo + airline + KPI cluster + Advance + 6 ghost buttons in a 58px bar. Won't fit ~375px. Largest piece of work.
2. **Tables** — 9 components use `<table width:100%>`; they squish below ~500px. Need scroll wrappers, with the busiest converted to stacked cards.
3. **Inline styles** — RouteMap (`height:520`) and a few others use `style={{...}}`. **Media queries cannot override inline styles**, so these need a JS `useIsMobile` hook. This is the only place mobile logic enters the JS.
4. **Tooltips** — 27 hover-only `title=` attributes vs. 5 tap-friendly `InfoTip` uses. Broken on touch.
5. **Mobile viewport details** — `height:100vh` (clips under mobile address bar), 13px inputs (triggers iOS focus-zoom), and no safe-area handling for installed PWA. All fixed in Phase 2.

*Already fine (no work needed):* modals/overlays are responsive (`min(560px,94vw)`, `max-height:90vh`); nav tabs already scroll; grids mostly fluid.

*Prerequisite:* `main` has uncommitted changes — must be committed/stashed before branching (see Phase 0).

---

## Does this risk desktop? No, if disciplined.

- **PWA plumbing** (manifest + service worker) is additive; desktop browsers ignore what they don't need. Only real risk is stale-cache after deploy → mitigated by network-first / auto-update service worker config.
- **Responsive CSS** is mobile-additive: all new rules scoped inside `@media (max-width:640px)`, so they don't apply on desktop viewports.
- **The one discipline rule:** never "fix" a layout by editing a base (unscoped) style — always add a mobile override. Editing base styles is the only way desktop regresses.
- **Tooltip change** is the single universal (non-scoped) change, and it improves desktop too (tap *and* hover).

---

## Phased plan

### Phase 0 — Clean baseline (PREREQUISITE)
`main` currently has uncommitted work (5 files, ~171 insertions, incl. an in-progress SetupScreen edit). The whole rollback model depends on branching from a clean, committed `main`. Commit or stash this work first, confirm a clean `git status`, then branch. **Do not start Phase 1 until this is done.**

### Phase 1 — PWA plumbing
Install `vite-plugin-pwa`. Add web manifest (name, icons from existing `/public` Tailwinds marks, `theme_color` `#18181b`, `display: standalone`). Configure auto-update service worker, network-first for the app shell to avoid stale builds. No visual change anywhere.
*Outcome: installable "Add to Home Screen," works offline.*

### Phase 2 — Breakpoint scaffolding + mobile viewport fixes
Append one `@media (max-width:640px)` block at the end of `index.css`. Add a small `useIsMobile()` React hook for the few inline-styled components. In the same scoped block, fix three mobile-only viewport issues found in audit:
- **`100dvh`**: `.app-layout`/`.setup-screen` use `height:100vh` (lines 101, 484) — switch to `100dvh` on mobile so the address bar doesn't clip the footer.
- **16px inputs**: `.form-input`/`.form-select` are 13px — bump to 16px on mobile to stop iOS auto-zoom on focus (affects SetupScreen most).
- **Safe-area insets**: add `env(safe-area-inset-*)` padding to topbar/footer so an installed PWA clears the notch / home indicator.

*Note: modals are already responsive (`min(560px,94vw)` / `max-height:90vh`) — no modal work needed.*

### Phase 3 — Topbar (biggest item)
Below 640px: collapse the 6 ghost buttons into an overflow ("⋯") menu, compact the KPI cluster (Cash stays visible as a pill), keep **Advance Week** as the primary action. Likely a two-row topbar on mobile.

### Phase 4 — Tables
Baseline: wrap all 9 table components in horizontal-scroll containers (quick, safe). Then convert the two highest-traffic tables (**Routes**, **Fleet**) to stacked card rows under 640px for a native feel. (Modals need no work — already responsive.)

### Phase 5 — Route map & inline-styled views
Use `useIsMobile()` to give RouteMap a responsive height and stacked legend/controls. Sweep remaining components for inline `width`/`height` that break narrow layouts.

### Phase 6 — Tooltips & tap targets
Replace the 27 `title=` tooltips with the existing `InfoTip` (tap-to-open). Bump tap-target sizing inside the mobile breakpoint only.

### Phase 7 — Test & verify
Test at 375 / 390 / 768px and desktop. Confirm desktop is pixel-identical. Lighthouse PWA audit, verify install. Run `npm test` to confirm no logic regressions.

---

## Reversibility (clean rollback, built in as we go)

Everything is reversible at two levels.

**Structural (git):**
- All work on a branch off `main`; `main` is never touched until you approve.
- Each phase = one atomic commit with a clear message, so any single phase can be undone independently via `git revert <hash>` without disturbing the others.
- Worst case, abandon the whole effort by deleting the branch — `main` is unchanged.

**Human-readable (`ROLLBACK.md`):**
A rollback log maintained *as each phase completes*, so reversal never requires reading diffs. Each entry records:
- Phase name + commit hash
- Files changed
- Exact command to undo just that phase (`git revert <hash>`)
- Any manual step needed on revert

**The one non-trivial revert — the service worker.** Once a browser registers a service worker, deleting the code is not enough; the worker keeps running until explicitly unregistered. Mitigations, all documented in `ROLLBACK.md`:
- Use auto-update / network-first config from the start (already in Phase 1).
- Keep a "kill-switch" self-unregistering service worker ready to deploy, which clears caches and removes itself from users' browsers.
This is the only change that affects users' machines rather than just the repo, so it gets its own documented procedure.

Every other phase is a pure code revert with zero user-side residue.

---

## After this: optional native app
Once responsive, wrap with **Capacitor** to ship to the App Store / Play Store — near-zero code change, reuses this same build. Separate, later effort.

## Known future item (flag, not in scope)
Saves are client-side. On mobile, app/browser storage clears more aggressively and people switch devices. If mobile becomes a real channel, plan for accounts + cloud save (a small backend) — bigger than the CSS work, so tracked separately.

---

## Suggested sequencing
Phase 1 and 2 are independent and quick. Phase 3 is the heaviest. Phases 4–6 can be done component-by-component and shipped incrementally — nothing is all-or-nothing. Each phase is independently shippable and desktop-safe.
