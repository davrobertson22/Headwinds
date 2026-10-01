// Era worlds: no global alliances before 1997 — for AI carriers too.
//
// Discord 2026-09-29 (Maxim Zayats): "Are the alliances even working? I tried
// in multiple games, and it's always unavailable" — 1950-1970 starts. The
// player was barred until 1997, but AI carriers kept their founding seats and
// kept joining, so every bloc looked full and open to everyone but you.
//
//   node --import ./tools/_register-loader.mjs tools/alliance-era-test.mjs
import assert from 'node:assert/strict';
import { ALLIANCES, applyAllianceEra, effectiveAllianceId } from '../packages/engine/src/data/alliances.js';
import { tickCompetitorAI } from '../packages/engine/src/models/competitorAI.js';
import { sampleAndInitializeCompetitors } from '../packages/engine/src/models/demand.js';

const founderIds = new Set(ALLIANCES.flatMap(a => a.memberIds));
const comps = sampleAndInitializeCompetitors(25);
assert.ok(comps.some(c => founderIds.has(c.id)), 'sample includes founding members');
Math.random = () => 0.001;   // max odds of every AI move, joins included

// 1. Classic worlds untouched.
const classic = applyAllianceEra(comps, null);
assert.equal(classic.competitors, comps);

// 2. Pre-1997: everyone unallied.
const pre = applyAllianceEra(comps, 1955).competitors;
assert.ok(pre.every(c => effectiveAllianceId(c) === null), 'no alliances in 1955');

// 3. AI tick in 1960 never joins a bloc, even at max join odds.
let world = pre;
for (let w = 1; w <= 60; w++) {
  world = tickCompetitorAI(world, { weekNumber: 100 + w, month: 1, calendarYear: 1960 }).competitors;
}
assert.ok(world.every(c => effectiveAllianceId(c) === null), 'AI stays unallied before 1997');

// 4. Old saves already holding memberships get stripped.
const stale = comps.map(c => ({ ...c, allianceId: 'skybridge' }));
const healed = tickCompetitorAI(stale, { weekNumber: 200, calendarYear: 1970 }).competitors;
assert.ok(healed.every(c => effectiveAllianceId(c) === null), 'stale memberships stripped');

// 5. 1997: founders take their seats, with news.
const res = tickCompetitorAI(world, { weekNumber: 2000, calendarYear: 1997 });
const founders = res.competitors.filter(c => founderIds.has(c.id));
for (const c of founders) {
  const expected = ALLIANCES.find(a => a.memberIds.includes(c.id)).id;
  assert.equal(c.allianceId, expected, `${c.id} founds ${expected}`);
}
assert.ok(res.events.some(e => e.type === 'allianceJoin' && /founding member/.test(e.description)));
assert.ok(res.competitors.every(c => !c._preAlliance), 'flag cleared');

console.log('alliance-era: all checks passed');
