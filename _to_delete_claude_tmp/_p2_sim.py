import sys

S = "/sessions/rcw-01fkfylpkstlasex52tw2cs7/mnt"
HW = f"{S}/Headwinds/packages/engine/src"
TW = f"{S}/Airline Management Game/src"

def read(p):  return open(p, encoding="utf-8").read()
def write(p, s): open(p, "w", encoding="utf-8").write(s)

def sub1(src, old, new, label):
    n = src.count(old)
    if n != 1:
        raise SystemExit(f"{label}: anchor count {n} (expected 1)\n  {old[:110]!r}")
    return src.replace(old, new, 1)


# ══ families.js — contract offsets on the outsourced MRO bill ═══════════════
def do_families(src):
    if "offsetsByFamily" in src:
        return src, "already applied"
    old = """export function weeklyFamilyBaseCost(fleet) {
  let total = 0;
  for (const famId of activeFamilies(fleet)) {
    total += FAMILY_INFO[famId]?.weeklyBaseCost ?? 0;
  }
  return total;
}"""
    new = """export function weeklyFamilyBaseCost(fleet, offsetsByFamily = null) {
  let total = 0;
  for (const famId of activeFamilies(fleet)) {
    const gross  = FAMILY_INFO[famId]?.weeklyBaseCost ?? 0;
    // A certified jet base does this family's work in-house, so most of the
    // outsourced contract falls away (see data/mroBase.js contractOffset).
    const offset = Math.max(0, Math.min(1, offsetsByFamily?.[famId] ?? 0));
    total += gross * (1 - offset);
  }
  return Math.round(total);
}"""
    src = sub1(src, old, new, "families.weeklyFamilyBaseCost")
    old_doc = """/**
 * Total weekly MRO base cost for all active families.
 * @param {object[]} fleet  - array of aircraft from game state
 * @returns {number}
 */"""
    new_doc = """/**
 * Total weekly MRO base cost for all active families, net of any jet-base
 * contract offsets.
 * @param {object[]} fleet            - array of aircraft from game state
 * @param {object}   offsetsByFamily  - { [familyId]: 0..1 } from familyContractOffsets()
 * @returns {number}
 */"""
    src = sub1(src, old_doc, new_doc, "families.doc")
    return src, "weeklyFamilyBaseCost accepts contract offsets"


