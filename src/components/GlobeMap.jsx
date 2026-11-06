import { useEffect, useRef, useState } from 'react';
import {
  loadMaplibre, webglAvailable, globeStyle, globeZoomFor, chainBounds, SPACE_COLOR,
  globeBasemapVisibility,
} from './globeCore.js';
import { HUB_COLOR, SPOKE_COLOR, CARGO_COLOR, DEFAULT_BASEMAP, SATELLITE_OCEAN } from './mapCore.js';
import { Glyph } from './Icons.jsx';
import {
  gameClockAt, formatGameClock, sunPosition, nightOverlayPixels, nightRefreshMs, NIGHT_COORDINATES,
} from './gameClock.js';
import { hubFinSize, tailAspect } from '../utils/hubFin.js';
import {
  planesGeoJSON, planeWeekHours, planeRate, planeRefreshMs, planePosition, planeTipHtml,
} from './flightsCore.js';

// ── Globe view of the Network map ─────────────────────────────────────────────
// Same data as the flat map (RouteMap builds it, globeCore turns it into
// GeoJSON), same hover / focus state (owned by RouteMap), same tooltip HTML.
// The camera moves for the same two reasons the flat map's does: first draw,
// and a change of focused route. Hover and weekly ticks only restyle.

// Line styles by state — the flat map's applyStyles numbers, so both views
// read the same: active / something-else-focused / normal.
const ROUTE = {
  main: { active: [4.5, 1],    dimmed: [1.8, 0.18], normal: [2.5, 0.85] },
  halo: { active: [18, 0.30],  dimmed: [7, 0.03],   normal: [9, 0.16] },
};

const isActive = ['boolean', ['feature-state', 'active'], false];
const byState = (spec, idx, anySel) =>
  ['case', isActive, spec.active[idx], anySel ? spec.dimmed[idx] : spec.normal[idx]];
// Line widths also carry each feature's `w` (globeCore: the width-by-passengers
// multiple, 1 when that toggle is off), so the globe matches the flat map.
const widthByState = (spec, anySel) => ['*', ['coalesce', ['get', 'w'], 1], byState(spec, 0, anySel)];

const INTERACTIVE = ['airports-hit', 'planes', 'routes-hit', 'cargo-line', 'partners-line', 'loyalty-ring'];

// ── Redraw only what changed ──────────────────────────────────────────────────
// RouteMap hands over a new `data` on every new game state — a week, but also
// every rival poll, which in a busy world is most of them. Each one used to
// re-send every source to MapLibre's worker (re-tiling hundreds of great-circle
// lines) and tear down and re-add an HTML label per airport, although a rival
// re-pricing somewhere else moves no line and no airport. Now a source is only
// re-sent when something it DRAWS changed, and the labels only when the set of
// airports did. Tooltips are the part that does change every time (the numbers
// in them), so they are read from an index rather than from the drawn features.
export const GLOBE_SOURCES = ['routes', 'cargo', 'partners', 'partnerStops', 'airports', 'loyalty'];
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

/** What a source draws: the collection without its tooltip HTML. */
export function globeSourceKey(fc) {
  return JSON.stringify(fc ?? EMPTY_FC, (k, v) => (k === 'tip' ? undefined : v));
}

/** Feature id → tooltip HTML, for one source. */
export function globeTipIndex(fc) {
  const m = new Map();
  for (const f of fc?.features ?? []) {
    const id = f.properties?.id;
    if (id != null && f.properties.tip) m.set(id, f.properties.tip);
  }
  return m;
}

/**
 * Send `data` to the map's GeoJSON sources — only the ones whose drawing
 * changed since `memo.drawn` (source id → key, updated in place). Returns the
 * tooltip index for every source, whether the routes source was re-sent, and
 * whether the airport labels need rebuilding (`memo.labelKey` updated).
 */
export function syncGlobeSources(map, data, memo) {
  const tips = {};
  let routesSent = false;
  for (const id of GLOBE_SOURCES) {
    const fc = data?.[id] ?? EMPTY_FC;
    tips[id] = globeTipIndex(fc);
    const key = globeSourceKey(fc);
    if (memo.drawn[id] === key) continue;   // nothing this source draws moved
    map.getSource(id)?.setData(fc);
    memo.drawn[id] = key;
    if (id === 'routes') routesSent = true;
  }
  const labelKey = globeLabelKey(data?.airports);
  const labelsChanged = labelKey !== memo.labelKey;
  memo.labelKey = labelKey;
  return { tips, routesSent, labelsChanged };
}

