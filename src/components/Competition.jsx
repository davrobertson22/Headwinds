import { useState, useEffect } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { getAirport } from '../data/airports.js';
import AirportLink from './AirportLink.jsx';
import { referencePrice, formatMoney, formatPercent, SLOTS_PER_GATE, fleetAvgUtilization } from '../utils/simulation.js';
import { computeQualityScore, cabinQualityPoints } from '../models/demand.js';
import { laborEffects } from '../data/labor.js';
import { ARCHETYPES, FIRE_SALE_PREMIUM } from '../models/competitorAI.js';
import { getAlliance, effectiveAllianceId } from '../data/alliances.js';
import { getAircraftType } from '../data/aircraft.js';
import AirlineLogo from './AirlineLogo.jsx';
import { Glyph, GlyphLabel } from './Icons.jsx';

const ACQUISITION_PREMIUM = 1.25;

/** Cost to acquire a carrier — fire-sale carriers go at a discount. */
function acquisitionPrice(carrier) {
  if (carrier.marketCap == null) return null;
  return Math.round(carrier.marketCap * (carrier.fireSale ? FIRE_SALE_PREMIUM : ACQUISITION_PREMIUM));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TIER_META = {
  budget:  { label: 'Budget',  color: 'var(--yellow)' },
  legacy:  { label: 'Legacy',  color: 'var(--accent)'  },
  premium: { label: 'Premium', color: '#a78bfa'         },
};

/** Compute player's quality score for one route — same inputs the engine uses
 *  (real on-time rate from morale + utilization, seat AND service cabin points). */
function playerQuality(route, fleet, laborFx) {
  const aircraft = fleet.find(a => a.id === route.aircraftId);
  if (!aircraft) return null;
  return computeQualityScore({
    onTimeRate:    laborFx.onTimeRate,
    cabinPoints:   cabinQualityPoints(aircraft.config),
    fleetAgeYears: (aircraft.ageWeeks ?? 0) / 52,
    customerRating: laborFx.customerRating,
  });
}

// ─── Root component ───────────────────────────────────────────────────────────

export default function Competition() {
  // Multiplayer (Headwinds): `remote` is true and every competitor is a real
  // player (`c.human`) — acquisitions and AI chrome (tiers, archetypes, fire
  // sales) don't exist; rival profiles load via remoteApi.fetchRivalProfile.
  const { state, dispatch, remote, remoteApi } = useGame();
  const { competitors = [], routes, fleet, financialHistory = [] } = state;
  const [expandedCarrier, setExpandedCarrier] = useState(null);
  const [acquireTarget, setAcquireTarget] = useState(null); // competitor object pending confirmation
  // Multiplayer: clicking a rival opens a dedicated full-screen dossier instead
  // of a cramped inline expand. Null in solo (solo keeps the inline network expand).
  const [detailCarrier, setDetailCarrier] = useState(null);

  // Map from routeKey → player route object
  const playerRouteMap = {};
  for (const r of routes) {
    const key = [r.origin, r.destination].sort().join('-');
    playerRouteMap[key] = r;
  }

  // Routes where at least one competitor overlaps with the player
  const contestedKeys = Object.keys(playerRouteMap).filter(k =>
    competitors.some(c => k in c.routes)
  );

  // Prior week profit for player
  const playerLastWeek = financialHistory.length > 0
    ? financialHistory[financialHistory.length - 1].profit ?? null
    : null;

  return (
    <div>
      {/* ── Acquisition confirmation modal (solo only — you can't buy people) ── */}
      {acquireTarget && !remote && (
        <AcquisitionModal
          target={acquireTarget}
          playerCash={state.cash}
          onConfirm={() => {
            dispatch({ type: 'ACQUIRE_COMPETITOR', competitorId: acquireTarget.id });
            setAcquireTarget(null);
          }}
          onCancel={() => setAcquireTarget(null)}
        />
      )}

      {/* ── Rival dossier (multiplayer) — click any rival to open ──────────── */}
      {remote && detailCarrier && (
        <RivalDetailView carrier={detailCarrier} onClose={() => setDetailCarrier(null)} />
      )}

      {/* ── Leaderboard ───────────────────────────────────────────────────── */}
      <Leaderboard
        competitors={competitors}
        playerLastWeek={playerLastWeek}
        playerName={state.airlineName}
        playerLogoId={state.logoId}
        playerHub={state.hub}
        playerCash={state.cash}
        playerMarketCap={state.marketCap ?? null}
        playerSharePrice={state.sharePrice ?? null}
        playerProfitHistory={financialHistory.slice(-12).map(w => w.profit ?? 0)}
        remote={remote}
        onSelect={remote ? setDetailCarrier : null}
      />

      {/* ── Contested routes ──────────────────────────────────────────────── */}
      <SectionHeader><Glyph e="⚔" /> Contested Routes</SectionHeader>
      {contestedKeys.length === 0 ? (
        <div className="empty-state" style={{ marginBottom: 24 }}>
          <div className="empty-state-icon"><Glyph e="🤝" /></div>
          <div className="empty-state-text">No contested routes yet</div>
          <div style={{ fontSize: 13, marginTop: 6, color: 'var(--text-muted)' }}>
            Open routes that competitors also fly to see head-to-head comparisons.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
          {contestedKeys.map(key => (
            <ContestedRouteRow
              key={key}
              routeKey={key}
              playerRoute={playerRouteMap[key]}
              competitors={competitors.filter(c => key in c.routes)}
              fleet={fleet}
            />
          ))}
        </div>
      )}

      {/* ── Full competitor networks ──────────────────────────────────────── */}
      <SectionHeader>{remote ? 'Rival Networks' : 'Competitor Networks'}</SectionHeader>
      {remote && competitors.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon"><Glyph e="🌍" /></div>
          <div className="empty-state-text">You're the only airline in this world so far</div>
          <div style={{ fontSize: 13, marginTop: 6, color: 'var(--text-muted)' }}>
            Rivals appear here as real players join. Share the world's join code from the lobby.
          </div>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {competitors.map(c => (
          <NetworkPanel
            key={c.id}
            carrier={c}
            playerRouteMap={playerRouteMap}
            playerCash={state.cash}
            expanded={expandedCarrier === c.id}
            onToggle={() => setExpandedCarrier(p => p === c.id ? null : c.id)}
            onAcquire={() => setAcquireTarget(c)}
            onOpenDetail={remote ? () => setDetailCarrier(c) : null}
            remote={remote}
            remoteApi={remoteApi}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Leaderboard({ competitors, playerLastWeek, playerName, playerLogoId, playerHub, playerCash,
                        playerMarketCap, playerSharePrice, playerProfitHistory = [], remote = false,
                        onSelect = null }) {
  // Build unified list with player + competitors
  const entries = [
    {
      id:          '__player__',
      name:        playerName,
      logoId:      playerLogoId,
      hub:         playerHub,
      cash:        playerCash,
      tier:        null,
      weeklyProfit: playerLastWeek,
      marketCap:   playerMarketCap,
      sharePrice:  playerSharePrice,
      profitHistory: playerProfitHistory,
      isPlayer:    true,
      carrier:     null,
    },
    ...competitors.map(c => ({
      id:          c.id,
      name:        c.name,
      logoId:      c.logoId,
      hub:         c.homeHub,
      cash:        c.cash ?? null,
      // Humans don't have AI tiers — every rival is just an airline.
      tier:        c.human ? null : c.tier,
      weeklyProfit: c.weeklyStats?.weeklyProfit ?? null,
      marketCap:   c.marketCap ?? null,
      sharePrice:  c.sharePrice ?? null,
      profitHistory: c.profitHistory ?? [],
      isPlayer:    false,
      carrier:     c,       // raw competitor — clicking opens the rival dossier
    })),
  ];

  const hasMarketCapData = entries.some(e => e.marketCap !== null);

  // Sort by market cap descending; fall back to weekly profit; nulls last
  const sorted = [...entries].sort((a, b) => {
    const aVal = a.marketCap ?? a.weeklyProfit ?? null;
    const bVal = b.marketCap ?? b.weeklyProfit ?? null;
    if (aVal === null && bVal === null) return 0;
    if (aVal === null) return 1;
    if (bVal === null) return -1;
    return bVal - aVal;
  });

  const maxMarketCap = Math.max(...sorted.map(e => e.marketCap ?? 0), 1);

  return (
    <div style={{ marginBottom: 28 }}>
      <SectionHeader><Glyph e="🏆" /> Industry Leaderboard — Market Capitalisation</SectionHeader>
      {onSelect && competitors.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -4, marginBottom: 8 }}>
          Click any rival to open their full dossier — fleet, routes, trends and head-to-head.
        </div>
      )}

      {!hasMarketCapData && (
        <div className="empty-state" style={{ marginBottom: 8 }}>
          <div className="empty-state-icon"><Glyph e="📊" /></div>
          <div className="empty-state-text">The leaderboard populates as weeks complete</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sorted.map((entry, idx) => {
          const profit = entry.weeklyProfit;
          const isPositive = profit !== null && profit >= 0;
          const profitColor = profit === null ? 'var(--text-muted)' : isPositive ? 'var(--green)' : '#f87171';
          const mcap = entry.marketCap;
          const barWidth = mcap !== null ? (mcap / maxMarketCap) * 100 : 0;
          const tier = entry.tier ? TIER_META[entry.tier] : null;
          const rankBadge = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
          const clickable = !!(onSelect && entry.carrier);

          return (
            <div
              key={entry.id}
              className="card"
              onClick={clickable ? () => onSelect(entry.carrier) : undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(entry.carrier); } } : undefined}
              title={clickable ? `View ${entry.name}'s dossier` : undefined}
              style={{
                padding: '10px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                cursor: clickable ? 'pointer' : undefined,
                border: entry.isPlayer ? '1px solid rgba(59,130,246,0.4)' : undefined,
                background: entry.isPlayer ? 'rgba(59,130,246,0.06)' : undefined,
              }}
            >
              {/* Rank */}
              <div style={{ width: 28, display: 'flex', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: idx < 3 ? ['#e0b341', '#b8bcc4', '#c8853f'][idx] : 'var(--text-muted)', flexShrink: 0 }}>
                <Glyph e={rankBadge} size={idx < 3 ? 18 : 13} />
              </div>

              {/* Logo */}
              <AirlineLogo id={entry.logoId} size={32} />

              {/* Name + hub */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{entry.name}</span>
                  {entry.isPlayer && (
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 99, background: 'rgba(59,130,246,0.2)', color: '#60a5fa', fontWeight: 700 }}>
                      YOU
                    </span>
                  )}
                  {tier && (
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 99, background: 'var(--surface2)', color: tier.color, fontWeight: 600 }}>
                      {tier.label}
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    <AirportLink code={entry.hub} style={{ color: 'var(--text-muted)' }} />
                  </span>
                </div>

                {/* Market cap bar */}
                <div style={{ marginTop: 5, height: 4, background: 'var(--surface2)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${barWidth}%`,
                    background: entry.isPlayer ? '#60a5fa' : 'var(--accent)',
                    borderRadius: 2,
                    transition: 'width 0.4s ease',
                  }} />
                </div>
              </div>

              {/* 12-week profit sparkline (multiplayer: how a rival is trending) */}
              {remote && entry.profitHistory?.length >= 2 && (
                <ProfitSparkline history={entry.profitHistory} />
              )}

              {/* Market cap + share price */}
              <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 110 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
                  {mcap !== null ? formatMoney(mcap) : '–'}
                </div>
                <div style={{ fontSize: 11, color: profitColor, marginTop: 1 }}>
                  {entry.sharePrice !== null
                    ? `$${entry.sharePrice.toFixed(2)}/share`
                    : profit !== null
                      ? `${isPositive ? '+' : ''}${formatMoney(profit)}/wk`
                      : 'market cap'}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Tiny inline profit trend — green above zero, red below.
function ProfitSparkline({ history, width = 72, height = 24 }) {
  const max = Math.max(...history.map(Math.abs), 1);
  const stepX = width / Math.max(history.length - 1, 1);
  const y = (v) => height / 2 - (v / max) * (height / 2 - 2);
  const points = history.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = history[history.length - 1];
  return (
    <svg width={width} height={height} style={{ flexShrink: 0 }} aria-label="profit trend">
      <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="var(--border)" strokeWidth="1" strokeDasharray="2 3" />
      <polyline
        points={points}
        fill="none"
        stroke={last >= 0 ? 'var(--green)' : '#f87171'}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

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

function CompetitorCard({ carrier, playerRouteMap }) {
  const tier        = TIER_META[carrier.tier] ?? { label: carrier.tier, color: 'var(--text-muted)' };
  const totalRoutes  = Object.keys(carrier.routes).length;
  const sharedRoutes = Object.keys(carrier.routes).filter(k => k in playerRouteMap).length;
  const s           = carrier.weeklyStats;

  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <AirlineLogo id={carrier.logoId} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.2 }}>{carrier.name}</div>
          <span style={{
            fontSize: 10, padding: '1px 7px', borderRadius: 99,
            background: 'var(--surface2)', color: tier.color, fontWeight: 600,
          }}>
            {tier.label}
          </span>
        </div>
      </div>

      {/* Identity row */}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
        Hub: <AirportLink code={carrier.homeHub} style={{ fontWeight: 700, color: 'var(--text)' }} />
        <span style={{ marginLeft: 12 }}>
          Quality: <strong style={{ color: qualityColor(carrier.baseQualityScore) }}>{carrier.baseQualityScore}/100</strong>
        </span>
      </div>

      {/* Weekly stats — show once first tick has run */}
      {s ? (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr',
            gap: '6px 16px', fontSize: 12, marginBottom: 10,
          }}>
            <StatLine label="Weekly profit" value={formatMoney(s.weeklyProfit)}
              color={s.weeklyProfit >= 0 ? 'var(--green)' : '#f87171'}
              prefix={s.weeklyProfit >= 0 ? '+' : ''} />
            <StatLine label="Weekly revenue" value={formatMoney(s.weeklyRevenue)} />
            <StatLine label="Weekly flights" value={s.weeklyFlights.toLocaleString()} />
            <StatLine label="Weekly pax" value={s.weeklyPax.toLocaleString()} />
          </div>

          {/* Cash */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '7px 10px', background: 'var(--surface2)', borderRadius: 6, fontSize: 12,
          }}>
            <span style={{ color: 'var(--text-muted)' }}>Cash balance</span>
            <strong style={{ color: carrier.cash >= 0 ? 'var(--text)' : '#f87171' }}>
              {formatMoney(carrier.cash ?? 0)}
            </strong>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          Financials appear after the first full week
        </div>
      )}

      {/* Routes summary */}
      <div style={{ display: 'flex', gap: 12, fontSize: 12, marginTop: 8, color: 'var(--text-muted)' }}>
        <span>{totalRoutes} routes</span>
        {sharedRoutes > 0 && (
          <span style={{ color: 'var(--yellow)', fontWeight: 600 }}><Glyph e="⚔" /> {sharedRoutes} shared</span>
        )}
      </div>
    </div>
  );
}

function StatLine({ label, value, color, prefix = '' }) {
  return (
    <div>
      <div style={{ color: 'var(--text-muted)', marginBottom: 1 }}>{label}</div>
      <div style={{ fontWeight: 700, color: color ?? 'var(--text)' }}>{prefix}{value}</div>
    </div>
  );
}

function ContestedRouteRow({ routeKey, playerRoute, competitors, fleet }) {
  const { state } = useGame();
  const [a, b] = routeKey.split('-');
  const oAirport = getAirport(a);
  const dAirport = getAirport(b);
  const refP = referencePrice(a, b);
  // Same labor + utilization inputs the engine feeds the demand model.
  const laborFx = laborEffects(state.labor ?? null,
    fleetAvgUtilization(state.fleet ?? [], [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]),
    state.satisfaction ?? null);
  const pQual = playerQuality(playerRoute, fleet, laborFx);

  const cols = 1 + competitors.length; // you + N competitors

  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      {/* Route header */}
      <div style={{ marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}><AirportLink code={a} /> → <AirportLink code={b} /></span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 10 }}>
          {oAirport?.city} – {dAirport?.city}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>
          · ref ${refP}
        </span>
      </div>

      {/* Comparison grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `140px repeat(${cols}, 1fr)`,
        fontSize: 12,
        gap: 0,
      }}>
        {/* Column headers */}
        <div />
        <ColHeader isPlayer>You</ColHeader>
        {competitors.map(c => <ColHeader key={c.id}>{c.name}</ColHeader>)}

        {/* Price */}
        <RowLabel>Price (economy)</RowLabel>
        <PriceCell price={playerRoute.ticketPrice} refP={refP} isPlayer />
        {competitors.map(c => {
          // Human rivals publish their ACTUAL fare (open book); AI carriers
          // are reconstructed from their price multiplier as before.
          const cfg = c.routes[routeKey];
          const price = cfg.economyFare ?? Math.round(refP * cfg.priceMultiplier);
          return <PriceCell key={c.id} price={price} refP={refP} />;
        })}

        {/* Quality */}
        <RowLabel>Quality score</RowLabel>
        <QualityCell score={pQual} isPlayer />
        {competitors.map(c => <QualityCell key={c.id} score={c.baseQualityScore} />)}

        {/* Frequency */}
        <RowLabel>Flights / week</RowLabel>
        <FreqCell freq={playerRoute.weeklyFrequency} isPlayer />
        {competitors.map(c => (
          <FreqCell key={c.id} freq={c.routes[routeKey].frequency} />
        ))}

        {/* Seats/week — human rivals publish configured capacity (open book) */}
        {competitors.some(c => c.routes[routeKey].seats != null) && (<>
          <RowLabel>Seats / week</RowLabel>
          <div style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--text-muted)' }}>
            {(() => {
              const aircraft = fleet.find(x => x.id === playerRoute.aircraftId);
              const seats = aircraft ? getAircraftType(aircraft.typeId)?.seats ?? null : null;
              return seats != null ? (seats * (playerRoute.weeklyFrequency ?? 0)).toLocaleString() : '–';
            })()}
          </div>
          {competitors.map(c => {
            const cfg = c.routes[routeKey];
            return (
              <div key={c.id} style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--text-muted)' }}>
                {cfg.seats != null ? (cfg.seats * (cfg.frequency ?? 0)).toLocaleString() : '–'}
              </div>
            );
          })}
        </>)}
      </div>

      {/* Hints */}
      <CompetitiveHints
        playerRoute={playerRoute}
        playerQual={pQual}
        competitors={competitors}
        routeKey={routeKey}
        refP={refP}
      />
    </div>
  );
}

