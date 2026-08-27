// MAINTENANCE PAGE — the airline's whole MRO picture in one place.
//
// Line-maintenance budget, heavy C/D checks, the jet-base network you build,
// what is in the shop right now, what is coming due, and the outsourced
// contracts a base offsets. Moved out of Operations so maintenance is a place
// you go rather than a slider you forget.
import { useState, useEffect } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { DEFAULT_LABOR_STATE, DEFAULT_MAINTENANCE_BUDGET } from '../data/labor.js';
import {
  AIRCRAFT_FAMILY, FAMILY_INFO, FAMILY_CATEGORY_LABEL,
  activeFamilies as getActiveFamilies, weeklyFamilyBaseCost,
} from '../data/families.js';
import {
  dueInfo, checkCost, checkDurationWeeks, groundedKind,
  autoSchedulingActive, AUTO_SCHEDULE_PAY_MIN, AUTO_SCHEDULE_BUDGET_MIN,
} from '../data/maintenance.js';
import {
  mroLevelDef, canBuildBase, upgradeCapex, closeRefund, certCapacity,
  addCertCapex, addCertOpex, certsIncludedLeft, certsFull,
  baseEfficiency, baseSlots, baseWeeklyCost, totalBaseWeeklyCost, isBaseOpen,
  resolveBaseFor, mroFactorsFor, familyContractOffsets,
  clampPartsPool, partsPoolCost, partsPoolDurationMult,
  MRO_MAX_LEVEL, MRO_MAX_CERTS_PER_BASE, MRO_RAMP_WEEKS, PARTS_POOL_MIN, PARTS_POOL_MAX,
} from '../data/mroBase.js';
import { getAircraftType } from '../data/aircraft.js';
import { formatMoney } from '../utils/simulation.js';
import { absoluteWeek } from '../utils/fuel.js';
import { Glyph } from './Icons.jsx';

const sliderStyle = { width: '100%' };

function SectionHeader({ label, right = null }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
      textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: 20, marginBottom: 10,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <span>{label}</span>
      {right}
    </div>
  );
}

// ─── Maintenance budget card ──────────────────────────────────────────────────

