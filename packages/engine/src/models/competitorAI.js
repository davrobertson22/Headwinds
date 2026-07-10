// ─────────────────────────────────────────────────────────────────────────────
// ADAPTIVE COMPETITOR AI
//
// Replaces the old fixed expansion script (COMPETITOR_EXPANSION_SCHEDULE) with
// living airlines that manage their networks like the player does:
//
//   • Each carrier has a PERSONALITY ARCHETYPE that shapes where it expands,
//     how fast it acts, and how it treats the player.
//   • Expansion is funded by real cash: a carrier opens routes only when it can
//     afford the aircraft deposits, and it targets markets that fit its style.
//   • Routes that lose money for a sustained stretch get cut. Distressed
//     carriers shrink; carriers with negative cash enter FIRE SALE (cheap to
//     acquire); prolonged distress ends in bankruptcy.
//   • Strong carriers occasionally acquire weak ones (AI-vs-AI mergers), and
//     new startup airlines appear mid-game — the market stays alive.
//   • On routes shared with the player, carriers match capacity when it is
//     profitable to do so, and pricing reactions (tickCompetitorPricing) still
//     apply every week.
//
// Everything here is pure apart from Math.random. Called once per ADVANCE_WEEK
// from GameContext, before competitor weekly stats are computed.
// ─────────────────────────────────────────────────────────────────────────────

import { baseCityPairDemand, routeDistance, referencePrice } from '../utils/market.js';
import { getAircraftType } from '../data/aircraft.js';
import { ALLIANCES } from '../data/alliances.js';
import {
  pickCompetitorAircraftType,
  tailsForRoute,
  makeCompetitorTail,
  generateStarterRoutes,
  buildCompetitorFleet,
  bigAirports,
  TIER_PRICE_MULT,
  tickCompetitorPricing,
  computeCompetitorRoutePnL,
  buildPairIncumbents,
} from './demand.js';

// ─── Personality archetypes ──────────────────────────────────────────────────

/**
 * actEvery: weeks between network decisions (staggered per carrier).
 * Lower = more hyperactive management.
 */
export const ARCHETYPES = {
  aggressive:   { label: 'Aggressive',   icon: '⚔️', actEvery: 4, blurb: 'Attacks rivals head-on, targeting busy routes others already fly — including yours.' },
  expansionist: { label: 'Expansionist', icon: '🚀', actEvery: 3, blurb: 'Grows fast and thin, opening new spokes wherever cash allows.' },
  fortress:     { label: 'Fortress',     icon: '🏰', actEvery: 6, blurb: 'Builds density at its home hub and defends it fiercely.' },
  copycat:      { label: 'Copycat',      icon: '🪞', actEvery: 5, blurb: 'Watches successful routes — especially yours — and follows onto proven markets.' },
  niche:        { label: 'Niche',        icon: '🧭', actEvery: 6, blurb: 'Seeks under-served markets and avoids crowded lanes.' },
  balanced:     { label: 'Balanced',     icon: '⚖️', actEvery: 5, blurb: 'Steady, profit-first network management.' },
};

const TIER_ARCHETYPE_POOL = {
  budget:  ['aggressive', 'expansionist', 'copycat', 'balanced'],
  legacy:  ['fortress', 'copycat', 'balanced', 'aggressive'],
  premium: ['fortress', 'niche', 'balanced'],
};

