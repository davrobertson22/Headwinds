// Fetching for the public world pages and the share card: the game API (called
// without credentials — it answers with the people taken out, server
// lib/publicView.mjs) and the engine data the renderers use.
export const API = process.env.HEADWINDS_API_ORIGIN ?? 'https://api.headwindsairlinegame.com';
const TIMEOUT_MS = 8000;
export const ID = /^[a-z0-9]{10,40}$/i;

export async function getJson(path) {
  const res = await fetch(`${API}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'headwinds-web/worlds-page' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

// What the pages use beyond the API's JSON, all from the engine: aircraft type
// names for "ordered 5× Boeing 737-800", airport coordinates for the maps, and
// the livery helpers the tail fins are painted with. Each is optional — if the
// workspace package is not reachable from the function bundle the page loses
// its maps or falls back to raw type ids rather than failing.
let ctxPromise = null;
export function loadCtx() {
  ctxPromise ??= (async () => {
    const [aircraft, airports, livery, branding] = await Promise.all([
      import('@tailwinds/engine/data/aircraft.js').catch(() => null),
      import('@tailwinds/engine/data/airports.js').catch(() => null),
      import('@tailwinds/engine/data/livery.js').catch(() => null),
      import('@tailwinds/engine/utils/logoBranding.js').catch(() => null),
    ]);
    return {
      apiOrigin: API,
      typeName: aircraft?.getAircraftType ? (id) => aircraft.getAircraftType(id)?.name ?? id ?? 'an aircraft' : undefined,
      getAirport: typeof airports?.getAirport === 'function' ? airports.getAirport : undefined,
      brand: livery?.normalizeLivery && branding?.markColorOn
        ? { normalizeLivery: livery.normalizeLivery, markColorOn: branding.markColorOn } : null,
    };
  })();
  return ctxPromise;
}

/** A public world's detail, or null when there is none a stranger may see. */
export async function publicWorld(id) {
  if (!ID.test(id)) return null;
  const detail = await getJson(`/worlds/${id}`);
  // A private world answers with its card and no standings; to the public
  // web that is the same as no world at all.
  if (!detail?.world || detail.private || detail.world.visibility !== 'PUBLIC') return null;
  return detail;
}

