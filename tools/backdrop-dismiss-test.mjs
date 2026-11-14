// Modal backdrops close on a click outside the panel, never on a drag that
// started inside it.
//
// Discord (2026-11-14): "click dragging over airline name to rename it just
// closes the rename menu". A browser fires `click` on the nearest common
// ancestor of mousedown and mouseup; press in the name field, drag past the
// panel edge, release over the backdrop, and that ancestor IS the backdrop. The
// old `if (e.target === e.currentTarget) onClose()` could not tell that from a
// real backdrop click.
//
//   node tools/backdrop-dismiss-test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backdropDismiss } from '../src/utils/backdropDismiss.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const backdrop = {};
const field = {};
const ev = (target) => ({ target, currentTarget: backdrop });

function gesture(handlers, downOn, upOn) {
  let closed = 0;
  const h = handlers(() => { closed++; });
  h.onMouseDown(ev(downOn));
  const common = downOn === upOn ? downOn : backdrop;
  h.onClick(ev(common));
  return closed;
}
const oldHandler = (onClose) => ({
  onMouseDown: () => {},
  onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
});

console.log('\nModal backdrop dismissal\n');

test('the old handler closed on a drag out of the name field (the bug, reproduced)', () => {
  assert.equal(gesture(oldHandler, field, backdrop), 1);
});
test('a drag that starts in the panel and ends on the backdrop does not close', () => {
  assert.equal(gesture(backdropDismiss, field, backdrop), 0);
});
test('a real click on the backdrop closes', () => {
  assert.equal(gesture(backdropDismiss, backdrop, backdrop), 1);
});
test('a click inside the panel does not close', () => {
  assert.equal(gesture(backdropDismiss, field, field), 0);
});
test('a drag-out is forgotten: the next real backdrop click still closes', () => {
  const h = backdropDismiss(() => { h.closed = (h.closed ?? 0) + 1; });
  h.onMouseDown(ev(field)); h.onClick(ev(backdrop));
  h.onMouseDown(ev(backdrop)); h.onClick(ev(backdrop));
  assert.equal(h.closed, 1);
});
test('a click with no mousedown seen (keyboard, synthetic) still closes', () => {
  const b = {};
  let closed = 0;
  backdropDismiss(() => { closed++; }).onClick({ target: b, currentTarget: b });
  assert.equal(closed, 1);
});

function* jsx(dir) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name === 'node_modules' || d.name === 'dist') continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) yield* jsx(p);
    else if (d.name.endsWith('.jsx')) yield p;
  }
}
test('no modal backdrop still closes on the bare target check', () => {
  const offenders = [];
  for (const dir of ['src', 'apps/headwinds-web/src']) {
    for (const f of jsx(join(ROOT, dir))) {
      const src = readFileSync(f, 'utf8');
      if (/onClick=\{\s*\(?e\)?\s*=>\s*\{\s*if \(e\.target === e\.currentTarget\)/.test(src)) offenders.push(f.slice(ROOT.length + 1));
    }
  }
  assert.deepEqual(offenders, [], `use {...backdropDismiss(onClose)} instead in: ${offenders.join(', ')}`);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
