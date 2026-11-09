// "Connect your own AI" — the supporters' read-only Agent API, set up here in
// the lobby (never in the game: the support ask stays out of the gameplay loop,
// see SupportCard.jsx).
//
// A supporter makes a connector token, pastes the URL it gives into Claude /
// ChatGPT / any MCP client, and their AI can read their airlines: the same
// briefing and Advisor every player gets in Company ▸ Advisor, without the
// copy-paste. Read-only — it cannot change anything in a world. Server half:
// apps/headwinds-server/src/lib/agentApi.mjs.
//
// Shown to supporters only. Non-supporters see the perk listed on the support
// card instead (support.js SUPPORT_PERKS) — no second ask.
import { useCallback, useEffect, useState } from 'react';
import { api, API_BASE, readableError } from './api.js';

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never');

function CopyField({ value, label }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 2000); }
    catch { /* the field is selectable; the player can copy by hand */ }
  };
  return (
    <div className="row" style={{ gap: 6, alignItems: 'stretch', flexWrap: 'nowrap', margin: '4px 0 10px' }}>
      <input readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()}
             style={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: 12 }} />
      <button type="button" className="btn small" onClick={copy}>{done ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

export default function AiConnectorCard({ me, token }) {
  const isSupporter = me?.account?.isSupporter === true;
  const [data, setData] = useState(null);        // { tokens, max }
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fresh, setFresh] = useState(null);      // { secret, label } — shown once

  const load = useCallback(async () => {
    try { setData(await api('/me/api-tokens', { token })); }
    catch (e) { setError(readableError(e)); }
  }, [token]);
  useEffect(() => { if (isSupporter && token) load(); }, [isSupporter, token, load]);

  if (!me?.account || !token || !isSupporter) return null;

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api('/me/api-tokens', { method: 'POST', token, body: { label: label.trim() || 'My AI' } });
      setFresh({ secret: res.secret, label: res.token.label });
      setLabel('');
      await load();
    } catch (err) { setError(readableError(err)); }
    finally { setBusy(false); }
  };

  const revoke = async (id) => {
    setBusy(true); setError(null);
    try {
      await api(`/me/api-tokens/${encodeURIComponent(id)}`, { method: 'DELETE', token });
      await load();
    } catch (err) { setError(readableError(err)); }
    finally { setBusy(false); }
  };

  const tokens = data?.tokens ?? [];
  const full = data && tokens.length >= (data.max ?? 3);
  const mcpUrl = fresh ? `${API_BASE}/mcp/${fresh.secret}` : null;

  return (
    <section className="card" style={{ marginTop: 24 }} data-card="ai-connector">
      <h3 style={{ marginTop: 0 }}>Connect your own AI</h3>
      <p className="muted small" style={{ marginTop: -6 }}>
        A supporter thank-you. A <strong>connector</strong> is a private link you add to Claude, ChatGPT or any AI app
        that accepts MCP connectors. After that you just ask — <em>“how are my airlines doing?”</em>,{' '}
        <em>“which routes should I reprice?”</em> — and your AI looks up your airlines itself, live, instead of you
        pasting a briefing every time.
      </p>

      <details style={{ margin: '4px 0 10px' }} data-help="connector-vs-briefing">
        <summary className="small" style={{ cursor: 'pointer' }}>How is this different from “Copy airline briefing”?</summary>
        <ul className="muted small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li><strong>Copy airline briefing</strong> (Company ▸ Advisor, free for everyone) copies one airline as text, as
            it stands right now. You paste it into a chat yourself, and paste it again when things change.</li>
          <li><strong>A connector</strong> lets your AI read the latest figures whenever you ask, for every airline you fly,
            and in more detail: every route and every aircraft rather than the best and worst, and up to a year of weekly
            results. It's the same kind of information the briefing shows, so it gives you nothing another player
            can't see about their own airline.</li>
        </ul>
      </details>

      <div className="small" style={{ fontWeight: 600, margin: '8px 0 4px' }}>Setting one up</div>
      <ol className="muted small" style={{ margin: '0 0 8px', paddingLeft: 18 }}>
        <li>Give it a name below and press <strong>Create connector</strong>.</li>
        <li>Copy the URL it shows you. It is shown <strong>once</strong>, so copy it straight away.</li>
        <li>In your AI app, add a custom connector (sometimes called an MCP server) and paste the URL.</li>
        <li>Ask about your airlines. If you fly in more than one world, your AI will ask which one, or you can name it.</li>
      </ol>

      <details style={{ margin: '0 0 10px' }} data-help="connector-limits">
        <summary className="small" style={{ cursor: 'pointer' }}>What it can and can't do</summary>
        <ul className="muted small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li><strong>Can read:</strong> your own airlines — the briefing, the Advisor's tips, your routes, fleet and weekly finances.</li>
          <li><strong>Can't change anything.</strong> It's read-only: no fares, routes, orders or settings. Your AI suggests; you decide in the game.</li>
          <li><strong>Can't see other players</strong> beyond the number of rivals on each of your routes.</li>
          <li><strong>Can't forecast new routes.</strong> It has no market data for routes you don't fly yet. Network ▸ Route Finder does that.</li>
          <li><strong>Pauses if your supporter badge lapses,</strong> and works again as soon as it's back. Your tokens stay put.</li>
          <li><strong>Treat the URL like a password.</strong> Anyone who has it can read your airlines. Revoke it here at any time and it stops working immediately.</li>
        </ul>
      </details>

      {fresh && (
        <div style={{ border: '1px solid var(--accent, #4ea1ff)', borderRadius: 8, padding: 12, margin: '12px 0' }}>
          <strong>“{fresh.label}” is ready.</strong>{' '}
          <span className="muted small">Copy it now — the secret is shown only this once.</span>
          <div className="small" style={{ marginTop: 10 }}>Connector URL (paste into your AI app):</div>
          <CopyField value={mcpUrl} label="Connector URL" />
          <ul className="muted small" style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            <li><strong>Claude</strong> (web or desktop): add a custom connector and paste the URL.</li>
            <li><strong>Claude Code</strong>: <code>claude mcp add --transport http headwinds {mcpUrl}</code></li>
            <li><strong>ChatGPT</strong> and other apps: wherever they let you add an MCP server by URL.</li>
          </ul>
          <div className="small">The token on its own (for scripts and other tools):</div>
          <CopyField value={fresh.secret} label="Token" />
          <p className="muted small" style={{ margin: 0 }}>
            Building something yourself? The same token works as <code>Authorization: Bearer …</code> on{' '}
            <code>{API_BASE}/agent/airlines</code>. Keep both private — revoke below if either leaks.
          </p>
          <button type="button" className="btn small" style={{ marginTop: 10 }} onClick={() => setFresh(null)}>Done, I've saved it</button>
        </div>
      )}

      {tokens.length > 0 && (
        <table className="small" style={{ width: '100%', margin: '8px 0 12px', borderCollapse: 'collapse' }}>
          <thead>
            <tr className="muted" style={{ textAlign: 'left' }}>
              <th>Name</th><th>Token</th><th>Created</th><th>Last used</th><th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td><code>{t.prefix}…</code></td>
                <td>{fmtDate(t.createdAt)}</td>
                <td>{fmtDate(t.lastUsedAt)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button type="button" className="btn small" disabled={busy} onClick={() => revoke(t.id)}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {full ? (
        <p className="muted small" style={{ marginBottom: 0 }}>You have {tokens.length} connectors — revoke one to make another.</p>
      ) : (
        <form className="row" onSubmit={create} style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name it, e.g. Claude on my laptop"
                 maxLength={40} aria-label="Connector name" style={{ flex: 1, minWidth: 200 }} />
          <button className="btn primary small" type="submit" disabled={busy}>Create connector</button>
        </form>
      )}
      {error && <p className="error" style={{ marginBottom: 0 }}>{error}</p>}
    </section>
  );
}
