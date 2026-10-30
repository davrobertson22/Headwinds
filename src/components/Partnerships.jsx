import { useMemo, useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { useConfirm } from './ConfirmModal.jsx';
import { formatMoney, routeStops, currentGameDate, fleetAvgUtilization } from '../utils/simulation.js';
import { laborEffects } from '../data/labor.js';
import {
  TRAVEL_PARTNERS, TRAVEL_PARTNER_MAP, TP_TYPES, TP_TYPE_ORDER, TP_INSTALMENTS, TP_TERM_WEEKS,
  TP_LOST_COOLDOWN_WEEKS, TP_WALKOUT_LEVEL, TP_WALKOUT_WEEKS, TP_REP_BREAK_PER_PROM,
  TP_AUTORENEW_MIN_HAPPINESS, TP_RENEWAL_WINDOW,
  travelPartnerAirports, travelPartnerInSeason, seasonLabel, travelPartnerListFee, weeksToNextTravelReprice,
  canSignTravelPartner, makeTravelPartnerContract, travelSignHappiness, scoreTravelContract,
  measureTravelPartners, travelPartnerMood, travelLiftScale, travelRenewalOffer, inTravelRenewalWindow,
  travelContractWeeksLeft, travelBreakCost, contractTargets, requirementLabel, formatRequirementValue,
  dueTravelInstalments,
} from '../data/travelPartners.js';
import { absoluteWeek } from '../../packages/engine/src/utils/fuel.js';

/**
 * Travel partnerships — cruise lines, tour operators, hotel chains, ride share.
 *
 * Every number here comes from data/travelPartners.js, the same functions the
 * reducer signs with and the tick scores, charges and renews through. "Your
 * figure" is last week's delivery, measured from last week's route results the
 * same way the tick measures it; the happiness target is the one the tick is
 * steering towards.
 */

const MOOD_COLOR = {
  delighted: 'var(--green)', content: '#5cb85c', lukewarm: 'var(--yellow)',
  frustrated: '#e8833a', hostile: 'var(--red)',
};
const moodColor = (h) => MOOD_COLOR[travelPartnerMood(h).id] ?? 'var(--text-muted)';
const attainColor = (a) => (a >= 1 ? 'var(--green)' : a >= 0.8 ? 'var(--yellow)' : 'var(--red)');
const SEG_COLOR = { leisure: '#e879a0', business: '#5c9de0' };
const money = (n) => formatMoney(n ?? 0);

function Bar({ value, max = 100, color, marker = null, height = 6 }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div style={{ position: 'relative', height, background: 'var(--surface2)', borderRadius: height, overflow: 'visible' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: height, transition: 'width .3s' }} />
      {marker != null && (
        <div title="Where happiness is heading" style={{
          position: 'absolute', top: -3, left: `calc(${Math.max(0, Math.min(100, marker))}% - 1px)`,
          width: 2, height: height + 6, background: 'var(--text)', opacity: 0.7, borderRadius: 1,
        }} />
      )}
    </div>
  );
}

function CoverageChips({ partner }) {
  const [open, setOpen] = useState(false);
  const codes = [...travelPartnerAirports(partner)].sort();
  const explicit = partner.coverage.every(c => c.kind === 'airports');
  const shown = open || explicit ? codes : codes.slice(0, 10);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
      {shown.map(c => (
        <span key={c} style={{ fontSize: 10, fontFamily: 'var(--mono, monospace)', padding: '1px 5px',
          borderRadius: 4, border: '1px solid var(--border)', color: 'var(--text-muted)' }}>{c}</span>
      ))}
      {!open && shown.length < codes.length && (
        <button className="btn btn-sm" style={{ fontSize: 10, padding: '0 6px' }} onClick={() => setOpen(true)}>
          +{codes.length - shown.length} more
        </button>
      )}
    </div>
  );
}

