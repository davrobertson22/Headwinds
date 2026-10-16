import { useMemo, useRef, useEffect } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { getAircraftType } from '../data/aircraft.js';
import { getAirport } from '../data/airports.js';
import { formatMoney, currentGameDate } from '../utils/simulation.js';
import { planRouteBatch, pickKey } from '../../packages/engine/src/models/routeBatch.js';
import { useToast } from './ToastSystem.jsx';
import NumberStepper from './NumberStepper.jsx';
import { Glyph } from './Icons.jsx';
import InfoTip from './InfoTip.jsx';

/**
 * Review a Route Finder shortlist and open it in one go.
 *
 * Discord, 2026-10-14 — Kadicuss: "I have had times when I had like 50 aircraft
 * arrived at the same time, and it was a pain to get them all on routes."
 * Brabus-G-Wagon: "basically repeating the same thing over and over again".
 * The suggestion was random routes. The player still chooses every route here;
 * what goes is the loop of doing it one plane at a time.
 *
 * Everything on this table comes from models/routeBatch.js, which checks and
 * forecasts each pick against the state the picks ABOVE it leave behind — the
 * reducer's own guard, the finder's own forecast, on the tail it will assign.
 * "Open" dispatches exactly the actions that plan accepted, in order.
 */
export default function BatchOpenReview({ picks, setPicks, onClose }) {
  const { state, dispatch } = useGame();
  const addToast = useToast();
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, []);

  const gameDate = currentGameDate(state);
  const plan = useMemo(
    () => planRouteBatch(state, picks, { gameDate }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, picks],
  );
  const { items, totals } = plan;

  const setFreq = (key, v) => setPicks(prev => prev.map(p =>
    pickKey(p.origin, p.destination) === key ? { ...p, weeklyFrequency: v } : p));
  const remove = (key) => setPicks(prev => prev.filter(p => pickKey(p.origin, p.destination) !== key));

  function handleOpen() {
    // Re-plan at the click, not at the last render: a Headwinds poll may have
    // moved cash or slots in between, and only a fresh plan is the truth.
    const fresh = planRouteBatch(state, picks, { gameDate });
    if (fresh.openable.length === 0) return;
    for (const action of fresh.openable) dispatch(action);
    const opened = new Set(fresh.items.filter(i => !i.reason).map(i => i.key));
    const left = picks.filter(p => !opened.has(pickKey(p.origin, p.destination)));
    setPicks(left);
    const n = fresh.openable.length;
    addToast({
      type: 'success',
      title: `Opened ${n} route${n !== 1 ? 's' : ''}`,
      message: `${formatMoney(fresh.totals.launchCost)} in launch costs.`
        + (left.length > 0 ? ` ${left.length} couldn't open and ${left.length !== 1 ? 'are' : 'is'} still on your list.` : ''),
    });
    if (left.length === 0) onClose();
  }

  const cell = { padding: '7px 10px', whiteSpace: 'nowrap' };
  const head = (h, right, tip) => (
    <th style={{ ...cell, textAlign: right ? 'right' : 'left', color: 'var(--text-muted)', fontWeight: 600 }}>
      {h}{tip && <InfoTip text={tip} />}
    </th>
  );

  return (
    <div ref={ref} data-batch-review="" className="card" style={{ marginBottom: 12, border: '1px solid var(--accent)', scrollMarginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Open {items.length} shortlisted route{items.length !== 1 ? 's' : ''}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            One idle aircraft each, at reference fares and your default catering. Each row is checked and
            forecast after the ones above it, so two picks can't claim the same plane, slot or cash.
          </div>
        </div>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={onClose}>✕ Close</button>
      </div>

      <div style={{ overflowX: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--surface2)' }}>
              {head('Route')}
              {head('Aircraft', false, 'The idle tail this route will get: the shortest-legged one that reaches the lane, so a range-modded jet is kept for a lane only it can fly. Reserves are never used — deploy one from the Route Planner if you mean to.')}
              {head('Flights/wk', true, 'Capped at what one aircraft can fly on this sector in a week.')}
              {head('Est. load', true)}
              {head('Est. profit', true, 'Weekly net once mature, the same forecast as the finder row — on the tail this route will actually get.')}
              {head('Launch', true)}
              <th style={cell} />
            </tr>
          </thead>
          <tbody>
            {items.map(it => {
              const t = getAircraftType(it.typeId);
              const dest = getAirport(it.destination);
              const p = it.projection;
              return (
                <tr key={it.key} data-batch-row={it.key} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td style={{ ...cell, whiteSpace: 'normal' }}>
                    <span style={{ fontWeight: 700 }}>{it.origin} → {it.destination}</span>
                    {dest && <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>{dest.city}</span>}
                    <span style={{ color: 'var(--text-dim)', marginLeft: 6, fontSize: 11 }}>{it.distKm.toLocaleString()} km</span>
                    {it.reason && (
                      <div data-batch-reason="" style={{ fontSize: 12, color: 'var(--red)', marginTop: 2 }}>
                        <Glyph e="⚠" size={11} /> {it.reason}
                      </div>
                    )}
                  </td>
                  <td style={{ ...cell, color: it.aircraft ? 'var(--text)' : 'var(--text-dim)' }}>
                    {it.aircraft ? (it.aircraft.tailNumber || it.aircraft.name) : '–'}
                    <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t?.name}</div>
                  </td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    <NumberStepper
                      live size="sm"
                      value={it.weeklyFrequency} min={1} max={Math.max(1, it.maxFrequency)}
                      ariaLabel={`flights per week, ${it.origin} to ${it.destination}`}
                      onChange={n => setFreq(it.key, n)}
                    />
                  </td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    {p
                      ? <span style={{ color: p.loadFactor >= 0.75 ? 'var(--green)' : p.loadFactor >= 0.45 ? 'var(--yellow)' : 'var(--red)' }}>{Math.round(p.loadFactor * 100)}%</span>
                      : <span style={{ color: 'var(--text-dim)' }}>–</span>}
                  </td>
                  <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>
                    {p
                      ? <span style={{ color: p.netProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>{p.netProfit >= 0 ? '+' : ''}{formatMoney(p.netProfit)}</span>
                      : <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>–</span>}
                  </td>
                  <td style={{ ...cell, textAlign: 'right', color: 'var(--text-muted)' }}>
                    {it.reason ? '–' : formatMoney(it.launchCost)}
                  </td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 12 }}
                      title="Take this route off the list" aria-label={`Remove ${it.origin} to ${it.destination}`}
                      onClick={() => remove(it.key)}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
        <div data-batch-totals="" style={{ flex: 1, minWidth: 220, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          {totals.count > 0 ? (
            <>
              Launch costs <strong style={{ color: 'var(--text)' }}>{formatMoney(totals.launchCost)}</strong>
              {' '}· cash after <strong style={{ color: 'var(--text)' }}>{formatMoney(totals.cashAfter)}</strong>
              {' '}· est. <strong style={{ color: totals.weeklyProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {totals.weeklyProfit >= 0 ? '+' : ''}{formatMoney(totals.weeklyProfit)}/wk
              </strong> once mature
            </>
          ) : <>Nothing on this list can open yet — the reason is under each route.</>}
          {totals.blocked > 0 && totals.count > 0 && (
            <div style={{ color: 'var(--yellow)' }}>
              {totals.blocked} can't open and will stay on your list.
            </div>
          )}
          <div style={{ color: 'var(--text-dim)' }}>Fares and catering can be tuned per route on the Routes page any time.</div>
        </div>
        <button
          className="btn btn-primary"
          style={{ padding: '8px 20px' }}
          disabled={totals.count === 0}
          onClick={handleOpen}
        >
          Open {totals.count} route{totals.count !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}
