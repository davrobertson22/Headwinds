// Server-renders the REAL Operations, Route Detail and Routes screens with
// catering contracts in the save — no mocks, no isolated helpers.
//
// The engine suite (tools/catering-contracts-test.mjs) proves the model; this
// one proves the screens quote the engine's numbers, that a capped route SAYS
// it is capped wherever its catering is chosen, and that every route preview
// in src/components carries the contract (previews must agree with the tick).
//
//   node --import ./tools/_register-loader.mjs tools/catering-contracts-ui-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { getAirport } from '../src/data/airports.js';
import { referencePrice, stateCateringCapReport } from '../src/utils/simulation.js';
import {
  CATERING_SUPPLIERS, makeCateringContract, weeksToNextReprice, CATERING_SUPPLIER_MAP,
} from '../src/data/cateringContracts.js';

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
    if (out && typeof out.then === 'function') throw new Error('test bodies must be synchronous');
    console.log(`  ✓ ${name}`); passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`);
    failed++;
  }
}

console.log('\nCatering contracts — the screens render and quote the engine\n');

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter && t.seats >= 150 && t.seats <= 200).sort((a, b) => b.range - a.range)[0];
const [P, Q] = ['JFK', 'LAX'].filter(c => getAirport(c));
const FARE = Math.round(referencePrice(P, Q));
const YEAR = 2, WEEK = 20, ABS = (YEAR - 1) * 52 + WEEK;

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Operations  = (await import('../src/components/Operations.jsx')).default;
const RouteDetail = (await import('../src/components/RouteDetail.jsx')).default;
const Routes      = (await import('../src/components/Routes.jsx')).default;
const { defaultAncillaries } = await import('../src/data/ancillaries.js');

function seed(extra = {}) {
  const save = {
    ...freshState(),
    phase: 'playing', week: WEEK, year: YEAR, hub: P, cash: 400_000_000,
    gates: { [P]: 8, [Q]: 8 },
    ancillaries: defaultAncillaries(),
    fleet: [{ id: 'ac1', typeId: jet.id, name: 'One', tailNumber: 'N1TEST', status: 'assigned',
      ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } }],
    routes: [{ id: 'r1', origin: P, destination: Q, stops: [P, Q], aircraftId: 'ac1',
      weeklyFrequency: 7, weeksOpen: 40, hub: P, ticketPrice: FARE, cateringLevel: 'full' }],
    routeCatering: { [[P, Q].sort().join('-')]: 'full' },
    ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!--.*?-->/g, '');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const withContract = (id, years = 3) => { const c = makeCateringContract(id, years, ABS); return { [c.id]: c }; };

console.log('── Operations: the book and your contracts ─────────────');

test('with no contract, the section says every airport pays the standard rate, and lists the whole book', () => {
  seed();
  const t = text(render(React.createElement(Operations)));
  assert.ok(t.includes('Catering Contracts'), 'section heading');
  assert.ok(t.includes('None — every airport pays the standard catering rate.'), 'empty state stated plainly');
  for (const s of CATERING_SUPPLIERS) assert.ok(t.includes(s.name), `${s.name} is in the book`);
  assert.ok(t.includes(`re-prices in ${weeksToNextReprice(ABS)} weeks`), 'when the book next moves');
});

test('a small airline sees the surcharge it would pay, and where it does not fly yet', () => {
  seed();
  const t = text(render(React.createElement(Operations)));
  assert.match(t, /under their [\d,]+ minimum, \+\d+% surcharge/, 'the volume surcharge is quoted, not hidden');
  assert.ok(t.includes("you don't fly here yet"), 'suppliers covering nowhere you fly say so');
});

test('a signed contract shows its terms and a priced Break; a same-coverage rival is refused on screen', () => {
  seed({ cateringContracts: withContract('bigsky') });
  const html = render(React.createElement(Operations));
  const t = text(html);
  assert.ok(t.includes('Big Sky Snacks · US'), 'the contract is listed with its coverage');
  assert.match(t, /\d+ weeks left/, 'term remaining');
  assert.ok(t.includes('up to Partial Service'), 'its cap is stated');
  assert.ok(/Break — \$/.test(t), 'break is priced before you click');
  assert.ok(t.includes('Signed.'), 'the book marks the signed supplier');
});

console.log('\n── Route screens: the cap is told, not hidden ──────────');

test('Route Detail warns when the caterer cannot deliver the chosen level, naming the caterer and airport', () => {
  seed({ cateringContracts: withContract('bigsky') });
  const t = text(render(React.createElement(RouteDetail, { origin: P, dest: Q, onBack: () => {} })));
  assert.ok(t.includes("can't deliver Full Service"), 'the cap is stated');
  assert.ok(t.includes('Big Sky Snacks'), 'by name');
  assert.ok(t.includes('served — and charged — as Partial Service'), 'and what the route actually gets');
});

test('no contract, or one that can deliver the level, shows no warning', () => {
  seed();
  assert.ok(!text(render(React.createElement(RouteDetail, { origin: P, dest: Q, onBack: () => {} }))).includes("can't deliver"));
  seed({ cateringContracts: withContract('orbital') });
  assert.ok(!text(render(React.createElement(RouteDetail, { origin: P, dest: Q, onBack: () => {} }))).includes("can't deliver"));
});

test('a hub whose own kitchen is cheaper is not capped by a budget caterer at that end', () => {
  // Hubs at BOTH ends at a tier whose kitchen beats even Big Sky's rate would
  // mean no cap at all; Big Sky is cheap enough to cook at a T1, so use the
  // real resolution rather than assume — the warning must match the tick.
  seed({ cateringContracts: withContract('bigsky'), hubs: { [P]: { tier: 3 }, [Q]: { tier: 3 } } });
  const t = text(render(React.createElement(RouteDetail, { origin: P, dest: Q, onBack: () => {} })));
  const rep = stateCateringCapReport(JSON.parse(store.get('bbae_save_v2')), P, Q, 'full');
  assert.equal(t.includes("can't deliver"), rep != null, 'the screen shows a warning exactly when the engine reports a cap');
});

test('every route-level catering picker is handed the cap report', () => {
  // The Routes page only mounts its pickers inside an expanded row, which SSR
  // does not open, and the Route Planner's only once an origin and destination
  // are picked — so guard the call sites directly. The one exemption is the
  // airline-wide DEFAULT on Operations: it belongs to no route, so no caterer
  // can cap it.
  const dir = fileURLToPath(new URL('../src/components/', import.meta.url));
  const missing = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsx'))) {
    if (file === 'CateringSelector.jsx') continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const re = /<CateringSelector\b[\s\S]*?\/>/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[0].includes('SET_DEFAULT_CATERING')) continue;
      if (!m[0].includes('capNote=')) missing.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(missing, [], 'a catering picker that is not told about the cap lets a player pick a level\n'
    + '      the tick will not deliver, with nothing on screen saying so:\n      ' + missing.join('\n      '));
});

console.log('\n── Every route preview carries the contract ────────────');

test('no screen simulates a route with the station fields but without stateCateringFields', () => {
  const dir = fileURLToPath(new URL('../src/components/', import.meta.url));
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsx') || f.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\bsimulate(Route|TagRoute)\s*\(/.test(line)) return;
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/^\s*import\b/.test(line) || /from '/.test(line)) return;
      const window = lines.slice(i, i + 6).join('\n');
      if (window.includes('...stateGroundHandlingFields') && !window.includes('stateCateringFields')) {
        offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'These call sites cost a route without its catering contract, so a contracted airline is\n'
    + '      quoted the standard catering rate (and the uncapped level) the tick will not charge.\n'
    + '      Spread ...stateCateringFields(state, route) LAST into the route object.\n      '
    + offenders.join('\n      '));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
