// GET /worlds and GET /worlds/:id — public, server-rendered world pages.
// Routed here by the rewrites in vercel.json (`/worlds/:id` arrives as ?id=).
// Rendering lives in _lib/render.mjs; this file only fetches and caches.
import {
  renderWorldsIndex, renderWorldPage, renderNotFound, renderUnavailable,
} from './_lib/render.mjs';

const API = process.env.HEADWINDS_API_ORIGIN ?? 'https://api.headwindsairlinegame.com';
const TIMEOUT_MS = 8000;
// Standings change once per tick (an hour or more); five minutes at the edge
// keeps a crawl or a review from multiplying into database reads, and
// stale-while-revalidate means a visitor never waits on the API.
const CACHE_OK = 'public, s-maxage=300, stale-while-revalidate=3600';
const CACHE_ERR = 'no-store';

async function getJson(path) {
  const res = await fetch(`${API}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'headwinds-web/worlds-page' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

// The engine's aircraft table names the type in "ordered 5× Boeing 737-800".
// Optional: if the workspace package is not reachable from the function
// bundle, headlines fall back to the raw type id rather than failing the page.
async function loadTypeName() {
  try {
    const mod = await import('@tailwinds/engine/data/aircraft.js');
    return (id) => mod.getAircraftType?.(id)?.name ?? id ?? 'an aircraft';
  } catch {
    return undefined;
  }
}

const send = (res, status, html, cache) => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', cache);
  res.end(html);
};

export default async function handler(req, res) {
  const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';
  try {
    if (!id) {
      const [liveRes, endedRes] = await Promise.all([getJson('/worlds'), getJson('/worlds?status=ENDED')]);
      const live = liveRes?.worlds ?? [];
      const concluded = endedRes?.worlds ?? [];
      // Top-5 tables on the index: one detail fetch per live world, in parallel,
      // each allowed to fail on its own (the card then shows counts only).
      const details = await Promise.all(live.map((w) => getJson(`/worlds/${w.id}`).catch(() => null)));
      const standingsById = {};
      live.forEach((w, i) => { if (details[i]?.standings) standingsById[w.id] = details[i].standings; });
      return send(res, 200, renderWorldsIndex({ live, concluded, standingsById }), CACHE_OK);
    }

    if (!/^[a-z0-9]{10,40}$/i.test(id)) return send(res, 404, renderNotFound(), CACHE_OK);
    const detail = await getJson(`/worlds/${id}`);
    // A private world answers with its card and no standings; to the public
    // web that is the same as no world at all.
    if (!detail?.world || detail.private || detail.world.visibility !== 'PUBLIC') {
      return send(res, 404, renderNotFound(), CACHE_OK);
    }
    const [newsRes, typeName] = await Promise.all([
      getJson(`/worlds/${id}/news?tier=1&limit=25`).catch(() => null),
      loadTypeName(),
    ]);
    return send(res, 200, renderWorldPage({ detail, news: newsRes?.items ?? [], typeName }), CACHE_OK);
  } catch (err) {
    console.error('[worlds page]', err?.message ?? err);
    res.setHeader('retry-after', '60');
    return send(res, 503, renderUnavailable(), CACHE_ERR);
  }
}
