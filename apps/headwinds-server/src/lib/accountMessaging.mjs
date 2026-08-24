// Account-level messaging — the rules, pure (player profiles, phase 3).
//
// Account DMs are the world-less sibling of world messages: same body cap,
// same hourly rate limit, plus one new lever — a per-account DM policy.
// The policy default is SHARED_WORLD: anyone you have EVER shared a world
// with (finished seasons included — a season you played against someone is a
// relationship), which keeps cold-contact spam off players by default without
// walling off actual rivals.

export const ACCOUNT_MESSAGE_MAX_LENGTH = 1000; // matches MESSAGE_MAX_LENGTH
export const ACCOUNT_MESSAGE_RATE_LIMIT_PER_HOUR = 30; // matches world DMs

export const DM_POLICIES = ['EVERYONE', 'SHARED_WORLD', 'NOBODY'];
export const DEFAULT_DM_POLICY = 'SHARED_WORLD';

/**
 * Why a sender may not open this conversation, or null if they may.
 *
 * Deliberately the SAME refusal text for NOBODY as for a block, so a refusal
 * never reveals whether it was personal.
 *
 * @param {string|null} policy       the target's dmPolicy (null = legacy row → default)
 * @param {object} ctx
 * @param {boolean} ctx.sharesWorld  do sender and target share any world, ever?
 * @returns {string|null}
 */
export function dmRefusal(policy, { sharesWorld = false } = {}) {
  const p = DM_POLICIES.includes(policy) ? policy : DEFAULT_DM_POLICY;
  if (p === 'NOBODY') return 'This player is not accepting messages.';
  if (p === 'SHARED_WORLD' && !sharesWorld) {
    return 'This player only accepts messages from people they share a world with.';
  }
  return null;
}
