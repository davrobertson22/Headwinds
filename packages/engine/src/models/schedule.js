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
//
// Hub-bank worlds (state.hubBanksWorld) are the exception to "cosmetic": there
// every designated hub runs on banks (waves of arrivals, then departures), the
// automatic week aims each rotation at them, and the network tick reads the
// real connection times from this timetable (hubTimetable) instead of assuming
// every flight connects in 1.5 h. Elsewhere none of the bank code runs and the
// week is exactly what it always was.

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

export function aircraftWeek(routes, type, seed = '', staggerMin = null, bank = null) {
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
  // Hub-bank world and this tail flies through a banked hub: the banked week.
  // Otherwise the code below, unchanged.
  if (bank?.ctx) {
    for (const it of items) it.banked = !bank.cargoIds?.has(it.route.id) && touchesBanks(it.rot, bank.ctx);
    if (items.some(it => it.banked)) return bankedWeek(items, seed, staggerMin, bank.ctx);
  }

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
  // In a banked week a rotation's length depends on when it leaves (it may sit
  // at the far end to make the next bank), so ask the week.
  dur = week.durAt?.(routeId, start) ?? dur;
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
  const ctx = bankContextOf(state);
  const bank = ctx ? { ctx, cargoIds: new Set((state?.cargoRoutes ?? []).map(r => r?.id)) } : null;
  const weeks = new Map();
  for (const [acId, routes] of byAc) {
    const ac = (state.fleet ?? []).find(a => a.id === acId);
    const type = ac ? getAircraftType(ac.typeId) : null;
    if (!type) continue;
    weeks.set(acId, cachedWeek(routes, type, acId, stagger.get(acId), bank));
  }
  return weeks;
}

/** The fields of a game state the timetable reads — what callers pass to
 *  airlineWeeks when they don't hand it the whole state. */
export function scheduleInputsOf(state) {
  return {
    fleet: state?.fleet ?? [], routes: state?.routes ?? [], cargoRoutes: state?.cargoRoutes ?? [],
    hubs: state?.hubs, hubBanks: state?.hubBanks, hubBanksWorld: state?.hubBanksWorld,
  };
}

// Weeks are rebuilt on every state change (polls re-hydrate routes), but a
// tail's week only changes when its routes do. Reusing the same object for the
// same inputs keeps the editor's memoised rows (and the board, and the globe)
// from redoing work for 99 aircraft when one flight moved.
const WEEK_CACHE = new Map();
const WEEK_CACHE_MAX = 4000;
function cachedWeek(routes, type, seed, staggerMin, bank = null) {
  const sig = [type.id, seed, staggerMin ?? '', bank?.ctx?.sig ?? '', ...routes.map(r => [
    r.id, r.weeklyFrequency, routeStops(r).join('-'), (r.schedule?.starts ?? []).join('.'),
    bank?.cargoIds?.has(r.id) ? 'c' : '',
  ].join(':'))].join('|');
  const hit = WEEK_CACHE.get(sig);
  if (hit) return hit;
  const w = aircraftWeek(routes, type, seed, staggerMin, bank);
  if (WEEK_CACHE.size >= WEEK_CACHE_MAX) WEEK_CACHE.delete(WEEK_CACHE.keys().next().value);
  WEEK_CACHE.set(sig, w);
  return w;
}

// ── Hub banks ─────────────────────────────────────────────────────────────────
// A bank is a time of day at a hub: flights arrive in the hour before it and
// leave in the hour after, so passengers on any inbound make any outbound.
// Hub-bank worlds only (state.hubBanksWorld). A designated hub is banked unless
// the player sets it to Rolling; with no setting it takes a pattern by size.
//
// The player never has to place flights for this: the automatic week aims
// every rotation through a banked hub at a wave (bankedWeek), and an aircraft
// waits at the far end (up to BANK_MAX_WAIT) so it comes back for the next
// one. That waiting is the price of banking — a busy tail fits fewer
// rotations — and the reason Rolling exists.

export const BANK_ARR_LEAD = 50;    // banked arrivals land 50–10 min before the bank
export const BANK_DEP_LAG  = 30;    // banked departures leave 30–70 min after it
export const BANK_SPREAD   = 40;    // per-tail stagger inside a wave (5-min steps)
export const BANK_MAX_WAIT = 240;   // the longest an aircraft sits to make a bank
/** …except overnight: an evening flight may sleep at the outstation (or the
 *  hub) to make the day's FIRST bank — how a first bank gets its arrivals. */
export const BANK_OVERNIGHT_MAX = 14 * 60;
export const CONNECT_MIN   = 40;    // minimum connecting time at a hub
// The longest wait that still sells as a connection. Six hours puts a world
// left on Automatic banks within ~2% of the old every-flight-connects-in-1.5-h
// assumption (contested-balance-probe, 104 wk: cash 1,271M vs 1,293M, revenue
// −0.5%) while a Rolling hub gives up ~10% — banking matters, and a player who
// never opens the editor isn't punished for it. Long waits still cost through
// the connection-time penalty (waitH).
export const CONNECT_MAX   = 360;
/** An arrival "makes" bank B when it lands in B + ARR window; a departure when
 *  it leaves in B + DEP window (minutes). Wider than where the scheduler aims,
 *  so a pin nudged a few minutes still counts. */
