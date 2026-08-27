// World-shared economy walks — fuel price + market sentiment.
// ----------------------------------------------------------------------------
// A multiplayer world has ONE fuel index and ONE market-sentiment index per
// week, replayed deterministically from the world seed (never stored): the tick
// injects them into every airline's ADVANCE_WEEK so rivals pay the same fuel
// and are valued against the same market, and a retried tick reproduces the
// exact same walk. This module is the single home for those walks so the tick
// (tickService) and the join-time backfill (worldService) can never disagree.
import { tickFuelPrice, FUEL_BASE_INDEX } from '@tailwinds/engine/utils/fuel.js';
import { eraFuelMean, ERA_FUEL_MIN_INDEX } from '@tailwinds/engine/data/era.js';
import { tickMarketIndex, MARKET_BASE_INDEX } from '@tailwinds/engine/utils/market.js';

// The reducer keeps at most 52 weeks of fuel history (see ADVANCE_WEEK); the
// backfill must honour the same cap or a late joiner's blob would carry more
// history than a founding member's.
export const FUEL_HISTORY_CAP = 52;

// Deterministic uniform [0,1) from a string seed + salt (xfnv1a hash → mulberry32).
export function seededRand(seedStr, salt) {
  let h = 2166136261 >>> 0;
  const s = `${seedStr}:${salt}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h += 0x6d2b79f5;
  let t = h >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// The world-shared fuel index at a given 1-based week — replayed from the base
// index through the SAME OU walk the solo game uses, but with a per-world-week
// seeded shock, so it's identical for every airline and reproducible.
// Era worlds pass startYear so each week's OU step reverts to the HISTORICAL
// mean for that calendar year (data/era.js) with the wider era floor — the
// same pure seeded replay, just a moving target. Null = classic, byte-identical.
//
// Memoised per (seed, startYear): the walk is O(weekIndex) from scratch, which
// at a century world's week 5,200 was 5,200 iterations per world per tick.
// Successive calls only walk the delta; an earlier week than the memo (a
// join-time backfill) recomputes from scratch.
const _fuelWalkMemo = new Map();

function eraWeekParams(startYear, w) {
  if (!Number.isInteger(startYear)) return [FUEL_BASE_INDEX, undefined];
  const mean = eraFuelMean(startYear + Math.floor((w - 1) / 52)) ?? FUEL_BASE_INDEX;
  return [mean, ERA_FUEL_MIN_INDEX];
}

export function worldFuelIndex(seed, weekIndex, startYear = null) {
  const key = `${seed}|${Number.isInteger(startYear) ? startYear : ''}`;
  let m = _fuelWalkMemo.get(key);
  if (!m || m.week > weekIndex) m = { week: 0, idx: FUEL_BASE_INDEX };
  let { week, idx } = m;
  for (let w = week + 1; w <= weekIndex; w++) {
    const [mean, minIdx] = eraWeekParams(startYear, w);
    idx = tickFuelPrice(idx, seededRand(seed, `fuel:${w}`), mean, minIdx);
  }
  _fuelWalkMemo.set(key, { week: Math.max(week, weekIndex), idx });
  return idx;
}

// The world-shared MARKET index at a given 1-based week — pure sentiment, replayed
// from the world seed exactly like the fuel index above, so every airline is valued
// against the same market that week and a retried tick reproduces it.
//
// The fuel lever is NOT part of this walk: the engine applies it at valuation time
// via marketValuationFactor(marketIndex, fuelIndex), using the same world-shared
// fuel index injected alongside this one. Keeping it out of the walk means a
// sustained fuel crisis keeps prices depressed instead of being mean-reverted away.
export function worldMarketIndex(seed, weekIndex) {
  let mkt = MARKET_BASE_INDEX;
  for (let w = 1; w <= weekIndex; w++) mkt = tickMarketIndex(mkt, seededRand(seed, `mkt:${w}`));
  return mkt;
}

// The economy exactly as a founding member's blob would carry it at world week
// `worldLinearWeek` (1-based linear week, i.e. (year-1)*52 + week).
//
// Shape contract with the reducer's ADVANCE_WEEK: a world at week W has ticked
// for fromIndex = 1 .. W-1. Each of those ticks injected worldFuelIndex(seed, k),
// which the reducer both APPENDED to fuelPrice.history and STORED as
// fuelPrice.index (in MP the stored index IS the injected value), and stored
// worldMarketIndex(seed, k) as marketIndex. So:
//   history = [fuel(1) .. fuel(W-1)]  (capped to the last FUEL_HISTORY_CAP)
//   index   = fuel(W-1)               (1.0 when W === 1 — no ticks yet)
//   market  = mkt(W-1)                (MARKET_BASE_INDEX when W === 1)
// Used by joinWorld so a late joiner starts on the same economy their rivals
// have been living in — not a fresh 1.000× with an empty chart (which also let
// them lock hedges at 1.0× regardless of where world fuel actually was).
export function worldEconomyAt(seed, worldLinearWeek, { historyCap = FUEL_HISTORY_CAP, startYear = null } = {}) {
  const upto = Math.max(0, Math.floor(worldLinearWeek) - 1);
  const history = [];
  let idx = FUEL_BASE_INDEX;
  for (let w = 1; w <= upto; w++) {
    const [mean, minIdx] = eraWeekParams(startYear, w);
    idx = tickFuelPrice(idx, seededRand(seed, `fuel:${w}`), mean, minIdx);
    history.push(idx);
  }
  let mkt = MARKET_BASE_INDEX;
  for (let w = 1; w <= upto; w++) mkt = tickMarketIndex(mkt, seededRand(seed, `mkt:${w}`));
  return {
    fuelPrice: {
      index: history.length > 0 ? history[history.length - 1] : FUEL_BASE_INDEX,
      history: history.slice(-historyCap),
    },
    marketIndex: mkt,
  };
}
