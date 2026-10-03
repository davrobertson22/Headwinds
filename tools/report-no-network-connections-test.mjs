// The weekly report must not carry `networkConnections`.
//
// Measured 2026-10-03 against production (270 airlines in running worlds):
// 154 MB of Airline.state, 97 MB of it lastReport, 46 MB of THAT the
// `networkConnections` array — "full Connection[] for debugging/UI", attached
// to every report since the hub-connectivity package and read by nothing in
// the engine, the server or the client. One airline (All Nippon Airways,
// Scarce Assets) carried 13.6 MB of it in a 22.6 MB save. Every load and
// every tick pulled that through Postgres on a 2 GB box that had been in swap
// for a week before it was killed at 6:40 AM PT.
//
// Verified failing on HEAD: `'networkConnections' in state.lastReport` was true
// (the key is present, [] on the single-route scenario) and the grep found the
// write at simulation.js:5451.
//
//   node tools/report-no-network-connections-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from './golden-master/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); fail++; }
}

const state = runScenario({ weeks: 8 });

t('a ticked state has a lastReport to inspect', () => {
  assert.ok(state.lastReport && typeof state.lastReport === 'object');
  assert.ok(Array.isArray(state.lastReport.routeResults));
});

t('lastReport does not carry networkConnections', () => {
  assert.equal('networkConnections' in state.lastReport, false,
    'networkConnections is still attached to the weekly report');
});

// Guard: if a reader ever appears, this test is the place to find out, so the
// field comes back deliberately (trimmed) rather than by surprise.
t('nothing in the engine, server or client reads networkConnections', () => {
  const dirs = ['packages/engine/src', 'apps/headwinds-server/src', 'apps/headwinds-server/worker', 'src'];
  const hits = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p); continue; }
      if (!/\.(m?js|jsx)$/.test(ent.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      let i = 0;
      while ((i = src.indexOf('networkConnections', i)) !== -1) {
        hits.push(path.relative(ROOT, p) + ':' + (src.slice(0, i).split('\n').length));
        i += 1;
      }
    }
  };
  for (const d of dirs) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  assert.deepEqual(hits, [], 'networkConnections referenced at: ' + hits.join(', '));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
