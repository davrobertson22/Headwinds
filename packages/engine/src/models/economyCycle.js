// The world business cycle — demand model v4 worlds (docs/game-audit-2026-11-06.md R5).
//
// WHY. Before this the only macro economy was ~26 short, memoryless world
// events a year (a "recession" lasted 8–16 weeks and came round about once a
// game year). Real airline management is about capacity discipline through a
// multi-year cycle: order in the bust, take delivery in the boom, do not get
// caught at the top with long leases. The production lines, priority slots,
// the used market and lease terms were all built for that game, but with only
// short noise to react to, timing never paid.
//
// WHAT. One shared cycle per world, `x` = demand above/below trend:
//   • a damped second-order walk (AR(2) with complex roots), which gives
//     genuine cycles with momentum — a turning economy keeps turning — and a
//     period of roughly four game years, but never a predictable sine wave;
//   • it scales every route's demand by (1 + x), clamped to −15% / +12%;
//   • it scales the rate a NEW lease is signed at by (1 + 0.6x) — lessors
//     charge more in a boom and less in a bust (existing leases keep their
//     locked rate);
//   • the phase (expanding / slowing / contracting / recovering) is public:
//     the News economy line and the Dashboard read it, and its momentum is the
//     leading indicator a careful airline plans fleet orders against.
// Multiplayer replays it from the world seed (server lib/worldEconomy.mjs) so
// every airline lives in the same economy; solo walks its own.
//
// Pure, no imports beyond the math, so the server and engine share it.

export const ECONOMY_CYCLE = {
  r: 0.992,                         // damping per week
  periodWeeks: 208,                 // ≈ 4 game years peak to peak
  sigma: 0.00024,                   // weekly innovation (sd) — stationary sd ≈ 4.5% (AR(2) gain ≈ 190)
  demandFloor: -0.15,
  demandCap: 0.12,
  leaseBeta: 0.6,                   // new-lease rate sensitivity to x
  historyCap: 104,
};

const A1 = 2 * ECONOMY_CYCLE.r * Math.cos((2 * Math.PI) / ECONOMY_CYCLE.periodWeeks);
const A2 = -(ECONOMY_CYCLE.r ** 2);

/** Inverse standard normal (Acklam's approximation) — one uniform in, one z out. */
export function normalFromUniform(u) {
  const p = Math.min(1 - 1e-9, Math.max(1e-9, Number(u) || 0.5));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** A fresh cycle at trend. */
export function newEconomyCycle() { return { x: 0, prev: 0, history: [] }; }

/**
 * One week of the cycle. `rand` is a uniform [0,1) — Math.random in solo, the
 * world-seeded draw in multiplayer. Shocks are clipped at ±3σ so a pinned
 * random source (tests) cannot fling the economy.
 */
export function tickEconomyCycle(cycle, rand = Math.random()) {
  const c = cycle ?? newEconomyCycle();
  const z = Math.max(-3, Math.min(3, normalFromUniform(rand)));
  // The walk itself is never clamped (a clamp fed back makes the economy stick
  // at its bounds); the clamp is applied where the cycle is USED.
  const x = A1 * (c.x ?? 0) + A2 * (c.prev ?? 0) + ECONOMY_CYCLE.sigma * z;
  const history = [...(c.history ?? []), +x.toFixed(6)].slice(-ECONOMY_CYCLE.historyCap);
  return { x: +x.toFixed(6), prev: +(c.x ?? 0).toFixed(6), history };
}

/** Whether this save lives in a business-cycle world (demand model v4). */
export function economyCycleWorld(state) {
  return (Number(state?.demandModel) || 1) >= 4;
}

/** The demand multiplier the cycle puts on every route this week (1 elsewhere). */
export function cycleDemandMult(state) {
  if (!economyCycleWorld(state)) return 1;
  const x = Number(state?.economyCycle?.x) || 0;
  return 1 + Math.max(ECONOMY_CYCLE.demandFloor, Math.min(ECONOMY_CYCLE.demandCap, x));
}

/** The per-world demand multiplier including the cycle — what the tick applies. */
export function worldDemandMultOf(state) {
  return (state?.worldDemandMult ?? 1) * cycleDemandMult(state);
}

/** Multiplier on the rate a NEW lease is signed at (1 elsewhere). */
export function cycleLeaseMult(state) {
  if (!economyCycleWorld(state)) return 1;
  const x = Math.max(ECONOMY_CYCLE.demandFloor, Math.min(ECONOMY_CYCLE.demandCap, Number(state?.economyCycle?.x) || 0));
  return +(1 + ECONOMY_CYCLE.leaseBeta * x).toFixed(4);
}

/**
 * Where the economy is: 'expanding' (above trend, rising), 'slowing' (above,
 * falling), 'contracting' (below, falling), 'recovering' (below, rising).
 * Momentum over the last 8 weeks is the leading indicator.
 */
export function economyPhase(cycle) {
  if (!cycle) return null;
  const h = cycle.history ?? [];
  const x = Number(cycle.x) || 0;
  const past = h.length > 8 ? h[h.length - 9] : (h[0] ?? cycle.prev ?? 0);
  const momentum = x - past;
  const phase = x >= 0 ? (momentum >= 0 ? 'expanding' : 'slowing') : (momentum < 0 ? 'contracting' : 'recovering');
  return { phase, demandPct: Math.round(x * 1000) / 10, momentumPct: Math.round(momentum * 1000) / 10 };
}
