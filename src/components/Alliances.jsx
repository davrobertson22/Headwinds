import { Glyph, GlyphLabel } from './Icons.jsx';
import { useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { formatMoney, routeQualityBreakdown } from '../utils/simulation.js';
import AirlineLogo from './AirlineLogo.jsx';
import {
  ALLIANCES,
  getAlliance,
  CODESHARE_WEEKLY_FEE_BY_TIER,
  INTERLINE_RATE_BY_TIER,
  MAX_CODESHARE_AGREEMENTS,
  CODESHARE_DURATION_WEEKS,
  countAdjacentRoutes,
  checkAllianceEligibility,
  partnerInterlineRevenue,
  allianceMembers,
} from '../data/alliances.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TIER_META = {
  budget:  { label: 'Budget',  color: 'var(--yellow)'  },
  legacy:  { label: 'Legacy',  color: 'var(--accent)'  },
  premium: { label: 'Premium', color: '#a78bfa'        },
};

/** Human-readable eligibility label for an alliance's allowed tiers.
 *  No allowedTiers (or empty) means the bloc is open to everyone. */
function allianceTierLabel(alliance) {
  const tiers = alliance.requirements?.allowedTiers;
  if (!tiers || tiers.length === 0) return 'all carriers';
  return tiers.map(t => TIER_META[t]?.label ?? t).join(' / ') + ' carriers';
}

/** Player's average quality score across routes.
 *  Prefers last week's engine results (routeResults[].qualityScore — real scores;
 *  older saves lack the field, so entries without it are SKIPPED, not defaulted:
 *  the old `?? 60` default meant this read exactly 60 forever). Falls back to a
 *  live engine-accurate computation via routeQualityBreakdown. */
function playerAvgQuality(state) {
  const routeResults = state.lastReport?.routeResults;
  if (routeResults?.length) {
    const scores = routeResults.map(r => r.qualityScore).filter(v => v != null);
    if (scores.length) return Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
  }
  // Live fallback (week 1, or a save from before qualityScore was reported)
  const live = (state.routes ?? [])
    .map(r => {
      const aircraft = (state.fleet ?? []).find(a => a.id === r.aircraftId);
      return aircraft ? routeQualityBreakdown(r, aircraft, state)?.total : null;
    })
    .filter(v => v != null);
  if (live.length) return Math.round(live.reduce((s, v) => s + v, 0) / live.length);
  return 60; // no routes yet
}

/** The player's "tier" for alliance eligibility purposes. */
function playerTier(state) {
  const avg = playerAvgQuality(state);
  if (avg >= 70) return 'premium';
  if (avg >= 50) return 'legacy';
  return 'budget';
}

