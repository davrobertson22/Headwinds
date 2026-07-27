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
import {
  STOCK_MARKET, sharesOf, svpsOf, freeFloatOf,
  CAPITAL, ipoDiscount, offeringDiscount, dividendPerShare,
} from '../utils/market.js';
import AirlineLogo from './AirlineLogo.jsx';
import { OgChip, DevChip } from './Competition.jsx';
import { GlyphLabel } from './Icons.jsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtPrice = (p) => (p == null || !Number.isFinite(p)) ? '—'
  : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(4)}`;

const fmtShares = (n) => (n ?? 0).toLocaleString();

const fmtSigned = (v) => `${v >= 0 ? '+' : '−'}${formatMoney(Math.abs(Math.round(v)))}`;

function priceOf(c) {
  const p = c?.sharePrice ?? (c?.marketCap != null ? c.marketCap / sharesOf(c) : null);
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
  // Float-pool visibility (multiplayer): how many of this carrier's shares the
  // market can actually sell you, and how much investor cash is left to absorb
  // a sale. Server-derived; absent in solo (no caps there).
  const poolShares = Number.isFinite(Number(carrier.poolShares)) ? Number(carrier.poolShares) : null;
  const pool       = state.stockPool ?? null;
  // The ownership cap is a share of THIS carrier's float, which issuance and
  // buybacks move — never a global constant.
  const targetShares = sharesOf(carrier);
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
  else if (carrier.isPublic === false)      blocked = `${carrier.name} is privately held — its shares aren't on the market yet.`;
  else if (shares <= 0)                     blocked = null; // nothing entered yet
  else if (isBuy && poolShares != null && poolShares <= 0)
    blocked = 'No shares available — other investors hold the entire float.';
  else if (isBuy && poolShares != null && shares > poolShares)
    blocked = `Only ${fmtShares(poolShares)} shares are available from other investors right now.`;
  else if (isBuy && gross < S.MIN_TICKET)   blocked = `Minimum trade is ${formatMoney(S.MIN_TICKET)}.`;
  else if (isBuy && heldShares + shares > S.MAX_OWNERSHIP_PCT * targetShares)
    blocked = `You can own at most ${Math.round(S.MAX_OWNERSHIP_PCT * 100)}% of an airline (${fmtShares(Math.floor(S.MAX_OWNERSHIP_PCT * targetShares))} shares).`;
  else if (isBuy && basisTotal + total > ownCapBudget)
    blocked = `Portfolio limit: your total invested cost can't exceed ${Math.round(S.MAX_PORTFOLIO_PCT_OF_CAP * 100)}% of your own market cap (${formatMoney(ownCapBudget)}).`;
  else if (isBuy && total > state.cash)     blocked = 'Not enough cash.';
  else if (!isBuy && shares > heldShares)   blocked = `You only hold ${fmtShares(heldShares)} shares.`;
  else if (!isBuy && pool && Number.isFinite(Number(pool.poolCash)) && gross > pool.poolCash)
    blocked = `The market can only absorb about ${formatMoney(pool.poolCash)} right now — try a smaller sale.`;

  const ready = shares > 0 && !blocked;

  // Quick-fill helpers
  const maxBuyable = (() => {
    if (price == null) return 0;
    const byCash  = Math.floor((state.cash * 0.999) / (price * (1 + S.SPREAD_HALF) * (1 + S.COMMISSION)));
    const byOwn   = Math.floor(S.MAX_OWNERSHIP_PCT * targetShares - heldShares);
    const byLimit = Math.floor(Math.max(0, ownCapBudget - basisTotal) / (price * (1 + S.SPREAD_HALF) * (1 + S.COMMISSION)));
    // The pool can't sell you shares it no longer holds — cap Max by what's
    // actually left, so a max-fill order can't come back rejected.
    const byPool  = poolShares != null ? poolShares : Infinity;
    return Math.max(0, Math.min(byCash, byOwn, byLimit, byPool));
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
              {isBuy && poolShares != null && <> · {fmtShares(poolShares)} available to buy</>}
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


// ─── Your company: the capital actions ────────────────────────────────────────
// The issuer side of the market. Market cap measures how BIG you got, which is why
// the leaderboard now ranks on SVPS (share price + lifetime dividends per share) —
// under that metric raising capital is dilutive rather than free score, and
// returning it is rank-neutral rather than self-harm. So all four of these are real
// decisions with real trade-offs.
//
// Every number here is recomputed by the engine (and, in multiplayer, by the server)
// before anything happens — this panel exists to explain the trade-off, not to
// enforce it.

const pct = (v) => `${(v * 100).toFixed(1)}%`;

function CapitalRow({ label, value, hint }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0' }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {label}
        {hint && <div style={{ fontSize: 10.5, opacity: 0.75 }}>{hint}</div>}
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 600, textAlign: 'right', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

function CapitalActions({ state, dispatch }) {
  const C = CAPITAL;
  const equity = state.equity ?? {};
  const isPublic = equity.isPublic !== false;
  const shares = sharesOf(state);
  const float = freeFloatOf(state);
  const price = state.sharePrice ?? 0;
  const history = state.financialHistory ?? [];
  const absWeek = ((state.year ?? 1) - 1) * 52 + (state.week ?? 1);

  const [issueStr, setIssueStr]   = useState('');
  const [buybackStr, setBuyStr]   = useState('');
  const [payoutStr, setPayoutStr] = useState(String(Math.round((equity.dividendPolicy ?? 0) * 100)));

  // ── IPO ────────────────────────────────────────────────────────────────────
  const recent = history.slice(-12);
  const profitableFrac = recent.length
    ? recent.filter((h) => (h.profit ?? 0) > 0).length / recent.length : 0;
  const ipoDisc = ipoDiscount(history.length, profitableFrac);
  const tooYoung = absWeek < C.IPO_MIN_ABS_WEEK;
  const noRecord = history.length < C.IPO_MIN_HISTORY_WEEKS;
  // Default offer: a quarter of the post-issue company, the middle of the band.
  const ipoShares = Math.round((shares * 0.25) / 0.75);
  const ipoProceeds = Math.round(ipoShares * price * (1 - ipoDisc));

  // ── Offering ──────────────────────────────────────────────────────────────
  const issuedThisYear = Number(equity.offeringsThisYear ?? 0);
  const issueAllowance = Math.max(0, Math.floor(C.OFFERING_MAX_PCT_PER_YEAR * shares) - issuedThisYear);
  const issueN = Math.max(0, Math.floor(Number(issueStr) || 0));
  const loyal = (equity.cumDividendsPerShare ?? 0) > 0 || (equity.buybacksEver ?? 0) > 0 ? 1 : 0;
  const issueDisc = offeringDiscount((issuedThisYear + issueN) / Math.max(1, shares), loyal);
  const issueProceeds = Math.round(issueN * price * (1 - issueDisc));

  // ── Buyback ───────────────────────────────────────────────────────────────
  const boughtThisYear = Number(equity.buybacksThisYear ?? 0);
  const buyAllowance = Math.max(0, Math.floor(C.BUYBACK_MAX_PCT_PER_YEAR * shares) - boughtThisYear);
  const buyN = Math.max(0, Math.floor(Number(buybackStr) || 0));
  const buyCost = Math.round(buyN * price * (1 + C.BUYBACK_PREMIUM));
  const weeklyCost = history.slice(-4).length
    ? history.slice(-4).reduce((sum, h) => sum + (h.totalCost ?? 0), 0) / history.slice(-4).length : 0;
  const coverNeeded = Math.round(weeklyCost * C.MIN_CASH_WEEKS_COVER);

  // ── Dividend ──────────────────────────────────────────────────────────────
  const payoutPct = Math.max(0, Math.min(100, Math.round(Number(payoutStr) || 0)));
  const payoutRatio = Math.min(C.DIVIDEND_MAX_PAYOUT, payoutPct / 100);
  const trailing = history.slice(-C.DIVIDEND_TRAILING_WEEKS).reduce((sum, h) => sum + (h.profit ?? 0), 0);
  const perShare = dividendPerShare(trailing, payoutRatio, shares);
  const quarterCost = Math.round(perShare * float);
  const yieldPct = price > 0 ? (perShare * 4) / price : 0;
  const weeksToPay = C.DIVIDEND_PERIOD_WEEKS - (absWeek % C.DIVIDEND_PERIOD_WEEKS);

  const box = {
    background: 'var(--surface-2, rgba(255,255,255,0.03))',
    border: '1px solid var(--border)', borderRadius: 10, padding: 12,
  };
  const input = {
    width: '100%', padding: '5px 8px', fontSize: 12, borderRadius: 6,
    border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>
        Your company
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10 }}>
        The board ranks airlines on <strong>shareholder value per share</strong> — your share
        price plus every dividend you have ever paid. Raising capital splits the pie; returning
        it does not cost you rank.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
        {/* Standing */}
        <div style={box}>
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Share register</div>
          <CapitalRow label="Status" value={isPublic ? 'Listed' : 'Private'} />
          <CapitalRow label="Shares outstanding" value={shares.toLocaleString()} />
          <CapitalRow label="Publicly held" value={`${float.toLocaleString()} (${pct(shares > 0 ? float / shares : 0)})`} />
          <CapitalRow label="Share price" value={fmtPrice(price)} />
          <CapitalRow
            label="Value per share"
            hint="price + lifetime dividends — the leaderboard metric"
            value={fmtPrice(svpsOf({ sharePrice: price, equity }))}
          />
          {!isPublic && (
            <div style={{ fontSize: 11, color: 'var(--amber, #f59e0b)', marginTop: 6 }}>
              Private airlines are not ranked in the standings.
            </div>
          )}
        </div>

        {/* IPO or offering */}
        {!isPublic ? (
          <div style={box}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Go public</div>
            <CapitalRow label="Shares offered" value={`${ipoShares.toLocaleString()} (25%)`} />
            <CapitalRow label="IPO discount" hint="a longer profitable record prices better" value={pct(ipoDisc)} />
            <CapitalRow label="Estimated proceeds" value={formatMoney(ipoProceeds)} />
            <button
              className="btn btn-primary"
              style={{ width: '100%', marginTop: 8, fontSize: 12 }}
              disabled={tooYoung || noRecord || !(price > 0)}
              onClick={() => dispatch({ type: 'GO_PUBLIC', shares: ipoShares })}
            >
              List on the exchange
            </button>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>
              {tooYoung ? `Available from week ${C.IPO_MIN_ABS_WEEK}.`
                : noRecord ? `Needs ${C.IPO_MIN_HISTORY_WEEKS} weeks of trading history.`
                : 'Raises cash, permanently dilutes you, and lets rivals buy in.'}
            </div>
          </div>
        ) : (
          <div style={box}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Share offering</div>
            <CapitalRow label="Allowance left this year" value={issueAllowance.toLocaleString()} />
            <CapitalRow label="Discount" hint="widens each time you tap the market" value={pct(issueDisc)} />
            <input
              style={input} inputMode="numeric" placeholder="Shares to issue"
              value={issueStr} onChange={(e) => setIssueStr(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <CapitalRow label="Proceeds" value={issueN > 0 ? formatMoney(issueProceeds) : '—'} />
            <button
              className="btn"
              style={{ width: '100%', marginTop: 6, fontSize: 12 }}
              disabled={!(issueN > 0) || issueN > issueAllowance || !(price > 0)}
              onClick={() => { dispatch({ type: 'ISSUE_SHARES', shares: issueN }); setIssueStr(''); }}
            >
              Issue shares
            </button>
          </div>
        )}

        {/* Buyback */}
        {isPublic && (
          <div style={box}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Buy back stock</div>
            <CapitalRow label="Allowance left this year" value={buyAllowance.toLocaleString()} />
            <CapitalRow label="Cash cover to keep" hint={`${C.MIN_CASH_WEEKS_COVER} weeks of costs`} value={formatMoney(coverNeeded)} />
            <input
              style={input} inputMode="numeric" placeholder="Shares to retire"
              value={buybackStr} onChange={(e) => setBuyStr(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <CapitalRow label="Cost" value={buyN > 0 ? formatMoney(buyCost) : '—'} />
            <button
              className="btn"
              style={{ width: '100%', marginTop: 6, fontSize: 12 }}
              disabled={!(buyN > 0) || buyN > buyAllowance || buyN > float
                        || (state.cash - buyCost) < coverNeeded}
              onClick={() => { dispatch({ type: 'BUY_BACK_SHARES', shares: buyN }); setBuyStr(''); }}
            >
              Retire shares
            </button>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>
              Accretive when your stock is cheap or your cash is sitting idle.
            </div>
          </div>
        )}

        {/* Dividend */}
        {isPublic && (
          <div style={box}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Dividend policy</div>
            <CapitalRow label="Trailing quarter profit" value={formatMoney(Math.round(trailing))} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
              <input
                style={{ ...input, width: 70 }} inputMode="numeric"
                value={payoutStr} onChange={(e) => setPayoutStr(e.target.value.replace(/[^0-9]/g, ''))}
              />
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                % of profit (max {Math.round(C.DIVIDEND_MAX_PAYOUT * 100)}%)
              </span>
            </div>
            <CapitalRow label="Per share, per quarter" value={perShare > 0 ? `$${perShare.toFixed(4)}` : '—'} />
            <CapitalRow label="Cost to you each quarter" hint="only publicly held shares are paid" value={quarterCost > 0 ? formatMoney(quarterCost) : '—'} />
            <CapitalRow label="Yield" value={yieldPct > 0 ? pct(yieldPct) : '—'} />
            <button
              className="btn"
              style={{ width: '100%', marginTop: 6, fontSize: 12 }}
              disabled={payoutRatio === (equity.dividendPolicy ?? 0)}
              onClick={() => dispatch({ type: 'SET_DIVIDEND_POLICY', payoutRatio })}
            >
              {payoutRatio > 0 ? 'Set policy' : 'Stop paying dividends'}
            </button>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>
              {(equity.dividendPolicy ?? 0) > 0
                ? `Paying ${Math.round((equity.dividendPolicy ?? 0) * 100)}% — next payment in ${weeksToPay} week${weeksToPay === 1 ? '' : 's'}.`
                : 'Paid every 13 weeks out of trailing profit. Suspended automatically after a losing quarter.'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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

      <CapitalActions state={state} dispatch={dispatch} />

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
              const cPool = Number.isFinite(Number(c.poolShares)) ? Number(c.poolShares) : null;
              const isPrivate = c.isPublic === false;
              const soldOut   = !isPrivate && cPool != null && cPool <= 0;
              const buyTitle  = isPrivate ? 'Privately held — not on the market yet'
                : soldOut ? 'No shares available — other investors hold the entire float'
                : cPool != null ? `${cPool.toLocaleString()} shares available` : undefined;
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
                          {fmtShares(held.shares)} sh · {((held.shares / sharesOf(c)) * 100).toFixed(1)}%
                        </div>
                      </div>
                    ) : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', padding: '9px 14px', whiteSpace: 'nowrap' }}>
                    <button className="btn" style={{ fontSize: 11.5, padding: '3px 10px', marginRight: 6 }}
                      disabled={price == null || isPrivate || soldOut}
                      title={buyTitle}
                      onClick={() => setTicket({ carrier: c, side: 'buy' })}>
                      {isPrivate ? 'Private' : soldOut ? 'Sold out' : 'Buy'}
                    </button>
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
