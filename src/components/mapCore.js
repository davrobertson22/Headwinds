// Shared map primitives — geometry, the Leaflet CDN loader, the basemap and the
// route palette.
//
// Extracted from RouteMap.jsx when the Rivals tab grew its own map. Two maps
// drawing great-circle arcs on a dark basemap must not drift apart: a rival's
// JFK–LHR line has to sit exactly where your own JFK–LHR line sits, or the
// overlap a player is trying to read is a lie. One implementation, both callers.
//
// This module is deliberately React-free — it is plain geometry plus DOM/Leaflet
// setup, so it can be imported by a test harness with no renderer.

// ── Great-circle interpolation ────────────────────────────────────────────────
export function greatCirclePoints(lat1, lon1, lat2, lon2, n = 80) {
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const φ1 = lat1 * D2R, λ1 = lon1 * D2R;
  const φ2 = lat2 * D2R, λ2 = lon2 * D2R;
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
  ));
  if (d < 0.001) return [[lat1, lon1], [lat2, lon2]];
  return Array.from({ length: n + 1 }, (_, i) => {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    return [
      Math.atan2(z, Math.sqrt(x ** 2 + y ** 2)) * R2D,
      Math.atan2(y, x) * R2D,
    ];
  });
}

// ── Great-circle path as a single continuous segment ─────────────────────────
// Keeps longitudes unwrapped (may exceed ±180) so Leaflet draws one smooth arc
// across world copies instead of splitting at the antimeridian edge.
export function segmentsForRoute(lat1, lon1, lat2, lon2, n = 80) {
  const raw = greatCirclePoints(lat1, lon1, lat2, lon2, n);
  if (raw.length === 0) return [raw];

  // Unwrap longitudes so the path is continuous (Leaflet handles >±180 fine)
  const norm = [[...raw[0]]];
  for (let i = 1; i < raw.length; i++) {
    let lon = raw[i][1];
    const prev = norm[i - 1][1];
    while (lon - prev >  180) lon -= 360;
    while (prev - lon >  180) lon += 360;
    norm.push([raw[i][0], lon]);
  }

  return [norm];
}

// ── Leaflet CDN loader ────────────────────────────────────────────────────────
export const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
export const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

// One in-flight load shared by every caller. Without this, opening a rival map
// while the main route map is still fetching Leaflet appended a second <script>
// for the same library and both callers raced on window.L.
let leafletPromise = null;

export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;

  leafletPromise = new Promise((resolve, reject) => {
    // CSS
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }

    // JS
    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.onload  = () => resolve(window.L);
    script.onerror = () => {
      // A failed load must not poison every later attempt — drop the cached
      // promise so a retry (e.g. the user reopening the panel) can try again.
      leafletPromise = null;
      reject(new Error('Failed to load Leaflet'));
    };
    document.head.appendChild(script);
  });
  return leafletPromise;
}

// ── Basemap ───────────────────────────────────────────────────────────────────
export const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
export const TILE_OPTS = {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 20,
};

/** A dark CartoDB map on `el`. Both route maps share the basemap so a rival's
 *  network reads against the same coastlines as your own. */
export function createDarkMap(el, opts = {}) {
  const L = window.L;
  const map = L.map(el, {
    center: [20, 10],
    zoom: 2,
    minZoom: 1,
    maxZoom: 10,
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true,
    ...opts,
  });
  L.tileLayer(TILE_URL, TILE_OPTS).addTo(map);
  return map;
}

// ── Palette ────────────────────────────────────────────────────────────────────
export const PROFIT_COLOR    = '#2ee6a0';  // bright teal-green
export const LOSS_COLOR      = '#ff5d6c';  // bright coral-red
export const HUB_COLOR       = '#ffcf4d';  // gold
export const SPOKE_COLOR     = '#4da6ff';  // sky blue
export const ALLIANCE_COLOR  = '#b794ff';  // purple for alliance members
export const CODESHARE_COLOR = '#38e1ff';  // cyan for codeshare partners
export const CARGO_COLOR     = '#e8833a';  // amber for cargo / freight routes

// Rivals tab. A rival's own network is deliberately NOT green/red — profit is
// private, so colouring their lines by profitability would be inventing data.
// Neutral slate for lanes you don't fly; contested amber for the ones where you
// meet them, which is the only fact this map can actually assert.
export const RIVAL_COLOR     = '#8fa3bf';  // slate — rival route you don't fly
export const CONTESTED_COLOR = '#fbbf24';  // amber — you fly this pair too
