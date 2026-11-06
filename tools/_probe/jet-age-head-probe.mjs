// @not-a-test
// Throwaway probe for tools/jet-age-test.mjs: reproduces Kat's two reports on the
// HEAD engine (extract it first, then point this at it):
//
//   git archive HEAD packages/engine | tar -x -C _to_delete/head-jetage
//   node tools/_probe/jet-age-head-probe.mjs _to_delete/head-jetage
//
// Exits 1 when the HEAD engine shows the bugs (the expected outcome).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] ?? '.', 'packages/engine/src');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const M = await imp('utils/market.js');
const S = await imp('utils/simulation.js');
const A = await imp('data/aircraft.js');
const route = { origin: 'EDI', destination: 'PMI', aircraftId: 'v', weeklyFrequency: 7,
  ticketPrice: Math.round(M.referencePrice('EDI', 'PMI') * 1.3) };
const ac = { id: 'v', typeId: 'vanguard', ageWeeks: 0 };
M.setEraCalendarYear(1957); const before = S.simulateRoute(route, ac).passengers;
M.setEraCalendarYear(1966); const after  = S.simulateRoute(route, ac).passengers;
const b100 = A.getAircraftType('b737100'), b200 = A.getAircraftType('b737200');
const bugs = [];
if (!(after < before * 0.75)) bugs.push(`Vanguard EDI–PMI: 1957 ${before} pax, 1966 ${after} pax — no jet age`);
if (!b100) bugs.push('no 737-100 in the catalogue');
if ((b200?.eis ?? 9999) > 1968) bugs.push(`737-200 enters service ${b200?.eis}`);
console.log(bugs.length ? bugs.map(b => `BUG: ${b}`).join('\n') : 'no bugs');
process.exit(bugs.length ? 1 : 0);
