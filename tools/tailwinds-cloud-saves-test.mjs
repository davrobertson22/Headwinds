// Tailwinds cloud saves — the supporter perk's server half.
//
// A Tailwinds player signs in with their Headwinds account (the same Supabase
// login) and keeps up to three airlines in cloud slots, so the airline follows
// them between browsers and devices. It is a GOODWILL perk (Dave, 2026-10-14):
// see docs/cloud-save-design.md in the Tailwinds repo. That framing is what
// most of these rules are for:
//
//   - Supporter status gates UPLOAD and nothing else. A lapsed supporter can
//     still list, load and delete their cloud saves — a thank-you that holds an
//     airline hostage when a tip stops is not a thank-you.
//   - A stale upload is REFUSED (409 with the slot's current version), never
//     last-write-wins. Two devices silently overwriting each other is the one
//     way cloud sync destroys an airline.
//   - Uploads are validated with the same decoder the Tailwinds importer uses
//     (lib/twsaveFile.mjs is a copy of it), and stored byte-for-byte.
//   - The slot list never carries the save bytes.
//
// Drives the REAL plugin through fastify.inject with an in-memory store, plus
// the real CORS and compression plugins configured as server.mjs does. The
// Prisma store adapter is tested against a fake client with Prisma's
// semantics (P2002 on a duplicate create, updateMany counts), because its
// conditional write IS the conflict rule.
//
// Verified failing on HEAD (2026-10-14): lib/cloudSaves.mjs did not exist, and
// a probe against HEAD's buildServer() answered GET /tw/saves with 404 (no
// such route) rather than 401.
//
//   node tools/tailwinds-cloud-saves-test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';

const {
  cloudSaveRoutes, memoryCloudSaveStore, prismaCloudSaveStore,
  CLOUD_SLOTS, MAX_UPLOAD_BYTES, UPLOAD_RATE_LIMIT, NOT_SUPPORTER_MESSAGE,
} = await import('../apps/headwinds-server/src/lib/cloudSaves.mjs');
const { encodeSaveFile, SAVE_FILE_FORMAT, SAVE_FILE_VERSION, MAX_SAVE_FILE_BYTES } =
  await import('../apps/headwinds-server/src/lib/twsaveFile.mjs');
const { errorHandler } = await import('../apps/headwinds-server/src/lib/errorHandler.mjs');
import { randomBytes } from 'node:crypto';

const TAILWINDS = 'https://www.tailwindsairlinegame.com';

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function section(t) { tests.push([`§${t}`, null]); }
const srcOf = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ── Harness ───────────────────────────────────────────────────────────────────

const airline = (name = 'Probe Air', over = {}) => ({
  airlineName: name, hub: 'LGW', logoId: 'horizon', logoColor: '#f5a623', customLogo: null,
  cash: 4_130_000, week: 12, year: 14, startYear: 1978, phase: 'playing',
  fleet: [{ id: 'a1', typeId: 'a320ceo' }], routes: [{ id: 'r1', origin: 'LGW', destination: 'CDG' }],
  ...over,
});
const twsave = async (name, over) => Buffer.from(await encodeSaveFile(airline(name, over), { exportedAt: 1_760_000_000_000 }));

