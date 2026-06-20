#!/usr/bin/env node
/**
 * add-aircraft.mjs — splice new aircraft types into src/data/aircraft.js
 * before the AIRCRAFT_TYPES array closes.
 *
 * - purchasePrice is auto-computed at 250x weeklyLease (the file's convention).
 * - Freighters get category 'Freighter', seats 0, freighter:true, payloadTonnes.
 * - image is '' (the AircraftPhoto component shows a category placeholder when
 *   src is empty — no broken links; real photos can be added later).
 * - Skips any id already present; validates intra-batch uniqueness.
 *
 * Usage: node tools/aircraft-expansion/add-aircraft.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const aircraftPath = path.resolve(__dir, '../../src/data/aircraft.js');

// Helper: passenger type [id,name,mfr,cat,seats,range,lease,burn,crew,maint,desc]
const P = (id, name, mfr, cat, seats, range, lease, burn, crew, maint, desc) =>
  ({ id, name, manufacturer: mfr, category: cat, seats, range, weeklyLease: lease,
     fuelBurnPer100km: burn, crewCostPerKm: crew, baseMaintenancePerWk: maint, description: desc });
// Helper: freighter type [id,name,mfr,payloadTonnes,range,lease,burn,crew,maint,desc]
const F = (id, name, mfr, payload, range, lease, burn, crew, maint, desc) =>
  ({ id, name, manufacturer: mfr, category: 'Freighter', seats: 0, range, weeklyLease: lease,
     fuelBurnPer100km: burn, crewCostPerKm: crew, baseMaintenancePerWk: maint,
     freighter: true, payloadTonnes: payload, description: desc });

const NEW = [
  // ── Historic / classic ──────────────────────────────────────────────────────
  P('dc3','Douglas DC-3','Douglas','Turboprop',28,2400,6000,90,0.5,6000,'The aircraft that made air travel mainstream. A 1930s piston legend still flying today on bush and heritage routes.'),
  P('dc863','Douglas DC-8-63','Douglas','Narrow Body',259,11000,75000,980,1.2,78000,'Stretched four-engine long-haul classic of the 1960s — the first jet to exceed Mach 1 in a (test) dive.'),
  P('caravelle','Sud Aviation Caravelle','Sud Aviation','Narrow Body',99,3300,30000,480,0.85,33000,'Pioneering French short-haul jet — the first rear-engined airliner and a 1960s European staple.'),
  P('trident3b','Hawker Siddeley Trident 3B','Hawker Siddeley','Narrow Body',150,2700,38000,620,0.95,42000,'British tri-jet built for dense short-haul; pioneered automatic landing.'),
  P('vc10','Vickers VC10','Vickers','Narrow Body',150,9400,60000,920,1.1,65000,'Elegant four-engine British long-hauler designed for hot-and-high African routes.'),
  P('cv990','Convair 990 Coronado','Convair','Narrow Body',149,6100,45000,850,1.0,50000,'The fastest subsonic airliner of its era — speed bought at the cost of thirsty economics.'),
  P('tu154m','Tupolev Tu-154M','Tupolev','Narrow Body',180,5200,40000,700,0.95,52000,'The workhorse tri-jet of the Eastern bloc — rugged, fast, and built for rough strips.'),
  P('tu134','Tupolev Tu-134','Tupolev','Regional Jet',76,3000,22000,420,0.8,26000,'Soviet short-haul jet, glass-nosed navigator station and all. A Cold War regional staple.'),
  P('il62m','Ilyushin Il-62M','Ilyushin','Narrow Body',174,10000,58000,980,1.1,62000,'The USSR\'s flagship long-haul quad-jet, with a distinctive rear-mounted engine cluster.'),
  P('il86','Ilyushin Il-86','Ilyushin','Wide Body',320,5000,95000,1150,1.9,110000,'The Soviet Union\'s first widebody — thirsty engines limited it to medium-haul.'),
  P('yak42','Yakovlev Yak-42','Yakovlev','Narrow Body',120,4000,28000,470,0.85,32000,'Soviet tri-jet for medium-density routes, rugged enough for unpaved regional fields.'),
  P('yak40','Yakovlev Yak-40','Yakovlev','Regional Jet',32,1800,12000,260,0.6,14000,'Tiny three-engine regional jet that opened jet service to small Soviet towns.'),
  P('f27','Fokker F27 Friendship','Fokker','Turboprop',48,1900,9000,80,0.65,8000,'Best-selling European turboprop of its generation — reliable workhorse of regional fleets.'),
  P('f28','Fokker F28 Fellowship','Fokker','Regional Jet',79,2700,20000,380,0.75,22000,'Dutch short-haul jet with built-in airstairs — forerunner of the Fokker 70/100.'),
  P('b720b','Boeing 720B','Boeing','Narrow Body',156,6700,55000,800,1.0,56000,'A lighter, faster derivative of the 707 for shorter routes — Boeing\'s early jet-age stopgap.'),
  P('b747100','Boeing 747-100','Boeing','Double Deck',440,9800,250000,1175,2.3,270000,'The original Jumbo Jet that democratized long-haul travel in 1970.'),
  P('b747300','Boeing 747-300','Boeing','Double Deck',470,11700,275000,1100,2.3,275000,'Stretched-upper-deck Jumbo bridging the -200 and the definitive -400.'),
  P('a300b4','Airbus A300B4','Airbus','Wide Body',250,5400,110000,850,1.85,120000,'The world\'s first twin-engine widebody — the aircraft that launched Airbus.'),
  P('a310200','Airbus A310-200','Airbus','Wide Body',240,6800,120000,760,1.8,125000,'Shortened, advanced-wing A300 derivative — an efficient medium widebody for its day.'),
  P('l188','Lockheed L-188 Electra','Lockheed','Turboprop',98,3500,18000,260,0.85,16000,'Fast American four-engine turboprop; airframe later spawned the P-3 Orion.'),
  P('bac111','BAC One-Eleven 500','BAC','Narrow Body',119,2700,26000,480,0.85,30000,'British rear-engined short-haul jet, a 1960s rival to the DC-9.'),
  P('cv580','Convair 580','Convair','Turboprop',56,2900,9000,110,0.7,8500,'Turboprop conversion of the Convair 340/440 piston twins — a durable regional hauler.'),

  // ── Newest / modern variants ────────────────────────────────────────────────
  P('b737max8200','Boeing 737 MAX 8-200','Boeing','Narrow Body',200,6570,80000,320,0.82,56000,'High-density MAX 8 with an extra exit pair — the low-cost-carrier workhorse (think Ryanair).'),
  P('a330800','Airbus A330-800neo','Airbus','Wide Body',257,15100,250000,680,1.9,200000,'The smaller, ultra-long-range neo — efficient new engines on the proven A330 airframe.'),
  P('sj100new','Sukhoi Superjet SJ-100','Sukhoi','Regional Jet',103,3000,30000,290,0.63,24000,'Import-substituted update of the Superjet 100 with Russian systems and engines.'),
  P('mc21310','Irkut MC-21-310','Irkut','Narrow Body',211,5100,78000,360,0.8,56000,'Russian composite-wing narrowbody with domestic PD-14 engines — an A321neo competitor.'),
  P('c929','COMAC C929','COMAC','Wide Body',280,12000,240000,700,1.9,200000,'China\'s widebody ambition — a 280-seat twin aimed at the 787/A330neo class.'),

  // ── Regional & commuter ─────────────────────────────────────────────────────
  P('do328','Dornier 328','Dornier','Turboprop',33,1850,9000,95,0.62,8000,'Fast, quiet German regional turboprop with a wide stand-up cabin for its size.'),
  P('do328jet','Dornier 328JET','Dornier','Regional Jet',32,1665,14000,230,0.6,12000,'Jet-powered 328 — one of the smallest regional jets ever in airline service.'),
  P('do228','Dornier 228','Dornier','Turboprop',19,1110,4500,42,0.5,3600,'Rugged STOL commuter with a distinctive boxy fuselage — popular for island and bush work.'),
  P('emb120','Embraer EMB-120 Brasilia','Embraer','Turboprop',30,1750,7000,70,0.6,6000,'Sleek Brazilian 30-seat turboprop that built Embraer\'s regional reputation.'),
  P('js31','BAe Jetstream 31','British Aerospace','Turboprop',19,1260,4200,40,0.5,3400,'19-seat British commuter twin — a fixture of 1980s feeder networks.'),
  P('js41','BAe Jetstream 41','British Aerospace','Turboprop',29,1433,6500,62,0.58,5400,'Stretched Jetstream seating 29 — a step up into larger commuter markets.'),
  P('saab340a','Saab 340A','Saab','Turboprop',34,1430,7500,66,0.62,6400,'Early-build Saab 340 — affordable 34-seat regional twin for thin routes.'),
  P('dhc8100','De Havilland Dash 8-100','De Havilland Canada','Turboprop',39,1890,11000,90,0.7,9000,'The original Dash 8 — STOL-capable 39-seat regional turboprop.'),
  P('dhc8200','De Havilland Dash 8-200','De Havilland Canada','Turboprop',39,2084,12000,92,0.7,9500,'Higher-powered Dash 8-100 with better speed and hot-and-high performance.'),
  P('dash7','De Havilland Dash 7','De Havilland Canada','Turboprop',50,1300,12000,140,0.78,11000,'Four-engine STOL airliner able to use very short city-centre and mountain strips.'),
  P('ma60','Xian MA60','Xian','Turboprop',60,1600,12000,105,0.74,9600,'Chinese 60-seat turboprop developed from the An-24 lineage for domestic regional routes.'),
  P('ma600','Xian MA600','Xian','Turboprop',60,1600,13000,102,0.74,9800,'Modernized MA60 with glass cockpit and updated systems.'),
  P('c408','Cessna 408 SkyCourier','Cessna','Turboprop',19,1660,5500,48,0.52,4000,'New high-wing utility twin — 19 passengers or LD3-friendly freight for feeder operators.'),
  P('an24','Antonov An-24','Antonov','Turboprop',50,2400,8000,130,0.7,8500,'Tough Soviet high-wing turboprop built to operate from gravel and ice strips.'),
  P('emb110','Embraer EMB-110 Bandeirante','Embraer','Turboprop',18,1900,3800,42,0.5,3200,'Embraer\'s first airliner — a no-frills 18-seat utility commuter twin.'),

  // ── More freighters ─────────────────────────────────────────────────────────
  F('a350f','Airbus A350F','Airbus',109,8700,360000,720,2.0,250000,'Purpose-built widebody freighter on the A350 airframe — large main-deck door, efficient engines.'),
  F('b7778f','Boeing 777-8F','Boeing',112,8200,380000,770,2.0,250000,'Next-generation 777X freighter — the new flagship of the long-haul cargo fleet.'),
  F('b757200pf','Boeing 757-200PF','Boeing',39,5800,110000,460,0.9,85000,'Narrowbody express freighter — the backbone of integrators like UPS and FedEx.'),
  F('md11f','McDonnell Douglas MD-11F','McDonnell Douglas',91,7300,210000,810,2.0,185000,'Tri-jet freighter prized by cargo carriers long after passenger MD-11s retired.'),
  F('a300600f','Airbus A300-600F','Airbus',54,7400,150000,790,1.85,140000,'Widebody freighter workhorse — FedEx\'s most numerous type for years.'),
  F('dc1030f','McDonnell Douglas DC-10-30F','McDonnell Douglas',78,5900,150000,850,2.0,150000,'Converted tri-jet freighter with long legs and a big main deck.'),
  F('b737400f','Boeing 737-400F','Boeing',20,3500,60000,400,0.79,52000,'Classic 737 converted to carry parcels — ubiquitous regional cargo hauler.'),
  F('b737300f','Boeing 737-300F','Boeing',18,3400,55000,410,0.78,50000,'Earlier classic-737 freighter conversion for short-haul express networks.'),
  F('b727200f','Boeing 727-200F','Boeing',26,3500,50000,600,0.99,58000,'Tri-jet freighter that powered overnight express in the 1980s-90s.'),
  F('dc873f','Douglas DC-8-73F','Douglas',53,9000,80000,950,1.2,80000,'Re-engined long-range DC-8 freighter, valued for trans-ocean cargo runs.'),
  F('e190f','Embraer E190F','Embraer',13,4500,46000,285,0.63,33000,'Regional jet converted to freight — fills the gap below narrowbody cargo aircraft.'),
  F('a321p2f','Airbus A321P2F','Airbus',28,4300,70000,290,0.7,50000,'Passenger-to-freighter A321 — efficient narrowbody capacity for e-commerce growth.'),
  F('b767200sf','Boeing 767-200SF','Boeing',42,6000,150000,600,1.6,140000,'Special-freighter 767-200 conversion — a favorite of Amazon Air feeder fleets.'),
  F('an12','Antonov An-12','Antonov',20,3600,35000,480,1.0,40000,'Rugged Soviet turboprop freighter with a rear ramp for outsize and rough-field cargo.'),
];

// ── load + existing ids ───────────────────────────────────────────────────────
let src = fs.readFileSync(aircraftPath, 'utf8');
const existing = new Set([...src.matchAll(/\bid:\s*'([^']+)'/g)].map(m => m[1]));

// validate intra-batch uniqueness
const seen = new Set();
for (const a of NEW) {
  if (seen.has(a.id)) { console.error('DUPLICATE id in batch:', a.id); process.exit(1); }
  seen.add(a.id);
}

// ── format JS objects ─────────────────────────────────────────────────────────
const num = n => n.toLocaleString('en-US').replace(/,/g, '_'); // 12500000 -> 12_500_000
const esc = s => s.replace(/'/g, "\\'");
function fmt(a) {
  const price = a.weeklyLease * 250;
  const lines = [
    '  {',
    `    id: '${a.id}',`,
    `    name: '${esc(a.name)}',`,
    `    manufacturer: '${esc(a.manufacturer)}',`,
    `    category: '${a.category}',`,
    `    seats: ${a.seats},`,
    `    range: ${num(a.range)},`,
    `    weeklyLease:    ${num(a.weeklyLease)},`,
    `    purchasePrice: ${num(price)},`,
    `    fuelBurnPer100km: ${a.fuelBurnPer100km},`,
    `    crewCostPerKm: ${a.crewCostPerKm},`,
    `    baseMaintenancePerWk: ${num(a.baseMaintenancePerWk)},`,
  ];
  if (a.freighter) { lines.push('    freighter: true,'); lines.push(`    payloadTonnes: ${a.payloadTonnes},`); }
  lines.push(`    description: '${esc(a.description)}',`);
  lines.push(`    image: '',`);
  lines.push('  },');
  return lines.join('\n');
}

let added = 0;
const blocks = ['', '  // ══════════════════════════════════════════════════════════════════════════',
  `  // EXPANSION (${new Date().toISOString().slice(0,10)}) — added via tools/aircraft-expansion`,
  '  // historic/classic, modern variants, regional/commuter, and freighters',
  '  // ══════════════════════════════════════════════════════════════════════════'];
for (const a of NEW) {
  if (existing.has(a.id)) { console.log('skip (exists):', a.id); continue; }
  blocks.push(fmt(a)); added++;
}
const block = blocks.join('\n') + '\n';

const closeIdx = src.indexOf('\n];');
if (closeIdx === -1) { console.error('Could not find AIRCRAFT_TYPES close'); process.exit(1); }
src = src.slice(0, closeIdx) + '\n' + block + src.slice(closeIdx + 1);
fs.writeFileSync(aircraftPath, src);
console.log(`Inserted ${added} aircraft (of ${NEW.length}).`);
