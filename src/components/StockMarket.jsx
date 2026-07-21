// Stocks — the airline stock market.
// ----------------------------------------------------------------------------
// Every airline in the market (solo: AI carriers; multiplayer: the other human
// players) is listed at its authoritative weekly price. Buy low, watch rivals'
// fundamentals, sell high — or ride a collapse down. Prices move once per week
// on the tick; trades execute instantly at the current price with a 1% spread
// and 0.5% commission each way (churn is intentionally lossy).
//
// All economics live in the engine (BUY_STOCK / SELL_STOCK reducer cases +
// STOCK_MARKET constants). This component only renders state and dispatches
// intents; in multiplayer the server re-runs the same reducer authoritatively.
import { useMemo, useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { formatMoney } from '../utils/simulation.js';
import { STOCK_MARKET, TOTAL_SHARES } from '../utils/market.js';
import AirlineLogo from './AirlineLogo.jsx';
import { OgChip, DevChip } from './Competition.jsx';
import { GlyphLabel } from './Icons.jsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtPrice = (p) => (p == null || !Number.isFinite(p)) ? '—'
  : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;

const fmtShares = (n) => (n ?? 0).toLocaleString();

const fmtSigned = (v) => `${v >= 0 ? '+' : '−'}${formatMoney(Math.abs(Math.round(v)))}`;

function priceOf(c) {
  const p = c?.sharePrice ?? (c?.marketCap != null ? c.marketCap / TOTAL_SHARES : null);
  return Number.isFinite(p) && p > 0 ? p : null;
}

function historyOf(c) {
  const h = (c?.sharePriceHistory ?? c?.priceHistory ?? []).filter((v) => Number.isFinite(v) && v > 0);
  return h;
}

/** Weekly move %: last two points of the price series (null with <2 points). */
function weeklyMove(c) {
  const h = historyOf(c);
  if (h.length < 2) return null;
  const prev = h[h.length - 2];
  return prev > 0 ? (h[h.length - 1] - prev) / prev : null;
}

// Price sparkline — teal line, first-point-indexed, no axes (trend at a glance).
function PriceSparkline({ history, width = 84, height = 26 }) {
  const h = (history ?? []).filter((v) => Number.isFinite(v) && v > 0);
  if (h.length < 2) {
    return <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>new listing</span>;
  }
  const min = Math.min(...h), max = Math.max(...h);
  const span = Math.max(max - min, max * 0.001, 1e-9);
  const stepX = width / (h.length - 1);
  const y = (v) => 2 + (height - 4) * (1 - (v - min) / span);
  const points = h.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const up = h[h.length - 1] >= h[0];
  return (
    <svg width={width} height={height} style={{ flexShrink: 0, display: 'block' }} aria-label="price trend">
      <polyline points={points} fill="none" stroke={up ? 'var(--green)' : '#f87171'}
        strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ─── Trade ticket ─────────────────────────────────────────────────────────────

function TradeModal({ carrier, side, state, onSubmit, onClose }) {
  const S          = STOCK_MARKET;
  const price      = priceOf(carrier);
  const portfolio  = state.portfolio ?? { holdings: {}, realizedPnL: 0 };
  const held       = portfolio.holdings?.[carrier.id];
  const heldShares = held?.shares ?? 0;
  const [sharesStr, setSharesStr] = useState('');
  const shares = Math.max(0, Math.floor(Number(sharesStr) || 0));

  const isBuy      = side === 'buy';
  const execPrice  = price == null ? null : price * (isBuy ? 1 + S.SPREAD_HALF : 1 - S.SPREAD_HALF);
  const gross      = execPrice == null ? 0 : Math.round(shares * execPrice);
  const commission = Math.round(gross * S.COMMISSION);
  const total      = isBuy ? gross + commission : gross - commission;

  // Mirror the engine's checks so the button explains itself (the reducer —
  // and in multiplayer the server — re-validates everything regardless).
  const basisTotal = Object.values(portfolio.holdings ?? {}).reduce((s, h) => s + (h?.costBasis ?? 0), 0);
  const ownCapBudget = S.MAX_PORTFOLIO_PCT_OF_CAP * (state.marketCap ?? 0);
  let blocked = null;
  if (price == null)                        blocked = 'No price for this airline yet.';
  else if (shares <= 0)                     blocked = null; // nothing entered yet
  else if (isBuy && gross < S.MIN_TICKET)   blocked = `Minimum trade is ${formatMoney(S.MIN_TICKET)}.`;
  else if (isBuy && heldShares + shares > S.MAX_OWNERSHIP_PCT * TOTAL_SHARES)
    blocked = `You can own at most ${Math.round(S.MAX_OWNERSHIP_PCT * 100)}% of an airline (${fmtShares(S.MAX_OWNERSHIP_PCT * TOTAL_SHARES)} shares).`;
  else if (isBuy && basisTotal + total > ownCapBudget)
    blocked = `Portfolio limit: your total invested cost can't exceed ${Math.round(S.MAX_PORTFOLIO_PCT_OF_CAP * 100)}% of your own market cap (${formatMoney(ownCapBudget)}).`;
  else if (isBuy && total > state.cash)     blocked = 'Not enough cash.';
  else if (!isBuy && shares > heldShares)   blocked = `You only hold ${fmtShares(heldShares)} shares.`;

  const ready = shares > 0 && !blocked;

  // Quick-fill helpers
  const maxBuyable = (() => {
    if (price == null) return 0;
    const byCash  = Math.floor((state.cash * 0.999) / (price * (1 + S.SPREAD_HALF) * (1 + S.COMMISSION)));
    const byOwn   = Math.floor(S.MAX_OWNERSHIP_PCT * TOTAL_SHARES - heldShares);
    const byLimit = Math.floor(Math.max(0, ownCapBudget - basisTotal) / (price * (1 + S.SPREAD_HALF) * (1 + S.COMMISSION)));
    return Math.max(0, Math.min(byCash, byOwn, byLimit));
  })();

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
      alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)',
    }} onClick={onClose}>
      <div className="card" style={{ width: 'min(440px, 92vw)', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <AirlineLogo id={carrier.logoId} size={32} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {isBuy ? 'Buy' : 'Sell'} {carrier.name}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Market price {fmtPrice(price)} · you hold {fmtShares(heldShares)} shares
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Shares</label>
        <div style={{ display: 'flex', gap: 8, margin: '4px 0 10px' }}>
          <input
            type="number" min="0" step="1" value={sharesStr} autoFocus
            onChange={(e) => setSharesStr(e.target.value)}
            placeholder="0"
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 14,
              background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)',
            }}
          />
          {isBuy
            ? <button className="btn" onClick={() => setSharesStr(String(maxBuyable))}>Max</button>
            : <button className="btn" onClick={() => setSharesStr(String(heldShares))}>All</button>}
        </div>

        <div style={{ fontSize: 12.5, display: 'grid', gap: 4, marginBottom: 12 }}>
          <Row label={`Execution (${isBuy ? '+' : '−'}${(S.SPREAD_HALF * 100).toFixed(0)}% spread)`} value={fmtPrice(execPrice)} />
          <Row label="Gross" value={formatMoney(gross)} />
          <Row label={`Commission (${(S.COMMISSION * 100).toFixed(1)}%)`} value={formatMoney(commission)} />
          <Row label={isBuy ? 'Total cost' : 'Net proceeds'} value={formatMoney(Math.max(0, total))} strong />
          {!isBuy && heldShares > 0 && held?.costBasis != null && shares > 0 && (
            <Row label="Est. realized P&L" value={fmtSigned(total - (held.costBasis / heldShares) * shares)} />
          )}
        </div>

        {blocked && shares > 0 && (
          <div style={{
            fontSize: 12, color: 'var(--yellow)', background: 'rgba(232,182,76,0.08)',
            border: '1px solid rgba(232,182,76,0.3)', borderRadius: 8, padding: '7px 10px', marginBottom: 10,
          }}>{blocked}</div>
        )}

        <button
          className="btn btn-primary" disabled={!ready} style={{ width: '100%' }}
          onClick={() => { onSubmit(shares); onClose(); }}
        >
          {isBuy ? `Buy ${shares > 0 ? fmtShares(shares) + ' shares' : 'shares'}` : `Sell ${shares > 0 ? fmtShares(shares) + ' shares' : 'shares'}`}
        </button>
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
          Prices update once per week. Round trip costs ≈3% in spread + commission, so
          trading pays only when you're right about where a rival is headed.
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, strong = false }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: strong ? 700 : 500 }}>{value}</span>
    </div>
  );
}

