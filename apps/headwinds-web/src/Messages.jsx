// In-game messaging — a Messages button (with unread badge) for the
// multiplayer top bar, opening a slide-over inbox with two channels:
//   Direct    airline-to-airline DMs, threaded, with block/unblock
//   Alliance  your alliance's shared board
// Headwinds-owned (not synced from Tailwinds) — safe to evolve freely.
import { useState, useEffect, useCallback, useRef } from 'react';
import { authedApi } from './authedApi.js';
import { ReportDialog } from './Report.jsx';
import OgBadge, { DevBadge } from './OgBadge.jsx';

const fmtTime = (t) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

export default function MessagesWidget({ worldId, token }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  const loadSummary = useCallback(() => {
    authedApi(`/worlds/${worldId}/messages`, { token })
      .then((d) => { setSummary(d); setError(null); })
      .catch(setError);
  }, [worldId, token]);

  useEffect(() => {
    loadSummary();
    const t = setInterval(loadSummary, 20000);
    return () => clearInterval(t);
  }, [loadSummary]);

  const unread = summary?.totalUnread ?? 0;

  return (
    <>
      <button className="hw-msg-btn" onClick={() => setOpen((o) => !o)} title="Messages">
        ✉ Messages
        {unread > 0 && <span className="hw-msg-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && summary && (
        <MessagesDrawer
          worldId={worldId} token={token} summary={summary}
          refresh={loadSummary} error={error}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function MessagesDrawer({ worldId, token, summary, refresh, error, onClose }) {
  const [tab, setTab] = useState('direct'); // 'direct' | 'alliance'
  const [thread, setThread] = useState(null); // airlineId of open DM thread
  const [composeTo, setComposeTo] = useState('');

  const openThread = (airlineId) => { setThread(airlineId); setTab('direct'); };

  return (
    <div className="hw-msg-drawer">
      <div className="hw-msg-head">
        <div className="hw-msg-tabs">
          <button className={tab === 'direct' ? 'active' : ''} onClick={() => { setTab('direct'); setThread(null); }}>
            Direct
          </button>
          <button className={tab === 'alliance' ? 'active' : ''} onClick={() => setTab('alliance')}
            disabled={!summary.alliance} title={summary.alliance ? '' : 'Join an alliance to use its board'}>
            Alliance{summary.alliance?.unread > 0 ? ` (${summary.alliance.unread})` : ''}
          </button>
        </div>
        <button className="hw-msg-close" onClick={onClose} title="Close">×</button>
      </div>
      {error && <p className="error" style={{ padding: '0 14px' }}>{String(error.message || error)}</p>}

      {tab === 'direct' && !thread && (
        <div className="hw-msg-body">
          <div className="hw-msg-compose-new">
            <select value={composeTo} onChange={(e) => setComposeTo(e.target.value)}>
              <option value="">New message to…</option>
              {summary.airlines.map((a) => (
                // <option> is text-only — badges render as plain markers here.
                <option key={a.id} value={a.id}>{a.name}{a.dev ? ' 🛠DEV' : ''}{a.og ? ' ✈OG' : ''} ({a.hub})</option>
              ))}
            </select>
            <button className="btn small" disabled={!composeTo}
              onClick={() => { openThread(composeTo); setComposeTo(''); }}>
              Open
            </button>
          </div>

          {summary.conversations.length === 0 ? (
            <p className="hw-msg-empty">No conversations yet. Every rival in this world is a real person — say hello, or talk some trash.</p>
          ) : summary.conversations.map((c) => (
            <button key={c.airlineId} className="hw-msg-convo" onClick={() => openThread(c.airlineId)}>
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

          {summary.blocked.length > 0 && (
            <div className="hw-msg-blocked">
              <div className="hw-msg-section">Blocked</div>
              {summary.blocked.map((b) => (
                <div key={b.airlineId} className="hw-msg-blocked-row">
                  <span>{b.name}</span>
                  <button className="btn small" onClick={() =>
                    authedApi(`/worlds/${worldId}/messages/block`, {
                      method: 'POST', token, body: { airlineId: b.airlineId, blocked: false },
                    }).then(refresh)
                  }>Unblock</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'direct' && thread && (
        <DmThread
          worldId={worldId} token={token} airlineId={thread}
          name={summary.conversations.find((c) => c.airlineId === thread)?.name
            ?? summary.airlines.find((a) => a.id === thread)?.name ?? 'Airline'}
          og={(summary.conversations.find((c) => c.airlineId === thread)?.og
            ?? summary.airlines.find((a) => a.id === thread)?.og) === true}
          dev={(summary.conversations.find((c) => c.airlineId === thread)?.dev
            ?? summary.airlines.find((a) => a.id === thread)?.dev) === true}
          onBack={() => { setThread(null); refresh(); }}
          onBlocked={() => { setThread(null); refresh(); }}
        />
      )}

      {tab === 'alliance' && summary.alliance && (
        <AllianceBoard worldId={worldId} token={token} onSeen={refresh} />
      )}
    </div>
  );
}

function Composer({ placeholder, disabled, onSend }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const send = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true); setErr(null);
    try { await onSend(body.trim()); setBody(''); }
    catch (ex) { setErr(ex); }
    setBusy(false);
  };
  return (
    <form className="hw-msg-composer" onSubmit={send}>
      {err && <p className="error">{String(err.message || err)}</p>}
      <div className="row">
        <textarea
          rows={2} maxLength={1000} placeholder={placeholder}
          value={body} onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(e); }}
        />
        <button className="btn primary small" type="submit" disabled={busy || disabled || !body.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}

function DmThread({ worldId, token, airlineId, name, og = false, dev = false, onBack, onBlocked }) {
  const [messages, setMessages] = useState(null);
  const [error, setError] = useState(null);
  const [reporting, setReporting] = useState(false);
  const endRef = useRef(null);

  const load = useCallback(() => {
    authedApi(`/worlds/${worldId}/messages/with/${airlineId}`, { token })
      .then((d) => { setMessages(d.messages); setError(null); })
      .catch(setError);
  }, [worldId, token, airlineId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const block = () => {
    if (!window.confirm(`Block ${name}? Their messages will no longer reach you.`)) return;
    authedApi(`/worlds/${worldId}/messages/block`, {
      method: 'POST', token, body: { airlineId, blocked: true },
    }).then(onBlocked);
  };

  return (
    <div className="hw-msg-body hw-msg-thread">
      <div className="hw-msg-thread-head">
        <button className="btn small" onClick={onBack}>← Inbox</button>
        <strong>{name}{dev ? <DevBadge /> : null}{og ? <OgBadge /> : null}</strong>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <button className="btn small" onClick={() => setReporting(true)} title="Report this player to the admins">⚠ Report</button>
          <button className="btn danger small" onClick={block}>Block</button>
        </span>
      </div>
      {reporting && (
        <ReportDialog
          worldId={worldId} token={token} airlineId={airlineId} airlineName={name}
          onClose={() => setReporting(false)}
        />
      )}
      <div className="hw-msg-scroll">
        {error && !messages ? <p className="hw-msg-empty error">{String(error.message || error)}</p> :
         !messages ? <p className="hw-msg-empty">Loading…</p> :
          messages.length === 0 ? <p className="hw-msg-empty">No messages yet — you're starting this conversation.</p> :
          messages.map((m) => (
            <div key={m.id} className={`hw-msg-bubble ${m.fromMe ? 'mine' : ''}`}>
              <div>{m.body}</div>
              <div className="hw-msg-time">{fmtTime(m.at)}</div>
            </div>
          ))}
        <div ref={endRef} />
      </div>
      <Composer
        placeholder={`Message ${name}…`}
        onSend={async (body) => {
          await authedApi(`/worlds/${worldId}/messages`, {
            method: 'POST', token, body: { toAirlineId: airlineId, body },
          });
          load();
        }}
      />
    </div>
  );
}

function AllianceBoard({ worldId, token, onSeen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const endRef = useRef(null);
  const seenRef = useRef(false);

  const load = useCallback(() => {
    authedApi(`/worlds/${worldId}/messages/alliance`, { token })
      .then((d) => {
        setData(d); setError(null);
        // Mark the board seen (refresh parent unread) once on open, not every poll.
        if (!seenRef.current) { seenRef.current = true; onSeen(); }
      })
      .catch(setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId, token]);

  useEffect(() => {
    load();
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [data]);

  if (!data) return (
    <div className="hw-msg-body">
      <p className="hw-msg-empty">{error ? String(error.message || error) : 'Loading…'}</p>
    </div>
  );

  return (
    <div className="hw-msg-body hw-msg-thread">
      <div className="hw-msg-thread-head"><strong>🤝 {data.alliance.name}</strong></div>
      <div className="hw-msg-scroll">
        {data.messages.length === 0
          ? <p className="hw-msg-empty">Nothing on the board yet. Coordinate routes, plan a fare war, or just chat.</p>
          : data.messages.map((m) => (
            <div key={m.id} className={`hw-msg-bubble ${m.fromMe ? 'mine' : ''}`}>
              {!m.fromMe && <div className="hw-msg-from">{m.from}{m.fromDev ? <DevBadge /> : null}{m.fromOG ? <OgBadge /> : null}</div>}
              <div>{m.body}</div>
              <div className="hw-msg-time">{fmtTime(m.at)}</div>
            </div>
          ))}
        <div ref={endRef} />
      </div>
      <Composer
        placeholder="Message your alliance…"
        onSend={async (body) => {
          await authedApi(`/worlds/${worldId}/messages/alliance`, { method: 'POST', token, body: { body } });
          load();
        }}
      />
    </div>
  );
}
