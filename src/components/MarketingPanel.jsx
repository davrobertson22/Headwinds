// Brand marketing and targeted campaigns. Moved here from Operations.jsx so the
// Brand page (Reputation.jsx) can carry the controls beside the awareness and
// appeal they buy; the card itself is unchanged.

import { useState, useEffect } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { formatMoney } from '../utils/simulation.js';
import {
  awarenessDemandMultiplier, marketingAwarenessGain, MARKETING_PCT_MAX,
  AWARENESS_PARITY, AWARENESS_FLOOR, AWARENESS_DECAY_RATE,
  campaignDemandBoostPct, campaignEquilibriumStrength,
  shareOfVoiceFactor, competitorPressureDrag,
} from '../data/overhead.js';
import { competitorMarketingSpend } from '../models/competitorAI.js';
import { getAirport } from '../data/airports.js';
import { Glyph } from './Icons.jsx';

// ─── Reusable money input ──────────────────────────────────────────────────────
// Keeps its own text while focused, so deleting a digit that momentarily makes
// the value 0 (or empty) never resets the field or unmounts its row. Commits the
// parsed dollar amount via onCommit. When allowZeroCommit is false (targeted
// campaigns, where a 0 deletes the campaign), a transient 0/empty is held locally
// and NOT committed — removal happens only via the explicit End button, and
// blurring an empty field restores the last committed value.
function MoneyInput({ value, onCommit, allowZeroCommit = true, ...rest }) {
  const [text, setText]       = useState(value ? String(value) : '');
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value ? String(value) : '');
  }, [value, focused]);
  return (
    <input
      type="number"
      value={text}
      onFocus={() => setFocused(true)}
      onChange={e => {
        const raw = e.target.value;
        setText(raw);
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) onCommit(n);
        else if (allowZeroCommit)        onCommit(0);
      }}
      onBlur={() => {
        setFocused(false);
        const n = parseInt(text, 10);
        if (!(Number.isFinite(n) && n > 0)) {
          if (allowZeroCommit) { onCommit(0); setText(''); }
          else                   setText(value ? String(value) : '');
        }
      }}
      {...rest}
    />
  );
}

