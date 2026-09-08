// SSR-renders the REAL Operations page against a seeded save, so the crew panel
// is proven to quote the same numbers the engine will act on — a helper tested
// alone can pass while the screen calling it is wrong.
//
//   node --import ./tools/_register-loader.mjs tools/crew-ui-test.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAircraftType } from '../src/data/aircraft.js';
import { formatMoney } from '../src/utils/simulation.js';
import {
  DEFAULT_LABOR_STATE, seedCrewFor, crewRequired, crewHireCost, CREW_LEAD_WEEKS,
  splitStarterHire, CREW_INSTANT_AIRCRAFT, crewBodies, CREW_PER_UNIT, crewShortfall,
} from '../src/data/labor.js';
import { gameReducer } from '../src/store/GameContext.jsx';

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
  } catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 3).join('\n      ')}`); failed++; }
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Operations = (await import('../src/components/Operations.jsx')).default;
// React SSR splits adjacent text nodes with <!-- --> markers; strip them so
// assertions match what a reader actually sees on the page.
const render = (el) => renderToString(React.createElement(GameProvider, null, el)).replaceAll('<!-- -->', '');

const NB = getAircraftType('b737800');
const typeOf = (a) => getAircraftType(a.typeId);
const FLEET = Array.from({ length: 4 }, (_, i) => ({
  id: `ac${i}`, typeId: NB.id, name: `Tail ${i}`, tailNumber: `N${i}TEST`,
  status: 'assigned', ageWeeks: 52, ownershipType: 'owned', config: { economy: NB.seats },
}));

function seed(extra = {}) {
  const save = {
    ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK', cash: 400_000_000,
    gates: { JFK: 8 }, fleet: FLEET, routes: [], ...extra,
  };
  store.set('bbae_save_v2', JSON.stringify(save));
  return save;
}

console.log('\n── Operations: crew pipeline panel ─────────────────────');

test('a new airline is told its starter crew hires instantly', () => {
  // Nobody hired yet: the whole starter allowance is still available.
  const bare = Object.fromEntries(['pilots', 'cabinCrew', 'groundStaff', 'maintenanceTeam']
    .map(id => [id, { payMultiplier: 1.0, morale: 80, headcount: 0, pipeline: [] }]));
  seed({ crewPipeline: true, labor: bare });
  const html = render(React.createElement(Operations));
  assert.ok(html.includes(`first ${CREW_INSTANT_AIRCRAFT} aircraft crew up instantly`),
    'the starter-crew allowance must be spelled out on the page');
  assert.ok(/· instant/.test(html), 'a qualifying hire button must be marked instant');
});

test('an airline past the starter allowance is not promised instant hiring', () => {
  seed({ crewPipeline: true, labor: seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf) });
  const html = render(React.createElement(Operations));
  assert.ok(!html.includes('crew up instantly'), 'a crewed-up airline must not be offered starter crew');
});

test('a classic save shows no crew panel at all', () => {
  seed({ crewPipeline: false });
  const html = render(React.createElement(Operations));
  assert.ok(!/fully staffed|% short/.test(html), 'classic save must not render staffing');
  assert.ok(!/in training/.test(html), 'classic save must not render a training line');
  assert.ok(!/Hire \d/.test(html), 'classic save must not offer hiring');
});

test('a fully staffed pipeline airline renders staffing and no warning', () => {
  seed({ crewPipeline: true, labor: seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf) });
  const html = render(React.createElement(Operations));
  assert.ok(/fully staffed/.test(html), 'staffing line missing');
  // The panel must speak in PEOPLE, never in the engine's narrowbody-equivalent
  // index — "0.9 pilots" is the bug this display exists to fix.
  const bodies = crewBodies('pilots', crewRequired('pilots', FLEET, typeOf));
  assert.ok(html.includes(`/ ${bodies.toLocaleString()} pilots`),
    `staffing should require ${bodies} pilots, in people`);
  assert.ok(!/\d\.\d \/ \d\.\d/.test(html), 'staffing must not print fractional crew');
  assert.ok(!/Short-handed/.test(html), 'must not warn when fully staffed');
});

test('an understaffed airline warns, and quotes the real hire cost + lead time', () => {
  const labor = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const short = { ...labor, pilots: { ...labor.pilots, headcount: 1 } };
  seed({ crewPipeline: true, labor: short });
  const html = render(React.createElement(Operations));
  assert.ok(/Short-handed|Severely understaffed/.test(html), 'no shortfall warning rendered');
  assert.ok(/\d+ short/.test(html), 'no shortfall size rendered');
  assert.ok(!/% short/.test(html), 'shortfall must be reported in people, not a percentage');
  assert.ok(html.includes(`${CREW_LEAD_WEEKS.pilots}-week training`), 'lead time not shown');

  // Every hire button must quote the SAME cost the reducer will charge for the
  // number of PEOPLE printed on it. Read the buttons off the page rather than
  // recomputing a gap here — that is what makes this an agreement test. The page
  // renders all four groups, so slice each card out by its own per-narrowbody
  // marker before pricing its buttons.
  let checked = 0;
  for (const g of ['pilots', 'cabinCrew', 'groundStaff', 'maintenanceTeam']) {
    const per = CREW_PER_UNIT[g];
    const from = html.indexOf(`≈${per} per narrowbody`);
    assert.ok(from > -1, `no staffing card rendered for ${g}`);
    const rest = html.slice(from);
    const to = rest.indexOf('Pay rate');
    const card = to > -1 ? rest.slice(0, to) : rest;
    for (const m of card.matchAll(/Hire ([\d,]+) · (\$[\d.]+[KMB]?)/g)) {
      const people = Number(m[1].replace(/,/g, ''));
      assert.equal(m[2], formatMoney(crewHireCost(g, people / per)),
        `${g}: hire button for ${people} quotes ${m[2]}, not the engine cost`);
      checked++;
    }
  }
  assert.ok(checked >= 4, `expected hire buttons on every card, priced ${checked}`);

  // And the per-person rate, so a custom amount is priceable before typing it.
  assert.ok(html.includes(`${formatMoney(crewHireCost('pilots', 1 / CREW_PER_UNIT.pilots))} each`),
    'per-person training cost not shown');
});

test('any number of staff can be hired, priced per person', () => {
  const labor = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  seed({ crewPipeline: true, labor: { ...labor, pilots: { ...labor.pilots, headcount: 1 } } });
  const html = render(React.createElement(Operations));
  assert.ok(/placeholder="Custom"/.test(html), 'no custom hire field rendered');

  // The action the field dispatches: PEOPLE in, the right number of units out,
  // and a bill that matches what the button quoted.
  const perUnit = CREW_PER_UNIT.pilots;
  const before = { ...freshState(), phase: 'playing', week: 20, year: 2, hub: 'JFK',
                   cash: 400_000_000, fleet: FLEET, routes: [], crewPipeline: true, labor };
  const after = gameReducer(before, { type: 'HIRE_CREW', group: 'pilots', bodies: 15 });
  const queued = (after.labor.pilots.pipeline ?? []).reduce((s, b) => s + b.count, 0)
               + (after.labor.pilots.headcount - labor.pilots.headcount);
  assert.ok(Math.abs(crewBodies('pilots', queued) - 15) <= 1,
    `hiring 15 people should queue ~15 people, queued ${crewBodies('pilots', queued)}`);
  assert.equal(before.cash - after.cash, crewHireCost('pilots', 15 / perUnit),
    'a custom hire must be billed at the per-person rate');

  // A fractional number of people is not a thing; the odd one is dropped, never
  // rounded up into crew the player did not ask for.
  const half = gameReducer(before, { type: 'HIRE_CREW', group: 'pilots', bodies: 15.9 });
  assert.equal(before.cash - half.cash, crewHireCost('pilots', 15 / perUnit));

  // Legacy callers (playbot, an older multiplayer client) still mean UNITS.
  const legacy = gameReducer(before, { type: 'HIRE_CREW', group: 'pilots', count: 2 });
  assert.equal(before.cash - legacy.cash, crewHireCost('pilots', 2),
    'count: must keep meaning narrowbody-equivalents, not people');
});

test('REGRESSION: every group reports the order book, not just the long-lead ones', () => {
  // Reported 2026-09-07: "the indicator for how many I need to order only shows
  // up for pilots and maintenance but not cabin crew and ground staff". Cause: a
  // delivery 8 weeks out is INSIDE the pilot (10wk) and maintenance (6wk)
  // training windows and OUTSIDE cabin crew (5wk) and ground staff (2wk), and
  // the panel said nothing at all for a group whose window had not opened —
  // indistinguishable from a broken indicator. Every card must speak.
  const labor = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const absWeek = (2 - 1) * 52 + 20;
  seed({
    crewPipeline: true, labor,
    pendingOrders: [{ id: 'o1', typeId: NB.id, ownershipType: 'owned',
                      deliverAbsWeek: absWeek + 8, totalPrice: 90_000_000 }],
  });
  const html = render(React.createElement(Operations));
  for (const g of ['pilots', 'cabinCrew', 'groundStaff', 'maintenanceTeam']) {
    const per = CREW_PER_UNIT[g];
    const from = html.indexOf(`≈${per} per narrowbody`);
    assert.ok(from > -1, `no staffing card for ${g}`);
    const rest = html.slice(from);
    const to = rest.indexOf('Pay rate');
    const card = to > -1 ? rest.slice(0, to) : rest;
    assert.ok(/aircraft on order|arriving inside/.test(card),
      `${g} says nothing about the aircraft on order`);
  }
  // The short-window groups must also say WHEN to act, not just that an aircraft
  // is coming: 8 weeks out less 5 weeks of cabin-crew training is 3 weeks.
  assert.ok(/by week 3/.test(html), 'no "hire N by week X" guidance');
});

test('REGRESSION: one styling rule for the order line, on every card', () => {
  // "it shows now but it is in gray text, also the styling is inconsistent and i
  // prefer the pilot's styling" (2026-09-07). The two branches had different
  // colours, so a card telling you to hire fourteen people rendered dim grey
  // purely because its training window had not opened yet. Urgency must key off
  // whether crew are MISSING, never off which branch drew the line.
  const labor = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const absWeek = (2 - 1) * 52 + 20;
  seed({
    crewPipeline: true, labor,
    pendingOrders: [{ id: 'o1', typeId: NB.id, ownershipType: 'owned',
                      deliverAbsWeek: absWeek + 8, totalPrice: 90_000_000 }],
  });
  const html = render(React.createElement(Operations));
  let insideWindow = 0, notYet = 0;
  for (const g of ['pilots', 'cabinCrew', 'groundStaff', 'maintenanceTeam']) {
    const per = CREW_PER_UNIT[g];
    const from = html.indexOf(`≈${per} per narrowbody`);
    const rest = html.slice(from);
    const to = rest.indexOf('Pay rate');
    const card = to > -1 ? rest.slice(0, to) : rest;
    const m = card.match(/color:var\((--[a-z-]+)\)[^"]*">🛬([\s\S]*?)<\/div>/);
    assert.ok(m, `${g}: no order line found to style`);
    const [, colour, text] = m;
    // The rule: amber when crew are missing, dim when covered — whichever branch
    // drew the line. A card that says "hire N" in grey is the reported bug.
    if (/hire /i.test(text)) {
      assert.equal(colour, '--yellow', `${g}: says hire but renders ${colour}`);
    } else {
      assert.equal(colour, '--text-dim', `${g}: covered but renders ${colour}`);
    }
    if (/training window/.test(text)) insideWindow++; else notYet++;
  }
  // Both branches must actually be exercised here, or the rule above is untested:
  // 8 weeks out is inside the pilot and maintenance windows, outside the others.
  assert.ok(insideWindow >= 1 && notYet >= 1,
    `expected both branches on one page, got ${insideWindow} inside / ${notYet} not-yet`);

  // And the duplicate: the pilots card used to carry both this line and a second
  // one saying the same thing in the same colour.
  assert.ok(!/short for the one you have on order/.test(html),
    'the order shortfall is stated twice');
});

test('REGRESSION: never "0 short" and "Short-handed" at the same time', () => {
  // Reported 2026-09-07: a card reading "156 / 156 cabin crew · 0% short" with
  // "⚠ Short-handed — on-time performance is suffering" underneath it. Cause:
  // attrition removes a FRACTION of a person every week and the tick stores
  // headcount to two decimals, so a fully-crewed airline lands a hair under its
  // requirement within a week and stays there forever. Both numbers were
  // "right"; together they were a lie. ("its just lying", "It isn't
  // understaffed at all".)
  const labor = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const bled = Object.fromEntries(Object.entries(labor).map(([id, g]) => {
    const need = crewRequired(id, FLEET, typeOf);
    // Exactly what a week of attrition leaves behind: a hair under, stored to 2dp.
    return [id, { ...g, headcount: Math.round((need - 0.004) * 100) / 100 }];
  }));
  seed({ crewPipeline: true, labor: bled });
  const html = render(React.createElement(Operations));
  assert.ok(!/Short-handed|Severely short/.test(html),
    'a sub-person gap must not warn about understaffing');
  assert.ok(/fully staffed/.test(html), 'a sub-person gap should read as fully staffed');
  assert.ok(!/· 0 short/.test(html), 'a zero shortfall must not be reported as a shortfall');

  // Same rule in the engine, so the page banner and the OTP penalty agree with
  // the card rather than each having their own opinion.
  const gap = crewShortfall(bled, FLEET, typeOf);
  assert.equal(gap.worst, 0, 'engine still sees a shortfall smaller than one person');

  // And a REAL shortfall is still reported, in people.
  const reallyShort = { ...labor, pilots: { ...labor.pilots, headcount: 1 } };
  seed({ crewPipeline: true, labor: reallyShort });
  const shortHtml = render(React.createElement(Operations));
  assert.ok(/Short-handed|Severely short/.test(shortHtml), 'a real shortfall must still warn');
  assert.ok(/\d+ short/.test(shortHtml), 'a real shortfall must say how many people');
});

test('crew in training are surfaced with a ready-in countdown', () => {
  const labor = seedCrewFor(DEFAULT_LABOR_STATE, FLEET, typeOf);
  const training = {
    ...labor,
    pilots: { ...labor.pilots, pipeline: [{ count: 3, readyAbsWeek: (2 - 1) * 52 + 20 + 6 }] },
  };
  seed({ crewPipeline: true, labor: training });
  const html = render(React.createElement(Operations));
  assert.ok(html.includes(`${crewBodies('pilots', 3).toLocaleString()} in training`),
    'training count not shown in people');
  assert.ok(/next ready in 6 wks/.test(html), 'ready-in countdown not shown');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
