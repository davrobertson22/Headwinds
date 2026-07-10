import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// ── Build stamp ───────────────────────────────────────────────────────────────
// A short, human-readable identifier baked into every build so we can tell at a
// glance which build a bug report came from. Prefers Vercel's commit SHA (present
// in CI), falls back to local git, then to 'dev' for `vite dev`.
function buildId() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA
  if (sha) return sha.slice(0, 7)
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'dev' }
}
const pkgVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
})
