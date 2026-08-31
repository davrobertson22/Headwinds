// era.js — the historical era curves (ERA_MODE_PLAN.md §3.3).
//
// A world created with tickConfig.startYear (baked into every airline blob as
// state.startYear) runs on a real calendar: week 1 of year 1 is January of
// startYear. Three things read these curves:
//
//   demand — eraDemandIndex replaces the classic compounding pairDemandGrowth
//            (market.js short-circuits to it via setEraStartYear), so a 1950
//            world starts at ~5% of 2026 traffic and grows along history
//            rather than upward from an arbitrary year 1.
//   fares  — eraFareIndex feeds setFareIndex at the reducer entry, scaling the
//            whole reference ladder: real yield per km was ~6.5x today's in
//            1950. The published index is gamma-compressed (γ≈0.31) BOTH for
//            balance and because setFareIndex hard-clamps at 2.0.
//   fuel   — eraFuelMean replaces the OU walk's reversion target through 2026:
//            cheap and flat to 1972, the 1973/1979 shocks, the 1986-99 glut,
//            the 2008 spike, COVID. After 2026 it returns null and the walk
//            reverts to the procedural FUEL_BASE_INDEX — history is written,
//            the future is not.
//
// EVERY function returns its neutral value (null) when calYear is null: a
// classic world never touches an era branch. That is the parity invariant —
// tools/golden-master/run.mjs must stay PARITY OK whatever changes here.
//
// The anchor values are the calibration surface for tools/era-balance-test.mjs
// (load factor 60-85% and consistent return-on-capital per decade). Tune them
// there, not by feel.

// Piecewise-linear interpolation over [year, value] anchors, clamped at the ends.
function lerp(anchors, x) {
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, v1] = anchors[i - 1], [x2, v2] = anchors[i];
    if (x <= x2) return v1 + (v2 - v1) * (x - x1) / (x2 - x1);
  }
  return last[1];
}

// World passenger traffic relative to 2026, compressed with γ_demand = 0.50 so
// the early decades are small rather than uninhabitable (raw 1950 RPKs are
// ~0.3% of 2026; the index plays at 5.4%).
export const ERA_DEMAND_ANCHORS = [
  [1930, 0.020], [1950, 0.054], [1960, 0.105], [1970, 0.217], [1980, 0.333],
  [1990, 0.439], [2000, 0.557], [2010, 0.696], [2019, 0.942], [2026, 1.000],
  [2050, 1.480], [2100, 2.200],
];

export function eraDemandIndex(calYear) {
  if (calYear == null) return null;
  return lerp(ERA_DEMAND_ANCHORS, calYear);
}

// Real yield relative to 2026, compressed with γ_yield ≈ 0.31. The ceiling is
// dictated by setFareIndex's hard clamp at 2.0 (market.js:751) — anything
// above it is silently swallowed — so the rest of the period's economics live
// in the aircraft COST data (fuel burn, crew, cruise speed), where they belong.
// Measured against tools/era-balance-test.mjs: the first cut (γ≈0.31, 1950 at
// 1.79) made the propliner decades print money — cheap airframes, cheap fuel
// and a 79% fare premium compounded into ~8x the modern return on capital.
// γ≈0.20 keeps the period feel (1950 fares 55% over the modern ladder) while
// holding the early-era RoC premium inside the balance test's ceiling.
export const ERA_FARE_ANCHORS = [
  [1930, 1.62], [1950, 1.55], [1960, 1.42], [1970, 1.30], [1980, 1.22],
  [1990, 1.13], [2000, 1.06], [2010, 1.01], [2019, 1.00], [2026, 1.00],
  [2050, 0.96], [2100, 0.92],
];

export function eraFareIndex(calYear) {
  if (calYear == null) return null;
  return Math.max(0.90, Math.min(1.95, lerp(ERA_FARE_ANCHORS, calYear)));
}

// Jet-fuel mean index the weekly OU walk reverts to, through 2026. The weekly
// volatility (fuel.js σ = 0.04) rides on top, so no two worlds see the same
// 1973 — the shape is history, the texture is the world's own seed. Null past
// 2026: the walk reverts to the procedural FUEL_BASE_INDEX from wherever the
// scripted era left it.
export const ERA_FUEL_ANCHORS = [
  [1950, 0.45], [1972, 0.46], [1973, 0.62], [1974, 0.95], [1976, 0.92],
  [1978, 0.95], [1980, 1.42], [1981, 1.45], [1982, 1.30], [1985, 1.10],
  [1986, 0.60], [1990, 0.68], [1993, 0.55], [1998, 0.45], [1999, 0.55],
  [2000, 0.75], [2002, 0.70], [2005, 1.25], [2008, 1.85], [2009, 0.95],
  [2011, 1.40], [2014, 1.30], [2015, 0.80], [2016, 0.65], [2019, 0.78],
  [2020, 0.45], [2021, 0.85], [2022, 1.50], [2023, 1.15], [2026, 1.00],
];

