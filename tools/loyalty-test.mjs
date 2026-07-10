// Loyalty rework test suite — maturity gating, points liability economics,
// tier caps, enrollment pacing, and the long-horizon payback dynamic.
//
// Run with: node tools/loyalty-test.mjs

import {
  loyaltyPenetration,
  loyaltyTier,
  loyaltyEnrollPull,
  loyaltyEffectiveStrength,
  loyaltyDemandBoostPct,
  loyaltyPriceSensitivityReduction,
  loyaltyReputationBonus,
  loyaltyPointsFlows,
  LOYALTY_EARN_RATE,
  LOYALTY_REDEEM_RATE,
  LOYALTY_BREAKAGE,
} from '../src/utils/simulation.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

// ─── Closed-loop program simulator ──────────────────────────────────────────
// Replicates the GameContext weekly loyalty loop against a fixed airline
// (steady pax/revenue) so we can measure the program's standalone economics.
function simulateProgram({ weeklyInvestment, weeks, weeklyPax = 100_000, weeklyRevenue = 20_000_000, hubShare = 0.6, defundAtWeek = null }) {
  let members = 0, maturity = 0, liability = 0, effInvestment = 0;
  const history = [];
  for (let w = 1; w <= weeks; w++) {
    const target = defundAtWeek != null && w >= defundAtWeek ? 0 : weeklyInvestment;
    effInvestment = Math.round(effInvestment + (target - effInvestment) * 0.18);

    // Effects computed with LAST week's stocks (mirrors engine using state.loyalty)
    const pen      = loyaltyPenetration(members, weeklyPax);
    const strength = loyaltyEffectiveStrength(pen, maturity);
    const tier     = loyaltyTier(effInvestment);
    const boostHub = loyaltyDemandBoostPct(strength, tier);
    // Program benefit proxy: hub-route demand lift on hub-attributable revenue
    // (ignores price-sensitivity shield + reputation, so it UNDERSTATES benefit).
    const benefit  = weeklyRevenue * hubShare * boostHub;

    // Points flows (engine §10)
    const generosity = tier.generosity || (members > 0 ? 0.85 : 0);
    const flows = (members > 0 || liability > 0)
      ? loyaltyPointsFlows(liability, weeklyRevenue, pen, generosity)
      : { earned: 0, redeemedCost: 0, expired: 0, newLiability: 0 };
    liability = flows.newLiability;

    const cost = (target > 0 ? target : 0) + flows.redeemedCost;

    // Member/maturity update (GameContext loop)
    if (target > 0 && effInvestment > 0 && weeklyPax > 0) {
      const ceiling  = tier.maxPenetration * weeklyPax * 4;
      const headroom = ceiling > 0 ? Math.max(0, 1 - members / ceiling) : 0;
      members  = Math.round(members * 0.996 + weeklyPax * loyaltyEnrollPull(effInvestment) * headroom);
      maturity = Math.min(1, maturity + (tier.maturityFactor ?? 1) / 80);
    } else {
      const lapse = maturity > 0.4 ? 0.97 : 0.988;
      members  = Math.round(members * lapse);
      maturity = Math.max(0, maturity - 1 / 20);
    }

    history.push({ w, members, maturity, pen, strength, boostHub, benefit, cost, liability, net: benefit - cost });
  }
  return history;
}

// ─── 1. Tier table sanity ────────────────────────────────────────────────────
console.log('\n1. Tier caps — Elite must dominate Gold');
{
  const gold = loyaltyTier(400_000), elite = loyaltyTier(800_000), basic = loyaltyTier(60_000);
  check('Elite demand cap > Gold demand cap', elite.demandCap > gold.demandCap);
  check('Elite sens cap > Gold sens cap', elite.sensCap > gold.sensCap);
  check('Elite matures faster than Gold', elite.maturityFactor > gold.maturityFactor);
  check('Basic caps are modest (≤5% demand)', basic.demandCap <= 0.05);
  check('tier caps bind: Basic at full strength ≤ cap',
    loyaltyDemandBoostPct(0.6, basic) === basic.demandCap);
}