/** The airports the HTML code labels are built for: codes and positions. */
export function globeLabelKey(airportsFc) {
  return (airportsFc?.features ?? [])
    .map(f => `${f.properties?.code}@${f.geometry?.coordinates?.join(',')}`).join('|');
}

// ── Day / night and planes ────────────────────────────────────────────────────
// Night is a small canvas raster over the whole world (gameClock.js draws the
// pixels); planes are a symbol layer fed by flightsCore.js. Both are redrawn
// from one timer loop at a cadence set by how fast things
// actually move — a 1-week-a-day world redraws night every ~17 s.
export const NIGHT_SIZE = 256;
const PLANE_ICON = 'hw-plane';

/** A top-down airliner pointing north, 64 px square (shown at 32 css px:
 *  pixelRatio 2), in the airline's livery: body colour for the fuselage and
 *  wings, tail colour for the fin — the same two colours the livery editor
 *  paints, so the planes on your routes match your paint (DEFAULT_PLANE_COLORS
 *  is the pre-livery white). */
export const DEFAULT_PLANE_COLORS = { body: '#f4f8ff', fin: '#f4f8ff' };
function planeIcon(colors = DEFAULT_PLANE_COLORS) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const right = [[32, 3], [35, 9], [35, 24], [61, 38], [61, 43], [35, 36], [35, 50], [45, 57], [45, 60], [32, 56]];
  const left = right.slice(1, -1).reverse().map(([x, y]) => [64 - x, y]);
  ctx.beginPath();
  [...right, ...left].forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(2, 6, 18, 0.85)';
  ctx.stroke();
  ctx.fillStyle = colors.body;
  ctx.fill();
  // Tailplane in the fin colour: the rear sweep of the silhouette.
  ctx.beginPath();
  [[35, 50], [45, 57], [45, 60], [32, 56], [19, 60], [19, 57], [29, 50]].forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = colors.fin;
  ctx.fill();
  return ctx.getImageData(0, 0, 64, 64);
}

