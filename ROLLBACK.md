# ROLLBACK — Mobile / PWA work

How to undo any part of the mobile/PWA effort, phase by phase. All work lives on
the **`mobile-pwa`** branch; `main` is the pre-mobile baseline.

## Fastest full undo
You never merged anything you didn't want, so the nuclear option is simple:
```bash
git checkout main          # return to the pre-mobile state
git branch -D mobile-pwa   # (optional) delete the mobile branch entirely
```
`main` is exactly as it was before this work began.

## Per-phase undo
Each phase is its own commit on `mobile-pwa`. To undo one phase without touching
the others:
```bash
git revert <commit-hash>   # creates an inverse commit; safe, preserves history
```
Find hashes with `git log --oneline`. Phase entries below list the files each
phase touched so you can confirm scope before reverting.

> Note on the sandbox: git commits in this effort are run by you in your own
> Terminal (the assistant edits files but does not commit). If you ever see
> `fatal: Unable to create '.git/index.lock': File exists`, it's a harmless
> leftover from the sandbox — just `rm .git/index.lock` and retry.

---

## Phase 0 — Clean baseline  ✅ committed
**Commit:** `59b8d75  Add custom airline logo upload`
This committed pre-existing uncommitted work (the custom-logo-upload feature) so
the mobile branch starts from a clean tree. It is a real feature, not mobile
work — leave it in place. To undo *just* this: `git revert 59b8d75`.
Files: `src/App.jsx`, `src/components/AirlineLogo.jsx`,
`src/components/SaveLoadModal.jsx`, `src/components/SetupScreen.jsx`,
`src/store/GameContext.jsx`.

---

## Phase 1 — PWA plumbing (manifest + service worker)
**Commit:** `_____` (fill in after committing)
Makes the app installable + offline-capable. Network-first, so it cannot pin
users to a stale build.

Added:
- `public/manifest.webmanifest`
- `public/sw.js`  (the service worker)
- `public/pwa-icon-192.png`, `public/pwa-icon-512.png`, `public/pwa-icon-maskable-512.png`

Changed:
- `index.html` — added `<link rel="manifest">`, `theme-color`, Apple PWA meta + touch icon (status-bar style = `default`)
- `src/main.jsx` — added the production-only service-worker registration block

**Code revert:** `git revert <hash>` (or delete the added files + the two edits).

**⚠ Service worker — the one non-pure-code revert.** Reverting the code stops
*new* visitors from registering the worker, but browsers that already registered
it keep running the cached worker until it's explicitly removed. To purge it from
those browsers, deploy a **kill-switch worker**: replace `public/sw.js` with the
file below and ship it. It unregisters itself and clears all caches, then can be
deleted on a later deploy.

```js
// public/sw.js  — KILL SWITCH: unregister and clear all caches
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll();
    clients.forEach((c) => c.navigate(c.url));
  })());
});
```
(An individual user can also clear it manually: DevTools → Application → Service
Workers → Unregister.)

---

## Phase 2 — Mobile breakpoint scaffolding + viewport fixes
**Commit:** `_____` (fill in after committing)
Adds the mobile foundation. All CSS changes are inside a single
`@media (max-width: 640px)` block, so desktop (>640px) is byte-for-byte
unchanged.

Added:
- `src/hooks/useIsMobile.js` — JS breakpoint hook for inline-styled components

Changed:
- `src/index.css` — appended one `@media (max-width: 640px)` block at the very
  end (`100dvh` fix + 16px form inputs). No existing rules were modified.

**Code revert:** `git revert <hash>`, or manually: delete the trailing
`@media (max-width: 640px)` block from `index.css`, delete
`src/hooks/useIsMobile.js`. Nothing else references them yet.
Desktop risk: none — the only change outside the media query is the iOS meta tag.

---

## Phase 3 — Mobile topbar (overflow menu)
**Commit:** `_____` (fill in after committing)
On mobile (≤640px) the 6 ghost buttons collapse into a single "⋯" overflow
menu; the brand mark and DATE KPI are hidden to fit; Cash + Next-Week stay.

