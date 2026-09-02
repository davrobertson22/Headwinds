import { pairDemandGrowth, setEraStartYear, getFareIndex, setFareIndex } from '../../packages/engine/src/utils/market.js';
import { eraFareIndex } from '../../packages/engine/src/data/era.js';
for (const [label, y] of [['1950 y1',1],['1975 y26',26],['2000 y51',51]]) {
  const abs = (y-1)*52+1;
  setEraStartYear(null); const classic = pairDemandGrowth('JFK','LAX',abs);
  setEraStartYear(1950); const era = pairDemandGrowth('JFK','LAX',abs);
  console.log(label, 'client-without-era', classic.toFixed(3), 'server-era', era.toFixed(3), 'overstated x', (classic/era).toFixed(1));
}
console.log('fare ladder 1950: client', 1, 'server', eraFareIndex(1950));