function MaintenanceCard({ budget: committedBudget, fleetMaintTotal, maintBudgetUsed, dispatch }) {
  // Local draft so a drag updates the thumb + live projection without dispatching
  // on every intermediate value; the actual SET_MAINTENANCE_BUDGET fires once, on
  // release (mouse/touch/keyboard). Re-syncs if the committed value changes (tick).
  const [draftBudget, setDraftBudget] = useState(committedBudget);
  useEffect(() => setDraftBudget(committedBudget), [committedBudget]);
  const commitBudget = (v) => dispatch({ type: 'SET_MAINTENANCE_BUDGET', multiplier: v });
  const budget = draftBudget;
  // Aging rate: 0.5→1.25 faster, 1.0→1.0 normal, 2.0→0.5 slower
  const agingRate = Math.max(0.5, 1 + (1 - budget) * 0.5);
  const agingColor = agingRate > 1.1 ? 'var(--red)' : agingRate < 0.9 ? 'var(--green)' : 'var(--text-muted)';

  // Live projection: last week's actual maintenance scaled to the current slider.
  // Maintenance cost is ~linear in the budget multiplier, so projected next-week
  // spend ≈ lastActual × (currentBudget / budgetThatProducedLastActual). This
  // makes the headline figure respond to the slider instead of showing a static
  // historical number (which only refreshes on the weekly tick).
  const baselineBudget = maintBudgetUsed > 0 ? maintBudgetUsed : 1.0;
  const projectedMaint = fleetMaintTotal * (budget / baselineBudget);
  const projMoved = Math.abs(budget - baselineBudget) > 0.001;

  const budgetLabel = budget < 0.75 ? 'Cut-rate'
    : budget < 0.95 ? 'Below standard'
    : budget < 1.1  ? 'Standard'
    : budget < 1.5  ? 'Enhanced'
    : 'Full overhaul';

  return (
    <div className="card" style={{ padding: '14px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}><Glyph e="🛠️" /></span>
            Maintenance Budget
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, maxWidth: 420 }}>
            Line maintenance — A/B checks, parts, components. Low budget cuts costs now but raises
            wear-related breakdown risk and accelerates airframe aging. Heavy C &amp; D checks are
            scheduled per aircraft in the Fleet tab — or automatically, once this budget and
            maintenance-team pay are both ≥1.30×.
          </div>
        </div>
        {fleetMaintTotal > 0 && (
          <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--red)' }}>
              −{formatMoney(projectedMaint)}/wk
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
              projected next week · all aircraft
            </div>
            {projMoved && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>
                was −{formatMoney(fleetMaintTotal)}/wk last week
              </div>
            )}
          </div>
        )}
      </div>

      {/* Budget slider */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
          <span style={{ color: 'var(--text-muted)' }}>Budget level</span>
          <span style={{ fontWeight: 600, color: budget < 0.9 ? 'var(--red)' : budget > 1.1 ? 'var(--green)' : 'var(--text)' }}>
            {budget.toFixed(2)}× — {budgetLabel}
          </span>
        </div>
        <div style={{ position: 'relative' }}>
          <input
            type="range"
            className="hw-range"
            min="0.5"
            max="2.0"
            step="0.05"
            value={budget}
            style={sliderStyle}
            draggable={false}
            onDragStart={e => e.preventDefault()}
            onChange={e => setDraftBudget(parseFloat(e.target.value))}
            onMouseUp={e => commitBudget(parseFloat(e.target.value))}
            onTouchEnd={e => commitBudget(parseFloat(e.target.value))}
            onKeyUp={e => commitBudget(parseFloat(e.target.value))}
          />
          <div style={{
            position: 'absolute', top: -4,
            left: `${(1.0 - 0.5) / (2.0 - 0.5) * 100}%`,
            transform: 'translateX(-50%)',
            width: 2, height: 14,
            background: 'var(--border)',
            pointerEvents: 'none',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
          <span>0.5× deferred</span>
          <span style={{ color: 'var(--text-muted)' }}>1.0× standard</span>
          <span>2.0× overhaul</span>
        </div>
      </div>

      {/* Effects */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 8, fontSize: 12 }}>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Aging rate</div>
          <div style={{ fontWeight: 600, color: agingColor }}>{agingRate.toFixed(2)}× per week</div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Maint cost multiplier</div>
          <div style={{ fontWeight: 600, color: budget < 1 ? 'var(--green)' : 'var(--red)' }}>{budget.toFixed(2)}×</div>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Impact</div>
          <div style={{ color: agingColor, fontSize: 11, fontStyle: 'italic' }}>
            {agingRate > 1.15
              ? 'Aircraft aging significantly faster, higher maintenance costs ahead'
              : agingRate > 1.05
              ? 'Slightly faster aging, monitor fleet condition'
              : agingRate < 0.85
              ? 'Aircraft condition well-maintained, extended service life'
              : agingRate < 0.95
              ? 'Slightly slowed aging, good for long-term economics'
              : 'Standard schedule, balanced cost and longevity'}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── MRO network (jet bases) ─────────────────────────────────────────────────

const LEVEL_COLOR = { 1: 'var(--green)', 2: 'var(--accent)', 3: 'var(--purple)' };

function levelChip(level) {
  const def = mroLevelDef(level);
  if (!def) return null;
  const c = LEVEL_COLOR[level] ?? 'var(--text-muted)';
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
      background: `${c}20`, color: c, border: `1px solid ${c}40`,
      textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
    }}>
      L{level} · {def.name}
    </span>
  );
}