async function harness({ limit } = {}) {
  const accounts = {
    sup:   { id: 'acc-sup',   isSupporter: true },
    other: { id: 'acc-other', isSupporter: true },
    plain: { id: 'acc-plain', isSupporter: false },
  };
  const store = memoryCloudSaveStore();
  let clock = Date.parse('2026-10-15T00:00:00.000Z');
  const now = () => new Date(clock += 1000);          // strictly increasing, 1s apart
  const hits = new Map();
  const allow = limit
    ? (key, max, windowMs) => { const n = (hits.get(key) ?? 0) + 1; hits.set(key, n); return n <= Math.min(max, limit); }
    : () => true;
  const authenticate = async (request) => {
    const who = request.headers['x-test-account'];
    if (!who || !accounts[who]) throw Object.assign(new Error('Missing Authorization: Bearer <token>'), { statusCode: 401 });
    request.account = accounts[who];
  };
  const app = Fastify();
  app.setErrorHandler(errorHandler);                   // production's, so codes and messages match
  app.register(cors, { origin: [TAILWINDS, 'http://localhost:5173'], credentials: true });
  app.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'], threshold: 4096 });
  app.register(cloudSaveRoutes({ store, authenticate, allow, now }));
  await app.ready();

  const as = (who, extra = {}) => (who ? { 'x-test-account': who, ...extra } : extra);
  const api = {
    list: (who) => app.inject({ method: 'GET', url: '/tw/saves', headers: as(who) }),
    load: (who, slot, headers = {}) => app.inject({ method: 'GET', url: `/tw/saves/${slot}`, headers: as(who, headers) }),
    put: (who, slot, body, base = 'none', headers = {}) => app.inject({
      method: 'PUT', url: `/tw/saves/${slot}`, payload: body,
      headers: as(who, { 'content-type': 'application/octet-stream', ...(base == null ? {} : { 'x-tw-base-upload': base }), ...headers }),
    }),
    del: (who, slot) => app.inject({ method: 'DELETE', url: `/tw/saves/${slot}`, headers: as(who) }),
  };
  return { app, api, accounts, store };
}
const json = (res) => JSON.parse(res.body);

// ── Signed out ────────────────────────────────────────────────────────────────

section('signed out');

test('every route needs a signed-in account', async () => {
  const { api } = await harness();
  const body = await twsave();
  for (const res of [await api.list(null), await api.load(null, 0), await api.put(null, 0, body), await api.del(null, 0)]) {
    assert.equal(res.statusCode, 401, res.body);
  }
});

// ── Listing ───────────────────────────────────────────────────────────────────

section('listing');

test('a new account sees three empty slots and whether it is a supporter', async () => {
  const { api } = await harness();
  const a = json(await api.list('plain'));
  assert.equal(a.supporter, false);
  assert.equal(a.maxSlots, CLOUD_SLOTS);
  assert.equal(CLOUD_SLOTS, 3);
  assert.deepEqual(a.slots, [null, null, null]);
  assert.equal(json(await api.list('sup')).supporter, true);
});

test('the list carries what a slot card draws — and never the save bytes', async () => {
  const { api } = await harness();
  assert.equal((await api.put('sup', 1, await twsave('Atlantic Airways'), 'none', { 'x-tw-device': 'Chrome on Mac' })).statusCode, 200);
  const res = await api.list('sup');
  const slot = json(res).slots[1];
  assert.equal(slot.slot, 1);
  assert.equal(slot.meta.airlineName, 'Atlantic Airways');
  assert.equal(slot.meta.startYear, 1978);
  assert.equal(slot.deviceLabel, 'Chrome on Mac');
  assert.equal(slot.savedAt, new Date(1_760_000_000_000).toISOString());
  assert.ok(Number.isFinite(Date.parse(slot.uploadedAt)));
  assert.ok(slot.size > 0);
  assert.ok(!('bytes' in slot) && !/"bytes"/.test(res.body), 'no bytes in the listing');
});

test('accounts are walled off from each other', async () => {
  const { api } = await harness();
  await api.put('sup', 0, await twsave('Mine'));
  assert.deepEqual(json(await api.list('other')).slots, [null, null, null]);
  assert.equal((await api.load('other', 0)).statusCode, 404);
  assert.equal((await api.del('other', 0)).statusCode, 204);         // deleting your own empty slot
  assert.equal(json(await api.list('sup')).slots[0].meta.airlineName, 'Mine');
});

// ── Upload: supporters only ───────────────────────────────────────────────────

section('upload is the perk — supporters only');

test('a supporter can upload to an empty slot', async () => {
  const { api } = await harness();
  const res = await api.put('sup', 0, await twsave());
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(json(res).slot.meta.airlineName, 'Probe Air');
});

test('a non-supporter is refused, kindly, and nothing is stored', async () => {
  const { api } = await harness();
  const res = await api.put('plain', 0, await twsave());
  assert.equal(res.statusCode, 403);
  assert.equal(json(res).code, 'NOT_SUPPORTER');
  assert.equal(json(res).error, NOT_SUPPORTER_MESSAGE);
  assert.match(NOT_SUPPORTER_MESSAGE, /thank-you/i);
  assert.deepEqual(json(await api.list('plain')).slots, [null, null, null]);
});

