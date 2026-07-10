// Tiny fetch wrapper for the @headwinds/server API.
// Every call optionally carries the Supabase access token as a Bearer header —
// the server maps it to an Account (creating one on first sight).

const BASE = import.meta.env?.VITE_API_URL || 'http://localhost:8787';

export async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const message = data?.error || data?.message || `${res.status} ${res.statusText}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}
