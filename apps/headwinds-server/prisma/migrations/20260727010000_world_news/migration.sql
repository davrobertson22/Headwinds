-- CreateTable
CREATE TABLE "WorldNews" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "airlineId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "tier" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorldNews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorldNews_worldId_createdAt_idx" ON "WorldNews"("worldId", "createdAt");

-- CreateIndex
CREATE INDEX "WorldNews_worldId_week_idx" ON "WorldNews"("worldId", "week");

-- AddForeignKey
ALTER TABLE "WorldNews" ADD CONSTRAINT "WorldNews_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;
