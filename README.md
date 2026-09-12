# Quarterstone

A 45° isometric two-player online co-op action RPG built on three.js, where terrain is a
1 m grid carved from 25 cm voxels. Steam integration targets appid 480 (Spacewar) during
development.

## Status

Pre-production. **No game code has been written yet.** The repository currently holds the
concept plate that locks art direction, terrain metrics and the gear system.

- `docs/concept/index.html` — concept plate. Open it in a browser: the isometric diorama is
  a live three.js render (voxel terrain, canyon, river, natural arc, trees, boulders, a
  fallen log, shader grass and water, two co-op characters), not artwork.

## Design summary

**Terrain** — one voxel field, 25 cm voxels on a 1 m grid:

| Feature | Metrics |
| --- | --- |
| Canyon | 3–5 m wide, 3–4 m deep |
| River  | 1–4 m wide, 0.3 m bed |
| Hills  | 1–3 m rise |
| Arc    | 4–6 m span, 3–5 m rise |
| Props  | trees, boulders, logs — 0.5–4 m, voxelised |
| Grass  | 0.3–0.6 m blades, **not** voxelised |

Grass and water are shader-driven: two sine bands of wind, plus a 1.15 m trample radius
around every character.

**Gear** — weapons and armour are frames with base stats and sockets. Tech and magic
upgrades slot in; upgrades in neighbouring sockets combine into a third behaviour
(tech + magic bends behaviour, same-discipline pairs amplify a stat and take a drawback).
