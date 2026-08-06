import { useMemo, useState } from 'react';
import { formatMoney } from '../utils/simulation.js';
import { buildAllianceStats } from '../utils/allianceStats.js';
import AirlineLogo from './AirlineLogo.jsx';
import { Glyph } from './Icons.jsx';

const TIER_COLOR = { budget: 'var(--yellow)', legacy: 'var(--accent)', premium: '#a78bfa' };

function Metric({ label, value, sub, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/**
 * The alliance seen as one airline.
 *
 * Everything here is composed from data the client already holds — every
 * member's route map arrives inside `state.competitors` and has done since
 * human rivals shipped. What was missing was anyone adding it up: the roster
 * used to be a row of names, so a bloc was a benefits sentence rather than a
 * team you could look at.
 */
export default function AllianceDashboard({ alliance, members, state, roster }) {
  const [tab, setTab] = useState('reach');

  const stats = useMemo(() => buildAllianceStats(members, {
    routes: state?.routes ?? [],
    cargoRoutes: state?.cargoRoutes ?? [],
    marketCap: state?.marketCap ?? 0,
    cash: state?.cash ?? 0,
    weeklyRevenue: state?.lastReport?.totalRevenue ?? 0,
  }), [members, state]);

  if (!alliance) return null;

  // Roles and tenure come from the alliance API (multiplayer); solo has none.
  const roleOf = (id) => roster?.find(m => m.airlineId === id || m.name === id)?.role ?? null;

  const TABS = [
    { id: 'reach',   label: `Reach (${stats.reachAdded.length})` },
    { id: 'members', label: `Members (${stats.memberCount})` },
    { id: 'overlap', label: `Overlap (${stats.overlap.length})` },
  ];

  return (
    <div className="card" style={{ padding: '16px 18px', marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{alliance.name}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {stats.memberCount} {stats.memberCount === 1 ? 'carrier' : 'carriers'} · seen as one network
        </div>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 14,
        paddingBottom: 14, borderBottom: '1px solid var(--border)',
      }}>
        <Metric label="Combined market cap" value={formatMoney(stats.blocMarketCap)} />
        <Metric label="Combined weekly revenue" value={formatMoney(stats.blocWeeklyRevenue)} />
        <Metric
          label="Airports reached"
          value={stats.blocAirports}
          sub={stats.blocAirports > stats.yourAirports
            ? `${stats.blocAirports - stats.yourAirports} beyond your own network`
            : 'all of them yours'}
        />
        <Metric label="City pairs flown" value={stats.blocPairs} />
        <Metric label="Weekly departures" value={stats.blocDepartures.toLocaleString()} />
      </div>

      <div style={{ display: 'flex', gap: 6, margin: '14px 0 12px' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`btn ${tab === t.id ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 12, padding: '5px 11px' }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'members' && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Carrier</th>
                <th style={{ textAlign: 'left' }}>Hub</th>
                <th style={{ textAlign: 'right' }}>Market cap</th>
                <th style={{ textAlign: 'right' }}>Cash</th>
                <th style={{ textAlign: 'right' }}>Weekly profit</th>
                <th style={{ textAlign: 'right' }}>Pairs</th>
                <th style={{ textAlign: 'right' }}>Departures</th>
                <th style={{ textAlign: 'right' }}>Quality</th>
              </tr>
            </thead>
            <tbody>
              {stats.members.map(m => (
                <tr key={m.id}>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {m.logoId && <AirlineLogo id={m.logoId} size={16} />}
                      <span style={{ fontWeight: 600 }}>{m.name}</span>
                      {roleOf(m.id) === 'FOUNDER' && <span title="Founder">★</span>}
                      <span style={{ fontSize: 10, color: TIER_COLOR[m.tier] ?? 'var(--text-muted)' }}>
                        {m.tier}
                      </span>
                    </span>
                  </td>
                  <td style={{ fontFamily: 'monospace' }}>{m.hub ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(m.marketCap)}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(m.cash)}</td>
                  <td style={{ textAlign: 'right', color: m.weeklyProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {formatMoney(m.weeklyProfit)}
                    {m.profitTrend != null && (
                      <span style={{ marginLeft: 4, fontSize: 10, color: m.profitTrend >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {m.profitTrend >= 0 ? '▲' : '▼'}
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{m.pairs.size}</td>
                  <td style={{ textAlign: 'right' }}>{m.departures}</td>
                  <td style={{ textAlign: 'right' }}>{m.quality || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {stats.members.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              No partners in the bloc yet — the figures above are your own network.
            </div>
          )}
        </div>
      )}

      {tab === 'reach' && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>
            Airports your partners serve and you do not. This is what the alliance actually
            buys you: connecting traffic onto {stats.reachAdded.length} station
            {stats.reachAdded.length === 1 ? '' : 's'} you never have to fly to yourself.
          </div>
          {stats.reachAdded.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              <Glyph e="ℹ" /> Your partners fly nowhere you don't already serve — a bloc of
              lookalikes. Recruiting a carrier with a different map would add more than another
              one with yours.
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {stats.reachAdded.slice(0, 60).map(({ code, names }) => (
                <span key={code} title={names.join(', ')} style={{
                  fontFamily: 'monospace', fontSize: 12, fontWeight: 700,
                  padding: '3px 8px', borderRadius: 5,
                  background: 'var(--surface2)', border: '1px solid var(--border)',
                }}>
                  {code}
                  {names.length > 1 && <span style={{ opacity: 0.6, fontWeight: 400 }}> ×{names.length}</span>}
                </span>
              ))}
              {stats.reachAdded.length > 60 && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
                  +{stats.reachAdded.length - 60} more
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'overlap' && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>
            Pairs where a partner flies against you. These carry the alliance demand boost —
            but you are also splitting the market with someone paying the same dues.
          </div>
          {stats.overlap.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              <Glyph e="✓" /> No member flies a pair you fly. The bloc is complementary — every
              partner route feeds yours instead of competing with it.
            </div>
          ) : (
            <div style={{ fontSize: 12, lineHeight: 1.8 }}>
              {stats.overlap.slice(0, 30).map(({ pair, names }) => (
                <div key={pair} style={{ display: 'flex', gap: 10 }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, minWidth: 90 }}>
                    {pair.replace('-', ' – ')}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>vs {names.join(', ')}</span>
                </div>
              ))}
              {stats.overlap.length > 30 && (
                <div style={{ color: 'var(--text-muted)' }}>+{stats.overlap.length - 30} more</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
