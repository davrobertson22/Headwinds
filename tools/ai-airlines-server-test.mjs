// AI airlines on the server (apps/headwinds-server/src/lib/aiAirlines.mjs) —
// phase 3 of claude/background-competitors-plan.md: the world option, founding
// the airlines, and giving each its weekly turn through a player's checks.
//
// No database, no network: the real service code and the real engine against
// an in-memory fake Prisma, as tools/headwinds-tick-test.mjs does.
//
// What is pinned:
//   • a world without the option never reaches any of it (not one query);
//   • AI airlines are ordinary airline rows on accounts nobody can sign in to,
//     founded once, in week 1, at hubs nobody else is based at;
//   • they do not take a player's seat, a trophy, a podium place or a
//     hall-of-fame entry;
//   • a turn is decided with the checks the decisions route runs, commits in
//     one version-guarded write, journals what it did, keeps the shared gate
//     ledger in step, and is dropped whole if the airline changed under it;
//   • the worker gives them their turn before the tick, and a failure there
//     never stops the week.
//
//   node --import ./tools/_register-loader.mjs tools/ai-airlines-server-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gameReducer } from '../packages/engine/src/reducer.mjs';
import {
  AI_PRESETS, AI_SETTINGS, AI_AUTH_PREFIX, AI_EMAIL_DOMAIN, AI_ACCOUNT_WHERE,
  AI_NAME_TAG, aiNameOf, hasAiTag, aiCountsFor,
  aiPresetOf, isAiAccount, aiAccountFor, ensureAiAirlines, runAiTurns, runAiWeek, playerChecks, humansOnly,
} from '../apps/headwinds-server/src/lib/aiAirlines.mjs';
import { createWorld, joinWorld, seedAirlineState, createAirlineRow, OG_NAME_PATTERN } from '../apps/headwinds-server/src/lib/worldService.mjs';
import { validateWorldConfig, serializeWorld, AI_AIRLINE_SETTINGS } from '../apps/headwinds-server/src/lib/worldConfig.mjs';
import { runDueTicks } from '../apps/headwinds-server/src/lib/tickService.mjs';
import { awardTrophy } from '../apps/headwinds-server/src/lib/trophies.mjs';
import { buildWorldRivalViews, withRivals, stripRivals, isAiEmail } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { joinReport, splitReport } from '../apps/headwinds-server/src/lib/reportColumn.mjs';
import { ALLOWED_PLAYER_ACTIONS } from '../apps/headwinds-server/src/world.mjs';

let passed = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
};
const quiet = { info() {}, warn() {}, error() {} };
const deps = { seedAirlineState, createAirlineRow, log: quiet };