export const BANK_ARR_WINDOW = [-75, -10];
export const BANK_DEP_WINDOW = [25, 95];
export const BANK_COUNTS = [3, 4, 6];
/** Bank times, minutes after local midnight. */
export const BANK_PRESETS = {
  3: [7 * 60, 13 * 60, 19 * 60],
  4: [7 * 60, 11 * 60, 15 * 60, 19 * 60],
  6: [6 * 60, 9 * 60, 12 * 60, 15 * 60, 18 * 60, 21 * 60],
};
export const MAX_CUSTOM_BANKS = 8;
/** Custom banks closer than this to the one before are dropped. */
export const MIN_BANK_GAP = 90;

/** Banks a day for a hub left on Automatic: by its tier (0 = focus city). */
export function autoBankCount(tier) { return tier >= 3 ? 6 : tier >= 2 ? 4 : 3; }

/** Custom bank times cleaned: 5-minute steps in a day, sorted, at least
 *  MIN_BANK_GAP apart (round midnight too), at most MAX_CUSTOM_BANKS. */
export function normalizeBankTimes(times) {
  if (!Array.isArray(times)) return [];
  const t = [...new Set(times.map(Number).filter(Number.isFinite)
    .map(m => (((Math.round(m / 5) * 5) % 1440) + 1440) % 1440))].sort((a, b) => a - b);
  const out = [];
  for (const m of t) if (!out.length || m - out[out.length - 1] >= MIN_BANK_GAP) out.push(m);
  while (out.length > 1 && out[0] + 1440 - out[out.length - 1] < MIN_BANK_GAP) out.pop();
  return out.slice(0, MAX_CUSTOM_BANKS);
}

/** A stored hub setting cleaned, or null for Automatic:
 *  { mode: 'rolling' } | { mode: 'banks', count } | { mode: 'banks', times }. */
export function normalizeHubBankSetting(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.mode === 'rolling') return { mode: 'rolling' };
  if (v.mode !== 'banks') return null;
  if (Array.isArray(v.times)) {
    const times = normalizeBankTimes(v.times);
    return times.length ? { mode: 'banks', times } : null;
  }
  const count = Number(v.count);
  return BANK_COUNTS.includes(count) ? { mode: 'banks', count } : null;
}

/** What a hub runs on, for the UI and the scheduler:
 *  { code, mode: 'auto' | 'banks' | 'rolling', times: [local min] (empty when rolling),
 *    utc: [week min] every bank of the week, auto: bool }. null = not a hub,
 *  or not a hub-bank world. */
export function hubBankPlan(state, code) {
  if (state?.hubBanksWorld !== true) return null;
  const tier = state?.hubs?.[code]?.tier;
  if (tier == null) return null;
  const set = normalizeHubBankSetting(state?.hubBanks?.[code]);
  if (set?.mode === 'rolling') return { code, mode: 'rolling', times: [], utc: [], auto: false };
  const times = set?.times ?? BANK_PRESETS[set?.count ?? autoBankCount(tier)];
  const ap = getAirport(code);
  const off = ap ? utcOffsetMinutes(ap) : 0;
  const utc = [], first = [];
  for (let d = 0; d < 7; d++) {
    for (const b of times) utc.push(wrapWeek(d * 1440 + b - off));
    first.push(wrapWeek(d * 1440 + times[0] - off));
  }
  utc.sort((a, b) => a - b);
  first.sort((a, b) => a - b);
  return { code, mode: set ? 'banks' : 'auto', times, utc, first, auto: !set, tier };
}

/** Every banked hub of an airline: { plans: Map(code → plan), sig } or null. */
export function bankContextOf(state) {
  if (state?.hubBanksWorld !== true) return null;
  const plans = new Map();
  for (const code of Object.keys(state?.hubs ?? {}).sort(byCodePoint)) {
    const p = hubBankPlan(state, code);
    if (p && p.utc.length) plans.set(code, p);
  }
  if (!plans.size) return null;
  const sig = [...plans.values()].map(p => `${p.code}@${p.utc[0]}:${p.times.join('.')}`).join(',');
  return { plans, sig };
}

const touchesBanks = (rot, ctx) => rot.legs.some(l => ctx.plans.has(l.from) || ctx.plans.has(l.to));

/** Minutes from `x` to the next of `utc` (shifted by `shift`), forward round the week. */
function waitFor(utc, shift, x) {
  let best = Infinity;
  for (const b of utc) { const d = wrapWeek(b + shift - x); if (d < best) best = d; }
  return best;
}

/** The wait for the plan's next wave from `x`, or 0 if it's too long to take:
 *  up to BANK_MAX_WAIT for any bank, up to BANK_OVERNIGHT_MAX for a day's first. */
