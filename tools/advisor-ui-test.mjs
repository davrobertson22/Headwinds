// Company ▸ Advisor and the Dashboard's Advisor line, SSR-rendered for real.
//
// CLAUDE.md: "SSR-render the real component when testing UI agreement. A
// helper tested in isolation can pass while the component that calls it
// fails." tools/advisor-test.mjs proves engine models/advisor.js; this proves
// the screens show exactly that advice, off the same projection the Dashboard
// alerts use, and that the page is reachable from both layouts' navigation.
//
// Verified failing on HEAD (2026-11-09): src/components/Advisor.jsx did not
// exist, the Dashboard rendered no data-advisor="teaser", and App.jsx had no
// 'advisor' tab.
//
//   node --import ./tools/_register-loader.mjs tools/advisor-ui-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? {};
window.dispatchEvent = () => true;
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
globalThis.matchMedia = window.matchMedia;
globalThis.CustomEvent = globalThis.CustomEvent ?? class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
window.localStorage = globalThis.localStorage;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}

let x = 99;
Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };

const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');
const { airlineAdvice } = await import('../packages/engine/src/models/advisor.js');
const { projectWeekShared } = await import('../src/utils/airlineAlerts.js');
const { GameProvider } = await import('../src/store/GameContext.jsx');
const Advisor = (await import('../src/components/Advisor.jsx')).default;
const Dashboard = (await import('../src/components/Dashboard.jsx')).default;
const { MAP_PAGES, MAP_GROUPS } = await import('../src/components/MapShell.jsx');
const { navPathFor } = await import('../src/navPath.js');

const render = (state, Comp) => {
  store.set('bbae_save_v2', JSON.stringify(state));
  return renderToString(React.createElement(GameProvider, null, React.createElement(Comp)));
};
const unescape = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<!-- -->/g, '');

function airline() {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Probe Air', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 5e9 };
  for (let i = 0; i < 4; i++) s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'JFK' });
  for (const d of ['ORD', 'MIA']) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
    const ac = s.fleet[s.fleet.length - 1].id;
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: d });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac, origin: 'JFK', destination: d, weeklyFrequency: 14 });
  }
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
  for (let i = 0; i < 4; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  return s;
}
const S = airline();

console.log('\nAdvisor screens (SSR)\n');

await test('the Advisor page lists exactly the engine\'s advice, in order, off the shared projection', async () => {
  const html = unescape(render(S, Advisor));
  // GameProvider hydrates the save, so compute against what it holds
  const want = airlineAdvice(S, projectWeekShared(S).report);
  assert.ok(want.length >= 2, `fixture should produce advice, got ${want.length}`);
  const got = [...html.matchAll(/data-advice="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(got, want.map(a => a.id));
  for (const a of want) assert.ok(html.includes(a.title), a.title);
  assert.ok(html.includes('data-advisor="copy-briefing"'));
  assert.ok(html.includes('Copy airline briefing'));
  // the buttons explain themselves: three steps and the what's-in-it fold
  assert.ok(html.includes('data-advisor="briefing-help"'));
  assert.match(html, /Ask your own AI about your airline/);
  assert.match(html, /What's in the briefing, and what isn't/);
});

await test('the page never mentions the supporter perk (the ask stays out of the game loop)', async () => {
  const html = render(S, Advisor).toLowerCase();
  for (const w of ['supporter', 'ko-fi', 'kofi', 'api token']) assert.ok(!html.includes(w), w);
});

await test('an airline with nothing to flag gets the empty state', async () => {
  const quiet = { ...S, fleet: [], routes: [], ancillaries: {}, awareness: 90 };
  const html = render(quiet, Advisor);
  const shown = [...html.matchAll(/data-advice="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(shown, ['none']);
});

await test('the Dashboard shows one Advisor line with the count and the top title', async () => {
  const html = unescape(render(S, Dashboard));
  const want = airlineAdvice(S, projectWeekShared(S).report);
  assert.ok(html.includes('data-advisor="teaser"'));
  assert.ok(html.includes(`${want.length} suggestion${want.length === 1 ? '' : 's'}`));
  assert.ok(html.includes(want[0].title));
  assert.ok(html.includes(`${navPathFor('advisor')} →`));
});

await test('reachable from both layouts: classic Company group and the map view\'s Operations dock', async () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /\{ id: 'advisor',\s+label: 'Advisor'/);
  assert.match(app, /label: 'Company',[^\n]*children: \['advisor'/);
  assert.match(app, /advisor:\s+<Advisor \/>/);
  assert.equal(navPathFor('advisor'), 'Company ▸ Advisor');
  assert.equal(MAP_PAGES.advisor.tab, 'advisor');
  assert.ok(MAP_GROUPS.find(g => g.id === 'ops').pages.includes('advisor'));
});

// ── Lobby: the supporters' connector card ───────────────────────────────────
const AiConnectorCard = (await import('../apps/headwinds-web/src/AiConnectorCard.jsx')).default;
const SupportCard = (await import('../apps/headwinds-web/src/SupportCard.jsx')).default;
const me = (over = {}) => ({ account: { id: 'a1', displayName: 'Dave', ...over } });

await test('the connector card shows for supporters only; everyone else sees the perk on the support card', async () => {
  const sup = renderToString(React.createElement(AiConnectorCard, { me: me({ isSupporter: true }), token: 't' }));
  assert.ok(sup.includes('data-card="ai-connector"'));
  assert.match(sup, /read-only/);
  assert.match(sup, /Create connector/);
  const free = renderToString(React.createElement(AiConnectorCard, { me: me(), token: 't' }));
  assert.equal(free, '');
  const ask = unescape(renderToString(React.createElement(SupportCard, { me: me() })));
  assert.match(ask, /Connect your own AI/);
  assert.match(ask, /no cash, no gates, no speed/i);
  // the card explains itself before any token exists
  const card = unescape(sup);
  assert.ok(card.includes('data-help="connector-vs-briefing"'));
  assert.ok(card.includes('data-help="connector-limits"'));
  assert.match(card, /Setting one up/);
  assert.match(card, /Can't change anything/);
});

await test('Help has an Advisor & AI briefing section — and, being in the game, no supporter ask', async () => {
  const Wiki = (await import('../src/components/Wiki.jsx')).default;
  const html = unescape(render(S, Wiki));
  assert.match(html, /Advisor &amp; AI briefing|Advisor & AI briefing/);
  const src = readFileSync(new URL('../src/components/Wiki.jsx', import.meta.url), 'utf8');
  const sec = src.slice(src.indexOf("id: 'advisor'"), src.indexOf("id: 'map'"));
  assert.match(sec, /Copy airline briefing/);
  for (const w of ['supporter', 'connector', 'ko-fi']) assert.ok(!sec.toLowerCase().includes(w), w);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
