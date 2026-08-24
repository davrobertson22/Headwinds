// /me/messages — account-level DMs (player profiles, phase 3).
//
// The world-less sibling of routes/messages.mjs: account → account, opened
// from any profile, surviving every season. Everything a conversation needs
// and nothing more:
//
//   GET  /me/messages                 inbox summary (conversations, blocks,
//                                     the caller's dmPolicy, total unread)
//   GET  /me/messages/with/:accountId one thread, marked read on open
//   POST /me/messages                 send (policy + blocks + rate limit)
//   POST /me/messages/block           block / unblock an account
//   POST /me/dm-policy                who may message me
//
// Refusal design: a block and a NOBODY policy answer with the SAME text, so
// a refusal never reveals whether it was personal. The SHARED_WORLD check
// counts any world both accounts ever flew in — finished seasons included.
import { requireAuth } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { isDevEmail } from '../lib/humanRivals.mjs';
import { displayNameOf } from '../lib/username.mjs';
import {
  ACCOUNT_MESSAGE_MAX_LENGTH, ACCOUNT_MESSAGE_RATE_LIMIT_PER_HOUR,
  DM_POLICIES, DEFAULT_DM_POLICY, dmRefusal,
} from '../lib/accountMessaging.mjs';

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

/** Have these two accounts ever flown in the same world? */
export async function sharesWorld(accountA, accountB) {
  const mine = await prisma.airline.findMany({
    where: { accountId: accountA },
    select: { worldId: true },
  });
  if (mine.length === 0) return false;
  const shared = await prisma.airline.findFirst({
    where: { accountId: accountB, worldId: { in: mine.map((a) => a.worldId) } },
    select: { id: true },
  });
  return shared != null;
}

/** The public face of a counterpart account, badges included. */
const counterpartOf = (a) => ({
  accountId: a.id,
  name: displayNameOf(a) ?? 'Unknown',
  og: a.isOG === true,
  dev: isDevEmail(a.email), // email compared server-side only, never emitted
});