function bankWait(plan, shift, x) {
  const w = waitFor(plan.utc, shift, x);
  if (w <= BANK_MAX_WAIT) return w;
  const wf = waitFor(plan.first ?? [], shift, x);
  return wf === w && w <= BANK_OVERNIGHT_MAX ? w : 0;
}

/** A tail's stagger inside a wave: 0–40 min in 5s, from its airlineWeeks stagger. */
const waveStagger = (staggerMin, seed) => {
  const s = Number.isFinite(staggerMin) ? staggerMin : seedUnit(seed) * 180;
  return Math.floor((s % (BANK_SPREAD + 5)) / 5) * 5;
};

/**
 * A rotation as flown from `start` in a banked network: at a banked hub met
 * mid-rotation the aircraft waits for the next departure wave; at any other
 * stop it waits so it lands at the NEXT banked stop in time for that bank.
 * A wait longer than BANK_MAX_WAIT isn't taken (it flies on and misses).
 * Waits ride in each leg's turnMin (so everything that walks legs stays
 * right) and in waitMin. Without banks, the rotation itself.
 */
export function timedRotation(rot, start, ctx, stagger = 0) {
  if (!ctx || !rot || !touchesBanks(rot, ctx)) return rot;
  const legs = rot.legs, n = legs.length;
  const out = [];
  let t = start, total = 0;
  for (let i = 0; i < n; i++) {
    const l = legs[i];
    const arr = t + l.flightMin;
    let wait = 0;
    if (i < n - 1) {
      const base = arr + l.turnMin;
      const here = ctx.plans.get(l.to);
      if (here) {
        wait = bankWait(here, BANK_DEP_LAG + stagger, base);
      } else {
        let ahead = 0, j = i + 1;
        for (; j < n; j++) {
          ahead += legs[j].flightMin;
          if (ctx.plans.has(legs[j].to)) break;
          ahead += legs[j].turnMin;
        }
        if (j < n) wait = bankWait(ctx.plans.get(legs[j].to), -BANK_ARR_LEAD + stagger, base + ahead);
      }
    }
    out.push(wait ? { ...l, turnMin: l.turnMin + wait, waitMin: wait, ...(wait > BANK_MAX_WAIT ? { overnight: true } : {}) } : l);
    total += wait;
    t = arr + l.turnMin + wait;
  }
  return total ? { ...rot, legs: out, durMin: rot.durMin + total, waitMin: total } : rot;
}

/** Starts that put a rotation's first banked hub on a wave: leaving it just
 *  after a bank when the rotation starts there, else arriving just before. */
export function bankStarts(rot, ctx, stagger = 0) {
  if (!ctx || !rot) return [];
  const p0 = ctx.plans.get(rot.legs[0]?.from);
  if (p0) return [...new Set(p0.utc.map(b => snapMin(b + BANK_DEP_LAG + stagger)))];
  let elapsed = 0;
  for (const l of rot.legs) {
    elapsed += l.flightMin;
    const p = ctx.plans.get(l.to);
    if (p) return [...new Set(p.utc.map(b => snapMin(b - BANK_ARR_LEAD + stagger - elapsed)))];
    elapsed += l.turnMin;
  }
  return [];
}

/** Furthest Snap to bank moves a pinned flight to make a wave. */
const BANK_SHIFT_MAX = 12 * 60;
/** The order days get a tail's rotations (Mon = 0): nested, so a lower
 *  frequency's days are a subset of a higher one's. */
const DAY_ORDER = [0, 3, 5, 1, 6, 2, 4];