function BaseCard({ code, base, absWeek, jobsHere, hostingHere, fleetFamilies = [], cash = 0, dispatch, onUpgrade }) {
  // Parts-pool slider draft: track the drag locally and commit SET_BASE_PARTS_POOL
  // once, on release, instead of firing a write on every intermediate drag value.
  const [draftPool, setDraftPool] = useState(clampPartsPool(base.partsPool));
  useEffect(() => setDraftPool(clampPartsPool(base.partsPool)), [base.partsPool]);
  const commitPool = (v) => dispatch({ type: 'SET_BASE_PARTS_POOL', code, pool: v });
  const def   = mroLevelDef(base.level);
  const open  = isBaseOpen(base);
  const eff   = baseEfficiency(base, absWeek);
  const slots = baseSlots(base);
  const used  = jobsHere.length;
  const cost  = baseWeeklyCost(base);
  const upgradeTo = base.upgradeTo ?? null;

  // What it would take to certify this base for one more family.
  const certs       = base.families ?? [];
  const uncertified = fleetFamilies.filter(f => !certs.includes(f.id));
  const certsMaxed  = certsFull(base);
  const nextCapex   = addCertCapex(base);
  const nextOpex    = addCertOpex(base);
  const includedLeft = certsIncludedLeft(base);
  const canAfford   = cash >= nextCapex;

  return (
    <div className="card" style={{ padding: '14px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 16 }}>{code}</span>
            {levelChip(base.level)}
            {!open && (
              <span style={{ fontSize: 11, color: 'var(--yellow)' }}>
                building · {base.buildWeeksLeft} wk{base.buildWeeksLeft !== 1 ? 's' : ''} left
              </span>
            )}
            {open && upgradeTo && (
              <span style={{ fontSize: 11, color: 'var(--yellow)' }}>
                upgrading to {mroLevelDef(upgradeTo)?.name} · {base.upgradeWeeksLeft} wk{base.upgradeWeeksLeft !== 1 ? 's' : ''} left
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, maxWidth: 460 }}>{def?.blurb}</div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--red)' }}>−{formatMoney(cost)}/wk</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{def?.gatesRequired} gates held by the hangar</div>
          {hostingHere > 0 && (
            <div style={{ fontSize: 11, color: 'var(--green)', marginTop: 2 }}>+{formatMoney(hostingHere)}/wk hosting</div>
          )}
        </div>
      </div>

      {/* Certifications */}
      <div style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Certified:</span>
          {certs.map(f => (
            <span key={f} style={{
              fontSize: 11, padding: '2px 7px', borderRadius: 4,
              background: 'var(--surface2)', border: '1px solid var(--border)',
            }}>{FAMILY_INFO[f]?.name ?? f}</span>
          ))}
          {certs.length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>none</span>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {certs.length}/{MRO_MAX_CERTS_PER_BASE}
            {includedLeft > 0 ? ` · ${includedLeft} more included at L${base.level}` : ''}
          </span>
        </div>

        {/* A level's allowance is not a ceiling — past it a certification costs
            capex once and opex every week, up to MRO_MAX_CERTS_PER_BASE. */}
        {!certsMaxed && uncertified.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
              {nextCapex > 0
                ? `Certify another family — ${formatMoney(nextCapex)} capex, ${formatMoney(nextOpex)}/wk`
                : 'Certify another family — included at this level, no extra cost'}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {uncertified.map(({ id, info, count }) => (
                <button
                  key={id}
                  className="btn btn-sm"
                  disabled={!canAfford}
                  title={canAfford
                    ? `Certify ${code} for ${info.name}`
                    : `Needs ${formatMoney(nextCapex)} in cash`}
                  onClick={() => dispatch({ type: 'ADD_BASE_CERTIFICATION', code, familyId: id })}
                >
                  + {info.name} · {count}
                </button>
              ))}
            </div>
            {!canAfford && (
              <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 4 }}>
                ⚠ Not enough cash — a further certification here costs {formatMoney(nextCapex)}.
              </div>
            )}
          </div>
        )}
        {certsMaxed && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
            Certified for the most families one base can hold ({MRO_MAX_CERTS_PER_BASE}).
          </div>
        )}
        {!certsMaxed && uncertified.length === 0 && certs.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
            Every family you fly is certified here.
          </div>
        )}
      </div>

      {open && (
        <>
          {/* Capacity + ramp */}
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 12, fontSize: 12 }}>
            <div>
              <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Shop slots</div>
              <div style={{ fontWeight: 600, color: used >= slots ? 'var(--red)' : 'var(--text)' }}>
                {used} / {slots} in use
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Effectiveness</div>
              <div style={{ fontWeight: 600, color: eff >= 0.99 ? 'var(--green)' : 'var(--yellow)' }}>
                {Math.round(eff * 100)}%{eff < 0.99 ? ' — still ramping' : ''}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>Contract offset</div>
              <div style={{ fontWeight: 600, color: 'var(--green)' }}>
                −{Math.round((def?.contractOffset ?? 0) * eff * 100)}% on certified families
              </div>
            </div>
          </div>

          {/* Parts pool */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>Parts pool</span>
              <span style={{ fontWeight: 600 }}>
                {draftPool.toFixed(2)}× · −{formatMoney(partsPoolCost(base))}/wk
              </span>
            </div>
            <input
              type="range" className="hw-range"
              min={PARTS_POOL_MIN} max={PARTS_POOL_MAX} step="0.25"
              value={draftPool}
              style={{ width: '100%' }}
              draggable={false}
              onDragStart={e => e.preventDefault()}
              onChange={e => setDraftPool(parseFloat(e.target.value))}
              onMouseUp={e => commitPool(parseFloat(e.target.value))}
              onTouchEnd={e => commitPool(parseFloat(e.target.value))}
              onKeyUp={e => commitPool(parseFloat(e.target.value))}
            />
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
              Deeper spares inventory ties up cash but gets grounded aircraft flying sooner
              (breakdown downtime ×{partsPoolDurationMult(base.partsPool).toFixed(2)}).
            </div>
          </div>
        </>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {open && !upgradeTo && base.level < MRO_MAX_LEVEL && (
          <button className="btn btn-sm" onClick={() => onUpgrade(code, base.level + 1)}>
            Upgrade to {mroLevelDef(base.level + 1)?.name} · {formatMoney(upgradeCapex(base.level, base.level + 1))}
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'CLOSE_MRO_BASE', code })}>
          Close base (refund {formatMoney(closeRefund(base))})
        </button>
      </div>
    </div>
  );
}

