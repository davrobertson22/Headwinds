// customLogo column split — the Supabase disk-IO fix (2026-08-24).
//
// Background. The tick rewrites every active airline's whole `state` JSONB
// every world-week, and Postgres cannot update part of a JSONB: each write
// TOASTs a complete new copy of the value, logs the same again in WAL, and
// leaves a dead copy for autovacuum. A user-uploaded logo is a STATIC data-URL
// that never changes between ticks, yet it rode inside that blob — re-written
// to disk on every tick of every world, forever. The fix moves it to its own
// Airline column (written once, on SET_BRANDING; unchanged columns' TOAST
// chunks are never rewritten) with lib/logoColumn.mjs as the single contract:
//
//   splitLogo(state)  on every persist  — blob never stores the key; the
//                     column is written only when the state carried one
//   injectLogo(state) on every owner-facing serve — the client keeps reading
//                     state.customLogo exactly as before (zero client changes)
//
// This file locks that contract, its composition with stripRivals on the two
// hot write paths (tick, decisions), the reducer round-trip that makes the
// decision route's "only SET_BRANDING ever writes the column" reasoning true,
// and the new SET_BRANDING boundary guard.

import assert from 'node:assert/strict';
import { splitLogo, injectLogo } from '../apps/headwinds-server/src/lib/logoColumn.mjs';
import { stripRivals } from '../apps/headwinds-server/src/lib/humanRivals.mjs';
import { guardDecision, GuardError } from '../apps/headwinds-server/src/lib/decisionGuard.mjs';
import { gameReducer } from '@tailwinds/engine/reducer';

