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
} from '../models/schedule.js';
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
// them. The timetable is cosmetic: it drives the departure board and the
// globe's planes, not demand or costs. The maths is in models/schedule.js.
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

export default function ScheduleTimeline() {
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
  const weeks = useMemo(() => airlineWeeks({ fleet, routes, cargoRoutes }, month),
    [fleet, routes, cargoRoutes, month]);
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
  const [selected, setSelected] = useState(null);   // { acId, routeId, start }
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
  live.current = { rows, pxPerMin, zoneOff, labelW, flush, queue };

  const [dragView, setDragView] = useState(null);   // what the dragged row draws
  const dragRef = useRef(null);
  const trackRefs = useRef(new Map());

  const api = useRef(null);
  if (!api.current) {
    const rowOf = (acId) => live.current.rows.find(r => r.a.id === acId);
    const select = (acId, b, how) => {
      if (how === 'key' || how === 'focus') focusNext.current = true;
      if (how === 'click') revealPanel.current = true;
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
      setSelected({ acId, routeId: b.routeId, start: to });
    };
    const pinHere = (acId, b, how) => {
      const row = rowOf(acId);
      const pins = row && pinsAfterMove(row.week, b.routeId, b, b.start);
      if (!pins) return;
      send({ [b.routeId]: pins }, 'queue');
      if (how === 'key') focusNext.current = true;
      setSelected({ acId, routeId: b.routeId, start: b.start });
    };
    const unpin = (acId, b, how) => {
      const row = rowOf(acId);
      if (!row) return;
      send({ [b.routeId]: pinsAfterUnpin(row.week, b.routeId, b.start) }, 'queue');
      // Keep the selection on that flight wherever automatic placement puts it.
      if (how === 'key') focusNext.current = true;
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
    api.current = { select, moveTo, pinHere, unpin, lockRow, resetRow, setTrack, startDrag, rowOf };
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
      // The flight as it is in the CURRENT week — state may have changed since
      // the drag began. Gone (closed route, new week): stop.
      if (d.from && !findBlock(row.week, d.from)) { end(); return; }
      const valid = over && canPlace(row.week, d.routeId, d.dur, utc, d.from);
      let blocker = null;
      if (over && !valid) {
        const skip = replacedBlock(row.week, d.routeId, d.from, utc);
        blocker = row.week.blocks.find(b => b !== skip && (b.pinned || b.routeId === d.routeId)
          && overlaps(utc, d.dur, b.start, b.dur)) ?? null;
      }
      if (utc !== d.utc || valid !== d.valid || over !== d.over || !d.shown || blocker?.key !== d.blocker?.key) {
        Object.assign(d, { utc, valid, over, shown: true, blocker: blocker ? { key: blocker.key, routeId: blocker.routeId, start: blocker.start } : null });
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
          Drag a flight to choose when it leaves, or drag one in from an aircraft&apos;s tray.
          {' '}<span className="sched-key sched-key-pinned" /> set by you
          {' '}<span className="sched-key sched-key-auto" /> placed automatically
        </div>
        <div className="sched-sub">
          Optional — anything you don&apos;t place is scheduled for you. Moving a flight sets that route&apos;s
          whole week as shown (only the flight you moved changes). Your timetable sets the departure board and
          the planes on the globe; it doesn&apos;t change demand or costs.
          {isMobile ? ' Hold a flight for a moment, then drag.' : ''}
        </div>
      </div>

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
const ScheduleRow = memo(function ScheduleRow({ row, labelW, fullW, pxPerMin, zoneOff, drag, selKey, api }) {
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
          return (
            <BlockPieces
              key={b.key} b={b} x={toX(b.start)} pxPerMin={pxPerMin} fullW={fullW}
              color={row.meta[b.routeId]?.color} cargo={row.meta[b.routeId]?.cargo}
              dataBlock={blockId(row.a.id, b)}
              tabIndex={i === tabIdx ? 0 : -1}
              selected={isSel}
              className={`sched-block${b.pinned ? ' is-pinned' : ' is-auto'}${isSel ? ' is-selected' : ''}${beingDragged ? ' is-ghost' : ''}${lifted ? ' is-lifted' : ''}${b.key === blockerKey ? ' is-blocking' : ''}`}
              label={`${pairOf(b.routeId, b)}–${row.meta[b.routeId]?.origin}, leaves ${weekLabel(b.start + zoneOff)}, ${b.pinned ? 'set by you' : 'automatic'}`}
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
                b={{ ...(shape ?? { stops: [], legs: [] }), start: drag.utc, dur: drag.dur }}
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

function BlockDetail({ panelRef, row, b, zoneOff, onNudge, onPin, onUnpin, onClose }) {
  const m = row.meta[b.routeId] ?? {};
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
      <div className="sched-detail-actions">
        <button className="btn btn-ghost sched-btn" onClick={() => onNudge(-60)}>−1h</button>
        <button className="btn btn-ghost sched-btn" onClick={() => onNudge(-15)}>−15m</button>
        <button className="btn btn-ghost sched-btn" onClick={() => onNudge(15)}>+15m</button>
        <button className="btn btn-ghost sched-btn" onClick={() => onNudge(60)}>+1h</button>
        <span style={{ flex: 1 }} />
        {b.pinned
          ? <button className="btn btn-ghost sched-btn" onClick={onUnpin}>Unpin (back to automatic)</button>
          : <button className="btn btn-primary sched-btn" onClick={onPin}>Pin at this time</button>}
      </div>
    </div>
  );
}
