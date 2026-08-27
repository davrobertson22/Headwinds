// eraFeatures.js — when game features become historically available (era
// worlds phase 5, ERA_MODE_PLAN.md §3.4).
//
// A 1955 airline selling seat-selection fees over onboard Wi-Fi while its
// global alliance negotiates codeshares is not a period piece. Each entry is
// the year the CONCEPT arrives in the world; before it, the reducer refuses
// the action (eraFeatureDenial) and the UI hides or disables the surface with
// the same message. Classic worlds (startYear null) short-circuit — the parity
// invariant.
//
// These are concept dates, deliberately round: the point is that the feature
// APPEARS mid-era with a little fanfare, not archival precision.

export const ERA_FEATURE_FROM = {
  wifi:            2004,   // Connexion by Boeing — onboard internet exists
  ancillaries:     2008,   // post-GFC unbundling: bag fees, seat fees, à la carte
  codeshares:      1990,   // modern codeshare agreements spread ~1989-1992
  globalAlliances: 1997,   // Star Alliance founds; oneworld/SkyTeam follow
  lounges:         1985,   // branded contract-lounge networks (clubs existed, the NETWORK product didn't)
  gateAuctions:    1990,   // formalised slot/gate trading and auction mechanisms
};

export const ERA_FEATURE_MESSAGE = {
  wifi:            'Onboard Wi-Fi does not exist yet — the first airborne internet arrives around 2004.',
  ancillaries:     'À la carte ancillary pricing does not exist yet — unbundled fees arrive around 2008.',
  codeshares:      'Codeshare agreements do not exist yet — they arrive around 1990.',
  globalAlliances: 'Global airline alliances do not exist yet — the first forms in 1997.',
  lounges:         'Branded lounge networks do not exist yet — they arrive around 1985.',
  gateAuctions:    'Formal gate auctions do not exist yet — they arrive around 1990.',
};

/**
 * Is this feature available at this calendar year?
 * calYear null (classic world) → always true.
 */
export function featureLive(feature, calYear) {
  if (calYear == null) return true;
  return calYear >= (ERA_FEATURE_FROM[feature] ?? 0);
}
