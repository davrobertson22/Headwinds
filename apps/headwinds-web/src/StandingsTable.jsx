// The world page's live player list (rankings rework, 2026-10-15).
//
// Every airline still flying, ranked on average weekly net profit over the
// last 52 weeks — the title goes to the best average over the FINAL 52 weeks —
// and sortable by the stats players compare: weekly profit, net assets,
// passengers and flights a week, fleet size. Sorting reorders the rows but the
// # column is always the official rank. Column definitions and sorting live in
// src/utils/standingsView.js, shared with the in-game Rivals leaderboard.
//
// A world no post-rework tick has reached (`ranking.metric === 'svps'`: it
// ended under the old rule, or it is waiting for its next week) says so and
// keeps its SVPS column, because that is still what its order means.
import { Fragment } from 'react';
import OgBadge, { DevBadge, SupporterBadge } from './OgBadge.jsx';
import { STANDINGS_SORTS, sortStandings, finalStretchLine } from '../../../src/utils/standingsView.js';

const fmtMoney = (n) => n == null ? '—' :
  Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` :
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}k`;

// Signed money: a real minus sign, and small amounts in dollars, not "$0k".
export const fmtSignedMoney = (n) => {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const body = abs < 1e3 ? `$${Math.round(abs)}` : fmtMoney(abs);
  return n < 0 ? `−${body}` : body;
};
const fmtCount = (n) => n == null ? '—' : Math.round(n).toLocaleString('en-US');
const fmtSvps = (n) => n == null ? '—'
  : Math.abs(n) >= 100 ? `$${Math.round(n).toLocaleString('en-US')}`
  : `$${Number(n).toFixed(2)}`;

function StatusChip({ status }) {
  return <span className={`chip chip-${String(status).toLowerCase()}`}>{status}</span>;
}

function StandingsCell({ spec, value }) {
  if (spec.money) {
    const signed = spec.key === 'rank' || spec.key === 'weeklyProfit';
    const cls = value == null || !signed ? '' : value < 0 ? 'neg' : 'pos';
    return <td className={cls}>{fmtSignedMoney(value)}</td>;
  }
  return <td>{fmtCount(value)}</td>;
}

function RulesLine({ world, ranking }) {
  if (ranking?.metric === 'svps') {
    return (
      <p className="small">
        {world.status === 'ENDED'
          ? 'This season was decided on shareholder value per share (SVPS), the rule when it ended.'
          : 'From the next week on, the standings rank on average weekly net profit over the last 52 weeks. When the world ends, the best average over the final 52 weeks wins.'}
      </p>
    );
  }
  const stretch = world.status === 'ENDED' ? null : finalStretchLine(ranking);
  return (
    <p className="small">
      {world.status === 'ENDED'
        ? 'Ranked on average weekly net profit over the final 52 weeks. The highest average took the title.'
        : 'Ranked on average weekly net profit over the last 52 weeks. When the world ends, the best average over the final 52 weeks wins.'}
      {stretch && <> <strong>{stretch}</strong></>}
    </p>
  );
}

export default function StandingsTable({
  world, standings = [], ranking = null, fallen = 0, mineId = null,
  sort = { key: 'rank', dir: 'desc' }, onSort = () => {},
  openRivalId = null, onToggleRival = () => {}, idleOf = () => null, renderDetail = null,
}) {
  const legacy = ranking?.metric === 'svps';
  const colCount = STANDINGS_SORTS.length + 4 + (legacy ? 1 : 0);
  return (
    <>
      <h3>{world.status === 'ENDED' ? 'Final standings' : 'Standings'}</h3>
      <RulesLine world={world} ranking={ranking} />
      <p className="muted small">
        Every airline below is a real player. Click one to see their network, fleet and recent moves. Click a column to sort by it.
        {/* The fallen are a number, not a table: dead airlines no longer clutter
            the standings (server filters to ACTIVE), but the count keeps the
            world's history — and its danger — visible. */}
        {fallen > 0 && (
          <> {fallen} airline{fallen === 1 ? ' has' : 's have'} gone bankrupt or bowed out here.</>
        )}
      </p>
      {standings.length === 0 ? (
        <p className="muted">
          {fallen > 0
            ? 'No airlines left flying — the skies are wide open.'
            : 'No airlines yet, be the first to join.'}
        </p>
      ) : (
        <table className="worlds standings">
          <thead>
            <tr>
              <th>#</th><th>Airline</th><th>Hub</th>
              {STANDINGS_SORTS.map((spec) => {
                const active = sort.key === spec.key;
                return (
                  <th
                    key={spec.key}
                    className={`sortable${active ? ' sorted' : ''}`}
                    aria-sort={active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}
                    title={spec.tip}
                    data-sort-key={spec.key}
                  >
                    <button type="button" className="th-sort" onClick={() => onSort(spec.key)}>
                      {spec.label}
                      <span className="sort-arrow" aria-hidden="true">{active ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}</span>
                    </button>
                  </th>
                );
              })}
              {legacy && <th title="Shareholder value per share — the rank metric before the rankings rework">SVPS</th>}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sortStandings(standings, sort.key, sort.dir).map((a) => {
              const ago = idleOf(a);
              return (
                <Fragment key={a.id}>
                  <tr
                    className={`rival-row ${mineId === a.id ? 'me-row' : ''}`}
                    data-airline-id={a.id}
                    onClick={() => onToggleRival(a.id)}
                  >
                    <td>{a.rank}</td>
                    <td>
                      {/* The name links to the account-level profile; stopPropagation so
                          the click doesn't also toggle the in-row rival panel. Older server
                          payloads carry no accountId — then the name stays plain text. */}
                      {a.accountId
                        ? <a href={`#/players/${a.accountId}`} title="View player profile"
                             onClick={(e) => e.stopPropagation()}>{a.name}</a>
                        : a.name}{a.dev ? <DevBadge /> : null}{a.og ? <OgBadge /> : null}{a.sup ? <SupporterBadge /> : null}{mineId === a.id ? <span className="muted"> (you)</span> : null}
                      {a.alliance ? <span className="alliance-tag" title={`Alliance: ${a.alliance}`}>🤝 {a.alliance}</span> : null}
                      {/* Flag a probably-abandoned rival at a glance (idle past ~3
                          real days; never your own row). */}
                      {ago?.idle
                        ? <span className="muted small" title={`Last move ${ago.label}`} style={{ marginLeft: 6 }}>· idle {ago.label}</span>
                        : null}
                    </td>
                    <td>{a.hub}</td>
                    {STANDINGS_SORTS.map((spec) => (
                      <StandingsCell key={spec.key} spec={spec}
                        value={spec.field === 'fleetSize' ? (a.fleetSize ?? a.fleet ?? null) : a[spec.field]} />
                    ))}
                    {legacy && (
                      <td title={`Market cap ${fmtMoney(a.marketCap)}`}>{fmtSvps(a.svps)}</td>
                    )}
                    <td><StatusChip status={a.status} /></td>
                  </tr>
                  {openRivalId === a.id && renderDetail && (
                    <tr>
                      <td colSpan={colCount} style={{ padding: 0, border: 'none' }}>
                        {renderDetail(a)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
