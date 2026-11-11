import { useState } from 'react';
import NumberStepper from './NumberStepper.jsx';
import { useGame } from '../store/GameContext.jsx';
import { getAircraftType, effectivePurchasePrice, eraPurchasePrice, eraWeeklyLease, orderDiscount,
         LEASE_TERM_OPTIONS, DEFAULT_LEASE_TERM_WEEKS, leaseTermRateMultiplier,
         leaseOrderBookCap, canFitWifi, wifiAirframeDenial } from '../data/aircraft.js';
import {
  formatMoney,
  CLASS_FARE_MULTIPLIERS,
  CLASS_SPACE_MULTIPLIERS,
  SEAT_QUALITY_COST_PER_ROUTE,
  SEAT_QUALITY_FITTING_FEE,
  SERVICE_QUALITY_COST_PER_ROUTE,
  cabinInstallFee,
  classSpaceUnits,
  weekToGameDate,
  configRangeMod, calendarYear, cruiseSpeedKmh, typicalSeatsOf } from '../utils/simulation.js';
import {
  wifiInstallCost, wifiRetrofitCost, wifiLeaseSurcharge, WIFI_WEEKLY_OPEX,
} from '../data/wifi.js';
import { featureLive, ERA_FEATURE_MESSAGE } from '../data/eraFeatures.js';
import { absoluteWeek } from '../utils/fuel.js';
import { deliverySchedule, deliveryLead } from '../data/delivery.js';
import { makeSlotAllocator, slotCalendar, PRIORITY_FEE_CAP, EARLY_SLOT_MAX_PREMIUM, launchWindow, launchOrderDiscount, lineInfo, lineOf } from '../data/productionLines.js';
import { Glyph, GlyphLabel } from './Icons.jsx';
import CabinTemplatePicker from './CabinTemplatePicker.jsx';
import CabinFloorPlan from './CabinFloorPlan.jsx';
import { CabinBrushes, ProductRow, useMediaQuery } from './CabinDesigner.jsx';
import { liveryFor } from '../data/livery.js';
import { CABIN_KEYS, productFittingCost, productWeeklyCost, defaultProducts, compactProducts } from '../data/seatProducts.js';
import { SERVICE_QUALITY_POINTS } from '../models/demand.js';
import {
  LABOR_GROUPS, CREW_LEAD_WEEKS, crewScaleFor, crewBodies, crewHireCost, crewAvailable, crewOnTheWay,
  crewRequiredForOrderBook,
} from '../data/labor.js';
import { ReplacesSection, replacesForDispatch } from './FleetRenewal.jsx';

const CAT_COLORS = {
  'Turboprop':    '#ffb43d',
  'Regional Jet': '#38d39f',
  'Narrow Body':  '#3ea6ff',
  'Wide Body':    '#a98bff',
};

const QUALITY_OPTIONS = [
  { value: 'basic',    label: 'Basic',    desc: 'Budget fittings, no frills.' },
  { value: 'standard', label: 'Standard', desc: 'Comfortable, no-nonsense.' },
  { value: 'premium',  label: 'Premium',  desc: 'Enhanced seats, better meals.' },
  { value: 'luxury',   label: 'Luxury',   desc: 'Flagship product. Premium cost.' },
];

const SERVICE_OPTIONS = [
  { value: 'basic',    label: 'Basic',    desc: 'Buy-on-board, no frills. Saves money.' },
  { value: 'standard', label: 'Standard', desc: 'The usual meal and a drink.' },
  { value: 'premium',  label: 'Premium',  desc: 'Better crew ratio, better catering.' },
  { value: 'luxury',   label: 'Luxury',   desc: 'Named chefs, a wine list, a crew who know you.' },
];

const CLASS_COLORS = {
  firstClass:     '#bc8cff',
  businessClass:  '#ffb43d',
  premiumEconomy: '#3ea6ff',
  economy:        '#38d39f',
};


function absWeekToDisplay(absWeek) {
  const year       = Math.floor((absWeek - 1) / 52) + 1;
  const weekInYear = ((absWeek - 1) % 52) + 1;
  const { monthName, weekInMonth } = weekToGameDate(weekInYear);
  return { displayYear: year, displayWeek: weekInYear, monthName, weekInMonth };
}

