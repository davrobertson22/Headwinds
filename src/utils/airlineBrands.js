// Airline branding for screens that name OTHER airlines.
//
// Two jobs, both React-free so tools/airline-identity-test.mjs imports them
// directly:
//
//   brandIndex(state, myAirlineId)   airline id → the logo fields AirlineLogo
//       takes, for the News tab and the Activity ticker. Built from what the
//       client already holds — your own state plus the human rivals in
//       state.competitors (server lib/humanRivals.mjs) — so no new request and
//       nothing new on the wire. A human rival's competitor id is
//       'human:<airlineId>' or, after a restart, 'human:<airlineId>~g<n>';
//       news rows carry the bare airline id.
//
//   rivalNetworkColor(carrier)       the colour a rival's own lines take on the
//       Rivals map: their livery's tail colour, when it reads on the dark and
//       satellite basemaps and can't be mistaken for one of the map's
//       meanings (contested amber, freight amber, hub gold, multi-stop
//       purple). Anything else falls back to the neutral slate. A rival's
//       PROFIT is still never shown — the colour only says whose network it is.

import { liveryFor } from '../data/livery.js';
import { cleanHex, contrastRatio } from './logoBranding.js';

/** 'human:abc~g2' → 'abc'; 'human:abc' → 'abc'; anything else → null. */
export function airlineIdOfRival(id) {
  if (typeof id !== 'string' || !id.startsWith('human:')) return null;
  const rest = id.slice('human:'.length);
  const at = rest.indexOf('~g');
  const bare = at >= 0 ? rest.slice(0, at) : rest;
  return bare || null;
}

/** The AirlineLogo props of anything carrying logo fields, or null. */
export function brandOf(src) {
  if (!src || typeof src !== 'object') return null;
  const logoId = typeof src.logoId === 'string' && src.logoId ? src.logoId : null;
  const customLogo = typeof src.customLogo === 'string' && src.customLogo ? src.customLogo : null;
  if (!logoId && !customLogo) return null;
  return {
    logoId: logoId ?? 'compass',
    logoColor: typeof src.logoColor === 'string' ? src.logoColor : null,
    logoBg: typeof src.logoBg === 'string' ? src.logoBg : null,
    customLogo,
  };
}

/** Map<airlineId, brand> for you and every human rival in the state. */
export function brandIndex(state, myAirlineId = null) {
  const out = new Map();
  for (const c of state?.competitors ?? []) {
    const id = airlineIdOfRival(c?.id);
    const b = id ? brandOf(c) : null;
    if (b) out.set(id, b);
  }
  if (myAirlineId) {
    const mine = brandOf(state);
    if (mine) out.set(myAirlineId, mine);
  }
  return out;
}

// ── Rivals map colour ────────────────────────────────────────────────────────

/** The neutral slate a rival's lines fall back to (mapCore RIVAL_COLOR). */
export const RIVAL_FALLBACK = '#8fa3bf';

// What the lines sit on: the dark basemap's container and the satellite ocean.
const MAP_BACKGROUNDS = ['#0b1017', '#02051a'];
/** A line must stand out from the basemap at least this much. */
export const MIN_LINE_CONTRAST = 3;

// Colours the Rivals map already gives a meaning (mapCore.js): contested,
// freight, hub, multi-stop — plus near-copies of the player map's profit green
// and loss red. Only near-copies: plenty of real airlines are red, and a deep
// red tail is still plainly "their network" beside the legend.
const RESERVED = ['#fbbf24', '#e8833a', '#ffcf4d', '#a371f7', '#2ee6a0', '#ff5d6c'];
/** RGB distance under which a colour reads as a reserved one. */
export const MIN_RESERVED_DISTANCE = 90;

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function distance(a, b) {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/** True when `hex` can carry a rival's identity on the Rivals map. */
export function usableNetworkColor(hex) {
  const c = cleanHex(hex);
  if (!c) return false;
  if (MAP_BACKGROUNDS.some((bg) => contrastRatio(c, bg) < MIN_LINE_CONTRAST)) return false;
  return RESERVED.every((r) => distance(c, r) >= MIN_RESERVED_DISTANCE);
}

/**
 * The colour of a rival's uncontested passenger lines: their livery's tail
 * (a saved livery, else the default one derived from their logo colour), when
 * usable; otherwise slate.
 */
export function rivalNetworkColor(carrier) {
  if (!carrier) return RIVAL_FALLBACK;
  const tail = liveryFor(carrier).tail;
  return usableNetworkColor(tail) ? cleanHex(tail) : RIVAL_FALLBACK;
}
