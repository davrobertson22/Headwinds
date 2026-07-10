-- In-game messaging: airline-to-airline DMs + alliance chat, block list, and
-- per-airline read cursors. Hand-authored offline; applied in production by
-- `prisma migrate deploy` (Railway pre-deploy).

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('DM', 'ALLIANCE');

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "kind" "MessageKind" NOT NULL DEFAULT 'DM',
    "fromAirlineId" TEXT NOT NULL,
    "toAirlineId" TEXT,
    "allianceId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageBlock" (
    "id" TEXT NOT NULL,
    "airlineId" TEXT NOT NULL,
    "blockedAirlineId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageCursor" (
    "id" TEXT NOT NULL,
    "airlineId" TEXT NOT NULL,
    "allianceSeenAt" TIMESTAMP(3),

    CONSTRAINT "MessageCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Message_worldId_toAirlineId_readAt_idx" ON "Message"("worldId", "toAirlineId", "readAt");

-- CreateIndex
CREATE INDEX "Message_worldId_fromAirlineId_createdAt_idx" ON "Message"("worldId", "fromAirlineId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_allianceId_createdAt_idx" ON "Message"("allianceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageBlock_airlineId_blockedAirlineId_key" ON "MessageBlock"("airlineId", "blockedAirlineId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageCursor_airlineId_key" ON "MessageCursor"("airlineId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;