function BuildBaseForm({ state, dispatch, fleetFamilies }) {
  const [code, setCode]   = useState('');
  const [level, setLevel] = useState(1);
  const [fams, setFams]   = useState([]);

  const bases = state.mroBases ?? {};
  const gates = state.gates ?? {};
  // Airports you hold gates at and have no base at yet, best-stocked first.
  const candidates = Object.entries(gates)
    .filter(([c, n]) => n > 0 && !bases[c])
    .sort((a, b) => b[1] - a[1]);

  const def   = mroLevelDef(level);
  // Certifications past the level's allowance are buyable at build time, so the
  // count feeds the quote instead of being clamped away by it.
  const check = code
    ? canBuildBase(code, level, { bases, gates, cash: state.cash }, fams.length)
    : null;
  const included = certCapacity(level);
  const extras   = Math.max(0, fams.length - included);
  const ready = !!check?.ok && fams.length > 0;

  function toggleFamily(f) {
    setFams(prev => prev.includes(f) ? prev.filter(x => x !== f)
      : prev.length >= MRO_MAX_CERTS_PER_BASE ? prev : [...prev, f]);
  }

  if (candidates.length === 0) {
    return (
      <div className="card" style={{ padding: '14px 18px', fontSize: 13, color: 'var(--text-muted)' }}>
        A jet base needs gates at the airport it sits on — the hangar occupies them, so they stop
        being available for flying. Lease gates on the Gates tab first.
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: '14px 18px' }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Glyph e="🏗️" /> Build a jet base
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>Airport</div>
          <select value={code} onChange={e => setCode(e.target.value)} style={{ minWidth: 180 }}>
            <option value="">Choose an airport…</option>
            {candidates.map(([c, n]) => (
              <option key={c} value={c}>{c} — {n} gate{n !== 1 ? 's' : ''} held</option>
            ))}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>Level</div>
          <select value={level} onChange={e => { setLevel(Number(e.target.value)); setFams([]); }} style={{ minWidth: 220 }}>
            {[1, 2, 3].map(l => (
              <option key={l} value={l}>
                L{l} {mroLevelDef(l).name} — {formatMoney(mroLevelDef(l).capex)}, {mroLevelDef(l).gatesRequired} gates
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.6 }}>
        {def.blurb}
        <br />
        {formatMoney(def.capex)} capex · {formatMoney(def.weeklyOpex)}/wk · {def.buildWeeks} weeks to build ·
        {' '}{def.slots} shop slots · {def.certsIncluded} certification{def.certsIncluded !== 1 ? 's' : ''} included
      </div>

      {/* Family certifications */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 5 }}>
          Certify for ({fams.length}/{MRO_MAX_CERTS_PER_BASE}) — {included} included at this level
          {extras > 0
            ? `, ${extras} extra at ${formatMoney(def.extraCertCapex)} + ${formatMoney(def.extraCertOpex)}/wk each`
            : '. You can certify more here, or from the base card later.'}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {fleetFamilies.length === 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Buy an aircraft first — a base is certified for the families you actually fly.</span>
          )}
          {fleetFamilies.map(({ id, info, count }) => {
            const on = fams.includes(id);
            return (
              <button
                key={id}
                className="btn btn-sm"
                onClick={() => toggleFamily(id)}
                style={{
                  background: on ? 'var(--accent)' : 'var(--surface2)',
                  color: on ? '#08131f' : 'var(--text)',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                }}
              >
                {info.name} · {count}
              </button>
            );
          })}
        </div>
      </div>

      {check && !check.ok && (
        <div style={{ fontSize: 12, color: 'var(--yellow)', marginTop: 10 }}>
          {check.reasons.map((r, i) => <div key={i}>⚠ {r}</div>)}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <button
          className="btn"
          disabled={!ready}
          onClick={() => {
            dispatch({ type: 'BUILD_MRO_BASE', code, level, families: fams });
            setCode(''); setFams([]);
          }}
        >
          Build for {formatMoney(check?.capex ?? def.capex)}
        </button>
        {ready && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            Opens in {def.buildWeeks} week{def.buildWeeks !== 1 ? 's' : ''}, then ramps to full effectiveness over {MRO_RAMP_WEEKS} weeks.
          </span>
        )}
      </div>
    </div>
  );
}

