import { useGame } from '../store/GameContext.jsx';
import { useConfirm } from './ConfirmModal.jsx';
import { formatMoney } from '../utils/simulation.js';
import { fuelStationsOn } from '../../packages/engine/src/data/fuelStations.js';
import { fuelImpact } from '../utils/fuelImpact.js';
import { absoluteWeek } from '../../packages/engine/src/utils/fuel.js';
import {
  CRACK_BASE_INDEX, REFINERY_CAPEX, REFINERY_BUILD_WEEKS, REFINERY_WEEKLY_OPEX,
  REFINERY_CAPACITY_SHARE, REFINERY_MIN_WEEKLY_BILL, REFINING_COST,
  canBuyRefinery, refineryStatus, refinerySaleValue, refinerySavingsFromReport,
  weeklyBaseBillOf,
} from '../../packages/engine/src/data/refinery.js';

/**
 * The refinery (FUEL_OPERATIONS_PLAN.md §9) — the endgame tier of the Fuel tab.
 *
 * The card's job is to make the BET legible, not to sell it: what the crack
 * spread is, what the refinery is charging against the market this week, and
 * that the same machine loses money when the spread collapses. Everything is
 * priced by the engine's own canBuyRefinery / refineryStatus, so the button
 * says what the reducer does.
 */
export default function FuelRefineryCard({ state, dispatch }) {
  const confirm = useConfirm();
  if (!fuelStationsOn(state)) return null;

  const abs    = absoluteWeek(state.year ?? 1, state.week ?? 1);
  const impact = fuelImpact(state, { lookbacks: [] });
  const jet    = state.fuelPrice?.index ?? 1;
  const crack  = state.fuelPrice?.crack ?? CRACK_BASE_INDEX;
  const status = refineryStatus(state, { absWeek: abs, jetIndex: jet, crackIndex: crack });
  const check  = canBuyRefinery(state);
  const bill   = weeklyBaseBillOf(state);
  const saved  = refinerySavingsFromReport(state.lastReport);

  // Don't advertise it to an airline that is nowhere near it — but do say what
  // the bar is, so the player knows the tier exists and what reaches it.
  const farOff = !status.owned && bill < REFINERY_MIN_WEEKLY_BILL * 0.5;

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
  const edgePct = (v) => `${v >= 0 ? '−' : '+'}${Math.abs(v * 100).toFixed(1)}%`;

  const buy = async () => {
    const ok = await confirm({
      title: 'Buy a refinery?',
      body: `${formatMoney(REFINERY_CAPEX)} now, ${formatMoney(REFINERY_WEEKLY_OPEX)}/wk to run, and ${REFINERY_BUILD_WEEKS} weeks before it makes a litre.\n\n`
          + `It will refine about ${Math.round(REFINERY_CAPACITY_SHARE * 100)}% of what you burn TODAY — ${formatMoney(Math.round(bill * REFINERY_CAPACITY_SHARE))}/wk of fuel — and that capacity never grows, so the share falls as you do.\n\n`
          + `Those litres come off the jet market and onto crude plus a refining cost. At the long-run spread that is about 6.7% under market. If the spread collapses you will pay MORE than market on every one of them, and the running cost is due either way.\n\n`
          + `Hedges cannot cover the refined share — the crack is the exposure you are buying.`,
      confirmLabel: `Buy for ${formatMoney(REFINERY_CAPEX)}`,
    });
    if (ok) dispatch({ type: 'BUY_REFINERY' });
  };
  const sell = async () => {
    const ok = await confirm({
      title: 'Sell the refinery?',
      body: `You recover ${formatMoney(refinerySaleValue(state.refinery))} of the ${formatMoney(state.refinery.capex)} you put in, and your whole fuel bill goes back on the jet market.`,
      confirmLabel: `Sell for ${formatMoney(refinerySaleValue(state.refinery))}`,
    });
    if (ok) dispatch({ type: 'SELL_REFINERY' });
  };

  const rows = [];
  if (status.owned) {
    rows.push(['Crack spread', `${crack.toFixed(2)}× · crude is ${(jet / crack).toFixed(2)}× against jet at ${jet.toFixed(2)}×`]);
    rows.push(['Refinery price', `${status.price.toFixed(3)}× — ${edgePct(status.edge)} against the market`]);
    if (status.building) {
      rows.push(['Commissioning', `${status.weeksLeft} weeks to go · ${formatMoney(REFINERY_WEEKLY_OPEX)}/wk already running`]);
    } else if (status.outage) {
      rows.push(['Status', `Off line for ${status.weeksLeft} more weeks — every litre is on the jet market`]);
    } else {
      rows.push(['Covering', `${Math.round(status.share * 100)}% of this week's fuel`
        + (impact?.bill ? ` · ${formatMoney(Math.round(impact.bill * status.share))}/wk` : '')]);
      if (saved !== 0) {
        rows.push([saved > 0 ? 'Made this week' : 'Lost this week', formatMoney(Math.abs(saved))]);
      }
    }
    rows.push(['Running cost', `${formatMoney(REFINERY_WEEKLY_OPEX)}/wk, outage or not`]);
  }

  return (
    <div style={card} data-testid="fuel-refinery-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Refinery</div>
        <div style={{ fontSize: 12, color: status.owned && saved < 0 ? 'var(--red)' : 'var(--muted)' }}>
          {!status.owned ? 'Not owned'
            : status.building ? `Commissioning · ${status.weeksLeft} wks`
            : status.outage ? 'Off line'
            : `${Math.round(status.share * 100)}% of your fuel at ${status.price.toFixed(2)}×`}
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>
        Hedges fix the price and programmes cut the burn; a refinery changes what you are exposed to.
        The litres it covers are priced off <strong>crude</strong> plus a refining cost instead of jet, so you win when
        the crack spread is wide and lose when it collapses. Delta bought one in 2012 for exactly this reason,
        and lost nine figures in the years the spread went against it.
      </div>

      {rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 0', fontSize: 12, marginBottom: 12 }}>
          {rows.map(([k, v]) => (
            <Fragmentish key={k} k={k} v={v} />
          ))}
        </div>
      )}

      {!status.owned && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          {farOff
            ? `Sold only to airlines burning ${formatMoney(REFINERY_MIN_WEEKLY_BILL)}+ of fuel a week. You burn ${formatMoney(bill)}.`
            : `${formatMoney(REFINERY_CAPEX)} · ${REFINERY_BUILD_WEEKS} weeks to commission · ${formatMoney(REFINERY_WEEKLY_OPEX)}/wk to run · `
              + `would cover about ${formatMoney(Math.round(bill * REFINERY_CAPACITY_SHARE))}/wk of fuel at today's flying.`}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!status.owned && !farOff && (
          <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={!check.ok}
                  title={check.ok ? `Buy for ${formatMoney(check.capex)}` : check.reasons.join(' ')}
                  onClick={() => check.ok && buy()}>
            Buy a refinery · {formatMoney(REFINERY_CAPEX)}
          </button>
        )}
        {!status.owned && !farOff && !check.ok && (
          <span style={{ fontSize: 11, color: 'var(--yellow)', alignSelf: 'center' }}>{check.reasons[0]}</span>
        )}
        {status.owned && (
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={sell}
                  title={`Recover ${formatMoney(refinerySaleValue(state.refinery))}`}>
            Sell · {formatMoney(refinerySaleValue(state.refinery))}
          </button>
        )}
      </div>
    </div>
  );
}

function Fragmentish({ k, v }) {
  return (
    <>
      <span style={{ color: 'var(--muted)' }}>{k}</span>
      <span>{v}</span>
    </>
  );
}