Changed:
- `src/App.jsx` — wrapped the existing desktop ghost buttons in
  `{!isMobile && (<> … </>)}` (unchanged output on desktop) and added an
  `{isMobile && …}` overflow-menu block. Also added `useIsMobile` import and
  `showMobileMenu` state.
- `src/index.css` — added topbar rules **inside** the existing
  `@media (max-width: 640px)` block (menu styles, hidden brand/date, etc.).

**Code revert:** `git revert <hash>`. Desktop risk: none — the desktop branch
renders the identical button markup; all new CSS is inside the mobile media query.

**Also added earlier (manifest screenshot):** `public/screenshot-wide.png` +
a `screenshots` entry in `public/manifest.webmanifest` (clears the desktop
"richer install UI" warning). Harmless to keep; remove the file + that JSON key
to revert.

## Phase 4 — Mobile tables + page padding
**Commit:** `_____` (fill in after committing)
On mobile, wide data tables scroll horizontally (columns intact) instead of
crushing; page padding tightened from 26px to 12px.

Changed:
- `src/index.css` — added, **inside** the `@media (max-width: 640px)` block:
  reduced `.main-content` padding, made `.main-content table` a horizontal
  scroll container (`display:block; overflow-x:auto; white-space:nowrap`), and
  slightly reduced cell padding.
- (Also widened the mobile `.topbar-airline` max-width 84px → 120px — tiny
  Phase 3 follow-up, same media block.)

**Code revert:** `git revert <hash>`, or delete the Phase 4 rules from the media
block. Desktop risk: none — everything is inside the mobile media query.

## Phase 5 — Route map responsive height
**Commit:** `_____` (fill in after committing)
The Map tab's container had a fixed inline `height: 520` (unreachable by CSS).

Changed:
- `src/components/RouteMap.jsx` — imported `useIsMobile`, derived
  `mapHeight = isMobile ? 380 : 520`, replaced the three `height: 520` inline
  styles with `height: mapHeight`, and added a `useEffect` that calls Leaflet's
  `invalidateSize()` when `mapHeight` changes (so tiles remeasure on resize).

**Code revert:** `git revert <hash>`, or set the three heights back to `520`,
remove the `useIsMobile`/`mapHeight` lines and the `invalidateSize` effect.
Desktop risk: none — on desktop `isMobile` is false so `mapHeight` is 520, the
original value; the extra effect is a no-op when size doesn't change.

Audit note: swept all components for fixed inline widths/heights that could
break narrow layouts — none found beyond table min-widths already inside scroll
wrappers.

## Phase 6 — Tooltips: reviewed, no code change
Inspected all 27 `title=` attributes. Outcome: **no changes made** (nothing to
revert).
- Most are action-button hints (Swap, Cancel, Delete, Acquire, map toggles) —
  the tap performs the action; no info is lost on touch.
- The informational ones have visible fallbacks (e.g. CateringSelector already
  prints the selected option's description below the buttons).
- The `InfoTip` component (used for real explanatory tooltips) is already
  tap-friendly: `tabIndex={0}` + `.infotip:focus .infotip-bubble` in index.css.

Optional future polish (not done): tap-to-reveal values on chart fragments
(Dashboard pie slices, Finance cost bars), which are currently hover-only with
no fallback. This is per-chart feature work, not a tooltip swap.

## Follow-up — Disclaimer scrolls instead of pinned (desktop + mobile)
**Commit:** `_____` (fill in after committing)
The AI-disclosure footer was permanently pinned at the bottom, taking up screen
space. Now it sits at the end of the scrollable content on BOTH desktop and
mobile (intentional desktop change, per request).

Changed:
- `src/App.jsx` — moved `<footer className="app-footer app-footer-inline">`
  inside `.main-content` (end of scroll content); removed the pinned footer that
  used to sit after `.main-content`.
- `src/index.css` — base `.app-footer-inline` rule (full-width via -26px margins
  offsetting `.main-content` padding) + a mobile override (-12px) in the media
  block.

**Code revert:** `git revert <hash>`, or move the `<footer className="app-footer">`
back out to a sibling after `.main-content` and drop the `.app-footer-inline`
rules. Note: this one DOES change desktop (by design).
