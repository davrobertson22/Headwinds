// /me/api-tokens, /agent/*, /mcp — the supporters' read-only Agent API. All of
// the logic is in lib/agentApi.mjs (testable without a database); this file
// only wires the real auth gate, rate limiter and Prisma tables into it.
import { requireAuth } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { allow } from '../lib/rateLimit.mjs';
import { joinReport } from '../lib/reportColumn.mjs';
import { paceLabel } from '../lib/worldConfig.mjs';
import { agentApiRoutes, prismaTokenStore, prismaAirlineSource } from '../lib/agentApi.mjs';

export default agentApiRoutes({
  store: prismaTokenStore(prisma),
  source: prismaAirlineSource(prisma, { joinReport, paceLabel }),
  authenticate: requireAuth,
  allow,
});