test('anything that is not a Tailwinds save is refused with the importer\'s own message', async () => {
  const { api } = await harness();
  for (const body of [Buffer.from('hello'), Buffer.from('{"foo":1}'), Buffer.from([0x89, 0x50, 0x4e, 0x47])]) {
    const res = await api.put('sup', 0, body);
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(json(res).code, 'INVALID_SAVE');
    assert.ok(json(res).error.length > 20);
  }
  const good = await twsave();
  const cut = await api.put('sup', 0, good.subarray(0, Math.floor(good.length / 2)));
  assert.equal(cut.statusCode, 422);
  assert.match(json(cut).error, /damaged|incomplete/i);
  assert.deepEqual(json(await api.list('sup')).slots, [null, null, null]);
});

test('a save that never got past setup is refused', async () => {
  const { api } = await harness();
  const res = await api.put('sup', 0, await twsave('', { phase: 'setup', airlineName: '' }));
  assert.equal(res.statusCode, 422);
});

test('slots outside 0–2 do not exist', async () => {
  const { api } = await harness();
  const body = await twsave();
  for (const s of ['3', '-1', 'x', '1.5', '01']) {
    assert.equal((await api.put('sup', s, body)).statusCode, 400, `put ${s}`);
    assert.equal((await api.load('sup', s)).statusCode, 400, `load ${s}`);
    assert.equal((await api.del('sup', s)).statusCode, 400, `del ${s}`);
  }
});

test('an upload must say which version it expects to replace', async () => {
  const { api } = await harness();
  const body = await twsave();
  assert.equal((await api.put('sup', 0, body, null)).statusCode, 400);
  assert.equal((await api.put('sup', 0, body, 'yesterday-ish')).statusCode, 400);
});

test('only raw bytes are accepted, and only up to the cap', async () => {
  const { api } = await harness();
  const asJson = await api.put('sup', 0, JSON.stringify(airline()), 'none', { 'content-type': 'application/json' });
  assert.equal(asJson.statusCode, 415);
  const huge = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x20);
  assert.equal((await api.put('sup', 0, huge)).statusCode, 413);
  assert.ok(MAX_UPLOAD_BYTES <= MAX_SAVE_FILE_BYTES);
});

test('a device label is cleaned and capped, never trusted as markup', async () => {
  const { api } = await harness();
  await api.put('sup', 0, await twsave(), 'none', { 'x-tw-device': `<b>\u0007${'x'.repeat(200)}` });
  const label = json(await api.list('sup')).slots[0].deviceLabel;
  assert.ok(label.length <= 60);
  assert.ok(!/[<>\u0000-\u001f]/.test(label));
});

// ── Conflicts ─────────────────────────────────────────────────────────────────

section('conflicts: refuse, never last-write-wins');

test('"none" against an occupied slot is a conflict, and the slot is untouched', async () => {
  const { api } = await harness();
  await api.put('sup', 0, await twsave('First'));
  const res = await api.put('sup', 0, await twsave('Second'), 'none');
  assert.equal(res.statusCode, 409);
  assert.equal(json(res).code, 'CLOUD_SLOT_CHANGED');
  assert.equal(json(res).current.meta.airlineName, 'First');
  assert.equal(json(await api.list('sup')).slots[0].meta.airlineName, 'First');
});

test('a stale version is a conflict; the current one replaces', async () => {
  const { api } = await harness();
  const v1 = json(await api.put('sup', 0, await twsave('V1'))).slot.uploadedAt;
  const v2 = json(await api.put('sup', 0, await twsave('V2'), v1)).slot.uploadedAt;
  assert.ok(Date.parse(v2) > Date.parse(v1));
  const stale = await api.put('sup', 0, await twsave('From the other laptop'), v1);
  assert.equal(stale.statusCode, 409);
  assert.equal(json(stale).current.meta.airlineName, 'V2');
  assert.equal(json(stale).current.uploadedAt, v2);
  // The player saw the conflict and chose to overwrite: they resend against v2.
  const ok = await api.put('sup', 0, await twsave('From the other laptop'), json(stale).current.uploadedAt);
  assert.equal(ok.statusCode, 200);
  assert.equal(json(await api.list('sup')).slots[0].meta.airlineName, 'From the other laptop');
});

