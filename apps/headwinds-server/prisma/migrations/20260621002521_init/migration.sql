-- CreateEnum
CREATE TYPE "WorldStatus" AS ENUM ('LOBBY', 'RUNNING', 'ENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "AirlineStatus" AS ENUM ('ACTIVE', 'BANKRUPT', 'ABANDONED');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "authUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "cosmetics" JSONB NOT NULL DEFAULT '[]',
    "careerStats" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "World" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "WorldStatus" NOT NULL DEFAULT 'LOBBY',
    "visibility" "Visibility" NOT NULL DEFAULT 'PUBLIC',
    "lengthYears" INTEGER NOT NULL,
    "weeksPerDay" INTEGER NOT NULL,
    "currentWeek" INTEGER NOT NULL DEFAULT 1,
    "currentYear" INTEGER NOT NULL DEFAULT 1,
    "maxPlayers" INTEGER NOT NULL DEFAULT 50,
    "joinCode" TEXT,
    "worldSeed" TEXT NOT NULL,
    "tickConfig" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "World_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Airline" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hub" TEXT NOT NULL,
    "homeCountry" TEXT,
    "state" JSONB NOT NULL,
    "cash" BIGINT NOT NULL DEFAULT 0,
    "marketCap" BIGINT NOT NULL DEFAULT 0,
    "week" INTEGER NOT NULL DEFAULT 1,
    "status" "AirlineStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedWeek" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Airline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "airlineId" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TickLog" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "error" TEXT,

    CONSTRAINT "TickLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Standing" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "airlineId" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Standing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_authUserId_key" ON "Account"("authUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_email_key" ON "Account"("email");

-- CreateIndex
CREATE UNIQUE INDEX "World_joinCode_key" ON "World"("joinCode");

-- CreateIndex
CREATE INDEX "World_status_visibility_idx" ON "World"("status", "visibility");

-- CreateIndex
CREATE INDEX "Airline_worldId_cash_idx" ON "Airline"("worldId", "cash");

-- CreateIndex
CREATE UNIQUE INDEX "Airline_worldId_accountId_key" ON "Airline"("worldId", "accountId");

-- CreateIndex
CREATE INDEX "Decision_worldId_week_idx" ON "Decision"("worldId", "week");

-- CreateIndex
CREATE INDEX "TickLog_worldId_week_idx" ON "TickLog"("worldId", "week");

-- CreateIndex
CREATE INDEX "Standing_worldId_week_rank_idx" ON "Standing"("worldId", "week", "rank");

-- AddForeignKey
ALTER TABLE "Airline" ADD CONSTRAINT "Airline_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Airline" ADD CONSTRAINT "Airline_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TickLog" ADD CONSTRAINT "TickLog_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Standing" ADD CONSTRAINT "Standing_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;
