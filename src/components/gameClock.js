// Game clock — the in-game time of day between weekly ticks, and the sun.
//
// Headwinds simulates in whole weeks, but a world's week takes real time to
// pass (24h ÷ weeksPerDay). The clock spreads that week across its real
// interval so the game has a time of day: Monday 00:00 when a week lands,
// Sunday 23:59 just before the next one. It is cosmetic — nothing in the
// simulation happens on a Tuesday afternoon — and it is derived only from what
// the countdown already knows (when the next week lands, and the pace), so it
// needs nothing new from the tick.
//
// Game time is UTC. Airports carry no time zones, and the globe's day/night
// shading makes local time visible anyway.
//
// React-free, DOM-free: tools/game-clock-test.mjs imports it directly.

export const WEEK_HOURS = 168;
const DAY_MS = 86_400_000;
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Real milliseconds per game week at this pace. */
export const tickIntervalMs = (weeksPerDay) => DAY_MS / weeksPerDay;

/** Game seconds per real second at this pace (a week is 7 days). */
export const gameRate = (weeksPerDay) => 7 * weeksPerDay;

// The clock never reads past Sunday 23:59. A late tick holds it there
// ("closing the books") rather than running into a week that hasn't landed.
const LAST_MINUTE = 1 - 1 / (WEEK_HOURS * 60);

/**
 * Where the world is in its current week at real time `nowMs`.
 *   spec: { nextTickAt, weeksPerDay, preStart }
 * Returns null when the pace or the next tick is unknown (an ended world, an
 * old server, the solo game). A scheduled world that hasn't started is parked
 * at Monday 00:00.
 *
 *   fraction   0..LAST_MINUTE through the week (clamped)
 *   weekHours  fraction × 168
 *   rawHours   unclamped and wrapped into [0, 168) — keeps moving through a late
 *              tick, for things that must not freeze mid-air (the planes)
 *   rate       game seconds per real second
 *   overdue    the next week is due but hasn't landed yet
 */
export function gameClockAt(nowMs, spec) {
  const wpd = Number(spec?.weeksPerDay);
  const next = spec?.nextTickAt ? new Date(spec.nextTickAt).getTime() : NaN;
  if (!(wpd > 0) || !Number.isFinite(next) || !Number.isFinite(nowMs)) return null;
  const rate = gameRate(wpd);
  if (spec.preStart) {
    return { fraction: 0, weekHours: 0, rawHours: 0, rate, overdue: false, frozen: true };
  }
  const raw = 1 - (next - nowMs) / tickIntervalMs(wpd);
  const fraction = Math.min(Math.max(raw, 0), LAST_MINUTE);
  return {
    fraction,
    weekHours: fraction * WEEK_HOURS,
    // Before the week (client clock behind the server's): hold at Monday 00:00
    // like the clock does, rather than wrapping to late in the week.
    rawHours: raw < 0 ? 0 : (((raw * WEEK_HOURS) % WEEK_HOURS) + WEEK_HOURS) % WEEK_HOURS,
    rate,
    overdue: nowMs >= next,
    frozen: false,
  };
}

/** Minutes the readout steps by, so it changes about once a real second at
 *  most. At 96 weeks/day a game minute passes in under a tenth of a second; a
 *  ticking minutes digit would just be a blur. */
