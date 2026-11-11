// What the API tells a visitor who is NOT signed in.
//
// Standings, rival dossiers and world news are readable without an account for
// a PUBLIC world — the public web pages (/worlds, an airline's page, the hall
// of fame) are built from them. Those reads describe AIRLINES. Anything that
// describes the PERSON behind one — their account id, display name, when they
// last played, their account badges — is for signed-in players only
// (Dave, 2026-11-10: "Airline only").
//
// One deep scrub rather than a field list per route: a field added to a
// response later is covered the day it is added, as long as it keeps the name.
// Pure — tools/public-view-test.mjs drives it.
export const PERSON_KEYS = new Set([
  'accountId', 'ownerAccountId', 'playerName', 'lastMoveAt', 'og', 'sup', 'dev', 'badges',
]);

const isPlain = (v) => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** A copy of `value` with every person-describing key removed, at any depth. */
export function withoutPeople(value) {
  if (Array.isArray(value)) return value.map(withoutPeople);
  if (!isPlain(value)) return value;          // Date, Buffer, primitives: as they are
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (PERSON_KEYS.has(k)) continue;
    out[k] = withoutPeople(v);
  }
  return out;
}

/** The body as this viewer may see it: whole for an account, scrubbed for a stranger. */
export const forViewer = (viewer, body) => (viewer ? body : withoutPeople(body));
