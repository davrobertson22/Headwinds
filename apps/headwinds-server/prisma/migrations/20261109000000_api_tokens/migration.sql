-- Read-only Agent API tokens (2026-11-09): supporters connect their own AI
-- (Claude, ChatGPT) to their airlines. Only the SHA-256 of each secret is kept;
-- the secret is shown once at creation. A NEW table only — no existing table or
-- column changes, so a deploy that misses this migration breaks nothing but
-- the token endpoints. lib/agentApi.mjs is the only reader and writer.
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

CREATE INDEX "ApiToken_accountId_idx" ON "ApiToken"("accountId");

ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
