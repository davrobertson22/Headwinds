// Thin wrapper around Google's H5 Games Ads "Ad Placement API".
//
// The adBreak()/adConfig() functions are defined in index.html (they push
// onto window.adsbygoogle). If H5 Games Ads isn't yet active on the account —
// or an ad simply isn't available — these calls are harmless no-ops, so the
// game keeps working whether or not an ad actually shows.

/**
 * Request a between-action interstitial ("next" placement type — the format
 * Google intends for transitions between game levels, i.e. advancing a week).
 *
 * @param {string} name  Stable label for this placement (used by Google reporting).
 * @param {object} [hooks]
 * @param {() => void} [hooks.beforeAd]  Pause/mute the game before the ad shows.
 * @param {() => void} [hooks.afterAd]   Resume the game after the ad closes.
 */
export function gameAdBreak(name = 'weekly_debrief', hooks = {}) {
  if (typeof window === 'undefined' || typeof window.adBreak !== 'function') return;

  try {
    window.adBreak({
      type: 'next',
      name,
      beforeAd: hooks.beforeAd || function () {},
      afterAd: hooks.afterAd || function () {},
      // Fires whether or not an ad was shown — useful for debugging in dev.
      adBreakDone: function (placementInfo) {
        if (typeof console !== 'undefined' && console.debug) {
          console.debug('[ads] adBreak done:', placementInfo && placementInfo.breakStatus);
        }
      },
    });
  } catch (err) {
    // Never let an ad failure break gameplay.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[ads] adBreak failed:', err);
    }
  }
}