function MroNetwork({ state, dispatch, fleetFamilies, absWeek }) {
  const bases = state.mroBases ?? {};
  const codes = Object.keys(bases).sort();
  const jobs  = state.lastReport?.mro?.jobs ?? [];
  const totalCost = totalBaseWeeklyCost(bases);
  const savings   = state.lastReport?.mro?.contractSavings ?? 0;
  const hosting   = state.lastReport?.mro?.hostingRevenue ?? 0;

  return (
    <>
      <SectionHeader
        label="MRO Network"
        right={codes.length > 0 ? (
          <span style={{ fontSize: 13, textTransform: 'none', letterSpacing: 0 }}>
            <span style={{ color: 'var(--red)', fontWeight: 700 }}>−{formatMoney(totalCost)}/wk</span>
            {savings > 0 && <span style={{ color: 'var(--green)', fontWeight: 700 }}> · saving {formatMoney(savings)}/wk</span>}
          </span>
        ) : null}
      />

      {codes.length === 0 ? (
        <div className="card" style={{ padding: '14px 18px', marginBottom: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7 }}>
            You have no jet bases. Every check and every breakdown currently goes to a third party at
            full price, and you pay the full outsourced contract for each aircraft family you fly.
            <br /><br />
            A base cuts what heavy checks and breakdowns cost, gets aircraft back in the air sooner,
            and offsets most of the outsourced contract for the families it is certified for. It needs
            gates at the airport — the hangar occupies them.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 10 }}>
          {codes.map(code => (
            <BaseCard
              key={code}
              code={code}
              base={bases[code]}
              absWeek={absWeek}
              jobsHere={jobs.filter(j => j.base === code)}
              hostingHere={hosting > 0 ? 0 : 0}
              fleetFamilies={fleetFamilies}
              cash={state.cash}
              dispatch={dispatch}
              onUpgrade={(c, l) => dispatch({ type: 'UPGRADE_MRO_BASE', code: c, level: l })}
            />
          ))}
        </div>
      )}

      <BuildBaseForm state={state} dispatch={dispatch} fleetFamilies={fleetFamilies} />
    </>
  );
}

