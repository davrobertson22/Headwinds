import { useState, useEffect } from 'react';
import { useConfirm } from './ConfirmModal.jsx';
import { useGame } from '../store/GameContext.jsx';
import {
  AIRCRAFT_TYPES,
  AIRCRAFT_CATEGORIES,
  getAircraftType,
  buyDiscount,
  effectivePurchasePrice,
  efficiencyScore,
  seatEfficiency,
  fuelCostPerKm,
} from '../data/aircraft.js';
import { formatMoney, weekToGameDate } from '../utils/simulation.js';
import { absoluteWeek } from '../utils/fuel.js';
import AircraftCheckout from './AircraftCheckout.jsx';
import InfoTip from './InfoTip.jsx';
import { Glyph } from './Icons.jsx';

// Category accent colors
const CAT_COLORS = {
  'Turboprop':    '#ffb43d',
  'Regional Jet': '#38d39f',
  'Narrow Body':  '#3ea6ff',
  'Wide Body':    '#a98bff',
  'Double Deck':  '#7c5cff',
  'Supersonic':   '#f778ba',
  'Freighter':    '#e8833a',
};

const CAT_ICONS = {
  'Turboprop':    '🌀',
  'Regional Jet': '✈',
  'Narrow Body':  '✈',
  'Wide Body':    '🛫',
  'Double Deck':  '🛬',
  'Supersonic':   '💨',
  'Freighter':    '📦',
};

// Display labels for category filter tabs (falls back to the raw category key).
const CAT_LABELS = {
  'Double Deck': 'Double Decker',
};

const DELIVERY_LEAD = {
  'Wide Body':    4,
  'Narrow Body':  3,
  'Regional Jet': 2,
  'Turboprop':    1,
  'Double Deck':  5,
  'Supersonic':   4,
  'Freighter':    4,
};

function AircraftPhoto({ src, alt, category }) {
  const [failed, setFailed] = useState(false);
  // Reset failed state if the src URL changes
  useEffect(() => { setFailed(false); }, [src]);
  const color = CAT_COLORS[category] || '#93a4ba';

  if (failed || !src) {
    return (
      <div className="aircraft-photo-placeholder" style={{
        background: `linear-gradient(160deg, ${color}18 0%, transparent 100%)`,
        borderBottom: `1px solid ${color}30`,
      }}>
        <div style={{ fontSize: 52, opacity: 0.25 }}><Glyph e="✈" /></div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, opacity: 0.7 }}>{alt}</div>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className="aircraft-photo"
      onError={() => setFailed(true)}
    />
  );
}

// ── Orders & Deliveries tab ───────────────────────────────────────────────────

function deliveryDateLabel(absWeek) {
  const year = Math.floor((absWeek - 1) / 52) + 1;
  const wiy  = ((absWeek - 1) % 52) + 1;
  const { monthName, weekInMonth } = weekToGameDate(wiy);
  return `Wk ${weekInMonth} ${monthName} Y${year}`;
}

const CABIN_CLASSES = [
  { key: 'firstClass',     label: 'First',      color: '#a98bff' },
  { key: 'businessClass',  label: 'Business',   color: '#3ea6ff' },
  { key: 'premiumEconomy', label: 'Prem Econ',  color: '#38d39f' },
  { key: 'economy',        label: 'Economy',    color: '#93a4ba' },
];

