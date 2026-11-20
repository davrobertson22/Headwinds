// TurnTimes.jsx — the player's standard turn times (docs/turn-times-design.md).
//
// TurnTimesCard (Operations ▸ Labor): one row per aircraft class the fleet
// flies, a turn for each within the class's limits, and a preview of what the
// draft does — block hours freed or spent, on-time rate, ground-staff morale —
// before Save. A draft that would push any tail past its weekly block-hour cap
// lists those tails and cannot be saved (the reducer refuses it too).
//
// RouteTurnControl (Route detail): a route's own turn, overriding its class.

import { useMemo, useState } from 'react';
import {
  TURN_CLASSES, TURN_STEP_MIN, turnLimitsForClass, cleanTurnTimes, turnClassKey, turnLimits,
  turnMinutesFor, clampTurnForClass, TURN_OTP_SHORT, TURN_OTP_LONG, TURN_MORALE_SHORT, TURN_MORALE_LONG,
} from '../models/turnTimes.js';
import { turnTimeEffectsOf, turnTimeBreaches, turnTimeClassSummary } from '../utils/simulation.js';
import { getAircraftType } from '../data/aircraft.js';
import InfoTip from './InfoTip.jsx';

const HOW_IT_WORKS = `How long your aircraft spend on the ground between flights. The turn counts toward each aircraft's weekly block-hour cap, so a quicker turn leaves room for more flights.
Quick turns cost on-time performance (up to ${Math.round(TURN_OTP_SHORT * 100)} points with the whole fleet at the floor) and wear your ground staff down (their morale drifts up to ${TURN_MORALE_SHORT} lower, cabin crew a third of that).
Padded turns buy back a little punctuality (up to +${Math.round(TURN_OTP_LONG * 100)} points) and goodwill (up to +${TURN_MORALE_LONG} ground-staff morale), with smaller gains the further you go, and the padding doesn't count as schedule pressure.
Effects are weighted by flying hours, so a spare aircraft's setting changes nothing. Morale moves gradually, like pay. A route can have its own turn on its Route detail page.`;

