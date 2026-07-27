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

export const isTransientError = (e) =>
  Boolean(e && (e.offline || e.status === 0 || e.name === 'NetworkError'));

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
    throw err;
  }
  return data;
}