/** Set of airports the player currently serves. */
function buildServedAirports(routes) {
  const set = new Set();
  for (const r of routes) {
    set.add(r.origin);
    set.add(r.destination);
  }
  return set;
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function Alliances() {
  const { state, dispatch } = useGame();
  const { routes = [], competitors = [], allianceMembership, codeshareAgreements = [] } = state;

  const servedAirports = buildServedAirports(routes);
  const avgQuality     = playerAvgQuality(state);
  const pTier          = playerTier(state);
  const currentAlliance = allianceMembership ? getAlliance(allianceMembership.allianceId) : null;

  // Weekly partnership revenue summary
  const allianceInterline = currentAlliance
    ? allianceMembers(currentAlliance.id, competitors).reduce((sum, comp) =>
        sum + partnerInterlineRevenue(comp, servedAirports, currentAlliance.interlineFraction), 0)
    : 0;

  const codeshareInterline = codeshareAgreements.reduce((sum, a) => {
    const comp = competitors.find(c => c.id === a.competitorId);
    return comp ? sum + partnerInterlineRevenue(comp, servedAirports, 1.0) : sum;
  }, 0);

  const totalInterline   = allianceInterline + codeshareInterline;
  const totalFees        = (allianceMembership?.weeklyFee ?? 0)
    + codeshareAgreements.reduce((s, a) => s + a.weeklyFee, 0);
  const netPartnership   = totalInterline - totalFees;

  return (
    <div>
      {/* ── Summary bar ─────────────────────────────────────────────────── */}
      <div className="card" style={{
        padding: '14px 18px', marginBottom: 20,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 12,
      }}>
        <SummaryKPI label="Interline revenue" value={formatMoney(totalInterline)} color="var(--green)" prefix="+" />
        <SummaryKPI label="Partnership fees"  value={formatMoney(totalFees)}      color="#f87171"      prefix="-" />
        <SummaryKPI
          label="Net benefit"
          value={formatMoney(Math.abs(netPartnership))}
          color={netPartnership >= 0 ? 'var(--green)' : '#f87171'}
          prefix={netPartnership >= 0 ? '+' : '-'}
        />
        <SummaryKPI
          label="Alliance"
          value={currentAlliance ? currentAlliance.name : 'None'}
          color={currentAlliance ? currentAlliance.color : 'var(--text-muted)'}
        />
        <SummaryKPI label="Codeshares" value={`${codeshareAgreements.length} / ${MAX_CODESHARE_AGREEMENTS}`} />
        <SummaryKPI
          label="Quality"
          value={`${avgQuality}/100`}
          color={avgQuality >= 65 ? 'var(--green)' : avgQuality >= 50 ? 'var(--yellow)' : '#f87171'}
          sub="avg across your routes — same score shown on route pages"
        />
      </div>

      {/* ── Alliance membership ──────────────────────────────────────────── */}
      <SectionHeader>Alliance Membership</SectionHeader>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 12,
        marginBottom: 28,
      }}>
        {ALLIANCES.map(a => (
          <AllianceCard
            key={a.id}
            alliance={a}
            state={state}
            competitors={competitors}
            isMember={allianceMembership?.allianceId === a.id}
            hasAnyMembership={!!allianceMembership}
            servedAirports={servedAirports}
            avgQuality={avgQuality}
            playerTier={pTier}
            dispatch={dispatch}
          />
        ))}
      </div>

      {/* ── Codeshare agreements ─────────────────────────────────────────── */}
      <SectionHeader>Bilateral Codeshare Agreements</SectionHeader>

      {/* Active agreements */}
      {codeshareAgreements.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>
            ACTIVE ({codeshareAgreements.length}/{MAX_CODESHARE_AGREEMENTS})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {codeshareAgreements.map(agreement => {
              const comp = competitors.find(c => c.id === agreement.competitorId);
              const revenue = comp ? partnerInterlineRevenue(comp, servedAirports, 1.0) : 0;
              return (
                <ActiveCodeshareRow
                  key={agreement.id}
                  agreement={agreement}
                  comp={comp}
                  weeklyRevenue={revenue}
                  dispatch={dispatch}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Available partners */}
      <AvailableCodeshares
        competitors={competitors}
        codeshareAgreements={codeshareAgreements}
        servedAirports={servedAirports}
        alliancePartnerIds={currentAlliance ? allianceMembers(currentAlliance.id, competitors).map(c => c.id) : []}
        state={state}
        dispatch={dispatch}
      />
    </div>
  );
}

// ─── Alliance card ────────────────────────────────────────────────────────────

function AllianceCard({
  alliance, state, competitors, isMember, hasAnyMembership,
  servedAirports, avgQuality, playerTier, dispatch,
}) {
  const [confirmLeave, setConfirmLeave] = useState(false);

  // Live membership — carriers join and leave blocs as the game evolves.
  const memberComps = allianceMembers(alliance.id, competitors);

  const weeklyInterline = memberComps.reduce(
    (s, c) => s + partnerInterlineRevenue(c, servedAirports, alliance.interlineFraction),
    0
  );

  const { eligible, reasons } = checkAllianceEligibility(alliance, {
    routes:          state.routes?.length ?? 0,
    playerTier,
    avgQualityScore: avgQuality,
  });

  const canAfford    = state.cash >= alliance.initiationFee;
  const canJoin      = eligible && canAfford && !hasAnyMembership;

  function handleJoin() {
    if (!canJoin) return;
    dispatch({ type: 'JOIN_ALLIANCE', allianceId: alliance.id });
  }

  function handleLeave() {
    if (confirmLeave) {
      dispatch({ type: 'LEAVE_ALLIANCE' });
      setConfirmLeave(false);
    } else {
      setConfirmLeave(true);
    }
  }

  return (
    <div className="card" style={{
      padding: '16px 18px',
      border: isMember ? `2px solid ${alliance.color}` : '1px solid var(--border)',
      position: 'relative',
    }}>
      {isMember && (
        <div style={{
          position: 'absolute', top: 10, right: 12,
          fontSize: 10, fontWeight: 700, color: alliance.color,
          background: `${alliance.color}20`, borderRadius: 99, padding: '2px 8px',
        }}>
          ● MEMBER
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 26, lineHeight: 1, display: 'inline-flex' }}><Glyph e={alliance.icon} size={26} /></div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: alliance.color }}>{alliance.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{alliance.tagline}</div>
        </div>
      </div>

      {/* Description */}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        {alliance.description}
      </div>

      {/* Members */}
      <div style={{ fontSize: 12, marginBottom: 10 }}>
        <div style={{ color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600, fontSize: 11 }}>MEMBERS</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {memberComps.map(c => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <AirlineLogo id={c.logoId} size={18} radius={4} />
              <span style={{ fontSize: 11 }}>{c.name}</span>
            </div>
          ))}
          {memberComps.length === 0 && (
            <span style={{ color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic' }}>Initialising…</span>
          )}
        </div>
      </div>

      {/* Benefits */}
      <div style={{
        background: 'var(--surface2)', borderRadius: 6, padding: '8px 10px',
        fontSize: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <BenefitLine icon="📈" label={`+${Math.round(alliance.demandBoostPct * 100)}% revenue on contested routes`} />
        <BenefitLine icon="⭐" label={`+${alliance.qualityBonus} quality score on all routes`} />
        <BenefitLine icon="🔗" label={`~${formatMoney(weeklyInterline)}/wk interline revenue (est.)`} />
      </div>

      {/* Cost */}
      <div style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ color: 'var(--text-muted)' }}>Initiation fee</span>
        <strong style={{ color: canAfford ? 'var(--text)' : '#f87171' }}>
          {formatMoney(alliance.initiationFee)}
        </strong>
      </div>
      <div style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ color: 'var(--text-muted)' }}>Weekly dues</span>
        <strong>{formatMoney(alliance.weeklyFee)}/wk</strong>
      </div>

      {/* Who can join */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Glyph e="🎫" size={12} />
        <span>Open to {allianceTierLabel(alliance)}</span>
      </div>

      {/* Eligibility / action */}
      {isMember ? (
        <div>
          <button
            className="btn"
            style={{
              width: '100%', fontSize: 12, padding: '7px 0',
              background: confirmLeave ? '#f87171' : 'var(--surface2)',
              color: confirmLeave ? '#fff' : 'var(--text)',
              border: '1px solid var(--border)',
            }}
            onClick={handleLeave}
          >
            <GlyphLabel size={12} text={confirmLeave ? '⚠ Confirm Leave Alliance' : 'Leave Alliance'} />
          </button>
          {confirmLeave && (
            <button
              style={{ fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 4 }}
              onClick={() => setConfirmLeave(false)}
            >
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div>
          {!eligible && (
            <div style={{ fontSize: 11, color: '#f87171', marginBottom: 8 }}>
              {reasons.map((r, i) => (
                <div key={i}>
                  <Glyph e="✗" /> {r}
                  {r.includes('quality') && (
                    <div style={{ color: 'var(--text-muted)', marginTop: 2, marginLeft: 10 }}>
                      ↳ This is your in-flight product score, not overall reputation.
                      Upgrade seat/service quality in Fleet → Configure.
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {eligible && !canAfford && (
            <div style={{ fontSize: 11, color: '#f87171', marginBottom: 8 }}>
              <Glyph e="✗" /> Need {formatMoney(alliance.initiationFee)} to join
            </div>
          )}
          {eligible && canAfford && hasAnyMembership && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
              Leave your current alliance first
            </div>
          )}
          <button
            className={`btn ${canJoin ? 'btn-primary' : ''}`}
            style={{ width: '100%', fontSize: 12, padding: '7px 0', opacity: canJoin ? 1 : 0.5 }}
            disabled={!canJoin}
            onClick={handleJoin}
          >
            {canJoin ? `Join — ${formatMoney(alliance.initiationFee)}` : 'Unavailable'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Active codeshare row ────────────────────────────────────────────────────

function ActiveCodeshareRow({ agreement, comp, weeklyRevenue, dispatch }) {
  const tier = TIER_META[agreement.competitorTier] ?? TIER_META.legacy;
  const net  = weeklyRevenue - agreement.weeklyFee;

  return (
    <div className="card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
      {comp && <AirlineLogo id={comp.logoId} size={32} radius={6} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{agreement.competitorName}</div>
        <div style={{ fontSize: 11, color: tier.color }}>{tier.label}</div>
      </div>

      <div style={{ textAlign: 'right', fontSize: 12, minWidth: 120 }}>
        <div style={{ color: 'var(--green)', fontWeight: 600 }}>+{formatMoney(weeklyRevenue)}</div>
        <div style={{ color: '#f87171' }}>−{formatMoney(agreement.weeklyFee)}</div>
        <div style={{ color: net >= 0 ? 'var(--green)' : '#f87171', fontWeight: 700, marginTop: 1 }}>
          net {net >= 0 ? '+' : ''}{formatMoney(net)}/wk
        </div>
      </div>

      <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)', minWidth: 70 }}>
        <div>{agreement.weeksRemaining}wk left</div>
        <div style={{ marginTop: 2 }}>
          <div style={{
            height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', borderRadius: 2, background: 'var(--accent)',
              width: `${(agreement.weeksRemaining / CODESHARE_DURATION_WEEKS) * 100}%`,
              transition: 'width 0.3s',
            }} />
          </div>
        </div>
      </div>

      <button
        className="btn"
        style={{
          fontSize: 11, padding: '4px 10px',
          background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-muted)',
        }}
        onClick={() => dispatch({ type: 'CANCEL_CODESHARE', agreementId: agreement.id })}
        title="Cancel agreement"
      >
        Cancel
      </button>
    </div>
  );
}

// ─── Available codeshare partners ────────────────────────────────────────────

function AvailableCodeshares({ competitors, codeshareAgreements, servedAirports, alliancePartnerIds, state, dispatch }) {
  const [filter, setFilter] = useState('all');

  const activePartnerIds = new Set([
    ...codeshareAgreements.map(a => a.competitorId),
    ...alliancePartnerIds,
  ]);

  const available = competitors
    .filter(c => !activePartnerIds.has(c.id))
    .filter(c => filter === 'all' || c.tier === filter)
    .map(c => ({
      comp:    c,
      adjacent: countAdjacentRoutes(c, servedAirports),
      weeklyFee: CODESHARE_WEEKLY_FEE_BY_TIER[c.tier] ?? CODESHARE_WEEKLY_FEE_BY_TIER.legacy,
      estRevenue: partnerInterlineRevenue(c, servedAirports, 1.0),
    }))
    .sort((a, b) => (b.estRevenue - b.weeklyFee) - (a.estRevenue - a.weeklyFee)); // sort by net benefit

  const atCap = codeshareAgreements.length >= MAX_CODESHARE_AGREEMENTS;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>
          AVAILABLE PARTNERS
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {['all', 'legacy', 'budget', 'premium'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="btn"
              style={{
                fontSize: 11, padding: '3px 8px',
                background: filter === f ? 'var(--accent)' : 'var(--surface2)',
                color: filter === f ? '#fff' : 'var(--text-muted)',
                border: '1px solid var(--border)',
              }}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {atCap && (
        <div style={{
          fontSize: 12, color: 'var(--yellow)', background: 'rgba(251,191,36,0.1)',
          padding: '8px 12px', borderRadius: 6, marginBottom: 10,
        }}>
          <Glyph e="⚠" /> Maximum codeshare agreements reached ({MAX_CODESHARE_AGREEMENTS}). Cancel one to add another.
        </div>
      )}

      {available.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Glyph e="🤝" /></div>
          <div className="empty-state-text">
            {filter !== 'all' ? `No available ${filter} partners` : 'All carriers already partnered'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {available.map(({ comp, adjacent, weeklyFee, estRevenue }) => {
            const tier     = TIER_META[comp.tier] ?? TIER_META.legacy;
            const netBenefit = estRevenue - weeklyFee;
            const worthwhile = netBenefit > 0;

            return (
              <div
                key={comp.id}
                className="card"
                style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}
              >
                <AirlineLogo id={comp.logoId} size={30} radius={6} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{comp.name}</div>
                  <div style={{ fontSize: 11, display: 'flex', gap: 10, marginTop: 2 }}>
                    <span style={{ color: tier.color }}>{tier.label}</span>
                    <span style={{ color: 'var(--text-muted)' }}>Hub: {comp.homeHub}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{Object.keys(comp.routes).length} routes</span>
                    <span style={{ color: adjacent > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {adjacent} adjacent
                    </span>
                  </div>
                </div>

                <div style={{ textAlign: 'right', fontSize: 12, minWidth: 130 }}>
                  <div style={{ color: 'var(--green)' }}>+{formatMoney(estRevenue)}/wk</div>
                  <div style={{ color: '#f87171' }}>−{formatMoney(weeklyFee)}/wk</div>
                  <div style={{ fontWeight: 700, color: worthwhile ? 'var(--green)' : '#f87171' }}>
                    net {netBenefit >= 0 ? '+' : ''}{formatMoney(netBenefit)}/wk
                  </div>
                </div>

                <button
                  className={`btn ${worthwhile && !atCap ? 'btn-primary' : ''}`}
                  style={{ fontSize: 12, padding: '6px 14px', opacity: atCap ? 0.5 : 1 }}
                  disabled={atCap}
                  onClick={() => dispatch({ type: 'SIGN_CODESHARE', competitorId: comp.id })}
                >
                  Sign
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function SectionHeader({ children }) {
  return (
    <div style={{
      fontWeight: 700, fontSize: 13, marginBottom: 10,
      color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
      {children}
    </div>
  );
}

function SummaryKPI({ label, value, color, prefix = '', sub }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 14, color: color ?? 'var(--text)' }}>
        {prefix && <span style={{ marginRight: 1 }}>{prefix}</span>}{value}
      </div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function BenefitLine({ icon, label }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
      <span style={{ lineHeight: 1.4, display: 'inline-flex' }}><Glyph e={icon} size={14} /></span>
      <span style={{ color: 'var(--text)', lineHeight: 1.4 }}>{label}</span>
    </div>
  );
}
