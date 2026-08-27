#!/usr/bin/env node
// engine-drift-check.mjs — @not-a-test: a READ-ONLY report, not a pass/fail suite.
// Without --strict it always exits 0, so it carries no signal inside `npm test`;
// tools/run-tests.mjs skips it and `npm run drift` still prints the report.
//
// READ-ONLY report of divergence between the Headwinds
// and Tailwinds copies of the shared-by-convention engine (data/, models/,
// utils/). It NEVER writes anything.
//
// The two repos share the pure engine by CONVENTION, not as a package: a change
// to demand / simulation / market / data is hand-ported to both, and a missed
// port is how the two silently diverge (the "D-items" an audit later has to
// find). This lists what differs so that drift is caught by a command instead.
//
// IMPORTANT — the engines are NOT expected to be byte-identical. Headwinds has
// grown into the multiplayer SUPERSET (stock market, valuation, career, server
// hooks…), so large modules legitimately differ. Read the DRIFT list for a file
// you just edited on one side and meant to port to the other; the big permanent
// gaps (market.js, simulation.js, competitorAI.js…) are expected. Once you have
// curated an exceptions manifest of the intentionally-divergent files, run with
// --strict to turn this into a hard CI / pre-commit gate.
//
//   node tools/engine-drift-check.mjs [path-to-tailwinds-repo] [--strict]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HW = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const rawArgs = process.argv.slice(2);
const STRICT = rawArgs.includes('--strict');
const pathArg = rawArgs.find((a) => !a.startsWith('--'));
const TW = path.resolve(pathArg ?? path.join(HW, '..', 'Airline Management Game'));
const HW_ENGINE = path.join(HW, 'packages', 'engine', 'src');
const TW_ENGINE = path.join(TW, 'src');
const SUBDIRS = ['data', 'models', 'utils'];

if (!existsSync(TW_ENGINE)) {
  console.error(`✗ Tailwinds repo not found at: ${TW}`);
  console.error('  Pass its path: node tools/engine-drift-check.mjs ~/path/to/tailwinds');
  process.exit(2);
}

const isBackup = (f) => /\.(bak|pre\w*)$/.test(f);
const jsFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.js') && !isBackup(f)) : []);
const norm = (s) => s.replace(/\r\n/g, '\n'); // line-ending normalization only

let inSync = 0, drift = 0, hwOnly = 0, twOnly = 0;
const lines = [];
for (const sub of SUBDIRS) {
  const hwDir = path.join(HW_ENGINE, sub), twDir = path.join(TW_ENGINE, sub);
  const names = [...new Set([...jsFiles(hwDir), ...jsFiles(twDir)])].sort();
  for (const name of names) {
    const hwF = path.join(hwDir, name), twF = path.join(twDir, name);
    const inHw = existsSync(hwF), inTw = existsSync(twF);
    if (inHw && !inTw) { lines.push(`  HW-only   ${sub}/${name}`); hwOnly++; continue; }
    if (!inHw && inTw) { lines.push(`  TW-only   ${sub}/${name}`); twOnly++; continue; }
    const a = norm(readFileSync(hwF, 'utf8')), b = norm(readFileSync(twF, 'utf8'));
    if (a === b) { inSync++; continue; }
    const la = a.split('\n'), lb = b.split('\n');
    let i = 0;
    while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
    lines.push(`  DRIFT     ${sub}/${name}  (HW ${la.length} ln, TW ${lb.length} ln; first differs at line ${i + 1})`);
    drift++;
  }
}

console.log(`\nEngine drift check — shared modules (${SUBDIRS.join(', ')})`);
console.log(`  HW: ${path.relative(process.cwd(), HW_ENGINE) || '.'}`);
console.log(`  TW: ${TW_ENGINE}\n`);
if (lines.length) console.log(lines.join('\n') + '\n');
console.log(`${inSync} in sync · ${drift} differ · ${hwOnly} HW-only · ${twOnly} TW-only`);
console.log(`\nReview a DRIFT file only if you just edited it on one side — the large permanent gaps are the MP superset. --strict fails on any drift (wire it up once you've curated the intentional exceptions).`);
process.exit(STRICT && drift ? 1 : 0);
