// Airport tiers follow real passenger traffic, not hand-picked labels.
//
//   node tools/airport-traffic-tier-test.mjs
//
// Discord, 2026-10-02: "why is Dublin in the game considered a regional
// airport?" There was no rule. Tiers were typed in by hand, so Dublin (~35M
// passengers a year) sat at 'regional' next to Zurich and Copenhagen at
// 'major'. Being regional capped it at 25 gates.
//
// The rule now: each airport we have figures for carries annualPaxM (latest
// full year, millions). A regional airport at 15M+ is promoted to major; a
// major below 12M is demoted. Between 12M and 15M an airport keeps its tier,
// so refreshing the figures doesn't flip airports that sit near the line.
// Mega is out of scope for this rule.

import assert from 'node:assert/strict';
import { AIRPORTS, getAirport, gateCapacityOf } from '../packages/engine/src/data/airports.js';

const PROMOTE_AT = 15;
const DEMOTE_BELOW = 12;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message.split('\n')[0]}`); }
}

const withPax = AIRPORTS.filter(a => typeof a.annualPaxM === 'number');

check('traffic figures cover the airports the rule depends on (≥250)', () => {
  assert.ok(withPax.length >= 250, `only ${withPax.length} airports carry annualPaxM`);
});

check('Dublin is major and gets a major airport\'s gate capacity', () => {
  const dub = getAirport('DUB');
  assert.equal(dub.tier, 'major');
  assert.ok(gateCapacityOf(dub) >= 250, `DUB gate capacity ${gateCapacityOf(dub)}`);
});

check(`no regional airport handles ${PROMOTE_AT}M+ passengers`, () => {
  const bad = withPax.filter(a => a.tier === 'regional' && a.annualPaxM >= PROMOTE_AT);
  assert.equal(bad.length, 0, bad.map(a => `${a.code} ${a.annualPaxM}`).join(', '));
});

check(`no major airport handles under ${DEMOTE_BELOW}M passengers`, () => {
  const bad = withPax.filter(a => a.tier === 'major' && a.annualPaxM < DEMOTE_BELOW);
  assert.equal(bad.length, 0, bad.map(a => `${a.code} ${a.annualPaxM}`).join(', '));
});

check('annualPaxM values are sane', () => {
  for (const a of withPax) assert.ok(a.annualPaxM >= 0 && a.annualPaxM < 150, `${a.code} ${a.annualPaxM}`);
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nairport traffic tiers OK');
