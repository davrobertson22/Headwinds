-- Capital actions: the cross-player dividend ledger.
--
-- Why a ledger and not a direct credit: tickWorldOnce computes every airline in one
-- pass, but each airline's write is a version compare-and-set that SKIPS any airline
-- whose player just made a decision. If a payer's write landed and a recipient's did
-- not, a directly-applied credit would vanish; reverse it and money would be minted.
--
-- So the payer's debit happens inside its own blob (the reducer), credit ROWS are
-- written in the same transaction but only for airlines whose write actually landed,
-- and each recipient applies its unconsumed rows at the start of its next tick —
-- marking them consumed only if ITS write lands. A skipped airline simply gets paid
-- next week. Money is conserved on every path, including retried ticks.

CREATE TABLE "DividendCredit" (
  "id"        TEXT NOT NULL,
  "worldId"   TEXT NOT NULL,
  "airlineId" TEXT NOT NULL,   -- recipient
  "fromId"    TEXT NOT NULL,   -- payer
  "fromName"  TEXT,
  "amount"    BIGINT NOT NULL,
  "week"      INTEGER NOT NULL,
  "consumed"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DividendCredit_pkey" PRIMARY KEY ("id")
);

-- The hot path: "what does this airline still have to collect?"
CREATE INDEX "DividendCredit_airlineId_consumed_idx" ON "DividendCredit"("airlineId", "consumed");
CREATE INDEX "DividendCredit_worldId_week_idx" ON "DividendCredit"("worldId", "week");

ALTER TABLE "DividendCredit" ADD CONSTRAINT "DividendCredit_worldId_fkey"
  FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;
