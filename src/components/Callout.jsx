import { useState } from 'react';

/**
 * One-time contextual hints for systems the tour never mentions.
 *
 * The onboarding tour covers seven things. The game has about twenty, and the
 * ones it leaves out are not minor: freight is a whole parallel economy behind
 * a toggle, heavy checks ground an aircraft at +50% cost if you ignore them,
 * and the bulk tools that make a 40-route airline manageable are invisible
 * until you happen to tick a checkbox. The Wiki documents all of it and nobody
 * reads a wiki before they have the problem.
 *
 * So: teach at the moment the player first meets the system, once, dismissibly,
 * rather than lengthening a modal they click through in the first two minutes.
 *
 * Each hint is keyed independently — dismissing the freight hint does not hide
 * the maintenance hint — and the version suffix lets a reworded hint show once
 * more without resetting the others. Storage failures are swallowed: a hint
 * that cannot remember it was dismissed is a nuisance, not a broken game, and
 * private-mode browsers throw on setItem.
 */

const PREFIX = 'bbae_hint_';

function seen(id) {
  try { return localStorage.getItem(PREFIX + id) === '1'; } catch (_) { return false; }
}

function markSeen(id) {
  try { localStorage.setItem(PREFIX + id, '1'); } catch (_) {}
}

/**
 * A dismissible one-time hint.
 *
 * @param {string}  id     stable key, versioned by the caller (e.g. 'freight_v1')
 * @param {boolean} when   show only when this is true — the caller's "the player
 *                         has just met this system" test. Defaults to true.
 * @param {string}  icon   leading glyph
 * @param {string}  title  short headline
 * @param {node}    children  body copy
 */
export default function Callout({ id, when = true, icon = '💡', title, children }) {
  // Read storage once on mount rather than on every render: a hint dismissed in
  // another tab should not vanish mid-sentence under the player's cursor.
  const [dismissed, setDismissed] = useState(() => seen(id));
  if (!when || dismissed) return null;

  return (
    <div
      className="hint-callout"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 12px', marginBottom: 12,
        background: 'var(--surface2)',
        border: '1px solid var(--border)',
        borderLeft: '3px solid var(--accent)',
        borderRadius: 'var(--radius)',
        fontSize: 12.5, lineHeight: 1.6,
      }}
    >
      <span style={{ fontSize: 15, flexShrink: 0, lineHeight: 1.2 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && (
          <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>{title}</div>
        )}
        <div style={{ color: 'var(--text-muted)' }}>{children}</div>
      </div>
      <button
        type="button"
        className="btn btn-ghost"
        title="Got it — don't show this again"
        onClick={() => { markSeen(id); setDismissed(true); }}
        style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0, color: 'var(--text-dim)' }}
      >
        Got it
      </button>
    </div>
  );
}
