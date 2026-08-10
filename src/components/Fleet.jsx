import { useState, useMemo, useRef, useEffect } from 'react';
import { useGame, transferCompatibility } from '../store/GameContext.jsx';
import { getAircraftType, leaseBuyoutPrice, LEASE_TERM_OPTIONS } from '../data/aircraft.js';
import { laborEffects } from '../data/labor.js';
import { getAirport } from '../data/airports.js';
import {
  formatMoney, formatPercent,
  maintenanceMultiplier, ageLabel,
  simulateRoute, weeklyBlockHours, currentGameDate,
  fleetAvgUtilization, buildEventDemandModel,
  maxWeeklyBlockHoursFor, CLASS_FARE_MULTIPLIERS, routeDistanceKm, weekToGameDate, aircraftHubMaintFactor,
  freighterLandingCategory, aircraftUtilization,
  stateLoungeFields,
} from '../utils/simulation.js';
import { reserveParkingFee, RESERVE_READINESS_MULT, isReserve } from '../data/reserve.js';
import { ReserveBadge } from './ReserveNotice.jsx';
import { projectWeek } from '../utils/financeProjection.js';
import { absoluteWeek } from '../utils/fuel.js';
import { DEPRECIATION_YEARS } from '../data/overhead.js';
import { dueInfo, checkCost, checkDurationWeeks, isOutOfService, MAX_SCHEDULE_AHEAD_WEEKS, autoSchedulingActive, AUTO_SCHEDULE_PAY_MIN, AUTO_SCHEDULE_BUDGET_MIN } from '../data/maintenance.js';
import InfoTip from './InfoTip.jsx';
import Callout from './Callout.jsx';
import { consumeNavFilter } from '../utils/navIntent.js';
import { isLeaseExpiring, leaseRemainingWeeks, LEASE_EXPIRY_WARN_WEEKS } from '../utils/leaseAlerts.js';
import { useConfirm } from './ConfirmModal.jsx';
import FleetConfig from './FleetConfig.jsx';
import { Glyph, GlyphLabel } from './Icons.jsx';
import { canRetrofitWifi, isWifiEquipped, WIFI_WEEKLY_OPEX } from '../data/wifi.js';

const CAT_COLORS = {
  'Turboprop':    '#ffb43d',
  'Regional Jet': '#38d39f',
  'Narrow Body':  '#3ea6ff',
  'Wide Body':    '#a98bff',
};

const CABIN_COLORS = {
  firstClass:     '#a98bff',
  businessClass:  '#3ea6ff',
  premiumEconomy: '#ffb43d',
  economy:        '#38d39f',
};
const CABIN_LABELS = {
  firstClass: 'First', businessClass: 'Business',
  premiumEconomy: 'Prem-Eco', economy: 'Economy',
};

// ── Utilisation, read one way everywhere ─────────────────────────────────────
// Every utilisation figure on this page comes from aircraftUtilization() in the
// engine, which answers the question the way the weekly tick answers it: the
// routes that OPERATE THIS MONTH, leg by leg, and nothing at all for an
// aircraft that is out of service. Summing the whole year at the direct O&D
// distance — what this file used to do in five separate places — showed a legal
// 138h airframe as 264h, and the Math.min(100, …) bar saturated so 145h and
// 278h drew the same rectangle.
const utilFor = (state, aircraft, month) => aircraftUtilization({
  aircraft,
  type:        getAircraftType(aircraft?.typeId),
  routes:      state.routes ?? [],
  cargoRoutes: state.cargoRoutes ?? [],
  month,
  capHours:    maxWeeklyBlockHoursFor(state),
});

/** Bar width % — full (not clipped-and-forgotten) once the cap is breached. */
const utilBarWidth = (pct) => `${Math.max(0, Math.min(100, pct * 100))}%`;

/** Colour ramp. Over-cap gets its own colour so it cannot read as "healthy busy". */
const OVER_CAP_COLOR = 'var(--red)';
function utilColorFor(pct, overCap) {
  if (overCap) return OVER_CAP_COLOR;
  return pct >= 0.95 ? 'var(--red)' : pct >= 0.75 ? 'var(--yellow)' : 'var(--accent)';
}

/**
 * The utilisation bar + figure, used by the fleet table and the detail card.
 * Over the cap it renders "278h / 140h" beside a full, hatched bar, so the one
 * visual that should scream cannot flatline into looking like 145h.
 */
function UtilBar({ util, width = 44, height = 4, fontSize = 11 }) {
  const { flyingHours, peakHours, capHours, overCap, grounded, seasonal, peakMonth } = util;
  // The figure is always THIS month's flying — printing a July peak in May would
  // put the screen back out of step with the tick. A tail that only breaches in
  // some other month is flagged, not restated.
  const shown    = flyingHours;
  const overNow  = !grounded && shown > capHours + 1e-6;
  const overSoon = overCap && !overNow;
  const pct      = shown / capHours;
  const colour   = utilColorFor(pct, overNow);
  const title  = overNow
    ? `Over the ${capHours}h weekly block-hour limit by ${(shown - capHours).toFixed(1)}h — trim frequency or move a route to another tail`
    : overSoon
      ? `Scheduled over the ${capHours}h limit in ${UTIL_MONTH_NAMES[peakMonth - 1]} (${peakHours.toFixed(1)}h)`
      : grounded
        ? `Out of service — flying nothing this week; its schedule is ${peakHours.toFixed(1)}h/wk when it returns`
        : seasonal
          ? `${flyingHours.toFixed(1)}h this month; busiest month (${UTIL_MONTH_NAMES[peakMonth - 1]}) is ${peakHours.toFixed(1)}h of a ${capHours}h limit`
          : `${flyingHours.toFixed(1)}h of a ${capHours}h weekly block-hour limit`;
  // Over the cap the bar is FULL — but the share of it that is illegal is drawn
  // hatched, so a tail at 141h and one at 271h no longer draw the same
  // rectangle. That saturation (a bare Math.min(100, …)) is what let eight
  // over-cap airframes look like eight busy ones.
  const overrunShare = overNow && shown > 0 ? Math.min(1, (shown - capHours) / shown) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={title}>
      <div style={{ width, height, borderRadius: 2, background: 'var(--surface3)', overflow: 'hidden', display: 'flex' }}>
        {overNow ? (
          <>
            <div style={{ height: '100%', width: `${(1 - overrunShare) * 100}%`, background: OVER_CAP_COLOR }} />
            <div style={{
              height: '100%', width: `${overrunShare * 100}%`,
              background: `repeating-linear-gradient(45deg, ${OVER_CAP_COLOR} 0 2px, rgba(0,0,0,0.45) 2px 4px)`,
            }} />
          </>
        ) : (
          <div style={{ height: '100%', width: utilBarWidth(pct), borderRadius: 2, background: colour }} />
        )}
      </div>
      <span style={{ fontSize, color: colour, fontWeight: overNow ? 700 : 400 }}>
        {shown.toFixed(0)}h{overNow ? ` / ${capHours}h` : ''}{overSoon ? ' ⚠' : ''}
      </span>
    </div>
  );
}

const UTIL_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