let passed = 0;
const check = (name, fn) => {
  try { fn(); passed += 1; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='; // shape, not a real image

// ── 1. splitLogo — the persist half ─────────────────────────────────────────
check('a state without the key passes through untouched (same reference, no column write)', () => {
  const state = { airlineName: 'Aero', cash: 100 };
  const { state: out, logo } = splitLogo(state);
  assert.equal(out, state);          // no needless clone on the hot tick path
  assert.equal(logo, undefined);     // undefined = leave the column alone
});
check('a set logo is captured for the column and stripped from the blob', () => {
  const { state: out, logo } = splitLogo({ airlineName: 'Aero', customLogo: LOGO });
  assert.equal(logo, LOGO);
  assert.equal('customLogo' in out, false);
  assert.equal(out.airlineName, 'Aero');
});
check('an explicit null (branding cleared the upload) nulls the column', () => {
  const { state: out, logo } = splitLogo({ airlineName: 'Aero', customLogo: null });
  assert.equal(logo, null);          // null = clear the column
  assert.equal('customLogo' in out, false);
});
check('splitLogo never mutates its input', () => {
  const state = { airlineName: 'Aero', customLogo: LOGO };
  splitLogo(state);
  assert.equal(state.customLogo, LOGO);
});
check('null/undefined states pass through', () => {
  assert.deepEqual(splitLogo(null), { state: null, logo: undefined });
  assert.deepEqual(splitLogo(undefined), { state: undefined, logo: undefined });
});

// ── 2. injectLogo — the serve half ──────────────────────────────────────────
check('the column value is injected for the owner', () => {
  const out = injectLogo({ airlineName: 'Aero' }, LOGO);
  assert.equal(out.customLogo, LOGO);
});
check('no logo on file → state untouched (client reads undefined, renders the preset)', () => {
  const state = { airlineName: 'Aero' };
  assert.equal(injectLogo(state, null), state);
  assert.equal(injectLogo(state, undefined), state);
});
check("a state that already carries the key WINS — the SET_BRANDING response path, where the reducer output is newer than the row read before it ran", () => {
  const fresh = { airlineName: 'Aero', customLogo: 'data:image/png;base64,NEW' };
  assert.equal(injectLogo(fresh, LOGO).customLogo, 'data:image/png;base64,NEW');
  // ...including a fresh explicit null (the player just cleared the upload):
  const cleared = { airlineName: 'Aero', customLogo: null };
  assert.equal(injectLogo(cleared, LOGO).customLogo, null);
});
check('injectLogo never mutates its input', () => {
  const state = { airlineName: 'Aero' };
  injectLogo(state, LOGO);
  assert.equal('customLogo' in state, false);
});
check('round-trip: split → inject serves the owner exactly what branding set', () => {
  const { state: persisted, logo } = splitLogo({ airlineName: 'Aero', customLogo: LOGO });
  assert.equal(injectLogo(persisted, logo).customLogo, LOGO);
});

// ── 3. Composition with stripRivals on the write paths ──────────────────────
// tickService persists splitLogo(stripRivals(next)).state; decisions.mjs
// persists the same and forwards `logo` to the column. Neither order may leak
// the key or a rival copy into the blob.
check('splitLogo(stripRivals(state)) leaves neither rivals nor the logo in the blob', () => {
  const state = {
    airlineName: 'Aero', customLogo: LOGO,
    competitors: [{ name: 'Rival' }], humanRivals: { r1: {} }, gateMarket: {},
  };
  const { state: out, logo } = splitLogo(stripRivals(state));
  assert.equal(logo, LOGO);
  for (const k of ['customLogo', 'competitors', 'humanRivals', 'gateMarket']) {
    assert.equal(k in out, false, `${k} leaked into the persisted blob`);
  }
  assert.equal(out.airlineName, 'Aero');
});

// ── 4. The decision route's column-write reasoning, end to end ──────────────
// The route computes `next` from the DB blob (key-free since migration
// 20260824000000). Its rule "logo !== undefined ⟺ this decision was a
// SET_BRANDING that carried customLogo" is only true if the reducer neither
// invents nor drops the key. Prove it with the real reducer.
const baseState = (() => {
  // A minimal state the SET_BRANDING case can spread. The reducer only touches
  // branding fields for this action, so nothing else needs to be realistic.
  return { airlineName: 'Base Air', logoId: 'horizon', logoColor: '#123456' };
})();
check('an ordinary decision on a key-free state never touches the column', () => {
  const next = gameReducer(baseState, { type: 'SET_MARKETING_BUDGET', amount: 1000 });
  const { logo } = splitLogo(stripRivals(next));
  assert.equal(logo, undefined);
});
check('SET_BRANDING with an upload writes the column and a clean blob', () => {
  const next = gameReducer(baseState, {
    type: 'SET_BRANDING', airlineName: 'Neo Air', logoId: 'horizon', customLogo: LOGO,
  });
  const { state: persisted, logo } = splitLogo(stripRivals(next));
  assert.equal(logo, LOGO);
  assert.equal('customLogo' in persisted, false);
  assert.equal(persisted.airlineName, 'Neo Air');
});
check('SET_BRANDING without the key (name-only rebrand) leaves the column alone', () => {
  const next = gameReducer(baseState, { type: 'SET_BRANDING', airlineName: 'Neo Air' });
  const { logo } = splitLogo(stripRivals(next));
  assert.equal(logo, undefined);
});
check('SET_BRANDING clearing the upload nulls the column', () => {
  const next = gameReducer(baseState, {
    type: 'SET_BRANDING', airlineName: 'Neo Air', customLogo: null,
  });
  const { logo } = splitLogo(stripRivals(next));
  assert.equal(logo, null);
});

// ── 5. The SET_BRANDING boundary guard ──────────────────────────────────────
// The solo client downscales uploads to a 128×128 PNG data URL (a few tens of
// kB); the multiplayer client is untrusted and could otherwise smuggle up to
// Fastify's 1 MB body limit into the column on every rebrand.
check('a legitimate branding payload passes through intact', () => {
  const out = guardDecision('SET_BRANDING',
    { airlineName: 'Neo Air', logoId: 'horizon', logoColor: '#abcdef', customLogo: LOGO }, {});
  assert.deepEqual(out, { airlineName: 'Neo Air', logoId: 'horizon', logoColor: '#abcdef', customLogo: LOGO });
});
check("a name-only rebrand forwards NO customLogo key (the reducer's `'customLogo' in action` contract)", () => {
  const out = guardDecision('SET_BRANDING', { airlineName: 'Neo Air' }, {});
  assert.equal('customLogo' in out, false);
});
check('clearing the upload forwards the explicit null', () => {
  const out = guardDecision('SET_BRANDING', { airlineName: 'Neo Air', customLogo: null }, {});
  assert.equal(out.customLogo, null);
});
check('an oversized logo is rejected at the boundary', () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(400_000);
  assert.throws(
    () => guardDecision('SET_BRANDING', { airlineName: 'Neo Air', customLogo: huge }, {}),
    GuardError,
  );
});
check('a non-image data URL is rejected (no smuggling text/html into the column)', () => {
  for (const bad of ['data:text/html;base64,AAAA', 'https://example.com/logo.png', 42, {}]) {
    assert.throws(
      () => guardDecision('SET_BRANDING', { airlineName: 'Neo Air', customLogo: bad }, {}),
      GuardError,
      `accepted: ${String(bad)}`,
    );
  }
});
check('a realistic 128×128 upload is comfortably under the cap (a real player is never rejected)', () => {
  // Worst-case 128×128 RGBA PNG ≈ 64 kB raw → ~87 kB base64. Cap is 192 kB.
  const worstCase = 'data:image/png;base64,' + 'A'.repeat(90_000);
  const out = guardDecision('SET_BRANDING', { airlineName: 'Neo Air', customLogo: worstCase }, {});
  assert.equal(out.customLogo, worstCase);
});

console.log(`logo-column-test: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
