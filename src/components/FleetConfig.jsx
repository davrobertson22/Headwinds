import { Glyph, GlyphLabel } from './Icons.jsx';
import { useState } from 'react';
import CabinTemplatePicker from './CabinTemplatePicker.jsx';
import CabinFloorPlan from './CabinFloorPlan.jsx';
import { CabinBrushes, ProductRow, useNarrow } from './CabinDesigner.jsx';
import { liveryFor } from '../data/livery.js';
import InfoTip from './InfoTip.jsx';
import { useGame } from '../store/GameContext.jsx';
import { getAircraftType } from '../data/aircraft.js';
import {
  CLASS_FARE_MULTIPLIERS,
  CLASS_SPACE_MULTIPLIERS,
  SEAT_QUALITY_COST_PER_ROUTE,
  SEAT_QUALITY_FITTING_FEE,
  defaultConfig,
  formatMoney,
  configRangeMod,
  configSpaceQualityBonus,
  calcReconfCost,
  refitWeeks,
  classSpaceUnits,
  calendarYear,
  SERVICE_QUALITY_COST_PER_ROUTE,
  newAircraftConfig,
  orderCabinChangeCost,
} from '../utils/simulation.js';
import { isOutOfService } from '../data/maintenance.js';
import { CABIN_KEYS, productWeeklyCost, cabinProductPoints, defaultProducts, compactProducts, productOf } from '../data/seatProducts.js';
import { SEAT_QUALITY_POINTS, SERVICE_QUALITY_POINTS } from '../models/demand.js';

const SERVICE_OPTIONS = [
  { value: 'basic',    label: 'Basic',    desc: 'Buy-on-board, no frills. Saves money.' },
  { value: 'standard', label: 'Standard', desc: 'The usual meal and a drink.' },
  { value: 'premium',  label: 'Premium',  desc: 'Better crew ratio, better catering.' },
  { value: 'luxury',   label: 'Luxury',   desc: 'Named chefs, a wine list, a crew who know you.' },
];

const QUALITY_OPTIONS = [
  { value: 'basic',    label: 'Basic',    desc: 'Slimline seats. The free baseline.' },
  { value: 'standard', label: 'Standard', desc: 'Comfortable seats. Fitting fee + weekly charge.' },
  { value: 'premium',  label: 'Premium',  desc: 'Enhanced product. Boosts quality, adds weekly cost.' },
  { value: 'luxury',   label: 'Luxury',   desc: 'Flagship product. Big quality boost, premium cost.' },
];

/**
 * The downtime sentence under the refit price. Pulled out of the JSX so the
 * promise can be tested against refitWeeks() — the function the reducer
 * actually grounds the tail with. The old copy ("Aircraft is taken out of
 * service for refitting") was true of nothing: no reducer had ever grounded an
 * aircraft for a cabin job, which is half of what Knightmare reported on
 * 2026-08-27.
 */
export function refitDowntimeNote(weeks, isBulk) {
  if (!(weeks > 0)) {
    return `${isBulk ? 'The aircraft keep' : 'The aircraft keeps'} flying — nothing here needs shop time.`;
  }
  return `${isBulk ? 'Each aircraft comes' : 'The aircraft comes'} out of service for `
       + `${weeks} week${weeks === 1 ? '' : 's'} while the cabin is refitted — any routes `
       + `${isBulk ? 'they fly' : 'it flies'} stop earning until the work is done.`;
}

/**
 * The parts of a cabin an order can be delivered with, as one comparable key:
 * two configs with the same key fit the same cabin.
 */
export function cabinKey(cfg) {
  if (!cfg) return '';
  const prods = CABIN_KEYS.map(k => {
    const { tier, extras } = productOf(cfg, k);
    return `${tier.key}:${extras.map(e => e.key).sort().join('+')}`;
  });
  return JSON.stringify([cfg.firstClass ?? 0, cfg.businessClass ?? 0, cfg.premiumEconomy ?? 0, cfg.economy ?? 0,
    cfg.seatQuality ?? 'basic', cfg.serviceQuality ?? 'standard', prods]);
}