// Clickable column header for the fleet table. Click to sort by that column,
// click again to flip the direction.
function SortableTh({ label, k, sortKey, sortDir, onSort, style }) {
  const active = sortKey === k;
  return (
    <th
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', ...style }}
      onClick={() => onSort(k)}
      title={`Sort by ${label}`}
    >
      <span style={{ color: active ? 'var(--accent)' : undefined }}>{label}</span>
      <span style={{ fontSize: 9, marginLeft: 4, opacity: active ? 1 : 0.35, color: active ? 'var(--accent)' : undefined }}>
        {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </th>
  );
}

function AircraftThumb({ type, size = 'sm' }) {
  const [failed, setFailed] = useState(false);
  const color  = CAT_COLORS[type?.category] || '#93a4ba';
  const isLarge = size === 'lg';

  if (failed || !type?.image) {
    return (
      <div
        className={isLarge ? '' : 'fleet-thumb-placeholder'}
        style={{
          background: `${color}18`, border: `1px solid ${color}30`,
          ...(isLarge ? {
            width: 120, height: 80, borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          } : {}),
        }}
      >
        <span style={{ fontSize: isLarge ? 36 : 18, opacity: 0.5 }}><Glyph e="✈" /></span>
      </div>
    );
  }

  if (isLarge) {
    return (
      <img
        src={type.image} alt={type.name}
        style={{ width: 120, height: 80, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <img
      src={type.image} alt={type.name}
      className="fleet-thumb"
      onError={() => setFailed(true)}
    />
  );
}

// ─── Transfer routes modal ────────────────────────────────────────────────────
// Move every route (pax + cargo) from this tail to a compatible idle aircraft.
// Routes keep their ramp, pricing and season — handy for swapping a new owned
// delivery in for a leased plane before returning it.

function TransferRoutesModal({ aircraft, onClose }) {
  const { state, dispatch } = useGame();
  const type = getAircraftType(aircraft.typeId);

  const candidates = state.fleet
    .filter(a => a.id !== aircraft.id)
    .map(a => ({ a, t: getAircraftType(a.typeId), compat: transferCompatibility(state, aircraft.id, a.id) }))
    .sort((x, y) => (y.compat.ok ? 1 : 0) - (x.compat.ok ? 1 : 0));

  function transferTo(toId) {
    dispatch({ type: 'TRANSFER_ROUTES', fromAircraftId: aircraft.id, toAircraftId: toId });
    onClose();
  }

  return (
    <div className="saveload-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="saveload-modal" style={{ width: 'min(520px, 94vw)' }}>
        <div className="saveload-header">
          <h2 style={{ margin: 0, fontSize: 17 }}>Transfer Routes</h2>
          <button className="btn" onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '4px 0 16px', lineHeight: 1.5 }}>
          Move every route from <strong>{aircraft.name}</strong> ({type?.name}) to another aircraft.
          Routes keep their maturity, pricing and season — the old aircraft goes idle, ready to
          sell or return.
        </p>
        {candidates.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-dim)', fontStyle: 'italic' }}>No other aircraft in the fleet.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {candidates.map(({ a, t, compat }) => (
            <div
              key={a.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                border: '1px solid var(--border)', borderRadius: 8,
                opacity: compat.ok ? 1 : 0.55,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span>
                    {a.name}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {t?.name}</span>
                  </span>
                  <ReserveBadge aircraft={a} />
                </div>
                <div style={{ fontSize: 11, color: compat.ok ? 'var(--text-muted)' : 'var(--red)' }}>
                  {compat.ok
                    ? `${a.ownershipType === 'owned' ? 'Owned' : 'Leased'} · ${ageLabel(a.ageWeeks ?? 0)}`
                    : compat.reason}
                </div>
                {compat.ok && isReserve(a) && (
                  <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 2 }}>
                    Handing the routes here takes it off standby at {a.reserveBase}.
                  </div>
                )}
              </div>
              <button className="btn btn-primary" disabled={!compat.ok} onClick={() => transferTo(a.id)}>
                Transfer
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ExtendLeaseModal({ aircraft, onClose }) {
  const { dispatch } = useGame();
  const type      = getAircraftType(aircraft.typeId);
  const remaining = aircraft.leaseRemainingWeeks ?? 0;
  const rate      = aircraft.weeklyLease ?? type?.weeklyLease ?? 0;

  function extend(addWeeks) {
    dispatch({ type: 'EXTEND_LEASE', aircraftId: aircraft.id, addWeeks });
    onClose();
  }

  const weeksLabel = (w) => w >= 52 && w % 52 === 0
    ? `${w / 52} yr` : `${w} wk`;

  return (
    <div className="saveload-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="saveload-modal" style={{ width: 'min(460px, 94vw)' }}>
        <div className="saveload-header">
          <h2 style={{ margin: 0, fontSize: 17 }}>Extend Lease</h2>
          <button className="btn" onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '4px 0 14px', lineHeight: 1.5 }}>
          Add time onto <strong>{aircraft.name}</strong> ({type?.name}) at the same weekly rate
          of <strong>{formatMoney(rate)}/wk</strong>. Extending is free — your current
          {' '}<strong>{remaining} weeks</strong> remaining are kept, not reset.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {LEASE_TERM_OPTIONS.map(o => (
            <button
              key={o.weeks}
              className="btn"
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '11px 14px', border: '1px solid var(--border)', borderRadius: 8,
                background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer',
              }}
              onClick={() => extend(o.weeks)}
            >
              <span style={{ fontWeight: 600 }}>+ {weeksLabel(o.weeks)}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                → {remaining + o.weeks} wk remaining
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

// ── Reserve standby (hub-based covers — see docs/reserve-aircraft-design.md) ──
// Station an idle tail at one of your hubs/focus cities; the weekly tick
// auto-covers same-type aircraft that go into the shop at that base.
function ReserveSection({ aircraft, type }) {
  const { state, dispatch } = useGame();
  const hubCodes = Object.keys(state.hubs ?? {});
  const [base, setBase] = useState(aircraft.reserveBase ?? hubCodes[0] ?? '');
  if (!type) return null;

  const allOps   = [...(state.routes ?? []), ...(state.cargoRoutes ?? [])];
  const covering = allOps.filter(r => r.aircraftId === aircraft.id && r.coverForAircraftId);
  const feeCat   = type.freighter ? freighterLandingCategory(type.payloadTonnes ?? 0) : type.category;
  const parkingFor = (code) => reserveParkingFee(feeCat, getAirport(code)?.tier ?? 'major');
  // ≈ readiness premium: +15% on this tail's base weekly line maintenance
  // (the engine also applies budget/labor multipliers — this is a preview).
  const premium = Math.round((type.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(aircraft.ageWeeks ?? 0) * (RESERVE_READINESS_MULT - 1));
  // Coverage preview: same-type tails whose routes touch a base.
  const coverableFor = (code) => {
    const sameType = new Set((state.fleet ?? [])
      .filter(a => a.id !== aircraft.id && a.typeId === aircraft.typeId && a.status !== 'retired')
      .map(a => a.id));
    const tails = new Set(); let count = 0;
    for (const r of allOps) {
      const owner = r.coverForAircraftId ?? r.aircraftId;
      if (!sameType.has(owner)) continue;
      if (r.origin === code || r.destination === code || (r.stops ?? []).includes(code)) { count++; tails.add(owner); }
    }
    return { routes: count, tails: tails.size };
  };

  const sectionTitle = (
    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
      <Glyph e="🛡️" /> Reserve Standby
    </div>
  );

  if (covering.length > 0) {
    const forIds = [...new Set(covering.map(r => r.coverForAircraftId))];
    const names  = forIds.map(id => state.fleet.find(a => a.id === id)?.name ?? 'sold aircraft');
    return (
      <div style={{ paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        {sectionTitle}
        <div style={{ fontSize: 13, color: 'var(--accent)', marginBottom: 6 }}>
          Covering {covering.length} route{covering.length !== 1 ? 's' : ''} for {names.join(', ')} — hands back automatically when {names.length > 1 ? 'they return' : 'it returns'} to service.
        </div>
        {aircraft.reserveBase ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-muted)' }}>
            <span>Based at {aircraft.reserveBase} · parking suspended while flying · readiness ≈ {formatMoney(premium)}/wk</span>
            <button className="btn" onClick={() => dispatch({ type: 'CLEAR_RESERVE', aircraftId: aircraft.id })}>Stand down after this cover</button>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Stood down — finishes this cover, then goes idle.</div>
        )}
      </div>
    );
  }

  if (aircraft.reserveBase) {
    const cov = coverableFor(aircraft.reserveBase);
    return (
      <div style={{ paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        {sectionTitle}
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          On standby at <b>{aircraft.reserveBase}</b> — will automatically cover your {cov.tails} other {type.name}{cov.tails !== 1 ? 's' : ''} there ({cov.routes} route{cov.routes !== 1 ? 's' : ''} reachable) if one goes into the shop.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
          <span>Standby cost ≈ {formatMoney(parkingFor(aircraft.reserveBase) + premium)}/wk ({formatMoney(parkingFor(aircraft.reserveBase))} parking + {formatMoney(premium)} readiness)</span>
          <button className="btn" onClick={() => dispatch({ type: 'CLEAR_RESERVE', aircraftId: aircraft.id })}>Stand down</button>
        </div>
      </div>
    );
  }

  if (aircraft.status !== 'idle') return null;
  if (hubCodes.length === 0) {
    return (
      <div style={{ paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        {sectionTitle}
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Designate a hub or focus city (Airports tab) to station this aircraft as a reserve.</div>
      </div>
    );
  }
  const cov = coverableFor(base || hubCodes[0]);
  return (
    <div style={{ paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      {sectionTitle}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
        <span>Station as reserve at</span>
        <select value={base || hubCodes[0]} onChange={e => setBase(e.target.value)} style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}>
          {hubCodes.map(c => <option key={c} value={c}>{c}{(state.hubs?.[c]?.tier ?? 0) === 0 ? ' (focus city)' : ''}</option>)}
        </select>
        <button className="btn btn-primary" onClick={() => dispatch({ type: 'SET_RESERVE', aircraftId: aircraft.id, baseCode: base || hubCodes[0] })}>Station</button>
      </div>
      <div style={{ fontSize: 12, color: cov.routes === 0 ? 'var(--yellow)' : 'var(--text-muted)', marginTop: 6 }}>
        {cov.routes === 0
          ? `No other ${type.name} routes touch ${base || hubCodes[0]} — a reserve here would have nothing to cover (same-type only).`
          : `Would stand in for your ${cov.tails} other ${type.name}${cov.tails !== 1 ? 's' : ''} touching ${base || hubCodes[0]} (${cov.routes} route${cov.routes !== 1 ? 's' : ''}) the moment one is grounded or checked.`}
        {' '}Standby cost ≈ {formatMoney(parkingFor(base || hubCodes[0]) + premium)}/wk.
      </div>
    </div>
  );
}

/**
 * Connectivity status for one tail, plus the retrofit offer when it has none.
 * The quote comes from the engine's canRetrofitWifi — the same function the
 * reducer charges from — so the price on the button cannot drift from the price
 * the player is actually charged.
 */
function WifiBadge({ aircraft }) {
  const { state, dispatch } = useGame();
  const confirm = useConfirm();
  const fitted  = isWifiEquipped(aircraft);
  const quote   = canRetrofitWifi([aircraft], state.cash);

  if (fitted) {
    return (
      <span className="badge" style={{ background: 'rgba(56,139,253,.12)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,.35)' }}
            title={`Connectivity fitted — ${formatMoney(WIFI_WEEKLY_OPEX)}/wk to run. The fee is set airline-wide on the Ancillaries tab.`}>
        <Glyph e="📶" /> Wi-Fi
      </span>
    );
  }
  if (aircraft.status === 'retired') return null;

  return (
    <button
      className="btn"
      style={{
        fontSize: 11, padding: '2px 9px',
        background: quote.ok ? 'var(--surface3)' : 'var(--surface3)',
        color: quote.ok ? 'var(--text-muted)' : 'var(--text-dim)',
        border: '1px solid var(--border)',
        cursor: quote.ok ? 'pointer' : 'not-allowed',
      }}
      disabled={!quote.ok}
      title={quote.ok
        ? `No Wi-Fi on this aircraft — it takes a quality penalty on every route it flies. Retrofit for ${formatMoney(quote.unitCost)}.`
        : quote.reasons[0]}
      onClick={async () => {
        if (!quote.ok) return;
        if (await confirm({
          title: `Fit Wi-Fi to ${aircraft.name}?`,
          body: `${formatMoney(quote.unitCost)} now, then ${formatMoney(WIFI_WEEKLY_OPEX)}/wk to run — `
              + `charged whether the aircraft flies or sits.\n\n`
              + `Fitting it on the production line at order time is cheaper; this is the retrofit price.\n\n`
              + `What you charge passengers is set airline-wide on the Ancillaries tab.`,
          confirmLabel: `Fit for ${formatMoney(quote.unitCost)}`,
        })) {
          dispatch({ type: 'INSTALL_WIFI', aircraftIds: [aircraft.id] });
        }
      }}
    >
      <Glyph e="📶" /> Fit Wi-Fi · {formatMoney(quote.unitCost)}
    </button>
  );
}

function AircraftDetail({ aircraft, onClose, onConfigure, onRetire, onSell }) {
  const { state, dispatch } = useGame();
  const bhCap = maxWeeklyBlockHoursFor(state);
  const { routes } = state;
  const confirm = useConfirm();

  // Inline rename
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft]     = useState('');
  const [showTransfer, setShowTransfer] = useState(false);
  const [bookWeeks, setBookWeeks] = useState(4);
  const [bookType, setBookType]   = useState('C');
  const [showExtend, setShowExtend]     = useState(false);

  // In-panel section navigation — jump straight to a section instead of scrolling.
  const routesRef  = useRef(null);
  const cabinRef   = useRef(null);
  const maintRef   = useRef(null);
  const actionsRef = useRef(null);
  const jumpTo = (ref) => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  function startRename() {
    setNameDraft(aircraft.name);
    setEditingName(true);
  }
  function commitRename() {
    const name = nameDraft.trim();
    if (name && name !== aircraft.name) {
      dispatch({ type: 'RENAME_AIRCRAFT', aircraftId: aircraft.id, name });
    }
    setEditingName(false);
  }

  async function handleBuyout() {
    const t     = getAircraftType(aircraft.typeId);
    const price = leaseBuyoutPrice(aircraft, t, DEPRECIATION_YEARS);
    if (state.cash < price) {
      await confirm.alert({
        title: 'Not enough cash',
        body: `Buying ${aircraft.name} out of its lease costs ${formatMoney(price)}, but you have ${formatMoney(state.cash)}.`,
      });
      return;
    }
    const ok = await confirm({
      title: `Buy out the lease on ${aircraft.name}?`,
      body: `Costs ${formatMoney(price)} (market value plus a 10% early-buyout premium, with your deposit credited back). It becomes an owned aircraft with no weekly lease, and you can sell it later.`,
      confirmLabel: 'Buy out lease',
    });
    if (ok) dispatch({ type: 'BUY_OUT_LEASE', aircraftId: aircraft.id });
  }

  const type = getAircraftType(aircraft.typeId);

  // All routes for this aircraft, with simulation results and block hours.
  // Numbers MUST come from the canonical engine projection (projectWeek) — the
  // same source the Routes and Finance tabs use — so this panel reflects real
  // competitor encroachment, labor, fuel and revenue lifts. Re-simulating
  // standalone here (simulateRoute with no competition context) reported the
  // uncontested demand, which showed routes at 100% load while Routes/Finance
  // correctly showed them contested and often losing money.
  const gd             = currentGameDate(state);
  const proj           = useMemo(() => projectWeek(state), [state]);
  const rrById         = useMemo(() => {
    const m = {};
    for (const rr of proj.report?.routeResults ?? []) m[rr.routeId] = rr;
    return m;
  }, [proj]);
  const aircraftRoutes = routes.filter(r => r.aircraftId === aircraft.id);
  const routeResults   = aircraftRoutes.map(r => {
    // Prefer the engine's authoritative routeResult. Routes the engine skips
    // (grounded or dormant-seasonal) aren't in the report, so fall back to a
    // standalone sim run with the same labor + fuel the engine used.
    let result = rrById[r.id];
    if (!result) {
      const avgUtil = fleetAvgUtilization(state.fleet ?? [], [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]);
      const evMult  = buildEventDemandModel(state.activeEvents).multFor(r.origin, r.destination);
      result = simulateRoute(
        { ...r, ...stateLoungeFields(state, r.origin, r.destination) },
        aircraft, gd, state.labor ?? null, proj.fuelMultiplier, null, [], avgUtil, state.satisfaction ?? null, evMult);
    }
    if (!result) return null;
    const bh = type ? weeklyBlockHours(result.distance, r.weeklyFrequency, type) : 0;
    return { route: r, result, blockHrs: bh };
  }).filter(Boolean);

  const mAbsWeek = absoluteWeek(state.year, state.week);
  const mDue     = dueInfo(aircraft, type, mAbsWeek);
  const mCheckOpts = { maintMod: aircraft.maintMod ?? 1, laborMult: laborEffects(state.labor).maintenanceCostMultiplier, hubFactor: aircraftHubMaintFactor(aircraft.id, state.routes, state.cargoRoutes, state.hubs) };
  const ageWks   = aircraft.ageWeeks ?? 0;
  const ageYrs   = ageWks / 52;
  const maintMlt = maintenanceMultiplier(ageWks);
  const weeklyMaint = Math.round((type?.baseMaintenancePerWk ?? 0) * maintMlt);
  const weeklyLease = aircraft.ownershipType === 'owned' ? 0 : (aircraft.weeklyLease ?? type?.weeklyLease ?? 0);
  const ageColor    = ageYrs < 5 ? 'var(--green)' : ageYrs < 12 ? 'var(--yellow)' : 'var(--red)';

  // Aggregate across all routes
  // Utilisation comes from the shared reading, not from the per-route sim rows:
  // those cover passenger routes only, and they carry no season or cover logic.
  const util           = utilFor(state, aircraft, gd.month);
  const totalBlockHrs  = util.flyingHours;
  const totalRevenue   = routeResults.reduce((s, { result }) => s + result.revenue, 0);
  const totalOpCost    = routeResults.reduce((s, { result }) => s + result.totalOpCost, 0);
  const blockPct       = util.pct;
  const blockColor     = utilColorFor(blockPct, util.overCap);

  const weeklyTotal   = weeklyLease + weeklyMaint + totalOpCost;
  const weeklyProfit  = totalRevenue - weeklyTotal;
  const profitColor   = weeklyProfit >= 0 ? 'var(--green)' : 'var(--red)';

  const cfg = aircraft.config ?? {};
  const cabinKeys = Object.keys(CLASS_FARE_MULTIPLIERS);
  const totalConfigSeats = cabinKeys.reduce((s, k) => s + (cfg[k] ?? 0), 0) || type?.seats || 0;

  return (
    <div
      className="card"
      style={{ marginTop: 0, border: '1px solid var(--accent-dim)', borderRadius: 'var(--radius-lg)', padding: '20px 24px' }}
    >
      {/* ── Header ───────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
        <AircraftThumb type={type} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {editingName ? (
                  <input
                    autoFocus
                    value={nameDraft}
                    maxLength={40}
                    onChange={e => setNameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setEditingName(false);
                    }}
                    style={{
                      fontWeight: 700, fontSize: 20, padding: '2px 8px',
                      background: 'var(--surface2)', color: 'var(--text)',
                      border: '1px solid var(--accent)', borderRadius: 6,
                      outline: 'none', minWidth: 0, width: 260, maxWidth: '100%',
                    }}
                  />
                ) : (
                  <>
                    <span style={{ fontWeight: 700, fontSize: 20 }}>{aircraft.name}</span>
                    <button
                      onClick={startRename}
                      title="Rename aircraft"
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--text-muted)', fontSize: 14, padding: '2px 4px',
                        display: 'inline-flex', alignItems: 'center',
                      }}
                    >
                      <Glyph e="✏️" size={14} />
                    </button>
                  </>
                )}
                {aircraft.tailNumber && (
                  <span style={{
                    fontFamily: 'monospace', fontSize: 13, fontWeight: 700,
                    letterSpacing: '0.1em', padding: '2px 8px', borderRadius: 4,
                    background: 'rgba(56,139,253,0.12)',
                    color: 'var(--accent)',
                    border: '1px solid rgba(56,139,253,0.35)',
                  }}>
                    {aircraft.tailNumber}
                  </span>
                )}
                <WifiBadge aircraft={aircraft} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
                {type?.name} · {type?.manufacturer}
                {' · '}
                <span style={{ color: CAT_COLORS[type?.category] || 'var(--text-muted)' }}>
                  {type?.category}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {aircraft.status === 'grounded' && (
                <span className="badge" style={{
                  background: 'rgba(248,81,73,.15)',
                  color: 'var(--red)',
                  border: '1px solid rgba(248,81,73,.4)',
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}>
                  <Glyph e="🔧" /> Grounded {aircraft.groundedWeeksLeft > 0 ? `(${aircraft.groundedWeeksLeft}w)` : ''}
                </span>
              )}
              {aircraft.status === 'maintenance' && (
                <span className="badge" style={{ background:'rgba(56,139,253,.15)', color:'var(--accent)', border:'1px solid rgba(56,139,253,.4)' }}>
                  <Glyph e="🔧" /> {aircraft.checkType || 'C'} check {aircraft.checkWeeksLeft > 0 ? `(${aircraft.checkWeeksLeft}w)` : ''}
                </span>
              )}
              {!isOutOfService(aircraft) && mDue.state !== 'ok' && (
                <span className="badge" style={{
                  background: mDue.state === 'soon' ? 'rgba(210,153,34,.15)' : 'rgba(248,81,73,.15)',
                  color: mDue.state === 'soon' ? 'var(--yellow)' : 'var(--red)',
                  border: `1px solid ${mDue.state === 'soon' ? 'rgba(210,153,34,.4)' : 'rgba(248,81,73,.4)'}`,
                  ...(mDue.state === 'overdue' ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}),
                }}>
                  {mDue.nextCheck} check {mDue.state === 'soon' ? 'due soon' : mDue.state === 'overdue' ? 'OVERDUE' : 'due'}
                </span>
              )}
              {aircraft.scheduledCheck && !isOutOfService(aircraft) && (
                <span className="badge" style={{ background:'rgba(139,148,158,.15)', color:'var(--text-muted)', border:'1px solid var(--border)' }}>
                  <Glyph e="📅" /> {aircraft.scheduledCheck.type} booked ({Math.max(0, aircraft.scheduledCheck.startWeek - mAbsWeek)}w)
                </span>
              )}
              <span className="badge" style={{
                background: aircraft.ownershipType === 'owned' ? 'rgba(63,185,80,.15)' : 'rgba(56,139,253,.15)',
                color: aircraft.ownershipType === 'owned' ? 'var(--green)' : 'var(--accent)',
                border: `1px solid ${aircraft.ownershipType === 'owned' ? 'rgba(63,185,80,.4)' : 'rgba(56,139,253,.4)'}`,
              }}>
                {aircraft.ownershipType === 'owned' ? 'Owned' : 'Leased'}
              </span>
              <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 16 }} onClick={onClose}><Glyph e="✕" /></button>
            </div>
          </div>

          {/* Specs strip */}
          <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
            <span>⟣ {type?.seats ?? '?'} seats max</span>
            <span>↔ {type?.range?.toLocaleString() ?? '?'} km range</span>
            <span><Glyph e="⛽" /> {type?.fuelBurnPer100km?.toFixed(0)} L/100km fuel burn</span>
            {aircraft.engineLabel && <span><Glyph e="🔧" /> {aircraft.engineLabel}</span>}
            {aircraft.hasWingtips  && <span style={{ color: 'var(--green)' }}>◇ Wingtips</span>}
            {aircraft.fuelMod && aircraft.fuelMod !== 1.0 && (
              <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                −{Math.round((1 - aircraft.fuelMod) * 100)}% fuel
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Quick-nav — jump to a section instead of scrolling the whole panel */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {[
          { label: aircraftRoutes.length > 0 ? `Routes (${aircraftRoutes.length})` : 'Routes', ref: routesRef },
          { label: 'Cabin', ref: cabinRef },
          { label: 'Maintenance', ref: maintRef, due: (!isOutOfService(aircraft) && mDue.state !== 'ok') ? mDue.state : null },
          { label: 'Actions', ref: actionsRef },
        ].map(({ label, ref, due }) => (
          <button
            key={label}
            className="btn btn-ghost"
            onClick={() => jumpTo(ref)}
            style={{ fontSize: 12, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {label}
            {due && (
              <span style={{ width: 7, height: 7, borderRadius: '50%', display: 'inline-block', background: due === 'soon' ? 'var(--yellow)' : 'var(--red)' }} />
            )}
          </button>
        ))}
      </div>

      {/* ── Key metrics ──────────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        gap: 10,
        marginBottom: 20,
      }}>
        {/* Utilisation */}
        <div className="stat-box" style={{ padding: '12px 14px' }}>
          <div className="stat-label">Utilisation ({util.routes.length} route{util.routes.length !== 1 ? 's' : ''})</div>
          <div style={{ fontWeight: 700, fontSize: 17, color: totalBlockHrs > 0 || util.overCap ? blockColor : 'var(--text-muted)', marginTop: 4 }}>
            {totalBlockHrs.toFixed(1)}h
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}> / {bhCap}h</span>
          </div>
          <div style={{ height: 4, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden', marginTop: 6 }}>
            <div style={{
              height: '100%', borderRadius: 2, transition: 'width 0.3s',
              width: utilBarWidth(blockPct),
              background: blockPct > 1
                ? `repeating-linear-gradient(45deg, ${OVER_CAP_COLOR} 0 3px, rgba(0,0,0,0.35) 3px 6px)`
                : (totalBlockHrs > 0 ? blockColor : 'var(--surface3)'),
            }} />
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>
            {blockPct > 1
              ? `over the ${bhCap}h weekly limit by ${(totalBlockHrs - bhCap).toFixed(1)}h — trim frequency or move a route`
              : util.overCap
                ? `⚠ scheduled over the ${bhCap}h limit in ${UTIL_MONTH_NAMES[util.peakMonth - 1]} (${util.peakHours.toFixed(1)}h)`
                : util.grounded
                  ? `out of service — ${util.peakHours.toFixed(1)}h/wk scheduled for its return`
                  : util.seasonal
                    ? `block hrs/wk this month · peak ${util.peakHours.toFixed(1)}h in ${UTIL_MONTH_NAMES[util.peakMonth - 1]}`
                    : 'block hrs/wk across all routes'}
          </div>
        </div>

        {/* Age */}
        <div className="stat-box" style={{ padding: '12px 14px' }}>
          <div className="stat-label">Age</div>
          <div style={{ fontWeight: 700, fontSize: 17, color: ageColor, marginTop: 4 }}>
            {ageLabel(ageWks)}
          </div>
          {maintMlt > 1 && (
            <div style={{ fontSize: 10, color: maintMlt > 1.5 ? 'var(--red)' : 'var(--yellow)', marginTop: 4 }}>
              +{((maintMlt - 1) * 100).toFixed(0)}% maint penalty
            </div>
          )}
        </div>

        {/* Lease / ownership */}
        <div className="stat-box" style={{ padding: '12px 14px' }}>
          <div className="stat-label">{aircraft.ownershipType === 'owned' ? 'Ownership' : 'Lease / wk'}</div>
          {aircraft.ownershipType === 'owned' ? (
            <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--green)', marginTop: 4 }}>Owned</div>
          ) : (
            <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--red)', marginTop: 4 }}>
              −{formatMoney(weeklyLease)}
            </div>
          )}
        </div>

        {/* Maintenance */}
        <div className="stat-box" style={{ padding: '12px 14px' }}>
          <div className="stat-label">Maintenance / wk</div>
          <div style={{ fontWeight: 700, fontSize: 17, color: maintMlt > 1.5 ? 'var(--yellow)' : 'var(--red)', marginTop: 4 }}>
            −{formatMoney(weeklyMaint)}
          </div>
        </div>

        {/* Weekly P&L */}
        <div className="stat-box" style={{ padding: '12px 14px' }}>
          <div className="stat-label">Net / wk (incl. fixed)</div>
          {routeResults.length > 0 ? (
            <div style={{ fontWeight: 700, fontSize: 17, color: profitColor, marginTop: 4 }}>
              {weeklyProfit >= 0 ? '+' : ''}{formatMoney(weeklyProfit)}
            </div>
          ) : (
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-dim)', marginTop: 4 }}>Idle</div>
          )}
          {routeResults.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>
              rev {formatMoney(totalRevenue)} − costs {formatMoney(weeklyTotal)}
            </div>
          )}
        </div>
      </div>

      {/* ── Route breakdown ───────────────────────────────────────── */}
      <div ref={routesRef} style={{ marginBottom: 20, scrollMarginTop: 70 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
          Route Performance {routeResults.length > 1 && `(${routeResults.length} routes)`}
        </div>

        {routeResults.length > 0 ? routeResults.map(({ route: r, result: res, blockHrs: bh }) => {
          const org = getAirport(r.origin);
          const dst = getAirport(r.destination);
          const rhColor = bh / bhCap >= 0.75 ? 'var(--yellow)' : 'var(--text-dim)';
          return (
            <div key={r.id} className="card" style={{ background: 'var(--surface2)', padding: '12px 16px', borderRadius: 'var(--radius)', marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{r.origin} → {r.destination}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>
                    {org?.city} → {dst?.city}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
                  {r.weeklyFrequency}× / wk · {res.distance?.toLocaleString()} km
                  <div style={{ color: rhColor }}>{bh.toFixed(1)}h block</div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
                {[
                  { label: 'Revenue/wk',    value: `+${formatMoney(res.revenue)}`,    color: 'var(--green)' },
                  { label: 'Op Cost/wk',    value: `−${formatMoney(res.totalOpCost)}`, color: 'var(--red)'  },
                  { label: 'Pax/wk',        value: res.passengers.toLocaleString(),    color: 'var(--text)' },
                  { label: 'Load Factor',   value: formatPercent(res.loadFactor),
                    color: res.loadFactor > .7 ? 'var(--green)' : res.loadFactor > .4 ? 'var(--yellow)' : 'var(--red)' },
                  { label: 'Ticket',        value: `$${r.ticketPrice}`,               color: 'var(--text)' },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                    <div style={{ fontWeight: 600, color, marginTop: 2, fontSize: 13 }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        }) : (
          <div style={{
            padding: '14px 16px', background: 'var(--surface2)', borderRadius: 'var(--radius)',
            color: 'var(--text-muted)', fontSize: 13, textAlign: 'center',
          }}>
            Aircraft is idle — assign it to a route to start earning.
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
              Open the <strong>Route Planner</strong> (or <strong>Routes → + Open Route</strong>), pick two airports, choose this aircraft's type, and hit <strong>Open Route</strong> to deploy it.
            </div>
          </div>
        )}

        {/* All-routes total row when there are 2+ routes */}
        {routeResults.length > 1 && (
          <div style={{
            display: 'flex', gap: 16, padding: '10px 16px', borderRadius: 'var(--radius)',
            background: 'var(--surface3)', fontSize: 12, flexWrap: 'wrap', marginTop: 4,
          }}>
            <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>Total across all routes:</span>
            <span style={{ color: 'var(--green)' }}>+{formatMoney(totalRevenue)} revenue</span>
            <span style={{ color: 'var(--red)' }}>−{formatMoney(totalOpCost)} op cost</span>
            {weeklyLease > 0 && <span style={{ color: 'var(--red)' }}>−{formatMoney(weeklyLease)} lease</span>}
            <span style={{ color: 'var(--red)' }}>−{formatMoney(weeklyMaint)} maint</span>
            <span
              style={{ fontWeight: 700, color: profitColor, cursor: 'help' }}
              title="True weekly profit: revenue minus operating cost, aircraft lease and maintenance. This is the number that reflects whether the aircraft actually pays for itself."
            >
              = {weeklyProfit >= 0 ? '+' : ''}{formatMoney(weeklyProfit)} true profit
            </span>
            <span>{routeResults.reduce((s, { result }) => s + result.passengers, 0).toLocaleString()} pax/wk</span>
          </div>
        )}
      </div>

      {/* ── Cabin configuration ───────────────────────────────────── */}
      <div ref={cabinRef} style={{ marginBottom: 20, scrollMarginTop: 70 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
          Cabin Configuration
        </div>
        {/* Seat bar */}
        <div style={{ display: 'flex', height: 20, borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
          {cabinKeys.map(cls => {
            const seats = cfg[cls] ?? 0;
            if (!seats) return null;
            const pct = (seats / totalConfigSeats) * 100;
            return (
              <div
                key={cls}
                style={{
                  width: `${pct}%`, background: CABIN_COLORS[cls],
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700, color: '#fff',
                  overflow: 'hidden', whiteSpace: 'nowrap',
                }}
                title={`${CABIN_LABELS[cls]}: ${seats} seats`}
              >
                {pct > 8 ? seats : ''}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {cabinKeys.map(cls => {
            const seats = cfg[cls] ?? 0;
            if (!seats) return null;
            return (
              <div key={cls} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: CABIN_COLORS[cls] }} />
                <span>{CABIN_LABELS[cls]}: {seats}</span>
                <span style={{ color: 'var(--text-muted)' }}>(×{CLASS_FARE_MULTIPLIERS[cls]})</span>
              </div>
            );
          })}
        </div>
        {cfg?.seatQuality && cfg.seatQuality !== 'basic' && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
            Seat quality: <span style={{ color: 'var(--yellow)', fontWeight: 600, textTransform: 'capitalize' }}>{cfg.seatQuality}</span>
          </div>
        )}
      </div>

      {/* ── Actions ───────────────────────────────────────────────── */}
      {/* ── Maintenance (heavy C/D checks) ─────────────────────────── */}
      <div ref={maintRef} style={{ paddingTop: 16, borderTop: '1px solid var(--border)', scrollMarginTop: 70 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Maintenance Checks</div>
        {aircraft.status === 'maintenance' ? (
          <div style={{ fontSize: 13, color: 'var(--accent)' }}>
            <Glyph e="🔧" /> In {aircraft.checkType || 'C'} check — {aircraft.checkWeeksLeft || 1} week{(aircraft.checkWeeksLeft || 1) !== 1 ? 's' : ''} remaining{aircraft.checkForced ? ' (regulator-forced)' : ''}.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              <span>C check: <span style={{ color: (mDue.cSoon || mDue.cDue) ? 'var(--yellow)' : 'var(--text)' }}>{Math.round(mDue.cProgress * 100)}%</span> ({Math.round(mDue.hoursSinceC)}h · {mDue.weeksSinceC}w)</span>
              <span>D check: <span style={{ color: (mDue.dSoon || mDue.dDue) ? 'var(--yellow)' : 'var(--text)' }}>{Math.round(mDue.dProgress * 100)}%</span> ({Math.round(mDue.hoursSinceD)}h · {mDue.weeksSinceD}w)</span>
            </div>
            {aircraft.scheduledCheck ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}><Glyph e="📅" /> {aircraft.scheduledCheck.type} check booked in {Math.max(0, aircraft.scheduledCheck.startWeek - mAbsWeek)}w</span>
                <button className="btn" onClick={() => dispatch({ type: 'CANCEL_SCHEDULED_CHECK', aircraftId: aircraft.id })}>Cancel</button>
              </div>
            ) : (
              <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => dispatch({ type: 'SCHEDULE_CHECK', aircraftId: aircraft.id, checkType: 'C', startNow: true })}>
                  Start C check — {formatMoney(checkCost(type, 'C', mCheckOpts))} · {checkDurationWeeks(type?.category, 'C')}w
                </button>
                <button className="btn" onClick={() => dispatch({ type: 'SCHEDULE_CHECK', aircraftId: aircraft.id, checkType: 'D', startNow: true })}>
                  Start D check — {formatMoney(checkCost(type, 'D', mCheckOpts))} · {checkDurationWeeks(type?.category, 'D')}w
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-muted)' }}>
                <span>or book ahead:</span>
                <select value={bookType} onChange={e => setBookType(e.target.value)} style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}>
                  <option value="C">C check</option>
                  <option value="D">D check</option>
                </select>
                <span>in</span>
                <input type="number" min={1} max={MAX_SCHEDULE_AHEAD_WEEKS} value={bookWeeks} onChange={e => setBookWeeks(Math.max(1, Math.min(MAX_SCHEDULE_AHEAD_WEEKS, parseInt(e.target.value, 10) || 1)))} style={{ width: 54, background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }} />
                <span>weeks — {formatMoney(checkCost(type, bookType, mCheckOpts))}</span>
                <button className="btn" onClick={() => dispatch({ type: 'SCHEDULE_CHECK', aircraftId: aircraft.id, checkType: bookType, startWeek: mAbsWeek + bookWeeks })}>Book</button>
              </div>
              </>
            )}
            {mDue.state !== 'ok' && (
              <div style={{ fontSize: 12, color: mDue.state === 'soon' ? 'var(--yellow)' : 'var(--red)', marginTop: 8 }}>
                {mDue.nextCheck} check {mDue.state === 'soon' ? 'due soon.' : mDue.state === 'overdue' ? 'OVERDUE — keep flying and the regulator will force a grounding (longer + 50% pricier).' : 'due now.'}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Reserve standby (hub-based covers) ─────────────────────── */}
      {isOutOfService(aircraft) ? (() => {
        const coveredRoutes = [...(state.routes ?? []), ...(state.cargoRoutes ?? [])].filter(r => r.coverForAircraftId === aircraft.id);
        const ownRoutes     = [...(state.routes ?? []), ...(state.cargoRoutes ?? [])].filter(r => r.aircraftId === aircraft.id);
        if (coveredRoutes.length === 0 && ownRoutes.length === 0) return null;
        const coverNames = [...new Set(coveredRoutes.map(r => state.fleet.find(a => a.id === r.aircraftId)?.name).filter(Boolean))];
        return (
          <div style={{ paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}><Glyph e="🛡️" /> Reserve Cover</div>
            {coveredRoutes.length > 0 ? (
              <div style={{ fontSize: 13, color: 'var(--accent)' }}>
                {coveredRoutes.length}/{coveredRoutes.length + ownRoutes.length} route{(coveredRoutes.length + ownRoutes.length) !== 1 ? 's' : ''} covered by {coverNames.join(', ')} while this aircraft is out of service.
                {ownRoutes.length > 0 && <span style={{ color: 'var(--yellow)' }}> {ownRoutes.length} uncovered — earning nothing.</span>}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--yellow)' }}>
                No reserve is covering this aircraft's {ownRoutes.length} route{ownRoutes.length !== 1 ? 's' : ''} — a same-type reserve stationed at an airport they touch would step in automatically.
              </div>
            )}
          </div>
        );
      })() : (
        <ReserveSection aircraft={aircraft} type={type} />
      )}

      {/* ── Actions ───────────────────────────────────────────────── */}
      <div ref={actionsRef} style={{ display: 'flex', gap: 8, paddingTop: 16, borderTop: '1px solid var(--border)', flexWrap: 'wrap', scrollMarginTop: 70 }}>
        <button className="btn btn-primary" onClick={onConfigure}>Configure Cabin</button>
        {(aircraftRoutes.length > 0 || (state.cargoRoutes ?? []).some(r => r.aircraftId === aircraft.id)) && (
          <button className="btn" onClick={() => setShowTransfer(true)}>
            Transfer Routes
          </button>
        )}
        {aircraft.ownershipType === 'owned' && (
          <button
            className="btn"
            style={{ background: 'rgba(255,180,61,.1)', color: 'var(--yellow)', border: '1px solid rgba(255,180,61,.3)' }}
            onClick={onSell}
          >
            Sell Aircraft
          </button>
        )}
        {aircraft.ownershipType === 'lease' && (
          <button
            className="btn"
            style={{ background: 'rgba(56,139,253,.1)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,.3)' }}
            onClick={() => setShowExtend(true)}
          >
            Extend Lease
          </button>
        )}
        {aircraft.ownershipType === 'lease' && (
          <button
            className="btn"
            style={{ background: 'rgba(63,185,80,.1)', color: 'var(--green)', border: '1px solid rgba(63,185,80,.3)' }}
            onClick={handleBuyout}
          >
            Buy Out Lease
          </button>
        )}
        <button
          className="btn"
          style={{ background: 'rgba(248,81,73,.1)', color: 'var(--red)', border: '1px solid rgba(248,81,73,.3)' }}
          onClick={onRetire}
        >
          {aircraft.ownershipType === 'owned' ? 'Scrap / Write Off' : 'Return Aircraft'}
        </button>
      </div>

      {showTransfer && <TransferRoutesModal aircraft={aircraft} onClose={() => setShowTransfer(false)} />}
      {showExtend && <ExtendLeaseModal aircraft={aircraft} onClose={() => setShowExtend(false)} />}
    </div>
  );
}

// ─── Main Fleet page ──────────────────────────────────────────────────────────

const DELIVERY_LEAD = { 'Wide Body': 4, 'Narrow Body': 3, 'Regional Jet': 2, 'Turboprop': 1 };
const CATEGORY_ORDER = ['Turboprop', 'Regional Jet', 'Narrow Body', 'Wide Body'];

// ─── By Type view ─────────────────────────────────────────────────────────────

function FleetByType({ fleet, routes, cargoRoutes = [] }) {
  const { state } = useGame();
  const bhCap = maxWeeklyBlockHoursFor(state);
  const gameMonth = currentGameDate(state).month;
  const gd = { year: 1, week: 1 }; // just for label purposes
  // Group by typeId
  const groups = {};
  for (const aircraft of fleet) {
    if (!groups[aircraft.typeId]) groups[aircraft.typeId] = [];
    groups[aircraft.typeId].push(aircraft);
  }
  // Sort groups: by category order then name
  const sorted = Object.entries(groups).sort(([aId, aList], [bId, bList]) => {
    const aType = getAircraftType(aId);
    const bType = getAircraftType(bId);
    const aCat  = CATEGORY_ORDER.indexOf(aType?.category);
    const bCat  = CATEGORY_ORDER.indexOf(bType?.category);
    if (aCat !== bCat) return aCat - bCat;
    return (aType?.name ?? '').localeCompare(bType?.name ?? '');
  });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
      {sorted.map(([typeId, aircraft]) => {
        const type     = getAircraftType(typeId);
        const catColor = CAT_COLORS[type?.category] || '#93a4ba';
        const count    = aircraft.length;
        const owned    = aircraft.filter(a => a.ownershipType === 'owned').length;
        const leased   = count - owned;
        // Stationed reserves are parked on purpose — they are NOT idle capacity.
        const idle     = aircraft.filter(a => a.status === 'idle' && !isReserve(a)).length;
        const reserve  = aircraft.filter(a => isReserve(a)).length;
        const grounded = aircraft.filter(a => a.status === 'grounded').length;
        const avgAgeWks = aircraft.reduce((s, a) => s + (a.ageWeeks ?? 0), 0) / count;
        const avgAgeYrs = avgAgeWks / 52;
        const ageColor  = avgAgeYrs < 5 ? 'var(--green)' : avgAgeYrs < 12 ? 'var(--yellow)' : 'var(--red)';

        // Total seats across fleet
        const totalSeats = aircraft.reduce((s, a) => {
          const cfg = a.config;
          const seats = cfg
            ? Object.values(cfg).filter(v => typeof v === 'number').reduce((x, y) => x + y, 0) || (type?.seats ?? 0)
            : (type?.seats ?? 0);
          return s + seats;
        }, 0);

        // Total weekly fixed costs
        const totalFixed = aircraft.reduce((s, a) => {
          const lease = a.ownershipType === 'owned' ? 0 : (a.weeklyLease ?? type?.weeklyLease ?? 0);
          const maint = Math.round((type?.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(a.ageWeeks ?? 0));
          return s + lease + maint;
        }, 0);

        // Avg utilisation — the shared reading, so this agrees with the table.
        const utils     = aircraft.map(a => utilFor(state, a, gameMonth));
        const avgBlock  = utils.reduce((s, u) => s + u.flyingHours, 0) / count;
        const anyOver   = utils.some(u => u.overCap);
        const avgPct    = avgBlock / bhCap;
        const blockColor = anyOver ? OVER_CAP_COLOR
          : avgPct >= 0.8 ? 'var(--red)' : avgPct >= 0.5 ? 'var(--yellow)' : avgPct > 0 ? 'var(--accent)' : 'var(--surface3)';

        return (
          <div key={typeId} className="card" style={{ padding: '16px 18px', borderTop: `3px solid ${catColor}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <AircraftThumb type={type} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{type?.name ?? typeId}</div>
                <div style={{ fontSize: 12, color: catColor, fontWeight: 600 }}>{type?.category}</div>
              </div>
              <div style={{
                fontWeight: 700, fontSize: 28, color: catColor, lineHeight: 1,
                background: `${catColor}14`, borderRadius: 8, padding: '4px 10px',
              }}>{count}</div>
            </div>

            {(() => {
              const inShop = aircraft.filter(a => a.status === 'maintenance').length;
              const due = aircraft.filter(a => a.status !== 'maintenance' && a.status !== 'retired' && (dueInfo(a, type, 0).cDue || dueInfo(a, type, 0).dDue)).length;
              if (inShop + due === 0) return null;
              return (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  {due > 0 && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, background: 'rgba(248,81,73,.12)', color: 'var(--red)', border: '1px solid rgba(248,81,73,.3)' }}><Glyph e="🔧" /> {due} check{due !== 1 ? 's' : ''} due</span>}
                  {inShop > 0 && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, background: 'rgba(56,139,253,.12)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,.3)' }}><Glyph e="🔧" /> {inShop} in shop</span>}
                </div>
              );
            })()}

            {/* Utilisation bar */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                <span>Avg utilisation</span>
                <span style={{ color: blockColor, fontWeight: 600 }}>
                  {avgBlock.toFixed(1)}h / {bhCap}h{anyOver ? ' ⚠' : ''}
                </span>
              </div>
              <div style={{ height: 5, background: 'var(--surface3)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: utilBarWidth(avgPct), background: blockColor, borderRadius: 3, transition: 'width 0.3s' }} />
              </div>
            </div>

            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Avg age</div>
                <div style={{ fontWeight: 600, color: ageColor }}>{avgAgeYrs < 1 ? '<1 yr' : `${avgAgeYrs.toFixed(1)} yrs`}</div>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Total seats</div>
                <div style={{ fontWeight: 600 }}>{totalSeats.toLocaleString()}</div>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Ownership</div>
                <div style={{ fontWeight: 600 }}>
                  {owned > 0 && <span style={{ color: 'var(--green)' }}>{owned} owned</span>}
                  {owned > 0 && leased > 0 && <span style={{ color: 'var(--text-dim)' }}> / </span>}
                  {leased > 0 && <span style={{ color: 'var(--accent)' }}>{leased} leased</span>}
                </div>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Fixed / wk</div>
                <div style={{ fontWeight: 600, color: 'var(--red)' }}>−{formatMoney(totalFixed)}</div>
              </div>
            </div>

            {/* Status badges */}
            {(idle > 0 || reserve > 0 || grounded > 0) && (
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {idle > 0 && (
                  <span className="badge badge-yellow">{idle} idle</span>
                )}
                {reserve > 0 && (
                  <span className="badge" style={{ background: 'rgba(56,139,253,.15)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,.4)' }}>
                    <Glyph e="🛡️" /> {reserve} reserve
                  </span>
                )}
                {grounded > 0 && (
                  <span className="badge" style={{ background: 'rgba(248,81,73,.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,.4)' }}>
                    <Glyph e="🔧" /> {grounded} grounded
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── By Category view ─────────────────────────────────────────────────────────

function FleetByCategory({ fleet, routes, cargoRoutes = [] }) {
  const { state } = useGame();
  const bhCap = maxWeeklyBlockHoursFor(state);
  const gameMonth = currentGameDate(state).month;
  const categories = CATEGORY_ORDER.filter(cat =>
    fleet.some(a => getAircraftType(a.typeId)?.category === cat)
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Fleet composition bar */}
      <div className="card" style={{ padding: '16px 18px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
          Fleet Composition
        </div>
        <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', marginBottom: 10 }}>
          {categories.map(cat => {
            const count = fleet.filter(a => getAircraftType(a.typeId)?.category === cat).length;
            const pct = (count / fleet.length) * 100;
            return (
              <div
                key={cat}
                style={{
                  width: `${pct}%`, background: CAT_COLORS[cat],
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, color: '#fff', overflow: 'hidden', whiteSpace: 'nowrap',
                  transition: 'width 0.3s',
                }}
                title={`${cat}: ${count}`}
              >
                {pct > 10 ? `${cat} (${count})` : pct > 5 ? count : ''}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {categories.map(cat => {
            const count = fleet.filter(a => getAircraftType(a.typeId)?.category === cat).length;
            return (
              <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: CAT_COLORS[cat] }} />
                <span>{cat}: <strong>{count}</strong></span>
                <span style={{ color: 'var(--text-muted)' }}>({((count / fleet.length) * 100).toFixed(0)}%)</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-category breakdown */}
      {categories.map(cat => {
        const catFleet  = fleet.filter(a => getAircraftType(a.typeId)?.category === cat);
        const catColor  = CAT_COLORS[cat];
        const owned     = catFleet.filter(a => a.ownershipType === 'owned').length;
        const leased    = catFleet.length - owned;
        const idle      = catFleet.filter(a => a.status === 'idle' && !isReserve(a)).length;
        const reserve   = catFleet.filter(a => isReserve(a)).length;
        const grounded  = catFleet.filter(a => a.status === 'grounded').length;
        const avgAgeWks = catFleet.reduce((s, a) => s + (a.ageWeeks ?? 0), 0) / catFleet.length;

        // Types within category
        const typeGroups = {};
        for (const a of catFleet) {
          typeGroups[a.typeId] = (typeGroups[a.typeId] ?? 0) + 1;
        }

        // Total weekly fixed
        const totalFixed = catFleet.reduce((s, a) => {
          const t = getAircraftType(a.typeId);
          const lease = a.ownershipType === 'owned' ? 0 : (a.weeklyLease ?? t?.weeklyLease ?? 0);
          const maint = Math.round((t?.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(a.ageWeeks ?? 0));
          return s + lease + maint;
        }, 0);

        // Avg utilisation — the shared reading, so this agrees with the table.
        const catUtils  = catFleet.map(a => utilFor(state, a, gameMonth));
        const avgBlock  = catUtils.reduce((s, u) => s + u.flyingHours, 0) / catFleet.length;
        const anyOver   = catUtils.some(u => u.overCap);
        const avgPct    = avgBlock / bhCap;
        const blockColor = anyOver ? OVER_CAP_COLOR
          : avgPct >= 0.8 ? 'var(--red)' : avgPct >= 0.5 ? 'var(--yellow)' : avgPct > 0 ? 'var(--accent)' : 'var(--surface3)';

        return (
          <div key={cat} className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {/* Category header */}
            <div style={{
              padding: '12px 18px', background: `${catColor}12`,
              borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{
                width: 12, height: 12, borderRadius: '50%', background: catColor, flexShrink: 0,
              }} />
              <span style={{ fontWeight: 700, fontSize: 16, color: catColor }}>{cat}</span>
              <span style={{ fontWeight: 700, fontSize: 22, color: catColor, marginLeft: 'auto' }}>{catFleet.length}</span>
            </div>
            {(() => {
              const inShop = catFleet.filter(a => a.status === 'maintenance').length;
              const due = catFleet.filter(a => a.status !== 'maintenance' && a.status !== 'retired' && (dueInfo(a, getAircraftType(a.typeId), 0).cDue || dueInfo(a, getAircraftType(a.typeId), 0).dDue)).length;
              if (inShop + due === 0) return null;
              return (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '8px 18px 0' }}>
                  {due > 0 && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, background: 'rgba(248,81,73,.12)', color: 'var(--red)', border: '1px solid rgba(248,81,73,.3)' }}><Glyph e="🔧" /> {due} check{due !== 1 ? 's' : ''} due</span>}
                  {inShop > 0 && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, background: 'rgba(56,139,253,.12)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,.3)' }}><Glyph e="🔧" /> {inShop} in shop</span>}
                </div>
              );
            })()}

            <div style={{ padding: '14px 18px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Avg utilisation</div>
                  <div style={{ fontWeight: 600, color: blockColor, marginTop: 2 }}>{avgBlock.toFixed(1)}h / wk</div>
                  <div style={{ height: 3, background: 'var(--surface3)', borderRadius: 2, marginTop: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: utilBarWidth(avgPct), background: blockColor, borderRadius: 2 }} />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Avg age</div>
                  <div style={{ fontWeight: 600, marginTop: 2 }}>{(avgAgeWks / 52).toFixed(1)} yrs</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Ownership</div>
                  <div style={{ fontWeight: 600, marginTop: 2, fontSize: 13 }}>
                    {owned > 0 && <span style={{ color: 'var(--green)' }}>{owned}× owned</span>}
                    {owned > 0 && leased > 0 && ' · '}
                    {leased > 0 && <span style={{ color: 'var(--accent)' }}>{leased}× leased</span>}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Fixed / wk</div>
                  <div style={{ fontWeight: 600, color: 'var(--red)', marginTop: 2 }}>−{formatMoney(totalFixed)}</div>
                </div>
              </div>

              {/* Aircraft types within category */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(typeGroups).map(([tid, cnt]) => {
                  const t = getAircraftType(tid);
                  return (
                    <div key={tid} style={{
                      fontSize: 12, padding: '4px 10px', borderRadius: 20,
                      background: `${catColor}14`, border: `1px solid ${catColor}30`,
                      color: 'var(--text)',
                    }}>
                      <span style={{ color: catColor, fontWeight: 700 }}>{cnt}×</span> {t?.name ?? tid}
                    </div>
                  );
                })}
              </div>

              {(idle > 0 || reserve > 0 || grounded > 0) && (
                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  {idle > 0     && <span className="badge badge-yellow">{idle} idle</span>}
                  {reserve > 0  && (
                    <span className="badge" style={{ background: 'rgba(56,139,253,.15)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,.4)' }}>
                      <Glyph e="🛡️" /> {reserve} reserve
                    </span>
                  )}
                  {grounded > 0 && (
                    <span className="badge" style={{ background: 'rgba(248,81,73,.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,.4)' }}>
                      <Glyph e="🔧" /> {grounded} grounded
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Fleet page ──────────────────────────────────────────────────────────

export default function Fleet() {
  const { state, dispatch } = useGame();
  const confirm = useConfirm();
  const { fleet, routes, cargoRoutes = [], pendingOrders = [], year, week, cash } = state;
  const bhCap = maxWeeklyBlockHoursFor(state);
  const gameMonth = currentGameDate(state).month;
  const nowAbs = absoluteWeek(year, week);
  const [selectedId,    setSelectedId]    = useState(null);
  const [configuringId, setConfiguringId] = useState(null);
  const [checkedIds,    setCheckedIds]    = useState([]);   // bulk selection
  const [bulkConfigIds, setBulkConfigIds] = useState(null); // array of ids → bulk configure modal
  const [search,        setSearch]        = useState('');
  const [filterChip,    setFilterChip]    = useState('all'); // all | idle | reserve | grounded | leased | owned
  const [filterTypeId,  setFilterTypeId]  = useState(null); // null = all types, or a typeId string
  const [viewMode,      setViewMode]      = useState('list'); // list | byType | byCategory
  const [sortKey,       setSortKey]       = useState(null);   // null = default order | name | type | cabin | age | util | fixed | status
  const [sortDir,       setSortDir]       = useState('asc');  // asc | desc

  // A Dashboard alert can send the player straight here, already filtered —
  // "2 leases expiring" lands on the expiring list, soonest first. The filter
  // is parked rather than passed as a prop because this component does not
  // exist yet at the moment the alert is clicked; see utils/navIntent.js.
  useEffect(() => {
    const nav = consumeNavFilter('fleet');
    if (!nav) return;
    if (nav.filterChip) setFilterChip(nav.filterChip);
    if (nav.filterChip === 'expiring') { setSortKey('lease'); setSortDir('asc'); }
  }, []);
  const [showOnOrder,   setShowOnOrder]   = useState(false); // collapsible "On Order" panel

  // When a plane is picked from the list, bring its detail panel into view so the
  // player doesn't have to hunt for it below a long roster.
  const detailRef = useRef(null);
  useEffect(() => {
    if (selectedId && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedId]);

  async function handleSell(aircraftId) {
    const aircraft     = fleet.find(a => a.id === aircraftId);
    const type         = getAircraftType(aircraft?.typeId);
    const activeRoutes = routes.filter(r => r.aircraftId === aircraftId);
    const ageYears     = (aircraft?.ageWeeks ?? 0) / 52;
    const remaining    = Math.max(0.1, 1 - ageYears / DEPRECIATION_YEARS);
    const nav          = Math.round((type?.purchasePrice ?? 0) * remaining);
    const fee          = Math.round(nav * 0.05);
    const proceeds     = nav - fee;

    const body = (activeRoutes.length > 0
      ? `${aircraft.name} is flying ${activeRoutes.length} route${activeRoutes.length > 1 ? 's' : ''}. Selling it closes them all.\n\n`
      : '')
      + `Sale price (NAV): ${formatMoney(nav)}\n`
      + `Selling & admin fee (5%): −${formatMoney(fee)}\n`
      + `Net proceeds: ${formatMoney(proceeds)}`;

    if (await confirm({ title: `Sell ${aircraft.name}?`, body, danger: true, confirmLabel: 'Sell aircraft' })) {
      dispatch({ type: 'SELL_AIRCRAFT', aircraftId });
      setSelectedId(null);
    }
  }

  async function handleRetire(aircraftId) {
    const aircraft     = fleet.find(a => a.id === aircraftId);
    const type         = getAircraftType(aircraft?.typeId);
    const activeRoutes = routes.filter(r => r.aircraftId === aircraftId);
    const weeksLeft    = aircraft?.leaseRemainingWeeks ?? 0;
    const penalty      = (aircraft?.ownershipType === 'lease' && weeksLeft > 0)
      ? Math.round((aircraft?.weeklyLease ?? type?.weeklyLease ?? 0) * weeksLeft * 0.5)
      : 0;

    const routeNote = activeRoutes.length > 0
      ? `${aircraft.name} is flying ${activeRoutes.length} route${activeRoutes.length > 1 ? 's' : ''}. Returning it closes them all.\n\n`
      : '';
    const isLease = aircraft?.ownershipType === 'lease';
    let title, body, label;
    if (isLease && weeksLeft > 0) {
      title = `Return ${aircraft.name} early?`;
      body  = routeNote + `Early termination penalty: ${formatMoney(penalty)} (${weeksLeft} weeks remaining at 50% of the lease rate).`;
      label = 'Return and pay penalty';
    } else if (isLease) {
      title = `Return ${aircraft.name}?`;
      body  = routeNote + `The lease has run its full term, so there's no penalty.`;
      label = 'Return aircraft';
    } else {
      title = `Retire ${aircraft.name}?`;
      body  = routeNote + `Weekly charges stop once it's retired.`;
      label = 'Retire aircraft';
    }

    if (await confirm({ title, body, danger: true, confirmLabel: label })) {
      dispatch({ type: 'RETIRE_AIRCRAFT', aircraftId });
      setSelectedId(null);
    }
  }

  async function handleCancelOrder(order) {
    const hasRefund = order.ownershipType === 'owned' && order.totalPrice > 0;
    const refund    = hasRefund ? Math.round(order.totalPrice * 0.95) : 0;
    const body = hasRefund
      ? `You'll be refunded ${formatMoney(refund)} (a 5% cancellation fee applies).`
      : `Lease orders are free to cancel before delivery.`;
    if (await confirm({ title: `Cancel the order for ${order.name}?`, body, danger: true, confirmLabel: 'Cancel order' })) {
      dispatch({ type: 'CANCEL_ORDER', orderId: order.id });
    }
  }

  if (fleet.length === 0 && pendingOrders.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon"><Glyph e="🛩️" /></div>
        <div className="empty-state-text">No aircraft yet.</div>
        <div style={{ marginTop: 8, fontSize: 13 }}>Head to <strong>Market</strong> to lease or buy your first aircraft.</div>
      </div>
    );
  }

  const weeklyLeaseTotal = fleet.reduce((s, a) => {
    const t = getAircraftType(a.typeId);
    return s + (a.ownershipType === 'owned' ? 0 : (a.weeklyLease ?? t?.weeklyLease ?? 0));
  }, 0);
  const weeklyMaintTotal = fleet.reduce((s, a) => {
    const t = getAircraftType(a.typeId);
    return s + Math.round((t?.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(a.ageWeeks));
  }, 0);

  const selectedAircraft = fleet.find(a => a.id === selectedId);

  const currentAbsWeek = absoluteWeek(year, week);

  // Search + filter
  const searchTerm = search.trim().toLowerCase();
  const visibleFleet = fleet.filter(a => {
    const type = getAircraftType(a.typeId);
    if (searchTerm) {
      const hit = (
        a.name.toLowerCase().includes(searchTerm) ||
        (a.tailNumber ?? '').toLowerCase().includes(searchTerm) ||
        (type?.name ?? '').toLowerCase().includes(searchTerm) ||
        (type?.category ?? '').toLowerCase().includes(searchTerm)
      );
      if (!hit) return false;
    }
    if (filterTypeId && a.typeId !== filterTypeId) return false;
    // "Idle" means genuinely unused — a tail stationed as a reserve is doing a
    // job (standing by) and lives on its own chip instead.
    if (filterChip === 'idle')     return a.status === 'idle' && !isReserve(a);
    if (filterChip === 'reserve')  return isReserve(a);
    if (filterChip === 'grounded') return a.status === 'grounded';
    if (filterChip === 'expiring') return isLeaseExpiring(a);
    if (filterChip === 'leased')   return a.ownershipType !== 'owned';
    if (filterChip === 'owned')    return a.ownershipType === 'owned';
    return true;
  });

  // ── Column sorting ──────────────────────────────────────────────────────
  // Numeric columns start descending (biggest first — that's usually what you
  // want for age/util/cost); text columns start ascending.
  const DESC_FIRST = ['age', 'util', 'fixed'];

  function handleSort(k) {
    if (sortKey === k) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(k);
      setSortDir(DESC_FIRST.includes(k) ? 'desc' : 'asc');
    }
  }

  function sortValue(a, key) {
    const t = getAircraftType(a.typeId);
    switch (key) {
      case 'name': return (a.name ?? '').toLowerCase();
      case 'type': return (t?.name ?? '').toLowerCase();
      case 'cabin': {
        const cfg = a.config;
        const seats = cfg
          ? (cfg.firstClass ?? 0) + (cfg.businessClass ?? 0) + (cfg.premiumEconomy ?? 0) + (cfg.economy ?? 0)
          : (t?.seats ?? 0);
        return seats;
      }
      case 'age': return a.ageWeeks ?? 0;
      // Owned aircraft sort last: they have no lease clock to run out.
      case 'lease': return leaseRemainingWeeks(a) ?? Number.POSITIVE_INFINITY;
      // Sort by the same number the column prints — an over-cap tail sorts by
      // the hours it is actually breaching the cap with, so "sort by UTIL." puts
      // the offenders on top instead of scattering them.
      case 'util': {
        if (!t) return 0;
        const u = utilFor(state, a, gameMonth);
        return u.overCap ? Math.max(u.flyingHours, u.peakHours) : u.flyingHours;
      }
      case 'fixed': {
        const maint = Math.round((t?.baseMaintenancePerWk ?? 0) * maintenanceMultiplier(a.ageWeeks ?? 0));
        const lease = a.ownershipType === 'owned' ? 0 : (a.weeklyLease ?? t?.weeklyLease ?? 0);
        return lease + maint;
      }
      case 'status': {
        // Grounded < in shop < idle < flying (then by how many routes it flies)
        const routeCount = routes.filter(r => r.aircraftId === a.id).length
                         + cargoRoutes.filter(r => r.aircraftId === a.id).length;
        if (a.status === 'grounded')    return 0;
        if (a.status === 'maintenance') return 1;
        if (routeCount === 0)           return 2;
        return 3 + Math.min(routeCount, 96) / 100;
      }
      default: return 0;
    }
  }

  const sortedFleet = sortKey == null ? visibleFleet : [...visibleFleet].sort((a, b) => {
    const va = sortValue(a, sortKey);
    const vb = sortValue(b, sortKey);
    let cmp;
    if (typeof va === 'string' || typeof vb === 'string') cmp = String(va).localeCompare(String(vb));
    else cmp = va - vb;
    if (cmp === 0) cmp = (a.name ?? '').localeCompare(b.name ?? ''); // stable tie-break
    return sortDir === 'asc' ? cmp : -cmp;
  });

  // ── Bulk selection ──────────────────────────────────────────────────────
  const checkedAircraft   = fleet.filter(a => checkedIds.includes(a.id));
  const allVisibleChecked = visibleFleet.length > 0 && visibleFleet.every(a => checkedIds.includes(a.id));
  const checkedTypeIds    = [...new Set(checkedAircraft.map(a => a.typeId))];
  const canBulkConfigure  = checkedAircraft.length > 0 && checkedTypeIds.length === 1;
  const checkedOwned      = checkedAircraft.filter(a => a.ownershipType === 'owned');
  // Wi-Fi retrofit: only tails that don't already have it. Quoted through the
  // engine's own canRetrofitWifi so the number on the button is the number the
  // reducer takes — the same shared-predicate rule canBuildBase follows.
  const wifiQuote         = canRetrofitWifi(checkedAircraft, cash);
  const checkedNoWifi     = wifiQuote.eligible;

  function toggleChecked(id) {
    setCheckedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  }

  function toggleAllVisible() {
    setCheckedIds(ids => allVisibleChecked
      ? ids.filter(id => !visibleFleet.some(a => a.id === id))
      : [...new Set([...ids, ...visibleFleet.map(a => a.id)])]);
  }

  function sellValue(a) {
    const type      = getAircraftType(a.typeId);
    const ageYears  = (a.ageWeeks ?? 0) / 52;
    const remaining = Math.max(0.1, 1 - ageYears / DEPRECIATION_YEARS);
    const nav       = Math.round((type?.purchasePrice ?? 0) * remaining);
    return nav - Math.round(nav * 0.05);
  }

  async function handleBulkSell() {
    if (checkedOwned.length === 0) return;
    const proceeds   = checkedOwned.reduce((s, a) => s + sellValue(a), 0);
    const routeCount = checkedOwned.reduce((s, a) =>
      s + routes.filter(r => r.aircraftId === a.id).length
        + cargoRoutes.filter(r => r.aircraftId === a.id).length, 0);
    const names = checkedOwned.slice(0, 8).map(a => a.name).join(', ')
                + (checkedOwned.length > 8 ? `, +${checkedOwned.length - 8} more` : '');

    const body = (routeCount > 0 ? `These aircraft fly ${routeCount} route${routeCount > 1 ? 's' : ''}. Selling closes them all.\n\n` : '')
      + `${names}\n\n`
      + `Net proceeds after the 5% fee: ${formatMoney(proceeds)}`;

    if (await confirm({ title: `Sell ${checkedOwned.length} owned aircraft?`, body, danger: true, confirmLabel: 'Sell aircraft' })) {
      dispatch({ type: 'SELL_AIRCRAFT_BULK', aircraftIds: checkedOwned.map(a => a.id) });
      setCheckedIds([]);
      setSelectedId(null);
    }
  }

  async function handleBulkRetire() {
    if (checkedAircraft.length === 0) return;
    let totalPenalty = 0;
    let routeCount   = 0;
    for (const a of checkedAircraft) {
      const type      = getAircraftType(a.typeId);
      const weeksLeft = a.leaseRemainingWeeks ?? 0;
      if (a.ownershipType === 'lease' && weeksLeft > 0) {
        totalPenalty += Math.round((a.weeklyLease ?? type?.weeklyLease ?? 0) * weeksLeft * 0.5);
      }
      routeCount += routes.filter(r => r.aircraftId === a.id).length
                  + cargoRoutes.filter(r => r.aircraftId === a.id).length;
    }
    const leasedCount = checkedAircraft.filter(a => a.ownershipType !== 'owned').length;
    const ownedCount  = checkedAircraft.length - leasedCount;
    const names = checkedAircraft.slice(0, 8).map(a => a.name).join(', ')
                + (checkedAircraft.length > 8 ? `, +${checkedAircraft.length - 8} more` : '');

    let body = (routeCount > 0 ? `These aircraft fly ${routeCount} route${routeCount > 1 ? 's' : ''}. Removing them closes them all.\n\n` : '')
      + `${names}\n\n`;
    if (leasedCount > 0) body += `${leasedCount} leased aircraft returned.\n`;
    if (ownedCount  > 0) body += `${ownedCount} owned aircraft retired (no sale proceeds; use Sell to get cash back).\n`;
    if (totalPenalty > 0) body += `\nTotal early lease termination penalties: ${formatMoney(totalPenalty)}`;

    if (await confirm({ title: `Remove ${checkedAircraft.length} aircraft from the fleet?`, body: body.trim(), danger: true, confirmLabel: 'Remove aircraft' })) {
      dispatch({ type: 'RETIRE_AIRCRAFT_BULK', aircraftIds: checkedAircraft.map(a => a.id) });
      setCheckedIds([]);
      setSelectedId(null);
    }
  }

  const chipCounts = {
    all:      fleet.length,
    idle:     fleet.filter(a => a.status === 'idle' && !isReserve(a)).length,
    reserve:  fleet.filter(a => isReserve(a)).length,
    grounded: fleet.filter(a => a.status === 'grounded').length,
    leased:   fleet.filter(a => a.ownershipType !== 'owned').length,
    expiring: fleet.filter(a => isLeaseExpiring(a)).length,
    owned:    fleet.filter(a => a.ownershipType === 'owned').length,
  };

  // ── Fleet-wide heavy maintenance ────────────────────────────────────────
  // A serviceable aircraft is one that's flying (not already in the shop, not
  // grounded, not already booked). dueInfo.primaryDue is 'D' when a D check is
  // due (a D also covers the C clock) else 'C' — so the two lists never overlap
  // and together cover every aircraft that has a heavy check due right now.
  const maintLaborMult = laborEffects(state.labor).maintenanceCostMultiplier;
  const maintAuto = autoSchedulingActive(state.labor, state.maintenanceBudget);
  const checkOptsFor = (a) => ({
    maintMod:  a.maintMod ?? 1,
    laborMult: maintLaborMult,
    hubFactor: aircraftHubMaintFactor(a.id, routes, cargoRoutes, state.hubs),
  });
  const maintServiceable = fleet.filter(a => !isOutOfService(a) && !a.scheduledCheck && a.status !== 'retired');
  const maintDue = maintServiceable
    .map(a => ({ a, di: dueInfo(a, getAircraftType(a.typeId), nowAbs) }))
    .filter(x => x.di.primaryDue);
  const cDueList = maintDue.filter(x => x.di.primaryDue === 'C').map(x => x.a);
  const dDueList = maintDue.filter(x => x.di.primaryDue === 'D').map(x => x.a);
  const inShopCount = fleet.filter(a => a.status === 'maintenance').length;
  const cDueCost = cDueList.reduce((s, a) => s + checkCost(getAircraftType(a.typeId), 'C', checkOptsFor(a)), 0);
  const dDueCost = dDueList.reduce((s, a) => s + checkCost(getAircraftType(a.typeId), 'D', checkOptsFor(a)), 0);
  const checkedServiceable = checkedAircraft.filter(a => !isOutOfService(a) && !a.scheduledCheck);

  // The leases in the selection that are about to take their routes with them —
  // the list P1's Dashboard alert and the "⏳ Expiring" chip point at. Renewing
  // them was one +1yr click per aircraft, which for a fleet of twenty leases is
  // twenty clicks to avoid twenty route closures.
  const checkedExpiring = checkedAircraft.filter(a => isLeaseExpiring(a));

  async function handleBulkFitWifi() {
    if (checkedNoWifi.length === 0) return;
    const names = checkedNoWifi.slice(0, 8).map(a => a.name).join(', ')
                + (checkedNoWifi.length > 8 ? `, +${checkedNoWifi.length - 8} more` : '');
    const already = checkedAircraft.length - checkedNoWifi.length;
    const body = `${names}\n\n`
      + `${formatMoney(wifiQuote.unitCost)} per aircraft to retrofit — `
      + `${formatMoney(wifiQuote.capex)} in total, due now.\n`
      + `Running cost afterwards: ${formatMoney(WIFI_WEEKLY_OPEX)}/wk per aircraft, `
      + `charged whether it flies or sits.\n\n`
      + (already > 0 ? `${already} of the aircraft you selected already have it and won't be charged again.\n\n` : '')
      + `What you charge passengers for Wi-Fi is set airline-wide on the Ancillaries tab.`;
    if (await confirm({
      title: `Fit Wi-Fi to ${checkedNoWifi.length} aircraft?`,
      body,
      confirmLabel: `Fit for ${formatMoney(wifiQuote.capex)}`,
    })) {
      dispatch({ type: 'INSTALL_WIFI', aircraftIds: checkedNoWifi.map(a => a.id) });
      setCheckedIds([]);
    }
  }

  async function handleBulkExtend(list) {
    if (list.length === 0) return;
    const names = list.slice(0, 8).map(a => `${a.name} (${a.leaseRemainingWeeks}w)`).join(', ')
                + (list.length > 8 ? `, +${list.length - 8} more` : '');
    const routeCount = list.reduce((s, a) =>
      s + routes.filter(r => r.aircraftId === a.id).length
        + cargoRoutes.filter(r => r.aircraftId === a.id).length, 0);
    const body = `Adds a year to each lease at the rate it was signed at. Free, and no remaining time is lost.\n\n`
      + (routeCount > 0
          ? `Left to expire, these aircraft go back and their ${routeCount} route${routeCount !== 1 ? 's' : ''} close.\n\n`
          : '')
      + names;
    if (await confirm({ title: `Extend ${list.length} lease${list.length !== 1 ? 's' : ''} by a year?`, body, confirmLabel: 'Extend leases' })) {
      dispatch({ type: 'EXTEND_LEASES', aircraftIds: list.map(a => a.id), addWeeks: 52 });
      setCheckedIds([]);
    }
  }

  async function handleBulkCheck(list, checkType, onDone) {
    if (list.length === 0) return false;
    const cost  = list.reduce((s, a) => s + checkCost(getAircraftType(a.typeId), checkType, checkOptsFor(a)), 0);
    const names = list.slice(0, 8).map(a => a.name).join(', ') + (list.length > 8 ? `, +${list.length - 8} more` : '');
    const overCash = cost > state.cash;
    const body =
      `${list.length} aircraft will enter a ${checkType} check and be out of service while it runs. `
      + `They keep their routes and resume flying automatically once the check completes.\n\n`
      + `${names}\n\n`
      + `Total cost: ${formatMoney(cost)}`
      + (overCash ? `\n\n⚠ That's more than your ${formatMoney(state.cash)} cash on hand.` : '');
    if (await confirm({ title: `Start ${checkType} check on ${list.length} aircraft?`, body, confirmLabel: `Start ${checkType} check${list.length > 1 ? 's' : ''}` })) {
      dispatch({ type: 'SCHEDULE_CHECKS', aircraftIds: list.map(a => a.id), checkType, startNow: true });
      onDone?.();
      return true;
    }
    return false;
  }

  return (
    <div>
      <Callout
        id="heavychecks_v1"
        when={fleet.length > 0}
        icon="🔧"
        title="Heavy checks are on a clock — schedule them before the regulator does"
      >
        Every airframe accrues hours toward a C check and, eventually, a much
        longer D check. Run them from an aircraft's panel or the fleet-wide bar
        above the table. Ignore one and the check is forced on you at +50% cost
        with the aircraft grounded, which is how most airlines here lose a week.
      </Callout>
      {/* Summary stats */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 16 }}>
        <div className="stat-box">
          <div className="stat-label">Fleet Size</div>
          <div className="stat-value blue">{fleet.length}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Weekly Leases</div>
          <div className={`stat-value ${weeklyLeaseTotal > 0 ? 'red' : ''}`}>{weeklyLeaseTotal > 0 ? `−${formatMoney(weeklyLeaseTotal)}` : formatMoney(0)}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Weekly Maintenance</div>
          <div className={`stat-value ${weeklyMaintTotal > 0 ? 'red' : ''}`}>{weeklyMaintTotal > 0 ? `−${formatMoney(weeklyMaintTotal)}` : formatMoney(0)}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            Idle Aircraft
            <InfoTip side="bottom" text="Planes not assigned to any route and not standing by as a reserve. They still cost lease & maintenance but earn nothing — assign them via the Route Planner, or station one as a reserve at a hub so it automatically covers same-type aircraft during breakdowns and heavy checks. Reserves are counted on their own chip below." />
          </div>
          <div className="stat-value yellow">{fleet.filter(a => a.status === 'idle' && !isReserve(a)).length}</div>
        </div>
        {pendingOrders.length > 0 && (
          <div className="stat-box">
            <div className="stat-label">On Order</div>
            <div className="stat-value" style={{ color: 'var(--yellow)' }}>{pendingOrders.length}</div>
          </div>
        )}
      </div>

      {/* ── By-type summary strip ─────────────────────────────────────────── */}
      {fleet.length > 0 && (() => {
        // Build per-type summaries for the strip
        const typeMap = {};
        for (const a of fleet) {
          if (!typeMap[a.typeId]) typeMap[a.typeId] = [];
          typeMap[a.typeId].push(a);
        }
        const typeSummaries = Object.entries(typeMap).sort(([aId], [bId]) => {
          const at = getAircraftType(aId), bt = getAircraftType(bId);
          const ac = CATEGORY_ORDER.indexOf(at?.category), bc = CATEGORY_ORDER.indexOf(bt?.category);
          return ac !== bc ? ac - bc : (at?.name ?? '').localeCompare(bt?.name ?? '');
        }).map(([typeId, aircraft]) => {
          const type = getAircraftType(typeId);
          const catColor = CAT_COLORS[type?.category] || '#93a4ba';
          const count = aircraft.length;
          const avgAgeYrs = aircraft.reduce((s, a) => s + (a.ageWeeks ?? 0), 0) / count / 52;
          const chipUtils = aircraft.map(a => utilFor(state, a, gameMonth));
          const avgUtil   = chipUtils.reduce((s, u) => s + u.flyingHours, 0) / count / bhCap;
          const anyOver   = chipUtils.some(u => u.overCap);
          const idle = aircraft.filter(a => a.status === 'idle' && !isReserve(a)).length;
          const res  = aircraft.filter(a => isReserve(a)).length;
          return { typeId, type, catColor, count, avgAgeYrs, avgUtil, anyOver, idle, res };
        });
        const isActive = (tid) => filterTypeId === tid;
        return (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {typeSummaries.map(({ typeId, type, catColor, count, avgAgeYrs, avgUtil, anyOver, idle, res }) => {
              const active = isActive(typeId);
              const utilColor = anyOver ? OVER_CAP_COLOR
                : avgUtil >= 0.8 ? 'var(--red)' : avgUtil >= 0.5 ? 'var(--yellow)' : avgUtil > 0 ? 'var(--accent)' : 'var(--text-dim)';
              return (
                <button
                  key={typeId}
                  onClick={() => { setFilterTypeId(active ? null : typeId); setFilterChip('all'); }}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 4,
                    padding: '8px 12px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                    background: active ? `${catColor}20` : 'var(--surface2)',
                    border: `1px solid ${active ? catColor : 'var(--border)'}`,
                    transition: 'all 0.15s', minWidth: 120,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: catColor, flexShrink: 0 }} />
                    <span style={{ fontWeight: 700, fontSize: 13, color: active ? catColor : 'var(--text)' }}>
                      {type?.name ?? typeId}
                    </span>
                    <span style={{
                      marginLeft: 'auto', fontWeight: 700, fontSize: 15,
                      color: active ? catColor : 'var(--text-muted)',
                    }}>×{count}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                    <span style={{ color: utilColor, fontWeight: 600 }}>{(avgUtil * 100).toFixed(0)}% util{anyOver ? ' ⚠' : ''}</span>
                    <span>{avgAgeYrs < 1 ? '<1yr' : `${avgAgeYrs.toFixed(1)}yr`} avg</span>
                    {idle > 0 && <span style={{ color: 'var(--yellow)' }}>{idle} idle</span>}
                    {res > 0 && <span style={{ color: 'var(--accent)' }}>{res} reserve</span>}
                  </div>
                  {/* Mini util bar */}
                  <div style={{ height: 3, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: utilBarWidth(avgUtil), background: utilColor, borderRadius: 2 }} />
                  </div>
                </button>
              );
            })}
            {filterTypeId && (
              <button
                onClick={() => setFilterTypeId(null)}
                className="btn btn-ghost"
                style={{ alignSelf: 'center', fontSize: 12 }}
              >
                <Glyph e="✕" /> Clear type filter
              </button>
            )}
          </div>
        );
      })()}

      {/* Toolbar: view switcher + search/filter */}
      {fleet.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Left: search + filter (only for list view) */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {viewMode === 'list' && (
              <>
                <input
                  className="form-input"
                  placeholder="Search name, type, tail…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ width: 210, flexShrink: 0 }}
                />
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {[
                    { id: 'all',      label: 'All'      },
                    { id: 'idle',     label: '⏸ Idle'  },
                    { id: 'reserve',  label: '🛡️ Reserve' },
                    { id: 'grounded', label: '🔧 Grnd'  },
                    { id: 'expiring', label: '⏳ Expiring' },
                    { id: 'leased',   label: 'Leased'   },
                    { id: 'owned',    label: 'Owned'    },
                  ].filter(c => chipCounts[c.id] > 0 || c.id === 'all').map(c => (
                    <button
                      key={c.id}
                      className={`btn ${filterChip === c.id ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => setFilterChip(c.id)}
                    >
                      <GlyphLabel text={c.label} size={12} />
                      {c.id !== 'all' && chipCounts[c.id] > 0 && (
                        <span style={{ marginLeft: 5, opacity: 0.65, fontSize: 11 }}>{chipCounts[c.id]}</span>
                      )}
                      {c.id === 'all' && (
                        <span style={{ marginLeft: 5, opacity: 0.65, fontSize: 11 }}>{chipCounts.all}</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Right: view mode switcher */}
          <div style={{ display: 'flex', gap: 2, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
            {[
              { id: 'list',        label: '☰ List'       },
              { id: 'byType',      label: '✈ By Type'    },
              { id: 'byCategory',  label: '◈ By Category'},
            ].map(v => (
              <button
                key={v.id}
                className={`btn ${viewMode === v.id ? 'btn-primary' : 'btn-ghost'}`}
                style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6 }}
                onClick={() => setViewMode(v.id)}
              >
                <GlyphLabel text={v.label} size={12} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── On Order panel ─────────────────────────────────────────────────── */}
      {pendingOrders.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
          <div
            onClick={() => setShowOnOrder(v => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowOnOrder(v => !v); } }}
            style={{
              padding: '10px 16px',
              borderBottom: showOnOrder ? '1px solid var(--border)' : 'none',
              fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
              textTransform: 'uppercase', letterSpacing: '0.07em',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 8, cursor: 'pointer', userSelect: 'none',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span><Glyph e="📦" /></span><span>On Order ({pendingOrders.length})</span>
            </span>
            <span style={{
              fontSize: 10, color: 'var(--text-dim)',
              transform: showOnOrder ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.15s',
            }}>▶</span>
          </div>
          {showOnOrder && (
          <table>
            <thead>
              <tr>
                <th>Aircraft</th>
                <th>Engine</th>
                <th>Type</th>
                <th>Delivery</th>
                <th>Progress</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pendingOrders.map(order => {
                const type       = getAircraftType(order.typeId);
                const catColor   = CAT_COLORS[type?.category] || '#93a4ba';
                const weeksLeft  = order.deliverAbsWeek - currentAbsWeek;
                const lead       = DELIVERY_LEAD[type?.category] ?? 2;
                // Use this order's ACTUAL total lead (first-of-type = 2×lead, stacked = +lead),
                // not the flat category constant, so progress isn't stuck at 0% early on.
                const totalLead  = (order.orderedWeek != null && order.orderedYear != null)
                  ? Math.max(1, order.deliverAbsWeek - absoluteWeek(order.orderedYear, order.orderedWeek))
                  : lead;
                const progress   = Math.max(0, Math.min(1, 1 - (weeksLeft / totalLead)));
                const deliverY   = Math.floor((order.deliverAbsWeek - 1) / 52) + 1;
                const _dWIY      = ((order.deliverAbsWeek - 1) % 52) + 1;
                const { monthName: deliverMon, weekInMonth: deliverWIM } = weekToGameDate(_dWIY);
                return (
                  <tr key={order.id}>
                    <td>
                      <strong>{order.name}</strong>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>
                        <span style={{
                          color: order.ownershipType === 'owned' ? 'var(--green)' : 'var(--accent)',
                          fontWeight: 600, marginRight: 4,
                        }}>
                          {order.ownershipType === 'owned' ? 'Purchase' : 'Lease'}
                        </span>
                        {order.hasWingtips && '· Wingtips'}
                      </div>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {order.engineLabel ?? '—'}
                    </td>
                    <td>
                      <span style={{ fontSize: 12, color: catColor, fontWeight: 600 }}>
                        {type?.category ?? '?'}
                      </span>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <span style={{ color: weeksLeft <= 1 ? 'var(--green)' : 'var(--text)', fontWeight: 600 }}>
                        {weeksLeft <= 0 ? 'Arriving…' : `${weeksLeft}w`}
                      </span>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>
                        Wk {deliverWIM} {deliverMon} Y{deliverY}
                      </div>
                    </td>
                    <td style={{ minWidth: 100 }}>
                      <div style={{ height: 4, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', width: `${progress * 100}%`,
                          background: catColor, borderRadius: 2, transition: 'width 0.3s',
                        }} />
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>
                        {Math.round(progress * 100)}% complete
                      </div>
                    </td>
                    <td>
                      <button
                        className="btn"
                        style={{
                          padding: '3px 10px', fontSize: 11,
                          background: 'rgba(248,81,73,0.08)',
                          color: 'var(--red)',
                          border: '1px solid rgba(248,81,73,0.3)',
                        }}
                        onClick={() => handleCancelOrder(order)}
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </div>
      )}

      {/* By Type view */}
      {viewMode === 'byType' && (
        <FleetByType fleet={fleet} routes={routes} cargoRoutes={cargoRoutes} />
      )}

      {/* By Category view */}
      {viewMode === 'byCategory' && (
        <FleetByCategory fleet={fleet} routes={routes} cargoRoutes={cargoRoutes} />
      )}

      {/* Aircraft list + detail panel */}
      {viewMode === 'list' && <>
      {/* ── Fleet maintenance bar ─────────────────────────────────── */}
      {(cDueList.length + dDueList.length + inShopCount) > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '10px 14px', marginBottom: 10, borderRadius: 8,
          background: 'rgba(210,153,34,0.07)', border: '1px solid rgba(210,153,34,0.3)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--yellow)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Glyph e="🔧" /> Maintenance
          </span>
          {maintAuto && (
            <span
              title={`Maintenance pay and budget are both ≥${AUTO_SCHEDULE_PAY_MIN.toFixed(2)}× — due C/D checks are booked automatically at planned cost.`}
              style={{ fontSize: 11, fontWeight: 600, color: 'var(--green)', background: 'rgba(63,185,80,0.12)', border: '1px solid rgba(63,185,80,0.35)', borderRadius: 999, padding: '2px 9px' }}
            >
              ⚙ Auto-scheduling on
            </span>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {(cDueList.length + dDueList.length) > 0
              ? `${cDueList.length + dDueList.length} check${(cDueList.length + dDueList.length) !== 1 ? 's' : ''} due`
              : 'no checks due'}
            {inShopCount > 0 && ` · ${inShopCount} in shop`}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {cDueList.length > 0 && (
              <button
                className="btn"
                style={{ fontSize: 12, padding: '5px 12px', background: 'rgba(210,153,34,0.14)', color: 'var(--yellow)', border: '1px solid rgba(210,153,34,0.4)' }}
                title="Send every aircraft with a C check due into the shop now"
                onClick={() => handleBulkCheck(cDueList, 'C')}
              >
                Do all due C checks ({cDueList.length}) · {formatMoney(cDueCost)}
              </button>
            )}
            {dDueList.length > 0 && (
              <button
                className="btn"
                style={{ fontSize: 12, padding: '5px 12px', background: 'rgba(248,81,73,0.1)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.35)' }}
                title="Send every aircraft with a D check due into the shop now (a D also resets the C-check clock)"
                onClick={() => handleBulkCheck(dDueList, 'D')}
              >
                Do all due D checks ({dDueList.length}) · {formatMoney(dDueCost)}
              </button>
            )}
          </div>
        </div>
      )}
      {/* Bulk action bar */}
      {checkedAircraft.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '10px 14px', marginBottom: 10, borderRadius: 8,
          background: 'rgba(56,139,253,0.08)', border: '1px solid var(--accent-dim)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
            {checkedAircraft.length} selected
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {checkedOwned.length} owned · {checkedAircraft.length - checkedOwned.length} leased
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn"
              style={{
                fontSize: 12, padding: '5px 12px',
                background: canBulkConfigure ? 'rgba(56,139,253,0.15)' : 'var(--surface3)',
                color: canBulkConfigure ? 'var(--accent)' : 'var(--text-dim)',
                border: `1px solid ${canBulkConfigure ? 'rgba(56,139,253,0.4)' : 'var(--border)'}`,
                cursor: canBulkConfigure ? 'pointer' : 'not-allowed',
              }}
              disabled={!canBulkConfigure}
              title={canBulkConfigure ? 'Apply one cabin layout to all selected aircraft' : 'Select aircraft of a single type to bulk-configure'}
              onClick={() => canBulkConfigure && setBulkConfigIds(checkedAircraft.map(a => a.id))}
            >
              <Glyph e="⚙" /> Configure ({checkedAircraft.length})
            </button>
            <button
              className="btn"
              style={{
                fontSize: 12, padding: '5px 12px',
                background: checkedServiceable.length > 0 ? 'rgba(210,153,34,0.14)' : 'var(--surface3)',
                color: checkedServiceable.length > 0 ? 'var(--yellow)' : 'var(--text-dim)',
                border: `1px solid ${checkedServiceable.length > 0 ? 'rgba(210,153,34,0.4)' : 'var(--border)'}`,
                cursor: checkedServiceable.length > 0 ? 'pointer' : 'not-allowed',
              }}
              disabled={checkedServiceable.length === 0}
              title={checkedServiceable.length > 0 ? 'Send the selected aircraft into a C check now' : 'Selected aircraft are already in the shop or booked'}
              onClick={() => handleBulkCheck(checkedServiceable, 'C', () => setCheckedIds([]))}
            >
              <Glyph e="🔧" /> C check ({checkedServiceable.length})
            </button>
            {checkedExpiring.length > 0 && (
              <button
                className="btn"
                style={{
                  fontSize: 12, padding: '5px 12px',
                  background: 'rgba(210,153,34,0.14)', color: 'var(--yellow)',
                  border: '1px solid rgba(210,153,34,0.4)', cursor: 'pointer',
                }}
                title="Add a year to every selected lease that is about to expire"
                onClick={() => handleBulkExtend(checkedExpiring)}
              >
                <Glyph e="⏳" /> Extend leases ({checkedExpiring.length})
              </button>
            )}
            {checkedNoWifi.length > 0 && (
              <button
                className="btn"
                style={{
                  fontSize: 12, padding: '5px 12px',
                  background: wifiQuote.ok ? 'rgba(56,139,253,0.15)' : 'var(--surface3)',
                  color: wifiQuote.ok ? 'var(--accent)' : 'var(--text-dim)',
                  border: `1px solid ${wifiQuote.ok ? 'rgba(56,139,253,0.4)' : 'var(--border)'}`,
                  cursor: wifiQuote.ok ? 'pointer' : 'not-allowed',
                }}
                disabled={!wifiQuote.ok}
                title={wifiQuote.ok
                  ? `Retrofit Wi-Fi to ${checkedNoWifi.length} aircraft for ${formatMoney(wifiQuote.capex)}`
                  : wifiQuote.reasons[0]}
                onClick={handleBulkFitWifi}
              >
                <Glyph e="📶" /> Fit Wi-Fi ({checkedNoWifi.length}) · {formatMoney(wifiQuote.capex)}
              </button>
            )}
            <button
              className="btn"
              style={{
                fontSize: 12, padding: '5px 12px',
                background: checkedServiceable.length > 0 ? 'rgba(248,81,73,0.08)' : 'var(--surface3)',
                color: checkedServiceable.length > 0 ? 'var(--red)' : 'var(--text-dim)',
                border: `1px solid ${checkedServiceable.length > 0 ? 'rgba(248,81,73,0.3)' : 'var(--border)'}`,
                cursor: checkedServiceable.length > 0 ? 'pointer' : 'not-allowed',
              }}
              disabled={checkedServiceable.length === 0}
              title={checkedServiceable.length > 0 ? 'Send the selected aircraft into a D check now' : 'Selected aircraft are already in the shop or booked'}
              onClick={() => handleBulkCheck(checkedServiceable, 'D', () => setCheckedIds([]))}
            >
              <Glyph e="🔧" /> D check ({checkedServiceable.length})
            </button>
            <button
              className="btn"
              style={{
                fontSize: 12, padding: '5px 12px',
                background: checkedOwned.length > 0 ? 'rgba(63,185,80,0.12)' : 'var(--surface3)',
                color: checkedOwned.length > 0 ? 'var(--green)' : 'var(--text-dim)',
                border: `1px solid ${checkedOwned.length > 0 ? 'rgba(63,185,80,0.35)' : 'var(--border)'}`,
                cursor: checkedOwned.length > 0 ? 'pointer' : 'not-allowed',
              }}
              disabled={checkedOwned.length === 0}
              title={checkedOwned.length > 0 ? 'Sell all selected owned aircraft at NAV minus 5% fee' : 'Only owned aircraft can be sold'}
              onClick={handleBulkSell}
            >
              Sell owned ({checkedOwned.length})
            </button>
            <button
              className="btn"
              style={{
                fontSize: 12, padding: '5px 12px',
                background: 'rgba(248,81,73,0.08)', color: 'var(--red)',
                border: '1px solid rgba(248,81,73,0.3)', cursor: 'pointer',
              }}
              title="Return leased / retire owned aircraft"
              onClick={handleBulkRetire}
            >
              Return / Retire ({checkedAircraft.length})
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: '5px 10px' }}
              onClick={() => setCheckedIds([])}
            >
              <Glyph e="✕" /> Clear
            </button>
          </div>
        </div>
      )}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 34, textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={allVisibleChecked}
                  onChange={toggleAllVisible}
                  title={allVisibleChecked ? 'Deselect all' : 'Select all visible'}
                  style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                />
              </th>
              <th style={{ width: 88 }}></th>
              <SortableTh label="Aircraft" k="name"   sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableTh label="Type"     k="type"   sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableTh label="Cabin"    k="cabin"  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableTh label="Age"      k="age"    sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableTh label="Util."    k="util"   sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableTh label="Fixed/wk" k="fixed"  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableTh label="Status"   k="status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {visibleFleet.length === 0 ? (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: 13 }}>
                No aircraft match — <button className="btn btn-ghost" style={{ fontSize: 12, display: 'inline' }} onClick={() => { setSearch(''); setFilterChip('all'); }}>clear filters</button>
              </td></tr>
            ) : null}
            {sortedFleet.map(aircraft => {
              const type   = getAircraftType(aircraft.typeId);
              const route  = routes.find(r => r.aircraftId === aircraft.id);
              const ageWks = aircraft.ageWeeks ?? 0;
              const maintM = maintenanceMultiplier(ageWks);
              const maint  = Math.round((type?.baseMaintenancePerWk ?? 0) * maintM);
              const lease  = aircraft.ownershipType === 'owned' ? 0 : (aircraft.weeklyLease ?? type?.weeklyLease ?? 0);
              const ageYrs = ageWks / 52;
              const ageColor = ageYrs < 5 ? 'var(--green)' : ageYrs < 12 ? 'var(--yellow)' : 'var(--red)';

              // Utilisation — one reading, the same one the tick uses.
              const util = utilFor(state, aircraft, gameMonth);
              const allRoutes = routes.filter(r => r.aircraftId === aircraft.id);
              const allCargo  = cargoRoutes.filter(r => r.aircraftId === aircraft.id);
              const assignedRoutes = [...allRoutes, ...allCargo];

              // Cabin summary
              const cfg = aircraft.config;
              const cabinParts = [];
              if (cfg?.firstClass     > 0) cabinParts.push(`${cfg.firstClass}F`);
              if (cfg?.businessClass  > 0) cabinParts.push(`${cfg.businessClass}J`);
              if (cfg?.premiumEconomy > 0) cabinParts.push(`${cfg.premiumEconomy}W`);
              if (cfg?.economy        > 0) cabinParts.push(`${cfg.economy}Y`);
              const cabinStr = cabinParts.length > 0 ? cabinParts.join('/') : `${type?.seats ?? '?'}Y`;

              const isSelected      = selectedId === aircraft.id;
              const leaseRemaining  = aircraft.ownershipType === 'lease' ? (aircraft.leaseRemainingWeeks ?? null) : null;
              const leaseTerm       = aircraft.leaseTermWeeks ?? null;
              const leaseUrgent     = leaseRemaining !== null && leaseRemaining <= 4;
              const leaseWarning    = leaseRemaining !== null && leaseRemaining <= 8 && leaseRemaining > 4;
              const leaseRowBg      = leaseUrgent   ? 'rgba(248,81,73,0.06)'
                                    : leaseWarning  ? 'rgba(210,153,34,0.06)'
                                    : undefined;

              return (
                <tr
                  key={aircraft.id}
                  style={{
                    cursor: 'pointer',
                    background: isSelected ? 'rgba(56,139,253,0.08)' : leaseRowBg,
                    borderLeft: isSelected ? '2px solid var(--accent)'
                              : leaseUrgent ? '2px solid var(--red)'
                              : leaseWarning ? '2px solid var(--yellow)'
                              : '2px solid transparent',
                    transition: 'background 0.15s',
                  }}
                  onClick={() => setSelectedId(isSelected ? null : aircraft.id)}
                >
                  <td
                    style={{ textAlign: 'center', padding: '6px 4px' }}
                    onClick={e => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={checkedIds.includes(aircraft.id)}
                      onChange={() => toggleChecked(aircraft.id)}
                      style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                    />
                  </td>
                  <td style={{ padding: '6px 8px 6px 12px' }}>
                    <AircraftThumb type={type} />
                  </td>
                  <td>
                    <strong>{aircraft.name}</strong>
                    {isWifiEquipped(aircraft) && (
                      <span
                        title="Wi-Fi fitted — this aircraft can sell connectivity and avoids the no-Wi-Fi quality penalty"
                        style={{ marginLeft: 5, fontSize: 10, color: 'var(--accent)' }}
                      ><Glyph e="📶" size={11} /></span>
                    )}
                    {aircraft.tailNumber && (
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'monospace', marginTop: 1, letterSpacing: '0.05em' }}>
                        {aircraft.tailNumber}
                      </div>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{type?.name ?? '?'}</td>
                  <td style={{ fontSize: 12 }}>{cabinStr}</td>
                  <td>
                    <span style={{ color: ageColor, fontWeight: 600 }}>{ageLabel(ageWks)}</span>
                  </td>
                  <td>
                    {(util.flyingHours > 0 || util.overCap) ? (
                      <UtilBar util={util} />
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}
                            title={util.grounded && util.peakHours > 0
                              ? `Out of service — flying nothing this week; its schedule is ${util.peakHours.toFixed(1)}h/wk when it returns`
                              : util.peakHours > 0
                                ? `Dormant this month; ${util.peakHours.toFixed(1)}h/wk in its season`
                                : undefined}>—</span>
                    )}
                  </td>
                  <td style={{ color: 'var(--red)', fontSize: 12 }}>
                    {formatMoney(lease + maint)}
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {aircraft.status === 'grounded' ? (
                        <span className="badge" style={{ background: 'rgba(248,81,73,.15)', color: 'var(--red)', border: '1px solid rgba(248,81,73,.4)' }}>
                          <Glyph e="🔧" /> Grounded {aircraft.groundedWeeksLeft > 0 ? `(${aircraft.groundedWeeksLeft}w)` : ''}
                        </span>
                      ) : assignedRoutes.length > 0 ? (
                        assignedRoutes.length === 1 ? (
                          allCargo.length === 1
                            ? <span className="badge" style={{ background: 'rgba(232,131,58,.15)', color: '#e8833a', border: '1px solid rgba(232,131,58,.4)' }}><Glyph e="📦" /> {allCargo[0].origin}→{allCargo[0].destination}</span>
                            : <span className="badge badge-green">{allRoutes[0].origin}→{allRoutes[0].destination}</span>
                        ) : (
                          <span className="badge badge-green">{assignedRoutes.length} routes</span>
                        )
                      ) : aircraft.reserveBase ? (
                        <span className="badge" style={{ background: 'rgba(56,139,253,.15)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,.4)' }}><Glyph e="🛡️" /> Reserve @ {aircraft.reserveBase}</span>
                      ) : (
                        <span className="badge badge-yellow">Idle</span>
                      )}
                      {assignedRoutes.some(r => r.coverForAircraftId) && (
                        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent)' }}><Glyph e="🛡️" size={10} /> covering{aircraft.reserveBase ? ` from ${aircraft.reserveBase}` : ''}</span>
                      )}
                      {isOutOfService(aircraft) && (() => {
                        const covered = [...routes, ...cargoRoutes].filter(r => r.coverForAircraftId === aircraft.id).length;
                        if (covered === 0) return null;
                        const own = assignedRoutes.length;
                        return <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent)' }}><Glyph e="🛡️" size={10} /> {covered}/{covered + own} covered</span>;
                      })()}
                      {aircraft.status === 'maintenance' && (
                        <span className="badge" style={{ background: 'rgba(56,139,253,.15)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,.4)' }}><Glyph e="🔧" /> {aircraft.checkType || 'C'} check {aircraft.checkWeeksLeft > 0 ? `(${aircraft.checkWeeksLeft}w)` : ''}</span>
                      )}
                      {!isOutOfService(aircraft) && (() => {
                        const di = dueInfo(aircraft, type, nowAbs);
                        if (di.state === 'ok') return aircraft.scheduledCheck ? (<span style={{ fontSize: 10, color: 'var(--text-dim)' }}><Glyph e="📅" size={10} /> {aircraft.scheduledCheck.type} booked</span>) : null;
                        return <span style={{ fontSize: 10, fontWeight: 600, color: di.state === 'soon' ? 'var(--yellow)' : 'var(--red)' }}>{di.nextCheck} check {di.state === 'soon' ? 'due soon' : di.state === 'overdue' ? 'OVERDUE' : 'due'}</span>;
                      })()}
                      {leaseRemaining !== null && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{
                            fontSize: 10, fontWeight: 600,
                            color: leaseUrgent ? 'var(--red)' : leaseWarning ? 'var(--yellow)' : 'var(--text-dim)',
                          }}>
                            {leaseUrgent && <><Glyph e="⚠" size={10} /> </>}{leaseRemaining}w lease
                          </span>
                          <button
                            className="btn btn-ghost"
                            title="Add 1 year to this lease (free), or open the aircraft for more options"
                            style={{ fontSize: 10, padding: '1px 6px', color: 'var(--accent)' }}
                            onClick={e => { e.stopPropagation(); dispatch({ type: 'EXTEND_LEASE', aircraftId: aircraft.id, addWeeks: 52 }); }}
                          >
                            +1yr
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>
        F = First · J = Business · W = Prem-Eco · Y = Economy · Click any row to see details
      </div>

      {/* Detail panel */}
      {selectedAircraft && (
        <div ref={detailRef} style={{ marginTop: 16, scrollMarginTop: 60 }}>
          <AircraftDetail
            aircraft={selectedAircraft}
            onClose={() => setSelectedId(null)}
            onConfigure={() => setConfiguringId(selectedAircraft.id)}
            onRetire={() => handleRetire(selectedAircraft.id)}
            onSell={() => handleSell(selectedAircraft.id)}
          />
        </div>
      )}
      </>}

      {/* FleetConfig modal */}
      {configuringId && (
        <FleetConfig
          aircraftId={configuringId}
          onClose={() => setConfiguringId(null)}
        />
      )}

      {/* Bulk FleetConfig modal */}
      {bulkConfigIds && (
        <FleetConfig
          aircraftIds={bulkConfigIds}
          onClose={() => { setBulkConfigIds(null); setCheckedIds([]); }}
        />
      )}
    </div>
  );
}