function statTile(label, value, sub) {
  return (
    <div style={{
      flex: '1 1 140px', minWidth: 130,
      background: 'var(--surface2)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 14px',
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function DeliveryForecast({ pendingOrders, currentAbsWeek }) {
  // Group orders by delivery week, soonest first
  const groups = {};
  for (const o of pendingOrders) {
    (groups[o.deliverAbsWeek] ??= []).push(o);
  }
  const weeks = Object.keys(groups).map(Number).sort((a, b) => a - b);

  return (
    <div style={{
      background: 'var(--surface2)', border: '1px solid var(--border)',
      borderRadius: 8, overflow: 'hidden', marginBottom: 20,
    }}>
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)',
        fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span><Glyph e="📅" /></span>
        <span>Delivery Forecast</span>
      </div>
      <div style={{ padding: '10px 16px' }}>
        {weeks.map((wk, i) => {
          const weeksAway = wk - currentAbsWeek;
          const arriving  = weeksAway <= 0;
          return (
            <div key={wk} style={{ display: 'flex', gap: 14, position: 'relative' }}>
              {/* Timeline column */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12, flexShrink: 0 }}>
                <div style={{
                  width: 10, height: 10, borderRadius: '50%', marginTop: 5,
                  background: arriving ? 'var(--green)' : 'var(--accent)',
                  boxShadow: arriving ? '0 0 0 3px rgba(63,185,80,0.2)' : '0 0 0 3px rgba(56,139,253,0.15)',
                  flexShrink: 0,
                }} />
                {i < weeks.length - 1 && (
                  <div style={{ width: 2, flex: 1, background: 'var(--border)', marginTop: 2, marginBottom: 2 }} />
                )}
              </div>
              {/* Week content */}
              <div style={{ flex: 1, paddingBottom: i < weeks.length - 1 ? 14 : 2, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: arriving ? 'var(--green)' : 'var(--text)' }}>
                    {arriving ? 'Arriving now' : `In ${weeksAway} week${weeksAway !== 1 ? 's' : ''}`}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{deliveryDateLabel(wk)}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    · {groups[wk].length} aircraft
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {groups[wk].map(o => {
                    const t        = getAircraftType(o.typeId);
                    const catColor = CAT_COLORS[t?.category] || '#93a4ba';
                    return (
                      <span key={o.id} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        fontSize: 11, padding: '3px 10px', borderRadius: 20,
                        background: 'var(--surface1)', border: `1px solid ${catColor}40`,
                      }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: catColor }} />
                        <span style={{ fontWeight: 600 }}>{o.name}</span>
                        <span style={{ color: o.ownershipType === 'owned' ? 'var(--green)' : 'var(--accent)', fontWeight: 600 }}>
                          {o.ownershipType === 'owned' ? 'Buy' : 'Lease'}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OrderCard({ order, currentAbsWeek, onCancel, onRename }) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft]     = useState('');

  function startRename() {
    setNameDraft(order.name);
    setEditingName(true);
  }
  function commitRename() {
    const name = nameDraft.trim();
    if (name && name !== order.name) onRename(order, name);
    setEditingName(false);
  }

  const type      = getAircraftType(order.typeId);
  const catColor  = CAT_COLORS[type?.category] || '#93a4ba';
  const weeksLeft = order.deliverAbsWeek - currentAbsWeek;
  const lead      = DELIVERY_LEAD[type?.category] ?? 2;
  const progress  = Math.max(0, Math.min(1, 1 - (weeksLeft / lead)));
  const isOwned   = order.ownershipType === 'owned';
  const cfg       = order.config;
  const totalSeats = cfg
    ? CABIN_CLASSES.reduce((s, c) => s + (cfg[c.key] || 0), 0)
    : null;

  const labelStyle = { fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' };

  return (
    <div style={{
      background: 'linear-gradient(180deg, var(--surface), var(--bg-elev))',
      border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: catColor, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
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
                fontWeight: 700, fontSize: 14, padding: '1px 6px', width: '100%',
                background: 'var(--surface2)', color: 'var(--text)',
                border: '1px solid var(--accent)', borderRadius: 5, outline: 'none',
              }}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
              <span style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {order.name}
              </span>
              <button
                onClick={startRename}
                title="Rename aircraft"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text-muted)', padding: '0 2px', flexShrink: 0,
                  display: 'inline-flex', alignItems: 'center',
                }}
              >
                <Glyph e="✏️" size={12} />
              </button>
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
            {type?.manufacturer} {type?.name} · <span style={{ color: catColor }}>{CAT_LABELS[type?.category] || type?.category}</span>
          </div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, flexShrink: 0,
          background: isOwned ? 'rgba(63,185,80,0.15)' : 'rgba(56,139,253,0.15)',
          color: isOwned ? 'var(--green)' : 'var(--accent)',
          border: `1px solid ${isOwned ? 'rgba(63,185,80,0.35)' : 'rgba(56,139,253,0.35)'}`,
        }}>
          {isOwned ? 'PURCHASE' : 'LEASE'}
        </span>
      </div>

      <div style={{ padding: '12px 16px' }}>
        {/* Configuration */}
        <div style={labelStyle}>Configuration</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, marginBottom: 12 }}>
          {order.engineLabel && (
            <span style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 4,
              background: 'rgba(163,113,247,0.12)', color: '#a98bff',
              border: '1px solid rgba(163,113,247,0.3)',
            }}>
              <Glyph e="⚙" /> {order.engineLabel}
            </span>
          )}
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 4,
            background: order.hasWingtips ? 'rgba(56,211,159,0.12)' : 'var(--surface3)',
            color: order.hasWingtips ? '#38d39f' : 'var(--text-dim)',
            border: `1px solid ${order.hasWingtips ? 'rgba(56,211,159,0.3)' : 'var(--border)'}`,
          }}>
            {order.hasWingtips ? '✓ Wingtips' : 'No wingtips'}
          </span>
          {type?.freighter && (
            <span style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 4,
              background: 'rgba(232,131,58,0.12)', color: '#e8833a',
              border: '1px solid rgba(232,131,58,0.3)',
            }}>
              <Glyph e="📦" /> {type.payloadTonnes}t payload
            </span>
          )}
        </div>

        {/* Cabin layout */}
        {cfg && totalSeats > 0 && (
          <>
            <div style={labelStyle}>Cabin Layout · {totalSeats} seats</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, marginBottom: 4 }}>
              {CABIN_CLASSES.filter(c => (cfg[c.key] || 0) > 0).map(c => (
                <div key={c.key} style={{
                  flex: 1, textAlign: 'center', padding: '5px 4px', borderRadius: 6,
                  background: 'var(--surface2)', border: `1px solid ${c.color}35`,
                }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: c.color }}>{cfg[c.key]}</div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{c.label}</div>
                </div>
              ))}
            </div>
            {/* Cabin mix bar */}
            <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', marginBottom: 12 }}>
              {CABIN_CLASSES.filter(c => (cfg[c.key] || 0) > 0).map(c => (
                <div key={c.key} style={{ width: `${(cfg[c.key] / totalSeats) * 100}%`, background: c.color }} />
              ))}
            </div>
          </>
        )}

        {/* Financials */}
        <div style={{
          display: 'flex', gap: 16, padding: '8px 0 10px',
          borderTop: '1px solid var(--border-subtle)', marginTop: 2,
        }}>
          {isOwned ? (
            <div>
              <div style={labelStyle}>Purchase Price</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--green)', marginTop: 2 }}>
                {formatMoney(order.totalPrice)}
              </div>
            </div>
          ) : (
            <>
              <div>
                <div style={labelStyle}>Weekly Lease</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent)', marginTop: 2 }}>
                  {formatMoney(order.weeklyLease)}<span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)' }}>/wk</span>
                </div>
              </div>
              <div>
                <div style={labelStyle}>Deposit Paid</div>
                <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>
                  {formatMoney(order.leaseDeposit)}
                </div>
              </div>
            </>
          )}
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={labelStyle}>Ordered</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              Wk {order.orderedWeek} Y{order.orderedYear}
            </div>
          </div>
        </div>

        {/* Delivery progress */}
        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
            <span style={{ fontSize: 11, color: weeksLeft <= 1 ? 'var(--green)' : 'var(--text-muted)', fontWeight: 600 }}>
              {weeksLeft <= 0 ? 'Arriving…' : `${weeksLeft} week${weeksLeft !== 1 ? 's' : ''} until delivery`}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{deliveryDateLabel(order.deliverAbsWeek)}</span>
          </div>
          <div style={{ height: 4, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress * 100}%`, background: catColor, borderRadius: 2, transition: 'width 0.3s' }} />
          </div>
          <button
            onClick={() => onCancel(order)}
            style={{
              marginTop: 10, width: '100%', padding: '5px 8px', fontSize: 11,
              borderRadius: 5, border: '1px solid rgba(248,81,73,0.3)',
              background: 'rgba(248,81,73,0.08)', color: 'var(--red)', cursor: 'pointer',
            }}
          >
            Cancel Order{isOwned && order.totalPrice > 0 ? ' (95% refund)' : ' (free)'}
          </button>
        </div>
      </div>
    </div>
  );
}

function OrdersTab({ pendingOrders, year, week, onCancel, onRename, onBrowse }) {
  const currentAbsWeek = absoluteWeek(year, week);

  if (!pendingOrders || pendingOrders.length === 0) {
    return (
      <div style={{
        textAlign: 'center', padding: '60px 20px',
        background: 'var(--surface2)', border: '1px dashed var(--border)', borderRadius: 10,
      }}>
        <div style={{ fontSize: 40, opacity: 0.3, marginBottom: 10 }}><Glyph e="📦" /></div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>No aircraft on order</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, marginBottom: 16 }}>
          Orders you place in the market will appear here with delivery forecasts.
        </div>
        <button className="btn btn-primary" onClick={onBrowse}>Browse Market →</button>
      </div>
    );
  }

  const sorted = [...pendingOrders].sort((a, b) => a.deliverAbsWeek - b.deliverAbsWeek);
  const purchases      = sorted.filter(o => o.ownershipType === 'owned');
  const leases         = sorted.filter(o => o.ownershipType !== 'owned');
  const capitalSpent   = purchases.reduce((s, o) => s + (o.totalPrice || 0), 0);
  const incomingLease  = leases.reduce((s, o) => s + (o.weeklyLease || 0), 0);
  const nextDelivery   = sorted[0]?.deliverAbsWeek - currentAbsWeek;

  return (
    <div>
      {/* Summary stats */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
        {statTile('On Order', sorted.length, `${purchases.length} purchase · ${leases.length} lease`)}
        {statTile('Next Delivery', nextDelivery <= 0 ? 'Arriving' : `${nextDelivery}w`, deliveryDateLabel(sorted[0].deliverAbsWeek))}
        {statTile('Capital Committed', formatMoney(capitalSpent), 'purchases (paid)')}
        {statTile('Incoming Lease Costs', `${formatMoney(incomingLease)}/wk`, 'starts on delivery')}
      </div>

      {/* Delivery forecast timeline */}
      <DeliveryForecast pendingOrders={sorted} currentAbsWeek={currentAbsWeek} />

      {/* Order detail cards */}
      <div style={{
        fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10,
      }}>
        Order Details ({sorted.length})
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))', gap: 16 }}>
        {sorted.map(order => (
          <OrderCard key={order.id} order={order} currentAbsWeek={currentAbsWeek} onCancel={onCancel} onRename={onRename} />
        ))}
      </div>
    </div>
  );
}

// ── Table (list) view ─────────────────────────────────────────────────────────

const TABLE_COLS = [
  { key: 'name',     label: 'Aircraft',     align: 'left'  },
  { key: 'seats',    label: 'Seats',        align: 'right' },
  { key: 'range',    label: 'Range',        align: 'right' },
  { key: 'runway',   label: 'Runway',       align: 'right', title: 'Minimum runway length required (ft)' },
  { key: 'fuel',     label: 'Fuel/seat',    align: 'right', title: 'Litres per seat per 100 km (per tonne for freighters)' },
  { key: 'eff',      label: 'Eff.',         align: 'right', title: 'Seat efficiency score, 0-100' },
  { key: 'maint',    label: 'Maint/wk',     align: 'right' },
  { key: 'lease',    label: 'Lease/wk',     align: 'right' },
  { key: 'buy',      label: 'Buy',          align: 'right' },
  { key: 'delivery', label: 'Delivery',     align: 'right' },
  { key: null,       label: '',             align: 'right' },
];

function MarketTable({ rows, sort, setSort, onCheckout }) {
  const sorted = [...rows].sort((a, b) => {
    const { key, dir } = sort;
    const av = a[key], bv = b[key];
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return ((av ?? 0) - (bv ?? 0)) * dir;
  });

  function clickSort(key) {
    if (!key) return;
    setSort(s => s.key === key ? { key, dir: -s.dir } : { key, dir: key === 'name' ? 1 : -1 });
  }

  return (
    <div className="market-table-wrap">
      <table className="market-table">
        <thead>
          <tr>
            {TABLE_COLS.map((c, i) => (
              <th
                key={i}
                title={c.title}
                style={{ textAlign: c.align, cursor: c.key ? 'pointer' : 'default' }}
                onClick={() => clickSort(c.key)}
              >
                {c.label}{sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => {
            const t = r.type;
            return (
              <tr key={t.id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.catColor, flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {t.name}
                        {r.owned > 0 && <span className="market-chip market-chip-blue">{r.owned} in fleet</span>}
                        {r.onOrder > 0 && <span className="market-chip market-chip-yellow">{r.onOrder} ordered</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {t.manufacturer} · <span style={{ color: r.catColor }}>{CAT_LABELS[t.category] || t.category}</span>
                      </div>
                    </div>
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>{t.freighter ? `${t.payloadTonnes}t` : t.seats}</td>
                <td style={{ textAlign: 'right' }}>{t.range.toLocaleString()} km</td>
                <td style={{ textAlign: 'right' }}>{t.runwayFt ? `${t.runwayFt.toLocaleString()} ft` : '–'}</td>
                <td style={{ textAlign: 'right' }}>{r.fuel.toFixed(2)}</td>
                <td style={{ textAlign: 'right', color: r.effColor, fontWeight: 600 }}>{t.freighter ? '–' : r.eff}</td>
                <td style={{ textAlign: 'right' }}>{formatMoney(t.baseMaintenancePerWk)}</td>
                <td style={{ textAlign: 'right', color: 'var(--accent)', fontWeight: 600 }}>{formatMoney(t.weeklyLease)}</td>
                <td style={{ textAlign: 'right' }}>
                  <span style={{ color: r.canAffordBuy ? 'var(--green)' : 'var(--text-dim)', fontWeight: 600 }}>
                    {formatMoney(r.buy)}
                  </span>
                  {r.discPct > 0 && <span className="market-chip market-chip-green">-{r.discPct}%</span>}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{r.delivery}w</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: 11, padding: '4px 10px', marginRight: 6 }}
                    onClick={() => onCheckout({ typeId: t.id, mode: 'lease' })}
                  >
                    Lease
                  </button>
                  <button
                    className="btn"
                    style={{
                      fontSize: 11, padding: '4px 10px',
                      background: r.canAffordBuy ? 'rgba(63,185,80,0.15)' : 'var(--surface3)',
                      color: r.canAffordBuy ? 'var(--green)' : 'var(--text-dim)',
                      border: `1px solid ${r.canAffordBuy ? 'rgba(63,185,80,0.4)' : 'var(--border)'}`,
                      cursor: r.canAffordBuy ? 'pointer' : 'not-allowed',
                    }}
                    disabled={!r.canAffordBuy}
                    onClick={() => r.canAffordBuy && onCheckout({ typeId: t.id, mode: 'buy' })}
                  >
                    Buy
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Marketplace() {
  const { state, dispatch } = useGame();
  const confirm = useConfirm();
  const { cash, fleet, pendingOrders = [], year, week } = state;

  const [view, setView]                     = useState('browse'); // 'browse' | 'orders'
  const [activeCategory, setActiveCategory] = useState('All');
  const [activeMfr, setActiveMfr]           = useState('All');
  const [query, setQuery]                   = useState('');
  // Card gallery vs compact comparison table. Remembered across sessions.
  const [layout, setLayoutState] = useState(() => {
    try { return localStorage.getItem('market_layout') === 'table' ? 'table' : 'cards'; }
    catch { return 'cards'; }
  });
  function setLayout(l) {
    setLayoutState(l);
    try { localStorage.setItem('market_layout', l); } catch { /* private mode */ }
  }
  const [sort, setSort] = useState({ key: 'name', dir: 1 });

  // Checkout modal state: { typeId, mode: 'lease'|'buy' } or null
  const [checkout, setCheckout] = useState(null);

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

  const ownedCounts = fleet.reduce((acc, a) => {
    acc[a.typeId] = (acc[a.typeId] || 0) + 1;
    return acc;
  }, {});

  const pendingCounts = pendingOrders.reduce((acc, o) => {
    acc[o.typeId] = (acc[o.typeId] || 0) + 1;
    return acc;
  }, {});

  const currentWeeklyLease = fleet.reduce((sum, a) => {
    const t = AIRCRAFT_TYPES.find(x => x.id === a.typeId);
    return sum + (a.ownershipType === 'lease' ? (t?.weeklyLease ?? 0) : 0);
  }, 0);

  const categories = ['All', ...AIRCRAFT_CATEGORIES];

  const mfrsInCategory = ['All', ...[...new Set(
    (activeCategory === 'All' ? AIRCRAFT_TYPES : AIRCRAFT_TYPES.filter(t => t.category === activeCategory))
      .map(t => t.manufacturer)
  )].sort()];

  const safeMfr = mfrsInCategory.includes(activeMfr) ? activeMfr : 'All';

  const q = query.trim().toLowerCase();
  const filtered = AIRCRAFT_TYPES.filter(t =>
    (activeCategory === 'All' || t.category === activeCategory) &&
    (safeMfr        === 'All' || t.manufacturer === safeMfr) &&
    (!q || `${t.manufacturer} ${t.name} ${t.category}`.toLowerCase().includes(q))
  );

  return (
    <div>
      {/* Subtabs: Browse Market / Orders & Deliveries */}
      <div className="category-tabs" style={{ marginBottom: 20 }}>
        <button
          className={`category-tab ${view === 'browse' ? 'active' : ''}`}
          style={{ fontSize: 13, padding: '9px 18px' }}
          onClick={() => setView('browse')}
        >
          <span style={{ marginRight: 6, display: 'inline-flex' }}><Glyph e="🛒" size={14} /></span>
          Browse Market
        </button>
        <button
          className={`category-tab ${view === 'orders' ? 'active' : ''}`}
          style={{ fontSize: 13, padding: '9px 18px' }}
          onClick={() => setView('orders')}
        >
          <span style={{ marginRight: 6, display: 'inline-flex' }}><Glyph e="📦" size={14} /></span>
          Orders &amp; Deliveries
          {pendingOrders.length > 0 && (
            <span style={{
              marginLeft: 7, fontSize: 10, fontWeight: 700,
              padding: '1px 7px', borderRadius: 10,
              background: 'rgba(210,153,34,0.2)', color: 'var(--yellow)',
              border: '1px solid rgba(210,153,34,0.4)',
            }}>
              {pendingOrders.length}
            </span>
          )}
        </button>
      </div>

      {view === 'orders' && (
        <OrdersTab
          pendingOrders={pendingOrders}
          year={year}
          week={week}
          onCancel={handleCancelOrder}
          onRename={(order, name) => dispatch({ type: 'RENAME_ORDER', orderId: order.id, name })}
          onBrowse={() => setView('browse')}
        />
      )}

      {view === 'browse' && (
      <>
      {/* Header + category filter */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
          Order aircraft to grow your fleet. Delivery times vary by size: turboprops 1 week, regional jets 2, narrowbodies 3, widebodies 4.
        </div>

        {/* Search + view toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 320 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', fontSize: 13, pointerEvents: 'none' }}>
              <Glyph e="🔍" size={13} />
            </span>
            <input
              type="search"
              className="form-input"
              placeholder="Search aircraft or manufacturer…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              style={{ width: '100%', paddingLeft: 32, fontSize: 13 }}
              aria-label="Search aircraft"
            />
          </div>
          <div className="market-view-toggle" role="group" aria-label="Market layout">
            <button
              className={layout === 'cards' ? 'active' : ''}
              onClick={() => setLayout('cards')}
              title="Card view with photos"
            >
              ▦ Cards
            </button>
            <button
              className={layout === 'table' ? 'active' : ''}
              onClick={() => setLayout('table')}
              title="Compact table for comparing aircraft"
            >
              ☰ Table
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Filter by type
          </span>
          <InfoTip side="bottom" text="Tap a category to show only that class of aircraft, then use the manufacturer pills below to narrow further. Pick 'All' to clear a filter." />
        </div>
        <div className="category-tabs">
          {categories.map(cat => {
            const isActive = activeCategory === cat;
            const color = CAT_COLORS[cat];
            return (
              <button
                key={cat}
                className={`category-tab ${isActive ? 'active' : ''}`}
                style={isActive && color ? { color, borderBottomColor: color } : {}}
                onClick={() => { setActiveCategory(cat); setActiveMfr('All'); }}
              >
                {cat !== 'All' && <span style={{ marginRight: 5, display: 'inline-flex' }}><Glyph e={CAT_ICONS[cat]} size={13} /></span>}
                {CAT_LABELS[cat] || cat}
              </button>
            );
          })}
        </div>

        {/* Manufacturer filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Filter by manufacturer
          </span>
        </div>
        <div style={{
          display: 'flex', gap: 6, overflowX: 'auto',
          paddingBottom: 4, marginTop: 6, scrollbarWidth: 'none',
        }}>
          {mfrsInCategory.map(mfr => {
            const isActive = safeMfr === mfr;
            return (
              <button
                key={mfr}
                onClick={() => setActiveMfr(mfr)}
                style={{
                  flexShrink: 0, padding: '4px 12px', borderRadius: 20,
                  border: isActive ? '1px solid var(--accent)' : '1px solid var(--border)',
                  background: isActive ? 'rgba(56,139,253,0.15)' : 'var(--surface2)',
                  color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                  fontSize: 12, fontWeight: isActive ? 600 : 400,
                  cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.15s',
                }}
              >
                {mfr}
              </button>
            );
          })}
        </div>
      </div>

      {/* No matches */}
      {filtered.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '48px 20px',
          background: 'var(--surface2)', border: '1px dashed var(--border)', borderRadius: 10,
        }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>No aircraft match</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            Try a different search term or clear the filters above.
          </div>
        </div>
      )}

      {/* Comparison table */}
      {layout === 'table' && filtered.length > 0 && (() => {
        const nowAbs = absoluteWeek(year, week);
        const rows = filtered.map(type => {
          const lead          = DELIVERY_LEAD[type.category] ?? 2;
          const alreadyOwned  = ownedCounts[type.id] || 0;
          const onOrder       = pendingCounts[type.id] || 0;
          const buyPrice      = effectivePurchasePrice(type, alreadyOwned);
          const effScore      = efficiencyScore(type) ?? 0;
          const pendingOfType = pendingOrders.filter(o => o.typeId === type.id);
          const maxExisting   = pendingOfType.length > 0
            ? Math.max(...pendingOfType.map(o => o.deliverAbsWeek))
            : nowAbs;
          return {
            type,
            name:     type.name,
            seats:    type.freighter ? (type.payloadTonnes ?? 0) : type.seats,
            range:    type.range,
            runway:   type.runwayFt ?? 0,
            fuel:     type.freighter
              ? type.fuelBurnPer100km / (type.payloadTonnes || 1)
              : type.fuelBurnPer100km / (type.seats || 1),
            eff:      effScore,
            effColor: effScore >= 70 ? 'var(--green)' : effScore >= 40 ? 'var(--yellow)' : 'var(--red)',
            maint:    type.baseMaintenancePerWk,
            lease:    type.weeklyLease,
            buy:      buyPrice,
            discPct:  Math.round(buyDiscount(alreadyOwned) * 100),
            delivery: Math.max(nowAbs + lead, maxExisting + lead) - nowAbs,
            owned:    alreadyOwned,
            onOrder,
            canAffordBuy: cash >= buyPrice,
            catColor: CAT_COLORS[type.category] || '#93a4ba',
          };
        });
        return <MarketTable rows={rows} sort={sort} setSort={setSort} onCheckout={setCheckout} />;
      })()}

      {/* Aircraft grid */}
      {layout === 'cards' && filtered.length > 0 && (
      <div className="aircraft-market-grid">
        {filtered.map(type => {
          const currentAbsWeek = absoluteWeek(year, week);
          const lead           = DELIVERY_LEAD[type.category] ?? 2;
          const newWeeklyTotal = currentWeeklyLease + type.weeklyLease;
          const weeksOfCash    = type.weeklyLease > 0 ? Math.floor(cash / newWeeklyTotal) : Infinity;
          const catColor       = CAT_COLORS[type.category] || '#93a4ba';
          const cashWarning    = isFinite(weeksOfCash) && weeksOfCash < 4;

          const alreadyOwned  = ownedCounts[type.id] || 0;
          const onOrder       = pendingCounts[type.id] || 0;
          const discount      = buyDiscount(alreadyOwned);
          const buyPrice      = effectivePurchasePrice(type, alreadyOwned);
          const discPct       = Math.round(discount * 100);
          const effScore      = efficiencyScore(type) ?? 0;
          const effRaw        = (seatEfficiency(type) ?? 0).toFixed(2);
          const canAffordBuy  = cash >= buyPrice;
          const effColor      = effScore >= 70 ? 'var(--green)' : effScore >= 40 ? 'var(--yellow)' : 'var(--red)';

          // Delivery note
          const pendingOfType = pendingOrders.filter(o => o.typeId === type.id);
          const maxExisting   = pendingOfType.length > 0
            ? Math.max(...pendingOfType.map(o => o.deliverAbsWeek))
            : currentAbsWeek;
          const nextDeliveryWeeks = Math.max(currentAbsWeek + lead, maxExisting + lead) - currentAbsWeek;

          const hasOptions = (type.configOptions?.engines?.length > 1) || !!type.configOptions?.wingtips;

          return (
            <div className="aircraft-market-card" key={type.id}>
              {/* Photo banner */}
              <div className="aircraft-photo-wrap">
                <AircraftPhoto src={type.image} alt={type.name} category={type.category} />
                <div className="aircraft-photo-overlay">
                  <span
                    className="aircraft-cat-badge"
                    style={{ background: `${catColor}25`, color: catColor, border: `1px solid ${catColor}50` }}
                  >
                    {CAT_LABELS[type.category] || type.category}
                  </span>
                  {alreadyOwned > 0 && (
                    <span className="badge badge-blue" style={{ marginLeft: 6 }}>{alreadyOwned} in fleet</span>
                  )}
                  {onOrder > 0 && (
                    <span className="badge" style={{
                      marginLeft: 4,
                      background: 'rgba(210,153,34,0.2)', color: 'var(--yellow)',
                      border: '1px solid rgba(210,153,34,0.4)',
                    }}>
                      {onOrder} on order
                    </span>
                  )}
                </div>
              </div>

              {/* Card body */}
              <div className="aircraft-market-body">
                {/* Title */}
                <div style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 17 }}>{type.name}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{type.manufacturer}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                    {type.description}
                  </div>
                </div>

                {/* Stat pills */}
                <div className="aircraft-stat-row">
                  <div className="aircraft-stat-pill">
                    <span className="aircraft-stat-pill-label">{type.freighter ? 'Payload' : 'Seats'}</span>
                    <span className="aircraft-stat-pill-value">{type.freighter ? `${type.payloadTonnes}t` : type.seats}</span>
                  </div>
                  <div className="aircraft-stat-pill">
                    <span className="aircraft-stat-pill-label">Range</span>
                    <span className="aircraft-stat-pill-value">{type.range.toLocaleString()} km</span>
                  </div>
                  <div className="aircraft-stat-pill">
                    <span className="aircraft-stat-pill-label">Runway</span>
                    <span className="aircraft-stat-pill-value">{type.runwayFt ? `${type.runwayFt.toLocaleString()} ft` : '–'}</span>
                  </div>
                  {!type.freighter && (
                    <div className="aircraft-stat-pill">
                      <span className="aircraft-stat-pill-label">Fuel burn</span>
                      <span className="aircraft-stat-pill-value">{type.fuelBurnPer100km.toFixed(0)} L/100km</span>
                    </div>
                  )}
                  <div className="aircraft-stat-pill">
                    <span className="aircraft-stat-pill-label">{type.freighter ? 'Fuel/tonne' : 'L/seat/100km'}</span>
                    <span className="aircraft-stat-pill-value">
                      {type.freighter
                        ? (type.fuelBurnPer100km / type.payloadTonnes).toFixed(2)
                        : (type.fuelBurnPer100km / type.seats).toFixed(2)}
                    </span>
                  </div>
                  <div className="aircraft-stat-pill">
                    <span className="aircraft-stat-pill-label">Maint/wk</span>
                    <span className="aircraft-stat-pill-value">{formatMoney(type.baseMaintenancePerWk)}</span>
                  </div>
                </div>

                {/* Fuel efficiency bar — passenger aircraft only (freighters have no seat metric) */}
                {!type.freighter && (
                  <div style={{ marginTop: 10, marginBottom: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Seat efficiency</span>
                      <span style={{ fontSize: 11, color: effColor, fontWeight: 600 }}>
                        {effScore}/100 · ${effRaw}/seat/100km
                      </span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--surface3)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 2, width: `${effScore}%`, background: effColor, transition: 'width 0.3s' }} />
                    </div>
                  </div>
                )}

                {/* Config options badge */}
                {hasOptions && (
                  <div style={{ marginTop: 8 }}>
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 4,
                      background: 'rgba(163,113,247,0.12)', color: '#a98bff',
                      border: '1px solid rgba(163,113,247,0.3)',
                    }}>
                      <Glyph e="⚙" /> Engine &amp; wingtip options available
                    </span>
                  </div>
                )}

                {/* Delivery note */}
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                  <Glyph e="📅" /> Delivery in <strong>{nextDeliveryWeeks} week{nextDeliveryWeeks !== 1 ? 's' : ''}</strong>
                  {onOrder > 0 && ` (${onOrder} already queued)`}
                </div>

                {/* Acquisition footer */}
                <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>

                  {/* Lease row */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                        <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>
                          {formatMoney(type.weeklyLease)}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>/wk</span>
                      </div>
                      <div style={{ fontSize: 11, color: cashWarning ? 'var(--red)' : 'var(--text-muted)', marginTop: 1 }}>
                        {isFinite(weeksOfCash)
                          ? <>{weeksOfCash} wks runway{cashWarning && <> <Glyph e="⚠" size={11} /></>}</>
                          : 'No lease costs yet'}
                      </div>
                    </div>
                    <button
                      className="btn btn-primary aircraft-lease-btn"
                      onClick={() => setCheckout({ typeId: type.id, mode: 'lease' })}
                    >
                      Lease →
                    </button>
                  </div>

                  {/* Buy row */}
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    paddingTop: 8, borderTop: '1px solid var(--border-subtle)',
                  }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 18, fontWeight: 700, color: canAffordBuy ? 'var(--green)' : 'var(--text-dim)' }}>
                          {formatMoney(buyPrice)}
                        </span>
                        {discPct > 0 && (
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                            background: 'rgba(63,185,80,0.15)', color: 'var(--green)',
                            border: '1px solid rgba(63,185,80,0.3)',
                          }}>
                            -{discPct}% fleet
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                        buy outright · no weekly lease
                      </div>
                    </div>
                    <button
                      className="btn aircraft-lease-btn"
                      style={{
                        background: canAffordBuy ? 'rgba(63,185,80,0.15)' : 'var(--surface3)',
                        color: canAffordBuy ? 'var(--green)' : 'var(--text-dim)',
                        border: `1px solid ${canAffordBuy ? 'rgba(63,185,80,0.4)' : 'var(--border)'}`,
                        cursor: canAffordBuy ? 'pointer' : 'not-allowed',
                      }}
                      disabled={!canAffordBuy}
                      onClick={() => canAffordBuy && setCheckout({ typeId: type.id, mode: 'buy' })}
                    >
                      {canAffordBuy ? 'Buy →' : 'Can\'t afford'}
                    </button>
                  </div>

                </div>
              </div>
            </div>
          );
        })}
      </div>
      )}
      </>
      )}

      {/* Checkout modal */}
      {checkout && (
        <AircraftCheckout
          typeId={checkout.typeId}
          mode={checkout.mode}
          onClose={() => setCheckout(null)}
        />
      )}
    </div>
  );
}
