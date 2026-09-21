// Server-renders the REAL airport page and Finance page with a ground handling
// station in the save — no mocks, no isolated helpers.
//
// The engine suite (tools/ground-station-test.mjs) proves the model; this one
// proves the screens quote the SAME numbers the reducer will charge, and that
// every preview in src/components carries the station factor so a route
// forecast is costed the way the tick will cost it (CLAUDE.md: previews must
// agree with the tick).
//
//   node --import ./tools/_register-loader.mjs tools/ground-station-ui-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { referencePrice, formatMoney } from '../packages/engine/src/utils/simulation.js';
import {
  GROUND_STATION_LEVELS, stationLevelDef, makeStation, stationCloseRefund, stationUpgradeCapex,
} from '../packages/engine/src/data/groundStation.js';

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
    if (out && typeof out.then === 'function') {
      throw new Error('test bodies must be synchronous — an async body is never awaited here');
    }
    console.log(`  ✓ ${name}`); passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`);
    failed++;
  }
}

console.log('\nGround handling stations — the screens render and quote the engine\n');

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter && t.seats >= 150 && t.seats <= 200).sort((a, b) => b.range - a.range)[0];
const [P, Q] = ['JFK', 'LAX'].filter(c => getAirport(c));
const FARE = Math.round(referencePrice(P, Q));

const { GameProvider, freshState, gameReducer } = await import('../src/store/GameContext.jsx');
const AirportDetail = (await import('../src/components/AirportDetail.jsx')).default;
const Finance       = (await import('../src/components/Finance.jsx')).default;
const { defaultAncillaries } = await import('../packages/engine/src/data/ancillaries.js');

function seed(extra = {}) {
  const save = {
    ...freshState(),
    phase: 'playing', week: 20, year: 2, hub: P, cash: 400_000_000,
    gates: { [P]: 8, [Q]: 8 },
    ancillaries: defaultAncillaries(),
    fleet: [
      { id: 'ac1', typeId: jet.id, name: 'One', tailNumber: 'N1TEST', status: 'assigned',
        ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } },
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

// React SSR separates adjacent text nodes with `<!-- -->`; strip them so an
// assertion can read the sentence the player reads.
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!--.*?-->/g, '');
const airport = (code) => render(React.createElement(AirportDetail, { code, onBack: () => {} }));
const OPEN = (code, level) => ({ ...makeStation(code, level, 0), buildWeeksLeft: 0, openedWeek: 0 });

console.log('── Airport detail: building ────────────────────────────');

test('with no station, every level is offered at the engine price with its capacity and gate need', () => {
  seed();
  const html = airport(P);
  assert.ok(html.includes('Ground Handling'), 'the card is there');
  for (const def of Object.values(GROUND_STATION_LEVELS)) {
    assert.ok(html.includes(def.name), `${def.name} is listed`);
    assert.ok(html.includes(formatMoney(def.capex)), `${def.name} capex is the engine constant`);
    assert.ok(html.includes(`${formatMoney(def.weeklyOpex)}/wk`), `${def.name} opex is quoted`);
    assert.ok(html.includes(`${def.gatesRequired} gates`), `${def.name} gate requirement is stated`);
  }
  assert.ok(html.includes('7</strong> departures a week'), 'the airport\'s own departure count is on the card');
});

test('a level the player cannot afford or gate is refused on screen with the engine\'s reason', () => {
  seed({ gates: { [P]: 2, [Q]: 2 } });
  const html = airport(P);
  assert.ok(html.includes('Needs 3 gates'), 'level 2 names the gate shortfall');
  assert.ok(html.includes('Needs 4 gates'), 'level 3 too');
  seed({ cash: 1_000 });
  const broke = airport(P);
  assert.ok(broke.includes('in cash'), 'the cash shortfall is stated, not left as a dead button');
});

test('after a tick, the card quotes what handling here actually cost and the saving each level would make', () => {
  const save = seed();
  const ticked = gameReducer(save, { type: 'ADVANCE_WEEK' });
  store.set('bbae_save_v2', JSON.stringify(ticked));
  const html = airport(P);
  assert.ok(html.includes('to handle them last week'), 'last week\'s handling bill is on the card');
  assert.ok(html.includes('saves ≈'), 'and each level shows its projected saving');
});

console.log('\n── Airport detail: a built station ─────────────────────');

test('a station under construction shows as building and hides the build ladder', () => {
  seed({ groundStations: { [P]: makeStation(P, 1, 53) } });
  const html = airport(P);
  assert.ok(html.includes('Building Ramp Station'), 'construction state is visible');
  assert.ok(!html.includes('Build —'), 'no second station offered');
  assert.ok(html.includes('Close refund'), 'the (halved) refund is shown');
  assert.ok(html.includes(formatMoney(stationCloseRefund(makeStation(P, 1, 53)))), 'at the engine\'s number');
});

test('an open station reports its coverage, offers the in-place upgrade at the engine price, and the close', () => {
  seed({ groundStations: { [P]: OPEN(P, 1) } });
  const html = airport(P);
  assert.ok(html.includes('Your crews handle 100% of your 7 weekly departures'), 'coverage in plain words');
  assert.ok(html.includes(`Upgrade to ${stationLevelDef(2).name}`), 'upgrade offered');
  assert.ok(html.includes(formatMoney(stationUpgradeCapex(1, 2))), 'at the upgrade price, not the build price');
  assert.ok(html.includes('Close station'));
  assert.ok(html.includes(formatMoney(stationCloseRefund(OPEN(P, 1)))));
});

test('a station that has outgrown its level says so', () => {
  // The save loader clamps a route's frequency to what its tail can fly, so
  // exceed the station with MANY tails rather than one absurd frequency:
  // 2 × capacity ÷ 7 daily rotations.
  const cap = stationLevelDef(1).weeklyDepartures;
  const n = Math.ceil((cap * 2) / 7);
  const fleet = [], routes = [];
  for (let i = 1; i <= n; i++) {
    fleet.push({ id: `ac${i}`, typeId: jet.id, name: `Tail ${i}`, tailNumber: `N${i}TEST`, status: 'assigned',
      ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } });
    routes.push({ id: `r${i}`, origin: P, destination: Q, stops: [P, Q], aircraftId: `ac${i}`,
      weeklyFrequency: 7, weeksOpen: 40, hub: P, ticketPrice: FARE, cateringLevel: 'full' });
  }
  seed({ groundStations: { [P]: OPEN(P, 1) }, fleet, routes, gates: { [P]: 60, [Q]: 60 } });
  const html = airport(P);
  const share = Math.round(cap / (n * 7) * 100);
  assert.ok(html.includes(`handle ${share}% of your ${n * 7} weekly departures`), `pro-rata coverage is shown (${share}%)`);
  assert.ok(html.includes('outgrown this station'), 'and the upgrade is suggested');
});

test('a top-level station offers no upgrade', () => {
  seed({ groundStations: { [P]: OPEN(P, 3) } });
  const html = airport(P);
  assert.ok(!html.includes('Upgrade to'), 'nothing above Hub Operation');
  assert.ok(html.includes('capacity unlimited'));
});

console.log('\n── Finance ─────────────────────────────────────────────');

test('the Finance page names the station opex and the saving once a week has run', () => {
  const save = seed({ groundStations: { [P]: OPEN(P, 1) } });
  const ticked = gameReducer(save, { type: 'ADVANCE_WEEK' });
  assert.ok(ticked.lastReport.totalGroundStationCosts > 0, 'fixture: the tick billed the station');
  assert.ok(ticked.lastReport.totalGroundStationSavings > 0, 'fixture: and it saved something');
  store.set('bbae_save_v2', JSON.stringify(ticked));
  const html = render(React.createElement(Finance));
  assert.ok(html.includes('Ground Handling Stations'), 'the opex sub-section is present');
  assert.ok(html.includes(formatMoney(-ticked.lastReport.totalGroundStationCosts)), 'quoting the report\'s opex');
  assert.ok(html.includes(`Self-handled at ${P}`), 'the saving line names the station');
  // The Finance page costs the COMING week (projectWeek), so the saving it
  // prints is a forecast, not last week's figure — assert the shape, not the number.
  assert.match(html, /saved \$[\d.]+[KM]? vs the contract rate/, 'and quotes a saving against the contract rate');
});

test('without a station the Finance page shows neither line', () => {
  const save = seed();
  const ticked = gameReducer(save, { type: 'ADVANCE_WEEK' });
  store.set('bbae_save_v2', JSON.stringify(ticked));
  const html = render(React.createElement(Finance));
  assert.ok(!html.includes('Ground Handling Stations'));
  assert.ok(!html.includes('Self-handled at'));
});

console.log('\n── Every route preview carries the station factor ──────');

test('no screen simulates a route with stateLoungeFields but without stateGroundHandlingFields', () => {
  const dir = fileURLToPath(new URL('../src/components/', import.meta.url));
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsx') || f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/\bsimulate(Route|TagRoute)\s*\(/.test(line)) return;
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/^\s*import\b/.test(line) || /from '/.test(line)) return;
      const window = lines.slice(i, i + 6).join('\n');
      if (window.includes('...stateLoungeFields') && !window.includes('stateGroundHandlingFields')) {
        offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'These call sites cost a route without the station factor, so a self-handled hub is\n'
    + '      quoted the contract handling rate the tick will not charge. Spread\n'
    + '      ...stateGroundHandlingFields(state, origin, destination) into the route object.\n      '
    + offenders.join('\n      '));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
