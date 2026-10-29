// Server-renders the REAL Partnerships, Reputation and Route Detail screens with
// travel partners in the save — no mocks, no isolated helpers.
//
// The engine suite (tools/travel-partners-test.mjs) proves the model; this one
// proves the screens show the engine's numbers, that a world without the
// feature says so, and that every hand-built offer in src/components carries
// the partner lift (previews must agree with the tick).
//
//   node --import ./tools/_register-loader.mjs tools/travel-partners-ui-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AIRCRAFT_TYPES } from '../src/data/aircraft.js';
import { referencePrice } from '../src/utils/simulation.js';
import {
  TRAVEL_PARTNERS, makeTravelPartnerContract, travelPartnerListFee,
} from '../src/data/travelPartners.js';
import { TAB_LABELS, TAB_GROUP } from '../src/navPath.js';

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

console.log('\nTravel partnerships — the screens\n');

const jet = AIRCRAFT_TYPES.filter(t => !t.freighter && t.seats >= 150 && t.seats <= 200).sort((a, b) => b.range - a.range)[0];
const P = 'JFK', Q = 'MCO';
const FARE = Math.round(referencePrice(P, Q));
const YEAR = 2, WEEK = 3, ABS = (YEAR - 1) * 52 + WEEK;   // January: cruise season in the Caribbean

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Partnerships = (await import('../src/components/Partnerships.jsx')).default;
const Reputation   = (await import('../src/components/Reputation.jsx')).default;
const RouteDetail  = (await import('../src/components/RouteDetail.jsx')).default;
const { defaultAncillaries } = await import('../src/data/ancillaries.js');

function seed(extra = {}) {
  const save = {
    ...freshState(),
    phase: 'playing', week: WEEK, year: YEAR, hub: P, cash: 400_000_000,
    gates: { [P]: 8, [Q]: 8 }, ancillaries: defaultAncillaries(),
    fleet: [{ id: 'ac1', typeId: jet.id, name: 'One', tailNumber: 'N1TEST', status: 'assigned',
      ageWeeks: 52, ownershipType: 'owned', config: { economy: jet.seats } }],
    routes: [{ id: 'r1', origin: P, destination: Q, stops: [P, Q], aircraftId: 'ac1',
      weeklyFrequency: 7, weeksOpen: 40, hub: P, ticketPrice: FARE }],
    partnershipsWorld: true,
    lastReport: { reputationScore: 58, routeResults: [{ routeId: 'r1', passengers: 1200, qualityScore: 61,
      segmentPax: { leisure: 1000, business: 200 } }] },
    ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replace(/<!--.*?-->/g, '');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const signed = (id, extra = {}) => ({ [id]: { ...makeTravelPartnerContract(id, ABS - 20), instalmentsPaid: 1, graceUntil: 0, ...extra } });

test('a world without the feature says so instead of showing an empty book', () => {
  seed({ partnershipsWorld: undefined });
  const t = text(render(React.createElement(Partnerships)));
  assert.match(t, /created before travel partnerships/);
  assert.ok(!t.includes('Azure Horizon'));
});

test('the book lists all 16 partners by type, with this window’s price', () => {
  seed();
  const html = render(React.createElement(Partnerships));
  const t = text(html);
  for (const p of TRAVEL_PARTNERS) assert.ok(t.includes(p.name), `${p.name} in the book`);
  for (const h of ['Cruise lines', 'Tour operators', 'Hotel chains', 'Ride share']) assert.ok(t.includes(h), h);
  assert.ok(t.includes('None yet'), 'no partners yet');
  const fee = travelPartnerListFee('zipway', ABS);
  assert.ok(t.includes(`$${(fee / 1e6).toFixed(2)}M/yr`), `Zipway at ${fee}`);
});

test('the book shows last week’s figure against each target', () => {
  seed();
  const t = text(render(React.createElement(Partnerships)));
  // Azure Horizon: 1,000 leisure pax arrived at MCO (one port end) last week.
  const az = t.slice(t.indexOf('Azure Horizon Cruises'), t.indexOf('Northern Passage Line'));
  assert.match(az, /1,000 \/ 1,500/);
  assert.match(az, /settle around \d+/);
});

test('reputation-gated partners say why they can’t be signed', () => {
  seed();
  const t = text(render(React.createElement(Partnerships)));
  assert.match(t, /Aldgate Hotels & Resorts only signs airlines with a reputation of 60\+ \(you: 58\)/);
});

test('a signed partner shows happiness, mood, the lift it gives now and the renewal price', () => {
  seed({ travelPartners: signed('azurehorizon', { happiness: 66 }) });
  const html = render(React.createElement(Partnerships));
  const t = text(html);
  assert.ok(html.includes('data-tp-active="azurehorizon"'));
  assert.match(t, /Content/);
  assert.match(t, /Lift now: \+7\.0% leisure/);
  assert.match(t, /Renewal at today's happiness: \$[\d.]+[MK]\/yr \(content\)/);
  assert.match(t, /Will auto-renew/);
});

test('a sour partner shows the faded lift and the walk-out countdown', () => {
  seed({ travelPartners: signed('azurehorizon', { happiness: 12, lowWeeks: 2 }) });
  const t = text(render(React.createElement(Partnerships)));
  assert.match(t, /Walking out/);
  assert.match(t, /none — too unhappy to promote you/);
  assert.match(t, /Below 15 for 2 weeks — they walk at 4/);
  assert.match(t, /Won't renew at this happiness/);
});

test('a lost partner is locked away in the book', () => {
  seed({ travelPartnerMemory: { aldgate: { cooldownUntil: ABS + 200, rejoinHappiness: 40 } } });
  const t = text(render(React.createElement(Partnerships)));
  assert.match(t, new RegExp(`Won't work with you until week ${ABS + 200}`));
});

test('Reputation shows the Partners term only when you have partners', () => {
  seed();
  assert.ok(!text(render(React.createElement(Reputation))).includes('Travel Partners'));
  seed({ travelPartners: signed('aldgate', { happiness: 0 }) });
  const t = text(render(React.createElement(Reputation)));
  assert.match(t, /Travel Partners −3\.0 pts/);
});

test('Route Detail names the partner lifting the route', () => {
  seed({ travelPartners: signed('azurehorizon', { happiness: 70 }) });
  const html = render(React.createElement(RouteDetail, { origin: P, dest: Q, onBack: () => {} }));
  assert.ok(html.includes('data-route-partner="azurehorizon"'));
  assert.match(text(html), /Azure Horizon Cruises .*\+7\.0% leisure/);
});

test('nav: Company ▸ Partnerships', () => {
  assert.equal(TAB_LABELS.partners, 'Partnerships');
  assert.equal(TAB_GROUP.partners, 'Company');
});

test('every hand-built offer in src/components that carries lounges carries travel partners too', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, '../src/components');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsx'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const lounge = (src.match(/loungeAppeal:\s*stateLoungeFields/g) ?? []).length;
    const travel = (src.match(/stateTravelPartnerFields\(/g) ?? []).length;
    if (lounge > travel) offenders.push(`${f}: ${lounge} lounge offers, ${travel} with partners`);
  }
  assert.deepEqual(offenders, []);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
