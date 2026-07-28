import { useEffect, useRef } from 'react';

// A setInterval that pauses while the tab is hidden, and fires once immediately
// when the tab comes back.
//
// Why this exists: every screen in the app polls on a timer, and nothing stopped
// those timers when the tab was backgrounded. Headwinds ticks hourly and people
// leave a world parked in a spare tab all day, so a browser that had been idle
// since breakfast was still asking the server for news, messages and standings
// every 10-60 seconds. That is server cost — and Supabase egress — spent on data
// nobody is looking at.
//
// Pausing is safe because it is paired with the visibilitychange refresh below:
// coming back to the tab refetches straight away rather than waiting out the
// remainder of an interval, so a returning player never sees stale data.
//
// The callback is held in a ref so that a caller passing a fresh closure on
// every render (the usual `useCallback` result) doesn't tear down and rebuild
// the timer each time — the interval depends only on the delay.
export function useVisibleInterval(fn, ms) {
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!ms) return undefined;
    const tick = () => { if (document.visibilityState !== 'hidden') saved.current(); };
    const onVisible = () => { if (document.visibilityState === 'visible') saved.current(); };
    const t = setInterval(tick, ms);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms]);
}

// True when the tab is backgrounded. For callers whose interval does more than
// just poll (GamePlayScreen runs connection bookkeeping on the same timer) and
// so can't hand the whole callback to useVisibleInterval.
export function isHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}