// ── In-memory fake Prisma: just the surface these paths touch ─────────────────
function fakePrisma({ worlds = [] } = {}) {
  const db = { worlds: worlds.map((w) => ({ ...w })), accounts: [], airlines: [], decisions: [], gates: [], trophies: [{ id: 'cup' }], awards: [], calls: 0, counts: [] };
  let n = 0; const id = (p) => `${p}${++n}`;
  const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const startsWith = (v, f) => (f?.startsWith != null ? String(v ?? '').startsWith(f.startsWith) : true);
  const accountOf = (a) => db.accounts.find((x) => x.id === a.accountId) ?? null;
  const matches = (a, where = {}) => (where.worldId == null || a.worldId === where.worldId)
    && (where.status == null || a.status === where.status)
    && (where.account?.NOT == null || !startsWith(accountOf(a)?.authUserId, where.account.NOT.authUserId));
  const withAccount = (a) => ({ ...a, account: accountOf(a) });
  const counted = (fn) => async (...args) => { db.calls++; return fn(...args); };
  const p = {
    _db: db,
    account: {
      upsert: counted(({ where, create }) => {
        let a = db.accounts.find((x) => x.authUserId === where.authUserId);
        if (!a) { a = { id: id('acct'), isOG: false, isSupporter: false, ...create }; db.accounts.push(a); }
        return { ...a };
      }),
      findUnique: counted(({ where }) => { const a = db.accounts.find((x) => x.id === where.id); return a ? { ...a } : null; }),
    },
    airline: {
      findMany: counted(({ where } = {}) => {
        const out = db.airlines.filter((a) => matches(a, where)).map(withAccount);
        // Someone else writes this airline straight after it was read (a tick, in real life).
        if (db.bumpAfterRead) { db.airlines.find((a) => a.id === db.bumpAfterRead).version += 1; db.bumpAfterRead = null; }
        return out;
      }),
      findUnique: counted(({ where }) => {
        const k = where.worldId_accountId;
        const a = db.airlines.find((x) => (k ? x.worldId === k.worldId && x.accountId === k.accountId : x.id === where.id));
        return a ? { ...a } : null;
      }),
      count: counted(({ where }) => { db.counts.push(where); return db.airlines.filter((a) => matches(a, where)).length; }),
      groupBy: counted(({ where }) => {
        const by = new Map();
        for (const a of db.airlines) {
          if (!where.worldId.in.includes(a.worldId) || a.status !== where.status || !startsWith(accountOf(a)?.authUserId, where.account.authUserId)) continue;
          by.set(a.worldId, (by.get(a.worldId) ?? 0) + 1);
        }
        return [...by].map(([worldId, n]) => ({ worldId, _count: { _all: n } }));
      }),
      create: counted(({ data }) => {
        if (db.airlines.some((a) => a.worldId === data.worldId && a.accountId === data.accountId)) throw p2002();
        const row = { id: id('air'), version: 0, report: null, customLogo: null, restarts: 0, ...data };
        db.airlines.push(row); return { ...row };
      }),
      updateMany: counted(({ where, data }) => {
        const a = db.airlines.find((x) => x.id === where.id && (where.version === undefined || x.version === where.version));
        if (!a) return { count: 0 };
        for (const [k, v] of Object.entries(data)) a[k] = (v && typeof v === 'object' && 'increment' in v) ? (a[k] ?? 0) + v.increment : v;
        return { count: 1 };
      }),
    },
    decision: { createMany: counted(({ data }) => { db.decisions.push(...data); return { count: data.length }; }) },
    world: {
      findMany: counted(({ where } = {}) => db.worlds.filter((w) => !where?.status || w.status === where.status).map((w) => ({ ...w }))),
      findUnique: counted(({ where }) => { const w = db.worlds.find((x) => x.id === where.id); return w ? { ...w } : null; }),
      create: counted(({ data }) => { const w = { id: id('world'), ...data }; db.worlds.push(w); return { ...w }; }),
      updateMany: counted(() => ({ count: 0 })),
    },
    worldGate: {
      findUnique: counted(({ where }) => { const k = where.worldId_airportCode; const g = db.gates.find((x) => x.worldId === k.worldId && x.airportCode === k.airportCode); return g ? { ...g, holdings: { ...g.holdings } } : null; }),
      findMany: counted(({ where } = {}) => db.gates.filter((g) => !where?.worldId || g.worldId === where.worldId).map((g) => ({ ...g }))),
      create: counted(({ data }) => { const g = { id: id('gate'), version: 0, ...data }; db.gates.push(g); return { ...g }; }),
      updateMany: counted(({ where, data }) => {
        const g = db.gates.find((x) => x.id === where.id && x.version === where.version); if (!g) return { count: 0 };
        for (const [k, v] of Object.entries(data)) g[k] = (v && typeof v === 'object' && 'increment' in v) ? (g[k] ?? 0) + v.increment : v;
        return { count: 1 };
      }),
    },
    alliance: { findMany: counted(() => []) }, allianceMember: { findMany: counted(() => []) },
    worldMarket: { findUnique: counted(() => null) }, worldMarketDev: { findUnique: counted(() => ({ pairs: {} })) },
    gateAuction: { findMany: counted(() => []) }, gateListing: { findMany: counted(() => []) }, gateSlotShare: { findMany: counted(() => []) },
    trophy: { findUnique: counted(({ where }) => db.trophies.find((x) => x.id === where.id) ?? null) },
    trophyAward: { findFirst: counted(() => null), create: counted(({ data }) => { db.awards.push(data); return { id: id('award'), ...data, trophy: {} }; }) },
    $transaction: async (fn) => fn(p),
  };
  return p;
}

