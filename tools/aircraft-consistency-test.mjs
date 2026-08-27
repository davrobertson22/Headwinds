// Aircraft data consistency — guards the class of errors behind the 2026-07-28
// Discord reports ("744 is bigger than the 748 somehow", "ATR 72F is expensive
// as hell", the 767-200SF undercutting the 767-300F).
//
// Root causes these lock out:
//   1. A frame's fuelBurnPer100km entered at a fraction of its real burn. The
//      A380 (1197) and 747-8I (986) sat at ~65% of real burn while every other
//      type in the table sat at 92-98%, which made both read as impossibly
//      efficient and made the -8I's smaller exit limit look like a bug.
//   2. A freighter burning less than the identical passenger airframe it is
//      converted from (MD-11F 931 vs MD-11 1281; DC-10-30F 977 vs DC-10-30
//      1318; 747-400F 1150 vs 747-400 1608).
//   3. The 2026-06-17 expansion block priced used conversions on a different
//      scale to the original freighters and never gave them an old-airframe
//      maintenance penalty, so 40-year-old jets strictly beat new-builds.
//   4. (2026-07-29) The PRICE half of that same seam. Used conversions were
//      priced off scrap values (0.11-0.50 $M/tonne) and purpose-built freighters
//      off new-market values (1.3-2.1 $M/tonne) — a 21.6x spread in capital cost
//      against only a 2.7x spread in operating cost per tonne-km. Every modern
//      freighter in the game was dominated by a 1970s conversion. Fixed by
//      compressing the price band AND giving used conversions a real delivered
//      age (deliveredAgeWeeks), so they arrive on a higher maintenance
//      multiplier with fewer years of life left.
//
//   node tools/aircraft-consistency-test.mjs

import assert from 'node:assert/strict';
import { AIRCRAFT_TYPES, seatEfficiency } from '../src/data/aircraft.js';
import { AIRCRAFT_FAMILY, FAMILY_INFO, aircraftFamily } from '../src/data/families.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}

const BY_ID = Object.fromEntries(AIRCRAFT_TYPES.map(t => [t.id, t]));
const get = (id) => {
  const t = BY_ID[id];
  assert.ok(t, `aircraft id '${id}' no longer exists — update this test`);
  return t;
};
const perSeat  = (id) => get(id).fuelBurnPer100km / get(id).seats;
const perTonne = (id) => get(id).fuelBurnPer100km / get(id).payloadTonnes;
const maintPerTonne = (id) => get(id).baseMaintenancePerWk / get(id).payloadTonnes;

console.log('\nAircraft data consistency\n');

// ── 1. Same airframe, converted to freight, burns roughly the same ───────────
// A P2F/SF/BCF conversion is the same tube and the same engines. Its burn may
// differ a little (no cabin fit, higher payload) but never by tens of percent.

const TWINS = [
  ['b747400', 'b747400f'],
  ['b7478i',  'b7478f'],
  ['md11',    'md11f'],
  ['dc1030',  'dc1030f'],
  ['b767200er', 'b767200sf'],
  ['a300600r', 'a300600f'],
  ['b757200', 'b757200pf'],
];

for (const [pax, frt] of TWINS) {
  test(`${get(frt).name} burns in line with the ${get(pax).name} it is converted from`, () => {
    const ratio = get(frt).fuelBurnPer100km / get(pax).fuelBurnPer100km;
    assert.ok(
      ratio >= 0.85 && ratio <= 1.20,
      `${get(frt).name} burns ${get(frt).fuelBurnPer100km} vs ${get(pax).fuelBurnPer100km} (ratio ${ratio.toFixed(2)}) — same airframe, expected 0.85-1.20`,
    );
  });
}

// ── 2. Four engines never beat two on fuel per seat ──────────────────────────
// The bug that started this: the A380 read 1.40 L/seat/100km, better than a
// 787-9 (1.71), because its burn was entered ~35% low.

test('no four-engine double-decker is more fuel-efficient per seat than a 787-9', () => {
  const ref = perSeat('b7879');
  for (const id of ['a380', 'b7478i', 'b747400', 'b747300', 'b747100']) {
    assert.ok(
      perSeat(id) > ref,
      `${get(id).name} shows ${perSeat(id).toFixed(2)} L/seat/100km vs the 787-9's ${ref.toFixed(2)} — a quad cannot beat a modern twin`,
    );
  }
});

test('the most efficient large aircraft is a twinjet, not a jumbo', () => {
  const QUADS = ['a380', 'b7478i', 'b747400', 'b747300', 'b747100', 'b747200', 'b747sp',
                 'a340300', 'a340600', 'il96300', 'il86', 'dc863', 'b707320b'];
  const best = AIRCRAFT_TYPES
    .filter(t => !t.freighter && t.seats >= 250)
    .sort((a, b) => seatEfficiency(a) - seatEfficiency(b))[0];
  assert.ok(
    !QUADS.includes(best.id),
    `most efficient large aircraft is ${best.name} — expected a modern twin, not a four-engine type`,
  );
});

// ── 3. The 747 exit-limit quirk is intentional, and explained in-game ────────
// Boeing never re-certified the -8I's exit limit, so it is placarded for 605
// against the -400's 660 despite being 5.6 m longer. That is real, so the seat
// numbers stay — but the -8I must actually earn its price on efficiency, and
// the description has to tell the player why the newest 747 looks smaller.

test('the 747-400D is the only 747 certified for the 660-seat exit limit', () => {
  // 2026-07-29: the 660-seat placard moved off the -400 and onto the new -400D,
  // which is the only 747 Boeing ever certified for it (domestic high-density,
  // strengthened for the cycles, range cut to 4,000 km). Every other 747 sits at
  // the standard 605. So the -8I is no LARGER than the -400 — the check that
  // used to be a strict "<" is now "<=", and the 660 figure is pinned to the -400D
  // so a later edit cannot quietly hand it back to a long-range frame.
  assert.equal(get('b747400d').seats, 660);
  assert.ok(get('b747400').seats < get('b747400d').seats,
    'the -400D exists precisely because the standard -400 is not certified for 660');
  assert.ok(get('b747400d').range < get('b747400').range,
    'the -400D trades range for seats — if it matched the -400 on range it would strictly dominate it');
  assert.ok(get('b7478i').seats <= get('b747400').seats);
});

test('the 747-8I is meaningfully more efficient per seat than the -400', () => {
  const gain = 1 - perSeat('b7478i') / perSeat('b747400');
  assert.ok(
    gain > 0.03,
    `-8I is only ${(gain * 100).toFixed(1)}% better per seat than the -400 — it costs 3.5x as much, it has to earn that back`,
  );
});

test('the 747-8I description explains the exit limit', () => {
  assert.match(get('b7478i').description, /exit limit/i);
});

test('the 747-300 description explains why it matches the -400 on seats', () => {
  assert.match(get('b747300').description, /exit limit|-400 cabin/i);
});

