// One order's place on its production line (utils/lineQueue.js), under the
// order's progress bar on Fleet → On Order: a row of frames due off the line
// before it, then its own, and one line of words. Nothing outside
// production-line worlds.

const MAX_CELLS = 12;

export default function LinePlace({ place }) {
  if (!place) return null;
  const { ahead, yoursAhead, alongside, lineName, weeksOut } = place;
  const shown = Math.min(ahead, MAX_CELLS - 1);
  const more = ahead - shown;
  const words = ahead === 0
    ? `Next off the ${lineName} line`
    : `${ahead} frame${ahead === 1 ? '' : 's'} ahead${yoursAhead ? ` (${yoursAhead} yours)` : ''} on the ${lineName} line`;
  const title = `${words}${alongside ? ` · ${alongside} more built the same week` : ''} · rolls out in ${weeksOut} week${weeksOut === 1 ? '' : 's'}`;
  return (
    <div className="line-place" data-line-ahead={ahead} title={title} style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {Array.from({ length: shown }, (_, i) => (
          <span key={i} style={{ width: 6, height: 6, borderRadius: 1, background: 'var(--surface3, rgba(255,255,255,.18))', display: 'inline-block' }} />
        ))}
        {more > 0 && <span style={{ fontSize: 9, color: 'var(--text-dim)', margin: '0 2px' }}>+{more}</span>}
        <span aria-label="your frame" style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--accent)', display: 'inline-block', marginLeft: ahead ? 2 : 0 }} />
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>{words}</div>
    </div>
  );
}
