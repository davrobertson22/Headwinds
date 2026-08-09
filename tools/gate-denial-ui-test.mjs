// Gate-denial visibility: the REASON must be readable, not hidden in a tooltip.
//
// Every "+ Gate" denial in a scarcity world comes from ONE helper
// (gateLeaseDenial). The messages were always written — they were just attached
// as `title` on a `disabled` button, and browsers suppress pointer events on
// disabled form controls, so Chrome and Safari render NO tooltip at all. A
// player saw a greyed-out button and nothing else ("I cant get gates at certain
// airports and I dont know why").
//
// So these tests strip every title="..." attribute out of the rendered HTML
// before matching. A reason that only survives in a tooltip fails here, which
// is exactly the regression being locked down. The expected strings are
// hard-coded rather than recomputed through gateLeaseDenial — calling the same
// helper the component calls would pass even if the component rendered nothing.
//
//   node --import ./tools/_register-loader.mjs tools/gate-denial-ui-test.mjs

import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAirport, getRegion } from '../src/data/airports.js';

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

console.log('\nGate denial — the reason must be on screen, not in a tooltip\n');

// Hub is deliberately OUTSIDE Europe: the home hub is exempt from the lockout
// and gets the first-5-gates capacity bypass, which would mask two of the four
// rules if the test airports shared it.
const HUB = 'JFK';
const LOCKED = 'PRG';   // rule-5 lockout
const FULL   = 'MAD';   // at capacity
const ALLY   = 'LHR';   // 80% alliance cap
const MINE   = 'CDG';   // 60% per-airline cap
for (const c of [HUB, LOCKED, FULL, ALLY, MINE]) {
  assert.ok(getAirport(c), `${c} missing from the airport data`);
}
for (const c of [LOCKED, FULL, ALLY, MINE]) {
  assert.equal(getRegion(getAirport(c).country), 'Europe',
    `${c} must be in Europe so one browse render covers all four rules`);
}

const { GameProvider, freshState } = await import('../src/store/GameContext.jsx');
const Airports      = (await import('../src/components/Airports.jsx')).default;
const AirportDetail = (await import('../src/components/AirportDetail.jsx')).default;
const AddGateButton = (await import('../src/components/AddGateButton.jsx')).default;

// Week 17 of year 1 = absolute week 17; the lockout expires at 31, so the
// player is 14 weeks from being allowed back in.
const save = {
  ...freshState(),
  phase: 'playing', week: 17, year: 1, hub: HUB, cash: 78_000_000_000,
  gateScarcityWorld: true,
  gates: { [HUB]: 6, [MINE]: 60 },
  gateLockouts: { [LOCKED]: 31 },
  gateIdleWeeks: { [MINE]: 18 },
  gateMarket: {
    airports: {
      [LOCKED]: { capacity: 25,  taken: 10,  allianceTaken: 10 },
      [FULL]:   { capacity: 250, taken: 250 },
      [ALLY]:   { capacity: 100, taken: 50, allianceTaken: 80 },
      [MINE]:   { capacity: 100, taken: 65, allianceTaken: 65 },
    },
  },
};
store.set('bbae_save_v2', JSON.stringify(save));

// The four messages a player must be able to READ. Hard-coded on purpose (see
// header) and identical to what the server returns as a 400 when the same
// lease is attempted over the API, so the two paths cannot drift apart.
const EXPECTED = {
  [LOCKED]: 'You are locked out of PRG for 14 more weeks (gates there were forfeited for non-use).',
  [MINE]:   "No airline may hold more than 60% of CDG's 100 gates.",
  [ALLY]:   "Your alliance may not hold more than 80% of LHR's gates combined.",
  [FULL]:   'MAD is at capacity (250/250 gates) — win one at auction or buy one from another airline.',
};

