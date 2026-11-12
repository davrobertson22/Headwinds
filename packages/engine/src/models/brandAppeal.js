// ─────────────────────────────────────────────────────────────────────────────
// BRAND APPEAL — why travellers pick you, for the Brand page
//
// Every passenger in the demand model is a business or a leisure traveller, and
// on a contested pair each one scores every carrier with computeUtility: price,
// quality, frequency, hub connections, campaigns, brand reach, lounges, airport
// appeal, travel partners, loyalty and the jet age, with different weights for
// the two segments. Share is a softmax over those scores, so a difference of d
// in one term multiplies your odds of being picked by exactly e^d. That is the
// whole page: for each segment, how far each term puts you ahead of or behind
// the average rival on the same pair, averaged over your routes by passengers.
//
// The terms come from computeUtility itself (its `out` argument), on the very
// offers pairMarketShare builds for the share fight the tick runs — so the page
// cannot explain a different sum from the one that books the passengers.
//
// A pair you fly alone has no rival to beat: there the same factors decide how
// many people fly at all, not who with. Those pairs are counted
// (`soloPairs`) and left out of the comparison rather than compared to nothing.
// ─────────────────────────────────────────────────────────────────────────────

import { computeUtility, awarenessRampUtil, UTILITY_PARTS } from './demand.js';
import { pairMarketShare } from './pairShare.js';
import { routePairKey, isMultiStop } from '../utils/simulation.js';

/** Pairs scored per page view: the busiest ones, so a 300-route airline stays quick. */
export const BRAND_MAX_PAIRS = 40;

/** A term under this many log points (≈2%) is noise, not a reason. */
const MIN_REASON = 0.02;

/** Every term the page reports: computeUtility's, plus the newcomer ramp. */
export const APPEAL_TERMS = [...UTILITY_PARTS, 'newcomer'];

// Plain-language names and reasons. [helping, hurting]; a segment-specific pair
// wins over the shared one.
const TERM_INFO = {
  price:        { name: 'Price', up: 'Cheaper than rivals', down: 'Fares higher than rivals',
                  business: { down: 'Business fares higher than rivals' } },
  quality:      { name: 'Quality',
                  business: { up: 'Better business product', down: 'Weaker business product' },
                  leisure:  { up: 'Better economy product',  down: 'Weaker economy product' } },
  frequency:    { name: 'Frequency', up: 'More flights than rivals', down: 'Fewer flights than rivals' },
  connectivity: { name: 'Hub connections', up: 'Better connections at your hubs', down: 'Rivals connect to more places' },
  marketing:    { name: 'Targeted campaigns', up: 'Your ad campaigns', down: "Rivals' ad campaigns" },
  brand:        { name: 'Brand (awareness and reputation)', up: 'Well-known, trusted brand', down: 'Brand not well known yet' },
  lounge:       { name: 'Lounges', up: 'Your lounges', down: "Rivals' lounges" },
  airport:      { name: 'Airports', up: 'Handier airports', down: 'Less convenient airports' },
  travel:       { name: 'Travel partners', up: 'Your travel partners', down: "Rivals' travel partners",
                  business: { up: 'Hotel and ride-share partners' },
                  leisure:  { up: 'Cruise and tour partners' } },
  loyalty:      { name: 'Loyalty', up: 'Loyal members', down: "Rivals' loyalty schemes" },
  jetAge:       { name: 'Aircraft', up: 'Jets against propeller rivals', down: 'Propellers against jets' },
  newcomer:     { name: 'New on the route', up: 'Established on your routes', down: 'Still new on some routes' },
};

export function termName(key) { return TERM_INFO[key]?.name ?? key; }

export function termReason(key, segment, helping) {
  const info = TERM_INFO[key] ?? {};
  const seg = info[segment] ?? {};
  const k = helping ? 'up' : 'down';
  return seg[k] ?? info[k] ?? termName(key);
}

/**
 * Verdict bands on the total log-odds against the average rival. Symmetric, so
 * "Average" means within about ±16% of the field.
 */
export function appealVerdict(total) {
  if (!Number.isFinite(total)) return null;
  if (total >= 0.6)   return { level: 5, label: 'Excellent',     line: 'They choose you over almost any rival.' };
  if (total >= 0.15)  return { level: 4, label: 'Strong',        line: 'They prefer you to most rivals.' };
  if (total > -0.15)  return { level: 3, label: 'Average',       line: 'They see you as no better or worse than rivals.' };
  if (total > -0.6)   return { level: 2, label: 'Below average', line: 'Most of them prefer your rivals.' };
  return               { level: 1, label: 'Weak',          line: 'They pick a rival whenever they can.' };
}