// ─── 2. Maturity gates effects ───────────────────────────────────────────────
console.log('\n2. Maturity gating');
{
  const pen = 0.40;
  const young  = loyaltyEffectiveStrength(pen, 0);
  const mature = loyaltyEffectiveStrength(pen, 1);
  check('young program delivers 25% of potential', Math.abs(young / mature - 0.25) < 1e-9);
  const gold = loyaltyTier(400_000);
  check('young program demand boost is small (<3%)', loyaltyDemandBoostPct(young, gold) < 0.03,
    `got ${loyaltyDemandBoostPct(young, gold)}`);
  check('mature 40% pen hits Gold demand cap', loyaltyDemandBoostPct(mature, gold) === gold.demandCap);
  check('rep bonus needs maturity: 40% pen young ≤ +2', loyaltyReputationBonus(young) <= 2);
  check('rep bonus maxes only when deep AND mature', loyaltyReputationBonus(loyaltyEffectiveStrength(0.55, 1)) === 8);
}

// ─── 3. Points liability economics ───────────────────────────────────────────
console.log('\n3. Points liability');
{
  // Steady state: liability → earned / REDEEM_RATE
  const rev = 20_000_000, pen = 0.45, gen = 1.15;
  let lia = 0;
  for (let i = 0; i < 300; i++) lia = loyaltyPointsFlows(lia, rev, pen, gen).newLiability;
  const earned = rev * pen * LOYALTY_EARN_RATE * gen;
  const expectedSteady = earned / LOYALTY_REDEEM_RATE;
  check('liability converges to earn/redeemRate', Math.abs(lia - expectedSteady) / expectedSteady < 0.01,
    `lia=${Math.round(lia)} expected≈${Math.round(expectedSteady)}`);
  check('steady liability is serious money (≈1.3× weekly revenue)', lia > rev * 1.1 && lia < rev * 1.6,
    `ratio=${(lia / rev).toFixed(2)}`);
  const steadyCost = loyaltyPointsFlows(lia, rev, pen, gen).redeemedCost;
  check('steady redemption cost ~3–4.5% of revenue', steadyCost / rev > 0.03 && steadyCost / rev < 0.045,
    `pct=${(steadyCost / rev * 100).toFixed(2)}%`);
  check('breakage relieves ~20% of draw', Math.abs(LOYALTY_BREAKAGE - 0.20) < 1e-9);
  // Early weeks: cost lags earn badly (the bill arrives later)
  const early = loyaltyPointsFlows(0, rev, 0.10, 0.85);
  check('week-1 redemption cost is ~0 while earn accrues', early.redeemedCost === 0 && early.earned > 0);
}

// ─── 4. Long-horizon payback (the core design goal) ─────────────────────────
console.log('\n4. Payback horizon — expensive early, pays off late');
{
  const h = simulateProgram({ weeklyInvestment: 400_000, weeks: 260 }); // Gold, 5 years
  const wk = (n) => h[n - 1];

  check('penetration ramps slower than before (<20% at wk 13)', wk(13).pen < 0.20, `pen=${wk(13).pen.toFixed(3)}`);
  check('maturity ~16% after 3 months', Math.abs(wk(13).maturity - 13 / 80) < 0.02);

  const firstYearNet = h.slice(0, 52).reduce((s, x) => s + x.net, 0);
  check('program is a NET LOSS over year 1', firstYearNet < 0, `net=${Math.round(firstYearNet).toLocaleString()}`);

  const year3Net = h.slice(104, 156).reduce((s, x) => s + x.net, 0);
  check('program is net-positive by year 3 (demand lift alone)', year3Net > 0, `net=${Math.round(year3Net).toLocaleString()}`);

  // Cumulative breakeven should land well beyond a year but within the sim
  let cum = 0, breakevenWk = null;
  for (const x of h) { cum += x.net; if (breakevenWk == null && cum > 0) breakevenWk = x.w; }
  check('cumulative breakeven takes 1.5–4 years', breakevenWk != null && breakevenWk > 78 && breakevenWk < 208,
    `breakeven wk=${breakevenWk}`);

  const end = wk(260);
  // NOTE: benefit proxy counts ONLY the hub demand lift — the price-sensitivity
  // shield (−15%) and +8 reputation are excluded, so real net is higher.
  check('mature program is net-positive weekly on demand lift alone', end.net > 50_000, `net/wk=${Math.round(end.net).toLocaleString()}`);
  check('liability stabilises (not runaway)', end.liability < 20_000_000 * 1.6, `lia=${Math.round(end.liability).toLocaleString()}`);
}