function AircraftPhoto({ src, alt, category }) {
  const [failed, setFailed] = useState(false);
  const color = CAT_COLORS[category] || '#93a4ba';
  if (failed || !src) {
    return (
      <div style={{
        width: '100%', height: 160,
        background: `linear-gradient(160deg, ${color}18 0%, transparent 100%)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: '10px 10px 0 0',
      }}>
        <span style={{ fontSize: 56, opacity: 0.2 }}><Glyph e="✈" /></span>
      </div>
    );
  }
  return (
    <img src={src} alt={alt}
      style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: '10px 10px 0 0', display: 'block' }}
      onError={() => setFailed(true)}
    />
  );
}

// ── Compact class row with inline +/- ────────────────────────────────────────
function ClassRow({ label, color, fareLabel, spaceLabel, value, max, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '7px 0',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
          {fareLabel} · {spaceLabel}
        </div>
      </div>
      {/* − / value / + */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <button
          onClick={() => onChange(Math.max(0, value - 1))}
          disabled={value === 0}
          style={{
            width: 26, height: 26, borderRadius: 5,
            border: '1px solid var(--border)', background: 'var(--surface2)',
            color: value === 0 ? 'var(--text-dim)' : 'var(--text)',
            cursor: value === 0 ? 'default' : 'pointer',
            fontSize: 16, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >−</button>
        <input
          type="number" min={0} max={max} value={value}
          onChange={e => onChange(Math.min(max, Math.max(0, parseInt(e.target.value, 10) || 0)))}
          style={{
            width: 50, textAlign: 'center', fontSize: 14, fontWeight: 600,
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 5, color: 'var(--text)', padding: '3px 4px',
          }}
        />
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          style={{
            width: 26, height: 26, borderRadius: 5,
            border: '1px solid var(--border)', background: 'var(--surface2)',
            color: value >= max ? 'var(--text-dim)' : 'var(--text)',
            cursor: value >= max ? 'default' : 'pointer',
            fontSize: 16, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >+</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', width: 30, textAlign: 'right', flexShrink: 0 }}>
        seats
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

// `replaceIds` presets the "Replaces" block (Fleet ▸ bulk replace); `onOrdered`
// runs after a successful dispatch, before onClose.
//   initialConfig: an optional cabin to open the form with (classes, seat and
//             service grade, products) instead of the type's typical cabin.
export default function AircraftCheckout({ typeId, mode, onClose, replaceIds = null, onOrdered = null, defaultPriority = false, initialConfig = null }) {
  const { state, dispatch, remote } = useGame();
  const { cash, fleet, pendingOrders = [], year, week } = state;

  // Headwinds multiplayer only: the first 2 aircraft a player ever takes deliver
  // instantly. `starterDeliveriesRemaining` > 0 means this order (and the next,
  // up to the cap) skips the delivery wait entirely.
  const STARTER_DELIVERY_CAP     = 2;
  const starterDeliveriesRemaining = remote
    ? Math.max(0, STARTER_DELIVERY_CAP - (state.starterDeliveriesUsed ?? 0))
    : 0;

  const type = getAircraftType(typeId);
  // The `!type` guard is deliberately BELOW every hook in this component rather
  // than here. React requires the same hooks in the same order on every render;
  // returning above them meant an unknown typeId rendered a different number of
  // hooks than a known one, so any render that changed `typeId` from unknown to
  // known (or back) while this modal stayed mounted would throw "Rendered more
  // hooks than during the previous render" and unmount the tree. That is the
  // same fault that black-screened every new game from App.jsx. Everything
  // between here and the guard therefore tolerates a null type.
  const isFreighter   = !!type?.freighter;
  const catColor      = CAT_COLORS[type?.category] || '#93a4ba';
  const configOptions = type?.configOptions ?? {};
  const engines       = configOptions.engines ?? [];
  const wingtipDef    = configOptions.wingtips ?? null;
  const maxSeats      = type?.seats ?? 0;

  // ── Engine / wingtip ──────────────────────────────────────────────────────
  const defaultEngine = engines.find(e => e.default) ?? engines[0];
  const [selectedEngineId, setSelectedEngineId] = useState(defaultEngine?.id ?? null);
  const [hasWingtips, setHasWingtips]            = useState(false);
  // "Keep me fully staffed" can be switched on from the order itself.
  const [staffForMe, setStaffForMe]              = useState(true);
  // Line-fit connectivity. Cheaper now than retrofitting later (see data/wifi.js),
  // which is the whole reason it belongs on the order form rather than only on
  // the Fleet page.
  const [hasWifi, setHasWifi]                    = useState(false);

  // ── Production lines (data/productionLines.js) ───────────────────────────
  // Shared factory line per family. A standard order queues at list; a
  // priority order may use the held-back share, starts at the build time and
  // pays per week saved. An announced, not-yet-flying type is a launch order.
  const linesWorld  = state.productionLinesWorld === true;
  const launchTerms = (() => {
    if (!linesWorld || mode !== 'buy' || !type) return null;
    const lw = launchWindow(state, type);
    return lw?.open ? lw : null;
  })();
  const isLaunch = !!launchTerms;
  // null = the standard week; an absWeek = start looking there (standard only).
  const [slotFrom, setSlotFrom] = useState(null);
  const [priority, setPriority] = useState(defaultPriority === true);

  // ── Quantity ──────────────────────────────────────────────────────────────
  const [quantity, setQuantity] = useState(Math.max(launchTerms?.minQty ?? 1, Math.min(100, replaceIds?.length || 1)));

  // ── Fleet renewal: which existing tails these frames take over from ──────
  const [replaceSel, setReplaceSel]           = useState(replaceIds ?? []);
  const [replaceDisposal, setReplaceDisposal] = useState('dispose');

  // ── Lease term (only relevant when leasing) ───────────────────────────────
  const [leaseTermWeeks, setLeaseTermWeeks] = useState(DEFAULT_LEASE_TERM_WEEKS);

  // ── Custom name (optional) ────────────────────────────────────────────────
  const [customName, setCustomName] = useState('');

  // ── Cabin configuration ───────────────────────────────────────────────────
  const [first, setFirstRaw] = useState(initialConfig?.firstClass ?? 0);
  const [biz,   setBizRaw]   = useState(initialConfig?.businessClass ?? 0);
  const [prem,  setPremRaw]  = useState(initialConfig?.premiumEconomy ?? 0);
  // A new aircraft arrives at the type's TYPICAL seating, where its headline range
  // applies; packing it up to the exit limit costs range (payloadRangeMod).
  const [eco,   setEcoRaw]   = useState(initialConfig?.economy ?? typicalSeatsOf(type));
  const [seatQ, setSeatQ]    = useState(initialConfig?.seatQuality ?? 'basic');
  const [serviceQ, setServiceQ] = useState(initialConfig?.serviceQuality ?? 'standard');
  // The cabin designer (CabinDesigner.jsx), the same one the refit modal uses:
  // what is bolted into each cabin, and the brush for painting on the plan.
  // Designing the cabin here means the aircraft is DELIVERED with it — no
  // refit, no weeks in the shop after it arrives (Discord: VF84, 2026-11-08).
  const [products, setProducts] = useState(() => ({ ...defaultProducts(), ...(initialConfig?.products ?? {}) }));
  const [brush, setBrush]       = useState('businessClass');
  // Wide screens put the plan beside the form; otherwise it sits in the cabin
  // section, nose-up on phones. False during SSR, so the inline plan is the
  // markup every test and first paint sees.
  const wide   = useMediaQuery('(min-width: 1100px)');
  const narrow = useMediaQuery('(max-width: 640px)');

  // Every hook above has now run unconditionally. Safe to bail.
  if (!type) return null;

  const calYear = calendarYear(state);   // era worlds: product dates, and the new-build premium while the line is open (null = classic)
  // Floor per seat of each class with THESE products: the number every max,
  // clamp and the plan agree on (a 28" pitch fits more, a lie-flat fewer).
  const space = Object.fromEntries(CABIN_KEYS.map(k => [k, classSpaceUnits({ products }, k)]));

  // Clamp economy whenever premium classes change to avoid over-allocation
  function clampEco(f, b, p, currentEco) {
    const premUnits = f * space.firstClass + b * space.businessClass + p * space.premiumEconomy;
    const maxE = Math.max(0, Math.floor((maxSeats - premUnits + 1e-9) / space.economy));
    return Math.min(currentEco, maxE);
  }
  // A stroke on the floor plan lands in the same four states the steppers edit.
  function applyPainted(cfg) {
    setFirstRaw(cfg.firstClass ?? 0);
    setBizRaw(cfg.businessClass ?? 0);
    setPremRaw(cfg.premiumEconomy ?? 0);
    setEcoRaw(cfg.economy ?? 0);
  }
  // Change a cabin's product. If the new seat is bigger than the floor allows,
  // that cabin gives up seats to fit rather than leaving the layout "over".
  function setProduct(cls, patch) {
    const next = { ...products, [cls]: { ...products[cls], ...patch } };
    const sp = (k) => classSpaceUnits({ products: next }, k);
    const counts = { firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco };
    const others = CABIN_KEYS.filter(k => k !== cls).reduce((t, k) => t + counts[k] * sp(k), 0);
    const fit = Math.max(0, Math.floor((maxSeats - others + 1e-9) / sp(cls)));
    if (counts[cls] > fit) {
      ({ firstClass: setFirstRaw, businessClass: setBizRaw, premiumEconomy: setPremRaw, economy: setEcoRaw })[cls](fit);
    }
    setProducts(next);
  }
  function toggleExtra(cls, key) {
    const have = products[cls].extras ?? [];
    setProduct(cls, { extras: have.includes(key) ? have.filter(k => k !== key) : [...have, key] });
  }
  function setFirst(v) { setFirstRaw(v); setEcoRaw(e => clampEco(v,   biz,  prem, e)); }
  function setBiz(v)   { setBizRaw(v);   setEcoRaw(e => clampEco(first, v,   prem, e)); }
  function setPrem(v)  { setPremRaw(v);  setEcoRaw(e => clampEco(first, biz,  v,   e)); }
  function setEco(v)   { setEcoRaw(v); }

  // Apply a saved cabin template (clamped defensively to this type's floor space)
  function applyTemplate(cfg) {
    const f = Math.max(0, cfg.firstClass ?? 0);
    const b = Math.max(0, cfg.businessClass ?? 0);
    const p = Math.max(0, cfg.premiumEconomy ?? 0);
    setFirstRaw(f);
    setBizRaw(b);
    setPremRaw(p);
    // A template saved with products brings them; one without resets to the
    // defaults, as its seat counts assume the default floor per seat.
    const tplProducts = { ...defaultProducts(), ...(cfg.products ?? {}) };
    const sp = (k) => classSpaceUnits({ products: tplProducts }, k);
    const maxE = Math.max(0, Math.floor((maxSeats - f * sp('firstClass') - b * sp('businessClass') - p * sp('premiumEconomy') + 1e-9) / sp('economy')));
    setEcoRaw(Math.min(Math.max(0, cfg.economy ?? 0), maxE));
    setSeatQ(cfg.seatQuality ?? 'basic');
    if (cfg.serviceQuality) setServiceQ(cfg.serviceQuality);
    setProducts(tplProducts);
  }

  const usedUnits = first * space.firstClass + biz * space.businessClass
                  + prem * space.premiumEconomy + eco * space.economy;
  const over = usedUnits > maxSeats + 1e-9;

  const maxFirst = Math.floor(
    (maxSeats - biz * space.businessClass - prem * space.premiumEconomy - eco * space.economy + 1e-9) / space.firstClass
  );
  const maxBiz = Math.floor(
    (maxSeats - first * space.firstClass - prem * space.premiumEconomy - eco * space.economy + 1e-9) / space.businessClass
  );
  const maxPrem = Math.floor(
    (maxSeats - first * space.firstClass - biz * space.businessClass - eco * space.economy + 1e-9) / space.premiumEconomy
  );
  const maxEco = Math.max(0, Math.floor(
    (maxSeats - first * space.firstClass - biz * space.businessClass - prem * space.premiumEconomy + 1e-9) / space.economy
  ));

  // Revenue index vs all-economy
  const totalPhysical = first + biz + prem + eco;
  const revenueIndex = totalPhysical > 0
    ? (first / totalPhysical) * CLASS_FARE_MULTIPLIERS.firstClass
    + (biz   / totalPhysical) * CLASS_FARE_MULTIPLIERS.businessClass
    + (prem  / totalPhysical) * CLASS_FARE_MULTIPLIERS.premiumEconomy
    + (eco   / totalPhysical) * CLASS_FARE_MULTIPLIERS.economy
    : 1;

  const extraQualityCost = SEAT_QUALITY_COST_PER_ROUTE[seatQ] ?? 0;

  // Freighters carry cargo, not passengers — no cabin layout to choose. Pass null
  // so delivery falls back to the (irrelevant) default config.
  const orderProducts = compactProducts(products);
  const cabinConfig = isFreighter ? null : {
    firstClass:     first,
    businessClass:  biz,
    premiumEconomy: prem,
    economy:        eco,
    seatQuality:    seatQ,
    serviceQuality: serviceQ,
    // Only carried when something is above the defaults, so an order that
    // never touched the products is the same action it always was.
    ...(orderProducts ? { products: orderProducts } : {}),
  };
  const productsWeekly = cabinConfig ? productWeeklyCost(cabinConfig) : 0;

  // ── Engine / wingtip modifiers ────────────────────────────────────────────
  const selectedEngine    = engines.find(e => e.id === selectedEngineId) ?? defaultEngine;
  const engineFuelMod     = selectedEngine?.fuelMod  ?? 1.0;
  const enginePriceMod    = selectedEngine?.priceMod ?? 1.0;
  const engineMaintMod    = selectedEngine?.maintMod ?? 1.0;
  const wingtipFuelMod    = (hasWingtips && wingtipDef) ? (wingtipDef.fuelMod  ?? 1.0) : 1.0;
  const wingtipRangeMod   = (hasWingtips && wingtipDef) ? (wingtipDef.rangeMod ?? 1.0) : 1.0;
  const wingtipCost       = (hasWingtips && wingtipDef) ? (wingtipDef.cost     ?? 0)   : 0;
  const combinedFuelMod   = Math.round(engineFuelMod * wingtipFuelMod * 10000) / 10000;
  const fuelPctSaving     = Math.round((1 - combinedFuelMod) * 100);
  const rangePctGain      = Math.round((wingtipRangeMod - 1) * 100);
  const maintPctChange    = Math.round((engineMaintMod - 1) * 100);
  const effectiveRange    = Math.round(type.range * wingtipRangeMod);
  // Cabin-density range bonus (fewer passengers = more range)
  const cabinForRange     = { firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco };
  const cabinRangeMod     = configRangeMod(cabinForRange, type);
  const effectiveRangeFull = Math.round(type.range * wingtipRangeMod * cabinRangeMod);
  const cabinRangePctGain  = Math.round((cabinRangeMod - 1) * 100);

  // ── Delivery schedule ─────────────────────────────────────────────────────
  const lead           = deliveryLead(type);
  const currentAbsWeek = absoluteWeek(year, week);
  const pendingOfType  = pendingOrders.filter(o => o.typeId === typeId);

  // Starter Fleet frames skip the queue and never join it (the reducer puts
  // them straight into the fleet), so only the rest are scheduled — otherwise
  // "last in Nw" counted the instant frames as if they had queued too.
  // Launch frames never skip the queue (the aeroplane does not exist yet).
  const instantCount  = isLaunch ? 0 : Math.min(quantity, starterDeliveriesRemaining);
  // Production lines: the same allocator ORDER_AIRCRAFT uses, over the same
  // injected rival bookings — so the weeks on screen are the weeks you get
  // unless another airline books first (then the server moves you on).
  const usePriority = linesWorld && !isLaunch && priority;
  const planLine = (prio) => {
    const alloc = makeSlotAllocator(state, type, {
      absWeek:   currentAbsWeek,
      fromWeek:  (isLaunch || prio) ? null : slotFrom,
      notBefore: isLaunch ? launchTerms.eisAbs : null,
      priority:  prio,
    });
    return { alloc, slots: Array.from({ length: quantity - instantCount }, () => alloc.takeSlot()) };
  };
  const linePlan  = linesWorld ? planLine(usePriority) : null;
  // The other choice, quoted on its button so the trade is visible up front.
  const otherPlan = linesWorld && !isLaunch ? planLine(!usePriority) : null;
  const lineAlloc = linePlan?.alloc ?? null;
  const deliveryWeeks = [
    ...Array(instantCount).fill(currentAbsWeek),
    ...(linePlan
      ? linePlan.slots.map(sl => sl.week)
      : deliverySchedule(type, pendingOrders, currentAbsWeek, quantity - instantCount)),
  ];
  const firstDelivery = deliveryWeeks[0];
  const lastDelivery  = deliveryWeeks[deliveryWeeks.length - 1];
  const { displayYear: firstYear, monthName: firstMon, weekInMonth: firstWIM } = absWeekToDisplay(firstDelivery);
  const { displayYear: lastYear,  monthName: lastMon,  weekInMonth: lastWIM  } = absWeekToDisplay(lastDelivery);

  // ── Pricing ───────────────────────────────────────────────────────────────
  const fleetCountNow   = fleet.filter(a => a.typeId === typeId).length;
  const pendingCountNow = pendingOfType.length;
  const alreadyOwned    = fleetCountNow + pendingCountNow;
  const discount        = mode === 'buy'
    ? (isLaunch ? launchOrderDiscount(state, type, quantity) : orderDiscount(quantity))
    : 0;
  const discPct         = Math.round(discount * 100);

  // Two independent gates on the connectivity option, and both have been
  // wrong (Discord 2026-09-03): the WORLD has to have onboard internet in it
  // at all, and the AIRFRAME has to be able to carry an installation. A
  // Constellation fails the second in every world; a brand-new DC-6 in a 1950
  // world failed the first and was offered the package anyway.
  const wifiEraLive     = featureLive('wifi', calYear);
  const wifiFittable    = canFitWifi(type);
  const wifiOffered     = wifiEraLive && wifiFittable;
  const wantsWifi       = hasWifi && wifiOffered;
  const baseUnitPrice   = isLaunch
    ? Math.round(eraPurchasePrice(type, calYear) * (1 - discount))
    : effectivePurchasePrice(type, mode === 'buy' ? quantity : 1, calYear);
  const enginePriceAdj  = Math.round(baseUnitPrice * (enginePriceMod - 1));
  const unitBuyPrice    = Math.round(baseUnitPrice * enginePriceMod) + wingtipCost;
  // Priority fee per frame, on list price — the reducer's exact formula.
  // Bought: part of the price. Leased: a one-off fee alongside the deposit.
  const feeOf           = (pct) => Math.round(eraPurchasePrice(type, calYear) * enginePriceMod * pct);
  const framePremiums   = deliveryWeeks.map((w, i) => (linePlan && i >= instantCount)
    ? feeOf(linePlan.slots[i - instantCount].premiumPct)
    : 0);
  const totalSlotPremium = framePremiums.reduce((a, b) => a + b, 0);
  const planSummary = (plan) => plan && plan.slots.length ? {
    first: plan.slots[0].week - currentAbsWeek,
    last:  plan.slots[plan.slots.length - 1].week - currentAbsWeek,
    fee:   plan.slots.reduce((a, sl) => a + feeOf(sl.premiumPct), 0),
  } : null;
  const stdSummary = planSummary(usePriority ? otherPlan : linePlan);
  const priSummary = planSummary(usePriority ? linePlan : otherPlan);
  const totalBuyPrice   = unitBuyPrice * quantity + (mode === 'buy' ? totalSlotPremium : 0);

  const leaseRateMult    = leaseTermRateMultiplier(leaseTermWeeks);
  const baseWeeklyLease  = eraWeeklyLease(type, calYear);
  const engineLeaseAdj   = Math.round(baseWeeklyLease * (enginePriceMod - 1));
  const wingtipLeaseAdj  = (hasWingtips && wingtipDef) ? Math.round((wingtipDef.cost ?? 0) / 200) : 0;
  const wifiLeaseAdj     = wantsWifi ? wifiLeaseSurcharge() : 0;
  // Term-adjusted weekly rate: longer commitments earn a lower rate (see LEASE_TERM_OPTIONS).
  const unitWeeklyLease  = Math.round((baseWeeklyLease + engineLeaseAdj + wingtipLeaseAdj + wifiLeaseAdj) * leaseRateMult);
  const totalWeeklyLease = unitWeeklyLease * quantity;
  const unitLeaseDeposit  = unitWeeklyLease * 12;   // 3 months (12 weeks) upfront
  const totalLeaseDeposit = unitLeaseDeposit * quantity;

  // One-off upfront extras (per aircraft): seat-quality fitting fee for seats above
  // basic economy + per-seat install fee for premium cabins (first/business/prem-eco).
  const unitFittingFee  = SEAT_QUALITY_FITTING_FEE[seatQ] ?? 0;
  const unitInstallFee  = cabinInstallFee(cabinConfig);
  // Seat products fitted on the line (lie-flats, suites, screens, a bar): the
  // same productFittingCost(null, config) ORDER_AIRCRAFT adds to its fitting fee.
  const unitProductFee  = cabinConfig ? productFittingCost(null, cabinConfig) : 0;
  // Owned: connectivity capex falls due up front alongside the seat fitting fees.
  // Leased: the lessor amortises it into the rate instead (wifiLeaseAdj below),
  // so charging it here too would bill for the same antenna twice. Both mirror
  // ORDER_AIRCRAFT exactly — if these drift, the quote on screen is a lie.
  const unitWifiFee     = (wantsWifi && mode === 'buy') ? wifiInstallCost() : 0;
  const unitExtras      = unitFittingFee + unitInstallFee + unitProductFee + unitWifiFee;
  const totalFittingFee = unitFittingFee * quantity;
  const totalInstallFee = unitInstallFee * quantity;
  const totalProductFee = unitProductFee * quantity;
  const totalWifiFee    = unitWifiFee * quantity;
  const totalExtras     = unitExtras * quantity;
  const buyTotalDue     = totalBuyPrice + totalExtras;
  const leaseDepositDue = totalLeaseDeposit + totalExtras + (mode === 'lease' ? totalSlotPremium : 0);

  const canAfford     = mode === 'buy' ? cash >= buyTotalDue : cash >= leaseDepositDue;
  const maxAffordable = mode === 'buy'
    ? Math.max(0, Math.floor(cash / (unitBuyPrice + unitExtras)))
    : Math.max(0, Math.floor(cash / (unitLeaseDeposit + unitExtras)));

  // ── New World Restrictions: lease order book ──────────────────────────────
  // Inert unless the world flag is on. The engine clamps an oversized order to
  // the free slots anyway; clamping here means the number on screen is the
  // number that will actually be placed.
  const nwrRestricted  = !!state.newWorldRestrictions && mode === 'lease';
  const nwrActiveFleet = fleet.filter(a => a.status !== 'retired').length;
  const nwrOnOrder     = pendingOrders
    .filter(o => o.ownershipType === 'lease')
    .reduce((sum, o) => sum + (o.quantity ?? 1), 0);
  const nwrCap         = leaseOrderBookCap(nwrActiveFleet);
  const nwrFree        = Math.max(0, nwrCap - nwrOnOrder);
  const qtyCeiling     = nwrRestricted ? Math.max(1, Math.min(100, nwrFree)) : 100;

  function setQty(n) { setQuantity(Math.max(isLaunch ? launchTerms.minQty : 1, Math.min(qtyCeiling, n))); }

  // The order as configured, for the replacement checks: range comes from the
  // wingtips and the cabin, exactly as it will on the delivered tail.
  const replaceDraft = {
    id: '__checkout-draft', typeId, name: type.name,
    ownershipType: mode === 'buy' ? 'owned' : 'lease',
    rangeMod: Math.round(wingtipRangeMod * 10000) / 10000,
    ...(cabinConfig ? { config: cabinConfig } : {}),
  };

  function handleConfirm() {
    const replaces = replaceSel.length ? replacesForDispatch(state, replaceSel, replaceDraft, quantity, instantCount) : [];
    dispatch({
      type:          'ORDER_AIRCRAFT',
      typeId,
      ownershipType: mode === 'buy' ? 'owned' : 'lease',
      engineId:      selectedEngine?.id ?? null,
      hasWingtips,
      hasWifi:       wantsWifi,
      quantity,
      config:        cabinConfig,
      name:          customName.trim() || null,
      leaseTermWeeks: mode === 'lease' ? leaseTermWeeks : undefined,
      // Production lines: priority, or where a standard order starts looking
      // (the reducer does the rest). Omitted = the standard week, at list.
      priority:      usePriority ? true : undefined,
      slotFromWeek:  linesWorld && !isLaunch && !usePriority && slotFrom != null ? slotFrom : undefined,
      ...(replaces.length ? { replaces, replaceDisposal } : {}),
    });
    // After the order, so the switch sees the aircraft it has to crew.
    if (crewOn && !autoStaff && staffForMe && crewToHire.people > 0) dispatch({ type: 'SET_AUTO_STAFF', enabled: true });
    onOrdered?.();
    onClose();
  }

  // Crew this order needs, less trained staff the airline already has spare
  // (reserves, or people hired ahead) once everything already on order is
  // crewed. Crew-pipeline games only — elsewhere crew is instant.
  const crewOn    = state.crewPipeline === true;
  const autoStaff = crewOn && state.crewAutoStaff === true;
  const crewToHire = (() => {
    if (!crewOn) return { people: 0, cost: 0, groups: [], covered: 0 };
    const typeOf = (a) => getAircraftType(a.typeId);
    let people = 0, cost = 0, covered = 0;
    const groups = [];
    for (const g of LABOR_GROUPS) {
      const need  = crewScaleFor(g.id, type) * quantity;
      const spare = Math.max(0, crewAvailable(state.labor, g.id) + crewOnTheWay(state.labor, g.id)
        - crewRequiredForOrderBook(g.id, fleet, pendingOrders, typeOf));
      const hire = Math.max(0, need - spare);
      const n = crewBodies(g.id, hire);
      covered += crewBodies(g.id, need) - n;
      if (n > 0) groups.push(`${n.toLocaleString()} ${g.name.toLowerCase()}`);
      people += n;
      cost += crewHireCost(g.id, hire);
    }
    return { people, cost, groups, covered };
  })();

  // The cabin plan: brushes + the paintable aircraft. One element, rendered
  // beside the form on wide screens and inside the cabin section otherwise.
  const cabinPlan = isFreighter ? null : (
    <>
      <CabinBrushes brush={brush} onBrush={setBrush} />
      <CabinFloorPlan
        type={type}
        config={cabinConfig}
        livery={liveryFor(state)}
        maxSeats={maxSeats}
        maxHeight="var(--cabin-plan-max-h)"
        orientation={narrow ? 'vertical' : 'horizontal'}
        editable={{ brush, onChange: applyPainted }}
      />
    </>
  );

  // Shared section header style
  const sectionTitle = {
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10,
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`checkout-modal${wide && !isFreighter ? ' has-plan' : ''}`} style={{
        background: 'var(--surface2)', borderRadius: 10,
        width: '100%', maxHeight: '92vh', overflowY: 'auto',
        border: '1px solid var(--border)', boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
      }}>
        {/* Wide screens: the cabin plan stays pinned beside the form, so it
            changes as the classes and products below are edited. */}
        {wide && !isFreighter && (
          <div className="checkout-plan" data-checkout-plan="side">
            {cabinPlan}
          </div>
        )}
        <div className="checkout-form">
        <AircraftPhoto src={type.image} alt={type.name} category={type.category} />

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{ padding: '14px 20px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 19 }}>{type.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                {type.manufacturer} · <span style={{ color: catColor }}>{type.category}</span>
                {' · '}{isFreighter ? `${type.payloadTonnes}t payload` : `${type.seats} seats`} · {type.range.toLocaleString()} km range{!isFreighter && (typicalSeatsOf(type) < type.seats ? ` at ${typicalSeatsOf(type)} seats` : ` at all ${type.seats} seats`)} · {cruiseSpeedKmh(type).toLocaleString()} km/h cruise
              </div>
            </div>
            <button className="btn btn-ghost" onClick={onClose} style={{ padding: '4px 10px', marginLeft: 8 }}><Glyph e="✕" /></button>
          </div>

          {/* Starter Fleet perk (multiplayer only) — first 2 aircraft ship instantly */}
          {starterDeliveriesRemaining > 0 && (
            <div style={{
              marginTop: 10, padding: '8px 12px',
              background: 'rgba(56,201,180,0.12)', borderRadius: 6,
              fontSize: 12.5, color: 'var(--accent)',
              border: '1px solid rgba(56,201,180,0.35)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span><Glyph e="🎁" /></span>
              <span>
                <strong>Starter Fleet:</strong> your first {STARTER_DELIVERY_CAP} aircraft are delivered instantly
                {' '}— {starterDeliveriesRemaining} {starterDeliveriesRemaining === 1 ? 'is' : 'are'} left.
                {' '}Only the wait is waived; you still pay the price. Later orders arrive on the normal schedule.
              </span>
            </div>
          )}

          {/* Delivery callout */}
          {(() => {
            const instantUnits = instantCount;
            const queuedUnits  = quantity - instantUnits;
            return (
          <div style={{
            marginTop: 10, padding: '8px 12px',
            background: 'rgba(56,139,253,0.1)', borderRadius: 6,
            fontSize: 13, color: 'var(--accent)',
            border: '1px solid rgba(56,139,253,0.25)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span><Glyph e="📅" /></span>
              <span>
                {instantUnits > 0 && queuedUnits === 0 ? (
                  quantity === 1
                    ? <>Delivered <strong>instantly</strong> · ready to fly now</>
                    : <><strong>{quantity} aircraft</strong> delivered <strong>instantly</strong> · ready to fly now</>
                ) : instantUnits > 0 ? (
                  <><strong>{instantUnits}</strong> delivered <strong>instantly</strong>, then <strong>{queuedUnits}</strong> {lineAlloc ? <>off the line, at least <strong>{lineAlloc.gap}w</strong> apart</> : <>from <strong>{lead}w</strong> apart</>} (last in <strong>{lastDelivery - currentAbsWeek}w</strong>)</>
                ) : quantity === 1 ? (
                  <>First delivery in <strong>{firstDelivery - currentAbsWeek}w</strong> (Wk {firstWIM} {firstMon} Y{firstYear})</>
                ) : (
                  <><strong>{quantity} aircraft</strong> · first in <strong>{firstDelivery - currentAbsWeek}w</strong> (Wk {firstWIM} {firstMon} Y{firstYear}), last in <strong>{lastDelivery - currentAbsWeek}w</strong> (Wk {lastWIM} {lastMon} Y{lastYear}) · {lineAlloc ? `at least ${lineAlloc.gap}w apart` : `every ${lead}w`}</>
                )}
                {pendingOfType.length > 0 && (
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {pendingOfType.length} already queued</span>
                )}
              </span>
            </div>
            {quantity > 1 && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(56,139,253,0.2)', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {deliveryWeeks.map((absW, i) => {
                  if (i < instantUnits) {
                    return (
                      <span key={i} style={{
                        fontSize: 11, padding: '2px 7px', borderRadius: 4,
                        background: 'rgba(56,201,180,0.18)', color: 'var(--accent)',
                        border: '1px solid rgba(56,201,180,0.4)',
                      }}>#{i+1} — Now</span>
                    );
                  }
                  const { displayYear: dy, monthName: mn, weekInMonth: wim } = absWeekToDisplay(absW);
                  return (
                    <span key={i} style={{
                      fontSize: 11, padding: '2px 7px', borderRadius: 4,
                      background: 'rgba(56,139,253,0.15)', color: 'var(--accent)',
                      border: '1px solid rgba(56,139,253,0.25)',
                    }}>#{i+1} — {absW - currentAbsWeek}w (Wk {wim} {mn} Y{dy}){framePremiums[i] > 0 ? ` · +${formatMoney(framePremiums[i])}` : ''}</span>
                  );
                })}
              </div>
            )}
          </div>
            );
          })()}

          {/* Launch-customer terms */}
          {isLaunch && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 6, fontSize: 12.5, lineHeight: 1.5,
              background: 'rgba(163,113,247,0.12)', border: '1px solid rgba(163,113,247,0.35)', color: 'var(--text)',
            }}>
              <Glyph e="🚀" /> <strong>Launch order.</strong> The {type.name} enters service in {type.eis}. As a launch customer
              you take the first slots on the line from January {type.eis}, one every {lineAlloc?.gap ?? lead} week{(lineAlloc?.gap ?? lead) === 1 ? '' : 's'}, at {Math.round(discount * 100)}% off list
              ({orderDiscount(quantity) > 0 ? 'bulk + ' : ''}launch{(launchTerms.discount > 0.08) ? ' + loyalty' : ''}). Minimum {launchTerms.minQty} frame{launchTerms.minQty === 1 ? '' : 's'}{launchTerms.built ? <> (scaled to the {launchTerms.built.toLocaleString()} ever built)</> : null}, bought
              outright. <strong>Launch orders are firm — they cannot be cancelled.</strong>
            </div>
          )}

          {/* Production line: standard (list) or priority delivery */}
          {lineAlloc && !isLaunch && (() => {
            const cal  = slotCalendar(state, type, currentAbsWeek, 12);
            const info = lineInfo(lineOf(type));
            const chosen = slotFrom ?? cal.rows[0]?.week;
            const pgap = usePriority ? lineAlloc.gap : (otherPlan?.alloc.gap ?? cal.gap);
            const choice = (on, label, sub, onClick, accent) => (
              <button type="button" onClick={onClick} style={{
                flex: 1, padding: '6px 9px', borderRadius: 6, textAlign: 'left', cursor: 'pointer',
                border: `1px solid ${on ? accent : 'var(--border)'}`,
                background: on ? 'rgba(56,139,253,0.12)' : 'var(--surface2)',
                color: on ? 'var(--text)' : 'var(--text-muted)', fontSize: 12, lineHeight: 1.35,
              }}>
                <strong style={{ color: on ? accent : 'var(--text)' }}>{label}</strong>
                <span style={{ display: 'block', fontSize: 11 }}>{sub}</span>
              </button>
            );
            return (
              <div style={{ marginTop: 10, fontSize: 12 }}>
                <div style={{ color: 'var(--text-muted)', marginBottom: 6 }}>
                  <Glyph e="🏭" /> <strong style={{ color: 'var(--text)' }}>{info.name}</strong> line · {cal.capacity} frames a week across every airline
                  {cal.reserve > 0 ? <>, {cal.reserve} held back for priority orders</> : null}.
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  {choice(!usePriority, 'Standard · list price',
                    stdSummary ? `First in ${stdSummary.first}w · ${cal.gap}w apart` : `${cal.gap}w apart`,
                    () => setPriority(false), 'var(--green)')}
                  {choice(usePriority, '⚡ Priority',
                    priSummary ? `First in ${priSummary.first}w · ${pgap}w apart · +${formatMoney(priSummary.fee)}` : `${pgap}w apart`,
                    () => setPriority(true), 'var(--yellow)')}
                </div>
                {usePriority ? (
                  <div style={{ color: 'var(--text-muted)', lineHeight: 1.45 }}>
                    Priority frames can take the held-back slots, start at the build time and come {pgap} week{pgap === 1 ? '' : 's'} apart.
                    Each pays for the weeks it arrives ahead of the standard queue: {Math.round(EARLY_SLOT_MAX_PREMIUM * 100)}% of list buys {lead} week{lead === 1 ? '' : 's'}, at most {Math.round(PRIORITY_FEE_CAP * 100)}% a frame.
                  </div>
                ) : (
                  <>
                    <div style={{ color: 'var(--text-muted)', marginBottom: 6 }}>
                      Yours arrive at least {cal.gap} week{cal.gap === 1 ? '' : 's'} apart. Start from:
                    </div>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {cal.rows.map((r, idx) => {
                        const full = r.free <= 0 || r.gapBlocked;
                        const on   = r.week === chosen;
                        return (
                          <button
                            key={r.week}
                            type="button"
                            disabled={full}
                            onClick={() => setSlotFrom(idx === 0 ? null : r.week)}
                            title={r.mine ? 'You already take a frame this week' : r.gapBlocked ? `Within ${cal.gap} weeks of another of your frames on this line` : full ? 'No standard slots left this week' : `${r.free} of ${r.room} standard slots open`}
                            style={{
                              padding: '3px 7px', borderRadius: 5, fontSize: 11, lineHeight: 1.3,
                              cursor: full ? 'not-allowed' : 'pointer', opacity: full ? 0.4 : 1,
                              border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                              background: on ? 'rgba(56,139,253,0.15)' : 'var(--surface2)',
                              color: on ? 'var(--accent)' : 'var(--text-muted)',
                            }}
                          >
                            {r.week - currentAbsWeek}w
                            <span style={{ display: 'block', fontSize: 10, color: 'var(--green)' }}>
                              {full ? (r.mine ? 'yours' : r.gapBlocked ? 'gap' : 'full') : 'list'}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </div>

        <div style={{ padding: '14px 20px' }}>

          {/* ── Quantity ─────────────────────────────────────────────────── */}
          <section style={{ marginBottom: 18 }}>
            <div style={sectionTitle}>Quantity</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {nwrRestricted && (
                <div style={{ fontSize: 11, color: nwrFree === 0 ? 'var(--red)' : 'var(--text-muted)', marginBottom: 6 }}>
                  <Glyph e="🔒" size={11} /> {nwrFree} of {nwrCap} lease order-book slot{nwrCap === 1 ? '' : 's'} free
                  {nwrOnOrder > 0 && <> · {nwrOnOrder} already on order</>}
                </div>
              )}
              <div style={{ textAlign: 'center' }}>
                <NumberStepper
                  live
                  value={quantity}
                  min={1}
                  max={Math.max(1, mode === 'buy' ? Math.min(qtyCeiling, maxAffordable) : qtyCeiling)}
                  onChange={setQty}
                  ariaLabel="aircraft quantity"
                />
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>aircraft</div>
              </div>
              <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
                {[1, 5, 10, 25, 50, 100].filter(n => n <= (mode === 'buy' ? maxAffordable : 100)).map(n => (
                  <button key={n} onClick={() => setQty(n)} style={{ padding: '4px 9px', borderRadius: 5, border: `1px solid ${quantity === n ? 'var(--accent)' : 'var(--border)'}`, background: quantity === n ? 'rgba(56,139,253,0.15)' : 'var(--surface2)', color: quantity === n ? 'var(--accent)' : 'var(--text-muted)', fontSize: 12, fontWeight: quantity === n ? 600 : 400, cursor: 'pointer' }}>{n}</button>
                ))}
              </div>
            </div>
          </section>

          {/* ── Custom name ──────────────────────────────────────────────── */}
          <section style={{ marginBottom: 18 }}>
            <div style={sectionTitle}>Aircraft Name <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></div>
            <input
              type="text"
              value={customName}
              maxLength={40}
              onChange={e => setCustomName(e.target.value)}
              placeholder={`e.g. "Spirit of ${type.manufacturer}" · defaults to ${type.name} #N`}
              style={{
                width: '100%', padding: '8px 12px', fontSize: 13,
                background: 'var(--surface2)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 7, outline: 'none',
              }}
              onFocus={e => { e.target.style.borderColor = 'var(--accent)'; }}
              onBlur={e => { e.target.style.borderColor = 'var(--border)'; }}
            />
            {customName.trim() && quantity > 1 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>
                Aircraft will be named “{customName.trim()} #1” through “{customName.trim()} #{quantity}”
              </div>
            )}
          </section>

          {/* ── Engine options ───────────────────────────────────────────── */}
          {engines.length > 1 && (
            <section style={{ marginBottom: 18 }}>
              <div style={sectionTitle}>Engine Options</div>
              {engines.map(eng => {
                const isSelected = selectedEngineId === eng.id;
                const fuelDelta  = Math.round((eng.fuelMod - 1) * 100);
                const priceDelta = Math.round((eng.priceMod - 1) * 100);
                const maintDelta = Math.round(((eng.maintMod ?? 1.0) - 1) * 100);
                return (
                  <label key={eng.id} style={{ display: 'flex', gap: 10, padding: '9px 12px', marginBottom: 5, borderRadius: 7, border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`, background: isSelected ? 'rgba(56,139,253,0.08)' : 'var(--surface2)', cursor: 'pointer', transition: 'all 0.15s' }}>
                    <input type="radio" name={`engine-${typeId}`} value={eng.id} checked={isSelected} onChange={() => setSelectedEngineId(eng.id)} style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{eng.label}</span>
                        {eng.default && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'rgba(56,139,253,0.15)', color: 'var(--accent)', border: '1px solid rgba(56,139,253,0.3)' }}>default</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{eng.description}</div>
                      <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11, flexWrap: 'wrap' }}>
                        {fuelDelta !== 0 && <span style={{ color: fuelDelta < 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{fuelDelta < 0 ? '↓' : '↑'} {Math.abs(fuelDelta)}% fuel</span>}
                        {maintDelta !== 0 && <span style={{ color: maintDelta > 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{maintDelta > 0 ? '↑' : '↓'} {Math.abs(maintDelta)}% maint</span>}
                        {priceDelta > 0 && <span style={{ color: 'var(--text-muted)' }}>+{priceDelta}% {mode === 'buy' ? 'unit price' : 'lease rate'}</span>}
                        {fuelDelta === 0 && maintDelta === 0 && priceDelta === 0 && <span style={{ color: 'var(--text-muted)' }}>Standard · no premium</span>}
                      </div>
                    </div>
                  </label>
                );
              })}
            </section>
          )}

          {/* ── Wingtip ──────────────────────────────────────────────────── */}
          {wingtipDef && (
            <section style={{ marginBottom: 18 }}>
              <div style={sectionTitle}>Wingtip Package</div>
              <label style={{ display: 'flex', gap: 10, padding: '9px 12px', borderRadius: 7, border: `1px solid ${hasWingtips ? 'var(--accent)' : 'var(--border)'}`, background: hasWingtips ? 'rgba(56,139,253,0.08)' : 'var(--surface2)', cursor: 'pointer', transition: 'all 0.15s' }}>
                <input type="checkbox" checked={hasWingtips} onChange={e => setHasWingtips(e.target.checked)} style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{wingtipDef.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{wingtipDef.description}</div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11, flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--green)', fontWeight: 600 }}>↓ {Math.abs(Math.round((wingtipDef.fuelMod - 1) * 100))}% fuel</span>
                    {wingtipDef.rangeMod && wingtipDef.rangeMod !== 1.0 && (
                      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>↑ {Math.round((wingtipDef.rangeMod - 1) * 100)}% range ({type.range.toLocaleString()} → {effectiveRangeFull.toLocaleString()} km)</span>
                    )}
                    {mode === 'buy' && <span style={{ color: 'var(--text-muted)' }}>+{formatMoney(wingtipDef.cost ?? 0)} per aircraft</span>}
                    {mode === 'lease' && wingtipLeaseAdj > 0 && <span style={{ color: 'var(--text-muted)' }}>+{formatMoney(wingtipLeaseAdj)}/wk per aircraft</span>}
                  </div>
                </div>
              </label>
            </section>
          )}

          {/* ── Onboard connectivity ─────────────────────────────────────── */}
          {/* Not offered at all when the world has no onboard internet yet, and
              not offered on an airframe that could never carry it. In both
              cases the player sees WHY rather than a silently missing option —
              an absent checkbox reads as a bug, a stated reason reads as a
              rule. */}
          {!isFreighter && !wifiOffered && (
            <section style={{ marginBottom: 18 }}>
              <div style={sectionTitle}>Onboard Connectivity</div>
              <div style={{ display: 'flex', gap: 10, padding: '9px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface2)' }}>
                <div style={{ opacity: 0.5, fontSize: 15, lineHeight: 1.2 }}><Glyph e="📶" /></div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-dim)' }}>
                    Wi-Fi &amp; streaming package unavailable
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                    {!wifiEraLive
                      ? ERA_FEATURE_MESSAGE.wifi
                      : `${wifiAirframeDenial(type)} It will take the no-Wi-Fi quality `
                        + `penalty on every route it flies.`}
                  </div>
                </div>
              </div>
            </section>
          )}
          {!isFreighter && wifiOffered && (
            <section style={{ marginBottom: 18 }}>
              <div style={sectionTitle}>Onboard Connectivity</div>
              <label style={{ display: 'flex', gap: 10, padding: '9px 12px', borderRadius: 7, border: `1px solid ${hasWifi ? 'var(--accent)' : 'var(--border)'}`, background: hasWifi ? 'rgba(56,139,253,0.08)' : 'var(--surface2)', cursor: 'pointer', transition: 'all 0.15s' }}>
                <input type="checkbox" checked={hasWifi} onChange={e => setHasWifi(e.target.checked)} style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Wi-Fi &amp; streaming package</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                    Satellite antenna, modem and cabin access points, fitted on the production line.
                    Passengers now expect connectivity, and an aircraft without it takes a quality
                    penalty on every route it flies. What you charge for it is a separate,
                    airline-wide decision on the Ancillaries tab.
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11, flexWrap: 'wrap' }}>
                    {mode === 'buy'
                      ? <span style={{ color: 'var(--text-muted)' }}>+{formatMoney(wifiInstallCost())} per aircraft</span>
                      : <span style={{ color: 'var(--text-muted)' }}>+{formatMoney(wifiLeaseSurcharge())}/wk per aircraft</span>}
                    <span style={{ color: 'var(--text-muted)' }}>−{formatMoney(WIFI_WEEKLY_OPEX)}/wk to run</span>
                    <span style={{ color: 'var(--yellow)' }}>fitting it later costs {formatMoney(wifiRetrofitCost())}</span>
                  </div>
                </div>
              </label>
            </section>
          )}

          {/* ── Cabin configuration (passenger aircraft only) ────────────── */}
          {!isFreighter && (
          <section style={{ marginBottom: 18 }}>
            <div style={sectionTitle}>Cabin Configuration</div>

            {/* Saved templates */}
            <CabinTemplatePicker
              typeId={typeId}
              currentConfig={cabinConfig}
              onApply={applyTemplate}
            />

            {/* The cabin, drawn in the aircraft and paintable — the same
                designer as the refit modal. Beside the form on wide screens. */}
            {!wide && (
              <div className="checkout-plan" data-checkout-plan="inline">
                {cabinPlan}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
              <span style={{ color: over ? 'var(--red)' : undefined }}>
                {over
                  ? <GlyphLabel size={11} text={`⚠ Over-allocated by ${(usedUnits - maxSeats).toFixed(1)} seat-units`} />
                  : `${usedUnits.toFixed(1)} / ${maxSeats} seat-units used`}
              </span>
              <span>{first + biz + prem + eco} physical seats</span>
            </div>

            {/* Class rows */}
            <ClassRow
              label="First Class" color={CLASS_COLORS.firstClass}
              fareLabel={`${CLASS_FARE_MULTIPLIERS.firstClass}× fare`}
              spaceLabel={`${+space.firstClass.toFixed(2)}× space`}
              value={first} max={maxFirst} onChange={setFirst}
            />
            <ClassRow
              label="Business Class" color={CLASS_COLORS.businessClass}
              fareLabel={`${CLASS_FARE_MULTIPLIERS.businessClass}× fare`}
              spaceLabel={`${+space.businessClass.toFixed(2)}× space`}
              value={biz} max={maxBiz} onChange={setBiz}
            />
            <ClassRow
              label="Premium Economy" color={CLASS_COLORS.premiumEconomy}
              fareLabel={`${CLASS_FARE_MULTIPLIERS.premiumEconomy}× fare`}
              spaceLabel={`${+space.premiumEconomy.toFixed(2)}× space`}
              value={prem} max={maxPrem} onChange={setPrem}
            />

            <ClassRow
              label="Economy" color={CLASS_COLORS.economy}
              fareLabel={`${CLASS_FARE_MULTIPLIERS.economy}× fare`}
              spaceLabel={`${+space.economy.toFixed(2)}× space`}
              value={eco} max={maxEco} onChange={setEco}
            />
            {/* Sparse-cabin range callout */}
            {!isFreighter && (
              <div style={{
                marginTop: 6, padding: '6px 10px',
                background: 'rgba(56,139,253,0.08)', borderRadius: 5,
                fontSize: 11, color: 'var(--accent)',
                border: '1px solid rgba(56,139,253,0.2)',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span><Glyph e="✈" /></span>
                <span>
                  Range with this cabin{' '}
                  <strong>{effectiveRangeFull.toLocaleString()} km</strong>
                  {cabinRangePctGain > 0 && <span style={{ color: 'var(--green)', marginLeft: 4 }}>(+{cabinRangePctGain}%)</span>}
                  {cabinRangePctGain < 0 && <span style={{ color: 'var(--red)', marginLeft: 4 }}>({cabinRangePctGain}%: packed past the typical {typicalSeatsOf(type)} seats)</span>}
                  {' · '}{first + biz + prem + eco} seats · {typicalSeatsOf(type)} typical · {maxSeats} max
                </span>
              </div>
            )}

            {/* Seat quality */}
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Seat Quality</div>
              <select
                value={seatQ} onChange={e => setSeatQ(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer' }}
              >
                {QUALITY_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
                ))}
              </select>
              {seatQ !== 'basic' && (
                <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 3 }}>
                  One-off fit {formatMoney(SEAT_QUALITY_FITTING_FEE[seatQ] ?? 0)} · +{formatMoney(SEAT_QUALITY_COST_PER_ROUTE[seatQ] ?? 0)}/route/wk
                </div>
              )}
            </div>

            {/* Service: the soft product. Free to choose here; costs (or saves) weekly. */}
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Service</div>
              <select
                value={serviceQ} onChange={e => setServiceQ(e.target.value)} data-service-quality
                style={{ width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer' }}
              >
                {SERVICE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
                ))}
              </select>
              {serviceQ !== 'standard' && (() => {
                const c = SERVICE_QUALITY_COST_PER_ROUTE[serviceQ] ?? 0;
                const pts = SERVICE_QUALITY_POINTS[serviceQ] ?? 0;
                return (
                  <div style={{ fontSize: 10, color: c > 0 ? 'var(--red)' : 'var(--green)', marginTop: 3 }}>
                    {c < 0 ? `Saves ${formatMoney(-c)}` : `+${formatMoney(c)}`}/route/wk · {pts >= 0 ? '+' : ''}{pts} quality
                  </div>
                );
              })()}
            </div>

            {/* Cabin products: fitted on the line, so the aircraft arrives with them */}
            <div style={{ marginTop: 14 }} data-cabin-products>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>Cabin products</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                Fitted on the production line: the aircraft is delivered with this cabin, with no refit and no time in the shop.
                A bigger seat takes more floor and its cabin gives up seats to fit.
              </div>
              {CABIN_KEYS.filter(k => ({ firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco })[k] > 0).map(cls => (
                <ProductRow
                  key={cls}
                  cls={cls}
                  seats={({ firstClass: first, businessClass: biz, premiumEconomy: prem, economy: eco })[cls]}
                  products={products}
                  currentConfig={null}
                  showChanged={false}
                  calYear={calYear}
                  type={type}
                  onTier={tier => setProduct(cls, { tier })}
                  onExtra={key => toggleExtra(cls, key)}
                />
              ))}
              {productsWeekly > 0 && (
                <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 6 }}>
                  Product upkeep +{formatMoney(productsWeekly)}/route/wk
                </div>
              )}
            </div>

            {/* Revenue preview */}
            <div style={{
              marginTop: 10, padding: '8px 12px',
              background: 'var(--surface2)', borderRadius: 6,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              fontSize: 12,
            }}>
              <span style={{ color: 'var(--text-muted)' }}>Blended revenue index vs all-economy</span>
              <span style={{ fontWeight: 700, color: revenueIndex > 1.05 ? 'var(--green)' : revenueIndex > 1 ? 'var(--yellow)' : 'var(--text-muted)' }}>
                {revenueIndex.toFixed(2)}×
              </span>
            </div>
          </section>
          )}

          {/* ── Replaces (fleet renewal) ─────────────────────────────────── */}
          {!isLaunch && (
            <ReplacesSection
              draft={replaceDraft}
              quantity={quantity}
              setQuantity={setQty}
              selected={replaceSel}
              setSelected={setReplaceSel}
              disposal={replaceDisposal}
              setDisposal={setReplaceDisposal}
              deliveryWeeks={deliveryWeeks}
              defaultOpen={!!replaceIds?.length}
              firstReplaceable={instantCount}
            />
          )}

          {/* ── Order summary ────────────────────────────────────────────── */}
          <section style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 14 }}>
            <div style={sectionTitle}>Order Summary</div>

            {mode === 'buy' ? (
              <div style={{ fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                  <span>Base price per aircraft{discPct > 0 && <span style={{ marginLeft: 5, fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>(−{discPct}% bulk)</span>}</span>
                  <span style={{ color: 'var(--text)' }}>{formatMoney(baseUnitPrice)}</span>
                </div>
                {enginePriceAdj !== 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>Engine: {selectedEngine?.label}</span>
                    <span style={{ color: 'var(--text)' }}>{enginePriceAdj > 0 ? '+' : ''}{formatMoney(enginePriceAdj)}</span>
                  </div>
                )}
                {wingtipCost > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>{wingtipDef?.label}</span>
                    <span style={{ color: 'var(--text)' }}>+{formatMoney(wingtipCost)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Unit price</span>
                  <span>{formatMoney(unitBuyPrice)}</span>
                </div>
                {totalSlotPremium > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>Priority fee{framePremiums.filter(x => x > 0).length > 1 ? ` (${framePremiums.filter(x => x > 0).length} frames)` : ''}</span>
                    <span style={{ color: 'var(--yellow)' }}>+{formatMoney(totalSlotPremium)}</span>
                  </div>
                )}
                {quantity > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>× {quantity} aircraft</span>
                    <span style={{ color: 'var(--text)' }}>{formatMoney(unitBuyPrice)} × {quantity}</span>
                  </div>
                )}
                {totalFittingFee > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>Seat fitting — one-off{quantity > 1 ? ` × ${quantity}` : ''}</span>
                    <span style={{ color: 'var(--text)' }}>+{formatMoney(totalFittingFee)}</span>
                  </div>
                )}
                {totalInstallFee > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>Premium cabin fit — one-off{quantity > 1 ? ` × ${quantity}` : ''}</span>
                    <span style={{ color: 'var(--text)' }}>+{formatMoney(totalInstallFee)}</span>
                  </div>
                )}
                {totalProductFee > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }} data-product-fee>
                    <span>Cabin products — one-off{quantity > 1 ? ` × ${quantity}` : ''}</span>
                    <span style={{ color: 'var(--text)' }}>+{formatMoney(totalProductFee)}</span>
                  </div>
                )}
                {totalWifiFee > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>Wi-Fi package — one-off{quantity > 1 ? ` × ${quantity}` : ''}</span>
                    <span style={{ color: 'var(--text)' }}>+{formatMoney(totalWifiFee)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, borderTop: '1px solid var(--border)', fontWeight: 700, fontSize: 15 }}>
                  <span>Total{quantity > 1 ? ` (${quantity} aircraft)` : ''}</span>
                  <span style={{ color: canAfford ? 'var(--green)' : 'var(--red)' }}>{formatMoney(buyTotalDue)}</span>
                </div>
                {!canAfford && (
                  <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, textAlign: 'right' }}>
                    Need {formatMoney(buyTotalDue - cash)} more{maxAffordable > 0 ? ` · can afford ${maxAffordable}` : ''}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, textAlign: 'right' }}>Full payment due at order</div>
              </div>
            ) : (
              <div style={{ fontSize: 13 }}>
                {/* ── Lease term picker (longer term = lower weekly rate) ── */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 600 }}>Lease term</span>
                    <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>longer term · lower weekly rate</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {LEASE_TERM_OPTIONS.map(o => {
                      const selected = o.weeks === leaseTermWeeks;
                      const pct      = Math.round((o.rateMult - 1) * 100);
                      const hint     = pct === 0 ? 'std rate' : (pct > 0 ? `+${pct}%/wk` : `−${Math.abs(pct)}%/wk`);
                      const hintCol  = pct === 0 ? 'var(--text-dim)' : (pct > 0 ? 'var(--red)' : 'var(--green)');
                      return (
                        <button
                          key={o.weeks}
                          onClick={() => setLeaseTermWeeks(o.weeks)}
                          style={{
                            flex: 1, padding: '8px 4px', borderRadius: 7, cursor: 'pointer',
                            border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                            background: selected ? 'rgba(56,139,253,0.12)' : 'var(--surface2)',
                            color: 'var(--text)', textAlign: 'center', transition: 'all 0.12s',
                          }}
                        >
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{o.label}</div>
                          <div style={{ fontSize: 10, color: selected ? hintCol : 'var(--text-dim)', marginTop: 2 }}>{hint}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                  <span>Base weekly lease</span>
                  <span style={{ color: 'var(--text)' }}>{formatMoney(baseWeeklyLease)}/wk</span>
                </div>
                {leaseRateMult !== 1 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>{LEASE_TERM_OPTIONS.find(o => o.weeks === leaseTermWeeks)?.label} term adjustment</span>
                    <span style={{ color: leaseRateMult < 1 ? 'var(--green)' : 'var(--red)' }}>
                      {leaseRateMult < 1 ? '−' : '+'}{Math.abs(Math.round((leaseRateMult - 1) * 100))}%
                    </span>
                  </div>
                )}
                {engineLeaseAdj !== 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>Engine: {selectedEngine?.label}</span>
                    <span style={{ color: 'var(--text)' }}>{engineLeaseAdj > 0 ? '+' : ''}{formatMoney(engineLeaseAdj)}/wk</span>
                  </div>
                )}
                {wingtipLeaseAdj > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>{wingtipDef?.label}</span>
                    <span style={{ color: 'var(--text)' }}>+{formatMoney(wingtipLeaseAdj)}/wk</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Per aircraft / wk</span>
                  <span>{formatMoney(unitWeeklyLease)}</span>
                </div>
                {quantity > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, color: 'var(--text-muted)' }}>
                    <span>× {quantity} aircraft (when all delivered)</span>
                    <span style={{ color: 'var(--text)' }}>{formatMoney(unitWeeklyLease)} × {quantity}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, borderTop: '1px solid var(--border)', fontWeight: 700, fontSize: 15 }}>
                  <span>Total weekly lease</span>
                  <span style={{ color: 'var(--accent)' }}>{formatMoney(totalWeeklyLease)}/wk</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', fontWeight: 700, fontSize: 14 }}>
                  <span>3-month deposit (due now)</span>
                  <span style={{ color: 'var(--text)' }}>{formatMoney(totalLeaseDeposit)}</span>
                </div>
                {totalSlotPremium > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontWeight: 700, fontSize: 14 }}>
                    <span>Priority fee, one-off (due now)</span>
                    <span style={{ color: 'var(--yellow)' }}>{formatMoney(totalSlotPremium)}</span>
                  </div>
                )}
                {totalFittingFee > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontWeight: 700, fontSize: 14 }}>
                    <span>Seat fitting, one-off (due now)</span>
                    <span style={{ color: canAfford ? 'var(--green)' : 'var(--red)' }}>{formatMoney(totalFittingFee)}</span>
                  </div>
                )}
                {totalInstallFee > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontWeight: 700, fontSize: 14 }}>
                    <span>Premium cabin fit, one-off (due now)</span>
                    <span style={{ color: canAfford ? 'var(--green)' : 'var(--red)' }}>{formatMoney(totalInstallFee)}</span>
                  </div>
                )}
                {totalProductFee > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontWeight: 700, fontSize: 14 }} data-product-fee>
                    <span>Cabin products, one-off (due now)</span>
                    <span style={{ color: canAfford ? 'var(--green)' : 'var(--red)' }}>{formatMoney(totalProductFee)}</span>
                  </div>
                )}
                {!canAfford && (
                  <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, textAlign: 'right' }}>
                    Need {formatMoney(leaseDepositDue - cash)} more{maxAffordable > 0 ? ` · can afford ${maxAffordable}` : ''}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, textAlign: 'right' }}>
                  12 weeks × {formatMoney(unitWeeklyLease)}/wk · applied toward first months of lease
                </div>
              </div>
            )}

            {/* Fuel / range / maint callout */}
            {(fuelPctSaving > 0 || rangePctGain > 0 || maintPctChange !== 0) && (
              <div style={{ marginTop: 10, padding: '7px 10px', background: 'rgba(63,185,80,0.1)', borderRadius: 5, fontSize: 12, color: 'var(--green)', border: '1px solid rgba(63,185,80,0.25)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
                  {fuelPctSaving > 0 && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span><Glyph e="⛽" /></span>
                      <span>Saves <strong>{fuelPctSaving}%</strong> fuel vs standard build</span>
                    </span>
                  )}
                  {rangePctGain > 0 && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent)' }}>
                      <span><Glyph e="✈" /></span>
                      <span>Range extended to <strong>{effectiveRange.toLocaleString()} km</strong> (+{rangePctGain}%)</span>
                    </span>
                  )}
                  {maintPctChange !== 0 && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: maintPctChange > 0 ? 'var(--red)' : 'var(--green)' }}>
                      <span><Glyph e="🔧" /></span>
                      <span>Maintenance <strong>{maintPctChange > 0 ? '+' : ''}{maintPctChange}%</strong> vs standard engine</span>
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Cabin summary callout */}
            {(first + biz + prem > 0 || eco < maxEco || seatQ !== 'basic') && (
              <div style={{ marginTop: 8, padding: '7px 10px', background: 'rgba(163,113,247,0.1)', borderRadius: 5, fontSize: 12, color: '#a98bff', border: '1px solid rgba(163,113,247,0.25)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span><Glyph e="💺" /></span>
                <span>
                  {[
                    first > 0 && `${first}F`,
                    biz   > 0 && `${biz}J`,
                    prem  > 0 && `${prem}W`,
                    `${eco}Y`,
                  ].filter(Boolean).join(' / ')}
                  {seatQ !== 'basic' && ` · ${seatQ} seats`}
                  {' · '}revenue index <strong>{revenueIndex.toFixed(2)}×</strong>
                  {extraQualityCost > 0 && <span style={{ color: 'var(--red)' }}> · +{formatMoney(extraQualityCost)}/route/wk quality costs</span>}
                </span>
              </div>
            )}
          </section>

          {/* ── Crew ─────────────────────────────────────────────────────────
              Hiring used to be a separate trip to Operations that the player
              had to time against the delivery. The order now says what crew
              it needs and offers to have them hired (2026-11-11). */}
          {crewOn && (
            <div data-order-crew style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 6, background: 'var(--surface2)', fontSize: 12 }}>
              {crewToHire.people <= 0 ? (
                <span style={{ color: 'var(--green)' }}>
                  <Glyph e="🧑‍✈️" size={13} /> Crew: your reserve staff already cover {quantity > 1 ? 'these aircraft' : 'this aircraft'}. Nobody to hire.
                </span>
              ) : (<>
                <div>
                  <Glyph e="🧑‍✈️" size={13} /> <strong>Crew to hire:</strong> {crewToHire.groups.join(', ')}
                  <span style={{ color: 'var(--text-muted)' }}> · about {formatMoney(crewToHire.cost)} training</span>
                  {crewToHire.covered > 0 && <span style={{ color: 'var(--text-muted)' }}> (your spare staff cover another {crewToHire.covered.toLocaleString()})</span>}
                  {replaceSel.length > 0 && <span style={{ color: 'var(--text-muted)' }}> · less the crews of the aircraft being replaced</span>}
                </div>
                {autoStaff ? (
                  <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
                    Hired for you in time for delivery (Keep me fully staffed is on). The training cost leaves your cash when hiring starts.
                  </div>
                ) : (
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={staffForMe} onChange={e => setStaffForMe(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>
                      Keep me fully staffed
                      <span style={{ color: 'var(--text-muted)' }}>
                        {' '}· hire them for me in time for delivery, and replace leavers from now on. Untick to hire by hand in
                        Company ▸ Operations (pilots train for {CREW_LEAD_WEEKS.pilots} weeks).
                      </span>
                    </span>
                  </label>
                )}
              </>)}
            </div>
          )}

          {/* ── Actions ──────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              style={{ flex: 2, ...(!canAfford || over ? { background: 'var(--surface3)', color: 'var(--text-dim)', cursor: 'not-allowed', border: '1px solid var(--border)' } : {}) }}
              disabled={!canAfford || over}
              onClick={handleConfirm}
            >
              <GlyphLabel size={13} text={over
                ? '⚠ Fix cabin layout'
                : mode === 'buy'
                  ? (isLaunch ? `🚀 Launch order ${quantity}× ${type.name}` : `🛒 Order ${quantity > 1 ? quantity + '× ' : ''}${type.name}`)
                  : `✍️ Sign Lease${quantity > 1 ? ` × ${quantity}` : ''}`} />
            </button>
          </div>

        </div>
        </div>
      </div>
    </div>
  );
}
