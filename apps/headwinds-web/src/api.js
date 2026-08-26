// Tiny fetch wrapper for the @headwinds/server API.
// Every call optionally carries the Supabase access token as a Bearer header —
// the server maps it to an Account (creating one on first sight).
//
// Every request is time-boxed. A bare fetch() on a half-dead connection (wifi
// flap, laptop sleep/wake, phone handing off to another cell) can hang for
// minutes without ever rejecting: no error surfaces, the caller's poll never
// completes, and the next poll multiplexes onto the same dead connection and
// hangs too. That is how the game used to wedge on "next week landing…" until a
// force refresh. An AbortController turns that silence into a real rejection,
// so the poller can notice, tell the player, and retry on a fresh connection.

const BASE = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

// Generous enough for a cold Railway container and the full state blob, short
// enough that a wedged request can't outlive the poll interval that issued it.
export const REQUEST_TIMEOUT_MS = 15000;

// Transport-level failure: offline, DNS/TLS failure, timeout, server
// unreachable. Distinct from an HTTP error (which has a real status) because
// callers must treat it as TRANSIENT — retry, don't sign the player out.
export class NetworkError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'NetworkError';
    this.status = 0;
    this.offline = true;
    this.cause = cause;
  }
}

// Gateway statuses mean "something upstream of the game is unavailable", not
// "your request was wrong": 502/504 from a proxy, and 503 from our own API when
// the Supabase auth service is unreachable (headwinds-server/src/auth.mjs).
//
// THE BUG THIS EXISTS TO PREVENT: on 2026-07-27 Supabase's GoTrue answered
// /auth/v1/user in 35s or not at all. The server turned that into 401 "Invalid
// or expired session", the client believed it, and an outage that had nothing to
// do with the player's session could sign them out mid-game. A 500 is
// deliberately NOT in this set — that is our own bug, and it should surface.
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

// A one-line error a player can actually read. Upstream edges sometimes hand
// us an ENTIRE HTML error page as the "message": on 2026-08-25 Supabase's
// Cloudflare edge answered the sign-in call with a 522 page, supabase-js put
// the whole body in error.message, and the login card printed ~200 lines of
// raw HTML source (Donovan's Discord screenshot). Anything that looks like
// markup, or runs longer than a couple of sentences, is not a message a human
// can act on -- collapse it to a friendly line. Render errors through this
// everywhere instead of String(error.message || error).
export const readableError = (error) => {
  let raw = String(error?.message || error || 'Something went wrong.');
  if (raw === '[object Object]') raw = 'Something went wrong.';
  const looksLikeMarkup = /^\s*</.test(raw) || /<\/?(html|head|body|div|span|!doctype)\b/i.test(raw);
  if (looksLikeMarkup || raw.length > 300) {
    return "The server sent back an unexpected response -- it may be briefly overloaded or down. Try again in a minute.";
  }
  return raw;
};

export const isTransientError = (e) =>
  Boolean(e && (
    e.offline ||
    e.status === 0 ||
    e.name === 'NetworkError' ||
    TRANSIENT_STATUSES.has(e.status)
  ));

export async function api(path, { method = 'GET', body, token, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let data = null;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    // Read the body inside the timeout too — a response whose headers arrived
    // but whose body stalls is just as wedging as one that never answers.
    try {
      data = await res.json();
    } catch (bodyErr) {
      // A body that never arrives, or is cut off mid-stream, is a transport
      // failure — let it fall through to the NetworkError below. Only a genuine
      // parse failure (an HTML error page, an empty body) is swallowed.
      if (bodyErr?.name === 'AbortError' || bodyErr?.name === 'TypeError') throw bodyErr;
      /* non-JSON error body — carry on with data = null */
    }
  } catch (e) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const timedOut = e?.name === 'AbortError';
    throw new NetworkError(
      offline   ? 'You appear to be offline — reconnecting…'
      : timedOut ? 'The server did not respond — retrying…'
      :            'Could not reach the server — retrying…',
      e,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const message = data?.error || data?.message || `${res.status} ${res.statusText}`;
    const err = new Error(message);
    err.status = res.status;
    // Machine-readable failure kind, when the server sends one. The status alone
    // is not enough to decide whether a write may be re-submitted: 409 covers
    // both "you lost the version check, nothing was written" (safe to retry) and
    // "your airline is BANKRUPT" (retrying just repeats it). See decisionPolicy.js.
    err.code = data?.code ?? null;
    err.retryable = data?.retryable === true;
    throw err;
  }
  return data;
}
