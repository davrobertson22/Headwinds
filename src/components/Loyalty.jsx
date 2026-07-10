import { Glyph } from './Icons.jsx';
import { useState, useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import {
  formatMoney,
  loyaltyPenetration,
  loyaltyPaxBase,
  loyaltyTier,
  loyaltyEffectiveStrength,
  loyaltyDemandBoostPct,
  loyaltyPriceSensitivityReduction,
  loyaltyReputationBonus,
  loyaltyEnrollPull,
} from '../utils/simulation.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// Preset investment tiers for quick selection
const INVESTMENT_TIERS = [
  { label: 'None',     amount: 0,       description: 'No loyalty program' },
  { label: 'Basic',    amount: 60_000,  description: 'Simple points program' },
  { label: 'Silver',   amount: 175_000, description: 'Tiered status benefits' },
  { label: 'Gold',     amount: 400_000, description: 'Premium perks & lounges' },
  { label: 'Elite',    amount: 800_000, description: 'Best-in-class program' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loyaltyTierLabel(investment) {
  if (investment <= 0)        return { label: 'None',   color: '#5e7088' };
  if (investment < 100_000)   return { label: 'Basic',  color: '#38d39f' };
  if (investment < 250_000)   return { label: 'Silver', color: '#93a4ba' };
  if (investment < 500_000)   return { label: 'Gold',   color: '#ffb43d' };
  return                             { label: 'Elite',  color: '#bc8cff' };
}

// NOTE: all loyalty effect math lives in utils/simulation.js so the engine and
// this panel are guaranteed to agree. Effects key off program STRENGTH =
// penetration × maturity factor — a young program delivers only a quarter of
// its potential, a fully mature one delivers all of it.

// ─── Component ────────────────────────────────────────────────────────────────

export default function Loyalty() {
  const { state, dispatch } = useGame();
  const { loyalty = { weeklyInvestment: 0, members: 0, maturity: 0, pointsLiability: 0 }, lastReport, financialHistory } = state;

  const [draftInvestment, setDraftInvestment] = useState(loyalty.weeklyInvestment);

  const weeklyRevenue    = lastReport?.totalRevenue ?? 0;
  // Smoothed 8-week pax base — same figure the engine uses for penetration.
  const weeklyPassengers = loyaltyPaxBase(state) || (lastReport?.totalPassengers ?? 0);

  const members    = loyalty.members ?? 0;
  const investment = loyalty.weeklyInvestment ?? 0;
  const maturity   = loyalty.maturity ?? 0;
  const liability  = loyalty.pointsLiability ?? 0;

  const tierInfo        = loyaltyTierLabel(investment);
  const tier            = loyaltyTier(investment);
  const penetration     = loyaltyPenetration(members, weeklyPassengers);
  const strength        = loyaltyEffectiveStrength(penetration, maturity);
  const repBonus        = loyaltyReputationBonus(strength);
  const demandBoost     = loyaltyDemandBoostPct(strength, tier);
  const sensShield      = loyaltyPriceSensitivityReduction(strength, tier);
  const pointsEarned    = lastReport?.loyaltyPointsEarned ?? 0;
  const pointsCost      = lastReport?.loyaltyPointsCost   ?? 0;
  const totalWeeklyCost = investment + pointsCost;

  // Weeks of funding left until full maturity at the current tier's pace
  const weeksToMature = tier.maturityFactor > 0
    ? Math.ceil((1 - maturity) * 80 / tier.maturityFactor)
    : null;

  // 12-week loyalty cost history from financialHistory
  const loyaltyHistory = useMemo(() =>
    financialHistory.slice(-12).map(h => h.loyalty ?? 0),
    [financialHistory]
  );

  function applyInvestment() {
    dispatch({ type: 'SET_LOYALTY_INVESTMENT', amount: draftInvestment });
  }

  function selectTier(amount) {
    setDraftInvestment(amount);
  }

  return (
    <div className="page-content">
      <h2 className="page-title">Loyalty Program</h2>

      {/* ── Status strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <StatCard
          label="Active Members"
          value={members.toLocaleString()}
          sub={members > 0 ? `${(penetration * 100).toFixed(1)}% of monthly pax · ${tierInfo.label} tier` : 'No members yet'}
          color="#3ea6ff"
        />
        <StatCard
          label="Program Maturity"
          value={`${Math.round(maturity * 100)}%`}
          sub={
            maturity >= 1 ? 'Fully mature — full effects unlocked'
            : investment > 0 && weeksToMature ? `~${weeksToMature} wks of funding to full`
            : maturity > 0 ? 'Unfunded — trust eroding fast'
            : 'Fund the program to start building trust'
          }
          color={maturity >= 1 ? '#38d39f' : '#ffb43d'}
        />
        <StatCard
          label="Points Liability"
          value={formatMoney(liability)}
          sub={liability > 0 ? `+${formatMoney(pointsEarned)} earned this wk — owed as future award seats` : 'No outstanding points'}
          color={liability > weeklyRevenue ? '#ff5d6c' : '#93a4ba'}
        />
        <StatCard
          label="Weekly Program Cost"
          value={formatMoney(totalWeeklyCost)}
          sub={`${formatMoney(investment)} invest + ${formatMoney(pointsCost)} redemptions`}
          color={totalWeeklyCost > 0 ? '#ff5d6c' : '#5e7088'}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

        {/* ── Investment controls ── */}
        <div className="card">
          <div className="card-title">Weekly Investment</div>
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginBottom: 16 }}>
            Loyalty is a long game: members enroll over months and the program's <strong>maturity</strong> builds
            over <strong>~18 months</strong> of continuous funding. Effects start small and compound — but members
            earn points you'll owe later, and defunding a mature program sends your best flyers to rivals.
          </p>

          {/* Tier presets */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 16 }}>
            {INVESTMENT_TIERS.map(t => {
              const active = draftInvestment === t.amount;
              return (
                <button
                  key={t.label}
                  onClick={() => selectTier(t.amount)}
                  style={{
                    background: active ? 'var(--accent)' : 'var(--bg-card)',
                    color: active ? '#fff' : 'var(--fg)',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 6,
                    padding: '8px 4px',
                    cursor: 'pointer',
                    textAlign: 'center',
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{t.label}</div>
                  <div style={{ fontSize: 11, color: active ? 'rgba(255,255,255,0.8)' : 'var(--fg-muted)' }}>
                    {t.amount > 0 ? formatMoney(t.amount) : '—'}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Custom amount */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span style={{ color: 'var(--fg-muted)', fontSize: 13, whiteSpace: 'nowrap' }}>Custom:</span>
            <input
              type="number"
              min={0}
              step={5000}
              value={draftInvestment}
              onChange={e => setDraftInvestment(Math.max(0, Number(e.target.value)))}
              style={{
                flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 10px', color: 'var(--fg)', fontSize: 14,
              }}
            />
          </div>

          {draftInvestment !== investment && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-primary" onClick={applyInvestment} style={{ flex: 1 }}>
                Apply — {formatMoney(draftInvestment)}/wk
              </button>
              <button
                className="btn-secondary"
                onClick={() => { setDraftInvestment(investment); }}
                style={{ padding: '8px 14px' }}
              >
                Cancel
              </button>
            </div>
          )}

          {draftInvestment !== investment && draftInvestment === 0 && maturity > 0.4 && (
            <div style={{
              background: 'rgba(255, 93, 108, 0.1)', border: '1px solid rgba(255, 93, 108, 0.35)',
              borderRadius: 6, padding: '10px 12px', fontSize: 13, color: 'var(--fg-muted)', marginTop: 8,
            }}>
              <Glyph e="⚠️" /> Killing a mature program is costly: elite members defect ~3% per week,
              maturity unwinds 4× faster than it was built, and outstanding points
              ({formatMoney(liability)}) must still be honoured.
            </div>
          )}

          {draftInvestment === investment && investment > 0 && (
            <div style={{
              background: 'rgba(56, 139, 253, 0.1)', border: '1px solid rgba(56, 139, 253, 0.3)',
              borderRadius: 6, padding: '10px 12px', fontSize: 13, color: 'var(--fg-muted)',
            }}>
              <Glyph e="✅" /> Active at <strong style={{ color: 'var(--fg)' }}>{formatMoney(investment)}/week</strong>
            </div>
          )}
        </div>

        {/* ── Effects panel ── */}
        <div className="card">
          <div className="card-title">Program Effects</div>
          <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginBottom: 8 }}>
            Program strength = penetration × maturity. Current strength:{' '}
            <strong style={{ color: 'var(--fg)' }}>{(strength * 100).toFixed(1)}%</strong>
            {maturity < 1 && penetration > 0 && (
              <> — a young program delivers only part of its potential; the rest unlocks as maturity builds.</>
            )}
          </p>

          <EffectRow
            label="Demand Stability Boost"
            value={`+${(demandBoost * 100).toFixed(1)}%`}
            desc={`Retained passengers who might otherwise defect on price. Strongest on hub routes. ${tierInfo.label !== 'None' ? `${tierInfo.label} tier cap: +${((tier.demandCap ?? 0) * 100).toFixed(1)}%.` : ''}`}
            color="#3ea6ff"
            active={demandBoost > 0}
          />
          <EffectRow
            label="Price-Sensitivity Shield"
            value={`−${(sensShield * 100).toFixed(1)}%`}
            desc={`Members shrug off competitor undercutting. ${tierInfo.label !== 'None' ? `${tierInfo.label} tier cap: −${((tier.sensCap ?? 0) * 100).toFixed(1)}%.` : ''}`}
            color="#38d39f"
            active={sensShield > 0}
          />
          <EffectRow
            label="Reputation Bonus"
            value={`+${repBonus} pts`}
            desc="A deep, mature program builds brand prestige. Boosts your reputation score up to +8."
            color="#ffb43d"
            active={repBonus > 0}
          />
          <EffectRow
            label="Points Redemption Cost"
            value={`−${formatMoney(pointsCost)}/wk`}
            desc="Members redeeming accumulated points for award seats. Lags earn by months — a growing program looks cheap before the bill arrives. ~20% of points expire unused."
            color="#ff5d6c"
            active={pointsCost > 0}
          />

          {members === 0 && investment === 0 && (
            <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 8, fontStyle: 'italic' }}>
              Set a weekly investment to start enrolling members.
            </p>
          )}
        </div>
      </div>

      {/* ── Member growth projection ── */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title">Member Growth</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 12 }}>
          <div>
            <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginBottom: 4 }}>Current Members</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{members.toLocaleString()}</div>
          </div>
          <div>
            <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginBottom: 4 }}>Weekly Enrollment Rate</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {weeklyPassengers > 0 && investment > 0
                ? `+${Math.round(weeklyPassengers * loyaltyEnrollPull(investment)).toLocaleString()}`
                : '—'}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginBottom: 4 }}>Monthly Churn</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#ff5d6c' }}>
              −{Math.round(members * (investment > 0 ? 0.016 : (maturity > 0.4 ? 0.115 : 0.047))).toLocaleString()}
            </div>
          </div>
        </div>

        {/* Growth milestones */}
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 8 }}>
          <strong style={{ color: 'var(--fg)' }}>Milestones</strong> (program strength — penetration × maturity):
          {[
            { s: 0.10, desc: '+2.5% hub demand, −3.5% price sensitivity, +2 reputation' },
            { s: 0.20, desc: '+5% hub demand, −7% price sensitivity, +4 reputation' },
            { s: 0.30, desc: '+7.5% hub demand, −10.5% price sensitivity, +6 reputation (needs Silver+ caps)' },
            { s: 0.40, desc: '+10% hub demand, −14% price sensitivity, +8 reputation (needs Gold+ caps)' },
            { s: 0.50, desc: '+12.5% hub demand, −17.5% price sensitivity (Elite caps only)' },
          ].map(({ s, desc }) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                background: strength >= s ? '#38d39f' : 'var(--border)',
              }} />
              <span style={{ color: strength >= s ? 'var(--fg)' : 'var(--fg-muted)' }}>
                <strong>{Math.round(s * 100)}% strength</strong> — {desc}
              </span>
            </div>
          ))}
          <p style={{ fontSize: 12, marginTop: 10, fontStyle: 'italic' }}>
            Example: 45% penetration at 50% maturity = 28% strength. Reaching the top milestones
            takes a deep member base <em>and</em> a program that's been funded for over a year.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }) {
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}

function EffectRow({ label, value, desc, color, active }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '10px 0', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        minWidth: 70, fontWeight: 600, fontSize: 14,
        color: active ? color : 'var(--fg-muted)',
        paddingTop: 1,
      }}>
        {value}
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: active ? 'var(--fg)' : 'var(--fg-muted)' }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>{desc}</div>
      </div>
    </div>
  );
}
