// Operational incidents earned by management — demand model v4 worlds
// (docs/game-audit-2026-11-06.md R6).
//
//   node tools/incidents-test.mjs
//
// A well-run airline carries zero risk (and draws no random number for it); a
// fleet flown flat-out with no spares and unhappy crews can melt down, which
// costs satisfaction and reputation and makes the world news.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { incidentRisk, rollIncident, INCIDENT } from '../packages/engine/src/models/incidents.js';
import { incidentNewsRows } from '../apps/headwinds-server/src/lib/newsService.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const realRandom = Math.random;

function airline(model, { tails = 6, freq = 7, morale = 80 } = {}) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: 'Ops', hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 5e8, ...(model ? { demandModel: model } : {}) };
  const dests = ['BOS', 'DCA', 'PHL', 'BUF', 'PIT', 'RDU', 'CLT', 'BWI'];
  for (let i = 0; i < tails; i++) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'e175' });
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: dests[i] });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: s.fleet[i].id, origin: 'JFK', destination: dests[i], weeklyFrequency: freq });
  }
  const labor = Object.fromEntries(Object.entries(s.labor ?? {}).map(([k, v]) => [k, { ...v, morale }]));
  return { ...s, labor };
}

console.log('\nEarned operational incidents\n');

test('a well-run airline carries no risk', () => {
  const s = airline(4, { freq: 7, morale: 80 });
  const r = incidentRisk({ ...s, fleet: [...s.fleet, { ...s.fleet[0], id: 'spare', status: 'idle' }] }, 0.6);
  assert.equal(r.prob, 0, JSON.stringify(r));
});

test('a fleet flown flat-out, no spares, unhappy crews: real risk, with the reasons', () => {
  const s = airline(4, { morale: 40 });
  const r = incidentRisk(s, 0.97);
  assert.ok(r.prob > 0.08 && r.prob <= INCIDENT.probCap, JSON.stringify(r));
  assert.deepEqual(r.causes.map(c => c.kind).sort(), ['morale', 'spares', 'utilisation']);
});

test('small airlines are exempt', () => {
  assert.equal(incidentRisk(airline(4, { tails: 3, morale: 30 }), 0.99).prob, 0);
});

test('v4: a risky week that rolls badly melts down — satisfaction and reputation take it', () => {
  const s = airline(4, { freq: 14, morale: 35 });
  Math.random = () => 0;          // every gate opens: the incident fires if risk > 0
  let a, b;
  try {
    a = gameReducer(s, { type: 'ADVANCE_WEEK' });
    b = gameReducer({ ...s, demandModel: 3 }, { type: 'ADVANCE_WEEK' });
  } finally { Math.random = realRandom; }
  assert.ok(a.lastReport.incident, 'no incident on a v4 risky week');
  assert.equal(b.lastReport.incident, undefined, 'v3 must not roll incidents');
  assert.ok(a.pendingToasts.some(t => /meltdown/i.test(t.title)), 'no toast');
  assert.ok((a.reputationPenalty ?? 0) > (b.reputationPenalty ?? 0), 'no reputation hit');
  if (a.satisfaction != null && b.satisfaction != null) assert.ok(a.satisfaction < b.satisfaction, `${a.satisfaction} vs ${b.satisfaction}`);
});

test('rollIncident draws nothing when there is no risk', () => {
  let draws = 0;
  assert.equal(rollIncident(airline(4), 0.5, () => { draws++; return 0; }), null);
  assert.equal(draws, 0);
});

test('the news feed names the airline and both feeds can render the row', () => {
  const rows = incidentNewsRows({ worldId: 'w', week: 9, nameOf: new Map([['a1', 'Ops Air']]),
    incidents: [{ airlineId: 'a1', kind: 'meltdown', airport: 'JFK', causes: [{ kind: 'spares' }] }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'operational_meltdown');
  assert.deepEqual(rows[0].payload, { airport: 'JFK', causes: ['spares'], name: 'Ops Air' });
  for (const f of ['../src/components/News.jsx', '../apps/headwinds-web/src/Feed.jsx']) {
    assert.ok(fs.readFileSync(new URL(f, import.meta.url), 'utf8').includes("case 'operational_meltdown'"), `${f} has no renderer`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
