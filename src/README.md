# src

The game. Today that is a seeded terrain generator, a character who can move and
fight through it, two of them over a wire, and a socket lattice to hang
progression on — see `docs/PROTOTYPE.md` for what lands next and in what order.

| Path | What it is |
| --- | --- |
| `gen/` | The seeded terrain generator. Plain ES modules: no DOM, no three.js, no renderer. |
| `sim/` | Collision, the character controller, the isometric camera, the input table, combat, the enemy, the socket lattice and what is lying on the ground. Same rules: no DOM, no three.js, no renderer. |
| `net/` | The transport interface, a loopback double, and the host and guest sessions. Same rules again. |

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

`camera.mjs` is the isometric view as maths: one angle decides where the eye
sits, which way "up the screen" points on the ground, and where a pixel lands in
the world. Keeping it here rather than in a renderer is what lets the two things
that are easy to get wrong and impossible to see in a screenshot be asserted —
that movement stays camera-relative across a quarter-turn snap, and that a mouse
point and a stick direction meaning the same thing produce the same facing. The
page builds a `THREE.OrthographicCamera` from `eye()` and points it at the same
target, so the angle has one owner.

`input.mjs` is a binding table, not a switch statement. Remapping is there from
the first commit because retrofitting it is the expensive version (#11), and it
costs a map and a lookup. Codes are `KeyboardEvent.code` — physical keys, so
WASD stays under the same fingers on any layout — plus `Pad<n>` for a gamepad.

`actor.mjs` is the controller. Only run speed is chosen; gravity, jump speed and
airtime are **solved** from `MOVE` so that a jump clears exactly `MOVE.jump`,
footprint included, and no more. Change the budget and the character changes
with the terrain instead of drifting away from it. The actor is an axis-aligned
box, not a capsule: against a voxel world an AABB is exact where a capsule is
approximate, and it cannot wedge on a corner.

Fixed timestep, no randomness, no wall clock. That is what lets
`tools/smoke.mjs` assert every clause of the budget — step, vault, gap, drop,
wade, swim, magma — in node, and run a five-minute soak on all six golden seeds,
with no browser anywhere. `docs/play/index.html` drives the same `step` from a
fixed-step accumulator, so what you play is what the gate measured.

Every number in `combat.mjs` is a **base**. `baseStats()` is the same set as a
value, `statsOf(a)` is what an actor is actually playing with, and `lattice.mjs`
is the only thing that makes those differ. Read the rules from `statsOf`, not
from the constants — the constants are the floor, not the answer.

`combat.mjs` is the first verb that is not movement: one committed swing and a
dodge, gated by a stamina pool. Three windows — wind-up, active, recovery — and
during the active one the actor goes nowhere and cannot cancel into anything. A
dodge cancels the recovery and only the recovery.

None of those numbers are balance, and they are not meant to be: #9 decides what
a hit is worth. They are sized to be *legible*, because the question underneath
#23 is whether a committed swing reads at 45° where the character is forty
pixels tall. `sweep` reports that the arc covered a target this tick and stops
there — as a bitmask, which is also how it goes over the wire.

`enemy.mjs` is one archetype — a sentry automaton — and the encounter that
holds them. It produces an input and hands it to the same `step` the player
uses, which is what keeps it honest about the movement budget: it steps a metre,
falls, drowns and burns exactly as a player would, and `canVault = false` is why
a heavy machine goes around instead of pulling itself over a ledge.

The interesting part is the telegraph, and the rule it produced: **the tell goes
on the surface the camera can see.** At 45° you look at the top of things, so a
raised arm is foreshortened to nothing. This one stops dead, rises, and lights
its top plate — and the stopping is the tell that works at any zoom, because
everything else in a fight is moving.

`makeEncounter` also defines the wire format for enemies, and the host draws
from that same format rather than from its own actors. If a field the guest
needs were missing, the host's picture would break too.

`lattice.mjs` is the spine of progression: a frame is a list of axial hex cells,
and everything else falls out of the adjacency that implies. One frame of eight —
four sockets in a rhombus, five edges — nine modules and six fusions. A module
seated in a socket modifies the stats block `combat.mjs` hands out; two modules
**from different traditions across a shared edge** fuse, if you know the recipe.

Three rules are worth knowing before adding to it. Fusion is only ever
cross-tradition, which is §1 made mechanical. A machine drops its **own**
discipline, so the prototype's all-tech machines can never hand you two
traditions — the lattice cannot be filled by fighting. And the recipe is the
scarce half: an adjacency you cannot close is inert until you have walked to a
cache that had the recipe in it.

`recomputeGear` is the only writer of stats. Two machines holding the same
lattice compute the same numbers in the same order, which is what lets a guest
replay its inputs against the host's gear rather than near it.

`loot.mjs` is where modules come from, and the reason to walk anywhere. The
interesting part is what it does *not* do: nothing here crosses the wire except
a bitmask of what has been taken. Caches are derived from the landmark and the
routed sites, which both machines grew from the same seed; a machine's spoil is
derived from its index and lies where that machine fell, which the guest is
already being told. That is the shape the netcode promised for edits, enemies
and loot — deltas against something both ends already have.

## src/net

```js
import { makeLoopback } from './src/net/transport.mjs';
import { makeHost, makeGuest } from './src/net/session.mjs';

const wire = makeLoopback({ latency: 6, loss: 0.2 });
const host = makeHost({ col, spawn, transport: wire.a, cfg });
const guest = makeGuest({ transport: wire.b, build: (cfg) => ({ col: myCol, spawn }) });
// each tick:  wire.pump(); host.step(hostInput); guest.step(guestInput);
```

**Gear is not an input.** Inputs are replayed after a correction, and "seat the
module I am carrying in slot 2" applied four times is not the same as applied
once. Socketing goes as its own message, the host applies it exactly once, and
the snapshot is the answer; a menu click can afford the round trip. The lattice
itself rides the snapshot, because `step` reads it and a replay against the
wrong one lands somewhere the host never was.

The host owns the simulation and runs both characters. The guest runs its own
immediately from its own input — otherwise every step would cost a round trip —
and then reconciles: an authoritative snapshot is restored **wholesale**, and
every input the host had not yet seen is replayed on top of it.

That only works because `step` is deterministic. The smoke test asserts the
strong form of it: after latency, after twenty percent packet loss, once
everyone stops moving the two ends hold *identical* state, not similar state.

`transport.mjs` is three methods — `send`, `onMessage`, `close` — and assumes
nothing about reliability or ordering, because the session is written not to
need either. A lost input is never re-sent; the host repeats what it has and the
next snapshot puts the guest right. Steam Networking implements the same three
methods later; the playable build currently speaks postMessage between two
browser windows, and `makeLoopback` is what the tests drive.

Nothing about the terrain crosses. The host sends a seed and the guest grows the
same world itself, which is what makes edits, enemies and loot affordable later:
they are deltas against something both ends already have.

### Known debt

- Colours are still chosen here, per voxel, from the biome palettes, alongside
  the material ids. That is deliberate for the plate's dithered blends, but the
  greedy mesher (issue #12) wants the look decided from the material at draw
  time, and the two will have to be reconciled then.
- One window at a time. The generator is positional in `cell(x, z)` but the
  world-build stream is ordered, so two overlapping windows do not agree at the
  seam. Issue #16 is region-level determinism, and it blocks chunk streaming.
