import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The hub picker imports airport data straight from @tailwinds/engine (two
// directories up), so allow Vite's dev server to serve files from the repo root.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  // The full game UI (mounted on '#/w/<id>/play') references the solo game's
  // static assets (logos, aircraft art) by absolute path — serve the repo's
  // shared public/ so those resolve here too.
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
  },
});
