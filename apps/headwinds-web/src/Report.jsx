// Report a player — a small modal used from both the Rivals leaderboard (App.jsx)
// and the Messages drawer (Messages.jsx). Posts to /worlds/:id/report; the admin
// reviews the queue in the moderation panel and may ban the reported account.
// Headwinds-owned (not synced from Tailwinds) — safe to evolve freely.
import { useState } from 'react';
import { api } from './api.js';

// Kept in sync with REPORT_CATEGORIES in the server (routes/reports.mjs).
export const REPORT_CATEGORIES = [
  { value: 'HARASSMENT', label: 'Harassment or abuse' },
  { value: 'CHEATING', label: 'Cheating or exploiting a bug' },
  { value: 'OFFENSIVE_NAME', label: 'Offensive airline name' },
  { value: 'SPAM', label: 'Spam' },
  { value: 'OTHER', label: 'Something else' },
];

export function ReportDialog({ worldId, token, airlineId, airlineName, onClose }) {
  const [category, setCategory] = useState('HARASSMENT');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const submit = async (ev) => {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      await api(`/worlds/${worldId}/report`, {
        method: 'POST', token,
        body: { airlineId, category, ...(details.trim() ? { details: details.trim() } : {}) },
      });
      setDone(true);
    } catch (e) { setError(e); }
    setBusy(false);
  };

  return (
    <div className="hw-modal-overlay" onClick={onClose}>
      <div className="hw-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hw-modal-head">
          <h3>Report {airlineName || 'this airline'}</h3>
          <button className="hw-modal-close" onClick={onClose} title="Close">×</button>
        </div>

        {done ? (
          <div className="hw-modal-body">
            <p>Thanks — this report has been sent to the admins for review. You won't
            hear back directly, but we look at every report.</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <form className="hw-modal-body" onSubmit={submit}>
            <label>Reason
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {REPORT_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <label>Details <span className="muted small">(optional, helps us investigate)</span>
              <textarea
                rows={4} maxLength={1000}
                placeholder="What happened? Include anything that helps — e.g. what they said, or what looks wrong."
                value={details} onChange={(e) => setDetails(e.target.value)}
              />
            </label>
            {error && <p className="error">{String(error.message || error)}</p>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" type="button" onClick={onClose}>Cancel</button>
              <button className="btn danger" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Submit report'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