const baseWorld = (over = {}) => ({
  id: 'w1', name: 'Test world', status: 'RUNNING', visibility: 'PUBLIC', lengthYears: 10, weeksPerDay: 24, currentWeek: 1, currentYear: 1,
  maxPlayers: 10, worldSeed: 'seed-1', startedAt: new Date(), endsAt: null,
  tickConfig: { stage: 'beta', fuelOpsV: 2, marketDev: true, demandModel: 3, crewPipeline: true, loyaltyPools: true, partnerships: true,
    startingCapital: 10_000_000, rivalItineraries: true, newWorldRestrictions: true, aiAirlines: 'light' },
  ...over,
});

// One world week, the way the tick advances an airline: reducer on the rival-injected state, report back in its column.
async function miniTick(prisma, world) {
  const rows = prisma._db.airlines.filter((a) => a.worldId === world.id && a.status === 'ACTIVE');
  const joined = rows.map((a) => ({ ...a, account: prisma._db.accounts.find((x) => x.id === a.accountId), state: joinReport(a.state, a.report) }));
  const views = await buildWorldRivalViews(prisma, world.id, { airlines: joined, world });
  for (const a of joined) {
    const next = stripRivals(gameReducer(withRivals(a.state, views.get(a.id)),
      { type: 'ADVANCE_WEEK', worldFuelIndex: 1, worldCrackIndex: 1, worldEvents: [], valuationNoise: 0, marketIndex: 1, incomingDividends: 0, incomingFarmFees: 0 }));
    const row = rows.find((r) => r.id === a.id); const { state, report } = splitReport(next);
    row.state = state; row.report = report ?? null; row.version += 1;
  }
  world.currentWeek += 1; if (world.currentWeek > 52) { world.currentWeek = 1; world.currentYear += 1; }
}

console.log('the world option');
await t('only the settings that exist are accepted, and the two lists agree', () => {
  assert.deepEqual([...AI_AIRLINE_SETTINGS].sort(), [...AI_SETTINGS].sort(), 'worldConfig.AI_AIRLINE_SETTINGS and aiAirlines.AI_PRESETS have drifted apart');
  const ok = { lengthYears: 10, weeksPerDay: 24, visibility: 'PUBLIC', maxPlayers: 10 };
  for (const v of [undefined, null, 'off', 'light']) validateWorldConfig({ ...ok, aiAirlines: v });
  for (const v of ['standard', 'fierce', 'LIGHT', true, 8]) assert.throws(() => validateWorldConfig({ ...ok, aiAirlines: v }), /aiAirlines must be one of/, `accepted aiAirlines: ${v}`);
});
await t('a world carries the key only when its creator asked for AI airlines', async () => {
  const prisma = fakePrisma();
  const plain = await createWorld(prisma, { lengthYears: 10, weeksPerDay: 24 });
  const off = await createWorld(prisma, { lengthYears: 10, weeksPerDay: 24, aiAirlines: 'off' });
  const light = await createWorld(prisma, { lengthYears: 10, weeksPerDay: 24, aiAirlines: 'light' });
  assert.ok(!('aiAirlines' in plain.tickConfig) && !('aiAirlines' in off.tickConfig));
  assert.equal(light.tickConfig.aiAirlines, 'light');
  assert.equal(aiPresetOf(plain), null); assert.equal(aiPresetOf(off), null);
  assert.equal(aiPresetOf(light).airlines, AI_PRESETS.light.airlines);
  assert.equal(aiPresetOf({ tickConfig: { aiAirlines: 'fierce' } }), null, 'a setting with no preset must read as off, not crash');
  assert.equal(serializeWorld(light, { playerCount: 0 }).aiAirlines, 'light');
  assert.equal(serializeWorld(plain, { playerCount: 0 }).aiAirlines, null);
});
await t('only an admin world can have them while the feature is on trial', async () => {
  await assert.rejects(() => createWorld(fakePrisma(), { lengthYears: 10, weeksPerDay: 24, aiAirlines: 'light', ownerAccountId: 'someone', password: 'secret1' }), /Only an admin/);
});

