// Operational incidents EARNED by management — demand model v4 worlds
// (docs/game-audit-2026-11-06.md R6).
//
// WHY. The per-airline service events (catering scandal, baggage meltdown…)
// were removed because events are rolled once per WORLD and a "your caterer
// failed" story fired for every airline at once (data/events.js). The design
// call recorded there: anything that singles out one airline should be earned
// by that airline's own management. This is that mechanic.
//
// WHAT. Each week an airline runs a risk of an operational meltdown — the week
// a thin operation tips over: a storm or a sick-out cascades because there is
// no slack to absorb it. The risk is ZERO for a well-run airline and rises with
// three things the player controls:
//   • how hard the fleet is worked (average block-hour use past 85%) — made
//     worse by how few spare tails there are (idle + reserve under 5%),
//   • how unhappy the people who run the day are (the lowest of pilot, ground
//     and cabin morale under 55).
// A meltdown costs passenger satisfaction (the customer rating then recovers
// at the satisfaction model's own pace) and a bruise to reputation, and it is
// world news — named. No cash line, so the P&L reconciles exactly as before.
// Small airlines (under 5 aircraft) are exempt: there is no network to melt.

export const INCIDENT = {
  minFleet: 5,
  utilisationSafe: 0.85,       // above this the schedule has no slack
  utilisationSpan: 0.10,       // +1 risk per 10 points past it
  spareSafe: 0.05,             // spare frames as a share of the fleet
  moraleSafe: 55,
  moraleSpan: 20,
  riskFloor: 0.5,              // below this score nothing can happen
  probPerRisk: 0.04,
  probCap: 0.12,
  satisfactionShock: -6,
  reputationHit: 3,
  // Reserve staff (data/labor.js "Reserve staff"): share of the risk a full
  // reserve in every flying group removes — a sick-out is covered.
  reserveRelief: 0.30,
};

const OPS_GROUPS = ['pilots', 'groundStaff', 'cabinCrew'];

/**
 * The airline's meltdown risk this week, with the reasons. `utilisation` is
 * the fleet's average block-hour use (0–1) — the reducer passes the tick's.
 */
export function incidentRisk(state, utilisation, reserveCover = 0) {
  const fleet = (state?.fleet ?? []).filter(a => a && a.status !== 'retired');
  if (fleet.length < INCIDENT.minFleet) return { score: 0, prob: 0, causes: [] };
  const causes = [];
  let score = 0;
  // Schedule slack: a fleet worked past 85% of its hours has none. Spare tails
  // are what absorb a bad day, so a thin spare pool AMPLIFIES that risk rather
  // than adding its own — an airline flying 70% of its hours with no spares
  // still has slack in the timetable and carries no risk from either.
  const u = Number(utilisation) || 0;
  const spares = fleet.filter(a => a.status === 'idle' || !!a.reserveBase).length;   // unassigned + reserve frames
  const spareShare = spares / fleet.length;
  if (u > INCIDENT.utilisationSafe) {
    const s = (u - INCIDENT.utilisationSafe) / INCIDENT.utilisationSpan;
    const amp = spareShare < INCIDENT.spareSafe ? (INCIDENT.spareSafe - spareShare) / INCIDENT.spareSafe : 0;
    score += s * (1 + amp);
    causes.push({ kind: 'utilisation', value: +u.toFixed(3), score: +s.toFixed(3) });
    if (amp > 0) causes.push({ kind: 'spares', value: +spareShare.toFixed(3), score: +(s * amp).toFixed(3) });
  }
  const morale = Math.min(...OPS_GROUPS.map(g => Number(state?.labor?.[g]?.morale ?? 80)));
  if (morale < INCIDENT.moraleSafe) {
    const s = (INCIDENT.moraleSafe - morale) / INCIDENT.moraleSpan;
    score += s; causes.push({ kind: 'morale', value: Math.round(morale), score: +s.toFixed(3) });
  }
  // Reserve cover (0–1, labor.js opsReserveCover) takes the edge off whatever
  // risk there is; it never creates any, and 0 leaves the score untouched.
  const cover = Math.max(0, Math.min(1, Number(reserveCover) || 0));
  if (cover > 0 && score > 0) {
    score *= 1 - INCIDENT.reserveRelief * cover;
    causes.push({ kind: 'reserves', value: +cover.toFixed(3), score: 0 });
  }
  const prob = score < INCIDENT.riskFloor ? 0 : Math.min(INCIDENT.probCap, INCIDENT.probPerRisk * score);
  return { score: +score.toFixed(3), prob: +prob.toFixed(4), causes };
}

/** The airline's busiest airport — where a meltdown is reported. */
function busiestAirport(state) {
  const n = new Map();
  for (const r of state?.routes ?? []) {
    for (const c of [r.origin, r.destination]) n.set(c, (n.get(c) ?? 0) + (r.weeklyFrequency ?? 0));
  }
  let best = state?.hub ?? null, bestN = -1;
  for (const [c, v] of n) if (v > bestN) { best = c; bestN = v; }
  return best;
}

/**
 * Roll this week's incident. Returns null (nothing happened) or
 * { kind: 'meltdown', airport, causes, satisfactionShock, reputationHit }.
 * `rand` is a uniform [0,1); it is drawn only when the risk is above zero, so
 * a well-run airline's random sequence is untouched.
 */
export function rollIncident(state, utilisation, rand = Math.random, reserveCover = 0) {
  const risk = incidentRisk(state, utilisation, reserveCover);
  if (!(risk.prob > 0)) return null;
  if (rand() >= risk.prob) return null;
  return {
    kind: 'meltdown',
    airport: busiestAirport(state),
    causes: risk.causes,
    satisfactionShock: INCIDENT.satisfactionShock,
    reputationHit: INCIDENT.reputationHit,
  };
}

const CAUSE_COPY = {
  utilisation: (c) => `aircraft flown ${Math.round(c.value * 100)}% of their hours`,
  spares: (c) => `${Math.round(c.value * 100)}% of the fleet spare`,
  morale: (c) => `crew morale at ${c.value}`,
};

/** "aircraft flown 93% of their hours, 0% of the fleet spare" — for toasts and news. */
export function incidentCauseLine(causes) {
  return (causes ?? []).map(c => CAUSE_COPY[c.kind]?.(c)).filter(Boolean).join(', ');
}
