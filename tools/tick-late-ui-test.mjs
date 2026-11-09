// The topbar clock when a world's week is late (TickCountdown, SSR).
//
// 2026-11-09: Heavy Landing sat on "next week landing…" for hours while the
// server was 16 weeks behind, and players asked on Discord whether it was just
// them. Past LATE_AFTER_MS the clock now says the world is behind.
//
//   node --import ./tools/_register-loader.mjs tools/tick-late-ui-test.mjs

import assert from 'node:assert/strict';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { default: TickCountdown, weeksBehind, LATE_AFTER_MS } = await import('../apps/headwinds-web/src/TickCountdown.jsx');
const strip = (h) => h.replaceAll('<!-- -->', '').replace(/<[^>]+>/g, '');
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
const render = (props) => renderToString(React.createElement(TickCountdown, props));

await test('just past due: still "next week landing…"', () => {
  const html = strip(render({ nextTickAt: ago(20_000), weeksPerDay: 24 }));
  assert.match(html, /next week landing…/);
});

await test('past the late threshold on the due week: "running late", and not your connection', () => {
  const raw = render({ nextTickAt: ago(LATE_AFTER_MS + 30_000), weeksPerDay: 24 });
  assert.match(strip(raw), /next week running late…/);
  assert.match(raw, /isn(&#x27;|')t your connection/);
});

await test('later weeks due too: "catching up · N weeks behind" (Heavy Landing, 16 h at 24/day)', () => {
  const raw = render({ nextTickAt: ago(15 * HOUR + 60_000), weeksPerDay: 24 });
  assert.match(strip(raw), /catching up · 16 weeks behind/);
  assert.match(raw, /running this world 16 weeks behind/);
});

await test('a lost connection still reads as ours, not the world\'s', () => {
  assert.match(strip(render({ nextTickAt: ago(5 * HOUR), weeksPerDay: 24, stale: true })), /waiting for the server…/);
});

await test('a pre-start world keeps "first week landing…"', () => {
  assert.match(strip(render({ nextTickAt: ago(10 * 60_000), weeksPerDay: 24, preStart: true })), /first week landing…/);
});

await test('weeksBehind arithmetic', () => {
  assert.equal(weeksBehind(0, 24), 1);
  assert.equal(weeksBehind(HOUR - 1, 24), 1);
  assert.equal(weeksBehind(HOUR, 24), 2);
  assert.equal(weeksBehind(5 * HOUR, null), 1, 'no pace: cannot count, say the due week');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
