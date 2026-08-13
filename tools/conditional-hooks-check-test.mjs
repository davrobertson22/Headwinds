// The conditional-hook check has to be trusted, so it gets its own fixtures.
//
// A checker like this fails in two directions and both are fatal to it. Miss a
// real conditional hook and it gives false confidence — the exact black screen
// it exists to prevent ships anyway. Report a false one and someone deletes the
// check. Every fixture below is a pattern that actually appears in this
// codebase, and three of them are patterns that broke earlier versions of the
// checker during development:
//
//   * `return useMemo(...)`                    — News.jsx useMyNetwork
//   * a return inside a nested callback        — ConfirmModal.jsx close()
//   * a return inside a useMemo callback       — RoutePlanner.jsx fleetOfType
//   * destructured props in the parameter list — AircraftCheckout.jsx
//
//   node tools/conditional-hooks-check-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const CHECKER = path.resolve('tools/conditional-hooks-check.mjs');

// Run the checker against a throwaway tree containing one fixture file.
function check(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookcheck-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'Fixture.jsx'), source);
  fs.copyFileSync(CHECKER, path.join(dir, 'check.mjs'));
  try {
    const out = execFileSync(process.execPath, ['check.mjs'], { cwd: dir, encoding: 'utf8' });
    return { flagged: false, out };
  } catch (e) {
    return { flagged: true, out: (e.stdout || '') + (e.stderr || '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\nConditional-hook check — its own fixtures\n');

// ── Must be flagged ──────────────────────────────────────────────────────────

test('THE BUG: a hook below an inline `if (...) return`', () => {
  const r = check(`
import { useEffect, useState } from 'react';
export default function AppInner() {
  const [a, setA] = useState(0);
  if (a === 0) return <Setup />;
  useEffect(() => { setA(1); }, []);
  return <div>{a}</div>;
}
`);
  assert.equal(r.flagged, true, 'the exact shape that black-screened the game went unreported');
  assert.match(r.out, /useEffect/);
});

test('a hook below a braced early return', () => {
  const r = check(`
import { useEffect, useState } from 'react';
export default function Thing() {
  const [a, setA] = useState(0);
  if (!a) {
    return null;
  }
  useEffect(() => {}, []);
  return <div />;
}
`);
  assert.equal(r.flagged, true);
});

test('a hook below a return, in a component with DESTRUCTURED props', () => {
  // The parameter list's braces are not the function body. Counting them made
  // the scope open and close on the declaration line, so the whole component
  // was skipped and its real conditional hook was missed.
  const r = check(`
import { useState } from 'react';
export default function Checkout({ typeId, mode, onClose }) {
  const type = getType(typeId);
  if (!type) return null;
  const [sel, setSel] = useState(null);
  return <div />;
}
`);
  assert.equal(r.flagged, true, 'destructured props hid the violation');
});

test('a hook below a return in an arrow-function component', () => {
  const r = check(`
import { useEffect } from 'react';
export const Panel = ({ open }) => {
  if (!open) return null;
  useEffect(() => {}, []);
  return <div />;
};
`);
  assert.equal(r.flagged, true);
});

// ── Must NOT be flagged ──────────────────────────────────────────────────────

test('`return useMemo(...)` is not a violation', () => {
  // The hook runs on every render that reaches the return. News.jsx.
  const r = check(`
import { useMemo } from 'react';
function useMyNetwork() {
  const { state } = useGame();
  return useMemo(() => ({ a: state.a }), [state.a]);
}
`);
  assert.equal(r.flagged, false, `flagged a plain \`return useMemo(...)\`:\n${r.out}`);
});

test('a return inside a nested callback is not an early return', () => {
  // ConfirmModal.jsx: `const close = (r) => setReq((s) => { ...; return null; });`
  const r = check(`
import { useEffect, useState } from 'react';
export function ConfirmProvider({ children }) {
  const [req, setReq] = useState(null);
  const close = (result) => setReq((r) => { r?.resolve(result); return null; });
  useEffect(() => {}, [req]);
  return <div>{children}</div>;
}
`);
  assert.equal(r.flagged, false, `a callback's return was read as an early return:\n${r.out}`);
});

test('a return inside a useMemo callback is not an early return', () => {
  // RoutePlanner.jsx fleetOfType — four false positives came from this shape.
  const r = check(`
import { useMemo } from 'react';
export default function RoutePlanner() {
  const { state } = useGame();
  const fleetOfType = useMemo(() => {
    if (!state.sel) return [];
    return state.fleet;
  }, [state.fleet, state.sel]);
  const effective = useMemo(() => {
    const t = getType(state.sel);
    if (!t) return null;
    return t;
  }, [state.sel]);
  return <div />;
}
`);
  assert.equal(r.flagged, false, `a useMemo callback's guard clause was read as an early return:\n${r.out}`);
});

test('a return inside a nested helper function is not an early return', () => {
  // RoutePlanner.jsx handleConfigSource.
  const r = check(`
import { useMemo } from 'react';
export default function Planner() {
  const { state } = useGame();
  function handleConfigSource(src) {
    const t = getType(src);
    if (!t) return;
    apply(t);
  }
  const cfg = useMemo(() => state.cfg, [state.cfg]);
  return <div onClick={handleConfigSource} />;
}
`);
  assert.equal(r.flagged, false, `a nested function's guard clause was read as an early return:\n${r.out}`);
});

test('a component with no early return at all is clean', () => {
  const r = check(`
import { useEffect, useState } from 'react';
export default function Clean() {
  const [a, setA] = useState(0);
  useEffect(() => {}, []);
  return <div>{a}</div>;
}
`);
  assert.equal(r.flagged, false, r.out);
});

test('the word "return" inside a string or comment is ignored', () => {
  const r = check(`
import { useEffect } from 'react';
export default function Stringy() {
  const msg = 'return null if you like';
  // return early? no.
  useEffect(() => {}, []);
  return <div>{msg}</div>;
}
`);
  assert.equal(r.flagged, false, r.out);
});

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
