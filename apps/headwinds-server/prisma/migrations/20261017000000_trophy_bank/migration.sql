-- Trophy bank: admin-made trophies (with artwork) awarded by hand, usually from
-- an event world's final ranking, and shown in the winner's public trophy case.
-- Cosmetic only: no world, tick or engine code reads these tables.
CREATE TABLE "Trophy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image" BYTEA,
    "imageType" TEXT,
    "imageHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByEmail" TEXT,

    CONSTRAINT "Trophy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrophyAward" (
    "id" TEXT NOT NULL,
    "trophyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "worldId" TEXT,
    "worldName" TEXT,
    "airlineName" TEXT,
    "place" INTEGER,
    "note" TEXT,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "awardedByEmail" TEXT,

    CONSTRAINT "TrophyAward_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TrophyAward_accountId_idx" ON "TrophyAward"("accountId");
CREATE INDEX "TrophyAward_worldId_idx" ON "TrophyAward"("worldId");

ALTER TABLE "TrophyAward" ADD CONSTRAINT "TrophyAward_trophyId_fkey" FOREIGN KEY ("trophyId") REFERENCES "Trophy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrophyAward" ADD CONSTRAINT "TrophyAward_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
