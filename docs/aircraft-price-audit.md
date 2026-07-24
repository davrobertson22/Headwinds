# Headwinds Aircraft Price Audit (pre-maintenance)

**Date:** 2026-07-24
**Purpose:** Verify `purchasePrice` values are realistic and internally consistent *before* the C/D maintenance work, since check costs (and fleetNAV, depreciation, lease deposits) all key off `purchasePrice`. A mispriced airframe would get mispriced check costs downstream.

## Method

- Parsed all **153 aircraft types** from `data/aircraft.js` (spec + buy price + lease + base maintenance).
- Accounted for the two in-game discounts already applied at purchase:
  - **Fleet-commonality discount** (`buyDiscount`): 2% on the 2nd unit → 3% at 2+ → max **5%** at 4+. This is small — the listed `purchasePrice` is effectively the "1–2 unit" price.
  - **Engine `priceMod`**: ±1–2.5% depending on option.
  - Net: a player pays between ~100% and ~92.5% of `purchasePrice`. The discount is modest enough that `purchasePrice` should read as a real transaction value on its own.
- Cross-checked representative types against **current (2025) real transaction values**, not list prices (airlines pay ~50% below list on new orders — verified below).

## Headline finding

**The table is well-calibrated.** The game already prices aircraft at real *transaction* value (~50% off list) and prices out-of-production types at *used* value. Two hunches I went in with — that the Embraer E2s and the A330neo were underpriced — were **wrong on verification**; both are spot-on. Only one airframe is a clear outlier.

### Verification spot-checks (in-game vs real 2025 transaction value)

| Type | In-game buy | Real transaction (2025) | Verdict |
|---|---|---|---|
| A320neo | $50M | list $113.5M → ~$55–90M real | ✅ good |
| 737 MAX 8 | $55M | list $121.6M → ~$55–65M real | ✅ good |
| E195-E2 | $45M | Mexicana paid ~$40M/ea (53% off list) | ✅ good |
| E190-E2 | $40M | Mexicana paid ~$35M/ea | ✅ good |
| A330-900neo | $110M | newly-built market value ~$107M | ✅ excellent |
| A350-900 | $185M | ~$180–210M real | ✅ good |
| 787-9 | $150M | list $292M → ~$140–150M real | ✅ good |
| 777-300ER | $170M | new-transaction ~$150–170M | ✅ good (priced as new) |

## The one change I'd make now

### 🔴 COMAC C919 — overpriced, and internally inverted

- **In-game:** $75M buy / $150k-wk lease. That makes it **the most expensive narrowbody in the game** — pricier than the A321XLR ($65M), 737 MAX 10 ($60M), and A321neo ($58M).
- **Reality:** the C919 is a budget domestic jet. List is $108M, but the entire point of the aircraft (per COMAC coverage) is that "government incentives and discounts mean airlines won't pay more" — real deals land around **~$50–55M**, i.e. right alongside the A320neo and below the 737 MAX 8.
- **Why it matters here:** it's both unrealistic *and* backwards — a value narrowbody sitting at the top of the price ladder. And once maintenance lands, a $75M base would give it inflated C/D check costs too.

**Recommended:**
```
purchasePrice: 75_000_000  →  52_000_000
weeklyLease:      150_000  →     104_000   // keeps the ~10.4%/yr lease ratio intact
```
(`baseMaintenancePerWk` is already $55k, in line with the A320neo's $59k — leave it.)

This drops the C919 to just above the A320neo ($50M) — correct for a newer but value-positioned jet — and un-inverts the narrowbody ladder.

## Optional / minor (your call, low stakes)

- **ATR 72-600 — $26M.** Priced at roughly list; real transaction is ~$20–24M, and it currently sits *above* the larger Dash 8 Q400 ($22M). If you want the turboprop ladder clean, nudge to **$22M** (lease $52k → $44k). Very minor — both are inside the noise.
- **Airbus A380 — $150M.** A judgment call, not a clear error. Your table prices *obsolete* out-of-production types at used value (747-400 $55M, 767-300ER $28M) but keeps *still-frontline* ones near new (777-300ER $170M). The A380 at $150M is treated as "still frontline." That's defensible as a prestige halo aircraft, but if you'd rather it follow the used-value rule (its real resale market collapsed to ~$30–50M), you could drop it toward **$90–110M**. I'd leave it unless the halo pricing bugs you.

## Ripple notes (all clean)

- `purchasePrice` feeds fleetNAV, depreciation, lease deposit (12 wk), and — soon — C/D check costs. Changing a data constant flows through all of them automatically; no migration needed.
- Any live save that already owns a C919 would see that airframe's NAV/market-cap contribution drop proportionally. Very few players likely own one; acceptable.
- Do this **before** the maintenance build so check-cost tuning is done against the corrected base.

## Bottom line

One firm change (**C919 $75M → $52M**, lease to match), two optional tweaks, and the other ~150 types check out against real 2025 transaction values. The pricing model is sound — it just had one jet on the wrong rung.
