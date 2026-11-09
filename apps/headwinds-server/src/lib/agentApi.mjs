// The read-only Agent API — supporters connect their own AI to their airlines.
//
// PRD on Discord (2026-11-07) asked for an "AI manager"; VodkaOnFire's answer
// was that players already pay for an AI of their own, so the game only has to
// let it in. This is that door, and it is deliberately narrow:
//
//   • READ-ONLY. No tool here dispatches a decision. Nothing can open a route,
//     sell a tail or move a fare. An AI advises; the player plays.
//   • OWN AIRLINES ONLY. A token belongs to an account and reads that account's
//     airlines — the same blob GET /worlds/:id/airline serves its owner, minus
//     the rival overlay. Rivals appear only as the per-route rival COUNT.
//   • NO INFORMATION EDGE. What it serves is the in-game Advisor and the
//     "Copy airline briefing" text (engine models/advisor.js, briefing.js),
//     which are free to every player. A supporter gets convenience — their AI
//     reads it without copy-paste — never facts other players cannot see. That
//     keeps it a supporter perk in the sense schema.prisma's Account.isSupporter
//     allows: nothing here is, or may become, an engine input.
//   • SUPPORTERS ONLY (Dave, 2026-11-09). Creating a token needs the ♥ badge,
//     and the badge is re-checked on EVERY call, so a lapsed supporter's
//     connector stops answering until it is back. Listing and revoking tokens
//     stay open to any account — tidying up is never paywalled.
//
// Transport: plain JSON under /agent/*, and an MCP endpoint (Model Context
// Protocol, Streamable HTTP in its stateless JSON-response form) at /mcp —
// what Claude's custom connectors, Claude Code and ChatGPT's connectors speak.
// Hand-rolled rather than the SDK: four JSON-RPC methods, no sessions, no
// streams, and no new dependency on the API service.
//
// The token rides either as `Authorization: Bearer hwk_…` or in the path
// (/mcp/hwk_…) for clients whose connector form takes only a URL. A path token
// is a secret in a URL, so server.mjs's request serializer redacts it from the
// logs (redactAgentUrl below).
//
// Testable without a database: the plugin takes a `store` (tokens) and a
// `source` (airlines); tools/agent-api-test.mjs drives it with in-memory fakes.

import { createHash, randomBytes } from 'node:crypto';
import { airlineAdvice } from '@tailwinds/engine/models/advisor.js';
import { airlineBriefing, routeRows, fleetRows } from '@tailwinds/engine/models/briefing.js';

export const TOKEN_PREFIX = 'hwk_';
export const MAX_TOKENS_PER_ACCOUNT = 3;
export const AGENT_RATE_LIMIT = { count: 60, windowMs: 60_000 };    // per token
export const MANAGE_RATE_LIMIT = { count: 30, windowMs: 5 * 60_000 }; // token create/revoke per account
export const TOUCH_EVERY_MS = 5 * 60_000;                           // lastUsedAt write throttle
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_VERSION = '1.0.0';

export const NOT_SUPPORTER_MESSAGE =
  'Connecting your own AI is a thank-you for supporters. The in-game Advisor and "Copy airline briefing" are free for everyone.';
export const LAPSED_MESSAGE =
  'This connector belongs to a supporter account whose ♥ badge has lapsed. It will work again as soon as the badge is back.';

const httpError = (statusCode, message, appCode) =>
  Object.assign(new Error(message), { statusCode, ...(appCode ? { appCode } : {}) });

// ── Tokens ───────────────────────────────────────────────────────────────────

/** A fresh secret: hwk_ + 32 url-safe characters (192 bits). Shown once, never stored. */
export function newSecret() {
  return TOKEN_PREFIX + randomBytes(24).toString('base64url');
}

/** What the database keeps: the SHA-256 of the secret. */
export function hashSecret(secret) {
  return createHash('sha256').update(String(secret)).digest('hex');
}

/** The first characters, so a player can tell their tokens apart without the secret. */
export function displayPrefix(secret) {
  return String(secret).slice(0, TOKEN_PREFIX.length + 6);
}

export const looksLikeSecret = (s) => typeof s === 'string' && /^hwk_[A-Za-z0-9_-]{32}$/.test(s);

/** A request URL with any path token blanked — for the request log. */
export function redactAgentUrl(url) {
  return typeof url === 'string' ? url.replace(/hwk_[A-Za-z0-9_-]+/g, 'hwk_[redacted]') : url;
}

