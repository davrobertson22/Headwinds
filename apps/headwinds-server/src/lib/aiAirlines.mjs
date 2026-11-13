// AI airlines — the server side of claude/background-competitors-plan.md, phase 3.
//
// A world created with `aiAirlines: 'light'` gets airlines run by the engine's
// bot (packages/engine/src/models/airlineBot.js). Each is an ORDINARY Airline
// row: the tick, the rival views, standings, gates and delivery slots treat it
// exactly as they treat a player's. This file is the three things that are new:
//
//   1. who they are     an Account per AI airline, recognised by its sign-in id
//                       (AI_AUTH_PREFIX). No schema change: there is no login
//                       behind it, and no column to migrate.
//   2. founding them    ensureAiAirlines(), once, in the world's first week.
//   3. their turn       runAiTurns(), before each weekly tick: the bot decides,
//                       and its decisions are checked and committed the way a
//                       player's are.
//
// A WORLD WITHOUT THE OPTION NEVER REACHES ANY OF THIS: aiPresetOf() is null and
// every entry point returns before its first query. Existing worlds are
// untouched (Dave, 2026-11-10).
//
// THE BOT GETS NO PATH A PLAYER DOES NOT HAVE. playerChecks() below is the same
// list of refusals, in the same order, that POST /worlds/:id/decisions runs
// before the reducer (routes/decisions.mjs) — the action allow-list, the world
// lifecycle, the guard, event rules, route blocks, gate scarcity, lease rules —
// and the commit calls the same ledger functions inside its transaction
// (applyGateDecisionTx, assertLineSlotsTx). It is a second caller of those
// pieces, not a copy of them. What it deliberately does differently:
//
//   • ONE write a week per airline, not one per action. A player's click is one
//     decision; a bot's turn is a dozen, and a dozen megabyte-blob writes per
//     airline per week is the load that has taken Postgres down before. If any
//     ledger refuses (the last gate went, the delivery slot was taken) the whole
//     turn is dropped and the airline tries again next week with fresh eyes.
//   • No rate limit, no reply, no trading or branding branches: the bot issues
//     none of those actions (airlineBot.js lists every one it can).
//
// When a refusal is added to the decisions route, add it to playerChecks().
// tools/ai-airlines-server-test.mjs pins the ones that exist today.

import { Prisma } from '@prisma/client';
import { gameReducer, gateLeaseDenial, leaseDenial, addRouteBlockReason } from '@tailwinds/engine/reducer';
import { runBotTurn, newBotMemory, startProspect } from '@tailwinds/engine/models/airlineBot.js';
import { COMPETITOR_AIRLINES } from '@tailwinds/engine/models/demand.js';
import { AIRPORTS } from '@tailwinds/engine/data/airports.js';
import { eventActionDenial, eventHubDenial } from '@tailwinds/engine/data/eventRules.js';
import { lineOrdersOf } from '@tailwinds/engine/data/productionLines.js';
import { svpsScore } from '@tailwinds/engine/utils/market.js';
import { ALLOWED_PLAYER_ACTIONS } from '../world.mjs';
import { decisionDenialFor, eventRulesOfWorld } from './worldConfig.mjs';
import { guardDecision } from './decisionGuard.mjs';
import { routeBlockReasonFor } from './routeBlocks.mjs';
import { eraBlockReasonFor } from './eraBlocks.mjs';
import { journalledPayload, withFleetFacts } from './publicDecisions.mjs';
import { buildWorldRivalViews, withRivals, stripRivals, loadAllianceMap } from './humanRivals.mjs';
import { isGateScarcity, applyGateDecisionTx } from './gateService.mjs';
import { newLineOrdersOf, assertLineSlotsTx } from './productionLineService.mjs';
import { splitLogo } from './logoColumn.mjs';
import { joinReport, reportWriteFor } from './reportColumn.mjs';
import { withTx } from './tx.mjs';

// ── Who they are ──────────────────────────────────────────────────────────────

/** An AI airline's account signs in as nobody: its auth id starts with this, and no auth provider issues such an id. */
export const AI_AUTH_PREFIX = 'ai:';
/** …and its address is on a domain that cannot receive mail (RFC 2606 `.invalid`), in case anything ever mails every account. */
export const AI_EMAIL_DOMAIN = 'ai.headwinds.invalid';