function bankedWeek(items, seed, staggerMin, ctx) {
  // Ordered by where they fly, then id: a preview of a route that has no id
  // yet lands where the real one will (code points, never localeCompare).
  items = [...items].sort((a, b) => byCodePoint(a.rot.stops.join('-'), b.rot.stops.join('-')) || byCodePoint(a.route.id, b.route.id));
  const blocks = [], demoted = [], overflow = [];
  const stag = waveStagger(staggerMin, seed);
  const timing = (it, s) => (it.banked ? timedRotation(it.rot, s, ctx, stag) : it.rot);
  const mk = (it, start, pinned) => {
    const r = timing(it, start);
    return {
      key: `${it.route.id}#${pinned ? 'p' : 'a'}${start}`,
      routeId: it.route.id, start, dur: r.durMin, legs: r.legs, stops: r.stops,
      pinned, n: blocks.filter(b => b.routeId === it.route.id).length,
      ...(r.waitMin ? { waitMin: r.waitMin } : {}),
    };
  };
  const fitsAt = (it, s) => fitsAmong(s, timing(it, s).durMin, blocks);
  // A flight that can't be fitted with its bank waits flies without them
  // (`plain`): banking may cost connections, never a flight.
  const mkPlain = (it, start) => ({
    key: `${it.route.id}#a${start}`, routeId: it.route.id, start, dur: it.rot.durMin,
    legs: it.rot.legs, stops: it.rot.stops, pinned: false, n: 0, plain: true,
  });

  // 1. Pins, as in aircraftWeek — each at its own banked length.
  for (const it of items) {
    it.kept = [];
    for (const s of it.pins) {
      if (fitsAt(it, s)) { blocks.push(mk(it, s, true)); it.kept.push(s); }
      else demoted.push({ routeId: it.route.id, start: s });
    }
  }

  // 2. Chain the rest through the waves, a day at a time. Each rotation leaves
  //    on the first wave after the aircraft is back (so it leaves in the bank
  //    it arrived in, and that bank gets both), the day's last one may sleep
  //    out to make tomorrow's first bank, and rotations are spread over days
  //    in a fixed nested order (Mon, Thu, Sat, Tue, Sun, Wed, Fri) so a 3×
  //    spoke flies on days a 4× one also flies — and they connect.
  const left = items.map(it => ({ ...it, count: Math.max(0, it.count - it.kept.length) }));
  const order = interleave(left.filter(it => it.count > 0)).map(i => left.filter(it => it.count > 0)[i]);
  const busy = items.reduce((s, it) => s + it.rot.durMin * it.count, 0);
  const total = order.length;
  const perDay = Array(7).fill(Math.floor(total / 7));
  for (let k = 0; k < total % 7; k++) perDay[DAY_ORDER[k]]++;
  const home = items.map(it => ctx.plans.get(it.rot.stops[0])).find(Boolean);
  const homeAp = getAirport(items[0].rot.stops[0]);
  const dayStart = (d) => home
    ? d * 1440 + home.times[0] - utcOffsetMinutes(getAirport(home.code)) + BANK_DEP_LAG + stag - 60
    : d * 1440 + 5 * 60 - utcOffsetMinutes(homeAp);
  // The day's last departure wave at the home hub: a tail's last rotation of
  // the day goes there (and sleeps out), so the first bank gets arrivals and
  // the last bank departures from every spoke, whatever else the tail does.
  const dayLast = (d) => home
    ? d * 1440 + home.times[home.times.length - 1] - utcOffsetMinutes(getAirport(home.code)) + BANK_DEP_LAG + stag - 5
    : -Infinity;
  const anchor = snapMin(dayStart(0));
  const missing = new Map();
  let k = 0, ready = -Infinity;
  for (let d = 0; d < 7; d++) {
    ready = Math.max(ready, dayStart(d));
    for (let n = 0; n < perDay[d]; n++) {
      const it = order[k++];
      let at = null;
      if (n === perDay[d] - 1 && n > 0 && it.banked) ready = Math.max(ready, dayLast(d));
      if (it.banked) {
        const fwd = (c) => wrapWeek(c - ready);
        const cands = bankStarts(it.rot, ctx, stag).filter(c => fwd(c) < 1440).sort((x, y) => fwd(x) - fwd(y));
        at = cands.find(c => fitsAt(it, c)) ?? null;
      }
      if (at == null) {
        for (let m = 0; m < WEEK_MIN && at == null; m += SNAP_MIN) {
          const c = snapMin(ready + m);
          if (fitsAt(it, c)) at = c;
        }
        if (at != null) { blocks.push(mk(it, at, false)); ready += wrapWeek(at - ready) + blocks[blocks.length - 1].dur; continue; }
      }
      if (at == null && it.banked) {
        for (let m = 0; m < WEEK_MIN; m += SNAP_MIN) {
          const c = snapMin(ready + m);
          if (fitsAmong(c, it.rot.durMin, blocks)) { at = c; break; }
        }
        if (at != null) { blocks.push(mkPlain(it, at)); ready += wrapWeek(at - ready) + it.rot.durMin; continue; }
      }
      if (at == null) { missing.set(it.route.id, (missing.get(it.route.id) ?? 0) + 1); continue; }
      blocks.push(mk(it, at, false));
      ready += wrapWeek(at - ready) + blocks[blocks.length - 1].dur;
    }
  }
  for (const it of items) { const m = missing.get(it.route.id); if (m) overflow.push({ routeId: it.route.id, count: m }); }

  blocks.sort((a, b) => a.start - b.start);
  // Renumber each route's flights in time order (mk numbered them as placed).
  const nth = {};
  for (const b of blocks) b.n = (nth[b.routeId] = (nth[b.routeId] ?? -1) + 1);
  const byId = new Map(items.map(it => [it.route.id, it]));
  return {
    blocks, overflow, demoted, busyMin: busy, anchor, banked: true, stagger: stag,
    waitMin: blocks.reduce((s, b) => s + (b.waitMin ?? 0), 0),
    /** How long a rotation of `routeId` takes if it leaves at `start`. */
    durAt: (routeId, start) => { const it = byId.get(routeId); return it ? timing(it, start).durMin : null; },
    /** The legs of a rotation of `routeId` leaving at `start` (drag previews). */
    legsAt: (routeId, start) => { const it = byId.get(routeId); return it ? timing(it, start).legs : null; },
  };
}

// ── Connections from the timetable ────────────────────────────────────────────

