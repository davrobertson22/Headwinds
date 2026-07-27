-- Gate auction: record what happened to EVERY bid, not just the winning ones.
--
-- `results` only ever held winners, so an auction that sold nothing — or a bid
-- voided at resolution by the ownership cap, a lockout, or a cash shortfall —
-- left no trace anywhere a player (or a maintainer) could read. The auction row
-- flipped to RESOLVED, the open-auction view stopped returning it, and the feed
-- stayed silent. Bidders were told nothing at all.
--
-- `outcomes` is one entry per bid: [{ airlineId, airline, amount, quantity,
-- gates, reason, detail }] where reason is WON | OUTBID | NO_LOTS_LEFT |
-- INSUFFICIENT_CASH | OWNERSHIP_CAP | ALLIANCE_CAP | LOCKED_OUT |
-- AIRLINE_INACTIVE | NO_LEDGER_ROW | WRITE_CONFLICT.
--
-- Nullable with no backfill: auctions resolved before this ship keep NULL, and
-- both the UI and tools/gate-auction-report.mjs treat NULL as "not recorded".

ALTER TABLE "GateAuction" ADD COLUMN "outcomes" JSONB;
