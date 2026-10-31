// CityLoyalty — the loyalty page in loyalty-pools worlds (engine models/loyaltyPools.js).
//
// Two sentences for the player, and the page never needs more: frequent flyers
// in every city join the best program there. Make yours worth joining, fly them
// reliably, and don't cut it once they have — every December your elites
// requalify.
//
// Three zones: the dial (the one decision), the cities (the story), the money.
// Every figure comes from the engine helpers the tick uses (loyaltyCityTable,
// programValueParts, generosityChange), so the page cannot promise what the
// tick will not do.

import { useMemo, useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { useConfirm } from './ConfirmModal.jsx';
import { formatMoney, loyaltyCityTable, loyaltyPenetration, loyaltyPaxBase, calendarYear, loyaltyMatchOffers } from '../utils/simulation.js';
import { absoluteWeek } from '../../packages/engine/src/utils/fuel.js';
import { featureLive, ERA_FEATURE_MESSAGE } from '../data/eraFeatures.js';
import {
  loyaltyProgramOn, normalizeGenerosity, generosityChange, devaluationRepPenalty, loyaltyBreakage,
  loyaltyMatFactor, eliteFraction, requalPassRate,
  LP_GEN_MIN, LP_GEN_MAX, LP_GEN_STEP, LP_GEN_DEFAULT, LP_REQUAL_WEEK, LP_DEVALUE_K, LP_DEVALUE_REP_WEEKS,
  LP_PROMO_GRACE_WEEKS, LP_RELIABLE_AT, LP_ADMIN_PER_MEMBER, LP_VALUE, loyaltyPoolName,
} from '../models/loyaltyPools.js';

const money = (n) => formatMoney(n ?? 0);
const num = (n) => Math.round(n ?? 0).toLocaleString();
const pct = (x, d = 0) => `${((x ?? 0) * 100).toFixed(d)}%`;

const PART_LABEL = {
  generosity:  'Generous earning',
  lounge:      'Lounge members can use',
  bags:        'Checked bag included',
  premium:     'Premium cabins',
  alliance:    'Alliance member',
  network:     'Places to fly from here',
  partners:    'Travel partners to earn with',
  reliability: 'On time',
};
// Airline-wide items are the same in every city; the rest depend on the city.
const AIRLINE_WIDE = ['generosity', 'bags', 'premium', 'alliance', 'reliability'];

export default function CityLoyalty() {
  const { state, dispatch } = useGame();
  const confirm = useConfirm();
  const lo = state.loyalty ?? {};
  const on = loyaltyProgramOn(lo);
  const g = lo.generosity ?? 0;
  const [draft, setDraft] = useState(on ? g : LP_GEN_DEFAULT);
  const [showAll, setShowAll] = useState(false);
  const absWeek = absoluteWeek(state.year ?? 1, state.week ?? 1);
  const report = state.lastReport ?? {};
  const eraLive = featureLive('loyaltyPrograms', calendarYear(state));

  const rows = useMemo(() => loyaltyCityTable(state), [state]);   // eslint-disable-line
  const offers = useMemo(() => loyaltyMatchOffers(state), [state]);   // eslint-disable-line
  const members = lo.members ?? 0;
  const elites = lo.elites ?? 0;
  const maturity = lo.maturity ?? 0;
  const liability = lo.pointsLiability ?? 0;
  const penetration = loyaltyPenetration(members, loyaltyPaxBase(state) || (report.totalPassengers ?? 0));
  const onTime = lo.onTimeEma ?? report.loyaltyOnTime ?? null;
  const weekly = lo.lastWeek ?? null;

  // The dial's what-if: earn at the draft rate on last week's member revenue.
  const draftG = normalizeGenerosity(draft);
  const earnAt = (rate) => Math.round((report.totalRevenue ?? 0) * penetration * rate);
  const change = on ? generosityChange(lo, draftG, absWeek) : { cut: 0 };
  const cutLoss = Math.round(members * Math.min(0.5, LP_DEVALUE_K * (change.cut ?? 0)));
  const cutRep = change.cut > 0
    ? devaluationRepPenalty({ devaluation: { cut: change.cut, until: absWeek + LP_DEVALUE_REP_WEEKS, maturity } }, absWeek) : 0;
  const promoLive = lo.promo && (lo.promo.until ?? 0) >= absWeek;

  const weeksToRequal = Math.max(0, LP_REQUAL_WEEK - (state.week ?? 1));
  const sampleCity = rows[0] ?? null;
  const airlineParts = sampleCity
    ? sampleCity.parts.filter(p => AIRLINE_WIDE.includes(p.id)) : [];

  const apply = async () => {
    if (change.cut > 0) {
      const ok = await confirm({
        title: 'Devalue your program?',
        body: `Members would earn ${pct(draftG, 1)} instead of ${pct(g, 1)}.\n\n`
          + `About ${num(cutLoss)} members walk out at the next tick and your elites take the hardest hit. `
          + `Every city you fly to shops around for 8 weeks, and for 3 weeks any rival flying your cities can status-match your members — it goes on the world news. `
          + `Reputation ${cutRep} for ${LP_DEVALUE_REP_WEEKS} weeks.\n\n`
          + `Points already earned keep their value — a devaluation never shrinks what you owe.`,
        confirmLabel: 'Devalue',
        danger: true,
      });
      if (!ok) return;
    }
    dispatch({ type: 'SET_LOYALTY_GENEROSITY', generosity: draftG });
  };
  const closeProgram = async () => {
    const ok = await confirm({
      title: 'Close the loyalty program?',
      body: `Members stop earning and drift away over the coming months; elites go first. `
        + `The ${money(liability)} of points already earned must still be honoured as they are redeemed.`,
      confirmLabel: 'Close program',
      danger: true,
    });
    if (ok) dispatch({ type: 'SET_LOYALTY_GENEROSITY', generosity: 0 });
  };

  const visible = showAll ? rows : rows.slice(0, 8);

  const match = async (o) => {
    const ok = await confirm({
      title: `Status-match ${o.name}'s members?`,
      body: `${o.name} cut its program by ${(o.cut * 100).toFixed(1)} points and its members are shopping around. `
        + `Honour their status and ${num(o.members)} of them join you at the next tick:\n\n`
        + o.cities.slice(0, 6).map(c => `• ${loyaltyPoolName(c.pool)}: ${num(c.members)}`).join('\n')
        + (o.cities.length > 6 ? `\n• and ${o.cities.length - 6} more` : '')
        + `\n\nCost ${money(o.cost)} (lounge guests, upgrades, the service desk). After that they stay only if your program `
        + `is the better one in their city — a match buys time, not the city. It goes on the world news.`,
      confirmLabel: `Match — ${money(o.cost)}`,
    });
    if (ok) dispatch({ type: 'LOYALTY_STATUS_MATCH', rivalId: o.rivalId });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-city-loyalty>
      <div className="card" style={{ padding: '14px 18px' }}>
        <div className="card-title">Loyalty Program</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>
          Frequent flyers in every city join the best program there. Make yours worth joining, fly them reliably,
          and don't cut it once they have — every December your elites requalify.
          {' '}<span style={{ color: 'var(--text-dim)' }}>
            Members decide <em>which</em> airline people fly. They never add travellers to a market, so on a route
            nobody else flies your program changes nothing; where you compete, it wins you the passengers.
          </span>
        </div>
      </div>

      {/* ── Status ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <Stat label="Members" value={num(members)}
          sub={members > 0 ? `${num(elites)} elites · ${pct(penetration)} of your flyers` : on ? 'Joining from next week' : 'Program closed'}
          delta={weekly ? weekly.joined - weekly.defected : null} />
        <Stat label="Maturity" value={pct(maturity)}
          sub={maturity >= 1 ? 'Full strength' : on ? `${pct(loyaltyMatFactor(maturity))} of full effect` : maturity > 0 ? 'Unwinding' : '—'} />
        <Stat label="Points owed" value={money(liability)}
          sub={`${pct(loyaltyBreakage(maturity))} will expire unused`} />
        <Stat label="Weekly cost" value={money(report.totalLoyaltyCost ?? 0)}
          sub={`${money(report.loyaltyPointsCost ?? 0)} redemptions + ${money(report.loyaltyAdminCost ?? 0)} running it`} />
      </div>

      {/* ── The dial ───────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: '14px 18px' }} data-loyalty-dial>
        <div className="form-label" style={{ marginBottom: 6 }}>Generosity — how much of the fare members earn back</div>
        {!eraLive ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>🕰 {ERA_FEATURE_MESSAGE.loyaltyPrograms}</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <input type="range" min={LP_GEN_MIN} max={LP_GEN_MAX} step={LP_GEN_STEP} value={draftG || LP_GEN_DEFAULT}
                onChange={(e) => setDraft(Number(e.target.value))} style={{ flex: '1 1 220px' }} aria-label="Generosity" />
              <strong style={{ fontSize: 18, minWidth: 56 }}>{pct(draftG, 1)}</strong>
              {!on && (
                <button className="btn btn-primary" onClick={() => dispatch({ type: 'SET_LOYALTY_GENEROSITY', generosity: draftG })}>
                  Open program at {pct(draftG, 1)}
                </button>
              )}
              {on && draftG !== g && (
                <button className={`btn ${change.cut > 0 ? 'btn-danger' : 'btn-primary'}`} onClick={apply}>
                  {change.cut > 0 ? `Devalue to ${pct(draftG, 1)}` : `Set ${pct(draftG, 1)}`}
                </button>
              )}
              {on && draftG !== g && (
                <button className="btn" onClick={() => setDraft(g)}>Cancel</button>
              )}
              {on && <button className="btn btn-sm" onClick={closeProgram}>Close program</button>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
              Real programs give back about 1–2% to ordinary members and 5–10% to elites; this is the blend.
              {' '}At {pct(draftG, 1)} members earn about <strong>{money(earnAt(draftG))}/wk</strong> in points
              {on && draftG !== g ? <> (now {money(earnAt(g))})</> : null}, which you pay out later as award seats.
              {' '}Raising it is free.
              {on && change.cut > 0 && (
                <span style={{ color: 'var(--red)' }}>
                  {' '}Lowering it is a <strong>devaluation</strong>: ~{num(cutLoss)} members leave, every city shops around for
                  8 weeks, rivals in your cities can status-match your members for 3 weeks, and reputation {cutRep} for {LP_DEVALUE_REP_WEEKS} weeks.
                </span>
              )}
              {on && promoLive && !change.cut && (
                <span> For {lo.promo.until - absWeek + 1} more week{lo.promo.until - absWeek === 0 ? '' : 's'} you can take your last raise back without penalty — members haven't priced it in yet.</span>
              )}
              {!on && (lo.members ?? 0) === 0 && <span> {pct(LP_GEN_DEFAULT)} is a sound start.</span>}
            </div>
          </>
        )}
      </div>

      {/* ── Status match ───────────────────────────────────────────────── */}
      {(offers.length > 0 || lo.pendingMatch || (lo.lastMatch && absWeek - lo.lastMatch.absWeek <= 4)) && (
        <div className="card" style={{ padding: '14px 18px', borderColor: 'rgba(188,140,255,.45)' }} data-loyalty-status-match>
          <div className="form-label" style={{ marginBottom: 6 }}>Status match</div>
          {lo.pendingMatch && (
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              ⏳ {num(lo.pendingMatch.members)} of {lo.pendingMatch.name}'s members join you at the next tick
              ({money(lo.pendingMatch.cost)}).
            </div>
          )}
          {!lo.pendingMatch && lo.lastMatch && absWeek - lo.lastMatch.absWeek <= 4 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              You matched {num(lo.lastMatch.members)} of {lo.lastMatch.name}'s members for {money(lo.lastMatch.cost)}.
              Whether they stay is up to your program now.
            </div>
          )}
          {offers.map(o => (
            <div key={o.rivalId} data-match-offer={o.rivalId}
              style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ flex: '1 1 260px', fontSize: 13 }}>
                <strong>{o.name}</strong> devalued by {(o.cut * 100).toFixed(1)} points. Match {num(o.members)} of its members at
                {' '}{o.cities.length} {o.cities.length === 1 ? 'city' : 'cities'} you both fly
                ({o.cities.slice(0, 3).map(c => loyaltyPoolName(c.pool)).join(', ')}{o.cities.length > 3 ? '…' : ''}).
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  Open until week {((o.until - 1) % 52) + 1}.
                </div>
              </div>
              <button className="btn btn-primary" disabled={!!lo.pendingMatch || (state.cash ?? 0) < o.cost}
                title={lo.pendingMatch ? 'One status match a week' : (state.cash ?? 0) < o.cost ? 'Not enough cash' : ''}
                onClick={() => match(o)}>
                Match — {money(o.cost)}
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        {/* ── What your program is worth ─────────────────────────────── */}
        <div className="card" style={{ padding: '14px 18px' }} data-loyalty-checklist>
          <div className="form-label" style={{ marginBottom: 8 }}>What makes your program worth joining</div>
          {airlineParts.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Fly somewhere to see how your program stacks up.</div>
          ) : (
            <>
              {airlineParts.map(p => <Check key={p.id} part={p} />)}
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
                City by city: a lounge your members can use, how many places you fly from there, and travel partners
                working there (hotels and ride share count most). See the table below.
              </div>
            </>
          )}
        </div>

        {/* ── The status year ────────────────────────────────────────── */}
        <div className="card" style={{ padding: '14px 18px' }} data-loyalty-status-year>
          <div className="form-label" style={{ marginBottom: 8 }}>Status year</div>
          <div style={{ fontSize: 13, lineHeight: 1.55 }}>
            {weeksToRequal === 0
              ? <>Elites requalify <strong>this week</strong>.</>
              : <>Elites requalify in <strong>{weeksToRequal} week{weeksToRequal === 1 ? '' : 's'}</strong> (December).</>}
            {' '}<span style={{ color: 'var(--text-muted)' }}>
              They keep status where you kept up the flying through the year. Cut a city's routes and its elites
              leave with them; everyone else shops around for 12 weeks.
            </span>
          </div>
          <div style={{ fontSize: 13, marginTop: 8 }}>
            On time (13-week average): <strong style={{ color: onTime == null ? 'inherit' : onTime >= 0.85 ? 'var(--green)' : onTime >= LP_RELIABLE_AT ? 'inherit' : 'var(--red)' }}>
              {onTime == null ? '—' : pct(onTime)}</strong>
            {onTime != null && onTime < LP_RELIABLE_AT && (
              <span style={{ color: 'var(--red)' }}> — elites are leaving. Below {pct(LP_RELIABLE_AT)} they go first.</span>
            )}
            {onTime != null && onTime >= LP_RELIABLE_AT && (
              <span style={{ color: 'var(--text-muted)' }}> — {pct(requalPassRate(1, 1, onTime).pass)} of elites requalify if you keep every route.</span>
            )}
          </div>
          {lo.lastRequal && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              Last December ({lo.lastRequal.year}): {num(lo.lastRequal.kept)} kept status, {num(lo.lastRequal.dropped)} dropped a tier
              {(lo.lastRequal.left ?? 0) > 0 && <>, <span style={{ color: 'var(--red)' }}>{num(lo.lastRequal.left)} left with routes you cut</span></>}.
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
            Elites are {pct(eliteFraction(maturity))} of members at this maturity and count three times over.
          </div>
        </div>
      </div>

      {/* ── Cities ─────────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: '14px 18px' }} data-loyalty-cities>
        <div className="form-label" style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
          <span>Cities — who holds the frequent flyers</span>
          {rows.length > 8 && (
            <button className="btn btn-sm" onClick={() => setShowAll(v => !v)}>{showAll ? 'Top 8' : `All ${rows.length}`}</button>
          )}
        </div>
        {rows.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No cities yet — open a route.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>City</th>
                  <th style={{ textAlign: 'right' }}>Your members</th>
                  <th style={{ textAlign: 'left', minWidth: 160 }}>Share of the city's frequent flyers</th>
                  <th style={{ textAlign: 'right' }}>Heading for</th>
                  <th style={{ textAlign: 'left' }}>Biggest rival</th>
                  <th style={{ textAlign: 'left' }}>Here</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(r => {
                  const rival = r.rivals[0];
                  const lounge = r.parts.find(p => p.id === 'lounge');
                  const partners = r.parts.find(p => p.id === 'partners');
                  const network = r.parts.find(p => p.id === 'network');
                  const trend = on && r.seats > 0 ? r.target - r.members : -r.members;
                  return (
                    <tr key={r.pool} data-loyalty-city={r.pool}>
                      <td>{r.name}{r.shopping && <span title="Members here are shopping around" style={{ marginLeft: 6, fontSize: 10, color: 'var(--yellow)' }}>SHOPPING</span>}</td>
                      <td style={{ textAlign: 'right' }}>{num(r.members)}<div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{num(r.elites)} elite</div></td>
                      <td><ShareBar mine={r.share} rivals={r.rivals.map(x => x.members / r.poolSize)} />
                        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{pct(r.share, 1)} of {num(r.poolSize)}</div></td>
                      <td style={{ textAlign: 'right', color: trend > 0 ? 'var(--green)' : trend < 0 ? 'var(--red)' : 'inherit' }}>
                        {on && r.seats > 0 ? num(r.target) : r.seats > 0 ? '—' : 'not flown'}
                      </td>
                      <td>{rival ? <>{rival.name}<div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{num(rival.members)} members</div></> : <span style={{ color: 'var(--text-dim)' }}>none</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <Tick ok={lounge?.ok} label={lounge?.note === 'members not admitted' ? 'Lounge (members not admitted)' : 'Lounge'} />
                        <Tick ok={partners?.ok} label={partners?.names?.length ? `Partners: ${partners.names.join(', ')}` : 'Travel partners'} />
                        <span title="Places you fly from here" style={{ marginLeft: 6, color: 'var(--text-muted)' }}>✈ {network?.n ?? 0}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
          Members move toward "heading for" a little each week. You pull on a city's flyers with the seats you fly
          from it and what your program is worth there; a rival's program pulls the other way, and most people
          carry no card at all unless a program is worth it. Running the program costs about
          {' '}{money(LP_ADMIN_PER_MEMBER)} per member a week.
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, delta = null }) {
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>
        {value}
        {delta != null && delta !== 0 && (
          <span style={{ fontSize: 12, marginLeft: 6, color: delta > 0 ? 'var(--green)' : 'var(--red)' }}>
            {delta > 0 ? '+' : '−'}{Math.abs(Math.round(delta)).toLocaleString()}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{sub}</div>
    </div>
  );
}

function Check({ part }) {
  const label = PART_LABEL[part.id] ?? part.id;
  const detail = part.id === 'reliability' && part.onTime != null ? ` (${pct(part.onTime)})`
    : part.id === 'premium' ? ` (${pct(part.got / LP_VALUE.premium)} of the way)`
    : '';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, padding: '3px 0' }} data-loyalty-part={part.id}>
      <span style={{ color: part.ok ? 'var(--green)' : part.got < 0 ? 'var(--red)' : 'var(--text-dim)', width: 14 }}>
        {part.ok ? '✓' : part.got < 0 ? '✗' : '○'}
      </span>
      <span style={{ flex: 1 }}>{label}{detail}</span>
      <Meter got={part.got} max={part.max} />
    </div>
  );
}

function Meter({ got, max }) {
  const w = max > 0 ? Math.max(0, Math.min(1, got / max)) : 0;
  return (
    <span style={{ display: 'inline-block', width: 60, height: 6, borderRadius: 3, background: 'var(--border)', position: 'relative' }}>
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${w * 100}%`, borderRadius: 3,
        background: got < 0 ? 'var(--red)' : 'var(--green)' }} />
    </span>
  );
}

function Tick({ ok, label }) {
  return <span title={label} style={{ marginLeft: 6, color: ok ? 'var(--green)' : 'var(--text-dim)' }}>{label.split(' ')[0] === 'Lounge' ? '🛋' : '🏨'}{ok ? '✓' : '·'}</span>;
}

function ShareBar({ mine, rivals }) {
  const total = Math.min(1, mine + rivals.reduce((s, x) => s + x, 0));
  let x = mine;
  return (
    <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--border)', width: '100%', maxWidth: 220 }}
      title={`You ${pct(mine, 1)} · rivals ${pct(total - mine, 1)} · no card ${pct(1 - total, 0)}`}>
      <span style={{ width: `${Math.min(1, mine) * 100}%`, background: '#bc8cff' }} />
      {rivals.map((r, i) => {
        const w = Math.max(0, Math.min(r, 1 - x)); x += w;
        return <span key={i} style={{ width: `${w * 100}%`, background: i % 2 ? '#93a4ba' : '#ff9f43', opacity: 0.85 }} />;
      })}
    </div>
  );
}
