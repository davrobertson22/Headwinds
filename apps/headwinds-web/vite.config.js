import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The hub picker imports airport data straight from @tailwinds/engine (two
// directories up), so allow Vite's dev server to serve files from the repo root.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
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
