import { useEffect, useState } from 'react';

/**
 * How many rows of a long list to render right now: the first `first` at once,
 * then `step` more every frame until all `total` are on the page.
 *
 * A big airline's Fleet page is 600 rows (14,000 elements) and the Market is
 * 200 aircraft cards — built in one go, the click that opened the page froze
 * for a second or more while the browser laid all of it out. Built a slice per
 * frame, the top of the page is there at once and the rest follows within a
 * few frames, with the page answering clicks and scrolls in between. Nothing
 * is hidden: every row is on the page a moment later (find-in-page works).
 *
 * `resetKey` (e.g. the filters and sort) starts again from the first slice
 * when it changes, so a new filter is as quick as opening the page.
 *
 * Off the browser (server rendering, the SSR tests) it returns `total` — the
 * whole list, as before.
 */
function canDefer() {
  return typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    && typeof document !== 'undefined' && typeof document.createElement === 'function';
}

export function useProgressiveCount(total, { first = 40, step = 80, resetKey } = {}) {
  const [shown, setShown] = useState(() => (canDefer() ? Math.min(total, first) : total));
  const [key, setKey] = useState(resetKey);
  let n = shown;
  if (key !== resetKey) {
    // Reset during render (not in an effect) so the frame with the new filter
    // never builds the whole new list first.
    n = canDefer() ? Math.min(total, first) : total;
    setKey(resetKey);
    setShown(n);
  }
  useEffect(() => {
    if (n >= total) return undefined;
    const id = window.requestAnimationFrame(() => setShown((c) => Math.min(total, Math.max(c, n) + step)));
    return () => window.cancelAnimationFrame(id);
  }, [n, total, step]);
  return Math.min(n, total);
}
