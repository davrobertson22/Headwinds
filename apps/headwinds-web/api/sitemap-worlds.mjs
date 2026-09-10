// GET /sitemap-worlds.xml — every public world page, live and concluded.
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
    res.statusCode = 200;
    res.setHeader('content-type', 'application/xml; charset=utf-8');
    res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.end(renderWorldsSitemap({ live: liveRes.worlds ?? [], concluded: endedRes.worlds ?? [] }));
  } catch (err) {
    console.error('[worlds sitemap]', err?.message ?? err);
    res.statusCode = 503;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('retry-after', '60');
    res.end('sitemap temporarily unavailable\n');
  }
}
