// No React hook may sit below a component's early return.
//
// The bug this exists to catch, and which it is verified to catch: App.jsx's
// AppInner had
//
//     if (state.phase === 'setup') return <SetupScreen />;      // line 267
//     ...
//     useEffect(() => { /* hw:navigate deep links */ }, []);    // line 298
//
// During setup AppInner ran 18 hooks. The instant the player finished setup and
// phase flipped to 'playing', it ran 19. React requires a component to call the
// same hooks in the same order on every render, so it threw "Rendered more
// hooks than during the previous render", unmounted the entire tree, and left a
// black screen. Every brand-new game was dead on arrival.
//
// Nothing caught it because only a NEW game crosses the setup→playing boundary.
// Loading a save enters at 'playing' and stays there, so the hook count never
// changes and every existing player — and every test fixture — was fine.
//
// The check: inside each component (a function whose name starts with a capital
// letter) or custom hook (use*), track brace depth. A `return` in the function's
// own body — depth 1, or depth 2 inside an if/else that is itself at depth 1 —
// is an early return. Any hook called at depth 1 after that point is a hook
// React will sometimes skip. Returns inside callbacks, .map()s and nested
// blocks are correctly ignored, because those are not early returns from the
// component.
//
//   node tools/conditional-hooks-check.mjs

import fs from 'node:fs';
import path from 'node:path';

// Headwinds has two React trees: the shared game UI, and the multiplayer
// client shell.
const ROOTS = ['src', 'apps/headwinds-web/src'];
const HOOK_CALL = /\b(use[A-Z][A-Za-z0-9]*)\s*\(/;
const FN_DECL = /^(?:export\s+)?(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*|use[A-Z][A-Za-z0-9]*)\s*\(/;
const ARROW_DECL = /^(?:export\s+)?(?:default\s+)?const\s+([A-Z][A-Za-z0-9]*|use[A-Z][A-Za-z0-9]*)\s*=\s*(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, out); }
    else if (/\.(jsx|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

// Strip line comments, block comments and string/template literals so their
// braces and the word "return" inside them cannot skew the depth count.
function strip(src) {
  let out = '', i = 0, n = src.length;
  let mode = null;   // 'line' | 'block' | '"' | "'" | '`'
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (mode === null) {
      if (c === '/' && d === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = c; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = null; out += '\n'; } else out += ' '; i++; continue; }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = null; out += '  '; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i++; continue;
    }
    // inside a string
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === mode) { mode = null; out += ' '; i++; continue; }
    out += (c === '\n' ? '\n' : ' '); i++;
  }
  return out;
}

// The kind of block a `{` opens, judged from the text before it on its line.
// 'topif' means an if/else block sitting directly in the component body — a
// return inside one still exits the component. Everything else is 'other'.
function classify(code, braceCol, depthBefore) {
  if (depthBefore !== 1) return 'other';
  const before = code.slice(0, braceCol);
  return /(^|[\s;}])(if|else)\b/.test(before) && !/=>\s*$/.test(before) ? 'topif' : 'other';
}

const findings = [];

