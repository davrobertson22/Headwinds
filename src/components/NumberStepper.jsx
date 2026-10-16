import { useRef, useState } from 'react';
import { useToast } from './ToastSystem.jsx';

// ── NumberStepper ─────────────────────────────────────────────────────────────
// One control for every number a player nudges: − / typed value / +, the same
// look as the seat-allocation stepper in Fleet config (the .seat-stepper CSS).
// Departures used to be − / read-out / + in the route list and a bare slider in
// the planners, so going from 3 to 14 flights a week meant eleven clicks
// (Barca, Discord 2026-10-16: "made like it is for seat allocation").
//
//   value, onChange(next)  the number; onChange only ever receives a clamped,
//                          rounded value that differs from `value`.
//   min, max, step         bounds; `decimals` rounds non-integer steps.
//   blockReason(next)      optional — the engine's own guard for INCREASES
//                          (null = allowed). The + stays clickable and explains
//                          itself instead of silently doing nothing, and a typed
//                          jump that is blocked settles on the highest value
//                          the guard allows, saying why.
//   live                   commit while typing (local planner drafts). Without
//                          it a typed value commits on Enter / blur, so a
//                          server-applied setting doesn't get "1" then "12".
//   size                   'sm' for table rows.
export function highestAllowed(from, to, step, blockReason, decimals = 0) {
  // Largest from + k·step ≤ to that the guard accepts. Guards here are
  // monotonic (more flights never un-blocks), so a binary search is exact and
  // a typed 9999 costs ~14 guard calls, not 9999.
  const at = (k) => roundTo(from + k * step, decimals);
  let lo = 0, hi = Math.floor((to - from) / step + 1e-9);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (blockReason(at(mid))) hi = mid - 1; else lo = mid;
  }
  return at(lo);
}

function roundTo(n, decimals) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// What a request for `requested` actually sets — the stepper's whole decision,
// kept pure so it is tested without a DOM. Returns { next, blocked, why }:
//   next     the value to apply, or null for "leave it alone"
//   blocked  the clamped request the guard refused (next < blocked), or null
//   why      the guard's sentence when it refused
export function resolveStep(value, requested, { min = 0, max = Infinity, step = 1, decimals = 0, blockReason = null } = {}) {
  const eps = step / 1000;
  const want = roundTo(Math.min(max, Math.max(min, requested)), decimals);
  if (!Number.isFinite(want) || Math.abs(want - value) < eps) return { next: null, blocked: null, why: null };
  if (want > value && blockReason) {
    const why = blockReason(want);
    if (why) {
      const best = highestAllowed(value, want, step, blockReason, decimals);
      return { next: best > value + eps ? best : null, blocked: want, why };
    }
  }
  return { next: want, blocked: null, why: null };
}

export default function NumberStepper({
  value, onChange,
  min = 0, max = Infinity, step = 1, decimals = 0,
  blockReason = null,
  live = false,
  size = 'md',
  disabled = false,
  ariaLabel,
  decTitle, incTitle,
  blockedTitle = 'Can’t go higher',
  inputWidth,
}) {
  const toast = useToast();
  const [draft, setDraft] = useState(null);   // string while the box is being edited
  const cancelRef = useRef(false);

  const eps = step / 1000;
  const fmt = (n) => (decimals > 0 ? Number(n).toFixed(decimals) : String(n));
  const clamp = (n) => roundTo(Math.min(max, Math.max(min, n)), decimals);
  const say = (t) => { try { toast(t); } catch { /* no toast host (SSR) */ } };

  const canDown = !disabled && value - step >= min - eps;
  const atMax   = value + step > max + eps;
  const upBlock = !disabled && !atMax && blockReason ? blockReason(clamp(value + step)) : null;
  const canUp   = !disabled && !atMax && !upBlock;

  // Commits `n` (already a number). `quiet` (live typing) applies only a
  // request the guard fully accepts and leaves the rest for Enter / blur.
  function commit(n, { quiet = false } = {}) {
    const r = resolveStep(value, n, { min, max, step, decimals, blockReason });
    if (r.why) {
      if (quiet) return;
      if (r.next != null) {
        onChange(r.next);
        say({ type: 'warning', title: `Set to ${fmt(r.next)}`, message: `${fmt(r.blocked)} isn’t possible. ${r.why}` });
      } else {
        say({ type: 'warning', title: blockedTitle, message: r.why });
      }
      return;
    }
    if (r.next != null) onChange(r.next);
  }

  const stepBy = (dir) => {
    if (dir < 0) { if (canDown) commit(value - step); return; }
    if (upBlock) { say({ type: 'warning', title: blockedTitle, message: upBlock }); return; }
    if (canUp) commit(value + step);
  };

  const parse = (s) => parseFloat(String(s).replace(',', '.'));

  const onInput = (e) => {
    const s = e.target.value;
    setDraft(s);
    if (live) {
      const n = parse(s);
      if (Number.isFinite(n) && n >= min - eps && n <= max + eps) commit(n, { quiet: true });
    }
  };

  const onBlur = () => {
    if (draft != null && !cancelRef.current) {
      const n = parse(draft);
      if (Number.isFinite(n)) commit(n);
    }
    cancelRef.current = false;
    setDraft(null);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
    else if (e.key === 'Escape') { cancelRef.current = true; e.currentTarget.blur(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setDraft(null); stepBy(+1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setDraft(null); stepBy(-1); }
  };

  return (
    <span className={`seat-stepper${size === 'sm' ? ' is-sm' : ''}`}>
      <button
        type="button"
        onClick={() => stepBy(-1)}
        disabled={!canDown}
        title={decTitle}
        aria-label={ariaLabel ? `Decrease ${ariaLabel}` : 'Decrease'}
      >−</button>
      <input
        type="text"
        inputMode={decimals > 0 ? 'decimal' : 'numeric'}
        value={draft ?? fmt(value)}
        disabled={disabled}
        aria-label={ariaLabel}
        role="spinbutton"
        aria-valuenow={value}
        aria-valuemin={Number.isFinite(min) ? min : undefined}
        aria-valuemax={Number.isFinite(max) ? max : undefined}
        onFocus={e => e.target.select()}
        onChange={onInput}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        style={inputWidth ? { width: inputWidth } : undefined}
      />
      <button
        type="button"
        onClick={() => stepBy(+1)}
        disabled={!canUp && !upBlock}
        className={upBlock ? 'is-blocked' : undefined}
        aria-disabled={upBlock ? 'true' : undefined}
        title={upBlock || incTitle}
        aria-label={ariaLabel ? `Increase ${ariaLabel}` : 'Increase'}
      >+</button>
    </span>
  );
}
