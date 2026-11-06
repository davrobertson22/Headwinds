// GET /logos/:airlineId — an airline's uploaded logo, as an image.
// GET /tails/:airlineId — their uploaded tail (the `customTail` column), the
// same way: the maps draw a rival's fin from this URL.
//
// Rival views carry `customLogo: '/logos/<id>?v=<hash>'` rather than the data
// URL (lib/logoColumn.mjs RIVALS): the bytes are fetched once per browser and
// then cached forever, instead of riding every rival rebuild to every client.
//
// Deliberately unauthenticated: it is an <image href>, which cannot carry the
// Bearer token, and a logo is shown to every player in the world anyway. The
// id is an unguessable cuid and nothing but the picture is returned.
//
// Reads ONE scalar column — never the state blob.
import { prisma } from '../db.mjs';
import { decodeLogoDataUrl, logoHashOf } from '../lib/logoColumn.mjs';

export default async function logoRoutes(fastify) {
  imageRoute(fastify, '/logos/:airlineId', 'customLogo', 'No logo.');
  imageRoute(fastify, '/tails/:airlineId', 'customTail', 'No tail.');
}

function imageRoute(fastify, path, column, missing) {
  fastify.get(path, {
    schema: {
      params: {
        type: 'object',
        properties: { airlineId: { type: 'string', maxLength: 64 } },
        required: ['airlineId'],
      },
      querystring: {
        type: 'object',
        properties: { v: { type: 'string', maxLength: 32 } },
      },
    },
  }, async (request, reply) => {
    const { airlineId } = request.params;
    const row = await prisma.airline.findUnique({
      where: { id: airlineId },
      select: { [column]: true },
    });
    const img = decodeLogoDataUrl(row?.[column]);
    if (!img) return reply.code(404).header('Cache-Control', 'public, max-age=300').send({ error: missing });

    // A request for the CURRENT hash can be cached forever — a new upload is a
    // new URL. A stale or missing ?v= gets the current bytes with a short TTL.
    const current = request.query?.v && request.query.v === logoHashOf(row[column]);
    return reply
      .header('Content-Type', img.contentType)
      .header('Cache-Control', current ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'")
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(img.bytes);
  });
}
