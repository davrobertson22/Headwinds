import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { getAirport } from '../data/airports.js';
import { getAircraftType } from '../data/aircraft.js';
import {
  simulateRoute, simulateCargoRoute, cargoLaneAllocations, formatMoney, currentGameDate,
  fleetAvgUtilization, buildEventDemandModel,
  stateLoungeFields, stateGroundHandlingFields, stateCateringFields, routeStops, isMultiStop,
  isRouteActive, routeDistanceKm, cruiseSpeedKmh, turnaroundHours,
} from '../utils/simulation.js';
import { projectWeek } from '../utils/financeProjection.js';
import { getAlliance } from '../data/alliances.js';
import { HUB_TIERS } from '../models/demand.js';
import { Glyph } from './Icons.jsx';
import { pairShapes } from './RivalRouteMap.jsx';
import useIsMobile from '../hooks/useIsMobile.js';
import useBasemap from '../hooks/useBasemap.js';
import GlobeMap from './GlobeMap.jsx';
import { liveryFor } from '../data/livery.js';
import { planeSpriteColors } from '../utils/liveryPaint.js';
import { buildGlobeData } from './globeCore.js';
import { buildFlightPlan } from './flightsCore.js';
import { airlineWeeks } from '../models/schedule.js';
// Geometry, the Leaflet loader, the basemap and the palette are shared with the
// Rivals tab's map — see mapCore.js for why they live in one place.
import {
  segmentsForRoute, segmentsForChain, loadLeaflet, createDarkMap, frameLatLngs, setMapBasemap,
  PROFIT_COLOR, LOSS_COLOR, HUB_COLOR, SPOKE_COLOR,
  ALLIANCE_COLOR, CODESHARE_COLOR, CARGO_COLOR, TAG_COLOR,
} from './mapCore.js';

// ── Viewport ownership ────────────────────────────────────────────────────────
// The map moves the camera for exactly two reasons: the network it is drawing
// changed extent, or the player focused a different route. Everything else —
// hovering a line, a weekly tick re-costing every route, a parent re-render —
// redraws layers and leaves the zoom exactly where the player put it.
//
// Reported by players (Discord, Aug 2026): "when you zoom in and pass your mouse
// over a route, it resets your zoom". Hovering sets state, which re-rendered the
// component; the derived route data was rebuilt from scratch every render (see
// `gd` below), so the layer effect re-ran and called fitBounds again.
//
// Both helpers take the ref they guard and are exported so a test can drive the
// SAME decision the map makes, with no DOM and no Leaflet.

/** A rotation's identity: its stop chain, direction-normalised so A→B→C and the
 *  same rotation entered as C→B→A are one line on the map rather than two
 *  overlapping ones. Exported for the map's tests. */
export function chainKey(chain = []) {
  const codes = chain.map(a => (typeof a === 'string' ? a : a?.code)).filter(Boolean);
  const fwd = codes.join('>');
  const rev = [...codes].reverse().join('>');
  return fwd <= rev ? fwd : rev;
}

/** The airport set the viewport is framed on, as a stable string. Sorted, so the
 *  same set re-derived in a different order reads as unchanged. */
export function viewportExtent(airports = []) {
  return airports.map(a => a.code).sort().join(',');
}

/** True when the viewport should be re-framed on `airports` — i.e. the extent
 *  genuinely changed since the last fit. Records the new extent when it does. */
export function claimViewportFit(ref, airports = []) {
  if (!airports.length) return false;
  const extent = viewportExtent(airports);
  if (ref.current === extent) return false;
  ref.current = extent;
  return true;
}

/** True when the map should fly to `selectedId` — i.e. the focus changed. A
 *  redraw of an already-focused route is not a reason to move.
 *
 *  `visible` is false while the flat map sits hidden under the globe. A hidden
 *  map does not fly AND does not claim the focus, so it flies once it is shown.
 *  Flying it anyway was Barca's "when I click a route sometimes my screen goes
 *  dark" (Discord, 2026-10-29): a Leaflet map that has never been on screen has
 *  no size, flyToBounds computes a NaN centre and throws "Invalid LatLng object:
 *  (NaN, NaN)" from inside a React effect, and the whole game unmounts to a black
 *  page. It needed the globe to be the first view since the page loaded — the
 *  map view opens on whichever the player used last, so "sometimes". */
export function claimRouteFly(ref, selectedId, visible = true) {
  if (selectedId == null) { ref.current = null; return false; }
  if (!visible) return false;
  if (ref.current === selectedId) return false;
  ref.current = selectedId;
  return true;
}

/** The route keys an airport focus lights up: every drawn group with the
 *  airport anywhere on it (an endpoint or a stop of a rotation). */
export function routeKeysAtAirport(groups = [], code) {
  if (!code) return [];
  return groups
    .filter(g => (g.chain?.length >= 2 ? g.chain : [g.origin, g.dest]).some(a => a?.code === code))
    .map(g => g.key);
}

// ── Component ─────────────────────────────────────────────────────────────────
// ── Designated stations ───────────────────────────────────────────────────────
// `state.hub` is the airline's FOUNDING hub and nothing more — it is stamped on
// every route at creation and never changes. The stations the player actually
// runs live in `state.hubs` ({ code: { tier, tierSince } }, tier 0 = focus city).
// The map pinned the founding hub alone, so a carrier hubbing at MCI, SLC, HNL
// and SJU saw four plain blue spokes and one gold pin (Discord, Knightmare,
// 27 Aug 2026). Same fallback HubManagement uses: an ABSENT hubs map is a legacy
// save and means "the founding hub, tier 1"; an EMPTY one means the player has
// abandoned every designation, and nothing should pin.

/** Every station the player has designated, as { [code]: { tier, name } }. */
export function mapHubs(state = {}) {
  const raw = state.hubs ?? (state.hub ? { [state.hub]: { tier: 1 } } : {});
  const out = {};
  for (const [code, h] of Object.entries(raw)) {
    const tier = h?.tier ?? 1;
    if (!HUB_TIERS[tier]) continue;   // hubConstruction entries aren't live yet
    out[code] = { tier, name: HUB_TIERS[tier].name };
  }
  return out;
}

// A stable empty list, so a state with no cargoRoutes doesn't defeat memos.
const NO_ROUTES = [];

// localStorage key for the flat-map / globe choice.
export const MAP_VIEW_KEY = 'headwinds.mapView';
// localStorage key for the globe's planes overlay (on unless turned off).
export const GLOBE_PLANES_KEY = 'headwinds.globePlanes';
// localStorage key for the airport code labels (both views; on unless turned off).
export const AIRPORT_LABELS_KEY = 'headwinds.airportLabels';

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * One flight plan per route a tail flies, for the globe's planes
 * (flightsCore.js), timed by the airline's timetable (models/schedule.js) —
 * the player's pinned rotations plus automatic ones — so a tail on two routes
 * is never in two places at once. Takes the map's own groups, so the
 * aircraft-type / airport filters and the cargo toggle apply to the planes
 * exactly as they do to the lines. A tail flies nothing while it's grounded or
 * in maintenance, or in a month its seasonal route is dormant.
 *   groups / cargoGroups: { key, members: [{ r, chain, origin, dest }] }
 *   colorOf(g): the line colour, used for the plane's glow
 *   weeks: airlineWeeks(...) for ALL the airline's routes (filters must not
 *          reshuffle the timetable); computed here when omitted
 */
