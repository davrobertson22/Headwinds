const HW=new URL('../../', import.meta.url).pathname.replace(/\/$/,'');
const { calcHQCost, HQ_DEPARTURE_FEE, HQ_BASE_WEEKLY } = await import(HW+'/packages/engine/src/data/overhead.js');
// Revenue per departure by class = the engine's OWN calibration table in overhead.js
const REV = { 'Turboprop':3481, 'Regional Jet':10948, 'Narrow Body':35731, 'Wide Body':206703, 'Double Deck':337862 };
console.log('A 2-AIRCRAFT STARTUP, 7 round trips per week per aircraft (14 departures):');
console.log('class'.padEnd(14), 'gross rev/wk'.padStart(14), 'legacy HQ'.padStart(11), 'HQ % rev'.padStart(9), '| NWR HQ'.padStart(10), 'HQ % rev'.padStart(9));
for (const [k,v] of Object.entries(REV)) {
  const rev = 14*v, legacy = calcHQCost(2), nwr = HQ_BASE_WEEKLY + 14*HQ_DEPARTURE_FEE[k];
  console.log(k.padEnd(14), ('$'+rev.toLocaleString()).padStart(14), ('$'+legacy.toLocaleString()).padStart(11),
    ((100*legacy/rev).toFixed(0)+'%').padStart(9), ('| $'+nwr.toLocaleString()).padStart(10), ((100*nwr/rev).toFixed(0)+'%').padStart(9));
}
console.log('\nSame, at HIGH utilisation (28 round trips/wk/aircraft = 56 departures) — the shuttle strategy:');
for (const [k,v] of Object.entries(REV)) {
  const rev = 56*v, legacy = calcHQCost(2), nwr = HQ_BASE_WEEKLY + 56*HQ_DEPARTURE_FEE[k];
  console.log(k.padEnd(14), ('$'+rev.toLocaleString()).padStart(14), ('$'+legacy.toLocaleString()).padStart(11),
    ((100*legacy/rev).toFixed(0)+'%').padStart(9), ('| $'+nwr.toLocaleString()).padStart(10), ((100*nwr/rev).toFixed(0)+'%').padStart(9));
}