const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };

/**
 * Who meets whom at each hub. `weeks` is airlineWeeks(state, month);
 * `paxIds` the passenger route ids (cargo doesn't connect passengers); `hubs`
 * the airports to index (all when omitted).
 *
 * stats(hub, a, c) → { known, freq, ratio, waitH } for the A–hub–C market,
 * both directions averaged: `freq` is how many times a week a passenger can
 * make it within CONNECT_MIN..CONNECT_MAX (never more than the flights that
 * carry them), `ratio` that as a share of the thinner side's flights, `waitH`
 * the average wait of those that work. known=false
 * when the timetable doesn't fly one of the legs (the tick then keeps its old
 * assumption).
 */
export function hubTimetable(weeks, { paxIds = null, hubs = null } = {}) {
  const arr = new Map(), dep = new Map();  // hub → Map(spoke → sorted week minutes)
  const push = (m, h, sp, v) => {
    let x = m.get(h); if (!x) m.set(h, (x = new Map()));
    let y = x.get(sp); if (!y) x.set(sp, (y = []));
    y.push(v);
  };
  for (const week of weeks?.values?.() ?? []) {
    for (const b of week.blocks) {
      if (paxIds && !paxIds.has(b.routeId)) continue;
      let t = b.start;
      for (const l of b.legs) {
        if (!hubs || hubs.has(l.from)) push(dep, l.from, l.to, wrapWeek(t));
        if (!hubs || hubs.has(l.to)) push(arr, l.to, l.from, wrapWeek(t + l.flightMin));
        t += l.flightMin + l.turnMin;
      }
    }
  }
  for (const m of [arr, dep]) for (const x of m.values()) for (const y of x.values()) y.sort((p, q) => p - q);

  const dir = (hub, a, c) => {
    const A = arr.get(hub)?.get(a), D = dep.get(hub)?.get(c);
    if (!A?.length || !D?.length) return null;
    let good = 0, waitSum = 0;
    const reached = new Set();
    for (const x of A) {
      const y = wrapWeek(x + CONNECT_MIN);
      const i = lowerBound(D, y);
      const d = i < D.length ? D[i] : D[0];
      const wait = CONNECT_MIN + wrapWeek(d - y);
      if (wait > CONNECT_MAX) continue;
      good++; waitSum += wait; reached.add(d);
    }
    // `of`: the most that could connect — the thinner side's flights.
    return { good: Math.min(good, reached.size), count: good, waitSum, of: Math.min(A.length, D.length) };
  };
  const memo = new Map();
  const stats = (hub, a, c) => {
    const k = `${hub}|${a < c ? a : c}|${a < c ? c : a}`;
    const hit = memo.get(k);
    if (hit) return hit;
    const d1 = dir(hub, a, c), d2 = dir(hub, c, a);
    let out;
    if (!d1 || !d2) out = { known: false };
    else {
      const n = d1.count + d2.count;
      out = {
        known: true,
        freq: (d1.good + d2.good) / 2,
        // Share of the possible connections that work. The tick scales the
        // legs' frequency by it, so flights the timetable couldn't fit (a
        // week over-full) don't count against the ones it could.
        ratio: (d1.good + d2.good) / Math.max(1, d1.of + d2.of),
        waitH: (n ? (d1.waitSum + d2.waitSum) / n : CONNECT_MAX) / 60,
      };
    }
    memo.set(k, out);
    return out;
  };
  return { stats, arrivals: arr, departures: dep };
}

/** The network tick's timetable for a hub-bank world, or null elsewhere. */
export function hubTimetableOf(state, month) {
  if (state?.hubBanksWorld !== true) return null;
  const hubs = new Set(Object.keys(state?.hubs ?? {}));
  if (!hubs.size) return null;
  const weeks = airlineWeeks(state, month);
  return hubTimetable(weeks, { paxIds: new Set((state.routes ?? []).map(r => r.id)), hubs });
}

/**
 * One hub's connectivity for the editor's hub panel: weekly connecting options
 * (sum over spoke pairs of stats().freq), the average wait, how many flights
 * make / miss a bank, and the hours aircraft sat waiting for one.
 */
export function hubConnectivity(tt, weeks, plan, { paxIds = null } = {}) {
  const hub = plan?.code;
  const spokes = [...new Set([...(tt?.arrivals.get(hub)?.keys() ?? [])])]
    .filter(s => tt.departures.get(hub)?.has(s)).sort(byCodePoint);
  let options = 0, waitW = 0, markets = 0;
  for (let i = 0; i < spokes.length; i++) {
    for (let j = i + 1; j < spokes.length; j++) {
      const st = tt.stats(hub, spokes[i], spokes[j]);
      if (!st.known || !(st.freq > 0)) continue;
      options += st.freq; waitW += st.freq * st.waitH; markets++;
    }
  }
  const status = bankStatusAt(weeks, plan, { paxIds });
  return {
    hub, spokes: spokes.length, markets,
    options: Math.round(options),
    avgWaitMin: options > 0 ? Math.round((waitW / options) * 60) : null,
    ...status,
  };
}

