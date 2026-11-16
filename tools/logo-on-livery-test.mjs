// The airline logo on the livery (Discord, VodkaOnFire 2026-11-14):
//   1. an uploaded PNG straight on the paint, its clear areas see-through,
//   2. a shape for the logo (square / rounded / circle),
//   3. X / Y / size for the fin logo, the fin cutting off what runs past it.
//
//   node --import ./tools/_register-loader.mjs tools/logo-on-livery-test.mjs
//
// Written failing on HEAD: the livery dropped logoShape / tailLogoX / Y /
// Scale on the floor, the map fin always put an upload on a dark tile, and
// the fin logo could not move.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const strip = (h) => h.replaceAll('<!-- -->', '');

const L = await import('../packages/engine/src/data/livery.js');
const TailFin = (await import('../src/components/TailFin.jsx')).default;
const AirlineLogo = (await import('../src/components/AirlineLogo.jsx')).default;
const { logoSrcsFor } = await import('../src/components/LiveryPlane.jsx');
const guard = await import('../apps/headwinds-server/src/lib/decisionGuard.mjs');
const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');

const PNG = 'data:image/png;base64,AAAA';
const fin = (livery, logo = { id: null, customSrc: PNG }) =>
  strip(renderToStaticMarkup(React.createElement(TailFin, { livery: { tail: '#0a2a66', ...livery }, logo, height: 60, idPrefix: 'x' })));

console.log('\n── 1. The new livery fields are kept, clamped and keyed ─────────────');

await test('shape and fin placement survive normalisation; junk falls back to the defaults', () => {
  const l = L.normalizeLivery({ logoShape: 'circle', tailLogoX: 0.4, tailLogoY: -0.25, tailLogoScale: 2.5 });
  assert.equal(l.logoShape, 'circle');
  assert.equal(l.tailLogoX, 0.4);
  assert.equal(l.tailLogoY, -0.25);
  assert.equal(l.tailLogoScale, 2.5);
  const d = L.normalizeLivery({ logoShape: 'star', tailLogoX: 'NaN', tailLogoY: Infinity, tailLogoScale: {} });
  assert.deepEqual([d.logoShape, d.tailLogoX, d.tailLogoY, d.tailLogoScale], [null, 0, 0, 1]);
});

await test('placement is clamped to the limits and rounded to 2 dp', () => {
  const l = L.normalizeLivery({ tailLogoX: 9, tailLogoY: -9, tailLogoScale: 40 });
  assert.deepEqual([l.tailLogoX, l.tailLogoY, l.tailLogoScale], [1, -1, 3]);
  assert.equal(L.normalizeLivery({ tailLogoScale: 0.01 }).tailLogoScale, 0.5);
  assert.equal(L.normalizeLivery({ tailLogoX: 0.123456 }).tailLogoX, 0.12);
  assert.ok(Object.is(L.normalizeLivery({ tailLogoX: -0.001 }).tailLogoX, 0), 'no −0 in the blob');
});

await test('a saved livery without the new fields looks exactly as before', () => {
  const l = L.normalizeLivery({ tail: '#c8102e' });
  assert.deepEqual([l.logoShape, l.tailLogoX, l.tailLogoY, l.tailLogoScale], [null, 0, 0, 1]);
  assert.equal(L.effectiveLogoShape(l, true), 'circle', 'a tile has always painted as a circle at livery sizes');
  assert.equal(L.effectiveLogoShape(l, false), 'square', 'a bare upload is not cropped');
  assert.deepEqual(L.tailLogoBox({ cx: 600, cy: 580, size: 600 }, l), { cx: 600, cy: 580, size: 600 });
  assert.equal(L.tailLogoMoved(l), false);
});

await test('every new field is a new paint (cache key)', () => {
  const base = L.liveryKey({});
  for (const patch of [{ logoShape: 'rounded' }, { tailLogoX: 0.2 }, { tailLogoY: 0.2 }, { tailLogoScale: 1.5 }]) {
    assert.notEqual(L.liveryKey(patch), base, JSON.stringify(patch));
  }
});

await test('placement maths: +x towards the nose, +y up, size scales the box', () => {
  const b = L.tailLogoBox({ cx: 600, cy: 580, size: 600 }, { tailLogoX: 0.5, tailLogoY: 0.5, tailLogoScale: 2 });
  assert.deepEqual(b, { cx: 900, cy: 280, size: 1200 });
  const left = L.tailLogoBox({ cx: 600, cy: 580, size: 600 }, { tailLogoX: 0.5 }, false);
  assert.equal(left.cx, 300, 'a nose-left drawing (the aircraft template) moves the other way: still towards the nose');
});

console.log('\n── 2. Through the server guard and the reducer ──────────────────────');

