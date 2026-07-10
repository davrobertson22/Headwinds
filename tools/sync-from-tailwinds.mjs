#!/usr/bin/env node
// Sync the latest Tailwinds (solo) game into this Headwinds monorepo.
//
//   node tools/sync-from-tailwinds.mjs [path-to-tailwinds-repo]
//   node tools/sync-from-tailwinds.mjs --check        # report only, change nothing
//
// What it does (the recipe several sessions ran by hand, scripted):
//   1. Pure engine modules  → packages/engine/src/{data,models,utils}
//   2. App code + static    → src/, index.html, vite.config.js, public/, docs/, tools/
//   3. Regenerates packages/engine/src/reducer.mjs from Tailwinds' GameContext.jsx
//      (marker-based, not line numbers), rewriting import paths for the package
//   4. Regenerates the src/{data,models,utils} re-export shims
//   5. Keeps Headwinds-owned files: thin src/store/GameContext.jsx (with
//      RemoteGameProvider), package.json, headwinds tools, golden-master
//   6. Repoints tools/strategy-sim at the canonical engine reducer
//   7. Reports engine actions missing from the server allow-list (world.mjs)
//
// After it runs: `npm test`, then `node tools/golden-master/run.mjs --update`
// (behavior changes are usually intentional — that's the point of syncing),
// then commit. The script prints the exact commands.
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HW = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2).filter((a) => a !== '--check');
const CHECK = process.argv.includes('--check');
const TW = path.resolve(args[0] ?? path.join(HW, '..', 'Airline Management Game'));

if (!existsSync(path.join(TW, 'src', 'store', 'GameContext.jsx'))) {
  console.error(`✗ Tailwinds repo not found at: ${TW}`);
  console.error('  Pass the path: node tools/sync-from-tailwinds.mjs ~/path/to/tailwinds');
  process.exit(1);
}
console.log(`Syncing Tailwinds → Headwinds${CHECK ? ' (CHECK ONLY)' : ''}`);
console.log(`  from: ${TW}\n  into: ${HW}\n`);

const isBackup = (f) => /\.(bak|pre\w*)$/.test(f);
const jsFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.js') && !isBackup(f));

// Utils are split: pure ones live in the engine, browser-bound ones in the app.
const PURE_UTILS = ['simulation.js', 'market.js', 'financeProjection.js', 'fuel.js'];
const APP_UTILS = ['ads.js', 'logoImage.js'];

let changes = 0;
function put(dest, content) {
  if (existsSync(dest) && readFileSync(dest, 'utf8') === content) return;
  changes++;
  if (CHECK) { console.log(`  would write ${path.relative(HW, dest)}`); return; }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, content);
}
function copy(src, dest) { put(dest, readFileSync(src, 'utf8')); }

// ── 1. Engine modules ─────────────────────────────────────────────────────────
for (const f of jsFiles(path.join(TW, 'src/data'))) {
  copy(path.join(TW, 'src/data', f), path.join(HW, 'packages/engine/src/data', f));
}
for (const f of jsFiles(path.join(TW, 'src/models'))) {
  copy(path.join(TW, 'src/models', f), path.join(HW, 'packages/engine/src/models', f));
}
for (const f of jsFiles(path.join(TW, 'src/utils'))) {
  if (PURE_UTILS.includes(f)) copy(path.join(TW, 'src/utils', f), path.join(HW, 'packages/engine/src/utils', f));
  else if (APP_UTILS.includes(f)) copy(path.join(TW, 'src/utils', f), path.join(HW, 'src/utils', f));
  else console.warn(`  ⚠ unknown utils file ${f} — classify it in PURE_UTILS or APP_UTILS (skipped)`);
}

