import { useGame, slotCapAt, slotsUsedAt } from '../store/GameContext.jsx';
import AddGateButton from './AddGateButton.jsx';

/**
 * Gate slots, on the Route Finder (Discord, Barca 2026-10-03: "It would be
 * really really handy if we could add airport slots from the route finder
 * screen").
 *
 * The finder told you where the demand was and then left you to discover, two
 * screens later in the planner, that you had no gate at the destination or the
 * hub was full. Now each row says how many weekly slots you have free at the
 * destination, the origin gets the same line above the table, and anywhere short
 * of a route's worth gets the same "+ Gate" button the planner uses (scarcity
 * refusals included — AddGateButton asks the engine's own gateLeaseDenial).
 *
 * Counted exactly the way the engine's guards count: slotCapAt (own gates plus
 * any alliance pool grant) against slotsUsedAt (peak month, passenger and
 * freight together, a tag-route stop charged two movements).
 */
export function useSlotPosition() {
  const { state } = useGame();
  const allOps = [...(state.routes ?? []), ...(state.cargoRoutes ?? [])];
  return (code) => {
    const cap = slotCapAt(state, code);
    const used = slotsUsedAt(allOps, code);
    return { cap, used, free: Math.max(0, cap - used), hasGate: cap > 0 };
  };
}

/** One table cell: free weekly slots at `code`, plus "+ Gate" when short of `freq`. */
export function SlotCell({ code, freq = 7, position }) {
  const p = position(code);
  const tone = !p.hasGate || p.free === 0 ? 'var(--red)' : p.free < freq ? 'var(--yellow)' : 'var(--green)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
      <span style={{ fontSize: 12, color: tone, whiteSpace: 'nowrap' }}
            title={p.hasGate
              ? `${p.used} of ${p.cap} weekly slots at ${code} in use. A route at ${freq} flights/wk needs ${freq}.`
              : `You have no gate at ${code} — a route needs gate slots at both ends.`}>
        {p.hasGate ? `${p.free.toLocaleString()} free` : 'No gate'}
      </span>
      {p.free < freq && <AddGateButton code={code} compact style={{ marginLeft: 0 }} />}
    </div>
  );
}

/** The origin's slot position, once, above the results. */
export function OriginSlotsLine({ code, freq = 7, position }) {
  const p = position(code);
  const short = p.free < freq;
  return (
    <div style={{ fontSize: 12, color: short ? 'var(--yellow)' : 'var(--text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
      <span>
        {p.hasGate
          ? <>Slots at {code}: <strong>{p.free.toLocaleString()}</strong> of {p.cap.toLocaleString()} free each week</>
          : <>You have no gate at {code} — every route from here needs one</>}
        {short && p.hasGate ? ` — not enough for another ${freq}/wk route` : ''}
      </span>
      {short && <AddGateButton code={code} />}
    </div>
  );
}
