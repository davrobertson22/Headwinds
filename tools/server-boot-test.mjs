// The server must LINK before it can serve.
//
// `gates.mjs` imported `loadRivalRows` from `humanRivals.mjs`, which declared it
// without `export`. That is not a runtime bug that shows up under load — it is
// an ESM link error, so the process dies before Fastify binds a port, and the
// only symptom is a Railway healthcheck timing out four minutes after a Build
// and Deploy that both reported success. It shipped because nothing in the
// suite imports the server at all: every other test exercises the engine.
//
// Checking this by actually importing the server is not an option here — that
// instantiates Prisma, which needs a generated client for the host platform and
// a DATABASE_URL. So this resolves the import graph statically instead: for
// every relative named import in the server tree, assert the target module
// really exports that binding. No database, no Prisma, no network.
//
//   node tools/server-boot-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'apps/headwinds-server');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); fail++; }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.mjs') || e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Named imports from a RELATIVE specifier: `import { a, b as c } from './x.mjs'`
// and the re-export form `export { a } from './x.mjs'`. Namespace and default
// imports cannot fail this way, so they are ignored.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]/g;

function namedExportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/(?:^|\n)\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  // `export { a, b as c }` — the exported name is what follows `as`.
  for (const m of src.matchAll(/(?:^|\n)\s*export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      const n = (bits[bits.length - 1] ?? '').trim();
      if (n) names.add(n);
    }
  }
  // `export * from './x.js'` re-exports everything the target exports.
  for (const m of src.matchAll(/(?:^|\n)\s*export\s*\*\s*from\s*['"](\.[^'"]*)['"]/g)) {
    const target = resolveRel(file, m[1]);
    if (target) for (const n of namedExportsOf(target)) names.add(n);
  }
  return names;
}

function resolveRel(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, base + '.mjs', base + '.js', path.join(base, 'index.mjs'), path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

const FILES = walk(path.join(SERVER, 'src')).concat(walk(path.join(SERVER, 'worker')));

t('the server tree is actually being scanned', () => {
  assert.ok(FILES.length > 10, `expected a server tree, found ${FILES.length} files`);
});

const broken = [];
for (const file of FILES) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    const target = resolveRel(file, m[2]);
    if (!target) {
      broken.push(`${path.relative(ROOT, file)} imports from '${m[2]}' — no such module`);
      continue;
    }
    const exported = namedExportsOf(target);
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (!name || name === 'type') continue;
      if (!exported.has(name)) {
        broken.push(`${path.relative(ROOT, file)} imports { ${name} } from '${m[2]}', which does not export it`);
      }
    }
  }
}

t('every named import in the server resolves to a real export', () => {
  assert.deepEqual(broken, [],
    'the server will not boot:\n       - ' + broken.join('\n       - '));
});

console.log(`\nserver-boot-test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
