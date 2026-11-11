// GET /worlds/:id/history — a world's season so far: who closed each game year
// on the podium, how long the current leader has held #1, and last year's
// ranks (for "biggest climbers"). Readable like the standings are: by anyone
// for a PUBLIC world, by members for a PRIVATE one. Airlines only — no account
// is named here (lib/publicView.mjs).
//
// GET /trophies/awards — every hand-awarded trophy, for the public hall of
// fame: the trophy, the airline that won it and where. Never the account.
import { prisma } from '../db.mjs';
import { optionalAccount } from '../auth.mjs';
import { assertWorldReadable } from '../lib/access.mjs';
import { rankingSinceOf } from '../lib/worldConfig.mjs';
import { loadWorldHistory } from '../lib/worldHistory.mjs';
import { serializeAward, TROPHY_META_SELECT } from '../lib/trophies.mjs';

// History changes once per tick. Five minutes in memory keeps the public pages
// (and a crawler walking them) from turning into Standing scans.
const TTL_MS = 5 * 60_000;
const CACHE_MAX = 100;
const cache = new Map();
const cached = async (key, load) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await load();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
};

export default async function worldHistoryRoutes(fastify) {
  fastify.get('/worlds/:id/history', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] } },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({ where: { id: request.params.id } });
    if (!world) return reply.code(404).send({ error: 'No such world' });
    // Gate BEFORE the cache, so a member's cached copy never reaches a stranger.
    await assertWorldReadable(prisma, world, await optionalAccount(request));
    const key = `${world.id}|${world.currentYear}|${world.currentWeek}`;
    const history = await cached(key, () => loadWorldHistory(prisma, world, { rankingSince: rankingSinceOf(world) }));
    return { world: { id: world.id, name: world.name, status: world.status }, ...history };
  });

  fastify.get('/trophies/awards', async () => cached('trophy-awards', async () => {
    const rows = await prisma.trophyAward.findMany({
      orderBy: { awardedAt: 'desc' },
      take: 200,
      include: { trophy: { select: TROPHY_META_SELECT } },
    });
    // serializeAward carries no account field; the trophy, the airline's name
    // and the world's name were snapshotted when it was handed out.
    return { awards: rows.map(serializeAward) };
  }));
}
