# src

The game. Today that is the terrain generator and nothing else — see
`docs/PROTOTYPE.md` for what lands next and in what order.

| Path | What it is |
| --- | --- |
| `gen/` | The seeded terrain generator. Plain ES modules: no DOM, no three.js, no renderer. |
| `sim/` | Collision and the character controller. Same rules: no DOM, no three.js, no renderer. |

## src/gen

`buildWorld(cfg)` takes a seed, a size and a world offset, and returns one window
of world as plain arrays:

```js
import { buildWorld } from './src/gen/index.mjs';
const w = buildWorld({ seed: 'QUARTERSTONE', size: 64, force: null, ox: 0, oz: 0 });
// w.pos / w.col     voxel centres and colours, 3 floats each
// w.mat             one material id per voxel — see src/gen/materials.mjs
// w.mpos/mcol/mmat  the emissive ones — magma, lamps, landmark lights
// w.grass, w.water  blade clouds and water surface geometry
// w.cells, w.Hs     the 1 m cell grid and the 25 cm height field
// w.reach, w.unreach, w.spawn   what the movement budget can actually get to
```

It runs identically in Node, in a worker and in the browser. `index.mjs` lists the
passes in the order they run, which is also the order the random stream is
consumed: **reordering a pass changes every world**. That is what
`tools/baseline.json` pins, and what `node tools/smoke.mjs` checks.

`pos`, `col` and `mat` are one record split three ways: voxel *n* is at
`pos[3n..3n+2]`, coloured `col[3n..3n+2]`, and made of `MATERIALS[mat[n]]`. Any
stamp that pushes a position must push all three, and the smoke test fails if
the lengths ever disagree.

Material and palette are deliberately separate. Two biomes can both be grass and
look nothing alike, and the per-voxel dithering that makes a blended transition
read only works on colour. The material answers what a thing *is* — how hard it
is to carve, whether it burns, whether it conducts, what it sounds like
underfoot — and the gear design depends on those answers.

### Three things to know before editing

**The concept plate inlines this code, it does not import it.** `docs/concept/index.html`
has to stay one self-contained file — it is opened from disk and published as an
artifact whose CSP admits no module graph. `node tools/bundle-gen.mjs` writes the
generator into the marked block near the top of the plate; the smoke test fails if
the block and `src/gen` have drifted. Edit the modules, run the bundler, commit both.

**The arithmetic is pinned.** `Math.sin`, `Math.cos`, `Math.exp`, `Math.pow` and
`Math.hypot` are "implementation-approximated" — two conforming engines may return
different last bits, and V8 changes them between versions. Node 22 and Chromium 141
already disagree on sine. So the generator uses only what the spec pins exactly, and
`gen/exact.mjs` supplies the rest. **Do not reach for `Math.` transcendentals here**;
the smoke test's MATH check exists to catch it if you do.

**The style is the plate's, deliberately.** The bodies were moved across
character-for-character so the extraction could be proved: all six golden seeds
still hash to the same digest they did inside the plate. That is why this reads
like dense ES5 with `var`. Modernising it is a separate change, one that has to
keep the digests green on its own merits.

## src/sim

```js
import { colliderForWorld } from './src/sim/collider.mjs';
import { placeOnGround, step } from './src/sim/actor.mjs';

const col = colliderForWorld(world);
const a = placeOnGround(col, world.spawn[0], world.spawn[2]);
step(col, a, { mx: 1, mz: 0, jump: false });   // one 1/60 s tick
```

`collider.mjs` turns one generated window into a column grid of solid spans.
It reads `cell.sp` rather than the voxel arrays on purpose: `buildVoxels` emits
a **shell** — the surface and a skirt down to the lowest neighbour — because that
is all a renderer needs, and a collider built from it would let a player drop
into the hollow inside of a hill. The voxels go in as well, on top, because
props are in no span at all and a bridge you cannot stand on is not a bridge.
The edge of the window is a wall: the world is bounded.

`actor.mjs` is the controller. Only run speed is chosen; gravity, jump speed and
airtime are **solved** from `MOVE` so that a jump clears exactly `MOVE.jump`,
footprint included, and no more. Change the budget and the character changes
with the terrain instead of drifting away from it. The actor is an axis-aligned
box, not a capsule: against a voxel world an AABB is exact where a capsule is
approximate, and it cannot wedge on a corner.

Fixed timestep, no randomness, no wall clock. That is what lets
`tools/smoke.mjs` assert every clause of the budget — step, vault, gap, drop,
wade, swim, magma — in node, and run a five-minute soak on all six golden seeds,
with no browser anywhere.

### Known debt

- Colours are still chosen here, per voxel, from the biome palettes, alongside
  the material ids. That is deliberate for the plate's dithered blends, but the
  greedy mesher (issue #12) wants the look decided from the material at draw
  time, and the two will have to be reconciled then.
- One window at a time. The generator is positional in `cell(x, z)` but the
  world-build stream is ordered, so two overlapping windows do not agree at the
  seam. Issue #16 is region-level determinism, and it blocks chunk streaming.