/**
 * THE TAG. Every AI airline's name ends with this, in the name itself — not a
 * badge drawn beside it. A badge has to be remembered by every screen that
 * shows a name (standings, maps, route competitor lists, the news, alliance
 * and gate lists, public pages, share cards, and whatever is built next); a
 * name is shown by all of them already. Players cannot wear it: bracketed
 * "AI" look-alikes are refused in airline names at join, restart and rename
 * (worldService.OG_NAME_PATTERN), exactly as OG, DEV and SUPPORTER are.
 */
export const AI_NAME_TAG = ' (AI)';
/** `Global Air` → `Global Air (AI)`. */
export const aiNameOf = (base) => `${String(base).trim()}${AI_NAME_TAG}`;
/** Does this airline or account name carry the tag? (A cheap first look; isAiAccount is the proof.) */
export const hasAiTag = (name) => typeof name === 'string' && name.endsWith(AI_NAME_TAG);

/** Is this account an AI airline's? Works on any row that selected `authUserId` or `email`. */
export function isAiAccount(account) {
  if (typeof account?.authUserId === 'string') return account.authUserId.startsWith(AI_AUTH_PREFIX);
  return typeof account?.email === 'string' && account.email.endsWith(`@${AI_EMAIL_DOMAIN}`);
}
/** Prisma filter for the same thing — `account: AI_ACCOUNT_WHERE`, or `account: { NOT: AI_ACCOUNT_WHERE }` for humans. */
export const AI_ACCOUNT_WHERE = { authUserId: { startsWith: AI_AUTH_PREFIX } };

/**
 * What each setting founds. Only `light` exists: the bot has one tier so far
 * (cautious), and Standard and Fierce are promises about tiers not built yet.
 * `maxFleet` bounds an AI airline's save, its share of the rival data every
 * player downloads, and the bot's thinking time (plan §9.8).
 */
export const AI_PRESETS = {
  light: { airlines: 8, tier: 'cautious', params: { maxFleet: 100 } },
};
export const AI_SETTINGS = Object.keys(AI_PRESETS);

/** The world's AI preset, or null — null for every world created without the option. */
export function aiPresetOf(worldOrTickConfig) {
  const tc = worldOrTickConfig?.tickConfig ?? worldOrTickConfig;
  const key = tc?.aiAirlines;
  return typeof key === 'string' && Object.hasOwn(AI_PRESETS, key) ? { key, ...AI_PRESETS[key] } : null;
}

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const absWeekOf = (world) => (world.currentYear - 1) * 52 + world.currentWeek;
const toBig = (v) => { const n = Math.round(Number(v)); return BigInt(Number.isFinite(n) ? n : 0); };

/**
 * The account an AI airline of this (untagged) name plays through — the same
 * one in every world. Its display name carries the tag too, and it accepts
 * direct messages from nobody: there is no one to read them.
 */
export async function aiAccountFor(prisma, name) {
  const authUserId = `${AI_AUTH_PREFIX}${slug(name)}`;
  return prisma.account.upsert({
    where: { authUserId },
    update: {},
    create: { authUserId, email: `${slug(name)}@${AI_EMAIL_DOMAIN}`, displayName: aiNameOf(name), dmPolicy: 'NOBODY' },
  });
}

/**
 * How many AI airlines are flying in each of these worlds — for the lobby,
 * which counts PEOPLE against a world's seats. Asks nothing unless one of the
 * worlds has the option.
 * @returns {Map<string, number>} worldId → AI airlines (absent = none)
 */
export async function aiCountsFor(prisma, worlds) {
  const ids = (worlds ?? []).filter((w) => aiPresetOf(w)).map((w) => w.id);
  if (ids.length === 0) return new Map();
  const rows = await prisma.airline.groupBy({
    by: ['worldId'], where: { worldId: { in: ids }, status: 'ACTIVE', account: AI_ACCOUNT_WHERE }, _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.worldId, r._count?._all ?? 0]));
}

// ── Founding ──────────────────────────────────────────────────────────────────

