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

function BaseCard({ code, base, absWeek, jobsHere, hostingHere, dispatch, onUpgrade }) {
  const def   = mroLevelDef(base.level);
  const open  = isBaseOpen(base);
  const eff   = baseEfficiency(base, absWeek);
  const slots = baseSlots(base);
  const used  = jobsHere.length;
  const cost  = baseWeeklyCost(base);
  const upgradeTo = base.upgradeTo ?? null;

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
      <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Certified:</span>
        {(base.families ?? []).map(f => (
          <span key={f} style={{
            fontSize: 11, padding: '2px 7px', borderRadius: 4,
            background: 'var(--surface2)', border: '1px solid var(--border)',
          }}>{FAMILY_INFO[f]?.name ?? f}</span>
        ))}
        {(base.families ?? []).length === 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>none</span>
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
                {clampPartsPool(base.partsPool).toFixed(2)}× · −{formatMoney(partsPoolCost(base))}/wk
              </span>
            </div>
            <input
              type="range" className="hw-range"
              min={PARTS_POOL_MIN} max={PARTS_POOL_MAX} step="0.25"
              value={clampPartsPool(base.partsPool)}
              style={{ width: '100%' }}
              draggable={false}
              onDragStart={e => e.preventDefault()}
              onChange={e => dispatch({ type: 'SET_BASE_PARTS_POOL', code, pool: parseFloat(e.target.value) })}
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
  const check = code ? canBuildBase(code, level, { bases, gates, cash: state.cash }) : null;
  const capacity = certCapacity(level);
  const ready = !!check?.ok && fams.length > 0;

  function toggleFamily(f) {
    setFams(prev => prev.includes(f) ? prev.filter(x => x !== f)
      : prev.length >= capacity ? prev : [...prev, f]);
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
          Certify for ({fams.length}/{capacity}) — you can add more families later at extra cost
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
        kind:  a.status === 'maintenance' ? `${a.checkType ?? 'C'} check` : 'AOG repair',
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