/** Is week-minute `m` an arrival (or departure) on one of the plan's banks? */
export function onBank(plan, m, kind) {
  if (!plan?.utc?.length) return null;
  const [lo, hi] = kind === 'arr' ? BANK_ARR_WINDOW : BANK_DEP_WINDOW;
  for (const b of plan.utc) {
    const d = wrapWeek(m - b);
    const off = d > WEEK_MIN / 2 ? d - WEEK_MIN : d;   // signed minutes after bank b
    if (off >= lo && off <= hi) return { bank: b, off };
  }
  return null;
}

/** Each banked-hub event of a block: [{ hub, kind: 'arr' | 'dep', at, made, bank }]. */
export function blockHubEvents(block, ctx) {
  const out = [];
  if (!ctx) return out;
  let t = block.start;
  for (const l of block.legs) {
    const pd = ctx.plans.get(l.from);
    if (pd) { const ob = onBank(pd, t, 'dep'); out.push({ hub: l.from, kind: 'dep', at: wrapWeek(t), made: !!ob, bank: ob?.bank ?? null, to: l.to }); }
    const a = t + l.flightMin;
    const pa = ctx.plans.get(l.to);
    if (pa) { const ob = onBank(pa, a, 'arr'); out.push({ hub: l.to, kind: 'arr', at: wrapWeek(a), made: !!ob, bank: ob?.bank ?? null, from: l.from }); }
    t += l.flightMin + l.turnMin;
  }
  return out;
}

function bankStatusAt(weeks, plan, { paxIds = null } = {}) {
  let made = 0, missed = 0, waitMin = 0;
  const missedBlocks = [];
  if (!plan?.utc?.length) return { made, missed, waitHoursPerDay: 0, missedBlocks };
  const ctx = { plans: new Map([[plan.code, plan]]) };
  for (const [acId, week] of weeks ?? []) {
    for (const b of week.blocks) {
      if (paxIds && !paxIds.has(b.routeId)) continue;
      const ev = blockHubEvents(b, ctx);
      if (!ev.length) continue;
      const miss = ev.filter(e => !e.made).length;
      made += ev.length - miss; missed += miss;
      if (miss) missedBlocks.push({ acId, routeId: b.routeId, start: b.start, pinned: b.pinned });
      // Sleeping out overnight costs nothing a day could have used.
      for (const l of b.legs) if (l.waitMin && !l.overnight) waitMin += l.waitMin;
    }
  }
  return { made, missed, waitHoursPerDay: +(waitMin / 60 / 7).toFixed(1), missedBlocks };
}

/**
 * Where a pinned flight should go to make its hub's waves: the bank-aligned
 * start nearest `block.start` that fits the tail's week (other pins and the
 * route's own flights in the way, as a drag would be), or null if none does.
 */
export function snapToBank(week, block, ctx) {
  if (!week?.banked || !ctx || !block) return null;
  const rot = { legs: block.legs.map(l => (l.waitMin ? { ...l, turnMin: l.turnMin - l.waitMin, waitMin: undefined, overnight: undefined } : l)) };
  const starts = bankStarts(rot, ctx, week.stagger ?? 0);
  const dist = (c) => Math.min(wrapWeek(c - block.start), wrapWeek(block.start - c));
  for (const c of [...starts].sort((a, b) => dist(a) - dist(b) || a - b)) {
    if (dist(c) > BANK_SHIFT_MAX) break;
    if (c === block.start) return null;
    if (canPlace(week, block.routeId, block.dur, c, block)) return c;
  }
  return null;
}

/** How many flights a hub event meets: for an arrival, the departures to other
 *  places it can make (CONNECT_MIN..CONNECT_MAX later); for a departure, the
 *  arrivals from other places that make it. `spoke` is the event's own other
 *  end (a passenger doesn't connect back where they came from). */
export function connectionsAt(tt, hub, at, kind, spoke) {
  const m = kind === 'arr' ? tt?.departures.get(hub) : tt?.arrivals.get(hub);
  if (!m) return 0;
  let n = 0;
  for (const [sp, list] of m) {
    if (sp === spoke) continue;
    for (const t of list) {
      const w = kind === 'arr' ? wrapWeek(t - at) : wrapWeek(at - t);
      if (w >= CONNECT_MIN && w <= CONNECT_MAX) n++;
    }
  }
  return n;
}

// ── Typed departure times ─────────────────────────────────────────────────────
// Writing a timetable by hand: the player types clock times, local at the
// route's origin, instead of dragging or nudging each flight. A route's week
// is a few rows — a time and the days it leaves at that time — so a 14×/week
// route is two times typed once, not fourteen flights moved one by one. A
// single flight can also be given a time of its own, on its own day.
//
// Everything here only works out pins; SET_ROUTE_SCHEDULES stores them, so the
// rules above (pins never overlap, automatic flights flow round them) are
// untouched. In a banked week a rotation's length depends on when it leaves
// (it may wait for a bank), so every length here is asked of the week
// (durAt), as canPlace does.

