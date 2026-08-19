import { useState } from 'react';
import RouteFinder from './RouteFinder.jsx';
import CargoRouteFinder from './CargoRouteFinder.jsx';
import { requestNav } from '../utils/navIntent.js';
import { Glyph } from './Icons.jsx';

/**
 * Route Finder — a research screen, not the first step of opening a route.
 *
 * The finder used to sit at the top of the Route Planner, so "where is the
 * demand out of my hub?" was question one of a form whose question two was
 * which aircraft to commit. The planner underneath answered that second
 * question before it was asked — it preselected a type from the catalogue,
 * usually one the player had never leased — and the whole screen read as the
 * game telling you to fly a plane you did not own. Players said so: "what's the
 * point of preselecting something the user doesn't have", and "maybe you can
 * just separate these two things — explicitly planning the route, and just
 * investigating what will be better."
 *
 * So they are two screens. This one answers where the demand is and stops
 * there. "Plan" is one optional exit, and it hands the pair over as a parked
 * nav intent (utils/navIntent.js) rather than rendering the planner inline —
 * searching a market never puts you inside the commit flow.
 */

const MODES = [
  { id: 'passenger', label: 'Passenger', icon: '🧍', accent: 'var(--accent)' },
  { id: 'freight',   label: 'Freight',   icon: '📦', accent: '#e8833a' },
];

export default function RouteFinderScreen() {
  const [mode, setMode] = useState('passenger');

  // The planner is a destination, not a consequence: nothing is parked until the
  // player clicks Plan on a specific pair.
  // The aircraft rides along. The finder now searches WITH a plane — range,
  // runway and the profit forecast all depend on which one — so handing the pair
  // over without it made the planner re-guess, and land on a different type than
  // the row the player clicked.
  const planPair = (m) => (origin, dest, typeId) =>
    requestNav('planner', { filter: { mode: m, origin, dest, typeId } });

  return (
    <div>
      {/* Passenger / freight — the two markets have separate demand models */}
      <div style={{ display: 'inline-flex', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 3, gap: 3, marginBottom: 12 }}>
        {MODES.map(o => {
          const active = mode === o.id;
          return (
            <button
              key={o.id}
              onClick={() => setMode(o.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '7px 16px',
                borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                background: active ? `${o.accent}22` : 'transparent',
                color: active ? o.accent : 'var(--text-muted)',
                boxShadow: active ? `inset 0 0 0 1px ${o.accent}55` : 'none',
                transition: 'all 0.15s',
              }}
            >
              <span style={{ display: 'inline-flex', marginRight: 5 }}><Glyph e={o.icon} size={14} /></span>{o.label}
            </button>
          );
        })}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Where is the demand?</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>
          Search the markets you don't serve yet, from any airport, and compare them on
          size, seasonality, reference price and who else already flies them.
          Nothing here changes your airline — use it to work out where to grow or what
          to order. <strong>Plan</strong> on a result is optional: it carries that pair
          over to the Route Planner, where opening a route is a separate, deliberate step.
        </div>
      </div>

      {mode === 'passenger'
        ? <RouteFinder standalone onPick={planPair('passenger')} />
        : <CargoRouteFinder standalone onPick={planPair('freight')} />}
    </div>
  );
}
