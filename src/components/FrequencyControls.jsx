import { useState, useMemo } from 'react';
import { useGame, planBulkFrequencyBatched } from '../store/GameContext.jsx';
import NumberStepper from './NumberStepper.jsx';

// ─── Change flights/wk on several routes at once ──────────────────────────────
//
// One control, two homes:
//
//   Routes ▸ Bulk Frequency (Discord, Barca 2026-10-16: "Bulk pricing but
//   instead it adjusts route frequency") — the selection bar's row and the
//   header modal's summary.
//
//   Fleet ▸ an aircraft's routes, or every route of the aircraft ticked in the
//   fleet table (Discord, VodkaOnFire 2026-10-21: "add an option in the fleet
//   menu to add flights [to] planes that already have routes … increase routes
//   to the same amount for each route a plane flies rather than having to look
//   through the routes list").
//
// Both preview and apply through planBulkFrequencyBatched — the engine's own
// plan split into server-sized writes, one BULK_ADJUST_FREQUENCY per batch — so
// the line under the controls is what Apply does. Passenger and freight routes
// both go through it. (Ported from Tailwinds, where there are no batches.)

export const MAX_FREQ_UI = 99;   // the per-route stepper's ceiling (MAX_ROUTE_FREQUENCY in the engine)
export const FREQ_MODES = [
  { id: 'delta', label: 'Add / remove' },
  { id: 'set',   label: 'Set to' },
  { id: 'max',   label: 'Fill spare hours' },
];