// ─── Shop board — what is in maintenance right now ───────────────────────────

function ShopBoard({ state }) {
  const fleet = state.fleet ?? [];
  const jobs  = state.lastReport?.mro?.jobs ?? [];
  const jobFor = new Map(jobs.map(j => [j.aircraftId, j]));

  const rows = fleet
    .filter(a => a.status === 'maintenance' || a.status === 'grounded')
    .map(a => {
      const job = jobFor.get(a.id) ?? null;
      return {
        a,
        kind:  a.status === 'maintenance' ? `${a.checkType ?? 'C'} check` : groundedKind(a),
        weeks: a.status === 'maintenance' ? (a.checkWeeksLeft ?? 0) : (a.groundedWeeksLeft ?? 0),
        forced: !!a.checkForced,
        job,
      };
    })
    .sort((x, y) => y.weeks - x.weeks);

  const outsourced = jobs.filter(j => !j.base && !j.forced).length;

  return (
    <>
      <SectionHeader
        label="Shop Board"
        right={rows.length > 0 ? (
          <span style={{ fontSize: 13, textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted)' }}>
            {rows.length} aircraft out of service
          </span>
        ) : null}
      />
      <div className="card" style={{ padding: '12px 18px', marginBottom: 10 }}>
        {rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '10px 0' }}>
            Nothing in the shop. Every aircraft is either flying or available.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {rows.map(({ a, kind, weeks, forced, job }) => (
              <div key={a.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{a.tailNumber || a.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{getAircraftType(a.typeId)?.name}</span>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                      background: forced ? 'var(--red)20' : 'var(--surface2)',
                      color: forced ? 'var(--red)' : 'var(--text-muted)',
                      border: '1px solid var(--border)',
                    }}>{forced ? 'REGULATOR' : kind.toUpperCase()}</span>
                  </div>
                  {job && (
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                      {job.label ? `${job.label} · ` : ''}
                      {job.base
                        ? <span style={{ color: 'var(--green)' }}>your {job.base} base</span>
                        : <span style={{ color: 'var(--yellow)' }}>outsourced</span>}
                      {job.cost > 0 ? ` · ${formatMoney(job.cost)}` : ''}
                    </div>
                  )}
                </div>
                <div style={{ fontWeight: 600, fontSize: 13, flexShrink: 0, color: weeks > 2 ? 'var(--red)' : 'var(--yellow)' }}>
                  {weeks} wk{weeks !== 1 ? 's' : ''} left
                </div>
              </div>
            ))}
          </div>
        )}
        {outsourced > 0 && (
          <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 8 }}>
            ⚠ {outsourced} job{outsourced !== 1 ? 's' : ''} went to a third party last week — either no base covers
            that family on its network, or every shop slot was already full.
          </div>
        )}
      </div>
    </>
  );
}

// ─── Due queue — what needs booking, and where it would go ───────────────────

