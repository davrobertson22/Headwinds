// /worlds/:id/news — the world news feed.
//
// Public (spectators can read a world's news, same as its standings). The
// composition, rollup and tiering all live in lib/newsService.mjs; this file is
// transport, validation and caching only.
import { prisma } from '../db.mjs';
import { buildNews, NEWS_CATEGORIES } from '../lib/newsService.mjs';

// The ticker polls this endpoint from every open client (every 60s idle, 15s
// while the drawer is open). Without a cache a 40-player world would run its
// full source fan-out ~40 times a minute for identical output. First pages only
// — deep pagination is rare and always fresh.
const CACHE_TTL_MS = 20_000;
const CACHE_MAX = 200;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    // Cheap eviction: drop the oldest inserted key. Map preserves insertion order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

/** Exported for tests and for the tick, which invalidates a world on write. */
export function invalidateNewsCache(worldId) {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${worldId}|`)) cache.delete(key);
  }
}

const parseCategories = (raw) => {
  if (!raw) return null;
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  const valid = list.filter((c) => NEWS_CATEGORIES.includes(c));
  return valid.length ? valid : null;
};

export default async function newsRoutes(fastify) {
  fastify.get('/worlds/:id/news', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        properties: {
          before: { type: 'string' },                          // ISO cursor (createdAt)
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          categories: { type: 'string' },                      // comma-separated, see NEWS_CATEGORIES
          tier: { type: 'integer', minimum: 1, maximum: 3 },   // 1 = big moves only
        },
      },
    },
  }, async (request, reply) => {
    const world = await prisma.world.findUnique({ where: { id: request.params.id } });
    if (!world) return reply.code(404).send({ error: 'No such world' });

    const categories = parseCategories(request.query.categories);
    const limit = request.query.limit ?? 40;
    const tier = request.query.tier;
    const before = request.query.before;

    const key = `${world.id}|${(categories ?? NEWS_CATEGORIES).join(',')}|${tier ?? 0}|${limit}`;
    if (!before) {
      const hit = cacheGet(key);
      if (hit) return hit;
    }

    const result = await buildNews(prisma, { world, categories, tier, before, limit });
    const body = {
      ...result,
      world: { week: world.currentWeek, year: world.currentYear, status: world.status },
    };
    if (!before) cacheSet(key, body);
    return body;
  });
}
