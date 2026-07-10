-- Player alliances: founded and governed by players (founder approves joins).
-- Hand-authored offline (same effect as `prisma migrate dev` for the schema
-- change); applied in production by `prisma migrate deploy` (Railway pre-deploy).

-- CreateEnum
CREATE TYPE "AllianceMemberStatus" AS ENUM ('PENDING', 'ACTIVE');

-- CreateEnum
CREATE TYPE "AllianceMemberRole" AS ENUM ('FOUNDER', 'MEMBER');

-- CreateTable
CREATE TABLE "Alliance" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alliance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllianceMember" (
    "id" TEXT NOT NULL,
    "allianceId" TEXT NOT NULL,
    "airlineId" TEXT NOT NULL,
    "status" "AllianceMemberStatus" NOT NULL DEFAULT 'PENDING',
    "role" "AllianceMemberRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllianceMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Alliance_worldId_name_key" ON "Alliance"("worldId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AllianceMember_airlineId_key" ON "AllianceMember"("airlineId");

-- CreateIndex
CREATE INDEX "AllianceMember_allianceId_status_idx" ON "AllianceMember"("allianceId", "status");

-- AddForeignKey
ALTER TABLE "Alliance" ADD CONSTRAINT "Alliance_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllianceMember" ADD CONSTRAINT "AllianceMember_allianceId_fkey" FOREIGN KEY ("allianceId") REFERENCES "Alliance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
