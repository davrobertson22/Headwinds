// Read-only Agent API — supporters connect their own AI to their airlines.
//
// PRD (Discord, 2026-11-07) asked for an "AI manager"; Dave chose a free
// in-game Advisor + "Copy airline briefing" for everyone, and a read-only API
// for SUPPORTERS (2026-11-09) that lets a player's own Claude/ChatGPT read the
// same thing over MCP. These are the rules that make it safe to ship:
//
//   - Supporter badge gates token CREATION and is re-checked on EVERY agent
//     call: a lapsed badge stops the connector; listing and revoking never do.
//   - Read-only: no tool, route or JSON-RPC method can reach a decision.
//   - Own airline only, no rival overlay: a rival's name planted in the blob's
//     overlay never comes back out.
//   - Only the hash is stored; the secret is returned once, and never logged —
//     the path form (/mcp/hwk_…) is redacted by the request serializer.
//   - MCP speaks the protocol a real client expects: initialize negotiates the
//     version, notifications get 202 and no body, unknown methods -32601,
//     tool failures come back as isError results the model can read.
//   - The briefing the API serves is byte-identical to the one the in-game
//     button copies for the same state and report.
//
// Drives the REAL plugin through fastify.inject with an in-memory token store
// and an airline source holding states built by the REAL reducer.
//
// Verified failing on HEAD (2026-11-09): lib/agentApi.mjs and the engine's
// models/advisor.js / briefing.js did not exist, and a probe against HEAD's
// buildServer() route table had no /mcp or /me/api-tokens route.
//
//   node tools/agent-api-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';

const {
  agentApiRoutes, memoryTokenStore, hashSecret, looksLikeSecret, redactAgentUrl, prismaAirlineSource,
  MAX_TOKENS_PER_ACCOUNT, NOT_SUPPORTER_MESSAGE, LAPSED_MESSAGE, TOOLS, MCP_PROTOCOL_VERSIONS, handleMcpMessage,
} = await import('../apps/headwinds-server/src/lib/agentApi.mjs');
const { errorHandler } = await import('../apps/headwinds-server/src/lib/errorHandler.mjs');
const { airlineBriefing } = await import('../packages/engine/src/models/briefing.js');
const { screenGuide, actionPathText } = await import('../src/screenGuide.js');
// What routes/agentApi.mjs injects: where every page is, multiplayer names.
const GUIDE = (state) => ({ screens: screenGuide(state, { remote: true }), actionPath: (a) => actionPathText(a, { remote: true }) });

let x = 777;
Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
const { gameReducer, freshState } = await import('../packages/engine/src/reducer.mjs');

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const srcOf = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ── Harness ───────────────────────────────────────────────────────────────────

function airlineState(name) {
  let s = gameReducer(freshState(), { type: 'START_GAME', airlineName: name, hub: 'JFK', enableObjectives: false });
  s = { ...s, cash: 5e8 };
  for (let i = 0; i < 3; i++) s = gameReducer(s, { type: 'ADD_GATE', airportCode: 'JFK' });
  for (const d of ['ORD', 'MIA']) {
    s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });
    const ac = s.fleet[s.fleet.length - 1].id;
    s = gameReducer(s, { type: 'ADD_GATE', airportCode: d });
    s = gameReducer(s, { type: 'ADD_ROUTE', aircraftId: ac, origin: 'JFK', destination: d, weeklyFrequency: 14 });
  }
  s = gameReducer(s, { type: 'BUY_AIRCRAFT', typeId: 'b737800' });   // stays idle
  for (let i = 0; i < 3; i++) s = gameReducer(s, { type: 'ADVANCE_WEEK' });
  return s;
}
const ALPHA = airlineState('Alpha Air');
const BETA = airlineState('Beta Air');
// A rival overlay as the airline GET serves it — must never come out of the API.
const ALPHA_WITH_OVERLAY = { ...ALPHA, humanRivals: { r1: { name: 'Secret Rival Airways' } } };