function cleanLabel(raw) {
  const s = typeof raw === 'string' ? raw.replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40).trim() : '';
  return s || 'My AI';
}

export function serializeToken(t) {
  const iso = (d) => (d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString());
  return { id: t.id, label: t.label, prefix: t.prefix, createdAt: iso(t.createdAt), lastUsedAt: iso(t.lastUsedAt) };
}

// ── Stores ───────────────────────────────────────────────────────────────────
//
// Token store contract:
//   list(accountId)                       → live (unrevoked) tokens, oldest first
//   create(accountId, { tokenHash, label, prefix }) → token
//   revoke(accountId, id)                 → boolean (false: no such live token)
//   findByHash(tokenHash)                 → { token, account } | null  (revoked → null)
//   touch(id, at)                         → void
//
// Airline source contract:
//   airlines(accountId)          → [{ airlineId, worldId, worldName, worldStatus, name, status, week, year }]
//   airline(accountId, worldId)  → { state, world: { name, pace } } | null
//     `state` has the weekly report joined back in (reportColumn joinReport).

export function memoryTokenStore() {
  const rows = [];
  let n = 0;
  return {
    rows,
    accounts: new Map(),
    async list(accountId) { return rows.filter(r => r.accountId === accountId && !r.revokedAt); },
    async create(accountId, data) {
      const row = { id: `tok${++n}`, accountId, createdAt: new Date(), lastUsedAt: null, revokedAt: null, ...data };
      rows.push(row);
      return row;
    },
    async revoke(accountId, id) {
      const r = rows.find(x => x.id === id && x.accountId === accountId && !x.revokedAt);
      if (!r) return false;
      r.revokedAt = new Date();
      return true;
    },
    async findByHash(tokenHash) {
      const r = rows.find(x => x.tokenHash === tokenHash && !x.revokedAt);
      if (!r) return null;
      return { token: r, account: this.accounts.get(r.accountId) ?? null };
    },
    async touch(id, at) { const r = rows.find(x => x.id === id); if (r) r.lastUsedAt = at; },
  };
}

export function prismaTokenStore(prisma) {
  const t = prisma.apiToken;
  return {
    list: (accountId) => t.findMany({ where: { accountId, revokedAt: null }, orderBy: { createdAt: 'asc' } }),
    create: (accountId, data) => t.create({ data: { accountId, ...data } }),
    async revoke(accountId, id) {
      const { count } = await t.updateMany({ where: { id, accountId, revokedAt: null }, data: { revokedAt: new Date() } });
      return count === 1;
    },
    async findByHash(tokenHash) {
      const row = await t.findUnique({ where: { tokenHash }, include: { account: true } });
      if (!row || row.revokedAt) return null;
      const { account, ...token } = row;
      return { token, account };
    },
    async touch(id, at) { await t.update({ where: { id }, data: { lastUsedAt: at } }); },
  };
}

// ── The data the tools serve ─────────────────────────────────────────────────

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

const ROUTE_SORTS = {
  profit:  (a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity),
  loss:    (a, b) => (a.profit ?? Infinity) - (b.profit ?? Infinity),
  revenue: (a, b) => (b.revenue ?? -Infinity) - (a.revenue ?? -Infinity),
  load:    (a, b) => (b.loadFactor ?? -1) - (a.loadFactor ?? -1),
  emptiest:(a, b) => (a.loadFactor ?? 2) - (b.loadFactor ?? 2),
};

/**
 * Which airline a call means. With one airline the world is optional; with
 * several, a missing world_id is an error that lists the choices — an AI
 * guessing between two airlines would quietly advise on the wrong one.
 */
async function resolveAirline(source, accountId, worldId) {
  if (worldId) {
    const hit = await source.airline(accountId, String(worldId));
    if (!hit) throw httpError(404, `You have no airline in world ${worldId}. Call list_my_airlines for your worlds.`);
    return hit;
  }
  const mine = (await source.airlines(accountId)).filter(a => a.status === 'ACTIVE');
  if (mine.length === 0) throw httpError(404, 'This account has no active airline.');
  if (mine.length > 1) {
    throw httpError(400, `You fly ${mine.length} airlines — pass world_id. `
      + mine.map(a => `${a.name} in ${a.worldName} (world_id ${a.worldId})`).join('; '));
  }
  return source.airline(accountId, mine[0].worldId);
}

const REPORT_LABEL = 'last week';

