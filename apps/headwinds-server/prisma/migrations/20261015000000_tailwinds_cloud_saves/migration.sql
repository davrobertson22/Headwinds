-- Tailwinds cloud saves: a supporter perk for the single-player game. Up to three
-- .twsave files per account, stored byte-for-byte, deleted with the account.
-- Only Account."isSupporter" gates UPLOAD (in lib/cloudSaves.mjs); nothing in any
-- Headwinds world or the engine reads this table.
CREATE TABLE "TailwindsCloudSave" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "fileVersion" INTEGER NOT NULL,
    "meta" JSONB NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL,
    "deviceLabel" TEXT,

    CONSTRAINT "TailwindsCloudSave_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TailwindsCloudSave_accountId_slot_key" ON "TailwindsCloudSave"("accountId", "slot");

ALTER TABLE "TailwindsCloudSave" ADD CONSTRAINT "TailwindsCloudSave_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