function fakeSource(byAccount) {
  return {
    async airlines(accountId) {
      return (byAccount[accountId] ?? []).map(a => ({ airlineId: a.id, worldId: a.worldId, worldName: a.worldName, worldStatus: 'RUNNING', name: a.state.airlineName, status: 'ACTIVE', week: 3, year: 1 }));
    },
    async airline(accountId, worldId) {
      const a = (byAccount[accountId] ?? []).find(r => r.worldId === worldId);
      // Handed back WITH any overlay still on it, so the tools themselves are
      // proven not to print rival data even if a blob ever carried some.
      if (!a) return null;
      return { state: a.state, world: { name: a.worldName, pace: '1 week / 2 hr' } };
    },
  };
}

const ACCOUNTS = {
  sup:  { id: 'sup',  isSupporter: true,  bannedAt: null },
  free: { id: 'free', isSupporter: false, bannedAt: null },
  two:  { id: 'two',  isSupporter: true,  bannedAt: null },
};

function build({ allow = () => true } = {}) {
  const store = memoryTokenStore();
  for (const a of Object.values(ACCOUNTS)) store.accounts.set(a.id, a);
  const source = fakeSource({
    sup: [{ id: 'al1', worldId: 'w1', worldName: 'Time Flies', state: ALPHA_WITH_OVERLAY }],
    two: [{ id: 'al2', worldId: 'w1', worldName: 'Time Flies', state: ALPHA }, { id: 'al3', worldId: 'w2', worldName: 'Jet Age', state: BETA }],
  });
  const authenticate = async (request) => {
    const who = request.headers['x-test-account'];
    if (!who || !ACCOUNTS[who]) throw Object.assign(new Error('Missing Authorization'), { statusCode: 401 });
    request.account = ACCOUNTS[who];
  };
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.register(agentApiRoutes({ store, source, authenticate, allow, guide: GUIDE }));
  return { app, store };
}

async function mint(app, account = 'sup', label = 'Claude') {
  const res = await app.inject({ method: 'POST', url: '/me/api-tokens', headers: { 'x-test-account': account }, payload: { label } });
  return { res, body: res.json() };
}
const rpc = (app, secret, body, { viaPath = false } = {}) => app.inject({
  method: 'POST', url: viaPath ? `/mcp/${secret}` : '/mcp',
  headers: { 'content-type': 'application/json', ...(viaPath ? {} : { authorization: `Bearer ${secret}` }) },
  payload: body,
});
const call = async (app, secret, name, args = {}) => {
  const res = await rpc(app, secret, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
  return res.json().result;
};

// ── Tokens ────────────────────────────────────────────────────────────────────

test('a supporter mints a token: secret returned once, only its hash stored', async () => {
  const { app, store } = build();
  const { res, body } = await mint(app);
  assert.equal(res.statusCode, 200);
  assert.ok(looksLikeSecret(body.secret), body.secret);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].tokenHash, hashSecret(body.secret));
  assert.ok(!JSON.stringify(store.rows[0]).includes(body.secret), 'the secret itself must not be stored');
  const list = (await app.inject({ method: 'GET', url: '/me/api-tokens', headers: { 'x-test-account': 'sup' } })).json();
  assert.equal(list.supporter, true);
  assert.equal(list.tokens.length, 1);
  assert.ok(!JSON.stringify(list).includes(body.secret), 'the list never carries the secret');
  assert.equal(list.tokens[0].label, 'Claude');
});