test('a slot deleted on another device is a conflict for an upload that expected it', async () => {
  const { api } = await harness();
  const v1 = json(await api.put('sup', 2, await twsave())).slot.uploadedAt;
  await api.del('sup', 2);
  const res = await api.put('sup', 2, await twsave(), v1);
  assert.equal(res.statusCode, 409);
  assert.equal(json(res).current, null);
});

// ── Load and delete ───────────────────────────────────────────────────────────

section('load and delete');

test('a load returns exactly the bytes uploaded, uncompressed by the server', async () => {
  const { api } = await harness();
  // Random notes so the save does not gzip below the compressor's 4 KB threshold.
  const body = await twsave('Byte Exact', { routes: Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, origin: 'LGW', destination: 'CDG', note: randomBytes(24).toString('hex') })) });
  assert.ok(body.length > 4096, 'big enough that global compression would kick in');
  await api.put('sup', 1, body);
  const res = await api.load('sup', 1, { 'accept-encoding': 'gzip, br' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.headers['content-encoding'], undefined, 'a .twsave is already gzip; do not wrap it again');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(Buffer.compare(res.rawPayload, body) === 0, 'byte-for-byte');
});

test('an empty slot is a 404', async () => {
  const { api } = await harness();
  assert.equal((await api.load('sup', 0)).statusCode, 404);
});

test('delete empties a slot', async () => {
  const { api } = await harness();
  await api.put('sup', 0, await twsave());
  assert.equal((await api.del('sup', 0)).statusCode, 204);
  assert.deepEqual(json(await api.list('sup')).slots, [null, null, null]);
});

test('a LAPSED supporter keeps their saves: list, load and delete still work; only upload pauses', async () => {
  const { api, accounts } = await harness();
  const body = await twsave('Kept');
  await api.put('sup', 0, body);
  await api.put('sup', 1, await twsave('Also kept'));
  accounts.sup.isSupporter = false;                     // the monthly tip stopped
  const list = json(await api.list('sup'));
  assert.equal(list.supporter, false);
  assert.equal(list.slots[0].meta.airlineName, 'Kept');
  const load = await api.load('sup', 0);
  assert.equal(load.statusCode, 200);
  assert.ok(Buffer.compare(load.rawPayload, body) === 0);
  assert.equal((await api.put('sup', 0, await twsave('New'), list.slots[0].uploadedAt)).statusCode, 403);
  assert.equal((await api.del('sup', 1)).statusCode, 204);
  assert.equal(json(await api.list('sup')).slots[0].meta.airlineName, 'Kept');
});

// ── Rate limits ───────────────────────────────────────────────────────────────

section('rate limits');

test('uploads past the limit are refused with 429, and the stored save survives', async () => {
  const { api } = await harness({ limit: 2 });
  const a = json(await api.put('sup', 0, await twsave('One'))).slot.uploadedAt;
  const b = json(await api.put('sup', 0, await twsave('Two'), a)).slot.uploadedAt;
  const res = await api.put('sup', 0, await twsave('Three'), b);
  assert.equal(res.statusCode, 429);
  assert.equal(json(await api.list('sup')).slots[0].meta.airlineName, 'Two');
  assert.ok(UPLOAD_RATE_LIMIT.count >= 6 && UPLOAD_RATE_LIMIT.windowMs <= 5 * 60_000,
    'window must fit inside rateLimit.mjs\'s 5-minute idle sweep, or it silently resets');
});

// ── CORS ──────────────────────────────────────────────────────────────────────

section('CORS from the Tailwinds site');

