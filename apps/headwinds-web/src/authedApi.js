// Authenticated API wrapper with bounded session recovery.
//
// Supabase access tokens are short-lived JWTs (~1h). The client refreshes them
// in the background, but there are gaps — a tab waking from sleep, or a poll
// firing in the moment between expiry and the background refresh. When that
// happens the server returns 401 "Invalid or expired session".
//
// authedApi() closes that gap without hiding real auth failures:
//   1. call api() normally
//   2. on 401, refresh the session ONCE and retry ONCE with the fresh token
//   3. if the refresh itself fails (token truly revoked — e.g. signed out, or
//      signed in elsewhere and the refresh token rotated), throw
//      SessionExpiredError so the caller can send the player to sign-in.
//
// It deliberately does NOT loop: one refresh, one retry, then give up. That
// keeps a genuinely-dead session from hammering the server.
//
// The one thing it must never do is treat a NETWORK failure as a dead session.
// SessionExpiredError is a permanent latch in the caller (polling stops, the
// player is shown "sign in again"), so a refreshSession() that failed only
// because the browser was offline would end the session over a wifi blip.
// Those come back as a transient NetworkError instead, and the poller retries.
import { supabase } from './supabase.js';
import { api, NetworkError, isTransientError } from './api.js';

export class SessionExpiredError extends Error {
  constructor() {
    super('Your session ended. Please sign in again.');
    this.name = 'SessionExpiredError';
    this.status = 401;
    this.expired = true;
  }
}

// Coalesce concurrent refreshes: several pollers can 401 at once, and we only
// want a single refreshSession() round-trip (rotating the refresh token twice
// in parallel can invalidate it). Everyone awaits the same in-flight promise.
let refreshInFlight = null;

// Supabase surfaces an unreachable auth server as AuthRetryableFetchError (or a
// thrown TypeError from fetch). Anything that smells like transport, not
// rejection, is retryable — we must not sign the player out over it.
const isTransientAuthFailure = (error) =>
  Boolean(
    (typeof navigator !== 'undefined' && navigator.onLine === false) ||
    (error && (
      error.name === 'AuthRetryableFetchError' ||
      error.name === 'TypeError' ||
      error.name === 'AbortError' ||
      error.status === 0 ||
      error.status === 429 ||
      (error.status >= 500 && error.status <= 599)
    )),
  );

// refreshSession() goes straight to Supabase and has NO timeout of its own, so
// a wedged auth service can hold it open far longer than the request budget
// api() enforces — which is exactly what happened on 2026-07-27, when GoTrue
// took 35s to answer. Time-box it and treat the timeout as transient: the poller
// tries again on the next tick instead of the screen sitting frozen.
export const REFRESH_TIMEOUT_MS = 10000;

function timeBox(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error('Sign-in service timed out');
      e.name = 'AbortError';
      reject(e);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function refreshOnce() {
  if (!refreshInFlight) {
    refreshInFlight = timeBox(supabase.auth.refreshSession(), REFRESH_TIMEOUT_MS)
      .then(({ data, error }) => {
        if (data?.session?.access_token) return { token: data.session.access_token };
        return { token: null, transient: isTransientAuthFailure(error) };
      })
      .catch((error) => ({ token: null, transient: isTransientAuthFailure(error) }))
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export async function authedApi(path, opts = {}) {
  try {
    return await api(path, opts);
  } catch (e) {
    // Only try to recover from auth failures, and only when we have a client
    // able to refresh. Everything else propagates unchanged.
    if (e.status !== 401 || !supabase) throw e;
    const { token: freshToken, transient } = await refreshOnce();
    if (!freshToken) {
      if (transient) throw new NetworkError('Lost contact with the sign-in service — retrying…', e);
      throw new SessionExpiredError();
    }
    return api(path, { ...opts, token: freshToken });
  }
}

export { isTransientError };
