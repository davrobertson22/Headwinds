// Tail markers for hubs on the maps — the painted fin (components/TailFin.jsx
// tailCanvas, the fin-only crop: the classic airline tail logo) as <img> HTML for Leaflet divIcons and MapLibre markers.
//
// Painting needs the template decoded and a canvas, so it is asynchronous and
// client-only: a map effect calls `load()` once per look, then `html(tier)`
// hands back an <img> with the painted data URL (or '' until it has loaded —
// the hub pin underneath still shows). Painted once per look and size, never
// per marker or per poll.
import { tailCanvas } from '../components/TailFin.jsx';
import { liveryFor, liveryKey } from '../data/livery.js';
import { getLiveryTemplate, DEFAULT_LIVERY_TEMPLATE, tailCropOf } from '../data/liveryTemplates.js';

/** Tail height in px for a hub tier (focus city 0 … gateway 3): bigger stations, bigger tails. */
export const hubFinSize = (tier) => 26 + 4 * Math.max(0, Math.min(3, tier ?? 1));

/** Width ÷ height of a hub marker (the template's fin-only crop). */
export const tailAspect = () => tailCropOf(getLiveryTemplate(DEFAULT_LIVERY_TEMPLATE), 'fin').aspect;

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

const urls = new Map();   // `${key}|${tier}` → data URL

/**
 * Tail markup for one airline: { key, load(tiers?) → Promise, html(tier) }.
 *   who   an airline state, or a rival view (livery + logo fields)
 */
export function hubFinMarkup(who) {
  const livery = liveryFor(who);
  const logo = logoOf(who);
  const name = who?.airlineName ?? who?.name ?? 'Airline';
  const key = hashStr(JSON.stringify([liveryKey(livery), logo]));
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
  return {
    key,
    async load(tiers = [0, 1, 2, 3]) {
      if (typeof document === 'undefined') return false;
      let painted = false;
      for (const tier of tiers) {
        const k = `${key}|${tier}`;
        if (urls.has(k)) continue;
        try {
          const c = await tailCanvas({ livery, logo, height: hubFinSize(tier), dpr, crop: 'fin' });
          urls.set(k, c.toDataURL('image/png'));
          painted = true;
        } catch { /* template missing: the pin alone */ }
      }
      if (urls.size > 256) urls.delete(urls.keys().next().value);
      return painted;
    },
    html(tier = 1) {
      const t = Math.max(0, Math.min(3, Number.isFinite(tier) ? tier : 1));
      const url = urls.get(`${key}|${t}`);
      if (!url) return '';
      const h = hubFinSize(t);
      return `<img src="${url}" alt="${String(name).replace(/[&<>"]/g, '')} hub" draggable="false" style="display:block;height:${h}px;width:auto;pointer-events:none">`;
    },
  };
}
