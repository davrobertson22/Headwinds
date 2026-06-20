// ── Random event templates ────────────────────────────────────────────────────
//
// Each template has:
//   id          unique string
//   type        'fuel' | 'demand' | 'disruption' | 'competition' | 'economy'
//   name        short display name
//   icon        emoji used in debrief + toasts
//   description text — {pct} and {dur} are replaced at runtime
//   color       accent colour for display
//   probability chance of triggering per week (0–1)
//   duration    [min, max] weeks the event lasts
//   generate()  returns { effects, resolvedDesc } for a specific instance
//
// effects object shape (all optional):
//   fuelMult            multiply all weekly fuel costs
//   globalDemandMult    multiply all route revenue
//   regionCodes         ISO country codes this event applies to (demand events)
//   regionDemandMult    demand multiplier for regionCodes airports
//   competitorMult      multiply competitor aggression / pricing
//   note                plain-language summary shown in debrief

// Maximum impact a broad (regional/domestic/global) event may have: ±30%.
export const MAX_EVENT_IMPACT = 0.30;
// Localized events that hit only a single airport/city may go up to ±50%.
export const MAX_LOCALIZED_IMPACT = 0.50;

// Global frequency dial for random events. 1.0 = original rates; lower = rarer.
// At 0.5 the player sits in an active event ~74% of weeks (~10/year).
export const EVENT_FREQUENCY = 0.5;

// Clamp a multiplier so it can never move more than `cap` from 1.0.
function clampImpact(mult, cap = MAX_EVENT_IMPACT) {
  const lo = 1 - cap;
  const hi = 1 + cap;
  return Math.min(hi, Math.max(lo, mult));
}

