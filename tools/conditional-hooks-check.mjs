// No React hook may sit below a component's early return.
//
// The bug this exists to catch: a hook placed after a conditional return means
// the component calls a different number of hooks depending on state. The
// moment the early return stops firing, React throws "Rendered more hooks than
// during the previous render", unmounts the entire tree, and the player gets a
// black screen.
//
// It has now happened twice:
//   - AppInner's setup→playing flip (the original incident this check was
//     written for): every brand-new game was dead on arrival.
//   - 2026-08-24: WorldScreen gained a `hubCounts` useMemo BELOW the
//     "Loading world…" return. Every world screen in production crashed for
//     every player the moment the world data arrived — a multi-hour outage.
//
// The first version of this check missed the 2026-08-24 bug entirely: it
// stripped strings line-by-line, so the apostrophe in JSX text ("Auth isn't
// configured", inside SignIn) opened a phantom string literal that swallowed
// ~1,100 lines — every component between SignIn and ReportScreen, WorldScreen
// included, was never scanned. Regex-stripping JSX is a losing game, so this
// version parses each file with @babel/parser and walks the real AST.
//
// The rule, per component (capitalized function or use* custom hook):
//   - an "early return" is a ReturnStatement that is a direct statement of the
//     component body, or sits inside an if/else that is itself a direct
//     statement (however deeply the if/else chain nests);
//   - after the first early return, any hook call (use[A-Z]…) reachable at the
//     component's own level — not inside a nested function — is an error.
//
//   node tools/conditional-hooks-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolve @babel/parser from wherever this script actually runs. The checker's
// own test copies it into a throwaway fixture tree with no node_modules, so
// resolution falls back from the script's location to the cwd to an explicit
// HOOKCHECK_REPO_ROOT the test provides.
const requireBabel = (base) => { try { return createRequire(base)('@babel/parser'); } catch { return null; } };
const babel = requireBabel(import.meta.url)
  ?? requireBabel(pathToFileURL(path.join(process.cwd(), 'package.json')))
  ?? (process.env.HOOKCHECK_REPO_ROOT
    ? requireBabel(pathToFileURL(path.join(process.env.HOOKCHECK_REPO_ROOT, 'package.json')))
    : null);
if (!babel) {
  console.error('conditional-hooks-check: cannot resolve @babel/parser (set HOOKCHECK_REPO_ROOT)');
  process.exit(1);
}
const { parse } = babel;

// Headwinds has two React trees: the shared game UI, and the multiplayer
// client shell.
const ROOTS = ['src', 'apps/headwinds-web/src'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, out); }
    else if (/\.(jsx|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

const isFn = (n) => n && (n.type === 'FunctionDeclaration'
  || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression'
  || n.type === 'ObjectMethod' || n.type === 'ClassMethod');

// Generic child visitor over parser AST nodes.
function children(node) {
  const out = [];
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'range' || k === 'leadingComments'
      || k === 'trailingComments' || k === 'innerComments' || k === 'extra') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') out.push(c); }
    else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
}

// First hook call inside `node` WITHOUT descending into nested functions.
// The hook call's own arguments still count as this component's level only for
// the call itself — a useEffect's callback body belongs to that callback.
function findHookCall(node) {
  if (isFn(node)) return null;
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
    && /^use[A-Z]/.test(node.callee.name)) return node;
  for (const c of children(node)) {
    if (isFn(c)) continue;
    const hit = findHookCall(c);
    if (hit) return hit;
  }
  return null;
}

// Does this direct statement of the component body constitute an early return?
// A bare return, or an if/else chain any branch of which returns at ITS top
// level (a return inside a nested callback does not exit the component).
function isEarlyReturn(stmt) {
  if (stmt.type === 'ReturnStatement') return stmt;
  if (stmt.type !== 'IfStatement') return null;
  const branchReturns = (b) => {
    if (!b) return null;
    if (b.type === 'ReturnStatement') return b;
    if (b.type === 'BlockStatement') {
      for (const s of b.body) { const r = isEarlyReturn(s); if (r) return r; }
      return null;
    }
    if (b.type === 'IfStatement') return isEarlyReturn(b);
    return null;
  };
  return branchReturns(stmt.consequent) || branchReturns(stmt.alternate);
}

function checkComponent(name, fnNode, file, findings) {
  const body = fnNode.body;
  if (!body || body.type !== 'BlockStatement') return; // expression-bodied arrow: no statements
  let returned = null;
  for (const stmt of body.body) {
    if (returned) {
      const hook = findHookCall(stmt);
      if (hook) {
        findings.push({
          file, fn: name, hook: hook.callee.name,
          hookLine: hook.loc.start.line, returnLine: returned.loc.start.line,
        });
        return; // one report per component is enough
      }
    } else {
      const r = isEarlyReturn(stmt);
      // The component's FINAL statement being a return is not "early".
      if (r && stmt !== body.body[body.body.length - 1]) returned = r;
    }
  }
}

// Find every named component/custom hook in the file, wherever it nests.
function collect(node, findings, file) {
  if (node.type === 'FunctionDeclaration' && node.id
    && /^(?:[A-Z]|use[A-Z])/.test(node.id.name)) {
    checkComponent(node.id.name, node, file, findings);
  }
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
    && /^(?:[A-Z]|use[A-Z])/.test(node.id.name) && isFn(node.init)) {
    checkComponent(node.id.name, node.init, file, findings);
  }
  for (const c of children(node)) collect(c, findings, file);
}

const findings = [];
let parsed = 0;

for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parse(src, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });
    } catch (e) {
      console.log(`  ✗ ${file} failed to parse: ${e.message}`);
      process.exitCode = 1;
      continue;
    }
    parsed++;
    collect(ast.program, findings, file);
  }
}

console.log('\nConditional-hook check\n');

if (findings.length === 0 && !process.exitCode) {
  console.log(`  ✓ no React hook is called below an early return (${parsed} files)\n`);
  process.exit(0);
}

for (const f of findings) {
  console.log(`  ✗ ${f.file}`);
  console.log(`      ${f.fn}() returns early at line ${f.returnLine}, then calls ${f.hook}() at line ${f.hookLine}.`);
  console.log(`      On the render where that early return stops firing, the hook count changes,`);
  console.log(`      React unmounts the tree, and the player gets a black screen.`);
  console.log(`      Move the hook above the return.\n`);
}
if (findings.length) console.log(`❌  ${findings.length} conditional hook${findings.length === 1 ? '' : 's'}\n`);
process.exit(1);
