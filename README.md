# Quarterstone

A 45° isometric two-player online co-op action RPG built on three.js. Worlds are seeded and
endless; terrain features are laid out in whole metres on a 1 m grid and built from 25 cm
voxels. Steam integration targets appid 480 (Spacewar) during development.

## Status

Pre-production. **No game code has been written yet.** The repository holds the concept
plate that locks generation rules, biomes and the gear lattice.

- `docs/concept/index.html` — concept plate. Open it in a browser. The hero diorama and all
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

Feature ranges: canyons 3–5 m wide and 3–4 m deep; rivers 1–4 m wide with the bed 1 m below
the bank (elevation changes become whole-metre cascades); hills 1–3 m; arcs 4–6 m span and
3–5 m rise; columns 2–4 m tall. Grass (0.3–0.9 m) and water are never voxelised — both are
shader-driven, with wind and a trample radius around every character.

### Biomes

Temperature and moisture are sampled as two low-frequency fields. Each biome sits at a point
in that space and every column is a weighted blend of all five, so palettes, densities and
feature sets cross-fade rather than switch.

Meadowlands · Redrock Mesa · Boreal Fen · Ashfall Barrens · Frostmoor

## Gear

Weapons and armour are **frames**: base stats plus a cluster of hexagonal sockets. Frames
never level up. Eight frames — longblade, paired knives, greataxe, warhammer, spear, recurve
bow, bulwark, focus rod — differing in socket count and lattice shape.

Nine modules across three disciplines: **tech** (arc capacitor, servo edge, kinetic battery),
**magic** (frostbind, emberweft, echo rune), **biological** (sporeling, bonegraft, vinelash).

Modules fuse only when their hexes share an edge, so socket layout is part of the build. Same
discipline pairs amplify a stat and take a drawback; cross-discipline pairs bend behaviour
into something neither module does alone.