export const TOOLS = [
  {
    name: 'list_my_airlines',
    title: 'List my airlines',
    description: 'Every Headwinds airline this account flies: the world it is in, its status and the game date. Use the world_id with the other tools when there is more than one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async ({ source, accountId }) => ({ json: await source.airlines(accountId) }),
  },
  {
    name: 'get_airline_briefing',
    title: 'Airline briefing',
    description: 'A Markdown snapshot of one of my airlines: cash and recent profit, the game\'s own Advisor recommendations, best and worst routes with load factor, fares and profit, the fleet by type, gate usage and key settings. Start here.',
    inputSchema: { type: 'object', properties: { world_id: { type: 'string', description: 'Needed only if the account flies more than one airline.' } }, additionalProperties: false },
    run: async ({ source, accountId, args }) => {
      const { state, world } = await resolveAirline(source, accountId, args.world_id);
      return { text: airlineBriefing(state, { reportLabel: REPORT_LABEL, world }) };
    },
  },
  {
    name: 'get_advice',
    title: 'Advisor recommendations',
    description: 'The game\'s rule-based Advisor for one airline, as JSON: idle or under-used aircraft, routes that sell out or fly empty, heavy checks due, crowded gates, crew pay, marketing, fuel exposure. Each item has a priority (1 = act now), the reasoning, the routes or aircraft concerned and the in-game screen that fixes it.',
    inputSchema: { type: 'object', properties: { world_id: { type: 'string' } }, additionalProperties: false },
    run: async ({ source, accountId, args }) => {
      const { state } = await resolveAirline(source, accountId, args.world_id);
      return { json: airlineAdvice(state, state.lastReport ?? null) };
    },
  },
  {
    name: 'list_routes',
    title: 'List routes',
    description: 'Passenger routes of one airline with last week\'s figures: frequency, load factor, revenue, profit after lease and maintenance, fares (and the reference economy fare), sold-out flag, rival count, weeks open. Paged.',
    inputSchema: {
      type: 'object',
      properties: {
        world_id: { type: 'string' },
        sort: { type: 'string', enum: Object.keys(ROUTE_SORTS), description: 'profit (default), loss, revenue, load, emptiest' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'default 25' },
        offset: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    run: async ({ source, accountId, args }) => {
      const { state } = await resolveAirline(source, accountId, args.world_id);
      const rows = routeRows(state, state.lastReport ?? null).sort(ROUTE_SORTS[args.sort] ?? ROUTE_SORTS.profit);
      const offset = clampInt(args.offset, 0, 1e6, 0), limit = clampInt(args.limit, 1, 100, 25);
      return { json: { total: rows.length, offset, routes: rows.slice(offset, offset + limit) } };
    },
  },
  {
    name: 'list_fleet',
    title: 'List fleet',
    description: 'Aircraft of one airline: type, status (assigned, idle, maintenance, grounded), age, owned or leased with lease weeks left, number of routes, and weekly block hours used against the cap. Paged.',
    inputSchema: {
      type: 'object',
      properties: { world_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
    run: async ({ source, accountId, args }) => {
      const { state } = await resolveAirline(source, accountId, args.world_id);
      const rows = fleetRows(state);
      const offset = clampInt(args.offset, 0, 1e6, 0), limit = clampInt(args.limit, 1, 200, 50);
      return { json: { total: rows.length, offset, aircraft: rows.slice(offset, offset + limit) } };
    },
  },
  {
    name: 'get_finances',
    title: 'Weekly finances',
    description: 'Week-by-week results of one airline (up to the last 52 weeks): revenue, cargo revenue, total cost, net profit, cash, passengers, fuel index.',
    inputSchema: {
      type: 'object',
      properties: { world_id: { type: 'string' }, weeks: { type: 'integer', minimum: 1, maximum: 52, description: 'default 12' } },
      additionalProperties: false,
    },
    run: async ({ source, accountId, args }) => {
      const { state } = await resolveAirline(source, accountId, args.world_id);
      const weeks = clampInt(args.weeks, 1, 52, 12);
      const pick = ['label', 'week', 'year', 'revenue', 'cargoRevenue', 'totalCost', 'profit', 'cash', 'passengers', 'fuelIndex'];
      return { json: (state.financialHistory ?? []).slice(-weeks).map(h => Object.fromEntries(pick.map(k => [k, h?.[k] ?? null]))) };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

export const MCP_INSTRUCTIONS =
  'Headwinds is a multiplayer airline-management game. These tools read the user\'s OWN airlines, read-only: '
  + 'you cannot change anything in the game, so recommend actions for the player to take and name the in-game screen. '
  + 'Start with get_airline_briefing. Money is in-game dollars per game week. Route profit is after lease and maintenance, '
  + 'before airline-wide overheads. The Advisor section is the game\'s own rule-based diagnosis. For new route ideas, '
  + 'point the player at Network > Route Finder, which forecasts market share properly — do not invent demand figures.';

// ── MCP (JSON-RPC 2.0) ───────────────────────────────────────────────────────

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/** Answer one JSON-RPC message, or null for a notification. */
export async function handleMcpMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id, -32600, 'Invalid Request');
  }
  const isNotification = !Object.prototype.hasOwnProperty.call(msg, 'id');
  if (isNotification) return null;   // notifications/initialized, cancelled, … — nothing to say
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'headwinds', title: 'Headwinds (read-only)', version: SERVER_VERSION },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema }) => ({
          name, title, description, inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const tool = TOOL_BY_NAME.get(params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const out = await tool.run({ ...ctx, args: params?.arguments ?? {} });
        const text = out.text ?? JSON.stringify(out.json, null, 1);
        return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        // A player-facing failure (no such world, pick a world) goes back to
        // the model as a tool error it can read and recover from.
        if (err?.statusCode && err.statusCode < 500) {
          return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        ctx.log?.error?.(err);
        return rpcResult(id, { content: [{ type: 'text', text: 'The game server could not read the airline just now. Try again in a moment.' }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── The plugin ───────────────────────────────────────────────────────────────

/**
 * @param {{ store, source, authenticate, allow, now? }} deps
 *   authenticate  the normal session preHandler (requireAuth) for token management
 *   allow         (key, count, windowMs) → boolean, lib/rateLimit.mjs
 */
export function agentApiRoutes({ store, source, authenticate, allow, now = () => new Date() }) {
  const limit = (key, { count, windowMs }, msg) => {
    if (!allow(key, count, windowMs)) throw httpError(429, msg);
  };

  // Token → account, or throw. The supporter badge is checked HERE, on every
  // call, not when the token was made.
  async function agentFromRequest(request) {
    const header = request.headers?.authorization ?? '';
    const fromHeader = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const secret = request.params?.token ?? fromHeader;
    if (!looksLikeSecret(secret)) throw httpError(401, 'Missing or malformed Headwinds API token.', 'BAD_TOKEN');
    const hit = await store.findByHash(hashSecret(secret));
    if (!hit || !hit.account) throw httpError(401, 'This Headwinds API token has been revoked or does not exist.', 'BAD_TOKEN');
    if (hit.account.bannedAt) throw httpError(403, 'This account is suspended.', 'BANNED');
    if (!hit.account.isSupporter) throw httpError(403, LAPSED_MESSAGE, 'NOT_SUPPORTER');
    limit(`agent:${hit.token.id}`, AGENT_RATE_LIMIT, 'Too many requests on this token — wait a minute.');
    const at = now();
    const last = hit.token.lastUsedAt ? new Date(hit.token.lastUsedAt).getTime() : 0;
    if (at.getTime() - last > TOUCH_EVERY_MS) {
      store.touch(hit.token.id, at).catch(() => {});   // best effort; never fail a read on it
    }
    return { account: hit.account, token: hit.token };
  }

  return async function agentApi(fastify) {
    // ── Token management (normal session auth) ───────────────────────────────
    fastify.get('/me/api-tokens', { preHandler: authenticate }, async (request) => {
      const account = request.account;
      const tokens = await store.list(account.id);
      return { supporter: account.isSupporter === true, max: MAX_TOKENS_PER_ACCOUNT, tokens: tokens.map(serializeToken) };
    });

    fastify.post('/me/api-tokens', {
      preHandler: authenticate,
      schema: { body: { type: ['object', 'null'], properties: { label: { type: 'string', maxLength: 80 } } } },
    }, async (request) => {
      const account = request.account;
      limit(`agent-manage:${account.id}`, MANAGE_RATE_LIMIT, 'Too many token changes — wait a few minutes.');
      if (account.isSupporter !== true) throw httpError(403, NOT_SUPPORTER_MESSAGE, 'NOT_SUPPORTER');
      const live = await store.list(account.id);
      if (live.length >= MAX_TOKENS_PER_ACCOUNT) {
        throw httpError(409, `You already have ${MAX_TOKENS_PER_ACCOUNT} connector tokens. Revoke one first.`, 'TOO_MANY_TOKENS');
      }
      const secret = newSecret();
      const token = await store.create(account.id, {
        tokenHash: hashSecret(secret), label: cleanLabel(request.body?.label), prefix: displayPrefix(secret),
      });
      // The only time the secret leaves the server.
      return { token: serializeToken(token), secret };
    });

    fastify.delete('/me/api-tokens/:id', {
      preHandler: authenticate,
      schema: { params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] } },
    }, async (request) => {
      const account = request.account;
      limit(`agent-manage:${account.id}`, MANAGE_RATE_LIMIT, 'Too many token changes — wait a few minutes.');
      const ok = await store.revoke(account.id, request.params.id);
      if (!ok) throw httpError(404, 'No such token.');
      return { ok: true };
    });

    // ── Plain JSON / text (token auth) ───────────────────────────────────────
    fastify.get('/agent/airlines', async (request) => {
      const { account } = await agentFromRequest(request);
      return { airlines: await source.airlines(account.id) };
    });

    fastify.get('/agent/worlds/:worldId/briefing', async (request, reply) => {
      const { account } = await agentFromRequest(request);
      const { state, world } = await resolveAirline(source, account.id, request.params.worldId);
      reply.type('text/markdown; charset=utf-8');
      return airlineBriefing(state, { reportLabel: REPORT_LABEL, world });
    });

    fastify.get('/agent/worlds/:worldId/advice', async (request) => {
      const { account } = await agentFromRequest(request);
      const { state } = await resolveAirline(source, account.id, request.params.worldId);
      return { advice: airlineAdvice(state, state.lastReport ?? null) };
    });

    // ── MCP ──────────────────────────────────────────────────────────────────
    const mcpPost = async (request, reply) => {
      let agent;
      try {
        agent = await agentFromRequest(request);
      } catch (err) {
        const status = err.statusCode ?? 500;
        return reply.code(status).send(rpcError(request.body?.id, -32001, err.message));
      }
      const ctx = { source, accountId: agent.account.id, log: request.log };
      const body = request.body;
      if (Array.isArray(body)) {
        if (body.length === 0) return reply.code(400).send(rpcError(null, -32600, 'Empty batch'));
        const answers = (await Promise.all(body.map(m => handleMcpMessage(m, ctx)))).filter(Boolean);
        return answers.length ? reply.send(answers) : reply.code(202).send();
      }
      const answer = await handleMcpMessage(body, ctx);
      return answer ? reply.send(answer) : reply.code(202).send();
    };
    // No server-to-client stream and no sessions: GET (SSE) and DELETE are
    // answered as the spec says a stateless server should.
    const noStream = async (request, reply) => reply.code(405).header('allow', 'POST').send({ error: 'This MCP endpoint answers POST only (no event stream).' });

    for (const path of ['/mcp', '/mcp/:token']) {
      fastify.post(path, mcpPost);
      fastify.get(path, noStream);
      fastify.delete(path, noStream);
    }
  };
}

/**
 * Airlines from Postgres. `state` is read with the weekly report joined back
 * in — the contract every owner-facing read follows (lib/reportColumn.mjs) —
 * and WITHOUT the rival overlay: an agent sees the owner's own blob only.
 *
 * `joinReport` and `paceLabel` are passed in so this file stays importable by
 * a test with no database and no world config.
 */
export function prismaAirlineSource(prisma, { joinReport, paceLabel }) {
  return {
    async airlines(accountId) {
      const rows = await prisma.airline.findMany({
        where: { accountId },
        select: {
          id: true, worldId: true, name: true, status: true,
          world: { select: { name: true, status: true, currentWeek: true, currentYear: true, weeksPerDay: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(r => ({
        airlineId: r.id, worldId: r.worldId, worldName: r.world?.name ?? null, worldStatus: r.world?.status ?? null,
        name: r.name, status: r.status,
        week: r.world?.currentWeek ?? null, year: r.world?.currentYear ?? null,
        pace: r.world?.weeksPerDay ? paceLabel(r.world.weeksPerDay) : null,
      }));
    },
    async airline(accountId, worldId) {
      const row = await prisma.airline.findUnique({
        where: { worldId_accountId: { worldId, accountId } },
        select: { state: true, report: true, world: { select: { name: true, weeksPerDay: true } } },
      });
      if (!row) return null;
      return {
        state: joinReport(row.state, row.report),
        world: { name: row.world?.name ?? null, pace: row.world?.weeksPerDay ? paceLabel(row.world.weeksPerDay) : null },
      };
    },
  };
}