const bizCapable = (o) => o?.businessPrice != null && (o.businessSeats ?? 0) > 0;

function termsOf(offer, market, segment) {
  const out = {};
  computeUtility(offer, market, segment, out);
  out.newcomer = awarenessRampUtil(market, offer);
  return out;
}

/** The pairs to score: one per city pair you fly nonstop, busiest first. */
function brandPairs(state, max) {
  const pax = {};
  for (const rr of state.lastReport?.routeResults ?? []) {
    if (rr?.routeId != null) pax[rr.routeId] = rr.totalPax ?? rr.passengers ?? 0;
  }
  const byPair = new Map();
  for (const r of state.routes ?? []) {
    if (!r?.origin || !r?.destination || isMultiStop(r)) continue;
    const key = routePairKey(r.origin, r.destination);
    const weight = (pax[r.id] ?? 0) + (r.weeklyFrequency ?? 0) / 1000;
    const cur = byPair.get(key);
    if (cur) cur.weight += weight;
    else byPair.set(key, { key, origin: r.origin, destination: r.destination, weight });
  }
  const all = [...byPair.values()].sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : 1));
  return { pairs: all.slice(0, max), capped: all.length > max };
}

/**
 * Business and leisure appeal against the average rival.
 *
 * @returns {{
 *   pairsScored: number, soloPairs: number, totalPairs: number, capped: boolean,
 *   business: SegmentAppeal, leisure: SegmentAppeal,
 * }}
 * SegmentAppeal = { contestedPairs, total, multiplier, verdict, terms: [{ key,
 *   name, delta, multiplier, ahead, behind }], helping: [{key, reason}],
 *   hurting: [{key, reason}] } — `total`/`verdict` null with no contested pair.
 */
export function brandAppeal(state, { maxPairs = BRAND_MAX_PAIRS } = {}) {
  const { pairs, capped } = brandPairs(state, maxPairs);
  const acc = { business: newAcc(), leisure: newAcc() };
  let soloPairs = 0, scored = 0;

  for (const p of pairs) {
    let ps;
    try { ps = pairMarketShare(state, p.origin, p.destination); }
    catch { continue; }   // one malformed pair must never take the page down
    if (!ps?.playerResult || !ps.offers?.length) continue;
    scored++;
    const player = ps.offers[0];
    const rivals = ps.offers.filter((o) => o.airlineId !== 'player');
    if (rivals.length === 0) { soloPairs++; continue; }

    for (const segment of ['business', 'leisure']) {
      let field = rivals;
      if (segment === 'business') {
        // The business softmax only seats carriers that sell a business cabin.
        if (!bizCapable(player)) continue;
        field = rivals.filter(bizCapable);
        if (field.length === 0) continue;
      }
      const mine = termsOf(player, ps.market, segment);
      const theirs = field.map((o) => termsOf(o, ps.market, segment));
      // "The average rival" is the field weighted by how the segment splits
      // between those rivals — the carriers that actually take the travellers
      // you don't count for most.
      const scores = theirs.map((t) => APPEAL_TERMS.reduce((s, k) => s + (t[k] ?? 0), 0));
      const top = Math.max(...scores);
      const w = scores.map((s) => Math.exp(s - top));
      const wSum = w.reduce((s, x) => s + x, 0) || 1;
      const pax = segment === 'business' ? ps.playerResult.businessPax : ps.playerResult.leisurePax;
      const weight = Math.max(1, pax ?? 0);
      const a = acc[segment];
      a.pairs++;
      a.weight += weight;
      for (const k of APPEAL_TERMS) {
        const base = theirs.reduce((s, t, i) => s + (t[k] ?? 0) * w[i], 0) / wSum;
        const d = (mine[k] ?? 0) - base;
        if (!Number.isFinite(d)) continue;
        a.sum[k] += d * weight;
        if (d > MIN_REASON / 2) a.ahead[k]++;
        else if (d < -MIN_REASON / 2) a.behind[k]++;
      }
    }
  }

  return {
    pairsScored: scored,
    soloPairs,
    totalPairs: pairs.length,
    capped,
    business: finish(acc.business, 'business'),
    leisure:  finish(acc.leisure, 'leisure'),
  };
}

function newAcc() {
  const z = () => Object.fromEntries(APPEAL_TERMS.map((k) => [k, 0]));
  return { pairs: 0, weight: 0, sum: z(), ahead: z(), behind: z() };
}