// ── 2. App code + static ─────────────────────────────────────────────────────
if (!CHECK) {
  const rsync = (from, to, del) =>
    execSync(`rsync -a ${del ? '--delete ' : ''}--exclude .DS_Store "${from}/" "${to}/"`, { stdio: 'inherit' });
  rsync(path.join(TW, 'src/components'), path.join(HW, 'src/components'), true);
  rsync(path.join(TW, 'src/hooks'), path.join(HW, 'src/hooks'), true);
  rsync(path.join(TW, 'public'), path.join(HW, 'public'), true);
  rsync(path.join(TW, 'docs'), path.join(HW, 'docs'), false);
  rsync(path.join(TW, 'tools'), path.join(HW, 'tools'), false); // no --delete: keeps headwinds-*/golden-master
}
for (const f of ['src/App.jsx', 'src/main.jsx', 'src/index.css', 'index.html', 'vite.config.js']) {
  copy(path.join(TW, f), path.join(HW, f));
}

// ── 3. Regenerate the engine reducer from GameContext.jsx (marker-based) ─────
const gc = readFileSync(path.join(TW, 'src/store/GameContext.jsx'), 'utf8').split('\n');
const findLine = (re, why) => {
  const i = gc.findIndex((l) => re.test(l));
  if (i === -1) throw new Error(`marker not found: ${why} (${re}) — GameContext.jsx structure changed, update this script`);
  return i;
};
const exportLine = findLine(/^export \{ reducer as gameReducer/, 'reducer export');
const reconcileLine = findLine(/^function reconcileState/, 'reconcileState');
const providerLine = findLine(/^export function GameProvider/, 'GameProvider');
// Include reconcileState's leading doc comment.
let docStart = reconcileLine;
while (docStart > 0 && /^(\/\*\*|\s\*|\s\*\/)/.test(gc[docStart - 1])) docStart--;
const reducerSrc = [
  '// @tailwinds/engine — canonical pure reducer (gameReducer + freshState + reconcileState).',
  '// GENERATED by tools/sync-from-tailwinds.mjs from the solo app\'s GameContext.jsx',
  '// (the authoritative logic), with import paths rewritten for this package.',
  '// Do not hand-edit — changes belong in Tailwinds; re-run the sync.',
  ...gc.slice(1, exportLine + 1),          // skip the react import; keep the export line
  '',
  ...gc.slice(docStart, providerLine).filter((_, i, a) => !(i === a.length - 1 && a[i] === '')),
].join('\n').replace(/from '\.\.\//g, "from './");
put(path.join(HW, 'packages/engine/src/reducer.mjs'), reducerSrc);

// Sanity: the provider section this script does NOT carry over (the thin
// GameContext template is Headwinds-owned). Warn if upstream changed it.
const providerSection = gc.slice(providerLine).join('\n');
const providerHashFile = path.join(HW, 'tools/.tailwinds-provider.hash');
const hash = [...providerSection].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0).toString(16);
if (existsSync(providerHashFile) && readFileSync(providerHashFile, 'utf8').trim() !== hash) {
  console.warn('  ⚠ Tailwinds\' GameProvider/useGame section changed — review src/store/GameContext.jsx (Headwinds keeps its own thin version with RemoteGameProvider)');
}
if (!CHECK) writeFileSync(providerHashFile, hash + '\n');

// ── 4. Shims ──────────────────────────────────────────────────────────────────
for (const dir of ['data', 'models', 'utils']) {
  for (const f of jsFiles(path.join(HW, 'packages/engine/src', dir))) {
    put(path.join(HW, 'src', dir, f),
      `// SHIM — the real module lives in @tailwinds/engine (packages/engine/src/).\n` +
      `// GENERATED by tools/sync-from-tailwinds.mjs.\n` +
      `export * from '../../packages/engine/src/${dir}/${f}';\n`);
  }
}

// ── 5/6. Headwinds-owned files & repoints ─────────────────────────────────────
if (!CHECK) {
  rmSync(path.join(HW, 'src/store/_engine.generated.mjs'), { force: true }); // stale solo artifact
  const harness = path.join(HW, 'tools/strategy-sim/harness.mjs');
  if (existsSync(harness)) {
    put(harness, readFileSync(harness, 'utf8')
      .replace("'../../src/store/_engine.generated.mjs'", "'../../packages/engine/src/reducer.mjs'"));
  }
}

// ── 6b. Re-apply Headwinds multiplayer patches to synced engine files ────────
// The engine is synced FROM Tailwinds, but Headwinds needs a few small hooks
// (humans-as-competitors; skip AI evolution/encroachment in multiplayer). Each
// patch is idempotent: skipped when already applied, applied when its anchor is
// found, and a HARD ERROR when neither — that means upstream refactored the
// code and the patch must be updated by hand. NEVER delete a failing patch
// without understanding it: without these hooks multiplayer silently regresses
// to AI competitors. See apps/headwinds-server/src/lib/humanRivals.mjs.
const MULTIPLAYER_PATCHES = [
  {
    file: 'packages/engine/src/utils/simulation.js',
    why: 'inject human rivals (state.humanRivals) into per-pair demand',
    anchor: `  // Encroachment challengers, keyed by O&D pair, injected into the demand model so
  // they split the route's passenger pool with the player.
  const encroachByPair = (pairKey) => {
    const e = encroachments?.[pairKey];
    return e ? [e] : [];
  };`,
    patched: `  // Encroachment challengers, keyed by O&D pair, injected into the demand model so
  // they split the route's passenger pool with the player.
  // Multiplayer (Headwinds): state.humanRivals carries OTHER HUMAN PLAYERS'
  // offers per pair in the same spec shape — they flow through the identical
  // channel, so every contested city pair splits demand between real people.
  const humanRivalsByPair = state.humanRivals ?? {};
  const encroachByPair = (pairKey) => {
    const e = encroachments?.[pairKey];
    const humans = humanRivalsByPair[pairKey] ?? [];
    return e ? [e, ...humans] : humans;
  };`,
  },
  {
    file: 'packages/engine/src/reducer.mjs',
    why: 'skip AI route encroachment in multiplayer',
    anchor: `      // ── Route encroachment: AI carriers contest the player's fat routes ──────
      // Decided from the PRIOR week's outcome (load factor + fares), gated by airline
      // size, then injected into this week's demand model so they split passengers.
      const { encroachments: updatedEncroachments, events: encroachEvents } = tickEncroachment({`,
    patched: `      // Multiplayer (Headwinds): no AI carriers exist. The server injects other
      // human players as state.competitors + state.humanRivals each tick, so AI
      // encroachment, AI network evolution, and AI startups are all skipped.
      const isMultiplayerWorld = state.multiplayer === true;

      // ── Route encroachment: AI carriers contest the player's fat routes ──────
      // Decided from the PRIOR week's outcome (load factor + fares), gated by airline
      // size, then injected into this week's demand model so they split passengers.
      const { encroachments: updatedEncroachments, events: encroachEvents } = isMultiplayerWorld
        ? { encroachments: state.encroachments ?? {}, events: [] }
        : tickEncroachment({`,
  },
  {
    file: 'packages/engine/src/reducer.mjs',
    why: 'skip AI competitor evolution/startups in multiplayer',
    anchor: `      const { competitors: aiCompetitors, events: competitorEvents } =
        tickCompetitorAI(currentCompetitors, {`,
    patched: `      // In multiplayer the "competitors" are real humans injected by the server:
      // they manage their own networks, so the AI never moves them, no AI
      // startups spawn, and no scripted fare wars / bankruptcies / mergers fire.
      const { competitors: aiCompetitors, events: competitorEvents } = isMultiplayerWorld
        ? { competitors: currentCompetitors, events: [] }
        : tickCompetitorAI(currentCompetitors, {`,
  },
];

// Branding patches: the shared UI (synced from Tailwinds) renders Headwinds
// branding when `remote` is true (multiplayer) and stays byte-identical for
// solo. Ideally these land upstream in Tailwinds (they're no-ops there — remote
// is always false in solo) and can then be deleted here.
MULTIPLAYER_PATCHES.push(
  {
    file: 'src/App.jsx',
    why: 'Headwinds wordmark in the game top bar (multiplayer)',
    anchor: `        <div className="topbar-logo">
          <span className="topbar-logo-icon"><TailwindsMark size={20} /></span>
          Tailwinds - Airline Manager
        </div>`,
    patched: `        <div className="topbar-logo">
          {remote ? (
            <span style={{ fontWeight: 800, letterSpacing: 2, color: 'var(--accent)' }}>
              HEADWINDS<span style={{ opacity: 0.55, fontWeight: 400, letterSpacing: 0 }}> · multiplayer</span>
            </span>
          ) : (<>
            <span className="topbar-logo-icon"><TailwindsMark size={20} /></span>
            Tailwinds - Airline Manager
          </>)}
        </div>`,
  },
  {
    file: 'src/App.jsx',
    why: 'Competition tab reads "Rivals" in multiplayer',
    anchor: `            <Icon size={14} />
            <span>{label}</span>
          </button>`,
    patched: `            <Icon size={14} />
            {/* In multiplayer the Competition tab shows the OTHER HUMANS in
                your world — "Rivals" says what it actually is. */}
            <span>{remote && id === 'competition' ? 'Rivals' : label}</span>
          </button>`,
  },
  {
    file: 'src/App.jsx',
    why: 'brand-aware version footer',
    anchor: `            Tailwinds v{APP_VERSION} · build {BUILD_ID}`,
    patched: `            {remote ? 'Headwinds' : 'Tailwinds'} v{APP_VERSION} · build {BUILD_ID}`,
  },
);
// The onboarding tour is fully reworded for multiplayer. Rather than patch its
// many hunks, keep the Headwinds copy authoritative: if a sync brings a NEW
// Tailwinds tour that lacks the remote-aware fields, fail loudly below.
MULTIPLAYER_PATCHES.push({
  file: 'src/components/OnboardingTour.jsx',
  why: 'multiplayer-aware tour (remoteTitle/remoteBody steps + useGame)',
  anchor: '__TOUR_MUST_BE_REMOTE_AWARE__',        // never matches — assert-only
  patched: "import { useGame } from '../store/GameContext.jsx';",
});

let patchErrors = 0;
for (const p of MULTIPLAYER_PATCHES) {
  const fp = path.join(HW, p.file);
  const src = readFileSync(fp, 'utf8');
  if (src.includes(p.patched)) continue; // already applied
  if (src.includes(p.anchor)) {
    if (!CHECK) writeFileSync(fp, src.replace(p.anchor, p.patched));
    changes++;
    console.log(`  ✚ multiplayer patch ${CHECK ? 'would be ' : ''}applied: ${p.file} (${p.why})`);
  } else {
    patchErrors++;
    console.error(`\n  ✗ MULTIPLAYER PATCH FAILED: ${p.file} (${p.why})`);
    console.error('    Neither the patch nor its anchor was found — Tailwinds refactored this code.');
    console.error('    Update MULTIPLAYER_PATCHES in tools/sync-from-tailwinds.mjs before committing.');
  }
}
if (patchErrors > 0) {
  console.error(`\n✗ ${patchErrors} multiplayer patch(es) failed — resolve before committing this sync.`);
  process.exit(1);
}

// ── 7. Allow-list coverage report ─────────────────────────────────────────────
const reducerActions = new Set([...reducerSrc.matchAll(/case '([A-Z_]+)'/g)].map((m) => m[1]));
const worldSrc = readFileSync(path.join(HW, 'apps/headwinds-server/src/world.mjs'), 'utf8');
const allowed = new Set([...worldSrc.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
const RESERVED = new Set(['ADVANCE_WEEK', 'START_GAME', 'LOAD_STATE', 'RESET']);
const uncovered = [...reducerActions].filter((a) => !allowed.has(a) && !RESERVED.has(a));
if (uncovered.length) {
  console.warn(`\n  ⚠ NEW reducer actions not in the server allow-list (apps/headwinds-server/src/world.mjs):`);
  for (const a of uncovered) console.warn(`      '${a}',`);
  console.warn('    Add them if players should be able to submit them in multiplayer.');
}

console.log(`\n${CHECK ? 'Would change' : 'Changed'} ${changes} file(s).`);
console.log(`\nNext steps:
  npm test
  node tools/headwinds-tick-test.mjs
  node tools/golden-master/run.mjs --update && node tools/golden-master/run.mjs
  git add -A && git commit -m "Sync from Tailwinds: <what changed>"`);
