// loyaltyMapCore.js — the Loyalty layer on the Network map (flat and globe).
//
// One circle per city the airline flies or holds members in (the Loyalty
// page's city table, engine loyaltyCityTable): sized by how many frequent
// flyers live there, filled by how many of them carry YOUR card, ringed green
// when your members there are growing toward target and red when they are
// draining. Dashed: the city is shopping around (after a devaluation or the
// December requalification). Pure — no DOM, no Leaflet, no MapLibre — so the
// two renderers and the tests read the same points.

import { getAirport } from '../data/airports.js';
import { loyaltyPoolAnchor } from '../models/loyaltyPools.js';

export const LOYALTY_MAP_KEY = 'hw_map_loyalty';
export const LOYALTY_FILL = '#bc8cff';
export const LOYALTY_EMPTY = '#5e7088';
export const LOYALTY_UP = '#38d39f';
export const LOYALTY_DOWN = '#ff5d6c';
export const LOYALTY_FLAT = '#e6edf7';

const BIG_POOL = 1_600_000;   // New York's frequent flyers: the biggest circle

const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Math.round(n ?? 0).toLocaleString();
const pct = (x, d = 0) => `${((x ?? 0) * 100).toFixed(d)}%`;

/** Circle radius in screen pixels, 8–34, by the square root of the pool — big
 *  enough to read as a city around the airport pin, not a glow on it. */
export function loyaltyRadius(poolSize) {
  return Math.max(8, Math.min(34, 8 + 26 * Math.sqrt(Math.max(0, poolSize) / BIG_POOL)));
}

/** Fill opacity by your share of the city's flyers: faint at 0, solid from 15%
 *  (holding 15% of a city's frequent flyers is a strong position). */
export function loyaltyFillOpacity(share) {
  return +(0.18 + 0.62 * Math.min(1, Math.max(0, share) / 0.15)).toFixed(3);
}

/** Ring colour: growing, draining or holding. */
export function loyaltyTrend(row, programOn) {
  const target = programOn && row.seats > 0 ? row.target : 0;
  if (target > row.members * 1.02 + 1) return 'up';
  if (target < row.members * 0.98 - 1) return 'down';
  return 'flat';
}

export function loyaltyTipHtml(row, programOn) {
  const trend = loyaltyTrend(row, programOn);
  const rivals = (row.rivals ?? []).slice(0, 3).map(r =>
    `<div class="map-tip-sub">${esc(r.name)}: ${num(r.members)} (${pct(r.members / row.poolSize, 1)})</div>`).join('');
  const heading = !(row.seats > 0) ? 'not flown — members drifting away'
    : !programOn ? 'program closed — members drifting away'
    : `heading for ${num(row.target)}${trend === 'up' ? ' ↑' : trend === 'down' ? ' ↓' : ''}`;
  return `
    <div class="map-tip">
      <div class="map-tip-title" style="color:${LOYALTY_FILL}">${esc(row.name)}${row.shopping ? ' <span style="font-size:10px;color:#ffb43d">SHOPPING AROUND</span>' : ''}</div>
      <div class="map-tip-sub">You: ${num(row.members)} members (${pct(row.share, 1)} of ${num(row.poolSize)} frequent flyers) · ${num(row.elites)} elite</div>
      <div class="map-tip-sub">${heading}</div>
      ${rivals ? `<div class="map-tip-sub" style="margin-top:4px;font-weight:600">Rival programs</div>${rivals}` : ''}
    </div>
  `;
}

/** The points both renderers draw. */
export function loyaltyMapPoints(rows, programOn) {
  const out = [];
  for (const r of rows ?? []) {
    if (!(r.members > 0) && !(r.seats > 0)) continue;
    const ap = getAirport(loyaltyPoolAnchor(r.pool));
    if (!ap) continue;
    const trend = loyaltyTrend(r, programOn);
    out.push({
      id: `loyalty:${r.pool}`, pool: r.pool, lat: ap.lat, lon: ap.lon,
      radius: +loyaltyRadius(r.poolSize).toFixed(2),
      fill: r.members > 0 ? LOYALTY_FILL : LOYALTY_EMPTY,
      fillOpacity: loyaltyFillOpacity(r.share),
      stroke: trend === 'up' ? LOYALTY_UP : trend === 'down' ? LOYALTY_DOWN : LOYALTY_FLAT,
      dashed: !!r.shopping,
      tip: loyaltyTipHtml(r, programOn),
    });
  }
  // Big cities first, so a small city on top of a big one stays clickable.
  return out.sort((a, b) => b.radius - a.radius);
}
