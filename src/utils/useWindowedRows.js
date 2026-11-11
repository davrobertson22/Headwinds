import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Which rows of a very long table to build: the ones on screen, plus a margin.
 *
 * useProgressiveCount spreads a long list over frames but still ends with
 * every row on the page, and every row is rebuilt on every state change. That
 * is fine at 600 rows. A live airline has 4,884 aircraft: 150,000 elements,
 * 56 seconds to open the Fleet page, and 8–17 seconds for any click made on it
 * (measured 2026-11-10). Past `minTotal` rows only the visible slice exists;
 * a spacer row above and below keeps the table its full height, so the
 * scrollbar, the page below the table and "scroll to" all behave as before.
 *
 * Rows are measured as they appear (they are not all one height — badges
 * stack), so the spacers are the real heights of rows already seen and
 * `estimate` for the rest.
 *
 * The trade: the browser's find-in-page only sees the rows that exist. Short
 * lists (≤ `minTotal`) are left whole for exactly that reason.
 *
 * Usage (the hook goes with the other hooks; the list may be filtered and
 * sorted later in the render, so its length is given when the rows are built):
 *   const win = useWindowedRows({ resetKey });
 *   …
 *   const view = win.rows(list.length);
 *   <tbody ref={win.bodyRef}>
 *     {view.padTop > 0 && <tr aria-hidden="true" data-spacer=""><td colSpan={n} style={{ height: view.padTop, padding: 0, border: 0 }} /></tr>}
 *     {list.slice(view.start, view.end).map(...)}
 *     {view.padBottom > 0 && <tr aria-hidden="true" data-spacer="">…</tr>}
 *   </tbody>
 *
 * Off the browser (server rendering, the SSR tests) and for short lists
 * `view.windowed` is false and the range is the whole list — the caller keeps
 * doing whatever it did before.
 */
function canWindow() {
  return typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    && typeof document !== 'undefined' && typeof document.createElement === 'function';
}

// The measuring pass must run before paint in the browser; on the server there
// is nothing to measure and React warns about a layout effect.
const useMeasureEffect = canWindow() ? useLayoutEffect : useEffect;

/**
 * Pure: the slice [start, end) of `total` rows that intersects the band
 * [viewTop - margin, viewBottom + margin], where row i is `heightOf(i)` tall
 * and the rows are stacked from 0. Also the stacked height before `start`
 * and after `end`.
 */
export function windowSlice(total, heightOf, viewTop, viewBottom, margin = 0) {
  const lo = viewTop - margin, hi = viewBottom + margin;
  let y = 0, start = -1, end = total, padTop = 0, sum = 0;
  for (let i = 0; i < total; i++) {
    const h = heightOf(i);
    if (start < 0 && y + h > lo) { start = i; padTop = y; }
    if (start >= 0 && end === total && y >= hi) end = i;
    y += h;
    if (end === total) sum = y;
  }
  if (start < 0) {
    // The band is entirely below the list (scrolled past it): keep the tail
    // so there is always something to measure against.
    start = Math.max(0, total - 1); padTop = y - (total > 0 ? heightOf(total - 1) : 0); end = total; sum = y;
  }
  return { start, end, padTop, padBottom: Math.max(0, y - sum) };
}

export function useWindowedRows({ estimate = 56, marginRows = 14, minTotal = 150, first = 40, resetKey } = {}) {
  const able = canWindow();
  const bodyRef = useRef(null);
  const heights = useRef(new Map());       // row index -> measured px
  const keyRef = useRef(resetKey);
  if (keyRef.current !== resetKey) { keyRef.current = resetKey; heights.current = new Map(); }
  const totalRef = useRef(0);              // the list length rows() was last asked about
  const shownRef = useRef({ start: 0, end: 0, windowed: false });
  const [range, setRange] = useState({ start: 0, end: first });
  const [, bump] = useState(0);

  const heightOf = useCallback((i) => heights.current.get(i) ?? estimate, [estimate]);

  const compute = useCallback(() => {
    const el = bodyRef.current, total = totalRef.current;
    if (!el || !able || total <= minTotal) return;
    const rect = el.getBoundingClientRect();
    const view = window.innerHeight || document.documentElement.clientHeight || 800;
    const s = windowSlice(total, heightOf, -rect.top, -rect.top + view, marginRows * estimate);
    setRange((cur) => (cur.start === s.start && cur.end === s.end ? cur : { start: s.start, end: s.end }));
  }, [able, heightOf, marginRows, estimate, minTotal]);

  // Measure what is on the page; a changed height moves the spacers.
  useMeasureEffect(() => {
    const el = bodyRef.current, shown = shownRef.current;
    if (!el || !shown.windowed) return;
    let changed = false, i = shown.start;
    for (const tr of el.children) {
      if (tr.hasAttribute('data-spacer')) continue;
      const h = tr.getBoundingClientRect().height;
      if (h > 0 && Math.abs((heights.current.get(i) ?? -1) - h) > 0.5) { heights.current.set(i, h); changed = true; }
      i++;
    }
    if (changed) bump((n) => n + 1);
  });

  // Follow the scroll — of whatever scrolls (capture catches every ancestor) —
  // and the window size. Re-read when the list itself changes.
  useEffect(() => {
    if (!able) return undefined;
    let frame = 0;
    const onMove = () => { if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; compute(); }); };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    compute();
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [able, compute, resetKey]);
  const lastTotal = useRef(-1);
  useEffect(() => {
    if (lastTotal.current !== totalRef.current) { lastTotal.current = totalRef.current; compute(); }
  });

  /** The slice to build for a list of `total` rows (call once per render). */
  const rows = (total) => {
    totalRef.current = total;
    if (!able || total <= minTotal) {
      shownRef.current = { start: 0, end: total, windowed: false };
      return { start: 0, end: total, padTop: 0, padBottom: 0, windowed: false };
    }
    const start = Math.min(range.start, Math.max(0, total - 1));
    const end = Math.max(start, Math.min(range.end, total));
    let padTop = 0, padBottom = 0;
    for (let i = 0; i < start; i++) padTop += heightOf(i);
    for (let i = end; i < total; i++) padBottom += heightOf(i);
    shownRef.current = { start, end, windowed: true };
    return { start, end, padTop, padBottom, windowed: true };
  };
  return { bodyRef, rows };
}
