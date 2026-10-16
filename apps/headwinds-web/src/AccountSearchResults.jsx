// Account search results in the admin panel (Admin → Players & badges).
//
// One row per matching account, with every account-level action an admin takes
// by hand: the OG and supporter badges, and ban / unban. Ban used to be
// reachable only from a player report, so a spam account nobody had reported
// could not be banned from the panel at all. Rendered by ModerationScreen in
// App.jsx; kept separate so tools/admin-ban-test.mjs can SSR-render it.
import OgBadge, { SupporterBadge } from './OgBadge.jsx';

export default function AccountSearchResults({
  accounts, busyId, onSetOg, onSetSupporter, onBan, onUnban,
}) {
  if (accounts == null) return null;
  if (accounts.length === 0) {
    return <p className="muted small">No matching account. They need to sign in to Headwinds at least once first.</p>;
  }
  return (
    <table className="worlds">
      <thead><tr><th>Player</th><th>Email</th><th>Airlines</th><th /></tr></thead>
      <tbody>
        {accounts.map((a) => (
          <tr key={a.id}>
            <td>
              {a.displayName}{a.isOG ? <OgBadge /> : null}{a.isSupporter ? <SupporterBadge /> : null}
              {a.bannedAt ? <span className="chip chip-banned"> banned</span> : null}
              {a.domainBlocked ? <span className="chip chip-banned" title="Email domain is in BANNED_EMAIL_DOMAINS"> domain blocked</span> : null}
              {/* Rename trail — a new name must not outrun the old one's reputation. */}
              {a.pastNames?.length ? <div className="muted small">formerly {a.pastNames.join(', ')}</div> : null}
              {a.bannedAt && a.banReason ? <div className="muted small">Ban reason: {a.banReason}</div> : null}
            </td>
            <td className="muted">{a.email}</td>
            <td className="muted small">{a.airlines?.length ? a.airlines.join(', ') : '—'}</td>
            <td>
              <div className="row">
                {a.isOG ? (
                  <button className="btn danger small" disabled={busyId === a.id}
                    onClick={() => onSetOg(a, false)}>Remove OG</button>
                ) : (
                  <button className="btn primary small" disabled={busyId === a.id}
                    onClick={() => onSetOg(a, true)}>Grant OG</button>
                )}
                {a.isSupporter ? (
                  <button className="btn danger small" disabled={busyId === a.id}
                    onClick={() => onSetSupporter(a, false)}>Remove supporter</button>
                ) : (
                  <button className="btn primary small" disabled={busyId === a.id}
                    onClick={() => onSetSupporter(a, true)}>Grant supporter</button>
                )}
                {a.isAdmin ? null : a.bannedAt ? (
                  <button className="btn small" disabled={busyId === a.id}
                    onClick={() => onUnban(a.id, a.displayName)}>Unban</button>
                ) : (
                  <button className="btn danger small" disabled={busyId === a.id}
                    onClick={() => onBan(a.id, a.displayName)}>Ban</button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