// ─── Portfolio summary ────────────────────────────────────────────────────────

function PortfolioSummary({ state, listed }) {
  const portfolio = state.portfolio ?? { holdings: {}, realizedPnL: 0, lastValuation: 0 };
  const holdings  = Object.entries(portfolio.holdings ?? {}).filter(([, h]) => h?.shares > 0);

  // Live value: current listed prices where available, else last marked price.
  const byId = new Map(listed.map((c) => [c.id, c]));
  let value = 0, basis = 0;
  for (const [id, h] of holdings) {
    const p = priceOf(byId.get(id)) ?? h.lastPrice ?? 0;
    value += h.shares * p;
    basis += h.costBasis ?? 0;
  }
  const unrealized = value - basis;

  return (
    <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 28px', alignItems: 'baseline' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Portfolio value</div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{formatMoney(Math.round(value))}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Cost basis</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{formatMoney(Math.round(basis))}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Unrealized P&L</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: unrealized >= 0 ? 'var(--green)' : '#f87171' }}>
            {holdings.length ? fmtSigned(unrealized) : '—'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Realized P&L (lifetime)</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: (portfolio.realizedPnL ?? 0) >= 0 ? 'var(--green)' : '#f87171' }}>
            {fmtSigned(portfolio.realizedPnL ?? 0)}
          </div>
        </div>
      </div>
      {holdings.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          You don't own stock in any rival yet. Buy into an airline below. Its price follows
          its real performance, so back the operators you believe in (or the recoveries
          everyone else has written off).
        </div>
      )}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