const pts = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)} pts`;
const num = (x, d = 1) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;
const hrs = (h) => `${Math.round(h).toLocaleString()}h`;

function stepsFor(key) {
  const { min, max } = turnLimitsForClass(key);
  const out = [];
  for (let m = min; m <= max; m += TURN_STEP_MIN) out.push(m);
  return out;
}

function deltaColor(x, goodWhenUp = true) {
  if (Math.abs(x) < 1e-9) return 'var(--text-muted)';
  return (x > 0) === goodWhenUp ? 'var(--green)' : 'var(--red)';
}

export function TurnTimesCard({ state, dispatch }) {
  const saved = state.turnTimes?.byClass ?? {};
  const [draft, setDraft] = useState(null);   // null = no unsaved change
  const current = draft ?? saved;

  const nowSummary = useMemo(() => turnTimeClassSummary(state),
    [state.fleet, state.routes, state.cargoRoutes, state.charters, state.turnTimes]);
  const classes = TURN_CLASSES.filter(c => nowSummary[c.key]);

  const draftTT = useMemo(() => cleanTurnTimes({ byClass: current }), [current]);
  const dirty = draft != null && JSON.stringify(draftTT) !== JSON.stringify(state.turnTimes ?? null);

  const nowFx = useMemo(() => turnTimeEffectsOf(state),
    [state.fleet, state.routes, state.cargoRoutes, state.charters, state.turnTimes]);
  const preview = useMemo(() => {
    if (!dirty) return null;
    const st = { ...state, turnTimes: draftTT };
    return {
      fx: turnTimeEffectsOf(st),
      summary: turnTimeClassSummary(state, draftTT),
      breaches: turnTimeBreaches(state, { turnTimes: draftTT }),
    };
  }, [dirty, draftTT, state]);

  if (classes.length === 0) return null;

  const set = (key, minutes) => {
    const std = turnLimitsForClass(key).std;
    const next = { ...current };
    if (minutes === std) delete next[key]; else next[key] = minutes;
    setDraft(next);
  };
  const fx = preview?.fx ?? nowFx;
  const breaches = preview?.breaches ?? [];

  return (
    <div className="card" data-turn-times style={{ marginTop: 16, padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Turn times</span>
        <InfoTip text={HOW_IT_WORKS} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Your standard ground time between flights, per aircraft class. Quicker turns fit more flights into each
        aircraft's week, but cost punctuality and ground-staff morale. Longer turns do the reverse.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {classes.map(c => {
          const { min, std, max } = turnLimitsForClass(c.key);
          const value = current[c.key] ?? std;
          const now = nowSummary[c.key];
          const then = preview?.summary?.[c.key];
          const dh = then ? then.hours - now.hours : 0;
          return (
            <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
              <span style={{ minWidth: 150, fontWeight: 600 }}>{c.label}</span>
              <span style={{ color: 'var(--text-dim)', minWidth: 90 }}>{now.aircraft} aircraft</span>
              <select
                aria-label={`${c.label} turn time`}
                value={value}
                onChange={e => set(c.key, Number(e.target.value))}
                style={{ fontSize: 12 }}
              >
                {stepsFor(c.key).map(m => (
                  <option key={m} value={m}>{m} min{m === std ? ' (standard)' : m === min ? ' (quickest)' : m === max ? ' (longest)' : ''}</option>
                ))}
              </select>
              <span style={{ color: 'var(--text-muted)' }}>
                {hrs(now.hours)}/wk flown
                {Math.abs(dh) >= 0.5 && (
                  <span style={{ color: dh < 0 ? 'var(--green)' : 'var(--yellow)', marginLeft: 6 }}>
                    {dh < 0 ? `frees ${hrs(-dh)}` : `needs ${hrs(dh)} more`}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)', fontSize: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <span>
          On-time rate{' '}
          <strong style={{ color: deltaColor(fx.otpDelta) }}>{pts(fx.otpDelta)}</strong>
          {preview && <span style={{ color: 'var(--text-dim)' }}> (now {pts(nowFx.otpDelta)})</span>}
        </span>
        <span>
          Ground-staff morale target{' '}
          <strong style={{ color: deltaColor(fx.moraleLift.groundStaff) }}>{num(fx.moraleLift.groundStaff)}</strong>
          {preview && <span style={{ color: 'var(--text-dim)' }}> (now {num(nowFx.moraleLift.groundStaff)})</span>}
        </span>
        <span>
          Cabin crew{' '}
          <strong style={{ color: deltaColor(fx.moraleLift.cabinCrew) }}>{num(fx.moraleLift.cabinCrew)}</strong>
        </span>
      </div>

      {breaches.length > 0 && (
        <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 4, fontSize: 12, border: '1px solid var(--red)', color: 'var(--red)', background: 'var(--surface2)' }}>
          <strong>Won't fit.</strong> These aircraft would go over their {Math.round(breaches[0].cap)}h weekly block-hour limit:
          {' '}{breaches.slice(0, 6).map(b => `${b.name} (${b.typeName}, ${Math.round(b.hours)}h)`).join(' · ')}
          {breaches.length > 6 ? ` and ${breaches.length - 6} more` : ''}.
          {' '}Cut some of their flights first, or keep a shorter turn.
        </div>
      )}

      {dirty && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={breaches.length > 0}
                  onClick={() => { dispatch({ type: 'SET_TURN_TIMES', byClass: Object.fromEntries(TURN_CLASSES.map(c => [c.key, current[c.key] ?? null])) }); setDraft(null); }}>
            Save turn times
          </button>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setDraft(null)}>Cancel</button>
        </div>
      )}
      {!dirty && Object.keys(saved).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }}
                  onClick={() => setDraft({})}>Back to standard</button>
        </div>
      )}
    </div>
  );
}

/** A pair's routes, each with its own turn (override) or the fleet setting. */
export function RouteTurnControl({ state, dispatch, routes }) {
  const [refused, setRefused] = useState(null);
  const rows = (routes ?? []).map(r => {
    const ac = (state.fleet ?? []).find(a => a.id === r.aircraftId);
    const type = ac ? getAircraftType(ac.typeId) : null;
    return type && !r.charter ? { r, ac, type } : null;
  }).filter(Boolean);
  if (rows.length === 0) return null;

  const choose = (r, type, v) => {
    const turnMin = v === '' ? null : clampTurnForClass(turnClassKey(type), Number(v));
    const apply = (x) => {
      if (x.id !== r.id) return x;
      const { turnMin: _o, ...sched } = x.schedule ?? {};
      return turnMin == null ? { ...x, schedule: sched } : { ...x, schedule: { ...sched, turnMin } };
    };
    const breaches = turnTimeBreaches(state, {
      routes: (state.routes ?? []).map(apply), cargoRoutes: (state.cargoRoutes ?? []).map(apply),
    });
    if (breaches.length) {
      setRefused(`${breaches[0].name} would fly ${Math.round(breaches[0].hours)}h a week, over its ${Math.round(breaches[0].cap)}h limit. Cut a flight first, or keep a shorter turn.`);
      return;
    }
    setRefused(null);
    dispatch({ type: 'SET_ROUTE_TURN', routeId: r.id, turnMin });
  };

  return (
    <div data-route-turn style={{ padding: '10px 12px', background: 'var(--surface2)', borderRadius: 'var(--radius)', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Turn time</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 200 }}>
          Ground time between this route's flights. Leave it on the fleet setting (Operations ▸ Turn times) or give this route its own,
          for example a longer turn at a congested airport.
        </span>
      </div>
      {rows.map(({ r, ac, type }) => {
        const key = turnClassKey(type);
        const { std } = turnLimits(type);
        const own = r.schedule?.turnMin;
        const fleetMin = turnMinutesFor(type, null, state.turnTimes?.byClass ?? null);
        return (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap', marginTop: 4 }}>
            {rows.length > 1 && <span style={{ minWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ac.name}</span>}
            <select aria-label={`Turn time for ${ac.name}`} value={own == null ? '' : clampTurnForClass(key, own)}
                    onChange={e => choose(r, type, e.target.value)} style={{ fontSize: 12 }}>
              <option value="">Fleet setting ({fleetMin} min)</option>
              {stepsFor(key).map(m => (
                <option key={m} value={m}>{m} min{m === std ? ' (standard)' : ''}</option>
              ))}
            </select>
          </div>
        );
      })}
      {refused && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 6 }}>{refused}</div>}
    </div>
  );
}
