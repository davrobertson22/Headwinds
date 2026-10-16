# Discord post — used-market cost basis + borrowing ceilings (2026-10-15)

Post AFTER both deploys have landed (cost basis + the credit ceilings) and
after deciding whether the backfill runs — the last paragraph differs. No
names: the players involved were playing within the rules as written. Two
posts, each under Discord's 2,000-character non-Nitro limit.

Facts to keep straight if editing:
- Estate (fire-sale) listings are priced at 65% of NAV. Aircraft Finance lent
  70% of FULL book value. SELL_AIRCRAFT paid NAV − 5% back to the shop.
  So: pledge a 0.65 frame for 0.70 (free plane), or flip it for +30% of NAV.
- A tail bought on the used market OR delivered from a factory order now
  records what was paid (costBasis). Collateral, resale and hull write-off
  payouts value it at the LOWER of book and basis. NAV only falls, so a frame
  bought at book behaves exactly as before.
- Borrowing: after a new loan, weekly debt service ≤ 50% of operating cash
  flow (net income before loan payments, 4-week average); total loan debt ≤
  4× book equity (cash + fleet at lower-of-cost-or-book − loans). The $5M /
  $10M / $20M unsecured base amounts are always available. Existing loans are
  not re-margined — nothing already drawn changes.
- Nobody was tampering with the API. The decision journal accounted for every
  plane and every dollar.

---

**Post 1 — the loophole**

**Balance fix: aircraft are now worth what you paid for them**

We've closed a loop in the used aircraft market that was letting a few airlines grow far faster than their routes could pay for.

**What was happening.** When an airline goes bankrupt, its owned aircraft go on the used market at a distressed price — well below book value (NAV). But two other systems still valued those frames at full NAV: Aircraft Finance would lend 70% of full book, and selling a plane back to the shop paid full NAV minus 5%. So a frame bought cheap from an estate could be pledged for *more than it cost*, or sold straight back at a profit. Every estate sale was free aircraft plus free cash, and the bigger your fleet got, the more the bank would lend you to buy the next one.

**What changed.** An aircraft now remembers what you paid for it — used-market buys and factory orders alike. From here on:

- Loans against it are secured on what you paid, not on full book value.
- Selling it back pays what you paid minus 5%, not NAV minus 5%. The Fleet sell dialog shows this when it applies.
- Hull write-off insurance pays out on the same figure.

NAV only ever declines, so a plane bought at book value behaves exactly as before, and the cap stops mattering once normal depreciation catches up. Estate sales are still a bargain and still the best time to expand. They're just not a money printer.

**What didn't happen.** We had a report suggesting this might be API tampering, and we checked. Every action is validated on the server and journaled, and the audit trail accounted for every plane and every dollar. Nobody was hacking anything; this was a gap in the game's own economics, found by players playing within the rules as written.

---

**Post 2 — borrowing**

**Also: the bank now asks whether you can pay**

Until now Aircraft Finance had one question: how much metal do you own? It'll now ask two more, the same two any lender asks:

- **Can you cover it?** After a new loan, your total weekly loan payments can't be more than half of your operating cash flow (net income before loan payments, averaged over the last four weeks). An airline that's losing money won't be offered new secured credit until it's back in profit.
- **How geared are you already?** Total loans can't exceed four times your book equity — cash plus owned aircraft (at the lower of book and what you paid), minus loans.

The $5M / $10M / $20M unsecured amounts stay available regardless, so a new airline can still borrow to get started. The Loans tab now tells you which limit is setting your figure ("limited by earnings", "limited by debt-to-equity").

**Nothing already drawn changes.** Existing loans keep their rate, term and payments. These rules only apply to new borrowing.

---

**If the backfill runs, append to Post 1 instead of the last paragraph:**

The rule applies to aircraft already in fleets too: frames bought from estates before today have been given their purchase price as their basis, so they sell and borrow on the same terms as a frame bought this week. Cash, loans and the planes themselves are untouched.

**If it doesn't, append instead:**

The rule applies to aircraft bought from today. Nothing already in anyone's fleet has changed.
