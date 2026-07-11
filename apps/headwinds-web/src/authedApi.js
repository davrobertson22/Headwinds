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
import { supabase } from './supabase.js';
import { api } from './api.js';

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

async function refreshOnce() {
  if (!refreshInFlight) {
    refreshInFlight = supabase.auth
      .refreshSession()
      .then(({ data, error }) => {
        if (error || !data?.session?.access_token) return null;
        return data.session.access_token;
      })
      .catch(() => null)
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
    const freshToken = await refreshOnce();
    if (!freshToken) throw new SessionExpiredError();
    return api(path, { ...opts, token: freshToken });
  }
}
