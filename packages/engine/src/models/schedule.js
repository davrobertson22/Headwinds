// Weekly flight schedule — when each aircraft's rotations leave.
//
// The simulation runs on weekly frequency; nothing in the tick reads a time of
// day. This module gives the frequency a timetable for the things that SHOW
// one — the schedule editor, the departure board and the planes on the globe —
// so all three agree.
//
// A route's `schedule.starts` holds the rotations the player has PINNED, as
// minutes into the week (UTC, Monday 00:00 = 0). Every rotation not pinned is
// placed automatically in the aircraft's free time, so a player who never
// opens the editor still gets a full, sensible week, and a player who pins a
// few gets the rest flowed around them. One rotation = every leg out and every
// leg back (each leg: flight + turnaround), exactly the block time the engine
// charges, so a tail's week can never hold more than the block-hour cap.
//
// Pure and deterministic — same state, same timetable on every client.

import { sectorTaxiHours } from '../utils/market.js';
import {
  routeStops, routeDistanceKm, cruiseSpeedKmh, turnaroundHours, isRouteActive,
} from '../utils/simulation.js';
import { getAirport } from '../data/airports.js';
import { getAircraftType } from '../data/aircraft.js';
import { utcOffsetMinutes } from '../data/timezones.js';

export const WEEK_MIN = 7 * 24 * 60;   // 10080
export const SNAP_MIN = 5;

export const wrapWeek = (m) => ((Math.round(m) % WEEK_MIN) + WEEK_MIN) % WEEK_MIN;
export const snapMin = (m, step = SNAP_MIN) => wrapWeek(Math.round(m / step) * step);

/** Pinned starts, cleaned: whole minutes in [0, WEEK_MIN), distinct, sorted,
 *  at most `freq` of them. Anything unusable is dropped. */
export function normalizeStarts(starts, freq = Infinity) {
  if (!Array.isArray(starts)) return [];
  const out = [...new Set(starts
    .map(Number)
    .filter(Number.isFinite)
    .map(wrapWeek))].sort((a, b) => a - b);
  return out.slice(0, Math.max(0, Math.floor(freq)));
}

/** A route's rotation for an aircraft type: legs out then back, in minutes. */
export function routeRotation(route, type) {
  const stops = routeStops(route);
  if (stops.length < 2 || !type) return null;
  const speed = cruiseSpeedKmh(type);
  const turnMin = Math.round(turnaroundHours(type) * 60);
  const out = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const km = routeDistanceKm(stops[i], stops[i + 1]);
    if (!(km > 0)) return null;
    out.push({ from: stops[i], to: stops[i + 1], km });
  }
  const back = [...out].reverse().map(l => ({ from: l.to, to: l.from, km: l.km }));
  const legs = [...out, ...back].map(l => ({
    // Gate to gate: v2 adds taxi/climb/approach time per sector (0 classic).
    ...l, flightMin: Math.max(1, Math.round((l.km / speed + sectorTaxiHours(type)) * 60)), turnMin,
  }));
  const durMin = legs.reduce((s, l) => s + l.flightMin + l.turnMin, 0);
  return { stops, legs, durMin };
}

// ── Cyclic intervals ──────────────────────────────────────────────────────────
/** Do [a, a+da) and [b, b+db) overlap on the week's circle? */
export function overlaps(a, da, b, db) {
  const d = wrapWeek(b - a);           // b's start, measured from a
  return d < da || d + db > WEEK_MIN;  // b starts inside a, or b wraps into a
}

const fitsAmong = (start, dur, placed) => placed.every(p => !overlaps(start, dur, p.start, p.dur));

/** Interleave routes by frequency (Bresenham): the order rotations come round
 *  in a week, so a 14× and a 7× route alternate 2:1 instead of bunching. */
function interleave(items) {
  const total = items.reduce((s, it) => s + it.count, 0);
  const used = items.map(() => 0);
  const order = [];
  for (let k = 0; k < total; k++) {
    let best = -1, bestDeficit = -Infinity;
    items.forEach((it, i) => {
      if (used[i] >= it.count) return;
      const deficit = (it.count * (k + 1)) / total - used[i];
      if (deficit > bestDeficit + 1e-9) { best = i; bestDeficit = deficit; }
    });
    used[best]++;
    order.push(best);
  }
  return order;
}