function ColHeader({ children, isPlayer }) {
  return (
    <div style={{
      padding: '4px 8px',
      background: isPlayer ? 'rgba(59,130,246,0.12)' : 'var(--surface2)',
      textAlign: 'center',
      fontWeight: 600,
      borderRadius: 4,
      margin: '0 2px 2px',
    }}>
      {children}
    </div>
  );
}

function RowLabel({ children }) {
  return (
    <div style={{ padding: '7px 0', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
      {children}
    </div>
  );
}

function PriceCell({ price, refP, isPlayer }) {
  const ratio = price / refP;
  const color = ratio < 0.95 ? 'var(--green)' : ratio > 1.20 ? '#f87171' : 'var(--text)';
  return (
    <div style={{ padding: '7px 8px', textAlign: 'center' }}>
      <span style={{ fontWeight: 700, color }}>${price}</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 3 }}>
        ({Math.round(ratio * 100)}%)
      </span>
    </div>
  );
}

function QualityCell({ score }) {
  if (score == null) return (
    <div style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--text-muted)' }}>–</div>
  );
  const color = qualityColor(score);
  return (
    <div style={{ padding: '7px 8px', textAlign: 'center' }}>
      <span style={{ fontWeight: 700, color }}>{score}</span>
      <div style={{ height: 3, background: 'var(--surface2)', borderRadius: 2, marginTop: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${score}%`, background: color, borderRadius: 2, transition: 'width 0.3s' }} />
      </div>
    </div>
  );
}

function FreqCell({ freq }) {
  return (
    <div style={{ padding: '7px 8px', textAlign: 'center' }}>
      {freq}×
    </div>
  );
}

function CompetitiveHints({ playerRoute, playerQual, competitors, routeKey, refP }) {
  const hints = [];

  for (const c of competitors) {
    const compPrice = c.routes[routeKey].economyFare
      ?? Math.round(refP * c.routes[routeKey].priceMultiplier);
    const priceDiff = playerRoute.ticketPrice - compPrice;
    const qualDiff  = (playerQual ?? 0) - c.baseQualityScore;

    if (priceDiff > compPrice * 0.12)
      hints.push({ type: 'warn', text: `Your price is ${Math.round(priceDiff / refP * 100)}% above ${c.name}'s — you may be losing price-sensitive passengers.` });

    if (qualDiff < -20)
      hints.push({ type: 'info', text: `${c.name} has a ${Math.abs(qualDiff)}-point quality advantage. Consider upgrading seat or service quality in Fleet.` });

    if (priceDiff < -compPrice * 0.12 && qualDiff > 15)
      hints.push({ type: 'good', text: `You lead ${c.name} on both price and quality — strong position.` });
  }

  if (hints.length === 0) return null;

  const colors = { warn: '#fbbf24', info: 'var(--accent)', good: 'var(--green)' };
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {hints.map((h, i) => (
        <div key={i} style={{ fontSize: 12, color: colors[h.type], padding: '4px 8px', background: 'var(--surface2)', borderRadius: 4 }}>
          <Glyph e={h.type === 'warn' ? '⚠' : h.type === 'good' ? '✓' : 'ℹ'} size={12} /> {h.text}
        </div>
      ))}
    </div>
  );
}

