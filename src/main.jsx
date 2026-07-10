import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { GameProvider } from './store/GameContext.jsx';
import UpdatePrompt from './components/UpdatePrompt.jsx';
import { Analytics } from '@vercel/analytics/react';
import './index.css';

// The static landing page stays in place as the front door for every visit.
// It is dismissed only when the user clicks "Play Free Now" (sets display:none),
// so there's no flash/flicker from JS removing it on load.

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GameProvider>
      <App />
    </GameProvider>
    <UpdatePrompt />
    <Analytics />
  </React.StrictMode>
);

// ── PWA service worker registration ──────────────────────────────────────────
// Registered only in production builds so it never interferes with Vite's dev
// server / HMR. The worker is network-first (see public/sw.js), so it can't
// pin users to a stale build. To fully remove the PWA, delete this block and
// public/sw.js — and deploy the kill-switch worker described in ROLLBACK.md to
// clear it from browsers that already registered it.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      // Nudge the browser to re-check for a new worker when the tab regains focus,
      // so an open session doesn't sit indefinitely on a superseded build. The
      // visible "new version available" banner is driven by UpdatePrompt, which
      // detects a changed app-bundle hash even when sw.js itself is unchanged.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration.update().catch(() => {});
      });
    }).catch(() => {
      /* registration failure is non-fatal — the app still works normally */
    });
  });
}
