// Basemap tile URL: the CARTO API key has to reach the query string.
//
// August 2026: CARTO began requiring a key on their raster basemaps. Unkeyed
// requests still answer HTTP 200 — with "API KEY REQUIRED" painted across the
// tile — so nothing throws, nothing logs, and the only symptom is a player
// posting a screenshot of a defaced world map. There is no runtime signal to
// assert on, which is exactly why the URL construction is pinned here.
//
//   node tools/basemap-key-test.mjs

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cartoTileUrl, TILE_OPTS } from '../src/components/mapCore.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nBasemap tile URL\n');

const UNKEYED = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

test('a key lands in the query string as ?key=', () => {
  assert.equal(cartoTileUrl('abc123'), `${UNKEYED}?key=abc123`);
});

test('no key falls back to the bare URL rather than a broken one', () => {
  assert.equal(cartoTileUrl(''), UNKEYED);
  assert.equal(cartoTileUrl(undefined), UNKEYED);
});

test('Leaflet placeholders survive — a mangled template is a blank map', () => {
  const url = cartoTileUrl('abc123');
  for (const token of ['{s}', '{z}', '{x}', '{y}', '{r}']) {
    assert.ok(url.includes(token), `lost ${token}`);
  }
});

test('exactly one query separator, key last', () => {
  const url = cartoTileUrl('abc123');
  assert.equal(url.split('?').length, 2);
  assert.ok(url.endsWith('?key=abc123'));
});

test('a key with URL-hostile characters is encoded', () => {
  assert.equal(cartoTileUrl('a b&c=d'), `${UNKEYED}?key=a%20b%26c%3Dd`);
});

test('attribution still credits OSM and CARTO — required by the free tier', () => {
  assert.match(TILE_OPTS.attribution, /openstreetmap\.org/);
  assert.match(TILE_OPTS.attribution, /carto\.com/);
});

// ── The regression that actually bites ───────────────────────────────────────
// Every past map bug here started with the tile URL being pasted inline into a
// new component. An inline copy is keyless by construction, so it watermarks in
// production while every other map on the site looks fine.

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs|ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

test('only the basemap module names the CARTO host', () => {
  const offenders = walk('src')
    .concat(walk('apps/headwinds-web/src'))
    .filter(f => readFileSync(f, 'utf8').includes('basemaps.cartocdn.com'))
    .filter(f => !f.endsWith('mapCore.js'));
  assert.deepEqual(offenders, [], `inline tile URL (will be keyless): ${offenders.join(', ')}`);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
