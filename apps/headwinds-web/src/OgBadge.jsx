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

// SUPPORTER badge — this account has chipped in on Ko-fi toward the server bill.
// Ko-fi blue (#72a4f2, Ko-fi's own accent) so it reads as a third thing beside
// the gold OG chip and the teal DEV chip. Driven by the account-level
// `isSupporter` flag, sent as `sup` alongside `og`/`dev` in every payload that
// carries an airline name. Same anti-fake rule as the other two: bracketed
// SUPPORTER/SUP look-alikes are rejected in airline names at join AND at rename
// (worldService.OG_NAME_PATTERN), so it can't be faked in plain text.
//
// It is deliberately wordy where OG and DEV are terse. The chip IS the pitch —
// a player who sees one in the standings and wonders what it is has already
// found the support page. Styles: .supporter-badge in styles.css.
export function SupporterBadge() {
  return (
    <span className="supporter-badge" title="Supporter · chipped in toward the server bill">
      <span className="og-badge-wing">♥</span>SUPPORTER
    </span>
  );
}
