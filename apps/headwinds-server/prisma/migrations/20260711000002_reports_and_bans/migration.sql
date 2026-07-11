-- Player reports + account bans. Players flag rule violations (Report); admins
-- review them and may ban the reported account (Account ban columns). Banned
-- accounts are rejected at auth (src/auth.mjs), which cuts off every world.
-- Hand-authored offline; applied in production by `prisma migrate deploy`
-- (Railway pre-deploy).

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'ACTIONED', 'DISMISSED');

-- AlterTable: account-wide ban fields
ALTER TABLE "Account" ADD COLUMN     "bannedAt" TIMESTAMP(3);
ALTER TABLE "Account" ADD COLUMN     "banReason" TEXT;
ALTER TABLE "Account" ADD COLUMN     "bannedByEmail" TEXT;

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "reporterAccountId" TEXT NOT NULL,
    "reporterAirlineId" TEXT,
    "reportedAccountId" TEXT NOT NULL,
    "reportedAirlineId" TEXT,
    "category" TEXT NOT NULL,
    "details" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedByEmail" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Report_reportedAccountId_idx" ON "Report"("reportedAccountId");

-- CreateIndex
CREATE INDEX "Report_worldId_idx" ON "Report"("worldId");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterAccountId_fkey" FOREIGN KEY ("reporterAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reportedAccountId_fkey" FOREIGN KEY ("reportedAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