/** Pick an archetype appropriate to the carrier's tier. */
export function assignArchetype(airline) {
  const pool = TIER_ARCHETYPE_POOL[airline.tier] ?? TIER_ARCHETYPE_POOL.legacy;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Tunable knobs ───────────────────────────────────────────────────────────

/** Cash a carrier keeps untouched before funding expansion. */
const CASH_RESERVE = { budget: 3_000_000, legacy: 8_000_000, premium: 12_000_000 };

/** Network size ceilings (soft — mergers may exceed briefly). */
const MAX_ROUTES = { budget: 26, legacy: 30, premium: 22 };

/** Never shrink below this many routes voluntarily. */
const MIN_ROUTES = 3;

/** Cumulative loss-weeks on a route before it gets cut. */
const LOSS_WEEKS_TO_CUT = 10;

/** Fire sale: acquisition premium drops from 1.25× to this while flag is set. */
export const FIRE_SALE_PREMIUM = 0.75;

/** Bankruptcy triggers. */
const BANKRUPT_CASH_FLOOR   = -15_000_000;
const BANKRUPT_DISTRESS_WKS = 15;

/** Weekly probability of an AI-vs-AI merger being attempted (needs candidates). */
const MERGER_PROB = 0.025;

// ── Fare wars ────────────────────────────────────────────────────────────────

/** Chance (per action week) a provoked carrier declares a fare war. */
const FARE_WAR_PROB = 0.30;
/** How far below the player's fare ratio a warring carrier prices. */
const FARE_WAR_UNDERCUT = 0.15;
/** Absolute fare-ratio floors during a war — below normal tier floors (that's the point). */
const FARE_WAR_FLOOR = { budget: 0.50, legacy: 0.62, premium: 0.85 };
/** War duration: base + random extra weeks. */
const FARE_WAR_MIN_WEEKS = 6;
const FARE_WAR_EXTRA_WEEKS = 8;

// ── Quality investment ───────────────────────────────────────────────────────

/** Quality score ceilings/floors by tier — investment can't escape your business model. */
const QUALITY_CAP   = { budget: 55, legacy: 82, premium: 96 };
const QUALITY_FLOOR = { budget: 28, legacy: 48, premium: 62 };
/** Cash cost per quality point invested. */
const QUALITY_INVEST_COST = 400_000;

// ── Alliances & hubs ─────────────────────────────────────────────────────────

/** Chance (per action week) an unallied healthy carrier joins an alliance.
 *  Budget carriers rarely do — the LCC model goes it alone, like real life. */
const ALLIANCE_JOIN_PROB = { budget: 0.015, legacy: 0.06, premium: 0.06 };
/** Chance (per action week) a fire-sale carrier is expelled from its alliance. */
const ALLIANCE_EXPEL_PROB = 0.25;
/** Max members per alliance bloc. */
const ALLIANCE_MAX_MEMBERS = 8;
/** Quality-score bonus a carrier's offers get from alliance membership. */
export const ALLIANCE_OFFER_QUALITY_BONUS = 3;

/** Network size + cash needed before a carrier opens a second hub. */
const SECOND_HUB_MIN_ROUTES = 10;
const SECOND_HUB_MIN_TOUCHES = 4;

/**
 * Dividend retention: above this cash pile, a carrier pays most of its profit
 * out to shareholders instead of banking it (keeps market caps acquirable).
 */
export const DIVIDEND_CASH_THRESHOLD = 400_000_000;
export const DIVIDEND_RETENTION      = 0.35;

/**
 * Apply dividend policy to a week's profit: how much of `profit` a carrier
 * actually adds to its cash pile given its current balance.
 */
export function retainedProfit(cash, profit) {
  if (profit <= 0 || cash < DIVIDEND_CASH_THRESHOLD) return profit;
  return Math.round(profit * DIVIDEND_RETENTION);
}

// ── Competitor marketing (share of voice) ────────────────────────────────────
//
// Every carrier projects a marketing "voice" at the airports it serves —
// heaviest at its home hub, a small station presence everywhere else, scaled
// by tier and cut when distressed. On top of that, carriers can run ad
// BLITZES: time-limited campaigns (paid weekly from real cash) launched to
// counter a player campaign at their hub, or occasionally unprovoked.
// The player's targeted campaigns compete against this voice (see
// shareOfVoiceFactor / competitorPressureDrag in overhead.js).

const MKT_HUB_SPEND     = { budget:  90_000, legacy: 220_000, premium: 300_000 };
const MKT_STATION_SPEND = { budget:   8_000, legacy:  18_000, premium:  25_000 };
const BLITZ_MAX_MULT    = 3;         // blitz spend cap: 3× the carrier's hub baseline
const BLITZ_MIN_WEEKS   = 6;
const BLITZ_EXTRA_WEEKS = 8;
/** Player campaign spend at a carrier's hub that provokes a counter-blitz. */
const BLITZ_PROVOKE_SPEND = 100_000;
/** Weekly counter-blitz probability by archetype (when provoked + healthy). */
const BLITZ_PROB = { fortress: 0.20, aggressive: 0.15, expansionist: 0.08, copycat: 0.06, niche: 0.03, balanced: 0.06 };
/** Weekly probability of an unprovoked hub brand campaign (healthy carriers). */
const BLITZ_UNPROVOKED_PROB = 0.012;

/**
 * Total competitor marketing spend ($/wk) per airport, for share-of-voice.
 * Pure derivation from competitor state — call each tick, nothing stored.
 * @returns {{[airportCode: string]: number}}
 */
export function competitorMarketingSpend(competitors) {
  const voice = {};
  const add = (code, amt) => { if (code && amt > 0) voice[code] = (voice[code] ?? 0) + amt; };
  for (const c of competitors ?? []) {
    if (!c) continue;
    const healthMult = c.fireSale ? 0.25 : (c._distressWeeks ?? 0) > 3 ? 0.5 : 1;
    add(c.homeHub, (MKT_HUB_SPEND[c.tier] ?? 150_000) * healthMult);
    if (c.secondaryHub) add(c.secondaryHub, (MKT_HUB_SPEND[c.tier] ?? 150_000) * 0.6 * healthMult);
    const station = (MKT_STATION_SPEND[c.tier] ?? 15_000) * healthMult;
    for (const key of Object.keys(c.routes ?? {})) {
      const [a, b] = key.split('-');
      if (a !== c.homeHub) add(a, station);
      if (b !== c.homeHub) add(b, station);
    }
    for (const [code, blitz] of Object.entries(c._mktBlitz ?? {})) {
      add(code, (blitz.spend ?? 0));
    }
  }
  return voice;
}

/** Weekly probability of a startup airline launching (gated by roster size). */
const STARTUP_PROB    = 0.020;
const MAX_ROSTER      = 28;
const ENDGAME_ROSTER  = 4;    // stop spawning startups when few rivals remain
const STARTUP_MIN_WEEK = 26;  // let the opening board settle first

// ─── Startup airline pool ────────────────────────────────────────────────────

const STARTUP_POOL = [
  { name: 'Velocity Air',    homeHub: 'ORD', tier: 'budget',  logoId: 'bolt',    baseQualityScore: 40, cash: 12_000_000 },
  { name: 'Aurora Air',      homeHub: 'HEL', tier: 'legacy',  logoId: 'arctic',  baseQualityScore: 60, cash: 22_000_000 },
  { name: 'Sirocco Express', homeHub: 'CMN', tier: 'budget',  logoId: 'prism',   baseQualityScore: 36, cash:  9_000_000 },
  { name: 'Golden Gate Air', homeHub: 'SFO', tier: 'legacy',  logoId: 'compass', baseQualityScore: 64, cash: 26_000_000 },
  { name: 'Bengal Sky',      homeHub: 'DEL', tier: 'legacy',  logoId: 'horizon', baseQualityScore: 61, cash: 20_000_000 },
  { name: 'Adriatic Air',    homeHub: 'VIE', tier: 'legacy',  logoId: 'comet',   baseQualityScore: 62, cash: 20_000_000 },
  { name: 'Coral Air',       homeHub: 'MNL', tier: 'budget',  logoId: 'phoenix', baseQualityScore: 38, cash: 10_000_000 },
  { name: 'Antipodes Air',   homeHub: 'AKL', tier: 'legacy',  logoId: 'summit',  baseQualityScore: 63, cash: 21_000_000 },
  { name: 'Harmattan Air',   homeHub: 'LOS', tier: 'budget',  logoId: 'bolt',    baseQualityScore: 34, cash:  8_000_000 },
  { name: 'Crystal Skies',   homeHub: 'DOH', tier: 'premium', logoId: 'crown',   baseQualityScore: 81, cash: 45_000_000 },
  { name: 'Meridian Air',    homeHub: 'GRU', tier: 'legacy',  logoId: 'eagle',   baseQualityScore: 62, cash: 22_000_000 },
  { name: 'Borealis Jet',    homeHub: 'YYZ', tier: 'budget',  logoId: 'arctic',  baseQualityScore: 39, cash: 11_000_000 },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return h;
}

const pairKeyOf = (a, b) => [a, b].sort().join('-');

/** Deposit paid when adding tails (matches the old scripted-growth model). */
function tailDeposit(type, count) {
  return count * (type?.weeklyLease ?? 0) * 4;
}

/** Cash recovered when a route is cut (partial deposit recovery / sale). */
function tailSalvage(type, count) {
  return count * (type?.weeklyLease ?? 0) * 2;
}

let _startupSeq = 0;

// ─── Main weekly tick ────────────────────────────────────────────────────────

/**
 * Advance all competitor networks by one week.
 *
 * @param {CompetitorAirline[]} competitors
 * @param {object} ctx
 *   weekNumber      total game-weeks elapsed (1-based)
 *   month           current game month 1–12 (seasonality)
 *   playerRoutes    [{ origin, destination, ticketPrice, weeklyFrequency }]
 *   playerHubs      airport codes of the player's designated hubs
 *   playerMarketCap player market cap (drives how much attention the player draws)
 * @returns {{ competitors: CompetitorAirline[], events: object[] }}
 *
 * Event types: launch | boost | cut | retrench | fireSale | recovered |
 *              bankrupt | merger | startup
 */
export function tickCompetitorAI(competitors, ctx) {
  const {
    weekNumber = 1,
    month = 1,
    playerRoutes = [],
    playerHubs = [],
    playerMarketCap = 0,
    playerCampaignSpend = {},   // { [airportCode]: $/wk } — player's targeted marketing
  } = ctx ?? {};

  const events = [];

  // ── Player market snapshot ─────────────────────────────────────────────────
  const playerPairs = new Map();   // pairKey → { freq, price }
  for (const r of playerRoutes) {
    const key = pairKeyOf(r.origin, r.destination);
    const prev = playerPairs.get(key);
    playerPairs.set(key, {
      freq:  (prev?.freq ?? 0) + (r.weeklyFrequency ?? 0),
      price: r.ticketPrice ?? prev?.price ?? null,
    });
  }
  const playerAirports = new Set();
  for (const r of playerRoutes) { playerAirports.add(r.origin); playerAirports.add(r.destination); }

  // Incumbent counts per pair (all AI carriers + player) — competition awareness
  // AND the demand-split input for per-route P&L.
  const incumbents = buildPairIncumbents(competitors, playerRoutes);

  // Player is "on the radar" once established — AI attention scales with size.
  const playerNotice = playerMarketCap >= 100_000_000 ? 1 : playerMarketCap >= 25_000_000 ? 0.5 : 0.15;

  // ── Per-carrier network management ────────────────────────────────────────
  let updated = competitors.map(airline => {
    let c = { ...airline };

    // Lazy init (new games AND old saves migrate transparently).
    if (!c._archetype) c._archetype = assignArchetype(c);
    if (c.allianceId === undefined) {
      c.allianceId = ALLIANCES.find(a => a.memberIds.includes(c.id))?.id ?? null;
    }
    const arch = ARCHETYPES[c._archetype] ?? ARCHETYPES.balanced;

    const lastProfit = (c.profitHistory && c.profitHistory.length)
      ? c.profitHistory[c.profitHistory.length - 1] : 0;
    const reserve = CASH_RESERVE[c.tier] ?? 8_000_000;

    // ── Fare-war upkeep (every week) ─────────────────────────────────────────
    if (c._fareWars && Object.keys(c._fareWars).length) {
      const wars = {};
      for (const [key, w] of Object.entries(c._fareWars)) {
        const [a, b] = key.split('-');
        if (!playerPairs.has(key) || !c.routes[key]) {
          // The player abandoned the lane (or the carrier cut it) — war over.
          events.push({ type: 'fareWarEnd', airlineId: c.id, name: c.name, routeKey: key,
            description: `${c.name} ended its fare war on ${a} → ${b} — the battle for the route is over.` });
          continue;
        }
        if ((c.cash ?? 0) < reserve * 0.3) {
          events.push({ type: 'fareWarEnd', airlineId: c.id, name: c.name, routeKey: key, capitulated: true,
            description: `${c.name} capitulated — it can no longer afford the fare war on ${a} → ${b}.` });
          continue;
        }
        if (w.weeksLeft <= 1) {
          events.push({ type: 'fareWarEnd', airlineId: c.id, name: c.name, routeKey: key,
            description: `${c.name} called a truce on ${a} → ${b}; fares are returning to normal.` });
          continue;
        }
        wars[key] = { ...w, weeksLeft: w.weeksLeft - 1 };
      }
      c._fareWars = wars;
    }

    // ── Marketing blitz upkeep + launches (every week) ───────────────────────
    if (c._mktBlitz && Object.keys(c._mktBlitz).length) {
      const live = {};
      for (const [code, b] of Object.entries(c._mktBlitz)) {
        if (b.weeksLeft <= 1 || (c.cash ?? 0) < reserve * 0.3) continue;  // expired or can't afford
        c.cash = (c.cash ?? 0) - (b.spend ?? 0);                          // paid weekly from real cash
        live[code] = { ...b, weeksLeft: b.weeksLeft - 1 };
      }
      c._mktBlitz = live;
    }
    const canBlitz = !c.fireSale && (c.cash ?? 0) > reserve;
    if (canBlitz) {
      const hubBase = MKT_HUB_SPEND[c.tier] ?? 150_000;
      const myHubs  = [c.homeHub, c.secondaryHub].filter(Boolean);
      for (const hub of myHubs) {
        if (c._mktBlitz?.[hub]) continue;
        const playerSpendHere = playerCampaignSpend[hub] ?? 0;
        const provoked = playerSpendHere >= BLITZ_PROVOKE_SPEND;
        const prob = provoked
          ? (BLITZ_PROB[c._archetype] ?? 0.06)
          : BLITZ_UNPROVOKED_PROB;
        if (Math.random() >= prob) continue;
        const spend = provoked
          ? Math.min(Math.round(playerSpendHere * 1.25), hubBase * BLITZ_MAX_MULT)
          : hubBase;
        const weeks = BLITZ_MIN_WEEKS + Math.floor(Math.random() * BLITZ_EXTRA_WEEKS);
        c._mktBlitz = { ...(c._mktBlitz ?? {}), [hub]: { spend, weeksLeft: weeks } };
        events.push({
          type: 'mktBlitz', airlineId: c.id, name: c.name, airport: hub, provoked,
          description: provoked
            ? `${c.name} launched a counter-advertising blitz at ${hub}, fighting your campaign for local mindshare.`
            : `${c.name} launched a brand campaign at ${hub} — expect stiffer competition for local passengers.`,
        });
      }
    }

    // ── Distress / fire-sale bookkeeping (every week) ────────────────────────
    const distressed = (c.cash ?? 0) < reserve * 0.5 && lastProfit < 0;
    c._distressWeeks = distressed
      ? (c._distressWeeks ?? 0) + 1
      : Math.max(0, (c._distressWeeks ?? 0) - 1);

    if ((c.cash ?? 0) < 0 && !c.fireSale) {
      c.fireSale = true;
      events.push({ type: 'fireSale', airlineId: c.id, name: c.name,
        description: `${c.name} is in financial distress — its board is entertaining takeover offers at a discount.` });
    } else if (c.fireSale && (c.cash ?? 0) > reserve) {
      c.fireSale = false;
      events.push({ type: 'recovered', airlineId: c.id, name: c.name,
        description: `${c.name} has stabilised its finances and is no longer seeking a buyer.` });
    }

    // ── Decision cadence: each carrier acts every `actEvery` weeks, staggered ─
    const acts = ((weekNumber + hashId(c.id)) % arch.actEvery) === 0;
    if (!acts) return c;

    const routes  = { ...c.routes };
    let   fleet   = [...(c.fleet ?? [])];
    let   cash    = c.cash ?? 0;
    const lossMap = { ...(c._routeLoss ?? {}) };
    const routeKeys = Object.keys(routes);

    // Per-route P&L (only on action weeks — keeps the tick cheap).
    const pnl = {};
    for (const key of routeKeys) pnl[key] = computeCompetitorRoutePnL(c, key, routes[key], month, incumbents);

    // 1. Track losses; cut chronic losers (forced cuts when broke).
    for (const key of routeKeys) {
      const p = pnl[key];
      if (!p) continue;
      lossMap[key] = p.profit < 0 ? (lossMap[key] ?? 0) + arch.actEvery : 0;
    }
    const inWar = (k) => !!(c._fareWars && c._fareWars[k]);   // war losses are deliberate — don't cut
    const cuttable = routeKeys
      .filter(k => (lossMap[k] ?? 0) >= LOSS_WEEKS_TO_CUT && !inWar(k))
      .sort((a, b) => (pnl[a]?.profit ?? 0) - (pnl[b]?.profit ?? 0));
    let cutsAllowed = cash < 0 ? 2 : 1;
    // A broke carrier retrenches even routes that haven't hit the loss timer yet.
    if (cash < 0 && cuttable.length === 0) {
      const losers = routeKeys.filter(k => (pnl[k]?.profit ?? 0) < 0)
        .sort((a, b) => (pnl[a]?.profit ?? 0) - (pnl[b]?.profit ?? 0));
      cuttable.push(...losers);
    }
    for (const key of cuttable) {
      if (cutsAllowed <= 0) break;
      if (Object.keys(routes).length <= MIN_ROUTES) break;
      const cfg  = routes[key];
      const type = cfg.aircraftType ? getAircraftType(cfg.aircraftType) : null;
      cash += tailSalvage(type, cfg.tails ?? 1);
      fleet = fleet.filter(f => f.routeKey !== key);
      delete routes[key];
      delete lossMap[key];
      cutsAllowed--;
      const [a, b] = key.split('-');
      events.push({ type: 'cut', airlineId: c.id, name: c.name, routeKey: key,
        description: `${c.name} withdrew from ${a} → ${b} after sustained losses.` });
    }

    // 2. Capacity response on routes shared with the player: match frequency
    //    where the route makes money (balanced pressure — no suicidal wars).
    let boostsAllowed = 1;
    for (const key of Object.keys(routes)) {
      if (boostsAllowed <= 0) break;
      const pInfo = playerPairs.get(key);
      if (!pInfo) continue;
      const cfg = routes[key];
      const p   = pnl[key];
      if (!p || p.profit <= 0) continue;
      // Fortress carriers defend their hub markets hardest.
      const isHubLane = key.includes(c.homeHub);
      const defendBias = (c._archetype === 'fortress' && isHubLane) ? 1.0
        : (c._archetype === 'aggressive') ? 0.8 : 0.5;
      if (pInfo.freq > cfg.frequency * 1.4 && Math.random() < defendBias * playerNotice + 0.15) {
        const targetFreq = Math.min(28, Math.max(cfg.frequency + 2, Math.round(pInfo.freq * 0.8)));
        const [a, b] = key.split('-');
        const dist   = routeDistance(a, b);
        const type   = cfg.aircraftType ? getAircraftType(cfg.aircraftType) : pickCompetitorAircraftType(dist, c.tier);
        if (!type) continue;
        const needTails = tailsForRoute(dist, targetFreq);
        const addTails  = Math.max(0, needTails - (cfg.tails ?? 1));
        const cost      = tailDeposit(type, addTails);
        if (cash - cost < reserve * 0.5) continue;
        cash -= cost;
        for (let i = 0; i < addTails; i++) fleet.push(makeCompetitorTail(c.id, type.id, key, false));
        routes[key] = { ...cfg, frequency: targetFreq, aircraftType: type.id, tails: needTails };
        boostsAllowed--;
        events.push({ type: 'boost', airlineId: c.id, name: c.name, routeKey: key,
          description: `${c.name} added capacity on ${a} → ${b}, matching your schedule.` });
      }
    }

    // 3. Quality investment: winners polish the product, losers cut service.
    const qCap   = QUALITY_CAP[c.tier]   ?? 82;
    const qFloor = QUALITY_FLOOR[c.tier] ?? 48;
    let quality  = c.baseQualityScore;
    if (c.fireSale || (c._distressWeeks ?? 0) >= 6) {
      if (quality > qFloor) {
        quality -= 1;   // service cuts: catering, cleaning, staffing
        if ((quality - qFloor) % 5 === 0) {
          events.push({ type: 'quality', airlineId: c.id, name: c.name, direction: 'down',
            description: `${c.name} is slashing service standards to conserve cash — passengers are noticing.` });
        }
      }
    } else if ((lastProfit > 0 || cash > reserve * 2) && cash - QUALITY_INVEST_COST > reserve * 1.5 && quality < qCap) {
      quality += 1;
      cash    -= QUALITY_INVEST_COST;
      const invested = (c._qualityInvested ?? 0) + 1;
      c._qualityInvested = invested;
      if (invested % 5 === 0) {
        events.push({ type: 'quality', airlineId: c.id, name: c.name, direction: 'up',
          description: `${c.name} completed a cabin & service upgrade program — its quality reputation is climbing.` });
      }
    }
    c.baseQualityScore = quality;

    // 4. Alliance diplomacy: healthy loners join blocs; broke members get expelled.
    if (!c.allianceId && (lastProfit > 0 || cash > reserve * 2)
        && weekNumber >= 13 && Math.random() < (ALLIANCE_JOIN_PROB[c.tier] ?? 0.05)) {
      const counts = {};
      for (const other of competitors) {
        const aid = other.allianceId ?? ALLIANCES.find(a => a.memberIds.includes(other.id))?.id ?? null;
        if (aid) {
          counts[aid] = counts[aid] ?? { total: 0, sameTier: 0 };
          counts[aid].total += 1;
          if (other.tier === c.tier) counts[aid].sameTier += 1;
        }
      }
      // Join the bloc with the most same-tier members that still has room.
      const open = ALLIANCES.filter(a => (counts[a.id]?.total ?? 0) < ALLIANCE_MAX_MEMBERS);
      if (open.length) {
        const pick = open.sort((a, b) =>
          (counts[b.id]?.sameTier ?? 0) - (counts[a.id]?.sameTier ?? 0)
          || (counts[a.id]?.total ?? 0) - (counts[b.id]?.total ?? 0))[0];
        c.allianceId = pick.id;
        events.push({ type: 'allianceJoin', airlineId: c.id, name: c.name, allianceId: pick.id,
          description: `${c.name} joined ${pick.name}.` });
      }
    } else if (c.allianceId && c.fireSale && Math.random() < ALLIANCE_EXPEL_PROB) {
      const aName = ALLIANCES.find(a => a.id === c.allianceId)?.name ?? c.allianceId;
      events.push({ type: 'allianceLeave', airlineId: c.id, name: c.name, allianceId: c.allianceId,
        description: `${aName} expelled the struggling ${c.name} from the alliance.` });
      c.allianceId = null;
    }

    // 5. Fare war declaration: aggressive/fortress carriers punish undercutting
    //    or an invasion of their hub — deliberately pricing below cost for weeks.
    const warCapable = (c._archetype === 'aggressive' || c._archetype === 'fortress')
      && !(c._fareWars && Object.keys(c._fareWars).length)
      && cash > reserve * 2
      && playerNotice >= 0.5;
    if (warCapable && Math.random() < FARE_WAR_PROB) {
      let warKey = null;
      for (const key of Object.keys(routes)) {
        const pInfo = playerPairs.get(key);
        if (!pInfo?.price) continue;
        const [a, b] = key.split('-');
        const refP = referencePrice(a, b);
        if (!refP) continue;
        const playerRatio = pInfo.price / refP;
        const undercutting = playerRatio < routes[key].priceMultiplier - 0.08;
        const hubInvasion  = key.includes(c.homeHub) || (c.secondaryHub && key.includes(c.secondaryHub));
        if (undercutting || (c._archetype === 'fortress' && hubInvasion)) { warKey = key; break; }
      }
      if (warKey) {
        const [a, b] = warKey.split('-');
        c._fareWars = {
          ...(c._fareWars ?? {}),
          [warKey]: { weeksLeft: FARE_WAR_MIN_WEEKS + Math.floor(Math.random() * FARE_WAR_EXTRA_WEEKS) },
        };
        events.push({ type: 'fareWar', airlineId: c.id, name: c.name, routeKey: warKey,
          description: `${c.name} declared a fare war on ${a} → ${b} — it is slashing fares below cost to drive you off the route.` });
      }
    }

    // 6. Second hub: a thriving carrier turns its busiest focus city into a hub.
    if (!c.secondaryHub && Object.keys(routes).length >= SECOND_HUB_MIN_ROUTES && cash > reserve * 3) {
      const touch = {};
      for (const key of Object.keys(routes)) {
        for (const code of key.split('-')) {
          if (code !== c.homeHub) touch[code] = (touch[code] ?? 0) + 1;
        }
      }
      const [bestCode, touches] = Object.entries(touch).sort(([, x], [, y]) => y - x)[0] ?? [null, 0];
      if (bestCode && touches >= SECOND_HUB_MIN_TOUCHES) {
        c.secondaryHub = bestCode;
        events.push({ type: 'secondHub', airlineId: c.id, name: c.name, airport: bestCode,
          description: `${c.name} designated ${bestCode} as its second hub and will build out a network there.` });
      }
    }

    // 7. Expansion: one new route per action week, if healthy and funded.
    const roomToGrow = Object.keys(routes).length < (MAX_ROUTES[c.tier] ?? 26);
    const healthy    = lastProfit > 0 || cash > reserve * 2;
    if (roomToGrow && healthy && cash > reserve) {
      const cand = pickExpansionTarget(c, routes, { incumbents, playerPairs, playerHubs, playerNotice });
      if (cand) {
        const type = pickCompetitorAircraftType(cand.dist, c.tier);
        if (type) {
          const tails = tailsForRoute(cand.dist, cand.frequency);
          const cost  = tailDeposit(type, tails);
          if (cash - cost >= reserve) {
            cash -= cost;
            for (let i = 0; i < tails; i++) fleet.push(makeCompetitorTail(c.id, type.id, cand.key, false));
            routes[cand.key] = {
              frequency:       cand.frequency,
              priceMultiplier: cand.priceMultiplier,
              aircraftType:    type.id,
              tails,
            };
            const [a, b] = cand.key.split('-');
            events.push({ type: 'launch', airlineId: c.id, name: c.name, routeKey: cand.key,
              attackedPlayer: cand.onPlayerPair,
              description: cand.onPlayerPair
                ? `${c.name} launched ${a} → ${b} — moving in on your market.`
                : `${c.name} launched new service on ${a} → ${b}.` });
          }
        }
      }
    }

    return { ...c, routes, fleet, cash, _routeLoss: lossMap };
  });

  // ── Lifecycle: bankruptcies ────────────────────────────────────────────────
  const survivors = [];
  for (const c of updated) {
    const broke = (c.cash ?? 0) < BANKRUPT_CASH_FLOOR
      || (c.fireSale && (c._distressWeeks ?? 0) >= BANKRUPT_DISTRESS_WKS);
    if (broke) {
      events.push({ type: 'bankrupt', airlineId: c.id, name: c.name,
        description: `${c.name} has ceased operations — creditors seized its fleet.` });
    } else {
      survivors.push(c);
    }
  }
  updated = survivors;

  // ── Lifecycle: AI-vs-AI mergers ────────────────────────────────────────────
  if (updated.length >= 6 && Math.random() < MERGER_PROB) {
    const buyers = updated
      .filter(c => (c.cash ?? 0) > 50_000_000 && ((c.profitHistory?.at(-1) ?? 0) > 0))
      .sort((a, b) => (b.cash ?? 0) - (a.cash ?? 0));
    const targets = updated
      .filter(c => c.fireSale || (c._distressWeeks ?? 0) >= 6)
      .sort((a, b) => (a.marketCap ?? 0) - (b.marketCap ?? 0));
    // Alliance solidarity: a distressed member's allies get first shot at the rescue.
    const target0 = targets[0];
    const allyBuyer = target0?.allianceId
      ? buyers.find(b => b.id !== target0.id && b.allianceId === target0.allianceId
          && (target0.marketCap ?? 20_000_000) * 0.9 < (b.cash ?? 0) * 0.8)
      : null;
    const buyer  = allyBuyer ?? buyers[0];
    const target = allyBuyer ? target0 : targets.find(t => t.id !== buyer?.id
      && (t.marketCap ?? 20_000_000) * 0.9 < (buyer?.cash ?? 0) * 0.8);
    if (buyer && target) {
      const price = Math.round(Math.max(5_000_000, (target.marketCap ?? 10_000_000)) * 0.9);
      const mergedRoutes = { ...buyer.routes };
      const mergedFleet  = [...(buyer.fleet ?? [])];
      for (const [key, cfg] of Object.entries(target.routes ?? {})) {
        if (mergedRoutes[key]) continue;   // keep buyer's own service on overlaps
        mergedRoutes[key] = { ...cfg };
        for (const tail of (target.fleet ?? []).filter(f => f.routeKey === key)) {
          mergedFleet.push({ ...tail, id: `${buyer.id}-x${tail.id}` });
        }
      }
      updated = updated
        .filter(c => c.id !== target.id)
        .map(c => c.id !== buyer.id ? c : {
          ...c,
          routes: mergedRoutes,
          fleet:  mergedFleet,
          cash:   (c.cash ?? 0) - price + Math.max(0, target.cash ?? 0),
        });
      events.push({ type: 'merger', airlineId: buyer.id, name: buyer.name, targetName: target.name,
        description: `${buyer.name} acquired the struggling ${target.name}, absorbing its network.` });
    }
  }

  // ── Lifecycle: startup airlines ────────────────────────────────────────────
  if (weekNumber >= STARTUP_MIN_WEEK
      && updated.length < MAX_ROSTER
      && updated.length > ENDGAME_ROSTER
      && Math.random() < STARTUP_PROB) {
    const usedNames = new Set(updated.map(c => c.name));
    const pool = STARTUP_POOL.filter(s => !usedNames.has(s.name));
    if (pool.length) {
      const spec = pool[Math.floor(Math.random() * pool.length)];
      const id   = `startup_${(++_startupSeq).toString(36)}_${hashId(spec.name).toString(36)}`;
      let newbie = {
        id,
        name: spec.name,
        homeHub: spec.homeHub,
        tier: spec.tier,
        logoId: spec.logoId,
        baseQualityScore: spec.baseQualityScore,
        cash: spec.cash,
        weeklyStats: null,
        routes: generateStarterRoutes({ homeHub: spec.homeHub, tier: spec.tier }, 3),
        isStartup: true,
        foundedWeek: weekNumber,
        _archetype: Math.random() < 0.6 ? 'expansionist' : 'aggressive',
      };
      newbie = buildCompetitorFleet(newbie);
      updated = [...updated, newbie];
      events.push({ type: 'startup', airlineId: id, name: spec.name,
        description: `A new airline, ${spec.name}, has launched operations out of ${spec.homeHub}.` });
    }
  }

  // ── Weekly price reactions on shared routes (existing behaviour) ──────────
  updated = tickCompetitorPricing(updated, playerRoutes);

  // ── Fare-war pricing override ──────────────────────────────────────────────
  // Applied AFTER normal pricing so a war always wins: the warring carrier
  // tracks the player's fare down to a deep undercut, below its usual tier
  // floor. It loses money doing this — that's the point.
  updated = updated.map(c => {
    const wars = c._fareWars;
    if (!wars || !Object.keys(wars).length) return c;
    const routes = { ...c.routes };
    let changed = false;
    for (const key of Object.keys(wars)) {
      const cfg = routes[key];
      const pInfo = playerPairs.get(key);
      if (!cfg || !pInfo?.price) continue;
      const [a, b] = key.split('-');
      const refP = referencePrice(a, b);
      if (!refP) continue;
      const floor = FARE_WAR_FLOOR[c.tier] ?? 0.62;
      const warMult = Math.max(floor, +(pInfo.price / refP - FARE_WAR_UNDERCUT).toFixed(4));
      if (Math.abs(warMult - cfg.priceMultiplier) > 0.001) {
        routes[key] = { ...cfg, priceMultiplier: warMult };
        changed = true;
      }
    }
    return changed ? { ...c, routes } : c;
  });

  return { competitors: updated, events };
}

// ─── Expansion target selection ──────────────────────────────────────────────

/**
 * Choose the best new route for a carrier given its archetype.
 * Returns { key, dist, frequency, priceMultiplier, onPlayerPair } or null.
 */
function pickExpansionTarget(airline, routes, { incumbents, playerPairs, playerHubs, playerNotice }) {
  const arch = airline._archetype ?? 'balanced';
  const hub  = airline.homeHub;

  // Bases: fortress builds only from its hub(s); growth archetypes also expand
  // from their busiest network airports (focus cities).
  const bases = new Set([hub]);
  if (airline.secondaryHub) bases.add(airline.secondaryHub);
  if (arch === 'expansionist' || arch === 'aggressive' || arch === 'copycat') {
    const touch = {};
    for (const key of Object.keys(routes)) {
      for (const code of key.split('-')) touch[code] = (touch[code] ?? 0) + 1;
    }
    Object.entries(touch)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .forEach(([code]) => bases.add(code));
  }

  const playerHubSet = new Set(playerHubs ?? []);
  let best = null;

  for (const base of bases) {
    for (const ap of bigAirports()) {
      if (ap.code === base) continue;
      const key = pairKeyOf(base, ap.code);
      if (routes[key]) continue;
      const dist = routeDistance(base, ap.code);
      if (!dist || dist < 300) continue;
      if (!pickCompetitorAircraftType(dist, airline.tier)) continue;
      const demand = baseCityPairDemand(base, ap.code);
      if (!demand || demand < 40) continue;

      const inc          = incumbents.get(key) ?? 0;
      const onPlayerPair = playerPairs.has(key);
      const touchesPlayerHub = playerHubSet.has(base) || playerHubSet.has(ap.code);

      let score = demand / (1 + dist / 9000) / (1 + inc * 0.6);
      switch (arch) {
        case 'aggressive':
          if (onPlayerPair)     score *= 1 + 1.6 * playerNotice;
          if (touchesPlayerHub) score *= 1 + 0.8 * playerNotice;
          break;
        case 'copycat':
          if (onPlayerPair) score *= 1 + 2.4 * playerNotice;
          break;
        case 'niche':
          score /= (1 + inc * 1.2);
          if (onPlayerPair) score *= 0.25;
          break;
        case 'fortress':
          // hub-only via bases; slight preference for dense trunk lanes
          score *= 1.15;
          break;
        case 'expansionist':
          score *= 0.9 + Math.random() * 0.4;   // roll the dice a bit
          break;
        default:
          break;
      }
      if (!best || score > best.score) {
        best = { key, dist, demand, score, onPlayerPair };
      }
    }
  }
  if (!best) return null;

  const seatsTarget = { budget: 160, legacy: 250, premium: 330 }[airline.tier] ?? 200;
  const frequency   = Math.max(3, Math.min(21, Math.round(best.demand / (seatsTarget * 0.75))));
  const priceBase   = TIER_PRICE_MULT[airline.tier] ?? 1.0;
  // Undercut modestly when deliberately entering the player's market.
  const undercut = best.onPlayerPair && (arch === 'aggressive' || arch === 'copycat') ? 0.93 : 1.0;
  const priceMultiplier = +(priceBase * undercut * (0.97 + Math.random() * 0.06)).toFixed(3);

  return { key: best.key, dist: best.dist, frequency, priceMultiplier, onPlayerPair: best.onPlayerPair };
}
