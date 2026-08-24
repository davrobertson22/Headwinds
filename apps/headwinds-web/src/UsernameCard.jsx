// Claim (or change) your username — the account-level identity behind your
// airlines, shown on your public profile and unique across all of Headwinds.
//
// Two states:
//   unclaimed  a nudge card with the claim form (the first set is free)
//   claimed    the current name plus a Change flow (one change per 30 days —
//              the server enforces the cooldown and answers with how long
//              is left, so no clock lives here)
//
// Validation is intentionally NOT duplicated here beyond the input's
// length/charset hints — the server's usernameProblem() is the authority and
// its message is shown verbatim.
import { useState } from 'react';
import { api } from './api.js';

export default function UsernameCard({ me, token, refreshMe }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { kind: 'ok' | 'err', text }

  const account = me?.account;
  if (!account || !token) return null;
  const username = account.username ?? null;

  const save = async (e) => {
    e.preventDefault();
    const requested = value.trim();
    if (!requested) return;
    setBusy(true); setNotice(null);
    try {
      const res = await api('/me/username', { method: 'POST', token, body: { username: requested } });
      setNotice({ kind: 'ok', text: `You are @${res.username}.` });
      setEditing(false); setValue('');
      refreshMe?.();
    } catch (err) {
      setNotice({ kind: 'err', text: String(err?.message || 'Could not save that username.') });
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <form className="row" onSubmit={save} style={{ gap: 8, flexWrap: 'wrap' }}>
      <input
        value={value} onChange={(e) => setValue(e.target.value)}
        placeholder="your-username" maxLength={20} autoComplete="off"
        aria-label="Username"
      />
      <button className="btn primary small" type="submit" disabled={busy || !value.trim()}>
        {username ? 'Change' : 'Claim'}
      </button>
      {username && (
        <button className="btn small" type="button" disabled={busy}
          onClick={() => { setEditing(false); setValue(''); setNotice(null); }}>
          Cancel
        </button>
      )}
    </form>
  );

  return (
    <section className="card" style={{ marginTop: 24 }}>
      {username ? (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }}>Username</h3>
            {!editing && (
              <button className="btn small" onClick={() => { setEditing(true); setValue(username); setNotice(null); }}>
                Change
              </button>
            )}
          </div>
          <p style={{ margin: '8px 0 4px', fontSize: 18, fontWeight: 700 }}>@{username}</p>
          {!editing && (
            <p className="muted small" style={{ margin: 0 }}>
              Shown on your public profile. You can change it once every 30 days.
            </p>
          )}
          {editing && form}
        </>
      ) : (
        <>
          <h3 style={{ marginTop: 0 }}>Choose your username</h3>
          <p className="muted small" style={{ marginTop: -6 }}>
            One name across every world, shown on your public profile. 3–20
            characters, letters, numbers, dashes and underscores. First pick is
            free; changes are limited to one a month.
          </p>
          {form}
        </>
      )}
      {notice && (
        <p className={notice.kind === 'err' ? 'error' : 'muted'} style={{ marginBottom: 0 }}>
          {notice.text}
        </p>
      )}
    </section>
  );
}
