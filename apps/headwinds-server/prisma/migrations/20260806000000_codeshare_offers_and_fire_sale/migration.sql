-- P6c: bilateral codeshares (B9) and the bankruptcy fire sale (B8).
--
-- Two unrelated features share one migration so there is a single
-- `prisma migrate deploy` rather than two.
--
-- ── B9 ──────────────────────────────────────────────────────────────────────
-- A codeshare against a human rival was signed unilaterally: you collected
-- interline revenue computed off a real player's network while they were never
-- told and never benefited. `CodeshareOffer` is the handshake that makes it a
-- deal instead of a helping.
--
-- A row IS a live offer. Resolving one — accepted, rejected or withdrawn —
-- DELETES it, exactly as AllianceMember does on reject, which is what lets the
-- unique constraint below stay simple: at most one open offer per ordered pair.
-- The agreement itself lives in both airlines' state blobs once accepted; this
-- table never becomes its source of truth.
CREATE TABLE "CodeshareOffer" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "fromAirlineId" TEXT NOT NULL,
    "toAirlineId" TEXT NOT NULL,
    "offeredWeek" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeshareOffer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodeshareOffer_worldId_fromAirlineId_toAirlineId_key"
    ON "CodeshareOffer"("worldId", "fromAirlineId", "toAirlineId");

CREATE INDEX "CodeshareOffer_worldId_toAirlineId_idx"
    ON "CodeshareOffer"("worldId", "toAirlineId");

CREATE INDEX "CodeshareOffer_worldId_fromAirlineId_idx"
    ON "CodeshareOffer"("worldId", "fromAirlineId");

ALTER TABLE "CodeshareOffer" ADD CONSTRAINT "CodeshareOffer_worldId_fkey"
    FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── B8 ──────────────────────────────────────────────────────────────────────
-- A bankrupt airline's gates went back to the pool in silence (and only on
-- gate-scarcity worlds); its fleet and orderbook simply ceased to exist. The
-- administration sweep now lists both.
--
-- `distressed` is the discriminator, NOT a null seller. The estate listing keeps
-- pointing at the airline that held the gate: that is who the ledger must debit
-- when it finally sells, and it is what lets the feed say whose gates these
-- were. What changes is that nobody is PAID — buyListing skips the seller-side
-- blob write, so the money leaves the world rather than being credited to a
-- company that no longer exists.
--
-- False on every existing row, which is what they all were.
ALTER TABLE "GateListing" ADD COLUMN "distressed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UsedAircraftListing" ADD COLUMN "distressed" BOOLEAN NOT NULL DEFAULT false;
