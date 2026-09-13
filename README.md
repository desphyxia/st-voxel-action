# Quarterstone

A 45° isometric two-player online co-op action RPG built on three.js. Worlds are seeded and
endless; terrain features are laid out in whole metres on a 1 m grid and built from 25 cm
voxels. Steam integration targets appid 480 (Spacewar) during development.

## Status

Pre-production. **There is no engine and nothing to play yet.** What exists is the seeded
terrain generator and the concept plate that locks generation rules, biomes and the gear
lattice.

- `docs/DECISIONS.md` — the design decision record. The authority on what the game is.
- `src/gen/` — the terrain generator. Plain ES modules, no DOM and no three.js; it runs in
  Node, in a worker and in the browser alike. See `src/README.md`.
- `docs/concept/index.html` — concept plate, published at
  https://claude.ai/code/artifact/10034b02-a25d-4f5b-ab04-cea2076ceee8 — or open it in a browser. The hero diorama and all
  six biome plates are live three.js renders produced by the same seeded generator, not
  artwork. Type a seed and press Generate to produce a different world.

## World generation

| Rule | Value |
| --- | --- |
| Chunk | 32 × 32 m footprint, 16 m ceiling — 128 × 128 × 64 voxels |
| Feature grid | 1 m. Every feature dimension is a whole number of metres |
| Voxel | 25 cm. Used for surface detail, palette dithering and silhouette only |
| Detail pass | ±2 voxels (±0.5 m), the only sub-metre operation |
| Seeding | One string seed drives climate, heightfield, features and props, so co-op partners generate identical terrain without transferring it |
| Columns | Stored as runs of solid spans, not a single height — caves, tunnels and true undercuts are the same case |

Feature ranges: canyons 3–5 m wide and 3–4 m deep; rivers 1–4 m wide with the bed 1 m below
the bank; hills 1–3 m; arcs 4–6 m span and 3–5 m rise; columns 2–4 m tall; overhangs undercut
a rim by 1–2 m, and paired across a canyon they leave a 2–3 m gap a player can clear.
Waterfalls are emitted wherever a watercourse steps down a metre; basins fill as ponds at
1.25 m. Grass (0.3–0.9 m) and water are never voxelised — both are shader-driven, with wind,
a trample radius around every character, and flow-advected foam.

### Traversability

The movement budget is the contract between the generator and the character controller:
step up 1 m, vault 2 m, jump a 2.5 m gap, survive a 6 m drop, wade 0.75 m (river beds sit
exactly there), swim anything deeper, and magma is lethal and impassable. Trails are routed
with A* over those costs and the ground is then graded under them so no step along a route
exceeds a metre; crossings are placed only where a route actually meets water, with both
banks dry. When a world has water that no route happened to cross, the generator finds the
narrowest ford — a short water run with dry, level banks — and takes the route over it, so
water-bearing worlds always get a crossing and dry ones never get a pointless one. A reach pass floods from the spawn under the same rules and marks what it cannot
get to — a generator test, not a debug view. Arm Reach on the plate to see it.

Nine systems drive the generator rather than a list of special cases: **span columns** (a
pseudo-3D field cuts caves before rims undercut them), a **flow field and water table**
(downhill vector per cell; hollows flood until they spill), an **erosion pass** (talus at
cliff feet, banks cut back above water), **trails** (routes drawn between sites before
anything is built), an **accumulation pass** (snow and ash settle on up-facing surfaces by
biome and slope), **one wind field** (shared by grass and water), **destructible terrain**
(carve voxels live — arm Carve on the plate and click), **chunk-scale landmarks** (an
obelisk, hive tree, wrecked machine or standing stones on the highest flat ground, chosen to
suit the biome), and **routing and reach** (above).

Clutter is voxelised on the same lattice and derived from the terrain where possible: scree
falls out of every 2 m drop, and bushes, stumps, fallen trunks, fences, lamp posts, ruined
walls, pillars, huts and deck bridges are placed by terrain rules rather than scattered. Two
points of interest per world — a ruin and a holding — are sited only on ground flat enough to
have been built on.

### Biomes

Temperature and moisture are sampled as two low-frequency fields. Each biome sits at a point
in that space and every column is a weighted blend of all five, so palettes, densities and
feature sets cross-fade rather than switch.

Meadowlands · Redrock Mesa · Boreal Fen · Ashfall Barrens · Frostmoor

## Gear

Weapons and armour are **frames**: base stats, an affinity, and a cluster of hexagonal
sockets. Frames never level up. Seven of the eight are symbiotic rather than historical:
longblade (the control case), splice gauntlet, hookline spool, emberpot censer, brood sling,
tuning stake, lodestone flail, root bulwark. Seating two modules of a frame's own discipline
wakes its trait.

Nine modules across three disciplines: **tech** (arc capacitor, servo edge, kinetic battery),
**magic** (frostbind, emberweft, echo rune), **biological** (sporeling, bonegraft, vinelash).

Modules fuse only when their hexes share an edge, so socket layout is part of the build. Same
discipline pairs amplify a stat and take a drawback; cross-discipline pairs bend behaviour
into something neither module does alone.
