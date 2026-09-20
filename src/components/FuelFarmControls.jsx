import { useGame } from '../store/GameContext.jsx';
import { useConfirm } from './ConfirmModal.jsx';
import { formatMoney } from '../utils/simulation.js';
import { fuelStationsOn } from '../../packages/engine/src/data/fuelStations.js';
import {
  FARM_LEVELS, canTakeFarm, farmDiscount, farmCloseRefund, farmWeeklyOpex, rivalFarmOwnerAt, farmLevelDef,
} from '../../packages/engine/src/data/fuelFarm.js';
import { absoluteWeek } from '../../packages/engine/src/utils/fuel.js';

/**
 * Fuel farm status and actions at one station (FUEL_OPERATIONS_PLAN.md §8):
 * what you hold, what a rival holds, and the Buy stake / Build farm / Sell
 * buttons — each priced by the engine's canTakeFarm, so the number on the
 * button is the number the reducer takes and the reason it is disabled is
 * the reason the reducer would refuse.
 */
export default function FuelFarmControls({ code, compact = false }) {
  const { state, dispatch } = useGame();
  const confirm = useConfirm();
  if (!fuelStationsOn(state) || !code) return null;
  const abs   = absoluteWeek(state.year ?? 1, state.week ?? 1);
  const mine  = state.fuelFarms?.[code] ?? null;
  const rival = rivalFarmOwnerAt(state, code);
  const stake = canTakeFarm(state, code, 1);
  const farm  = canTakeFarm(state, code, 2);
  const upliftHere = state.lastReport?.fuelByStation?.[code] ?? 0;

  const take = async (level, check) => {
    const def = FARM_LEVELS[level];
    const ok = await confirm({
      title: `${def.name} at ${code}?`,
      body: `${formatMoney(check.capex)} now${mine ? ' (your stake converts)' : ''}, then ${formatMoney(Math.round(check.fullCapex * def.opexPctPerWeek))}/wk to run.\n\n`
          + `${def.blurb}\n\n`
          + (upliftHere > 0 ? `You bought ${formatMoney(upliftHere)} of fuel here last week; ${Math.round(def.discount * 100)}% of that is ${formatMoney(Math.round(upliftHere * def.discount))}/wk once fully bedded in.\n\n` : '')
          + `Selling later recovers ${Math.round(100 * 0.25)}% of the capex.`,
      confirmLabel: `${level === 2 ? 'Build' : 'Buy'} for ${formatMoney(check.capex)}`,
    });
    if (ok) dispatch({ type: level === 2 ? 'BUILD_FUEL_FARM' : 'BUY_FUEL_STAKE', code });
  };
  const sell = async () => {
    const ok = await confirm({
      title: `Sell your ${farmLevelDef(mine.level)?.name.toLowerCase()} at ${code}?`,
      body: `You recover ${formatMoney(farmCloseRefund(mine))} of the ${formatMoney(mine.capex)} you put in, and lose the discount here${mine.level === 2 ? ' and the throughput fees' : ''}.`,
      confirmLabel: `Sell for ${formatMoney(farmCloseRefund(mine))}`,
    });
    if (ok) dispatch({ type: 'CLOSE_FUEL_FARM', code });
  };

  const btn = (label, check, level) => (
    <button
      key={label}
      className="btn btn-ghost"
      style={{ fontSize: compact ? 10 : 11, padding: compact ? '1px 7px' : '3px 9px' }}
      disabled={!check.ok}
      title={check.ok ? `${label} for ${formatMoney(check.capex)}` : check.reasons.join(' ')}
      onClick={() => check.ok && take(level, check)}
    >
      {label} · {formatMoney(check.capex)}
    </button>
  );

  return (
    <span data-testid={`fuel-farm-${code}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {mine && (
        <span style={{ fontSize: compact ? 10 : 11, color: 'var(--green)', fontWeight: 600 }}
              title={`${farmLevelDef(mine.level)?.name}: ${Math.round(farmDiscount(mine, abs) * 100)}% off your uplift here${mine.level === 2 && farmDiscount(mine, abs) < FARM_LEVELS[2].discount ? ' (bedding in)' : ''} · ${formatMoney(farmWeeklyOpex(mine))}/wk to run`}>
          {mine.level === 2 ? '🏭 your farm' : '🤝 stake'} −{Math.round(farmDiscount(mine, abs) * 100)}%
        </span>
      )}
      {!mine && rival && (
        <span style={{ fontSize: compact ? 10 : 11, color: 'var(--text-muted)' }} title="One owner per airport — every rival fuelling here pays them a throughput fee.">
          🏭 {rival.name ?? 'a rival'} owns the farm
        </span>
      )}
      {!mine && btn('Buy stake', stake, 1)}
      {(!mine || mine.level < 2) && !rival && btn(mine ? 'Upgrade to farm' : 'Build farm', farm, 2)}
      {mine && (
        <button className="btn btn-ghost" style={{ fontSize: compact ? 10 : 11, padding: compact ? '1px 7px' : '3px 9px' }} onClick={sell}
                title={`Recover ${formatMoney(farmCloseRefund(mine))}`}>
          Sell
        </button>
      )}
    </span>
  );
}
