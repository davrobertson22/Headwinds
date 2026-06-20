// Golden-master runner / guardrail.
//
//   node tools/golden-master/run.mjs            → compare against golden.json (CI mode)
//   node tools/golden-master/run.mjs --update   → (re)write golden.json
//
// Workflow: run with --update ONCE on the current engine to capture the baseline.
// After any engine relocation/refactor that is meant to be behavior-preserving,
// run WITHOUT --update; a mismatch means the refactor changed behavior.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runScenario, projection } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'golden.json');
const update = process.argv.includes('--update');

// Canonical, key-sorted JSON so the hash is stable regardless of key order.
function canonical(obj) {
  return JSON.stringify(obj, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

const state = runScenario();
const proj = projection(state);
const fullHash = crypto.createHash('sha256').update(canonical(state)).digest('hex');
const snapshot = { fullHash, projection: proj, capturedWith: 'tools/golden-master/harness.mjs', seedScenario: '60w / JFK-LAX / a320ceo' };

if (update || !fs.existsSync(GOLDEN)) {
  fs.writeFileSync(GOLDEN, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`[golden-master] ${fs.existsSync(GOLDEN) && !update ? 'created' : 'WROTE'} baseline → ${path.relative(process.cwd(), GOLDEN)}`);
  console.log('[golden-master] projection:', JSON.stringify(proj, null, 2));
  process.exit(0);
}

const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
if (golden.fullHash === fullHash) {
  console.log('[golden-master] ✓ PARITY OK — engine output is byte-identical to baseline.');
  process.exit(0);
}

console.error('[golden-master] ✗ MISMATCH — engine output changed vs baseline.');
console.error('  expected hash:', golden.fullHash);
console.error('  actual   hash:', fullHash);
console.error('  baseline projection:', JSON.stringify(golden.projection));
console.error('  current  projection:', JSON.stringify(proj));
process.exit(1);
