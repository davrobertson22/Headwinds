// ─────────────────────────────────────────────────────────────────────────────
// Rebalance bench. Sizes candidate fixes for small-gauge viability by mutating
// the engine's own cost tables at runtime (no source edits, nothing to revert)
// and re-running the same scenarios 2-sim.mjs runs.
//
// Knobs, as env vars:
//   GATE_MULT=0.25      multiply every GATE_FEE_BY_TIER entry
//   GATE_REGIONAL=2000  absolute monthly regional gate fee (overrides GATE_MULT)
//   HUB_T1=5000         HUB_TIERS[1].weeklyInvestment
//   FAMILY_MULT=0.25    multiply every FAMILY_INFO weeklyBaseCost
//   HQ_BASE=20000       HQ_BASE_WEEKLY (already gauge-scaled; this moves the top)
// Usage: HUB_T1=5000 node tools/stbarths/4-rebalance.mjs <scenario> <seeds> <weeks>
// ─────────────────────────────────────────────────────────────────────────────
import { GATE_FEE_BY_TIER } from '../../packages/engine/src/data/airports.js';
import { HUB_TIERS } from '../../packages/engine/src/models/demand.js';
import { FAMILY_INFO } from '../../packages/engine/src/data/families.js';
import * as overhead from '../../packages/engine/src/data/overhead.js';

const applied = [];
if (process.env.GATE_REGIONAL) {
  GATE_FEE_BY_TIER.regional = parseInt(process.env.GATE_REGIONAL, 10);
  applied.push(`gate.regional=$${GATE_FEE_BY_TIER.regional}/mo`);
} else if (process.env.GATE_MULT) {
  const m = parseFloat(process.env.GATE_MULT);
  for (const k of Object.keys(GATE_FEE_BY_TIER)) GATE_FEE_BY_TIER[k] = Math.round(GATE_FEE_BY_TIER[k] * m);
  applied.push(`gateFee×${m}`);
}
if (process.env.HUB_T1) { HUB_TIERS[1].weeklyInvestment = parseInt(process.env.HUB_T1, 10); applied.push(`hubT1=$${HUB_TIERS[1].weeklyInvestment}/wk`); }
if (process.env.HUB_T0) { HUB_TIERS[0].weeklyInvestment = parseInt(process.env.HUB_T0, 10); applied.push(`hubT0=$${HUB_TIERS[0].weeklyInvestment}/wk`); }
if (process.env.FAMILY_MULT) {
  const m = parseFloat(process.env.FAMILY_MULT);
  for (const f of Object.values(FAMILY_INFO)) if (f.weeklyBaseCost) f.weeklyBaseCost = Math.round(f.weeklyBaseCost * m);
  applied.push(`familyBase×${m}`);
}
console.error('rebalance:', applied.length ? applied.join('  ') : 'BASELINE (no change)');

// The sim is imported AFTER the tables are mutated so it sees the new values.
process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(2)];
await import('./2-sim.mjs');
