// Account-level inbox — messages that outlive any world (player profiles,
// phase 3).
//
// A lobby-header widget, deliberately shaped like the in-game Messages
// drawer: envelope button with an unread badge, a slide-over with a
// conversation list, threads, block/report, plus one thing world messages
// never needed — a "who can message me" policy select, answered by
// POST /me/dm-policy.
//
// A profile's "✉ Message" button routes here through `requestThread`: the
// shell sets it to an accountId, the widget opens straight onto that thread
// and calls onConsumeRequest so the request doesn't re-fire.
import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import { ReportDialog } from './Report.jsx';
import OgBadge, { DevBadge } from './OgBadge.jsx';
import { useVisibleInterval } from './usePoll.js';

const fmtTime = (t) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const POLICY_OPTIONS = [
  { value: 'EVERYONE', label: 'Anyone' },
  { value: 'SHARED_WORLD', label: 'People I share a world with' },
  { value: 'NOBODY', label: 'No one' },
];

export default function AccountInboxWidget({ token, requestThread = null, onConsumeRequest = null }) {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState(null); // accountId of the open thread
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    if (!token) return;
    api('/me/messages', { token })
      .then((d) => { setSummary(d); setError(null); })
      .catch(setError);
  }, [token]);
  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, 30000);

  useEffect(() => {
    if (!requestThread) return;
    setThread(requestThread);
    setOpen(true);
    onConsumeRequest?.();
  }, [requestThread, onConsumeRequest]);

  if (!token) return null;
  const unread = summary?.totalUnread ?? 0;

  return (
    <>
      <button className="btn small" style={{ position: 'relative' }} title="Messages"
        onClick={() => setOpen((o) => !o)}>
        ✉ <span className="hw-btn-label">Inbox</span>
        {unread > 0 && <span className="hw-msg-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <InboxDrawer
          token={token} summary={summary} error={error}
          thread={thread} setThread={setThread} refresh={load}
          onClose={() => { setOpen(false); setThread(null); }}
        />
      )}
    </>
  );
}

function InboxDrawer({ token, summary, error, thread, setThread, refresh, onClose }) {
  const [policyBusy, setPolicyBusy] = useState(false);
  const setPolicy = async (policy) => {
    setPolicyBusy(true);
    try { await api('/me/dm-policy', { method: 'POST', token, body: { policy } }); refresh(); }
    catch { /* the select snaps back on the next refresh */ }
    setPolicyBusy(false);
  };

  return createPortal(
    <div className="hw-msg-drawer">
      <div className="hw-msg-head">
        <strong style={{ padding: '0 6px' }}>Messages</strong>
        <button className="hw-msg-close" onClick={onClose} title="Close">×</button>
      </div>
      {error && <p className="error" style={{ padding: '0 14px' }}>{String(error.message || error)}</p>}

      {!thread && (
        <div className="hw-msg-body">
          {!summary ? <p className="hw-msg-empty">Loading…</p> :
           summary.conversations.length === 0 ? (
            <p className="hw-msg-empty">
              No conversations yet. Open any player's profile and hit
              “✉ Message” to start one — these work across every world.
            </p>
          ) : summary.conversations.map((c) => (
            <button key={c.accountId} className="hw-msg-convo" onClick={() => setThread(c.accountId)}>
              <span className="hw-msg-convo-name">
                {c.name}{c.dev ? <DevBadge /> : null}{c.og ? <OgBadge /> : null}
                {c.unread > 0 && <span className="hw-msg-badge">{c.unread}</span>}
              </span>
              {c.lastMessage && (
                <span className="hw-msg-convo-preview">
                  {c.lastMessage.fromMe ? 'You: ' : ''}{c.lastMessage.body}
                </span>
              )}
            </button>
          ))}

          {summary?.blocked?.length > 0 && (
            <div className="hw-msg-blocked">
              <div className="hw-msg-section">Blocked</div>
              {summary.blocked.map((b) => (
                <div key={b.accountId} className="hw-msg-blocked-row">
                  <span>{b.name}</span>
                  <button className="btn small" onClick={() =>
                    api('/me/messages/block', {
                      method: 'POST', token, body: { accountId: b.accountId, blocked: false },
                    }).then(refresh)
                  }>Unblock</button>
                </div>
              ))}
            </div>
          )}

          {summary && (
            <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,.1)' }}>
              <label className="muted small" style={{ display: 'block' }}>
                Who can message me
                <select
                  value={summary.dmPolicy} disabled={policyBusy}
                  onChange={(e) => setPolicy(e.target.value)}
                  style={{ display: 'block', marginTop: 4, width: '100%' }}
                >
                  {POLICY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
            </div>
          )}
        </div>
      )}

      {thread && (
        <AccountThread
          token={token} accountId={thread}
          fallbackName={summary?.conversations.find((c) => c.accountId === thread)?.name ?? 'Player'}
          onBack={() => { setThread(null); refresh(); }}
          onBlocked={() => { setThread(null); refresh(); }}
        />
      )}
    </div>,
    document.body
  );
}

function AccountThread({ token, accountId, fallbackName, onBack, onBlocked }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reporting, setReporting] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState(null);
  const endRef = useRef(null);

  const load = useCallback(() => {
    api(`/me/messages/with/${accountId}`, { token })
      .then((d) => { setData(d); setError(null); })
      .catch(setError);
  }, [accountId, token]);
  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, 10000);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [data]);

  const name = data?.counterpart?.name ?? fallbackName;

  const send = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true); setSendError(null);
    try {
      await api('/me/messages', { method: 'POST', token, body: { toAccountId: accountId, body: body.trim() } });
      setBody(''); load();
    } catch (ex) { setSendError(ex); }
    setBusy(false);
  };

  const block = () =>
    api('/me/messages/block', { method: 'POST', token, body: { accountId, blocked: true } })
      .then(onBlocked);

  return (
    <div className="hw-msg-body hw-msg-thread">
      <div className="hw-msg-thread-head">
        <button className="btn small" onClick={onBack}>← Inbox</button>
        <strong>
          <a href={`#/players/${accountId}`} title="View player profile"
            style={{ color: 'inherit' }}>{name}</a>
          {data?.counterpart?.dev ? <DevBadge /> : null}
          {data?.counterpart?.og ? <OgBadge /> : null}
        </strong>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <button className="btn small" onClick={() => setReporting(true)} title="Report this player to the admins">⚠ Report</button>
          <button className="btn danger small" onClick={block}>Block</button>
        </span>
      </div>
      {reporting && (
        <ReportDialog
          token={token} accountId={accountId} airlineName={name}
          onClose={() => setReporting(false)}
        />
      )}
      <div className="hw-msg-scroll">
        {error && !data ? <p className="hw-msg-empty error">{String(error.message || error)}</p> :
         !data ? <p className="hw-msg-empty">Loading…</p> :
          data.messages.length === 0 ? <p className="hw-msg-empty">No messages yet, you're starting this conversation.</p> :
          data.messages.map((m) => (
            <div key={m.id} className={`hw-msg-bubble ${m.fromMe ? 'mine' : ''}`}>
              <div>{m.body}</div>
              <div className="hw-msg-time">{fmtTime(m.at)}</div>
            </div>
          ))}
        <div ref={endRef} />
      </div>
      <form className="hw-msg-composer" onSubmit={send}>
        {sendError && <p className="error">{String(sendError.message || sendError)}</p>}
        <div className="row">
          <textarea
            rows={2} maxLength={1000} placeholder={`Message ${name}…`}
            value={body} onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(e); }}
          />
          <button className="btn primary small" type="submit" disabled={busy || !body.trim()}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
