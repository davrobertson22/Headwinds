// The jet age — passengers abandon propellers on longer sectors (era worlds).
//
// WHY. Discord (Kat the Fox, 2026-11-03, Timely Takeoff): "the last week of '66
// and the #1 airline has 0 jets but 406 Vanguards." Nothing in the demand model
// knew what a passenger was sitting in beyond the quality score, and a 1961
// Vanguard is inside the design-age grace period until 1976. So the Vanguard —
// 139 seats at 5.0¢ a seat-km against the Caravelle's 7.2¢, with a 30-minute
// turn that hands back most of what it loses in cruise speed — carried exactly
// the passengers a jet did and was simply the best airliner of the 1960s.
//
// Historically it was the opposite: within a few years of the 707 and DC-8
// travellers would wait for, connect to, or pay more for "jet service", and the
// big turboprops (Britannia, Electra, Vanguard) were off the trunk routes by the
// mid-60s while their smaller siblings kept the short hops for decades.
//
// WHAT. A demand factor ≤ 1 on a propeller-driven airliner's offer (the game
// files every piston and turboprop under 'Turboprop'):
//
//   loss = JET_AGE_MAX_LOSS × yearRamp × distanceRamp
//   yearRamp     0 in 1958 (707 and Comet 4 enter service) → 1 by 1965
//   distanceRamp 0 at ≤ 400 km (props hold the short hops) → 1 at ≥ 1,600 km
//
// It enters the model through the same two channels as airport appeal and
// brand reach, so the monopoly and contested paths agree where they meet:
//   • the POOL (both segments): on a pair only props fly, the travellers who
//     want a jet drive, take the train, connect on someone else, or don't go.
//     Before elasticity and the capacity cap, so a deep market still fills a
//     prop — it just stops being able to charge for it.
//   • the SHARE: log(appeal) in the utility, weight 1, so against a jet at the
//     same fare and quality a full-penalty prop keeps 0.65 / 1.65 ≈ 39%.
// On a contested pair the pool reached is the BEST appeal in the fight: one jet
// on the pair and nobody is turned away — they just fly the jet.
//
// Era worlds only (the published era calendar year). Classic worlds are frozen
// at 2026 and untouched — calYear null returns 1 everywhere, so golden-master
// parity holds. Applies to live era worlds from their next tick (Dave,
// 2026-11-06), the way the design-age penalty does.
//
// Freighters are exempt: freight does not care what is on the wing.

import { getEraCalendarYear } from '../utils/market.js';

export const JET_AGE_FROM_YEAR = 1958;
export const JET_AGE_FULL_YEAR = 1965;
export const JET_AGE_SHORT_KM  = 400;
export const JET_AGE_LONG_KM   = 1600;
export const JET_AGE_MAX_LOSS  = 0.35;

/** A propeller-driven passenger type — every piston and turboprop airliner. */
export function isPropAirliner(type) {
  return !!type && !type.freighter && type.category === 'Turboprop';
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** 0 → 1 across the jet-age transition; 0 outside an era world. */
export function jetAgeYearRamp(calYear = getEraCalendarYear()) {
  if (calYear == null) return 0;
  return clamp01((calYear - JET_AGE_FROM_YEAR) / (JET_AGE_FULL_YEAR - JET_AGE_FROM_YEAR));
}

/** 0 → 1 with sector length. */
export function jetAgeDistanceRamp(distKm) {
  return clamp01(((Number(distKm) || 0) - JET_AGE_SHORT_KM) / (JET_AGE_LONG_KM - JET_AGE_SHORT_KM));
}

/**
 * Demand appeal (0.65 … 1) of flying `type` on a `distKm` sector in calendar
 * year `calYear` (defaults to the era calendar the reducer publishes). 1 for
 * jets, freighters, short hops, the pre-jet era and every classic world.
 */
export function jetAgeAppeal(type, distKm, calYear = getEraCalendarYear()) {
  if (!isPropAirliner(type)) return 1;
  const loss = JET_AGE_MAX_LOSS * jetAgeYearRamp(calYear) * jetAgeDistanceRamp(distKm);
  return loss > 0 ? +(1 - loss).toFixed(4) : 1;
}

/**
 * Frequency-weighted appeal of a mixed schedule on one pair — the tick's
 * multi-aircraft pre-pass, the pairShare preview and a human rival's spec all
 * blend with this, so a pair flown half by jets and half by props sits halfway.
 *
 * @param {{ type: object, freq: number }[]} items
 */
export function blendJetAgeAppeal(items, distKm, calYear = getEraCalendarYear()) {
  let w = 0, s = 0;
  for (const { type, freq } of items ?? []) {
    const f = Math.max(0, Number(freq) || 0);
    if (f <= 0) continue;
    w += f; s += f * jetAgeAppeal(type, distKm, calYear);
  }
  return w > 0 ? +(s / w).toFixed(4) : 1;
}

/**
 * The share of a contested pair's travellers that the offers reach between
 * them: the best appeal in the fight. One jet on the pair and nobody is turned
 * away; for a single offer it is that offer's own appeal — the monopoly rule.
 */
export function offersJetAgeCapture(offers) {
  let best = 0, any = false;
  for (const o of offers ?? []) {
    any = true;
    best = Math.max(best, Math.min(1, Math.max(0, o?.jetAgeAppeal ?? 1)));
    if (best >= 1) return 1;
  }
  return any ? best : 1;
}

/** The spread-in field for an offer or route object: {} when it is parity. */
export function jetAgeFields(appeal) {
  return appeal != null && appeal < 1 ? { jetAgeAppeal: appeal } : {};
}