console.log('\na world without the option');
await t('is never touched: no founding, no turns, not one query', async () => {
  const world = baseWorld({ tickConfig: { ...baseWorld().tickConfig, aiAirlines: undefined } });
  const prisma = fakePrisma({ worlds: [world] });
  assert.equal(await runAiWeek(prisma, world, deps), null);
  assert.deepEqual(await ensureAiAirlines(prisma, world, deps), { founded: 0 });
  assert.equal((await runAiTurns(prisma, world, deps)).airlines, 0);
  assert.equal(prisma._db.calls, 0, 'a world without AI airlines cost a database query');
});
await t('counts its seats exactly as before; a world with AI airlines counts people only', async () => {
  const ask = async (world) => {
    const prisma = fakePrisma({ worlds: [world] });
    await assert.rejects(() => joinWorld(prisma, { account: { id: 'me' }, world: { ...world, maxPlayers: 0 }, airlineName: 'Mine', hub: 'LHR' }), /full/);
    return prisma._db.counts.at(-1);
  };
  assert.deepEqual(await ask(baseWorld({ tickConfig: {} })), { worldId: 'w1', status: 'ACTIVE' });
  assert.deepEqual(await ask(baseWorld()), { worldId: 'w1', status: 'ACTIVE', account: { NOT: AI_ACCOUNT_WHERE } });
});

console.log('\nwho they are');
await t('an AI account cannot be signed in to or mailed, and is the same one in every world', async () => {
  const prisma = fakePrisma();
  const a = await aiAccountFor(prisma, 'Global Air'); const b = await aiAccountFor(prisma, 'Global Air');
  assert.equal(a.id, b.id); assert.equal(prisma._db.accounts.length, 1);
  assert.ok(a.authUserId.startsWith(AI_AUTH_PREFIX) && a.email.endsWith(`@${AI_EMAIL_DOMAIN}`) && AI_EMAIL_DOMAIN.endsWith('.invalid'));
  assert.ok(isAiAccount(a)); assert.ok(isAiAccount({ email: a.email }), 'a row that only selected the email must still be recognised');
  assert.equal(a.displayName, 'Global Air (AI)', 'the account\'s own name must carry the tag too');
  assert.equal(a.dmPolicy, 'NOBODY', 'an AI account must not accept direct messages — nobody reads them');
  assert.ok(isAiEmail(a.email) && !isAiEmail('dave@example.com'), 'humanRivals.isAiEmail and aiAirlines.AI_EMAIL_DOMAIN have drifted apart');
  assert.ok(!isAiAccount({ authUserId: 'f3b1c0de-uuid', email: 'dave@example.com' }) && !isAiAccount({ email: 'ai@example.com' }) && !isAiAccount(null));
});

console.log('\nfounding');
const world = baseWorld({ tickConfig: { ...baseWorld().tickConfig, gateScarcity: true } });
const prisma = fakePrisma({ worlds: [world] });
// A player is already based at Tokyo Haneda when the world starts.
prisma._db.accounts.push({ id: 'human', authUserId: 'f3b1c0de', email: 'player@example.com', displayName: 'Player', isOG: false, isSupporter: false });
await createAirlineRow(prisma, { world, accountId: 'human', airlineName: 'Player Air', hub: 'HND' });
const founded = await ensureAiAirlines(prisma, world, deps);
const aiRows = () => prisma._db.airlines.filter((a) => isAiAccount(prisma._db.accounts.find((x) => x.id === a.accountId)));
await t('the preset\'s airlines are founded in week 1, each at its own hub, none at a player\'s', () => {
  assert.equal(founded.founded, AI_PRESETS.light.airlines);
  const rows = aiRows();
  assert.equal(rows.length, AI_PRESETS.light.airlines);
  assert.equal(new Set(rows.map((r) => r.hub)).size, rows.length, 'two AI airlines share a hub');
  assert.equal(new Set(rows.map((r) => r.name)).size, rows.length, 'two AI airlines share a name');
  assert.ok(!rows.some((r) => r.hub === 'HND'), 'an AI airline was founded at the hub a player already holds');
  for (const r of rows) { assert.equal(r.status, 'ACTIVE'); assert.equal(r.state.hub, r.hub); assert.equal(Number(r.cash), 10_000_000); assert.equal(r.joinedWeek, 1); }
});
await t('they are founded like a player\'s airline: the same opening state, and the starter hub gate in the ledger', () => {
  const human = prisma._db.airlines.find((a) => a.accountId === 'human');
  for (const r of aiRows()) {
    assert.deepEqual(Object.keys(r.state).sort(), Object.keys(human.state).sort(), 'an AI airline\'s save has different keys from a player\'s');
    const ledger = prisma._db.gates.find((g) => g.airportCode === r.hub);
    assert.equal(ledger?.holdings?.[r.id]?.count, 1, `no starter gate in the ledger for ${r.name} at ${r.hub}`);
  }
});
await t('founding happens once: not again the same week, and never later', async () => {
  assert.deepEqual(await ensureAiAirlines(prisma, world, deps), { founded: 0 });
  const late = baseWorld({ id: 'w-late', currentWeek: 2 });
  const p2 = fakePrisma({ worlds: [late] });
  assert.deepEqual(await ensureAiAirlines(p2, late, deps), { founded: 0 });
  assert.equal(p2._db.airlines.length, 0);
  const lobby = baseWorld({ id: 'w-lobby', status: 'LOBBY' });
  assert.deepEqual(await ensureAiAirlines(fakePrisma({ worlds: [lobby] }), lobby, deps), { founded: 0 });
});

