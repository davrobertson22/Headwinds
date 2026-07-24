-- Used aircraft market (all Headwinds worlds).
-- A completed SELL_AIRCRAFT (seller paid NAV − 5% by the reducer) lists that exact
-- tail here at NAV; any airline can buy it and it arrives on the next weekly tick.
-- The game is the counterparty on both sides — the 5% sell fee is the shop's
-- spread. Age and price are frozen while a tail is listed; a listing unsold for
-- 104 weeks (2 game-years) is scrapped by the weekly tick.

-- CreateTable
CREATE TABLE "UsedAircraftListing" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "origin" TEXT,
    "typeId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "navPrice" INTEGER NOT NULL,
    "listedWeek" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "buyerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "soldAt" TIMESTAMP(3),

    CONSTRAINT "UsedAircraftListing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsedAircraftListing_worldId_status_idx" ON "UsedAircraftListing"("worldId", "status");

-- AddForeignKey
ALTER TABLE "UsedAircraftListing" ADD CONSTRAINT "UsedAircraftListing_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Supabase RLS: new public tables ship without row-level security and the advisor
-- flags them. Server access uses the service role (bypasses RLS), so enabling RLS
-- with no policies is safe and correct here.
ALTER TABLE "UsedAircraftListing" ENABLE ROW LEVEL SECURITY;
