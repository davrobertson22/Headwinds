// ── Board Objectives ─────────────────────────────────────────────────────────
//
// Three phases:
//   'strategic'  — Year 1 milestones: build the foundation (operational goals)
//   'financial'  — Year 2+ targets:   grow and optimise (KPI goals)
//   'empire'     — Endgame ambitions: dominate the industry (scale goals)
//
// Each template has:
//   id          unique string (stored in state)
//   phase       'strategic' | 'financial'
//   title       short name
//   desc        one-line explanation shown in UI
//   icon        emoji
//   reward      cash bonus on completion ($)
//   check(snap) → boolean — receives a snapshot of relevant state fields;
//                 returns true when the objective is met
//
// The `check` function receives:
//   {
//     routes            array of route records
//     fleet             array of fleet records (including delivered this tick)
//     gates             { [code]: gateCount }
//     financialHistory  array of history entries (newest last)
//     lastReport        the weekly tick report
//     weekProfit        after-tax profit this tick
//     cash              cash on hand after this tick ($)
//     marketCap         player market cap after this tick ($)
//     year              current year after advance
//     week              current week after advance
//   }

import { getAirport } from './airports.js';

export const OBJECTIVE_TEMPLATES = [

  // ── Phase 1: Strategic milestones ─────────────────────────────────────────
  // Goal: establish a functioning airline in Year 1

  {
    id:     'first_route',
    phase:  'strategic',
    title:  'First Departure',
    desc:   'Launch your first route',
    icon:   '✈️',
    reward: 50_000,
    check: ({ routes }) => routes.length >= 1,
  },

  {
    id:     'first_profit',
    phase:  'strategic',
    title:  'In the Black',
    desc:   'Achieve a profitable week',
    icon:   '💚',
    reward: 200_000,
    check: ({ weekProfit }) => weekProfit > 0,
  },

  {
    id:     'fleet_3',
    phase:  'strategic',
    title:  'Growing Fleet',
    desc:   'Operate 3 or more aircraft',
    icon:   '🛫',
    reward: 100_000,
    check: ({ fleet }) => fleet.filter(a => a.status !== 'retired').length >= 3,
  },

  {
    id:     'airports_4',
    phase:  'strategic',
    title:  'Network Builder',
    desc:   'Serve 4 or more airports (gates required)',
    icon:   '🏛️',
    reward: 150_000,
    check: ({ gates }) => Object.values(gates).filter(n => n > 0).length >= 4,
  },

  {
    id:     'routes_5',
    phase:  'strategic',
    title:  'Route Network',
    desc:   'Operate 5 or more city pairs',
    icon:   '🗺️',
    reward: 250_000,
    check: ({ routes }) => {
      const pairs = new Set(routes.map(r => {
        const [a, b] = [r.origin, r.destination].sort();
        return `${a}-${b}`;
      }));
      return pairs.size >= 5;
    },
  },

  {
    id:     'profitable_quarter',
    phase:  'strategic',
    title:  'Profitable Quarter',
    desc:   'Achieve 4 consecutive profitable weeks',
    icon:   '📈',
    reward: 500_000,
    check: ({ financialHistory }) => {
      if (financialHistory.length < 4) return false;
      return financialHistory.slice(-4).every(h => (h.profit ?? 0) > 0);
    },
  },

  // ── Phase 2: Financial targets ─────────────────────────────────────────────
  // Goal: scale and optimise from Year 2 onwards

  {
    id:     'revenue_500k',
    phase:  'financial',
    title:  'Revenue Milestone',
    desc:   'Generate $500K in a single week',
    icon:   '💰',
    reward: 200_000,
    check: ({ lastReport }) => (lastReport?.totalRevenue ?? 0) >= 500_000,
  },

  {
    id:     'revenue_1m',
    phase:  'financial',
    title:  'Million Dollar Week',
    desc:   'Generate $1M in a single week',
    icon:   '🤑',
    reward: 300_000,
    check: ({ lastReport }) => (lastReport?.totalRevenue ?? 0) >= 1_000_000,
  },

  {
    id:     'profit_margin_15',
    phase:  'financial',
    title:  'Healthy Margins',
    desc:   'Achieve 15%+ operating profit margin in a week',
    icon:   '📊',
    reward: 250_000,
    check: ({ lastReport, weekProfit }) => {
      const rev = lastReport?.totalRevenue ?? 0;
      if (rev <= 0) return false;
      return weekProfit / rev >= 0.15;
    },
  },

  {
    id:     'fleet_10',
    phase:  'financial',
    title:  'Major Carrier',
    desc:   'Operate 10 or more aircraft',
    icon:   '🛩️',
    reward: 500_000,
    check: ({ fleet }) => fleet.filter(a => a.status !== 'retired').length >= 10,
  },

  {
    id:     'international',
    phase:  'financial',
    title:  'Going Global',
    desc:   'Serve airports in 3 or more countries',
    icon:   '🌍',
    reward: 350_000,
    check: ({ routes }) => {
      const countries = new Set(
        routes.flatMap(r => [
          getAirport(r.origin)?.country,
          getAirport(r.destination)?.country,
        ]).filter(Boolean)
      );
      return countries.size >= 3;
    },
  },

  {
    id:     'revenue_2m',
    phase:  'financial',
    title:  'Industry Leader',
    desc:   'Generate $2M in a single week',
    icon:   '🏆',
    reward: 750_000,
    check: ({ lastReport }) => (lastReport?.totalRevenue ?? 0) >= 2_000_000,
  },

  // ── Phase 3: Empire ────────────────────────────────────────────────────────
  // Goal: dominate the industry at scale (the long game)

  {
    id:     'revenue_5m',
    phase:  'empire',
    title:  'Heavyweight',
    desc:   'Generate $5M in a single week',
    icon:   '💎',
    reward: 1_500_000,
    check: ({ lastReport }) => (lastReport?.totalRevenue ?? 0) >= 5_000_000,
  },

  {
    id:     'revenue_10m',
    phase:  'empire',
    title:  'Mega Carrier',
    desc:   'Generate $10M in a single week',
    icon:   '👑',
    reward: 3_000_000,
    check: ({ lastReport }) => (lastReport?.totalRevenue ?? 0) >= 10_000_000,
  },

  {
    id:     'weekly_profit_2m',
    phase:  'empire',
    title:  'Cash Machine',
    desc:   'Bank $2M after-tax profit in a single week',
    icon:   '💵',
    reward: 2_000_000,
    check: ({ weekProfit }) => (weekProfit ?? 0) >= 2_000_000,
  },

  {
    id:     'pax_250k',
    phase:  'empire',
    title:  'People Mover',
    desc:   'Fly 250K passengers in a single week',
    icon:   '👥',
    reward: 1_500_000,
    check: ({ lastReport }) => (lastReport?.totalPassengers ?? 0) >= 250_000,
  },

  {
    id:     'fleet_25',
    phase:  'empire',
    title:  'Sky Armada',
    desc:   'Operate 25 or more aircraft',
    icon:   '🛬',
    reward: 1_500_000,
    check: ({ fleet }) => fleet.filter(a => a.status !== 'retired').length >= 25,
  },

  {
    id:     'fleet_50',
    phase:  'empire',
    title:  'Flag Carrier',
    desc:   'Operate 50 or more aircraft',
    icon:   '🏢',
    reward: 4_000_000,
    check: ({ fleet }) => fleet.filter(a => a.status !== 'retired').length >= 50,
  },

  {
    id:     'countries_6',
    phase:  'empire',
    title:  'Global Network',
    desc:   'Serve airports in 6 or more countries',
    icon:   '🌐',
    reward: 1_500_000,
    check: ({ routes }) => {
      const countries = new Set(
        routes.flatMap(r => [
          getAirport(r.origin)?.country,
          getAirport(r.destination)?.country,
        ]).filter(Boolean)
      );
      return countries.size >= 6;
    },
  },

  {
    id:     'annual_profit_25m',
    phase:  'empire',
    title:  'Banner Year',
    desc:   'Earn $25M total profit over a rolling 52 weeks',
    icon:   '📅',
    reward: 3_000_000,
    check: ({ financialHistory }) =>
      financialHistory.reduce((s, h) => s + (h.profit ?? 0), 0) >= 25_000_000,
  },

  {
    id:     'net_worth_100m',
    phase:  'empire',
    title:  'War Chest',
    desc:   'Hold $100M in cash on hand',
    icon:   '🏦',
    reward: 3_000_000,
    check: ({ cash }) => (cash ?? 0) >= 100_000_000,
  },

  {
    id:     'market_cap_1b',
    phase:  'empire',
    title:  'Unicorn',
    desc:   'Reach a $1B market capitalisation',
    icon:   '🦄',
    reward: 5_000_000,
    check: ({ marketCap }) => (marketCap ?? 0) >= 1_000_000_000,
  },
];

