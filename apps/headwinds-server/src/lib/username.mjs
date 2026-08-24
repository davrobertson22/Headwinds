// Usernames — validation and display rules (player profiles, phase 2).
//
// One rule the whole feature hangs on: `displayName` is the sign-up name and
// never becomes load-bearing; `username` is the claimed, unique identity.
// Display everywhere is `username ?? displayName` (displayNameOf below), so an
// account that never claims one keeps working exactly as before.
//
// Validation lives here as pure functions so the route, the tests, and any
// future client-side pre-check cannot drift apart.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

// Starts alphanumeric; then letters, digits, underscore, dash. Compared
// lowercased everywhere — the DB's lower("username") unique index is the
// authority on uniqueness, this regex only shapes the string.
export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/;

// How often a SET username may change. The first claim is free; after that a
// scammer must wear a name for a month — long enough for reports to land on
// the name that earned them (and the NameChange trail keeps the history
// regardless).
export const RENAME_COOLDOWN_DAYS = 30;

// Names that would impersonate the game or its operators. Compared lowercased.
// Deliberately short — offensive names are NOT filtered here; they go through
// the existing OFFENSIVE_NAME report category and the moderation panel, which
// already handles exactly this for airline names.
export const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'mod', 'moderator', 'staff', 'support', 'system',
  'headwinds', 'tailwinds', 'official', 'dev', 'developer', 'root',
]);

/**
 * Why a candidate username is unacceptable, or null if it is fine.
 * Pure string validation — uniqueness is the database's job.
 *
 * @param {string} name
 * @returns {string|null} a player-facing problem description
 */
export function usernameProblem(name) {
  if (typeof name !== 'string') return 'Enter a username.';
  const n = name.trim();
  if (n.length < USERNAME_MIN) return `Usernames need at least ${USERNAME_MIN} characters.`;
  if (n.length > USERNAME_MAX) return `Usernames are at most ${USERNAME_MAX} characters.`;
  if (!USERNAME_RE.test(n)) {
    return 'Letters, numbers, dashes and underscores only — and it has to start with a letter or number.';
  }
  if (RESERVED_USERNAMES.has(n.toLowerCase())) return 'That name is reserved.';
  return null;
}

/** What to show for an account, wherever accounts are shown. */
export const displayNameOf = (a) => a?.username ?? a?.displayName ?? null;
