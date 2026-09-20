-- Supporter worlds: private worlds a ♥ SUPPORTER account creates for its own
-- group. Null = operator-created (unchanged). See World.ownerAccountId in
-- schema.prisma for the three rules (always private + owner password, every
-- member must be a supporter, at most 2 live supporter worlds per account).
-- SET NULL rather than CASCADE: an owner's account going away must not take
-- their friends' world with it.
ALTER TABLE "World" ADD COLUMN "ownerAccountId" TEXT;

ALTER TABLE "World" ADD CONSTRAINT "World_ownerAccountId_fkey"
  FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "World_ownerAccountId_status_idx" ON "World"("ownerAccountId", "status");

-- The join code is now an owner-chosen password on supporter worlds, and two
-- groups may pick the same one. Nothing looks a world up by code (entry is
-- always world id + code), so the unique index from the init migration goes.
DROP INDEX IF EXISTS "World_joinCode_key";
