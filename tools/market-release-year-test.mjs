// Fleet → Market: release year on both layouts.
//
// Discord, 2026-10-17 (VodkaOnFire): "Can we add a 'release year' on the
// aircrafts page, both in cards and table variants? I forget when aircraft
// released, and don't necessarily wanna buy something that is dating in 4-5
// years."
//
// The contract: the table carries a sortable Year column (entry into service),
// with a second line in era worlds saying when passengers start marking the
// design down; cards show "Introduced <year>" by the maker. The "dates" year is
// the first year designAgeQualityPts goes negative, so the table line, the
// card's "Dates from" badge and the quality score can never disagree.
//
//   node --import ./tools/_register-loader.mjs tools/market-release-year-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window ??= { localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 1200 };
if (!globalThis.window.localStorage) globalThis.window.localStorage = globalThis.localStorage;
globalThis.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Marketplace = (await import('../src/components/Marketplace.jsx')).default;
const { AIRCRAFT_TYPES } = await import('../src/data/aircraft.js');
const { designAgeQualityPts, DESIGN_AGE_GRACE_YEARS } = await import('../src/models/demand.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
const clean = (html) => html.replace(/<!-- -->/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const get = (id) => AIRCRAFT_TYPES.find(t => t.id === id);

const base = (over = {}) => ({
  ...freshState(), phase: 'playing', week: 1, year: 1, cash: 40_000_000, hub: 'JFK', airlineName: 'Test',
  routes: [], cargoRoutes: [], competitors: [], fleet: [], pendingOrders: [], objectives: [],
  objectivesEnabled: false, ...over,
});
function render(save, layout) {
  store.clear();
  store.set('bbae_save_v2', JSON.stringify(save));
  store.set('market_layout', layout);
  return clean(renderToString(React.createElement(GameProvider, null, React.createElement(Marketplace))));
}
function tableRow(html, name) {
  const row = html.split('<tr').find(r => r.includes(`>${name}<`));
  assert.ok(row, `no table row for ${name}`);
  return row;
}

console.log('\nFleet → Market release year\n');

const a320 = get('a320ceo');

test('every type has an entry-into-service year to show', () => {
  const missing = AIRCRAFT_TYPES.filter(t => !Number.isInteger(t.eis)).map(t => t.id);
  assert.deepEqual(missing, []);
});

test('"dates" year = the first year the quality score marks the design down', () => {
  for (const t of AIRCRAFT_TYPES) {
    if (t.category === 'Supersonic') continue;
    const from = t.eis + DESIGN_AGE_GRACE_YEARS + 1;
    assert.equal(designAgeQualityPts(t, from - 1), 0, `${t.name} already dated in ${from - 1}`);
    assert.ok(designAgeQualityPts(t, from) < 0, `${t.name} not yet dated in ${from}`);
  }
});

test('table: sortable Year column, release year on every row (classic world)', () => {
  const html = render(base(), 'table');
  assert.match(html, /<th[^>]*title="Year the type entered service[^"]*"[^>]*>Year</);
  const row = tableRow(html, get('a320neo').name);
  assert.match(row, />2016</);
  assert.doesNotMatch(html, />dates \d{4}</, 'classic designs never date — no dating line');
});

test('table, era 1990: A320ceo (1988) shows 1988 and "dates 2004", muted', () => {
  const row = tableRow(render(base({ startYear: 1990 }), 'table'), a320.name);
  assert.match(row, />1988</);
  assert.match(row, /color:var\(--text-muted\)[^>]*>dates 2004</);
});

test('table, era 2000: within five years of dating → yellow', () => {
  const row = tableRow(render(base({ startYear: 2000 }), 'table'), a320.name);
  assert.match(row, /color:var\(--yellow\)[^>]*>dates 2004</);
});

test('table, era 2010: already dated → red, with the quality hit', () => {
  const pts = Math.round(designAgeQualityPts(a320, 2010));
  const row = tableRow(render(base({ startYear: 2010 }), 'table'), a320.name);
  assert.match(row, new RegExp(`color:var\\(--red\\)[^>]*>dated · ${pts} qual<`));
});

test('table, era 1995: Concorde (1976) is exempt — year, no dating line', () => {
  const row = tableRow(render(base({ startYear: 1995 }), 'table'), get('concorde').name);
  assert.match(row, new RegExp(`>${get('concorde').eis}<`));
  assert.doesNotMatch(row, /dates \d{4}|dated ·/);
});

function cardTitle(html, name) {
  const m = html.match(new RegExp(`>${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span><span[^>]*>(.*?)</span></span>`));
  assert.ok(m, `no card title for ${name}`);
  return m[1].replace(/<[^>]+>/g, '');
}

test('cards: "Introduced <year>" next to the maker, classic and era', () => {
  assert.equal(cardTitle(render(base(), 'cards'), get('a320neo').name), `${get('a320neo').manufacturer} · Introduced 2016`);
  assert.equal(cardTitle(render(base({ startYear: 1990 }), 'cards'), a320.name), `${a320.manufacturer} · Introduced 1988`);
});

test('cards, era 2000: every "Dates from" badge = EIS + 16, the first year of markdown', () => {
  const html = render(base({ startYear: 2000 }), 'cards');
  const badges = [...html.matchAll(/marking this (\d{4}) design down in (\d{4})[^>]*>Dates from (\d{4})</g)];
  assert.ok(badges.length > 0, 'expected some types five years from dating in 2000');
  for (const [, eis, inYear, label] of badges) {
    assert.equal(Number(label), Number(eis) + DESIGN_AGE_GRACE_YEARS + 1, `${eis} design labelled ${label}`);
    assert.equal(inYear, label, 'tooltip and label disagree');
  }
  assert.ok(badges.some(b => b[1] === '1988' && b[3] === '2004'), 'A320ceo badge should read 2004');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
