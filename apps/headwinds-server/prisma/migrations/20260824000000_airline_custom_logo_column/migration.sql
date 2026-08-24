-- customLogo out of the save blob, into its own column (disk-IO fix).
--
-- The tick rewrites every active airline's whole `state` JSONB each world-week;
-- Postgres TOASTs a full new copy of the value on every such write (plus WAL,
-- plus the dead copy vacuum reclaims). A user-uploaded logo is a static
-- data-URL that never changes between ticks — as part of the blob it was being
-- re-written to disk forever; as a column it is written once and then never
-- again (an UPDATE that doesn't touch a TOASTed column leaves its chunks in
-- place). See apps/headwinds-server/src/lib/logoColumn.mjs for the contract.

ALTER TABLE "Airline" ADD COLUMN "customLogo" TEXT;

-- Backfill from every blob that carries the key, then strip the key so the
-- blob never pays for it again. One final whole-blob rewrite per affected row
-- — the last time the logo bytes ever ride a blob write. NULLIF guards the
-- empty string; a JSON null comes back from ->> as SQL NULL already.
UPDATE "Airline"
   SET "customLogo" = NULLIF(state ->> 'customLogo', ''),
       state        = state - 'customLogo'
 WHERE state ? 'customLogo';
