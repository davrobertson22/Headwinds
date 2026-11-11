// The public, server-rendered world pages:
//
//   /worlds                              every live world, with standings
//   /worlds/hall-of-fame                 leaders, records, champions, trophies
//   /worlds/:id                          one world: standings, map, headlines
//   /worlds/:id/history                  its season so far, year by year
//   /worlds/:id/airlines/:airlineId      one airline: network, fleet, rank
//
// Routed here by the rewrites in vercel.json (`/worlds/:id` arrives as ?id=,
// the history page adds &view=history, an airline page adds &airline=).
// Rendering lives in _lib/render.mjs and _lib/renderMore.mjs; this file only
// fetches and caches. The API is called WITHOUT credentials, so it answers
// with the people taken out (server lib/publicView.mjs) — these pages could not
// name a player if they tried.
import {
  renderWorldsIndex, renderWorldPage, renderNotFound, renderUnavailable,
} from './_lib/render.mjs';
import { renderAirlinePage, renderHistoryPage, renderHallOfFame } from './_lib/renderMore.mjs';

import { getJson, loadCtx, publicWorld, ID } from './_lib/data.mjs';

// Standings change once per tick (an hour or more); five minutes at the edge
// keeps a crawl or a review from multiplying into database reads, and
// stale-while-revalidate means a visitor never waits on the API.
const CACHE_OK = 'public, s-maxage=300, stale-while-revalidate=3600';
const CACHE_ERR = 'no-store';

const send = (res, status, html, cache) => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', cache);
  res.end(html);
};

const tier1News = (id, limit) => getJson(`/worlds/${id}/news?tier=1&limit=${limit}`).then((r) => r?.items ?? []).catch(() => []);

export default async function handler(req, res) {
  const q = (k) => (typeof req.query?.[k] === 'string' ? req.query[k].trim() : '');
  const id = q('id'), view = q('view'), airlineId = q('airline');
  try {
    const ctx = await loadCtx();

    if (!id || id === 'hall-of-fame') {
      const [liveRes, endedRes] = await Promise.all([getJson('/worlds'), getJson('/worlds?status=ENDED')]);
      const live = liveRes?.worlds ?? [];
      const concluded = endedRes?.worlds ?? [];
      // One detail fetch per live world, in parallel, each allowed to fail on
      // its own (the card then shows counts only).
      const details = await Promise.all(live.map((w) => getJson(`/worlds/${w.id}`).catch(() => null)));
      const standingsById = {};
      live.forEach((w, i) => { if (details[i]?.standings) standingsById[w.id] = details[i].standings; });
      if (!id) return send(res, 200, renderWorldsIndex({ live, concluded, standingsById, ctx }), CACHE_OK);

      const [histories, awardsRes] = await Promise.all([
        Promise.all(live.map((w) => getJson(`/worlds/${w.id}/history`).catch(() => null))),
        getJson('/trophies/awards').catch(() => null),
      ]);
      const historyById = {};
      live.forEach((w, i) => { if (histories[i]) historyById[w.id] = histories[i]; });
      return send(res, 200, renderHallOfFame({ live, concluded, standingsById, historyById, awards: awardsRes?.awards ?? [], ctx }), CACHE_OK);
    }

    const detail = await publicWorld(id);
    if (!detail) return send(res, 404, renderNotFound(), CACHE_OK);

    if (airlineId) {
      if (!ID.test(airlineId)) return send(res, 404, renderNotFound(), CACHE_OK);
      const [rival, news] = await Promise.all([getJson(`/worlds/${id}/rivals/${airlineId}`), tier1News(id, 100)]);
      const html = rival ? renderAirlinePage({ detail, rival, news, typeName: ctx.typeName, ctx }) : null;
      return html ? send(res, 200, html, CACHE_OK) : send(res, 404, renderNotFound(), CACHE_OK);
    }

    if (view === 'history') {
      const [history, news] = await Promise.all([getJson(`/worlds/${id}/history`).catch(() => null), tier1News(id, 100)]);
      return send(res, 200, renderHistoryPage({ detail, history: history ?? {}, news, typeName: ctx.typeName, ctx }), CACHE_OK);
    }

    const news = await tier1News(id, 25);
    return send(res, 200, renderWorldPage({ detail, news, typeName: ctx.typeName, ctx }), CACHE_OK);
  } catch (err) {
    console.error('[worlds page]', err?.message ?? err);
    res.setHeader('retry-after', '60');
    return send(res, 503, renderUnavailable(), CACHE_ERR);
  }
}
