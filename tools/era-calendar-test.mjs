// era-calendar-test.mjs — Phase 0 of ERA_MODE_PLAN.md: the startYear epoch.
//
// HEAD failure proof (run before this phase landed, per CLAUDE.md):
//   node -e "import('./packages/engine/src/utils/simulation.js').then(m => {
//     console.log(m.formatGameDate({week:1,year:3,startYear:1950}));   // "Week 1 Jan Year 3" — era ignored
//     console.log(typeof m.calendarYear);                              // "undefined"
//   })"
//
// The invariant under test everywhere below: startYear == null (classic world)
// must behave byte-for-byte as before — every era path short-circuits.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  calendarYear, calendarYearFrac, yearLabel, shortYearLabel, formatGameDate,
} from '../packages/engine/src/utils/simulation.js';
import { eraDemandGrowthFactor, eraFareIndex, eraOverheadScale, eraFuelMean } from '../packages/engine/src/data/era.js';
import { gameReducer, freshState } from '../packages/engine/src/reducer.mjs';
import { getFareIndex } from '../packages/engine/src/utils/market.js';
import { getEraCostScale } from '../packages/engine/src/data/overhead.js';
import {
  validateWorldConfig, serializeWorld, ERA_START_YEARS, MIN_START_YEAR, MAX_START_YEAR,
} from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import { historyLabel, rebaseStateCalendar } from '../apps/headwinds-server/src/lib/calendar.mjs';

// ── Engine helpers ────────────────────────────────────────────────────────────

test('classic worlds are untouched: calendarYear null, labels ordinal', () => {
  assert.equal(calendarYear({ year: 3, week: 1 }), null);
  assert.equal(calendarYear({ year: 3, week: 1, startYear: null }), null);
  assert.equal(yearLabel({ year: 3 }), 'Year 3');
  assert.equal(shortYearLabel({ year: 3 }), 'Y3');
  assert.equal(formatGameDate({ week: 14, year: 3 }), 'Week 5 Mar Year 3');
});

test('era worlds translate the ordinal year to the calendar', () => {
  assert.equal(calendarYear({ year: 1, startYear: 1950 }), 1950);
  assert.equal(calendarYear({ year: 29, startYear: 1950 }), 1978);
  assert.equal(yearLabel({ year: 3, startYear: 1978 }), '1980');
  assert.equal(shortYearLabel({ year: 3, startYear: 1950 }), '1952');
  assert.equal(formatGameDate({ week: 14, year: 3, startYear: 1950 }), 'Week 5 Mar 1952');
});

test('year stays a 1-based ordinal — startYear never changes state.year', () => {
  // The epoch is display-and-gating only. A state carrying startYear keeps its
  // ordinal year untouched; only the label translates.
  const s = { year: 5, week: 10, startYear: 1958 };
  calendarYear(s); yearLabel(s); formatGameDate(s);
  assert.equal(s.year, 5);
});

// ── Server config flow ────────────────────────────────────────────────────────

test('validateWorldConfig accepts era years in bounds, rejects outside', () => {
  const base = { lengthYears: 40, weeksPerDay: 48 };
  validateWorldConfig({ ...base, startYear: 1950 });
  validateWorldConfig({ ...base, startYear: MIN_START_YEAR });
  validateWorldConfig({ ...base, startYear: MAX_START_YEAR });
  validateWorldConfig({ ...base });                       // classic: absent
  validateWorldConfig({ ...base, startYear: null });      // classic: explicit null
  for (const bad of [1850, 2200, 1950.5, '1950']) {
    assert.throws(() => validateWorldConfig({ ...base, startYear: bad }), /startYear/,
      `startYear ${JSON.stringify(bad)} must be rejected`);
  }
  assert.ok(ERA_START_YEARS.every((y) => Number.isInteger(y) && y >= MIN_START_YEAR && y <= MAX_START_YEAR));
});

test('serializeWorld surfaces startYear, null for classic worlds', () => {
  const w = (tickConfig) => ({ tickConfig, lengthYears: 40, weeksPerDay: 48, currentYear: 2, currentWeek: 5 });
  assert.equal(serializeWorld(w({})).startYear, null);
  assert.equal(serializeWorld(w({ startYear: 1978 })).startYear, 1978);
  assert.equal(serializeWorld(w({ startYear: 'x' })).startYear, null, 'garbage in tickConfig reads as classic');
  // What a joiner actually receives, era-scaled to the world's CURRENT year.
  assert.equal(serializeWorld(w({})).seedCapital, 15_000_000);
  assert.equal(serializeWorld({ ...w({ startYear: 1950, startingCapital: 4_000_000 }), currentYear: 1 }).seedCapital, 4_000_000, 'at founding: exactly the knob');
  assert.equal(serializeWorld(w({ startYear: 1950, startingCapital: 4_000_000 })).seedCapital, 4_200_000, 'year 2 (1951): scaled up a notch with the era');
  assert.ok(serializeWorld({ ...w({ startYear: 1950, startingCapital: 4_000_000 }), currentYear: 21 }).seedCapital > 4_000_000, 'a 1970 joiner gets more');
});

