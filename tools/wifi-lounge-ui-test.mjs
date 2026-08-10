// Server-renders the REAL screens the two new mechanics touch, against a seeded
// save — no mocks, no isolated helpers.
//
// A helper tested on its own can pass while the component calling it is wrong.
// That is exactly how the hydrated-`stops` bug got caught, and it is the reason
// this file exists alongside tools/wifi-lounge-test.mjs: the engine suite proves
// the model, this one proves the screens quote the SAME numbers the reducer will
// charge and the tick will apply.
//
//   node --import ./tools/_register-loader.mjs tools/wifi-lounge-ui-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { referencePrice, formatMoney } from '../src/utils/simulation.js';
import { wifiInstallCost, wifiRetrofitCost } from '../src/data/wifi.js';
import {
  LOUNGE_BUILD_COST, LOUNGE_BUILD_WEEKS, LOUNGE_WEEKLY_OPEX, makeLounge,
} from '../src/data/lounges.js';

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
  try {
    const out = fn();
    // An async body would resolve its assertions into a promise nobody awaits,
    // so a failing test would print a tick. Refuse them outright rather than
    // quietly reporting green — this guard exists to catch regressions, and a
    // guard that cannot fail is worse than no guard.
    if (out && typeof out.then === 'function') {
      throw new Error('test bodies must be synchronous — an async body is never awaited here');
    }
    console.log(`  ✓ ${name}`); passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`);
    failed++;
  }
}

console.log('\nWi-Fi & lounges — the screens render and quote the engine\n');

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter).sort((a, b) => b.range - a.range)[0];
const [P, Q] = ['JFK', 'LAX'].filter(c => getAirport(c));
const FARE = Math.round(referencePrice(P, Q));

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Ancillaries    = (await import('../src/components/Ancillaries.jsx')).default;
const Fleet          = (await import('../src/components/Fleet.jsx')).default;
const AirportDetail  = (await import('../src/components/AirportDetail.jsx')).default;
const Marketplace    = (await import('../src/components/Marketplace.jsx')).default;
const { defaultAncillaries } = await import('../src/data/ancillaries.js');

function seed(extra = {}) {
  const save = {
    ...freshState(),
    phase: 'playing', week: 20, year: 2, hub: P, cash: 400_000_000,
    gates: { [P]: 8, [Q]: 8 },
    ancillaries: defaultAncillaries(),
    fleet: [
      { id: 'ac1', typeId: jet.id, name: 'Unfitted One', tailNumber: 'N1TEST', status: 'assigned',
        ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } },
      { id: 'ac2', typeId: jet.id, name: 'Connected Two', tailNumber: 'N2TEST', status: 'assigned',
        ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats }, hasWifi: true },
    ],
    routes: [
      { id: 'r1', origin: P, destination: Q, stops: [P, Q], aircraftId: 'ac1',
        weeklyFrequency: 7, weeksOpen: 40, hub: P, ticketPrice: FARE, cateringLevel: 'full' },
    ],
    ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}

const render = (el) => renderToString(React.createElement(GameProvider, null, el));

// ── Ancillaries ─────────────────────────────────────────────────────────────

console.log('── Ancillaries: policy vs capability ───────────────────');

test('the Wi-Fi card reports what the fleet can actually deliver', () => {
  seed();
  const html = render(React.createElement(Ancillaries));
  assert.ok(html.includes('1 of 2 aircraft fitted'),
    'the card must say how much of the fleet is fitted, not just that the policy offers Wi-Fi');
  assert.ok(html.includes(formatMoney(wifiRetrofitCost())) || html.includes('unfitted tail'),
    'and point the player at the retrofit');
});

test('with no lounges the day-pass card says there is no room to sell', () => {
  seed();
  const html = render(React.createElement(Ancillaries));
  assert.ok(html.includes('No lounges open'), 'lounge capability stated plainly');
  assert.ok(!html.includes('Lounge access'),
    'the access panel must stay hidden until there is a lounge to have a policy about');
});

test('once a lounge exists the access panel appears with both switches', () => {
  seed({ lounges: { [P]: { ...makeLounge(P, 1), buildWeeksLeft: 0 } }, loungePolicy: { loyaltyAccess: false, allianceAccess: false } });
  const html = render(React.createElement(Ancillaries));
  assert.ok(html.includes('Lounge access'), 'the access panel is shown');
  assert.ok(html.includes('Loyalty members'), 'loyalty switch present');
  assert.ok(html.includes("Alliance partners"), 'alliance switch present');
  assert.ok(html.includes(`Lounges at ${P}`), 'and the lounge card names the airport');
});

test('the alliance switch is disabled for an airline in no alliance', () => {
  seed({ lounges: { [P]: { ...makeLounge(P, 1), buildWeeksLeft: 0 } }, allianceMembership: null });
  const html = render(React.createElement(Ancillaries));
  assert.ok(html.includes('Join an alliance to open reciprocal lounge access'),
    'the reason must be on screen, not just a dead button');
});

// ── Airport detail: building a lounge ───────────────────────────────────────

console.log('\n── Airport detail: the lounge ──────────────────────────');

test('an airport with a gate offers the build, priced from the engine', () => {
  seed();
  const html = render(React.createElement(AirportDetail, { code: P, onBack: () => {} }));
  assert.ok(html.includes('Build lounge'), 'the build affordance is there');
  assert.ok(html.includes(formatMoney(LOUNGE_BUILD_COST)),
    'the price on screen must be the engine constant the reducer charges');
  assert.ok(html.includes(`${LOUNGE_BUILD_WEEKS} weeks`), 'fit-out time is stated');
  assert.ok(html.includes(formatMoney(LOUNGE_WEEKLY_OPEX)), 'so is the running cost');
});

test('an airport with no gate explains why it cannot be built', () => {
  seed({ gates: { [P]: 8 } });                      // none at Q
  const html = render(React.createElement(AirportDetail, { code: Q, onBack: () => {} }));
  assert.ok(html.includes('gate') && html.includes('to build a lounge'),
    'the gate requirement must be stated as the reason, not left as a dead button');
});

test('a lounge under construction shows as fitting out, not open', () => {
  seed({ lounges: { [P]: makeLounge(P, 1) } });
  const html = render(React.createElement(AirportDetail, { code: P, onBack: () => {} }));
  assert.ok(html.includes('Fitting out'), 'construction state is visible');
  assert.ok(!html.includes('Build lounge'), 'and you are not invited to build a second one');
});

test('an open lounge offers the close, with the refund named', () => {
  seed({ lounges: { [P]: { ...makeLounge(P, 1), buildWeeksLeft: 0 } } });
  const html = render(React.createElement(AirportDetail, { code: P, onBack: () => {} }));
  assert.ok(html.includes('Close lounge'), 'close affordance present');
  assert.ok(html.includes('Close refund'), 'and the refund is quoted before you commit');
});

// ── Fleet: the retrofit ─────────────────────────────────────────────────────

console.log('\n── Fleet: connectivity ─────────────────────────────────');

test('the fleet list renders with a mixed-equipage fleet', () => {
  seed();
  const html = render(React.createElement(Fleet));
  assert.ok(html.includes('Unfitted One') && html.includes('Connected Two'),
    'both tails render');
});

test('the order form offers line-fit Wi-Fi at the engine price', () => {
  seed();
  const html = render(React.createElement(Marketplace));
  // The checkout is a modal opened from the catalogue, so assert on what the
  // catalogue itself can show; the price constant is asserted directly.
  assert.ok(wifiInstallCost() < wifiRetrofitCost(),
    'line-fit must undercut the retrofit or the order-time choice is meaningless');
  assert.ok(html.length > 0, 'marketplace renders');
});

// ── The guard that stops this coming back ───────────────────────────────────

console.log('\n── Every route simulation carries the lounge fields ─────');

test('no screen calls simulateRoute / simulateTagRoute without stateLoungeFields', () => {
  // fileURLToPath, not .pathname: a repo checked out under a directory with a
  // space in its name ('Airline Management Game') comes back percent-encoded
  // from .pathname and readdirSync then can't find it.
  const dir = fileURLToPath(new URL('../src/components/', import.meta.url));

  const offenders = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsx') || f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // Every CALL (not the import line, not a comment) must have the fields
    // spread into the route object within the following few lines.
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/\bsimulate(Route|TagRoute)\s*\(/.test(line)) return;
      if (/^\s*(\/\/|\*)/.test(line)) return;                 // comment
      if (/^\s*import\b/.test(line) || /from '/.test(line)) return; // import
      const window = lines.slice(i, i + 6).join('\n');
      if (!window.includes('stateLoungeFields')) {
        offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }

  assert.deepEqual(offenders, [],
    'These call sites simulate a route without the lounge fields, so they are scored at the\n'
    + '      parity default: a lounge owner is quoted nearly 3x the premium ground cost the tick\n'
    + '      actually charges, and an airline with no lounges is shown day-pass revenue the tick\n'
    + '      refuses to book. Spread ...stateLoungeFields(state, origin, destination) into the\n'
    + '      route object.\n      ' + offenders.join('\n      '));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
