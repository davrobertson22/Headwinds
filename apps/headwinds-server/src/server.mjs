// Headwinds HTTP API — minimal, dependency-free (Node built-in http).
//
//   node apps/headwinds-server/src/server.mjs      # listens on :8787
//
// SCAFFOLD NOTE: this is a thin REST shell to show the shape of the API. For
// production, port it to Fastify (schema validation = your input allow-list),
// add managed auth (Clerk/Supabase) in front of accountId, persist via the
// Postgres store, and run the tick from a scheduled worker (see the plan, §5–6).
import http from 'node:http';
import { createWorld, joinWorld, applyPlayerAction, tickWorld, standings } from './world.mjs';
import { store } from './store.mjs';

const PORT = process.env.PORT || 8787;

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

// account is faked via header here; real auth middleware replaces this.
const account = (req) => req.headers['x-account-id'] || 'anon';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);  // e.g. ['worlds', ':id', 'tick']
  try {
    // GET /worlds — list
    if (req.method === 'GET' && parts[0] === 'worlds' && parts.length === 1) {
      return send(res, 200, { worlds: store.list() });
    }
    // POST /worlds — create
    if (req.method === 'POST' && parts[0] === 'worlds' && parts.length === 1) {
      const b = await readBody(req);
      const w = store.put(createWorld({ name: b.name, pace: b.pace, seasonEndYear: b.seasonEndYear }));
      return send(res, 201, { id: w.id, name: w.name, status: w.status });
    }
    const w = parts[0] === 'worlds' ? store.get(parts[1]) : null;
    if (parts[0] === 'worlds' && !w) return send(res, 404, { error: 'no such world' });

    // GET /worlds/:id — standings + clock
    if (req.method === 'GET' && parts.length === 2) {
      return send(res, 200, { id: w.id, status: w.status, week: w.week, year: w.year, standings: standings(w) });
    }
    // POST /worlds/:id/join { airlineName, hub }
    if (req.method === 'POST' && parts[2] === 'join') {
      const b = await readBody(req);
      joinWorld(w, { accountId: account(req), airlineName: b.airlineName, hub: b.hub });
      return send(res, 200, { ok: true });
    }
    // POST /worlds/:id/actions { type, ... } — validated player intent
    if (req.method === 'POST' && parts[2] === 'actions') {
      const action = await readBody(req);
      const state = applyPlayerAction(w, account(req), action);
      return send(res, 200, { cash: Math.round(state.cash), routes: state.routes.length, fleet: state.fleet.length });
    }
    // POST /worlds/:id/tick — authoritative tick (in prod: scheduler-only, not public)
    if (req.method === 'POST' && parts[2] === 'tick') {
      return send(res, 200, tickWorld(w));
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`[headwinds] listening on http://localhost:${PORT}`));