// ── History labels ────────────────────────────────────────────────────────────

test('historyLabel: ordinal for classic, calendar for era', () => {
  assert.equal(historyLabel(3, 52), 'Dec W4 Y3');
  assert.equal(historyLabel(3, 52, null), 'Dec W4 Y3');
  assert.equal(historyLabel(3, 52, 1950), 'Dec W4 1952');
});

test('rebaseStateCalendar re-stamps history labels era-aware', () => {
  const mk = (startYear) => ({
    week: 1, year: 1, ...(startYear ? { startYear } : {}),
    financialHistory: [{ week: 1, year: 1, label: historyLabel(1, 1, startYear ?? null), cash: 0 }],
  });
  const classic = rebaseStateCalendar(mk(null), { year: 2, week: 5 });
  assert.equal(classic.state.financialHistory[0].label, 'Jan W5 Y2');
  const era = rebaseStateCalendar(mk(1950), { year: 2, week: 5 });
  assert.equal(era.state.financialHistory[0].label, 'Jan W5 1951');
  assert.equal(era.state.startYear, 1950, 'rebase must not drop the epoch');
});

// ── Continuous curves move weekly, not on January W1 ─────────────────────────
// HEAD failure proof: every era curve was evaluated at the INTEGER calendar
// year, so demand stepped +9.4% (1950→51) / +10.7% (1960→61) overnight at
// New Year, fares and overheads a notch with it — at 48 weeks/day, a sawtooth
// every real day. The discrete gates (eis/oop, features, events, the Comet)
// deliberately still read calendarYear.

test('calendarYearFrac: week 1 is the whole year, week 27 is half-way, classic null', () => {
  assert.equal(calendarYearFrac({ startYear: 1950, year: 1, week: 1 }), 1950);
  assert.ok(Math.abs(calendarYearFrac({ startYear: 1950, year: 1, week: 27 }) - 1950.5) < 1e-9);
  assert.ok(Math.abs(calendarYearFrac({ startYear: 1950, year: 3, week: 52 }) - (1952 + 51 / 52)) < 1e-9);
  assert.equal(calendarYearFrac({ year: 3, week: 20 }), null);
  assert.equal(calendarYear({ startYear: 1950, year: 3, week: 52 }), 1952, 'the integer year is unchanged');
});

test('demand, fare, overhead and fuel curves never step at the year boundary', () => {
  // Week 52 of 1960 → week 1 of 1961 used to be the +10.7% cliff.
  const w52 = 11 * 52, w1 = w52 + 1;
  const jump = eraDemandGrowthFactor(1950, w1) / eraDemandGrowthFactor(1950, w52) - 1;
  assert.ok(jump > 0 && jump < 0.004, `demand moves ${(jump * 100).toFixed(2)}% across New Year, not ~10%`);
  // And the largest weekly move anywhere in the century is the same size.
  let worst = 0;
  for (let w = 2; w <= 100 * 52; w++) {
    worst = Math.max(worst, Math.abs(eraDemandGrowthFactor(1950, w) / eraDemandGrowthFactor(1950, w - 1) - 1));
  }
  assert.ok(worst < 0.004, `worst weekly demand step ${(worst * 100).toFixed(2)}%`);
  // The reducer entry reads the fractional position for fare and overheads.
  const at = (year, week) => ({ ...freshState(), phase: 'playing', multiplayer: true, competitors: [], startYear: 1950, year, week });
  gameReducer(at(11, 52), { type: 'CLEAR_TOASTS' });
  const fiBefore = getFareIndex(), costBefore = getEraCostScale();
  gameReducer(at(12, 1), { type: 'CLEAR_TOASTS' });
  assert.ok(Math.abs(getFareIndex() / fiBefore - 1) < 0.002, 'fare ladder glides across New Year');
  assert.ok(Math.abs(getEraCostScale() / costBefore - 1) < 0.002, 'overhead scale glides across New Year');
  assert.ok(Math.abs(getFareIndex() - eraFareIndex(1961)) < 0.002, 'and still tracks the curve');
  // Fuel: the 1973 shock ramps through 1973 rather than landing whole on Jan W1.
  assert.ok(eraFuelMean(1973.5) > eraFuelMean(1973) && eraFuelMean(1973.5) < eraFuelMean(1974));
  // Classic: untouched.
  gameReducer({ ...freshState(), phase: 'playing', year: 12, week: 1 }, { type: 'CLEAR_TOASTS' });
  assert.equal(getFareIndex(), 1); assert.equal(getEraCostScale(), 1);
});
