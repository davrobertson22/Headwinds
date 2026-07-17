// OG veteran badge — this account has been flying since the original Tailwinds.
// Gold on purpose (Tailwinds' brand color) worn inside teal Headwinds. Driven by
// the account-level `isOG` flag the server sends alongside airline names — it is
// NEVER part of the name string itself (bracketed OG look-alikes are rejected at
// join, so the badge can't be faked in plain text). Styles: .og-badge in styles.css.
export default function OgBadge() {
  return (
    <span className="og-badge" title="OG · flying since the original Tailwinds">
      <span className="og-badge-wing">✈</span>OG
    </span>
  );
}

// DEV badge — this account is one of the game's operators (ADMIN_EMAILS on the
// server; never a DB flag, never grantable). Teal — Headwinds' own color — so it
// reads distinctly from the gold veteran chip. Same anti-fake rule: bracketed
// DEV look-alikes are rejected in airline names at join.
export function DevBadge() {
  return (
    <span className="dev-badge" title="DEV · Headwinds developer">
      <span className="og-badge-wing">🛠</span>DEV
    </span>
  );
}
