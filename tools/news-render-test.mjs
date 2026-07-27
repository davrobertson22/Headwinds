// Render smoke: the News tab mounts and composes real sentences.
//
// Server-renders the REAL component against a fixed news payload, so a broken
// composer, a bad hook or a wrong data shape fails here rather than in a world.
//
//   node --import ./tools/_register-loader.mjs tools/news-render-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

const store = new Map();
globalThis.window = globalThis.window ?? { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { default: News } = await import('../src/components/News.jsx');
const { RemoteGameProvider } = await import('../src/store/GameContext.jsx');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const ITEMS = [
  {
    id: 'i1', at: new Date().toISOString(), year: 2, week: 14, category: 'fleet',
    kind: 'fleet_in', tier: 1, airlineId: 'a2', airline: 'Sky Blue',
    data: { total: 12, byType: { b738: 12 }, ordered: true },
  },
  {
    id: 'i2', at: new Date().toISOString(), year: 2, week: 14, category: 'routes',
    kind: 'routes_opened', tier: 2, airlineId: 'a3', airline: 'Condor Air',
    data: {
      total: 6, commonOrigin: 'DEN', cargo: false,
      pairs: [
        { origin: 'DEN', destination: 'BOI' }, { origin: 'DEN', destination: 'TUS' },
        { origin: 'DEN', destination: 'OKC' }, { origin: 'DEN', destination: 'MSO' },
        { origin: 'DEN', destination: 'BIL' }, { origin: 'DEN', destination: 'RAP' },
      ],
    },
    detail: [],
  },
  {
    id: 'i3', at: new Date().toISOString(), year: 2, week: 14, category: 'world',
    kind: 'event_started', tier: 1, airlineId: null, airline: null,
    data: { name: 'Fuel Price Spike', icon: '⛽', description: 'Jet fuel costs up 23%.' },
  },
  {
    id: 'i4', at: new Date().toISOString(), year: 2, week: 13, category: 'stocks',
    kind: 'stock_tape', tier: 1, airlineId: 'a2', airline: 'Sky Blue',
    data: {
      targetId: 'a3', targetName: 'Condor Air', netShares: 6_000_000,
      grossValue: 1_200_000, pricePerShare: 1, stakePct: 6, direction: 'buy',
      crossedThreshold: true,
    },
  },
  {
    id: 'i5', at: new Date().toISOString(), year: 2, week: 13, category: 'standings',
    kind: 'bankruptcy', tier: 1, airlineId: 'a9', airline: 'Meridian Airways',
    data: { routes: 22, fleet: 14 },
  },
];

const STATE = {
  airlineName: 'My Air', week: 14, year: 2,
  routes: [{ id: 'r1', origin: 'DEN', destination: 'BOI', weeklyFrequency: 7 }],
  cargoRoutes: [], gates: { DEN: 4 }, hubs: { DEN: { tier: 2 } }, fleet: [],
};

function render(remoteApi) {
  return renderToString(
    React.createElement(
      RemoteGameProvider,
      { state: STATE, dispatch: () => {}, remoteApi },
      React.createElement(News),
    ),
  );
}

console.log('\nNews tab render\n');

test('mounts and shows its filters before data arrives', () => {
  const html = render({ fetchNews: () => new Promise(() => {}), airlineId: 'a1' });
  assert.ok(html.includes('News'), 'heading renders');
  assert.ok(html.includes('Big moves only'), 'filter chips render');
  assert.ok(html.includes('Loading'), 'loading state while the first page is in flight');
});

test('survives a failing API without crashing the tab', () => {
  const html = render({ fetchNews: () => Promise.reject(new Error('nope')), airlineId: 'a1' });
  assert.ok(html.includes('News'));
});

test('composes a real sentence for every item kind the server emits', async () => {
  const { compose } = await import('../src/components/News.jsx');
  const say = (it) => {
    const c = compose(it);
    const subject = c.standalone ? (c.subject ?? '') : (it.airline ?? c.subject ?? '');
    return `${subject} ${c.headline ?? ''}`.trim();
  };

  // The bug players reported: the count must be in the sentence, and the
  // aircraft must be named, not printed as its internal id.
  const order = say(ITEMS[0]);
  assert.match(order, /Sky Blue ordered 12× /);
  assert.ok(!order.includes('b738'), `raw typeId leaked: ${order}`);

  assert.equal(say(ITEMS[1]), 'Condor Air opened 6 routes from DEN');
  assert.equal(say(ITEMS[2]), 'Fuel Price Spike');
  assert.equal(compose(ITEMS[2]).sub, 'Jet fuel costs up 23%.');
  assert.match(say(ITEMS[3]), /Sky Blue bought 6,000,000 shares in Condor Air — now holds 6%/);
  assert.equal(say(ITEMS[4]), 'Meridian Airways has gone under');
  assert.match(compose(ITEMS[4]).sub, /22 routes and 14 aircraft leave the market/);

  // A single move must not read like a rolled-up one.
  assert.equal(say({
    ...ITEMS[1],
    data: { total: 1, commonOrigin: 'DEN', pairs: [{ origin: 'DEN', destination: 'BOI' }] },
  }), 'Condor Air opened DEN–BOI');

  // Three tails on one pair is ONE route flown three times, not three routes.
  assert.equal(say({
    ...ITEMS[1],
    data: {
      total: 2, services: 4, commonOrigin: 'JFK',
      pairs: [
        { origin: 'JFK', destination: 'LHR', count: 3 },
        { origin: 'JFK', destination: 'NRT', count: 1 },
      ],
    },
  }), 'Condor Air opened 2 routes from JFK');
  assert.equal(say({
    ...ITEMS[1],
    data: {
      total: 1, services: 3, commonOrigin: 'JFK',
      pairs: [{ origin: 'JFK', destination: 'LHR', count: 3 }],
    },
  }), 'Condor Air opened JFK–LHR ×3');

  // Every kind the builder can emit composes something non-empty.
  const KINDS = [
    'event_started', 'event_ended', 'bankruptcy', 'rank_change',
    'routes_opened', 'routes_closed', 'fleet_in', 'fleet_out',
    'gates_added', 'gates_removed', 'hub_designated', 'hub_upgraded', 'focus_city',
    'stock_tape', 'gate_auction_opened', 'gate_auction_won', 'gate_sold',
    'used_aircraft_sold', 'joined', 'alliance_founded', 'alliance_joined', 'alliance_left',
  ];
  for (const kind of KINDS) {
    const c = compose({ kind, airline: 'Test Air', data: { direction: 'in', pairs: [], total: 1, byType: {} } });
    assert.ok(c && typeof c.icon === 'string', `${kind} has an icon`);
    assert.ok(typeof c.headline === 'string', `${kind} composes a headline`);
    assert.notEqual(c.headline, kind, `${kind} fell through to the raw kind name`);
  }
});

test('the tab is registered in the app shell, multiplayer only', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync('src/App.jsx', 'utf8'));
  assert.ok(src.includes("id: 'news'"), 'news is a tab');
  assert.ok(src.includes("NAV_GROUPS.filter((g) => g.id !== 'news')"), 'hidden in solo');
  assert.ok(src.includes('news:        <News />'), 'the tab renders the component');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
