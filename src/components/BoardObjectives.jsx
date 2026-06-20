import { useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { OBJECTIVE_TEMPLATES } from '../data/objectives.js';
import { formatMoney } from '../utils/simulation.js';
import { Glyph } from './Icons.jsx';

// ── helpers ───────────────────────────────────────────────────────────────────

function phaseLabel(phase) {
  return phase === 'strategic' ? 'Year 1 — Strategic' : 'Year 2+ — Financial';
}

function phaseColor(phase) {
  return phase === 'strategic' ? 'var(--accent)' : 'var(--yellow)';
}

// ── component ─────────────────────────────────────────────────────────────────

export default function BoardObjectives() {
  const { state } = useGame();
  const [collapsed, setCollapsed] = useState(false);

  const objectives = state.objectives ?? [];

  // Hidden when objectives are disabled at setup, or not yet initialized
  if (!state.objectivesEnabled || objectives.length === 0) return null;

  // Merge template data with completion state
  const merged = OBJECTIVE_TEMPLATES.map(tmpl => {
    const stateObj = objectives.find(o => o.id === tmpl.id) ?? { completed: false };
    return { ...tmpl, ...stateObj };
  });

  const strategic = merged.filter(o => o.phase === 'strategic');
  const financial = merged.filter(o => o.phase === 'financial');
  const empire    = merged.filter(o => o.phase === 'empire');

  const totalCompleted = merged.filter(o => o.completed).length;
  const totalRewardEarned = merged
    .filter(o => o.completed)
    .reduce((s, o) => s + (o.reward ?? 0), 0);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      {/* Header */}
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setCollapsed(v => !v)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}><Glyph e="🏅" /> Board Objectives</span>
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12,
            background: 'rgba(56,139,253,0.12)', color: 'var(--accent)',
            border: '1px solid rgba(56,139,253,0.3)',
          }}>
            {totalCompleted} / {merged.length} complete
          </span>
          {totalRewardEarned > 0 && (
            <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>
              +{formatMoney(totalRewardEarned)} earned
            </span>
          )}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{collapsed ? '▸' : '▾'}</span>
      </div>

      {!collapsed && (
        <div style={{ marginTop: 14 }}>
          <ObjectiveGroup label="Year 1 — Strategic" objectives={strategic} color="var(--accent)" />
          <ObjectiveGroup label="Year 2+ — Financial" objectives={financial} color="var(--yellow)" style={{ marginTop: 14 }} />
          {empire.length > 0 && (
            <ObjectiveGroup label="Empire — Endgame" objectives={empire} color="var(--green)" style={{ marginTop: 14 }} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Objective group ───────────────────────────────────────────────────────────

function ObjectiveGroup({ label, objectives, color, style }) {
  const completed = objectives.filter(o => o.completed).length;

  return (
    <div style={style}>
      {/* Group header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
        paddingBottom: 6, borderBottom: '1px solid var(--border-subtle)',
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {label}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {completed}/{objectives.length}
        </span>
        {/* Progress bar */}
        <div style={{ flex: 1, height: 4, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${objectives.length > 0 ? (completed / objectives.length) * 100 : 0}%`,
            background: color,
            borderRadius: 2,
            transition: 'width 0.4s ease',
          }} />
        </div>
      </div>

      {/* Objectives grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: 8,
      }}>
        {objectives.map(obj => (
          <ObjectiveCard key={obj.id} obj={obj} groupColor={color} />
        ))}
      </div>
    </div>
  );
}

// ── Individual objective card ─────────────────────────────────────────────────

function ObjectiveCard({ obj, groupColor }) {
  const done = obj.completed;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '9px 11px',
      borderRadius: 'var(--radius)',
      background: done ? 'rgba(56,210,150,0.06)' : 'var(--surface2)',
      border: `1px solid ${done ? 'rgba(56,210,150,0.25)' : 'var(--border-subtle)'}`,
      opacity: done ? 1 : 0.9,
      transition: 'all 0.2s',
    }}>
      {/* Icon / check */}
      <div style={{
        lineHeight: 1,
        flexShrink: 0,
        display: 'inline-flex',
        color: done ? 'var(--green)' : 'var(--text-muted)',
        filter: done ? 'none' : 'opacity(0.8)',
      }}>
        <Glyph e={done ? '✅' : obj.icon} size={18} />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12,
          fontWeight: 700,
          color: done ? 'var(--green)' : 'var(--text)',
          marginBottom: 2,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {obj.title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.3, marginBottom: 4 }}>
          {obj.desc}
        </div>
        {done ? (
          <div style={{ fontSize: 10, color: 'var(--green)', fontWeight: 600 }}>
            <Glyph e="✓" /> Completed W{obj.completedWeek}/{obj.completedYear}
          </div>
        ) : (
          <div style={{ fontSize: 10, color: groupColor, fontWeight: 600 }}>
            +{formatMoney(obj.reward)} reward
          </div>
        )}
      </div>
    </div>
  );
}
