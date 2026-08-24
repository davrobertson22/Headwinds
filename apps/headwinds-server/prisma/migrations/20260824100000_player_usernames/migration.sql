-- Player-chosen usernames (player profiles, phase 2).
--
-- The column is nullable: nobody is renamed out from under themselves, and the
-- population converges to all-unique through the lobby's claim flow. The rule
-- that matters lives in the second index — uniqueness is CASE-INSENSITIVE
-- ("Dave" and "dave" are one name), which Prisma cannot express, so the
-- functional index below is the authority and the plain one is the
-- case-sensitive companion the schema declares.

ALTER TABLE "Account" ADD COLUMN "username" TEXT;

CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");
CREATE UNIQUE INDEX "Account_username_lower_key" ON "Account"(lower("username"));

-- Rename audit trail: every set, including the first claim (oldName null).
-- The moderation panel reads it so a rename cannot outrun a reputation.
CREATE TABLE "NameChange" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "oldName" TEXT,
    "newName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NameChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NameChange_accountId_createdAt_idx" ON "NameChange"("accountId", "createdAt");

ALTER TABLE "NameChange" ADD CONSTRAINT "NameChange_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
