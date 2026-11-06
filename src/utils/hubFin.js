// Tail-logo markers for hubs on the maps — components/TailFin.jsx as static
// markup for Leaflet divIcons and MapLibre markers, rendered once per look
// and size (not per marker, not per poll).
//
// `load()` is kept for the map effects' contract (it resolves at once: a flat
// SVG needs nothing decoded); `html(tier)` renders on first call and caches.
// renderToStaticMarkup is called only from map effects, never during a
// render — a static render inside another render swaps React's dispatcher
// out from under the outer component and breaks its hooks.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TailFin, { FIN_ASPECT } from '../components/TailFin.jsx';
import { liveryFor, liveryKey } from '../data/livery.js';

/** Tail height in px for a hub tier (focus city 0 … gateway 3): bigger stations, bigger tails. */
export const hubFinSize = (tier) => 22 + 4 * Math.max(0, Math.min(3, tier ?? 1));

/** Width ÷ height of a hub marker (the fin silhouette). */
export const tailAspect = () => FIN_ASPECT;

/** The AirlineLogo fields of an airline state or rival view. */
export const logoOf = (a) => ({
  id: a?.customLogo ? null : (a?.logoId ?? 'compass'),
  accentColor: a?.logoColor ?? null,
  bgColor: a?.logoBg ?? null,
  customSrc: a?.customLogo ?? null,
});

/** Cheap stable hash of a string (FNV-1a), for redraw keys. */
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/**
 * Tail markup for one airline: { key, load(tiers?) → Promise, html(tier) }.
 *   who   an airline state, or a rival view (livery + logo fields)
 */
export function hubFinMarkup(who) {
  const livery = liveryFor(who);
  const logo = logoOf(who);
  const name = who?.airlineName ?? who?.name ?? 'Airline';
  const key = hashStr(JSON.stringify([liveryKey(livery), logo]));
  const cache = {};
  return {
    key,
    async load() { return true; },
    html(tier = 1) {
      const t = Math.max(0, Math.min(3, Number.isFinite(tier) ? tier : 1));
      return (cache[t] ??= renderToStaticMarkup(createElement(TailFin, {
        livery, logo, height: hubFinSize(t), idPrefix: `hub-${key}-t${t}`, title: `${name} hub`,
      })));
    },
  };
}
