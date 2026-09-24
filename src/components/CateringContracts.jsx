import { useGame } from '../store/GameContext.jsx';
import { useConfirm } from './ConfirmModal.jsx';
import { formatMoney, routeStops } from '../utils/simulation.js';
import { CATERING_LEVELS } from '../data/catering.js';
import {
  CATERING_TERMS, CATERING_SUPPLIER_MAP, CATERING_BREAK_FRACTION,
  cateringOfferBook, weeksToNextReprice, canSignCatering, coverageLabel, coverageKey,
  airportSeatsMap, coverageVolume, volumeSurchargeMult, contractWeeksLeft, cateringBreakCost,
} from '../data/cateringContracts.js';
import { absoluteWeek } from '../../packages/engine/src/utils/fuel.js';

/**
 * Catering contracts — the supplier book and the deals you've signed.
 *
 * Every number here comes from data/cateringContracts.js, the same functions the
 * reducer signs and breaks with and the tick charges through, so the card never
 * quotes a rate the game will not charge. Rates are shown against the standard
 * (contract-free) catering bill: −19% means 19% cheaper than today's rate.
 */

const pct = (factor) => {
  const d = Math.round((factor - 1) * 100);
  return d === 0 ? 'standard rate' : `${d > 0 ? '+' : '−'}${Math.abs(d)}%`;
};
const pctColor = (factor) => (factor < 0.995 ? 'var(--green)' : factor > 1.005 ? 'var(--red)' : 'var(--text-muted)');
const KIND_ORDER = { country: 0, continent: 1, global: 2 };
const KIND_LABEL = { global: 'Worldwide', continent: 'Continental', country: 'Single country' };

