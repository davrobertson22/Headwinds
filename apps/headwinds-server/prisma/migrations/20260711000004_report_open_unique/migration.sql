-- At most ONE open report per (world, reporter, reported) trio. Backs the
-- app-level "fold a repeat into the existing open report" dedupe so two
-- concurrent reports can no longer both create an OPEN row. Partial index
-- (Prisma can't express a WHERE on @@unique, so this lives only in SQL).
CREATE UNIQUE INDEX "Report_open_reporter_reported_key"
  ON "Report" ("worldId", "reporterAccountId", "reportedAccountId")
  WHERE "status" = 'OPEN';