test('a non-supporter cannot mint (403 NOT_SUPPORTER) but can list', async () => {
  const { app } = build();
  const { res, body } = await mint(app, 'free');
  assert.equal(res.statusCode, 403);
  assert.equal(body.code, 'NOT_SUPPORTER');
  assert.equal(body.error, NOT_SUPPORTER_MESSAGE);
  const list = await app.inject({ method: 'GET', url: '/me/api-tokens', headers: { 'x-test-account': 'free' } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().supporter, false);
});

test(`at most ${MAX_TOKENS_PER_ACCOUNT} live tokens; revoking frees a slot`, async () => {
  const { app } = build();
  const ids = [];
  for (let i = 0; i < MAX_TOKENS_PER_ACCOUNT; i++) ids.push((await mint(app, 'sup', `t${i}`)).body.token.id);
  const over = await mint(app);
  assert.equal(over.res.statusCode, 409);
  const del = await app.inject({ method: 'DELETE', url: `/me/api-tokens/${ids[0]}`, headers: { 'x-test-account': 'sup' } });
  assert.equal(del.statusCode, 200);
  assert.equal((await mint(app)).res.statusCode, 200);
});

test('you can only revoke your own token', async () => {
  const { app } = build();
  const { body } = await mint(app, 'sup');
  const del = await app.inject({ method: 'DELETE', url: `/me/api-tokens/${body.token.id}`, headers: { 'x-test-account': 'two' } });
  assert.equal(del.statusCode, 404);
  assert.equal((await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 200);
});

// ── Agent auth ────────────────────────────────────────────────────────────────

test('no token, a malformed token, an unknown token: 401', async () => {
  const { app } = build();
  assert.equal((await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })).statusCode, 401);
  assert.equal((await rpc(app, 'hwk_short', { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 401);
  assert.equal((await rpc(app, 'hwk_' + 'A'.repeat(32), { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 401);
});

test('a revoked token stops answering at once', async () => {
  const { app } = build();
  const { body } = await mint(app);
  await app.inject({ method: 'DELETE', url: `/me/api-tokens/${body.token.id}`, headers: { 'x-test-account': 'sup' } });
  assert.equal((await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 401);
});

test('a LAPSED badge silences an existing token (403), and it works again when the badge is back', async () => {
  const { app } = build();
  const { body } = await mint(app);
  ACCOUNTS.sup.isSupporter = false;
  try {
    const res = await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.message, LAPSED_MESSAGE);
    const rest = await app.inject({ method: 'GET', url: '/agent/airlines', headers: { authorization: `Bearer ${body.secret}` } });
    assert.equal(rest.statusCode, 403);
    // …and listing/revoking stay open to the lapsed account
    assert.equal((await app.inject({ method: 'GET', url: '/me/api-tokens', headers: { 'x-test-account': 'sup' } })).statusCode, 200);
  } finally { ACCOUNTS.sup.isSupporter = true; }
  assert.equal((await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 200);
});

test('a banned account is refused', async () => {
  const { app } = build();
  const { body } = await mint(app);
  ACCOUNTS.sup.bannedAt = new Date();
  try { assert.equal((await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 403); }
  finally { ACCOUNTS.sup.bannedAt = null; }
});

test('the token works in the path for URL-only connectors, and the path is redacted for logs', async () => {
  const { app } = build();
  const { body } = await mint(app);
  const res = await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'ping' }, { viaPath: true });
  assert.equal(res.statusCode, 200);
  assert.equal(redactAgentUrl(`/mcp/${body.secret}?x=1`), '/mcp/hwk_[redacted]?x=1');
  assert.ok(!redactAgentUrl(`/mcp/${body.secret}`).includes(body.secret.slice(4)));
  // server.mjs actually installs the redacting serializer
  const server = srcOf('apps/headwinds-server/src/server.mjs');
  assert.match(server, /url:\s*redactAgentUrl\(req\.url\)/);
  assert.match(server, /app\.register\(agentApiRoutes\)/);
});

test('per-token rate limit answers 429', async () => {
  let n = 0;
  const { app } = build({ allow: (key) => !(key.startsWith('agent:') && ++n > 2) });
  const { body } = await mint(app);
  assert.equal((await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 200);
  assert.equal((await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 200);
  assert.equal((await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 429);
});

// ── MCP protocol ──────────────────────────────────────────────────────────────

test('initialize negotiates the protocol version and announces tools only', async () => {
  const { app } = build();
  const { body } = await mint(app);
  for (const v of MCP_PROTOCOL_VERSIONS) {
    const r = (await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
    assert.equal(r.result.protocolVersion, v);
    assert.deepEqual(Object.keys(r.result.capabilities), ['tools']);
    assert.equal(r.result.serverInfo.name, 'headwinds');
    assert.match(r.result.instructions, /read-only/);
  }
  const unknown = (await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json();
  assert.equal(unknown.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
});

test('a notification gets 202 and no body; a batch answers only its requests', async () => {
  const { app } = build();
  const { body } = await mint(app);
  const note = await rpc(app, body.secret, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.statusCode, 202);
  assert.equal(note.body, '');
  const batch = await rpc(app, body.secret, [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'a', method: 'ping' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
  ]);
  const out = batch.json();
  assert.deepEqual(out.map(m => m.id), ['a', 'b']);
});

test('unknown method -32601; malformed message -32600; GET is 405 (no stream)', async () => {
  const { app } = build();
  const { body } = await mint(app);
  assert.equal((await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'resources/list' })).json().error.code, -32601);
  assert.equal((await rpc(app, body.secret, { id: 1, method: 'ping' })).json().error.code, -32600);
  const get = await app.inject({ method: 'GET', url: `/mcp/${body.secret}` });
  assert.equal(get.statusCode, 405);
});

test('every tool is read-only: annotated so, and no tool or route can reach a decision', async () => {
  const { app } = build();
  const { body } = await mint(app);
  const list = (await rpc(app, body.secret, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json().result.tools;
  assert.deepEqual(list.map(t => t.name).sort(), TOOLS.map(t => t.name).sort());
  for (const t of list) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
  }
  const lib = srcOf('apps/headwinds-server/src/lib/agentApi.mjs');
  for (const forbidden of ['gameReducer', 'dispatch(', 'decisions', 'prisma.airline.update', 'airline.update(']) {
    assert.ok(!lib.includes(forbidden), `agentApi.mjs must not touch ${forbidden}`);
  }
});

// ── What the tools serve ──────────────────────────────────────────────────────

test('get_airline_briefing serves the same text the in-game button copies', async () => {
  const { app } = build();
  const { body } = await mint(app);
  const r = await call(app, body.secret, 'get_airline_briefing');
  assert.equal(r.isError, false);
  const expected = airlineBriefing(ALPHA_WITH_OVERLAY, { reportLabel: 'last week', world: { name: 'Time Flies', pace: '1 week / 2 hr' }, ...GUIDE(ALPHA_WITH_OVERLAY) });
  assert.equal(r.content[0].text, expected);
  assert.match(r.content[0].text, /# Airline briefing: Alpha Air/);
  assert.match(r.content[0].text, /## Advisor/);
  assert.match(r.content[0].text, /idle Boeing 737-800/);
  // the connected AI gets the screen guide too, with multiplayer names
  assert.match(r.content[0].text, /## Where things are in the game/);
  assert.match(r.content[0].text, /\| Company ▸ Rivals \|/);
});

test('the route wiring injects the screen guide', () => {
  const wiring = srcOf('apps/headwinds-server/src/routes/agentApi.mjs');
  assert.match(wiring, /import \{ screenGuide, actionPathText \} from '..\/..\/..\/..\/src\/screenGuide.js'/);
  assert.match(wiring, /\bguide,\n\}\);/);
});

test('no rival overlay comes out of any tool', async () => {
  const { app } = build();
  const { body } = await mint(app);
  for (const t of TOOLS) {
    const r = await call(app, body.secret, t.name);
    assert.ok(!r.content[0].text.includes('Secret Rival Airways'), `${t.name} leaked the rival overlay`);
  }
});

test('get_advice, list_routes, list_fleet, get_finances return the airline\'s own figures', async () => {
  const { app } = build();
  const { body } = await mint(app);
  const advice = JSON.parse((await call(app, body.secret, 'get_advice')).content[0].text);
  assert.ok(advice.some(a => a.id === 'idle-b737800'), JSON.stringify(advice.map(a => a.id)));
  const idle = advice.find(a => a.id === 'idle-b737800');
  assert.equal(idle.where, 'Network ▸ Route Finder (map view: Search ▸ Route Finder)');
  const routes = JSON.parse((await call(app, body.secret, 'list_routes', { sort: 'loss', limit: 1 })).content[0].text);
  assert.equal(routes.total, 2);
  assert.equal(routes.routes.length, 1);
  const rr = new Map(ALPHA.lastReport.routeResults.map(r => [r.routeId, r]));
  const worst = Math.min(...ALPHA.routes.map(r => rr.get(r.id).trueProfit));
  assert.equal(routes.routes[0].profit, Math.round(worst), 'profit is the tick\'s trueProfit');
  const fleet = JSON.parse((await call(app, body.secret, 'list_fleet')).content[0].text);
  assert.equal(fleet.total, 3);
  assert.equal(fleet.aircraft.filter(a => a.status === 'idle').length, 1);
  const fin = JSON.parse((await call(app, body.secret, 'get_finances', { weeks: 2 })).content[0].text);
  assert.equal(fin.length, 2);
  assert.equal(fin[1].profit, ALPHA.financialHistory.at(-1).profit);
});

test('with two airlines a missing world_id is a readable tool error listing both; world_id picks one', async () => {
  const { app } = build();
  const { body } = await mint(app, 'two');
  const r = await call(app, body.secret, 'get_airline_briefing');
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /pass world_id/);
  assert.match(r.content[0].text, /w1/); assert.match(r.content[0].text, /w2/);
  const b = await call(app, body.secret, 'get_airline_briefing', { world_id: 'w2' });
  assert.equal(b.isError, false);
  assert.match(b.content[0].text, /Beta Air/);
  const nope = await call(app, body.secret, 'get_airline_briefing', { world_id: 'w9' });
  assert.equal(nope.isError, true);
});

test('plain JSON/text routes: /agent/airlines, briefing (markdown), advice', async () => {
  const { app } = build();
  const { body } = await mint(app);
  const h = { authorization: `Bearer ${body.secret}` };
  const al = (await app.inject({ method: 'GET', url: '/agent/airlines', headers: h })).json();
  assert.equal(al.airlines[0].worldId, 'w1');
  const br = await app.inject({ method: 'GET', url: '/agent/worlds/w1/briefing', headers: h });
  assert.match(br.headers['content-type'], /text\/markdown/);
  assert.match(br.body, /Alpha Air/);
  const adv = (await app.inject({ method: 'GET', url: '/agent/worlds/w1/advice', headers: h })).json();
  assert.ok(Array.isArray(adv.advice));
});

test('a tool that throws unexpectedly answers isError without leaking internals', async () => {
  const ctx = { accountId: 'x', source: { airlines: async () => { throw new Error('connection terminated by pgbouncer'); } }, log: { error() {} } };
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_my_airlines' } }, ctx);
  assert.equal(r.result.isError, true);
  assert.ok(!r.result.content[0].text.includes('pgbouncer'));
});

test('prismaAirlineSource joins the report and drops nothing the owner sees', async () => {
  const calls = [];
  const prisma = { airline: {
    findMany: async (q) => { calls.push(q); return [{ id: 'a', worldId: 'w', name: 'N', status: 'ACTIVE', world: { name: 'W', status: 'RUNNING', currentWeek: 4, currentYear: 2, weeksPerDay: 12 } }]; },
    findUnique: async (q) => { calls.push(q); return { state: { airlineName: 'N' }, report: { routeResults: [] }, world: { name: 'W', weeksPerDay: 12 } }; },
  } };
  const joinReport = (state, report) => ({ ...state, lastReport: report });
  const src = prismaAirlineSource(prisma, { joinReport, paceLabel: (w) => `${w}/day` });
  const list = await src.airlines('acc');
  assert.equal(list[0].pace, '12/day');
  assert.deepEqual(calls[0].where, { accountId: 'acc' });
  const one = await src.airline('acc', 'w');
  assert.deepEqual(one.state.lastReport, { routeResults: [] });
  assert.deepEqual(calls[1].where, { worldId_accountId: { worldId: 'w', accountId: 'acc' } });
  assert.equal(calls[1].select.rivalState, undefined, 'never reads the rival-facing column');
});

test('schema + migration: the ApiToken table exists and touches no existing table', () => {
  const schema = srcOf('apps/headwinds-server/prisma/schema.prisma');
  assert.match(schema, /model ApiToken \{[\s\S]*tokenHash\s+String\s+@unique/);
  const sql = srcOf('apps/headwinds-server/prisma/migrations/20261109000000_api_tokens/migration.sql');
  assert.match(sql, /CREATE TABLE "ApiToken"/);
  assert.ok(!/ALTER TABLE "(?!ApiToken)/.test(sql), 'the migration must only alter its own table');
});

// ── Run ───────────────────────────────────────────────────────────────────────
console.log('\nRead-only Agent API (supporters)\n');
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
