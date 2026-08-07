// Codeshares become a deal instead of a helping.
//
// B9. `SIGN_CODESHARE` was on the multiplayer allow-list. It created an
//     agreement against a human rival's view with no consent and no
//     notification: you paid a weekly fee and collected interline revenue
//     computed off a REAL PLAYER'S network, while they neither knew the deal
//     existed nor saw a cent of it. The game's only bilateral "deal" verb was
//     the one thing in it that was not bilateral.
//
//     It is now offer → accept, server-governed like alliance membership, with
//     both airlines' state blobs written in one transaction. Cancelling tears
//     down both sides too: ending only your own half would leave the other
//     player paying a fee for a partner who no longer carries their passengers.
//
//   node tools/codeshare-test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gameReducer } from '../packages/engine/src/reducer.mjs';
import { MAX_CODESHARE_AGREEMENTS, CODESHARE_WEEKLY_FEE_BY_TIER } from '../packages/engine/src/data/alliances.js';
import {
  CodeshareError, CODESHARE_OFFER_EXPIRY_WEEKS,
  alreadyPartnered, offerCodeshare, resolveOffer, acceptOffer, cancelCodeshare,
  buildOfferView, expireStaleOffers,
} from '../apps/headwinds-server/src/lib/codeshareService.mjs';
import { ALLOWED_PLAYER_ACTIONS } from '../apps/headwinds-server/src/world.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
async function rejects(fn, re, message) {
  try { await fn(); }
  catch (e) {
    if (re && !re.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    return e;
  }
  throw new Error(message ?? 'expected a refusal');
}

// ── The reducer half ────────────────────────────────────────────────────────

console.log('\n── Signing against a stored blob ────────────────────────');

const blank = (over = {}) => ({ week: 10, year: 1, codeshareAgreements: [], competitors: [], ...over });

test('the client path is untouched — a known competitor still signs', () => {
  const state = blank({ competitors: [{ id: 'r1', name: 'Rival', tier: 'budget' }] });
  const next = gameReducer(state, { type: 'SIGN_CODESHARE', competitorId: 'r1' });
  assert.equal(next.codeshareAgreements.length, 1);
  assert.equal(next.codeshareAgreements[0].competitorName, 'Rival');
  assert.equal(next.codeshareAgreements[0].weeklyFee, CODESHARE_WEEKLY_FEE_BY_TIER.budget);
});

test('a stored blob has no competitors, so the server must name the partner', () => {
  // THE mechanism that makes acceptance possible. `state.competitors` is
  // rebuilt on every read and stripped before persistence, so dispatching
  // against a raw stored blob finds nobody — the acceptor's side would have
  // silently no-opped while the offerer paid.
  const stored = blank();
  const blind = gameReducer(stored, { type: 'SIGN_CODESHARE', competitorId: 'r1' });
  assert.equal(blind, stored, 'without a partner it must decline, not invent one');

  const told = gameReducer(stored, {
    type: 'SIGN_CODESHARE', competitorId: 'r1',
    partner: { id: 'r1', name: 'Rival', tier: 'legacy' },
  });
  assert.equal(told.codeshareAgreements.length, 1);
  assert.equal(told.codeshareAgreements[0].competitorId, 'r1');
});

test('a partner that does not match the id is not accepted', () => {
  const stored = blank();
  const next = gameReducer(stored, {
    type: 'SIGN_CODESHARE', competitorId: 'r1',
    partner: { id: 'someone-else', name: 'Wrong', tier: 'legacy' },
  });
  assert.equal(next, stored);
});

test('the cap and duplicates are still refused', () => {
  const full = blank({
    codeshareAgreements: Array.from({ length: MAX_CODESHARE_AGREEMENTS },
      (_, i) => ({ id: `a${i}`, competitorId: `c${i}` })),
  });
  assert.equal(gameReducer(full, {
    type: 'SIGN_CODESHARE', competitorId: 'r1', partner: { id: 'r1', name: 'R', tier: 'legacy' },
  }), full);

  const dup = blank({ codeshareAgreements: [{ id: 'a1', competitorId: 'r1' }] });
  assert.equal(gameReducer(dup, {
    type: 'SIGN_CODESHARE', competitorId: 'r1', partner: { id: 'r1', name: 'R', tier: 'legacy' },
  }), dup);
});

test('cancelling works by partner as well as by agreement id', () => {
  // The server knows who the partner is; it does not know what the OTHER
  // airline's copy of the deal happens to be called.
  const state = blank({ codeshareAgreements: [
    { id: 'mine', competitorId: 'r1' }, { id: 'other', competitorId: 'r2' },
  ] });
  assert.deepEqual(
    gameReducer(state, { type: 'CANCEL_CODESHARE', agreementId: 'mine' })
      .codeshareAgreements.map(a => a.competitorId), ['r2']);
  assert.deepEqual(
    gameReducer(state, { type: 'CANCEL_CODESHARE', competitorId: 'r1' })
      .codeshareAgreements.map(a => a.competitorId), ['r2']);
});

// ── The allow-list ──────────────────────────────────────────────────────────

console.log('\n── No longer a decision one player makes ────────────────');

test('a codeshare decision is refused with a reason, not a shrug', () => {
  // The refusal lives in routes/decisions.mjs, not the allow-list — because the
  // allow-list check runs FIRST, and an unlisted action gets a bare "Action not
  // allowed: SIGN_CODESHARE". Staying listed is what lets the player be told
  // where codeshares actually happen. JOIN_ALLIANCE and ACQUIRE_COMPETITOR are
  // governed exactly the same way, which is why they are still listed too.
  const src = readFileSync(new URL('../apps/headwinds-server/src/routes/decisions.mjs', import.meta.url), 'utf8');
  const guard = /if \(type === 'SIGN_CODESHARE' \|\| type === 'CANCEL_CODESHARE'\) \{\s*throw httpError\(403/;
  assert.match(src, guard, 'no 403 branch for codeshare decisions');
  for (const t of ['SIGN_CODESHARE', 'CANCEL_CODESHARE', 'JOIN_ALLIANCE', 'ACQUIRE_COMPETITOR']) {
    assert.ok(ALLOWED_PLAYER_ACTIONS.has(t), `${t} must stay listed for its own refusal to be reachable`);
  }
  assert.ok(!ALLOWED_PLAYER_ACTIONS.has('NONSENSE_ACTION'), 'sanity: the list still excludes things');
});

// ── The service, against a stand-in database ────────────────────────────────

console.log('\n── Offer and accept ─────────────────────────────────────');

const WORLD = { id: 'w1', currentYear: 1, currentWeek: 20 };

/** Minimal prisma stand-in: airlines, offers, and a transaction that is a pass-through. */
function fakeDb(airlines) {
  const rows = new Map(airlines.map((a) => [a.id, { ...a }]));
  const offers = new Map();
  let seq = 0;
  const key = (o) => `${o.worldId}|${o.fromAirlineId}|${o.toAirlineId}`;
  const api = {
    _rows: rows, _offers: offers,
    // `withTx` calls prisma.$transaction(fn, opts). The stand-in has no
    // isolation to offer, which is fine: what these tests exercise is the
    // compare-and-set logic inside the body, not Postgres.
    $transaction: async (fn) => fn(api),
    airline: {
      findUnique: async ({ where }) => (rows.has(where.id) ? { ...rows.get(where.id) } : null),
      updateMany: async ({ where, data }) => {
        const row = rows.get(where.id);
        if (!row || row.version !== where.version) return { count: 0 };
        rows.set(where.id, { ...row, ...data, version: row.version + 1 });
        return { count: 1 };
      },
      findMany: async ({ where }) => [...rows.values()].filter((r) => where.id.in.includes(r.id)),
    },
    codeshareOffer: {
      findUnique: async ({ where }) => {
        if (where.id) return offers.get(where.id) ?? null;
        const k = where.worldId_fromAirlineId_toAirlineId;
        return [...offers.values()].find((o) => key(o) === key(k)) ?? null;
      },
      findMany: async ({ where }) => [...offers.values()].filter((o) =>
        o.worldId === where.worldId
        && where.OR.some((c) => (c.fromAirlineId && o.fromAirlineId === c.fromAirlineId)
                             || (c.toAirlineId && o.toAirlineId === c.toAirlineId))),
      upsert: async ({ where, create, update }) => {
        const k = where.worldId_fromAirlineId_toAirlineId;
        const existing = [...offers.values()].find((o) => key(o) === key(k));
        if (existing) { Object.assign(existing, update); return existing; }
        const row = { id: `o${++seq}`, createdAt: new Date(), ...create };
        offers.set(row.id, row);
        return row;
      },
      delete: async ({ where }) => { offers.delete(where.id); return {}; },
      deleteMany: async ({ where }) => {
        let n = 0;
        for (const [id, o] of [...offers]) {
          if (o.worldId === where.worldId && o.offeredWeek < where.offeredWeek.lt) { offers.delete(id); n++; }
        }
        return { count: n };
      },
    },
  };
  return api;
}

// `withTx` is imported by the service; the stand-in's transaction is the db.
const airline = (id, name, over = {}) => ({
  id, name, worldId: 'w1', status: 'ACTIVE', version: 1,
  state: { week: 20, year: 1, codeshareAgreements: [], competitors: [] }, ...over,
});

await atest('an offer changes nothing until it is answered', async () => {
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta')]);
  const res = await offerCodeshare(db, {
    world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20,
  });
  assert.ok(res.offer);
  assert.equal(db._offers.size, 1);
  assert.equal(db._rows.get('a1').state.codeshareAgreements.length, 0, 'the offerer signed nothing');
  assert.equal(db._rows.get('a2').state.codeshareAgreements.length, 0, 'and neither did the recipient');
});

await atest('accepting writes BOTH sides', async () => {
  // The whole package in one assertion: before this, only the signer's blob
  // ever changed.
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta')]);
  await offerCodeshare(db, { world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 });
  const offer = [...db._offers.values()][0];
  const res = await acceptOffer(db, { world: WORLD, offer, acceptor: db._rows.get('a2'), weekIndex: 20 });

  const a1 = db._rows.get('a1').state.codeshareAgreements;
  const a2 = db._rows.get('a2').state.codeshareAgreements;
  assert.equal(a1.length, 1, 'the offerer has the agreement');
  assert.equal(a2.length, 1, 'and so does the acceptor');
  assert.equal(a1[0].competitorId, 'a2');
  assert.equal(a2[0].competitorId, 'a1');
  assert.equal(a1[0].weeklyFee, a2[0].weeklyFee, 'both pay the same fee');
  assert.equal(res.partnerName, 'Alpha');
  assert.equal(db._offers.size, 0, 'the offer row is consumed');
});

await atest('two players who both offered are simply partners', async () => {
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta')]);
  await offerCodeshare(db, { world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 });
  const res = await offerCodeshare(db, {
    world: WORLD, from: db._rows.get('a2'), toAirlineId: 'a1', weekIndex: 20,
  });
  assert.equal(res.mutual, true, 'a mirror-image offer is consent, not a second proposal');
  assert.equal(db._rows.get('a1').state.codeshareAgreements.length, 1);
  assert.equal(db._rows.get('a2').state.codeshareAgreements.length, 1);
  assert.equal(db._offers.size, 0);
});

await atest('you cannot offer to yourself, or to a ghost', async () => {
  const db = fakeDb([airline('a1', 'Alpha')]);
  await rejects(() => offerCodeshare(db, {
    world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a1', weekIndex: 20 }), /yourself/i);
  await rejects(() => offerCodeshare(db, {
    world: WORLD, from: db._rows.get('a1'), toAirlineId: 'nope', weekIndex: 20 }), /No such airline/i);
});

await atest('a bankrupt airline is not a counterparty', async () => {
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta', { status: 'BANKRUPT' })]);
  await rejects(() => offerCodeshare(db, {
    world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 }), /bankrupt/i);
});

await atest('a partner at the agreement cap is refused, on both sides', async () => {
  const capped = () => ({
    week: 20, year: 1, competitors: [],
    codeshareAgreements: Array.from({ length: MAX_CODESHARE_AGREEMENTS },
      (_, i) => ({ id: `x${i}`, competitorId: `c${i}` })),
  });
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta', { state: capped() })]);
  await rejects(() => offerCodeshare(db, {
    world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 }), /maximum/i);

  const db2 = fakeDb([airline('a1', 'Alpha', { state: capped() }), airline('a2', 'Beta')]);
  await rejects(() => offerCodeshare(db2, {
    world: WORLD, from: db2._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 }), /maximum/i);
});

await atest('a pair already partnered cannot double up', async () => {
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta')]);
  await offerCodeshare(db, { world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 });
  await acceptOffer(db, {
    world: WORLD, offer: [...db._offers.values()][0], acceptor: db._rows.get('a2'), weekIndex: 20 });
  assert.ok(alreadyPartnered(db._rows.get('a1'), db._rows.get('a2')));
  await rejects(() => offerCodeshare(db, {
    world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 }), /already have a codeshare/i);
});

await atest('a stale version loses rather than half-signing', async () => {
  // Both blobs move together or neither does. Half a bilateral agreement is
  // worse than none: one side pays for a partner that does not know it.
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta')]);
  await offerCodeshare(db, { world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 });
  const offer = [...db._offers.values()][0];
  // Somebody else writes a2 between the read and the commit.
  const realUpdate = db.airline.updateMany;
  let calls = 0;
  db.airline.updateMany = async (args) => (++calls === 2 ? { count: 0 } : realUpdate(args));
  await rejects(() => acceptOffer(db, {
    world: WORLD, offer, acceptor: db._rows.get('a2'), weekIndex: 20 }), /try again/i);
});

// ── Decisions on an offer ───────────────────────────────────────────────────

console.log('\n── Answering ────────────────────────────────────────────');

await atest('only the recipient may accept', async () => {
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta')]);
  await offerCodeshare(db, { world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 });
  const offer = [...db._offers.values()][0];
  await rejects(() => resolveOffer(db, {
    world: WORLD, offerId: offer.id, airlineId: 'a1', decision: 'accept' }), /can accept/i);
  const ok = await resolveOffer(db, {
    world: WORLD, offerId: offer.id, airlineId: 'a2', decision: 'accept' });
  assert.equal(ok.id, offer.id);
});

await atest('a stranger cannot touch somebody else\'s offer', async () => {
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta'), airline('a3', 'Gamma')]);
  await offerCodeshare(db, { world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 });
  const offer = [...db._offers.values()][0];
  await rejects(() => resolveOffer(db, {
    world: WORLD, offerId: offer.id, airlineId: 'a3', decision: 'reject' }), /not yours/i);
});

// ── Cancelling ──────────────────────────────────────────────────────────────

console.log('\n── Cancelling ───────────────────────────────────────────');

await atest('cancelling ends the agreement for both airlines', async () => {
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta')]);
  await offerCodeshare(db, { world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 });
  await acceptOffer(db, {
    world: WORLD, offer: [...db._offers.values()][0], acceptor: db._rows.get('a2'), weekIndex: 20 });

  await cancelCodeshare(db, { world: WORLD, airline: db._rows.get('a1'), partnerId: 'a2' });
  assert.equal(db._rows.get('a1').state.codeshareAgreements.length, 0);
  assert.equal(db._rows.get('a2').state.codeshareAgreements.length, 0,
    'the other player must not be left paying for a partner that stopped flying for them');
});

await atest('a dead partner cannot hold you hostage', async () => {
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta')]);
  await offerCodeshare(db, { world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 });
  await acceptOffer(db, {
    world: WORLD, offer: [...db._offers.values()][0], acceptor: db._rows.get('a2'), weekIndex: 20 });
  // Beta goes bankrupt and its side of the deal is swept by the tick.
  db._rows.get('a2').state = { ...db._rows.get('a2').state, codeshareAgreements: [] };
  await cancelCodeshare(db, { world: WORLD, airline: db._rows.get('a1'), partnerId: 'a2' });
  assert.equal(db._rows.get('a1').state.codeshareAgreements.length, 0);
});

await atest('cancelling a deal you do not have is refused', async () => {
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta')]);
  await rejects(() => cancelCodeshare(db, {
    world: WORLD, airline: db._rows.get('a1'), partnerId: 'a2' }), /no codeshare/i);
});

// ── Views and housekeeping ──────────────────────────────────────────────────

console.log('\n── Offers on screen, and offers swept ───────────────────');

await atest('the view separates what you were asked from what you asked', async () => {
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta'), airline('a3', 'Gamma')]);
  await offerCodeshare(db, { world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 20 });
  await offerCodeshare(db, { world: WORLD, from: db._rows.get('a3'), toAirlineId: 'a1', weekIndex: 18 });
  const view = await buildOfferView(db, { worldId: 'w1', airlineId: 'a1' });
  assert.deepEqual(view.outgoing.map((o) => o.name), ['Beta']);
  assert.deepEqual(view.incoming.map((o) => o.name), ['Gamma']);
  assert.equal(view.incoming[0].expiresWeek, 18 + CODESHARE_OFFER_EXPIRY_WEEKS);
});

await atest('an empty desk is an empty view, not a crash', async () => {
  const db = fakeDb([airline('a1', 'Alpha')]);
  assert.deepEqual(await buildOfferView(db, { worldId: 'w1', airlineId: 'a1' }),
    { incoming: [], outgoing: [] });
});

await atest('unanswered offers lapse', async () => {
  // Not just tidiness: the unique constraint that stops duplicate offers would
  // otherwise let one dead row block a pair from ever offering again.
  const db = fakeDb([airline('a1', 'Alpha'), airline('a2', 'Beta')]);
  await offerCodeshare(db, { world: WORLD, from: db._rows.get('a1'), toAirlineId: 'a2', weekIndex: 5 });
  assert.equal(await expireStaleOffers(db, 'w1', 5 + CODESHARE_OFFER_EXPIRY_WEEKS), 0, 'not yet');
  assert.equal(await expireStaleOffers(db, 'w1', 6 + CODESHARE_OFFER_EXPIRY_WEEKS), 1);
  assert.equal(db._offers.size, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