export function eraFuelMean(calYear) {
  if (calYear == null || calYear > 2026) return null;
  return lerp(ERA_FUEL_ANCHORS, calYear);
}

// The classic clamp floor (0.55) sits above the 1950-72 and 2020 means; era
// worlds widen it so the cheap-fuel decades are actually cheap.
export const ERA_FUEL_MIN_INDEX = 0.35;

// Era demand factor — REPLACES classic pairDemandGrowth (never stacks with
// it, or growth counts twice), and it is the ABSOLUTE index, not a ratio from
// the start year. The classic gravity model's base pool represents roughly
// today's traffic (a classic world starts at modern demand and compounds up),
// so the era factor must scale the LEVEL: a 1950 world runs at 5.4% of the
// classic pool and reaches 148% by 2050. Two consequences worth knowing:
//   - the factor stays inside [0.054, 2.2] across any legal era, a NARROWER
//     absolute band than classic's own 3.0 growth cap, so gates, slots and
//     aircraft sizing never see a demand level the model wasn't built for;
//   - an incumbent still grows ~27x across the full century, which is the
//     compounding-advantage question ERA_MODE_PLAN.md §3.3 flags — era slices
//     remain the recommended product.
// The cap is a guard for far-future custom worlds, not a lever.
export const ERA_DEMAND_GROWTH_CAP = 8.0;

export function eraDemandGrowthFactor(startYear, absWeek) {
  if (!Number.isInteger(startYear)) return 1;
  const w = Math.max(1, Number(absWeek) || 1);
  const idx = eraDemandIndex(startYear + Math.floor((w - 1) / 52));
  return Math.min(ERA_DEMAND_GROWTH_CAP, Math.max(0.02, idx));
}

// ── Era money and pax scales (phase 3, ERA_MODE_PLAN.md §4) ──────────────────
// The constant-dollar decision covers aircraft prices and per-flight economics;
// it deliberately does NOT cover the game's fixed-dollar progression furniture,
// which is calibrated against a 2026-scale airline. These three scales are the
// NARROW, NAMED set that moves with the era — nothing else does.
//
//   eraRevenueScale — demand x fare: what a week of flying is worth vs 2026.
//                     Scales revenue/profit/cash/market-cap objective targets.
//   eraPaxScale     — demand alone. Scales passenger-count targets.
//   eraCapitalScale — sqrt(revenue scale), floored at 0.25 and capped at 1.
//                     Scales starting capital, objective rewards and the fixed
//                     cost floors. Sqrt, not linear: capital buys AIRCRAFT and
//                     aircraft prices stay in constant dollars, so a linear cut
//                     would hand a 1950 founder cash that cannot buy one DC-3.
// All three return null for a classic world — the parity invariant.

export function eraRevenueScale(calYear) {
  if (calYear == null) return null;
  return Math.max(0.05, eraDemandIndex(calYear) * eraFareIndex(calYear));
}

export function eraPaxScale(calYear) {
  if (calYear == null) return null;
  return Math.max(0.02, eraDemandIndex(calYear));
}

export function eraCapitalScale(calYear) {
  if (calYear == null) return null;
  return Math.max(0.25, Math.min(1, Math.sqrt(eraRevenueScale(calYear))));
}


// Fixed-overhead scale for an era year: gate rents, wages, MRO contracts, hub
// investment, HQ, insurance, route launch and marketing floors all run at this
// fraction of their modern-dollar level. The SQUARE ROOT of the capital scale
// (1950: 0.54, 1978: 0.78) — a gentler cut than capital, on purpose: the
// 1950 playtest showed that scaling overheads all the way down to the capital
// scale (0.29) left the early decades printing money. Null in classic.
export function eraOverheadScale(calYear) {
  const c = eraCapitalScale(calYear);
  return c == null ? null : Math.sqrt(c);
}

// Seed capital for an era start: the modern-equivalent figure × capitalScale,
// then FLOORED to a whole million (never below $1M). The floor is deliberate —
// playtesting showed the early decades generous once fixed overheads were
// scaled, so a 1950 airline opens on $4.0M rather than $4.34M, 1978 on $9M
// rather than $9.28M. Classic (calYear null) returns the modern figure as is.
export function eraSeedCapital(modernCapital, calYear) {
  const scale = eraCapitalScale(calYear);
  if (scale == null) return modernCapital;
  return Math.max(1_000_000, Math.floor(modernCapital * scale / 1_000_000) * 1_000_000);
}