await test('SET_BRANDING keeps the shape and placement (guard and reducer)', () => {
  const out = guard.guardDecision('SET_BRANDING', { airlineName: 'X', livery: { logoShape: 'rounded', tailLogoX: -0.3, tailLogoY: 0.6, tailLogoScale: 9 } }, {});
  assert.equal(out.livery.logoShape, 'rounded');
  assert.equal(out.livery.tailLogoX, -0.3);
  assert.equal(out.livery.tailLogoScale, 3, 'clamped server-side too');
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Fin Air', hub: 'SYD', enableObjectives: false });
  s = gameReducer(s, { type: 'SET_BRANDING', livery: out.livery });
  assert.equal(s.livery.tailLogoY, 0.6);
  assert.equal(s.livery.logoShape, 'rounded');
});

console.log('\n── 3. The map / profile fin (TailFin) ───────────────────────────────');

await test('an upload sits straight on the tail paint by default — no dark tile behind a transparent PNG', () => {
  const html = fin({});
  assert.match(html, /<image[^>]+href="data:image\/png;base64,AAAA"/);
  assert.doesNotMatch(html, /fill="#15202f"/, 'no default tile behind the upload');
  assert.match(fin({ logoTile: true }), /fill="#15202f"/, 'on its tile when the livery asks for it');
  assert.match(fin({ logoTile: true }, { id: null, customSrc: PNG, bgColor: '#ffcc00' }), /fill="#ffcc00"/, 'in the tile colour');
});

await test('the shape outlines the upload and the tile', () => {
  assert.match(fin({ logoShape: 'circle' }), /<clipPath id="clip-[^"]*"><rect width="40" height="40" rx="20"/);
  assert.match(fin({ logoShape: 'rounded' }), /<rect width="40" height="40" rx="8"/);
  assert.match(fin({}), /<rect width="40" height="40" rx="0"/, 'bare upload, no shape picked: uncropped');
  assert.match(fin({ logoTile: true }), /<rect width="40" height="40" rx="20"/, 'tile default: the circle it always was');
  const preset = fin({ logoTile: true, logoShape: 'square' }, { id: 'eagle', accentColor: '#d71920' });
  assert.match(preset, /<rect width="40" height="40" rx="0"/, 'a preset tile takes the shape too');
});

await test('the fin logo moves and grows, still inside the fin clip', () => {
  assert.match(fin({}), /<g transform="translate\(300 280\)"><svg width="600" height="600"/, 'default spot');
  const moved = fin({ tailLogoX: 0.5, tailLogoY: 0.5, tailLogoScale: 2 });
  assert.match(moved, /<g transform="translate\(300 -320\)"><svg width="1200" height="1200"/);
  assert.match(moved, /<g clip-path="url\(#fin-x\)">[\s\S]*<g transform="translate\(300 -320\)">/, 'drawn inside the clipped group');
});

await test('AirlineLogo: shape overrides the px radius; nothing else changes', () => {
  const r = (props) => strip(renderToStaticMarkup(React.createElement(AirlineLogo, { id: 'eagle', ...props })));
  assert.match(r({ size: 600, shape: 'rounded' }), /rx="8"/);
  assert.match(r({ size: 600, shape: 'square' }), /rx="0"/);
  assert.match(r({ size: 28, radius: 6 }), /rx="6"/, 'list tiles untouched');
});

console.log('\n── 4. The aircraft (LiveryPlane / liveryPaint) ──────────────────────');

await test('an upload is painted bare by default, on its tile colour when asked, in the chosen shape', () => {
  const n = (l) => L.normalizeLivery(l);
  assert.deepEqual(logoSrcsFor({ customSrc: PNG }, n({})).clip, { shape: 'square', bg: null });
  assert.deepEqual(logoSrcsFor({ customSrc: PNG, bgColor: '#ffcc00' }, n({ logoTile: true })).clip, { shape: 'circle', bg: '#ffcc00' });
  assert.deepEqual(logoSrcsFor({ customSrc: PNG }, n({ logoTile: true, logoShape: 'rounded' })).clip, { shape: 'rounded', bg: '#15202f' });
  const tile = logoSrcsFor({ id: 'eagle', accentColor: '#d71920' }, n({ logoTile: true, logoShape: 'square' }));
  assert.equal(tile.clip, null, 'a preset carries its own tile');
  assert.match(tile.tail, /rx="0"/);
});

await test('the painter places the fin logo by the livery and cuts it to the fin part', () => {
  const src = read('../src/utils/liveryPaint.js');
  assert.match(src, /const box = tailLogoBox\(spec\.logo, livery, b\.noseX > b\.tailX\);/);
  assert.match(src, /if \(parts\[i\] !== PART\.fin\) continue;/);
  assert.match(src, /drawLogo\(p, bodyLogo, [^)]+, logoClip\)/);
});

await test('both editors offer the shape and placement controls', () => {
  assert.match(read('../src/components/LiveryEditor.jsx'), /<LogoPlacement /);
  assert.match(read('../src/components/TailPicker.jsx'), /<LogoPlacement /);
  assert.doesNotMatch(read('../src/components/LiveryEditor.jsx'), /\(l\.logoOnTail \|\| l\.logoOnFuselage\) && !logo\?\.customSrc/, 'the tile option is offered for uploads too');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
