// World rule presets on the create form (docs/game-audit-2026-11-06.md F5).
//
//   node --import ./tools/_register-loader.mjs tools/world-presets-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const src = fs.readFileSync(new URL('../apps/headwinds-web/src/App.jsx', import.meta.url), 'utf8');
const KEYS = ['nwr', 'crew', 'lines', 'partners', 'demand', 'marketDev', 'loyalty', 'hubBanks', 'scarcity', 'capital', 'demandMult'];

console.log('\nWorld rule presets\n');

await test('every preset sets every switch', async () => {
  const { WORLD_RULE_PRESETS } = await import('../apps/headwinds-web/src/App.jsx');
  for (const [k, p] of Object.entries(WORLD_RULE_PRESETS)) {
    for (const key of KEYS) assert.ok(key in p, `${k} is missing ${key}`);
    assert.ok(p.label && p.blurb, `${k} needs a label and a blurb`);
  }
});

await test('"Standard" is exactly the form\'s own defaults, so picking nothing changes nothing', async () => {
  const { WORLD_RULE_PRESETS: { standard: s } } = await import('../apps/headwinds-web/src/App.jsx');
  const def = (name) => src.match(new RegExp(`\\[${name}, set\\w+\\] = useState\\(([^)]+)\\)`))?.[1];
  assert.equal(String(s.nwr), def('newWorldRestrictions'));
  assert.equal(String(s.crew), def('crewPipeline'));
  assert.equal(String(s.lines), def('productionLines'));
  assert.equal(String(s.partners), def('partnerships'));
  assert.equal(String(s.demand), def('demandV2'));
  assert.equal(String(s.marketDev), def('marketDev'));
  assert.equal(String(s.loyalty), def('loyaltyPools'));
  assert.equal(String(s.hubBanks), def('hubBanks'));
  assert.equal(String(s.scarcity), def('gateScarcity'));
  assert.equal(String(s.capital), def('startingCapital'));
  assert.equal(String(s.demandMult), def('demandMultiplier'));
});

await test('touching any switch marks the form Custom', () => {
  for (const setter of ['setNewWorldRestrictions', 'setCrewPipeline', 'setGateScarcity', 'setHubBanks']) {
    assert.ok(src.includes(`customised((e) => ${setter}(e.target.checked))`), `${setter} does not mark Custom`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