// ── 3b. The 757 buys range, not economics (2026-07-29) ───────────────────────
// Discord: "why on earth is a 757-200 cheaper, bigger and more fuel efficient
// than a 737-800?" It was — and against the A320ceo, A320neo, A321ceo and
// Tu-204-100 too. Two rules collided:
//
//   a) docs/aircraft-price-audit.md prices out-of-production types at USED
//      market value. The 757 (production ended 2004) got $22M. Its peers were
//      priced off near-new transactions ($28M). But there is no age or
//      condition state on passenger types — the freighters got deliveredAgeWeeks
//      and the passenger table never did — so that $22M bought a zero-hour
//      airframe. A used price with no used airframe is a free lunch, not a
//      trade-off.
//   b) fuelBurnPer100km 476.25 put the 757 only 19% above a 737-800 on trip
//      fuel when the real gap is ~25-30%. Spread over the 757's exit-limit 239
//      seats, that made it BETTER per seat than a 737-800 — the reverse of why
//      airlines actually retired them.
//
// Seats stay at the 239 exit limit (Dave's call — changing them would cut
// capacity on live saves), so price and fuel carry the whole correction.
// The 757's edge is meant to be range and payload out of short fields, paid
// for with worse seat-mile costs. These lock that shape in.

test('the 757-200 costs more than the narrowbodies it outsizes', () => {
  // Only the mainstream 189/195-seat rivals. The A321ceo is deliberately NOT
  // here: at $34M it stays dearer than the 757-200, and that is the intended
  // shape — a newer airframe costs more up front and earns it back on fuel.
  // The invariant is that the 757 never wins BOTH at once; see the last test
  // in this section.
  const t = get('b757200');
  for (const id of ['b737800', 'a320ceo']) {
    const rival = get(id);
    assert.ok(t.purchasePrice > rival.purchasePrice,
      `757-200 $${(t.purchasePrice / 1e6).toFixed(0)}M vs ${rival.name} $${(rival.purchasePrice / 1e6).toFixed(0)}M — ` +
      `a bigger, longer-ranged airframe cannot also be the cheaper one`);
    assert.ok(t.weeklyLease > rival.weeklyLease,
      `757-200 lease $${(t.weeklyLease / 1000).toFixed(1)}k vs ${rival.name} $${(rival.weeklyLease / 1000).toFixed(1)}k`);
  }
});

test('the 757-200 burns more per seat than the narrowbodies it competes with', () => {
  const worse = [];
  // a320ceo is NOT here: once its exit limit was corrected to 186 (see 3c) it
  // became a genuinely smaller aircraft, and a 239-seat 757 out-economising a
  // 186-seat A320 per seat is just size doing its job. The 757 no longer
  // dominates it overall — it now costs $31M against the A320ceo's $28M.
  for (const id of ['b737800', 'a320neo', 'a321ceo']) {
    if (perSeat('b757200') <= perSeat(id)) {
      worse.push(`${get(id).name} ${perSeat(id).toFixed(3)}`);
    }
  }
  assert.deepEqual(worse, [],
    `757-200 is ${perSeat('b757200').toFixed(3)} L/seat/100km and must be WORSE than each of these — ` +
    `a 1983 airframe at exit-limit density cannot out-economise an A320neo`);
});

test('the 757-200 trip-fuel premium over a 737-800 matches the real ~25-30%', () => {
  const ratio = get('b757200').fuelBurnPer100km / get('b737800').fuelBurnPer100km;
  assert.ok(ratio >= 1.22 && ratio <= 1.33,
    `757-200 burns ${ratio.toFixed(3)}x a 737-800's trip fuel — real-world is ~1.25-1.30x`);
});

test('the 757-300 is a stretch of the -200, not a free upgrade over it', () => {
  const a = get('b757200'), b = get('b757300');
  assert.ok(b.fuelBurnPer100km > a.fuelBurnPer100km,
    `-300 burns ${b.fuelBurnPer100km} vs -200 ${a.fuelBurnPer100km} — a longer fuselage cannot burn less`);
  assert.ok(b.purchasePrice > a.purchasePrice && b.weeklyLease > a.weeklyLease,
    `-300 must cost more than the -200 it stretches`);
});