/** One line per reason a route got less than it asked for: "Aircraft's weekly block-hour limit ×3". */
function cappedReasons(plan) {
  const counts = new Map();
  for (const e of plan.plan) {
    const why = e.reason ?? null;
    if (!why) continue;
    // "No free gate slots at LHR" → group by the sentence, airports included:
    // that names exactly which gate to lease.
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/**
 * What a plan would do, in one box. `noun` is what each route IS to the
 * reader: on Routes every row is one aircraft on a pair ("3 aircraft change");
 * on an aircraft's own card they are its routes ("3 routes change").
 */
export function FrequencyPlanSummary({ plan, mode, noun = 'aircraft' }) {
  if (!plan) return null;
  const reasons = cappedReasons(plan);
  const none = plan.changed === 0;
  const nouns = noun === 'aircraft' ? 'aircraft' : `${noun}s`;
  return (
    <div data-freq-plan="" style={{
      padding: '8px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.5,
      background: none ? 'var(--surface2)' : 'rgba(56,139,253,0.10)',
      border: `1px solid ${none ? 'var(--border)' : 'rgba(56,139,253,0.3)'}`,
    }}>
      {none ? (
        <span style={{ color: 'var(--text-muted)' }}>
          {mode === 'max' || plan.capped > 0
            ? (noun === 'aircraft' ? 'None of these aircraft has room for another flight.' : `None of these ${nouns} has room for another flight.`)
            : 'Nothing would change.'}
        </span>
      ) : (
        <span>
          <b>{plan.changed}</b> {plan.changed === 1 ? noun : nouns} change
          {plan.added > 0 && <> · <span style={{ color: 'var(--green)', fontWeight: 700 }}>+{plan.added}</span> flight{plan.added !== 1 ? 's' : ''}/wk</>}
          {plan.removed > 0 && <> · <span style={{ color: 'var(--red)', fontWeight: 700 }}>−{plan.removed}</span> flight{plan.removed !== 1 ? 's' : ''}/wk</>}
        </span>
      )}
      {plan.capped > 0 && (
        <div style={{ color: 'var(--yellow)', marginTop: 4 }}>
          {none ? 'What stops them:' : `${plan.capped} got less than asked — each takes the most that fits:`}
          {reasons.slice(0, 4).map(([why, n]) => (
            <div key={why} style={{ color: 'var(--text-muted)', paddingLeft: 10 }}>· {why}{n > 1 ? ` ×${n}` : ''}</div>
          ))}
          {reasons.length > 4 && <div style={{ color: 'var(--text-dim)', paddingLeft: 10 }}>· and {reasons.length - 4} more reasons</div>}
        </div>
      )}
    </div>
  );
}

/**
 * Mode + value, the live plan for `routeIds`, and Apply. `onApply(plan, spec)`
 * receives the plan the player was shown; without one, it dispatches one
 * BULK_ADJUST_FREQUENCY per planned batch itself.
 *
 * @param {string[]} routeIds  passenger and/or freight route ids
 * @param {string}   [noun]    'aircraft' (Routes) or 'route' (an aircraft's own routes)
 * @param {string}   [each]    what the value applies to — "each aircraft", "each route"
 * @param {string}   [defaultMode]
 */
export default function RouteFrequencyControls({
  routeIds, onApply, noun = 'aircraft', each = 'each aircraft', defaultMode = 'delta', label = 'Flights/wk',
}) {
  const { state, dispatch } = useGame();
  const [mode, setMode]     = useState(defaultMode);
  const [delta, setDelta]   = useState(1);
  const [target, setTarget] = useState(7);
  const value = mode === 'delta' ? delta : mode === 'set' ? target : 0;
  // The caller rebuilds the list every render; key the plan on the ids it holds.
  const idsKey = (routeIds ?? []).join(',');
  const ids = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey]);
  const ready = ids.length > 0 && (mode !== 'delta' || delta !== 0);
  // Keyed on what the guards read rather than the whole state, so a rival
  // re-pricing somewhere in the world doesn't re-plan a big selection.
  const plan = useMemo(
    () => (ready ? planBulkFrequencyBatched(state, ids, { mode, value }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.routes, state.fleet, state.cargoRoutes, state.gates, state.allianceSlotPool, state.charters, ids, mode, value, ready]);

  function apply() {
    if (!plan || plan.changed === 0) return;
    if (onApply) onApply(plan, { routeIds: ids, mode, value });
    else for (const batch of plan.batches) dispatch({ type: 'BULK_ADJUST_FREQUENCY', routeIds: batch, mode, value });
  }

  const modeButtons = (
    <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', width: 'fit-content' }}>
      {FREQ_MODES.map(m => (
        <button
          key={m.id}
          type="button"
          data-freq-mode={m.id}
          onClick={() => setMode(m.id)}
          style={{
            padding: '4px 8px', fontSize: 11, fontWeight: 600,
            cursor: 'pointer', border: 'none',
            background: mode === m.id ? 'var(--accent)' : 'transparent',
            color: mode === m.id ? '#fff' : 'var(--text-muted)',
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );

  const valueControl = mode === 'delta' ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <NumberStepper size="sm" live value={delta} min={-98} max={98} onChange={setDelta}
        ariaLabel={`flights per week to add or remove on ${each}`}
        decTitle="One fewer" incTitle="One more" />
      <span style={{ color: 'var(--text-muted)' }}>flights/wk on {each}</span>
    </span>
  ) : mode === 'set' ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <NumberStepper size="sm" live value={target} min={1} max={MAX_FREQ_UI} onChange={setTarget}
        ariaLabel={`flights per week on ${each}`}
        decTitle="One fewer" incTitle="One more" />
      <span style={{ color: 'var(--text-muted)' }}>flights/wk on {each}</span>
    </span>
  ) : (
    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
      as many flights as {noun === 'aircraft' ? "each aircraft's" : "the aircraft's"} hours and the gate slots allow
    </span>
  );

  return (
    <div data-freq-controls="" style={{ display: 'flex', flexDirection: 'column', gap: 6, flexBasis: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>{label}</span>
        {modeButtons}
        {valueControl}
        <button
          className="btn btn-primary"
          style={{ fontSize: 13 }}
          disabled={!plan || plan.changed === 0}
          onClick={apply}
        >
          Apply
        </button>
      </div>
      {plan && <FrequencyPlanSummary plan={plan} mode={mode} noun={noun} />}
    </div>
  );
}
