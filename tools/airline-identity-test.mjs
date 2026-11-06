// Airline identity everywhere (visual & engagement plan, pick 1, 2026-11-05):
// every airline's logo beside its name in Rankings, the season results, the
// News tab and the Activity ticker; each rival's own lines on the Rivals map
// in their livery's tail colour; and an admin "Clear logo" for the rude upload
// that is now seen far more often.
//
//   1. SQL — the REAL standings query from routes/worlds.mjs, run in PGlite:
//      it returns each airline's preset fields off the rival projection and a
//      logo hash equal to logoHashOf(), so the /logos URL it builds is the
//      cache-forever one.
//   2. Branding index — the ids News and the ticker carry ('abc') match the
//      competitor ids the client holds ('human:abc', 'human:abc~g2').
//   3. Rivals map colour — livery tail when it reads on both basemaps and
//      isn't a colour the map already means something by; slate otherwise.
//   4. SSR of the REAL StandingsTable, SeasonResults, EventMark, AccountSearch
//      results and RivalRouteMap legend.
//
//   node --import ./tools/_register-loader.mjs tools/airline-identity-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (h) => h.replaceAll('<!-- -->', '');

const { logoHashOf, logoPathOf } = await import('../apps/headwinds-server/src/lib/logoColumn.mjs');
const { brandIndex, airlineIdOfRival, rivalNetworkColor, usableNetworkColor, RIVAL_FALLBACK } =
  await import('../src/utils/airlineBrands.js');

// ── 1. The real standings SQL, in PGlite ─────────────────────────────────────
console.log('\n── 1. Standings query carries the logo ─────────────────────────');

const MIGRATION = fileURLToPath(new URL(
  '../apps/headwinds-server/prisma/migrations/20261022000000_airline_rival_state/migration.sql', import.meta.url));
const db = new PGlite();
await db.exec(`
  CREATE TYPE "AirlineStatus" AS ENUM ('ACTIVE', 'BANKRUPT', 'ABANDONED');
  CREATE TABLE "Account" (
    id text PRIMARY KEY, "isOG" boolean NOT NULL DEFAULT false,
    "isSupporter" boolean NOT NULL DEFAULT false, email text,
    username text, "displayName" text);
  CREATE TABLE "Airline" (
    id text PRIMARY KEY, "worldId" text NOT NULL, "accountId" text NOT NULL REFERENCES "Account"(id),
    name text NOT NULL, hub text NOT NULL, state jsonb NOT NULL, "customLogo" text,
    cash bigint NOT NULL DEFAULT 0, "marketCap" bigint NOT NULL DEFAULT 0,
    shares bigint NOT NULL DEFAULT 0, svps bigint NOT NULL DEFAULT 0,
    "rankScore" bigint, "weeklyProfit" bigint, "netAssets" bigint,
    "paxWeek" integer, "flightsWeek" integer, "fleetSize" integer,
    week integer NOT NULL DEFAULT 1, "joinedWeek" integer NOT NULL DEFAULT 1,
    version integer NOT NULL DEFAULT 0, status "AirlineStatus" NOT NULL DEFAULT 'ACTIVE',
    restarts integer NOT NULL DEFAULT 0);
`);
await db.exec(read('../apps/headwinds-server/prisma/migrations/20261022000000_airline_rival_state/migration.sql'));

// The query text exactly as the route sends it (template → $1).
const worldsSrc = read('../apps/headwinds-server/src/routes/worlds.mjs');
const m = /const airlines = await prisma\.\$queryRaw`([\s\S]*?)`;/.exec(worldsSrc);
assert.ok(m, 'found the standings query in routes/worlds.mjs');
const sql = m[1].replace(/\$\{world\.id\}/g, '$1');

const UPLOAD = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
await db.query(`INSERT INTO "Account"(id, email, username) VALUES ('acc1', 'a@x.com', 'ann'), ('acc2', 'b@x.com', 'bob'), ('acc3', 'c@x.com', 'cat')`);
const ins = (id, acc, state, logo, rival) => db.query(
  `INSERT INTO "Airline"(id, "worldId", "accountId", name, hub, state, "customLogo", "rankScore") VALUES ($1, 'w1', $2, $3, 'JFK', $4::jsonb, $5, $6)`,
  [id, acc, `Air ${id}`, JSON.stringify(state), logo, rival]);