export const DAY_MIN = 24 * 60;

/** Minutes of the day → "07:05". */
export function clockLabel(min) {
  const m = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * A typed time → minutes of the day, or null when it isn't one. Takes what
 * people actually type: "7:30", "07.30", "0730", "730", "19", "7pm", "7:30 pm".
 */
export function parseClock(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] == null ? 0 : Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3][0] === 'p' ? 12 : 0);
  } else if (h > 23) return null;
  return h * 60 + min;
}

/** A time of day on the timetable's five-minute grid (23:58 is 00:00). */
export const snapClock = (tod) => (Math.round(tod / SNAP_MIN) * SNAP_MIN) % DAY_MIN;

/** Where a week minute falls for a clock `off` minutes ahead of UTC. */
export function localDayTime(utcMin, off = 0) {
  const m = wrapWeek(utcMin + off);
  return { day: Math.floor(m / DAY_MIN), tod: m % DAY_MIN };
}

/** The week minute (UTC) of `tod` on local `day` for a clock `off` minutes ahead of UTC. */
export const utcOfLocal = (day, tod, off = 0) => wrapWeek(day * DAY_MIN + tod - off);

/**
 * A route's flights on this tail by local day at its origin: seven lists
 * (Mon–Sun) of { b, tod }, each in the order they leave.
 */
export function routeDays(week, routeId, off = 0) {
  const days = Array.from({ length: 7 }, () => []);
  for (const b of week?.blocks ?? []) {
    if (b.routeId !== routeId) continue;
    const { day, tod } = localDayTime(b.start, off);
    days[day].push({ b, tod });
  }
  for (const d of days) d.sort((x, y) => x.tod - y.tod || x.b.start - y.b.start);
  return days;
}

/** How many flights a route has on this tail: placed, plus any that found no room. */
export function routeFlights(week, routeId) {
  return (week?.blocks ?? []).filter(b => b.routeId === routeId).length
    + (week?.overflow?.find(o => o.routeId === routeId)?.count ?? 0);
}

/**
 * A route's week as timetable rows, [{ tod, days: [Mon..Sun booleans] }] in
 * time order — what the editor shows before the player types anything.
 *
 * A route the player has timed completely reads back exactly as set: one row
 * per distinct time. Anything else (automatic flights drift a few minutes from
 * day to day, and shift round whatever else the tail flies) is offered as the
 * tidy timetable its frequency implies: one row per flight a day on every day,
 * plus a row on the busiest days for what is left over (10×/week is a daily
 * row and a three-day row). Times start from the flights on `day` — the day
 * the player is looking at — or the busiest day when that one flies fewer; a
 * row with nothing to start from has tod null.
 */
export function timetableRows(week, routeId, off = 0, day = 0) {
  const days = routeDays(week, routeId, off);
  const placed = days.flat();
  const total = routeFlights(week, routeId);
  if (!total) return [];
  if (placed.length === total && placed.every(x => x.b.pinned)) {
    const byTod = new Map();
    days.forEach((list, d) => list.forEach(({ tod }) => {
      if (!byTod.has(tod)) byTod.set(tod, Array(7).fill(false));
      byTod.get(tod)[d] = true;
    }));
    return [...byTod].sort((a, b) => a[0] - b[0]).map(([tod, on]) => ({ tod, days: on }));
  }
  const n = Math.ceil(total / 7);
  const extra = total - 7 * (n - 1);                 // flights on the last row, 1–7
  // The days that row flies: where the route is busiest now, so a 3×/week
  // route keeps the three days it is on.
  const busiest = days.map((list, d) => ({ d, c: list.length })).sort((a, b) => b.c - a.c || a.d - b.d).slice(0, extra).map(x => x.d);
  // Times from the day being looked at; a day that flies fewer than the rows
  // need (the one-flight day of a 10×/week route) borrows the busiest day's.
  const todsOf = (list) => [...new Set(list.map(x => snapClock(x.tod)))].sort((a, b) => a - b);
  let seen = todsOf(days[day] ?? []);
  if (seen.length < n) {
    const fullest = todsOf(days.reduce((m, d) => (d.length > m.length ? d : m), []));
    if (fullest.length > seen.length) seen = fullest;
  }
  return Array.from({ length: n }, (_, i) => ({
    tod: seen[i] ?? null,
    days: i < n - 1 || extra === 7 ? Array(7).fill(true) : Array.from({ length: 7 }, (_, d) => busiest.includes(d)),
  }));
}

/** The first thing in the way of a `dur`-minute block at `start` among `placed`. */
const firstClash = (start, dur, placed) => placed.find(p => overlaps(start, dur, p.start, p.dur)) ?? null;

/** The free start nearest `s` (either side, five-minute steps, at most `reach`
 *  minutes away) for a block among `placed`; null if none. `dur` is its length
 *  in minutes, or a function of the start for a rotation whose length depends
 *  on when it leaves. */
