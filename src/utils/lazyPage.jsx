import { lazy, Suspense } from 'react';

/**
 * A page that loads its code the first time it's opened.
 *
 * Every page used to sit in the one script the game starts with (3.2 MB), so
 * a player waited for the Market, the Rivals tab and the Wiki to download and
 * compile before seeing the Dashboard. Now each page is its own chunk.
 *
 * - The page carries its own Suspense, so a page still loading shows a small
 *   placeholder in its own spot — the map view's map and the top bar stay put.
 * - Once loaded, later visits render at once (no placeholder flash).
 * - preloadPages() fetches them all; App calls it when the browser is idle
 *   after the first screen is up, so the first click on a tab rarely waits.
 *   A test that server-renders a lazy page awaits it first: renderToString
 *   can't wait, and an already-loaded page renders synchronously.
 */
const registry = [];

export function lazyPage(load, name = 'page') {
  let Loaded = null;
  let pending = null;
  const preload = () => {
    if (Loaded) return Promise.resolve(Loaded);
    pending ??= load().then((m) => { Loaded = m.default; return Loaded; });
    return pending;
  };
  // Once the code is here (preloaded), hand React.lazy a thenable that answers
  // synchronously: React then renders the page straight away instead of
  // flashing the placeholder for a tick. One tree shape either way — a page
  // must never switch between two shapes, or React remounts it and it loses
  // its state (search, sort, selection).
  const Lazy = lazy(() => (Loaded
    ? { then: (resolve) => resolve({ default: Loaded }) }
    : preload().then((C) => ({ default: C }))));
  function Page(props) {
    return (
      <Suspense fallback={<div className="page-loading" role="status" aria-live="polite">Loading…</div>}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  Page.displayName = `LazyPage(${name})`;
  Page.preload = preload;
  registry.push(preload);
  return Page;
}

export function preloadPages() {
  return Promise.all(registry.map((p) => p().catch(() => null)));
}

/** Preload every page once the browser has nothing better to do. */
export function preloadPagesWhenIdle(delayMs = 1500) {
  if (typeof window === 'undefined') return;
  const go = () => { preloadPages(); };
  setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(go, { timeout: 5000 });
    else go();
  }, delayMs);
}
