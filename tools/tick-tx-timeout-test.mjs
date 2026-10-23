// tick-tx-timeout-test.mjs — the weekly commit's transaction budget is TICK_TX_TIMEOUT_MS.
//
// 2026-10-22: Scarce Assets' commit grew from ~20s to ~31s (the Airline."rivalState"
// trigger), past the hard-coded 30s budget. Every attempt expired (P2028) and was
// retried until the worker ran out of heap, so the worlds queued behind it stopped
// ticking for ~17 hours. The budget must be settable from the worker's environment,
// keep 30s when unset, and reach the transaction the tick actually opens.
//
// TICK_SERVICE_UNDER_TEST=<path> runs the module checks against another copy (HEAD).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const target = process.env.TICK_SERVICE_UNDER_TEST
  ? pathToFileURL(process.env.TICK_SERVICE_UNDER_TEST).href
  : new URL('../apps/headwinds-server/src/lib/tickService.mjs', import.meta.url).href;

let pass = 0;
const ok = (name) => { pass++; console.log('  ok - ' + name); };

const mod = await import(target);

// 1. The parser: unset keeps today's 30s; a valid value is used; junk falls back.
{
  assert.equal(typeof mod.tickTxOpts, 'function', 'tickService exports tickTxOpts(env)');
  assert.deepEqual(mod.tickTxOpts({}), { timeout: 30_000, maxWait: 15_000 });
  assert.equal(mod.tickTxOpts({ TICK_TX_TIMEOUT_MS: '90000' }).timeout, 90_000);
  assert.equal(mod.tickTxOpts({ TICK_TX_TIMEOUT_MS: ' 45000 ' }).timeout, 45_000);
  assert.equal(mod.tickTxOpts({ TICK_TX_TIMEOUT_MS: '90s' }).timeout, 30_000, 'non-numeric -> default');
  assert.equal(mod.tickTxOpts({ TICK_TX_TIMEOUT_MS: '' }).timeout, 30_000, 'blank -> default');
  assert.equal(mod.tickTxOpts({ TICK_TX_TIMEOUT_MS: '0' }).timeout, 30_000, 'below the 5s floor -> default');
  assert.equal(mod.tickTxOpts({ TICK_TX_TIMEOUT_MS: '99999999' }).timeout, 30_000, 'above the 10 min ceiling -> default');
  assert.equal(mod.tickTxOpts({ TICK_TX_TIMEOUT_MS: '90000' }).maxWait, 15_000, 'maxWait unchanged');
  ok('tickTxOpts: default 30s, env value honoured, junk falls back');
}

// 2. Module wiring: a process started with the env var gets that budget in
//    TICK_TX_OPTS; one started without it keeps 30s.
{
  const probe = (envExtra) => {
    const env = { ...process.env, ...envExtra };
    if (!('TICK_TX_TIMEOUT_MS' in envExtra)) delete env.TICK_TX_TIMEOUT_MS;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(target)}); console.log(JSON.stringify(m.TICK_TX_OPTS ?? null));`,
    ], { env, encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  };
  assert.equal(probe({ TICK_TX_TIMEOUT_MS: '90000' })?.timeout, 90_000, 'TICK_TX_OPTS reads the env');
  assert.equal(probe({})?.timeout, 30_000, 'unset -> 30s');
  ok('TICK_TX_OPTS follows TICK_TX_TIMEOUT_MS at load');
}

// 3. The week's commit transaction is opened with TICK_TX_OPTS (not a literal).
{
  const src = readFileSync(fileURLToPath(target), 'utf8');
  const call = src.slice(src.indexOf('const outcome = await withTx(prisma'));
  assert.ok(call.length > 0, 'found the commit withTx call');
  assert.match(call.slice(0, call.indexOf('if (outcome.lostRace)')), /\.\.\.TICK_TX_OPTS,/);
  assert.doesNotMatch(src, /TICK_TX_OPTS\s*=\s*\{\s*timeout:\s*30_000/, 'no hard-coded 30s budget');
  ok('the commit transaction spreads TICK_TX_OPTS');
}

// 4. The worker logs the budget and heap limit it runs under.
{
  const w = readFileSync(new URL('../apps/headwinds-server/worker/index.mjs', import.meta.url), 'utf8');
  assert.match(w, /week commit budget \$\{Math\.round\(TICK_TX_OPTS\.timeout \/ 1000\)\}s/);
  assert.match(w, /heap_size_limit/);
  ok('worker start-up log names the commit budget and heap limit');
}

console.log(`\ntick-tx-timeout-test: ${pass} passed`);
