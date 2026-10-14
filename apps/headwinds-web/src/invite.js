// World invites: the link a player sends, the message that goes with it, and
// keeping the invited world through sign-in.
//
// Sign-in always returns to bare /play (Supabase's redirect allow-list has that
// one URL, and the implicit flow writes its tokens into the hash, so the route
// can't ride along in the redirect). The route is parked in localStorage
// instead and picked up once the session appears. Limitation: an email link
// opened in a different browser (an email app's in-app browser) has its own
// storage, so that one case still lands on the world list.

export const SITE = 'https://www.headwindsairlinegame.com';
export const RETURN_ROUTE_KEY = 'hw:returnRoute';
export const RETURN_ROUTE_TTL_MS = 2 * 3600 * 1000;

// Only a world lobby or the game inside it. Same id shape the public world
// pages accept (api/worlds.mjs), so nothing else can be parked and replayed.
const WORLD_ROUTE = /^#\/w\/[a-z0-9]{10,40}(\/play)?$/i;

export function rememberReturnRoute(hash, storage, now = Date.now()) {
  if (!storage || typeof hash !== 'string' || !WORLD_ROUTE.test(hash)) return;
  try { storage.setItem(RETURN_ROUTE_KEY, JSON.stringify({ route: hash, at: now })); } catch { /* private mode */ }
}

// Returns the path to send the player to ('/w/<id>' or '/w/<id>/play'), or
// null. One shot: the entry is cleared whenever a signed-in player is seen,
// used or not. Only redirects a player who landed on the world list — the
// place a fresh sign-in drops you — never one who already went somewhere.
export function resumeAfterSignIn({ signedIn, screen, storage, now = Date.now() }) {
  if (!signedIn || !storage) return null;
  let raw = null;
  try {
    raw = storage.getItem(RETURN_ROUTE_KEY);
    if (raw != null) storage.removeItem(RETURN_ROUTE_KEY);
  } catch { return null; }
  if (raw == null || screen !== 'worlds') return null;
  let saved;
  try { saved = JSON.parse(raw); } catch { return null; }
  const route = saved?.route;
  if (typeof route !== 'string' || !WORLD_ROUTE.test(route)) return null;
  if (!Number.isFinite(saved.at) || now - saved.at > RETURN_ROUTE_TTL_MS || now < saved.at) return null;
  return route.slice(1);
}

export function safeLocalStorage() {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

const isPublic = (w) => w?.visibility !== 'PRIVATE' && !w?.supporterWorld;

// Public worlds share their public page: it previews properly in Discord and
// WhatsApp and works before sign-in. Private worlds have no public page (it
// 404s by design), so they share the lobby link inside the game.
export function worldInviteUrl(world) {
  return isPublic(world) ? `${SITE}/worlds/${world.id}` : `${SITE}/play#/w/${world.id}`;
}

export function worldInviteText(world) {
  const parts = [`Join me in ${world.name} on Headwinds, a free multiplayer airline game where every rival is a real person.`];
  const n = Number(world.playerCount), max = Number(world.maxPlayers);
  if (Number.isFinite(n) && Number.isFinite(max) && max > n) parts.push(`${max - n} of ${max} airline seats open.`);
  // Never the password itself: the message gets forwarded.
  if (world.supporterWorld) parts.push("It's a private supporter world, so you'll need the password from me and a ♥ Supporter badge.");
  else if (!isPublic(world)) parts.push("It's private, so you'll need the join code from me.");
  return parts.join(' ');
}

// Native share sheet where there is one (phones, Safari, Edge), else the
// clipboard, else hand the link back for the UI to show.
export async function shareWorldInvite(world, { nav = typeof navigator !== 'undefined' ? navigator : {} } = {}) {
  const url = worldInviteUrl(world);
  const text = worldInviteText(world);
  if (typeof nav?.share === 'function') {
    try {
      await nav.share({ title: `${world.name} · Headwinds`, text, url });
      return { kind: 'shared', url, text };
    } catch (e) {
      if (e?.name === 'AbortError') return { kind: 'cancelled', url, text };
    }
  }
  if (typeof nav?.clipboard?.writeText === 'function') {
    try {
      await nav.clipboard.writeText(`${text} ${url}`);
      return { kind: 'copied', url, text };
    } catch { /* fall through */ }
  }
  return { kind: 'manual', url, text };
}
