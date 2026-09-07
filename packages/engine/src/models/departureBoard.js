/**
 * departureBoard.js — a real departure board for any airport in the world.
 *
 * Asked for on Discord (2026-09-07): "Departure Board at the airports screen …
 * basically utilize the routes that are running and airlines logo."
 *
 * Every airline flying out of an airport is already in state: the player's own
 * `routes` (with `weeklyFrequency`), and every competitor's `routes` map keyed
 * `AAA-BBB` with a frequency and an aircraft type. Two things a real board has
 * that the game does not model are DEPARTURE TIMES and FLIGHT NUMBERS — the
 * schedule is weekly frequency, not a timetable.
 *
 * So both are SYNTHESISED, and the one hard rule is that they are synthesised
 * deterministically. This board is shown in a multiplayer world where two
 * players look at the same airport; if the times drifted per client it would
 * read as a bug, and it must survive a reload unchanged. Everything here is a
 * pure function of (world seed, airport, airline, route, day) through `hash32`
 * — no Math.random, no Date.now, no state.
 *
 * Nothing in this module feeds the tick. It is a view of existing state.
 */

// ─── Deterministic hashing ───────────────────────────────────────────────────

/** FNV-1a, 32-bit. Same string in, same number out, on every client forever. */
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Hash to a float in [0,1). */
function hashUnit(str) {
  return hash32(str) / 0x100000000;
}

/** Hash to an integer in [min, max]. */
function hashRange(str, min, max) {
  return min + Math.floor(hashUnit(str) * (max - min + 1));
}

// ─── Airline codes ───────────────────────────────────────────────────────────