console.log('\nthe AI tag');
await t('every AI airline\'s NAME ends with the tag — the row, the save and the account', () => {
  assert.equal(AI_NAME_TAG, ' (AI)'); assert.equal(aiNameOf('Global Air'), 'Global Air (AI)');
  for (const r of aiRows()) {
    assert.ok(hasAiTag(r.name), `"${r.name}" is an AI airline with no tag in its name`);
    assert.equal(r.state.airlineName, r.name, 'the save\'s own name differs from the row\'s');
    assert.ok(hasAiTag(prisma._db.accounts.find((x) => x.id === r.accountId).displayName));
    assert.ok(r.name.length <= 40, `"${r.name}" is longer than the 40 characters a name may be`);
  }
  assert.ok(!hasAiTag(prisma._db.airlines.find((a) => a.accountId === 'human').name));
});
await t('a player cannot wear it: bracketed AI look-alikes are refused in airline names', async () => {
  for (const fake of ['Fake Air (AI)', 'Fake Air [ai]', 'Fake {A.I}', 'Fake <A I>', '(A1) Fake', 'Fake ( a-i )']) {
    assert.ok(OG_NAME_PATTERN.test(fake), `"${fake}" would be accepted as a player's airline name`);
  }
  for (const fine of ['Air India', 'AI Airways', 'Hawaiian (Maui)', 'Thai (THAI)', 'Samurai Air', 'Air (Aid)']) {
    assert.ok(!OG_NAME_PATTERN.test(fine), `"${fine}" is refused, and should not be`);
  }
  await assert.rejects(() => joinWorld(fakePrisma({ worlds: [world] }), { account: { id: 'me' }, world, airlineName: 'Totally Real (AI)', hub: 'LHR' }), /reserved/);
});
await t('every rival sees the flag as well as the name', async () => {
  const joined = prisma._db.airlines.map((a) => ({ ...a, account: prisma._db.accounts.find((x) => x.id === a.accountId), state: joinReport(a.state, a.report) }));
  const views = await buildWorldRivalViews(prisma, world.id, { airlines: joined, world });
  const human = joined.find((a) => a.accountId === 'human');
  const rivals = views.get(human.id).competitors ?? [];
  assert.equal(rivals.length, AI_PRESETS.light.airlines);
  for (const c of rivals) { assert.equal(c.ai, true, `${c.name} reached a player's screen without the ai flag`); assert.ok(hasAiTag(c.name)); }
  const seenByAi = views.get(joined.find((a) => a.accountId !== 'human').id).competitors ?? [];
  assert.equal(seenByAi.find((c) => c.name === 'Player Air')?.ai, false, 'a player was flagged as an AI airline');
});
await t('the lobby counts people: AI airlines are reported beside the seats, not in them', async () => {
  const counts = await aiCountsFor(prisma, [world]);
  assert.equal(counts.get(world.id), AI_PRESETS.light.airlines);
  const card = serializeWorld(world, { playerCount: prisma._db.airlines.length, aiCount: counts.get(world.id) });
  assert.equal(card.playerCount, 1); assert.equal(card.aiAirlineCount, AI_PRESETS.light.airlines);
  const plain = fakePrisma();
  assert.equal((await aiCountsFor(plain, [baseWorld({ tickConfig: {} })])).size, 0);
  assert.equal(plain._db.calls, 0, 'a world without AI airlines cost a query to count them');
  assert.equal(serializeWorld(baseWorld({ tickConfig: {} }), { playerCount: 7 }).playerCount, 7);
});

