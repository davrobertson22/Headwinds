import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { withRivals } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { AIRCRAFT_TYPES } from '../packages/engine/src/data/aircraft.js';

const nb = AIRCRAFT_TYPES.find(t => t.category === 'Narrow Body') || AIRCRAFT_TYPES[0];
const view = { competitors:[], humanRivals:{}, alliance:null };

function legacyMidGameBlob() {
  let s = gameReducer(freshState(), { type:'START_GAME', airlineName:'Test Air', hub:'SFO', enableObjectives:false });
  s = { ...s, cash: 900_000_000, week: 20, fleet: [
    { id:'a1', typeId: nb.id, name:'X1', tailNumber:'N1', status:'idle', ageWeeks:40, config:{}, ownershipType:'owned' },
    { id:'a2', typeId: nb.id, name:'X2', tailNumber:'N2', status:'idle', ageWeeks:40, config:{}, ownershipType:'owned' },
    { id:'a3', typeId: nb.id, name:'X3', tailNumber:'N3', status:'idle', ageWeeks:40, config:{}, ownershipType:'owned' },
  ] };
  delete s.starterDeliveriesUsed; // created before the perk shipped
  return s;
}

function brandNewBlob() {
  let s = gameReducer(freshState(), { type:'START_GAME', airlineName:'New Air', hub:'SFO', enableObjectives:false });
  s = { ...s, cash: 900_000_000 };
  delete s.starterDeliveriesUsed;
  return s;
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

// --- Mid-game legacy airline ---
{
  const s = legacyMidGameBlob();
  const injected = withRivals(s, view);
  console.log('withRivals.starterDeliveriesUsed (legacy mid-game) =', injected.starterDeliveriesUsed);
  const next = gameReducer(injected, { type:'ORDER_AIRCRAFT', typeId: nb.id, ownershipType:'owned', quantity:4, config:{} });
  const instant = next.fleet.length - s.fleet.length;
  console.log('  instant granted to mid-game =', instant, '| counter after =', next.starterDeliveriesUsed);
  check('mid-game airline gets NO instant deliveries', instant === 0);
  const remaining = Math.max(0, 2 - (injected.starterDeliveriesUsed ?? 0));
  check('mid-game banner would be hidden (remaining 0)', remaining === 0);
}

// --- Brand-new airline still gets the perk ---
{
  const s = brandNewBlob();
  const injected = withRivals(s, view);
  console.log('withRivals.starterDeliveriesUsed (brand new) =', injected.starterDeliveriesUsed);
  const next = gameReducer(injected, { type:'ORDER_AIRCRAFT', typeId: nb.id, ownershipType:'owned', quantity:4, config:{} });
  const instant = next.fleet.length - s.fleet.length;
  console.log('  instant granted to new player =', instant, '| counter after =', next.starterDeliveriesUsed);
  check('brand-new airline still gets exactly 2 instant', instant === 2);
  const remaining = Math.max(0, 2 - (injected.starterDeliveriesUsed ?? 0));
  check('brand-new banner shows 2 remaining', remaining === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
