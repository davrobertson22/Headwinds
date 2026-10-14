// Planes on the globe — where each aircraft is at a given moment of the week.
//
// The game schedules nothing finer than "N round trips a week", so the planes
// are a plausible picture of that, not a timetable the tick reads. Each tail
// flies its route's frequency as evenly spaced rotations: every leg out, every
// leg back, with the type's real cruise speed and turnaround (the same numbers
// the engine charges block hours with). A tail is one plane, so the sky never
// holds more aircraft than the fleet has, and the block-hour cap keeps a tail's
// rotations from overlapping.
//
// Speed: planes run on the game clock when the world is slow enough to look
// like flying (≤ 24 weeks/day: an hour's hop takes ≥ 21 real seconds). Faster
// worlds would turn short-haul into a swarm, so above that the planes keep the
// 24-weeks/day speed on their own wrapped clock and drift from the game clock.
//
// React-free: tools/flights-core-test.mjs imports it directly.

import { WEEK_HOURS } from './gameClock.js';

/** Fastest game-seconds-per-real-second the planes are shown at (24 wk/day). */
export const PLANE_MAX_RATE = 168;

/** The planes' rate at this world's game rate (no world → the cap). */
export const planeRate = (gameRate) =>
  (gameRate > 0 ? Math.min(gameRate, PLANE_MAX_RATE) : PLANE_MAX_RATE);

/**
 * Hours into the week the planes are drawn at.
 *   clock: from gameClockAt (or null)
 * On the game clock when it's slow enough; otherwise a free-running clock at
 * PLANE_MAX_RATE from real time, so planes keep moving smoothly through a late
 * tick and never jump.
 */
export function planeWeekHours(nowMs, clock) {
  if (clock && !clock.frozen && clock.rate <= PLANE_MAX_RATE) return clock.rawHours;
  if (clock?.frozen) return 0;
  const h = (nowMs / 1000) * PLANE_MAX_RATE / 3600;
  return ((h % WEEK_HOURS) + WEEK_HOURS) % WEEK_HOURS;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Stable 0..1 from a string — spreads departures of different tails. */
export function hash01(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/** Point a fraction `f` of the way along the great circle a → b ({lat, lon}). */
export function slerp(a, b, f) {
  const φ1 = a.lat * D2R, λ1 = a.lon * D2R, φ2 = b.lat * D2R, λ2 = b.lon * D2R;
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (d < 1e-9) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return { lat: Math.atan2(z, Math.hypot(x, y)) * R2D, lon: Math.atan2(y, x) * R2D };
}

/** Initial compass bearing (0 = north, clockwise) from a to b. */
export function bearingDeg(a, b) {
  const φ1 = a.lat * D2R, φ2 = b.lat * D2R, Δλ = (b.lon - a.lon) * D2R;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * R2D) + 360) % 360;
}

/**
 * One tail's week, ready to sample.
 *   id         unique per tail (the route id)
 *   group      the map line it belongs to (for focus/hover)
 *   stops      [{ code, lat, lon }] in visiting order (≥ 2)
 *   legKm      distance of each outbound leg (stops.length − 1 values)
 *   weeklyFrequency  round trips a week
 *   cruiseKmh, turnaroundH  the type's speed and ground time
 * Returns null for a tail that doesn't fly (no frequency, bad data).
 */
export function buildFlightPlan({
  id, group, color, tip = '', stops, legKm, weeklyFrequency, cruiseKmh, turnaroundH,
}) {
  const f = Math.floor(Number(weeklyFrequency) || 0);
  if (f <= 0 || !Array.isArray(stops) || stops.length < 2 || !(cruiseKmh > 0)) return null;
  const out = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const km = legKm?.[i] ?? 0;
    if (!(km > 0)) return null;
    out.push({ from: stops[i], to: stops[i + 1], km });
  }
  const back = [...out].reverse().map(l => ({ from: l.to, to: l.from, km: l.km }));
  const turn = Math.max(0, turnaroundH ?? 0);
  const legs = [...out, ...back].map(l => ({ ...l, flightH: l.km / cruiseKmh, turnH: turn }));
  const rotationH = legs.reduce((s, l) => s + l.flightH + l.turnH, 0);
  const slotH = Math.max(WEEK_HOURS / f, rotationH);
  // First departure around 06:00 local at the origin (solar time), plus up to
  // three hours' jitter so tails sharing a pair don't fly in formation.
  const localSix = 6 - stops[0].lon / 15;
  const phase = ((((localSix + hash01(id) * 3) % slotH) + slotH) % slotH);
  return { id, group, color, tip, legs, rotationH, slotH, phase };
}

/**
 * Where a plan's aircraft is at `weekHours`: null on the ground, else
 * { lat, lon, heading, leg, progress }.
 */
export function planePosition(plan, weekHours) {
  if (!plan) return null;
  let t = (((weekHours - plan.phase) % plan.slotH) + plan.slotH) % plan.slotH;
  if (t >= plan.rotationH) return null;
  for (let i = 0; i < plan.legs.length; i++) {
    const l = plan.legs[i];
    if (t < l.flightH) {
      const p = t / l.flightH;
      const here = slerp(l.from, l.to, p);
      // Heading along the path: toward a point just ahead (or away from one
      // just behind, on the last stretch, where "ahead" is the airport itself).
      const heading = p < 0.995
        ? bearingDeg(here, slerp(l.from, l.to, Math.min(1, p + 0.005)))
        : (bearingDeg(slerp(l.from, l.to, p - 0.005), here));
      return { lat: here.lat, lon: here.lon, heading, leg: i, progress: p };
    }
    t -= l.flightH;
    if (t < l.turnH) return null;
    t -= l.turnH;
  }
  return null;
}

/** GeoJSON of every airborne plane at `weekHours`. */
export function planesGeoJSON(plans, weekHours) {
  const features = [];
  for (const plan of plans ?? []) {
    const pos = planePosition(plan, weekHours);
    if (!pos) continue;
    const l = plan.legs[pos.leg];
    features.push({
      type: 'Feature',
      properties: {
        id: plan.id, group: plan.group, color: plan.color, heading: pos.heading,
        tip: plan.tip ? `${plan.tip}<div class="map-tip-sub">${l.from.code ?? ''} → ${l.to.code ?? ''} · ${Math.round(pos.progress * 100)}% of the way</div>` : '',
      },
      geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Real ms between plane redraws: about half a screen pixel of movement at
 *  this zoom, between 1/30 s and 2 s. (MapLibre's world is 512·2^z px round.) */
export function planeRefreshMs(rate, zoom, cruiseKmh = 840) {
  const kmPerRealSec = (cruiseKmh * rate) / 3600;
  const kmPerPx = 40075 / (512 * 2 ** (zoom ?? 1));
  const pxPerSec = kmPerRealSec / kmPerPx;
  if (!(pxPerSec > 0)) return 2000;
  return Math.min(2000, Math.max(33, 500 / pxPerSec));
}
