-- Account-level messaging (player profiles, phase 3).
--
-- Messages between ACCOUNTS, not airlines: reachable from any profile,
-- world-less, surviving every season. A parallel system to the world-scoped
-- Message table, not a retrofit of it.

CREATE TYPE "DmPolicy" AS ENUM ('EVERYONE', 'SHARED_WORLD', 'NOBODY');

ALTER TABLE "Account" ADD COLUMN "dmPolicy" "DmPolicy" NOT NULL DEFAULT 'SHARED_WORLD';

CREATE TABLE "AccountMessage" (
    "id" TEXT NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "AccountMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountMessage_toAccountId_readAt_idx" ON "AccountMessage"("toAccountId", "readAt");
CREATE INDEX "AccountMessage_fromAccountId_createdAt_idx" ON "AccountMessage"("fromAccountId", "createdAt");
CREATE INDEX "AccountMessage_toAccountId_createdAt_idx" ON "AccountMessage"("toAccountId", "createdAt");

CREATE TABLE "AccountMessageBlock" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "blockedAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountMessageBlock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountMessageBlock_accountId_blockedAccountId_key" ON "AccountMessageBlock"("accountId", "blockedAccountId");

-- Reports filed from account messages carry no world at all.
ALTER TABLE "Report" ALTER COLUMN "worldId" DROP NOT NULL;

-- The world-scoped open-report dedupe index treats a NULL worldId as always
-- distinct (Postgres unique-index NULL semantics), so account-context reports
-- get their own partial index for the same one-OPEN-row guarantee.
CREATE UNIQUE INDEX "Report_open_account_reporter_reported_key"
  ON "Report" ("reporterAccountId", "reportedAccountId")
  WHERE "status" = 'OPEN' AND "worldId" IS NULL;
