import { useEffect, useState, useRef } from 'react';

/**
 * UpdatePrompt — "a new version is available, reload" banner.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The app is a PWA with a network-first service worker (public/sw.js). Network-first
 * stops NEW loads from being served a stale build, but it does nothing for a tab (or
 * installed PWA) that's ALREADY open: that page keeps running whatever JS bundle it
 * booted with until it is fully reloaded. On mobile especially, players leave the app
 * open for days, so they stay on an old build and report already-fixed bugs.
 *
 * HOW IT DETECTS AN UPDATE
 * ────────────────────────
 * We can't rely on the service worker's `updatefound` event, because sw.js is a static
 * file that usually doesn't change between deploys — so the browser sees identical SW
 * bytes and never signals an update, even though the app bundle changed.
 *
 * Instead we poll the served index.html and read the hashed main-bundle filename
 * (e.g. /assets/index-BXjrA1OM.js). Vite gives every build a new hash, so if the
 * filename the server returns differs from the one this page is running, a newer build
 * is live and we surface the banner. The fetch is no-store and goes through the
 * network-first SW, so it always reflects the latest deploy.
 *
 * The banner is non-intrusive: it never force-reloads (which could interrupt someone
 * mid-action) — the player reloads when ready, or dismisses for the session.
 */

const POLL_INTERVAL_MS = 15 * 60 * 1000; // re-check every 15 min while the tab is open
const BUNDLE_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

/** The main-bundle path this page is currently running, read from its own script tag. */
function currentBundlePath() {
  const el = document.querySelector('script[type="module"][src*="/assets/index-"]');
  const src = el?.getAttribute('src') ?? '';
  const m = src.match(BUNDLE_RE);
  return m ? m[0] : null;
}

/** Fetch the live index.html and extract the deployed main-bundle path. */
async function fetchDeployedBundlePath() {
  try {
    const res = await fetch('/index.html', { cache: 'no-store' });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(BUNDLE_RE);
    return m ? m[0] : null;
  } catch {
    return null; // offline or blocked — try again next tick
  }
}

export default function UpdatePrompt() {
  const [available, setAvailable] = useState(false);
  const runningBundle = useRef(currentBundlePath());
  const dismissed = useRef(false);

  useEffect(() => {
    // Only meaningful in a real build (dev serves /src/main.jsx, no hashed bundle).
    if (!runningBundle.current) return;

    let cancelled = false;

    async function check() {
      if (cancelled || dismissed.current) return;
      const deployed = await fetchDeployedBundlePath();
      if (!cancelled && deployed && deployed !== runningBundle.current) {
        setAvailable(true);
      }
    }

    // Check shortly after load, whenever the tab regains focus, and on an interval.
    const initial = setTimeout(check, 5000);
    const interval = setInterval(check, POLL_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);

    // Secondary trigger: if the service worker itself is ever replaced, re-check too.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener?.('controllerchange', check);
    }

    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      navigator.serviceWorker?.removeEventListener?.('controllerchange', check);
    };
  }, []);

  if (!available) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 20,
        transform: 'translateX(-50%)',
        zIndex: 3000,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        maxWidth: 'calc(100vw - 32px)',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderLeft: '3px solid var(--accent)',
        borderRadius: 'var(--radius)',
        padding: '11px 14px',
        boxShadow: '0 6px 26px rgba(0,0,0,.6)',
      }}
    >
      <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.4 }}>
        A new version of Tailwinds is available.
      </div>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: 'var(--accent)',
          color: '#0a0a0a',
          border: 'none',
          borderRadius: 'calc(var(--radius) - 2px)',
          padding: '6px 14px',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        Reload
      </button>
      <button
        onClick={() => { dismissed.current = true; setAvailable(false); }}
        aria-label="Dismiss"
        style={{
          background: 'none', border: 'none', color: 'var(--text-dim)',
          cursor: 'pointer', fontSize: 17, padding: 0, lineHeight: 1, flexShrink: 0,
        }}
      >×</button>
    </div>
  );
}
