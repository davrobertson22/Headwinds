import { useEffect, useRef, useState } from 'react';
import {
  loadMaplibre, webglAvailable, globeStyle, globeZoomFor, chainBounds, SPACE_COLOR,
} from './globeCore.js';
import { HUB_COLOR, SPOKE_COLOR, CARGO_COLOR } from './mapCore.js';
import { Glyph } from './Icons.jsx';

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

const INTERACTIVE = ['airports-hit', 'routes-hit', 'cargo-line', 'partners-line'];

function addLayers(map) {
  const src = (id) => map.addSource(id, {
    type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id',
  });
  ['partners', 'partnerStops', 'cargo', 'routes', 'airports'].forEach(src);

  const round = { 'line-cap': 'round', 'line-join': 'round' };

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
             'line-width': byState(ROUTE.halo, 0, false), 'line-opacity': byState(ROUTE.halo, 1, false) } });
  map.addLayer({ id: 'routes-line', type: 'line', source: 'routes', layout: round,
    paint: { 'line-color': ['get', 'color'],
             'line-width': byState(ROUTE.main, 0, false), 'line-opacity': byState(ROUTE.main, 1, false) } });
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
  map.addLayer({ id: 'airports-hit', type: 'circle', source: 'airports',
    paint: { 'circle-radius': 9, 'circle-opacity': 0, 'circle-pitch-alignment': 'map' } });
}

export default function GlobeMap({
  data, height, home, selectedId, hoveredId, focusChain, onHover, onSelect, onFallback,
}) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const labelsRef = useRef([]);
  const activeRef = useRef(new Set());   // route ids carrying feature-state active
  const flownRef = useRef(null);
  const handlersRef = useRef({ onHover, onSelect });
  handlersRef.current = { onHover, onSelect };
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
        style: globeStyle({ retina: (window.devicePixelRatio ?? 1) > 1 }),
        center: [home?.lon ?? 10, Math.max(-50, Math.min(50, home?.lat ?? 20))],
        zoom: globeZoomFor(height),
        minZoom: 0,
        maxZoom: 10,
        maxPitch: 0,          // a globe you spin, not a tilted flight-sim camera
        dragRotate: false,
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
        addLayers(map);
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
          const tip = f?.properties?.tip;
          if (!tip) { popupRef.current.remove(); lastTip = null; return; }
          if (tip !== lastTip) { popupRef.current.setHTML(tip); lastTip = tip; }
          popupRef.current.setLngLat(lngLat);
          if (!popupRef.current.isOpen()) popupRef.current.addTo(map);
        };
        map.on('mousemove', (e) => {
          const f = pick(e.point);
          map.getCanvas().style.cursor = f && f.layer.id === 'routes-hit' ? 'pointer' : '';
          handlersRef.current.onHover(f?.layer.id === 'routes-hit' ? f.properties.id : null);
          show(f, e.lngLat);
        });
        map.getCanvas().addEventListener('mouseleave', () => {
          popupRef.current.remove(); lastTip = null;
          handlersRef.current.onHover(null);
        });
        map.on('click', (e) => {
          const f = pick(e.point);
          if (f?.layer.id === 'routes-hit') {
            const id = f.properties.id;
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
      popupRef.current?.remove();
      mapRef.current?.remove();
      mapRef.current = null;
      activeRef.current = new Set();
      flownRef.current = null;
    };
  // Built once per mount; height changes go through resize below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { mapRef.current?.resize(); }, [height]);

  // 2. Data → sources, plus HTML code labels (no glyph server needed).
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map || !data) return;
    for (const id of ['routes', 'cargo', 'partners', 'partnerStops', 'airports']) {
      map.getSource(id)?.setData(data[id]);
    }
    // Start feature-state from clean on every rebuild; effect 3 re-applies it.
    map.removeFeatureState({ source: 'routes' });
    activeRef.current = new Set();

    labelsRef.current.forEach(m => m.remove());
    labelsRef.current = data.airports.features.map(f => {
      const el = document.createElement('div');
      el.className = 'airport-label globe-label';
      el.innerHTML = `<span>${f.properties.code}</span>`;
      return new window.maplibregl.Marker({
        element: el, anchor: 'left', offset: [8, 0], opacityWhenCovered: '0',
      }).setLngLat(f.geometry.coordinates).addTo(map);
    });
  }, [loaded, data]);

  // 3. Hover / focus → feature-state and the dimming of everything else.
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    const want = new Set([selectedId, hoveredId].filter(v => v != null));
    for (const id of activeRef.current) if (!want.has(id)) map.setFeatureState({ source: 'routes', id }, { active: false });
    for (const id of want) map.setFeatureState({ source: 'routes', id }, { active: true });
    activeRef.current = want;

    const anySel = selectedId != null;
    map.setPaintProperty('routes-line', 'line-width',   byState(ROUTE.main, 0, anySel));
    map.setPaintProperty('routes-line', 'line-opacity', byState(ROUTE.main, 1, anySel));
    map.setPaintProperty('routes-glow', 'line-width',   byState(ROUTE.halo, 0, anySel));
    map.setPaintProperty('routes-glow', 'line-opacity', byState(ROUTE.halo, 1, anySel));
    map.setPaintProperty('cargo-line',  'line-opacity', anySel ? 0.27 : 0.9);
    map.setPaintProperty('cargo-glow',  'line-opacity', anySel ? 0.04 : 0.14);
    map.setPaintProperty('partners-line', 'line-opacity', anySel ? 0.14 : 0.55);
  }, [loaded, data, selectedId, hoveredId]);

  // 4. Fly to a newly focused route — once per focus, like the flat map.
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    if (selectedId == null) { flownRef.current = null; return; }
    if (flownRef.current === selectedId || !focusChain?.length) return;
    flownRef.current = selectedId;
    const b = chainBounds(focusChain.map(a => [a.lat, a.lon]));
    if (b) map.fitBounds(b, { padding: 90, maxZoom: 6, duration: 900 });
  }, [loaded, selectedId, focusChain]);

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
      {!loaded && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13, pointerEvents: 'none' }}>
          Loading globe…
        </div>
      )}
    </div>
  );
}
