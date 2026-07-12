import { useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { Glyph } from './Icons.jsx';

/**
 * Save / apply / delete cabin configuration templates.
 * Templates are per aircraft type — only templates matching `typeId` are shown.
 *
 * Props:
 *   typeId        — aircraft type the dialog is configuring
 *   currentConfig — { firstClass, businessClass, premiumEconomy, economy, seatQuality, serviceQuality }
 *   onApply(config) — called with the template's config when the player applies one
 */
export default function CabinTemplatePicker({ typeId, currentConfig, onApply }) {
  const { state, dispatch } = useGame();
  const templates = (state.cabinTemplates ?? []).filter(t => t.typeId === typeId);

  const [saving, setSaving]         = useState(false);
  const [name, setName]             = useState('');
  const [selectedId, setSelectedId] = useState('');

  const selected = templates.find(t => t.id === selectedId) ?? null;

  function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    dispatch({ type: 'SAVE_CABIN_TEMPLATE', name: trimmed, typeId, config: currentConfig });
    setName('');
    setSaving(false);
  }

  function summarize(cfg) {
    const parts = [
      cfg.firstClass     > 0 && `${cfg.firstClass}F`,
      cfg.businessClass  > 0 && `${cfg.businessClass}J`,
      cfg.premiumEconomy > 0 && `${cfg.premiumEconomy}W`,
      `${cfg.economy ?? 0}Y`,
    ].filter(Boolean).join('/');
    const qual = (cfg.seatQuality && cfg.seatQuality !== 'basic')
      ? ` · ${cfg.seatQuality} seats`
      : '';
    return parts + qual;
  }

  return (
    <div style={{
      padding: '8px 10px', marginBottom: 12, borderRadius: 7,
      border: '1px dashed var(--border)', background: 'var(--surface2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>
          <Glyph e="📋" /> Templates
        </span>

        {templates.length > 0 ? (
          <>
            <select
              value={selectedId}
              onChange={e => setSelectedId(e.target.value)}
              style={{
                flex: 1, minWidth: 140, padding: '5px 8px', fontSize: 12, borderRadius: 5,
                border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer',
              }}
            >
              <option value="">Choose a template…</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name} — {summarize(t.config)}</option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              style={{ padding: '4px 12px', fontSize: 12 }}
              disabled={!selected}
              onClick={() => selected && onApply({ ...selected.config })}
            >
              Apply
            </button>
            {selected && (
              <button
                className="btn btn-ghost"
                title="Delete template"
                style={{ padding: '4px 8px', fontSize: 12, color: 'var(--red)' }}
                onClick={() => { dispatch({ type: 'DELETE_CABIN_TEMPLATE', templateId: selected.id }); setSelectedId(''); }}
              >
                <Glyph e="🗑" />
              </button>
            )}
          </>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text-dim)', flex: 1 }}>
            No saved templates for this aircraft type yet.
          </span>
        )}

        {!saving && (
          <button
            className="btn btn-ghost"
            style={{ padding: '4px 10px', fontSize: 12, flexShrink: 0 }}
            onClick={() => setSaving(true)}
          >
            + Save current
          </button>
        )}
      </div>

      {saving && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
          <input
            autoFocus
            type="text"
            placeholder="Template name (e.g. Premium Long-haul)"
            value={name}
            maxLength={40}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setSaving(false); }}
            style={{
              flex: 1, padding: '5px 8px', fontSize: 12, borderRadius: 5,
              border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
            }}
          />
          <button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: 12 }} disabled={!name.trim()} onClick={handleSave}>
            Save
          </button>
          <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => { setSaving(false); setName(''); }}>
            Cancel
          </button>
        </div>
      )}
      {saving && templates.some(t => t.name.toLowerCase() === name.trim().toLowerCase()) && (
        <div style={{ fontSize: 10, color: 'var(--yellow)', marginTop: 4 }}>
          A template with this name exists for this type — saving will overwrite it.
        </div>
      )}
    </div>
  );
}