test('a preflight PUT from Tailwinds is allowed, with the headers the client sends', async () => {
  const { app } = await harness();
  const res = await app.inject({ method: 'OPTIONS', url: '/tw/saves/0', headers: {
    origin: TAILWINDS, 'access-control-request-method': 'PUT',
    'access-control-request-headers': 'authorization,content-type,x-tw-base-upload,x-tw-device',
  } });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], TAILWINDS);
  assert.match(res.headers['access-control-allow-methods'], /PUT/);
  assert.match(res.headers['access-control-allow-methods'], /DELETE/);
  assert.match(res.headers['access-control-allow-headers'], /x-tw-base-upload/);
});

test('an origin not on the list gets no CORS grant', async () => {
  const { app } = await harness();
  const res = await app.inject({ method: 'OPTIONS', url: '/tw/saves/0', headers: {
    origin: 'https://evil.example', 'access-control-request-method': 'PUT',
  } });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

// ── The Prisma adapter ────────────────────────────────────────────────────────

section('Prisma store: the conditional write is the conflict rule');

/** A fake Prisma client with the semantics the adapter relies on. */
function fakePrisma() {
  const rows = [];
  const calls = [];
  const match = (r, w) => Object.entries(w).every(([k, v]) =>
    v instanceof Date ? r[k] instanceof Date && r[k].getTime() === v.getTime() : r[k] === v);
  const pick = (r, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, r[k]])) : { ...r });
  const model = {
    async findMany({ where, select, orderBy }) { calls.push(['findMany', { where, select, orderBy }]); return rows.filter((r) => match(r, where)).map((r) => pick(r, select)); },
    async findUnique({ where, select }) {
      calls.push(['findUnique', { where, select }]);
      const { accountId, slot } = where.accountId_slot;
      const r = rows.find((x) => x.accountId === accountId && x.slot === slot);
      return r ? pick(r, select) : null;
    },
    async create({ data, select }) {
      if (rows.some((x) => x.accountId === data.accountId && x.slot === data.slot)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      const r = { id: `id${rows.length}`, ...data }; rows.push(r); return pick(r, select);
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const r of rows) if (match(r, where)) { Object.assign(r, data); count++; }
      return { count };
    },
    async deleteMany({ where }) {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], where)) { rows.splice(i, 1); count++; }
      return { count };
    },
  };
  return { tailwindsCloudSave: model, rows, calls };
}

const row = (n, at) => ({ fileVersion: 1, meta: { airlineName: n }, bytes: Buffer.from(n), size: n.length, savedAt: new Date(0), uploadedAt: at, deviceLabel: null });

test('create on an empty slot; a duplicate create is a conflict, not a crash', async () => {
  const p = fakePrisma(); const s = prismaCloudSaveStore(p);
  const t1 = new Date('2026-10-15T01:00:00Z');
  const a = await s.write('acc', 0, null, row('A', t1));
  assert.equal(a.ok, true); assert.equal(a.row.meta.airlineName, 'A');
  const b = await s.write('acc', 0, null, row('B', new Date()));
  assert.equal(b.ok, false); assert.equal(b.current.meta.airlineName, 'A');
  assert.equal(p.rows.length, 1);
});

test('replace only when the stored version is the one expected', async () => {
  const p = fakePrisma(); const s = prismaCloudSaveStore(p);
  const t1 = new Date('2026-10-15T01:00:00Z'), t2 = new Date('2026-10-15T02:00:00Z');
  await s.write('acc', 0, null, row('A', t1));
  const stale = await s.write('acc', 0, new Date('2026-10-14T00:00:00Z'), row('X', t2));
  assert.equal(stale.ok, false); assert.equal(stale.current.meta.airlineName, 'A');
  const ok = await s.write('acc', 0, t1, row('B', t2));
  assert.equal(ok.ok, true); assert.equal(ok.row.meta.airlineName, 'B');
  assert.equal(ok.row.uploadedAt.getTime(), t2.getTime());
});

test('the list query never selects the bytes column', async () => {
  const p = fakePrisma(); const s = prismaCloudSaveStore(p);
  await s.write('acc', 0, null, row('A', new Date()));
  const list = await s.list('acc');
  assert.equal(list.length, 1);
  assert.ok(!('bytes' in list[0]));
  const q = p.calls.find(([k]) => k === 'findMany')[1];
  assert.ok(q.select && !q.select.bytes, 'select must omit bytes');
});

