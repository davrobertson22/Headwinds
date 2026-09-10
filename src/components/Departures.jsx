import { useMemo, useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import {
  buildDepartureBoard, DAY_NAMES,
} from '../models/departureBoard.js';
import { getAircraftType } from '../data/aircraft.js';
import { getAirport } from '../data/airports.js';
import { routeLegs, fleetAvgUtilization } from '../utils/simulation.js';
import { laborEffects } from '../data/labor.js';
import { isOutOfService, groundedKind } from '../data/maintenance.js';
import AirportSelect from './AirportSelect.jsx';
import AirlineLogo from './AirlineLogo.jsx';
import { Glyph } from './Icons.jsx';

/**
 * Departure board — every airline's departures from one airport.
 *
 * Discord asked for this on the airports screen; it lives under Operations
 * instead, with a picker, so you can read ANY airport's board — the one you are
 * thinking of entering as much as the one you already fly. The airport screen
 * links here for the airport you are looking at.
 *
 * Times and flight numbers do not exist in the model (the schedule is a weekly
 * frequency) and are synthesised deterministically in models/departureBoard.js.
 * Everything else on the board — who flies where, how often, on what, and how
 * punctually — is real state.
 */

// ── Cross-screen entry point ────────────────────────────────────────────────
//
// The airport screen links here for the airport being viewed. It cannot pass a
// prop: the shell owns the tab state and Operations is not mounted yet when the
// link is clicked. So the request is parked here and Operations claims it on
// mount, which keeps it a module value with a name instead of a string on
// `window`.
let pendingAirport = null;

/** Open the departure board on `airport` (from anywhere in the app). */
export function requestDepartureBoard(airport) {
  pendingAirport = airport;
  window.dispatchEvent(new CustomEvent('hw:navigate', { detail: { tab: 'operations' } }));
}

/** Claim a parked request, if any. Reading it clears it. */
export function takeDepartureBoardRequest() {
  const a = pendingAirport;
  pendingAirport = null;
  return a;
}

// A rival's on-time rate is not stored, but its quality score is, and OTP is the
// biggest input to that score. Invert it back to a plausible rate so a budget
// carrier visibly runs later than a premium one.
function competitorOtp(c) {
  const q = c.qualityScore ?? c.baseQualityScore ?? 55;
  return Math.max(0.55, Math.min(0.95, 0.60 + (q / 100) * 0.32));
}

const STATUS_COLOR = {
  ontime:    'var(--green)',
  delayed:   'var(--yellow)',
  cancelled: 'var(--red)',
};

export default function Departures({ initialAirport = null }) {
  const { state } = useGame();
  const fleet  = state.fleet ?? [];
  const routes = state.routes ?? [];

  // Default to wherever the player has the most departures — their real base,
  // whether or not it is a designated hub.
  const busiest = useMemo(() => {
    const byCode = {};
    for (const r of routes) {
      for (const leg of routeLegs(r)) {
        byCode[leg.from] = (byCode[leg.from] ?? 0) + (r.weeklyFrequency ?? 0);
      }
    }
    return Object.entries(byCode).sort((a, b) => b[1] - a[1])[0]?.[0]
      ?? Object.keys(state.hubs ?? {})[0] ?? state.hub ?? 'JFK';
  }, [routes, state.hubs, state.hub]);

  const [airport, setAirport] = useState(initialAirport ?? busiest);
  const [day, setDay] = useState(0);
  const [mineOnly, setMineOnly] = useState(false);

  const playerOtp = useMemo(() => {
    try {
      return laborEffects(
        state.labor ?? null,
        fleetAvgUtilization(fleet, [...routes, ...(state.cargoRoutes ?? [])]),
        state.satisfaction ?? null,
      ).onTimeRate;
    } catch { return 0.85; }
  }, [state.labor, state.satisfaction, fleet, routes, state.cargoRoutes]);

  const rows = useMemo(() => {
    // The player's own departures, including every leg of a tag flight that
    // leaves this airport — a rotation stopping here departs here.
    const myLegs = [];
    for (const r of routes) {
      const ac   = fleet.find(a => a.id === r.aircraftId);
      const type = getAircraftType(ac?.typeId);
      // A grounded or in-check tail with no reserve covering it is not flying
      // this week — its departures are cancelled, and the board should say so
      // rather than roll an on-time status for a plane in the hangar. (A
      // covered route already carries the reserve's id, so it shows normally.)
      const cancelled = isOutOfService(ac);
      const cancelReason = !cancelled ? null
        : ac.status === 'maintenance' ? `Aircraft in ${ac.checkType ?? 'heavy'} check`
        : `Aircraft grounded — ${groundedKind(ac).toLowerCase()}`;
      for (const leg of routeLegs(r)) {
        if (leg.from !== airport) continue;
        myLegs.push({
          to: leg.to,
          weeklyFrequency: r.weeklyFrequency ?? 0,
          typeId: type?.id,
          typeName: type?.name ?? '—',
          cancelled,
          cancelReason,
        });
      }
    }

    const carriers = [];
    if (myLegs.length) {
      carriers.push({
        id: '__player__',
        name: state.airlineName ?? 'Your airline',
        isPlayer: true,
        logoId: state.logoId,
        logoColor: state.logoColor,
        customLogo: state.customLogo,
        onTimeRate: playerOtp,
        legs: myLegs,
      });
    }

    if (!mineOnly) {
      for (const c of state.competitors ?? []) {
        const legs = [];
        for (const [key, cfg] of Object.entries(c.routes ?? {})) {
          const [a, b] = key.split('-');
          if (a !== airport && b !== airport) continue;
          const type = cfg?.aircraftType ? getAircraftType(cfg.aircraftType) : null;
          legs.push({
            to: a === airport ? b : a,
            weeklyFrequency: cfg?.frequency ?? 0,
            typeId: type?.id,
            typeName: type?.name ?? '—',
          });
        }
        if (!legs.length) continue;
        carriers.push({
          id: c.id ?? c.name,
          name: c.name,
          logoId: c.logoId,
          logoColor: c.logoColor,
          customLogo: c.customLogo,
          onTimeRate: competitorOtp(c),
          legs,
        });
      }
    }

    return buildDepartureBoard({
      airport, day,
      // Stable per world, so the timetable survives a reload and matches what
      // every other player in this world sees.
      worldSeed: String(state.worldId ?? state.seed ?? state.airlineName ?? 'tailwinds'),
      carriers,
    });
  }, [airport, day, mineOnly, routes, fleet, state.competitors, state.airlineName,
      state.logoId, state.logoColor, state.customLogo, state.worldId, state.seed, playerOtp]);

  const ap = getAirport(airport);
  const mine = rows.filter(r => r.isPlayer).length;
  const carrierCount = new Set(rows.map(r => r.airlineId)).size;

  return (
    <div>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ minWidth: 240 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Airport</div>
          <AirportSelect
            value={airport}
            onChange={setAirport}
            gates={state.gates}
            hubs={state.hubs}
            requireGate={false}
            showGates={false}
          />
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Day</div>
          <select className="form-select" value={day} onChange={e => setDay(Number(e.target.value))}>
            {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', paddingBottom: 8 }}>
          <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} />
          My flights only
        </label>
      </div>

      {/* Board */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
          padding: '12px 16px', background: '#10151f', borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.08em', color: '#f5c518' }}>
              DEPARTURES
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {ap ? `${ap.city} · ${ap.name}` : airport} ({airport}) · {DAY_NAMES[day]}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {rows.length} departures · {carrierCount} airline{carrierCount === 1 ? '' : 's'}
            {mine > 0 && ` · ${mine} yours`}
          </div>
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Nothing departs {airport} on {DAY_NAMES[day]}.
            {mineOnly ? ' You have no flights here — clear the filter to see who does.' : ''}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' }}>
                  <th style={{ textAlign: 'left', padding: '7px 12px' }}>Time</th>
                  <th style={{ textAlign: 'left', padding: '7px 12px' }}>Flight</th>
                  <th style={{ textAlign: 'left', padding: '7px 12px' }}>Destination</th>
                  <th style={{ textAlign: 'left', padding: '7px 12px' }}>Airline</th>
                  <th style={{ textAlign: 'left', padding: '7px 12px' }}>Aircraft</th>
                  <th style={{ textAlign: 'left', padding: '7px 12px' }}>Gate</th>
                  <th style={{ textAlign: 'left', padding: '7px 12px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const dest = getAirport(r.destination);
                  return (
                    <tr key={`${r.flightNo}-${i}`} style={{
                      borderTop: '1px solid var(--border)',
                      background: r.isPlayer ? 'rgba(88,166,255,0.06)' : 'transparent',
                    }}>
                      <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: '#f5c518' }}>
                        {r.timeLabel}
                      </td>
                      <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>
                        {r.flightNo}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{ fontWeight: 600 }}>{dest?.city ?? r.destination}</span>
                        <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>{r.destination}</span>
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                          <AirlineLogo id={r.logoId} accentColor={r.logoColor} customSrc={r.customLogo} size={18} radius={4} />
                          <span style={{ color: r.isPlayer ? 'var(--blue)' : 'var(--text)', fontWeight: r.isPlayer ? 600 : 400 }}>
                            {r.airlineName}
                          </span>
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{r.typeName}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{r.gate}</td>
                      <td style={{ padding: '8px 12px', color: STATUS_COLOR[r.key], fontWeight: r.key === 'ontime' ? 400 : 600 }}
                          title={r.reason ?? undefined}>
                        {r.label}
                        {r.reason && <span style={{ display: 'block', fontSize: 10, fontWeight: 400, color: 'var(--text-dim)' }}>{r.reason}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 10, lineHeight: 1.6 }}>
        <Glyph e="ℹ" /> Who flies where, how often, on what aircraft and how punctually is your world's
        real state — the board is the fastest way to read an airport you are thinking of entering, and
        a carrier running late here is one whose crews are stretched. Clock times, flight numbers and
        gates are generated from the world seed: the schedule is weekly frequency, so the timetable is
        dressing, but it is the same dressing for everyone in this world, every time.
      </div>
    </div>
  );
}
