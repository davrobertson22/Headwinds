import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
 *
 * WHY THE MENU IS PORTALLED (bug report, 2026-08-31): the picker used to be a
 * `position: absolute` box inside the row. Every per-aircraft table on the
 * Routes page is wrapped in `<div style={{ overflowX: 'auto' }}>` so the wide
 * table can scroll sideways on a phone — and a box with `overflow-x: auto` and
 * `overflow-y: visible` is not a thing CSS will give you: the used overflow-y
 * computes to `auto` as well, so the wrapper clips vertically too. On any row
 * but the last there was enough table below to hide the clip; on the bottom (or
 * only) aircraft of a route the menu was sliced off at the wrapper's edge and
 * what survived read as a black smear tucked under the next route's card.
 *
 * Widening the wrapper is not available — dropping overflow-x loses the
 * sideways scroll the table needs. So the menu renders into document.body
 * through a portal, positioned `fixed` against the trigger's viewport rect
 * (`reassignMenuPosition` below): it escapes the clip AND any stacking context
 * the card sets up, it flips above the button when it would run off the bottom
 * of the screen, and it stays clamped inside the viewport on narrow screens.
 * The same shape as the grouped nav menus in App.jsx — trigger rect in,
 * fixed coordinates out, portalled to the body — including their z-indexes
 * (3000 backdrop / 3001 menu).
 */

const MENU_WIDTH = 280;   // px — comfortable for "Boeing 737 MAX 8 #42 · Boeing 737"
const MENU_MAX_H = 320;   // px — same cap the absolute version used
const GAP        = 6;     // px between trigger and menu
const EDGE       = 8;     // px minimum breathing room at the viewport edges

/**
 * Where to paint the fixed-position menu, given the trigger's viewport rect.
 * Pure — no DOM reads — so the placement rules are testable on their own.
 *
 * · right-aligned to the trigger (the button sits in the last table column),
 *   then clamped so neither edge leaves the viewport;
 * · flipped ABOVE the trigger when the space below is too short to be useful
 *   and there is more room above — the bottom-row case from the bug report;
 * · height capped to whatever space the chosen side actually has, with the
 *   menu's own `overflow-y: auto` handling the rest.
 */
export function reassignMenuPosition(rect, viewport = {}, opts = {}) {
  const vw = viewport.width ?? 0;
  const vh = viewport.height ?? 0;
  const cap = opts.maxHeight ?? MENU_MAX_H;

  const width = Math.max(160, Math.min(opts.width ?? MENU_WIDTH, vw - EDGE * 2));
  const left  = Math.round(Math.max(EDGE, Math.min(rect.right - width, vw - width - EDGE)));

  const roomBelow = vh - rect.bottom - GAP - EDGE;
  const roomAbove = rect.top - GAP - EDGE;
  // Only flip when below is genuinely cramped AND above is roomier: a menu that
  // jumps sides for the sake of 10px is worse than one that scrolls.
  const above = roomBelow < Math.min(cap, 180) && roomAbove > roomBelow;

  const maxHeight = Math.max(120, Math.round(Math.min(cap, above ? roomAbove : roomBelow)));
  const top = Math.round(above
    ? Math.max(EDGE, rect.top - GAP - maxHeight)
    : rect.bottom + GAP);

  return { top, left, width, maxHeight, placement: above ? 'above' : 'below' };
}

export default function ReassignRouteButton({ route }) {
  const { state, dispatch } = useGame();
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState(null);
  const btnRef  = useRef(null);
  const menuRef = useRef(null);

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

  // Measure the trigger where it is right now. Returns null when the button has
  // scrolled out of the viewport, which is the cue to close rather than leave a
  // fixed menu floating next to nothing.
  function place() {
    const el = btnRef.current;
    if (!el || typeof window === 'undefined') return null;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return null;
    return reassignMenuPosition(r, { width: window.innerWidth, height: window.innerHeight });
  }

  // A fixed menu does not travel with the page, so follow the trigger while the
  // menu is open. Scroll is listened for in the capture phase because scroll
  // does not bubble (an inner scroller would otherwise never reach window) —
  // hence the explicit "not the menu's own scrollbar" guard.
  useEffect(() => {
    if (!open) return undefined;
    const reflow = (e) => {
      if (e?.target?.nodeType && menuRef.current?.contains(e.target)) return;
      const next = place();
      if (!next) { setOpen(false); return; }
      setPos(next);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('scroll', reflow, true);
    window.addEventListener('resize', reflow);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', reflow, true);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle() {
    if (open) { setOpen(false); return; }
    const next = place();
    if (!next) return;
    setPos(next);
    setOpen(true);
  }

  function move(toAircraftId) {
    dispatch({ type: 'REASSIGN_ROUTE', routeId: route.id, toAircraftId });
    setOpen(false);
  }

  const menu = (
    <>
      <div
        onClick={() => setOpen(false)}
        style={{ position: 'fixed', inset: 0, zIndex: 3000 }}
      />
      <div
        ref={menuRef}
        role="menu"
        style={{
          position: 'fixed', top: pos?.top, left: pos?.left,
          width: pos?.width, maxHeight: pos?.maxHeight, overflowY: 'auto',
          zIndex: 3001,
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
  );

  return (
    <span style={{ display: 'inline-block' }}>
      <button
        ref={btnRef}
        className="btn"
        style={{ padding: '3px 8px', fontSize: 11, background: 'var(--surface3)', border: '1px solid var(--border)' }}
        title={eligible > 0
          ? 'Move this route to another aircraft — keeps its fares, ramp and season'
          : 'No other aircraft can take this route'}
        aria-expanded={open}
        onClick={toggle}
      >
        <Glyph e="🔀" /> Move
      </button>

      {open && pos && typeof document !== 'undefined' && createPortal(menu, document.body)}
    </span>
  );
}
