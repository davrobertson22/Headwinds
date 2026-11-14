// Standard cabin layouts, sized to an aircraft's floor. The Route Planner's
// cabin presets and the "Standard layouts" in the buy and refit dialogs'
// template picker both come from here, so a layout picked while planning a
// route is the same one offered when buying the aircraft.
import { CLASS_SPACE_MULTIPLIERS } from './simulation.js';

/** Build a preset cabin layout sized to a type's total floor units (= type.seats). */
// `typical` is the type's typical seating (where its headline range applies): the
// default all-economy cabin fills to it, and 'dense' packs to the exit limit.
export function makePreset(kind, seats, typical = seats) {
  if (kind === 'dense') kind = 'economy', typical = seats;
  const base = {
    firstClass: 0, businessClass: 0, premiumEconomy: 0, economy: Math.min(seats, typical),
    seatQuality: 'basic', serviceQuality: 'standard',
  };
  if (kind === 'twoClass') {
    const biz = Math.max(1, Math.floor((seats * 0.15) / CLASS_SPACE_MULTIPLIERS.businessClass));
    const eco = Math.max(0, Math.floor(seats - biz * CLASS_SPACE_MULTIPLIERS.businessClass));
    return { ...base, businessClass: biz, economy: eco };
  }
  if (kind === 'threeClass') {
    const biz  = Math.max(1, Math.floor((seats * 0.20) / CLASS_SPACE_MULTIPLIERS.businessClass));
    const prem = Math.max(1, Math.floor((seats * 0.15) / CLASS_SPACE_MULTIPLIERS.premiumEconomy));
    const used = biz * CLASS_SPACE_MULTIPLIERS.businessClass + prem * CLASS_SPACE_MULTIPLIERS.premiumEconomy;
    return { ...base, businessClass: biz, premiumEconomy: prem, economy: Math.max(0, Math.floor(seats - used)) };
  }
  if (kind === 'premiumHeavy') {
    const first = Math.max(1, Math.floor((seats * 0.08) / CLASS_SPACE_MULTIPLIERS.firstClass));
    const biz   = Math.max(1, Math.floor((seats * 0.30) / CLASS_SPACE_MULTIPLIERS.businessClass));
    const prem  = Math.max(1, Math.floor((seats * 0.20) / CLASS_SPACE_MULTIPLIERS.premiumEconomy));
    const used  = first * CLASS_SPACE_MULTIPLIERS.firstClass + biz * CLASS_SPACE_MULTIPLIERS.businessClass + prem * CLASS_SPACE_MULTIPLIERS.premiumEconomy;
    return { ...base, firstClass: first, businessClass: biz, premiumEconomy: prem, economy: Math.max(0, Math.floor(seats - used)) };
  }
  return base; // 'economy'
}

export const PRESET_OPTIONS = [
  { id: 'economy',      label: 'All economy, typical seats (default)' },
  { id: 'dense',        label: 'All economy, packed to the limit (less range)' },
  { id: 'twoClass',     label: 'Two-class (business + economy)' },
  { id: 'threeClass',   label: 'Three-class (business + prem. eco + economy)' },
  { id: 'premiumHeavy', label: 'Premium-heavy (first + business + prem. eco)' },
];
