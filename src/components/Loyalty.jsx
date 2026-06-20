import { Glyph } from './Icons.jsx';
import { useState, useMemo } from 'react';
import { useGame } from '../store/GameContext.jsx';
import {
  formatMoney,
  loyaltyPenetration,
  loyaltyTier,
  loyaltyDemandBoostPct,
  loyaltyReputationBonus,
  loyaltyPointsCostPct,
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

// NOTE: all loyalty effect math now lives in utils/simulation.js so the engine
// and this panel are guaranteed to agree. These thin wrappers keep the existing
// call sites readable and base everything on member PENETRATION.

// ─── Component ────────────────────────────────────────────────────────────────

export default function Loyalty() {
  const { state, dispatch } = useGame();
  const { loyalty = { weeklyInvestment: 0, members: 0 }, lastReport, financialHistory } = state;

  const [draftInvestment, setDraftInvestment] = useState(loyalty.weeklyInvestment);
  const [editing, setEditing] = useState(false);

  const weeklyRevenue    = lastReport?.totalRevenue ?? 0;
  const weeklyPassengers = lastReport?.totalPassengers ?? 0;

  const members    = loyalty.members ?? 0;
  const investment = loyalty.weeklyInvestment ?? 0;

  const tierInfo        = loyaltyTierLabel(investment);
  const penetration     = loyaltyPenetration(members, weeklyPassengers);
  const generosity      = loyaltyTier(investment).generosity || (members > 0 ? 0.85 : 0);
  const repBonus        = loyaltyReputationBonus(penetration);
  const pointsCostPct   = loyaltyPointsCostPct(penetration, generosity);
  const pointsCost      = members > 0 ? Math.round(weeklyRevenue * pointsCostPct) : 0;
  const totalWeeklyCost = investment + pointsCost;
  const demandBoost     = loyaltyDemandBoostPct(penetration);

  // 12-week loyalty history from financialHistory
  const loyaltyHistory = useMemo(() =>
    financialHistory.slice(-12).map(h => h.loyalty ?? 0),
    [financialHistory]
  );

  function applyInvestment() {
    dispatch({ type: 'SET_LOYALTY_INVESTMENT', amount: draftInvestment });
    setEditing(false);
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
          sub={members > 0 ? `${(penetration * 100).toFixed(1)}% monthly pax` : 'No members yet'}
          color="#3ea6ff"
        />
        <StatCard
          label="Program Tier"
          value={tierInfo.label}
          sub={investment > 0 ? `${formatMoney(investment)}/wk invested` : 'No investment'}
          color={tierInfo.color}
        />
        <StatCard
          label="Reputation Bonus"
          value={`+${repBonus} pts`}
          sub={members < 12_500 ? 'Grow to 12.5k members for +1' : `${formatMoney(12_500 * (8 - repBonus))} members to max`}
          color="#ffb43d"
        />
        <StatCard
          label="Weekly Program Cost"
          value={formatMoney(totalWeeklyCost)}
          sub={`${formatMoney(investment)} invest + ${formatMoney(pointsCost)} points`}
          color={totalWeeklyCost > 0 ? '#ff5d6c' : '#5e7088'}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

        {/* ── Investment controls ── */}
        <div className="card">
          <div className="card-title">Weekly Investment</div>
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginBottom: 16 }}>
            Higher investment drives faster member enrollment and unlocks better program benefits.
            Members earn points on every flight — they're less price-sensitive and more loyal to your airline.
          </p>

          {/* Tier presets */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 16 }}>
            {INVESTMENT_TIERS.map(tier => {
              const active = draftInvestment === tier.amount;
              return (
                <button
                  key={tier.label}
                  onClick={() => selectTier(tier.amount)}
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
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{tier.label}</div>
                  <div style={{ fontSize: 11, color: active ? 'rgba(255,255,255,0.8)' : 'var(--fg-muted)' }}>
                    {tier.amount > 0 ? formatMoney(tier.amount) : '—'}
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

          <EffectRow
            label="Demand Stability Boost"
            value={`+${(demandBoost * 100).toFixed(1)}%`}
            desc="Retained passengers who might otherwise defect due to price. Strongest on hub routes; diluted on off-hub leisure routes."
            color="#3ea6ff"
            active={demandBoost > 0}
          />
          <EffectRow
            label="Points Redemption Cost"
            value={`−${(pointsCostPct * 100).toFixed(1)}% of revenue`}
            desc="Members redeem points for free/discounted seats. Scales with member penetration and how generous your tier is."
            color="#ff5d6c"
            active={members > 0}
          />
          <EffectRow
            label="Reputation Bonus"
            value={`+${repBonus} pts`}
            desc="A strong loyalty program builds brand prestige. Boosts your reputation score up to +8."
            color="#ffb43d"
            active={repBonus > 0}
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
                ? `+${Math.round(weeklyPassengers * Math.min(0.25, investment / 2_000_000)).toLocaleString()}`
                : '—'}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginBottom: 4 }}>Monthly Churn</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#ff5d6c' }}>
              −{Math.round(members * (investment > 0 ? 0.02 : 0.05) * 4).toLocaleString()}
            </div>
          </div>
        </div>

        {/* Growth milestones */}
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 8 }}>
          <strong style={{ color: 'var(--fg)' }}>Milestones:</strong>
          {[
            { m: 10_000,  desc: 'Demand boost kicks in (+0.8%)' },
            { m: 25_000,  desc: 'Meaningful price retention' },
            { m: 50_000,  desc: '+4 reputation pts, −3.75% price sensitivity' },
            { m: 100_000, desc: '+8 reputation pts, −7.5% price sensitivity' },
          ].map(({ m, desc }) => (
            <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                background: members >= m ? '#38d39f' : 'var(--border)',
              }} />
              <span style={{ color: members >= m ? 'var(--fg)' : 'var(--fg-muted)' }}>
                <strong>{m.toLocaleString()} members</strong> — {desc}
              </span>
            </div>
          ))}
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