export function tailFlightPlans({ groups = [], cargoGroups = [], fleet = [], month, colorOf, cargoColor, weeks = null }) {
  const plans = [];
  const table = weeks ?? airlineWeeks({
    fleet,
    routes: groups.flatMap(g => g.members.map(d => d.r)),
    cargoRoutes: cargoGroups.flatMap(g => g.members.map(d => d.r)),
  }, month);
  const add = (g, d, idx, group, color) => {
    const r = d.r;
    if (!r || !isRouteActive(r, month)) return;
    const ac = fleet.find(a => a.id === r.aircraftId);
    if (!ac || ac.status === 'grounded' || ac.status === 'maintenance') return;
    const type = getAircraftType(ac.typeId);
    if (!type) return;
    const stops = d.chain?.length >= 2 ? d.chain : [d.origin, d.dest];
    const startsH = (table.get(ac.id)?.blocks ?? []).filter(b => b.routeId === r.id).map(b => b.start / 60);
    if (!startsH.length) return;
    const plan = buildFlightPlan({
      id: r.id ?? `${group}#${idx}`,
      group, color,
      tip: `<div class="map-tip-title">${escHtml(ac.tailNumber || ac.name || type.name)}</div>`
        + `<div class="map-tip-sub">${escHtml(type.name)} · ${r.weeklyFrequency ?? 0}× weekly</div>`,
      stops,
      legKm: stops.slice(1).map((s, i) => routeDistanceKm(stops[i].code, s.code)),
      weeklyFrequency: r.weeklyFrequency,
      cruiseKmh: cruiseSpeedKmh(type),
      turnaroundH: turnaroundHours(type),
      startsH,
    });
    if (plan) plans.push(plan);
  };
  for (const g of groups) g.members.forEach((d, i) => add(g, d, i, g.key, colorOf(g)));
  for (const g of cargoGroups) g.members.forEach((d, i) => add(g, d, i, `cargo:${g.key}`, cargoColor));
  return plans;
}

/** A passenger line's colour: multi-stop violet, else profit green / loss red. */
export function routeGroupColor(g) {
  return g.multi ? TAG_COLOR : ((g.hasResult ? g.profit : 0) >= 0 ? PROFIT_COLOR : LOSS_COLOR);
}

/**
 * The shape of what the flat map's route layer draws, as one string: every line
 * (its group key fixes the geometry) and every pin with its hub badge. A weekly
 * tick or a rival poll usually leaves all of that alone and moves only the
 * numbers in the tooltips, and now and then flips a break-even route between
 * green and red. So when this is unchanged the layer effect recolours and
 * re-labels the lines in place instead of tearing down and re-adding every
 * polyline and marker (a few hundred ms on a big airline, on every poll, in map
 * view where the map is always on screen).
 */
export function networkDrawKey(routeGroups, airportSet, hubs) {
  // Sorted: the engine may hand the routes back in a different order after a
  // tick, which redraws nothing.
  const lines = routeGroups.map(g => g.key).sort().join('|');
  const pins = airportSet.map((a) => {
    const h = hubs[a.code];
    return h ? `${a.code}*${h.tier ?? ''}*${h.name ?? ''}` : a.code;
  }).sort().join(',');
  return `${lines}#${pins}`;
}

/** Marker geometry for a hub tier — bigger pin the higher the tier. */
export function hubMarkerSize(tier) {
  const core = 9 + 2 * Math.max(0, Math.min(3, tier ?? 1));
  return { core, ring: core + 3 };
}

// ── Tooltip HTML ──────────────────────────────────────────────────────────────
// One builder per line kind, shared by the flat map and the globe so the two
// views can never disagree about what a route is earning.
export function routeTipHtml(g) {
  const { origin, dest } = g;
  const chain = g.chain?.length >= 2 ? g.chain : [origin, dest];
  const profit = g.hasResult ? g.profit : 0;
  const profitColor = profit >= 0 ? PROFIT_COLOR : LOSS_COLOR;
  const lf      = g.hasResult ? `${(g.loadFactor * 100).toFixed(0)}%` : '—';
  const pax     = g.hasResult ? Math.round(g.passengers).toLocaleString() : '—';
  const profStr = g.hasResult ? `<span style="color:${profitColor}">${profit >= 0 ? '+' : ''}${formatMoney(profit)}/wk</span>` : '—';
  const rev     = g.hasResult ? `+${formatMoney(g.revenue)}` : '—';
  const acText  = `${g.aircraftCount} aircraft`;
  const titleHtml = chain.map(a => a.code).join(' <span class="map-tip-arrow">→</span> ');
  const subHtml = g.multi
    ? `${chain.length - 1} legs · ${origin.city} → ${dest.city} · ${acText}`
    : `${origin.city} → ${dest.city} · ${acText}`;
  return `
    <div class="map-tip">
      <div class="map-tip-title">${titleHtml}</div>
      <div class="map-tip-sub">${subHtml}</div>
      <div class="map-tip-stats">
        <div><span class="map-tip-lbl">Load</span><span class="map-tip-val">${lf}</span></div>
        <div><span class="map-tip-lbl">Pax/wk</span><span class="map-tip-val">${pax}</span></div>
        <div><span class="map-tip-lbl">Revenue</span><span class="map-tip-val" style="color:${PROFIT_COLOR}">${rev}</span></div>
        <div><span class="map-tip-lbl">Profit</span><span class="map-tip-val">${profStr}</span></div>
      </div>
      <div class="map-tip-hint">Click to focus this route</div>
    </div>
  `;
}