test('the memory store honours the same contract (it stands in for Prisma above)', async () => {
  const s = memoryCloudSaveStore();
  const t1 = new Date(1000);
  assert.equal((await s.write('acc', 0, null, row('A', t1))).ok, true);
  assert.equal((await s.write('acc', 0, null, row('B', new Date(2000)))).ok, false);
  assert.equal((await s.write('acc', 0, new Date(5), row('B', new Date(2000)))).ok, false);
  assert.equal((await s.write('acc', 0, t1, row('B', new Date(2000)))).ok, true);
  assert.ok(!('bytes' in (await s.list('acc'))[0]));
});

// ── Wiring ────────────────────────────────────────────────────────────────────

section('wiring: schema, migration, route, server');

test('schema: one row per account per slot, bytes stored, deleted with the account', () => {
  const schema = srcOf('apps/headwinds-server/prisma/schema.prisma');
  const m = schema.match(/model TailwindsCloudSave \{[\s\S]*?\n\}/);
  assert.ok(m, 'model TailwindsCloudSave');
  assert.match(m[0], /bytes\s+Bytes/);
  assert.match(m[0], /uploadedAt\s+DateTime/);
  assert.match(m[0], /onDelete: Cascade/);
  assert.match(m[0], /@@unique\(\[accountId, slot\]\)/);
  assert.match(schema, /tailwindsCloudSaves\s+TailwindsCloudSave\[\]/);
});

test('a migration creates the table, its unique pair and the cascading key', () => {
  const dir = new URL('../apps/headwinds-server/prisma/migrations/', import.meta.url);
  const name = readdirSync(dir).find((d) => /tailwinds_cloud_saves$/.test(d));
  assert.ok(name, 'migration folder');
  const sql = readFileSync(new URL(`${name}/migration.sql`, dir), 'utf8');
  assert.match(sql, /CREATE TABLE "TailwindsCloudSave"/);
  assert.match(sql, /"bytes" BYTEA NOT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX "TailwindsCloudSave_accountId_slot_key"/);
  assert.match(sql, /ON DELETE CASCADE/);
});

test('server.mjs uses the shared error handler the suite runs under', () => {
  const server = srcOf('apps/headwinds-server/src/server.mjs');
  assert.match(server, /app\.setErrorHandler\(errorHandler\)/);
  assert.match(server, /import \{ errorHandler \} from '\.\/lib\/errorHandler\.mjs'/);
});

test('the route uses the real auth gate and the Prisma store, and the server registers it', () => {
  const route = srcOf('apps/headwinds-server/src/routes/tailwindsSaves.mjs');
  assert.match(route, /authenticate: requireAuth/);
  assert.match(route, /prismaCloudSaveStore\(prisma\)/);
  const server = srcOf('apps/headwinds-server/src/server.mjs');
  assert.match(server, /import tailwindsSaveRoutes from '\.\/routes\/tailwindsSaves\.mjs'/);
  assert.match(server, /app\.register\(tailwindsSaveRoutes\)/);
});

test('the copied save-file format matches what Tailwinds writes', () => {
  assert.equal(SAVE_FILE_FORMAT, 'tailwinds-save');
  assert.equal(SAVE_FILE_VERSION, 1);
  assert.match(srcOf('apps/headwinds-server/src/lib/twsaveFile.mjs'), /COPY of Tailwinds `src\/store\/saveFile\.js`/);
});

test('the supporter flag is still never an engine input', () => {
  const engineDir = new URL('../packages/engine/src/', import.meta.url);
  const walk = (u) => readdirSync(u, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(new URL(`${d.name}/`, u)) : /\.(m?js|jsx)$/.test(d.name) ? [new URL(d.name, u)] : []);
  if (!existsSync(engineDir)) return;
  for (const f of walk(engineDir)) assert.ok(!readFileSync(f, 'utf8').includes('isSupporter'), f.pathname);
});

// ── run ───────────────────────────────────────────────────────────────────────

for (const [name, fn] of tests) {
  if (fn === null) { console.log(`\n── ${name.slice(1)} ${'─'.repeat(Math.max(0, 61 - name.length))}`); continue; }
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