const SORTS = {
  cap:    { label: 'Market cap',  fn: (a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0) },
  move:   { label: 'Weekly move', fn: (a, b) => (weeklyMove(b) ?? -Infinity) - (weeklyMove(a) ?? -Infinity) },
  price:  { label: 'Price',       fn: (a, b) => (priceOf(b) ?? 0) - (priceOf(a) ?? 0) },
  name:   { label: 'Name',        fn: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
};

export default function StockMarket() {
  const { state, dispatch, remote } = useGame();
  const [sortKey, setSortKey] = useState('cap');
  const [ticket, setTicket]   = useState(null);   // { carrier, side }

  const portfolio = state.portfolio ?? { holdings: {}, realizedPnL: 0 };
  const listed = useMemo(
    () => [...(state.competitors ?? [])].sort(SORTS[sortKey].fn),
    [state.competitors, sortKey],
  );

  // Own airline — shown pinned at top of the list (not tradeable: no buying
  // your own stock; your price is your scoreboard).
  const ownHistory = (state.statsHistory ?? []).map((e) => e.sharePrice).filter((v) => Number.isFinite(v) && v > 0);

  return (
    <div>
      <PortfolioSummary state={state} listed={listed} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{
          fontWeight: 700, fontSize: 13, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1,
        }}>
          Listed airlines
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {Object.entries(SORTS).map(([k, s]) => (
            <button
              key={k}
              className="btn btn-ghost"
              style={{
                fontSize: 11.5, padding: '3px 10px',
                color: sortKey === k ? 'var(--accent)' : 'var(--text-muted)',
                borderColor: sortKey === k ? 'var(--accent)' : 'var(--border)',
              }}
              onClick={() => setSortKey(k)}
            >{s.label}</button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 640 }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <th style={{ textAlign: 'left',  padding: '10px 14px' }}>Airline</th>
              <th style={{ textAlign: 'right', padding: '10px 8px'  }}>Price</th>
              <th style={{ textAlign: 'right', padding: '10px 8px'  }}>Wk Δ</th>
              <th style={{ textAlign: 'center', padding: '10px 8px' }}>26 wks</th>
              <th style={{ textAlign: 'right', padding: '10px 8px'  }}>Market cap</th>
              <th style={{ textAlign: 'right', padding: '10px 8px'  }}>Your stake</th>
              <th style={{ textAlign: 'right', padding: '10px 14px' }}></th>
            </tr>
          </thead>
          <tbody>
            {/* Your own airline, pinned — the benchmark row */}
            <tr style={{ borderTop: '1px solid var(--border)', background: 'rgba(56,201,180,0.05)' }}>
              <td style={{ padding: '9px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AirlineLogo id={state.logoId} size={24} />
                  <span style={{ fontWeight: 700 }}>{state.airlineName ?? 'Your airline'}</span>
                  <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>YOU</span>
                </div>
              </td>
              <td style={{ textAlign: 'right', padding: '9px 8px', fontWeight: 600 }}>{fmtPrice(state.sharePrice)}</td>
              <td style={{ textAlign: 'right', padding: '9px 8px' }}>
                <MovePct history={ownHistory} />
              </td>
              <td style={{ textAlign: 'center', padding: '9px 8px' }}>
                <div style={{ display: 'inline-block' }}><PriceSparkline history={ownHistory} /></div>
              </td>
              <td style={{ textAlign: 'right', padding: '9px 8px' }}>{formatMoney(Math.round(state.marketCap ?? 0))}</td>
              <td style={{ textAlign: 'right', padding: '9px 8px', color: 'var(--text-muted)', fontSize: 11 }}>—</td>
              <td style={{ textAlign: 'right', padding: '9px 14px', color: 'var(--text-muted)', fontSize: 11 }}>not tradeable</td>
            </tr>

            {listed.map((c) => {
              const price = priceOf(c);
              const held  = portfolio.holdings?.[c.id];
              const stakeValue = held?.shares > 0 && price != null ? held.shares * price : null;
              return (
                <tr key={c.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '9px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <AirlineLogo id={c.logoId} size={24} />
                      <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                      {c.og && <OgChip size={9} />}
                      {c.dev && <DevChip size={9} />}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', padding: '9px 8px', fontWeight: 600 }}>{fmtPrice(price)}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px' }}><MovePct history={historyOf(c)} /></td>
                  <td style={{ textAlign: 'center', padding: '9px 8px' }}>
                    <div style={{ display: 'inline-block' }}><PriceSparkline history={historyOf(c)} /></div>
                  </td>
                  <td style={{ textAlign: 'right', padding: '9px 8px' }}>{c.marketCap != null ? formatMoney(Math.round(c.marketCap)) : '—'}</td>
                  <td style={{ textAlign: 'right', padding: '9px 8px' }}>
                    {held?.shares > 0 ? (
                      <div>
                        <div style={{ fontWeight: 600 }}>{formatMoney(Math.round(stakeValue ?? 0))}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                          {fmtShares(held.shares)} sh · {((held.shares / TOTAL_SHARES) * 100).toFixed(1)}%
                        </div>
                      </div>
                    ) : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', padding: '9px 14px', whiteSpace: 'nowrap' }}>
                    <button className="btn" style={{ fontSize: 11.5, padding: '3px 10px', marginRight: 6 }}
                      disabled={price == null}
                      onClick={() => setTicket({ carrier: c, side: 'buy' })}>Buy</button>
                    <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 10px' }}
                      disabled={!(held?.shares > 0)}
                      onClick={() => setTicket({ carrier: c, side: 'sell' })}>Sell</button>
                  </td>
                </tr>
              );
            })}
            {listed.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                No tradeable rivals right now{remote ? '. Active players are listed here; bankrupt and abandoned airlines are delisted.' : '.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.6 }}>
        <GlyphLabel size={11} text={
          'ℹ Prices are set by each airline\'s fundamentals (profits, growth, cash, fleet and debt) and move once per weekly tick (max ±20% a week, plus a little market noise). '
          + 'You may own up to 20% of any one airline, and your total invested cost is capped at 40% of your own market cap. '
          + 'If an airline you hold shuts down or leaves the world, the position is force-liquidated at a haircut.'
        } />
      </div>

      {ticket && (
        <TradeModal
          carrier={ticket.carrier}
          side={ticket.side}
          state={state}
          onSubmit={(shares) => dispatch({
            type: ticket.side === 'buy' ? 'BUY_STOCK' : 'SELL_STOCK',
            targetId: ticket.carrier.id,
            shares,
          })}
          onClose={() => setTicket(null)}
        />
      )}
    </div>
  );
}

function MovePct({ history }) {
  const h = (history ?? []).filter((v) => Number.isFinite(v) && v > 0);
  if (h.length < 2) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const prev = h[h.length - 2];
  const move = prev > 0 ? (h[h.length - 1] - prev) / prev : null;
  if (move == null) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  return (
    <span style={{ fontWeight: 600, color: move >= 0 ? 'var(--green)' : '#f87171' }}>
      {move >= 0 ? '+' : ''}{(move * 100).toFixed(1)}%
    </span>
  );
}