// ─── 5. Defunding a mature program hurts ─────────────────────────────────────
console.log('\n5. Defunding penalty');
{
  const h = simulateProgram({ weeklyInvestment: 400_000, weeks: 200, defundAtWeek: 160 });
  const before = h[158], after20 = h[178], end = h[199];
  check('members collapse after defunding (−35%+ in 20 wks)', after20.members < before.members * 0.66,
    `${before.members} → ${after20.members}`);
  check('maturity mostly unwound within ~20 wks', after20.maturity < 0.08, `mat=${after20.maturity.toFixed(2)}`);
  check('points still cost money after defunding (debt honoured)',
    h.slice(160, 180).every(x => x.cost > 0));
  check('benefits gone by end while liability lingers', end.benefit < before.benefit * 0.25 && end.liability > 0);
}

// ─── 6. Airline shrinks — no permanent 100% penetration ─────────────────────
console.log('\n6. Shrinking airline');
{
  // Build a mature Elite program at 100k pax/wk, then shrink to 25k pax/wk.
  // Inactive members must lapse toward the 85% hard cap instead of pinning
  // penetration at 100% forever.
  const HARD_CAP_PEN = 0.85, EXCESS_LAPSE = 0.90;
  let members = 0, maturity = 0;
  const step = (pax, inv) => {
    const tier = loyaltyTier(inv);
    if (inv > 0) {
      const ceiling  = tier.maxPenetration * pax * 4;
      const headroom = ceiling > 0 ? Math.max(0, 1 - members / ceiling) : 0;
      members  = Math.round(members * 0.996 + pax * loyaltyEnrollPull(inv) * headroom);
      maturity = Math.min(1, maturity + (tier.maturityFactor ?? 1) / 80);
    } else {
      members = Math.round(members * (maturity > 0.4 ? 0.97 : 0.988));
      maturity = Math.max(0, maturity - 1 / 20);
    }
    const hardCap = Math.round(pax * 4 * HARD_CAP_PEN);
    if (hardCap > 0 && members > hardCap) members = Math.round(hardCap + (members - hardCap) * EXCESS_LAPSE);
  };
  for (let w = 0; w < 150; w++) step(100_000, 800_000);   // grow big at Elite
  const bigMembers = members;
  check('big-airline penetration below hard cap', loyaltyPenetration(bigMembers, 100_000) < 0.85);
  for (let w = 0; w < 26; w++) step(25_000, 800_000);     // shrink to a quarter the pax
  const penHalfYear = loyaltyPenetration(members, 25_000);
  check('6 months after shrinking, penetration falling (<92%)', penHalfYear < 0.92, `pen=${penHalfYear.toFixed(3)}`);
  for (let w = 0; w < 26; w++) step(25_000, 800_000);     // another 6 months
  const penYear = loyaltyPenetration(members, 25_000);
  check('1 year after shrinking, penetration ≤ 86%', penYear <= 0.86, `pen=${penYear.toFixed(3)}`);
  check('inactive members actually lapsed', members < bigMembers * 0.55, `${bigMembers} → ${members}`);
}

// ─── 7. Enrollment pull halved ───────────────────────────────────────────────
console.log('\n7. Enrollment pacing');
{
  check('pull capped at 12%/wk', loyaltyEnrollPull(10_000_000) === 0.12);
  check('Gold pull is 10%/wk', Math.abs(loyaltyEnrollPull(400_000) - 0.10) < 1e-9);
  check('Basic pull is 1.5%/wk', Math.abs(loyaltyEnrollPull(60_000) - 0.015) < 1e-9);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
