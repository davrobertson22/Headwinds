-- Alliance slot pool: the owner's per-airport "share my spare slots" switch.
-- Hand-authored offline (same effect as `prisma migrate dev` for the schema
-- change); applied in production by `prisma migrate deploy` (Railway pre-deploy).
-- No per-draw table exists on purpose — borrowed usage is derived from route
-- blobs + these settings on every view build / tick.

-- CreateTable
CREATE TABLE "GateSlotShare" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "airlineId" TEXT NOT NULL,
    "airportCode" TEXT NOT NULL,
    "sharing" BOOLEAN NOT NULL DEFAULT false,
    "reservedSlots" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GateSlotShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GateSlotShare_airlineId_airportCode_key" ON "GateSlotShare"("airlineId", "airportCode");

-- CreateIndex
CREATE INDEX "GateSlotShare_worldId_idx" ON "GateSlotShare"("worldId");

-- AddForeignKey
ALTER TABLE "GateSlotShare" ADD CONSTRAINT "GateSlotShare_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS (matches the gate-scarcity tables — service-role access only; re-run the
-- Supabase RLS DO-block after deploy, see docs).
ALTER TABLE "GateSlotShare" ENABLE ROW LEVEL SECURITY;
