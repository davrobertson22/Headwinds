import { useGame } from '../store/GameContext.jsx';
import { getAircraftType } from '../data/aircraft.js';
import { requestNav } from '../utils/navIntent.js';
import { idleTailsOfType } from '../../packages/engine/src/models/routeBatch.js';
import { Glyph } from './Icons.jsx';

/**
 * The way back from the Route Planner to the Route Finder.
 *
 * Plan → used to be a one-way door: the planner had no route back, and the
 * finder you returned to by hand had forgotten your search. Deploying a
 * delivery meant doing that once per tail (Discord, 2026-10-14). The finder now
 * remembers its search (utils/finderMemory.js); this bar is the other half — and
 * after a route opens it says how many of that type are still idle, which is the
 * number that decides whether there is a "next one" to go and find.
 *
 * `opened` is { origin, dest, typeId } for the route just opened, or null.
 */
export default function FinderReturnBar({ fromFinder, opened }) {
  const { state } = useGame();
  if (!fromFinder && !opened) return null;
  const type = opened ? getAircraftType(opened.typeId) : null;
  const idleLeft = type ? idleTailsOfType(state.fleet, type.id).length : 0;
  return (
    <div
      data-finder-return=""
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12,
        padding: '8px 12px', borderRadius: 'var(--radius)', fontSize: 13,
        background: opened ? 'rgba(56,211,159,0.08)' : 'var(--surface2)',
        border: `1px solid ${opened ? 'rgba(56,211,159,0.35)' : 'var(--border)'}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 200, color: 'var(--text-muted)' }}>
        {opened ? (
          <>
            <span style={{ color: 'var(--green)' }}><Glyph e="✓" size={12} /> Opened {opened.origin} → {opened.dest}.</span>
            {type && (
              <> {idleLeft > 0
                ? <><strong style={{ color: 'var(--text)' }}>{idleLeft}</strong> idle {type.name}{idleLeft !== 1 ? 's' : ''} still waiting for a route.</>
                : <>No idle {type.name}s left.</>}</>
            )}
          </>
        ) : (
          <>From the Route Finder — your search is kept.</>
        )}
      </div>
      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => requestNav('finder')}>
        <Glyph e="🔍" size={12} /> {opened && idleLeft > 0 ? 'Find the next route' : 'Back to Route Finder'}
      </button>
    </div>
  );
}
