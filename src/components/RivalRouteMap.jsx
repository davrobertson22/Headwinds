import { useEffect, useRef, useState } from 'react';
import { getAirport } from '../data/airports.js';
import { getAircraftType } from '../data/aircraft.js';
import { referencePrice } from '../utils/simulation.js';
import {
  segmentsForRoute, loadLeaflet, createDarkMap,
  HUB_COLOR, CARGO_COLOR, RIVAL_COLOR, CONTESTED_COLOR,
} from './mapCore.js';

// Rival route map — a competitor's published network drawn on the same basemap
// as your own.
//
// Deliberately NOT a copy of RouteMap with different inputs. Your own map colours
// lines by profit; a rival's profit is private, so the only fact this map can
// honestly assert about a line is whether YOU fly that pair too. Hence two
// colours: slate for their network, amber for the pairs where you meet them.
//
// Props rather than context: the same component is mounted inline in every
// rival's panel on the Rivals tab and again inside the rival dossier, and those
// two callers hold their rival data in different places.

/** Pair key used by every rival-facing surface: sorted IATA codes, hyphenated.
 *  Matches the server's pairKeyOf() and buildPlayerPairMap(). */
export const pairKey = (a, b) => [a, b].sort().join('-');

/**
 * Fold a rival's published passenger + freight networks into drawable links and
 * the airport set they touch. Pure — exported so a test can assert the network
 * derivation without a DOM, a map, or Leaflet.
 *
 * @param routes          rival's passenger routes, keyed "AAA-BBB"
 * @param cargoRoutes     rival's freight lanes, same key shape (absent for solo AI)
 * @param hubs            IATA codes to draw as hub markers
 * @param playerRouteMap  YOUR passenger pairs, keyed "AAA-BBB"
 * @param playerCargoKeys YOUR freight pairs, as an iterable of "AAA-BBB"
 */
export function buildRivalNetwork({
  routes = {}, cargoRoutes = {}, hubs = [], playerRouteMap = {}, playerCargoKeys = [],
} = {}) {
  const cargoKeys = new Set(playerCargoKeys);
  const links = [];
  const codes = new Set();

  const add = (key, cfg, cargo) => {
    const [a, b] = key.split('-');
    const origin = getAirport(a);
    const dest = getAirport(b);
    // An airport the client's data doesn't know (older save, renamed code) is
    // skipped rather than drawn at 0,0 in the Gulf of Guinea.
    if (!origin || !dest) return;
    codes.add(origin.code);
    codes.add(dest.code);
    links.push({
      key, cfg, cargo, origin, dest,
      contested: cargo ? cargoKeys.has(key) : key in playerRouteMap,
    });
  };

  for (const [key, cfg] of Object.entries(routes ?? {})) add(key, cfg, false);
  for (const [key, cfg] of Object.entries(cargoRoutes ?? {})) add(key, cfg, true);

  const hubSet = new Set(hubs.filter(Boolean));
  for (const h of hubSet) codes.add(h);

  const airports = [...codes].map(getAirport).filter(Boolean)
    .map((a) => ({ ...a, isHub: hubSet.has(a.code) }));

  // Contested first so the lines that matter draw on top of the ones that don't.
  links.sort((x, y) => Number(x.contested) - Number(y.contested));

  return {
    links,
    airports,
    passengerCount: links.filter((l) => !l.cargo).length,
    cargoCount: links.filter((l) => l.cargo).length,
    contestedCount: links.filter((l) => l.contested).length,
  };
}

/**
 * Everything the map DRAWS OR ASSERTS, as a string — the redraw trigger.
 *
 * Split into two halves on purpose:
 *   `content` — geometry AND every number the tooltip states as fact. It must
 *               cover the whole tooltip, not just the lines' shape: a rival who
 *               cuts a fare or re-rates a freight lane without touching
 *               frequency changes nothing about where the line sits, but makes
 *               the tooltip's "$480 · 104% vs ref" a lie until it redraws.
 *   `extent`  — the airport set alone, which is what decides the viewport. Kept
 *               separate so a fare change redraws the layers WITHOUT yanking the
 *               map back from wherever the player had panned it.
 */