export function nearestFit(s, dur, placed, reach = 12 * 60) {
  const len = typeof dur === 'function' ? dur : () => dur;
  for (let k = SNAP_MIN; k <= reach; k += SNAP_MIN) {
    for (const at of [wrapWeek(s + k), wrapWeek(s - k)]) {
      if (!firstClash(at, len(at), placed)) return at;
    }
  }
  return null;
}

/**
 * What stops `from` (a flight of `routeId`) moving to `start`: the pinned
 * flight or other flight of its own route it would overlap, or null when the
 * move is fine. The same rule as canPlace, naming the culprit.
 */
export function blockerFor(week, routeId, dur, start, from = null) {
  dur = week.durAt?.(routeId, start) ?? dur;
  const skip = replacedBlock(week, routeId, from, start);
  return week.blocks.find(b => b !== skip && (b.pinned || b.routeId === routeId)
    && overlaps(start, dur, b.start, b.dur)) ?? null;
}

/**
 * Pins for a route from timetable rows.
 *   rows: [{ tod, days }] — minutes of the day, local at the route's origin
 *         (`off` = that airport's UTC offset in minutes), and the days (Mon..Sun
 *         booleans) a flight leaves at that time
 * A flight whose typed time is taken by a flight of another route the player
 * set leaves at the nearest free time instead, and one with nowhere to go
 * within twelve hours is left automatic. Flights the rows don't
 * cover stay automatic too. Other routes' automatic flights make room, as they
 * do for any pin.
 *
 * Returns null when there is nothing to set (no flights, no row with a time
 * and a day), or an error the player has to fix:
 *   { error: 'too-many', timed, flights }   more departures than the route flies
 *   { error: 'too-close', a, b, dur }       two of them ({ day, tod }) nearer
 *                                           than one round trip (`dur`: the
 *                                           earlier one's, bank waits included)
 * otherwise {
 *   pins,                           the route's new pinned starts
 *   flights,                        how many flights the route has on this tail
 *   timed,                          how many departures the rows asked for
 *   set,                            how many leave exactly when typed
 *   bumped: [{ day, tod, at, by }]  typed time taken → leaves at `at` instead
 *   auto:   [{ day, tod, by }]      no room near the typed time → automatic
 * } — `by` is the block in the way: { routeId, start }.
 */
export function pinsForTimetable(week, routeId, rows, off = 0) {
  if (!week) return null;
  const flights = routeFlights(week, routeId);
  const sample = week.blocks.find(b => b.routeId === routeId);
  if (!flights || !sample) return null;
  // A banked rotation's length depends on when it leaves; elsewhere every
  // flight of a route is the same length.
  const durOf = (start) => week.durAt?.(routeId, start) ?? sample.dur;
  const seen = new Set();
  const targets = [];
  for (const row of rows ?? []) {
    if (row?.tod == null || row.tod === '' || !Number.isFinite(Number(row.tod))) continue;
    const tod = snapClock(Number(row.tod));
    for (let day = 0; day < 7; day++) {
      if (!row.days?.[day] || seen.has(`${day}|${tod}`)) continue;
      seen.add(`${day}|${tod}`);
      targets.push({ day, tod, to: utcOfLocal(day, tod, off) });
    }
  }
  if (!targets.length) return null;
  if (targets.length > flights) return { error: 'too-many', timed: targets.length, flights };
  // In the order the origin's week runs (so a problem is reported from Monday
  // on); sorted round the week, only neighbours can overlap.
  targets.sort((a, b) => a.day - b.day || a.tod - b.tod);
  for (let i = 0; i < targets.length && targets.length > 1; i++) {
    const a = targets[i], b = targets[(i + 1) % targets.length];
    if (wrapWeek(b.to - a.to) < durOf(a.to)) return { error: 'too-close', a: { day: a.day, tod: a.tod }, b: { day: b.day, tod: b.tod }, dur: durOf(a.to) };
  }
  const fixed = week.blocks.filter(b => b.routeId !== routeId && b.pinned);
  // Everything that fits where it was typed goes first, so a flight that has
  // to shift never takes another day's typed time.
  const placed = [];
  const late = [];
  for (const t of targets) {
    const by = firstClash(t.to, durOf(t.to), fixed);
    if (by) { t.by = { routeId: by.routeId, start: by.start }; late.push(t); continue; }
    t.at = t.to;
    placed.push({ start: t.at, dur: durOf(t.at) });
  }
  for (const t of late) {
    t.at = nearestFit(t.to, durOf, [...fixed, ...placed]);
    if (t.at != null) placed.push({ start: t.at, dur: durOf(t.at) });
  }
  return {
    pins: normalizeStarts(placed.map(p => p.start)),
    flights,
    timed: targets.length,
    set: targets.length - late.length,
    bumped: late.filter(t => t.at != null).map(t => ({ day: t.day, tod: t.tod, at: t.at, by: t.by })),
    auto: late.filter(t => t.at == null).map(t => ({ day: t.day, tod: t.tod, by: t.by })),
  };
}