export function clockStepMinutes(rate) {
  const perSecond = (rate ?? 0) / 60;
  for (const step of [1, 5, 10, 15, 30]) if (perSecond <= step) return step;
  return 60;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "Tue 14:45" for a clock from gameClockAt (null → ''). */
export function formatGameClock(clock) {
  if (!clock) return '';
  const day = Math.min(6, Math.floor(clock.weekHours / 24));
  const step = clockStepMinutes(clock.rate);
  // The epsilon keeps float dust (10079.9999…) from reading Sun 23:59 as 23:58.
  const minsInDay = Math.floor(((clock.weekHours - day * 24) * 60 + 1e-6) / step) * step;
  return `${WEEKDAYS[day]} ${pad2(Math.floor(minsInDay / 60))}:${pad2(minsInDay % 60)}`;
}

// ── The sun ───────────────────────────────────────────────────────────────────
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * The subsolar point — where the sun is straight overhead — for game week
 * `week` (1–52) at `weekHours` into it (UTC). The game's year is 52 weeks;
 * it's stretched to 365.25 days so June is northern summer.
 * Declination uses the standard cosine fit (±0.5°); longitude ignores the
 * equation of time (≤ 4°). Both are invisible at globe scale.
 */
export function sunPosition(week, weekHours) {
  const w = Math.min(52, Math.max(1, Math.floor(Number(week) || 1)));
  const dayOfYear = ((w - 1) * 7 + weekHours / 24) * (365.25 / 364);
  const lat = -23.44 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365.25);
  const utcHours = ((weekHours % 24) + 24) % 24;
  let lon = -15 * (utcHours - 12);
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return { lat, lon };
}

/** Sun elevation in degrees above the horizon at (lat, lon). */
export function sunElevationDeg(lat, lon, sun) {
  const φ = lat * D2R, δ = sun.lat * D2R, H = (lon - sun.lon) * D2R;
  const s = Math.sin(φ) * Math.sin(δ) + Math.cos(φ) * Math.cos(δ) * Math.cos(H);
  return Math.asin(Math.max(-1, Math.min(1, s))) * R2D;
}

// ── Night overlay ─────────────────────────────────────────────────────────────
// A small raster laid over the whole world (Web Mercator rows, so MapLibre can
// stretch it between the corner coordinates without distortion), transparent
// in daylight and darkening through twilight. A raster rather than polygons:
// twilight is a gradient, and near the equinoxes the twilight band around the
// terminator doesn't reach either pole, which a "terminator → pole" polygon
// can't draw.
export const MERC_MAX_LAT = 85.0511287798;
export const NIGHT_COORDINATES = [
  [-180, MERC_MAX_LAT], [180, MERC_MAX_LAT], [180, -MERC_MAX_LAT], [-180, -MERC_MAX_LAT],
];
export const NIGHT_RGB = [2, 6, 18];
export const NIGHT_MAX_ALPHA = 0.55;
// Daylight fades out from +2° (the sun just above the horizon) to full night
// at −12° (nautical dusk).
const DUSK_START = 2, DUSK_END = -12;

/** Night opacity 0..1 for a sun elevation in degrees. */
export function nightAlpha(elevationDeg) {
  const t = Math.min(1, Math.max(0, (DUSK_START - elevationDeg) / (DUSK_START - DUSK_END)));
  return NIGHT_MAX_ALPHA * t * t * (3 - 2 * t);
}

/** Latitude at the centre of mercator row `j` of `height`. */
export function mercRowLat(j, height) {
  const y = Math.PI * (1 - (2 * (j + 0.5)) / height);
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * R2D;
}

/** RGBA pixels (row-major, Web Mercator rows from 85°N down) for the night
 *  overlay with the sun at `sun`. */
export function nightOverlayPixels(sun, width = 256, height = 256) {
  const px = new Uint8ClampedArray(width * height * 4);
  const [r, g, b] = NIGHT_RGB;
  for (let j = 0; j < height; j++) {
    const lat = mercRowLat(j, height);
    for (let i = 0; i < width; i++) {
      const lon = -180 + (360 * (i + 0.5)) / width;
      const k = (j * width + i) * 4;
      px[k] = r; px[k + 1] = g; px[k + 2] = b;
      px[k + 3] = Math.round(255 * nightAlpha(sunElevationDeg(lat, lon, sun)));
    }
  }
  return px;
}

/** How often (real ms) the night overlay is worth redrawing: whenever the sun
 *  has moved about half an overlay pixel (two game minutes), within 0.2–30 s. */
export function nightRefreshMs(rate) {
  const ms = (120 / Math.max(rate || 0, 1e-6)) * 1000;
  return Math.min(30_000, Math.max(200, ms));
}