export function networkSignature(links = [], airports = []) {
  const content = links.map((l) => {
    const c = l.cfg ?? {};
    const ac = (c.aircraftTypes ?? (c.aircraftType ? [c.aircraftType] : [])).join('+');
    return [
      l.key, l.cargo ? 'c' : 'p', l.contested ? 1 : 0,
      c.frequency ?? '',
      // passenger tooltip
      c.economyFare ?? '', c.priceMultiplier ?? '', c.seatsPerWeek ?? '', c.seats ?? '',
      // freight tooltip
      c.yieldPrice ?? '', c.tonnesPerWeek ?? '',
      ac,
    ].join('|');
  }).join('~');
  const extent = airports.map((a) => `${a.code}${a.isHub ? '*' : ''}`).join(',');
  return { content, extent, full: `${content}#${extent}` };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

function tooltipFor(link, rivalName) {
  const { origin, dest, cfg, cargo, contested } = link;
  const color = contested ? CONTESTED_COLOR : cargo ? CARGO_COLOR : RIVAL_COLOR;
  const acTypes = cfg?.aircraftTypes ?? (cfg?.aircraftType ? [cfg.aircraftType] : []);
  const ac = acTypes.length
    ? acTypes.map((t) => getAircraftType(t)?.name ?? t).join(', ')
    : '—';

  let stats;
  if (cargo) {
    const rate = cfg?.yieldPrice != null ? `$${cfg.yieldPrice.toFixed(2)}/t-km` : '—';
    const tonnes = cfg?.tonnesPerWeek ? `${Math.round(cfg.tonnesPerWeek).toLocaleString()} t` : '—';
    stats = `
      <div><span class="map-tip-lbl">Freq</span><span class="map-tip-val">${cfg?.frequency ?? 0}×/wk</span></div>
      <div><span class="map-tip-lbl">Capacity</span><span class="map-tip-val">${tonnes}</span></div>
      <div><span class="map-tip-lbl">Rate</span><span class="map-tip-val">${rate}</span></div>
    `;
  } else {
    const refP = referencePrice(origin.code, dest.code);
    const fare = cfg?.economyFare ?? (refP ? Math.round(refP * (cfg?.priceMultiplier ?? 1)) : null);
    const ratio = refP && fare ? Math.round((fare / refP) * 100) : null;
    const seatsWk = cfg?.seatsPerWeek
      ?? (cfg?.seats != null ? cfg.seats * (cfg.frequency ?? 0) : null);
    stats = `
      <div><span class="map-tip-lbl">Fare</span><span class="map-tip-val">${fare != null ? `$${fare}` : '—'}</span></div>
      <div><span class="map-tip-lbl">vs ref</span><span class="map-tip-val">${ratio != null ? `${ratio}%` : '—'}</span></div>
      <div><span class="map-tip-lbl">Freq</span><span class="map-tip-val">${cfg?.frequency ?? 0}×/wk</span></div>
      <div><span class="map-tip-lbl">Seats/wk</span><span class="map-tip-val">${seatsWk != null ? seatsWk.toLocaleString() : '—'}</span></div>
    `;
  }

  return `
    <div class="map-tip">
      <div class="map-tip-title" style="color:${color}">${origin.code} <span class="map-tip-arrow">→</span> ${dest.code}${cargo ? ' <span style="font-size:10px">FREIGHT</span>' : ''}</div>
      <div class="map-tip-sub">${esc(origin.city)} → ${esc(dest.city)} · ${esc(rivalName)}</div>
      <div class="map-tip-stats">${stats}</div>
      <div class="map-tip-sub" style="margin-top:4px">${esc(ac)}</div>
      ${contested ? `<div class="map-tip-hint" style="color:${CONTESTED_COLOR}">⚔ You fly this pair too</div>` : ''}
    </div>
  `;
}

function LegendChip({ color, label, dashed = false }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)' }}>
      <span style={{
        width: 16, height: 0, flexShrink: 0,
        borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}`,
      }} />
      {label}
    </span>
  );
}

export default function RivalRouteMap({
  routes = {},
  cargoRoutes = {},
  hubs = [],
  playerRouteMap = {},
  playerCargoKeys = [],
  name = 'Rival',
  height = 300,
}) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef([]);
  // Airport set the viewport was last fitted to — see the fitBounds call below.
  const fittedExtentRef = useRef(null);
  const [ready, setReady] = useState(!!window.L);
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState(null);

  // Derived every render on purpose. The callers rebuild `playerRouteMap` (and
  // the hub array) fresh each time, so memoising on object identity would never
  // hit — and worse, the redraw effect below would fire on every parent render
  // and rebuild every Leaflet layer. Instead the derivation is cheap and the
  // expensive part (layer sync) keys off a content signature.
  const { links, airports, cargoCount, contestedCount } =
    buildRivalNetwork({ routes, cargoRoutes, hubs, playerRouteMap, playerCargoKeys });
  const isEmpty = links.length === 0;

  // The layer-sync effect keys off this, so it redraws when the rival's network
  // changes and stays put when the parent merely re-rendered.
  const { content: signature, extent } = networkSignature(links, airports);

  // 1. Leaflet (shared loader — never fetches the library twice, however many
  //    rival panels the player opens).
  useEffect(() => {
    if (window.L) { setReady(true); return; }
    let alive = true;
    loadLeaflet()
      .then(() => { if (alive) setReady(true); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  // 2. Init map. This component is only mounted while its panel is actually
  //    open, so a page of twenty rivals costs zero map instances until the
  //    player asks for one.
  useEffect(() => {
    if (!ready || isEmpty || !mapElRef.current || mapRef.current) return;
    const L = window.L;
    const map = createDarkMap(mapElRef.current, { zoomControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    mapRef.current = map;
    setMapReady(true);
    return () => {
      map.remove();
      mapRef.current = null;
      // A fresh map instance starts with no viewport of its own, so the next
      // draw must fit it even if the network is unchanged.
      fittedExtentRef.current = null;
      setMapReady(false);
    };
  }, [ready, isEmpty]);

  // 3. Draw the network.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;

    layersRef.current.forEach((l) => map.removeLayer(l));
    layersRef.current = [];

    for (const link of links) {
      const { origin, dest, cargo, contested } = link;
      const color = contested ? CONTESTED_COLOR : cargo ? CARGO_COLOR : RIVAL_COLOR;
      const segments = segmentsForRoute(origin.lat, origin.lon, dest.lat, dest.lon);
      const tip = tooltipFor(link, name);

      for (const pts of segments) {
        if (contested) {
          // Contested pairs get the glow your own map gives a live route — this
          // is the one thing a player opens a rival's map to find.
          const glow = L.polyline(pts, {
            color, weight: 9, opacity: 0.18, lineCap: 'round',
            smoothFactor: 1, interactive: false, className: 'route-glow',
          });
          glow.addTo(map);
          layersRef.current.push(glow);
        }

        // Visible line — non-interactive, so its dash gaps can never punch holes
        // in the mouse hit region (the flicker bug the main map hit).
        const line = L.polyline(pts, {
          color,
          weight: contested ? 2.6 : 1.6,
          opacity: contested ? 0.95 : 0.6,
          dashArray: cargo ? '5, 6' : null,
          lineCap: 'round',
          smoothFactor: 1,
          interactive: false,
          className: 'route-line',
        });
        line.addTo(map);
        layersRef.current.push(line);

        // Invisible, always-solid hit corridor on top.
        const hit = L.polyline(pts, {
          color: '#000', weight: 18, opacity: 0, lineCap: 'round',
          smoothFactor: 1, interactive: true, bubblingMouseEvents: false,
          className: 'route-hit',
        });
        hit.bindTooltip(tip, { sticky: true, className: 'game-tooltip', offset: [15, 0] });
        hit.on('mouseover', () => line.setStyle({ weight: contested ? 4 : 3, opacity: 1 }));
        hit.on('mouseout', () => line.setStyle({
          weight: contested ? 2.6 : 1.6,
          opacity: contested ? 0.95 : 0.6,
        }));
        hit.addTo(map);
        layersRef.current.push(hit);
      }
    }

    for (const airport of airports) {
      const marker = L.circleMarker([airport.lat, airport.lon], {
        radius: airport.isHub ? 6 : 3.5,
        fillColor: airport.isHub ? HUB_COLOR : RIVAL_COLOR,
        color: airport.isHub ? HUB_COLOR : '#c7d6ea',
        weight: airport.isHub ? 2 : 1,
        fillOpacity: airport.isHub ? 1 : 0.85,
      });
      marker.bindTooltip(
        `<div class="map-tip"><div class="map-tip-title">${airport.code}</div>`
        + `<div class="map-tip-sub">${esc(airport.city)}, ${esc(airport.country)}`
        + `${airport.isHub ? ` <span style="color:${HUB_COLOR}">● HUB</span>` : ''}</div></div>`,
        { className: 'game-tooltip', offset: [10, 0] },
      );
      marker.addTo(map);
      layersRef.current.push(marker);

      if (airport.isHub) {
        const label = L.marker([airport.lat, airport.lon], {
          icon: L.divIcon({
            className: 'airport-label',
            html: `<span>${airport.code}</span>`,
            iconAnchor: [-9, 4],
          }),
          interactive: false,
          zIndexOffset: 500,
        });
        label.addTo(map);
        layersRef.current.push(label);
      }
    }

    // Fit ONLY when the set of airports changed — i.e. the network genuinely
    // grew or shrank. Re-fitting on every redraw would rip the viewport back to
    // the whole network the moment a rival nudged a fare, while the player was
    // zoomed into the two lanes they came here to read.
    if (airports.length > 0 && fittedExtentRef.current !== extent) {
      fittedExtentRef.current = extent;
      map.fitBounds(L.latLngBounds(airports.map((a) => [a.lat, a.lon])), {
        padding: [30, 30], maxZoom: 5,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, extent, name, mapReady]);

  // Leaflet caches container size; a panel that opens into a freshly-sized box
  // must be told to remeasure or it tiles into stale dimensions.
  useEffect(() => {
    if (mapRef.current) mapRef.current.invalidateSize();
  }, [height, mapReady]);

  if (isEmpty) {
    return (
      <div style={{
        height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, color: 'var(--text-muted)', background: 'var(--surface2)', borderRadius: 8,
      }}>
        {name} has no routes open yet.
      </div>
    );
  }

  return (
    <div>
      <div style={{ position: 'relative', height, borderRadius: 8, overflow: 'hidden', background: '#0b1017' }}>
        <div ref={mapElRef} style={{ position: 'absolute', inset: 0 }} />
        {error && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 12, color: 'var(--text-muted)', padding: 16, textAlign: 'center',
          }}>
            Map unavailable — {error}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
        <LegendChip color={RIVAL_COLOR} label="Their network" />
        <LegendChip
          color={CONTESTED_COLOR}
          label={contestedCount ? `Contested with you (${contestedCount})` : 'Contested with you'}
        />
        {cargoCount > 0 && <LegendChip color={CARGO_COLOR} label={`Freight (${cargoCount})`} dashed />}
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          <span style={{ color: HUB_COLOR }}>●</span> hub
        </span>
      </div>
    </div>
  );
}