function RequirementRows({ partner, score, targets, actuals }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
      {partner.requirements.map((req, i) => {
        const t = targets[i];
        const a = actuals?.[i];
        const att = score?.attain?.[i];
        // Bar length is attainment (what the partner scores), so a rate target
        // missed by a few points reads as the miss it is, not as 95% full.
        const ratio = att != null ? Math.min(1, att) : a == null ? 0 : Math.min(1, a / Math.max(1, t));
        return (
          <div key={i} data-tp-req={req.kind}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
              <span style={{ color: 'var(--text-muted)' }}>{requirementLabel(req)}</span>
              <span>
                <strong style={{ color: att != null ? attainColor(att) : 'var(--text)' }}>{formatRequirementValue(req, a)}</strong>
                <span style={{ color: 'var(--text-dim)' }}> / {formatRequirementValue(req, t)}</span>
              </span>
            </div>
            <Bar value={ratio * 100} color={att != null ? attainColor(att) : 'var(--text-dim)'} height={4} />
          </div>
        );
      })}
    </div>
  );
}

export default function Partnerships() {
  const { state, dispatch } = useGame();
  const confirm = useConfirm();
  const absWeek = absoluteWeek(state.year ?? 1, state.week ?? 1);
  const month = currentGameDate(state).month;
  const partners = state.travelPartners ?? {};
  const memory = state.travelPartnerMemory ?? {};
  const report = state.lastReport ?? {};
  const scores = report.travelPartnerScores ?? {};
  const reputation = report.reputationScore ?? 0;
  const pending = dueTravelInstalments(partners, absWeek).reduce((s, d) => s + d.amount, 0);
  const cash = (state.cash ?? 0) - pending;

  // Last week's delivery against every partner's requirements — the tick's own
  // measurement, run over last week's route results.
  const measured = useMemo(() => {
    const util = fleetAvgUtilization(state.fleet ?? [], [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]);
    return measureTravelPartners(TRAVEL_PARTNERS.map(p => p.id), {
      routes: state.routes ?? [], routeResults: report.routeResults ?? [], fleet: state.fleet ?? [],
      onTimeRate: laborEffects(state.labor ?? null, util, state.satisfaction ?? null).onTimeRate,
      month, stopsOf: routeStops,
    });
  }, [state.routes, state.fleet, state.labor, state.satisfaction, report.routeResults, month]);  // eslint-disable-line

  if (state.partnershipsWorld !== true) {
    return (
      <div className="card" style={{ padding: '14px 18px' }}>
        <div className="card-title">Travel Partnerships</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          This world was created before travel partnerships existed, so there are no partners to sign here.
          Every world created from now on has them.
        </div>
      </div>
    );
  }

  const active = TP_TYPE_ORDER.flatMap(t => Object.values(partners)
    .filter(c => TRAVEL_PARTNER_MAP[c.partnerId]?.type === t));
  const anyAutoOff = active.some(c => c.autoRenew === false);

  const sign = async (p, check) => {
    const startH = travelSignHappiness(memory, p.id);
    if (await confirm({
      title: `Partner with ${p.name}?`,
      body: `${money(check.fee)} a year for 2 years — the first year is charged this week, the second in a year.\n\n`
          + `${TP_TYPES[p.type].segment === 'leisure' ? 'Leisure' : 'Business'} demand +${Math.round(p.lift * 100)}% on routes to `
          + `its airports${p.season ? ` (${seasonLabel(p)} only)` : ''}. In return:\n`
          + p.requirements.map(r => `• ${requirementLabel(r)}: ${formatRequirementValue(r, r.min)}`).join('\n')
          + `\n\nThey start at ${startH} happiness and give you 8 weeks to add flights before they judge you. `
          + `Below ${TP_WALKOUT_LEVEL} for ${TP_WALKOUT_WEEKS} weeks they walk out and won't work with you for 5 years.`,
      confirmLabel: `Sign — ${money(check.fee)}/yr`,
    })) dispatch({ type: 'SIGN_TRAVEL_PARTNER', partnerId: p.id });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-partnerships>
      <div className="card" style={{ padding: '14px 18px' }}>
        <div className="card-title">Travel Partnerships</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>
          Cruise lines and tour operators bring <strong style={{ color: SEG_COLOR.leisure }}>leisure</strong> travellers
          to their airports; hotel chains and ride share bring <strong style={{ color: SEG_COLOR.business }}>business</strong> travellers.
          Each wants something back — passengers delivered, airports served, punctuality, a proper cabin. Meet the brief and a
          partner settles at around 80 happiness; beat it to delight them. Every deal runs 2 years. Happy partners renew cheaply
          and on the same terms; frustrated ones charge more, raise their targets, stop promoting you and cost you reputation.
          A partner that walks out — or refuses to renew — won't work with you again for 5 years.
        </div>
      </div>

      {/* ── Your partners ─────────────────────────────────────────────── */}
      <div className="card" style={{ padding: '14px 18px' }}>
        <div className="form-label" style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>Your partners</span>
          {active.length > 0 && (
            <label style={{ fontSize: 11, fontWeight: 400, textTransform: 'none', letterSpacing: 0, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={!anyAutoOff}
                onChange={(e) => dispatch({ type: 'SET_TRAVEL_PARTNER_AUTORENEW', partnerId: 'all', on: e.target.checked })} />
              Auto-renew all
            </label>
          )}
        </div>
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>None yet — pick one from the book below.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
            {active.map(c => {
              const p = TRAVEL_PARTNER_MAP[c.partnerId];
              const type = TP_TYPES[p.type];
              const h = c.happiness ?? 60;
              const mood = travelPartnerMood(h);
              const score = scores[c.partnerId];
              const inSeason = travelPartnerInSeason(p, month);
              const liftNow = inSeason ? p.lift * travelLiftScale(h) : 0;
              const left = travelContractWeeksLeft(c, absWeek);
              const offer = travelRenewalOffer(c, absWeek);
              const inWindow = inTravelRenewalWindow(c, absWeek);
              const breakCost = travelBreakCost(c);
              const autoWill = c.autoRenew !== false && h >= TP_AUTORENEW_MIN_HAPPINESS;
              const targets = contractTargets(c);
              const actuals = score?.actuals ?? measured[c.partnerId]?.actuals;
              return (
                <div key={c.partnerId} data-tp-active={c.partnerId}
                  style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', background: 'var(--surface)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{type.icon} {p.name}</div>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{left} wk left</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                    {p.coverageLabel} · {seasonLabel(p)} · {money(c.annualFee)}/yr
                    {(c.instalmentsPaid ?? 0) < TP_INSTALMENTS && (c.instalmentsPaid ?? 0) > 0 ? ' · year 2 still to pay' : ''}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: moodColor(h) }}>{mood.label}</span>
                    <span style={{ fontSize: 12 }}>
                      <strong style={{ color: moodColor(h) }}>{Math.round(h)}</strong>
                      {score?.T != null && Math.abs(score.T - h) >= 1 && (
                        <span style={{ color: 'var(--text-dim)' }}> → heading to {Math.round(score.T)}</span>
                      )}
                      {score?.T == null && score && <span style={{ color: 'var(--text-dim)' }}> · out of season, holding</span>}
                    </span>
                  </div>
                  <Bar value={h} color={moodColor(h)} marker={score?.T ?? null} />
                  {absWeek < (c.graceUntil ?? 0) && (
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                      Settling in — happiness can only rise for {c.graceUntil - absWeek} more week{c.graceUntil - absWeek === 1 ? '' : 's'}.
                    </div>
                  )}
                  {(c.lowWeeks ?? 0) > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>
                      Below {TP_WALKOUT_LEVEL} for {c.lowWeeks} week{c.lowWeeks === 1 ? '' : 's'} — they walk at {TP_WALKOUT_WEEKS}.
                    </div>
                  )}

                  <div style={{ fontSize: 11, marginTop: 8, color: 'var(--text-muted)' }}>
                    Lift now:{' '}
                    <strong style={{ color: liftNow > 0 ? SEG_COLOR[type.segment] : 'var(--text-dim)' }}>
                      {liftNow > 0 ? `+${(liftNow * 100).toFixed(1)}% ${type.segment}` : inSeason ? 'none — too unhappy to promote you' : 'none — out of season'}
                    </strong>
                    {liftNow > 0 && liftNow < p.lift && <span style={{ color: 'var(--yellow)' }}> (of {Math.round(p.lift * 100)}%)</span>}
                  </div>

                  <RequirementRows partner={p} score={score} targets={targets} actuals={actuals} />

                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
                    {c.renewal ? (
                      <span style={{ color: 'var(--green)' }}>Renewal agreed — {money(c.renewal.annualFee)}/yr from week {absWeek + left}.</span>
                    ) : offer.refuses ? (
                      <span style={{ color: 'var(--red)' }}>Won't renew at this happiness — lift it above {TP_WALKOUT_LEVEL} or lose them for 5 years at the end of the term.</span>
                    ) : (
                      <span>
                        Renewal at today's happiness: <strong>{money(offer.annualFee)}/yr</strong> ({offer.mood.label.toLowerCase()}
                        {offer.tighten > (c.tighten ?? 0) ? ', targets +15%' : ''}).
                        {' '}{inWindow ? '' : `Opens ${TP_RENEWAL_WINDOW} weeks before the end. `}
                        {autoWill ? 'Will auto-renew.' : c.autoRenew === false ? 'Auto-renew is off.' : `Won't auto-renew below ${TP_AUTORENEW_MIN_HAPPINESS}.`}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {inWindow && !c.renewal && !offer.refuses && (
                      <button className="btn btn-sm btn-primary" style={{ fontSize: 11 }}
                        onClick={async () => {
                          if (await confirm({
                            title: `Renew ${p.name} for 2 more years?`,
                            body: `${money(offer.annualFee)} a year, starting when this term ends in ${left} weeks. `
                                + `The price is set by how happy they are today (${offer.mood.label.toLowerCase()}).`
                                + (offer.tighten > (c.tighten ?? 0) ? '\n\nThey are frustrated, so the new term comes with targets 15% higher.' : ''),
                            confirmLabel: `Renew — ${money(offer.annualFee)}/yr`,
                          })) dispatch({ type: 'RENEW_TRAVEL_PARTNER', partnerId: c.partnerId });
                        }}>
                        Renew — {money(offer.annualFee)}/yr
                      </button>
                    )}
                    <label style={{ fontSize: 11, display: 'inline-flex', gap: 4, alignItems: 'center', color: 'var(--text-muted)' }}>
                      <input type="checkbox" checked={c.autoRenew !== false}
                        onChange={(e) => dispatch({ type: 'SET_TRAVEL_PARTNER_AUTORENEW', partnerId: c.partnerId, on: e.target.checked })} />
                      Auto-renew
                    </label>
                    <button className="btn btn-sm"
                      style={{ fontSize: 11, marginLeft: 'auto', background: 'rgba(248,81,73,0.08)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.3)' }}
                      onClick={async () => {
                        if (await confirm({
                          title: `End the ${p.name} partnership early?`,
                          body: `It costs ${money(breakCost)} (half of what is still unpaid) and about `
                              + `${(TP_REP_BREAK_PER_PROM * p.prominence).toFixed(1)} reputation points, fading over a few months.\n\n`
                              + `${p.name} will remember: if you sign again, they start at 40 happiness.`,
                          danger: true,
                          confirmLabel: breakCost > 0 ? `End it — ${money(breakCost)}` : 'End it',
                        })) dispatch({ type: 'BREAK_TRAVEL_PARTNER', partnerId: c.partnerId });
                      }}>
                      End early
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── The book ──────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: '14px 18px' }}>
        <div className="form-label" style={{ marginBottom: 6, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <span>Partners on offer</span>
          <span style={{ fontWeight: 400, color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0 }}>
            prices move in {weeksToNextTravelReprice(absWeek)} weeks · your figures are last week's
          </span>
        </div>
        {TP_TYPE_ORDER.map(t => {
          const type = TP_TYPES[t];
          const rows = TRAVEL_PARTNERS.filter(p => p.type === t);
          return (
            <div key={t} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, margin: '10px 0 6px', display: 'flex', gap: 8, alignItems: 'center' }}>
                <span>{type.icon} {type.plural}</span>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 600,
                  color: SEG_COLOR[type.segment], border: `1px solid ${SEG_COLOR[type.segment]}55` }}>
                  {type.segment} demand
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                {rows.map(p => {
                  const held = partners[p.id];
                  const check = canSignTravelPartner(p.id, {
                    partners, memory, absWeek, reputation, cash, worldOn: true,
                  });
                  const fee = check.fee ?? travelPartnerListFee(p.id, absWeek);
                  const m = measured[p.id];
                  const preview = m ? scoreTravelContract(
                    { ...makeTravelPartnerContract(p.id, absWeek), tighten: 0 }, { ...m, inForce: true }) : null;
                  const cool = memory[p.id]?.cooldownUntil;
                  const servesAny = (state.routes ?? []).some(r => routeStops(r).some(code => travelPartnerAirports(p).has(code)));
                  const cooling = cool != null && absWeek < cool;
                  return (
                    <div key={p.id} data-tp-book={p.id}
                      style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
                        opacity: held || cooling ? 0.6 : 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{p.name}</div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: SEG_COLOR[type.segment] }}>+{Math.round(p.lift * 100)}%</div>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{p.blurb}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        {p.coverageLabel} · {seasonLabel(p)}
                        {p.reputationMin != null && <> · reputation {p.reputationMin}+</>}
                        {' · '}<strong>{money(fee)}/yr</strong> × 2
                      </div>
                      <CoverageChips partner={p} />
                      <RequirementRows partner={p} score={preview} targets={p.requirements.map(r => r.min)} actuals={m?.actuals} />
                      {!held && !servesAny && (
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
                          You don't fly to any of its airports yet.
                        </div>
                      )}
                      {preview?.T != null && !held && servesAny && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                          At last week's network they'd settle around{' '}
                          <strong style={{ color: moodColor(preview.T) }}>{Math.round(preview.T)}</strong>
                          {' '}({travelPartnerMood(preview.T).refuses ? 'they would walk out' : travelPartnerMood(preview.T).label.toLowerCase()}).
                        </div>
                      )}
                      <div style={{ marginTop: 8 }}>
                        {held ? (
                          <span style={{ fontSize: 11, color: 'var(--green)' }}>Signed.</span>
                        ) : cooling ? (
                          <span style={{ fontSize: 11, color: 'var(--red)' }}>
                            Won't work with you until week {cool} ({Math.ceil((cool - absWeek) / 52)} yr).
                          </span>
                        ) : (
                          <button className="btn btn-sm btn-primary" style={{ fontSize: 11 }}
                            disabled={!check.ok} title={check.ok ? undefined : check.reasons[0]}
                            onClick={() => check.ok && sign(p, check)}>
                            Sign — {money(fee)}/yr
                          </button>
                        )}
                        {!held && !cooling && !check.ok && (
                          <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 4 }}>{check.reasons[0]}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          The book is the same for every airline in the world, and partners aren't exclusive: if a rival on your route signs the
          same partner, its lift cancels yours out there. A {TP_TERM_WEEKS / 52}-year term; losing a partner locks it away for {TP_LOST_COOLDOWN_WEEKS / 52} years.
        </div>
      </div>
    </div>
  );
}
