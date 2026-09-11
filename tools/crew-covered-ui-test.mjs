// The staffing panel must distinguish "short and doing nothing about it" from
// "short, but the people are already in training".
//
// Reported by Mariaklinga (Discord, 2026-09-11): "give us the option to turn off
// the red 'you need new staff' text when staff are in training I now have 59
// pilots instead of the 15 needed". Two defects fed each other:
//
//   1. `crewShortfall` reads crewAvailable only, so the banner and the card line
//      were identical whether the player had hired nobody or four times what
//      they needed — max-severity red either way, with the engine's own
//      recommendation (crewHiresNeeded, which IS pipeline-aware) sitting at 0.
//   2. The preset row fell through `gapBodies || bookGap || perUnit`, so a
//      covered group still offered a full narrowbody's crew as if it were the
//      remedy the red text was demanding. Six clicks is 54 pilots.
//
// The engine is deliberately NOT changed here: a trainee cannot fly, so the
// on-time penalty stays exactly where it was. What changes is that the screen
// stops demanding a hire it has already been given.
//
//   node --import ./tools/_register-loader.mjs tools/crew-covered-ui-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAircraftType } from '../src/data/aircraft.js';
import {
  DEFAULT_LABOR_STATE, seedCrewFor, crewRequired, crewShortfall, CREW_PER_UNIT,
} from '../src/data/labor.js';

const store = new Map();
globalThis.window = globalThis.window ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), clear: () => store.clear(),
};

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`); passed++;
  } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Operations = (await import('../src/components/Operations.jsx')).default;
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');

const NB = getAircraftType('b737800');
const typeOf = (a) => getAircraftType(a.typeId);
const FLEET = Array.from({ length: 4 }, (_, i) => ({
  id: `ac${i}`, typeId: NB.id, name: `Tail ${i}`, tailNumber: `N${i}TEST`,
  status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: NB.seats },
}));
const ABS_WEEK = (2 - 1) * 52 + 20;

function seed(extra = {}) {
  store.set('bbae_save_v2', JSON.stringify({
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 400_000_000,
    gates: { JFK: 8 }, fleet: FLEET, routes: [], ...extra,
  }));
}

// One card's worth of HTML, sliced out by its own per-narrowbody marker.
function cardFor(html, group) {
  const from = html.indexOf(`≈${CREW_PER_UNIT[group]} per narrowbody`);
  assert.ok(from > -1, `no staffing card rendered for ${group}`);
  const rest = html.slice(from);
  const to = rest.indexOf('Pay rate');
  return to > -1 ? rest.slice(0, to) : rest;
}

// A group short on the line, with the shortfall already in the training queue.
function covered(group) {
  const base = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const need = crewRequired(group, FLEET, typeOf);
  return { ...base, [group]: { ...base[group], headcount: 1,
    pipeline: [{ count: need, readyAbsWeek: ABS_WEEK + 6 }] } };
}

// The same shortfall with nobody hired against it.
function uncovered(group) {
  const base = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  return { ...base, [group]: { ...base[group], headcount: 1, pipeline: [] } };
}

console.log('\n── Operations: a shortfall already covered by training ─────────');

test('the shortfall itself is unchanged — a trainee still cannot fly', () => {
  // The fix is a display fix. If this ever fails the engine has been softened,
  // which is not what was asked for: the operation really is short-handed until
  // the course finishes, and the on-time penalty must still bite.
  const gap = crewShortfall(covered('pilots'), FLEET, typeOf);
  assert.ok(gap.byGroup.pilots > 0, 'crew in training must not count as available');
  assert.ok(gap.severe, 'a covered shortfall this size is still severe to the operation');
});

test('a covered shortfall is not dressed as an emergency', () => {
  seed({ crewPipeline: true, labor: covered('pilots') });
  const html = render(React.createElement(Operations));
  const card = cardFor(html, 'pilots');

  assert.ok(!/Severely understaffed/.test(html),
    'the banner must not scream at an airline that has already hired the people');
  assert.ok(!/Severely short/.test(card), 'the card must not scream either');
  assert.ok(!/Hire before it gets worse/.test(card),
    'telling a player to hire more when the engine wants zero is how 15 pilots became 59');

  // It must still be honest about the operational cost of the wait.
  assert.ok(/in training/.test(card), 'the training queue must stay visible');
  assert.ok(/no further hiring needed/i.test(card),
    'the card must say the pipeline covers it');
  assert.ok(/on-time/i.test(card),
    'the player must still be told the shortfall is costing on-time performance');
});

test('a covered shortfall is not sold another hire', () => {
  seed({ crewPipeline: true, labor: covered('pilots') });
  const card = cardFor(render(React.createElement(Operations)), 'pilots');
  const buttons = [...card.matchAll(/Hire ([\d,]+) · \$/g)].map(m => m[1]);
  // Hiring AHEAD of an order you have not placed yet is legitimate — pilots take
  // ten weeks — so the button stays. What it must not do is present itself as
  // the remedy for the shortfall printed directly above it.
  for (const b of buttons) {
    assert.ok(/already have enough/i.test(card),
      `a preset (Hire ${b}) is offered with no note that the group is covered`);
  }
});

test('an uncovered shortfall still warns exactly as before', () => {
  seed({ crewPipeline: true, labor: uncovered('pilots') });
  const html = render(React.createElement(Operations));
  const card = cardFor(html, 'pilots');
  assert.ok(/Severely understaffed/.test(html), 'a real emergency must still be red');
  assert.ok(/Severely short/.test(card), 'the card must still warn');
  assert.ok(!/no further hiring needed/i.test(card), 'this airline very much needs to hire');
  assert.ok(/Hire [\d,]+ · \$/.test(card), 'and must still be offered the hire');
});

test('one covered group does not mute a genuinely short one', () => {
  const labor = { ...covered('pilots'), cabinCrew: {
    ...seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf).cabinCrew, headcount: 1, pipeline: [] } };
  seed({ crewPipeline: true, labor });
  const html = render(React.createElement(Operations));
  assert.ok(/Severely understaffed/.test(html),
    'the banner must stay red while any group still needs hiring');
  const banner = html.slice(html.indexOf('Labor Groups'), html.indexOf('≈9 per narrowbody'));
  assert.ok(/Cabin Crew/.test(banner), 'the banner must name the group that needs hiring');
  assert.ok(/in training/.test(banner),
    'and must show that the other group is already covered rather than listing it as a demand');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
