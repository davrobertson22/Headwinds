import { useEffect, useRef, useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { formatMoney } from '../utils/simulation.js';
import { AlertIcon, HeartIcon } from './Icons.jsx';

export default function WeeklyDebrief() {
  const { state, dispatch } = useGame();
  const { lastReport, showDebrief, week, year, activeEvents, routes } = state;

  const [displayed, setDisplayed] = useState(0);
  const [phase, setPhase]         = useState('counting'); // 'counting' | 'done'
  const [showCosts, setShowCosts] = useState(false);
  const frameRef = useRef(null);

  const profit = lastReport?.cashDelta ?? 0;

  // Animate the profit counter
  useEffect(() => {
    if (!showDebrief) return;
    setDisplayed(0);
    setPhase('counting');

    const start     = performance.now();
    const duration  = 900;
    const target    = profit;

    function frame(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);   // ease-out cubic
      setDisplayed(Math.round(target * ease));
      if (t < 1) {
        frameRef.current = requestAnimationFrame(frame);
      } else {
        setPhase('done');
      }
    }
    frameRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(frameRef.current);
  }, [showDebrief, profit]);

  if (!showDebrief || !lastReport) return null;

  const isProfit  = profit >= 0;
  const profColor = isProfit ? 'var(--green)' : 'var(--red)';

  const prevProfit = state.financialHistory?.at(-2)?.profit ?? null;
  const trend = prevProfit != null ? profit - prevProfit : null;

  const newEvents          = lastReport.newEvents          ?? [];
  const expiredEvents      = lastReport.expiredEvents      ?? [];
  const compEvents         = lastReport.competitorEvents   ?? [];
  const mechanicalFailures = lastReport.mechanicalFailures ?? [];
  const maintChecks        = lastReport.maintenanceChecks ?? { started: [], forced: [], completed: [], spend: 0 };

  const loyaltyMembers      = lastReport.loyaltyMembersTotal ?? 0;
  const loyaltyMemberDelta  = lastReport.loyaltyMemberDelta  ?? 0;
  const loyaltyCost         = lastReport.totalLoyaltyCost    ?? 0;
  const loyaltyBoost        = lastReport.loyaltyMultiplier   != null
    ? Math.round((lastReport.loyaltyMultiplier - 1) * 100 * 10) / 10
    : 0;
  const showLoyalty = loyaltyMembers > 0 || loyaltyCost > 0;

  // ── Cost breakdown (reconciles exactly to the "All Costs" chip) ──────────
  const r = lastReport;
  const n = v => (typeof v === 'number' ? v : 0);
  const costAll = r.totalCostAll ?? r.totalCost ?? 0;
  const costItems = [
    { label: 'Fuel',                  v: n(r.totalFuel) },
    { label: 'Crew & labor',          v: n(r.totalCrew) + n(r.totalLaborCosts) + n(r.totalFamilyBaseCosts) },
    { label: 'Maintenance',           v: n(r.totalMaintenance) },
    { label: 'Aircraft leases',       v: n(r.totalLeases) },
    { label: 'Airport & ground fees', v: n(r.totalLandingFees) + n(r.totalGateFees) + n(r.totalGroundHandling) },
    { label: 'Catering & service',    v: n(r.totalCatering) + n(r.totalLounge) + n(r.totalQuality) },
    { label: 'Passenger compensation', v: n(r.totalCompensation) + n(r.totalLayover) },
    { label: 'Distribution & partner fees', v: n(r.totalDistributionCost) + n(r.totalPartnerFees) },
    { label: 'Marketing & loyalty',   v: n(r.totalMarketingSpend) + n(r.totalLoyaltyCost) },
    { label: 'Overhead & insurance',  v: n(r.totalHQCost) + n(r.totalHubInvestment) + n(r.totalInsurance) },
    { label: 'Loan payments',         v: n(r.loanPayments) },
    { label: 'Lease redelivery',      v: n(r.leaseRedelivery) },
    { label: 'Seasonal reactivation', v: n(r.seasonalReactivation) },
    { label: 'Corporate tax',         v: n(r.corporateTax) },
  ];
  const knownCosts = costItems.reduce((s, i) => s + i.v, 0);
  const otherCosts = costAll - knownCosts;
  if (Math.abs(otherCosts) >= 1) costItems.push({ label: 'Other', v: otherCosts });
  const costRows = costItems.filter(i => Math.abs(i.v) >= 1);

  function dismiss() {
    dispatch({ type: 'DISMISS_DEBRIEF' });
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,.75)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 900,
      }}
      onClick={e => { if (e.target === e.currentTarget) dismiss(); }}
    >
      <div style={{
        background: 'var(--surface)',
        border: `1px solid ${isProfit ? 'rgba(63,185,80,.4)' : 'rgba(248,81,73,.4)'}`,
        borderRadius: 16,
        maxWidth: 520,
        width: '90%',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: `0 0 60px ${isProfit ? 'rgba(63,185,80,.12)' : 'rgba(248,81,73,.12)'}`,
        animation: 'debrief-in .25s ease',
      }}>

      <div style={{ overflowY: 'auto', padding: '32px 36px 16px', flex: 1 }}>
        {/* Header */}
        <div style={{ marginBottom: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 6 }}>
            Week {week > 1 ? week - 1 : 52} · Year {year} complete
          </div>
          <div style={{ fontSize: 48, fontWeight: 800, color: profColor, letterSpacing: '-2px', lineHeight: 1 }}>
            {displayed >= 0 ? '+' : ''}{formatMoney(displayed)}
          </div>
          {trend != null && phase === 'done' && (
            <div style={{ fontSize: 13, color: trend >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 6 }}>
              {trend >= 0 ? '↑' : '↓'} {formatMoney(Math.abs(trend))} vs last week
            </div>
          )}
        </div>

        {/* Stats row */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20,
        }}>
          <StatChip label="Revenue" value={`+${formatMoney(lastReport.revenueEffective ?? lastReport.totalRevenue)}`} color="var(--green)" />
          <StatChip label="All Costs" value={`−${formatMoney(lastReport.totalCostAll ?? lastReport.totalCost ?? 0)}`} color="var(--red)" />
          <StatChip label="Pax" value={(lastReport.totalPassengers ?? '—').toLocaleString?.()} />
        </div>

        {/* Strike impact strip */}
        {(lastReport.strikeLoss ?? 0) > 0 && (
          <div style={{
            marginBottom: 20, padding: '8px 12px', borderRadius: 8,
            border: '1px solid rgba(248,81,73,.4)', background: 'rgba(248,81,73,.08)',
            fontSize: 12, color: 'var(--text-muted)',
          }}>
            ✊ <b style={{ color: 'var(--red)' }}>Strike impact: −{formatMoney(lastReport.strikeLoss)}</b> in
            revenue lost to cancelled flights this week. Settle the dispute in Operations → Labor.
          </div>
        )}

        {/* Cost breakdown (expandable) */}
        {costRows.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <button
              onClick={() => setShowCosts(s => !s)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'var(--surface2)', border: '1px solid transparent', borderRadius: 8,
                padding: '8px 12px', cursor: 'pointer', color: 'var(--text-muted)',
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
              }}
            >
              <span>Where the money went</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--red)' }}>−{formatMoney(costAll)}</span>
                <span style={{ transform: showCosts ? 'rotate(90deg)' : 'none', transition: 'transform .15s', fontSize: 13 }}>›</span>
              </span>
            </button>
            {showCosts && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {costRows.map((item, i) => {
                  const pct = costAll > 0 ? item.v / costAll : 0;
                  return (
                    <div key={i} style={{ position: 'relative', padding: '6px 12px', borderRadius: 6, overflow: 'hidden' }}>
                      <div style={{
                        position: 'absolute', inset: 0,
                        width: `${Math.max(0, Math.min(100, pct * 100))}%`,
                        background: 'rgba(248,81,73,.10)',
                      }} />
                      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                        <span style={{ color: 'var(--text-muted)' }}>{item.label}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>{Math.round(pct * 100)}%</span>
                          <span style={{ color: 'var(--text)', fontWeight: 600, fontFamily: 'monospace' }}>−{formatMoney(item.v)}</span>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Active events */}
        {(newEvents.length > 0 || activeEvents.length > 0) && (
          <div style={{ marginBottom: 16 }}>
            <SectionLabel>World Events</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {newEvents.map(ev => (
                <EventRow key={ev.id} ev={ev} tag="new" />
              ))}
              {activeEvents.filter(ev => !newEvents.find(n => n.id === ev.id)).map(ev => (
                <EventRow key={ev.id} ev={ev} tag={ev.weeksLeft === 1 ? 'ending' : 'active'} />
              ))}
              {expiredEvents.map(ev => (
                <EventRow key={ev.id} ev={ev} tag="ended" />
              ))}
            </div>
          </div>
        )}

        {/* Mechanical failures */}
        {mechanicalFailures.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <SectionLabel><AlertIcon size={12} /> Mechanical Failures</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {mechanicalFailures.map((f, i) => {
                const affectedRoute = (routes ?? []).find(r => r.aircraftId === f.aircraftId);
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 10px',
                    background: 'rgba(248,81,73,.08)',
                    border: '1px solid rgba(248,81,73,.25)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}>
                    <span style={{ fontSize: 16 }}>{f.icon}</span>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: 600, color: 'var(--red)' }}>{f.aircraftName}</span>
                      {f.tailNumber && <span style={{ color: 'var(--text-dim)', fontFamily: 'monospace', marginLeft: 6 }}>{f.tailNumber}</span>}
                      <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{f.label}</span>
                      {affectedRoute && (
                        <div style={{ marginTop: 3, fontSize: 11, color: 'var(--text-muted)' }}>
                          Route suspended: <span style={{ fontWeight: 600, color: 'var(--text)' }}>{affectedRoute.origin} → {affectedRoute.destination}</span>
                          <span style={{ marginLeft: 6, color: 'var(--text-dim)' }}>{affectedRoute.weeklyFrequency}× / wk</span>
                        </div>
                      )}
                    </div>
                    <span style={{
                      fontSize: 11, padding: '2px 6px', borderRadius: 4,
                      background: 'rgba(248,81,73,.15)', color: 'var(--red)',
                      whiteSpace: 'nowrap',
                    }}>
                      Grounded {f.weeksGrounded}w
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {(maintChecks.started.length + maintChecks.forced.length + maintChecks.completed.length) > 0 && (
          <div style={{ marginBottom: 16 }}>
            <SectionLabel>🔧 Maintenance Checks</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {maintChecks.forced.map((c, i) => (
                <div key={'mf' + i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'rgba(248,81,73,.08)', border: '1px solid rgba(248,81,73,.25)', borderRadius: 8, fontSize: 12 }}>
                  <span style={{ fontSize: 16 }}>⚠️</span>
                  <div style={{ flex: 1 }}><span style={{ fontWeight: 600, color: 'var(--red)' }}>{c.name}</span> <span style={{ color: 'var(--text-muted)' }}>regulator-forced {c.checkType} check</span></div>
                  <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'rgba(248,81,73,.15)', color: 'var(--red)', whiteSpace: 'nowrap' }}>−{formatMoney(c.cost)} · {c.weeks}w</span>
                </div>
              ))}
              {maintChecks.started.map((c, i) => (
                <div key={'ms' + i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'rgba(56,139,253,.08)', border: '1px solid rgba(56,139,253,.25)', borderRadius: 8, fontSize: 12 }}>
                  <span style={{ fontSize: 16 }}>🔧</span>
                  <div style={{ flex: 1 }}><span style={{ fontWeight: 600, color: 'var(--accent)' }}>{c.name}</span> <span style={{ color: 'var(--text-muted)' }}>{c.checkType} check started</span></div>
                  <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'rgba(56,139,253,.15)', color: 'var(--accent)', whiteSpace: 'nowrap' }}>−{formatMoney(c.cost)} · {c.weeks}w</span>
                </div>
              ))}
              {maintChecks.completed.map((c, i) => (
                <div key={'mc' + i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'rgba(63,185,80,.08)', border: '1px solid rgba(63,185,80,.25)', borderRadius: 8, fontSize: 12 }}>
                  <span style={{ fontSize: 16 }}>✅</span>
                  <div style={{ flex: 1 }}><span style={{ fontWeight: 600, color: 'var(--green)' }}>{c.name}</span> <span style={{ color: 'var(--text-muted)' }}>{c.checkType} check complete — back in service</span></div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Competitor events */}
        {compEvents.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <SectionLabel>Competitor Activity</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {compEvents.slice(0, 6).map((ev, i) => {
                let text;
                if (typeof ev === 'string') {
                  text = ev;
                } else if (ev.description) {
                  text = ev.description;
                } else if (ev.airlineId && ev.routeKey) {
                  const comp = (state.competitors ?? []).find(c => c.id === ev.airlineId);
                  const name = comp?.name ?? ev.airlineId;
                  const [a, b] = ev.routeKey.split('-');
                  text = ev.isUpgrade
                    ? `${name} upgraded service on ${a} → ${b}`
                    : `${name} launched new service on ${a} → ${b}`;
                } else {
                  text = JSON.stringify(ev);
                }
                return (
                  <div key={i} style={{
                    fontSize: 12, color: 'var(--text-muted)',
                    padding: '5px 10px',
                    background: 'var(--surface2)',
                    borderRadius: 6,
                  }}>
                    {text}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Loyalty program snapshot */}
        {showLoyalty && (
          <div style={{ marginBottom: 16 }}>
            <SectionLabel><HeartIcon size={12} /> Loyalty Program</SectionLabel>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
            }}>
              <StatChip
                label="Members"
                value={loyaltyMembers.toLocaleString()}
                color="var(--text)"
              />
              <StatChip
                label="Enrolled"
                value={loyaltyMemberDelta >= 0 ? `+${loyaltyMemberDelta.toLocaleString()}` : loyaltyMemberDelta.toLocaleString()}
                color={loyaltyMemberDelta >= 0 ? 'var(--green)' : 'var(--red)'}
              />
              <StatChip
                label="Program Cost"
                value={`−${formatMoney(loyaltyCost)}`}
                color="var(--red)"
              />
            </div>
            {loyaltyBoost > 0 && (
              <div style={{
                marginTop: 8, padding: '6px 10px',
                background: 'rgba(63,185,80,.08)', border: '1px solid rgba(63,185,80,.2)',
                borderRadius: 7, fontSize: 12, color: 'var(--green)',
              }}>
                +{loyaltyBoost}% demand retention from loyal members this week
              </div>
            )}
          </div>
        )}

      </div>{/* end scrollable area */}

        {/* Continue — always visible */}
        <div style={{ padding: '12px 36px 24px', flexShrink: 0 }}>
          <button
            onClick={dismiss}
            style={{
              width: '100%', padding: '12px',
              background: isProfit ? 'var(--green)' : 'var(--surface2)',
              color: isProfit ? '#000' : 'var(--text)',
              border: 'none', borderRadius: 10,
              fontSize: 15, fontWeight: 700,
              cursor: 'pointer',
              transition: 'opacity .15s',
            }}
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}

function StatChip({ label, value, color }) {
  return (
    <div style={{
      background: 'var(--surface2)', borderRadius: 8,
      padding: '10px 12px', textAlign: 'center',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: color ?? 'var(--text)' }}>
        {value ?? '—'}
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '.07em', color: 'var(--text-dim)',
      marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5,
    }}>
      {children}
    </div>
  );
}

function EventRow({ ev, tag }) {
  const tagStyles = {
    new:    { bg: `${ev.color}25`, color: ev.color, label: 'NEW' },
    active: { bg: 'var(--surface2)', color: 'var(--text-muted)', label: `${ev.weeksLeft}w left` },
    ending: { bg: 'rgba(210,153,34,.15)', color: 'var(--yellow)', label: 'ending soon' },
    ended:  { bg: 'var(--surface2)', color: 'var(--text-dim)', label: 'ended' },
  }[tag] ?? { bg: 'var(--surface2)', color: 'var(--text-muted)', label: '' };

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '7px 10px',
      background: tagStyles.bg,
      borderRadius: 7,
      border: tag === 'new' ? `1px solid ${ev.color}40` : '1px solid transparent',
    }}>
      <span style={{ fontSize: 14, lineHeight: 1.3, flexShrink: 0 }}>{ev.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: tagStyles.color, marginBottom: 1 }}>{ev.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>{ev.description}</div>
      </div>
      <span style={{
        fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
        color: tagStyles.color, flexShrink: 0, marginTop: 2,
      }}>
        {tagStyles.label}
      </span>
    </div>
  );
}
