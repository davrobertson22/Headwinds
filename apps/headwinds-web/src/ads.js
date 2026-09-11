// The supporter ad-free perk.
//
// Headwinds runs AdSense Auto Ads, loaded from play.html's <head>. Ad requests
// start PAUSED there (`adsbygoogle.pauseAdRequests = 1`) and this module is what
// releases them, once the app knows whether the signed-in account is a
// supporter. That ordering matters and the obvious alternative is worse:
// injecting the AdSense tag at runtime instead would take the script out of the
// static <head> that AdSense's own reviewer and Google's crawler fetch — and
// headwindsairlinegame.com has already been rejected once (2026-07-28, "low
// value content"). Pause/resume is Google's documented pattern (it is what
// consent flows use), so the tag stays exactly where a reviewer expects it.
//
// FAILSAFE: if the app throws before it can resolve, ads must NOT stay paused
// forever — that is silent revenue loss with no error anywhere. A timer releases
// them regardless after ADS_FAILSAFE_MS. /me normally resolves in well under a
// second, so a supporter should never reach it.

// One-line kill switch. Set to false and ads behave exactly as they did before
// any of this landed: released on first paint, for everyone, supporters
// included. Worth flipping if fill rate or RPM drops after launch — the pause
// is the only part of the supporter build that can touch ad revenue.
export const SUPPORTER_AD_FREE = true;

const ADS_FAILSAFE_MS = 8000;

let settled = false;
let failsafe = null;

function release() {
  try {
    window.adsbygoogle = window.adsbygoogle || [];
    window.adsbygoogle.pauseAdRequests = 0;
    // Auto Ads needs a push after an unpause to start filling the page.
    window.adsbygoogle.push({});
  } catch { /* adblocker, or the tag never loaded — nothing to do */ }
}

function settle(fn) {
  if (settled) return;
  settled = true;
  if (failsafe) { clearTimeout(failsafe); failsafe = null; }
  fn();
}

/** Arm the failsafe. Call once on mount, before auth has resolved. */
export function armAdFailsafe() {
  if (!SUPPORTER_AD_FREE) { settle(release); return; }
  if (settled || failsafe) return;
  failsafe = setTimeout(() => settle(release), ADS_FAILSAFE_MS);
}

/**
 * Decide, now that the account is known.
 *   supporter → leave ads paused for the rest of the page's life
 *   everyone else (signed out included) → release
 * First call wins; later ones are ignored, so a /me refresh mid-session can't
 * flicker ads onto a supporter's screen.
 */
export function resolveAds(isSupporter) {
  if (!SUPPORTER_AD_FREE) { settle(release); return; }
  settle(() => { if (!isSupporter) release(); });
}
