// The server logs where a slow decision's time went, and each tick's slowest airlines.
//
// Nothing in the November 2026 performance work was measured on production:
// it was all done on airlines rebuilt from an export. lib/perfLog.mjs puts the
// split in the server's own log. This pins what a line says, when one is
// written, and that the two call sites use it.
//
//   node tools/perf-log-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`); }
}
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const perf = await import('../apps/headwinds-server/src/lib/perfLog.mjs').catch(() => null);
const need = () => { if (!perf) throw new Error('lib/perfLog.mjs does not exist'); };

test('a stopwatch splits the time into named laps that add up', () => {
  need();
  let t = 1000; const w = perf.stopwatch(() => t);
  t += 300; w.lap('views'); t += 40; w.lap('reduce'); t += 60; w.lap('commit'); t += 5;
  assert.deepEqual(w.laps(), { views: 300, reduce: 40, commit: 60 });
  assert.equal(w.total(), 405);
});
test('the line names the action, the total, the split and the airline\'s size — and nothing typed by a player', () => {
  need();
  let t = 0; const w = perf.stopwatch(() => t);
  t += 301; w.lap('views'); t += 38; w.lap('reduce'); t += 61; w.lap('commit');
  const line = perf.decisionPerfLine('UPDATE_TICKET_PRICE', w, { lean: true, cachedRows: false, routes: 4027, fleet: 4884, airline: 'cm123' });
  assert.equal(line, '[perf] decision UPDATE_TICKET_PRICE 400ms (views 301, reduce 38, commit 61) lean routes=4027 fleet=4884 airline=cm123');
});
test('slow decisions are always logged; the rest one in a sample', () => {
  need();
  assert.equal(perf.shouldLogPerf(900, { slowMs: 250, sample: 1e9 }), true);
  assert.equal(perf.shouldLogPerf(250, { slowMs: 250, sample: 1e9 }), true);
  let logged = 0;
  for (let i = 0; i < 1000; i++) if (perf.shouldLogPerf(20, { slowMs: 250, sample: 100 })) logged++;
  assert.equal(logged, 10);
});
test('the tick names its slowest airlines', () => {
  need();
  assert.equal(perf.slowestLine([{ name: 'A', ms: 12.4 }, { name: 'B', ms: 2011.2 }, { name: 'C', ms: 640 }, { name: 'D', ms: 1702 }]), 'slowest: B 2011ms, D 1702ms, C 640ms');
  assert.equal(perf.slowestLine([]), '');
});
test('the decision route and the tick both write it', () => {
  const dec = read('apps/headwinds-server/src/routes/decisions.mjs');
  for (const lap of ['views', 'checks', 'reduce', 'commit']) assert.match(dec, new RegExp(`watch\\.lap\\('${lap}'\\)`), lap);
  assert.match(dec, /if \(shouldLogPerf\(watch\.total\(\)\)\) \{\s*\n\s*request\.log\.info\(decisionPerfLine\(type, watch,/);
  assert.doesNotMatch(dec.slice(dec.indexOf('decisionPerfLine(type, watch,'), dec.indexOf('decisionPerfLine(type, watch,') + 300), /payload|guarded|email|name/, 'the line must carry no player input');
  const tick = read('apps/headwinds-server/src/lib/tickService.mjs');
  assert.match(tick, /computeTimes\.push\(\{ name: airline\.name \?\? airline\.id, ms: performance\.now\(\) - t0 \}\);/);
  assert.match(tick, /computed \$\{computed\.length\} airline\(s\) in \$\{Math\.round\(computeMs\)\}ms/);
});

console.log(`\nperf-log-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