/**
 * Hubs for `n` new AI airlines: the big airports nobody is based at yet, ranked
 * by the bot's own forecast of a start there (startProspect), one per country.
 * A weak hub is the one thing the lab found no rule could save an airline from
 * (plan §9.13), so the choice is made on prospects, not on airport size.
 * Deterministic for a world: same world, same hubs.
 */
export function pickAiHubs(world, n, { taken = new Set(), seedState, preset } = {}) {
  const rules = eventRulesOfWorld(world?.tickConfig);
  const open = AIRPORTS
    .filter((ap) => (ap.tier === 'mega' || ap.tier === 'major') && !taken.has(ap.code)
      && !(rules && eventHubDenial(rules, ap.code, { founding: true })))
    .sort((x, y) => (y.tier === 'mega') - (x.tier === 'mega') || y.population - x.population || (x.code < y.code ? -1 : 1))
    .slice(0, n * 3);
  const scored = [];
  for (const ap of open) {
    let prospect = null;
    try {
      prospect = startProspect(seedState(world, { airlineName: 'AI', hub: ap.code }),
        { canLease: (s, id) => !leaseDenial(s, id, 1), tier: preset.tier, params: preset.params });
    } catch { prospect = null; }
    if (prospect && prospect.weekly > 0) scored.push({ code: ap.code, country: ap.country, weekly: prospect.weekly });
  }
  scored.sort((x, y) => y.weekly - x.weekly || (x.code < y.code ? -1 : 1));
  const picks = []; const countries = new Set();
  for (const s of scored) { if (picks.length >= n) break; if (countries.has(s.country)) continue; countries.add(s.country); picks.push(s.code); }
  for (const s of scored) { if (picks.length >= n) break; if (!picks.includes(s.code)) picks.push(s.code); }   // fewer countries than airlines
  return picks;
}

/**
 * Found the world's AI airlines if it has the option and has not got them yet.
 * They start with the world (week 1) or not at all: an airline that joins late
 * is as small as a late human and competes with nobody.
 *
 * @param {object} deps  seedAirlineState and createAirlineRow from worldService.mjs — passed in, because
 *                       worldService is also what a player's join goes through and must not depend on this file.
 * @returns {{ founded: number }}
 */
export async function ensureAiAirlines(prisma, world, { seedAirlineState, createAirlineRow, log = console } = {}) {
  const preset = aiPresetOf(world);
  if (!preset || world.status !== 'RUNNING' || absWeekOf(world) > 1) return { founded: 0 };
  const rows = await prisma.airline.findMany({
    where: { worldId: world.id },
    select: { id: true, hub: true, name: true, account: { select: { authUserId: true, email: true } } },
  });
  const missing = preset.airlines - rows.filter((r) => isAiAccount(r.account)).length;
  if (missing <= 0) return { founded: 0 };

  const hubs = pickAiHubs(world, missing, { taken: new Set(rows.map((r) => r.hub)), seedState: seedAirlineState, preset });
  const usedNames = new Set(rows.map((r) => String(r.name).toLowerCase()));
  const names = COMPETITOR_AIRLINES.map((c) => c.name);
  const taken = (base) => usedNames.has(base.toLowerCase()) || usedNames.has(aiNameOf(base).toLowerCase());
  let at = hash(world.worldSeed ?? world.id) % names.length;
  let founded = 0;
  for (const hub of hubs) {
    let name = null;
    for (let tries = 0; tries < names.length && !name; tries++, at = (at + 1) % names.length) {
      if (!taken(names[at])) name = names[at];
    }
    if (!name) break;
    usedNames.add(name.toLowerCase());
    try {
      const account = await aiAccountFor(prisma, name);
      await createAirlineRow(prisma, { world, accountId: account.id, airlineName: aiNameOf(name), hub });
      founded++;
    } catch (err) {
      if (err?.code !== 'P2002') log.warn?.(`[ai] world ${world.id}: could not found ${name} at ${hub}: ${err?.message ?? err}`);
    }
  }
  if (founded > 0) log.info?.(`[ai] ${world.name} (${world.id}): founded ${founded} AI airline(s) at ${hubs.slice(0, founded).join(', ')}`);
  return { founded };
}

