// Deploying a RESERVE onto a route must never be silent.
//
// Five actions null `reserveBase` (ADD_ROUTE, ADD_TAG_ROUTE, ADD_CARGO_ROUTE,
// TRANSFER_ROUTES, REASSIGN_ROUTE). Before this test the signal was uneven:
// the single-leg planner warned, the multi-stop planner and the route "Move"
// menu said nothing at all, so a player could spend a paid-for standby cover
// without ever being told. This locks in (a) the coverage arithmetic the
// warning quotes and (b) the fact that every one of the five pickers carries a
// reserve signal at the click site.
//
//   node --import ./tools/_register-loader.mjs tools/reserve-deploy-warning-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { isReserve, reserveCoverageSummary } from '../src/data/reserve.js';
import ReserveNotice, { ReserveBadge, reserveOptionTag, reserveButtonTag } from '../src/components/ReserveNotice.jsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); fail++; }
}

const RES  = { id: 'res', name: 'Res One', tailNumber: 'N100RS', typeId: 'a320', status: 'idle', reserveBase: 'DFW' };
const IDLE = { id: 'idle', name: 'Idle One', typeId: 'a320', status: 'idle' };

// ── reserveCoverageSummary ───────────────────────────────────────────────────

t('non-reserves return null (callers can render unconditionally)', () => {
  assert.equal(reserveCoverageSummary(IDLE, [IDLE], []), null);
  assert.equal(reserveCoverageSummary(null, [], []), null);
  assert.equal(reserveCoverageSummary({ ...RES, reserveBase: null }, [], []), null);
});

t('counts same-type tails and routes touching the base', () => {
  const fleet = [RES, { id: 'x', typeId: 'a320' }, { id: 'y', typeId: 'a320' }];
  const ops = [
    { id: 'r1', origin: 'DFW', destination: 'ORD', aircraftId: 'x' },
    { id: 'r2', origin: 'LAX', destination: 'DFW', aircraftId: 'x' },
    { id: 'r3', origin: 'DFW', destination: 'SEA', aircraftId: 'y' },
  ];
  const cov = reserveCoverageSummary(RES, fleet, ops);
  assert.deepEqual(cov, { base: 'DFW', tails: 2, routes: 3 });
});

t('ignores routes that never touch the base, and other types', () => {
  const fleet = [RES, { id: 'x', typeId: 'a320' }, { id: 'z', typeId: 'b738' }];
  const ops = [
    { id: 'r1', origin: 'JFK', destination: 'ORD', aircraftId: 'x' },   // misses DFW
    { id: 'r2', origin: 'DFW', destination: 'ORD', aircraftId: 'z' },   // wrong type
  ];
  assert.deepEqual(reserveCoverageSummary(RES, fleet, ops), { base: 'DFW', tails: 0, routes: 0 });
});

t('never counts itself — a reserve does not cover its own routes', () => {
  const ops = [{ id: 'r1', origin: 'DFW', destination: 'ORD', aircraftId: 'res' }];
  assert.deepEqual(reserveCoverageSummary(RES, [RES], ops), { base: 'DFW', tails: 0, routes: 0 });
});

t('retired tails do not inflate the cover being given up', () => {
  const fleet = [RES, { id: 'x', typeId: 'a320', status: 'retired' }];
  const ops = [{ id: 'r1', origin: 'DFW', destination: 'ORD', aircraftId: 'x' }];
  assert.equal(reserveCoverageSummary(RES, fleet, ops).tails, 0);
});

t('a route flown as a cover counts for the tail it covers FOR', () => {
  // While `x` is in the shop its route is flown by another tail; the cover this
  // reserve provides still belongs to x, so it must not be double-counted or lost.
  const fleet = [RES, { id: 'x', typeId: 'a320' }, { id: 'sub', typeId: 'a320' }];
  const ops = [{ id: 'r1', origin: 'DFW', destination: 'ORD', aircraftId: 'sub', coverForAircraftId: 'x' }];
  const cov = reserveCoverageSummary(RES, fleet, ops);
  assert.equal(cov.routes, 1);
  assert.equal(cov.tails, 1);
});

t('multi-stop routes count when the base is an intermediate stop', () => {
  const fleet = [RES, { id: 'x', typeId: 'a320' }];
  const ops = [{ id: 'r1', origin: 'JFK', destination: 'LAX', stops: ['JFK', 'DFW', 'LAX'], aircraftId: 'x' }];
  assert.equal(reserveCoverageSummary(RES, fleet, ops).routes, 1);
});

t('cargo routes count too — a freighter reserve covers freighter lanes', () => {
  const fleet = [RES, { id: 'f', typeId: 'a320' }];
  const cargo = [{ id: 'c1', origin: 'DFW', destination: 'MEM', aircraftId: 'f' }];
  assert.equal(reserveCoverageSummary(RES, fleet, cargo).routes, 1);
});

