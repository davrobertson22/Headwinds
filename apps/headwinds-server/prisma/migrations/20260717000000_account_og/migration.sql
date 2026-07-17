-- OG veteran badge: admin-granted, account-wide flag for players who've been
-- flying since the original Tailwinds. Rendered as a gold chip beside the
-- airline name everywhere it appears — never stored in the name string.
ALTER TABLE "Account" ADD COLUMN "isOG" BOOLEAN NOT NULL DEFAULT false;
