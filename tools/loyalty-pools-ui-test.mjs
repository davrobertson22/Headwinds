// Server-renders the REAL Loyalty page (and Reputation) in a loyalty-pools
// world — no mocks. The engine suite (tools/loyalty-pools-test.mjs) proves the
// model; this proves the screen shows the engine's numbers, that a classic
// world keeps its old page, and that every hand-built offer that carries the
// travel-partner fields carries the loyalty fields too (previews must agree
// with the tick).
//
//   node --import ./tools/_register-loader.mjs tools/loyalty-pools-ui-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { referencePrice } from '../src/utils/simulation.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

console.log('\nLoyalty pools — the screens\n');

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter && t.seats >= 150 && t.seats <= 200).sort((a, b) => b.range - a.range)[0];
const P = 'DEN', Q = 'ORD';
const FARE = Math.round(referencePrice(P, Q));

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Loyalty    = (await import('../src/components/Loyalty.jsx')).default;
const Reputation = (await import('../src/components/Reputation.jsx')).default;

function seed(extra = {}) {
  const save = {
    ...freshState(),
    phase: 'playing', week: 40, year: 2, hub: P, cash: 400_000_000,
    gates: { [P]: 8, [Q]: 8 },
    fleet: [{ id: 'ac1', typeId: jet.id, name: 'One', tailNumber: 'N1TEST', status: 'assigned',
      ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats - 12, businessClass: 12 } }],
    routes: [{ id: 'r1', origin: P, destination: Q, stops: [P, Q], aircraftId: 'ac1',
      weeklyFrequency: 14, weeksOpen: 40, hub: P, ticketPrice: FARE }],
    loyaltyPoolsWorld: true,
    lastReport: { reputationScore: 60, totalRevenue: 2_000_000, totalPassengers: 4_000,
      totalLoyaltyCost: 41_000, loyaltyPointsCost: 30_000, loyaltyAdminCost: 11_000, loyaltyOnTime: 0.86 },
    ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!--.*?-->/g, '');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const running = {
  generosity: 0.07, maturity: 0.6, members: 38_000, elites: 3_100, pointsLiability: 1_250_000,
  onTimeEma: 0.86, lastWeek: { joined: 900, defected: 120 },
  pools: { DEN: [30_000, 2_600, 2_268], [Q === 'ORD' ? 'chicago' : Q]: [8_000, 500, 2_268] },
};

test('a classic world keeps the budget-and-tier page', () => {
  seed({ loyaltyPoolsWorld: undefined });
  const t = text(render(React.createElement(Loyalty)));
  assert.match(t, /Weekly Investment/);
  assert.ok(!t.includes('Status year'));
});

test('a pools world with the program closed offers to open it at the default', () => {
  seed();
  const html = render(React.createElement(Loyalty));
  const t = text(html);
  assert.ok(html.includes('data-city-loyalty'));
  assert.match(t, /Frequent flyers in every city join the best program there/);
  assert.match(t, /Open program at 6\.0%/);
  assert.ok(!t.includes('Weekly Investment'));
});

test('a running program shows members, the checklist, the status year and the cities', () => {
  seed({ loyalty: running, competitors: [{ id: 'human:r', name: 'Rival Air', loyaltyPools: { DEN: [20_000, 520, 21_000, 2_000] } }] });
  const html = render(React.createElement(Loyalty));
  const t = text(html);
  assert.match(t, /38,000/);
  assert.match(t, /3,100 elites/);
  assert.match(t, /Points owed/);
  assert.match(t, /Elites requalify in 12 weeks/);
  assert.match(t, /Checked bag included/);
  assert.match(t, /On time \(86%\)/);
  assert.ok(html.includes('data-loyalty-city="DEN"'));
  assert.match(t, /Denver/);
  assert.match(t, /Rival Air/);
  assert.match(t, /21,000 members/);
  assert.match(t, /Close program/);
});

test('a rival\'s devaluation shows a status match with the engine\'s price', () => {
  const abs = (2 - 1) * 52 + 40;
  seed({ loyalty: running, competitors: [{ id: 'human:r', name: 'Rival Air', routes: {},
    loyaltyDevaluation: { cut: 0.03, absWeek: abs }, loyaltyPools: { DEN: [20_000, 520, 21_000, 2_000] } }] });
  const html = render(React.createElement(Loyalty));
  const t = text(html);
  assert.ok(html.includes('data-loyalty-status-match') && html.includes('data-match-offer="human:r"'));
  assert.match(t, /Rival Air devalued by 3\.0 points/);
  assert.match(t, /Match — \$/);
});

test('no devaluation, no status-match card', () => {
  seed({ loyalty: running, competitors: [{ id: 'human:r', name: 'Rival Air', routes: {}, loyaltyPools: { DEN: [20_000, 520, 21_000, 2_000] } }] });
  assert.ok(!render(React.createElement(Loyalty)).includes('data-loyalty-status-match'));
});

test('an era world before 1981 explains that programs do not exist yet', () => {
  seed({ startYear: 1975, year: 1 });
  const t = text(render(React.createElement(Loyalty)));
  assert.match(t, /first launches in 1981/);
  assert.ok(!/Open program at/.test(t));
});

test('Reputation renders in a pools world with a devaluation on record', () => {
  seed({ loyalty: { ...running, devaluation: { cut: 0.02, until: 999, maturity: 0.6, applied: true } } });
  const t = text(render(React.createElement(Reputation)));
  assert.ok(t.length > 100);
});

test('every hand-built offer that carries the travel-partner fields carries the loyalty fields', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    ...fs.readdirSync(path.join(root, 'src/components')).filter(f => f.endsWith('.jsx')).map(f => path.join(root, 'src/components', f)),
    path.join(root, 'packages/engine/src/models/pairShare.js'),
    path.join(root, 'apps/headwinds-server/src/lib/humanRivals.mjs'),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const travel = (src.match(/\.\.\.stateTravelPartnerFields\(/g) ?? []).length;
    const loyal = (src.match(/\.\.\.stateLoyaltyFields\(/g) ?? []).length;
    assert.equal(loyal, travel, `${path.basename(f)}: ${travel} travel-partner spreads, ${loyal} loyalty spreads`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