// ── The labels themselves ────────────────────────────────────────────────────

t('reserveOptionTag / reserveButtonTag are empty for non-reserves', () => {
  assert.equal(reserveOptionTag(IDLE), '');
  assert.equal(reserveButtonTag(IDLE), '');
  assert.match(reserveOptionTag(RES), /ON RESERVE @ DFW/);
  assert.match(reserveButtonTag(RES), /ends standby/);
});

t('ReserveNotice names the tail, the base, and what stops being covered', () => {
  const fleet = [RES, { id: 'x', typeId: 'a320' }, { id: 'y', typeId: 'a320' }];
  const ops = [
    { id: 'r1', origin: 'DFW', destination: 'ORD', aircraftId: 'x' },
    { id: 'r2', origin: 'DFW', destination: 'SEA', aircraftId: 'y' },
  ];
  // renderToString splits adjacent text nodes with <!-- --> markers; strip them
  // so the assertions read the sentence a player actually sees.
  const html = renderToString(React.createElement(ReserveNotice, {
    aircraft: RES, fleet, ops, action: 'Opening this route', typeName: 'A320',
  })).replace(/<!-- -->/g, '');
  assert.match(html, /N100RS/, 'names the tail');
  assert.match(html, /DFW/, 'names the base');
  assert.match(html, /2 other A320s/, 'quantifies the tails it stops covering');
  assert.match(html, /2 routes/, 'quantifies the routes');
  assert.match(html, /opening this route/i, 'names the action being taken');
});

t('ReserveNotice says so when the reserve is covering nothing', () => {
  const html = renderToString(React.createElement(ReserveNotice, {
    aircraft: RES, fleet: [RES], ops: [], action: 'Opening this route', typeName: 'A320',
  }));
  assert.match(html, /nothing to cover/i);
});

t('ReserveNotice and ReserveBadge render nothing for a normal aircraft', () => {
  assert.equal(renderToString(React.createElement(ReserveNotice, { aircraft: IDLE, fleet: [IDLE], ops: [] })), '');
  assert.equal(renderToString(React.createElement(ReserveBadge, { aircraft: IDLE })), '');
  assert.match(renderToString(React.createElement(ReserveBadge, { aircraft: RES })), /DFW/);
});

// ── Coverage guard, derived from the code not from a list ────────────────────
// The first version of this guard hand-listed five picker files and passed
// while the Routes-tab "Open New Route" form — a SIXTH dispatch site, in a file
// that already imported isReserve for its idle/reserve counters — shipped with
// no warning at all. A hand-written inventory only ever proves the author
// remembered. So: find every UI site that dispatches a reserve-spending action
// by reading the source, and require each one to carry a signal.

const SPENDING_ACTIONS = [
  'ADD_ROUTE', 'ADD_TAG_ROUTE', 'ADD_CARGO_ROUTE', 'TRANSFER_ROUTES', 'REASSIGN_ROUTE',
];

// Every file under src/components that dispatches one of them.
function dispatchSites() {
  const dir = path.join(ROOT, 'src/components');
  const hits = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsx') && !f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (SPENDING_ACTIONS.some(a => src.includes(`type: '${a}'`))) hits.push(f);
  }
  return hits.sort();
}

const SITES = dispatchSites();

t('the deploy surface is the six pickers we know about', () => {
  // Not a rubber stamp: if a seventh way to put a plane on a route appears,
  // this fails and whoever added it has to wire the warning and update the list.
  assert.deepEqual(SITES, [
    'CargoRoutePlanner.jsx',
    'Fleet.jsx',
    'ReassignRouteButton.jsx',
    'RoutePlanner.jsx',
    'Routes.jsx',
    'TagRoutePlanner.jsx',
  ]);
});

for (const file of SITES) {
  t(`${file} warns before it spends a reserve`, () => {
    const src = read(path.join('src/components', file));
    // Importing isReserve for an unrelated counter is NOT a warning — the
    // Routes.jsx miss looked exactly like that. Require a real surface.
    assert.match(src, /ReserveNotice|ReserveBadge|reserveOptionTag|reserveButtonTag/,
      `${file} dispatches a reserve-spending action but renders no reserve warning`);
  });
}

t('every reducer action that clears reserveBase has a picker that warns', () => {
  // If this count grows, a new way to spend a reserve has appeared in the
  // engine — add its picker to the list above rather than muting this.
  const reducer = read('packages/engine/src/reducer.mjs');
  const clears = (reducer.match(/reserveBase: null/g) ?? []).length;
  assert.equal(clears, 8,
    `expected 8 reserveBase-clearing sites in the reducer, found ${clears}`);
});

console.log(`\nreserve-deploy-warning-test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