export function cargoTipHtml(g) {
  const { origin, dest } = g;
  const lf      = g.hasResult ? `${(g.loadFactor * 100).toFixed(0)}%` : '—';
  const tonnes  = g.hasResult ? `${Math.round(g.tonnes).toLocaleString()} t` : '—';
  const profit  = g.hasResult ? g.profit : 0;
  const profStr = g.hasResult ? `${profit >= 0 ? '+' : ''}${formatMoney(profit)}/wk` : '—';
  const rev     = g.hasResult ? `+${formatMoney(g.revenue)}` : '—';
  return `
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
}

export function airportTipHtml(airport, hubInfo) {
  const badge = hubInfo ? ` <span style="color:${HUB_COLOR}">● ${hubInfo.name.toUpperCase()}</span>` : '';
  return `<div class="map-tip"><div class="map-tip-title">${airport.code}</div><div class="map-tip-sub">${airport.city}, ${airport.country}${badge}</div></div>`;
}

export function partnerTipHtml({ comp, type, color, origin, dest, chain }) {
  const via = chain.length > 2 ? ` <span style="font-size:10px">via ${chain.slice(1, -1).map(ap => ap.code).join(', ')}</span>` : '';
  return `
    <div class="map-tip">
      <div class="map-tip-title" style="color:${color}">${origin.code} → ${dest.code}${via}</div>
      <div class="map-tip-sub">${origin.city} → ${dest.city}</div>
      <div class="map-tip-sub" style="margin-top:4px">${comp.name} · ${type === 'alliance' ? 'Alliance' : 'Codeshare'}</div>
    </div>
  `;
}

/** Airports the map pins: every station you've designated (even one you have no
 *  routes at yet) plus every stop of every route drawn — a rotation's
 *  intermediate stops are airports it lands at, so they get a pin too. */
export function mapAirportCodes(hubCodes = [], ...routeDataSets) {
  const codes = new Set(hubCodes.filter(Boolean));
  for (const set of routeDataSets) {
    for (const d of set ?? []) {
      if (Array.isArray(d?.chain)) for (const a of d.chain) { if (a?.code) codes.add(a.code); }
      else { if (d?.origin?.code) codes.add(d.origin.code); if (d?.dest?.code) codes.add(d.dest.code); }
    }
  }
  return [...codes];
}

export default function RouteMap({ fullBleed = false, paused = false } = {}) {
  // Map view keeps this map mounted under every page. While a page covers it
  // (`paused`) it holds the state it last drew, so a weekly tick, a rival poll
  // or any click inside the page doesn't re-project the week and rebuild every
  // Leaflet layer behind the panel, and the globe stops animating. It catches
  // up once, when the panel closes.
  const live = useGame();
  const heldRef = useRef(live);
  if (!paused) heldRef.current = live;
  const { state, remoteChrome } = heldRef.current;
  // Satellite (Blue Marble) or Dark (CARTO) — one choice for every map.
  const [basemap, setBasemap] = useBasemap();
  // Globe plane sprite in the airline's livery (fuselage + tail colours).
  const planeColors = useMemo(() => planeSpriteColors(liveryFor(state)), [state.livery, state.logoColor]);
  const { fleet, routes, cargoRoutes = NO_ROUTES, hub, hubs: hubsState,
          competitors = [], allianceMembership, codeshareAgreements = [] } = state;

  // Every designated station, gold-pinned — not just the founding hub.
  const hubs = useMemo(() => mapHubs({ hub, hubs: hubsState }), [hub, hubsState]);
  const hubCodes = useMemo(() => Object.keys(hubs), [hubs]);

  // The map has a fixed inline height that a CSS media query can't reach, so we
  // size it here. Shorter on phones so the route list below is reachable without
  // a long scroll; unchanged (520) on desktop.
  //
  // Full-bleed (the map-first layout's background) fills its parent instead, so
  // the height is measured — GlobeMap's starting zoom and Leaflet's size both
  // want a number, not '100%'.
  const isMobile = useIsMobile();
  const bleedRef = useRef(null);
  const [bleedHeight, setBleedHeight] = useState(() =>
    (typeof window !== 'undefined' ? window.innerHeight : 800));
  useEffect(() => {
    if (!fullBleed || !bleedRef.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const h = Math.round(e.contentRect.height);
      if (h > 0) setBleedHeight(h);
    });
    ro.observe(bleedRef.current);
    return () => ro.disconnect();
  }, [fullBleed]);
  const mapHeight = fullBleed ? bleedHeight : (isMobile ? 380 : 520);

  const mapElRef      = useRef(null);   // DOM node
  const mapRef        = useRef(null);   // Leaflet map instance
  const layersRef     = useRef([]);     // Active Leaflet layers (routes + markers)
  const lineGroupsRef = useRef(new Map()); // routeId -> { halo:[], main:[], color }
  const partnerLayersRef = useRef([]);  // Partner overlay layers (separate so we can toggle)
  const [ready, setReady]       = useState(!!window.L);
  const [mapReady, setMapReady] = useState(false);   // true once L.map() is done
  const [error, setError]       = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [selectedId, setSelectedIdRaw] = useState(null);
  // Airport focus (Barca, Discord 2026-10-29: "highlight all routes from a
  // particular airport — maybe by clicking its label"). One focus at a time:
  // picking a route drops the airport focus and the other way round.
  const [focusAirport, setFocusAirportRaw] = useState(null);
  const setSelectedId = useCallback((v) => {
    setFocusAirportRaw(null);
    setSelectedIdRaw(v);
  }, []);
  const toggleAirportFocus = useCallback((code) => {
    setSelectedIdRaw(null);
    setFocusAirportRaw(prev => (prev === code ? null : code));
  }, []);
  const clearFocus = useCallback(() => { setSelectedIdRaw(null); setFocusAirportRaw(null); }, []);
  const [showAlliance,  setShowAlliance]  = useState(true);
  const [showCodeshare, setShowCodeshare] = useState(true);
  const [showCargo,     setShowCargo]     = useState(true);
  const [acTypeFilter,  setAcTypeFilter]  = useState('all');  // 'all' | aircraft typeId
  const [airportFilter, setAirportFilter] = useState('all');  // 'all' | IATA code
  const cargoLayersRef = useRef([]);   // amber cargo route overlay layers
  // Signatures of what each layer effect last drew (see networkDrawKey), so an
  // update that changes no line can skip the rebuild.
  const drawnRef = useRef({ routes: null, cargo: null, partners: null });

  // Flat map or 3D globe. Remembered per browser; the flat map stays the
  // default. The Leaflet map stays mounted (hidden) under the globe, so
  // switching back is instant and keeps the player's zoom.
  const [mapView, setMapView] = useState(() => {
    try { return localStorage.getItem(MAP_VIEW_KEY) === 'globe' ? 'globe' : 'flat'; }
    catch { return 'flat'; }
  });
  // Planes on the globe — on by default, remembered per browser.
  const [showPlanes, setShowPlanes] = useState(() => {
    try { return localStorage.getItem(GLOBE_PLANES_KEY) !== 'off'; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(GLOBE_PLANES_KEY, showPlanes ? 'on' : 'off'); } catch { /* private mode */ }
  }, [showPlanes]);
  // Airport code labels — on by default, remembered per browser. One switch for
  // both views: hiding is a class on the map card (CSS hides .airport-label
  // inside it), so neither map rebuilds its layers or markers.
  const [showLabels, setShowLabels] = useState(() => {
    try { return localStorage.getItem(AIRPORT_LABELS_KEY) !== 'off'; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(AIRPORT_LABELS_KEY, showLabels ? 'on' : 'off'); } catch { /* private mode */ }
  }, [showLabels]);
  const frameRef = useRef(null);         // last fitBounds target, for a re-fit after being hidden
  const fitHiddenRef = useRef(false);    // true when that fit ran while the flat map was hidden

  // Keep refs of current interaction state so the (rarely-rebuilt) layer effect
  // can apply correct styling without being a dependency.
  const selectedIdRef = useRef(null);
  const hoveredIdRef  = useRef(null);
  const focusKeysRef  = useRef(new Set());   // route keys lit by an airport focus
  const airportClickRef = useRef(null);      // latest toggleAirportFocus, for Leaflet handlers
  airportClickRef.current = toggleAirportFocus;

  // Viewport bookkeeping — see claimViewportFit / claimRouteFly above.
  const fittedExtentRef = useRef(null);   // airport set the viewport was fitted to
  const flownToRef      = useRef(null);   // route key we last flew to

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

    // CartoDB Dark Matter — proper dark game-map feel
    const map = createDarkMap(mapElRef.current, { basemap });

    // Full-bleed: wheel / pinch zoom only — the corner belongs to the HUD.
    if (!fullBleed) L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Click empty map → deselect (a route or an airport)
    map.on('click', () => clearFocus());

    mapRef.current = map;
    setMapReady(true);   // ← signals the layers effect to run

    // Cleanup on unmount
    return () => {
      map.remove();
      mapRef.current = null;
      // A fresh map instance starts with no viewport of its own, so the next
      // draw must frame the network even if nothing about it changed.
      fittedExtentRef.current = null;
      flownToRef.current = null;
      drawnRef.current = { routes: null, cargo: null, partners: null };
      setMapReady(false);
    };
  }, [ready]);

  // Satellite / Dark switched (here or from the map-first settings menu).
  useEffect(() => {
    if (mapReady) setMapBasemap(mapRef.current, basemap);
  }, [mapReady, basemap]);

  // Leaflet caches the container size, so when the height changes (e.g. crossing
  // the mobile breakpoint or rotating the device) we must tell it to remeasure,
  // otherwise tiles render into the old dimensions.
  useEffect(() => {
    if (mapRef.current) mapRef.current.invalidateSize();
  }, [mapHeight]);

  useEffect(() => {
    try { localStorage.setItem(MAP_VIEW_KEY, mapView); } catch { /* private mode */ }
    const map = mapRef.current;
    if (mapView !== 'flat' || !map) return;
    map.invalidateSize();
    if (fitHiddenRef.current && frameRef.current) {
      map.fitBounds(frameRef.current, { padding: [50, 50], maxZoom: 5 });
      fitHiddenRef.current = false;
    }
  }, [mapView]);

  // 3. Derive route data
  //
  // ── Single source of truth ────────────────────────────────────────────────
  // Every number on this screen (map tooltips + the route table below) comes
  // from the SAME canonical engine projection the Dashboard, Routes and Finance
  // screens use. This map used to call a BARE simulateRoute(r, aircraft, gd),
  // which skipped labor, the fuel-price multiplier, competitor encroachment,
  // fleet utilisation, satisfaction, live events and — on the cargo side — the
  // shared-lane demand pool. Unopposed demand meant busy routes pinned at a
  // 100% load factor with an inflated profit, so the map disagreed with every
  // other screen (Finance said 87%, the map said 100%). Prefer the engine's
  // routeResult; fall back to a standalone sim ONLY for routes the engine skips
  // (grounded / dormant-seasonal), run with the same inputs the engine used.
  // Memoised on the game week, NOT derived inline: currentGameDate() returns a
  // fresh object every call and this value is a dependency of routeData below.
  // Recomputed each render, it made routeData → routeGroups → airportSet all new
  // identities on EVERY render, so the layer effect tore down and rebuilt every
  // Leaflet layer — and re-framed the viewport — each time hover state changed.
  const gd = useMemo(() => currentGameDate(state), [state.week]);
  const proj = useMemo(() => projectWeek(state), [state]);
  const rrById = useMemo(() => {
    const m = {};
    for (const rr of proj.report?.routeResults ?? []) m[rr.routeId] = rr;
    return m;
  }, [proj]);
  const cargoRrById = useMemo(() => {
    const m = {};
    for (const rr of proj.report?.cargoRouteResults ?? []) m[rr.routeId] = rr;
    return m;
  }, [proj]);

  const routeData = useMemo(() => {
    const avgUtil  = fleetAvgUtilization(fleet, [...routes, ...cargoRoutes]);
    const evDemand = buildEventDemandModel(state.activeEvents);
    return routes.map(r => {
      const origin   = getAirport(r.origin);
      const dest     = getAirport(r.destination);
      if (!origin || !dest) return null;
      // The airports this route actually touches, in visiting order. For a
      // single-leg route that is [origin, dest]; for a rotation it is every
      // stop, which is what the line has to bend through and what the airport
      // filter has to match on.
      const chain = routeStops(r).map(getAirport).filter(Boolean);
      const multi = isMultiStop(r) && chain.length > 2;
      const aircraft = fleet.find(a => a.id === r.aircraftId);
      const result = !aircraft ? null
        : (rrById[r.id] ?? simulateRoute(
            { ...r, ...stateLoungeFields(state, r.origin, r.destination), ...stateGroundHandlingFields(state, r.origin, r.destination), ...stateCateringFields(state, r) },
            aircraft, gd, state.labor ?? null, proj.fuelMultiplier,
            null, [], avgUtil, state.satisfaction ?? null,
            evDemand.multFor(r.origin, r.destination)));
      return { r, origin, dest, result, chain, multi };
    }).filter(Boolean);
  }, [routes, cargoRoutes, fleet, rrById, proj, gd, state.labor, state.satisfaction, state.activeEvents]);

  // Cargo route data (mirrors routeData but for freighters / cargo routes).
  // The fallback runs the same shared-lane allocation the engine does, so a
  // freighter sharing a pair never sees the full-market pool to itself.
  const cargoRouteData = useMemo(() => {
    const needsFallback = cargoRoutes.some(r => !cargoRrById[r.id]);
    const alloc = needsFallback
      ? cargoLaneAllocations(cargoRoutes, fleet, 1.0, { gameDate: gd, competitors }) : null;
    return cargoRoutes.map(r => {
      const origin   = getAirport(r.origin);
      const dest     = getAirport(r.destination);
      if (!origin || !dest) return null;
      const aircraft = fleet.find(a => a.id === r.aircraftId);
      const result = !aircraft ? null
        : (cargoRrById[r.id] ?? simulateCargoRoute(r, aircraft, gd, state.labor ?? null,
            proj.fuelMultiplier, 1.0, alloc?.get(r.id) ?? null));
      return { r, origin, dest, result, chain: [origin, dest], multi: false };
    }).filter(Boolean);
  }, [cargoRoutes, fleet, cargoRrById, proj, gd, state.labor]);

  // ── Map filters: by aircraft type and by airport ─────────────────────────
  // Options come from the UNfiltered data so the dropdowns always list
  // everything; the map + table below render only what passes the filters.
  const typesInUse = useMemo(() => {
    const ids = new Set();
    for (const r of [...routes, ...cargoRoutes]) {
      const a = fleet.find(x => x.id === r.aircraftId);
      if (a) ids.add(a.typeId);
    }
    return [...ids].map(getAircraftType).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [routes, cargoRoutes, fleet]);

  const airportOptions = useMemo(() => {
    const codes = new Set([
      ...routeData.flatMap(d => d.chain.map(a => a.code)),
      ...cargoRouteData.flatMap(d => [d.origin.code, d.dest.code]),
    ]);
    return [...codes].map(getAirport).filter(Boolean)
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [routeData, cargoRouteData]);

  const matchesFilters = useCallback((d) => {
    if (acTypeFilter !== 'all') {
      const a = fleet.find(x => x.id === d.r.aircraftId);
      if (!a || a.typeId !== acTypeFilter) return false;
    }
    // A rotation touching the filtered airport in the MIDDLE is still touching
    // it — filtering on the endpoints alone hid MCI–JFK–ORY from "Airport: JFK".
    if (airportFilter !== 'all' && !(d.chain ?? [d.origin, d.dest]).some(a => a.code === airportFilter)) return false;
    return true;
  }, [acTypeFilter, airportFilter, fleet]);

  const filteredRouteData      = useMemo(() => routeData.filter(matchesFilters), [routeData, matchesFilters]);
  const filteredCargoRouteData = useMemo(() => cargoRouteData.filter(matchesFilters), [cargoRouteData, matchesFilters]);
  const filtersActive = acTypeFilter !== 'all' || airportFilter !== 'all';

  const airportSet = useMemo(() => (
    mapAirportCodes(hubCodes, filteredRouteData, filteredCargoRouteData)
      .map(getAirport).filter(Boolean)
  ), [filteredRouteData, filteredCargoRouteData, hubCodes]);

  // Group route entries by city pair (direction-agnostic) so multiple aircraft
  // on the same JFK↔ORD pair show as ONE line + ONE row with aggregated stats.
  const routeGroups = useMemo(() => {
    const map = new Map();
    for (const d of filteredRouteData) {
      // A rotation is keyed on its whole chain, not its endpoints. Sharing the
      // pair key with a plain MCI–ORY service merged two different products
      // into one line and one row — and drew the rotation as a direct flight it
      // does not operate.
      const key = d.multi ? `tag:${chainKey(d.chain)}` : [d.origin.code, d.dest.code].sort().join('~');
      let g = map.get(key);
      if (!g) {
        g = {
          key, origin: d.origin, dest: d.dest, members: [],
          chain: d.chain, multi: d.multi,
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
  }, [filteredRouteData]);

  // Group cargo route entries by city pair (aggregate tonnes / profit / capacity).
  const cargoGroups = useMemo(() => {
    const map = new Map();
    for (const d of filteredCargoRouteData) {
      const key = [d.origin.code, d.dest.code].sort().join('~');
      let g = map.get(key);
      if (!g) {
        g = { key, origin: d.origin, dest: d.dest, chain: [d.origin, d.dest], multi: false, members: [], profit: 0, revenue: 0, tonnes: 0, capacity: 0, distance: 0 };
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
  }, [filteredCargoRouteData]);

  // If the focused route gets filtered out, drop the focus so the map doesn't
  // stay zoomed on an invisible line.
  useEffect(() => {
    if (selectedId != null && !routeGroups.some(g => g.key === selectedId)) setSelectedId(null);
  }, [routeGroups, selectedId]);

  // Routes lit by the airport focus (empty when none, or when no drawn route
  // touches it — then the focus simply frames the airport).
  const airportFocusKeys = useMemo(
    () => routeKeysAtAirport(routeGroups, focusAirport),
    [routeGroups, focusAirport],
  );

  // ── Style resolver: highlight selected/hovered, dim the rest ─────────────────
  const applyStyles = useCallback(() => {
    const selId = selectedIdRef.current;
    const hovId = hoveredIdRef.current;
    const lit = focusKeysRef.current;
    const anySel = selId != null || lit.size > 0;

    lineGroupsRef.current.forEach((group, id) => {
      // A single focused (or hovered) route flows; an airport's routes are lit
      // solid — dozens of animated dashes at once is what makes a map crawl.
      const flowing = id === selId || id === hovId;
      const active = flowing || lit.has(id);
      let mainW, mainO, haloW, haloO;
      if (flowing)      { mainW = 4.5; mainO = 1;    haloW = 18; haloO = 0.30; }
      else if (active)  { mainW = 3.2; mainO = 1;    haloW = 12; haloO = 0.24; }
      else if (anySel)  { mainW = 1.8; mainO = 0.18; haloW = 7;  haloO = 0.03; }
      else              { mainW = 2.5; mainO = 0.85; haloW = 9;  haloO = 0.16; }

      group.halo.forEach(l => l.setStyle({ weight: haloW, opacity: haloO }));
      group.main.forEach(l => {
        l.setStyle({
          weight: mainW,
          opacity: mainO,
          dashArray: flowing ? '10 16' : null,
        });
        const el = l.getElement && l.getElement();
        if (el) el.classList.toggle('flowing', flowing);
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
      for (const [routeKey, cfg] of Object.entries(comp.routes ?? {})) {
        const [a, b] = routeKey.split('-');
        const origin = getAirport(a);
        const dest   = getAirport(b);
        if (!origin || !dest) continue;
        // A partner's tag rotation draws through its stops, not as a nonstop.
        for (const sh of pairShapes(routeKey, cfg)) {
          result.push({ comp, type, color, origin, dest, routeKey, chain: sh.airports });
        }
      }
    }
    return result;
  }, [competitors, allianceMembership, codeshareAgreements, currentAlliance]);

  // 4b. Sync partner overlay layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    const dim = (selectedId != null || focusAirport) ? 0.25 : 1;   // fade partners when focusing

    // The airport filter applies to partner overlays too, so "show me JFK"
    // really means only lines touching JFK. (The aircraft-type filter is
    // ours-only — we don't know what partners fly.)
    const shown = partnerRouteData.filter(({ type, origin, dest, chain = [origin, dest] }) =>
      (type === 'alliance' ? showAlliance : showCodeshare)
      && (airportFilter === 'all' || chain.some(ap => ap.code === airportFilter)));
    // A rival poll hands over new competitor objects even when no partner
    // route moved; everything a partner line shows is in this key.
    const drawKey = `${dim}#` + shown.map(({ comp, type, origin, dest, chain = [origin, dest] }) =>
      `${comp.id}:${comp.name}:${type}:${chain.map(ap => ap.code).join('-')}`).sort().join('|');
    if (drawnRef.current.partners === drawKey) return;
    drawnRef.current.partners = drawKey;

    // Clear previous partner layers
    partnerLayersRef.current.forEach(l => map.removeLayer(l));
    partnerLayersRef.current = [];

    for (const { comp, type, color, origin, dest, chain = [origin, dest] } of shown) {

      const segments = chain.length > 2
        ? segmentsForChain(chain.map(ap => [ap.lat, ap.lon]))
        : segmentsForRoute(origin.lat, origin.lon, dest.lat, dest.lon);
      const tipHtml = partnerTipHtml({ comp, type, color, origin, dest, chain });

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

      // Small dot at each endpoint and stop (only if not already in our own airportSet)
      for (const airport of chain) {
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
  }, [partnerRouteData, showAlliance, showCodeshare, selectedId, focusAirport, mapReady, airportFilter]);

  // 4c. Sync cargo route overlay (amber, distinct from green/red passenger lines)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    // Fade cargo when focusing a passenger route; an airport focus keeps the
    // freight lines that touch the airport.
    const dimFor = (g) => (selectedId != null ? 0.3
      : focusAirport && g.origin.code !== focusAirport && g.dest.code !== focusAirport ? 0.3 : 1);

    // Same lines as last time (a tick or a poll): refresh the tooltips only.
    const drawKey = showCargo ? `${selectedId != null}:${focusAirport ?? ''}#${cargoGroups.map(g => g.key).sort().join('|')}` : 'off';
    if (drawnRef.current.cargo === drawKey) {
      for (const l of cargoLayersRef.current) {
        if (l._cargoKey) l.setTooltipContent(cargoTipHtml(cargoGroups.find(g => g.key === l._cargoKey)));
      }
      return;
    }
    drawnRef.current.cargo = drawKey;

    cargoLayersRef.current.forEach(l => map.removeLayer(l));
    cargoLayersRef.current = [];
    if (!showCargo) return;

    for (const g of cargoGroups) {
      const { origin, dest } = g;
      const dim = dimFor(g);
      const segments = segmentsForRoute(origin.lat, origin.lon, dest.lat, dest.lon);
      const tipHtml = cargoTipHtml(g);

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
        line._cargoKey = g.key;
        line.on('mouseover', () => line.setStyle({ weight: 4, opacity: 1 }));
        line.on('mouseout',  () => line.setStyle({ weight: 2.5, opacity: 0.9 * dim }));
        line.addTo(map);
        cargoLayersRef.current.push(line);
      }
    }
  }, [cargoGroups, showCargo, selectedId, focusAirport, mapReady]);

  // 4. Sync routes + markers to map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;

    // Same lines and pins (the usual weekly tick or rival poll): recolour any
    // route that crossed break-even, put the new numbers in the tooltips, and
    // keep every layer, the hover/focus styles and the view.
    const drawKey = networkDrawKey(routeGroups, airportSet, hubs);
    if (drawnRef.current.routes === drawKey) {
      for (const g of routeGroups) {
        const group = lineGroupsRef.current.get(g.key);
        if (!group) continue;
        const color = routeGroupColor(g);
        if (color !== group.color) {
          group.halo.forEach(l => l.setStyle({ color }));
          group.main.forEach(l => l.setStyle({ color }));
          group.color = color;
        }
        const tip = routeTipHtml(g);
        group.hits.forEach(h => h.setTooltipContent(tip));
      }
      return;
    }
    drawnRef.current.routes = drawKey;

    // Clear previous layers
    layersRef.current.forEach(l => map.removeLayer(l));
    layersRef.current = [];
    lineGroupsRef.current = new Map();

    // Route polylines (glow halo underneath + crisp main line on top).
    // One line per city pair — all aircraft on the pair are aggregated into the group.
    // Canonical path of every drawn line — the viewport frames these too.
    const framePaths = [];
    for (const g of routeGroups) {
      const { origin, dest } = g;
      const chain    = g.chain?.length >= 2 ? g.chain : [origin, dest];
      const profit   = g.hasResult ? g.profit : 0;
      // Profit colour still carries the money; a rotation is purple because the
      // shape of the line is the thing you cannot read any other way (and purple
      // is what the Routes page already calls multi-stop).
      const profitColor = profit >= 0 ? PROFIT_COLOR : LOSS_COLOR;
      const color    = g.multi ? TAG_COLOR : profitColor;
      const segments = g.multi
        ? segmentsForChain(chain.map(a => [a.lat, a.lon]))
        : segmentsForRoute(origin.lat, origin.lon, dest.lat, dest.lon);
      framePaths.push(segments[0]);

      const tipHtml = routeTipHtml(g);

      const halo = [];
      const main = [];
      const hits = [];

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
        hits.push(hit);
        layersRef.current.push(hit);
      }

      lineGroupsRef.current.set(g.key, { halo, main, hits, color });
    }

    // Airport markers
    for (const airport of airportSet) {
      const hubInfo = hubs[airport.code];

      if (hubInfo) {
        // Pulsing hub marker (animated CSS divIcon), sized by tier so a focus
        // city reads as smaller than an International Gateway.
        const { core, ring } = hubMarkerSize(hubInfo.tier);
        const hubMarker = L.marker([airport.lat, airport.lon], {
          icon: L.divIcon({
            className: 'hub-marker',
            html: `<span class="hub-pulse-ring" style="--hub-ring:${ring}px"></span><span class="hub-pulse-core" style="--hub-core:${core}px"></span>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
          zIndexOffset: 1000,
        });
        hubMarker.bindTooltip(
          airportTipHtml(airport, hubInfo),
          { className: 'game-tooltip', offset: [12, 0] },
        );
        hubMarker.on('click', (e) => { window.L.DomEvent.stopPropagation(e); airportClickRef.current?.(airport.code); });
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
          airportTipHtml(airport, null),
          { className: 'game-tooltip', offset: [10, 0] },
        );
        marker.on('click', (e) => { window.L.DomEvent.stopPropagation(e); airportClickRef.current?.(airport.code); });
        marker.addTo(map);
        layersRef.current.push(marker);
      }

      // Code label (not shown at low zoom — Leaflet handles that via zoom)
      // Clickable: a click lights every route at this airport.
      const label = L.marker([airport.lat, airport.lon], {
        icon: L.divIcon({
          className: 'airport-label airport-label-click',
          html: `<span>${airport.code}</span>`,
          iconAnchor: [-10, 4],
        }),
        interactive: true,
        keyboard: false,
        title: `Show every route at ${airport.code}`,
        zIndexOffset: 500,
      });
      label.on('click', (e) => { window.L.DomEvent.stopPropagation(e); airportClickRef.current?.(airport.code); });
      label.addTo(map);
      layersRef.current.push(label);
    }

    // Frame the network — only when its extent actually changed.
    if (claimViewportFit(fittedExtentRef, airportSet)) {
      // Airports AND the arcs between them — see frameLatLngs in mapCore.
      const bounds = L.latLngBounds(frameLatLngs(airportSet, framePaths));
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 5 });
      frameRef.current = bounds;
      // A hidden container measures 0×0, so a fit made under the globe lands
      // on a meaningless zoom; redo it when the flat map is shown again.
      fitHiddenRef.current = map.getSize().x === 0;
    }

    applyStyles();
  }, [routeGroups, airportSet, hubs, mapReady, applyStyles]); // mapReady ensures this re-runs after L.map() finishes

  // Re-style when hover changes
  useEffect(() => {
    hoveredIdRef.current = hoveredId;
    applyStyles();
  }, [hoveredId, applyStyles]);

  // What a focus frames: the route's whole chain, or every airport on the
  // routes at the focused airport (the airport alone when none touch it).
  const focusKey = selectedId != null ? selectedId : (focusAirport ? `airport:${focusAirport}` : null);
  const focusChain = useMemo(() => {
    if (selectedId != null) {
      const g = routeGroups.find(x => x.key === selectedId);
      return g ? (g.chain?.length >= 2 ? g.chain : [g.origin, g.dest]) : null;
    }
    if (!focusAirport) return null;
    const keys = new Set(airportFocusKeys);
    const pts = new Map();
    for (const g of routeGroups) {
      if (!keys.has(g.key)) continue;
      for (const a of (g.chain?.length >= 2 ? g.chain : [g.origin, g.dest])) if (a) pts.set(a.code, a);
    }
    const self = getAirport(focusAirport);
    if (self) pts.set(self.code, self);
    return pts.size ? [...pts.values()] : null;
  }, [selectedId, focusAirport, airportFocusKeys, routeGroups]);

  // Re-style + fly to the focus when it changes
  useEffect(() => {
    selectedIdRef.current = selectedId;
    focusKeysRef.current = new Set(airportFocusKeys);
    applyStyles();

    // routeGroups is a dependency (the focused route's coordinates live there),
    // so this effect also fires on the weekly tick. Fly once per focus — and
    // never while the flat map is hidden under the globe (see claimRouteFly).
    const map = mapRef.current;
    const visible = mapView === 'flat' && !!map && map.getSize().x > 0;
    const focusChanged = claimRouteFly(flownToRef, focusKey, visible);
    if (!focusChanged || !map || !window.L) return;
    if (!focusChain) { flownToRef.current = null; return; }
    // Frame the WHOLE rotation — flying to the endpoints of MCI–JFK–ORY can
    // leave the stop in the middle off-screen.
    const bounds = window.L.latLngBounds(focusChain.map(a => [a.lat, a.lon]));
    try {
      if (focusChain.length === 1) map.flyTo(bounds.getCenter(), Math.max(map.getZoom(), 4), { duration: 0.8 });
      else map.flyToBounds(bounds, { padding: [90, 90], maxZoom: 6, duration: 0.8 });
    } catch { /* a fly is never worth the page */ }
  }, [selectedId, focusKey, focusChain, airportFocusKeys, routeGroups, applyStyles, mapView]);

  // A focused airport that leaves the network (its last route closed) clears.
  useEffect(() => {
    if (focusAirport && !airportSet.some(a => a.code === focusAirport)) setFocusAirportRaw(null);
  }, [airportSet, focusAirport]);

  // Globe input — the same groups, colours and tooltips the flat map draws,
  // with the overlay toggles and airport filter already applied. Only built
  // while the globe is showing.
  const globeData = useMemo(() => {
    if (mapView !== 'globe') return null;
    const showPartner = (p) => (p.type === 'alliance' ? showAlliance : showCodeshare)
      && (airportFilter === 'all' || p.chain.some(a => a.code === airportFilter));
    return buildGlobeData({
      routes: routeGroups.map(g => ({
        id: g.key,
        chain: g.chain?.length >= 2 ? g.chain : [g.origin, g.dest],
        color: routeGroupColor(g),
        tip: routeTipHtml(g),
      })),
      cargo: showCargo ? cargoGroups.map(g => ({
        id: `cargo:${g.key}`, chain: [g.origin, g.dest], color: CARGO_COLOR, tip: cargoTipHtml(g),
      })) : [],
      partners: partnerRouteData.filter(showPartner).map((p, i) => ({
        id: `partner:${i}`, chain: p.chain, color: p.color, tip: partnerTipHtml(p),
      })),
      airports: airportSet.map(a => {
        const h = hubs[a.code];
        return { code: a.code, lat: a.lat, lon: a.lon, hub: !!h,
                 core: h ? hubMarkerSize(h.tier).core : 5, tip: airportTipHtml(a, h ?? null) };
      }),
    });
  }, [mapView, routeGroups, cargoGroups, showCargo, partnerRouteData, showAlliance, showCodeshare,
      airportFilter, airportSet, hubs]);

  // Planes: one per flying tail, on the same groups (and so the same filters)
  // as the lines. Only built while the globe is showing with planes on.
  const flightPlans = useMemo(() => {
    if (mapView !== 'globe' || !showPlanes) return null;
    return tailFlightPlans({
      groups: routeGroups, cargoGroups: showCargo ? cargoGroups : [],
      fleet, month: gd.month, colorOf: routeGroupColor, cargoColor: CARGO_COLOR,
      weeks: airlineWeeks({ fleet, routes, cargoRoutes }, gd.month),
    });
  }, [mapView, showPlanes, routeGroups, cargoGroups, showCargo, fleet, routes, cargoRoutes, gd.month]);

  // The world's clock (multiplayer only), as primitives so a poll that
  // changes nothing doesn't restart the globe's animation.
  const gc = remoteChrome?.gameClock ?? null;
  const clockSpec = useMemo(() => (gc
    ? { nextTickAt: gc.nextTickAt, weeksPerDay: gc.weeksPerDay, preStart: !!gc.preStart, week: state.week }
    : null), [gc?.nextTickAt, gc?.weeksPerDay, gc?.preStart, state.week]);

  const globeHome = useMemo(() => getAirport(hub) ?? airportSet[0] ?? null, [hub, airportSet]);
  const globeFocus = focusChain;

  // Full-bleed is the map-first layout's background, so it always draws the
  // world — a new airline still needs a map to look at.
  const noRoutes = routes.length === 0 && cargoRoutes.length === 0;
  if (noRoutes && !fullBleed) {
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        <div className="empty-state-icon"><Glyph e="🗺️" /></div>
        <div className="empty-state-text">No routes yet.</div>
        <div style={{ marginTop: 8, fontSize: 13 }}>Open routes to see your network on the map.</div>
      </div>
    );
  }

  const selectedData = selectedId != null ? routeGroups.find(x => x.key === selectedId) : null;

  // Flat map / globe, and Satellite / Dark. Shared by the Map tab's header and
  // the full-bleed map's floating controls.
  const viewToggles = (
    <>
      <div className="map-view-toggle" role="group" aria-label="Map view">
        {[['flat', 'Map'], ['globe', 'Globe']].map(([v, label]) => (
          <button
            key={v}
            className={mapView === v ? 'active' : ''}
            aria-pressed={mapView === v}
            onClick={() => setMapView(v)}
            title={v === 'globe' ? 'Show your network on a 3D globe' : 'Show the flat map'}
          >{label}</button>
        ))}
      </div>
      <div className="map-view-toggle" role="group" aria-label="Map style">
        {[['satellite', 'Satellite'], ['dark', 'Dark']].map(([v, label]) => (
          <button
            key={v}
            data-basemap={v}
            className={basemap === v ? 'active' : ''}
            aria-pressed={basemap === v}
            onClick={() => setBasemap(v)}
            title={v === 'satellite' ? 'NASA Blue Marble satellite imagery' : 'Dark map with coastlines and borders'}
          >{label}</button>
        ))}
      </div>
    </>
  );

  // The map itself — the globe sits in front; the flat map stays mounted
  // underneath so switching back keeps its zoom.
  const mapBody = (
    <>
    {mapView === 'globe' && (
      <GlobeMap
        data={globeData}
        height={mapHeight}
        home={globeHome}
        selectedId={selectedId}
        hoveredId={hoveredId}
        focusChain={globeFocus}
        focusKey={focusKey}
        focusIds={airportFocusKeys}
        onHover={setHoveredId}
        onSelect={setSelectedId}
        onSelectAirport={toggleAirportFocus}
        onFallback={() => setMapView('flat')}
        flights={flightPlans}
        clock={clockSpec}
        planeColors={planeColors}
        basemap={basemap}
        paused={paused}
      />
    )}
    <div style={{ display: mapView === 'globe' ? 'none' : 'block' }}>
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
    </>
  );

  // Map-first layout: the map IS the screen. No card, no route table — the
  // Routes page has the table — just the map and a small floating control row.
  if (fullBleed) {
    return (
      <div ref={bleedRef} className={showLabels ? 'map-bleed' : 'map-bleed map-labels-off'}>
        {mapBody}
        {noRoutes && (
          <div className="map-bleed-hint">No routes yet — tap <strong>Search</strong> to find your first one.</div>
        )}
        <div className="map-bleed-controls">
          {viewToggles}
          <button
            className={`map-bleed-chip${showLabels ? ' on' : ''}`}
            aria-pressed={showLabels}
            onClick={() => setShowLabels(v => !v)}
            title={showLabels ? 'Hide the airport codes' : 'Show the airport codes'}
          >ABC</button>
          {mapView === 'globe' && (
            <button
              className={`map-bleed-chip${showPlanes ? ' on' : ''}`}
              aria-pressed={showPlanes}
              onClick={() => setShowPlanes(v => !v)}
              title={showPlanes ? 'Hide the planes in the air' : 'Show your planes in the air'}
            ><Glyph e="✈" /></button>
          )}
          {selectedId != null && (
            <button className="map-bleed-chip on" onClick={clearFocus}>
              <Glyph e="✕" /> Focus
            </button>
          )}
          {focusAirport && (
            <button className="map-bleed-chip on" data-airport-focus={focusAirport} onClick={clearFocus}
              title={`Stop highlighting ${focusAirport}'s routes`}>
              <Glyph e="✕" /> {focusAirport} · {airportFocusKeys.length} route{airportFocusKeys.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Map card */}
      <div className={showLabels ? 'card' : 'card map-labels-off'} style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        {/* Header */}
        <div style={{
          padding: '12px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Route Network</span>
            <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--text-muted)' }}>
              {routeGroups.length} route{routeGroups.length !== 1 ? 's' : ''} · {airportSet.length} airports{filtersActive && <span style={{ color: 'var(--accent)' }}> · filtered</span>}
              {selectedData && (
                <span style={{ color: 'var(--accent)' }}> · focused {(selectedData.chain ?? [selectedData.origin, selectedData.dest]).map(a => a.code).join('→')}</span>
              )}
              {focusAirport && (
                <span style={{ color: 'var(--accent)' }}> · {focusAirport}: {airportFocusKeys.length} route{airportFocusKeys.length === 1 ? '' : 's'}</span>
              )}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)', alignItems: 'center', flexWrap: 'wrap' }}>
            {viewToggles}
            {/* Filters: aircraft type + airport */}
            {typesInUse.length > 1 && (
              <select
                className="form-select"
                value={acTypeFilter}
                onChange={e => setAcTypeFilter(e.target.value)}
                style={{ width: 'auto', fontSize: 11, padding: '3px 6px', maxWidth: 160 }}
                title="Only show routes flown by this aircraft type"
              >
                <option value="all">Aircraft: All</option>
                {typesInUse.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            {airportOptions.length > 1 && (
              <select
                className="form-select"
                value={airportFilter}
                onChange={e => setAirportFilter(e.target.value)}
                style={{ width: 'auto', fontSize: 11, padding: '3px 6px', maxWidth: 160 }}
                title="Only show routes touching this airport"
              >
                <option value="all">Airport: All</option>
                {airportOptions.map(a => <option key={a.code} value={a.code}>{a.code} — {a.city}</option>)}
              </select>
            )}
            {filtersActive && (
              <button
                onClick={() => { setAcTypeFilter('all'); setAirportFilter('all'); }}
                className="map-clear-btn"
                title="Clear map filters"
              >
                <Glyph e="✕" /> Filters
              </button>
            )}
            {(selectedId != null || focusAirport) && (
              <button
                onClick={clearFocus}
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
            {routeGroups.some(g => g.multi) && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }} title="A multi-stop rotation, drawn through every stop it serves">
                <span style={{ width: 18, height: 2, background: TAG_COLOR, display: 'inline-block', borderRadius: 1 }} />
                Multi-stop
              </span>
            )}
            <span
              style={{ display: 'flex', alignItems: 'center', gap: 5 }}
              title="Gold pins mark every station you've designated — focus cities, hubs and gateways alike"
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: HUB_COLOR, display: 'inline-block' }} />
              {hubCodes.length > 1 ? 'Hubs' : 'Hub'}
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

            {/* Planes toggle — globe only */}
            {mapView === 'globe' && (
              <button
                onClick={() => setShowPlanes(v => !v)}
                aria-pressed={showPlanes}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  opacity: showPlanes ? 1 : 0.4, transition: 'opacity 0.15s',
                  color: 'var(--text-muted)', fontSize: 11,
                }}
                title={showPlanes ? 'Hide the planes in the air' : 'Show your planes in the air'}
              >
                <Glyph e="✈" /> Planes
              </button>
            )}

            {/* Airport code labels — both views */}
            <button
              onClick={() => setShowLabels(v => !v)}
              aria-pressed={showLabels}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                opacity: showLabels ? 1 : 0.4, transition: 'opacity 0.15s',
                color: 'var(--text-muted)', fontSize: 11,
              }}
              title={showLabels ? 'Hide the airport codes (hover an airport to see it)' : 'Show the airport codes'}
            >
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 9, color: '#6fb0f0', letterSpacing: '.05em' }}>ABC</span>
              Labels
            </button>

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

        {mapBody}
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
                    <strong style={g.multi ? { color: TAG_COLOR } : undefined}>
                      {(g.chain ?? [g.origin, g.dest]).map(a => a.code).join(' → ')}
                    </strong>
                    {g.aircraftCount > 1 && (
                      <span className="ac-badge">{g.aircraftCount}×</span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    {g.multi
                      ? `${g.origin.city} → ${g.dest.city} · ${(g.chain?.length ?? 2) - 1} legs`
                      : `${g.origin.city} → ${g.dest.city}`}
                  </td>
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
