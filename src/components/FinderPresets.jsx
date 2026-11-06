import { useState } from 'react';
import InfoTip from './InfoTip.jsx';
import {
  loadPresets, savePreset, deletePreset, sameSearch, MAX_PRESETS, MAX_NAME,
} from '../utils/finderPresets.js';

/**
 * The preset row above a Route Finder's controls (utils/finderPresets.js).
 *
 *   panel          'passenger' | 'freight'
 *   current        the finder's live search (any extra fields are ignored)
 *   onApply(p)     set the finder to preset p; may return a note to show
 *                  (e.g. the preset's aircraft isn't flying in this world yet)
 *   suggestedName  what "Save this search" offers as the name
 *
 * A chip lights up when the search below matches it exactly, so moving one
 * control off a preset visibly leaves it. Saving under an existing name
 * overwrites that preset — which is also how you update one.
 */
export default function FinderPresets({ panel, current, onApply, suggestedName = '', accent = 'var(--accent)' }) {
  const [presets, setPresets] = useState(() => loadPresets(panel));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState(null);

  const active = presets.find(p => sameSearch(panel, p.search, current)) ?? null;
  const full = presets.length >= MAX_PRESETS;
  const overwriting = naming && presets.some(p => p.name.toLowerCase() === name.trim().toLowerCase());

  function apply(p) {
    const msg = onApply?.(p);
    setNote(typeof msg === 'string' ? msg : null);
  }
  function startSave() {
    setName(active?.name ?? suggestedName);
    setNaming(true);
    setNote(null);
  }
  function commit() {
    const list = savePreset(panel, name, current);
    if (!list) return;
    setPresets(list);
    setNaming(false);
  }
  function remove(p) {
    setPresets(deletePreset(panel, p.name));
    setNote(null);
  }

  const chip = (on) => ({
    display: 'inline-flex', alignItems: 'center', borderRadius: 999, fontSize: 12,
    border: `1px solid ${on ? accent : 'var(--border)'}`,
    background: on ? 'var(--accent-dim)' : 'transparent',
    color: on ? 'var(--text)' : 'var(--text-muted)',
  });
  const bare = { background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit' };

  return (
    <div data-finder-presets={panel} style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="form-label" style={{ margin: 0, marginRight: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
          Presets
          <InfoTip text="Save the search below — aircraft, distance band, region, sort and filters — and bring it back in one click. The origin isn't saved, so a preset works from whichever airport you search from. Presets are kept in this browser and carry over to every world you play in it. Saving under an existing name updates that preset." />
        </span>

        {presets.map(p => {
          const on = active?.name === p.name;
          return (
            <span key={p.name} data-finder-preset={p.name} data-active={on ? '' : undefined} style={chip(on)}>
              <button type="button" style={{ ...bare, padding: '3px 4px 3px 10px', fontWeight: on ? 600 : 400 }}
                      title={on ? 'This search' : `Search with “${p.name}”`} onClick={() => apply(p)}>
                {p.name}
              </button>
              <button type="button" aria-label={`Delete preset ${p.name}`} title="Delete preset"
                      style={{ ...bare, padding: '3px 8px 3px 4px', color: 'var(--text-dim)' }} onClick={() => remove(p)}>
                ×
              </button>
            </span>
          );
        })}

        {naming ? (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              className="form-input" autoFocus maxLength={MAX_NAME} value={name} placeholder="Preset name"
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setNaming(false); }}
              style={{ width: 220, fontSize: 12, padding: '4px 8px' }}
            />
            <button type="button" className="btn btn-primary" style={{ fontSize: 12, padding: '4px 12px' }}
                    disabled={!name.trim() || (full && !overwriting)} onClick={commit}>
              {overwriting ? 'Update' : 'Save'}
            </button>
            <button type="button" className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}
                    onClick={() => setNaming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" data-save-preset="" className="btn btn-ghost" style={{ fontSize: 12, padding: '3px 10px' }}
                  onClick={startSave}>
            + Save this search
          </button>
        )}

        {presets.length === 0 && !naming && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            Set up a search you use often, then save it here.
          </span>
        )}
      </div>
      {naming && full && !overwriting && (
        <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 4 }}>
          {MAX_PRESETS} presets is the limit — delete one, or save under an existing name to update it.
        </div>
      )}
      {note && <div data-preset-note="" style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 4 }}>{note}</div>}
    </div>
  );
}