await ins('a1', 'acc1', { logoId: 'eagle', logoColor: '#d71920', logoBg: '#ffffff', routes: [], fleet: [] }, UPLOAD, 300);
await ins('a2', 'acc2', { logoId: 'star', logoColor: '#1e9bff', routes: [{}], fleet: [{}] }, null, 200);
await ins('a3', 'acc3', { routes: [], fleet: [] }, null, 100);
// a2 has a filled rival projection that disagrees with its blob on purpose:
// the query must read the projection (it never needs the blob for a filled row).
await db.query(`UPDATE "Airline" SET "rivalState" = '{"logoId":"jade","logoColor":"#00a99d"}'::jsonb WHERE id = 'a2'`);

const rows = (await db.query(sql, ['w1'])).rows;
const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

await test('the query still runs and returns every active airline', () => {
  assert.equal(rows.length, 3);
});
await test('preset fields come back, off the rival projection when it is filled', () => {
  assert.equal(byId.a1.logoId, 'eagle');
  assert.equal(byId.a1.logoColor, '#d71920');
  assert.equal(byId.a1.logoBg, '#ffffff');
  assert.equal(byId.a2.logoId, 'jade', 'read from rivalState, not state');
  assert.equal(byId.a2.logoColor, '#00a99d');
  assert.equal(byId.a3.logoId, null, 'no pick → null (the route defaults it to compass)');
});
await test('the SQL logo hash is the JS hash, so the URL is the cache-forever one', () => {
  assert.equal(byId.a1.logoHash, logoHashOf(UPLOAD));
  assert.equal(logoPathOf('a1', byId.a1.logoHash), `/logos/a1?v=${logoHashOf(UPLOAD)}`);
  assert.equal(byId.a2.logoHash, null);
  assert.equal(logoPathOf('a2', byId.a2.logoHash), null, 'no upload → no URL');
});
await test('the route emits the logo fields on every standings row', () => {
  for (const k of ["logoId: a.logoId ?? 'compass'", 'logoColor: a.logoColor ?? null', 'logoBg: a.logoBg ?? null', 'customLogo: logoPathOf(a.id, a.logoHash)']) {
    assert.ok(worldsSrc.includes(k), `standings row maps ${k}`);
  }
});

// ── 2. Branding index ────────────────────────────────────────────────────────
console.log('\n── 2. News and ticker find each airline\'s logo ────────────────');

await test('competitor ids strip to the airline id news rows carry', () => {
  assert.equal(airlineIdOfRival('human:abc'), 'abc');
  assert.equal(airlineIdOfRival('human:abc~g2'), 'abc');
  assert.equal(airlineIdOfRival('ai-17'), null);
  assert.equal(airlineIdOfRival(null), null);
});
await test('brandIndex: you and every human rival, AI carriers skipped', () => {
  const state = {
    logoId: 'star', logoColor: '#ff0000', logoBg: null, customLogo: 'data:image/png;base64,AA',
    competitors: [
      { id: 'human:r1', logoId: 'eagle', logoColor: '#00ff00', customLogo: '/logos/r1?v=abc' },
      { id: 'human:r2~g1', logoId: 'jade' },
      { id: 'ai-3', logoId: 'arctic' },
    ],
  };
  const idx = brandIndex(state, 'me');
  assert.deepEqual([...idx.keys()].sort(), ['me', 'r1', 'r2']);
  assert.equal(idx.get('r1').customLogo, '/logos/r1?v=abc');
  assert.equal(idx.get('r2').logoId, 'jade');
  assert.equal(idx.get('me').logoColor, '#ff0000');
  assert.equal(brandIndex(state, null).has('me'), false, 'no airline id (solo) → no self entry');
});

// ── 3. Rivals map colour ─────────────────────────────────────────────────────
console.log('\n── 3. Rivals map: their lines in their colours ─────────────────');