export default function CateringContracts() {
  const { state, dispatch } = useGame();
  const confirm = useConfirm();
  const absWeek   = absoluteWeek(state.year, state.week);
  const contracts = state.cateringContracts ?? {};
  const seats     = airportSeatsMap(state.routes ?? [], state.fleet ?? [], routeStops);
  const book      = cateringOfferBook(absWeek);
  const spend     = state.lastReport?.cateringContractSpend ?? {};
  const active    = Object.values(contracts).sort((a, b) =>
    (KIND_ORDER[a.coverage.kind] - KIND_ORDER[b.coverage.kind]) || coverageLabel(a.coverage).localeCompare(coverageLabel(b.coverage)));

  return (
    <div className="card" style={{ padding: '14px 18px' }}>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        Sign a caterer to cover a country, a continent or the world. At every airport it covers it sets what your
        meals cost and how good they can be — a budget caterer is cheap but can't serve a full meal service, a
        premium one lifts quality at a price. Where you run a hub, your own flight kitchen cooks instead whenever it
        is cheaper. The most specific deal wins: a country contract beats a continental one beats a global one.
        Longer terms lock in a lower rate; leaving early costs {Math.round(CATERING_BREAK_FRACTION * 100)}% of the
        spend you walk away from.
      </div>

      {/* ── Signed ─────────────────────────────────────────────────────── */}
      <div className="form-label" style={{ marginBottom: 6 }}>Your contracts</div>
      {active.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 14 }}>
          None — every airport pays the standard catering rate.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {active.map(c => {
            const s = CATERING_SUPPLIER_MAP[c.supplierId];
            const vol = coverageVolume(c.coverage, seats);
            const sur = volumeSurchargeMult(vol, c.minVolume);
            const eff = c.costFactor * sur;
            const left = contractWeeksLeft(c, absWeek);
            const lastSpend = spend[c.id] ?? 0;
            const breakCost = cateringBreakCost(c, absWeek, lastSpend);
            return (
              <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6 }}>
                <div style={{ flex: '1 1 240px' }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {s?.name ?? c.supplierId} <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· {coverageLabel(c.coverage)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    <span style={{ color: pctColor(eff) }}>{pct(eff)}</span>
                    {sur > 1 && <span style={{ color: 'var(--yellow)' }}> (incl. +{Math.round((sur - 1) * 100)}% small-carrier surcharge)</span>}
                    {' · '}up to {CATERING_LEVELS[c.qualityCap]?.name ?? c.qualityCap}
                    {' · '}quality {c.qualityDelta >= 0 ? '+' : ''}{c.qualityDelta}
                    {' · '}{left} weeks left
                    {lastSpend > 0 && <> · {formatMoney(lastSpend)} last week</>}
                  </div>
                </div>
                <button
                  className="btn btn-sm"
                  style={{ fontSize: 12, background: 'rgba(248,81,73,0.08)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.3)' }}
                  onClick={async () => {
                    if (await confirm({
                      title: `Break the ${s?.name ?? ''} contract?`,
                      body: `${left} weeks remain. Leaving now costs ${formatMoney(breakCost)} — `
                          + `${Math.round(CATERING_BREAK_FRACTION * 100)}% of what you'd have spent at last week's `
                          + `rate${lastSpend > 0 ? '' : ' (nothing yet — it hasn\'t catered a week)'}.\n\n`
                          + `${coverageLabel(c.coverage)} airports go back to the standard rate, or to a broader `
                          + `contract you hold.`,
                      danger: true,
                      confirmLabel: breakCost > 0 ? `Break for ${formatMoney(breakCost)}` : 'Break contract',
                    })) {
                      dispatch({ type: 'BREAK_CATERING_CONTRACT', id: c.id });
                    }
                  }}
                >
                  Break — {formatMoney(breakCost)}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── The book ───────────────────────────────────────────────────── */}
      <div className="form-label" style={{ marginBottom: 6, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>Supplier book</span>
        <span style={{ fontWeight: 400, color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0 }}>
          re-prices in {weeksToNextReprice(absWeek)} weeks
        </span>
      </div>
      {['country', 'continent', 'global'].map(kind => {
        const rows = book.filter(o => o.coverage.kind === kind);
        if (rows.length === 0) return null;
        return (
          <div key={kind} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '6px 0 4px' }}>{KIND_LABEL[kind]}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.map(o => {
                const vol = coverageVolume(o.coverage, seats);
                const sur = volumeSurchargeMult(vol, o.minVolume);
                const held = Object.values(contracts).find(c => coverageKey(c.coverage) === coverageKey(o.coverage));
                return (
                  <div key={o.id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                    padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6,
                    opacity: held && held.supplierId !== o.id ? 0.6 : 1 }}>
                    <div style={{ flex: '1 1 260px' }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        {o.name} <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· {coverageLabel(o.coverage)}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{o.blurb}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        up to {CATERING_LEVELS[o.qualityCap]?.name ?? o.qualityCap}
                        {' · '}quality {o.qualityDelta >= 0 ? '+' : ''}{o.qualityDelta}
                        {' · '}{vol > 0
                          ? <>you fly {vol.toLocaleString()} seats/wk here{sur > 1
                              ? <span style={{ color: 'var(--yellow)' }}> — under their {o.minVolume.toLocaleString()} minimum, +{Math.round((sur - 1) * 100)}% surcharge</span>
                              : null}</>
                          : <span>you don't fly here yet</span>}
                      </div>
                      {held && <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 2 }}>
                        {held.supplierId === o.id ? 'Signed.' : `You hold a ${coverageLabel(o.coverage)} contract with ${CATERING_SUPPLIER_MAP[held.supplierId]?.name}.`}
                      </div>}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {o.terms.map(t => {
                        const check = canSignCatering(o.id, t.years, contracts);
                        const eff = t.costFactor * sur;
                        return (
                          <button
                            key={t.years}
                            className={check.ok ? 'btn btn-sm' : 'btn btn-sm'}
                            disabled={!check.ok}
                            title={check.ok ? undefined : check.reasons[0]}
                            style={{ fontSize: 11, cursor: check.ok ? 'pointer' : 'not-allowed', display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.2 }}
                            onClick={async () => {
                              if (!check.ok) return;
                              if (await confirm({
                                title: `Sign ${o.name} for ${t.years} year${t.years > 1 ? 's' : ''}?`,
                                body: `${coverageLabel(o.coverage)} catering at ${pct(t.costFactor)} of the standard rate, `
                                    + `locked for ${t.weeks} weeks${sur > 1 ? ` (plus a ${Math.round((sur - 1) * 100)}% surcharge while you fly under their minimum)` : ''}. `
                                    + `They can serve up to ${CATERING_LEVELS[o.qualityCap]?.name}; routes set higher are served — and charged — at that level.\n\n`
                                    + `Leaving early costs ${Math.round(CATERING_BREAK_FRACTION * 100)}% of the remaining spend.`,
                                confirmLabel: 'Sign contract',
                              })) {
                                dispatch({ type: 'SIGN_CATERING_CONTRACT', supplierId: o.id, years: t.years });
                              }
                            }}
                          >
                            <span>{t.years} yr</span>
                            <span style={{ color: pctColor(eff), fontWeight: 600 }}>{pct(eff)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