// ── Their turn ────────────────────────────────────────────────────────────────

/**
 * Every refusal POST /worlds/:id/decisions runs before the reducer, in its
 * order, for the actions a bot can issue. Throws the route's own sentence.
 * @returns {object} the guarded payload
 */
export function playerChecks(world, state, type, payload) {
  if (!ALLOWED_PLAYER_ACTIONS.has(type)) throw new Error(`Action not allowed: ${type}`);
  const denial = decisionDenialFor(world, type);
  if (denial) throw new Error(denial);
  const guarded = guardDecision(type, payload, state) ?? payload;
  if (state.eventRules) {
    const why = eventActionDenial(state, { type, ...guarded });
    if (why) throw new Error(why);
  }
  const blocked = routeBlockReasonFor(type, state, { type, ...guarded });
  if (blocked) throw new Error(blocked);
  const tooEarly = eraBlockReasonFor(type, state);
  if (tooEarly) throw new Error(tooEarly);
  if (isGateScarcity(world) && type === 'ADD_GATE') {
    const full = gateLeaseDenial(state, guarded.airportCode);
    if (full) throw new Error(full);
  }
  if ((world?.tickConfig?.newWorldRestrictions === true || Number.isInteger(world?.tickConfig?.startYear))
      && (type === 'ORDER_AIRCRAFT' || type === 'BUY_AIRCRAFT') && guarded.ownershipType === 'lease') {
    const lease = leaseDenial(state, guarded.typeId, guarded.quantity ?? 1);
    if (lease && lease.code !== 'order_book_partial') throw new Error(lease.message);
  }
  return guarded;
}

class AiTurnConflict extends Error {
  constructor() { super('the airline changed under the turn (version conflict)'); this.name = 'AiTurnConflict'; }
}

/**
 * One AI airline's week: decide in memory, commit once.
 * @returns {'idle'|'committed'}  throws when the commit is refused (the turn is dropped)
 */
async function takeTurn(prisma, world, row, view, { preset, scarcity, eventRules, allianceMap }) {
  const injected = withRivals(joinReport(row.state, row.report), view);
  if (eventRules) injected.eventRules = eventRules;
  const readReport = injected.lastReport;
  const memory = injected.aiMemory ?? newBotMemory();

  const steps = new Map();      // the action object → what the reducer did with it
  const turn = runBotTurn(injected, memory, {
    tier: preset.tier,
    params: preset.params,
    canLease: (s, id) => !leaseDenial(s, id, 1),
    explain: addRouteBlockReason,
    apply: (state, action) => {
      const { type, ...payload } = action;
      const guarded = playerChecks(world, state, type, payload);
      const next = gameReducer(state, { type, ...guarded });
      if (next !== state) steps.set(action, { type, guarded, before: state, after: next });
      return next;
    },
  });

  const sameMemory = JSON.stringify(turn.memory) === JSON.stringify(injected.aiMemory ?? null);
  if (steps.size === 0 && sameMemory) return 'idle';

  const next = { ...turn.state, aiMemory: turn.memory };
  const week = absWeekOf(world);
  const journal = [];
  for (const action of turn.actions) {
    const s = steps.get(action); if (!s) continue;
    // A closed route is journalled with its city pair, as the route does: the id means nothing once it is gone.
    let journalled = s.guarded;
    if (s.type === 'CLOSE_ROUTE') {
      const gone = (s.before.routes ?? []).find((r) => r.id === s.guarded.routeId);
      if (gone) journalled = { ...journalled, origin: gone.origin, destination: gone.destination };
    }
    const facts = withFleetFacts(s.type, journalled, s.before, s.after);
    journal.push({ worldId: world.id, airlineId: row.id, week, type: s.type, payload: journalledPayload(facts.journalled, { changed: facts.moved }) });
  }

  await withTx(prisma, async (tx) => {
    // Shared ledgers first, each exactly as a player's click reaches it. Either may throw: nothing is written.
    for (const s of steps.values()) {
      if (scarcity && (s.type === 'ADD_GATE' || s.type === 'REMOVE_GATE')) {
        const code = s.guarded.airportCode;
        if (((s.after.gates?.[code] ?? 0) - (s.before.gates?.[code] ?? 0)) !== 0) {
          await applyGateDecisionTx(tx, { worldId: world.id, airportCode: code, type: s.type, airline: row, allianceMap });
        }
      }
      if (s.type === 'ORDER_AIRCRAFT' && s.before.productionLinesWorld === true) {
        const newOrders = newLineOrdersOf(s.before.pendingOrders, s.after.pendingOrders);
        if (newOrders.length > 0) {
          await assertLineSlotsTx(tx, {
            worldId: world.id, airlineId: row.id, pendingOrders: lineOrdersOf(s.after), newOrders,
            scale: s.before.productionLineScale ?? 1, rates: s.before.productionLineRates ?? null,
            absWeek: (s.after.year - 1) * 52 + s.after.week,
          });
        }
      }
    }
    const { state: blob } = splitLogo(stripRivals(next));
    const { state: persistedState, writeReport, report } = reportWriteFor(row, readReport, blob);
    const updated = await tx.airline.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        state: persistedState,
        ...(writeReport ? { report: report ?? Prisma.DbNull } : {}),
        cash: toBig(next.cash),
        marketCap: toBig(next.marketCap),
        ...(Number.isFinite(next.svps) ? { svps: BigInt(svpsScore(next.svps)) } : {}),
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) throw new AiTurnConflict();
    if (journal.length > 0) await tx.decision.createMany({ data: journal });
  });
  return 'committed';
}

