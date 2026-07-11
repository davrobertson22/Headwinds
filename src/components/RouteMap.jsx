import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { getAirport } from '../data/airports.js';
import { simulateRoute, simulateCargoRoute, formatMoney, currentGameDate } from '../utils/simulation.js';
import { getAlliance } from '../data/alliances.js';
import { Glyph } from './Icons.jsx';
import useIsMobile from '../hooks/useIsMobile.js';

// ── Great-circle path as a single continuous segment ─────────────────────────
// Keeps longitudes unwrapped (may exceed ±180) so Leaflet draws one smooth arc
// across world copies instead of splitting at the antimeridian edge.
function segmentsForRoute(lat1, lon1, lat2, lon2, n = 80) {
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

// ── Great-circle interpolation ────────────────────────────────────────────────
function greatCirclePoints(lat1, lon1, lat2, lon2, n = 80) {
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

// ── Leaflet CDN loader ────────────────────────────────────────────────────────
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

function loadLeaflet() {
  return new Promise((resolve, reject) => {
    if (window.L) { resolve(window.L); return; }

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
    script.onerror = () => reject(new Error('Failed to load Leaflet'));
    document.head.appendChild(script);
  });
}

// ── Palette ────────────────────────────────────────────────────────────────────
const PROFIT_COLOR    = '#2ee6a0';  // bright teal-green
const LOSS_COLOR      = '#ff5d6c';  // bright coral-red
const HUB_COLOR       = '#ffcf4d';  // gold
const SPOKE_COLOR     = '#4da6ff';  // sky blue
const ALLIANCE_COLOR  = '#b794ff';  // purple for alliance members
const CODESHARE_COLOR = '#38e1ff';  // cyan for codeshare partners
const CARGO_COLOR     = '#e8833a';  // amber for cargo / freight routes

// ── Component ─────────────────────────────────────────────────────────────────
export default function RouteMap() {
  const { state } = useGame();
  const { fleet, routes, cargoRoutes = [], hub, competitors = [], allianceMembership, codeshareAgreements = [] } = state;

  // The map has a fixed inline height that a CSS media query can't reach, so we
  // size it here. Shorter on phones so the route list below is reachable without
  // a long scroll; unchanged (520) on desktop.
  const isMobile = useIsMobile();
  const mapHeight = isMobile ? 380 : 520;

  const mapElRef      = useRef(null);   // DOM node
  const mapRef        = useRef(null);   // Leaflet map instance
  const layersRef     = useRef([]);     // Active Leaflet layers (routes + markers)
  const lineGroupsRef = useRef(new Map()); // routeId -> { halo:[], main:[], color }
  const partnerLayersRef = useRef([]);  // Partner overlay layers (separate so we can toggle)
  const [ready, setReady]       = useState(!!window.L);
  const [mapReady, setMapReady] = useState(false);   // true once L.map() is done
  const [error, setError]       = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [showAlliance,  setShowAlliance]  = useState(true);
  const [showCodeshare, setShowCodeshare] = useState(true);
  const [showCargo,     setShowCargo]     = useState(true);
  const cargoLayersRef = useRef([]);   // amber cargo route overlay layers

  // Keep refs of current interaction state so the (rarely-rebuilt) layer effect
  // can apply correct styling without being a dependency.
  const selectedIdRef = useRef(null);
  const hoveredIdRef  = useRef(null);

  // 1. Load Leaflet from CDN
  useEffect(() => {
    if (window.L) { setReady(true); return; }
    loadLeaflet()
      .then(() => setReady(true))
      .catch(e => setError(e.message));
  }, []);

  // 2. Init map once Leaflet + DOM element are ready
  useEffect(() => {
    if (!ready || !mapElRef.current || mapRef.current) return;
    const L = window.L;

    const map = L.map(mapElRef.current, {
      center: [20, 10],
      zoom: 2,
      minZoom: 1,
      maxZoom: 10,
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // CartoDB Dark Matter — proper dark game-map feel
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map);

    // Click empty map → deselect
    map.on('click', () => setSelectedId(null));

    mapRef.current = map;
    setMapReady(true);   // ← signals the layers effect to run

    // Cleanup on unmount
    return () => {
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [ready]);

  // Leaflet caches the container size, so when the height changes (e.g. crossing
  // the mobile breakpoint or rotating the device) we must tell it to remeasure,
  // otherwise tiles render into the old dimensions.
  useEffect(() => {
    if (mapRef.current) mapRef.current.invalidateSize();
  }, [mapHeight]);

  // 3. Derive route data
  const gd = currentGameDate(state);
  const routeData = useMemo(() => routes.map(r => {
    const origin   = getAirport(r.origin);
    const dest     = getAirport(r.destination);
    if (!origin || !dest) return null;
    const aircraft = fleet.find(a => a.id === r.aircraftId);
    const result   = aircraft ? simulateRoute(r, aircraft, gd) : null;
    return { r, origin, dest, result };
  }).filter(Boolean), [routes, fleet, state.week]);

  // Cargo route data (mirrors routeData but for freighters / cargo routes)
  const cargoRouteData = useMemo(() => cargoRoutes.map(r => {
    const origin   = getAirport(r.origin);
    const dest     = getAirport(r.destination);
    if (!origin || !dest) return null;
    const aircraft = fleet.find(a => a.id === r.aircraftId);
    const result   = aircraft ? simulateCargoRoute(r, aircraft, gd) : null;
    return { r, origin, dest, result };
  }).filter(Boolean), [cargoRoutes, fleet, state.week]);

  const airportSet = useMemo(() => {
    const codes = new Set([
      hub,
      ...routeData.flatMap(d => [d.origin.code, d.dest.code]),
      ...cargoRouteData.flatMap(d => [d.origin.code, d.dest.code]),
    ]);
    return [...codes].map(getAirport).filter(Boolean);
  }, [routeData, cargoRouteData, hub]);

  // Group route entries by city pair (direction-agnostic) so multiple aircraft
  // on the same JFK↔ORD pair show as ONE line + ONE row with aggregated stats.
  const routeGroups = useMemo(() => {
    const map = new Map();
    for (const d of routeData) {
      const key = [d.origin.code, d.dest.code].sort().join('~');
      let g = map.get(key);
      if (!g) {
        g = {
          key, origin: d.origin, dest: d.dest, members: [],
          profit: 0, revenue: 0, passengers: 0, seats: 0, distance: 0,
        };
        map.set(key, g);
      }
      g.members.push(d);
      if (d.result) {
        g.profit     += d.result.profit;
        g.revenue    += d.result.revenue;
        g.passengers += d.result.passengers;
        g.seats      += d.result.loadFactor > 0 ? d.result.passengers / d.result.loadFactor : 0;
        g.distance    = d.result.distance;
      }
    }
    const arr = [...map.values()];
    for (const g of arr) {
      g.loadFactor   = g.seats > 0 ? g.passengers / g.seats : 0;
      g.aircraftCount = g.members.length;
      g.hasResult    = g.members.some(m => m.result);
    }
    return arr;
  }, [routeData]);

  // Group cargo route entries by city pair (aggregate tonnes / profit / capacity).
  const cargoGroups = useMemo(() => {
    const map = new Map();
    for (const d of cargoRouteData) {
      const key = [d.origin.code, d.dest.code].sort().join('~');
      let g = map.get(key);
      if (!g) {
        g = { key, origin: d.origin, dest: d.dest, members: [], profit: 0, revenue: 0, tonnes: 0, capacity: 0, distance: 0 };
        map.set(key, g);
      }
      g.members.push(d);
      if (d.result) {
        g.profit   += d.result.profit;
        g.revenue  += d.result.revenue;
        g.tonnes   += d.result.tonnes;
        g.capacity += d.result.capacityTonnes;
        g.distance  = d.result.distance;
      }
    }
    const arr = [...map.values()];
    for (const g of arr) {
      g.loadFactor    = g.capacity > 0 ? g.tonnes / g.capacity : 0;
      g.aircraftCount = g.members.length;
      g.hasResult     = g.members.some(m => m.result);
    }
    return arr;
  }, [cargoRouteData]);

  // ── Style resolver: highlight selected/hovered, dim the rest ─────────────────
  const applyStyles = useCallback(() => {
    const selId = selectedIdRef.current;
    const hovId = hoveredIdRef.current;
    const anySel = selId != null;

    lineGroupsRef.current.forEach((group, id) => {
      const active = id === selId || id === hovId;
      let mainW, mainO, haloW, haloO;
      if (active)       { mainW = 4.5; mainO = 1;    haloW = 18; haloO = 0.30; }
      else if (anySel)  { mainW = 1.8; mainO = 0.18; haloW = 7;  haloO = 0.03; }
      else              { mainW = 2.5; mainO = 0.85; haloW = 9;  haloO = 0.16; }

      group.halo.forEach(l => l.setStyle({ weight: haloW, opacity: haloO }));
      group.main.forEach(l => {
        l.setStyle({
          weight: mainW,
          opacity: mainO,
          dashArray: active ? '10 16' : null,
        });
        const el = l.getElement && l.getElement();
        if (el) el.classList.toggle('flowing', active);
      });
    });
  }, []);

  // 4a. Derive partner route data (alliance members + codeshare partners)
  const currentAlliance = allianceMembership ? getAlliance(allianceMembership.allianceId) : null;

  const partnerRouteData = useMemo(() => {
    const allianceMemberIds   = new Set(currentAlliance?.memberIds ?? []);
    const codesharePartnerIds = new Set(codeshareAgreements.map(a => a.competitorId));
    const result = [];
    for (const comp of competitors) {
      const isAllianceMember   = allianceMemberIds.has(comp.id);
      const isCodesharePartner = codesharePartnerIds.has(comp.id);
      if (!isAllianceMember && !isCodesharePartner) continue;
      const type  = isAllianceMember ? 'alliance' : 'codeshare';
      const color = isAllianceMember ? ALLIANCE_COLOR : CODESHARE_COLOR;
      for (const routeKey of Object.keys(comp.routes ?? {})) {
        const [a, b] = routeKey.split('-');
        const origin = getAirport(a);
        const dest   = getAirport(b);
        if (!origin || !dest) continue;
        result.push({ comp, type, color, origin, dest, routeKey });
      }
    }
    return result;
  }, [competitors, allianceMembership, codeshareAgreements, currentAlliance]);

  // 4b. Sync partner overlay layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    const dim = selectedId != null ? 0.25 : 1;   // fade partners when focusing a route

    // Clear previous partner layers
    partnerLayersRef.current.forEach(l => map.removeLayer(l));
    partnerLayersRef.current = [];

    for (const { comp, type, color, origin, dest } of partnerRouteData) {
      const show = type === 'alliance' ? showAlliance : showCodeshare;
      if (!show) continue;

      const segments = segmentsForRoute(origin.lat, origin.lon, dest.lat, dest.lon);
      const tipHtml = `
        <div class="map-tip">
          <div class="map-tip-title" style="color:${color}">${origin.code} → ${dest.code}</div>
          <div class="map-tip-sub">${origin.city} → ${dest.city}</div>
          <div class="map-tip-sub" style="margin-top:4px">${comp.name} · ${type === 'alliance' ? 'Alliance' : 'Codeshare'}</div>
        </div>
      `;

      for (const pts of segments) {
        const line = L.polyline(pts, {
          color,
          weight: 1.5,
          opacity: 0.55 * dim,
          dashArray: '5, 6',
          smoothFactor: 1,
        });
        line.bindTooltip(tipHtml, { sticky: true, className: 'game-tooltip', offset: [15, 0] });
        line.on('mouseover', () => line.setStyle({ opacity: 0.9, weight: 2.5 }));
        line.on('mouseout',  () => line.setStyle({ opacity: 0.55 * dim, weight: 1.5 }));
        line.addTo(map);
        partnerLayersRef.current.push(line);
      }

      // Small dot at each endpoint (only if not already in our own airportSet)
      for (const airport of [origin, dest]) {
        const dot = L.circleMarker([airport.lat, airport.lon], {
          radius: 3,
          fillColor: color,
          color: color,
          weight: 1,
          fillOpacity: 0.7 * dim,
          interactive: false,
        });
        dot.addTo(map);
        partnerLayersRef.current.push(dot);
      }
    }
  }, [partnerRouteData, showAlliance, showCodeshare, selectedId, mapReady]);

  // 4c. Sync cargo route overlay (amber, distinct from green/red passenger lines)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    const dim = selectedId != null ? 0.3 : 1;   // fade cargo when focusing a passenger route

    cargoLayersRef.current.forEach(l => map.removeLayer(l));
    cargoLayersRef.current = [];
    if (!showCargo) return;

    for (const g of cargoGroups) {
      const { origin, dest } = g;
      const segments = segmentsForRoute(origin.lat, origin.lon, dest.lat, dest.lon);
      const lf      = g.hasResult ? `${(g.loadFactor * 100).toFixed(0)}%` : '—';
      const tonnes  = g.hasResult ? `${Math.round(g.tonnes).toLocaleString()} t` : '—';
      const profit  = g.hasResult ? g.profit : 0;
      const profStr = g.hasResult ? `${profit >= 0 ? '+' : ''}${formatMoney(profit)}/wk` : '—';
      const rev     = g.hasResult ? `+${formatMoney(g.revenue)}` : '—';
      const tipHtml = `
        <div class="map-tip">
          <div class="map-tip-title" style="color:${CARGO_COLOR}">${origin.code} <span class="map-tip-arrow">→</span> ${dest.code}</div>
          <div class="map-tip-sub">${origin.city} → ${dest.city} · ${g.aircraftCount} freighter${g.aircraftCount !== 1 ? 's' : ''}</div>
          <div class="map-tip-stats">
            <div><span class="map-tip-lbl">Tonnes/wk</span><span class="map-tip-val" style="color:${CARGO_COLOR}">${tonnes}</span></div>
            <div><span class="map-tip-lbl">Load</span><span class="map-tip-val">${lf}</span></div>
            <div><span class="map-tip-lbl">Revenue</span><span class="map-tip-val" style="color:${PROFIT_COLOR}">${rev}</span></div>
            <div><span class="map-tip-lbl">Profit</span><span class="map-tip-val">${profStr}</span></div>
          </div>
        </div>
      `;

      for (const pts of segments) {
        const glow = L.polyline(pts, {
          color: CARGO_COLOR, weight: 9, opacity: 0.14 * dim,
          lineCap: 'round', smoothFactor: 1, interactive: false, className: 'route-glow',
        });
        glow.addTo(map);
        cargoLayersRef.current.push(glow);

        const line = L.polyline(pts, {
          color: CARGO_COLOR, weight: 2.5, opacity: 0.9 * dim,
          lineCap: 'round', smoothFactor: 1,
        });
        line.bindTooltip(tipHtml, { sticky: true, className: 'game-tooltip', offset: [15, 0] });
        line.on('mouseover', () => line.setStyle({ weight: 4, opacity: 1 }));
        line.on('mouseout',  () => line.setStyle({ weight: 2.5, opacity: 0.9 * dim }));
        line.addTo(map);
        cargoLayersRef.current.push(line);
      }
    }
  }, [cargoGroups, showCargo, selectedId, mapReady]);

  // 4. Sync routes + markers to map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;

    // Clear previous layers
    layersRef.current.forEach(l => map.removeLayer(l));
    layersRef.current = [];
    lineGroupsRef.current = new Map();

    // Route polylines (glow halo underneath + crisp main line on top).
    // One line per city pair — all aircraft on the pair are aggregated into the group.
    for (const g of routeGroups) {
      const { origin, dest } = g;
      const profit   = g.hasResult ? g.profit : 0;
      const color    = profit >= 0 ? PROFIT_COLOR : LOSS_COLOR;
      const segments = segmentsForRoute(origin.lat, origin.lon, dest.lat, dest.lon);

      const lf      = g.hasResult ? `${(g.loadFactor * 100).toFixed(0)}%` : '—';
      const pax     = g.hasResult ? Math.round(g.passengers).toLocaleString() : '—';
      const profStr = g.hasResult ? `<span style="color:${color}">${profit >= 0 ? '+' : ''}${formatMoney(profit)}/wk</span>` : '—';
      const rev     = g.hasResult ? `+${formatMoney(g.revenue)}` : '—';
      const acText  = `${g.aircraftCount} aircraft`;
      const tipHtml = `
        <div class="map-tip">
          <div class="map-tip-title">${origin.code} <span class="map-tip-arrow">→</span> ${dest.code}</div>
          <div class="map-tip-sub">${origin.city} → ${dest.city} · ${acText}</div>
          <div class="map-tip-stats">
            <div><span class="map-tip-lbl">Load</span><span class="map-tip-val">${lf}</span></div>
            <div><span class="map-tip-lbl">Pax/wk</span><span class="map-tip-val">${pax}</span></div>
            <div><span class="map-tip-lbl">Revenue</span><span class="map-tip-val" style="color:${PROFIT_COLOR}">${rev}</span></div>
            <div><span class="map-tip-lbl">Profit</span><span class="map-tip-val">${profStr}</span></div>
          </div>
          <div class="map-tip-hint">Click to focus this route</div>
        </div>
      `;

      const halo = [];
      const main = [];

      for (const pts of segments) {
        // Glow halo (non-interactive, sits beneath the main line)
        const glow = L.polyline(pts, {
          color,
          weight: 9,
          opacity: 0.16,
          lineCap: 'round',
          smoothFactor: 1,
          interactive: false,
          className: 'route-glow',
        });
        glow.addTo(map);
        halo.push(glow);
        layersRef.current.push(glow);

        // Crisp main line — VISUAL ONLY. It is non-interactive, so the dashed
        // style and extra width it takes on hover can never punch gaps in the
        // mouse hit-region. (Those dash gaps were what made the tooltip rapidly
        // flash on and off as the cursor sat over the line.)
        const line = L.polyline(pts, {
          color,
          weight: 2.5,
          opacity: 0.85,
          lineCap: 'round',
          smoothFactor: 1,
          interactive: false,
          className: 'route-line',
        });
        line.addTo(map);
        main.push(line);
        layersRef.current.push(line);

        // Invisible, always-solid "hit corridor" sitting on top of the visible
        // line. This — not the styled line — is what the mouse interacts with.
        // Its geometry and width never change, so hover stays rock-steady and
        // the tooltip stops flickering while you hover a route.
        const hit = L.polyline(pts, {
          color: '#000',
          weight: 22,
          opacity: 0,
          lineCap: 'round',
          smoothFactor: 1,
          interactive: true,
          bubblingMouseEvents: false,
          className: 'route-hit',
        });
        hit.bindTooltip(tipHtml, { sticky: true, className: 'game-tooltip', offset: [15, 0] });
        hit.on('mouseover', () => { setHoveredId(g.key); });
        hit.on('mouseout',  () => { setHoveredId(null); });
        hit.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          setSelectedId(prev => (prev === g.key ? null : g.key));
        });
        hit.addTo(map);
        layersRef.current.push(hit);
      }

      lineGroupsRef.current.set(g.key, { halo, main, color });
    }

    // Airport markers
    for (const airport of airportSet) {
      const isHub = airport.code === hub;

      if (isHub) {
        // Pulsing hub marker (animated CSS divIcon)
        const hubMarker = L.marker([airport.lat, airport.lon], {
          icon: L.divIcon({
            className: 'hub-marker',
            html: '<span class="hub-pulse-ring"></span><span class="hub-pulse-core"></span>',
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
          zIndexOffset: 1000,
        });
        hubMarker.bindTooltip(
          `<div class="map-tip"><div class="map-tip-title">${airport.code}</div><div class="map-tip-sub">${airport.city}, ${airport.country} <span style="color:${HUB_COLOR}">● HUB</span></div></div>`,
          { className: 'game-tooltip', offset: [12, 0] },
        );
        hubMarker.addTo(map);
        layersRef.current.push(hubMarker);
      } else {
        // Glow halo behind spoke airport
        const halo = L.circleMarker([airport.lat, airport.lon], {
          radius: 9,
          fillColor: SPOKE_COLOR,
          color: SPOKE_COLOR,
          weight: 0,
          fillOpacity: 0.18,
          interactive: false,
        });
        halo.addTo(map);
        layersRef.current.push(halo);

        const marker = L.circleMarker([airport.lat, airport.lon], {
          radius: 5,
          fillColor: SPOKE_COLOR,
          color: '#bfe0ff',
          weight: 1.5,
          fillOpacity: 1,
        });
        marker.bindTooltip(
          `<div class="map-tip"><div class="map-tip-title">${airport.code}</div><div class="map-tip-sub">${airport.city}, ${airport.country}</div></div>`,
          { className: 'game-tooltip', offset: [10, 0] },
        );
        marker.addTo(map);
        layersRef.current.push(marker);
      }

      // Code label (not shown at low zoom — Leaflet handles that via zoom)
      const label = L.marker([airport.lat, airport.lon], {
        icon: L.divIcon({
          className: 'airport-label',
          html: `<span>${airport.code}</span>`,
          iconAnchor: [-10, 4],
        }),
        interactive: false,
        zIndexOffset: 500,
      });
      label.addTo(map);
      layersRef.current.push(label);
    }

    // Fit map to show all airports (with padding)
    if (airportSet.length > 0) {
      const bounds = L.latLngBounds(airportSet.map(a => [a.lat, a.lon]));
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 5 });
    }

    applyStyles();
  }, [routeGroups, airportSet, hub, mapReady, applyStyles]); // mapReady ensures this re-runs after L.map() finishes

  // Re-style when hover changes
  useEffect(() => {
    hoveredIdRef.current = hoveredId;
    applyStyles();
  }, [hoveredId, applyStyles]);

  // Re-style + fly to selected route when selection changes
  useEffect(() => {
    selectedIdRef.current = selectedId;
    applyStyles();

    const map = mapRef.current;
    if (!map || !window.L || selectedId == null) return;
    const g = routeGroups.find(x => x.key === selectedId);
    if (!g) return;
    const bounds = window.L.latLngBounds([
      [g.origin.lat, g.origin.lon],
      [g.dest.lat, g.dest.lon],
    ]);
    map.flyToBounds(bounds, { padding: [90, 90], maxZoom: 6, duration: 0.8 });
  }, [selectedId, routeGroups, applyStyles]);

  if (routes.length === 0 && cargoRoutes.length === 0) {
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        <div className="empty-state-icon"><Glyph e="🗺️" /></div>
        <div className="empty-state-text">No routes yet.</div>
        <div style={{ marginTop: 8, fontSize: 13 }}>Open routes to see your network on the map.</div>
      </div>
    );
  }

  const selectedData = selectedId != null ? routeGroups.find(x => x.key === selectedId) : null;

  return (
    <div>
      {/* Map card */}
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        {/* Header */}
        <div style={{
          padding: '12px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Route Network</span>
            <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--text-muted)' }}>
              {routeGroups.length} route{routeGroups.length !== 1 ? 's' : ''} · {airportSet.length} airports
              {selectedData && (
                <span style={{ color: 'var(--accent)' }}> · focused {selectedData.origin.code}→{selectedData.dest.code}</span>
              )}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)', alignItems: 'center', flexWrap: 'wrap' }}>
            {selectedId != null && (
              <button
                onClick={() => setSelectedId(null)}
                className="map-clear-btn"
              >
                <Glyph e="✕" /> Clear focus
              </button>
            )}
            {/* Static legend items */}
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 18, height: 2, background: PROFIT_COLOR, display: 'inline-block', borderRadius: 1 }} />
              Profitable
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 18, height: 2, background: LOSS_COLOR, display: 'inline-block', borderRadius: 1 }} />
              Loss
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: HUB_COLOR, display: 'inline-block' }} />
              Hub
            </span>

            {/* Cargo toggle — only when cargo routes exist */}
            {cargoRoutes.length > 0 && (
              <button
                onClick={() => setShowCargo(v => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  opacity: showCargo ? 1 : 0.4, transition: 'opacity 0.15s',
                  color: 'var(--text-muted)', fontSize: 11,
                }}
                title={showCargo ? 'Hide cargo routes' : 'Show cargo routes'}
              >
                <span style={{ width: 18, height: 2, background: CARGO_COLOR, display: 'inline-block', borderRadius: 1 }} />
                <Glyph e="📦" /> Cargo
              </button>
            )}

            {/* Divider */}
            <span style={{ width: 1, height: 14, background: 'var(--border)', display: 'inline-block' }} />

            {/* Alliance toggle */}
            {currentAlliance && (
              <button
                onClick={() => setShowAlliance(v => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  opacity: showAlliance ? 1 : 0.4, transition: 'opacity 0.15s',
                  color: 'var(--text-muted)', fontSize: 11,
                }}
                title={showAlliance ? 'Hide alliance routes' : 'Show alliance routes'}
              >
                <span style={{
                  width: 18, height: 0, borderTop: `2px dashed ${ALLIANCE_COLOR}`,
                  display: 'inline-block',
                }} />
                Alliance
              </button>
            )}

            {/* Codeshare toggle */}
            {codeshareAgreements.length > 0 && (
              <button
                onClick={() => setShowCodeshare(v => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  opacity: showCodeshare ? 1 : 0.4, transition: 'opacity 0.15s',
                  color: 'var(--text-muted)', fontSize: 11,
                }}
                title={showCodeshare ? 'Hide codeshare routes' : 'Show codeshare routes'}
              >
                <span style={{
                  width: 18, height: 0, borderTop: `2px dashed ${CODESHARE_COLOR}`,
                  display: 'inline-block',
                }} />
                Codeshare
              </button>
            )}
          </div>
        </div>

        {/* Map container */}
        {error ? (
          <div style={{ height: mapHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#060b18', color: 'var(--red)', fontSize: 13 }}>
            <Glyph e="⚠" /> Could not load map: {error}
          </div>
        ) : !ready ? (
          <div style={{ height: mapHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#060b18', color: 'var(--text-muted)', fontSize: 13, gap: 10 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
            Loading map tiles…
          </div>
        ) : (
          <div ref={mapElRef} style={{ height: mapHeight }} />
        )}
      </div>

      {/* Route summary table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)' }}>
            All Routes
          </span>
          <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--text-dim)' }}>
            click a row to focus it on the map
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 14 }}></th>
              <th>Route</th>
              <th>Airports</th>
              <th>Distance</th>
              <th>Load</th>
              <th>Profit / wk</th>
            </tr>
          </thead>
          <tbody>
            {routeGroups.map((g) => {
              const profit = g.hasResult ? g.profit : 0;
              const lf = g.hasResult ? g.loadFactor : 0;
              const isHov = hoveredId === g.key;
              const isSel = selectedId === g.key;
              return (
                <tr
                  key={g.key}
                  onClick={() => setSelectedId(prev => (prev === g.key ? null : g.key))}
                  onMouseEnter={() => setHoveredId(g.key)}
                  onMouseLeave={() => setHoveredId(null)}
                  style={{
                    background: isSel ? 'var(--accent-dim)' : isHov ? 'var(--surface2)' : undefined,
                    boxShadow: isSel ? 'inset 3px 0 0 var(--accent)' : undefined,
                    cursor: 'pointer',
                  }}
                >
                  <td style={{ paddingRight: 4 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: profit >= 0 ? 'var(--green)' : 'var(--red)' }} />
                  </td>
                  <td>
                    <strong>{g.origin.code} → {g.dest.code}</strong>
                    {g.aircraftCount > 1 && (
                      <span className="ac-badge">{g.aircraftCount}×</span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{g.origin.city} → {g.dest.city}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    {g.hasResult ? `${g.distance.toLocaleString()} km` : '—'}
                  </td>
                  <td>
                    {g.hasResult ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{
                          fontSize: 12, fontWeight: 600,
                          color: lf > 0.7 ? 'var(--green)' : lf > 0.4 ? 'var(--yellow)' : 'var(--red)',
                        }}>
                          {(lf * 100).toFixed(0)}%
                        </span>
                        <div className="mini-bar" style={{ width: 48 }}>
                          <div className="mini-bar-fill" style={{
                            width: `${Math.min(lf, 1) * 100}%`,
                            background: lf > 0.7 ? 'var(--green)' : lf > 0.4 ? 'var(--yellow)' : 'var(--red)',
                          }} />
                        </div>
                      </div>
                    ) : '—'}
                  </td>
                  <td>
                    <span style={{ fontWeight: 600, color: profit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {profit >= 0 ? '+' : ''}{formatMoney(profit)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
