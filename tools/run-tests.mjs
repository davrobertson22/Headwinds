/**
 * run-tests.mjs — the whole suite, discovered from disk.
 *
 * Replaces the hand-maintained `&&` chain that used to live in package.json's
 * "test" script. That chain was append-only by hand, so a suite that was never
 * added to it simply never ran: ten of them had accumulated, all passing, all
 * invisible. Discovery is from the filesystem now, so a new tools/*-test.mjs is
 * in the suite the moment it exists and cannot silently rot out of it.
 *
 * What counts as a suite: tools/*-test.mjs and tools/*-check.mjs, minus
 * underscore-prefixed helpers (_jsx-loader, _register-loader, probes) and minus
 * any file carrying an `@not-a-test` marker in its header — calibration
 * harnesses that print a table and assert nothing. Skips are listed by --list,
 * never dropped in silence.
 *
 * Every suite runs under the JSX loader. The loader only rewrites .jsx, so it
 * is a no-op for engine tests and removes the need to remember which suites
 * SSR-render a component.
 *
 *   node tools/run-tests.mjs                 all suites, parallel
 *   node tools/run-tests.mjs cargo fare      only suites matching those strings
 *   node tools/run-tests.mjs --serial        one at a time
 *   node tools/run-tests.mjs --jobs 2        cap the workers
 *   node tools/run-tests.mjs --bail          stop at the first failure
 *   node tools/run-tests.mjs --list          show what would run, then exit
 *   node tools/run-tests.mjs --timeout 300   per-suite seconds (default 180)
 *   node tools/run-tests.mjs --shard 1/3     run a third of the suites (CI fan-out)
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(TOOLS);
const LOADER = './tools/_register-loader.mjs';

// ── argv ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const filters = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return !(prev === '--jobs' || prev === '--timeout' || prev === '--shard');
});

// --shard i/n : deterministic slice, dealt round-robin so each shard gets a
// mix of fast and slow suites rather than one alphabetical clump.
const shardArg = argv[argv.indexOf('--shard') + 1];
const shard = argv.includes('--shard') && /^\d+\/\d+$/.test(shardArg ?? '')
  ? { index: Number(shardArg.split('/')[0]), total: Number(shardArg.split('/')[1]) }
  : null;
if (argv.includes('--shard') && !shard) {
  console.error('--shard expects i/n, e.g. --shard 1/3');
  process.exit(1);
}

const LIST_ONLY = flag('--list');
const BAIL = flag('--bail');
const TIMEOUT_MS = value('--timeout', 180) * 1000;
const JOBS = flag('--serial')
  ? 1
  : value('--jobs', Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length)));

// ── discovery ─────────────────────────────────────────────────────────────────
const NOT_A_TEST = /@not-a-test/;

const discovered = readdirSync(TOOLS)
  .filter((f) => /-(test|check)\.mjs$/.test(f) && !f.startsWith('_'))
  .sort();

const skipped = [];
const candidates = [];
for (const file of discovered) {
  const head = readFileSync(path.join(TOOLS, file), 'utf8').slice(0, 4000);
  if (NOT_A_TEST.test(head)) skipped.push(file);
  else candidates.push(file);
}

const matched = filters.length
  ? candidates.filter((f) => filters.some((needle) => f.includes(needle)))
  : candidates;

const selected = shard
  ? matched.filter((_, i) => i % shard.total === shard.index - 1)
  : matched;

if (LIST_ONLY) {
  console.log(`${selected.length} suite(s) would run:\n`);
  for (const f of selected) console.log(`  ${f}`);
  if (skipped.length) {
    console.log(`\n${skipped.length} file(s) skipped (@not-a-test):\n`);
    for (const f of skipped) console.log(`  ${f}`);
  }
  process.exit(0);
}

if (!selected.length) {
  console.error(
    filters.length
      ? `No suite matches: ${filters.join(', ')}`
      : 'No suites found in tools/.',
  );
  process.exit(1);
}

// ── run ───────────────────────────────────────────────────────────────────────
// Colour only for a real terminal, so piping to a file or a CI log stays clean.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const GREEN = COLOR ? '\x1b[32m' : '';
const RED = COLOR ? '\x1b[31m' : '';
const DIM = COLOR ? '\x1b[2m' : '';
const OFF = COLOR ? '\x1b[0m' : '';
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', LOADER, path.join('tools', file)], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let out = '';
    const cap = (buf) => {
      if (out.length < 200_000) out += buf.toString();
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      out += `\n[run-tests] killed after ${TIMEOUT_MS / 1000}s — suite hung.\n`;
    }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, code, out, elapsed: Date.now() - started });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ file, code: 1, out: out + String(err), elapsed: Date.now() - started });
    });
  });
}

const label = `${selected.length} suite${selected.length === 1 ? '' : 's'}`;
const shardNote = shard ? ` ${DIM}(shard ${shard.index}/${shard.total} of ${matched.length})${OFF}` : '';
console.log(`${DIM}running ${label} with ${JOBS} worker${JOBS === 1 ? '' : 's'}${OFF}${shardNote}\n`);

const queue = [...selected];
const results = [];
let failed = 0;
let aborted = false;
const suiteStart = Date.now();

async function worker() {
  while (queue.length) {
    if (aborted) return;
    const file = queue.shift();
    const r = await runOne(file);
    results.push(r);
    const ok = r.code === 0;
    if (!ok) failed++;
    const mark = ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
    const done = String(results.length).padStart(String(selected.length).length);
    console.log(`${mark} ${DIM}${done}/${selected.length}${OFF} ${file} ${DIM}${ms(r.elapsed)}${OFF}`);
    if (!ok && BAIL) aborted = true;
  }
}

await Promise.all(Array.from({ length: Math.min(JOBS, selected.length) }, worker));

const wall = Date.now() - suiteStart;

// ── report ────────────────────────────────────────────────────────────────────
const failures = results.filter((r) => r.code !== 0);
for (const f of failures) {
  console.log(`\n${RED}${'─'.repeat(72)}${OFF}`);
  console.log(`${RED}FAILED${OFF} ${f.file} ${DIM}(exit ${f.code})${OFF}`);
  console.log(`${RED}${'─'.repeat(72)}${OFF}`);
  console.log(f.out.trimEnd());
}

const slowest = [...results].sort((a, b) => b.elapsed - a.elapsed).slice(0, 5);
console.log(`\n${DIM}slowest: ${slowest.map((r) => `${r.file.replace(/\.mjs$/, '')} ${ms(r.elapsed)}`).join(', ')}${OFF}`);

if (skipped.length) {
  console.log(`${DIM}skipped (@not-a-test): ${skipped.join(', ')}${OFF}`);
}

const passed = results.length - failed;
console.log(
  failed
    ? `\n${RED}${failed} failed${OFF}, ${passed} passed  ${DIM}${ms(wall)}${OFF}`
    : `\n${GREEN}${passed} suites passed${OFF}  ${DIM}${ms(wall)}${OFF}`,
);
if (aborted) console.log(`${DIM}stopped early (--bail); ${queue.length} suite(s) not run${OFF}`);

process.exit(failed ? 1 : 0);