/**
 * One aircraft's week.
 *   routes: every route this tail flies this month (passenger and cargo), each
 *           { id, origin, destination, stops?, weeklyFrequency, schedule? }
 *   type:   its aircraft type
 *   seed:   the aircraft id (staggers its automatic departures)
 *   staggerMin: explicit 0–180 min stagger (airlineWeeks spreads tails that
 *           share a first route evenly, so they never leave together)
 * Returns {
 *   blocks:   [{ key, routeId, start, dur, legs, pinned }] sorted by start
 *   overflow: [{ routeId, count }] auto rotations that found no room (only when
 *             pins are packed so tightly the rest can't fit)
 *   demoted:  [{ routeId, start }] pins dropped because they overlap an
 *             earlier pin (e.g. after the route moved to a busier tail)
 *   busyMin, anchor
 * }
 */
/** Stable 0..1 from a string (FNV-1a) — staggers tails that share a pair. */
export function seedUnit(str) {
  let h = 0x811c9dc5;
  for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  // Murmur3 finaliser: FNV alone leaves 'tail-1' and 'tail-2' a hair apart in
  // the high bits, i.e. the same five-minute slot.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/** Code-point order. NOT localeCompare: route ids are base-36 and a Danish or
 *  Norwegian browser sorts "aa" after "z", which would give the same airline a
 *  different timetable on different devices. */
export const byCodePoint = (a, b) => { const x = String(a), y = String(b); return x < y ? -1 : x > y ? 1 : 0; };

export function aircraftWeek(routes, type, seed = '', staggerMin = null) {
  const items = [];
  for (const r of [...(routes ?? [])].sort((a, b) => byCodePoint(a.id, b.id))) {
    const f = Math.max(0, Math.floor(Number(r.weeklyFrequency) || 0));
    if (f <= 0) continue;
    const rot = routeRotation(r, type);
    if (!rot) continue;
    items.push({ route: r, rot, count: f, pins: normalizeStarts(r.schedule?.starts, f) });
  }
  const blocks = [], demoted = [], overflow = [];
  if (!items.length) return { blocks, overflow, demoted, busyMin: 0, anchor: 0 };

  // 1. Pins first, in route order; one that collides with an earlier pin is
  //    demoted to automatic rather than drawn on top of it.
  for (const it of items) {
    it.kept = [];
    for (const s of it.pins) {
      if (fitsAmong(s, it.rot.durMin, blocks)) {
        blocks.push(block(it, s, true, it.kept.length));
        it.kept.push(s);
      } else demoted.push({ routeId: it.route.id, start: s });
    }
  }

  // 2. The ideal automatic week: every rotation in interleaved order, evenly
  //    spaced, the first leaving between 06:00 and 09:00 local at the first
  //    route's origin — staggered per tail so two aircraft on one pair don't
  //    leave together.
  const order = interleave(items);
  const busy = items.reduce((s, it) => s + it.rot.durMin * it.count, 0);
  const gap = Math.max(0, (WEEK_MIN - busy) / order.length);
  const origin = getAirport(items[0].rot.stops[0]);
  const stagger = Number.isFinite(staggerMin) ? staggerMin : seedUnit(seed) * 180;
  const anchor = snapMin(6 * 60 + stagger - utcOffsetMinutes(origin));
  const ideal = items.map(() => []);
  let t = anchor;
  for (const i of order) {
    ideal[i].push(snapMin(t));
    t += items[i].rot.durMin + gap;
  }

  // 3. Each route's unpinned rotations take its ideal slots, minus the slot
  //    nearest each pin (a pin replaces the automatic flight closest to it),
  //    then slide forward to the first free time if a pin is in the way.
  items.forEach((it, i) => {
    const slots = [...ideal[i]];
    for (const p of it.kept) {
      let bi = 0, bd = Infinity;
      slots.forEach((s, j) => {
        const d = Math.min(wrapWeek(s - p), wrapWeek(p - s));
        if (d < bd) { bd = d; bi = j; }
      });
      slots.splice(bi, 1);
    }
    let missing = 0;
    for (const s of slots) {
      const at = firstFit(s, it.rot.durMin, blocks);
      if (at == null) { missing++; continue; }
      blocks.push(block(it, at, false, blocks.filter(b => b.routeId === it.route.id).length));
    }
    if (missing) overflow.push({ routeId: it.route.id, count: missing });
  });

  blocks.sort((a, b) => a.start - b.start);
  return { blocks, overflow, demoted, busyMin: busy, anchor };
}

function block(it, start, pinned, n) {
  return {
    key: `${it.route.id}#${pinned ? 'p' : 'a'}${start}`,
    routeId: it.route.id, start, dur: it.rot.durMin, legs: it.rot.legs, stops: it.rot.stops,
    pinned, n,
  };
}

/** First start at or after `s` (5-minute steps, round the week once) where a
 *  `dur`-minute block fits among `placed`; null if nowhere. */
export function firstFit(s, dur, placed) {
  for (let k = 0; k < WEEK_MIN; k += SNAP_MIN) {
    const at = wrapWeek(s + k);
    if (fitsAmong(at, dur, placed)) return at;
  }
  return null;
}

/** The flight `b` refers to in `week` — matched by route and start, never by
 *  object identity: the editor's week is rebuilt on every state change (a
 *  poll, a decision echo), so a block captured at pointerdown is a stale copy
 *  by the time it's dropped (audit, 2026-10-14). */
export function findBlock(week, b) {
  if (!b) return null;
  return week.blocks.find(x => x.routeId === b.routeId && x.start === b.start) ?? null;
}

/** The block a move replaces: the one dragged (as it is in `week`), or —
 *  dropped in from the tray — the route's automatic flight nearest the drop. */
export function replacedBlock(week, routeId, from, to) {
  if (from) return findBlock(week, from);
  const autos = week.blocks.filter(b => b.routeId === routeId && !b.pinned);
  if (!autos.length) return null;
  const dist = (s) => Math.min(wrapWeek(s - to), wrapWeek(to - s));
  return autos.reduce((m, b) => (dist(b.start) < dist(m.start) ? b : m));
}

/**
 * Can a `dur`-minute rotation of `routeId` move to `start`? `from` is the
 * block being moved (null for a tray drop). Pins block it, and so do the
 * route's own other flights — editing a route pins all of them where they
 * are (pinsAfterMove). Other routes' automatic flights flow around it.
 */
export function canPlace(week, routeId, dur, start, from = null) {
  const skip = replacedBlock(week, routeId, from, start);
  if (from && !skip) return false;   // that flight isn't in this week any more
  return week.blocks
    .filter(b => b !== skip && (b.pinned || b.routeId === routeId))
    .every(b => !overlaps(start, dur, b.start, b.dur));
}

/**
 * The new pinned starts for a route after a move. `from` is the block being
 * moved (null when dragging one in from the tray).
 *
 * Editing a route pins the whole route as it is shown, with just the moved
 * flight changed. Pinning only the moved flight let the automatic placement
 * re-pick which automatic flight it replaced — the one nearest the DROP, not
 * the one dragged — so dragging Monday's flight to Wednesday could leave
 * Monday in place and delete Wednesday's (review, 2026-10-14). A tray drop
 * replaces the automatic flight nearest where it lands.
 */
export function pinsAfterMove(week, routeId, from, to) {
  const gone = replacedBlock(week, routeId, from, to);
  const mine = week.blocks.filter(b => b.routeId === routeId);
  const overflow = week.overflow.find(o => o.routeId === routeId)?.count ?? 0;
  // Refuse rather than guess: a dragged flight that's gone, or a tray drop
  // with no automatic flight to take the place of.
  if (from && !gone) return null;
  if (!from && !gone && overflow === 0) return null;
  const starts = mine.filter(b => b !== gone).map(b => b.start);
  const next = normalizeStarts([...starts, to]);
  return next.length <= mine.length + overflow ? next : null;
}

/** Pins for a route with one block unpinned. */
export function pinsAfterUnpin(week, routeId, start) {
  return normalizeStarts(week.blocks.filter(b => b.routeId === routeId && b.pinned && b.start !== start)
    .map(b => b.start));
}

/** Every leg's departure, as { routeId, from, to, utcMin } — for the board. */
export function weekDepartures(week) {
  const out = [];
  // `rotation` is the flight's place in its route's week and `leg` its sector,
  // a stable identity for the board's flight numbers.
  const nth = {};
  for (const b of week.blocks) {
    const rotation = (nth[b.routeId] = (nth[b.routeId] ?? -1) + 1);
    let t = b.start;
    b.legs.forEach((l, leg) => {
      out.push({ routeId: b.routeId, from: l.from, to: l.to, utcMin: wrapWeek(t), pinned: b.pinned, rotation, leg });
      t += l.flightMin + l.turnMin;
    });
  }
  return out;
}

/**
 * Every tail's week for an airline state, keyed by aircraft id. Routes dormant
 * this month (seasonal) don't fly, so they take no time. A reserve covering a
 * grounded tail already carries the route under its own id.
 */
export function airlineWeeks(state, month) {
  const byAc = new Map();
  for (const r of [...(state?.routes ?? []), ...(state?.cargoRoutes ?? [])]) {
    if (!r?.aircraftId || !isRouteActive(r, month)) continue;
    if (!byAc.has(r.aircraftId)) byAc.set(r.aircraftId, []);
    byAc.get(r.aircraftId).push(r);
  }
  // Tails whose week starts on the same route pair would hash to only 37
  // five-minute staggers — six SYD–MEL tails collided a third of the time.
  // Spread each such group evenly across the 06:00–09:00 wave instead.
  const pairOf = (routes) => {
    const r = [...routes].sort((a, b) => byCodePoint(a.id, b.id))
      .find(x => (Number(x.weeklyFrequency) || 0) > 0);
    return r ? [r.origin, r.destination].sort().join('~') : '';
  };
  const groups = new Map();
  for (const [acId, routes] of byAc) {
    const k = pairOf(routes);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(acId);
  }
  // Each tail keeps its own hashed five-minute slot in the wave and only
  // probes onward on a collision, so adding or retiring one aircraft doesn't
  // reshuffle every other tail on the pair (an earlier rank-based spread did).
  const SLOTS = 36;
  const stagger = new Map();
  for (const ids of groups.values()) {
    ids.sort(byCodePoint);
    const used = new Set();
    for (const id of ids) {
      if (used.size >= SLOTS) used.clear();
      let s = Math.floor(seedUnit(id) * SLOTS);
      while (used.has(s)) s = (s + 1) % SLOTS;
      used.add(s);
      stagger.set(id, s * 5);
    }
  }
  const weeks = new Map();
  for (const [acId, routes] of byAc) {
    const ac = (state.fleet ?? []).find(a => a.id === acId);
    const type = ac ? getAircraftType(ac.typeId) : null;
    if (!type) continue;
    weeks.set(acId, cachedWeek(routes, type, acId, stagger.get(acId)));
  }
  return weeks;
}

// Weeks are rebuilt on every state change (polls re-hydrate routes), but a
// tail's week only changes when its routes do. Reusing the same object for the
// same inputs keeps the editor's memoised rows (and the board, and the globe)
// from redoing work for 99 aircraft when one flight moved.
const WEEK_CACHE = new Map();
const WEEK_CACHE_MAX = 4000;
function cachedWeek(routes, type, seed, staggerMin) {
  const sig = [type.id, seed, staggerMin ?? '', ...routes.map(r => [
    r.id, r.weeklyFrequency, routeStops(r).join('-'), (r.schedule?.starts ?? []).join('.'),
  ].join(':'))].join('|');
  const hit = WEEK_CACHE.get(sig);
  if (hit) return hit;
  const w = aircraftWeek(routes, type, seed, staggerMin);
  if (WEEK_CACHE.size >= WEEK_CACHE_MAX) WEEK_CACHE.delete(WEEK_CACHE.keys().next().value);
  WEEK_CACHE.set(sig, w);
  return w;
}