/**
 * The cabin designer, for aircraft (a refit) or for aircraft still on order.
 *   aircraftId / aircraftIds   refit one tail, or a same-type selection
 *   orderIds                   orders on the queue: the cabin is fitted on the
 *                              production line, so the frame is delivered with
 *                              it — no refit, no shop time (SET_ORDER_CABIN)
 */
export default function FleetConfig({ aircraftId, aircraftIds = null, orderIds = null, onClose }) {
  const { state, dispatch } = useGame();
  const orderMode = Array.isArray(orderIds);
  // Order mode: one tick applies the cabin to every undelivered order of the type.
  const [applyAll, setApplyAll] = useState(false);

  // Bulk mode: aircraftIds is an array of same-type aircraft; the layout chosen
  // here is applied to all of them (each pays its own refit cost).
  const targetIds = orderMode ? orderIds : (aircraftIds ?? (aircraftId ? [aircraftId] : []));
  const queue     = (state.pendingOrders ?? []).filter(o => !o.used);
  const picked    = orderMode
    ? queue.filter(o => targetIds.includes(o.id))
    : state.fleet.filter(a => targetIds.includes(a.id));
  // Every undelivered order of the picked type: what "apply to all" reaches.
  const sameType  = orderMode && picked[0] ? queue.filter(o => o.typeId === picked[0].typeId) : [];
  const selected  = orderMode && applyAll ? sameType : picked;
  // A refit needs the hangar. A tail already in a heavy check or grounded by a
  // failure cannot take a cabin job without cancelling the work it is there
  // for, so the reducer refuses it — say so here rather than letting the player
  // press Confirm on aircraft that will silently be left out. (An order has no
  // hangar to be in.)
  const targets   = orderMode ? selected : selected.filter(a => !isOutOfService(a));
  const inShop    = orderMode ? [] : selected.filter(a => isOutOfService(a));
  const isBulk    = targets.length > 1;

  // Falls back to a shop-bound tail so the modal still renders (and explains
  // itself) when every selected aircraft is out of service.
  // On order, the picked order stays the reference when "apply to all" widens the set.
  const aircraft = orderMode ? (picked[0] ?? targets[0]) : (targets[0] ?? selected[0]);
  const type     = aircraft ? getAircraftType(aircraft.typeId) : null;

  const maxSeats = type?.seats ?? 0;
  // An order placed without a cabin is delivered at the type's typical seating.
  const baseOf   = (a) => a?.config ?? (orderMode && type ? newAircraftConfig(type) : defaultConfig(maxSeats));
  const current  = baseOf(aircraft);

  const [first,  setFirst]  = useState(current.firstClass     ?? 0);
  const [biz,    setBiz]    = useState(current.businessClass  ?? 0);
  const [prem,   setPrem]   = useState(current.premiumEconomy ?? 0);
  const [ecoSeats, setEcoSeats] = useState(current.economy    ?? maxSeats);
  const [seatQ,  setSeatQ]  = useState(current.seatQuality    ?? 'basic');
  const [serviceQ, setServiceQ] = useState(current.serviceQuality ?? 'standard');
  // What is bolted into each cabin (data/seatProducts.js). Starts from the
  // aircraft's own products, every cabin at its default when it has none.
  const [products, setProducts] = useState(() => ({ ...defaultProducts(), ...(current.products ?? {}) }));
  const [brush,  setBrush]  = useState('businessClass');
  const calYear = calendarYear(state);
  // Floor per seat of each class with THESE products: the number every max,
  // clamp and the plan below agree on.
  const spaceCfg = { products };
  const space = Object.fromEntries(CABIN_KEYS.map(k => [k, classSpaceUnits(spaceCfg, k)]));
  const narrow = useNarrow();

  // A stroke on the floor plan lands in the same four states the steppers
  // edit, so the inputs, the plan and the price all move together.
  function applyPainted(cfg) {
    setFirst(cfg.firstClass ?? 0);
    setBiz(cfg.businessClass ?? 0);
    setPrem(cfg.premiumEconomy ?? 0);
    setEcoSeats(cfg.economy ?? 0);
  }

  // Apply a saved cabin template (economy clamped to remaining floor space)
  function applyTemplate(cfg) {
    const f = Math.max(0, cfg.firstClass ?? 0);
    const b = Math.max(0, cfg.businessClass ?? 0);
    const p = Math.max(0, cfg.premiumEconomy ?? 0);
    const premUnits = f * space.firstClass + b * space.businessClass + p * space.premiumEconomy;
    const maxE = Math.max(0, Math.floor((maxSeats - premUnits) / space.economy));
    setFirst(f);
    setBiz(b);
    setPrem(p);
    setEcoSeats(Math.min(Math.max(0, cfg.economy ?? 0), maxE));
    setSeatQ(cfg.seatQuality ?? 'basic');
    if (cfg.serviceQuality) setServiceQ(cfg.serviceQuality);
    // A template saved with products brings them; one without resets to the
    // defaults, as its seat counts assume the default floor per seat.
    setProducts({ ...defaultProducts(), ...(cfg.products ?? {}) });
  }

  // Premium classes take more floor space: First=2×, Business=1.5×, PremEco=1.25×,
  // times whatever seat product is fitted there (a lie-flat, a suite).
  const premiumUnits = first * space.firstClass + biz * space.businessClass + prem * space.premiumEconomy;
  // Economy is player-set, but capped to the floor units left after premium
  // cabins — at ITS pitch, so a 28" cabin fits more rows.
  const ecoMax = Math.max(0, Math.floor((maxSeats - premiumUnits + 1e-9) / space.economy));
  const eco    = Math.min(Math.max(0, ecoSeats), ecoMax);
  const usedUnits  = premiumUnits + eco * space.economy;

  // Change a cabin's product. If the new seat is bigger than the floor allows,
  // that cabin gives up seats to fit rather than leaving the layout "over".
  function setProduct(cls, patch) {
    const next = { ...products, [cls]: { ...products[cls], ...patch } };
    const sp = (k) => classSpaceUnits({ products: next }, k);
    const counts = { firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco };
    const others = CABIN_KEYS.filter(k => k !== cls).reduce((t, k) => t + counts[k] * sp(k), 0);
    const fit = Math.max(0, Math.floor((maxSeats - others + 1e-9) / sp(cls)));
    if (counts[cls] > fit) {
      ({ firstClass: setFirst, businessClass: setBiz, premiumEconomy: setPrem, economy: setEcoSeats })[cls](fit);
    }
    setProducts(next);
  }
  function toggleExtra(cls, key) {
    const have = products[cls].extras ?? [];
    setProduct(cls, { extras: have.includes(key) ? have.filter(k => k !== key) : [...have, key] });
  }
  const emptyUnits = Math.max(0, maxSeats - usedUnits);   // deliberately unfilled floor
  const over = premiumUnits > maxSeats;

  // Density dynamics preview (range + comfort from a lighter / roomier cabin).
  const previewConfig = { firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco, products: compactProducts(products) };
  const baseRangeKm   = Math.round((type?.range ?? 0) * (aircraft?.rangeMod ?? 1.0));
  const cfgRangeKm     = Math.round(baseRangeKm * configRangeMod(previewConfig, type));
  const rangeGainPct   = baseRangeKm > 0 ? Math.round((cfgRangeKm / baseRangeKm - 1) * 100) : 0;
  const spaceQualityBonus = configSpaceQualityBonus(previewConfig, type);

  // Reconfiguration cost — in bulk mode each aircraft pays its own refit cost
  // (they may start from different current layouts).
  const nextConfig = {
    firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco,
    seatQuality: seatQ, serviceQuality: serviceQ,
    // Only carried when something is above the defaults, so a cabin that
    // never touched the products stays a legacy config byte for byte.
    ...(compactProducts(products) ? { products: compactProducts(products) } : {}),
  };
  // Quality by audience: what a leisure passenger in economy sees, and what a
  // business passenger up front sees. Seat grade and service reach everyone.
  const sharedPts   = (SEAT_QUALITY_POINTS[seatQ] ?? 0) + (SERVICE_QUALITY_POINTS[serviceQ] ?? 0);
  const productPts  = cabinProductPoints(nextConfig);
  const leisurePts  = sharedPts + productPts.leisure;
  const businessPts = sharedPts + productPts.business;
  const productsWeekly = productWeeklyCost(nextConfig);
  // An order pays the difference in line fitting (the reducer's own
  // orderCabinChangeCost); a tail pays the refit.
  const perAircraftCosts = targets.map(a => orderMode
    ? orderCabinChangeCost(baseOf(a), nextConfig)
    : calcReconfCost(a.config ?? defaultConfig(maxSeats), nextConfig)
  );
  const reconfCost = perAircraftCosts.reduce((s, c) => s + c, 0);
  const canAfford  = state.cash >= reconfCost;
  // On order, taking something out or changing the service is free but still a
  // change worth saving; on a tail, a free refit changes nothing billable.
  const nextKey    = cabinKey(nextConfig);
  const noChange   = orderMode ? targets.every(a => cabinKey(baseOf(a)) === nextKey) : reconfCost === 0;
  // Shop time, from the same function the reducer grounds the tail with — so
  // the number promised here is the number the player gets.
  const downWeeks  = !orderMode && targets.length
    ? Math.max(...targets.map(a => refitWeeks(getAircraftType(a.typeId), a.config ?? defaultConfig(maxSeats), nextConfig)))
    : 0;

  function handleSave() {
    if (over || !canAfford || targets.length === 0) return;
    if (orderMode) {
      dispatch({ type: 'SET_ORDER_CABIN', orderIds: targets.map(o => o.id), config: nextConfig });
      onClose();
      return;
    }
    // One atomic action instead of N serialized CONFIGURE_AIRCRAFT dispatches:
    // the whole batch reconfigures (and is charged once, for the summed cost) or
    // not at all — no partially-refit fleet if a mid-loop server write is refused
    // after this modal has already closed. Per-tail costs still sum client-side
    // for the affordability check; the server re-derives the total.
    dispatch({
      type:        'CONFIGURE_AIRCRAFT_BULK',
      aircraftIds: targets.map(a => a.id),
      config:      nextConfig,
      reconfCost,
    });
    onClose();
  }

  // Revenue index: blended fare multiplier vs all-economy
  const revenueIndex = maxSeats > 0
    ? (first / maxSeats) * CLASS_FARE_MULTIPLIERS.firstClass     +
      (biz   / maxSeats) * CLASS_FARE_MULTIPLIERS.businessClass  +
      (prem  / maxSeats) * CLASS_FARE_MULTIPLIERS.premiumEconomy +
      (eco   / maxSeats) * CLASS_FARE_MULTIPLIERS.economy
    : 1;

  const extraQualityCost = SEAT_QUALITY_COST_PER_ROUTE[seatQ] ?? 0;

  if (!aircraft || !type) return null;

  return (
    <div className="bankrupt-overlay" onClick={onClose}>
      <div
        className="fleet-config-modal"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
                 padding: 28, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700 }}>
              {orderMode
                ? (isBulk ? `Cabin for ${targets.length} × ${type.name} on order` : `Cabin for ${aircraft.name} (on order)`)
                : (isBulk ? `Configure ${targets.length} × ${type.name}` : `Configure ${aircraft.name}`)}
            </h2>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {type.name} · {maxSeats} total seats · Current cash: <strong style={{ color: 'var(--green)' }}>{formatMoney(state.cash)}</strong>
            </div>
            {isBulk && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, maxWidth: 420 }}>
                Applying to: {targets.slice(0, 6).map(a => a.name).join(', ')}{targets.length > 6 ? `, +${targets.length - 6} more` : ''}
              </div>
            )}
            {orderMode && sameType.length > picked.length && (
              <label data-apply-all style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={applyAll} onChange={e => setApplyAll(e.target.checked)} />
                Apply to all {sameType.length} {type.name} orders still to be delivered
              </label>
            )}
          </div>
          <button className="btn btn-ghost" style={{ padding: '4px 10px', flexShrink: 0 }} onClick={onClose}><Glyph e="✕" /></button>
        </div>

        <div className="fleet-config-grid">
        {/* The cabin, drawn in the aircraft: every seat in the inputs is on the
            plan, and each cabin's length is its share of the floor. Pinned
            beside the controls on wide screens so it changes as you edit. */}
        <div className="fleet-config-plan">
          <CabinBrushes brush={brush} onBrush={setBrush} />
          <CabinFloorPlan
            type={type}
            config={previewConfig}
            livery={liveryFor(state)}
            maxSeats={maxSeats}
            maxHeight="var(--cabin-plan-max-h)"
            orientation={narrow ? 'vertical' : 'horizontal'}
            editable={{ brush, onChange: applyPainted }}
          />
        </div>

        <div className="fleet-config-controls">
        {/* Cabin Layout */}
        <div style={{ marginBottom: 22 }}>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Cabin Layout
            <InfoTip text="Any mix works, including all-premium. Premium cabins earn more per seat but each route only has so many premium flyers: overdo it and those seats fly empty. Leaving floor space unused adds range and comfort." />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Set seats per cabin, or hit Max to fill the remaining floor with one class.
            {orderMode
              ? ' Fitted on the production line: no charge for moving seats, only the install fee for new premium seats ($200 prem-eco, $500 business, $1,000 first), the seat grade and any seat products.'
              : ' Refits cost $2,500 per seat moved, plus an install fee for new premium seats ($200 prem-eco, $500 business, $1,000 first).'}
          </div>

          <CabinTemplatePicker
            typeId={aircraft.typeId}
            currentConfig={nextConfig}
            onApply={applyTemplate}
          />

          <ClassInput
            label="First Class"
            fareLabel={`${CLASS_FARE_MULTIPLIERS.firstClass}× fare`}
            spaceLabel={`${+space.firstClass.toFixed(2)}× space`}
            revPerSpace={(CLASS_FARE_MULTIPLIERS.firstClass / CLASS_SPACE_MULTIPLIERS.firstClass).toFixed(1)}
            value={first}
            max={Math.floor((maxSeats - biz * space.businessClass - prem * space.premiumEconomy + 1e-9) / space.firstClass)}
            onChange={v => setFirst(v)}
            color="#bc8cff"
          />
          <ClassInput
            label="Business Class"
            fareLabel={`${CLASS_FARE_MULTIPLIERS.businessClass}× fare`}
            spaceLabel={`${+space.businessClass.toFixed(2)}× space`}
            revPerSpace={(CLASS_FARE_MULTIPLIERS.businessClass / CLASS_SPACE_MULTIPLIERS.businessClass).toFixed(1)}
            value={biz}
            max={Math.floor((maxSeats - first * space.firstClass - prem * space.premiumEconomy + 1e-9) / space.businessClass)}
            onChange={v => setBiz(v)}
            color="#ffb43d"
          />
          <ClassInput
            label="Premium Economy"
            fareLabel={`${CLASS_FARE_MULTIPLIERS.premiumEconomy}× fare`}
            spaceLabel={`${+space.premiumEconomy.toFixed(2)}× space`}
            revPerSpace={(CLASS_FARE_MULTIPLIERS.premiumEconomy / CLASS_SPACE_MULTIPLIERS.premiumEconomy).toFixed(1)}
            value={prem}
            max={Math.floor((maxSeats - first * space.firstClass - biz * space.businessClass + 1e-9) / space.premiumEconomy)}
            onChange={v => setPrem(v)}
            color="#3ea6ff"
          />

          {/* Economy (player-set, capped to floor units left after premium cabins) */}
          <ClassInput
            label="Economy"
            fareLabel="1× fare"
            spaceLabel={`${+space.economy.toFixed(2)}× space`}
            revPerSpace="1.0"
            value={eco}
            max={ecoMax}
            onChange={v => setEcoSeats(v)}
            color="#38d39f"
          />

          {/* Floor used — the plan above shows where */}
          <div style={{ marginTop: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ color: over ? 'var(--red)' : 'var(--text-muted)' }}>
                {over
                  ? <GlyphLabel size={12} text={`⚠ Over by ${(usedUnits - maxSeats).toFixed(2)} seat units, reduce a class`} />
                  : `${usedUnits.toFixed(1)} / ${maxSeats} seat units used${emptyUnits >= 1 ? ` · ${emptyUnits.toFixed(0)} empty` : ''}`}
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                {first + biz + prem + eco} physical seats total
              </span>
            </div>
          </div>

          {/* Density dynamics: range + comfort from a lighter, roomier cabin */}
          {(rangeGainPct !== 0 || spaceQualityBonus > 0) && (
            <div style={{ display: 'flex', gap: 16, marginTop: 12, padding: '10px 12px', background: 'var(--surface2)', borderRadius: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>
                Range <strong style={{ color: rangeGainPct < 0 ? 'var(--red)' : 'var(--accent)' }}>{rangeGainPct > 0 ? '+' : ''}{rangeGainPct}%</strong>
                <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>({baseRangeKm.toLocaleString()} → {cfgRangeKm.toLocaleString()} km)</span>
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                Cabin comfort <strong style={{ color: 'var(--green)' }}>+{spaceQualityBonus}</strong> quality
              </span>
            </div>
          )}
        </div>

        {/* Cabin products: what is bolted into each cabin */}
        <div style={{ marginBottom: 22 }} data-cabin-products>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Cabin Products
            <InfoTip text="Each cabin's seat: pitch in economy, lie-flats and suites up front, screens and power as extras. A product changes the floor each seat takes (the plan redraws), a weekly upkeep, and the quality the people sitting there see: economy's reaches leisure travellers, the premium cabins' reaches business travellers." />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            A bigger seat takes more floor and the cabin gives up seats to fit. Products not yet invented in this world, or that need a bigger airframe, are greyed out.
          </div>
          {CABIN_KEYS.filter(k => ({ firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco })[k] > 0).map(cls => (
            <ProductRow
              key={cls}
              cls={cls}
              seats={({ firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco })[cls]}
              products={products}
              currentConfig={current}
              calYear={calYear}
              type={type}
              onTier={tier => setProduct(cls, { tier })}
              onExtra={key => toggleExtra(cls, key)}
            />
          ))}
        </div>

        {/* Seat quality */}
        <div style={{ marginBottom: 22 }}>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Seat Quality
            <InfoTip text="Classes decide the layout; seat quality decides the hardware in every one of those seats. A luxury-seat economy cabin beats a basic one for demand, at a cost. Think slimline vs. plush: same class, different seat." />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            The seat hardware fitted throughout this aircraft. Basic is free. Better seats
            lift demand but cost a one-off fitting fee plus a weekly charge per route.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
            <QualityPicker
              label="Seat Quality"
              value={seatQ}
              onChange={setSeatQ}
              current={current.seatQuality ?? 'basic'}
              hint={seatQ === 'basic'
                ? 'Free · no fitting fee, no weekly charge'
                : `One-off fit ${formatMoney(SEAT_QUALITY_FITTING_FEE[seatQ] ?? 0)} · +${formatMoney(SEAT_QUALITY_COST_PER_ROUTE[seatQ] ?? 0)}/route/wk`}
            />
            <QualityPicker
              label="Service"
              options={SERVICE_OPTIONS}
              value={serviceQ}
              onChange={setServiceQ}
              current={current.serviceQuality ?? 'standard'}
              hint={(() => {
                const c = SERVICE_QUALITY_COST_PER_ROUTE[serviceQ] ?? 0;
                const pts = SERVICE_QUALITY_POINTS[serviceQ] ?? 0;
                return `${c < 0 ? `Saves ${formatMoney(-c)}` : c > 0 ? `+${formatMoney(c)}` : 'No charge'}/route/wk · ${pts >= 0 ? '+' : ''}${pts} quality`;
              })()}
            />
          </div>
        </div>

        {/* Preview */}
        <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8 }}>
            <PreviewStat
              label="Revenue index vs all-economy"
              value={`${revenueIndex.toFixed(2)}×`}
              color={revenueIndex > 1 ? 'var(--green)' : 'var(--text-muted)'}
            />
            <PreviewStat
              label="Extra quality cost / route / wk"
              value={extraQualityCost + productsWeekly > 0 ? `+${formatMoney(extraQualityCost + productsWeekly)}` : 'None'}
              color={extraQualityCost + productsWeekly > 0 ? 'var(--red)' : 'var(--text-muted)'}
            />
            <PreviewStat
              label="Quality seen by leisure · business"
              value={`${leisurePts >= 0 ? '+' : ''}${Math.round(leisurePts)} · ${businessPts >= 0 ? '+' : ''}${Math.round(businessPts)}`}
              color={businessPts > 0 || leisurePts > 0 ? 'var(--green)' : 'var(--text-muted)'}
            />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Premium seats earn more but draw from a smaller pool of flyers. Pack in too many and they fly empty.
          </div>
        </div>

        {inShop.length > 0 && (
          <div style={{
            padding: '10px 14px', marginBottom: 12, borderRadius: 8, fontSize: 12,
            background: 'rgba(248,81,73,.08)', border: '1px solid rgba(248,81,73,.3)', color: 'var(--text-muted)',
          }}>
            <Glyph e="🔧" /> {inShop.length} selected aircraft {inShop.length === 1 ? 'is' : 'are'} already out of service and
            {' '}{inShop.length === 1 ? 'is' : 'are'} not included — refit {inShop.length === 1 ? 'it' : 'them'} once {inShop.length === 1 ? 'it is' : 'they are'} back in service.
          </div>
        )}

        {/* Reconfiguration cost banner */}
        {!noChange && (
          <div style={{
            padding: '12px 16px',
            marginBottom: 16,
            borderRadius: 8,
            background: canAfford ? 'rgba(56,139,253,.08)' : 'rgba(248,81,73,.08)',
            border: `1px solid ${canAfford ? 'var(--accent-dim)' : 'rgba(248,81,73,.3)'}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {orderMode ? 'Fitting on the line: ' : 'Reconfiguration cost: '}
                  <span style={{ color: canAfford ? 'var(--accent)' : 'var(--red)' }}>{orderMode && reconfCost === 0 ? 'no charge' : formatMoney(reconfCost)}</span>
                  {isBulk && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>across {targets.length} {orderMode ? 'orders' : 'aircraft'}</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }} data-order-cabin-note={orderMode ? '' : undefined}>
                  {orderMode
                    ? `${reconfCost > 0 ? 'Paid now. ' : ''}${isBulk ? 'Each aircraft is' : 'The aircraft is'} delivered with this cabin: no refit and no downtime.`
                    : <>Paid immediately. {refitDowntimeNote(downWeeks, isBulk)}</>}
                </div>
              </div>
              {!canAfford && (
                <span className="badge badge-red">Can't afford</span>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="btn btn-primary"
            style={{ flex: 1, padding: 10 }}
            onClick={handleSave}
            disabled={over || targets.length === 0 || (!noChange && !canAfford)}
          >
            {noChange ? 'No Changes'
              : orderMode
                ? `Save cabin${isBulk ? ` (${targets.length} orders)` : ''}${reconfCost > 0 ? ` · ${formatMoney(reconfCost)}` : ''}`
                : `Confirm Refit${isBulk ? ` (${targets.length} aircraft)` : ''} · ${formatMoney(reconfCost)}`}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
        </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ClassInput({ label, fareLabel, spaceLabel, revPerSpace, value, max, onChange, color }) {
  const clamp = v => Math.min(max, Math.max(0, v));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
      <div style={{ width: 12, height: 12, borderRadius: 2, background: color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {fareLabel} · {spaceLabel} ·{' '}
          <span title="Revenue potential per unit of floor space, higher is more efficient use of the cabin">
            {revPerSpace}× rev/space
          </span>
        </div>
      </div>
      <div className="seat-stepper">
        <button type="button" aria-label={`Fewer ${label} seats`} onClick={() => onChange(clamp(value - 1))} disabled={value <= 0}>−</button>
        <input
          type="number"
          min={0}
          max={max}
          value={value}
          onChange={e => onChange(clamp(parseInt(e.target.value, 10) || 0))}
        />
        <button type="button" aria-label={`More ${label} seats`} onClick={() => onChange(clamp(value + 1))} disabled={value >= max}>+</button>
      </div>
      <button
        type="button"
        className="seat-max-btn"
        title={`Fill the remaining floor space with ${label} (${max} seats max)`}
        onClick={() => onChange(max)}
        disabled={value >= max}
      >
        Max
      </button>
    </div>
  );
}

function QualityPicker({ label, value, onChange, current, hint, options = QUALITY_OPTIONS }) {
  const changed = value !== current;
  return (
    <div>
      <div className="form-label">{label} {changed && <span style={{ color: 'var(--yellow)', fontSize: 10 }}>CHANGED</span>}</div>
      <select className="form-select" value={value} onChange={e => onChange(e.target.value)}>
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
        ))}
      </select>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{hint}</div>
    </div>
  );
}

function PreviewStat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color }}>{value}</div>
    </div>
  );
}
