// The seasons you have already played.
//
// A Headwinds world runs about seven real months and then ends. Until the
// career layer there was nothing to show for one: the world flipped to ENDED
// and the next one started you at zero with no memory that the last had
// happened at all. This is where the record lives.

const fmtNum = (n) => Math.round(Number(n) || 0).toLocaleString();

function fmtPax(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

function ordinal(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const s = ['th', 'st', 'nd', 'rd'];
  const m = v % 100;
  return v + (s[(m - 20) % 10] ?? s[m] ?? s[0]);
}

function Figure({ label, value, hint }) {
  return (
    <div>
      <div className="muted small">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>{value}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}

export default function CareerPanel({ career, accountId = null }) {
  const totals = career?.totals;
  const worlds = career?.worlds ?? [];
  const badges = career?.badges ?? [];

  // An account that has never finished a season gets nothing rather than a
  // grid of zeroes — a hall of fame with no entries is worse than no hall.
  if (!totals || !(totals.worldsFinished > 0)) return null;

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ marginTop: 0 }}>Career</h3>
        {accountId && (
          <a className="muted small" href={`#/players/${accountId}`}
             title="Your profile as other players see it — private worlds hidden">
            View my public profile →
          </a>
        )}
      </div>
      <p className="muted small" style={{ marginTop: -6 }}>
        {totals.worldsFinished === 1
          ? 'One season finished.'
          : `${totals.worldsFinished} seasons finished.`}
        {' '}Seasons still running are not counted until they end.
      </p>

      {badges.length > 0 && (
        <div className="row wrap" style={{ gap: 8, margin: '10px 0 14px' }}>
          {badges.map((b) => (
            <span
              key={b.id}
              title={b.description}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.14)',
              }}
            >
              <span aria-hidden="true">{b.icon}</span>{b.label}
            </span>
          ))}
        </div>
      )}

      <div
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
          gap: 16, paddingBottom: 14,
        }}
      >
        <Figure
          label="Best finish"
          value={totals.bestFinish == null ? '—' : ordinal(totals.bestFinish)}
          hint={totals.bestFinish == null ? 'no ranked season yet' : undefined}
        />
        <Figure label="Championships" value={fmtNum(totals.championships)} />
        <Figure label="Podiums" value={fmtNum(totals.podiums)} />
        <Figure label="Passengers carried" value={fmtPax(totals.lifetimePassengers)} />
        <Figure label="Weeks flown" value={fmtNum(totals.weeksPlayed)} />
        {totals.refoundings > 0 && (
          <Figure label="Re-foundings" value={fmtNum(totals.refoundings)} hint="airlines rebuilt" />
        )}
      </div>

      <div className="list-head">
        <span>Season</span>
        <span>Airline</span>
        <span>Finish</span>
        <span>Passengers</span>
      </div>
      {worlds.map((w) => (
        <div key={w.worldId} className="row" style={{ padding: '6px 0', gap: 12 }}>
          <span style={{ flex: 1 }}>
            {w.worldName ?? 'Unnamed world'}
            {w.lengthYears ? <span className="muted small"> · {w.lengthYears}y</span> : null}
          </span>
          <span style={{ flex: 1 }}>
            {w.airlineName ?? '—'}
            {w.hub ? <span className="muted small"> · {w.hub}</span> : null}
          </span>
          <span style={{ flex: 1 }}>
            {w.rank == null
              ? <span className="muted">unranked</span>
              : <>
                  {w.rank === 1 ? '🏆 ' : ''}{ordinal(w.rank)}
                  {w.of ? <span className="muted small"> of {w.of}</span> : null}
                </>}
            {w.status === 'BANKRUPT' && <span className="muted small"> · bankrupt</span>}
          </span>
          <span style={{ flex: 1 }}>
            {w.passengers > 0 ? fmtPax(w.passengers) : <span className="muted">—</span>}
          </span>
        </div>
      ))}

      {worlds.some((w) => !(w.passengers > 0)) && (
        <p className="muted small" style={{ marginTop: 10 }}>
          Seasons that ended before career records existed carry no passenger
          count — the figure was never written down at the time.
        </p>
      )}
    </section>
  );
}