// The browser shims go in only now: PGlite (above) reads `window` to decide
// whether it is running in a browser.
globalThis.window = globalThis.window ?? {};
const store = new Map();
globalThis.localStorage = globalThis.localStorage ?? {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { RIVAL_COLOR, CONTESTED_COLOR } = await import('../src/components/mapCore.js');

await test('the fallback is the map\'s own slate', () => {
  assert.equal(RIVAL_FALLBACK, RIVAL_COLOR);
});
await test('a readable tail colour is used as-is', () => {
  assert.equal(rivalNetworkColor({ livery: { tail: '#1E9BFF' } }), '#1e9bff');
  assert.equal(rivalNetworkColor({ livery: { tail: '#ffffff' } }), '#ffffff', 'white reads on a dark map');
  assert.equal(rivalNetworkColor({ livery: { tail: '#d71920' } }), '#d71920', 'a deep airline red is still theirs');
});
await test('no saved livery → the default tail, which is their logo colour', () => {
  assert.equal(rivalNetworkColor({ logoColor: '#38e1ff' }), '#38e1ff');
});
await test('colours that vanish on the basemaps fall back to slate', () => {
  for (const tail of ['#000000', '#0a2a66', '#15202f', '#202733']) {
    assert.equal(rivalNetworkColor({ livery: { tail } }), RIVAL_FALLBACK, tail);
  }
});
await test('colours the map already gives a meaning fall back to slate', () => {
  assert.equal(usableNetworkColor(CONTESTED_COLOR), false, 'contested amber');
  for (const tail of ['#fbbf24', '#f0b323', '#e8833a', '#ffcf4d', '#a371f7', '#2ee6a0', '#ff5d6c']) {
    assert.equal(rivalNetworkColor({ livery: { tail } }), RIVAL_FALLBACK, tail);
  }
});

// ── 4. The real components ───────────────────────────────────────────────────
console.log('\n── 4. Server-rendered screens ──────────────────────────────────');

const { setLogoOrigin } = await import('../src/components/AirlineLogo.jsx');
setLogoOrigin('https://api.example.com');
const StandingsTable = (await import('../apps/headwinds-web/src/StandingsTable.jsx')).default;
const SeasonResults = (await import('../apps/headwinds-web/src/SeasonResults.jsx')).default;
const EventMark = (await import('../src/components/EventMark.jsx')).default;
const AccountSearchResults = (await import('../apps/headwinds-web/src/AccountSearchResults.jsx')).default;
const RivalRouteMap = (await import('../src/components/RivalRouteMap.jsx')).default;

const standings = [
  { rank: 1, id: 'a1', name: 'Air a1', hub: 'JFK', status: 'ACTIVE', logoId: 'eagle', logoColor: '#d71920', logoBg: '#ffffff', customLogo: '/logos/a1?v=0123456789ab' },
  { rank: 2, id: 'a2', name: 'Air a2', hub: 'LHR', status: 'ACTIVE', logoId: 'jade', logoColor: '#00a99d', logoBg: null, customLogo: null },
  { rank: 3, id: 'a3', name: 'Air a3', hub: 'SYD', status: 'ACTIVE' },   // an older payload: no logo fields
];
const rowOf = (html, id) => {
  const at = html.indexOf(`data-airline-id="${id}"`);
  return html.slice(at, html.indexOf('</tr>', at));
};

await test('Rankings: an upload renders from the API origin, a preset as its mark', () => {
  const html = strip(renderToString(React.createElement(StandingsTable, {
    world: { id: 'w1' }, standings, ranking: null, fallen: 0, mineId: null,
    sort: { key: 'avgProfit', dir: 'desc' }, onSort: () => {}, openRivalId: null, onToggleRival: () => {}, idleOf: () => null,
  })));
  assert.match(rowOf(html, 'a1'), /<image[^>]+href="https:\/\/api\.example\.com\/logos\/a1\?v=0123456789ab"/);
  assert.match(rowOf(html, 'a2'), /class="standings-logo"/);
  assert.match(rowOf(html, 'a2'), /stroke="#00a99d"/, 'the preset is drawn in their colour');
  assert.doesNotMatch(rowOf(html, 'a3'), /standings-logo/, 'no logo fields → no mark, no broken square');
});

await test('Season results: the podium and final table carry each airline\'s mark', () => {
  const html = strip(renderToString(React.createElement(SeasonResults, {
    worldId: 'w1', token: null, myAirlineId: null, me: null,
    preloaded: { standings: [...standings, { rank: 4, id: 'a4', name: 'Air a4', hub: 'DXB', status: 'ACTIVE', logoId: 'star', logoColor: '#ffcc00' }],
      ranking: { metric: 'avgProfit' }, seasonAwards: null },
  })));
  const podium = html.slice(html.indexOf('Podium'), html.indexOf('Final standings'));
  assert.match(podium, /logos\/a1\?v=0123456789ab/);
  assert.equal((podium.match(/<svg/g) ?? []).length >= 2, true, 'presets and uploads both drawn');
  const table = html.slice(html.indexOf('Final standings'));
  assert.match(table, /fill="#ffcc00"/, 'the fourth finisher, below the podium, has a mark too');
});

await test('News / ticker mark: the logo leads with the event as a badge; no brand keeps the emoji', () => {
  const withBrand = strip(renderToString(React.createElement(EventMark, {
    brand: { logoId: 'eagle', logoColor: '#d71920', logoBg: null, customLogo: null }, icon: '✈️', size: 22,
  })));
  assert.match(withBrand, /class="event-mark"/);
  assert.match(withBrand, /<svg/);
  assert.match(withBrand, /✈️/);
  const bare = strip(renderToString(React.createElement(EventMark, { brand: null, icon: '🌍' })));
  assert.doesNotMatch(bare, /<svg/);
  assert.match(bare, /🌍/);
});

await test('News and the ticker actually use the mark', () => {
  assert.match(read('../src/components/News.jsx'), /<EventMark brand=\{c\.standalone \? null : \(brands\.get\(it\.airlineId\) \?\? null\)\}/);
  assert.match(read('../apps/headwinds-web/src/Feed.jsx'), /<EventMark[\s\S]*brands\?\.get\(e\.airlineId\)/);
  assert.match(read('../apps/headwinds-web/src/GamePlayScreen.jsx'), /<FeedWidget [^>]*brands=\{brands\}/);
});

await test('Admin: account search offers Clear logo, wired to its own route', () => {
  const html = strip(renderToString(React.createElement(AccountSearchResults, {
    accounts: [{ id: 'acc1', displayName: 'ann', email: 'a@x.com', airlines: ['Air a1'] }],
    busyId: null, onSetOg: () => {}, onSetSupporter: () => {}, onBan: () => {}, onUnban: () => {}, onClearLogo: () => {},
  })));
  assert.match(html, />Clear logo</);
  const admin = read('../apps/headwinds-server/src/routes/admin.mjs');
  assert.match(admin, /fastify\.post\('\/admin\/accounts\/:accountId\/clear-logo'/);
  assert.match(admin, /preHandler: requireAdmin,\s*schema: \{\s*params: \{ type: 'object', properties: \{ accountId[\s\S]{0,400}data: \{ customLogo: null \}/);
});

await test('Rivals map legend says "Their network" in their colour', () => {
  const html = strip(renderToString(React.createElement(RivalRouteMap, {
    routes: { 'JFK-LHR': { frequency: 7, aircraftType: 'b737800' } }, hubs: ['JFK'],
    name: 'Air a1', networkColor: '#d71920',
  })));
  const legend = html.slice(html.lastIndexOf('Their network') - 300, html.lastIndexOf('Their network'));
  assert.match(legend, /#d71920/);
  const dflt = strip(renderToString(React.createElement(RivalRouteMap, {
    routes: { 'JFK-LHR': { frequency: 7, aircraftType: 'b737800' } }, hubs: ['JFK'], name: 'Air a1',
  })));
  assert.match(dflt.slice(dflt.lastIndexOf('Their network') - 300), new RegExp(RIVAL_COLOR));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
