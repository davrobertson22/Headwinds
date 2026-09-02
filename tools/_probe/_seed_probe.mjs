import { seedAirlineState } from '../../apps/headwinds-server/src/lib/worldService.mjs';
const world = { id:'w', worldSeed:'s', currentYear: 5, currentWeek: 10, tickConfig: { startYear: 1950, startingCapital: 4_000_000, crewPipeline: true, gateScarcity: true } };
const st = seedAirlineState(world, { airlineName: 'T', hub: 'JFK' });
const joinAbs = (5-1)*52+10;
console.log('year/week', st.year, st.week, 'cash', st.cash, 'fuel', st.fuelPrice.index, 'hist', st.fuelPrice.history.length, 'startYear', st.startYear, 'foundedAbsWeek', st.foundedAbsWeek);
// find any numeric field whose key mentions AbsWeek / Week and is between 1 and joinAbs-1
function walk(o, path, out) {
  if (!o || typeof o !== 'object') return;
  for (const [k,v] of Object.entries(o)) {
    const p = path? path+'.'+k : k;
    if (typeof v === 'number' && /abs|Week|week/i.test(k) && !/ageWeeks|weeksRemaining|weeksOpen|WeeksLeft|Per|Weekly|weekly/.test(k)) out.push([p, v]);
    else if (typeof v === 'object') walk(v, p, out);
  }
}
const out=[]; walk(st,'',out); console.log(out.filter(([p,v]) => v < joinAbs && v > 0 && !/^week$/.test(p)));
console.log('labor keys', Object.keys(st.labor??{}), st.laborRelations);
console.log('objectives sample', (st.objectives??[]).slice(0,2));