// Real boards show a two-letter code, and it is most of what makes a flight
// number look like a flight number. Derived from the airline's name so it is
// stable for the life of the world, then de-duplicated ACROSS THE WORLD in a
// fixed order — two airlines sharing "AA" on the same board is the one thing
// that would give the synthesis away.

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** First-guess two-letter code from a name: initials, else first two letters. */
function codeSeed(name) {
  const words = String(name ?? '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]);
  const w = words[0] ?? 'XX';
  return (w[0] ?? 'X') + (w[1] ?? 'X');
}

/**
 * Assign every airline in the world a unique two-letter code.
 * `airlines` is [{ id, name }]; order must be stable (it is — competitors are a
 * fixed list and the player is pinned first).
 */
export function assignAirlineCodes(airlines) {
  const used = new Set();
  const out = {};
  for (const a of airlines ?? []) {
    let code = codeSeed(a.name);
    if (used.has(code)) {
      // Walk the second letter, then the first, deterministically.
      let found = null;
      for (let i = 0; i < 26 && !found; i++) {
        const c = code[0] + CODE_ALPHABET[i];
        if (!used.has(c)) found = c;
      }
      for (let i = 0; i < 26 && !found; i++) {
        const c = CODE_ALPHABET[i] + code[1];
        if (!used.has(c)) found = c;
      }
      code = found ?? code;
    }
    used.add(code);
    out[a.id] = code;
  }
  return out;
}

// ─── Schedule synthesis ──────────────────────────────────────────────────────

/** Minutes after midnight for the earliest and latest departure of the day. */
const DAY_START = 5 * 60 + 30;   // 05:30
const DAY_END   = 22 * 60 + 30;  // 22:30

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * How many of a route's weekly departures fall on `day` (0 = Monday).
 *
 * A 7×/week route flies daily; a 3×/week route flies on three FIXED days that
 * depend on the route, not on the day being viewed — so paging through the week
 * shows a schedule that hangs together instead of a random draw each time.
 * A route flown more than daily gets the extra rotations spread the same way.
 */
export function departuresOnDay(weeklyFrequency, day, seed) {
  const f = Math.max(0, Math.round(Number(weeklyFrequency) || 0));
  if (f <= 0) return 0;
  const base = Math.floor(f / 7);
  const extra = f % 7;
  if (extra === 0) return base;
  // Rotate the week by a per-route offset so different routes pick different
  // days, then take the first `extra` days of that rotation.
  const offset = hash32(`${seed}|days`) % 7;
  const slot = (day - offset + 7) % 7;
  return base + (slot < extra ? 1 : 0);
}

/**
 * Departure times for `count` flights on one route on one day, in minutes.
 *
 * Spread across the operating day rather than bunched: a 2×-daily route gets a
 * morning and an evening rotation, which is what a real short-haul pair looks
 * like. Jitter is hashed so times are odd-looking (07:42, not 07:00) but fixed.
 */
export function departureTimes(count, seed) {
  const n = Math.max(0, Math.floor(count));
  if (n <= 0) return [];
  const span = DAY_END - DAY_START;
  const band = span / n;
  const times = [];
  for (let i = 0; i < n; i++) {
    const jitter = hashUnit(`${seed}|t${i}`) * band * 0.8;
    const t = Math.round(DAY_START + band * i + jitter);
    // Round to 5 minutes — timetables do.
    times.push(Math.min(DAY_END, Math.round(t / 5) * 5));
  }
  return times.sort((a, b) => a - b);
}

/** "07:45" from minutes after midnight. */
export function formatClock(minutes) {
  const m = Math.max(0, Math.round(minutes));
  const hh = String(Math.floor(m / 60) % 24).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * A flight number: airline code + a number stable per route and rotation.
 *
 * `taken` de-duplicates. A hashed number out of ~3,800 collides more often than
 * intuition suggests — a 60-row board has a better-than-even chance of printing
 * the same flight number twice — so on a clash we walk deterministically to the
 * next free number rather than shrugging at the birthday problem.
 */
export function flightNumber(code, seed, index, taken) {
  const base = hashRange(`${seed}|fn${index}`, 100, 3899);
  let n = base;
  if (taken) {
    for (let step = 0; step < 3800 && taken.has(`${code}${n}`); step++) {
      n = 100 + ((n - 100 + 1) % 3800);
    }
    taken.add(`${code}${n}`);
  }
  return `${code}${n}`;
}

/** A gate label. Terminal letter is per-airline-at-airport, stand is per route. */
export function gateLabel(airportCode, airlineId, seed) {
  const terminal = 'ABCD'[hash32(`${airportCode}|${airlineId}|term`) % 4];
  const stand = hashRange(`${seed}|gate`, 1, 42);
  return `${terminal}${stand}`;
}

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Flight status from the operator's on-time rate.
 *
 * This is the payoff for putting the board in the game at all: an airline that
 * is understaffed or has angry crews visibly runs late, on a screen everyone can
 * see, including its rivals. `onTimeRate` is 0-1; unknown reads as 0.82.
 */
export function flightStatus(onTimeRate, seed) {
  const otp = Number.isFinite(onTimeRate) ? Math.max(0, Math.min(1, onTimeRate)) : 0.82;
  const roll = hashUnit(`${seed}|status`);
  if (roll < otp) return { key: 'ontime', label: 'On Time', delayMins: 0 };
  // Everything past the on-time line is a delay, and a small slice of the worst
  // of it is a cancellation — an operation at 50% OTP is not merely late.
  const severity = (roll - otp) / Math.max(0.01, 1 - otp);
  if (severity > 0.92) return { key: 'cancelled', label: 'Cancelled', delayMins: 0 };
  const delay = 10 + Math.round(severity * 110);
  return { key: 'delayed', label: `Delayed ${delay}m`, delayMins: delay };
}

// ─── Board ───────────────────────────────────────────────────────────────────

/**
 * Build the board.
 *
 * @param {object} o
 * @param {string} o.airport        airport code to show departures FROM
 * @param {number} o.day            0-6, Monday-based
 * @param {string} o.worldSeed      anything stable per world (id, or name+year)
 * @param {object[]} o.carriers     [{ id, name, isPlayer, logoId, logoColor,
 *                                     customLogo, onTimeRate, legs: [{ to,
 *                                     weeklyFrequency, typeId, typeName }] }]
 * @returns {object[]} rows sorted by scheduled time
 */
export function buildDepartureBoard({ airport, day = 0, worldSeed = 'w', carriers = [] }) {
  const codes = assignAirlineCodes(carriers.map(c => ({ id: c.id, name: c.name })));
  const taken = new Set();
  const rows = [];
  for (const c of carriers) {
    for (const leg of c.legs ?? []) {
      const routeSeed = `${worldSeed}|${airport}|${c.id}|${leg.to}`;
      const n = departuresOnDay(leg.weeklyFrequency, day, routeSeed);
      if (n <= 0) continue;
      const daySeed = `${routeSeed}|d${day}`;
      const times = departureTimes(n, daySeed);
      times.forEach((time, i) => {
        const rowSeed = `${daySeed}|${i}`;
        rows.push({
          time,
          timeLabel:   formatClock(time),
          flightNo:    flightNumber(codes[c.id] ?? 'XX', routeSeed, i, taken),
          destination: leg.to,
          airlineId:   c.id,
          airlineName: c.name,
          isPlayer:    !!c.isPlayer,
          logoId:      c.logoId,
          logoColor:   c.logoColor,
          customLogo:  c.customLogo,
          typeId:      leg.typeId,
          typeName:    leg.typeName,
          gate:        gateLabel(airport, c.id, routeSeed),
          ...flightStatus(c.onTimeRate, rowSeed),
        });
      });
    }
  }
  return rows.sort((a, b) => a.time - b.time || a.flightNo.localeCompare(b.flightNo));
}