# ══ simulation.js — jet bases in the weekly economics ══════════════════════
def do_sim(src):
    if "mroFactorsByAircraft" in src:
        return src, "already applied"

    # 1. import
    src = sub1(src,
        "import { isOutOfService, effectiveMaintAgeWeeks } from '../data/maintenance.js';",
        "import { isOutOfService, effectiveMaintAgeWeeks } from '../data/maintenance.js';\n"
        "import {\n"
        "  resolveBaseFor, mroFactorsFor, familyContractOffsets, totalBaseWeeklyCost,\n"
        "  contractOffsetSavings, isBaseOpen, RESERVE_AT_BASE_READINESS_DISCOUNT,\n"
        "} from '../data/mroBase.js';",
        "sim.import")

    # 2. destructure mroBases + absWeek
    src = sub1(src,
        "    maintenanceBudget = 1.0, fuelMultiplier = 1.0,",
        "    maintenanceBudget = 1.0, fuelMultiplier = 1.0,\n"
        "    mroBases = {}, absWeek = 0,",
        "sim.destructure")

    # 3. per-aircraft base factors + contract offsets, computed once
    src = sub1(src,
        "  // 2. Fleet fixed costs (lease + maintenance + reserve standby)\n"
        "  let totalLeases         = 0;",
        "  // ── Jet bases: resolve each aircraft's best available base ONCE ────────────\n"
        "  // Slot contention is NOT applied here — line maintenance and the contract\n"
        "  // offset are ownership benefits that a base delivers to the whole fleet it\n"
        "  // covers. Slots gate the discrete JOBS (checks, AOG repairs) in the reducer.\n"
        "  const mroFactorsByAircraft = {};\n"
        "  for (const aircraft of fleet) {\n"
        "    const resolved = resolveBaseFor(aircraft, mroBases, rawRoutes, cargoRoutes, absWeek);\n"
        "    if (resolved) mroFactorsByAircraft[aircraft.id] = mroFactorsFor(resolved);\n"
        "  }\n"
        "  const mroContractOffsets = familyContractOffsets(mroBases, absWeek);\n"
        "\n"
        "  // 2. Fleet fixed costs (lease + maintenance + reserve standby)\n"
        "  let totalLeases         = 0;",
        "sim.factors")

    # 4. line maintenance: best facility wins (hub OR base, not stacked)
    src = sub1(src,
        "    const baseMaint         = Math.round(\n"
        "      type.baseMaintenancePerWk * maintMult * maintenanceBudget * maintenanceCostMultiplier * (aircraft.maintMod ?? 1.0)\n"
        "      * (aircraftMaintFactor[aircraft.id] ?? 1.0)   // hub line-maintenance discount\n"
        "    );",
        "    // Line-maintenance facility discount: the BEST of the hub factor and the\n"
        "    // jet-base factor — they do not stack, you only maintain the jet once.\n"
        "    const mroF              = mroFactorsByAircraft[aircraft.id] ?? null;\n"
        "    const facilityFactor    = Math.min(aircraftMaintFactor[aircraft.id] ?? 1.0, mroF?.lineFactor ?? 1.0);\n"
        "    const baseMaint         = Math.round(\n"
        "      type.baseMaintenancePerWk * maintMult * maintenanceBudget * maintenanceCostMultiplier * (aircraft.maintMod ?? 1.0)\n"
        "      * facilityFactor\n"
        "    );",
        "sim.linemaint")

    # 5. reserve readiness discount when stationed at your own open base
    src = sub1(src,
        "    const stationed = !!aircraft.reserveBase && aircraft.status !== 'retired';\n"
        "    const maint     = stationed ? Math.round(baseMaint * RESERVE_READINESS_MULT) : baseMaint;",
        "    // A reserve parked at one of your OWN open bases is cheaper to keep warm —\n"
        "    // your mechanics are already standing there.\n"
        "    const stationed = !!aircraft.reserveBase && aircraft.status !== 'retired';\n"
        "    const atOwnBase = stationed && isBaseOpen(mroBases?.[aircraft.reserveBase]);\n"
        "    const readiness = atOwnBase\n"
        "      ? 1 + (RESERVE_READINESS_MULT - 1) * (1 - RESERVE_AT_BASE_READINESS_DISCOUNT)\n"
        "      : RESERVE_READINESS_MULT;\n"
        "    const maint     = stationed ? Math.round(baseMaint * readiness) : baseMaint;",
        "sim.reserve")

    # 6. family contracts net of offsets + base opex as its own cost line
    src = sub1(src,
        "  // 5. Fleet family MRO base costs (one fixed fee per active aircraft family, regardless of fleet size)\n"
        "  const totalFamilyBaseCosts = fleet.length > 0 ? weeklyFamilyBaseCost(fleet) : 0;",
        "  // 5. Fleet family MRO base costs (one fixed fee per active aircraft family, regardless of fleet size).\n"
        "  //    These are OUTSOURCED contract rates — a certified jet base offsets most of\n"
        "  //    the family's bill because you are now doing that work yourself.\n"
        "  const familyBaseGross      = fleet.length > 0 ? weeklyFamilyBaseCost(fleet) : 0;\n"
        "  const totalFamilyBaseCosts = fleet.length > 0 ? weeklyFamilyBaseCost(fleet, mroContractOffsets) : 0;\n"
        "  const mroContractSavings   = Math.max(0, familyBaseGross - totalFamilyBaseCosts);\n"
        "\n"
        "  // 5b. Jet-base running costs — opex, extra certifications, parts pool.\n"
        "  const totalMroBaseCosts = totalBaseWeeklyCost(mroBases);",
        "sim.family")

    # 7. base opex into the cost total
    src = sub1(src,
        "    + totalLaborCosts + totalFamilyBaseCosts + totalHubInvestment",
        "    + totalLaborCosts + totalFamilyBaseCosts + totalMroBaseCosts + totalHubInvestment",
        "sim.totalcost")

    # 8. report fields
    src = sub1(src,
        "    totalFamilyBaseCosts:   Math.round(totalFamilyBaseCosts),",
        "    totalFamilyBaseCosts:   Math.round(totalFamilyBaseCosts),\n"
        "    totalMroBaseCosts:      Math.round(totalMroBaseCosts),\n"
        "    mroContractSavings:     Math.round(mroContractSavings),\n"
        "    mroFactorsByAircraft,   // aircraftId → resolved jet-base benefits this week",
        "sim.report")

    return src, "jet bases wired into line maint, reserves, contracts and the P&L"


TARGETS = [
    ("families.js",   [f"{HW}/data/families.js",       f"{TW}/data/families.js"],    do_families),
    ("simulation.js", [f"{HW}/utils/simulation.js",    f"{TW}/utils/simulation.js"], do_sim),
]

for name, paths, fn in TARGETS:
    ref = read(paths[0])
    out, msg = fn(ref)
    for p in paths:
        cur = read(p)
        if cur != ref:
            # Tailwinds copies can drift; apply independently rather than clobber.
            out2, msg2 = fn(cur)
            write(p, out2)
            print(f"{name} [{p.split('/mnt/')[1].split('/')[0]}]: {msg2} (applied independently)")
        else:
            write(p, out)
            print(f"{name} [{p.split('/mnt/')[1].split('/')[0]}]: {msg}")