// ─── Percent input ────────────────────────────────────────────────────────────
// Typed as a percentage ("4.5"), committed as a fraction (0.045) on Enter or
// blur — not per keystroke, so typing "12" never briefly sets 1%.
function PctInput({ value, onCommit, max = 100, ...rest }) {
  const shown = v => (v == null ? '' : String(+(v * 100).toFixed(2)));
  const [text, setText]       = useState(shown(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(shown(value)); }, [value, focused]);
  const commit = () => {
    const n = parseFloat(text);
    if (Number.isFinite(n) && n >= 0) onCommit(Math.min(n, max) / 100);
    else setText(shown(value));
  };
  return (
    <input
      type="number"
      value={text}
      onFocus={() => setFocused(true)}
      onChange={e => setText(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      onBlur={() => { setFocused(false); commit(); }}
      {...rest}
    />
  );
}

// ─── Marketing budget card ────────────────────────────────────────────────────

export function MarketingCard({ budget: fixedBudget, pctOfRevenue = null, weeklyRevenue, weeklyPax, awareness, targetedMarketing, campaignStrength, routes, competitors, dispatch }) {
  const [newAirport, setNewAirport] = useState('');
  const rivalVoice = competitorMarketingSpend(competitors ?? []);

  // % of revenue mode: the tick charges pct × THAT week's revenue, so the best
  // preview is pct × last week's (labelled "≈"). Everything below — gain,
  // trend, settles-at — runs on this effective figure, same as the engine.
  const pctMode = Number.isFinite(pctOfRevenue);
  const budget  = pctMode ? Math.round(pctOfRevenue * Math.max(0, weeklyRevenue)) : fixedBudget;
  // Switching modes keeps the current spend level: fixed → % pins today's
  // share (4% — the model's sweet spot — before there is any revenue); % → fixed
  // keeps marketingBudget, which the tick leaves at last week's actual spend.
  const switchToPct = () => {
    const share = weeklyRevenue > 0 && fixedBudget > 0
      ? Math.min(MARKETING_PCT_MAX, Math.round(fixedBudget / weeklyRevenue * 1000) / 1000)
      : 0.04;
    dispatch({ type: 'SET_MARKETING_PCT', pct: share });
  };
  const switchToFixed = () => dispatch({ type: 'SET_MARKETING_PCT', pct: null });
  const pctPresets = [0, 0.005, 0.01, 0.02, 0.04, 0.06, 0.08];
  const fmtPct = p => `${+(p * 100).toFixed(2)}%`;

  // Brand (adstock): spend builds awareness over time; lift derives from awareness.
  // This MIRRORS the engine's weekly awareness step exactly (see the awareness
  // block in the reducer): next = current + organic + marketing − decay. Showing
  // only (marketing − decay) made a growing airline read as "−0.3 awareness/wk"
  // while its awareness was actually climbing.
  const reach        = awarenessDemandMultiplier(awareness);
  const diminishing  = 1 - awareness / 100;
  const organicCoef  = Math.min(1.0, (weeklyPax ?? 0) / 1000);   // pax flown → word of mouth
  const organicGain  = organicCoef * diminishing;
  const rawGain      = marketingAwarenessGain(budget, weeklyRevenue);
  const mktGain      = rawGain * diminishing;
  const decayBase    = Math.max(0, (awareness - AWARENESS_FLOOR) * AWARENESS_DECAY_RATE);
  const decay        = routes.length === 0 ? Math.max(0.5, decayBase) : decayBase;
  const netTrend     = organicGain + mktGain - decay;   // what the engine will apply

  // Steady state: awareness settles where (organic + marketing) gain balances
  // decay. Solving  (S)(1 − a/100) = decayRate·(a − floor)  for a, with S the
  // combined pre-diminishing gain. Assumes traffic holds at its current level.
  const settleAt = g => {
    const s = organicCoef + g;
    return Math.max(AWARENESS_FLOOR, Math.min(100,
      (s + AWARENESS_DECAY_RATE * AWARENESS_FLOOR) / (AWARENESS_DECAY_RATE + s / 100)
    ));
  };
  const settleNow  = settleAt(rawGain);
  const settleZero = settleAt(0);
  const fmtPts     = v => (Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));

  // Presets scale with airline size: the model costs ≈4% of weekly revenue for
  // ~63% of the maximum awareness gain, so a fixed $25k–$500k ladder is
  // meaningless once a carrier is doing nine figures a week. Floor keeps the
  // early-game ladder sane while revenue is still tiny.
  const presetBase = Math.max(weeklyRevenue, 2_000_000);
  const roundNice  = v => {
    const mag  = Math.pow(10, Math.floor(Math.log10(v)));
    const step = mag / 2;
    return Math.max(step, Math.round(v / step) * step);
  };
  const presets = [0, ...new Set([0.005, 0.01, 0.02, 0.04, 0.08].map(p => roundNice(presetBase * p)))];

  // Targeted campaigns
  const served = [...new Set(routes.flatMap(r => r.stops ?? [r.origin, r.destination]))].sort();
  const campaigns = Object.entries(targetedMarketing);
  const available = served.filter(c => !(c in targetedMarketing));

  return (
    <div className="card" style={{ padding: '14px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}><Glyph e="📣" /></span>
            Brand Marketing
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, maxWidth: 460 }}>
            Weekly spend on national advertising and brand campaigns. Builds <strong>awareness</strong> over
            weeks rather than boosting demand instantly — and awareness persists after spend stops, fading slowly.
            Demand reach: 40% when unknown, 100% at awareness {AWARENESS_PARITY}, up to 112% for a household name.
          </div>
        </div>
        {budget > 0 && (
          <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--red)' }}>
              {pctMode ? '≈' : ''}−{formatMoney(budget)}/wk
            </div>
            {pctMode && (
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>
                {fmtPct(pctOfRevenue)} of revenue · resized every week
              </div>
            )}
            <div style={{ fontSize: 11, color: mktGain > 0 ? 'var(--green)' : 'var(--text-muted)', marginTop: 1, fontWeight: 600 }}>
              +{fmtPts(mktGain)} awareness/wk from spend
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>
              lifts steady state to ≈{Math.round(settleNow)}
            </div>
          </div>
        )}
      </div>

      {/* Budget mode: a fixed weekly figure, or a share of revenue that follows the airline */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap', fontSize: 12 }}>
        <span style={{ color: 'var(--text-dim)' }}>Budget</span>
        <button
          className={`btn ${pctMode ? 'btn-ghost' : 'btn-primary'}`}
          style={{ fontSize: 12, padding: '3px 10px' }}
          aria-pressed={!pctMode}
          onClick={() => { if (pctMode) switchToFixed(); }}
        >
          Fixed $/wk
        </button>
        <button
          className={`btn ${pctMode ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: 12, padding: '3px 10px' }}
          aria-pressed={pctMode}
          onClick={() => { if (!pctMode) switchToPct(); }}
        >
          % of revenue
        </button>
        {pctMode && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Each week brand spend is set to {fmtPct(pctOfRevenue)} of that week's revenue, so it grows (and shrinks) with the airline.
          </span>
        )}
      </div>

      {/* Quick presets */}
      {pctMode ? (
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {pctPresets.map(p => (
          <button
            key={p}
            className={`btn ${Math.abs(pctOfRevenue - p) < 1e-9 ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => dispatch({ type: 'SET_MARKETING_PCT', pct: p })}
          >
            {p === 0 ? 'None' : fmtPct(p)}
          </button>
        ))}
        <PctInput
          className="input"
          placeholder="Custom %"
          min="0"
          max={MARKETING_PCT_MAX * 100}
          step="0.1"
          value={pctOfRevenue}
          onCommit={pct => dispatch({ type: 'SET_MARKETING_PCT', pct })}
          style={{ width: 100, fontSize: 12, padding: '4px 8px' }}
          aria-label="Brand spend as % of revenue"
        />
      </div>
      ) : (
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {presets.map(v => (
          <button
            key={v}
            className={`btn ${budget === v ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => dispatch({ type: 'SET_MARKETING_BUDGET', amount: v })}
          >
            {v === 0 ? 'None' : v >= 1_000_000 ? `$${v/1_000_000}M` : `$${v/1000}k`}
          </button>
        ))}
        <MoneyInput
          className="input"
          placeholder="Custom $"
          min="0"
          step="10000"
          value={budget}
          onCommit={amount => dispatch({ type: 'SET_MARKETING_BUDGET', amount })}
          style={{ width: 120, fontSize: 12, padding: '4px 8px' }}
        />
      </div>
      )}

      {/* Effect summary */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12 }}>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Brand awareness</div>
          <div style={{ fontWeight: 600 }}>{Math.round(awareness)} / 100</div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Demand reach</div>
          <div style={{ fontWeight: 600, color: reach >= 1 ? 'var(--green)' : 'var(--yellow)' }}>
            {(reach * 100).toFixed(0)}%
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Awareness trend</div>
          <div style={{ fontWeight: 600, color: netTrend > 0.005 ? 'var(--green)' : netTrend < -0.005 ? 'var(--red)' : 'var(--text-muted)' }}>
            {netTrend >= 0 ? '+' : '−'}{fmtPts(Math.abs(netTrend))}/wk net
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
            flying +{fmtPts(organicGain)} · ads +{fmtPts(mktGain)} · fade −{fmtPts(decay)}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Settles at</div>
          <div style={{ fontWeight: 600 }}>≈{Math.round(settleNow)} / 100</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
            {budget > 0
              ? `+${(settleNow - settleZero).toFixed(1)} vs no brand spend`
              : 'at zero brand spend'}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Spend as % revenue</div>
          {pctMode ? (
            <div style={{ fontWeight: 600, color: pctOfRevenue > 0.15 ? 'var(--yellow)' : 'var(--text-muted)' }}>
              {fmtPct(pctOfRevenue)} <span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-dim)' }}>held</span>
            </div>
          ) : (
          <div style={{ fontWeight: 600, color: weeklyRevenue > 0 && budget / weeklyRevenue > 0.15 ? 'var(--yellow)' : 'var(--text-muted)' }}>
            {weeklyRevenue > 0 ? `${(budget / weeklyRevenue * 100).toFixed(1)}%` : '—'}
          </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Adstock note</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Marketing works with a lag: spend compounds into awareness, and cutting the budget
            lets it fade at ~{(AWARENESS_DECAY_RATE * 100).toFixed(1)}%/wk rather than dropping demand overnight.
            Flying passengers also builds awareness organically — the trend above is the net weekly
            change the sim applies, and "settles at" is where it levels off if nothing changes.
          </div>
        </div>
      </div>

      {/* ── Targeted campaigns ── */}
      <div style={{ borderTop: '1px solid var(--border, rgba(128,128,128,0.25))', marginTop: 14, paddingTop: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>Targeted Campaigns</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, maxWidth: 460 }}>
          Tactical advertising in a single market — billboards, local media, fare promotions.
          Lifts demand up to ~+10% (sustained) on routes touching that airport.
          Builds in weeks but fades fast when unfunded. Bigger metros cost more to saturate.
          Effectiveness is <strong>share of voice</strong>: rival hub advertising dilutes your
          campaign and drags local demand — and carriers may counter-blitz when you invade their hub.
        </div>

        {campaigns.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: 8 }}>
            No active campaigns.
          </div>
        )}

        {campaigns.map(([code, spend]) => {
          const ap       = getAirport(code);
          const popM     = ap?.effectivePop ?? ap?.population ?? 1;
          const strength = campaignStrength?.[code] ?? 0;
          const rival    = rivalVoice[code] ?? 0;
          const sov      = shareOfVoiceFactor(spend, rival);
          const drag     = competitorPressureDrag(rival, spend, popM);
          const boostNow = (1 + campaignDemandBoostPct(strength)) * (1 - drag) - 1;
          const eqBoost  = (1 + campaignDemandBoostPct(campaignEquilibriumStrength(spend, popM, sov))) * (1 - drag) - 1;
          return (
            <div key={code} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, fontSize: 12, flexWrap: 'wrap' }}>
              <div style={{ width: 150, fontWeight: 600 }}>
                {code} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{ap?.city ?? ''}</span>
              </div>
              <MoneyInput
                className="input"
                min="0"
                step="10000"
                value={spend}
                allowZeroCommit={false}
                onCommit={amount => dispatch({ type: 'SET_TARGETED_MARKETING', airport: code, amount })}
                style={{ width: 110, fontSize: 12, padding: '3px 8px' }}
              />
              <span style={{ color: 'var(--text-dim)' }}>/wk</span>
              {/* strength bar */}
              <div style={{ flex: 1, minWidth: 90, maxWidth: 160, height: 6, background: 'rgba(128,128,128,0.2)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, strength)}%`, height: '100%', background: 'var(--green)', borderRadius: 3 }} />
              </div>
              <span style={{ color: boostNow > 0 ? 'var(--green)' : boostNow < 0 ? 'var(--red)' : 'var(--text-dim)', fontWeight: 600, minWidth: 56 }}>
                {boostNow >= 0 ? '+' : ''}{(boostNow * 100).toFixed(1)}%
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                sustained: {eqBoost >= 0 ? '+' : ''}{(eqBoost * 100).toFixed(1)}%
              </span>
              {rival > 0 && (
                <span style={{ color: 'var(--yellow)', fontSize: 11 }} title="Competitor marketing at this airport dilutes your campaign and drags demand">
                  rivals {formatMoney(rival)}/wk · SoV {(sov * 100).toFixed(0)}%
                </span>
              )}
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => dispatch({ type: 'SET_TARGETED_MARKETING', airport: code, amount: 0 })}
              >
                End
              </button>
            </div>
          );
        })}

        {available.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <select
              className="input"
              value={newAirport}
              onChange={e => setNewAirport(e.target.value)}
              style={{ fontSize: 12, padding: '3px 8px', width: 220 }}
            >
              <option value="">Add campaign at…</option>
              {available.map(c => {
                const ap = getAirport(c);
                return <option key={c} value={c}>{c} — {ap?.city ?? c}</option>;
              })}
            </select>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: '4px 10px' }}
              disabled={!newAirport}
              onClick={() => {
                if (!newAirport) return;
                dispatch({ type: 'SET_TARGETED_MARKETING', airport: newAirport, amount: 50_000 });
                setNewAirport('');
              }}
            >
              Start ($50k/wk)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The marketing card wired to the game state. */
export default function MarketingPanel() {
  const { state, dispatch } = useGame();
  return (
    <MarketingCard
      budget={state.marketingBudget ?? 0}
      pctOfRevenue={state.marketingPctOfRevenue ?? null}
      weeklyRevenue={state.lastReport?.totalRevenue ?? 0}
      weeklyPax={state.lastReport?.totalPassengers ?? 0}
      awareness={state.awareness ?? 5}
      targetedMarketing={state.targetedMarketing ?? {}}
      campaignStrength={state.campaignStrength ?? {}}
      routes={state.routes ?? []}
      competitors={state.competitors ?? []}
      dispatch={dispatch}
    />
  );
}
