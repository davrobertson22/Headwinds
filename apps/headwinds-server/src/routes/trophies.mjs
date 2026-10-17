// The trophy bank — see lib/trophies.mjs.
//
//   GET    /trophies/:id/image          public; the artwork, cached forever per hash
//   GET    /admin/trophies[?worldId=]   the bank + awards (optionally one world's)
//   POST   /admin/trophies              create { name, description?, image? (data URL) }
//   POST   /admin/trophies/:id          edit   { name?, description?, image? (null clears) }
//   DELETE /admin/trophies/:id          only while it has never been awarded
//   POST   /admin/trophies/:id/award    { accountId, worldId?, place?, note? }
//   DELETE /admin/trophy-awards/:id     revoke
//   GET    /trophies/:id/model          public; the 3D model (.glb), cached forever per hash
//   PUT    /admin/trophies/:id/model    raw .glb body (model/gltf-binary or octet-stream)
//   DELETE /admin/trophies/:id/model
import { requireAdmin } from '../auth.mjs';
import { prisma } from '../db.mjs';
import {
  createTrophy, updateTrophy, deleteTrophy, awardTrophy, serializeTrophy, serializeAward,
  setTrophyModel, clearTrophyModel, TROPHY_MODEL_MAX_BYTES,
  TROPHY_META_SELECT, TROPHY_BODY_LIMIT, TROPHY_NAME_MAX, TROPHY_DESCRIPTION_MAX, TROPHY_NOTE_MAX,
} from '../lib/trophies.mjs';

const idParams = { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] };
const send = (reply, err) => reply.code(err.statusCode ?? 500).send({ error: err.message });