function NetworkPanel({ carrier, playerRouteMap, playerCash, expanded, onToggle, onAcquire, onOpenDetail = null, remote = false, remoteApi = null }) {
  const isHuman = carrier.human === true;
  const tier   = isHuman ? null : (TIER_META[carrier.tier] ?? { label: carrier.tier, color: 'var(--text-muted)' });
  const routes = Object.entries(carrier.routes).sort(([a], [b]) => a.localeCompare(b));
  const arch     = !isHuman && carrier._archetype ? ARCHETYPES[carrier._archetype] : null;
  // Player-founded alliances ('hw:' ids) never resolve in the static bank —
  // the server sends the display name alongside.
  const alliance = isHuman
    ? (carrier.allianceId ? { name: carrier.allianceName ?? 'Alliance', icon: '🤝', color: 'var(--accent)' } : null)
    : getAlliance(effectiveAllianceId(carrier));
  const atWar    = !isHuman && carrier._fareWars && Object.keys(carrier._fareWars).length > 0;

  // You can't buy a human being's airline.
  const acquirable      = !remote && !isHuman;
  const acquisitionCost = acquirable ? acquisitionPrice(carrier) : null;
  const canAfford       = acquisitionCost !== null && playerCash >= acquisitionCost;
  const hasMarketCap    = carrier.marketCap != null;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        onClick={onOpenDetail || onToggle}
        title={onOpenDetail ? `View ${carrier.name}'s dossier` : undefined}
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)',
        }}
      >
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700 }}>{carrier.name}</span>
          {tier && <span style={{ fontSize: 11, color: tier.color, fontWeight: 600 }}>{tier.label}</span>}
          {isHuman && (
            <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 99,
                           background: 'var(--accent-dim, var(--surface2))', color: 'var(--accent)', fontWeight: 700 }}>
              PLAYER
            </span>
          )}
          {arch && (
            <span
              title={arch.blurb}
              style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600,
                       padding: '1px 7px', borderRadius: 10, border: '1px solid var(--border)' }}
            >
              <GlyphLabel size={12} text={`${arch.icon} ${arch.label}`} />
            </span>
          )}
          {carrier.fireSale && (
            <span style={{ fontSize: 11, fontWeight: 700, color: '#f87171',
                           padding: '1px 7px', borderRadius: 10,
                           border: '1px solid rgba(248,113,113,0.5)', background: 'rgba(248,113,113,0.12)' }}>
              <GlyphLabel size={12} text="💸 Fire sale" />
            </span>
          )}
          {carrier.isStartup && (
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--green)',
                           padding: '1px 7px', borderRadius: 10, border: '1px solid rgba(16,185,129,0.4)' }}>
              <GlyphLabel size={12} text="🛫 Startup" />
            </span>
          )}
          {atWar && (
            <span
              title="This carrier is waging a fare war on a route you share — it is pricing below cost to push you off."
              style={{ fontSize: 11, fontWeight: 700, color: '#fb923c',
                       padding: '1px 7px', borderRadius: 10,
                       border: '1px solid rgba(251,146,60,0.5)', background: 'rgba(251,146,60,0.12)' }}>
              <GlyphLabel size={12} text="🔥 Fare war" />
            </span>
          )}
          {alliance && (
            <span
              title={alliance.name}
              style={{ fontSize: 11, fontWeight: 600, color: alliance.color ?? 'var(--text-muted)',
                       padding: '1px 7px', borderRadius: 10, border: '1px solid var(--border)' }}>
              <GlyphLabel size={12} text={`${alliance.icon} ${alliance.name}`} />
            </span>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            hub {carrier.homeHub}{carrier.secondaryHub ? ` +${carrier.secondaryHub}` : ''}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{routes.length} routes</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· quality {carrier.baseQualityScore}/100</span>
          {hasMarketCap && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              · mkt cap <strong style={{ color: 'var(--text)' }}>{formatMoney(carrier.marketCap)}</strong>
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {acquirable && hasMarketCap && (
            <button
              onClick={e => { e.stopPropagation(); onAcquire(); }}
              disabled={!canAfford}
              style={{
                fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 6, cursor: canAfford ? 'pointer' : 'not-allowed',
                background: canAfford ? 'rgba(16,185,129,0.15)' : 'var(--surface2)',
                color: canAfford ? 'var(--green)' : 'var(--text-muted)',
                border: `1px solid ${canAfford ? 'rgba(16,185,129,0.4)' : 'var(--border)'}`,
              }}
              title={canAfford ? `Acquire for ${formatMoney(acquisitionCost)}` : `Need ${formatMoney(acquisitionCost ?? 0)} to acquire`}
            >
              <GlyphLabel size={13} text={canAfford ? '🤝 Acquire' : `🔒 ${formatMoney(acquisitionCost ?? 0)}`} />
            </button>
          )}
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{onOpenDetail ? '›' : expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && !onOpenDetail && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {/* Multiplayer: the rival's public profile — fleet, rank history,
              recent moves — fetched from the server on expand. */}
          {isHuman && remoteApi?.fetchRivalProfile && (
            <RivalProfile carrier={carrier} fetchRivalProfile={remoteApi.fetchRivalProfile} />
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', background: 'var(--surface2)' }}>
                <th style={{ textAlign: 'left',  padding: '6px 14px', fontWeight: 500 }}>Route</th>
                <th style={{ textAlign: 'right', padding: '6px 12px', fontWeight: 500 }}>Price</th>
                <th style={{ textAlign: 'right', padding: '6px 12px', fontWeight: 500 }}>vs ref</th>
                <th style={{ textAlign: 'right', padding: '6px 12px', fontWeight: 500 }}>Freq</th>
                <th style={{ textAlign: 'left', padding: '6px 12px', fontWeight: 500 }}>Aircraft</th>
                <th style={{ padding: '6px 14px' }} />
              </tr>
            </thead>
            <tbody>
              {routes.map(([key, cfg]) => {
                const [a, b] = key.split('-');
                const refP  = referencePrice(a, b);
                // Human rivals publish real fares (open book).
                const price = cfg.economyFare ?? Math.round(refP * cfg.priceMultiplier);
                const oCity = getAirport(a)?.city ?? a;
                const dCity = getAirport(b)?.city ?? b;
                const isShared = key in playerRouteMap;

                return (
                  <tr key={key} style={{
                    borderTop: '1px solid var(--border)',
                    background: isShared ? 'rgba(251,191,36,0.05)' : 'transparent',
                  }}>
                    <td style={{ padding: '7px 14px' }}>
                      <span style={{ fontWeight: 600 }}><AirportLink code={a} />–<AirportLink code={b} /></span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>
                        {oCity}–{dCity}
                      </span>
                      {isShared && (
                        <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--yellow)', fontWeight: 600 }}>
                          <Glyph e="⚔" /> contested
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', padding: '7px 12px', fontWeight: 700 }}>
                      <span style={{ color: priceColor(cfg.priceMultiplier) }}>${price}</span>
                    </td>
                    <td style={{ textAlign: 'right', padding: '7px 12px', color: 'var(--text-muted)' }}>
                      {Math.round(cfg.priceMultiplier * 100)}%
                    </td>
                    <td style={{ textAlign: 'right', padding: '7px 12px' }}>{cfg.frequency}×/wk</td>
                    <td style={{ padding: '7px 12px', color: 'var(--text-muted)', fontSize: 11 }}>
                      {cfg.aircraftType
                        ? `${cfg.tails ?? 1}× ${getAircraftType(cfg.aircraftType)?.name ?? cfg.aircraftType}`
                        : '—'}
                    </td>
                    <td style={{ padding: '7px 14px' }} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Rival profile (multiplayer) ──────────────────────────────────────────────
// A human rival's PUBLIC profile, fetched from the server on expand: fleet
// composition, hubs, rank history and recent visible moves. The route table
// below it comes from state.competitors as usual.

const MOVE_LABELS = {
  ADD_ROUTE:           (p) => `Opened route ${p.origin ?? '?'}–${p.destination ?? '?'}`,
  CLOSE_ROUTE:         (p) => `Closed route ${p.origin ?? '?'}–${p.destination ?? '?'}`,
  ADD_CARGO_ROUTE:     (p) => `Opened cargo lane ${p.origin ?? '?'}–${p.destination ?? '?'}`,
  CLOSE_CARGO_ROUTE:   (p) => `Closed cargo lane ${p.origin ?? '?'}–${p.destination ?? '?'}`,
  LEASE_AIRCRAFT:      (p) => `Leased ${p.typeId ?? 'an aircraft'}`,
  BUY_AIRCRAFT:        (p) => `Bought ${p.typeId ?? 'an aircraft'}`,
  ORDER_AIRCRAFT:      (p) => `Ordered ${p.typeId ?? 'an aircraft'}`,
  SELL_AIRCRAFT:       () => 'Sold an aircraft',
  RETIRE_AIRCRAFT:     () => 'Retired an aircraft',
  ADD_GATE:            (p) => `Added a gate${p.airportCode ? ` at ${p.airportCode}` : ''}`,
  UPGRADE_HUB:         (p) => `Upgraded hub${p.airportCode ? ` ${p.airportCode}` : ''}`,
  DESIGNATE_HUB:       (p) => `Designated ${p.airportCode ?? 'a'} hub`,
  DESIGNATE_FOCUS_CITY:(p) => `Designated ${p.airportCode ?? 'a'} focus city`,
  JOIN_ALLIANCE:       () => 'Joined an alliance',
  LEAVE_ALLIANCE:      () => 'Left an alliance',
};

function describeMove(m) {
  const fn = MOVE_LABELS[m.type];
  return fn ? fn(m.payload ?? {}) : m.type;
}

function RivalProfile({ carrier, fetchRivalProfile }) {
  const [profile, setProfile] = useState(null);
  const [failed, setFailed] = useState(false);
  const airlineId = carrier.id.startsWith('human:') ? carrier.id.slice('human:'.length) : carrier.id;

  useEffect(() => {
    let alive = true;
    setProfile(null); setFailed(false);
    fetchRivalProfile(airlineId)
      .then((p) => { if (alive) setProfile(p); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [airlineId, fetchRivalProfile]);

  if (failed) return null; // the route table below still works from local state
  if (!profile) {
    return (
      <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
        Loading profile…
      </div>
    );
  }

  const fleetEntries = Object.entries(profile.fleetByType ?? {});
  const ranks = (profile.rankHistory ?? []).map((r) => r.rank);
  const moves = profile.recentMoves ?? [];

  return (
    <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)',
                  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
      {/* Fleet + hubs */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          Fleet {fleetEntries.length > 0 && `(${fleetEntries.reduce((s, [, n]) => s + n, 0)} aircraft)`}
        </div>
        {fleetEntries.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No aircraft yet</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {fleetEntries.map(([typeId, n]) => (
              <span key={typeId} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10,
                                          background: 'var(--surface2)', color: 'var(--text)' }}>
                {n}× {getAircraftType(typeId)?.name ?? typeId}
              </span>
            ))}
          </div>
        )}
        {(profile.hubs ?? []).length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Hubs: {profile.hubs.map((h, i) => (
              <span key={h}>{i > 0 && ', '}<AirportLink code={h} /></span>
            ))}
          </div>
        )}
        {ranks.length >= 2 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            Rank trend:
            <RankSparkline ranks={ranks} />
            <span style={{ fontWeight: 700, color: 'var(--text)' }}>#{ranks[ranks.length - 1]}</span>
          </div>
        )}
      </div>

      {/* Recent public moves */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          Recent moves
        </div>
        {moves.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No public moves yet</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {moves.slice(0, 8).map((m, i) => (
              <div key={i} style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {m.week != null && <span style={{ color: 'var(--text-dim)', marginRight: 6 }}>W{m.week}</span>}
                {describeMove(m)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Rank over time — lower is better, so the y-axis is inverted.
function RankSparkline({ ranks, width = 90, height = 20 }) {
  const min = Math.min(...ranks), max = Math.max(...ranks);
  const span = Math.max(max - min, 1);
  const stepX = width / Math.max(ranks.length - 1, 1);
  const y = (r) => 2 + ((r - min) / span) * (height - 4);
  const points = ranks.map((r, i) => `${(i * stepX).toFixed(1)},${y(r).toFixed(1)}`).join(' ');
  const improving = ranks[ranks.length - 1] <= ranks[0];
  return (
    <svg width={width} height={height} aria-label="rank history">
      <polyline points={points} fill="none"
        stroke={improving ? 'var(--green)' : '#f87171'}
        strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ─── Rival detail view (multiplayer dossier) ──────────────────────────────────
// A dedicated, full-screen dossier for one human rival — opened by clicking them
// in the leaderboard or the Rival Networks list. Everything the "open book"
// model makes public, laid out to be read rather than squinted at:
//   • overview stat tiles (market cap, share price, cash, profit, quality…)
//   • financial trend + rank-over-time charts
//   • fleet breakdown by type (with total seats)
//   • the full route network with fares, frequency, seats and contested markers
//   • head-to-head vs YOU on every contested city pair
//   • a timeline of their recent public moves
// Private internals (loans, hedges, marketing spend) never appear.

function StatTile({ label, value, sub, color }) {
  return (
    <div style={{
      background: 'var(--surface2)', borderRadius: 8, padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 800, color: color ?? 'var(--text)', lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </div>
      {sub != null && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

function DetailSection({ title, right, children }) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {title}
        </div>
        {right && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{right}</div>}
      </div>
      {children}
    </div>
  );
}

// A single You-vs-Them comparison line inside the head-to-head block.
function VsRow({ label, you, them, youWins, fmt = (v) => v }) {
  const youColor = youWins === true ? 'var(--green)' : youWins === false ? 'var(--text)' : 'var(--text)';
  const themColor = youWins === false ? 'var(--green)' : 'var(--text)';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 8, fontSize: 12, padding: '3px 0' }}>
      <div style={{ textAlign: 'right', fontWeight: 700, color: youColor }}>{you == null ? '–' : fmt(you)}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'center', minWidth: 78 }}>{label}</div>
      <div style={{ textAlign: 'left', fontWeight: 700, color: themColor }}>{them == null ? '–' : fmt(them)}</div>
    </div>
  );
}

function RivalDetailView({ carrier, onClose }) {
  const { state, remoteApi } = useGame();
  const [profile, setProfile] = useState(null);
  const [failed, setFailed] = useState(false);
  const isHuman = carrier.human === true;
  const airlineId = carrier.id.startsWith('human:') ? carrier.id.slice('human:'.length) : carrier.id;

  useEffect(() => {
    if (!remoteApi?.fetchRivalProfile) { setFailed(true); return; }
    let alive = true;
    setProfile(null); setFailed(false);
    remoteApi.fetchRivalProfile(airlineId)
      .then((p) => { if (alive) setProfile(p); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [airlineId, remoteApi]);

  // Esc closes; lock body scroll while open.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  // ── Player-side inputs for head-to-head ──────────────────────────────────────
  const fleet = state.fleet ?? [];
  const playerRouteMap = {};
  for (const r of (state.routes ?? [])) {
    playerRouteMap[[r.origin, r.destination].sort().join('-')] = r;
  }
  const laborFx = laborEffects(
    state.labor ?? null,
    fleetAvgUtilization(fleet, [...(state.routes ?? []), ...(state.cargoRoutes ?? [])]),
    state.satisfaction ?? null,
  );

  // ── Rival data (carrier is instant; profile fills in fleet/rank/moves) ────────
  const routeEntries = Object.entries(carrier.routes ?? {}).sort((a, b) => {
    const ac = (a[0] in playerRouteMap) ? 0 : 1;
    const bc = (b[0] in playerRouteMap) ? 0 : 1;
    return ac - bc || a[0].localeCompare(b[0]);
  });
  const contestedEntries = routeEntries.filter(([k]) => k in playerRouteMap);

  const fleetByType = profile?.fleetByType ?? null;
  const fleetTotal = fleetByType ? Object.values(fleetByType).reduce((s, n) => s + n, 0) : null;
  const seatTotal = fleetByType
    ? Object.entries(fleetByType).reduce((s, [t, n]) => s + (getAircraftType(t)?.seats ?? 0) * n, 0)
    : null;
  const maxTypeCount = fleetByType ? Math.max(1, ...Object.values(fleetByType)) : 1;

  const ranks = (profile?.rankHistory ?? []).map((r) => r.rank);
  const currentRank = ranks.length ? ranks[ranks.length - 1] : null;
  const rankDelta = ranks.length >= 2 ? ranks[0] - ranks[ranks.length - 1] : null; // + = climbed

  const alliance = carrier.allianceId ? (carrier.allianceName ?? profile?.alliance ?? 'Alliance') : (profile?.alliance ?? null);
  const hubs = profile?.hubs?.length ? profile.hubs : (carrier.homeHub ? [carrier.homeHub] : []);
  const wp = carrier.weeklyStats?.weeklyProfit ?? null;
  const wr = carrier.weeklyStats?.weeklyRevenue ?? null;
  const profitHistory = carrier.profitHistory ?? [];
  const moves = profile?.recentMoves ?? [];

  const money = (v) => (v == null ? '–' : formatMoney(v));

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.62)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 16px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: '100%', maxWidth: 880, maxHeight: '92vh', padding: 0,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* ── Sticky header ─────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px',
          borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <AirlineLogo id={carrier.logoId} size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 800, fontSize: 18 }}>{carrier.name}</span>
              {isHuman && (
                <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 99,
                               background: 'var(--accent-dim, var(--surface2))', color: 'var(--accent)', fontWeight: 700 }}>
                  PLAYER
                </span>
              )}
              {currentRank != null && (
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                  Rank #{currentRank}
                  {rankDelta != null && rankDelta !== 0 && (
                    <span style={{ color: rankDelta > 0 ? 'var(--green)' : '#f87171', marginLeft: 4 }}>
                      {rankDelta > 0 ? `▲${rankDelta}` : `▼${-rankDelta}`}
                    </span>
                  )}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <span>Hub {hubs.length ? hubs.map((h, i) => (
                <span key={h}>{i > 0 && ', '}<AirportLink code={h} style={{ color: 'var(--text-muted)' }} /></span>
              )) : '—'}</span>
              {alliance && (
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                  <GlyphLabel size={12} text={`🤝 ${alliance}`} />
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)',
              borderRadius: 8, width: 32, height: 32, cursor: 'pointer', fontSize: 16, lineHeight: 1, flexShrink: 0,
            }}
          >×</button>
        </div>

        {/* ── Scrollable body ───────────────────────────────────────────────── */}
        <div style={{ padding: '16px 18px 22px', overflowY: 'auto' }}>
          {/* Overview tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
            <StatTile label="Market cap" value={money(carrier.marketCap)} />
            <StatTile label="Share price" value={carrier.sharePrice != null ? `$${carrier.sharePrice.toFixed(2)}` : '–'} />
            <StatTile label="Cash" value={money(carrier.cash)} color={carrier.cash != null && carrier.cash < 0 ? '#f87171' : undefined} />
            <StatTile label="Weekly profit" value={wp == null ? '–' : `${wp >= 0 ? '+' : ''}${formatMoney(wp)}`}
              color={wp == null ? undefined : wp >= 0 ? 'var(--green)' : '#f87171'} />
            <StatTile label="Weekly revenue" value={money(wr)} />
            <StatTile label="Quality" value={`${carrier.baseQualityScore}/100`} color={qualityColor(carrier.baseQualityScore)} />
            <StatTile label="Routes" value={routeEntries.length} sub={contestedEntries.length ? `${contestedEntries.length} vs you` : undefined} />
            <StatTile label="Fleet" value={fleetTotal == null ? '…' : fleetTotal} sub={seatTotal ? `${seatTotal.toLocaleString()} seats` : undefined} />
          </div>

          {/* Trends */}
          <DetailSection title="Financial & rank trends">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
              <div className="card" style={{ padding: '12px 14px', background: 'var(--surface2)' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Weekly profit — last {profitHistory.length || 0} wks</div>
                {profitHistory.length >= 2 ? (
                  <ProfitSparkline history={profitHistory} width={220} height={54} />
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>Not enough history yet</div>
                )}
              </div>
              <div className="card" style={{ padding: '12px 14px', background: 'var(--surface2)' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  Rank over time {currentRank != null && <span style={{ color: 'var(--text)', fontWeight: 700 }}>· now #{currentRank}</span>}
                </div>
                {ranks.length >= 2 ? (
                  <RankSparkline ranks={ranks} width={220} height={54} />
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    {failed ? 'Rank history unavailable' : profile ? 'Not enough history yet' : 'Loading…'}
                  </div>
                )}
              </div>
            </div>
          </DetailSection>

          {/* Fleet breakdown */}
          <DetailSection
            title="Fleet"
            right={fleetTotal != null ? `${fleetTotal} aircraft${seatTotal ? ` · ${seatTotal.toLocaleString()} seats` : ''}` : null}
          >
            {fleetByType == null ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                {failed ? 'Fleet composition unavailable' : 'Loading fleet…'}
              </div>
            ) : fleetTotal === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No aircraft yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {Object.entries(fleetByType).sort((a, b) => b[1] - a[1]).map(([typeId, n]) => {
                  const t = getAircraftType(typeId);
                  return (
                    <div key={typeId} style={{ display: 'grid', gridTemplateColumns: '1fr 46px', alignItems: 'center', gap: 10, fontSize: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontWeight: 600 }}>{t?.name ?? typeId}</span>
                        {t?.seats != null && <span style={{ color: 'var(--text-muted)' }}> · {t.seats} seats</span>}
                        <div style={{ marginTop: 3, height: 4, background: 'var(--surface2)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${(n / maxTypeCount) * 100}%`, background: 'var(--accent)', borderRadius: 2 }} />
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', fontWeight: 700 }}>{n}×</div>
                    </div>
                  );
                })}
              </div>
            )}
          </DetailSection>

          {/* Route network */}
          <DetailSection
            title="Route network"
            right={`${routeEntries.length} route${routeEntries.length === 1 ? '' : 's'}${contestedEntries.length ? ` · ${contestedEntries.length} contested` : ''}`}
          >
            {routeEntries.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No routes open yet.</div>
            ) : (
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--text-muted)', background: 'var(--surface2)' }}>
                      <th style={{ textAlign: 'left', padding: '7px 12px', fontWeight: 500 }}>Route</th>
                      <th style={{ textAlign: 'right', padding: '7px 12px', fontWeight: 500 }}>Fare</th>
                      <th style={{ textAlign: 'right', padding: '7px 12px', fontWeight: 500 }}>vs ref</th>
                      <th style={{ textAlign: 'right', padding: '7px 12px', fontWeight: 500 }}>Freq</th>
                      <th style={{ textAlign: 'right', padding: '7px 12px', fontWeight: 500 }}>Seats/wk</th>
                      <th style={{ textAlign: 'left', padding: '7px 12px', fontWeight: 500 }}>Aircraft</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routeEntries.map(([key, cfg]) => {
                      const [a, b] = key.split('-');
                      const refP = referencePrice(a, b);
                      const price = cfg.economyFare ?? Math.round(refP * (cfg.priceMultiplier ?? 1));
                      const ratio = refP ? price / refP : 1;
                      const seatsWk = cfg.seats != null ? cfg.seats * (cfg.frequency ?? 0) : null;
                      const isShared = key in playerRouteMap;
                      return (
                        <tr key={key} style={{ borderTop: '1px solid var(--border)', background: isShared ? 'rgba(251,191,36,0.06)' : 'transparent' }}>
                          <td style={{ padding: '7px 12px' }}>
                            <span style={{ fontWeight: 600 }}><AirportLink code={a} />–<AirportLink code={b} /></span>
                            {isShared && (
                              <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--yellow)', fontWeight: 700 }}>
                                <Glyph e="⚔" /> contested
                              </span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', padding: '7px 12px', fontWeight: 700, color: ratio < 0.95 ? 'var(--green)' : ratio > 1.2 ? '#f87171' : 'var(--text)' }}>${price}</td>
                          <td style={{ textAlign: 'right', padding: '7px 12px', color: 'var(--text-muted)' }}>{Math.round(ratio * 100)}%</td>
                          <td style={{ textAlign: 'right', padding: '7px 12px' }}>{cfg.frequency ?? 0}×</td>
                          <td style={{ textAlign: 'right', padding: '7px 12px', color: 'var(--text-muted)' }}>{seatsWk != null ? seatsWk.toLocaleString() : '–'}</td>
                          <td style={{ padding: '7px 12px', color: 'var(--text-muted)' }}>
                            {cfg.aircraftType ? (getAircraftType(cfg.aircraftType)?.name ?? cfg.aircraftType) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </DetailSection>

          {/* Head-to-head on contested routes */}
          {contestedEntries.length > 0 && (
            <DetailSection title="Head-to-head — contested routes" right="you vs them">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {contestedEntries.map(([key, cfg]) => {
                  const [a, b] = key.split('-');
                  const refP = referencePrice(a, b);
                  const pr = playerRouteMap[key];
                  const theirFare = cfg.economyFare ?? Math.round(refP * (cfg.priceMultiplier ?? 1));
                  const yourFare = pr.ticketPrice;
                  const yourQual = playerQuality(pr, fleet, laborFx);
                  const theirQual = carrier.baseQualityScore;
                  const yourFreq = pr.weeklyFrequency ?? 0;
                  const theirFreq = cfg.frequency ?? 0;
                  const yourAc = fleet.find((x) => x.id === pr.aircraftId);
                  const yourSeatsWk = yourAc ? (getAircraftType(yourAc.typeId)?.seats ?? 0) * yourFreq : null;
                  const theirSeatsWk = cfg.seats != null ? cfg.seats * theirFreq : null;
                  // Simple "who's ahead" tally across the four levers.
                  let youPts = 0, themPts = 0;
                  if (yourFare < theirFare) youPts++; else if (theirFare < yourFare) themPts++;
                  if (yourQual != null && (yourQual > theirQual)) youPts++; else if (yourQual != null && theirQual > yourQual) themPts++;
                  if (yourFreq > theirFreq) youPts++; else if (theirFreq > yourFreq) themPts++;
                  if (yourSeatsWk != null && theirSeatsWk != null) {
                    if (yourSeatsWk > theirSeatsWk) youPts++; else if (theirSeatsWk > yourSeatsWk) themPts++;
                  }
                  const verdict = youPts > themPts ? { t: 'You lead', c: 'var(--green)' }
                    : themPts > youPts ? { t: `${carrier.name} leads`, c: '#f87171' }
                    : { t: 'Even', c: 'var(--text-muted)' };
                  return (
                    <div key={key} className="card" style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}><AirportLink code={a} /> → <AirportLink code={b} /></span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: verdict.c }}>{verdict.t}</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>
                        <div style={{ textAlign: 'right', fontWeight: 700, color: '#60a5fa' }}>You</div>
                        <div style={{ minWidth: 78 }} />
                        <div style={{ textAlign: 'left', fontWeight: 700, color: 'var(--text)' }}>{carrier.name}</div>
                      </div>
                      <VsRow label="Fare" you={yourFare} them={theirFare} youWins={yourFare < theirFare ? true : theirFare < yourFare ? false : null} fmt={(v) => `$${v}`} />
                      <VsRow label="Quality" you={yourQual} them={theirQual} youWins={yourQual == null ? null : yourQual > theirQual ? true : theirQual > yourQual ? false : null} />
                      <VsRow label="Flights/wk" you={yourFreq} them={theirFreq} youWins={yourFreq > theirFreq ? true : theirFreq > yourFreq ? false : null} fmt={(v) => `${v}×`} />
                      <VsRow label="Seats/wk" you={yourSeatsWk} them={theirSeatsWk} youWins={(yourSeatsWk == null || theirSeatsWk == null) ? null : yourSeatsWk > theirSeatsWk ? true : theirSeatsWk > yourSeatsWk ? false : null} fmt={(v) => v.toLocaleString()} />
                    </div>
                  );
                })}
              </div>
            </DetailSection>
          )}

          {/* Recent public moves */}
          <DetailSection title="Recent moves">
            {moves.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                {failed ? 'Move history unavailable' : profile ? 'No public moves yet' : 'Loading…'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {moves.map((m, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--text)', display: 'flex', gap: 8 }}>
                    {m.week != null && <span style={{ color: 'var(--text-muted)', fontWeight: 700, minWidth: 34 }}>W{m.week}</span>}
                    <span style={{ color: 'var(--text-muted)' }}>{describeMove(m)}</span>
                  </div>
                ))}
              </div>
            )}
          </DetailSection>
        </div>
      </div>
    </div>
  );
}

// ─── Acquisition modal ────────────────────────────────────────────────────────

function AcquisitionModal({ target, playerCash, onConfirm, onCancel }) {
  const premium         = target.fireSale ? FIRE_SALE_PREMIUM : ACQUISITION_PREMIUM;
  const acquisitionCost = Math.round((target.marketCap ?? 0) * premium);
  const netCost         = acquisitionCost - (target.cash ?? 0);
  const canAfford       = playerCash >= acquisitionCost;
  const routeCount      = Object.keys(target.routes ?? {}).length;
  const tier            = TIER_META[target.tier] ?? { label: target.tier, color: 'var(--text-muted)' };

  // Preview the fleet + gates that transfer with the airline.
  const slotsByAirport = {};
  Object.entries(target.routes ?? {}).forEach(([key, cfg]) => {
    const [a, b] = key.split('-');
    const f = cfg.frequency ?? 7;
    slotsByAirport[a] = (slotsByAirport[a] ?? 0) + f;
    slotsByAirport[b] = (slotsByAirport[b] ?? 0) + f;
  });
  const gatesGained    = Object.values(slotsByAirport)
    .reduce((s, sl) => s + Math.max(1, Math.ceil(sl / SLOTS_PER_GATE)), 0);
  const aircraftGained = (target.fleet ?? []).length;  // the carrier's real fleet

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
    }}>
      <div className="card" style={{ width: '100%', maxWidth: 420, padding: '24px 24px 20px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <AirlineLogo id={target.logoId} size={44} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>{target.name}</div>
            <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 99, background: 'var(--surface2)', color: tier.color, fontWeight: 600 }}>
              {tier.label}
            </span>
          </div>
        </div>

        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Acquisition Summary</div>

        {/* Deal breakdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, marginBottom: 16 }}>
          <DealRow label="Market cap" value={formatMoney(target.marketCap ?? 0)} />
          <DealRow
            label={target.fireSale
              ? `Fire-sale discount (${Math.round((1 - premium) * 100)}%)`
              : `Acquisition premium (${Math.round((premium - 1) * 100)}%)`}
            value={`${premium >= 1 ? '+' : '−'}${formatMoney(Math.abs(Math.round((target.marketCap ?? 0) * (premium - 1))))}`}
            color={target.fireSale ? 'var(--green)' : 'var(--yellow)'} />
          <DealRow label="Total acquisition cost" value={formatMoney(acquisitionCost)} bold />
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
          <DealRow label="You receive — their cash" value={`+${formatMoney(target.cash ?? 0)}`} color="var(--green)" />
          <DealRow label="You receive — routes" value={`+${routeCount}`} color="var(--green)" />
          <DealRow label="You receive — aircraft" value={`+${aircraftGained}`} color="var(--green)" />
          <DealRow label="You receive — gate slots" value={`+${gatesGained}`} color="var(--green)" />
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
          <DealRow label="Net cash outlay" value={formatMoney(netCost)} bold color={netCost > 0 ? '#f87171' : 'var(--green)'} />
          <DealRow label="Your cash after" value={formatMoney(playerCash - acquisitionCost + (target.cash ?? 0))}
                   color={(playerCash - acquisitionCost + (target.cash ?? 0)) >= 0 ? 'var(--text)' : '#f87171'} />
        </div>

        {/* Routes you'll absorb */}
        {routeCount > 0 && (
          <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 12px', marginBottom: 16, fontSize: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-muted)' }}>Routes to absorb (fleet & gates come with them)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {Object.keys(target.routes).slice(0, 12).map(key => {
                const [a, b] = key.split('-');
                return (
                  <span key={key} style={{ background: 'var(--surface)', padding: '2px 7px', borderRadius: 4, fontWeight: 600 }}>
                    {a}–{b}
                  </span>
                );
              })}
              {routeCount > 12 && (
                <span style={{ color: 'var(--text-muted)', padding: '2px 4px' }}>+{routeCount - 12} more</span>
              )}
            </div>
          </div>
        )}

        {!canAfford && (
          <div style={{ color: '#f87171', fontSize: 12, marginBottom: 12, padding: '8px 10px', background: 'rgba(248,113,113,0.1)', borderRadius: 6 }}>
            You need {formatMoney(acquisitionCost - playerCash)} more to complete this acquisition.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1, padding: '9px 0', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer',
              background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canAfford}
            style={{
              flex: 2, padding: '9px 0', borderRadius: 8, fontWeight: 700, fontSize: 13,
              cursor: canAfford ? 'pointer' : 'not-allowed',
              background: canAfford ? 'var(--green)' : 'var(--surface2)',
              border: 'none', color: canAfford ? '#fff' : 'var(--text-muted)',
            }}
          >
            {canAfford ? `Acquire for ${formatMoney(acquisitionCost)}` : 'Insufficient funds'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DealRow({ label, value, bold, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: bold ? 700 : 500, color: color ?? 'var(--text)' }}>{value}</span>
    </div>
  );
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

function qualityColor(score) {
  if (score >= 70) return 'var(--green)';
  if (score >= 45) return 'var(--yellow)';
  return '#f87171';
}

function priceColor(multiplier) {
  if (multiplier < 0.90) return 'var(--green)';
  if (multiplier > 1.25) return '#a78bfa';
  return 'var(--text)';
}
