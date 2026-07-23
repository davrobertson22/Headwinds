-- Gate scarcity (optional per-world setting: tickConfig.gateScarcity)
-- WorldGate = the authoritative per-(world, airport) gate ledger;
-- GateAuction/GateBid = yearly sealed-bid auctions at full airports;
-- GateListing = the player-to-player gate marketplace.

-- CreateTable
CREATE TABLE "WorldGate" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "airportCode" TEXT NOT NULL,
    "baseSize" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "taken" INTEGER NOT NULL DEFAULT 0,
    "holdings" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorldGate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateAuction" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "airportCode" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lots" INTEGER NOT NULL,
    "reserve" INTEGER NOT NULL,
    "opensWeek" INTEGER NOT NULL,
    "resolvesWeek" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "results" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GateAuction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateBid" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "airlineId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GateBid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateListing" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "airportCode" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "askPrice" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "buyerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "soldAt" TIMESTAMP(3),

    CONSTRAINT "GateListing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorldGate_worldId_airportCode_key" ON "WorldGate"("worldId", "airportCode");

-- CreateIndex
CREATE UNIQUE INDEX "GateAuction_worldId_airportCode_year_key" ON "GateAuction"("worldId", "airportCode", "year");

-- CreateIndex
CREATE INDEX "GateAuction_worldId_status_idx" ON "GateAuction"("worldId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GateBid_auctionId_airlineId_key" ON "GateBid"("auctionId", "airlineId");

-- CreateIndex
CREATE INDEX "GateListing_worldId_status_idx" ON "GateListing"("worldId", "status");

-- CreateIndex
CREATE INDEX "GateListing_sellerId_status_idx" ON "GateListing"("sellerId", "status");

-- AddForeignKey
ALTER TABLE "WorldGate" ADD CONSTRAINT "WorldGate_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateAuction" ADD CONSTRAINT "GateAuction_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateBid" ADD CONSTRAINT "GateBid_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "GateAuction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateListing" ADD CONSTRAINT "GateListing_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Supabase RLS: new public tables ship without row-level security and the
-- advisor flags them. Server access uses the service role (bypasses RLS), so
-- enabling RLS with no policies is safe and correct here.
ALTER TABLE "WorldGate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GateAuction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GateBid" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GateListing" ENABLE ROW LEVEL SECURITY;
