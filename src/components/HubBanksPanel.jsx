import { useMemo } from 'react';
import { getAirport } from '../data/airports.js';
import { utcOffsetMinutes } from '../data/timezones.js';
import {
  hubBankPlan, hubConnectivity, bankContextOf, snapToBank, normalizeHubBankSetting, autoBankCount,
  normalizeStarts, wrapWeek, BANK_COUNTS, BANK_ARR_WINDOW, BANK_DEP_WINDOW, MAX_CUSTOM_BANKS,
} from '../models/schedule.js';

// ── Hub banks (hub-bank worlds) ──────────────────────────────────────────────
// One card per designated hub: how it runs its waves, a 24-hour strip of when
// flights land (above) and leave (below) against the banks, and the numbers
// that matter — how many connections the timetable makes, how long people
// wait, and what the waves cost in aircraft sitting about. The automatic week
// does the banking; this is where a player changes the pattern, and "Snap
// all" puts flights they've moved back onto a wave. Maths: models/schedule.js.

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (m) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
const dur = (m) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${pad2(m % 60)}m` : ''}` : `${m}m`);
const BUCKET = 15;

/** The select's value for a hub's stored setting. */
function modeOf(setting) {
  const s = normalizeHubBankSetting(setting);
  if (!s) return 'auto';
  if (s.mode === 'rolling') return 'rolling';
  return s.times ? 'custom' : String(s.count);
}

export default function HubBanksPanel({ state, weeks, tt, paxIds, dispatch, onSnap }) {
  const codes = useMemo(() => Object.keys(state.hubs ?? {})
    .filter(c => state.hubs[c]?.tier != null)
    .sort((a, b) => (state.hubs[b].tier - state.hubs[a].tier) || (a < b ? -1 : 1)), [state.hubs]);
  if (!codes.length) {
    return (
      <div className="hubbanks-empty sched-sub">
        Connections only happen at a designated hub. Designate one under Airports and its banks appear here.
      </div>
    );
  }
  return (
    <div className="hubbanks" role="region" aria-label="Hub banks">
      {codes.map(code => (
        <HubCard key={code} code={code} state={state} weeks={weeks} tt={tt} paxIds={paxIds}
          dispatch={dispatch} onSnap={onSnap} />
      ))}
    </div>
  );
}