await t('the lobby says so: a world tag, the count beside the seats, and an admin-only switch on the create form', () => {
  const app = readFileSync(new URL('../apps/headwinds-web/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /key: 'ai',\s*on: \(w\) => w\.aiAirlines != null/, 'the world feature tags have no AI airlines entry');
  assert.match(app, /\.\.\.\(admin && aiAirlines !== 'off' \? \{ aiAirlines \} : \{\}\)/, 'the create form must send aiAirlines only for an admin who chose it');
  assert.match(app, /\{admin && \(\s*<label[^>]*>AI airlines/, 'the AI airlines control must be inside an admin-only block');
  assert.ok(app.includes('w.aiAirlineCount > 0') && app.includes('world.aiAirlineCount > 0'), 'the seat counts do not mention the AI airlines beside them');
});
await t('nobody can message an AI airline: the route refuses, and it checks the account, not just the name', () => {
  const src = readFileSync(new URL('../apps/headwinds-server/src/routes/messages.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(hasAiTag\(target\.name\)\) \{[\s\S]{0,260}isAiAccount\(owner\)\) throw httpError\(400/, 'POST /worlds/:id/messages no longer refuses an AI airline');
});

console.log('\ntheir turn');
const first = await runAiTurns(prisma, world, deps);
await t('every AI airline moves in week 1, in one version-guarded write each', () => {
  assert.equal(first.airlines, AI_PRESETS.light.airlines); assert.equal(first.committed, first.airlines); assert.equal(first.dropped, 0);
  for (const r of aiRows()) {
    assert.equal(r.version, 1, `${r.name} was written ${r.version} times in one turn`);
    assert.equal((r.state.pendingOrders ?? []).length + (r.state.fleet ?? []).length, 1, `${r.name} did not lease its first aircraft`);
    assert.ok(r.state.aiMemory?.started, 'the bot\'s memory was not saved with the airline');
  }
  assert.equal(prisma._db.airlines.find((a) => a.accountId === 'human').version, 0, 'a player\'s airline was written by the AI turn');
});
await t('what is saved is a clean save: no rival view, no report inside the blob', () => {
  // Everything withRivals lays over a save for the reducer (humanRivals.stripRivals takes it off again), and the
  // weekly report, which lives in its own column.
  const overlay = ['competitors', 'humanRivals', 'encroachments', 'allianceMembership', 'allianceDef', 'accountOG', 'accountDev', 'accountSupporter',
    'gateMarket', 'worldMarket', 'stockPool', 'allianceSlotPool', 'laborMarket', 'selfStanding', 'lineBook', 'marketDev', 'lastReport'];
  for (const r of aiRows()) for (const k of overlay) assert.ok(!(k in r.state), `${k} was written into ${r.name}'s save`);
});
await t('its decisions are journalled like a player\'s, and every one is on the players\' allow-list', () => {
  const ids = new Set(aiRows().map((r) => r.id));
  assert.ok(prisma._db.decisions.length > 0);
  for (const d of prisma._db.decisions) {
    assert.ok(ids.has(d.airlineId)); assert.equal(d.worldId, world.id); assert.equal(d.week, 1);
    assert.ok(ALLOWED_PLAYER_ACTIONS.has(d.type), `${d.type} is not an action a player can take`);
    assert.ok(d.payload && typeof d.payload === 'object');
  }
  for (const id of ids) assert.ok(prisma._db.decisions.some((d) => d.airlineId === id && d.type === 'ORDER_AIRCRAFT'), 'an order was not journalled');
});
for (let w = 0; w < 7; w++) { await miniTick(prisma, world); await runAiTurns(prisma, world, deps); }
await t('over the next weeks they open routes, and the memory survives the tick', () => {
  for (const r of aiRows()) {
    assert.ok((r.state.routes ?? []).length >= 1, `${r.name} at ${r.hub} has no routes after eight weeks`);
    assert.ok(r.state.aiMemory && Object.keys(r.state.aiMemory.promised ?? {}).length >= 1, 'the bot forgot what it promised itself');
  }
  assert.ok(prisma._db.decisions.some((d) => d.type === 'ADD_ROUTE') && prisma._db.decisions.some((d) => d.type === 'ADD_GATE'));
  for (const d of prisma._db.decisions) assert.ok(ALLOWED_PLAYER_ACTIONS.has(d.type), `${d.type} is not an action a player can take`);
});
await t('the world\'s gate ledger agrees with every AI airline\'s own gates', () => {
  for (const r of aiRows()) for (const [code, count] of Object.entries(r.state.gates ?? {})) {
    const ledger = prisma._db.gates.find((g) => g.airportCode === code);
    assert.equal(ledger?.holdings?.[r.id]?.count ?? 0, count, `${r.name} holds ${count} gate(s) at ${code}; the ledger says ${ledger?.holdings?.[r.id]?.count ?? 0}`);
  }
  for (const g of prisma._db.gates) assert.equal(g.taken, Object.values(g.holdings).reduce((s, h) => s + (h.count ?? 0), 0), `${g.airportCode}: taken does not match its holdings`);
});
await t('a turn that loses its version check is dropped whole; the others still move', async () => {
  // Make sure every AI airline has something to save this week (its standing
  // orders are due again), then let one be written under its turn.
  for (const r of aiRows()) r.state = { ...r.state, aiMemory: { ...r.state.aiMemory, started: false } };
  const [victim, ...others] = aiRows();
  const journalled = prisma._db.decisions.filter((d) => d.airlineId === victim.id).length;
  const before = JSON.stringify(victim.state);
  prisma._db.bumpAfterRead = victim.id;
  const res = await runAiTurns(prisma, world, deps);
  assert.equal(res.dropped, 1, `expected exactly the one airline to be dropped: ${JSON.stringify(res)}`);
  assert.equal(res.committed, others.length);
  assert.equal(JSON.stringify(victim.state), before, 'a turn computed on a stale read was written over the newer airline');
  assert.equal(prisma._db.decisions.filter((d) => d.airlineId === victim.id).length, journalled, 'decisions were journalled for a turn that did not land');
});

console.log('\nthe same checks a player\'s action meets');
await t('an action a player cannot take, the bot cannot take', () => {
  const st = aiRows()[0].state;
  assert.throws(() => playerChecks(world, st, 'LEASE_AIRCRAFT', { typeId: 'b737800' }), /not allowed/);
  assert.throws(() => playerChecks(world, st, 'TOTALLY_MADE_UP', {}), /not allowed/);
  assert.throws(() => playerChecks({ ...world, status: 'ENDED' }, st, 'ADD_GATE', { airportCode: 'LHR' }), /ENDED/);
  assert.throws(() => playerChecks(world, st, 'ADD_ROUTE', { origin: st.hub, destination: st.hub, aircraftId: 'nope', weeklyFrequency: 7 }));
  assert.deepEqual(playerChecks(world, st, 'SET_LEASE_AUTO_RENEW', { enabled: true, addWeeks: 104 }), { enabled: true, addWeeks: 104 });
});
await t('TRIPWIRE: the decisions route runs no refusal that playerChecks does not', () => {
  // The bot commits its week in one write instead of going through the route
  // once per action, so the route's checks are called from two places. If a
  // new one is added to the route, add it to playerChecks() and to this list.
  const src = readFileSync(new URL('../apps/headwinds-server/src/routes/decisions.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  const from = src.indexOf("fastify.post('/worlds/:id/decisions'"); const to = src.indexOf('gameReducer(injected, action)', from);
  assert.ok(from > 0 && to > from, 'could not find the decisions handler — has it moved?');
  const called = new Set([...src.slice(from, to).matchAll(/\b([A-Za-z]*(?:Denial|DenialFor|BlockReasonFor|Clash)|guardDecision|assertFinitePayload)\(/g)].map((m) => m[1]));
  const mirrored = ['decisionDenialFor', 'guardDecision', 'eventActionDenial', 'routeBlockReasonFor', 'eraBlockReasonFor', 'gateLeaseDenial', 'leaseDenial'];
  const notForBots = ['brandingClash', 'assertFinitePayload'];   // SET_BRANDING only; a JSON-body check the bot's own objects cannot fail
  const lib = readFileSync(new URL('../apps/headwinds-server/src/lib/aiAirlines.mjs', import.meta.url), 'utf8');
  for (const name of mirrored) { assert.ok(called.has(name), `${name} is no longer called by the route — remove it from playerChecks too?`); assert.ok(lib.includes(`${name}(`), `playerChecks no longer calls ${name}`); }
  const unknown = [...called].filter((c) => !mirrored.includes(c) && !notForBots.includes(c));
  assert.deepEqual(unknown, [], `the decisions route gained a check the AI airlines do not run: ${unknown.join(', ')}`);
});

console.log('\ntrophies, podiums and the hall of fame are for players');
await t('an AI airline is taken out of the ranking the awards are made from', () => {
  const airlines = prisma._db.airlines.map((a) => ({ ...a, account: prisma._db.accounts.find((x) => x.id === a.accountId) }));
  const human = airlines.find((a) => a.accountId === 'human'); const ai = airlines.filter((a) => a.id !== human.id);
  const ranked = [{ airlineId: ai[0].id }, { airlineId: human.id }, { airlineId: ai[1].id }];
  assert.deepEqual(humansOnly(ranked, airlines), [{ airlineId: human.id }]);
  const plain = [{ airlineId: 'a' }, { airlineId: 'b' }];
  assert.equal(humansOnly(plain, [{ id: 'a', account: { email: 'x@example.com' } }, { id: 'b', account: { email: 'y@example.com' } }]), plain, 'a world with no AI airlines must get its own ranking back untouched');
});
await t('an AI airline cannot be handed a trophy', async () => {
  const ai = prisma._db.accounts.find((a) => isAiAccount(a));
  await assert.rejects(() => awardTrophy(prisma, { trophyId: 'cup', accountId: ai.id }), /AI airline/);
  await awardTrophy(prisma, { trophyId: 'cup', accountId: 'human' });
  assert.equal(prisma._db.awards.length, 1);
});

await t('TRIPWIRE: the tick makes its hall of fame and its awards from the humans-only ranking', () => {
  const src = readFileSync(new URL('../apps/headwinds-server/src/lib/tickService.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/ranked: humansOnly\(outcome\.ranked \?\? \[\], airlines\)/g) ?? []).length, 2, 'snapshotWorldCareers and computeSeasonAwards must both be given humansOnly(...)');
  assert.ok(!/ranked: outcome\.ranked/.test(src), 'something in the tick is handed the full ranking for an award');
});

console.log('\nthe worker');
await t('gives a world\'s AI airlines their turn before its tick, and only in a world that has them', async () => {
  const order = [];
  const ai = baseWorld({ id: 'w-ai', startedAt: new Date(Date.now() - 3 * 3600_000) });
  const plain = baseWorld({ id: 'w-plain', startedAt: new Date(Date.now() - 3 * 3600_000), tickConfig: {} });
  const p3 = fakePrisma({ worlds: [ai, plain] });
  const tickOne = async (pr, w) => { order.push(`tick ${w.id} with ${pr._db.airlines.filter((a) => a.worldId === w.id).length} airline(s)`); return { ok: false }; };
  await runDueTicks(p3, { log: quiet, tickOne, maxCatchUp: 1 });
  assert.ok(order.includes(`tick w-ai with ${AI_PRESETS.light.airlines} airline(s)`), `the AI airlines were not there when their world ticked: ${order.join('; ')}`);
  assert.ok(order.includes('tick w-plain with 0 airline(s)'));
  assert.ok(p3._db.airlines.every((a) => a.worldId === 'w-ai' && a.version === 1), 'the AI airlines had not taken their turn before the tick');
});
await t('a failure in the AI turn never stops the week', async () => {
  const ai = baseWorld({ id: 'w-ai', startedAt: new Date(Date.now() - 3 * 3600_000) });
  const p4 = fakePrisma({ worlds: [ai] });
  p4.airline.findMany = async () => { throw new Error('database fell over'); };
  let ticked = 0;
  await runDueTicks(p4, { log: quiet, tickOne: async () => { ticked++; return { ok: false }; }, maxCatchUp: 1 });
  assert.equal(ticked, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