// A tooltip is not an explanation: drop every title="..." before matching.
const stripTitles = (html) => html.replace(/\stitle="[^"]*"/g, '');
// React SSR separates adjacent text nodes with an empty <!-- --> comment, so
// {n} wk arrives as "14<!-- --> wk". It is not visible content — strip it, or
// every assertion spanning an interpolation silently fails to match.
const stripSeparators = (html) => html.replace(/<!-- -->/g, '');
const decode = (s) => s
  .replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const visible = (el) => decode(stripSeparators(stripTitles(renderToString(React.createElement(GameProvider, null, el)))));
const raw     = (el) => decode(stripSeparators(renderToString(React.createElement(GameProvider, null, el))));

// initialRegion drops the browse list straight into Europe — without it the
// page renders the region PICKER and the airport rows never mount.
const browse = () => visible(React.createElement(Airports, { initialRegion: 'Europe' }));

console.log('── 1. the browse list ("Expand to more airports") ──────────');

test('it renders the European airports at all', () => {
  const html = browse();
  for (const c of [LOCKED, FULL, ALLY, MINE]) {
    assert.ok(html.includes(c), `${c} should be listed in the Europe browse list`);
  }
});

for (const [code, message] of Object.entries(EXPECTED)) {
  test(`${code}: the reason is rendered as text, not only as a tooltip`, () => {
    const html = browse();
    assert.ok(html.includes(message),
      `expected the denial reason on the ${code} row:\n        "${message}"\n      `
      + 'It is NOT in the rendered output once title="..." attributes are stripped, '
      + 'so a player on Chrome or Safari sees a greyed-out button and no explanation.');
  });
}

test('the "+ Gate" button is still disabled on every denied airport', () => {
  const html = browse();
  assert.ok(/disabled/.test(html), 'denied airports must keep the button disabled');
});

test('a locked-out airport carries a countdown chip', () => {
  const html = browse();
  assert.ok(/locked/i.test(html),
    'the lockout is the one rule with no visual footprint — it needs a chip like "🔒 LOCKED · 14 WK"');
  assert.ok(/14\s*(WK|week)/i.test(html), 'the chip should say how many weeks are left');
});

// The 16-week warning the engine raises is a TOAST, and a server-side tick
// overwrites the toast queue before the player ever opens the tab. The airport
// itself has to carry the countdown or the forfeiture arrives unannounced.
test('gates going idle warn on the page, not only in a perishable toast', () => {
  const html = browse();
  assert.ok(/No routes have served CDG for 18 weeks/.test(html),
    'gateIdleWeeks is engine-only state with no UI — the 16-week warning must be visible');
  assert.ok(/forfeited in 6 weeks/.test(html), 'and it should say how long is left');
});

console.log('── 2. the Details panel ─────────────────────────────');

for (const [code, message] of Object.entries(EXPECTED)) {
  test(`${code}: Details explains the denial too`, () => {
    const html = visible(React.createElement(AirportDetail, { code, onBack: () => {} }));
    assert.ok(html.includes(message),
      `Details is where a confused player looks next; it should state why ${code} is closed to them`);
  });
}

console.log('── 3. the inline AddGateButton (route planners) ───────────');

test('it is disabled under a denial instead of silently no-oping', () => {
  const html = raw(React.createElement(AddGateButton, { code: LOCKED }));
  assert.ok(/disabled/.test(html),
    'AddGateButton dispatches ADD_GATE and the reducer returns state unchanged — '
    + 'a click that does nothing at all. It must consult gateLeaseDenial.');
});

test('it explains itself in visible text', () => {
  const html = visible(React.createElement(AddGateButton, { code: LOCKED }));
  assert.ok(/locked out/i.test(html),
    'the button should say why it cannot be used, not just grey out');
});

test('it still works where leasing is allowed', () => {
  const html = raw(React.createElement(AddGateButton, { code: 'AMS' }));
  assert.ok(!/disabled/.test(html), 'AMS is unconstrained — the button must stay live');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
