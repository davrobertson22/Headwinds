// The career panel, rendered for real.
//
// The whole point of the career layer is that a finished season shows up
// somewhere a player will see it. A record written correctly into a JSONB
// column that never reaches the page would be the same amount of nothing the
// world used to leave behind.
//
//   node --import ./tools/_register-loader.mjs tools/career-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

globalThis.window = globalThis.window ?? {};
window.location = window.location ?? { hash: '', origin: 'http://localhost:5173' };
window.addEventListener = window.addEventListener ?? (() => {});
window.removeEventListener = window.removeEventListener ?? (() => {});

const CareerPanel = (await import('../apps/headwinds-web/src/CareerPanel.jsx')).default;
const { serializeCareer, withWorldRecord, emptyCareer } = await import('../apps/headwinds-server/src/lib/career.mjs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

// React SSR splits adjacent text nodes with an empty comment.
const render = (career) => renderToString(React.createElement(CareerPanel, { career }))
  .replace(/<!-- -->/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const season = (over = {}) => ({
  worldId: 'w1', worldName: 'Blitz One', lengthYears: 3, endedAt: '2026-01-01T00:00:00.000Z',
  airlineId: 'a1', airlineName: 'Test Air', hub: 'JFK',
  rank: 1, of: 20, bestRank: 1, svps: 50_000, marketCap: 900_000_000,
  status: 'ACTIVE', restarts: 0, passengers: 4_200_000, weeksPlayed: 156, ...over,
});

const careerOf = (...seasons) =>
  serializeCareer(seasons.reduce((c, s) => withWorldRecord(c, s), emptyCareer()));

console.log('\n── Career panel ─────────────────────────────────────────');

test('an account with no finished season shows nothing at all', () => {
  // A hall of fame full of zeroes is worse than no hall of fame.
  assert.equal(render(careerOf()).trim(), '');
  assert.equal(render(null).trim(), '');
  assert.equal(render(undefined).trim(), '');
});

test('a finished season puts the record on the page', () => {
  const html = render(careerOf(season()));
  assert.ok(html.includes('Career'));
  assert.ok(html.includes('One season finished'));
  assert.ok(html.includes('Blitz One'), 'the world should be named');
  assert.ok(html.includes('Test Air'), 'and so should the airline');
});

test('a win reads as a win', () => {
  const html = render(careerOf(season({ rank: 1 })));
  assert.ok(html.includes('1st'), 'the finish should be ordinal, not a bare number');
  assert.ok(html.includes('🏆'));
  assert.ok(html.includes('Champion'), 'the badge should be earned and shown');
});

test('the totals are the totals', () => {
  const html = render(careerOf(
    season({ worldId: 'w1', rank: 1, passengers: 4_000_000 }),
    season({ worldId: 'w2', rank: 2, passengers: 3_000_000, worldName: 'Blitz Two' }),
  ));
  assert.ok(html.includes('2 seasons finished'));
  assert.ok(html.includes('Championships'));
  assert.ok(html.includes('7M'), 'lifetime passengers should be 7M');
  assert.ok(html.includes('Blitz Two'));
});

test('an unranked season says unranked, not last', () => {
  const html = render(careerOf(season({ rank: null })));
  assert.ok(html.includes('unranked'));
  assert.ok(html.includes('Best finish'));
  assert.ok(html.includes('no ranked season yet'));
});

test('a bankrupt season is shown, not hidden', () => {
  const html = render(careerOf(season({ status: 'BANKRUPT', rank: null, restarts: 1 })));
  assert.ok(html.includes('bankrupt'));
  assert.ok(html.includes('Phoenix'), 'coming back and finishing earns the badge');
  assert.ok(html.includes('Re-foundings'));
});

test('a backfilled season with no passenger count explains itself', () => {
  // Seasons that ended before the career layer existed genuinely have no
  // figure. A silent 0 would read as "you carried nobody".
  const html = render(careerOf(season({ passengers: 0 })));
  assert.ok(html.includes('—'), 'a dash, not a zero');
  assert.ok(html.includes('never written down at the time'));
});

test('a career blob full of nonsense does not take the lobby down with it', () => {
  for (const junk of [{ totals: null }, { totals: { worldsFinished: 'many' } }, { worlds: 'no' }]) {
    assert.doesNotThrow(() => render(junk), JSON.stringify(junk));
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
