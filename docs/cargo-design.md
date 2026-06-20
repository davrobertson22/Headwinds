# Cargo — MVP Design

Status: agreed design, not yet implemented.
Scope: **dedicated freighters only.** Belly cargo (freight under passenger flights) is explicitly out of scope for v1.

## Goal

Add a parallel cargo system that mirrors the existing passenger pipeline so it reuses
distance, fuel, crew, maintenance, slots/gates, and hub bonuses unchanged. The player
buys freighters, assigns them to cargo routes, and earns freight revenue each weekly tick.

The existing passenger pipeline is:

```
market.js (gravity demand) -> demand.js (segments + share) -> simulateRoute()
```

Cargo gets the same three layers, swapping the seat/pax block for tonnes x yield.

---

## Decisions (locked)

| Decision        | Choice                                   |
|-----------------|------------------------------------------|
| Demand basis    | New `cargoScore` field on airports       |
| Freighters      | New dedicated aircraft types             |
| Belly headroom  | Freighters capture 100% of the pool      |

Belly capture is gated behind a single constant `FREIGHTER_CAPTURE_RATE = 1.0`
so it can be reduced later (when belly cargo is added) without a rebalance.

---

## 1. Cargo demand model (`market.js`)

New `cargoCityPairDemand(originCode, destCode)` — structurally a sibling of
`baseCityPairDemand`, with three differences:

- **Mass driver is trade, not tourism.** Uses a new optional per-airport
  `cargoScore` (0–100), backfilled for the real freight hubs (HKG, PVG, ICN, MEM,
  ANC, DXB, FRA, LAX, NRT, SIN, etc.). Airports without it default to a neutral value.
- **Gentler distance decay** than passengers — freight is insensitive to flight time.
  Lower the gravity exponent vs. the passenger model.
- **Output unit is tonnes/week**, not passengers.
- **Directional storage.** Cargo demand is stored o->d (NOT a sorted routeKey),
  so directional imbalance (headhaul/backhaul) can be added later with no migration.

New `cargoReferenceYield(originCode, destCode)` — analogous to `referencePrice`,
expressed as **$ per tonne-km**. Player can price above/below; demand adjusts via the
same elasticity treatment already used for passengers.

For MVP, cargo clears as a **monopoly against a clearing price** (the `_monopolyResult`
path) — no AI freighter competitors and no competitive softmax in v1.

---

## 2. Freighter fleet (`aircraft.js`)

Add new dedicated freighter types with two new fields:

- `freighter: true`
- `payloadTonnes: <number>`  (replaces the `seats` concept for capacity)

Starter set (~6): 747-400F, 777F, 767-300F, A330-200F, 737-800BCF, ATR72F.
They reuse `range`, `fuelBurnPer100km`, `crewCostPerKm`, `baseMaintenancePerWk`,
`weeklyLease`, `purchasePrice` verbatim.

---

## 3. Cargo routes + simulation

A separate `cargoRoutes` list in game state, with its own `simulateCargoRoute()`.
It reuses, unchanged:

- distance, effective range / range gating
- fuel, crew, maintenance costs
- slot/gate consumption
- hub quality + connectivity bonuses

It **replaces** the seat/cabin/pax demand block with:

```
tonnes carried = min( cargoDemand * elasticity * FREIGHTER_CAPTURE_RATE,
                      payloadTonnes * weeklyFrequency )
revenue        = tonnes * distanceKm * yield
ground handling = per-tonne (not per-pax)
```

Cargo revenue surfaces as its own line in Finance.

---

## 4. Out of scope for v1 (deliberately)

- **Belly cargo** — the whole reason for the freighter-first cut.
- **Cargo in the network/cannibalization model** — freight consolidates through hubs
  differently; deferred to avoid a rabbit hole.
- **AI freighter competitors** — cargo runs monopoly-vs-clearing-price for now.
- **Directional imbalance** — modeled symmetrically in v1, but stored directionally
  so it can be turned on later.

---

## MVP loop

cargo demand pool (directional) -> buy a freighter -> assign to a cargo route ->
weekly tick fills tonnes against yield with elasticity -> profit flows to Finance.

## Files touched

- `src/data/airports.js`  — add `cargoScore` to freight hubs
- `src/utils/market.js`   — `cargoCityPairDemand`, `cargoReferenceYield`
- `src/data/aircraft.js`  — freighter types (`freighter`, `payloadTonnes`)
- `src/utils/simulation.js` — `simulateCargoRoute`
- game state / context     — `cargoRoutes`
- UI — cargo surfaces paralleling Routes / Marketplace / Finance