function DueQueue({ state, dispatch, absWeek }) {
  const fleet = state.fleet ?? [];
  const bases = state.mroBases ?? {};
  const rows = [];
  for (const a of fleet) {
    if (a.status === 'retired' || a.status === 'maintenance') continue;
    const type = getAircraftType(a.typeId);
    const di = dueInfo(a, type, absWeek);
    if (di.state === 'ok') continue;
    const ct = di.primaryDue ?? di.soonType ?? 'C';
    const resolved = resolveBaseFor(a, bases, state.routes ?? [], state.cargoRoutes ?? [], absWeek);
    const f = mroFactorsFor(resolved);
    const mult = ct === 'D' ? f.dCostMult : f.cCostMult;
    const listCost = checkCost(type, ct, { maintMod: a.maintMod ?? 1 });
    rows.push({
      a, type, di, ct,
      base: mult < 1 ? f.code : null,
      cost: Math.round(listCost * (mult < 1 ? mult : 1)),
      listCost,
      weeks: Math.max(1, checkDurationWeeks(type?.category, ct) - (ct === 'D' ? f.dWeeksSaved : f.cWeeksSaved)),
    });
  }
  const order = { overdue: 0, due: 1, soon: 2 };
  rows.sort((x, y) => (order[x.di.state] ?? 3) - (order[y.di.state] ?? 3));

  return (
    <>
      <SectionHeader
        label="Due Queue"
        right={rows.length > 0 ? (
          <span style={{ fontSize: 13, textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted)' }}>
            {rows.length} aircraft
          </span>
        ) : null}
      />
      <div className="card" style={{ padding: '12px 18px', marginBottom: 10 }}>
        {rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '10px 0' }}>
            Nothing due. The whole fleet is inside its check intervals.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {rows.map(({ a, di, ct, base, cost, listCost, weeks }) => {
              const color = di.state === 'overdue' ? 'var(--red)' : di.state === 'due' ? 'var(--yellow)' : 'var(--text-muted)';
              return (
                <div key={a.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{a.tailNumber || a.name}</span>
                      <span style={{ fontSize: 11, color }}>{ct} check {di.state}</span>
                      {a.scheduledCheck && (
                        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>booked wk {a.scheduledCheck.startWeek}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                      {base
                        ? <span style={{ color: 'var(--green)' }}>routes to your {base} base · {formatMoney(cost)} · {weeks} wk{weeks !== 1 ? 's' : ''}</span>
                        : <span>outsourced · {formatMoney(listCost)} · {weeks} wk{weeks !== 1 ? 's' : ''}</span>}
                    </div>
                  </div>
                  <button
                    className="btn btn-sm"
                    onClick={() => dispatch({ type: 'SCHEDULE_CHECK', aircraftId: a.id, checkType: ct, startNow: true })}
                  >
                    Start {ct} check
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Maintenance() {
  const { state, dispatch } = useGame();
  const {
    fleet = [], labor = DEFAULT_LABOR_STATE,
    maintenanceBudget = DEFAULT_MAINTENANCE_BUDGET,
  } = state;
  const absWeek = absoluteWeek(state.year ?? 1, state.week ?? 1);

  // Families in the fleet, dearest contract first.
  const familySet = getActiveFamilies(fleet);
  const familyCount = {};
  for (const a of fleet) {
    const fam = AIRCRAFT_FAMILY[a.typeId];
    if (fam) familyCount[fam] = (familyCount[fam] ?? 0) + 1;
  }
  const famEntries = [...familySet]
    .map(id => ({ id, info: FAMILY_INFO[id] ?? { name: id, category: 'regional', weeklyBaseCost: 0 }, count: familyCount[id] ?? 0 }))
    .sort((a, b) => b.info.weeklyBaseCost - a.info.weeklyBaseCost);

  const offsets    = familyContractOffsets(state.mroBases ?? {}, absWeek);
  const familyCost = weeklyFamilyBaseCost(fleet, offsets);
  const fleetMaintTotal = state.lastReport?.totalMaintenance ?? 0;

  const mro = state.lastReport?.mro ?? null;

  return (
    <div>
      <h2 style={{ marginBottom: 4 }}>Maintenance</h2>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
        Everything that keeps the fleet airworthy: what you spend keeping it flying, what breaks,
        and where the work gets done.
      </div>

      {/* Last week at a glance */}
      {mro && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
          <MroStat label="Line maintenance" value={-fleetMaintTotal} />
          <MroStat label="Heavy checks" value={-(state.lastReport?.maintenanceChecks?.spend ?? 0)} />
          <MroStat label="Breakdown repairs" value={-(mro.aogSpend ?? 0)} />
          <MroStat label="Outsourced contracts" value={-familyCost} />
          <MroStat label="Base running costs" value={-(mro.baseCosts ?? 0)} />
          <MroStat label="Saved by your bases" value={mro.contractSavings ?? 0} good />
        </div>
      )}

      <SectionHeader label="Line Maintenance" />
      <MaintenanceCard
        budget={maintenanceBudget}
        fleetMaintTotal={fleetMaintTotal}
        maintBudgetUsed={state.lastReport?.maintenanceBudgetUsed ?? 1.0}
        dispatch={dispatch}
      />

      <div className="card" style={{ padding: '12px 18px', marginTop: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Maintenance-team pay is set on the Operations page and gates automatic check scheduling
          alongside this budget.{' '}
          {autoSchedulingActive(labor, maintenanceBudget)
            ? <span style={{ color: 'var(--green)' }}>⚙ Auto-scheduling is on ({(labor?.maintenanceTeam?.payMultiplier ?? 1).toFixed(2)}× pay / {maintenanceBudget.toFixed(2)}× budget).</span>
            : <span style={{ color: 'var(--text-dim)' }}>⚙ Auto-scheduling is off — both need to reach {AUTO_SCHEDULE_PAY_MIN.toFixed(2)}× (currently {(labor?.maintenanceTeam?.payMultiplier ?? 1).toFixed(2)}× pay / {maintenanceBudget.toFixed(2)}× budget).</span>}
        </div>
      </div>

      <MroNetwork state={state} dispatch={dispatch} fleetFamilies={famEntries} absWeek={absWeek} />

      <ShopBoard state={state} />

      <DueQueue state={state} dispatch={dispatch} absWeek={absWeek} />

      <SectionHeader
        label="Outsourced MRO Contracts"
        right={familyCost > 0 ? (
          <span style={{ color: 'var(--red)', fontWeight: 700, fontSize: 13, textTransform: 'none', letterSpacing: 0 }}>
            −{formatMoney(familyCost)}/wk total
          </span>
        ) : null}
      />

      <div className="card" style={{ padding: '14px 18px' }}>
        {famEntries.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
            No aircraft in fleet yet. Every aircraft family you operate carries its own MRO contract.
          </div>
        ) : (
          <>
            {famEntries.map(({ id, info, count }) => {
              const catLabel = FAMILY_CATEGORY_LABEL[info.category] ?? info.category;
              const catColors = {
                widebody: '#a98bff', narrowBody: '#3ea6ff',
                regional: '#38d39f', turboprop: '#ffb43d', utility: '#93a4ba',
              };
              const color  = catColors[info.category] ?? '#93a4ba';
              const offset = offsets[id] ?? 0;
              const net    = Math.round(info.weeklyBaseCost * (1 - offset));
              return (
                <div key={id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 0', borderBottom: '1px solid var(--border-subtle)',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{info.name}</span>
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                        background: `${color}20`, color, border: `1px solid ${color}40`,
                        textTransform: 'uppercase', letterSpacing: '0.05em',
                      }}>{catLabel}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{count} aircraft</span>
                    </div>
                    {info.note && (
                      <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 2, fontStyle: 'italic' }}>
                        <Glyph e="⚠" /> {info.note}
                      </div>
                    )}
                    {offset > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--green)', marginTop: 2 }}>
                        ✓ covered in-house — {Math.round(offset * 100)}% of the contract offset by your base
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontWeight: 600, color: 'var(--red)', fontSize: 13 }}>−{formatMoney(net)}/wk</div>
                    {offset > 0 && (
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', textDecoration: 'line-through' }}>
                        {formatMoney(info.weeklyBaseCost)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {famEntries.length === 1 ? (
                <span style={{ color: 'var(--green)' }}>
                  <Glyph e="✓" /> Single-family fleet — the smallest possible MRO contract bill.
                </span>
              ) : (
                <>
                  <span style={{ color: 'var(--yellow)' }}>{famEntries.length} families active.</span>
                  {' '}Each one carries its own contract whatever the fleet size, so consolidating types
                  or certifying a base for a family both cut this line.
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        A jet base helps an aircraft only when it is certified for that aircraft's family, sits on an
        airport the aircraft's routes touch, and still has a shop slot free that week. Everything else
        goes to a third party at full price and full downtime.
      </div>
    </div>
  );
}

function MroStat({ label, value, good = false }) {
  const positive = value >= 0;
  const color = good || positive ? 'var(--green)' : 'var(--red)';
  return (
    <div className="card" style={{ padding: '10px 14px', minWidth: 150, flex: '1 1 150px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color }}>
        {positive ? '+' : '−'}{formatMoney(Math.abs(value))}<span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-dim)' }}>/wk</span>
      </div>
    </div>
  );
}
