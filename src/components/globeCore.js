// Globe view primitives — geometry, the MapLibre loader and the style.
//
// The Network map's 3D globe (2026-10-02, after the "routes run off the map"
// reports). It draws the SAME route data as the flat Leaflet map; only the
// projection differs. Like mapCore.js this module is React-free so a test can
// import it with no renderer, no WebGL and no network.
//
// What the globe does NOT need from mapCore: polar softening and world copies.
// Both exist only because Web Mercator cannot draw a near-polar great circle or
// a line that crosses the date line. On a sphere a great circle is just a line,
// so the globe draws the true path. Squashing it would bend it off the sphere's
// real route.

import { greatCirclePoints, cartoTileUrl, CARTO_KEY, TILE_OPTS } from './mapCore.js';

// ── MapLibre CDN loader ───────────────────────────────────────────────────────
// Pinned to the 5.x line: 6.x ships ESM-only with a split worker and no UMD
// build, so it can't be loaded the way Leaflet is (one <script>, a global).
export const MAPLIBRE_VERSION = '5.24.0';
export const MAPLIBRE_CSS = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;
export const MAPLIBRE_JS  = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js`;

let maplibrePromise = null;

export function loadMaplibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (maplibrePromise) return maplibrePromise;
  maplibrePromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${MAPLIBRE_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = MAPLIBRE_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = MAPLIBRE_JS;
    script.onload = () => resolve(window.maplibregl);
    script.onerror = () => {
      maplibrePromise = null;   // let a later open retry
      reject(new Error('Failed to load the globe renderer'));
    };
    document.head.appendChild(script);
  });
  return maplibrePromise;
}

/** True when this browser can draw the globe at all. */
export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

// ── Geometry ──────────────────────────────────────────────────────────────────
/** Great-circle path through a chain of [lat, lon] stops, longitudes unwrapped
 *  so consecutive points never jump by more than 180°. No polar softening. */
export function globeChainPath(points, n = 64) {
  const pts = (points ?? []).filter(p => Array.isArray(p) && p.length >= 2);
  if (pts.length < 2) return pts.map(p => [p[0], p[1]]);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const leg = greatCirclePoints(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], n);
    for (let j = out.length ? 1 : 0; j < leg.length; j++) {
      let [lat, lon] = leg[j];
      if (out.length) {
        const prev = out[out.length - 1][1];
        while (lon - prev > 180) lon -= 360;
        while (prev - lon > 180) lon += 360;
      }
      out.push([lat, lon]);
    }
  }
  return out;
}

const worldOf = (lon) => Math.floor((lon + 180) / 360);

/** Split an unwrapped [lat, lon] path where it crosses the date line, returning
 *  pieces whose longitudes all sit in [−180, 180]. GeoJSON (RFC 7946 §3.1.9)
 *  wants antimeridian-crossing lines cut this way; on the globe the two pieces
 *  meet seamlessly. */
export function splitAntimeridian(path) {
  if (!path?.length) return [];
  const lines = [];
  let w = worldOf(path[0][1]);
  let cur = [[path[0][0], path[0][1] - 360 * w]];
  for (let i = 1; i < path.length; i++) {
    const [lat0, lon0] = path[i - 1];
    const [lat1, lon1] = path[i];
    const w1 = worldOf(lon1);
    if (w1 !== w) {
      // The boundary between world w and w1 (they differ by one: steps < 180°).
      const edge = w1 > w ? 360 * w1 - 180 : 360 * w - 180;
      const t = (edge - lon0) / (lon1 - lon0);
      const latEdge = lat0 + (lat1 - lat0) * t;
      cur.push([latEdge, edge - 360 * w]);           // +180 or −180 in world w
      if (cur.length >= 2) lines.push(cur);
      cur = [[latEdge, edge - 360 * w1]];             // the opposite edge
      w = w1;
    }
    cur.push([lat1, lon1 - 360 * w]);
  }
  if (cur.length >= 2) lines.push(cur);
  return lines;
}

/** A MultiLineString geometry for a chain of airports, GeoJSON [lon, lat]. */
export function chainGeometry(points, n = 64) {
  return {
    type: 'MultiLineString',
    coordinates: splitAntimeridian(globeChainPath(points, n))
      .map(line => line.map(([lat, lon]) => [lon, lat])),
  };
}

/** Bounds to fly to for a focused rotation, as [[w, s], [e, n]]. Taken from the
 *  unwrapped path so a trans-Pacific route frames across the Pacific rather
 *  than the long way round. */
export function chainBounds(points) {
  const path = globeChainPath(points, 32);
  if (!path.length) return null;
  let s = 90, n = -90, w = Infinity, e = -Infinity;
  for (const [lat, lon] of path) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  // Bring the box's centre into [−180, 180] without changing its width; an
  // edge may still sit past ±180, which MapLibre frames correctly.
  const shift = -360 * Math.round((w + e) / 2 / 360);
  return [[w + shift, s], [e + shift, n]];
}

// ── Data → GeoJSON ────────────────────────────────────────────────────────────
// The caller (RouteMap) decides colour and tooltip; this only turns "a line
// through these airports" into features. Feature ids are the route-group keys,
// promoted so hover and focus can be set through feature-state.
const ll = (a) => [a.lat, a.lon];

export function buildGlobeData({ routes = [], cargo = [], partners = [], airports = [] } = {}) {
  const lineFC = (items) => ({
    type: 'FeatureCollection',
    features: items
      .filter(it => (it.chain?.length ?? 0) >= 2)
      .map(it => ({
        type: 'Feature',
        properties: { id: it.id, color: it.color, tip: it.tip ?? '' },
        geometry: chainGeometry(it.chain.map(ll)),
      })),
  });
  return {
    routes:   lineFC(routes),
    cargo:    lineFC(cargo),
    partners: lineFC(partners),
    partnerStops: {
      type: 'FeatureCollection',
      features: partners.flatMap(p => (p.chain ?? []).map(a => ({
        type: 'Feature',
        properties: { color: p.color },
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
      }))),
    },
    airports: {
      type: 'FeatureCollection',
      features: airports.map(a => ({
        type: 'Feature',
        properties: { id: a.code, code: a.code, hub: !!a.hub, core: a.core ?? 5, tip: a.tip ?? '' },
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
      })),
    },
  };
}

// ── Style ─────────────────────────────────────────────────────────────────────
/** CARTO's dark raster tiles, the same ones the flat map uses (and the same
 *  key). MapLibre has no {s} subdomain template, so the four hosts are listed. */
export function globeTileUrls(key = CARTO_KEY, retina = false) {
  const tpl = cartoTileUrl(key).replace('{r}', retina ? '@2x' : '');
  return (TILE_OPTS.subdomains ?? 'abcd').split('').map(s => tpl.replace('{s}', s));
}

export const SPACE_COLOR = '#03060d';

export function globeStyle({ retina = false } = {}) {
  return {
    version: 8,
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#0b1a33',
      'horizon-color': '#1b3a66',
      'fog-color': '#060b18',
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.8, 4, 0.6, 6, 0],
    },
    sources: {
      carto: {
        type: 'raster',
        tiles: globeTileUrls(CARTO_KEY, retina),
        tileSize: 256,
        maxzoom: 18,
        attribution: TILE_OPTS.attribution,
      },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': '#060b18' } },
      { id: 'carto', type: 'raster', source: 'carto' },
    ],
  };
}

/** Zoom at which the whole globe fills about 80% of a map `height` px tall.
 *  MapLibre's world is 512 px around at zoom 0, so the sphere's diameter is
 *  512·2^z/π. */
export function globeZoomFor(height) {
  const z = Math.log2((0.8 * height * Math.PI) / 512);
  return Math.max(0, Math.min(3, z));
}
