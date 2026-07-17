import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Build stamp for the in-game footer (mirrors the root vite.config.js).
// Without these defines the footer falls back to "v0.0.0 · build dev".
function buildId() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 7);
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; }
}
const pkgVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;

// The hub picker imports airport data straight from @tailwinds/engine (two
// directories up), so allow Vite's dev server to serve files from the repo root.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  // Two pages: index.html is the static marketing landing; play.html mounts the
  // React app (lobby + full game UI, hash-routed: /play#/w/<id>/play).
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        play: fileURLToPath(new URL('play.html', import.meta.url)),
      },
    },
  },
  // GENERATED public dir (gitignored) — built by tools/headwinds-public.mjs
  // (predev/prebuild): the shared repo public/ re-branded for Headwinds (teal
  // pages, Headwinds canonicals/manifest) plus brand art and page overrides.
  // The full game UI still finds the solo app's static assets here because the
  // generator copies them through.
  publicDir: fileURLToPath(new URL('public', import.meta.url)),
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
  },
});
