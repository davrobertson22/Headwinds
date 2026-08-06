import { useEffect, useMemo, useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { formatMoney } from '../utils/simulation.js';
import {
  AWAY_MIN_WEEKS, absWeekOf, loadLastSeen, saveLastSeen, weeksAway,
  buildAwayDigest, setPendingAwayWeeks,
} from '../utils/awayDigest.js';

/** A dash, not a zero — "the save cannot answer this" is not the same as "none". */
const Dash = () => <span style={{ color: 'var(--text-dim)' }}>—</span>;

function Delta({ value, suffix = '', invert = false }) {
  if (value == null) return <Dash />;
  const good = invert ? value < 0 : value > 0;
  const color = value === 0 ? 'var(--text-muted)' : good ? 'var(--green)' : 'var(--red)';
  return <span style={{ color }}>{value > 0 ? '+' : ''}{value}{suffix}</span>;
}

function Stat({ label, children, wide = false }) {
  return (
    <div style={{ gridColumn: wide ? 'span 2' : undefined }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{children}</div>
    </div>
  );
}

/** Week-by-week profit, so a single catastrophic week is visible as one. */
function ProfitStrip({ series }) {
  if (!series?.length) return null;
  const peak = Math.max(1, ...series.map(s => Math.abs(s.profit)));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 46, marginTop: 4 }}>
      {series.map((s, i) => {
        const h = Math.max(2, Math.round((Math.abs(s.profit) / peak) * 20));
        const up = s.profit >= 0;
        return (
          <div key={i} title={`${s.label}: ${formatMoney(s.profit)}`}
               style={{ flex: 1, minWidth: 3, display: 'flex', flexDirection: 'column',
                        justifyContent: 'center', height: '100%' }}>
            <div style={{ height: 22, display: 'flex', alignItems: 'flex-end' }}>
              {up && <div style={{ width: '100%', height: h, background: 'var(--green)', borderRadius: 1, opacity: 0.85 }} />}
            </div>
            <div style={{ height: 22 }}>
              {!up && <div style={{ width: '100%', height: h, background: 'var(--red)', borderRadius: 1, opacity: 0.85 }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * "While you were away" — the screen that exists because the world does not
 * stop when you close the tab. Shown INSTEAD of the weekly debrief when the
 * save has jumped two or more weeks since this device last saw it; dismissing
 * it hands over to the ordinary debrief for the latest week.
 *
 * Everything here is derived from `financialHistory` and `statsHistory`, both
 * of which are already in the save — see utils/awayDigest.js for why nothing
 * new is stored to make this work.
 */
export default function AwayDigest() {
  const { state, remoteApi } = useGame();
  const scope = remoteApi?.airlineId ?? null;
  const nowAbs = absWeekOf(state);

  // The week we last dismissed at, so a digest stays dismissed until the world
  // moves on again.
  const [dismissedAt, setDismissedAt] = useState(null);
  const [news, setNews] = useState(null);

  // Decided DURING render, not in an effect. An effect would leave the first
  // paint empty and pop the modal in a frame later — and, less cosmetically,
  // would make this component impossible to render outside a browser, which is
  // how the rest of this codebase checks that a screen shows what it claims.
  // `phase` guards the pre-game screens, where a half-built state would
  // otherwise read as a fifty-week absence.
  const ready = !!state && state.phase !== 'setup' && nowAbs > 0;
  const seen  = ready ? loadLastSeen(scope) : null;
  const weeks = (!ready || seen == null || dismissedAt === nowAbs)
    ? 0
    : (weeksAway(state, seen) >= AWAY_MIN_WEEKS ? weeksAway(state, seen) : 0);

  // The only thing the effect does is remember. A first sighting starts the
  // clock (there is nothing to summarise about a save you have never seen), and
  // an ordinary single tick just moves it forward.
  useEffect(() => {
    if (!ready) return;
    if (seen == null || (weeks === 0 && dismissedAt !== nowAbs)) saveLastSeen(scope, nowAbs);
  }, [ready, seen, weeks, nowAbs, scope, dismissedAt]);

  // Tell the weekly debrief whether to stand aside. Module stores are a side
  // effect, so this cannot happen during render.
  useEffect(() => {
    setPendingAwayWeeks(weeks);
    return () => setPendingAwayWeeks(0);
  }, [weeks]);

  const digest = useMemo(
    () => (weeks >= AWAY_MIN_WEEKS ? buildAwayDigest(state, weeks) : null),
    [state, weeks],
  );

  // World news across the missed span. Multiplayer only — the feed is where
  // bankruptcies, rank changes and gate auctions live, and it is the one part
  // of the story the save genuinely does not hold.
  useEffect(() => {
    if (!digest || !remoteApi?.fetchNews) { setNews(null); return; }
    let live = true;
    remoteApi.fetchNews('?limit=40')
      .then((res) => {
        if (!live) return;
        const items = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
        const fromWeek = nowAbs - digest.weeks;
        setNews(items.filter(n => {
          const w = (((n.year ?? 1) - 1) * 52) + (n.week ?? 0);
          return Number.isFinite(w) ? w > fromWeek : true;
        }).slice(0, 8));
      })
      .catch(() => { if (live) setNews(null); });
    return () => { live = false; };
  }, [digest, remoteApi, nowAbs]);

  if (!digest) return null;

  function dismiss() {
    saveLastSeen(scope, nowAbs);
    setDismissedAt(nowAbs);
    setPendingAwayWeeks(0);
  }

  const up = digest.cashDelta >= 0;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.72)', zIndex: 950,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div className="card" style={{
        maxWidth: 620, width: '100%', maxHeight: '88vh', overflowY: 'auto',
        padding: '22px 24px',
      }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', letterSpacing: '.06em', textTransform: 'uppercase' }}>
          While you were away
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
          {digest.weeks} weeks passed
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
          {digest.fromLabel} → {digest.toLabel}
        </div>

        <div style={{
          marginTop: 16, padding: '14px 16px', borderRadius: 10,
          background: up ? 'rgba(63,185,80,.08)' : 'rgba(248,81,73,.08)',
          border: `1px solid ${up ? 'rgba(63,185,80,.25)' : 'rgba(248,81,73,.25)'}`,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Cash over the period</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: up ? 'var(--green)' : 'var(--red)' }}>
            {up ? '+' : ''}{formatMoney(digest.cashDelta)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {digest.profitableWeeks} profitable {digest.profitableWeeks === 1 ? 'week' : 'weeks'},
            {' '}{digest.losingWeeks} in the red · now holding {formatMoney(digest.cashNow)}
          </div>
          <ProfitStrip series={digest.series} />
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: 14, marginTop: 18,
        }}>
          <Stat label="Revenue">{formatMoney(digest.revenue)}</Stat>
          <Stat label="Costs">{formatMoney(digest.cost)}</Stat>
          <Stat label="Passengers">{Math.round(digest.passengers).toLocaleString()}</Stat>
          <Stat label="Avg load factor">
            {digest.avgLoadFactor != null ? `${(digest.avgLoadFactor * 100).toFixed(1)}%` : <Dash />}
          </Stat>
          <Stat label="Fleet"><Delta value={digest.fleetChange} /></Stat>
          <Stat label="Routes"><Delta value={digest.routeChange} /></Stat>
          <Stat label="Destinations"><Delta value={digest.destinationChange} /></Stat>
          <Stat label="Share price">
            {digest.sharePriceNow != null
              ? <>${Number(digest.sharePriceNow).toFixed(2)}{digest.sharePriceFrom != null && (
                  <span style={{ fontSize: 12, marginLeft: 5,
                                 color: digest.sharePriceNow >= digest.sharePriceFrom ? 'var(--green)' : 'var(--red)' }}>
                    {digest.sharePriceNow >= digest.sharePriceFrom ? '▲' : '▼'}
                    {' '}${Math.abs(digest.sharePriceNow - digest.sharePriceFrom).toFixed(2)}
                  </span>)}</>
              : <Dash />}
          </Stat>
        </div>

        {(digest.best || digest.worst || digest.biggestCost) && (
          <div style={{ marginTop: 16, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7 }}>
            {digest.best && digest.worst && digest.best.label !== digest.worst.label && (
              <div>
                Best week <strong style={{ color: 'var(--text)' }}>{digest.best.label}</strong>
                {' '}at {formatMoney(digest.best.profit)}; worst
                {' '}<strong style={{ color: 'var(--text)' }}>{digest.worst.label}</strong>
                {' '}at {formatMoney(digest.worst.profit)}.
              </div>
            )}
            {digest.biggestCost && (
              <div>
                Biggest cost line was <strong style={{ color: 'var(--text)' }}>{digest.biggestCost.label}</strong>
                {' '}at {formatMoney(digest.biggestCost.amount)}.
              </div>
            )}
          </div>
        )}

        {news?.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '.05em', marginBottom: 6 }}>
              MEANWHILE, IN THE WORLD
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              {news.map((n, i) => (
                <div key={n.id ?? i} style={{ display: 'flex', gap: 8 }}>
                  <span style={{ fontFamily: 'monospace', color: 'var(--text-dim)', flexShrink: 0 }}>
                    W{n.week ?? '?'}
                  </span>
                  <span>{n.headline ?? n.title ?? n.payload?.headline ?? n.kind}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <button className="btn btn-primary" style={{ marginTop: 20, width: '100%' }} onClick={dismiss}>
          Catch up
        </button>
      </div>
    </div>
  );
}
