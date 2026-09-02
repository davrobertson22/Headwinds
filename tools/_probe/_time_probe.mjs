import { worldEconomyAt, worldFuelIndex } from '../../apps/headwinds-server/src/lib/worldEconomy.mjs';
import { eraDemandIndex, eraFuelMean } from '../../packages/engine/src/data/era.js';
import { AIRCRAFT_TYPES, aircraftAvailability, eraDeliveredAgeWeeks, getAircraftType } from '../../packages/engine/src/data/aircraft.js';
console.log('--- fuel at open, 1950 world (mean', eraFuelMean(1950), ')');
for (const w of [1,2,5,10,20,30,40,52]) console.log(w, worldEconomyAt('seedX', w, {startYear:1950}).fuelPrice.index);
console.log('--- fuel at open, 2000 world (mean', eraFuelMean(2000), ')');
for (const w of [1,5,10,20]) console.log(w, worldEconomyAt('seedX', w, {startYear:2000}).fuelPrice.index);
console.log('--- demand step at Jan 1');
for (const y of [1950,1955,1960,1970,1980,2000,2026]) console.log(y, '->', y+1, ((eraDemandIndex(y+1)/eraDemandIndex(y)-1)*100).toFixed(1)+'%');
console.log('--- comet availability');
const c = getAircraftType('comet1');
for (const y of [1952,1953,1954,1955]) console.log(y, aircraftAvailability(c,y));
console.log('--- delivered age samples 1950');
for (const id of ['dc3','c47','cv240','dc4']) { const t=getAircraftType(id); console.log(id, t.oop, t.deliveredAgeWeeks, '->', eraDeliveredAgeWeeks(t,1950)); }
console.log('--- types with no eis or no oop and pre-2026 out of production issues');
console.log('missing eis:', AIRCRAFT_TYPES.filter(t=>t.eis==null).map(t=>t.id));
console.log('oop<eis:', AIRCRAFT_TYPES.filter(t=>t.oop!=null&&t.oop<t.eis).map(t=>t.id));
console.log('deliveredAge>0 but no oop:', AIRCRAFT_TYPES.filter(t=>(t.deliveredAgeWeeks??0)>0&&t.oop==null).map(t=>t.id));
console.log('oop set but deliveredAge 0 and oop<2010:', AIRCRAFT_TYPES.filter(t=>t.oop!=null&&t.oop<2010&&!(t.deliveredAgeWeeks>0)).map(t=>t.id+':'+t.oop));
