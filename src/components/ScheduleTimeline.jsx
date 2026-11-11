import { memo, useEffect, useMemo, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { getAirport } from '../data/airports.js';
import { getAircraftType } from '../data/aircraft.js';
import { isOutOfService, groundedKind } from '../data/maintenance.js';
import { currentGameDate } from '../utils/simulation.js';
import { utcOffsetMinutes } from '../data/timezones.js';
import {
  WEEK_MIN, wrapWeek, snapMin, airlineWeeks, canPlace, pinsAfterMove, pinsAfterUnpin,
  routeRotation, byCodePoint, findBlock, replacedBlock, overlaps,
  scheduleInputsOf, bankContextOf, hubTimetable, blockHubEvents, snapToBank, connectionsAt,
  DAY_MIN, clockLabel, parseClock, snapClock, localDayTime, utcOfLocal, routeFlights, timetableRows,
  pinsForTimetable, blockerFor,
} from '../models/schedule.js';
import HubBanksPanel from './HubBanksPanel.jsx';
import { gameClockAt } from './gameClock.js';
import useIsMobile from '../hooks/useIsMobile.js';
import { Glyph } from './Icons.jsx';

// ── Schedule — drag your week ─────────────────────────────────────────────────
// One row per aircraft, the week across. Each block is a rotation (every leg
// out and back). Solid blocks are departures the player set; dashed ones are
// placed automatically, so the tool is optional — a player who never opens it
// still has a full week. Drag a block to move it, or drag a flight in from the
// row's tray. Moving a flight sets that route's whole week as shown, with only
// the moved flight changed, so nothing the player didn't touch shifts under
// them. The timetable drives the departure board and the globe's planes; in a
// hub-bank world it also decides which connections work at the player's hubs
// (HubBanksPanel on top; off-bank flights are marked). The maths is in
// models/schedule.js.
//
// Typed times (2026-11-10, from a player who had to nudge fourteen flights one
// by one): click a flight and its panel takes a clock time for that flight,
// and the route's whole week as rows of "this time, on these days", set in one
// go. Both are local time at the route's origin, as a timetable prints them.
//
// Robustness (audits 2026-10-14):
//  · blocks are matched by route + start, never object identity — the week is
//    rebuilt whenever state changes, including mid-drag;
//  · keyboard and button nudges are batched: applied on screen at once, sent
//    as one decision after a short pause (holding an arrow key used to queue
//    dozens of authoritative writes);
//  · rows are memoised and the per-aircraft week is cached in the model, so a
//    move re-renders the one row that changed;
//  · touch: hold ~0.3 s before a flight lifts (a swipe still scrolls); a
//    second finger cancels the drag.

export const SCHEDULE_ZONE_KEY = 'headwinds.scheduleZone';
export const SCHEDULE_ZOOM_KEY = 'headwinds.scheduleZoom';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const LABEL_W = 168;
const LABEL_W_PHONE = 124;
const HEAD_H = 28;
const ROW_H = 40;
const LONG_PRESS_MS = 280;
const NUDGE_FLUSH_MS = 600;
// Mid-tone, distinct from the UI's red (which means "can't go here"), and dark
// enough for the white route labels.
const PALETTE = ['#4f8fd0', '#3f9e78', '#b07f2a', '#8a72cc', '#b8539a', '#2f9a96', '#c06c35', '#6b973b', '#a35cb3', '#5a76c8'];
const EMPTY = [];

const pad2 = (n) => String(n).padStart(2, '0');
const durLabel = (min) => `${Math.floor(min / 60)}h${pad2(min % 60)}`;
/** "Tue 07:05" for a minute of the display week. */
export function weekLabel(min) {
  const m = wrapWeek(min);
  const d = Math.floor(m / 1440), r = m % 1440;
  return `${DAYS[d]} ${pad2(Math.floor(r / 60))}:${pad2(r % 60)}`;
}
const offsetLabel = (mins) => {
  if (!mins) return 'UTC';
  const sign = mins > 0 ? '+' : '−';
  const a = Math.abs(mins);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${pad2(a % 60)}` : ''}`;
};
const readPref = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const writePref = (key, v) => { try { localStorage.setItem(key, String(v)); } catch { /* private mode */ } };

/** Destination codes for a block's label: "MEL", or "JFK·ORY" for a rotation. */
const blockCodes = (b) => (b?.stops ?? []).slice(1).join('·');
const blockId = (acId, b) => `${acId}|${b.routeId}|${b.start}`;
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The block of the same route nearest `start` — where a selection lands when
 *  its flight moved (unpinned flights go back to their automatic slot). */
function resolveBlock(week, sel) {
  if (!week || !sel) return null;
  const exact = findBlock(week, sel);
  if (exact) return exact;
  const mine = week.blocks.filter(b => b.routeId === sel.routeId);
  if (!mine.length) return null;
  const d = (b) => Math.min(wrapWeek(b.start - sel.start), wrapWeek(sel.start - b.start));
  return mine.reduce((m, b) => (d(b) < d(m) ? b : m));
}

/** `initialSelection` ({ acId, routeId, start }) opens with that flight's panel showing. */
export default function ScheduleTimeline({ initialSelection = null } = {}) {
  const { state, dispatch, remoteChrome } = useGame();
  const fleet = state.fleet ?? EMPTY;
  const stateRoutes = state.routes ?? EMPTY;
  const stateCargo = state.cargoRoutes ?? EMPTY;
  const isMobile = useIsMobile();
  const labelW = isMobile ? LABEL_W_PHONE : LABEL_W;
  const month = currentGameDate(state).month;

  // ── Batched edits ───────────────────────────────────────────────────────────
  // Nudges land in `pending` (shown at once) and go to the game as one
  // SET_ROUTE_SCHEDULES after a pause; drops and row actions send at once,
  // taking anything pending with them.
  const [pending, setPending] = useState({});
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const flushTimer = useRef(null);
  const flush = useCallback((extra = null) => {
    clearTimeout(flushTimer.current);
    const all = { ...pendingRef.current, ...(extra ?? {}) };
    pendingRef.current = {};
    setPending({});
    if (Object.keys(all).length) dispatch({ type: 'SET_ROUTE_SCHEDULES', schedules: all });
  }, [dispatch]);
  const queue = useCallback((schedules) => {
    const next = { ...pendingRef.current, ...schedules };
    pendingRef.current = next;
    setPending(next);
    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => flush(), NUDGE_FLUSH_MS);
  }, [flush]);
  useEffect(() => () => {        // leaving the screen sends what's waiting
    clearTimeout(flushTimer.current);
    if (Object.keys(pendingRef.current).length) {
      dispatch({ type: 'SET_ROUTE_SCHEDULES', schedules: pendingRef.current });
    }
  }, [dispatch]);

  const withPending = useCallback((list) => {
    if (!Object.keys(pending).length) return list;
    return list.map(r => {
      if (!Object.prototype.hasOwnProperty.call(pending, r.id)) return r;
      const starts = pending[r.id];
      if (!starts?.length) { const { schedule, ...rest } = r; return rest; }
      return sameList(starts, r.schedule?.starts ?? []) ? r : { ...r, schedule: { starts } };
    });
  }, [pending]);
  const routes = useMemo(() => withPending(stateRoutes), [stateRoutes, withPending]);
  const cargoRoutes = useMemo(() => withPending(stateCargo), [stateCargo, withPending]);

  // ── Data ────────────────────────────────────────────────────────────────────
  const hubBanksWorld = state.hubBanksWorld === true;
  const weeks = useMemo(() => airlineWeeks({ ...scheduleInputsOf(state), fleet, routes, cargoRoutes }, month),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fleet, routes, cargoRoutes, month, state.hubs, state.hubBanks, state.hubBanksWorld]);
  // Hub-bank worlds: the waves, and who meets whom at each hub — built from
  // the week on screen (pending nudges included), the same way the tick does.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bankCtx = useMemo(() => bankContextOf(state), [state.hubBanksWorld, state.hubs, state.hubBanks]);
  const paxIds = useMemo(() => new Set(routes.map(r => r.id)), [routes]);
  const tt = useMemo(() => (hubBanksWorld
    ? hubTimetable(weeks, { paxIds, hubs: new Set(Object.keys(state.hubs ?? {})) }) : null),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [hubBanksWorld, weeks, paxIds, state.hubs]);
  const routeById = useMemo(() => {
    const m = new Map();
    for (const r of routes) m.set(r.id, { r, cargo: false });
    for (const r of cargoRoutes) m.set(r.id, { r, cargo: true });
    return m;
  }, [routes, cargoRoutes]);

  // Row objects are reused while their week (cached by the model) and the
  // aircraft's own fields are unchanged, so the memoised rows skip re-render.
  const rowCache = useRef(new Map());
  const rows = useMemo(() => {
    const out = [];
    const nextCache = new Map();
    for (const a of fleet) {
      const week = weeks.get(a.id);
      if (!week || (!week.blocks.length && !week.overflow.length)) continue;
      const sig = `${a.typeId}|${a.tailNumber ?? ''}|${a.name ?? ''}|${a.status ?? ''}|${a.checkType ?? ''}|${a.groundedReason ?? ''}`;
      const prev = rowCache.current.get(a.id);
      if (prev && prev.week === week && prev.sig === sig) { out.push(prev); nextCache.set(a.id, prev); continue; }
      const type = getAircraftType(a.typeId);
      const routeIds = [...new Set([...week.blocks.map(b => b.routeId), ...week.overflow.map(o => o.routeId)])]
        .sort(byCodePoint);
      const meta = Object.fromEntries(routeIds.map((id, i) => {
        const info = routeById.get(id);
        return [id, {
          color: PALETTE[i % PALETTE.length],
          origin: info?.r.origin ?? '?',
          destination: info?.r.destination ?? '?',
          cargo: !!info?.cargo,
          frequency: info?.r.weeklyFrequency ?? 0,
          hasPins: !!info?.r.schedule?.starts?.length,
          // The real rotation length — what a tray drag previews and is
          // checked with, even when none of its flights is on the timeline.
          dur: (info && type ? routeRotation(info.r, type)?.durMin : null) ?? 120,
        }];
      }));
      const row = {
        a, type, week, sig, meta, routeIds,
        label: a.tailNumber || a.name || type?.name || a.id,
        out: isOutOfService(a),
        outWhy: isOutOfService(a) ? groundedKind(a) : '',
        placedMin: week.blocks.reduce((s, b) => s + b.dur, 0),
      };
      out.push(row);
      nextCache.set(a.id, row);
    }
    rowCache.current = nextCache;
    return out.sort((x, y) => (x.type?.name ?? '').localeCompare(y.type?.name ?? '')
      || String(x.label).localeCompare(String(y.label)));
  }, [fleet, weeks, routeById]);

  const [typeFilter, setTypeFilter] = useState('all');
  const types = useMemo(() => [...new Map(rows.map(r => [r.type?.id, r.type])).values()].filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name)), [rows]);
  const shown = useMemo(() => (typeFilter === 'all' ? rows : rows.filter(r => r.type?.id === typeFilter)),
    [rows, typeFilter]);

  // ── View: zone and zoom ─────────────────────────────────────────────────────
  const hubAirport = getAirport(state.hub);
  const hubOffset = utcOffsetMinutes(hubAirport);
  const [zone, setZone] = useState(() => (readPref(SCHEDULE_ZONE_KEY, 'hub') === 'utc' ? 'utc' : 'hub'));
  const zoneOff = zone === 'utc' || !hubAirport ? 0 : hubOffset;
  const [zoom, setZoom] = useState(() => {
    const z = Number(readPref(SCHEDULE_ZOOM_KEY, ''));
    return [1, 2, 4].includes(z) ? z : null;
  });
  const effZoom = zoom ?? (isMobile ? 4 : 1);
  useEffect(() => writePref(SCHEDULE_ZONE_KEY, zone), [zone]);

  const scrollRef = useRef(null);
  const [trackW, setTrackW] = useState(840);
  const hasRows = rows.length > 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setTrackW(Math.max(420, el.clientWidth - labelW - 2)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [labelW, hasRows]);
  const pxPerMin = (trackW * effZoom) / WEEK_MIN;
  const fullW = trackW * effZoom;

  // Changing zoom keeps the same moment in the middle of the view.
  const zoomAnchor = useRef(null);
  const changeZoom = (z) => {
    const sc = scrollRef.current;
    if (sc) zoomAnchor.current = (sc.scrollLeft + (sc.clientWidth - labelW) / 2) / fullW;
    setZoom(z);
    writePref(SCHEDULE_ZOOM_KEY, z);
  };
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc || zoomAnchor.current == null) return;
    sc.scrollLeft = Math.max(0, zoomAnchor.current * fullW - (sc.clientWidth - labelW) / 2);
    zoomAnchor.current = null;
  }, [fullW, labelW]);

  // ── The game's "now" (one overlay line) ─────────────────────────────────────
  const gc = remoteChrome?.gameClock ?? null;
  const gcNext = gc?.nextTickAt ?? null, gcWpd = gc?.weeksPerDay ?? null, gcPre = !!gc?.preStart;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!gcNext || !gcWpd) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [gcNext, gcWpd]);
  const clock = gcNext && gcWpd ? gameClockAt(now, { nextTickAt: gcNext, weeksPerDay: gcWpd, preStart: gcPre }) : null;
  const nowUtc = clock ? clock.weekHours * 60 : null;

  // Zoomed in, open at "now" rather than Monday morning.
  const openedAtNow = useRef(false);
  useEffect(() => {
    const sc = scrollRef.current;
    if (openedAtNow.current || !sc || nowUtc == null || effZoom === 1) return;
    openedAtNow.current = true;
    sc.scrollLeft = Math.max(0, wrapWeek(nowUtc + zoneOff) * pxPerMin - (sc.clientWidth - labelW) / 3);
  }, [nowUtc, effZoom, zoneOff, pxPerMin, labelW]);

  // ── Selection and focus ─────────────────────────────────────────────────────
  const [selected, setSelected] = useState(initialSelection);   // { acId, routeId, start }
  // What the last typed time or timetable did: { acId, routeId, tone, text }.
  const [notice, setNotice] = useState(null);
  const selRow = selected ? rows.find(r => r.a.id === selected.acId) ?? null : null;
  const selBlock = selRow ? resolveBlock(selRow.week, selected) : null;
  const focusNext = useRef(false);    // after a keyboard action or a drop, re-focus the selected block
  const revealPanel = useRef(false);  // after a click, bring the detail panel into view
  const panelRef = useRef(null);
  const selKey = selBlock ? blockId(selRow.a.id, selBlock) : null;
  useEffect(() => {
    if (!selKey || !focusNext.current) return;
    focusNext.current = false;
    const el = scrollRef.current?.querySelector(`[data-block="${(typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(selKey) : selKey}"]`);
    el?.focus({ preventScroll: false });
  });
  useEffect(() => {
    if (!selected || !revealPanel.current) return;
    revealPanel.current = false;
    panelRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  // Everything the rows call goes through one stable object (reading the
  // latest values through `live`), so a memoised row re-renders only when its
  // own data changes.
  const live = useRef({});
  live.current = { rows, pxPerMin, zoneOff, labelW, flush, queue, bankCtx };

  const [dragView, setDragView] = useState(null);   // what the dragged row draws
  const dragRef = useRef(null);
  const trackRefs = useRef(new Map());

  const api = useRef(null);
  if (!api.current) {
    const rowOf = (acId) => live.current.rows.find(r => r.a.id === acId);
    const select = (acId, b, how) => {
      if (how === 'key' || how === 'focus') focusNext.current = true;
      if (how === 'click') revealPanel.current = true;
      setNotice(n => (n && b && n.acId === acId && n.routeId === b.routeId ? n : null));
      setSelected(b ? { acId, routeId: b.routeId, start: b.start } : null);
    };
    // Nudges (keys, panel buttons) batch; `now` sends at once.
    const send = (schedules, how) => (how === 'now' ? live.current.flush(schedules) : live.current.queue(schedules));
    const moveTo = (acId, b, to, how) => {
      const row = rowOf(acId);
      if (!row || to === b.start) return;
      if (!canPlace(row.week, b.routeId, b.dur, to, b)) return;
      const pins = pinsAfterMove(row.week, b.routeId, b, to);
      if (!pins) return;
      send({ [b.routeId]: pins }, how);
      if (how === 'key' || how === 'now') focusNext.current = true;
      setNotice(null);
      setSelected({ acId, routeId: b.routeId, start: to });
    };
    // A typed time for one flight, on the day it already flies (local at the
    // route's origin). Says what is in the way when it can't go there.
    const retime = (acId, b, tod) => {
      const row = rowOf(acId);
      const cur = row && findBlock(row.week, b);
      if (!cur) return;
      const origin = cur.stops[0];
      const off = utcOffsetMinutes(getAirport(origin));
      const to = utcOfLocal(localDayTime(cur.start, off).day, tod, off);
      const say = (tone, text) => setNotice({ acId, routeId: cur.routeId, tone, text });
      const by = to === cur.start ? null : blockerFor(row.week, cur.routeId, cur.dur, to, cur);
      const pins = by ? null : pinsAfterMove(row.week, cur.routeId, cur, to);
      if (by) {
        // In a banked week the round trip from the typed time may include a wait for a bank.
        const len = row.week.durAt?.(cur.routeId, to) ?? cur.dur;
        say('bad', `Can’t leave at ${weekLabel(to + off)}: ${clashName(row, by, cur.routeId)} (leaves ${weekLabel(by.start + off)}) is in the way. `
          + (by.routeId === cur.routeId
            ? `The aircraft is away for ${durLabel(len)} on each round trip, so two departures can’t be closer than that.`
            : 'Move or unpin that flight first.'));
        return;
      }
      if (!pins) return;
      live.current.flush({ [cur.routeId]: pins });
      say('ok', `Leaves ${origin} ${weekLabel(to + off)}.`);
      setSelected({ acId, routeId: cur.routeId, start: to });
    };
    // The route's whole week from typed rows (see TimetableForm).
    const setTimetable = (acId, b, ttRows) => {
      const row = rowOf(acId);
      if (!row) return;
      const off = utcOffsetMinutes(getAirport(b.stops[0]));
      const res = pinsForTimetable(row.week, b.routeId, ttRows, off);
      const note = timetableNotice(res, { off, name: (by) => clashName(row, by, b.routeId) });
      setNotice({ acId, routeId: b.routeId, ...note });
      if (res && !res.error) live.current.flush({ [b.routeId]: res.pins });
    };
    const pinHere = (acId, b, how) => {
      const row = rowOf(acId);
      const pins = row && pinsAfterMove(row.week, b.routeId, b, b.start);
      if (!pins) return;
      send({ [b.routeId]: pins }, 'queue');
      if (how === 'key') focusNext.current = true;
      setNotice(null);
      setSelected({ acId, routeId: b.routeId, start: b.start });
    };
    const unpin = (acId, b, how) => {
      const row = rowOf(acId);
      if (!row) return;
      send({ [b.routeId]: pinsAfterUnpin(row.week, b.routeId, b.start) }, 'queue');
      // Keep the selection on that flight wherever automatic placement puts it.
      if (how === 'key') focusNext.current = true;
      setNotice(null);
      setSelected({ acId, routeId: b.routeId, start: b.start });
    };
    const lockRow = (acId) => {
      const row = rowOf(acId);
      if (!row) return;
      const out = {};
      for (const b of row.week.blocks) (out[b.routeId] ??= []).push(b.start);
      live.current.flush(out);
    };
    const resetRow = (acId) => {
      const row = rowOf(acId);
      if (row) live.current.flush(Object.fromEntries(row.routeIds.map(id => [id, null])));
    };
    const setTrack = (acId, el) => { if (el) trackRefs.current.set(acId, el); else trackRefs.current.delete(acId); };

    // Drag: mouse and pen lift at once; touch must be held still for a moment
    // first, so a swipe that starts on a block still scrolls the timeline.
    const startDrag = (e, acId, routeId, from) => {
      if (e.button != null && e.button !== 0) return;
      if (e.isPrimary === false || dragRef.current) return;   // a second finger never starts a drag
      const row = rowOf(acId);
      const track = trackRefs.current.get(acId);
      if (!row || !track) return;
      const touch = e.pointerType === 'touch';
      if (!touch) {
        e.preventDefault();                       // no text selection while dragging
        e.currentTarget.focus?.({ preventScroll: true });
      }
      const { pxPerMin: ppm, zoneOff: off } = live.current;
      const rect = track.getBoundingClientRect();
      const dur = from?.dur ?? row.meta[routeId]?.dur ?? 120;
      const grabMin = from ? (e.clientX - rect.left) / ppm - wrapWeek(from.start + off) : dur / 2;
      const d = {
        acId, routeId, from: from ? { routeId: from.routeId, start: from.start, dur: from.dur, pinned: from.pinned, key: from.key } : null,
        dur, grabMin, pointerId: e.pointerId, touch,
        x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
        armed: !touch, moved: false, utc: from ? from.start : null, valid: false, over: !!from, blocker: null,
      };
      dragRef.current = d;
      if (touch) {
        d.timer = setTimeout(() => {
          if (dragRef.current !== d) return;
          d.armed = true;
          try { navigator.vibrate?.(8); } catch { /* not supported */ }
          setDragView({ ...d });
        }, LONG_PRESS_MS);
      }
      setDragView({ ...d });
    };
    api.current = { select, moveTo, pinHere, unpin, retime, setTimetable, lockRow, resetRow, setTrack, startDrag, rowOf };
    // Hub-bank worlds: what a flight meets at a hub, read live by the rows'
    // tooltips without making them re-render when other rows change.
    api.current.bankCtx = () => live.current.bankCtx;
  }

  useEffect(() => {
    if (!dragView) return undefined;
    const d0 = dragRef.current;
    if (!d0) return undefined;
    const end = () => {
      clearTimeout(d0.timer);
      dragRef.current = null;
      setDragView(null);
    };
    const place = () => {
      const d = dragRef.current;
      const row = api.current.rowOf(d.acId);
      const track = trackRefs.current.get(d.acId);
      if (!row || !track) return;
      const { pxPerMin: ppm, zoneOff: off } = live.current;
      const rect = track.getBoundingClientRect();
      // Anywhere to the right counts, so dragging off Sunday night wraps to Monday.
      const over = d.y >= rect.top - 24 && d.y <= rect.bottom + 24 && d.x >= rect.left - 8;
      const utc = snapMin((d.x - rect.left) / ppm - d.grabMin - off);
      // A banked rotation's length depends on when it leaves (it may wait at
      // the far end for the next bank) — preview and check it at the drop time.
      const dur = row.week.durAt?.(d.routeId, utc) ?? d.dur;
      // The flight as it is in the CURRENT week — state may have changed since
      // the drag began. Gone (closed route, new week): stop.
      if (d.from && !findBlock(row.week, d.from)) { end(); return; }
      const valid = over && canPlace(row.week, d.routeId, d.dur, utc, d.from);
      let blocker = null;
      if (over && !valid) {
        const skip = replacedBlock(row.week, d.routeId, d.from, utc);
        blocker = row.week.blocks.find(b => b !== skip && (b.pinned || b.routeId === d.routeId)
          && overlaps(utc, dur, b.start, b.dur)) ?? null;
      }
      if (utc !== d.utc || valid !== d.valid || over !== d.over || !d.shown || blocker?.key !== d.blocker?.key || dur !== d.dur) {
        Object.assign(d, { utc, dur, valid, over, shown: true, blocker: blocker ? { key: blocker.key, routeId: blocker.routeId, start: blocker.start } : null });
        setDragView({ ...d });
      }
    };
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      d.x = e.clientX; d.y = e.clientY;
      const dist = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
      if (!d.armed) {
        if (dist > 8) end();            // a touch that moves before the long-press is a scroll
        return;
      }
      if (!d.moved && dist > 4) d.moved = true;
      if (d.moved) place();
    };
    const onDown = (e) => {             // a second finger (pinch, two-finger pan) cancels
      const d = dragRef.current;
      if (d && e.pointerId !== d.pointerId) end();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); end(); } };
    const onUp = (e) => {
      const d = dragRef.current;
      if (!d || (e.pointerId != null && e.pointerId !== d.pointerId)) return;
      end();
      if (e.type === 'pointercancel') return;
      if (!d.moved) {
        if (d.from) api.current.select(d.acId, d.from, 'click');
        return;
      }
      // Dropped back where it was, or somewhere it can't go: nothing to do —
      // a wobble must not pin an automatic flight.
      if (!d.valid || d.utc == null || (d.from && d.utc === d.from.start)) return;
      const row = api.current.rowOf(d.acId);
      const pins = row && pinsAfterMove(row.week, d.routeId, d.from, d.utc);
      if (!pins) return;
      live.current.flush({ [d.routeId]: pins });
      if (!d.touch) focusNext.current = true;
      setNotice(null);
      setSelected({ acId: d.acId, routeId: d.routeId, start: d.utc });
    };
    // Once a touch drag is armed, stop the page scrolling under the finger.
    const onTouchMove = (e) => { if (dragRef.current?.armed && dragRef.current?.touch) e.preventDefault(); };
    // Auto-scroll while the pointer rests near either edge of the timeline.
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const d = dragRef.current;
      const sc = scrollRef.current;
      if (!d || !d.moved || !d.armed || !sc) return;
      const sr = sc.getBoundingClientRect();
      const left = sr.left + live.current.labelW;
      if (d.y < sr.top || d.y > sr.bottom || d.x < left - 8) return;   // e.g. still over the tray
      const edge = 40;
      const step = d.x > sr.right - edge ? 1 : d.x < left + edge ? -1 : 0;
      if (!step) return;
      const before = sc.scrollLeft;
      sc.scrollLeft += step * 12;
      if (sc.scrollLeft !== before) place();
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('touchmove', onTouchMove);
    };
  // Bound once per drag; the handlers read everything else through refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragView != null]);

  // iOS decides at touchstart whether a gesture can be cancelled, so the
  // non-passive listener that stops scrolling during an armed drag must exist
  // before the touch begins — one on the timeline for its whole life.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const stop = (e) => { if (dragRef.current?.armed && dragRef.current?.touch) e.preventDefault(); };
    el.addEventListener('touchmove', stop, { passive: false });
    el.addEventListener('touchstart', () => {}, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, [hasRows]);

  const anyPins = rows.some(r => r.week.blocks.some(b => b.pinned));
  const [confirmAll, setConfirmAll] = useState(false);
  useEffect(() => {
    if (!confirmAll) return undefined;
    const t = setTimeout(() => setConfirmAll(false), 4000);
    return () => clearTimeout(t);
  }, [confirmAll]);
  const resetAll = () => {
    if (!confirmAll) { setConfirmAll(true); return; }
    setConfirmAll(false);
    const out = {};
    for (const r of rows) for (const id of r.routeIds) if (r.meta[id].hasPins) out[id] = null;
    flush(out);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  if (!rows.length) {
    return (
      <div className="empty-state" style={{ paddingTop: 60 }}>
        <div className="empty-state-icon"><Glyph e="🗓" /></div>
        <div className="empty-state-text">No flights to schedule yet.</div>
        <div style={{ marginTop: 8, fontSize: 13 }}>Open a route and its flights appear here.</div>
      </div>
    );
  }

  const pxPerHour = pxPerMin * 60;
  const hourStep = pxPerHour >= 14 ? 3 : pxPerHour >= 6 ? 6 : 12;
  const tickW = pxPerHour * hourStep;

  return (
    <div className="sched">
      <div className="sched-intro">
        <div>
          Click a flight to type when it leaves, or to set its route&apos;s whole week in one go. You can also drag
          a flight, or drag one in from an aircraft&apos;s tray.
          {' '}<span className="sched-key sched-key-pinned" /> set by you
          {' '}<span className="sched-key sched-key-auto" /> placed automatically
        </div>
        <div className="sched-sub">
          Optional — anything you don&apos;t place is scheduled for you. Moving a flight sets that route&apos;s
          whole week as shown (only the flight you moved changes). Your timetable sets the departure board and
          the planes on the globe{hubBanksWorld
            ? <>, and at your hubs it decides who can connect: flights that meet in a bank carry connecting
              passengers, flights that miss one don&apos;t. The automatic schedule banks every hub for you.</>
            : <>; it doesn&apos;t change demand or costs.</>}
          {isMobile ? ' Hold a flight for a moment, then drag.' : ''}
        </div>
      </div>

      {hubBanksWorld && (
        <HubBanksPanel state={state} weeks={weeks} tt={tt} paxIds={paxIds} dispatch={dispatch}
          onSnap={(schedules) => flush(schedules)} />
      )}

      <div className="sched-toolbar">
        <div className="sched-seg" role="group" aria-label="Time zone">
          {hubAirport && (
            <button aria-pressed={zone === 'hub'} onClick={() => setZone('hub')}>
              {hubAirport.code} time ({offsetLabel(hubOffset)})
            </button>
          )}
          <button aria-pressed={zone === 'utc' || !hubAirport} onClick={() => setZone('utc')}>UTC</button>
        </div>
        <div className="sched-seg" role="group" aria-label="Zoom">
          {[1, 2, 4].map(z => (
            <button key={z} aria-pressed={effZoom === z} onClick={() => changeZoom(z)}>
              {z === 1 ? 'Week' : `${z}×`}
            </button>
          ))}
        </div>
        {types.length > 1 && (
          <select className="form-select" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
            style={{ width: 'auto', fontSize: 12, padding: '4px 8px' }} aria-label="Aircraft type">
            <option value="all">All aircraft</option>
            {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <span style={{ flex: 1 }} />
        {anyPins && (
          <button className="btn btn-ghost sched-btn" onClick={resetAll}
            title="Put every aircraft back on the automatic timetable">
            {confirmAll ? 'Click again to reset all' : 'Reset all to automatic'}
          </button>
        )}
      </div>


      <div className="sched-scroll" ref={scrollRef}>
        <div className="sched-grid" style={{ width: labelW + fullW }}>
          <div className="sched-head" style={{ height: HEAD_H }}>
            <div className="sched-label sched-corner" style={{ width: labelW }}>
              {shown.length} aircraft
            </div>
            <div className="sched-track sched-days" style={{ width: fullW }}>
              {DAYS.map((d, i) => (
                <div key={d} className="sched-day" style={{ left: i * 1440 * pxPerMin, width: 1440 * pxPerMin }}>
                  <span>{d}</span>
                  {Array.from({ length: 24 / hourStep - 1 }, (_, k) => (k + 1) * hourStep).map(h => (
                    <span key={h} className="sched-hour" style={{ left: h * 60 * pxPerMin }}>
                      {/* Zoomed in, the day name scrolls away — repeat it on the ticks. */}
                      {tickW >= 46 ? `${d} ${pad2(h)}` : pad2(h)}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {shown.map(row => (
            <ScheduleRow
              key={row.a.id}
              row={row}
              labelW={labelW}
              fullW={fullW}
              pxPerMin={pxPerMin}
              zoneOff={zoneOff}
              drag={dragView?.acId === row.a.id ? dragView : null}
              selKey={selRow === row && selBlock ? selBlock.key : null}
              api={api.current}
              bankCtx={bankCtx}
            />
          ))}

          {nowUtc != null && (
            <div className="sched-now" title={`Now: ${weekLabel(nowUtc + zoneOff)}`}
              style={{ left: labelW + wrapWeek(nowUtc + zoneOff) * pxPerMin, top: HEAD_H }} />
          )}
        </div>
      </div>

      {selBlock && selRow && (
        <BlockDetail
          panelRef={panelRef}
          row={selRow} b={selBlock} zoneOff={zoneOff}
          bankCtx={bankCtx} tt={tt}
          notice={notice && notice.acId === selRow.a.id && notice.routeId === selBlock.routeId ? notice : null}
          onRetime={(tod) => api.current.retime(selRow.a.id, selBlock, tod)}
          onSetTimetable={(ttRows) => api.current.setTimetable(selRow.a.id, selBlock, ttRows)}
          onSnap={(to) => api.current.moveTo(selRow.a.id, selBlock, to, 'now')}
          onNudge={(d) => api.current.moveTo(selRow.a.id, selBlock, wrapWeek(selBlock.start + d), 'queue')}
          onPin={() => api.current.pinHere(selRow.a.id, selBlock)}
          onUnpin={() => api.current.unpin(selRow.a.id, selBlock)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/** One aircraft's row. Memoised: while a flight is dragged only its own row
 *  gets a new `drag`, and an edit only changes the edited aircraft's week. */
const ScheduleRow = memo(function ScheduleRow({ row, labelW, fullW, pxPerMin, zoneOff, drag, selKey, api, bankCtx = null }) {
  const autoByRoute = {}, pinnedByRoute = {};
  for (const b of row.week.blocks) {
    const m = b.pinned ? pinnedByRoute : autoByRoute;
    m[b.routeId] = (m[b.routeId] ?? 0) + 1;
  }
  const overflow = Object.fromEntries(row.week.overflow.map(o => [o.routeId, o.count]));
  const rowPins = row.week.blocks.some(b => b.pinned);
  const toX = (utc) => wrapWeek(utc + zoneOff) * pxPerMin;
  const sorted = row.week.blocks;   // already by start
  const selIdx = selKey ? sorted.findIndex(b => b.key === selKey) : -1;
  const tabIdx = selIdx >= 0 ? selIdx : 0;   // one tab stop per row
  const pairOf = (id, b) => `${row.meta[id]?.origin}–${b ? blockCodes(b) : row.meta[id]?.destination}`;

  const onKey = (e, b, i) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;   // leave Cmd/Ctrl+P (print) etc. alone
    const step = e.shiftKey ? 60 : 15;
    const acId = row.a.id;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); api.moveTo(acId, b, wrapWeek(b.start - step), 'key'); break;
      case 'ArrowRight': e.preventDefault(); api.moveTo(acId, b, wrapWeek(b.start + step), 'key'); break;
      case 'ArrowUp': e.preventDefault(); api.select(acId, sorted[(i - 1 + sorted.length) % sorted.length], 'key'); break;
      case 'ArrowDown': e.preventDefault(); api.select(acId, sorted[(i + 1) % sorted.length], 'key'); break;
      case 'Enter': case ' ': e.preventDefault(); api.select(acId, b, 'click'); break;
      case 'p': case 'P': if (!b.pinned) { e.preventDefault(); api.pinHere(acId, b, 'key'); } break;
      case 'Delete': case 'Backspace': if (b.pinned) { e.preventDefault(); api.unpin(acId, b, 'key'); } break;
      default:
    }
  };

  const blockerKey = drag?.blocker?.key ?? null;
  return (
    <div className="sched-row" style={{ minHeight: ROW_H }}>
      <div className="sched-label" style={{ width: labelW }}>
        <div className="sched-tail" title={`${row.label} · ${row.type?.name ?? ''}`}>
          <span>{row.label}</span>
        </div>
        <div className="sched-meta">
          {row.type?.name ?? '—'} · {Math.round(row.placedMin / 60)}h/wk
          {row.out && <> · <span className="sched-badge" title={row.outWhy}>out of service</span></>}
        </div>
        <div className="sched-tray" role="group" aria-label={`${row.label} routes`}>
          {row.routeIds.map(id => {
            const n = autoByRoute[id] ?? 0;
            const over = overflow[id] ?? 0;
            const set = pinnedByRoute[id] ?? 0;
            const m = row.meta[id];
            const sample = row.week.blocks.find(b => b.routeId === id);
            const dest = sample ? blockCodes(sample) : m.destination;
            const pair = pairOf(id, sample);
            const draggable = n + over > 0;
            const firstAuto = row.week.blocks.find(b => b.routeId === id && !b.pinned);
            return (
              <button
                key={id}
                type="button"
                className={`sched-chip${draggable ? '' : ' is-set'}${over ? ' sched-chip-over' : ''}`}
                style={{ '--c': m.color }}
                onPointerDown={draggable ? (e) => api.startDrag(e, row.a.id, id, null) : undefined}
                onClick={() => { const b = firstAuto ?? sample; if (b) api.select(row.a.id, b, 'key'); }}
                aria-label={draggable
                  ? `${pair}: ${n} placed automatically${over ? `, ${over} can't fit` : ''}${set ? `, ${set} set by you` : ''}. Press Enter to go to its flights, or drag onto the timeline.`
                  : `${pair}: all ${set} flights set by you. Press Enter to go to its flights.`}
                title={over
                  ? `${over} ${pair} flight${over > 1 ? 's' : ''} can't fit around your times — move one of your flights to make room`
                  : draggable
                    ? `${n} ${pair} flight${n > 1 ? 's are' : ' is'} placed automatically — drag one onto the timeline to set its time`
                    : `Every ${pair} flight is set by you`}
              >
                {m.cargo && <Glyph e="📦" />}{dest}{draggable ? ` ×${n + over}` : ''}
                {over > 0 && <span className="sched-chip-note">{over} won&apos;t fit</span>}
              </button>
            );
          })}
        </div>
        <div className="sched-row-actions">
          {row.week.blocks.some(b => !b.pinned) && (
            <button type="button" onClick={() => api.lockRow(row.a.id)} aria-label={`Pin all of ${row.label}'s flights`}
              title="Keep this aircraft's week exactly as shown (sets every flight)">Pin all</button>
          )}
          {rowPins && (
            <button type="button" onClick={() => api.resetRow(row.a.id)} aria-label={`Reset ${row.label} to automatic`}
              title="Put this aircraft back on the automatic timetable">Reset</button>
          )}
        </div>
      </div>

      <div
        className={`sched-track${row.out ? ' sched-track-out' : ''}`}
        style={{ width: fullW, minHeight: ROW_H }}
        ref={el => api.setTrack(row.a.id, el)}
      >
        {DAYS.map((d, i) => <div key={d} className="sched-day-bg" style={{ left: i * 1440 * pxPerMin, width: 1440 * pxPerMin }} />)}
        {sorted.map((b, i) => {
          const beingDragged = drag?.moved && drag.from && drag.from.routeId === b.routeId && drag.from.start === b.start;
          const isSel = i === selIdx;
          const lifted = drag && drag.touch && drag.armed && !drag.moved && drag.from?.routeId === b.routeId && drag.from?.start === b.start;
          const missed = bankCtx ? blockHubEvents(b, bankCtx).filter(e => !e.made).map(e => e.hub) : [];
          return (
            <BlockPieces
              key={b.key} b={b} x={toX(b.start)} pxPerMin={pxPerMin} fullW={fullW}
              color={row.meta[b.routeId]?.color} cargo={row.meta[b.routeId]?.cargo}
              dataBlock={blockId(row.a.id, b)}
              tabIndex={i === tabIdx ? 0 : -1}
              selected={isSel}
              className={`sched-block${b.pinned ? ' is-pinned' : ' is-auto'}${isSel ? ' is-selected' : ''}${beingDragged ? ' is-ghost' : ''}${lifted ? ' is-lifted' : ''}${b.key === blockerKey ? ' is-blocking' : ''}${missed.length ? ' is-offbank' : ''}`}
              label={`${pairOf(b.routeId, b)}–${row.meta[b.routeId]?.origin}, leaves ${weekLabel(b.start + zoneOff)}, ${b.pinned ? 'set by you' : 'automatic'}${missed.length ? `, misses a bank at ${[...new Set(missed)].join(' and ')}` : ''}`}
              hint={`Drag to move · ←/→ 15 min (Shift: 1 h) · ↑/↓ other flights · ${b.pinned ? 'Delete to unpin' : 'P to pin'}`}
              onPointerDown={(e) => api.startDrag(e, row.a.id, b.routeId, b)}
              onKeyDown={(e) => onKey(e, b, i)}
            />
          );
        })}
        {drag?.moved && drag.utc != null && drag.over && (() => {
          const shape = (drag.from && findBlock(row.week, drag.from)) ?? row.week.blocks.find(x => x.routeId === drag.routeId) ?? null;
          const x = toX(drag.utc);
          const blocker = drag.blocker;
          return (
            <>
              <BlockPieces
                b={{ ...(shape ?? { stops: [], legs: [] }), legs: row.week.legsAt?.(drag.routeId, drag.utc) ?? shape?.legs ?? [], start: drag.utc, dur: drag.dur }}
                x={x} pxPerMin={pxPerMin} fullW={fullW} color={row.meta[drag.routeId]?.color}
                className={`sched-block is-preview${drag.valid ? '' : ' is-invalid'}`}
                text=""
              />
              <div className={`sched-readout${drag.valid ? '' : ' is-invalid'}`} style={{ left: Math.min(x, fullW - 40) }} aria-live="polite">
                {weekLabel(drag.utc + zoneOff)}
                {blocker && <> · clashes with {pairOf(blocker.routeId)} {weekLabel(blocker.start + zoneOff)}</>}
              </div>
            </>
          );
        })()}
      </div>
    </div>
  );
});

/** A rotation block, split in two where it runs past Sunday midnight. Flights
 *  are solid segments, turnarounds the gaps between them. */
function BlockPieces({
  b, x, pxPerMin, fullW, color, cargo, className, label, hint, text: forcedText, dataBlock, tabIndex = -1, selected,
  onPointerDown, onKeyDown,
}) {
  if (!b) return null;
  const w = b.dur * pxPerMin;
  const pieces = x + w > fullW + 0.5 ? [[x, fullW - x, 0], [0, x + w - fullW, fullW - x]] : [[x, w, 0]];
  let t = 0;
  const segs = (b.legs ?? []).map(l => { const s = { at: t, w: l.flightMin }; t += l.flightMin + l.turnMin; return s; });
  const text = forcedText ?? (w >= 46 ? blockCodes(b) : '');
  const interactive = !!onKeyDown;
  return pieces.map(([left, width, shift], i) => (
    <div
      key={i}
      className={className}
      style={{ left, width: Math.max(2, width), '--c': color }}
      title={interactive ? `${label}\n${hint}` : undefined}
      data-block={i === 0 ? dataBlock : undefined}
      tabIndex={interactive ? (i === 0 ? tabIndex : -1) : undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      role={interactive ? 'button' : undefined}
      aria-label={interactive && i === 0 ? label : undefined}
      aria-pressed={interactive && i === 0 ? !!selected : undefined}
      aria-hidden={interactive && i > 0 ? 'true' : undefined}
    >
      {segs.map((s, k) => (
        <span key={k} className="sched-seg-fly" style={{ left: s.at * pxPerMin - shift, width: Math.max(1, s.w * pxPerMin) }} />
      ))}
      {i === 0 && text && <span className="sched-block-label">{cargo ? '📦 ' : ''}{text}</span>}
    </div>
  ));
}

/** The flight in the way, in the player's words: "SYD–BNE". */
function clashName(row, by, routeId) {
  if (by.routeId === routeId) return 'this route’s own flight';
  const m = row.meta[by.routeId] ?? {};
  return `${m.origin}–${m.destination}`;
}

/** "Mon, Wed and Fri"; all seven is "every day". */
function listDays(days) {
  const ds = [...new Set(days)].sort((a, b) => a - b).map(d => DAYS[d]);
  if (ds.length === 7) return 'every day';
  return ds.length < 2 ? ds.join('') : `${ds.slice(0, -1).join(', ')} and ${ds.at(-1)}`;
}

/** What setting a timetable did (a pinsForTimetable result), for the panel.
 *  Times are local at the route's origin (`off`), like the ones typed. */
export function timetableNotice(res, { off = 0, name = () => 'another flight' } = {}) {
  if (!res) return { tone: 'bad', text: 'Type a departure time and tick at least one day.' };
  if (res.error === 'too-many') {
    const over = res.timed - res.flights;
    return {
      tone: 'bad',
      text: `This route flies ${res.flights} time${res.flights === 1 ? '' : 's'} a week on this aircraft, and this timetable has ${res.timed} departures. `
        + `Untick ${over} day${over === 1 ? '' : 's'} or remove a time. To fly more often, raise the route’s frequency first.`,
    };
  }
  if (res.error === 'too-close') {
    const a = `${DAYS[res.a.day]} ${clockLabel(res.a.tod)}`, b = `${DAYS[res.b.day]} ${clockLabel(res.b.tod)}`;
    const next = res.a.day * DAY_MIN + res.a.tod + Math.ceil(res.dur / 5) * 5;
    return {
      tone: 'bad',
      text: `${a} and ${b} are too close together. The aircraft is away for ${durLabel(res.dur)} on each round trip, `
        + `so after ${a} the next departure can be ${weekLabel(next)} at the earliest.`,
    };
  }
  const rest = res.flights - res.timed;
  const moved = res.bumped.length + res.auto.length;
  const parts = [];
  if (!moved) parts.push(res.set === 1 ? '1 flight set.' : rest ? `${res.set} flights set.` : `All ${res.set} flights set.`);
  else if (!res.set) parts.push(`None of the ${res.timed} departures could be set as typed.`);
  else parts.push(`${res.set} of ${res.timed} departures set as typed.`);
  // Days that hit the same thing and moved the same way are said once: a
  // daily flight in the way of a daily timetable is one sentence, not seven.
  const sameDay = (x, min) => localDayTime(min + off, 0).day === x.day;
  const groups = new Map();
  for (const x of res.bumped) {
    const tidy = sameDay(x, x.by.start) && sameDay(x, x.at);
    const key = tidy ? [x.tod, x.by.routeId, localDayTime(x.by.start, off).tod, localDayTime(x.at, off).tod].join('|') : `${x.day}|${x.tod}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  const notes = [
    ...[...groups.values()].map(g => {
      const x = g[0];
      if (g.length === 1) return `${DAYS[x.day]} ${clockLabel(x.tod)} is taken by ${name(x.by)} (leaves ${weekLabel(x.by.start + off)}), so that flight leaves at ${weekLabel(x.at + off)}.`;
      return `${clockLabel(x.tod)} on ${listDays(g.map(y => y.day))} is taken by ${name(x.by)} (leaves ${clockLabel(localDayTime(x.by.start, off).tod)}), so those flights leave at ${clockLabel(localDayTime(x.at, off).tod)}.`;
    }),
    ...res.auto.map(x => `${DAYS[x.day]} ${clockLabel(x.tod)} has no room within 12 hours (${name(x.by)} is in the way), so that flight is placed automatically.`),
  ];
  parts.push(...notes.slice(0, 3));
  if (notes.length > 3) parts.push(`${notes.length - 3} more moved the same way.`);
  if (rest > 0) parts.push(`The other ${rest} flight${rest === 1 ? ' is' : 's are'} placed automatically.`);
  return { tone: moved ? 'warn' : 'ok', text: parts.join(' ') };
}

/**
 * A route's week as rows of "this time, on these days". Typed once and set
 * together, so a 14×/week route is two times, not fourteen flights to move.
 * The rows start from what the route flies now (models/schedule.js
 * timetableRows) and nothing changes until Set timetable.
 */
export function TimetableForm({ origin, pair, tail, flights, dur, banked = false, initialRows, onSet }) {
  const nextId = useRef(0);
  const [rows, setRows] = useState(() => initialRows.map(r => ({
    id: ++nextId.current, text: r.tod == null ? '' : clockLabel(r.tod), days: [...r.days],
  })));
  const parsed = rows.map(r => (r.text.trim() === '' ? null : parseClock(r.text)));
  const badRow = rows.find((r, i) => r.text.trim() !== '' && parsed[i] == null);
  const want = new Set();
  rows.forEach((r, i) => {
    if (parsed[i] == null) return;
    r.days.forEach((on, d) => { if (on) want.add(`${d}|${snapClock(parsed[i])}`); });
  });
  const timed = want.size;
  const over = timed - flights;
  const edit = (id, patch) => setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const tidy = (id) => setRows(rs => rs.map(r => {
    const t = r.id === id ? parseClock(r.text) : null;
    return t == null ? r : { ...r, text: clockLabel(snapClock(t)) };
  }));
  const add = () => setRows(rs => [...rs, { id: ++nextId.current, text: '', days: Array(7).fill(flights - timed >= 7) }]);
  const ready = !badRow && timed > 0 && over <= 0;
  const apply = () => { if (ready) onSet(rows.map((r, i) => ({ tod: parsed[i], days: r.days }))); };

  let status, statusBad = false;
  if (badRow) { status = `“${badRow.text.trim()}” isn’t a time. Use 24-hour times like 07:30 or 18:05.`; statusBad = true; }
  else if (over > 0) { status = `${timed} departures, but this route flies ${flights} a week on this aircraft. Untick ${over} day${over === 1 ? '' : 's'}.`; statusBad = true; }
  else if (!timed) status = 'Type a time and tick the days it flies.';
  else if (timed < flights) status = `${timed} of ${flights} flights timed. The other ${flights - timed} ${flights - timed === 1 ? 'is' : 'are'} placed automatically.`;
  else status = `All ${flights} flights timed.`;

  return (
    <div className="sched-tt">
      <div className="sched-tt-head">
        <strong>Whole week</strong>
        <span className="sched-meta">
          {pair} on {tail} · {flights} flights a week · {durLabel(dur)} round trip{banked ? ' (longer when it waits for a bank)' : ''} · times are local at {origin}
        </span>
      </div>
      {rows.map((r, i) => (
        <div className="sched-tt-row" key={r.id}>
          <input
            className="sched-time" type="text" inputMode="numeric" autoComplete="off" spellCheck={false}
            value={r.text} placeholder="07:30" maxLength={8}
            aria-label={`Departure time ${i + 1}, local time at ${origin}`}
            aria-invalid={r.text.trim() !== '' && parsed[i] == null ? 'true' : undefined}
            onChange={e => edit(r.id, { text: e.target.value })}
            onBlur={() => tidy(r.id)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
          />
          <div className="sched-daypick" role="group" aria-label={`Days the ${r.text.trim() || 'new'} departure flies`}>
            {DAY_NAMES.map((name, d) => (
              <button
                key={name} type="button" aria-pressed={!!r.days[d]} aria-label={name} title={name}
                onClick={() => edit(r.id, { days: r.days.map((on, k) => (k === d ? !on : on)) })}
              >{name.slice(0, 2)}</button>
            ))}
          </div>
          {rows.length > 1 && (
            <button type="button" className="sched-x" onClick={() => setRows(rs => rs.filter(x => x.id !== r.id))}
              aria-label={`Remove the ${r.text.trim() || 'empty'} departure`} title="Remove this time">✕</button>
          )}
        </div>
      ))}
      <div className="sched-tt-foot">
        <button type="button" className="sched-add" onClick={add}>+ Add a time</button>
        <span className={`sched-meta${statusBad ? ' is-bad' : ''}`} role="status">{status}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary sched-btn" onClick={apply} disabled={!ready}>Set timetable</button>
      </div>
    </div>
  );
}

/** One flight's own departure time, typed. Local at the route's origin. */
function FlightTime({ origin, day, tod, onSet }) {
  const [text, setText] = useState(() => clockLabel(tod));
  const t = text.trim() === '' ? null : parseClock(text);
  const bad = text.trim() !== '' && t == null;
  const go = () => { if (t != null) { setText(clockLabel(snapClock(t))); onSet(snapClock(t)); } };
  const id = `sched-flight-time-${origin}`;
  return (
    <>
      <label className="sched-meta" htmlFor={id}>{DAYS[day]} only: leaves {origin} at</label>
      <input
        id={id} className="sched-time" type="text" inputMode="numeric" autoComplete="off" spellCheck={false}
        value={text} placeholder="07:30" maxLength={8} aria-invalid={bad ? 'true' : undefined}
        title={`Local time at ${origin}. Use 24-hour times like 07:30 or 18:05.`}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); go(); } }}
      />
      <button type="button" className="btn btn-ghost sched-btn" onClick={go} disabled={t == null}>Set</button>
    </>
  );
}

function BlockDetail({ panelRef, row, b, zoneOff, notice, onNudge, onPin, onUnpin, onRetime, onSetTimetable, onClose, bankCtx = null, tt = null, onSnap }) {
  const m = row.meta[b.routeId] ?? {};
  const origin = b.stops[0];
  const off = utcOffsetMinutes(getAirport(origin));
  const here = localDayTime(b.start, off);
  const flights = routeFlights(row.week, b.routeId);
  // The form starts again from the route as it stands whenever the route's
  // week changes (a set, a drag, a nudge) — not when another of its flights is
  // picked, so times typed but not yet set survive a look round the week.
  const formKey = `${row.a.id}|${b.routeId}|${row.week.blocks.filter(x => x.routeId === b.routeId).map(x => `${x.pinned ? 'p' : 'a'}${x.start}`).join('.')}`;
  // Hub-bank worlds: each landing at and departure from a banked hub — does it
  // make a bank, and how many flights does it meet?
  const events = bankCtx ? blockHubEvents(b, bankCtx) : [];
  const localHm = (code, utc) => weekLabel(utc + utcOffsetMinutes(getAirport(code))).slice(4);
  const bankHm = (code, bank) => (bank == null ? '' : localHm(code, bank));
  const snapTo = events.some(e => !e.made) && b.pinned ? snapToBank(row.week, b, bankCtx) : null;
  let t = b.start;
  const legs = b.legs.map(l => {
    const dep = t, arr = t + l.flightMin;
    t += l.flightMin + l.turnMin;
    const fo = utcOffsetMinutes(getAirport(l.from)), to = utcOffsetMinutes(getAirport(l.to));
    return { ...l, depLocal: weekLabel(dep + fo), arrLocal: weekLabel(arr + to) };
  });
  return (
    <div className="sched-detail card" ref={panelRef}>
      <div className="sched-detail-head" aria-live="polite">
        <span className="sched-key" style={{ background: m.color }} />
        <strong>{m.cargo ? '📦 ' : ''}{b.stops.join(' → ')} → {b.stops[0]}</strong>
        <span className="sched-meta">· {row.label} · {b.pinned ? 'set by you' : 'placed automatically'} · leaves {weekLabel(b.start + zoneOff)} on your timeline</span>
        <span style={{ flex: 1 }} />
        <button className="sched-x" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="sched-legs">
        {legs.map((l, i) => (
          <div key={i}>
            <span className="sched-leg-code">{l.from}</span> {l.depLocal}
            <span className="sched-arrow">→</span>
            <span className="sched-leg-code">{l.to}</span> {l.arrLocal}
            <span className="sched-meta"> · {Math.floor(l.flightMin / 60)}h{pad2(l.flightMin % 60)}</span>
          </div>
        ))}
        <div className="sched-meta">Local times at each airport.</div>
      </div>
      {events.length > 0 && (
        <div className="sched-banks">
          {events.map((e, i) => {
            const n = connectionsAt(tt, e.hub, e.at, e.kind, e.kind === 'arr' ? e.from : e.to);
            return (
              <div key={i} className={e.made ? '' : 'is-off'}>
                {e.kind === 'arr' ? 'Lands' : 'Leaves'} <span className="sched-leg-code">{e.hub}</span> {localHm(e.hub, e.at)}
                {' — '}
                {e.made ? `${e.kind === 'arr' ? 'in time for' : 'in'} the ${bankHm(e.hub, e.bank)} bank` : 'between banks'}
                {' · '}
                {e.kind === 'arr' ? `${n} onward flight${n === 1 ? '' : 's'} to connect to` : `${n} flight${n === 1 ? '' : 's'} feed it`}
              </div>
            );
          })}
          {b.legs.filter(l => l.waitMin).map((l, i) => (
            <div key={`w${i}`} className="sched-meta">
              Waits {Math.floor(l.waitMin / 60)}h{pad2(l.waitMin % 60)} at {l.to}{l.overnight ? ' overnight' : ''} to make the next bank.
            </div>
          ))}
          {b.plain && <div className="sched-meta">This aircraft&apos;s week is too full to wait for a bank on this flight.</div>}
          {snapTo != null && (
            <div>
              <button className="btn btn-primary sched-btn" onClick={() => onSnap?.(snapTo)}>
                Snap to the bank (leave {weekLabel(snapTo + zoneOff)})
              </button>
            </div>
          )}
        </div>
      )}
      <div className="sched-detail-actions">
        <FlightTime key={b.key} origin={origin} day={here.day} tod={here.tod} onSet={onRetime} />
        <span className="sched-nudge">
          <button className="btn btn-ghost sched-btn" onClick={() => onNudge(-60)}>−1h</button>
          <button className="btn btn-ghost sched-btn" onClick={() => onNudge(-15)}>−15m</button>
          <button className="btn btn-ghost sched-btn" onClick={() => onNudge(15)}>+15m</button>
          <button className="btn btn-ghost sched-btn" onClick={() => onNudge(60)}>+1h</button>
        </span>
        <span style={{ flex: 1 }} />
        {b.pinned
          ? <button className="btn btn-ghost sched-btn" onClick={onUnpin}>Unpin (back to automatic)</button>
          : <button className="btn btn-ghost sched-btn" onClick={onPin}>Pin at this time</button>}
      </div>
      {flights > 1 && (
        <TimetableForm
          key={formKey}
          origin={origin} pair={`${origin}–${blockCodes(b)}`} tail={row.label} flights={flights} dur={b.dur}
          banked={typeof row.week.durAt === 'function'}
          initialRows={timetableRows(row.week, b.routeId, off, here.day)}
          onSet={onSetTimetable}
        />
      )}
      {notice && <div className={`sched-notice is-${notice.tone}`} role="status">{notice.text}</div>}
    </div>
  );
}