export default async function accountMessageRoutes(fastify) {
  // ── Inbox summary ──────────────────────────────────────────────────────────
  fastify.get('/me/messages', { preHandler: requireAuth }, async (request) => {
    const me = request.account;
    const [dms, blocks] = await Promise.all([
      prisma.accountMessage.findMany({
        where: { OR: [{ toAccountId: me.id }, { fromAccountId: me.id }] },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      prisma.accountMessageBlock.findMany({ where: { accountId: me.id } }),
    ]);
    const blockedIds = new Set(blocks.map((b) => b.blockedAccountId));

    // Everyone the thread list needs a name for, in one read.
    const otherIds = [...new Set([
      ...dms.map((m) => (m.fromAccountId === me.id ? m.toAccountId : m.fromAccountId)),
      ...blocks.map((b) => b.blockedAccountId),
    ])];
    const others = otherIds.length === 0 ? [] : await prisma.account.findMany({
      where: { id: { in: otherIds } },
      select: { id: true, username: true, displayName: true, isOG: true, email: true },
    });
    const otherById = new Map(others.map((a) => [a.id, a]));

    // Fold the flat list into conversations keyed by counterpart.
    const conversations = new Map();
    for (const m of dms) {
      const otherId = m.fromAccountId === me.id ? m.toAccountId : m.fromAccountId;
      if (blockedIds.has(otherId)) continue; // blocked senders vanish from the inbox
      let c = conversations.get(otherId);
      if (!c) {
        const other = otherById.get(otherId);
        c = {
          ...(other ? counterpartOf(other) : { accountId: otherId, name: 'Unknown', og: false, dev: false }),
          unread: 0,
          lastMessage: null,
        };
        conversations.set(otherId, c);
      }
      if (!c.lastMessage) {
        c.lastMessage = { body: m.body.slice(0, 80), fromMe: m.fromAccountId === me.id, at: m.createdAt };
      }
      if (m.toAccountId === me.id && !m.readAt) c.unread++;
    }
    const list = [...conversations.values()];

    return {
      conversations: list,
      blocked: blocks.map((b) => {
        const other = otherById.get(b.blockedAccountId);
        return { accountId: b.blockedAccountId, name: other ? displayNameOf(other) ?? 'Unknown' : 'Unknown' };
      }),
      dmPolicy: DM_POLICIES.includes(me.dmPolicy) ? me.dmPolicy : DEFAULT_DM_POLICY,
      totalUnread: list.reduce((t, c) => t + c.unread, 0),
    };
  });

  // ── One thread (and mark it read) ──────────────────────────────────────────
  fastify.get('/me/messages/with/:accountId', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        properties: { accountId: { type: 'string' } },
        required: ['accountId'],
      },
    },
  }, async (request) => {
    const me = request.account;
    const otherId = request.params.accountId;
    const other = await prisma.account.findUnique({
      where: { id: otherId },
      select: { id: true, username: true, displayName: true, isOG: true, email: true },
    });
    if (!other) throw httpError(404, 'No such player');

    const messages = await prisma.accountMessage.findMany({
      where: {
        OR: [
          { fromAccountId: me.id, toAccountId: otherId },
          { fromAccountId: otherId, toAccountId: me.id },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    await prisma.accountMessage.updateMany({
      where: { fromAccountId: otherId, toAccountId: me.id, readAt: null },
      data: { readAt: new Date() },
    });
    return {
      counterpart: counterpartOf(other),
      messages: messages.map((m) => ({
        id: m.id, fromMe: m.fromAccountId === me.id, body: m.body, at: m.createdAt,
      })),
    };
  });

  // ── Send ───────────────────────────────────────────────────────────────────
  fastify.post('/me/messages', {
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        required: ['toAccountId', 'body'],
        properties: {
          toAccountId: { type: 'string' },
          body: { type: 'string', minLength: 1, maxLength: ACCOUNT_MESSAGE_MAX_LENGTH },
        },
      },
    },
  }, async (request, reply) => {
    const me = request.account;
    const { toAccountId } = request.body;
    if (toAccountId === me.id) {
      throw httpError(400, 'Talking to yourself is free — no postage required');
    }

    // A banned account's profile is a 404; its inbox is too.
    const target = await prisma.account.findUnique({
      where: { id: toAccountId },
      select: { id: true, dmPolicy: true, bannedAt: true },
    });
    if (!target || target.bannedAt) throw httpError(404, 'No such player');

    const [blockedByThem, blockedByMe] = await Promise.all([
      prisma.accountMessageBlock.findUnique({
        where: { accountId_blockedAccountId: { accountId: target.id, blockedAccountId: me.id } },
      }),
      prisma.accountMessageBlock.findUnique({
        where: { accountId_blockedAccountId: { accountId: me.id, blockedAccountId: target.id } },
      }),
    ]);
    // Same text as the NOBODY policy refusal — never reveal it was personal.
    if (blockedByThem) throw httpError(403, 'This player is not accepting messages.');
    if (blockedByMe) throw httpError(409, 'You have blocked this player — unblock them first');

    // Policy gate. The shared-world lookup only runs when the policy needs it.
    const policy = DM_POLICIES.includes(target.dmPolicy) ? target.dmPolicy : DEFAULT_DM_POLICY;
    const refusal = dmRefusal(policy, {
      sharesWorld: policy === 'SHARED_WORLD' ? await sharesWorld(me.id, target.id) : false,
    });
    if (refusal) throw httpError(403, refusal);

    // Rolling rate limit, same shape as world DMs.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const sent = await prisma.accountMessage.count({
      where: { fromAccountId: me.id, createdAt: { gte: oneHourAgo } },
    });
    if (sent >= ACCOUNT_MESSAGE_RATE_LIMIT_PER_HOUR) {
      throw httpError(429, `Rate limit: max ${ACCOUNT_MESSAGE_RATE_LIMIT_PER_HOUR} messages per hour`);
    }

    const message = await prisma.accountMessage.create({
      data: { fromAccountId: me.id, toAccountId: target.id, body: request.body.body.trim() },
    });
    return reply.code(201).send({ ok: true, id: message.id });
  });

  // ── Block / unblock ────────────────────────────────────────────────────────
  fastify.post('/me/messages/block', {
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        required: ['accountId', 'blocked'],
        properties: { accountId: { type: 'string' }, blocked: { type: 'boolean' } },
      },
    },
  }, async (request) => {
    const me = request.account;
    const { accountId, blocked } = request.body;
    if (accountId === me.id) throw httpError(400, 'You cannot block yourself');
    if (blocked) {
      await prisma.accountMessageBlock.upsert({
        where: { accountId_blockedAccountId: { accountId: me.id, blockedAccountId: accountId } },
        update: {},
        create: { accountId: me.id, blockedAccountId: accountId },
      });
    } else {
      await prisma.accountMessageBlock.deleteMany({
        where: { accountId: me.id, blockedAccountId: accountId },
      });
    }
    return { ok: true, blocked };
  });

  // ── Who may message me ─────────────────────────────────────────────────────
  fastify.post('/me/dm-policy', {
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        required: ['policy'],
        properties: { policy: { type: 'string', enum: DM_POLICIES } },
      },
    },
  }, async (request) => {
    await prisma.account.update({
      where: { id: request.account.id },
      data: { dmPolicy: request.body.policy },
    });
    return { dmPolicy: request.body.policy };
  });
}
