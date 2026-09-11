-- Supporter badge: granted to players who've chipped in on Ko-fi toward the
-- server bill. Cosmetic ONLY — nothing in the engine reads this column, and
-- nothing ever should (see the note on Account.isSupporter in schema.prisma).
-- Mirrors "isOG": account-wide, admin-granted, rendered as a chip beside the
-- airline name and never stored in the name string itself.
ALTER TABLE "Account" ADD COLUMN "isSupporter" BOOLEAN NOT NULL DEFAULT false;
