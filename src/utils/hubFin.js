// Tail-fin markers for hubs on the maps — static HTML for Leaflet divIcons and
// MapLibre markers, rendered once per airline look and fin size (not per
// marker, not per poll).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TailFin from '../components/TailFin.jsx';
import { liveryFor } from '../data/livery.js';

/** Fin height in px for a hub tier (focus city 0 … gateway 3): bigger stations, bigger fins. */
export const hubFinSize = (tier) => 24 + 3 * Math.max(0, Math.min(3, tier ?? 1));

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
 * Fin HTML per tier for one airline: { html(tier) → string, key }.
 *   who      an airline state, or a rival view (livery + logo fields)
 *   prefix   unique per map/airline, so clip-path ids never collide on a page
 *
 * LAZY on purpose: `html(tier)` renders on first call and caches. Callers
 * build this object during render (cheap: it only hashes the look) and call
 * html() inside effects — a renderToStaticMarkup DURING another render swaps
 * React's dispatcher out from under the outer component and breaks its hooks.
 */
export function hubFinMarkup(who, prefix = 'own') {
  const livery = liveryFor(who);
  const logo = logoOf(who);
  const name = who?.airlineName ?? who?.name ?? 'Airline';
  const cache = {};
  return {
    key: hashStr(JSON.stringify([livery, logo, name, prefix])),
    html(tier = 1) {
      const t = Math.max(0, Math.min(3, Number.isFinite(tier) ? tier : 1));
      return (cache[t] ??= renderToStaticMarkup(createElement(TailFin, {
        livery, logo, size: hubFinSize(t), idPrefix: `${prefix}-t${t}`, title: `${name} hub`,
      })));
    },
  };
}