test('no 757 variant dominates a rival on capital AND seat-mile fuel at once', () => {
  // The general form of the Discord report: within the narrowbody class, being
  // bigger and longer-legged must cost something. Scoped to the 757s because
  // the wider catalogue deliberately prices obsolete types at used value.
  const nb = AIRCRAFT_TYPES.filter(t => t.category === 'Narrow Body' && !t.freighter && t.seats > 0);
  const bad = [];
  for (const a of nb.filter(t => t.id.startsWith('b757'))) {
    for (const b of nb) {
      if (a.id === b.id) continue;
      if (a.seats >= b.seats && a.range >= b.range && (a.runwayFt || 0) <= (b.runwayFt || 0)
        && a.purchasePrice <= b.purchasePrice && a.weeklyLease <= b.weeklyLease
        && a.fuelBurnPer100km / a.seats <= b.fuelBurnPer100km / b.seats
        && a.crewCostPerKm / a.seats <= b.crewCostPerKm / b.seats) {
        bad.push(`${b.name} < ${a.name}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

// ── 3c. Narrowbody ladder inversions (2026-07-29, round 2) ───────────────────
// Fallout from the 757 sweep. Four more errors of the same family:
//
//   a) `a320ceo` carried 195 seats — the NEO's Cabin-Flex exit limit applied to
//      the ceo. A real A320ceo maxes at 180, or 186 with Space-Flex (what
//      easyJet and Vueling actually fly). Those 9 phantom seats made the
//      A320ceo dominate the 737-800 on ALL EIGHT axes.
//   b) `c919` burned 381 for 192 seats — the second-best seat-mile figure of
//      any narrowbody, better than an A320neo. Real reporting has the C919
//      LAGGING both the A320neo and the MAX 8. Corrected to 400, and the price
//      dropped $52M → $46M to match: once it is honestly the thirstier jet it
//      cannot also be the dearer one, which is the C919's whole real-world
//      pitch (nobody pays a premium for it).
//   c) `b737900er` sat at $136k/seat — BELOW the older 737-800 ($148k) and
//      A320ceo. A 2007 airframe cannot be cheaper per seat than its own
//      predecessors. Same used-value-with-no-age-model trap as the 757.
//   d) `a319ceo` and `b737700` were priced IDENTICALLY ($16M/$40k) while the
//      A319 wins seats, range and runway. Identical pricing is what turns a
//      real-world near-tie into strict dominance; the more capable airframe
//      now costs more.

test('the A320ceo carries its own exit limit, not the neo\'s', () => {
  const s = get('a320ceo').seats;
  assert.ok(s <= 186,
    `A320ceo at ${s} seats — the ceo maxes at 180, or 186 with Space-Flex. ` +
    `194-195 is the A320neo's Cabin-Flex figure and does not belong here`);
  assert.ok(s < get('b737800').seats,
    `the 737-800's 189 exit limit is the larger of the two — that is the whole ` +
    `reason it competes with the A320 on trip cost`);
});

test('the C919 lags the A320neo and MAX 8 on seat-mile fuel', () => {
  const worse = ['a320neo', 'b737max8'].filter(id => perSeat('c919') <= perSeat(id));
  assert.deepEqual(worse.map(id => get(id).name), [],
    `C919 is ${perSeat('c919').toFixed(3)} L/seat/100km and must be WORSE than these — ` +
    `a first-generation airframe on the same LEAP core does not beat them`);
});

test('the C919 is cheaper than the A320neo it cannot out-burn', () => {
  assert.ok(get('c919').purchasePrice < get('a320neo').purchasePrice,
    `a thirstier jet priced above the one it loses to is dead catalogue weight — ` +
    `nobody would ever buy it. Its real pitch is that airlines will not pay more`);
});

test('no narrowbody is cheaper per seat than an older one from the same family', () => {
  const perSeatPrice = (id) => get(id).purchasePrice / get(id).seats;
  const PAIRS = [['b737900er', 'b737800'], ['b737max9', 'b737max8'], ['a321ceo', 'a320ceo']];
  const bad = PAIRS.filter(([newer, older]) => perSeatPrice(newer) < perSeatPrice(older))
    .map(([n, o]) => `${get(n).name} $${(perSeatPrice(n) / 1000).toFixed(0)}k/seat < ${get(o).name} $${(perSeatPrice(o) / 1000).toFixed(0)}k/seat`);
  assert.deepEqual(bad, []);
});

test('the A319ceo and 737-700 each give something up to the other', () => {
  // They are a real-world near-tie. Identical price AND lease is what made the
  // A319 strictly better — it already wins seats, range and runway.
  const a = get('a319ceo'), b = get('b737700');
  assert.ok(a.purchasePrice !== b.purchasePrice,
    `A319ceo and 737-700 are both $${(a.purchasePrice / 1e6).toFixed(0)}M — the more capable ` +
    `airframe has to cost more, or it strictly dominates`);
  assert.ok(a.purchasePrice > b.purchasePrice && a.weeklyLease > b.weeklyLease,
    'the A319 wins seats, range and runway, so it is the one that costs more');
});

// ── 3d. Full-table audit (2026-07-29) ────────────────────────────────────────
// docs/aircraft-data-audit-2026-07-29.md — 33 field corrections found by checking
// every jet against real specs. Two reusable techniques came out of it:
//
//   1. The table's fuel figures were derived from operational BLOCK-HOUR (kg/h)
//      data ÷ an assumed cruise speed. `il96300`'s 1150.25 matches a published
//      Russian Transport Clearing House figure of 7,818 kg/h ÷ 850 km/h to
//      within 0.05%, and the same source reproduces the A320/A321 rows. So to
//      sanity-check any fuel value, multiply back out:
//        implied kg/h = fuelBurnPer100km × 0.008 × cruise_km_h
//      and compare against published block data. Every error found was a type
//      that had fallen off that scale — in BOTH directions.
//   2. Fuel ÷ fuselage length is near-constant within a generation (737 NG
//      10.12-10.14, MAX 9.42-9.67). That is how the MAX 8-200 was caught: 8.10.
//
// The tests below lock the structural relationships, not the individual numbers.

test('a shrink never out-burns the stretch it shrinks, within a generation', () => {
  // Each group is ONE generation, ordered small → large. A later variant is a
  // longer tube on the same wing and engine, so it must burn more per trip.
  const GENERATIONS = {
    'A330neo':  ['a330800', 'a330neo'],
    'A220':     ['a220100', 'a220'],
    'MAX':      ['b737max7', 'b737max8', 'b737max9', 'b737max10'],
    '737 NG':   ['b737700', 'b737800', 'b737900er'],
    'A320neo':  ['a319neo', 'a320neo', 'a321neo'],
    'A320ceo':  ['a319ceo', 'a320ceo', 'a321ceo'],
    '757':      ['b757200', 'b757300'],
    '787':      ['b7878', 'b7879', 'b787x10'],
    'E-Jet E2': ['e175e2', 'e190e2', 'e195e2'],
    'E-Jet E1': ['e175', 'e190', 'e195'],
    'CRJ':      ['crj700', 'crj900', 'crj1000'],
  };
  const bad = [];
  for (const [fam, ids] of Object.entries(GENERATIONS)) {
    const list = ids.map(get);
    for (let i = 0; i < list.length - 1; i++) {
      const small = list[i], large = list[i + 1];
      if (large.fuelBurnPer100km <= small.fuelBurnPer100km) {
        bad.push(`${fam}: ${large.name} ${large.fuelBurnPer100km} <= ${small.name} ${small.fuelBurnPer100km}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'a longer fuselage on the same wing and engine cannot burn less');
});

test('a bigger freighter of the same generation burns more, and carries it cheaper', () => {
  // The freighters sit outside the shrink/stretch GENERATIONS map above, so nothing
  // was checking them. The 737-300F was entered at 410 L/100km — 15% above published
  // block fuel, while its own pax sibling sat within 1% — which left the 18-tonne
  // -300F burning MORE per trip than the larger 20-tonne -400F. A shorter tube on
  // the same wing and engine cannot do that, and the payload ladder has to reward
  // size the way the seat ladder does.
  const GENERATIONS = { 'Classic F': ['b737300f', 'b737400f'] };
  const bad = [];
  for (const [fam, ids] of Object.entries(GENERATIONS)) {
    const list = ids.map(get);
    for (let i = 0; i < list.length - 1; i++) {
      const small = list[i], large = list[i + 1];
      if (large.fuelBurnPer100km <= small.fuelBurnPer100km) {
        bad.push(`${fam}: ${large.name} burns ${large.fuelBurnPer100km} <= ${small.name} ${small.fuelBurnPer100km}`);
      }
      const ls = small.fuelBurnPer100km / small.payloadTonnes;
      const ll = large.fuelBurnPer100km / large.payloadTonnes;
      if (ll >= ls) bad.push(`${fam}: ${large.name} ${ll.toFixed(2)} L/tonne >= ${small.name} ${ls.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the MAX 8-200 burns at least as much as the MAX 8 it is built from', () => {
  // Same fuselage, same LEAP-1B, same MTOW, one extra exit pair, ~450 kg more
  // OEW. It was entered at 320 against the MAX 8's 382 — 16% less, which made it
  // the most efficient narrowbody in the game by a 12% margin.
  const a = get('b737max8'), b = get('b737max8200');
  assert.ok(b.fuelBurnPer100km >= a.fuelBurnPer100km,
    `MAX 8-200 burns ${b.fuelBurnPer100km} vs MAX 8 ${a.fuelBurnPer100km} — identical airframe, and the -200 is heavier`);
  // 2026-08-26: the seat counts were the wrong way round. 210 is the -200's
  // certified maximum, not the MAX 8's — the MAX 8 is the same fuselage as the
  // 737-800, which this table already lists at its true 189-seat exit limit, and
  // EASA certifies the -200 at 202 on the strength of its extra mid-cabin exit
  // pair (ten doors against eight). The old assertion tried to compensate for the
  // inversion with a discount, which could never work: $2M off against $72/seat/wk
  // of worse economics never pays back, so the -200 was dead catalogue weight.
  assert.ok(b.seats > a.seats,
    'the -200 exists to carry MORE than a MAX 8 — that is what the extra exit pair buys');
  assert.ok(b.purchasePrice > a.purchasePrice,
    'the higher-density variant is the one that costs more');
  assert.equal(a.seats, get('b737800').seats,
    'the MAX 8 is the 737-800 fuselage — same exits, same certified maximum');
});

test('the MAX 8-200 actually beats the MAX 8 on the metric it exists for', () => {
  // A denser variant that costs more per seat to run has no reason to exist. Held
  // at a realistic 40,000 km/wk (~70 block-hours, the 9-11h/day the NWR cap note
  // cites), leased, so lease + maintenance + fuel + crew all count.
  const KM = 40_000, FUEL = 1.45, INSURANCE = 12_000;
  const perSeatWk = (t) => (
    (t.fuelBurnPer100km / 100) * KM * FUEL
    + t.crewCostPerKm * KM
    + t.baseMaintenancePerWk
    + t.weeklyLease
    + INSURANCE
  ) / t.seats;
  const a = get('b737max8'), b = get('b737max8200');
  assert.ok(perSeatWk(b) < perSeatWk(a),
    `MAX 8-200 costs $${perSeatWk(b).toFixed(0)}/seat/wk against the MAX 8's `
    + `$${perSeatWk(a).toFixed(0)} — it carries more seats and costs more to buy, so if it `
    + 'also costs more per seat to fly, nobody has a reason to order one');
});

test('per-seat fuel improves as the MAX gets longer', () => {
  // The failure this locks out: with the MAX 8 inflated to the -200's 210 seats,
  // correcting it to 189 left the SHORTER MAX 7 looking more efficient per seat,
  // because 296 was the -700's burn x the per-aircraft re-engine factor and the
  // MAX 7 is a stretch of the -700, not a same-length re-engine.
  const ids = ['b737max7', 'b737max8', 'b737max9'];
  const bad = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const small = get(ids[i]), large = get(ids[i + 1]);
    const ls = small.fuelBurnPer100km / small.seats, ll = large.fuelBurnPer100km / large.seats;
    if (ll >= ls) bad.push(`${large.name} ${ll.toFixed(3)} L/seat >= ${small.name} ${ls.toFixed(3)}`);
  }
  assert.deepEqual(bad, [], 'a longer tube on the same wing carries its seats more cheaply');
});

test('the MAX range ladder shortens as the fuselage lengthens', () => {
  // Boeing's own table was read one row down: the MAX 9 carried the MAX 8's
  // range and the MAX 10 carried the MAX 9's.
  const ids = ['b737max7', 'b737max8', 'b737max9', 'b737max10'];
  const bad = [];
  for (let i = 0; i < ids.length - 1; i++) {
    if (get(ids[i + 1]).range >= get(ids[i]).range) {
      bad.push(`${get(ids[i + 1]).name} ${get(ids[i + 1]).range} >= ${get(ids[i]).name} ${get(ids[i]).range}`);
    }
  }
  assert.deepEqual(bad, [], 'each MAX stretch trades range for length');
});

test('the A220-100 out-ranges the A220-300 it shrinks', () => {
  // Airbus: -100 = 3,600 nm, -300 = 3,400 nm. The lighter shrink really does fly
  // further — the table had it 1,000 km short AND in the wrong order.
  assert.ok(get('a220100').range > get('a220').range,
    `A220-100 ${get('a220100').range} km vs A220-300 ${get('a220').range} km`);
});

test('every neo and E2 earns a real generational gain per seat', () => {
  // a319neo sat at 337 against the A319ceo's 336.75 — a 0% gain, the only neo in
  // the table with none. The E2s were at roughly a third of Embraer's published
  // flight-test numbers (17.3% for the E190-E2, 25.4%/seat for the E195-E2).
  const PAIRS = [
    ['a319neo', 'a319ceo', 0.04], ['a320neo', 'a320ceo', 0.04], ['a321neo', 'a321ceo', 0.04],
    ['b737max7', 'b737700', 0.03], ['b737max8', 'b737800', 0.03], ['b737max9', 'b737900er', 0.03],
    ['e175e2', 'e175', 0.05], ['e190e2', 'e190', 0.10], ['e195e2', 'e195', 0.15],
  ];
  const bad = [];
  for (const [neo, ceo, minGain] of PAIRS) {
    const gain = 1 - perSeat(neo) / perSeat(ceo);
    if (gain < minGain) bad.push(`${get(neo).name} only ${(gain * 100).toFixed(1)}% better per seat than the ${get(ceo).name} (need ${(minGain * 100).toFixed(0)}%)`);
  }
  assert.deepEqual(bad, []);
});

test('no regional jet burns like a narrowbody, and none is impossibly frugal', () => {
  // The 328JET implied ~1,390 kg/h for a 15.7 t twinjet — more than the table's
  // own 24 t CRJ-200 (~1,034 kg/h). Its 6.890 L/seat was 2.2x every other RJ.
  const rj = AIRCRAFT_TYPES.filter(t => t.category === 'Regional Jet' && !t.freighter && t.seats > 0);
  // Scoped to 1990-on. The 1960s trijets really were this bad — the Yak-40 at
  // 6.99 L/seat implies ~1,230 kg/h for 40 seats, which matches reality.
  const out = rj.filter(t => (t.eis ?? 0) >= 1990)
    .filter(t => perSeat(t.id) > 5.0 || perSeat(t.id) < 1.5)
    .map(t => `${t.name} ${perSeat(t.id).toFixed(3)} L/seat/100km`);
  assert.deepEqual(out, [], 'post-1990 regional jets sit between roughly 1.8 and 4.7 L/seat/100km');
});

test('the four-engine long-haulers are thirsty but not absurd', () => {
  // a340300 implied ~9,210 kg/h against a published 6-7 t/h, and 9 t/h is the
  // figure quoted for the LARGER -600. Both were set well above the scale the
  // rest of the table uses.
  const impliedKgH = (id) => get(id).fuelBurnPer100km * 0.008 * 900;
  for (const id of ['a340300', 'a340600', 'md11']) {
    const kgh = impliedKgH(id);
    assert.ok(kgh > 4_000 && kgh < 11_000,
      `${get(id).name} implies ${Math.round(kgh).toLocaleString()} kg/h — outside the plausible widebody band`);
  }
  assert.ok(impliedKgH('a340300') < impliedKgH('a340600'),
    'the A340-600 is the longer, thirstier jet');
});

test('the MC-21-310 is the worse of the two MC-21s', () => {
  // Russian PD-14 engines (~5% behind the PW1400G) on an airframe ~5.75 t
  // heavier, and UAC has revised the declared range down to 3,830 km. It was
  // entered burning 7% LESS than the -300 at the same price.
  const a = get('mc21300'), b = get('mc21310');
  assert.ok(b.fuelBurnPer100km > a.fuelBurnPer100km,
    `MC-21-310 burns ${b.fuelBurnPer100km} vs the -300's ${a.fuelBurnPer100km}`);
  assert.ok(b.range < a.range, 'the -310 gives up range too');
  assert.ok(b.purchasePrice < a.purchasePrice,
    'worse on both fuel and range, so it cannot cost the same as the -300');
});

// ── 4. Freighter pricing sits on one scale ───────────────────────────────────

test('the ATR 72-600F is priced off its passenger sibling, not 20% above it', () => {
  const ratio = get('atr72f').purchasePrice / get('atr72').purchasePrice;
  assert.ok(
    ratio <= 1.10,
    `ATR 72-600F is $${(get('atr72f').purchasePrice / 1e6).toFixed(0)}M against the -600's $${(get('atr72').purchasePrice / 1e6).toFixed(0)}M (${ratio.toFixed(2)}x) — same airframe, freight door`,
  );
});

test('the 767-200SF does not out-burn the newer 767-300F per tonne', () => {
  assert.ok(
    perTonne('b767200sf') > perTonne('b767300f'),
    `767-200SF ${perTonne('b767200sf').toFixed(2)} vs 767-300F ${perTonne('b767300f').toFixed(2)} L/tonne — the older, smaller conversion cannot be the efficient one`,
  );
});

// Old airframes are cheap to buy and cheap to lease. They must not also be
// cheap to maintain, or there is no reason to ever buy a new freighter.
const CLASSIC_FREIGHTERS = [
  'b727200f', 'dc873f', 'dc1030f', 'md11f', 'an12', 'an124',
  'b737300f', 'b737400f', 'b757200pf', 'a300600f', 'b767200sf', 'b747400f', 'an225',
];

test('every classic freighter conversion carries an old-airframe maintenance penalty', () => {
  const newBuildCeiling = Math.max(
    ...['b767300f', 'a330200f', 'b777f', 'b7478f', 'a350f', 'b7778f'].map(maintPerTonne),
  );
  for (const id of CLASSIC_FREIGHTERS) {
    assert.ok(
      maintPerTonne(id) >= newBuildCeiling,
      `${get(id).name} costs $${Math.round(maintPerTonne(id))}/tonne/wk to maintain, under the $${Math.round(newBuildCeiling)} worst new-build — a 40-year-old jet cannot be the cheap one to keep flying`,
    );
  }
});

// ── 5. Whole-table guards ────────────────────────────────────────────────────

test('every type leases for 8-15% of its purchase price a year', () => {
  const bad = AIRCRAFT_TYPES
    .map(t => ({ t, pct: (t.weeklyLease * 52) / t.purchasePrice * 100 }))
    .filter(({ pct }) => pct < 8 || pct > 15);
  assert.deepEqual(
    bad.map(({ t, pct }) => `${t.name} ${pct.toFixed(1)}%`), [],
  );
});

test('no freighter is strictly dominated by another', () => {
  const f = AIRCRAFT_TYPES.filter(t => t.freighter);
  const dominated = [];
  for (const b of f) {
    for (const a of f) {
      if (a.id === b.id) continue;
      const better = a.payloadTonnes >= b.payloadTonnes && a.range >= b.range
        && (a.runwayFt || 0) <= (b.runwayFt || 0)
        && a.purchasePrice <= b.purchasePrice && a.weeklyLease <= b.weeklyLease
        && a.baseMaintenancePerWk <= b.baseMaintenancePerWk
        && a.fuelBurnPer100km / a.payloadTonnes <= b.fuelBurnPer100km / b.payloadTonnes;
      if (better) dominated.push(`${b.name} < ${a.name}`);
    }
  }
  assert.deepEqual(dominated, []);
});

test('no modern widebody is Pareto-dominated by another (2026-08-24 rebalance)', () => {
  // Three new-build widebodies used to lose on EVERY axis to a cheaper rival —
  // the 787-10 and C929 to the A330neo, the 777X-8 to the A350-900ULR — so they
  // were traps, never a real choice. Each must now win at least one axis. This
  // is a TARGETED guard (a whole-table sweep lights up on the many intentional
  // cheap-but-thirsty used frames); it locks only the pairs the rebalance fixed.
  const pairs = [['b787x10', 'a330neo'], ['c929', 'a330neo'], ['b7778x', 'a350900ulr']];
  const dominated = [];
  for (const [loserId, winnerId] of pairs) {
    const b = BY_ID[loserId], a = BY_ID[winnerId];
    // `a` WEAKLY dominates `b` (a trap) when it is at-least-as-good on every axis.
    const weaklyDom = a.seats >= b.seats && a.range >= b.range
      && a.purchasePrice <= b.purchasePrice && a.weeklyLease <= b.weeklyLease
      && a.baseMaintenancePerWk <= b.baseMaintenancePerWk
      && (a.runwayFt || 0) <= (b.runwayFt || 0)
      && a.fuelBurnPer100km <= b.fuelBurnPer100km
      && a.crewCostPerKm <= b.crewCostPerKm;
    if (weaklyDom) dominated.push(`${b.name} <= ${a.name} (wins no axis)`);
  }
  assert.deepEqual(dominated, []);
});

// ── 6. Freighter capital cost (2026-07-29) ───────────────────────────────────
// The failure these lock out: prices set from real transaction values in two
// independently-calibrated populations. Each price was individually defensible;
// the TABLE was unplayable. Assert on the internal spread, not on absolutes.

const FREIGHTERS = AIRCRAFT_TYPES.filter(t => t.freighter);
const pricePerTonne = (t) => t.purchasePrice / 1e6 / t.payloadTonnes;

test('freighter $M-per-tonne spread stays under 10x', () => {
  const vals = FREIGHTERS.map(pricePerTonne);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const cheapest = FREIGHTERS.find(t => pricePerTonne(t) === lo);
  const dearest  = FREIGHTERS.find(t => pricePerTonne(t) === hi);
  assert.ok(hi / lo < 10,
    `capital cost spans ${(hi / lo).toFixed(1)}x (${cheapest.name} $${lo.toFixed(2)}M/t vs ` +
    `${dearest.name} $${hi.toFixed(2)}M/t). Operating cost only spans ~2.7x, so anything ` +
    `wider makes price — not efficiency — decide every purchase.`);
});

test('no freighter is priced off scrap value while others are priced off market', () => {
  // Guards the specific regression: a classic conversion priced from what a
  // 40-year-old hull actually fetches, sitting in the same buy menu as a
  // new-build priced from market value. Pre-fix, the DC-8-73F, DC-10-30F and
  // 727-200F all sat below an eighth of the cheapest new-build per tonne.
  const NEW_BUILDS = ['b767300f', 'a330200f', 'b777f', 'b7478f', 'a350f', 'b7778f', 'atr72f'];
  const floor = Math.min(...NEW_BUILDS.map(id => pricePerTonne(get(id)))) / 8;
  const tooCheap = FREIGHTERS.filter(t => pricePerTonne(t) < floor);
  assert.deepEqual(tooCheap.map(t => `${t.name} $${pricePerTonne(t).toFixed(2)}M/t`), [],
    `(scrap-pricing floor is $${floor.toFixed(2)}M/t)`);
});

test('every used conversion arrives used, and every new-build arrives new', () => {
  // deliveredAgeWeeks is the counterweight that lets classics stay cheap without
  // dominating: they start on a higher maintenanceMultiplier and depreciate from
  // their delivered value. Without it, a DC-8-73F is a zero-hour airframe.
  const IN_PRODUCTION = ['b767300f', 'a330200f', 'b777f', 'b7478f', 'a350f', 'b7778f', 'atr72f'];
  const wrong = [];
  for (const t of FREIGHTERS) {
    const age = t.deliveredAgeWeeks ?? 0;
    const shouldBeNew = IN_PRODUCTION.includes(t.id);
    if (shouldBeNew && age !== 0) wrong.push(`${t.name} is in production but delivers ${age / 52}y old`);
    if (!shouldBeNew && age < 5 * 52) wrong.push(`${t.name} is a used conversion but delivers ${age / 52}y old`);
  }
  assert.deepEqual(wrong, []);
});

test('no freighter delivers older than 20y — the maintenance curve is quadratic', () => {
  // maintenanceMultiplier = 1 + (age/20)^2 * 2, so 30y = 5.5x base. Pairing that
  // with a large baseMaintenancePerWk makes a type loss-making on every lane.
  const tooOld = FREIGHTERS.filter(t => (t.deliveredAgeWeeks ?? 0) > 20 * 52);
  assert.deepEqual(tooOld.map(t => `${t.name} ${(t.deliveredAgeWeeks / 52).toFixed(0)}y`), []);
});

test('older freighters are cheaper per tonne than newer ones', () => {
  // Monotonicity: sort by delivered age, and price-per-tonne should trend down.
  // Catches a future edit that makes a classic dearer than a new-build.
  const oldest = FREIGHTERS.filter(t => (t.deliveredAgeWeeks ?? 0) >= 14 * 52);
  const newest = FREIGHTERS.filter(t => (t.deliveredAgeWeeks ?? 0) === 0);
  const dearestOld  = Math.max(...oldest.map(pricePerTonne));
  const cheapestNew = Math.min(...newest.map(pricePerTonne));
  assert.ok(dearestOld < cheapestNew,
    `the dearest 16y-old conversion ($${dearestOld.toFixed(2)}M/t) must cost less per tonne ` +
    `than the cheapest new-build ($${cheapestNew.toFixed(2)}M/t)`);
});

test('every freighter carries its own cruise speed', () => {
  // Freighters share one category, so CRUISE_SPEED_KMH cannot step them — they
  // all silently fell back to 840 km/h, including the ATR 72 turboprop.
  const missing = FREIGHTERS.filter(t => !(t.cruiseKmh > 0));
  assert.deepEqual(missing.map(t => t.id), []);
  const turboprops = FREIGHTERS.filter(t => t.cruiseKmh < 600);
  assert.ok(turboprops.length >= 2,
    'the ATR 72-600F and An-12 are turboprops and must cruise well under 600 km/h');
});

test('payload tonnage matches real max structural payload', () => {
  const REAL = { atr72f: 8.6, e190f: 13.5, b737300f: 17.5, b737400f: 20, an12: 20,
    b737800bcf: 23.9, b727200f: 26, a321p2f: 27.9, b757200pf: 39.8, b767200sf: 42,
    b767300f: 52.7, dc873f: 48, a300600f: 54, a330200f: 70, dc1030f: 77, md11f: 91,
    b777f: 102, a350f: 109, b747400f: 112, b7778f: 112.3, an124: 120, b7478f: 137.7,
    an225: 250 };
  const off = FREIGHTERS
    .filter(t => REAL[t.id] && Math.abs(t.payloadTonnes - REAL[t.id]) / REAL[t.id] > 0.08)
    .map(t => `${t.name} ${t.payloadTonnes}t vs real ${REAL[t.id]}t`);
  assert.deepEqual(off, []);
});

test('every aircraft carries the fields the market card renders', () => {
  const missing = AIRCRAFT_TYPES.filter(t =>
    !t.name || !t.description || !t.image || !t.category
    || !(t.range > 0) || !(t.purchasePrice > 0) || !(t.weeklyLease > 0)
    || !(t.fuelBurnPer100km > 0) || !(t.baseMaintenancePerWk > 0)
    || !(t.freighter ? t.payloadTonnes > 0 : t.seats > 0));
  assert.deepEqual(missing.map(t => t.id), []);
});


// ── 7. Every type has a maintenance family (2026-08-12) ──────────────────────
// data/families.js is a hand-maintained id → family map, and nothing forced it
// to keep up with data/aircraft.js. It had drifted to 92 of 164 entries. An
// unmapped type is INVISIBLE to activeFamilies(), which means:
//
//   * weeklyFamilyBaseCost() charges it $0 — the whole outsourced-MRO contract
//     line disappears for that airframe;
//   * fleetComplexityMultiplier() does not count it, so adding a wholly new
//     type to the fleet costs nothing in split pilot pools or type ratings;
//   * resolveBaseFor() (data/mroBase.js) returns null for it — no jet-base line
//     factor, no AOG reduction, and no family a base can even be certified for.
//
// All 23 freighters were unmapped, so a cargo-only airline paid nothing at all
// and opened Maintenance → MRO Network to an empty certification list: the
// feature was unreachable for freight. The 737 MAX 8-200 was unmapped while the
// MAX 8 it is built from cost $42,000/wk, and the E195 was unmapped while the
// E190 cost $23,000/wk — the same airframe and tooling, one of them free.
//
// This is the assertion that would have caught it. The invariant is TOTAL: a
// genuinely one-off airframe gets its own single-type family rather than being
// left out, because "no plausible commonality group" means full freight, not free.

test('every aircraft type belongs to a maintenance family', () => {
  const orphans = AIRCRAFT_TYPES.filter(t => !aircraftFamily(t.id)).map(t => `${t.id} (${t.name})`);
  assert.deepEqual(orphans, [],
    `${orphans.length} of ${AIRCRAFT_TYPES.length} types have no entry in AIRCRAFT_FAMILY. ` +
    `An unmapped type pays $0 weeklyFamilyBaseCost, adds nothing to fleetComplexityMultiplier, ` +
    `and resolveBaseFor() returns null for it — no base can be certified for a family it has none of`);
});

test('every AIRCRAFT_FAMILY key is a real aircraft type', () => {
  // The complement: a stale key is a silent typo. `b737max8200` mapped as
  // `b737max8_200` would leave the real type unmapped while the map still
  // looked complete, so the first test alone is not enough.
  const ids = new Set(AIRCRAFT_TYPES.map(t => t.id));
  const ghosts = Object.keys(AIRCRAFT_FAMILY).filter(id => !ids.has(id));
  assert.deepEqual(ghosts, [],
    'AIRCRAFT_FAMILY maps ids that do not exist in AIRCRAFT_TYPES — a rename or a typo');
});

test('every family referenced by the map has a FAMILY_INFO entry', () => {
  // weeklyFamilyBaseCost() falls back to `?? 0` on a missing entry, so a family
  // key with no metadata is the same free ride as no key at all — just harder
  // to see, because activeFamilies() reports the aircraft as covered.
  const missing = [...new Set(Object.values(AIRCRAFT_FAMILY))].filter(f => !FAMILY_INFO[f]);
  assert.deepEqual(missing, []);
});

test('every family costs something and carries a renderable category', () => {
  const bad = Object.entries(FAMILY_INFO)
    .filter(([, i]) => !(i.weeklyBaseCost > 0) || !i.name || !i.category)
    .map(([k]) => k);
  assert.deepEqual(bad, []);
});

test('every freighter is grouped with the airframe it is converted from', () => {
  // A P2F/SF/BCF conversion is the same tube, the same engines and the same type
  // rating as its passenger sibling, so it must reuse that family rather than
  // getting one of its own. TWINS is the pax↔freight pairing already used by the
  // fuel-burn checks at the top of this file; reuse it so the two cannot drift.
  const split = TWINS
    .filter(([pax, frt]) => aircraftFamily(pax) !== aircraftFamily(frt))
    .map(([pax, frt]) => `${get(frt).name} is ${aircraftFamily(frt)} but ${get(pax).name} is ${aircraftFamily(pax)}`);
  assert.deepEqual(split, []);
});

test('no freighter sits in a family of its own invention', () => {
  // Every freighter's family must also be flown by something else — either its
  // passenger sibling or another freighter of the same airframe. The exceptions
  // are the two purpose-built outsize Antonovs, which have no passenger version
  // anywhere in the catalogue and legitimately carry their own family.
  const ALLOWED_FREIGHT_ONLY = new Set(['antonov_an124', 'antonov_an12']);
  const lonely = AIRCRAFT_TYPES.filter(t => t.freighter).filter((t) => {
    const fam = aircraftFamily(t.id);
    if (ALLOWED_FREIGHT_ONLY.has(fam)) return false;
    return !AIRCRAFT_TYPES.some(o => o.id !== t.id && !o.freighter && aircraftFamily(o.id) === fam);
  }).map(t => `${t.name} → ${aircraftFamily(t.id)}`);
  assert.deepEqual(lonely, []);
});

// ── 8. Passenger-side guards (2026-07-31) ────────────────────────────────────
// Everything above guards the FREIGHTER table. The passenger table had the exact
// same seam wide open: 92 out-of-production passenger types carried no
// deliveredAgeWeeks, so a 1971 Trident 3B was delivered factory-fresh at $4M and
// paid maintenanceMultiplier(0) = 1.0 for life. Combined with 1970s scrap
// pricing that gave it a ~6.5x return on capital against a 737 MAX 8, which is
// the passenger twin of the "MD-10 is cheaper than an ATR-72" report.

const PAX = AIRCRAFT_TYPES.filter(t => !t.freighter && !t.supersonic);
const hasEis = PAX.some(t => t.eis != null);   // Tailwinds' copy carries no eis
const ppsK = (t) => t.purchasePrice / t.seats / 1000;   // $K per seat

/**
 * The published delivered-age band. Keep in sync with the file header.
 *
 * Banded off the GENERATION's service entry, not the individual variant's. A
 * type can enter service years after the line it is built on and still leave
 * production alongside its siblings, so it reaches the second-hand market at
 * their vintage, not its own. The 737-900ER (eis 2007) came off the 737NG line
 * and stopped when the -700 and -800 did; banding it off 2007 dropped it past
 * the end of the table and made it the only NG delivered factory-fresh, which
 * let a 2007 airframe out-earn the MAX 9 that replaced it. `bandEis` names the
 * cohort to band with.
 */
function expectedAgeBand(t) {
  const eis = t?.bandEis ?? t?.eis;
  if (eis == null) return null;
  if (eis <= 1974) return 832;
  if (eis <= 1984) return 624;
  if (eis <= 1994) return 520;
  if (eis <= 2004) return 312;
  return 0;
}

if (hasEis) {
  test('no out-of-production passenger type is delivered factory-fresh', () => {
    // THE BUG: reducer.mjs stamps `ageWeeks: type?.deliveredAgeWeeks ?? 0` on
    // every acquisition path. With the field absent, a 55-year-old airframe
    // arrived at zero hours with a full 30-year depreciation life ahead of it.
    const fresh = PAX
      .filter(t => t.eis <= 2004 && !(t.deliveredAgeWeeks > 0))
      .map(t => `${t.name} (${t.eis})`);
    assert.deepEqual(fresh, [],
      'every passenger type out of production since 2004 must arrive already used');
  });

  test('delivered age matches the published band for its vintage', () => {
    const off = PAX
      .filter(t => (t.deliveredAgeWeeks ?? 0) !== expectedAgeBand(t))
      .map(t => `${t.name} (eis ${t.bandEis ?? t.eis}) has ${t.deliveredAgeWeeks ?? 0}w, band says ${expectedAgeBand(t)}w`);
    assert.deepEqual(off, []);
  });

  test('the whole 737NG cohort arrives used, including the -900ER', () => {
    // The -900ER entered service in 2007 but was built on the same line as the
    // -700 and -800 and left production with them. Banded off its own EIS it fell
    // past the end of the age table and arrived factory-fresh — the only NG that
    // did — which handed a 2007 airframe a lower maintenance clock and a full
    // depreciation life, and let it out-earn the MAX 9 built to replace it.
    const NG = ['b737700', 'b737800', 'b737900er'].map(get);
    const fresh = NG.filter(t => !(t.deliveredAgeWeeks > 0)).map(t => t.name);
    assert.deepEqual(fresh, [], 'every 737NG comes off a line that closed in 2019');
    assert.equal(new Set(NG.map(t => t.deliveredAgeWeeks)).size, 1,
      'they stopped being built at the same time, so they reach the market equally old');
  });

  test('no passenger type is priced below the floor for its vintage', () => {
    // maintenanceMultiplier only ever accounts for 7-17% of a vintage frame's
    // operating cost, so an age penalty alone cannot fix an underpriced airframe
    // — the capital number has to carry it. These floors sit just under the
    // cheapest surviving frame in each band; they exist to catch a future edit
    // that drops a 180-seat jet back to $4M, not to pin exact values.
    const FLOOR = [
      { maxEis: 1969, floorK: 42 }, { maxEis: 1979, floorK: 27 },
      { maxEis: 1989, floorK: 36 }, { maxEis: 1999, floorK: 65 },
      { maxEis: 2009, floorK: 90 }, { maxEis: 9999, floorK: 180 },
    ];
    const under = PAX
      .filter(t => t.seats >= 80)
      .filter(t => ppsK(t) < FLOOR.find(b => t.eis <= b.maxEis).floorK)
      .map(t => `${t.name} (${t.eis}) $${ppsK(t).toFixed(0)}K/seat`);
    assert.deepEqual(under, []);
  });
}

test('no SMALL passenger type is priced below the floor for its vintage', () => {
  // Era-mode phase 3 (ERA_MODE_PLAN.md §6): the 80-seat floors above left every
  // propliner and feeder type unguarded, which is exactly the fleet a late era
  // world would exploit — sub-80-seat frames at giveaway $/seat. Floors sit
  // just under the cheapest surviving small frame in each band (DC-3 $47K,
  // Dash 7 $93K, CRJ700 $154K...), to catch a future edit, not pin values.
  const FLOOR_SMALL = [
    { maxEis: 1969, floorK: 40 }, { maxEis: 1979, floorK: 85 },
    { maxEis: 1989, floorK: 90 }, { maxEis: 1999, floorK: 90 },
    { maxEis: 2009, floorK: 140 }, { maxEis: 9999, floorK: 190 },
  ];
  const under = PAX
    .filter(t => t.seats > 0 && t.seats < 80)
    .filter(t => ppsK(t) < FLOOR_SMALL.find(b => t.eis <= b.maxEis).floorK)
    .map(t => `${t.name} (${t.eis}) $${ppsK(t).toFixed(0)}K/seat`);
  assert.deepEqual(under, []);
});

test('no passenger type delivers older than 20y — the maintenance curve is quadratic', () => {
  // Same reasoning as the freighter guard: 1 + (age/20)^2 * 2 means 30y = 5.5x
  // base, which would make the type loss-making on every route rather than
  // merely expensive.
  const tooOld = PAX
    .filter(t => (t.deliveredAgeWeeks ?? 0) > 20 * 52)
    .map(t => `${t.name} ${((t.deliveredAgeWeeks ?? 0) / 52).toFixed(0)}y`);
  assert.deepEqual(tooOld, []);
});

test('each current-generation narrowbody beats the type it replaces on fuel', () => {
  // The re-engined generations were entered at only a 4-5% per-aircraft gain
  // against a real 13-14%, so a 737-400 broke even at the same load factor as a
  // MAX 8 that cost six times as much. Sources: Aircraft Commerce CFM56-7B vs
  // LEAP-1B (-13.2%/hr, stable across six sectors) and CFM56-5B vs LEAP-1A /
  // PW1100G (-14%/hr). Floor set at 10% so the table keeps a real margin.
  const PAIRS = [
    ['b737700', 'b737max7'], ['b737800', 'b737max8'], ['b737900er', 'b737max9'],
    ['a319ceo', 'a319neo'], ['a320ceo', 'a320neo'], ['a321ceo', 'a321neo'],
  ];
  const weak = [];
  for (const [oldId, newId] of PAIRS) {
    const o = get(oldId), n = get(newId);
    // Per-aircraft is the right basis for a same-length re-engine. Where the
    // newer type is also a STRETCH — the MAX 7 adds 23 seats over the -700, every
    // neo adds seats over its ceo — the aircraft got bigger as well as newer, so
    // holding it to a per-aircraft gain forces its burn below what the longer
    // tube can physically achieve. Measure those per seat.
    const stretch = n.seats !== o.seats;
    const gain = stretch
      ? 1 - (n.fuelBurnPer100km / n.seats) / (o.fuelBurnPer100km / o.seats)
      : 1 - n.fuelBurnPer100km / o.fuelBurnPer100km;
    if (gain < 0.10) {
      weak.push(`${n.name} is only ${(gain * 100).toFixed(1)}% better `
        + `${stretch ? 'per seat' : 'per hour'} than the ${o.name}`);
    }
  }
  assert.deepEqual(weak, []);
});

test('a re-engined narrowbody earns its price premium', () => {
  // The end state the fuel pass exists to protect: if the newest metal costs
  // several times as much, it has to break even at a lower load factor than the
  // classic it replaces, or nobody has a reason to ever buy new.
  //   BELF ~ (lease + maint*ageMult + fuel*km) / (seats * fare)
  // measured on a 1,500 km sector at max frequency inside the 140 bh cap.
  const belf = (t) => {
    const bt = 1500 / 840 + 0.83;
    const f = Math.floor(140 / (bt * 2));
    const km = f * 2 * 1500;
    const ageMult = 1 + Math.pow(((t.deliveredAgeWeeks ?? 0) / 52) / 20, 2) * 2;
    const cost = t.weeklyLease + t.baseMaintenancePerWk * ageMult
      + km * ((t.fuelBurnPer100km / 100) * 1.45 + (t.crewCostPerKm ?? 0));
    return cost / (t.seats * f * 2 * Math.round((80 + 1500 * 0.09) * 0.87));
  };
  for (const [classic, modern] of [['b737400', 'b737max8'], ['b737300', 'b737max7'], ['a320ceo', 'a320neo']]) {
    assert.ok(belf(get(modern)) < belf(get(classic)),
      `${get(modern).name} breaks even at ${(belf(get(modern)) * 100).toFixed(0)}% load vs the ` +
      `${get(classic).name}'s ${(belf(get(classic)) * 100).toFixed(0)}% — the new type must be the easier aircraft to fill`);
  }
});

test('the 737-500 is not certified for as many seats as the longer -300', () => {
  // EASA TCDS IM.A.120 issue 24 certifies the -500 at 140 against the -300's
  // 149. Boeing's ACAP quotes an FAA exit limit of 149 for both, but the -500 is
  // 2.4 m shorter and Boeing's own densest all-economy layout for it is 122 — it
  // cannot physically reach 149. Left at 149 it strictly dominated the -300,
  // which then had no reason to exist.
  assert.ok(get('b737500').seats < get('b737300').seats,
    'the -500 is the shortest Classic and must seat fewer than the -300');
  assert.ok(get('b737300').seats < get('b737400').seats,
    'the -400 gets a second overwing exit pair — (I,III,III,I) vs (I,III,I)');
});

test('E-Jet runway requirement rises with weight inside a generation', () => {
  // Embraer spec sheets: E175 TOFL 1,724 m at 38.8 t, E190 2,100 m at 51.8 t,
  // E195 2,179 m at 52.3 t. The table had the E190 at 4,800 ft against the
  // E175's 5,300 — backwards, and it was the main reason the heavier, cheaper
  // E190 strictly outclassed the E175 the scope clauses price above it.
  assert.ok(get('e175').runwayFt < get('e190').runwayFt,
    'the E190 is 13 t heavier than the E175 and needs more runway, not less');
  assert.ok(get('e190').runwayFt <= get('e195').runwayFt,
    'the E195 is the heaviest E1 and needs at least as much runway as the E190');
  assert.ok(get('e190e2').runwayFt < get('e190').runwayFt,
    'the E190-E2 has a new wing and better field performance than the E1');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