// ── Multiplayer starter objectives (Headwinds) ───────────────────────────────
//
// A compact 10-objective set used in multiplayer worlds instead of the solo
// three-phase board. Goal: give a new player a guided on-ramp with cash
// bonuses (~$6.8M total vs $15M starting capital) rather than a lifetime
// achievement list — humans are the endgame in multiplayer.
//
// Extra snapshot fields used here (provided by ADVANCE_WEEK):
//   hubs        { [code]: { tier, tierSince } } — every airline starts with a
//               tier-1 hub at its base, so "Hub Investor" requires tier ≥ 2
//   paxAllTime  cumulative passengers flown across the whole game (all weeks)

export const MULTIPLAYER_OBJECTIVE_TEMPLATES = [

  {
    id:     'mp_first_route',
    phase:  'starter',
    title:  'First Departure',
    desc:   'Launch your first route',
    icon:   '✈️',
    reward: 250_000,
    check: ({ routes }) => routes.length >= 1,
  },

  {
    id:     'mp_international',
    phase:  'starter',
    title:  'Border Crosser',
    desc:   'Open your first international route',
    icon:   '🌍',
    reward: 350_000,
    check: ({ routes }) => routes.some(r => {
      const a = getAirport(r.origin)?.country;
      const b = getAirport(r.destination)?.country;
      return !!a && !!b && a !== b;
    }),
  },

  {
    id:     'mp_first_profit',
    phase:  'starter',
    title:  'In the Black',
    desc:   'Achieve a profitable week',
    icon:   '💚',
    reward: 400_000,
    check: ({ weekProfit }) => weekProfit > 0,
  },

  {
    id:     'mp_routes_5',
    phase:  'starter',
    title:  'Network Builder',
    desc:   'Operate 5 or more city pairs',
    icon:   '🗺️',
    reward: 500_000,
    check: ({ routes }) => {
      const pairs = new Set(routes.map(r => {
        const [a, b] = [r.origin, r.destination].sort();
        return `${a}-${b}`;
      }));
      return pairs.size >= 5;
    },
  },

  {
    id:     'mp_fleet_5',
    phase:  'starter',
    title:  'Growing Fleet',
    desc:   'Operate 5 or more aircraft',
    icon:   '🛫',
    reward: 500_000,
    check: ({ fleet }) => fleet.filter(a => a.status !== 'retired').length >= 5,
  },

  {
    id:     'mp_fleet_10',
    phase:  'starter',
    title:  'Major Carrier',
    desc:   'Operate 10 or more aircraft',
    icon:   '🛩️',
    reward: 1_000_000,
    check: ({ fleet }) => fleet.filter(a => a.status !== 'retired').length >= 10,
  },

  {
    id:     'mp_hub_tier2',
    phase:  'starter',
    title:  'Hub Investor',
    desc:   'Upgrade a hub to Tier 2',
    icon:   '🏗️',
    reward: 750_000,
    check: ({ hubs }) => Object.values(hubs ?? {}).some(h => (h?.tier ?? 0) >= 2),
  },

  {
    id:     'mp_pax_10k',
    phase:  'starter',
    title:  '10,000 Passengers',
    desc:   'Fly 10,000 passengers in total',
    icon:   '👥',
    reward: 300_000,
    check: ({ paxAllTime }) => (paxAllTime ?? 0) >= 10_000,
  },

  {
    id:     'mp_pax_100k',
    phase:  'starter',
    title:  '100,000 Passengers',
    desc:   'Fly 100,000 passengers in total',
    icon:   '🧳',
    reward: 750_000,
    check: ({ paxAllTime }) => (paxAllTime ?? 0) >= 100_000,
  },

  {
    id:     'mp_pax_1m',
    phase:  'starter',
    title:  'Millionth Passenger',
    desc:   'Fly 1,000,000 passengers in total',
    icon:   '🏆',
    reward: 2_000_000,
    check: ({ paxAllTime }) => (paxAllTime ?? 0) >= 1_000_000,
  },
];

