// GET /sitemap-worlds.xml — every public world page, live and concluded: the
// world itself, its season-so-far page, the hall of fame, and the page of each
// airline with a real network (_lib/render.mjs AIRLINE_PAGE_MIN_ROUTES).
// The static sitemap.xml is written at build time and cannot know which
// worlds exist; robots.txt lists both sitemaps.
import { renderWorldsSitemap } from './_lib/render.mjs';

const API = process.env.HEADWINDS_API_ORIGIN ?? 'https://api.headwindsairlinegame.com';

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  try {
    const [liveRes, endedRes] = await Promise.all([getJson('/worlds'), getJson('/worlds?status=ENDED')]);
    const live = liveRes.worlds ?? [];
    // Airline pages need each world's standings; a world whose fetch fails
    // simply lists no airlines this hour.
    const details = await Promise.all(live.map((w) => getJson(`/worlds/${w.id}`).catch(() => null)));
    const airlinesById = {};
    live.forEach((w, i) => { if (details[i]?.standings) airlinesById[w.id] = details[i].standings; });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/xml; charset=utf-8');
    res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.end(renderWorldsSitemap({ live, concluded: endedRes.worlds ?? [], airlinesById }));
  } catch (err) {
    console.error('[worlds sitemap]', err?.message ?? err);
    res.statusCode = 503;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('retry-after', '60');
    res.end('sitemap temporarily unavailable\n');
  }
}
