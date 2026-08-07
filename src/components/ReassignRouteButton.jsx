import { useState } from 'react';
import { useGame, reassignCompatibility } from '../store/GameContext.jsx';
import { getAircraftType } from '../data/aircraft.js';
import { Glyph } from './Icons.jsx';
import { isReserve, reserveCoverageSummary } from '../data/reserve.js';
import { ReserveBadge } from './ReserveNotice.jsx';

/**
 * Move ONE route onto a different aircraft.
 *
 * Before this, the only way to change a route's equipment was to close it and
 * open it again: the launch cost charged twice, and the pair dropped back to
 * week 0 of its 16-week maturity ramp. So the routine airline move — up-gauge
 * the pair that's spilling passengers, hand the thin one to something smaller —
 * was priced like a mistake, and players who did it anyway only found out about
 * the ramp reset weeks later when demand hadn't come back.
 *
 * The picker lists every tail with a verdict from the engine's own
 * `reassignCompatibility`, so an aircraft that can't take the route is shown
 * greyed out WITH the reason (out of range, wrong type, no spare block hours)
 * rather than silently missing. Aircraft already flying are eligible — that is
 * the common case; the block-hour check counts their existing schedule.
 */
export default function ReassignRouteButton({ route }) {
  const { state, dispatch } = useGame();
  const [open, setOpen] = useState(false);

  const ops = [...(state.routes ?? []), ...(state.cargoRoutes ?? [])];

  const candidates = (state.fleet ?? [])
    .filter(a => a.id !== route.aircraftId && a.status !== 'retired')
    .map(a => ({
      a,
      type: getAircraftType(a.typeId),
      compat: reassignCompatibility(state, route.id, a.id),
    }))
    // Eligible first, then non-reserves, then by name — a standby cover should
    // never be the plane the list puts under your cursor by accident.
    .sort((x, y) => (Number(y.compat.ok) - Number(x.compat.ok))
      || (Number(isReserve(x.a)) - Number(isReserve(y.a)))
      || (x.a.name ?? '').localeCompare(y.a.name ?? ''));

  const eligible = candidates.filter(c => c.compat.ok).length;

  function move(toAircraftId) {
    dispatch({ type: 'REASSIGN_ROUTE', routeId: route.id, toAircraftId });
    setOpen(false);
  }

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className="btn"
        style={{ padding: '3px 8px', fontSize: 11, background: 'var(--surface3)', border: '1px solid var(--border)' }}
        title={eligible > 0
          ? 'Move this route to another aircraft — keeps its fares, ramp and season'
          : 'No other aircraft can take this route'}
        onClick={() => setOpen(v => !v)}
      >
        <Glyph e="🔀" /> Move
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
          />
          <div
            role="menu"
            style={{
              position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 41,
              minWidth: 260, maxHeight: 320, overflowY: 'auto',
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', boxShadow: '0 12px 32px rgba(0,0,0,.45)',
              padding: 6, textAlign: 'left',
            }}
          >
            <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.05em', padding: '4px 8px 6px' }}>
              Move {route.origin}–{route.destination} to
            </div>
            {candidates.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 8px' }}>
                No other aircraft in the fleet.
              </div>
            )}
            {candidates.map(({ a, type, compat }) => (
              <button
                key={a.id}
                role="menuitem"
                disabled={!compat.ok}
                onClick={() => compat.ok && move(a.id)}
                title={compat.ok ? 'Keeps this route’s fares, maturity and season' : compat.reason}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '5px 8px', border: 'none', borderRadius: 4,
                  background: 'transparent', font: 'inherit', fontSize: 12,
                  color: compat.ok ? 'var(--text)' : 'var(--text-dim)',
                  cursor: compat.ok ? 'pointer' : 'not-allowed',
                }}
              >
                <span style={{ fontWeight: 600 }}>{a.name}</span>
                <span style={{ color: 'var(--text-muted)' }}> · {type?.name ?? a.typeId}</span>
                {compat.ok && isReserve(a) && (
                  <span style={{ display: 'block', marginTop: 3 }}>
                    <ReserveBadge aircraft={a} />
                    <span style={{ display: 'block', fontSize: 10.5, color: 'var(--yellow)', marginTop: 2 }}>
                      Moving this route here ends its standby{(() => {
                        const cov = reserveCoverageSummary(a, state.fleet, ops);
                        return cov && cov.tails > 0
                          ? ` — it stops covering ${cov.tails} other ${type?.name ?? 'aircraft'}${cov.tails !== 1 ? 's' : ''} at ${cov.base}`
                          : '';
                      })()}.
                    </span>
                  </span>
                )}
                {!compat.ok && (
                  <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-dim)' }}>
                    {compat.reason}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