function HubCard({ code, state, weeks, tt, paxIds, dispatch, onSnap }) {
  const ap = getAirport(code);
  const off = ap ? utcOffsetMinutes(ap) : 0;
  const tier = state.hubs?.[code]?.tier ?? 1;
  const setting = state.hubBanks?.[code];
  const mode = modeOf(setting);
  const plan = useMemo(() => hubBankPlan(state, code), [state.hubBanksWorld, state.hubs, state.hubBanks, code]); // eslint-disable-line react-hooks/exhaustive-deps
  const stats = useMemo(() => (tt && plan ? hubConnectivity(tt, weeks, plan, { paxIds }) : null), [tt, weeks, plan, paxIds]);
  const set = (banks) => dispatch({ type: 'SET_HUB_BANKS', banks: { [code]: banks } });

  // When flights land and leave across a day (week averaged), hub local time.
  const strip = useMemo(() => {
    const n = 1440 / BUCKET;
    const arr = new Array(n).fill(0), dep = new Array(n).fill(0);
    const fill = (m, into) => { if (!m) return; for (const list of m.values()) for (const t of list) into[Math.floor((wrapWeek(t + off) % 1440) / BUCKET)]++; };
    fill(tt?.arrivals.get(code), arr);
    fill(tt?.departures.get(code), dep);
    const max = Math.max(1, ...arr, ...dep);
    return { arr, dep, max };
  }, [tt, code, off]);

  const banked = plan && plan.mode !== 'rolling';
  const ctx = useMemo(() => bankContextOf(state), [state.hubBanksWorld, state.hubs, state.hubBanks]); // eslint-disable-line react-hooks/exhaustive-deps
  const missedPinned = (stats?.missedBlocks ?? []).filter(m => m.pinned);
  const missedAuto = (stats?.missedBlocks ?? []).length - missedPinned.length;

  const snapAll = () => {
    const byRoute = new Map();   // routeId → { week, moves: Map(from → to) }
    for (const m of missedPinned) {
      const week = weeks.get(m.acId);
      const b = week?.blocks.find(x => x.routeId === m.routeId && x.start === m.start);
      const to = b ? snapToBank(week, b, ctx) : null;
      if (to == null) continue;
      const e = byRoute.get(m.routeId) ?? { week, moves: new Map() };
      e.moves.set(m.start, to);
      byRoute.set(m.routeId, e);
    }
    const out = {};
    for (const [routeId, { week, moves }] of byRoute) {
      const starts = week.blocks.filter(b => b.routeId === routeId).map(b => moves.get(b.start) ?? b.start);
      out[routeId] = normalizeStarts(starts);
    }
    if (Object.keys(out).length) onSnap(out);
  };

  const times = plan?.times ?? [];
  const setTime = (i, v) => {
    const [h, m] = String(v).split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    const next = [...times]; next[i] = h * 60 + m;
    set({ mode: 'banks', times: next });
  };
  const addTime = () => {
    const last = times[times.length - 1] ?? 7 * 60;
    set({ mode: 'banks', times: [...times, (last + 180) % 1440] });
  };
  const removeTime = (i) => {
    const next = times.filter((_, k) => k !== i);
    set(next.length ? { mode: 'banks', times: next } : null);
  };
  const onMode = (v) => {
    if (v === 'auto') set(null);
    else if (v === 'rolling') set({ mode: 'rolling' });
    else if (v === 'custom') set({ mode: 'banks', times: times.length ? times : [7 * 60, 13 * 60, 19 * 60] });
    else set({ mode: 'banks', count: Number(v) });
  };

  const through = state.lastReport?.hubThroughput?.[code];
  return (
    <div className="hubbank card">
      <div className="hubbank-head">
        <strong className="hubbank-code">{code}</strong>
        <span className="sched-meta">{ap?.city ?? ap?.name ?? ''}</span>
        <span style={{ flex: 1 }} />
        <label className="hubbank-mode">
          <select className="form-select" value={mode} onChange={e => onMode(e.target.value)}
            aria-label={`How ${code} times its flights`}>
            <option value="auto">Automatic ({autoBankCount(tier)} banks a day)</option>
            {BANK_COUNTS.map(n => <option key={n} value={String(n)}>{n} banks a day</option>)}
            <option value="custom">Custom bank times</option>
            <option value="rolling">Rolling (no banks)</option>
          </select>
        </label>
      </div>

      {mode === 'custom' && (
        <div className="hubbank-times" role="group" aria-label={`${code} bank times`}>
          {times.map((t, i) => (
            <span key={i} className="hubbank-time">
              <input type="time" step={300} value={hhmm(t)} onChange={e => setTime(i, e.target.value)}
                aria-label={`Bank ${i + 1}`} />
              <button type="button" className="sched-x" onClick={() => removeTime(i)} aria-label={`Remove the ${hhmm(t)} bank`}>✕</button>
            </span>
          ))}
          {times.length < MAX_CUSTOM_BANKS && (
            <button type="button" className="btn btn-ghost sched-btn" onClick={addTime}>+ Bank</button>
          )}
          <span className="sched-meta">{code} local time · banks at least 90 min apart</span>
        </div>
      )}

      <div className="hubbank-strip" aria-hidden="true">
        {banked && times.map(t => (
          <span key={t} className="hubbank-bank" style={{ left: `${((t + BANK_ARR_WINDOW[0]) / 1440) * 100}%`, width: `${((BANK_DEP_WINDOW[1] - BANK_ARR_WINDOW[0]) / 1440) * 100}%` }}>
            <span className="hubbank-bank-label">{hhmm(t)}</span>
          </span>
        ))}
        <div className="hubbank-bars hubbank-arr">
          {strip.arr.map((n, i) => <span key={i} style={{ height: `${(n / strip.max) * 100}%` }} />)}
        </div>
        <div className="hubbank-bars hubbank-dep">
          {strip.dep.map((n, i) => <span key={i} style={{ height: `${(n / strip.max) * 100}%` }} />)}
        </div>
        <div className="hubbank-axis">{[0, 6, 12, 18].map(h => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{pad2(h)}:00</span>)}</div>
      </div>
      <div className="hubbank-legend sched-meta">
        <span className="hubbank-swatch hubbank-swatch-arr" /> lands
        <span className="hubbank-swatch hubbank-swatch-dep" /> leaves
        {banked && <><span className="hubbank-swatch hubbank-swatch-bank" /> bank</>}
      </div>

      <div className="hubbank-stats">
        <span><strong>{(stats?.options ?? 0).toLocaleString()}</strong> connections a week</span>
        <span>average wait <strong>{dur(stats?.avgWaitMin)}</strong></span>
        {through != null && <span><strong>{Math.round(through).toLocaleString()}</strong> connecting passengers last week</span>}
        {banked && <span>aircraft wait <strong>{stats?.waitHoursPerDay ?? 0} h</strong> a day for banks</span>}
      </div>
      {mode === 'rolling' && (
        <div className="sched-sub">Rolling: flights leave whenever the aircraft is ready. No waiting about — but passengers only connect where flights happen to meet.</div>
      )}
      {banked && (missedPinned.length > 0 || missedAuto > 0) && (
        <div className="hubbank-fix">
          {missedPinned.length > 0 && (
            <>
              <span>{missedPinned.length} flight{missedPinned.length > 1 ? 's' : ''} you moved miss{missedPinned.length > 1 ? '' : 'es'} a bank here.</span>
              <button type="button" className="btn btn-primary sched-btn" onClick={snapAll}>Snap {missedPinned.length > 1 ? 'all' : 'it'} to the nearest bank</button>
            </>
          )}
          {missedAuto > 0 && (
            <span className="sched-meta">{missedAuto} automatic flight{missedAuto > 1 ? 's' : ''} can&apos;t wait for a bank — {missedAuto > 1 ? 'their aircraft are' : 'its aircraft is'} too busy.</span>
          )}
        </div>
      )}
    </div>
  );
}
