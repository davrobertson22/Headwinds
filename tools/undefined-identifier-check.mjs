// Static no-undef guard for src/components — the cheap catch for the whole class
// of bug that took the route planner down.
//
// `<ReserveNotice>` and `reserveOptionTag(a)` were both used in RoutePlanner.jsx
// with neither imported. Nothing about that needs a browser, a render or a fixture
// to detect: the identifiers simply do not exist in the module. A linter's
// `no-undef` / `react/jsx-no-undef` is the standard answer, but neither repo has
// eslint installed and the sandbox has no network, so this is the same check
// built on @babel/parser + @babel/traverse — which are already hard dependencies
// of the JSX test loader, so nothing new is installed.
//
// It resolves every identifier reference against real lexical scope (imports,
// declarations, params, catch clauses, labels, hoisting) and reports anything
// left over that is not a known JS/DOM/Node global. Lowercase JSX tags (<div>)
// are host elements, not references, and babel excludes them for us.
//
//   node tools/undefined-identifier-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const parser   = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIRS = ['src/components'];

// ── Known globals ────────────────────────────────────────────────────────────
// Node's own global object covers the ECMAScript builtins plus the web-standard
// APIs Node ships (fetch, URL, structuredClone, setTimeout, console…). Babel's
// globals data adds the capitalised DOM constructors. The rest is the lowercase
// browser surface Node does not define.
const KNOWN = new Set(Object.getOwnPropertyNames(globalThis));
for (const f of ['browser-upper', 'builtin-lower', 'builtin-upper']) {
  try {
    for (const g of require(`@babel/helper-globals/data/${f}.json`)) KNOWN.add(g);
  } catch { /* older babel — the curated lists below still cover the common cases */ }
}
for (const g of [
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'self',
  'top', 'parent', 'frames', 'opener', 'origin', 'name', 'status', 'closed',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore',
  'alert', 'confirm', 'prompt', 'print', 'open', 'close', 'focus', 'blur',
  'scroll', 'scrollTo', 'scrollBy', 'matchMedia', 'getComputedStyle',
  'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'postMessage',
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio',
  'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset', 'visualViewport',
  'speechSynthesis', 'customElements', 'frameElement', 'isSecureContext',
  // module / runtime identifiers that are legal but not properties of globalThis
  'arguments', 'undefined', 'require', 'module', 'exports', '__dirname', '__filename',
  'import', 'importScripts',
]) KNOWN.add(g);

// ── File discovery ───────────────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = TARGET_DIRS.flatMap(d => walk(path.join(ROOT, d))).sort();
if (files.length === 0) {
  console.error(`undefined-identifier-check: no source files under ${TARGET_DIRS.join(', ')}`);
  process.exit(1);
}

// ── The check ────────────────────────────────────────────────────────────────
const problems = [];

for (const file of files) {
  const rel  = path.relative(ROOT, file);
  const code = fs.readFileSync(file, 'utf8');

  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: 'module',
      sourceFilename: rel,
      plugins: ['jsx', 'classProperties', 'classPrivateProperties', 'classPrivateMethods',
                'dynamicImport', 'importMeta', 'topLevelAwait', 'optionalChaining',
                'nullishCoalescingOperator'],
    });
  } catch (e) {
    problems.push({ rel, name: '(parse error)', line: e.loc?.line ?? 0, kind: 'parse', detail: e.message });
    continue;
  }

  let programScope = null;
  traverse(ast, { Program(p) { programScope = p.scope; p.stop(); } });
  if (!programScope) continue;

  // babel resolves every reference against real lexical scope; whatever is left
  // in `globals` is an identifier this module never defines and never imports.
  for (const [name, node] of Object.entries(programScope.globals)) {
    if (KNOWN.has(name)) continue;
    const kind = node.type === 'JSXIdentifier' ? 'jsx element' : 'identifier';
    problems.push({ rel, name, line: node.loc?.start.line ?? 0, kind });
  }
}

problems.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line || a.name.localeCompare(b.name));

console.log(`\nundefined-identifier-check — ${files.length} files under ${TARGET_DIRS.join(', ')}\n`);

if (problems.length === 0) {
  console.log('  ✓ every identifier resolves to an import, a declaration or a known global');
  console.log(`\n  0 undefined identifiers\n`);
  process.exit(0);
}

for (const p of problems) {
  console.log(`  ✗ ${p.rel}:${p.line}  ${p.name}  — ${p.kind} is not imported, declared or a known global`
    + (p.detail ? `\n      ${p.detail}` : ''));
}
console.log(`\n  ${problems.length} undefined identifier${problems.length === 1 ? '' : 's'}\n`);
console.log('  Each of these throws a ReferenceError the moment the line executes.');
console.log('  Add the missing import (or declaration) — do not silence this check.\n');
process.exit(1);