export default async function trophyRoutes(fastify) {
  // Raw .glb uploads. Encapsulated in this plugin, so the cloud-save routes'
  // own octet-stream parser is untouched.
  for (const type of ['model/gltf-binary', 'application/octet-stream']) {
    fastify.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: TROPHY_MODEL_MAX_BYTES + 1024 },
      (request, body, done) => done(null, body));
  }

  fastify.get('/trophies/:id/model', {
    schema: {
      params: idParams,
      querystring: { type: 'object', properties: { v: { type: 'string', maxLength: 32 } } },
    },
  }, async (request, reply) => {
    const row = await prisma.trophy.findUnique({
      where: { id: request.params.id },
      select: { model: true, modelHash: true },
    });
    if (!row?.model) return reply.code(404).header('Cache-Control', 'public, max-age=300').send({ error: 'No model.' });
    const current = request.query?.v && request.query.v === row.modelHash;
    return reply
      .header('Content-Type', 'model/gltf-binary')
      .header('Cache-Control', current ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'")
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(Buffer.from(row.model));
  });

  fastify.put('/admin/trophies/:id/model', {
    preHandler: requireAdmin,
    bodyLimit: TROPHY_MODEL_MAX_BYTES + 1024,
    schema: { params: idParams },
  }, async (request, reply) => {
    try {
      const t = await setTrophyModel(prisma, request.params.id, request.body);
      return { trophy: serializeTrophy(t) };
    } catch (e) { return send(reply, e); }
  });

  fastify.delete('/admin/trophies/:id/model', {
    preHandler: requireAdmin,
    schema: { params: idParams },
  }, async (request, reply) => {
    try { return { trophy: serializeTrophy(await clearTrophyModel(prisma, request.params.id)) }; }
    catch (e) { return send(reply, e.code === 'P2025' ? Object.assign(new Error('No such trophy'), { statusCode: 404 }) : e); }
  });

  // Unauthenticated on purpose, like /logos: it is an <img src>, which cannot
  // carry the Bearer token, and a trophy is shown on public profiles anyway.
  fastify.get('/trophies/:id/image', {
    schema: {
      params: idParams,
      querystring: { type: 'object', properties: { v: { type: 'string', maxLength: 32 } } },
    },
  }, async (request, reply) => {
    const row = await prisma.trophy.findUnique({
      where: { id: request.params.id },
      select: { image: true, imageType: true, imageHash: true },
    });
    if (!row?.image || !row.imageType) {
      return reply.code(404).header('Cache-Control', 'public, max-age=300').send({ error: 'No image.' });
    }
    const current = request.query?.v && request.query.v === row.imageHash;
    return reply
      .header('Content-Type', row.imageType)
      .header('Cache-Control', current ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'")
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(Buffer.from(row.image));
  });

  fastify.get('/admin/trophies', {
    preHandler: requireAdmin,
    schema: { querystring: { type: 'object', properties: { worldId: { type: 'string', maxLength: 64 } } } },
  }, async (request) => {
    const { worldId } = request.query ?? {};
    const [trophies, awards] = await Promise.all([
      prisma.trophy.findMany({
        orderBy: { createdAt: 'desc' },
        select: { ...TROPHY_META_SELECT, _count: { select: { awards: true } } },
      }),
      prisma.trophyAward.findMany({
        where: worldId ? { worldId } : {},
        orderBy: { awardedAt: 'desc' },
        take: 500,
        include: {
          trophy: { select: TROPHY_META_SELECT },
          account: { select: { id: true, username: true, displayName: true } },
        },
      }),
    ]);
    return {
      trophies: trophies.map(serializeTrophy),
      awards: awards.map((a) => ({
        ...serializeAward(a),
        accountId: a.accountId,
        playerName: a.account?.username ?? a.account?.displayName ?? null,
        awardedByEmail: a.awardedByEmail ?? null,
      })),
    };
  });

  const trophyBody = {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: TROPHY_NAME_MAX },
      description: { type: ['string', 'null'], maxLength: TROPHY_DESCRIPTION_MAX },
      image: { type: ['string', 'null'], maxLength: TROPHY_BODY_LIMIT },
    },
  };

  fastify.post('/admin/trophies', {
    preHandler: requireAdmin,
    bodyLimit: TROPHY_BODY_LIMIT,
    schema: { body: { ...trophyBody, required: ['name'] } },
  }, async (request, reply) => {
    try {
      const t = await createTrophy(prisma, request.body, { adminEmail: request.account?.email ?? null });
      return reply.code(201).send({ trophy: serializeTrophy(t) });
    } catch (e) { return send(reply, e); }
  });

  fastify.post('/admin/trophies/:id', {
    preHandler: requireAdmin,
    bodyLimit: TROPHY_BODY_LIMIT,
    schema: { params: idParams, body: trophyBody },
  }, async (request, reply) => {
    try {
      const t = await updateTrophy(prisma, request.params.id, request.body ?? {});
      return { trophy: serializeTrophy(t) };
    } catch (e) { return send(reply, e); }
  });

  fastify.delete('/admin/trophies/:id', {
    preHandler: requireAdmin,
    schema: { params: idParams },
  }, async (request, reply) => {
    try {
      await deleteTrophy(prisma, request.params.id);
      return { ok: true };
    } catch (e) { return send(reply, e); }
  });

  fastify.post('/admin/trophies/:id/award', {
    preHandler: requireAdmin,
    schema: {
      params: idParams,
      body: {
        type: 'object',
        required: ['accountId'],
        properties: {
          accountId: { type: 'string', maxLength: 64 },
          worldId: { type: ['string', 'null'], maxLength: 64 },
          place: { type: ['integer', 'null'], minimum: 1, maximum: 1000 },
          note: { type: ['string', 'null'], maxLength: TROPHY_NOTE_MAX },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const a = await awardTrophy(prisma, { trophyId: request.params.id, ...request.body },
        { adminEmail: request.account?.email ?? null });
      return reply.code(201).send({ award: serializeAward(a) });
    } catch (e) { return send(reply, e); }
  });

  fastify.delete('/admin/trophy-awards/:id', {
    preHandler: requireAdmin,
    schema: { params: idParams },
  }, async (request, reply) => {
    const gone = await prisma.trophyAward.deleteMany({ where: { id: request.params.id } });
    if (!gone.count) return reply.code(404).send({ error: 'No such award' });
    return { ok: true };
  });
}