/**
 * Give every AI airline in the world its turn for the week about to be ticked.
 * One airline's failure never stops the others, and nothing here can stop the
 * tick: the caller catches whatever escapes.
 * @returns {{ airlines: number, committed: number, dropped: number, ms: number }}
 */
export async function runAiTurns(prisma, world, { log = console } = {}) {
  const preset = aiPresetOf(world);
  const none = { airlines: 0, committed: 0, dropped: 0, ms: 0 };
  if (!preset || world.status !== 'RUNNING') return none;
  const started = Date.now();
  // The same read the tick is about to make (tickService.loadTickAirlines), raw:
  // the commit below needs each row as stored, the way a decision reads it.
  const rows = await prisma.airline.findMany({
    where: { worldId: world.id, status: 'ACTIVE' },
    include: { account: { select: { isOG: true, isSupporter: true, email: true } } },
  });
  const bots = rows.filter((a) => isAiAccount(a.account));
  if (bots.length === 0) return none;
  const views = await buildWorldRivalViews(prisma, world.id, { airlines: rows.map((a) => ({ ...a, state: joinReport(a.state, a.report) })), world });
  const scarcity = isGateScarcity(world);
  const ctx = { preset, scarcity, eventRules: eventRulesOfWorld(world.tickConfig), allianceMap: scarcity ? await loadAllianceMap(prisma, world.id) : new Map() };
  let committed = 0; let dropped = 0;
  for (const row of bots) {
    try {
      if (await takeTurn(prisma, world, row, views.get(row.id), ctx) === 'committed') committed++;
    } catch (err) {
      dropped++;
      log.warn?.(`[ai] ${row.name} (${row.id}) in ${world.id}: turn dropped — ${err?.message ?? err}`);
    }
  }
  const ms = Date.now() - started;
  log.info?.(`[ai] ${world.name} (${world.id}): ${bots.length} AI airline(s), ${committed} moved, ${dropped} dropped, ${ms}ms`);
  return { airlines: bots.length, committed, dropped, ms };
}

/** Found them if the world has just started, then give each its turn. The worker calls this before a world's tick. */
export async function runAiWeek(prisma, world, deps = {}) {
  if (!aiPresetOf(world)) return null;
  await ensureAiAirlines(prisma, world, deps);
  return runAiTurns(prisma, world, deps);
}

/** A ranking with the AI airlines taken out — for the podium, the champion and the awards, which go to humans only. */
export function humansOnly(ranked, airlines) {
  const ai = new Set((airlines ?? []).filter((a) => isAiAccount(a.account)).map((a) => a.id));
  return ai.size === 0 ? ranked : (ranked ?? []).filter((r) => !ai.has(r.airlineId));
}