function finish(a, segment) {
  if (a.pairs === 0) {
    return { contestedPairs: 0, total: null, multiplier: null, verdict: null, terms: [], helping: [], hurting: [] };
  }
  const terms = APPEAL_TERMS.map((key) => {
    const delta = a.sum[key] / a.weight;
    return { key, name: termName(key), delta, multiplier: Math.exp(delta), ahead: a.ahead[key], behind: a.behind[key] };
  }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || APPEAL_TERMS.indexOf(x.key) - APPEAL_TERMS.indexOf(y.key));
  const total = terms.reduce((s, t) => s + t.delta, 0);
  const up = terms.filter((t) => t.delta >= MIN_REASON).map((t) => ({ key: t.key, reason: termReason(t.key, segment, true) }));
  const down = terms.filter((t) => t.delta <= -MIN_REASON).map((t) => ({ key: t.key, reason: termReason(t.key, segment, false) }));
  // Three lines on the card: the two biggest helps and the biggest hurt, or
  // whatever mix there is when one side is short.
  const nDown = Math.min(down.length, up.length >= 2 ? 1 : 3 - Math.min(up.length, 2));
  const nUp = Math.min(up.length, 3 - nDown);
  return {
    contestedPairs: a.pairs,
    total,
    multiplier: Math.exp(total),
    verdict: appealVerdict(total),
    terms,
    helping: up.slice(0, nUp),
    hurting: down.slice(0, nDown),
  };
}

// ── Quality ─────────────────────────────────────────────────────────────────

/**
 * The quality score's parts (calcReputation's `qualityParts`) as reasons.
 * Returns { parts: [{ key, name, points, max, detail }], helping, hurting }.
 */
export function qualityReasons(qp) {
  if (!qp) return { parts: [], helping: [], hurting: [] };
  const parts = [
    { key: 'onTime', name: 'On-time record', points: qp.onTime, max: 30,
      detail: `${Math.round((qp.onTimeRate ?? 0) * 100)}% of flights on time` },
    { key: 'rating', name: 'Customer rating', points: qp.rating, max: 28,
      detail: `${(qp.customerRating ?? 0).toFixed(1)}★ from passengers` },
    { key: 'age', name: 'Fleet age', points: qp.age, max: 20,
      detail: 'Full marks for new aircraft, nothing past about 13 years' },
    { key: 'cabin', name: 'Cabin product', points: qp.cabin, max: null,
      detail: 'Seats, service and cabin products; standard scores 0' },
  ];
  if ((qp.designAge ?? 0) < 0) {
    parts.push({ key: 'designAge', name: 'Aircraft designs', points: qp.designAge, max: null,
      detail: 'Designs over 15 years old lose points' });
  }
  if (Math.abs(qp.ground ?? 0) >= 0.5) {
    parts.push({ key: 'ground', name: 'Ground staff', points: qp.ground, max: null,
      detail: 'Ground staff morale, added on top' });
  }

  const frac = (p) => (p.max ? p.points / p.max : null);
  const helping = [];
  const hurting = [];
  for (const p of parts) {
    const f = frac(p);
    if (p.key === 'onTime') { if (f >= 0.8) helping.push([f, 'Reliable on-time record']); else if (f < 0.7) hurting.push([p.max - p.points, 'Too many delays']); }
    if (p.key === 'rating') { if (f >= 0.75) helping.push([f, 'Well-rated service']); else if (f < 0.6) hurting.push([p.max - p.points, 'Poorly rated service']); }
    if (p.key === 'age')    { if (f >= 0.7) helping.push([f, 'Young fleet']); else if (f < 0.4) hurting.push([p.max - p.points, 'Ageing fleet']); }
    if (p.key === 'cabin')  { if (p.points >= 10) helping.push([Math.min(1, p.points / 20), 'Comfortable cabins']); else if (p.points < 0) hurting.push([-p.points, 'Basic cabins']); }
    if (p.key === 'designAge' && p.points < -1) hurting.push([-p.points, 'Old aircraft designs']);
    if (p.key === 'ground') { if (p.points >= 1) helping.push([0.5, 'Happy ground staff']); else if (p.points <= -1) hurting.push([-p.points, 'Unhappy ground staff']); }
  }
  helping.sort((a, b) => b[0] - a[0]);
  hurting.sort((a, b) => b[0] - a[0]);
  const nDown = Math.min(hurting.length, helping.length >= 2 ? 1 : 3 - Math.min(helping.length, 2));
  const nUp = Math.min(helping.length, 3 - nDown);
  return {
    parts,
    helping: helping.slice(0, nUp).map(([, reason]) => ({ reason })),
    hurting: hurting.slice(0, nDown).map(([, reason]) => ({ reason })),
  };
}
