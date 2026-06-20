import { useState } from 'react';
import AirportDetail from './AirportDetail.jsx';
import { Glyph } from './Icons.jsx';

/**
 * Renders an airport code (or custom children) as a clickable element that
 * opens an AirportDetail modal overlay. Drop in anywhere an airport code appears.
 *
 * Usage:
 *   <AirportLink code="JFK" />
 *   <AirportLink code="LHR" style={{ fontSize: 22, fontWeight: 700 }}>LHR</AirportLink>
 */
export default function AirportLink({ code, children, style }) {
  const [open, setOpen] = useState(false);

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); }
    if (e.key === 'Escape') setOpen(false);
  }

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        onClick={e => { e.stopPropagation(); setOpen(true); }}
        onKeyDown={handleKeyDown}
        title={`View ${code} details`}
        style={{
          cursor: 'pointer',
          borderBottom: '1px dashed rgba(139,148,158,0.5)',
          transition: 'border-color 0.15s',
          ...style,
        }}
        onMouseEnter={e => e.currentTarget.style.borderBottomColor = 'var(--accent)'}
        onMouseLeave={e => e.currentTarget.style.borderBottomColor = 'rgba(139,148,158,0.5)'}
      >
        {children ?? code}
      </span>

      {open && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(3px)',
            display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
            padding: '24px 16px', overflowY: 'auto',
          }}
          onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', width: '100%', maxWidth: 960,
            padding: 24, position: 'relative', boxShadow: 'var(--shadow)',
            marginTop: 0, marginBottom: 24,
          }}>
            {/* Close button */}
            <button
              onClick={() => setOpen(false)}
              className="btn btn-ghost"
              style={{ position: 'absolute', top: 12, right: 12, padding: '4px 10px', fontSize: 16, zIndex: 1 }}
            >
              <Glyph e="✕" />
            </button>
            <AirportDetail code={code} onBack={() => setOpen(false)} backLabel="← Close" />
          </div>
        </div>
      )}
    </>
  );
}
