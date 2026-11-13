// Era pre-flight: turn an engine era refusal into a sentence the player reads.
//
// In an era world the reducer refuses an anachronism (Wi-Fi in 1971, a lounge
// network in 1960, a global alliance in 1955) through refuseEraFeature, which
// returns a NEW state carrying a warning toast. routes/decisions.mjs decides
// whether a decision did anything by `next !== injected`, so every one of
// those refusals was saved and answered 201 — the client had nothing to roll
// back and nothing to show. Same failure shape as lib/routeBlocks.mjs.
//
// Which actions are gated, and by which feature, is listed once in the engine
// (ERA_GATED_ACTIONS); tools/wifi-era-retrofit-test.mjs fails if that list
// drifts from the reducer's refuseEraFeature call sites.
//
// Deliberately free of prisma/env imports so it can be unit-tested directly.
import { eraFeatureDenial } from '../../../../packages/engine/src/reducer.mjs';
import { ERA_GATED_ACTIONS } from '../../../../packages/engine/src/data/eraFeatures.js';
import { isLoyaltyPoolsWorld } from '../../../../packages/engine/src/models/loyaltyPools.js';

/**
 * Why the engine would refuse this action as not yet invented, or null.
 *
 * @param {string} type   the validated action type
 * @param {object} state  the rival-injected state the reducer will run on
 * @returns {string|null}
 */
export function eraBlockReasonFor(type, state) {
  const feature = ERA_GATED_ACTIONS[type];
  if (!feature) return null;
  // The reducer ignores SET_LOYALTY_GENEROSITY outside loyalty-pools worlds
  // BEFORE it looks at the era; refusing it here would speak for a no-op.
  if (type === 'SET_LOYALTY_GENEROSITY' && !isLoyaltyPoolsWorld(state)) return null;
  return eraFeatureDenial(state, feature)?.message ?? null;
}
