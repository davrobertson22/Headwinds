// GET /worlds/:id/airlines/:airlineId/card.png — an airline's share card.
//
// The picture Discord, WhatsApp or a group chat shows when a player pastes
// their airline's page: its tail fin, its name, where it stands. It is the
// page's og:image (renderMore.mjs), addressed with ?w=<game week> so a new
// week is a new picture and an old one can be cached for good.
//
// What is on it: rank, world, hub, routes, fleet, passengers. Not profit — a
// rank is a boast, a profit figure is a number to argue about (the same call
// the in-game share-card plan made, claude/visual-engagement-plan.md).
//
// Never an error image: anything that goes wrong redirects to the site's
// ordinary preview card, so a pasted link always unfurls with something.
import { ImageResponse } from '@vercel/og';
import { loadCtx, publicWorld, ID } from './_lib/data.mjs';
import { buildCard } from './_lib/card.mjs';

const FALLBACK = '/og-image.png';
const IMAGE_TIMEOUT_MS = 4000;
const IMAGE_MAX_BYTES = 600_000;

// An uploaded logo or tail has to be INSIDE the picture (the renderer fetches
// nothing), so it is read here and inlined as a data URL. Best effort: a slow
// or missing upload just means the fin is drawn without it.
async function inline(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    // PNG, JPEG and GIF only: the renderer cannot size a WebP, and a card with
    // no mark is better than no card.
    if (!res.ok || !/^image\/(png|jpeg|gif)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > IMAGE_MAX_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const q = (k) => (typeof req.query?.[k] === 'string' ? req.query[k].trim() : '');
  const worldId = q('world'), airlineId = q('airline');
  try {
    if (!ID.test(worldId) || !ID.test(airlineId)) throw new Error('bad id');
    const [detail, ctx] = await Promise.all([publicWorld(worldId), loadCtx()]);
    if (!detail) throw new Error('no such world');
    const card = await buildCard({ detail, airlineId, ctx, inline });
    if (!card) throw new Error('no such airline');
    let png;
    try {
      png = Buffer.from(await new ImageResponse(card.element, { width: 1200, height: 630 }).arrayBuffer());
    } catch (err) {
      // An upload the renderer cannot decode: draw the card again without it.
      console.error('[share card] retrying without uploads:', err?.message ?? err);
      const plain = await buildCard({ detail, airlineId, ctx, inline: async () => null });
      png = Buffer.from(await new ImageResponse(plain.element, { width: 1200, height: 630 }).arrayBuffer());
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'image/png');
    // The address carries the game week, so this exact picture never changes.
    res.setHeader('cache-control', 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=604800');
    res.end(png);
  } catch (err) {
    console.error('[share card]', err?.message ?? err);
    res.statusCode = 302;
    res.setHeader('location', FALLBACK);
    res.setHeader('cache-control', 'public, s-maxage=60');
    res.end();
  }
}
