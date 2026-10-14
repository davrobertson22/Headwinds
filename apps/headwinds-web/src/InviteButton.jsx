// "Invite" — shares a world: native share sheet on phones, copy on desktop,
// and a selectable link as the last resort. Given `world` (the lobby already
// has it) or `worldId` (the in-game top bar doesn't know the world's name or
// visibility, so it looks the world up on click — one request, only on use).
import { useState, useRef, useEffect } from 'react';
import { api, readableError } from './api.js';
import { shareWorldInvite } from './invite.js';

const TOPBAR_BTN = { background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit' };

export default function InviteButton({ world, worldId, token, variant = 'card' }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let w = world;
      if (!w) w = (await api(`/worlds/${worldId}`, { token }))?.world;
      if (!w) throw new Error('World not found');
      const r = await shareWorldInvite(w);
      setResult(r);
      clearTimeout(timer.current);
      if (r.kind !== 'manual') timer.current = setTimeout(() => setResult(null), 4000);
    } catch (e) {
      setResult({ kind: 'error', message: readableError(e) });
    } finally {
      setBusy(false);
    }
  };

  const note = result?.kind === 'copied' ? 'Invite link copied'
    : result?.kind === 'shared' ? 'Shared'
    : result?.kind === 'error' ? result.message
    : null;

  const manual = result?.kind === 'manual' && (
    <input
      readOnly value={result.url} onFocus={(e) => e.target.select()} autoFocus
      aria-label="Invite link" style={{ fontSize: 12, width: variant === 'topbar' ? 180 : 320, maxWidth: '60vw' }}
    />
  );

  if (variant === 'topbar') {
    return (
      <>
        <button className="hw-lobby-link" style={TOPBAR_BTN} onClick={onClick} disabled={busy}
          title="Invite a friend to this world">🔗 <span className="hw-btn-label">Invite</span></button>
        {note && <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{note}</span>}
        {manual}
      </>
    );
  }
  return (
    <span className="row" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button className="btn small" type="button" onClick={onClick} disabled={busy}
        title="Send a friend a link to this world">🔗 Invite a friend</button>
      {note && <span className="muted small">{note}</span>}
      {manual}
    </span>
  );
}