for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    const clean = strip(raw).split('\n');

    let fn = null;            // { name, startLine }
    let started = false;      // seen the function's opening brace
    let returnedAt = null;    // line of the first early return
    let returnedCol = 0;      // column of it, so `return useMemo(...)` is not self-flagged
    // One frame per open brace inside the component. `kind` is 'topif' for a
    // block opened by an if/else sitting directly in the component body, and
    // 'other' for everything else — a callback, a nested function, an object
    // literal. A `return` only exits the COMPONENT when it is at depth 1, or at
    // depth 2 inside a 'topif'. An earlier attempt tracked this with a sticky
    // "an if-block exists at depth 2" flag that was never cleared, so once any
    // top-level `if (...) {` appeared, every later return inside every callback
    // and nested function read as an early return. That produced four false
    // positives in RoutePlanner alone — enough noise to get the check deleted.
    let stack = [];
    // >0 while a parameter list is still open across lines, so braces in
    // multi-line destructured params are not mistaken for the body.
    let paramsPending = 0;

    for (let i = 0; i < clean.length; i++) {
      const code = clean[i];

      let scanFrom = 0;
      if (!fn) {
        const m = code.match(FN_DECL) || code.match(ARROW_DECL);
        if (m) {
          fn = { name: m[1], startLine: i + 1 }; started = false; returnedAt = null; stack = [];
          // The function BODY starts at the first `{` that is not inside the
          // parameter list. Braces in destructured params are not the body:
          // `function Checkout({ typeId, mode }) {` opens and closes one before
          // the body brace, and counting it made the scope start and end on the
          // declaration line — the component was skipped whole and its real
          // conditional hook went unreported. Same for `({ open }) =>`.
          let pd = 0, found = -1;
          for (let k = code.indexOf(m[1]) + m[1].length; k < code.length; k++) {
            const ch = code[k];
            if (ch === '(') pd++;
            else if (ch === ')') pd--;
            else if (ch === '{' && pd === 0) { found = k; break; }
          }
          if (found >= 0) scanFrom = found;
          else { paramsPending = pd; scanFrom = code.length; }  // params span lines
        }
        if (!fn) continue;
      }

      if (fn && !started && paramsPending > 0) {
        let pd = paramsPending, found = -1;
        for (let k = 0; k < code.length; k++) {
          const ch = code[k];
          if (ch === '(') pd++;
          else if (ch === ')') pd--;
          else if (ch === '{' && pd === 0) { found = k; break; }
        }
        if (found >= 0) { scanFrom = found; paramsPending = 0; }
        else { paramsPending = pd; continue; }
      }

      const depthAt = (col) => {
        let d = stack.length;
        for (let k = scanFrom; k < col && k < code.length; k++) {
          if (code[k] === '{') d++;
          else if (code[k] === '}') d--;
        }
        return d;
      };
      const kindAt = (col) => {
        // The kind of the innermost block open at `col`.
        let frames = stack.slice();
        for (let k = scanFrom; k < col && k < code.length; k++) {
          if (code[k] === '{') frames.push(classify(code, k, frames.length));
          else if (code[k] === '}') frames.pop();
        }
        return frames.length ? frames[frames.length - 1] : null;
      };

      if (started && returnedAt === null) {
        const rm = /(?:^|[\s;{}()])return\b/.exec(code);
        if (rm) {
          const col = rm.index + rm[0].length - 'return'.length;
          const d = depthAt(col);
          if (d === 1 || (d === 2 && kindAt(col) === 'topif')) {
            returnedAt = i + 1;
            returnedCol = col;
          }
        }
      }

      if (started && returnedAt !== null) {
        const hm = HOOK_CALL.exec(code);
        if (hm && !(returnedAt === i + 1 && hm.index >= returnedCol) && depthAt(hm.index) === 1) {
          findings.push({ file, fn: fn.name, hook: hm[1], hookLine: i + 1, returnLine: returnedAt, src: lines[i].trim() });
          returnedAt = null;   // one report per function is enough
        }
      }

      // Advance the stack across this line.
      for (let k = scanFrom; k < code.length; k++) {
        if (code[k] === '{') { stack.push(classify(code, k, stack.length)); if (!started) started = true; }
        else if (code[k] === '}') {
          stack.pop();
          if (started && stack.length === 0) { fn = null; started = false; returnedAt = null; stack = []; break; }
        }
      }
    }
  }
}

console.log('\nConditional-hook check\n');

if (findings.length === 0) {
  console.log('  ✓ no React hook is called below an early return\n');
  process.exit(0);
}

for (const f of findings) {
  console.log(`  ✗ ${f.file}`);
  console.log(`      ${f.fn}() returns early at line ${f.returnLine}, then calls ${f.hook}() at line ${f.hookLine}:`);
  console.log(`          ${f.src.slice(0, 90)}`);
  console.log(`      On the render where that early return stops firing, the hook count changes,`);
  console.log(`      React unmounts the tree, and the player gets a black screen.`);
  console.log(`      Move the hook above the return.\n`);
}
console.log(`❌  ${findings.length} conditional hook${findings.length === 1 ? '' : 's'}\n`);
process.exit(1);