/** All objective IDs in order */
export const OBJECTIVE_IDS = OBJECTIVE_TEMPLATES.map(t => t.id);

/** Multiplayer starter objective IDs in order */
export const MULTIPLAYER_OBJECTIVE_IDS = MULTIPLAYER_OBJECTIVE_TEMPLATES.map(t => t.id);

/** Template list for a named set ('multiplayer' → starter set, default solo board) */
export function objectiveTemplatesForSet(set) {
  return set === 'multiplayer' ? MULTIPLAYER_OBJECTIVE_TEMPLATES : OBJECTIVE_TEMPLATES;
}

/** Look up a template by id (searches solo + multiplayer sets; ids are unique) */
export function getObjective(id) {
  return OBJECTIVE_TEMPLATES.find(t => t.id === id)
      ?? MULTIPLAYER_OBJECTIVE_TEMPLATES.find(t => t.id === id)
      ?? null;
}

/**
 * Build the initial objectives array for a new game.
 * Pass set='multiplayer' for the Headwinds starter board (default: solo board).
 * Returns [{ id, completed: false, completedWeek: null, completedYear: null }]
 */
export function initialObjectives(set) {
  return objectiveTemplatesForSet(set).map(t => ({
    id:             t.id,
    completed:      false,
    completedWeek:  null,
    completedYear:  null,
  }));
}

/**
 * Build the initial objectives array for an existing (upgraded) game.
 * Any objective that is ALREADY met is silently pre-marked completed
 * (no reward, no toast) so the player only earns credit going forward.
 */
export function initialObjectivesForState(snap, set) {
  return objectiveTemplatesForSet(set).map(t => {
    let alreadyMet = false;
    try { alreadyMet = t.check(snap); } catch { /* ignore */ }
    return {
      id:            t.id,
      completed:     alreadyMet,
      completedWeek: alreadyMet ? snap.week  : null,
      completedYear: alreadyMet ? snap.year  : null,
      legacy:        alreadyMet,   // flag: completed before objectives were enabled
    };
  });
}

/**
 * Check all uncompleted objectives against a state snapshot.
 * Returns { newlyCompleted: [id, ...] }
 */
export function checkObjectives(objectives, snap) {
  const newlyCompleted = [];

  for (const obj of objectives) {
    if (obj.completed) continue;
    const tmpl = getObjective(obj.id);
    if (!tmpl) continue;
    try {
      if (tmpl.check(snap)) {
        newlyCompleted.push(obj.id);
      }
    } catch {
      // silently skip if check throws (e.g. missing data on old saves)
    }
  }

  return { newlyCompleted };
}