export const EVENT_TEMPLATES = [

  // ── Fuel ──────────────────────────────────────────────────────────────────

  {
    id: 'fuel_spike',
    type: 'fuel',
    name: 'Fuel Price Spike',
    icon: '⛽',
    description: 'Oil market disruption pushes jet fuel prices up {pct}%.',
    color: '#ff5d6c',
    probability: 0.04,
    duration: [3, 6],
    generate() {
      const mult = clampImpact(1.15 + Math.random() * 0.20);
      return {
        effects: { fuelMult: mult },
        resolvedDesc: `Jet fuel costs up ${pct(mult, true)} — all routes more expensive to operate.`,
      };
    },
  },
  {
    id: 'fuel_drop',
    type: 'fuel',
    name: 'Fuel Prices Fall',
    icon: '⛽',
    description: 'Global oil oversupply drives fuel costs down {pct}%.',
    color: '#38d39f',
    probability: 0.03,
    duration: [4, 8],
    generate() {
      const mult = clampImpact(0.78 + Math.random() * 0.14);
      return {
        effects: { fuelMult: mult },
        resolvedDesc: `Fuel costs down ${pct(mult, false)} — great week to fly more.`,
      };
    },
  },

  // ── Global demand ─────────────────────────────────────────────────────────

  {
    id: 'travel_boom',
    type: 'demand',
    name: 'Global Travel Boom',
    icon: '🌍',
    description: 'Consumer confidence surge drives travel demand up globally.',
    color: '#38d39f',
    probability: 0.025,
    duration: [4, 8],
    generate() {
      const mult = clampImpact(1.12 + Math.random() * 0.13);
      return {
        effects: { globalDemandMult: mult },
        resolvedDesc: `All routes seeing ${pct(mult, true)} more passengers than normal.`,
      };
    },
  },
  {
    id: 'recession',
    type: 'economy',
    name: 'Economic Downturn',
    icon: '📉',
    description: 'Recession fears cause passengers to cut discretionary travel.',
    color: '#ff5d6c',
    probability: 0.018,
    duration: [8, 16],
    generate() {
      const mult = clampImpact(0.72 + Math.random() * 0.12);
      return {
        effects: { globalDemandMult: mult },
        resolvedDesc: `Demand down ${pct(mult, false)} across all routes. Load factors dropping.`,
      };
    },
  },
  {
    id: 'holiday_surge',
    type: 'demand',
    name: 'Holiday Travel Surge',
    icon: '🎄',
    description: 'Seasonal holiday travel drives a short demand spike.',
    color: '#38d39f',
    probability: 0.04,
    duration: [2, 4],
    generate() {
      const mult = clampImpact(1.18 + Math.random() * 0.12);
      return {
        effects: { globalDemandMult: mult },
        resolvedDesc: `Holiday peak — loads up ${pct(mult, true)} this week.`,
      };
    },
  },

  // ── Regional demand ───────────────────────────────────────────────────────

  {
    id: 'asia_boom',
    type: 'demand',
    name: 'Asia-Pacific Travel Surge',
    icon: '🌏',
    description: 'Strong regional growth boosts Asia-Pacific routes.',
    color: '#38d39f',
    probability: 0.03,
    duration: [6, 12],
    generate() {
      const mult = clampImpact(1.20 + Math.random() * 0.18);
      return {
        effects: {
          regionCodes: ['SG','HK','MY','TH','ID','PH','JP','KR','CN','IN'],
          regionDemandMult: mult,
        },
        resolvedDesc: `Asia-Pacific routes +${pct(mult, true)} demand for the duration.`,
      };
    },
  },
  {
    id: 'europe_surge',
    type: 'demand',
    name: 'European Summer Rush',
    icon: '☀️',
    description: 'Summer holidays drive a surge across European routes.',
    color: '#38d39f',
    probability: 0.035,
    duration: [6, 10],
    generate() {
      const mult = clampImpact(1.18 + Math.random() * 0.15);
      return {
        effects: {
          regionCodes: ['GB','FR','DE','ES','IT','GR','PT','NL','BE','AT','CH','SE','NO','DK'],
          regionDemandMult: mult,
        },
        resolvedDesc: `European routes seeing ${pct(mult, true)} extra demand.`,
      };
    },
  },
  {
    id: 'us_slump',
    type: 'demand',
    name: 'US Domestic Slowdown',
    icon: '🇺🇸',
    description: 'Economic concerns soften North American travel demand.',
    color: '#ffb43d',
    probability: 0.025,
    duration: [4, 8],
    generate() {
      const mult = clampImpact(0.82 + Math.random() * 0.10);
      return {
        effects: {
          regionCodes: ['US','CA','MX'],
          regionDemandMult: mult,
        },
        resolvedDesc: `North American demand down ${pct(mult, false)}.`,
      };
    },
  },

  // ── Disruptions ───────────────────────────────────────────────────────────

  {
    id: 'lhr_strike',
    type: 'disruption',
    name: 'LHR Ground Staff Strike',
    icon: '✊',
    description: 'London Heathrow ground handlers on strike — capacity severely restricted.',
    color: '#ff5d6c',
    probability: 0.02,
    duration: [1, 3],
    generate() {
      // Single-airport disruption — allowed the higher localized cap.
      const mult = clampImpact(0.35 + Math.random() * 0.25, MAX_LOCALIZED_IMPACT);
      return {
        effects: {
          regionCodes: ['GB'],
          regionDemandMult: mult,
          airportCode: 'LHR',
        },
        resolvedDesc: `LHR operating at ${Math.round(mult * 100)}% capacity due to strike action.`,
      };
    },
  },
  {
    id: 'weather_us',
    type: 'disruption',
    name: 'Severe US Winter Weather',
    icon: '🌨️',
    description: 'Major winter storm grounds flights across the US northeast.',
    color: '#ffb43d',
    probability: 0.03,
    duration: [1, 2],
    generate() {
      const mult = clampImpact(0.55 + Math.random() * 0.20);
      return {
        effects: {
          regionCodes: ['US'],
          regionDemandMult: mult,
        },
        resolvedDesc: `US operations reduced to ${Math.round(mult * 100)}% during storm.`,
      };
    },
  },
  {
    id: 'tech_outage',
    type: 'disruption',
    name: 'Industry-Wide IT Outage',
    icon: '💻',
    description: 'Global reservation system failure causes booking chaos.',
    color: '#ffb43d',
    probability: 0.015,
    duration: [1, 1],
    generate() {
      return {
        effects: { globalDemandMult: clampImpact(0.70) },
        resolvedDesc: 'Booking systems down — revenue impacted across all routes this week.',
      };
    },
  },

  // ── More demand events ────────────────────────────────────────────────────

  {
    id: 'world_cup',
    type: 'demand',
    name: 'Major Sporting Event',
    icon: '🏆',
    description: 'A marquee global sporting event draws massive travel surges to the host region.',
    color: '#38d39f',
    probability: 0.02,
    duration: [3, 5],
    generate() {
      const regions = [
        { codes: ['DE','AT','CH','FR'], label: 'Central Europe' },
        { codes: ['BR','AR','CL','CO'], label: 'South America' },
        { codes: ['JP','KR','CN'],      label: 'East Asia' },
        { codes: ['US','CA','MX'],      label: 'North America' },
        { codes: ['GB','FR','ES','IT'], label: 'Western Europe' },
      ];
      const region = regions[Math.floor(Math.random() * regions.length)];
      const mult = clampImpact(1.25 + Math.random() * 0.20);
      return {
        effects: { regionCodes: region.codes, regionDemandMult: mult },
        resolvedDesc: `Major sporting event in ${region.label} driving ${pct(mult, true)} demand to host region.`,
      };
    },
  },
  {
    id: 'pandemic_scare',
    type: 'disruption',
    name: 'Pandemic Scare',
    icon: '😷',
    description: 'A new respiratory illness triggers travel advisories and widespread cancellations.',
    color: '#ff5d6c',
    probability: 0.012,
    duration: [6, 14],
    generate() {
      const mult = clampImpact(0.55 + Math.random() * 0.20);
      return {
        effects: { globalDemandMult: mult },
        resolvedDesc: `Travel demand down ${pct(mult, false)} globally as passengers avoid flying.`,
      };
    },
  },
  {
    id: 'volcanic_ash',
    type: 'disruption',
    name: 'Volcanic Ash Cloud',
    icon: '🌋',
    description: 'A major volcanic eruption closes airspace across a region for weeks.',
    color: '#ffb43d',
    probability: 0.018,
    duration: [2, 5],
    generate() {
      const regions = [
        { codes: ['IS','NO','SE','DK','GB'], label: 'North Atlantic' },
        { codes: ['ID','PH','MY'], label: 'Southeast Asia' },
      ];
      const region = regions[Math.floor(Math.random() * regions.length)];
      const mult = clampImpact(0.30 + Math.random() * 0.25);
      return {
        effects: { regionCodes: region.codes, regionDemandMult: mult },
        resolvedDesc: `Volcanic ash closes ${region.label} airspace — routes severely disrupted.`,
      };
    },
  },
  {
    id: 'natural_disaster',
    type: 'disruption',
    name: 'Natural Disaster',
    icon: '🌊',
    description: 'A major earthquake, flood, or hurricane devastates a region, halting travel.',
    color: '#ff5d6c',
    probability: 0.022,
    duration: [3, 7],
    generate() {
      const regions = [
        { codes: ['JP','KR'],      label: 'Japan/Korea' },
        { codes: ['US'],           label: 'the United States' },
        { codes: ['TH','MY','ID'], label: 'Southeast Asia' },
        { codes: ['AU'],           label: 'Australia' },
        { codes: ['MX','CO'],      label: 'Central America' },
      ];
      const region = regions[Math.floor(Math.random() * regions.length)];
      const mult = clampImpact(0.45 + Math.random() * 0.25);
      return {
        effects: { regionCodes: region.codes, regionDemandMult: mult },
        resolvedDesc: `Natural disaster in ${region.label} causes ${pct(mult, false)} demand drop — emergency crews replacing tourists.`,
      };
    },
  },
  {
    id: 'political_unrest',
    type: 'disruption',
    name: 'Political Unrest',
    icon: '🚨',
    description: 'Civil unrest and travel advisories deter visitors from flying to a region.',
    color: '#ffb43d',
    probability: 0.025,
    duration: [4, 10],
    generate() {
      const regions = [
        { codes: ['TR','EG','MA'], label: 'North Africa & Turkey' },
        { codes: ['NG','KE','ET'], label: 'East Africa' },
        { codes: ['CO','PE'],      label: 'Andean South America' },
        { codes: ['TH','PH'],      label: 'Southeast Asia' },
      ];
      const region = regions[Math.floor(Math.random() * regions.length)];
      const mult = clampImpact(0.60 + Math.random() * 0.18);
      return {
        effects: { regionCodes: region.codes, regionDemandMult: mult },
        resolvedDesc: `Political unrest in ${region.label} — travel advisories cut demand by ${pct(mult, false)}.`,
      };
    },
  },
  {
    id: 'tourism_campaign',
    type: 'demand',
    name: 'Tourism Boom',
    icon: '🗺️',
    description: 'A high-profile campaign or viral moment sparks a tourism rush to a region.',
    color: '#38d39f',
    probability: 0.03,
    duration: [5, 10],
    generate() {
      const regions = [
        { codes: ['JP','KR'], label: 'East Asia' },
        { codes: ['PT','ES','GR'], label: 'Southern Europe' },
        { codes: ['AU','NZ'], label: 'Oceania' },
        { codes: ['BR','AR'], label: 'South America' },
      ];
      const region = regions[Math.floor(Math.random() * regions.length)];
      const mult = clampImpact(1.15 + Math.random() * 0.20);
      return {
        effects: { regionCodes: region.codes, regionDemandMult: mult },
        resolvedDesc: `Tourism surge to ${region.label} — demand up ${pct(mult, true)}.`,
      };
    },
  },
  {
    id: 'mega_conference',
    type: 'demand',
    name: 'Major Trade Conference',
    icon: '🤝',
    description: 'A global summit draws thousands of business travellers to a single destination.',
    color: '#38d39f',
    probability: 0.03,
    duration: [1, 2],
    generate() {
      const mult = clampImpact(1.20 + Math.random() * 0.15);
      return {
        effects: { globalDemandMult: mult },
        resolvedDesc: `Global conference boosts business travel — loads up ${pct(mult, true)} this week.`,
      };
    },
  },
  {
    id: 'currency_crisis',
    type: 'economy',
    name: 'Currency Crisis',
    icon: '💱',
    description: 'A currency collapse makes foreign travel unaffordable for millions in a region.',
    color: '#ffb43d',
    probability: 0.02,
    duration: [6, 12],
    generate() {
      const regions = [
        ['TR'],
        ['AR','CL','BR'],
        ['ZA','NG'],
        ['EG','MA'],
      ];
      const codes = regions[Math.floor(Math.random() * regions.length)];
      const mult = clampImpact(0.65 + Math.random() * 0.18);
      return {
        effects: { regionCodes: codes, regionDemandMult: mult },
        resolvedDesc: `Currency devaluation — outbound travel from affected region down ${pct(mult, false)}.`,
      };
    },
  },
  {
    id: 'heatwave_escape',
    type: 'demand',
    name: 'Heatwave Escape Rush',
    icon: '🌡️',
    description: 'Record temperatures send travellers fleeing to cooler destinations.',
    color: '#38d39f',
    probability: 0.025,
    duration: [3, 6],
    generate() {
      const mult = clampImpact(1.10 + Math.random() * 0.15);
      return {
        effects: { globalDemandMult: mult },
        resolvedDesc: `Extreme heat drives escape travel — load factors up ${pct(mult, true)} across leisure routes.`,
      };
    },
  },
  {
    id: 'new_route_frenzy',
    type: 'demand',
    name: 'Low-Cost Carrier Exits Market',
    icon: '📢',
    description: 'A low-cost rival collapses — passengers scramble for alternatives on their routes.',
    color: '#38d39f',
    probability: 0.018,
    duration: [4, 8],
    generate() {
      const mult = clampImpact(1.18 + Math.random() * 0.20);
      return {
        effects: { globalDemandMult: mult },
        resolvedDesc: `LCC grounding pushes ${pct(mult, true)} more passengers your way. Capitalize now.`,
      };
    },
  },

  // ── Competition ───────────────────────────────────────────────────────────

  {
    id: 'fare_war',
    type: 'competition',
    name: 'Competitor Fare War',
    icon: '⚔️',
    description: 'Rival airlines slash fares across shared routes to grab market share.',
    color: '#ff5d6c',
    probability: 0.03,
    duration: [3, 6],
    generate() {
      const mult = clampImpact(0.82 + Math.random() * 0.10);
      return {
        effects: { globalDemandMult: mult, competitorMult: 1.4 },
        resolvedDesc: 'Aggressive pricing by competitors pulling passengers away. Consider lowering fares.',
      };
    },
  },
  {
    id: 'competitor_crisis',
    type: 'competition',
    name: 'Competitor Airline Crisis',
    icon: '🏚️',
    description: 'A rival airline grounds its fleet — stranded passengers flood the market.',
    color: '#38d39f',
    probability: 0.015,
    duration: [4, 8],
    generate() {
      const mult = clampImpact(1.22 + Math.random() * 0.18);
      return {
        effects: { globalDemandMult: mult },
        resolvedDesc: `Stranded passengers from competitor grounding drive ${pct(mult, true)} demand boost.`,
      };
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(mult, positive) {
  const n = Math.abs(Math.round((mult - 1) * 100));
  return `${positive ? '+' : '-'}${n}%`;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Roll for new events this week. Returns an array of new event objects to add.
 * Won't add a second instance of an already-active event type.
 */
export function rollEvents(activeEvents = []) {
  const MAX_ACTIVE_EVENTS = 2;
  const activeTypes = new Set(activeEvents.map(e => e.templateId));
  const newEvents = [];

  for (const tmpl of EVENT_TEMPLATES) {
    if (activeEvents.length + newEvents.length >= MAX_ACTIVE_EVENTS) break; // cap reached
    if (activeTypes.has(tmpl.id)) continue;          // already active
    if (Math.random() > tmpl.probability * EVENT_FREQUENCY) continue;  // didn't trigger

    const dur = randInt(tmpl.duration[0], tmpl.duration[1]);
    const { effects, resolvedDesc } = tmpl.generate();

    // Defensive cap, even if a template forgets to clamp. Localized events
    // (those hitting a single airport/city) get the higher ±50% cap;
    // everything broader is held to ±30%.
    const cap = effects.airportCode ? MAX_LOCALIZED_IMPACT : MAX_EVENT_IMPACT;
    if (effects.fuelMult)         effects.fuelMult         = clampImpact(effects.fuelMult, cap);
    if (effects.globalDemandMult) effects.globalDemandMult = clampImpact(effects.globalDemandMult, cap);
    if (effects.regionDemandMult) effects.regionDemandMult = clampImpact(effects.regionDemandMult, cap);

    newEvents.push({
      id:          `${tmpl.id}-${Date.now()}-${Math.random()}`,
      templateId:  tmpl.id,
      type:        tmpl.type,
      name:        tmpl.name,
      icon:        tmpl.icon,
      description: resolvedDesc,
      color:       tmpl.color,
      weeksLeft:   dur,
      totalDur:    dur,
      effects,
    });
  }

  return newEvents;
}

/**
 * Tick active events: decrement weeksLeft, return updated + expired arrays.
 */
export function tickEvents(activeEvents) {
  const updated  = [];
  const expired  = [];
  for (const ev of activeEvents) {
    if (ev.weeksLeft <= 1) expired.push(ev);
    else updated.push({ ...ev, weeksLeft: ev.weeksLeft - 1 });
  }
  return { updated, expired };
}

// ── Mechanical failure descriptions ──────────────────────────────────────────

const FAILURE_TYPES = [
  { label: 'Engine fault',          icon: '🔧', severity: 'major',  durationRange: [2, 4] },
  { label: 'Hydraulics leak',       icon: '🔩', severity: 'major',  durationRange: [2, 3] },
  { label: 'Avionics fault',        icon: '📡', severity: 'minor',  durationRange: [1, 2] },
  { label: 'Landing gear issue',    icon: '⚙️', severity: 'major',  durationRange: [2, 4] },
  { label: 'APU failure',           icon: '🔌', severity: 'minor',  durationRange: [1, 2] },
  { label: 'Pressurization fault',  icon: '💨', severity: 'major',  durationRange: [2, 3] },
  { label: 'Fuel system anomaly',   icon: '⛽', severity: 'minor',  durationRange: [1, 2] },
  { label: 'Structural crack found',icon: '🪛', severity: 'severe', durationRange: [3, 5] },
];

/**
 * Probability of a mechanical failure occurring this week for a given aircraft.
 * - New aircraft (~0y): ~0.5%/week
 * - 5 years: ~2.5%/week
 * - 10 years: ~5%/week
 * - 20 years: ~15%/week
 * Maintenance budget divides the probability:
 *   budget 2.0 → ÷2  |  1.0 → ÷1  |  0.5 → ÷0.5 (i.e. doubles it)
 */
export function mechanicalFailureProb(ageWeeks, maintenanceBudget = 1.0) {
  const ageYears = (ageWeeks ?? 0) / 52;
  const base     = 0.005 + Math.pow(ageYears / 20, 1.4) * 0.15;
  return Math.min(0.35, base / Math.max(0.5, maintenanceBudget));
}

/**
 * Roll mechanical failures for the entire fleet this week.
 * Returns an array of failure objects:
 *   { aircraftId, aircraftName, tailNumber, label, icon, severity, weeksGrounded }
 * Only rolls for aircraft that are currently assigned (flying) and not already grounded.
 */
export function rollMechanicalFailures(fleet, maintenanceBudget = 1.0) {
  const failures = [];
  for (const aircraft of fleet) {
    if (aircraft.status === 'grounded') continue; // already out
    const prob = mechanicalFailureProb(aircraft.ageWeeks ?? 0, maintenanceBudget);
    if (Math.random() > prob) continue;

    const tmpl = FAILURE_TYPES[Math.floor(Math.random() * FAILURE_TYPES.length)];
    const weeksGrounded = randInt(tmpl.durationRange[0], tmpl.durationRange[1]);
    failures.push({
      aircraftId:    aircraft.id,
      aircraftName:  aircraft.name,
      tailNumber:    aircraft.tailNumber ?? '',
      label:         tmpl.label,
      icon:          tmpl.icon,
      severity:      tmpl.severity,
      weeksGrounded,
    });
  }
  return failures;
}

/**
 * Compute aggregate effect modifiers from all active events.
 * Returns { fuelMult, globalDemandMult, regionMults: { [country]: mult } }
 */
export function computeEventEffects(activeEvents, route, getAirport) {
  let fuelMult         = 1.0;
  let globalDemandMult = 1.0;
  const regionMults    = {};

  for (const ev of activeEvents) {
    const fx = ev.effects ?? {};
    if (fx.fuelMult)         fuelMult         *= fx.fuelMult;
    if (fx.globalDemandMult) globalDemandMult *= fx.globalDemandMult;
    if (fx.regionCodes && fx.regionDemandMult && route) {
      // Check if this route touches an affected region
      const originAp  = getAirport(route.origin);
      const destAp    = getAirport(route.destination);
      const affected  = fx.regionCodes.includes(originAp?.country) ||
                        fx.regionCodes.includes(destAp?.country);
      if (affected) {
        const code = route.origin + '-' + route.destination;
        regionMults[code] = (regionMults[code] ?? 1.0) * fx.regionDemandMult;
      }
    }
  }

  return { fuelMult, globalDemandMult, regionMults };
}
