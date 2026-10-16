// Email-domain blocklist — the BANNED_EMAIL_DOMAINS env var.
//
// A ban (Account.bannedAt) is per account. A spam operator who owns a domain can
// mint a fresh address on it for every sign-up, and auth.mjs creates a new,
// unbanned Account on the first request each one makes. Blocking the domain is
// what actually stops that: auth.mjs refuses to create an account for a blocked
// address and rejects any existing account whose email is on one.
//
// Matching is on the domain after the last '@', case-insensitive, and covers
// subdomains: `spambot.com.au` also blocks `x@mail.spambot.com.au`, but never
// `x@notspambot.com.au`. Entries may be written with or without a leading '@'.
// Admins are exempt at the call site (auth.mjs), so a typo in the env var can
// never lock the operators out.

export function parseDomainList(raw) {
  return [...new Set(
    String(raw ?? '')
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, ''))
      .filter((d) => d && d.includes('.')),
  )];
}

export function emailDomain(email) {
  const s = String(email ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 0) return null;
  const domain = s.slice(at + 1).replace(/\.+$/, '');
  return domain || null;
}

export function isEmailDomainBlocked(email, blockedDomains) {
  if (!blockedDomains?.length) return false;
  const domain = emailDomain(email);
  if (!domain) return false;
  return blockedDomains.some((b) => domain === b || domain.endsWith(`.${b}`));
}