function addLayers(map, nightCanvas, planeColors) {
  // Night sits directly on the basemap, under every line and pin.
  try {
    map.addSource('night', { type: 'canvas', canvas: nightCanvas, coordinates: NIGHT_COORDINATES, animate: false });
    map.addLayer({ id: 'night', type: 'raster', source: 'night',
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } });
  } catch { /* no canvas sources in this build — the globe just has no night */ }

  const src = (id) => map.addSource(id, {
    type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id',
  });
  ['loyalty', 'partners', 'partnerStops', 'cargo', 'routes', 'airports'].forEach(src);
  map.addSource('planes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  const round = { 'line-cap': 'round', 'line-join': 'round' };

  // Loyalty layer: city circles under every line (loyaltyMapCore.js). A
  // shopping city's ring is drawn thinner and fainter — MapLibre circles have no
  // dash, so the flat map's dashed ring becomes a softer one here.
  map.addLayer({ id: 'loyalty-ring', type: 'circle', source: 'loyalty',
    paint: { 'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'fill'],
             'circle-opacity': ['get', 'fillOpacity'],
             'circle-stroke-color': ['get', 'stroke'],
             'circle-stroke-width': ['case', ['get', 'dashed'], 1.2, 2],
             'circle-stroke-opacity': ['case', ['get', 'dashed'], 0.55, 0.9],
             'circle-pitch-alignment': 'map' } });

  map.addLayer({ id: 'partners-line', type: 'line', source: 'partners', layout: round,
    paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.55, 'line-dasharray': [2, 2.4] } });
  map.addLayer({ id: 'partners-stops', type: 'circle', source: 'partnerStops',
    paint: { 'circle-radius': 3, 'circle-color': ['get', 'color'], 'circle-opacity': 0.7,
             'circle-pitch-alignment': 'map' } });

  map.addLayer({ id: 'cargo-glow', type: 'line', source: 'cargo', layout: round,
    paint: { 'line-color': CARGO_COLOR, 'line-width': 9, 'line-opacity': 0.14, 'line-blur': 4 } });
  map.addLayer({ id: 'cargo-line', type: 'line', source: 'cargo', layout: round,
    paint: { 'line-color': CARGO_COLOR, 'line-width': 2.5, 'line-opacity': 0.9 } });

  map.addLayer({ id: 'routes-glow', type: 'line', source: 'routes', layout: round,
    paint: { 'line-color': ['get', 'color'], 'line-blur': 5,
             'line-width': widthByState(ROUTE.halo, false), 'line-opacity': byState(ROUTE.halo, 1, false) } });
  map.addLayer({ id: 'routes-line', type: 'line', source: 'routes', layout: round,
    paint: { 'line-color': ['get', 'color'],
             'line-width': widthByState(ROUTE.main, false), 'line-opacity': byState(ROUTE.main, 1, false) } });
  // Wide invisible corridor — what the pointer hits, so a 2.5px line is easy
  // to hover (the flat map's "hit corridor", for the same reason).
  map.addLayer({ id: 'routes-hit', type: 'line', source: 'routes', layout: round,
    paint: { 'line-color': '#000', 'line-width': 18, 'line-opacity': 0 } });

  // Airports: spokes as a glow + dot, hubs gold and sized by tier.
  const spoke = ['!', ['get', 'hub']];
  map.addLayer({ id: 'airports-glow', type: 'circle', source: 'airports',
    paint: { 'circle-radius': ['case', spoke, 9, ['+', ['get', 'core'], 5]],
             'circle-color': ['case', spoke, SPOKE_COLOR, HUB_COLOR],
             'circle-opacity': ['case', spoke, 0.18, 0.28], 'circle-blur': 0.6,
             'circle-pitch-alignment': 'map' } });
  map.addLayer({ id: 'airports-dot', type: 'circle', source: 'airports',
    paint: { 'circle-radius': ['case', spoke, 5, ['/', ['get', 'core'], 1.6]],
             'circle-color': ['case', spoke, SPOKE_COLOR, HUB_COLOR],
             'circle-stroke-color': ['case', spoke, '#bfe0ff', '#fff3c4'],
             'circle-stroke-width': 1.5, 'circle-pitch-alignment': 'map' } });

  // Planes: a soft glow in the line's colour under a white airliner turned to
  // its heading and laid flat on the globe.
  if (!map.hasImage(PLANE_ICON)) map.addImage(PLANE_ICON, planeIcon(planeColors), { pixelRatio: 2 });
  map.addLayer({ id: 'planes-glow', type: 'circle', source: 'planes',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 6, 6, 12],
             'circle-color': ['get', 'color'], 'circle-blur': 1, 'circle-opacity': 0.55,
             'circle-pitch-alignment': 'map' } });
  map.addLayer({ id: 'planes', type: 'symbol', source: 'planes',
    layout: {
      'icon-image': PLANE_ICON,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.42, 3, 0.6, 6, 0.9],
      'icon-rotate': ['get', 'heading'],
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': 1 } });

  map.addLayer({ id: 'airports-hit', type: 'circle', source: 'airports',
    paint: { 'circle-radius': 9, 'circle-opacity': 0, 'circle-pitch-alignment': 'map' } });
}

/** The group a hit belongs to, when hovering / clicking it should focus a
 *  passenger line: the line itself, or a plane flying it. Cargo planes only
 *  show their tooltip. */
function focusGroupOf(f) {
  if (!f) return null;
  if (f.layer.id === 'routes-hit') return f.properties.id;
  if (f.layer.id === 'planes') {
    const g = f.properties.group;
    return g && !String(g).startsWith('cargo:') ? g : null;
  }
  return null;
}

export default function GlobeMap({
  data, height, home, selectedId, hoveredId, focusChain, onHover, onSelect, onFallback,
  // An airport focus: every route id it lights, the key the camera flies once
  // per, and the click that toggles it (an airport pin or its code label).
  focusIds = null, focusKey = undefined, onSelectAirport = null,
  flights = null, clock = null, planeColors = DEFAULT_PLANE_COLORS, basemap = DEFAULT_BASEMAP,
  hubFin = null,   // { key, load(), html(tier) } (utils/hubFin.js): your painted tail over each hub
  paused = false,
}) {
  const basemapRef = useRef(basemap);
  basemapRef.current = basemap;
  const nightCanvasRef = useRef(null);
  const planeColorsRef = useRef(planeColors);
  planeColorsRef.current = planeColors;
  const clockLabelRef = useRef(null);
  // Planes carry no tooltip HTML in their per-frame GeoJSON; hover looks the
  // plan up here and describes where it is at that moment.
  const planTipRef = useRef(() => '');
  const hoveredPlaneRef = useRef(null);
  planTipRef.current = (id) => {
    const plan = flights?.find(p => p.id === id);
    if (!plan) return '';
    const c = clock ? gameClockAt(Date.now(), clock) : null;
    return planeTipHtml(plan, planePosition(plan, planeWeekHours(Date.now(), c)));
  };
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const labelsRef = useRef([]);
  const finsRef = useRef([]);            // hub tail-fin markers
  const finKeyRef = useRef(null);        // hubs + fin look the fins were built for
  const activeRef = useRef(new Set());   // route ids carrying feature-state active
  const drawnRef = useRef({});           // source id → globeSourceKey last sent
  const labelKeyRef = useRef(null);      // globeLabelKey the labels were built for
  const tipsRef = useRef({});            // source id → globeTipIndex
  const nightAtRef = useRef({ key: null, at: -Infinity });  // when night was last drawn (survives a loop restart)
  const flownRef = useRef(null);
  const handlersRef = useRef({ onHover, onSelect, onSelectAirport });
  handlersRef.current = { onHover, onSelect, onSelectAirport };
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  // 1. Load MapLibre and build the map once.
  useEffect(() => {
    if (!webglAvailable()) { setError('This browser can\'t draw the 3D globe (WebGL is off).'); return; }
    let cancelled = false;
    loadMaplibre().then((maplibregl) => {
      if (cancelled || !elRef.current || mapRef.current) return;
      const map = new maplibregl.Map({
        container: elRef.current,
        style: globeStyle({ retina: (window.devicePixelRatio ?? 1) > 1, basemap: basemapRef.current }),
        center: [home?.lon ?? 10, Math.max(-50, Math.min(50, home?.lat ?? 20))],
        zoom: globeZoomFor(height),
        minZoom: 0,
        maxZoom: 10,
        maxPitch: 0,          // a globe you spin, not a tilted flight-sim camera
        dragRotate: false,
        // No symbol cross-fade. The planes are the only symbol layer and they
        // ignore placement, so the fade showed nothing — but each planes update
        // kept the globe repainting for the 300 ms fade after it.
        fadeDuration: 0,
        attributionControl: { compact: true },
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
      mapRef.current = map;
      popupRef.current = new maplibregl.Popup({
        closeButton: false, closeOnClick: false, className: 'globe-tip', maxWidth: 'none', offset: 14,
      });

      map.on('style.load', () => {
        // Some 5.x builds only honour the style's projection when set here.
        try { map.setProjection({ type: 'globe' }); } catch { /* older build */ }
      });
      map.on('load', () => {
        const nightCanvas = document.createElement('canvas');
        nightCanvas.width = nightCanvas.height = NIGHT_SIZE;
        nightCanvasRef.current = nightCanvas;
        addLayers(map, nightCanvas, planeColorsRef.current);
        let lastTip = null;
        const pick = (point) => {
          const layers = INTERACTIVE.filter(l => map.getLayer(l));
          const hits = map.queryRenderedFeatures(point, { layers });
          for (const l of INTERACTIVE) {
            const f = hits.find(h => h.layer.id === l);
            if (f) return f;
          }
          return null;
        };
        const show = (f, lngLat) => {
          // A hovered plane's tooltip follows it (effect 5 moves the popup).
          hoveredPlaneRef.current = f?.layer?.id === 'planes' ? f.properties.id : null;
          const tip = f?.layer?.id === 'planes' ? planTipRef.current(f.properties.id)
            : (tipsRef.current[f?.source]?.get(f?.properties?.id) ?? f?.properties?.tip);
          if (!tip) { popupRef.current.remove(); lastTip = null; return; }
          if (tip !== lastTip) { popupRef.current.setHTML(tip); lastTip = tip; }
          popupRef.current.setLngLat(lngLat);
          if (!popupRef.current.isOpen()) popupRef.current.addTo(map);
        };
        map.on('mousemove', (e) => {
          const f = pick(e.point);
          const group = focusGroupOf(f);
          map.getCanvas().style.cursor = group != null ? 'pointer' : '';
          handlersRef.current.onHover(group);
          show(f, e.lngLat);
        });
        map.getCanvas().addEventListener('mouseleave', () => {
          popupRef.current.remove(); lastTip = null; hoveredPlaneRef.current = null;
          handlersRef.current.onHover(null);
        });
        map.on('click', (e) => {
          const f = pick(e.point);
          const group = focusGroupOf(f);
          if (f?.layer?.id === 'airports-hit' && f.properties?.code && handlersRef.current.onSelectAirport) {
            handlersRef.current.onSelectAirport(f.properties.code);
            show(f, e.lngLat);
          } else if (group != null) {
            const id = group;
            handlersRef.current.onSelect(prev => (prev === id ? null : id));
            show(f, e.lngLat);   // a tap on a phone has no hover, so show it now
          } else {
            handlersRef.current.onSelect(null);
            show(f, e.lngLat);
          }
        });
        setLoaded(true);
      });
      map.on('error', (e) => {
        // Tile hiccups are routine; only a missing WebGL context is fatal.
        if (/webgl/i.test(String(e?.error?.message ?? ''))) setError(String(e.error.message));
      });
    }).catch(e => !cancelled && setError(e.message));

    return () => {
      cancelled = true;
      labelsRef.current.forEach(m => m.remove());
      labelsRef.current = [];
      finsRef.current.forEach(m => m.remove());
      finsRef.current = [];
      finKeyRef.current = null;
      popupRef.current?.remove();
      mapRef.current?.remove();
      mapRef.current = null;
      activeRef.current = new Set();
      drawnRef.current = {};
      labelKeyRef.current = null;
      flownRef.current = null;
    };
  // Built once per mount; height changes go through resize below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { mapRef.current?.resize(); }, [height]);

  // Satellite / Dark → flip which raster layer draws. The hidden source fetches
  // nothing, and the camera, lines and planes stay exactly where they are.
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    const vis = globeBasemapVisibility(basemap);
    try {
      for (const [id, v] of Object.entries(vis)) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
      map.setPaintProperty('ocean', 'background-color', vis.bluemarble === 'visible' ? SATELLITE_OCEAN : '#060b18');
    } catch { /* style not ready */ }
  }, [loaded, basemap]);

  // Livery change → repaint the plane sprite in place (no layer rebuild).
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map || !map.hasImage(PLANE_ICON)) return;
    try { map.updateImage(PLANE_ICON, planeIcon(planeColors)); } catch { /* style not ready */ }
  }, [loaded, planeColors?.body, planeColors?.fin]);

  // 2. Data → sources, plus HTML code labels (no glyph server needed).
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map || !data) return;
    const memo = { drawn: drawnRef.current, labelKey: labelKeyRef.current };
    const { tips, routesSent, labelsChanged } = syncGlobeSources(map, data, memo);
    labelKeyRef.current = memo.labelKey;
    tipsRef.current = tips;
    // Start feature-state from clean when the lines were re-sent; effect 3
    // re-applies it.
    if (routesSent) {
      map.removeFeatureState({ source: 'routes' });
      activeRef.current = new Set();
    }
    if (!labelsChanged) return;
    labelsRef.current.forEach(m => m.remove());
    labelsRef.current = data.airports.features.map(f => {
      const el = document.createElement('div');
      el.className = 'airport-label globe-label airport-label-click';
      el.innerHTML = `<span>${f.properties.code}</span>`;
      el.title = `Show every route at ${f.properties.code}`;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        handlersRef.current.onSelectAirport?.(f.properties.code);
      });
      return new window.maplibregl.Marker({
        element: el, anchor: 'left', offset: [8, 0], opacityWhenCovered: '0',
      }).setLngLat(f.geometry.coordinates).addTo(map);
    });
  }, [loaded, data]);

  // 2b. Your tail fin standing on each hub pin. HTML markers like the labels,
  // rebuilt only when the set of hubs (or their tiers) or the fin's look
  // changes — never on a poll that moved nothing. Click-through: the pin under
  // the fin keeps the hover and the click.
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map || !data) return;
    const hubsF = (data.airports?.features ?? []).filter(f => f.properties?.hub);
    const key = `${hubFin?.key ?? ''}|${hubsF.map(f => `${f.properties.code}@${f.properties.tier ?? ''}`).join(',')}`;
    if (key === finKeyRef.current) return;
    finKeyRef.current = key;
    let cancelled = false;
    (async () => {
      if (hubFin) await hubFin.load([...new Set(hubsF.map(f => Math.max(0, Math.min(3, f.properties.tier ?? 1))))]);
      if (cancelled || mapRef.current !== map) return;
      finsRef.current.forEach(m => m.remove());
      finsRef.current = !hubFin ? [] : hubsF.map(f => {
        const tier = Math.max(0, Math.min(3, f.properties.tier ?? 1));
        const html = hubFin.html(tier);
        if (!html) return null;
        const el = document.createElement('div');
        el.className = 'hub-fin-marker globe-fin';
        el.style.pointerEvents = 'none';
        el.innerHTML = html;
        return new window.maplibregl.Marker({
          element: el, anchor: 'bottom',
          // The base runs the full bottom; its centre stands on the pin.
          offset: [-Math.round(hubFinSize(tier) * tailAspect() * 0.16), -Math.round((f.properties.core ?? 11) / 2) - 1], opacityWhenCovered: '0',
        }).setLngLat(f.geometry.coordinates).addTo(map);
      }).filter(Boolean);
    })();
    return () => { cancelled = true; };
  }, [loaded, data, hubFin]);

  // 3. Hover / focus → feature-state and the dimming of everything else.
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    const lit = focusIds ?? [];
    const want = new Set([selectedId, hoveredId, ...lit].filter(v => v != null));
    for (const id of activeRef.current) if (!want.has(id)) map.setFeatureState({ source: 'routes', id }, { active: false });
    for (const id of want) map.setFeatureState({ source: 'routes', id }, { active: true });
    activeRef.current = want;

    const anySel = selectedId != null || lit.length > 0;
    map.setPaintProperty('routes-line', 'line-width',   widthByState(ROUTE.main, anySel));
    map.setPaintProperty('routes-line', 'line-opacity', byState(ROUTE.main, 1, anySel));
    map.setPaintProperty('routes-glow', 'line-width',   widthByState(ROUTE.halo, anySel));
    map.setPaintProperty('routes-glow', 'line-opacity', byState(ROUTE.halo, 1, anySel));
    map.setPaintProperty('cargo-line',  'line-opacity', anySel ? 0.27 : 0.9);
    map.setPaintProperty('cargo-glow',  'line-opacity', anySel ? 0.04 : 0.14);
    map.setPaintProperty('partners-line', 'line-opacity', anySel ? 0.14 : 0.55);
    const onFocus = lit.length
      ? ['in', ['get', 'group'], ['literal', lit]]
      : ['==', ['get', 'group'], selectedId ?? ''];
    map.setPaintProperty('planes', 'icon-opacity', anySel ? ['case', onFocus, 1, 0.3] : 1);
    map.setPaintProperty('planes-glow', 'circle-opacity', anySel ? ['case', onFocus, 0.7, 0.08] : 0.55);
  }, [loaded, data, selectedId, hoveredId, focusIds]);

  // 5. Day / night and the planes — one animation loop, each redrawn only as
  //    often as it visibly moves. rAF stops by itself in a background tab.
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    // Covered by a page in map view: planes and night hold where they are.
    if (paused) return undefined;
    const reduce = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const nightSrc = map.getSource('night');
    const planesSrc = map.getSource('planes');
    const hasNight = !!(clock && nightSrc && map.getLayer('night'));
    if (map.getLayer('night')) map.setLayoutProperty('night', 'visibility', hasNight ? 'visible' : 'none');
    if (!flights?.length) planesSrc?.setData({ type: 'FeatureCollection', features: [] });
    // Nothing to animate (solo game with planes off): no loop at all.
    if (!clock && !flights?.length) {
      if (clockLabelRef.current) clockLabelRef.current.style.display = 'none';
      return undefined;
    }

    const drawNight = (sun) => {
      const cv = nightCanvasRef.current;
      const ctx = cv?.getContext('2d');
      if (!ctx) return;
      ctx.putImageData(new ImageData(nightOverlayPixels(sun, cv.width, cv.height), cv.width, cv.height), 0, 0);
      // A static canvas source uploads only while "playing"; pause() uploads
      // once and stops, so this is one texture update per redraw.
      nightSrc.play();
      nightSrc.pause();
    };

    // Wake only when something is due (night every 5–30 s, planes about once
    // a second for a big fleet), not every frame — battery on phones, and the
    // fan on a laptop with the globe parked in a tab.
    //
    // The loop restarts whenever `flights` is rebuilt — which is every new game
    // state, rival polls included — so when night was last drawn lives in a
    // ref: a restart redraws the planes at once but leaves night until it is due.
    let timer = 0, lastPlanes = -Infinity, lastLabel = -Infinity;
    const nightKey = `${clock?.week}|${clock?.nextTickAt}|${clock?.weeksPerDay}`;
    if (nightAtRef.current.key !== nightKey) nightAtRef.current = { key: nightKey, at: -Infinity };
    const planeCount = flights?.length ?? 0;
    const frame = () => {
      // A background tab (or a minimised window) draws nothing — and MapLibre's
      // worker re-tiles nothing. The visibility handler below picks up again.
      if (typeof document !== 'undefined' && document.hidden) { timer = 0; return; }
      const now = Date.now();
      const c = clock ? gameClockAt(now, clock) : null;
      const nightEvery = reduce ? 60_000 : (c ? nightRefreshMs(c.rate) : Infinity);
      const planesEvery = reduce ? 30_000 : planeRefreshMs(planeRate(c?.rate), map.getZoom(), undefined, planeCount);
      const lastNight = nightAtRef.current.at;
      if (hasNight && c && now - lastNight >= nightEvery) {
        nightAtRef.current = { key: nightKey, at: now };
        drawNight(sunPosition(clock.week, c.weekHours));
      }
      if (planesSrc && flights?.length && now - lastPlanes >= planesEvery) {
        lastPlanes = now;
        const h = planeWeekHours(now, c);
        planesSrc.setData(planesGeoJSON(flights, h, { tips: false }));
        const id = hoveredPlaneRef.current;
        const popup = popupRef.current;
        if (id && popup?.isOpen()) {
          const plan = flights.find(p => p.id === id);
          const pos = plan && planePosition(plan, h);
          if (pos) popup.setLngLat([pos.lon, pos.lat]).setHTML(planeTipHtml(plan, pos));
          else { popup.remove(); hoveredPlaneRef.current = null; }   // it landed
        }
      }
      if (clockLabelRef.current && now - lastLabel >= 1000) {
        lastLabel = now;
        clockLabelRef.current.textContent = c ? `${formatGameClock(c)} UTC` : '';
        clockLabelRef.current.style.display = c ? '' : 'none';
      }
      const due = Math.min(
        hasNight && c ? nightAtRef.current.at + nightEvery : Infinity,
        flights?.length ? lastPlanes + planesEvery : Infinity,
        lastLabel + 1000,
      ) - Date.now();
      timer = setTimeout(frame, Math.max(16, Math.min(due, 60_000)));
    };
    frame();
    // Zooming changes how often planes need redrawing — re-plan straight away.
    const onZoom = () => { clearTimeout(timer); frame(); };
    map.on('zoomend', onZoom);
    const onVisible = () => { if (!document.hidden) { clearTimeout(timer); frame(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      map.off('zoomend', onZoom);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loaded, flights, clock, paused]);

  // 4. Fly to a newly focused route — once per focus, like the flat map.
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    const key = focusKey !== undefined ? focusKey : selectedId;
    if (key == null) { flownRef.current = null; return; }
    if (flownRef.current === key || !focusChain?.length) return;
    flownRef.current = key;
    try {
      if (focusChain.length === 1) {
        map.easeTo({ center: [focusChain[0].lon, focusChain[0].lat], duration: 900 });
      } else {
        const b = chainBounds(focusChain.map(a => [a.lat, a.lon]));
        if (b) map.fitBounds(b, { padding: 90, maxZoom: 6, duration: 900 });
      }
    } catch { /* a camera move is never worth the page */ }
  }, [loaded, selectedId, focusKey, focusChain]);

  if (error) {
    return (
      <div style={{ height, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', justifyContent: 'center', background: SPACE_COLOR, color: 'var(--text-muted)', fontSize: 13 }}>
        <span><Glyph e="⚠" /> {error}</span>
        {onFallback && <button className="map-clear-btn" onClick={onFallback}>Back to the flat map</button>}
      </div>
    );
  }
  return (
    <div style={{ position: 'relative', height, background: SPACE_COLOR }}>
      <div ref={elRef} style={{ position: 'absolute', inset: 0 }} />
      {/* Game time, so the day/night line reads as "now" (filled by effect 5). */}
      <div
        ref={clockLabelRef}
        className="globe-clock"
        title="Game time (UTC). Night falls where the sun has set — the simulation still runs in whole weeks. In very fast worlds the planes are slowed so they don't race."
        style={{ display: 'none' }}
      />
      {!loaded && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13, pointerEvents: 'none' }}>
          Loading globe…
        </div>
      )}
    </div>
  );
}
