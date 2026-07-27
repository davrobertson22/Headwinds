// Reconnect / connection-loss guards for the Headwinds live game screen.
//
// Community report (Discord, "Kat the Fox", 2026-07-27):
//   "The website won't resync after temp connection loss, force refresh needed.
//    It won't tell you if you've lost connection and the only way to know is if
//    it refuses to tick to the next week after 30 mins."
//
// Three defects made a transient blip permanent. This file locks all three:
//   1. api() used a bare fetch with no timeout, so a request on a half-dead
//      connection hung forever — never rejecting, never retrying, never telling
//      anyone. Now every request is time-boxed and fails as a NetworkError.
//   2. the fast-poll test had no lower bound, so once the tick time passed the
//      client polled every 4s forever instead of falling back to 25s.
//   3. a refreshSession() that failed because the browser was OFFLINE was
//      treated as a revoked token, latching the session dead until reload.
//      (Covered here by the classifier the auth wrapper uses.)

import assert from 'node:assert/strict';
import {
  shouldFastPoll,
  isStaleContact,
  STALE_AFTER_MS,
  FAST_POLL_AFTER_DUE_MS,
} from '../apps/headwinds-web/src/connection.js';
import { api, NetworkError, isTransientError } from '../apps/headwinds-web/src/api.js';

let passed = 0;
const check = (name, fn) => {
  try { fn(); passed += 1; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};
const checkAsync = async (name, fn) => {
  try { await fn(); passed += 1; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const at = (ms) => new Date(NOW + ms).toISOString();

// ── 1. fast-poll window ─────────────────────────────────────────────────────
check('no fast poll long before the tick is due', () => {
  assert.equal(shouldFastPoll(at(60_000), NOW), false);
});
check('fast poll in the last seconds before the tick', () => {
  assert.equal(shouldFastPoll(at(4_000), NOW), true);
});
check('fast poll just after the tick is due (the new week is landing)', () => {
  assert.equal(shouldFastPoll(at(-10_000), NOW), true);
});
check('fast poll STOPS once the due time is well past — the 4s-forever bug', () => {
  assert.equal(shouldFastPoll(at(-FAST_POLL_AFTER_DUE_MS - 1), NOW), false);
  // An hour-old nextTickAt is the signature of a client that lost contact.
  // Before the fix this returned true and it polled every 4s indefinitely.
  assert.equal(shouldFastPoll(at(-3_600_000), NOW), false);
});
check('missing or unparseable nextTickAt never fast-polls', () => {
  assert.equal(shouldFastPoll(null, NOW), false);
  assert.equal(shouldFastPoll(undefined, NOW), false);
  assert.equal(shouldFastPoll('not a date', NOW), false);
});

// ── 2. stale-contact detection ──────────────────────────────────────────────
check('a fresh poll is not stale', () => {
  assert.equal(isStaleContact(NOW - 1_000, NOW), false);
  assert.equal(isStaleContact(NOW - STALE_AFTER_MS, NOW), false);
});
check('no successful poll for longer than the window is stale', () => {
  assert.equal(isStaleContact(NOW - STALE_AFTER_MS - 1, NOW), true);
});
check('stale window outlives one failed request plus the next poll', () => {
  // 15s request timeout + 25s poll interval must fit inside it, or a single
  // unlucky request would flash "reconnecting" at players on a fine connection.
  assert.ok(STALE_AFTER_MS > 15_000 + 25_000);
});

// ── 3. transport failures are transient, HTTP failures are not ──────────────
check('NetworkError classifies as transient', () => {
  assert.equal(isTransientError(new NetworkError('offline')), true);
});
check('a 401 does NOT classify as transient', () => {
  const e = new Error('Invalid or expired session'); e.status = 401;
  assert.equal(isTransientError(e), false);
});
check('a 500 does NOT classify as transient at the transport layer', () => {
  const e = new Error('boom'); e.status = 500;
  assert.equal(isTransientError(e), false);
});

// ── 4. api() time-boxes every request ───────────────────────────────────────
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};

await checkAsync('a hung request rejects instead of hanging forever', async () => {
  // The exact failure Kat hit: the socket is dead, the server never answers,
  // and the promise used to sit unresolved until the tab was reloaded.
  const hung = (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
    });
  });
  const started = Date.now();
  await withFetch(hung, async () => {
    await assert.rejects(
      api('/worlds/x/airline', { timeoutMs: 60 }),
      (e) => e instanceof NetworkError && isTransientError(e),
    );
  });
  assert.ok(Date.now() - started < 5_000, 'timed out promptly');
});

await checkAsync('a thrown fetch (DNS/TLS/offline) becomes a NetworkError', async () => {
  await withFetch(() => Promise.reject(new TypeError('Failed to fetch')), async () => {
    await assert.rejects(api('/worlds/x/airline'), (e) => e instanceof NetworkError);
  });
});

await checkAsync('a real HTTP error still surfaces with its status', async () => {
  const res = {
    ok: false, status: 401, statusText: 'Unauthorized',
    json: async () => ({ error: 'Invalid or expired session' }),
  };
  await withFetch(async () => res, async () => {
    await assert.rejects(api('/worlds/x/airline'), (e) => {
      assert.equal(e.status, 401);
      assert.equal(e instanceof NetworkError, false); // must NOT look transient
      return true;
    });
  });
});

await checkAsync('a good response still returns its payload', async () => {
  const res = { ok: true, status: 200, statusText: 'OK', json: async () => ({ unchanged: true, stamp: '7:9' }) };
  await withFetch(async () => res, async () => {
    const d = await api('/worlds/x/airline?stamp=7:9');
    assert.deepEqual(d, { unchanged: true, stamp: '7:9' });
  });
});

await checkAsync('a stalled response BODY also times out', async () => {
  // Headers arrive, the body never does — just as wedging as no response at
  // all, and the reason the timeout has to stay armed until the JSON is read.
  // Real fetch rejects a pending body read with AbortError when the signal
  // fires; the mock models that.
  await withFetch(async (_url, opts) => ({
    ok: true, status: 200, statusText: 'OK',
    json: () => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    }),
  }), async () => {
    const guard = new Promise((_r, rej) => setTimeout(() => rej(new Error('api() hung on the body')), 3000));
    await assert.rejects(
      Promise.race([api('/x', { timeoutMs: 40 }), guard]),
      (e) => e instanceof NetworkError,
    );
  });
});

if (process.exitCode) console.error(`\nreconnect-test: ${passed} passed, failures above`);
else console.log(`reconnect-test: ${passed}/${passed} passed`);
