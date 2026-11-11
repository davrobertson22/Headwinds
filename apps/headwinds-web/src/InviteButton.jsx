// "Invite" — shares a world: native share sheet on phones, copy on desktop,
// and a selectable link as the last resort. Given `world` (the lobby already
// has it) or `worldId` (the in-game top bar doesn't know the world's name or
// visibility, so it looks the world up on click — one request, only on use).
import { useState, useRef, useEffect } from 'react';
import { api, readableError } from './api.js';
import { shareWorldInvite, shareAirlinePage } from './invite.js';

const TOPBAR_BTN = { background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit' };

// `airlineId` (top bar only) adds a second button that shares the player's own
// airline page instead of the world — /worlds/:world/airlines/:airline, which
// unfurls as a card with their tail and rank. Public worlds only.
export default function InviteButton({ world, worldId, token, variant = 'card', airlineId = null }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = async (what) => {
    if (busy) return;
    setBusy(true);
    try {
      let w = world;
      if (!w) w = (await api(`/worlds/${worldId}`, { token }))?.world;
      if (!w) throw new Error('World not found');
      const r = what === 'airline' ? await shareAirlinePage(w, airlineId) : await shareWorldInvite(w);
      r.what = what;
      setResult(r);
      clearTimeout(timer.current);
      if (r.kind !== 'manual') timer.current = setTimeout(() => setResult(null), 4000);
    } catch (e) {
      setResult({ kind: 'error', message: readableError(e) });
    } finally {
      setBusy(false);
    }
  };

  const onClick = () => run('world');

  const note = result?.kind === 'private' ? 'Private worlds have no public pages'
    : result?.kind === 'copied' ? (result.what === 'airline' ? 'Airline page link copied' : 'Invite link copied')
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
        {airlineId && (
          <button className="hw-lobby-link" style={TOPBAR_BTN} onClick={() => run('airline')} disabled={busy}
            title="Share your airline's public page: its route map, fleet and rank">✈ <span className="hw-btn-label">Share airline</span></button>
        )}
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
