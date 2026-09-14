# Getting to playable, and staying there

Two rules govern the prototype phase. The first gets us to something we can judge; the second
stops it rotting afterwards.

> **Do early what is expensive to change later. Defer everything that is merely slow.**
>
> **Every merge leaves the build playable.**

---

## What "playable" means

The bar for the **first** playable build, deliberately small enough to reach in days:

> A character walks, vaults, jumps and falls on generated terrain under the movement budget,
> with the isometric camera following, for five minutes, without falling through the world.

That is **Move and look**. It cannot tell us whether the game is good — only whether moving
through this world feels good, which is the first thing worth knowing and the thing the
terrain work has been serving all along.

It is a floor, not a ceiling. The bar **ratchets**: see below.

**Met, as of #21**, and passed. `docs/play/index.html` is that build, and as of #24 it was
**move and fight** — the first build anyone could form an opinion about, which was the whole
point of the ordering. Phase 0 is complete.

As of #27 it is **move, fight and fuse**: the hex lattice is in, a machine leaves the discipline
it was built from where it fell, and there are caches out in the world holding modules and the
fusion recipes that make two of them worth more than two. That closes the loudest of the gaps —
"no loot, no progression and no reason to go anywhere" — and leaves the rest of Phase 1: one
frame of eight, one archetype of twelve, and a world with no set-pieces in it.

### The movement budget it is measured against

Step up 1 m · vault 2 m · jump a 2.5 m gap · survive a 6 m drop · wade 0.75 m · swim deeper ·
magma lethal. (`DECISIONS.md` §3.)

## The ratchet

**Every issue that adds a player-facing verb must add a smoke assertion covering it**, as part
of its definition of done. Internal systems — meshing, streaming, save deltas — only have to
keep the existing assertions passing.

The consequence is deliberate: `tools/smoke.mjs` becomes the real, executable specification of
what the game can do. When someone asks what state the prototype is in, the answer is the list
of assertions.

## The path there

Ordered by the first rule, not by architectural tidiness. The backlog's original order
optimised for never rewriting anything; this optimises for playing something.

1. ~~**Extract the generator from the plate into a module.**~~ **Done** (#19). It lives in
   `src/gen/` as ES modules with no DOM and no three.js; the plate inlines a generated copy,
   and the smoke test fails if the two disagree. See `src/README.md`.
2. ~~**Material ids.**~~ **Done** (#14). The one "do it anyway" item: it changed the per-voxel
   layout the mesher, the save deltas and the netcode all read, and it was cheap to do early.
3. ~~**Collision and a character controller.**~~ **Done** (#20). `src/sim/` derives collision
   from the generated spans and moves a box through it under the budget. Every clause of that
   budget is a smoke assertion, and a wanderer survives five simulated minutes on all six
   golden seeds. Nothing draws it yet — that is the next item.
4. ~~**Camera and input.**~~ **Done** (#21). An orthographic 45° follow camera with the plate's
   quarter-turn snap, camera-relative movement that survives a snap, both aiming models, and a
   remappable binding table — all in `src/sim/`, all assertable in node. `docs/play/index.html`
   is the build: open it and walk around. **The bar at the top of this document is met.**
5. ~~**Two players moving.**~~ **Done** (#22). Host-authoritative, with the guest predicting
   locally and reconciling — exactly, because the controller is deterministic. The transport is
   three methods (`src/net/transport.mjs`); the prototype speaks postMessage between two browser
   windows, and Steam Networking implements the same interface later. Nothing about the terrain
   crosses the wire: the world is a pure function of its seed.
6. ~~**One frame, one attack, stamina, dodge.**~~ **Done** (#23). Longblade only, no sockets.
   Wind-up, active, recovery; during the active window you go nowhere and cannot cancel. A dodge
   cancels the recovery and nothing else. None of the numbers are balance — #9 decides that —
   and the finding is recorded on the issue: the arc reads at 45°, the blade does not.
7. ~~**One enemy** with a telegraph and a death.~~ **Done** (#24). A sentry automaton that
   notices, closes, telegraphs, swings, staggers and dies — under the same movement budget the
   player walks, through the same controller. **Phase 0 is complete: the prototype is
   *move and fight*.**

## Phase 1, and where it started

The rule that ordered Phase 0 orders this too, and it picked the same kind of thing: the spine
of progression, because the shape of a lattice is expensive to change once saves, netcode and
twelve archetypes' drop tables all read it — and because it is the one thing that makes the
world worth walking across.

1. ~~**Modules, sockets, fusion and loot.**~~ **Done** (#27). One frame of eight, nine modules,
   six fusions, and the first reason to go anywhere: a machine drops its own tradition, so
   fighting alone can never give you two to fuse. `src/sim/lattice.mjs` and `src/sim/loot.mjs`.
   What crosses the wire for all of it is **one integer** — the caches are derived from the
   world on both machines, and a machine's spoil lies where the guest was already told it fell.

**Deliberately deferred, and recorded as debt:** the instanced-box renderer stays until
streaming forces the mesher — it handles a single window fine. Also deferred: LOD, region
determinism, save deltas, the Steam wrapper, seven of the eight frames, module refinement, the
stash, and the holdout traders that are the third source of modules.

## Enforcement

The real audience for these rules is a future session with no memory of the decision. A hook
can be skipped and a red check can be ignored; a rule written where the next person reads it
is what actually holds.

| Layer | What it does |
| --- | --- |
| `tools/smoke.mjs` | The assertions, in two halves. `--node` (seconds): bundle sync, pinned arithmetic, generation, the movement budget, the camera and input table, the lattice and what is on the ground, two networked sessions over a lossy wire, a five-minute soak per seed, golden-master, sanity invariants. `--browser` (minutes): boot, cross-engine math, plate/node parity, both renders, loot you can walk onto, and two windows playing together. |
| `tools/hooks/pre-push` | Runs `--node` before anything leaves the machine — genuinely seconds, so it survives contact with 1am. Install: `node tools/hooks/install.mjs` |
| `.github/workflows/ci.yml` | Two required jobs in parallel on every push and PR: `checks` (the node half, under a minute) and `browser` (boot, parity, and both renders). |
| This document | The bar, in the place a new session will look. |

### The rules

- **Default path:** commit to trunk directly, gated by the pre-push hook.
- **Architectural work:** anything landing behind a feature flag, or touching the voxel data
  layout, meshing, or netcode authority, goes through a **pull request** so the CI check is a
  hard gate. This narrows the repo's usual "no PRs unless asked" convention rather than
  contradicting it.
- **A red trunk stops everything.** With a single developer, fix-forward is fine *provided you
  find out immediately* — which is what CI is for.
- **Bypass is possible but visible.** `SKIP_SMOKE=1 git push` works, and requires a
  `Smoke-Skipped: <reason>` trailer on the commit. An impossible bypass gets the hook deleted
  at one in the morning; a visible one survives and leaves a trail.
- **Anything too large to land playable lands dark** — behind a flag, off by default. The flag
  flip is its own small change. This is not a nicety: the greedy mesher and the collision
  rework cannot land green in one step, and flags are what make the rule survivable.

### Performance

CI runners have no GPU, so the smoke test renders in software and **frame-rate assertions there
would be meaningless**. CI asserts what software rendering can measure honestly: generation
time, voxel and instance counts, draw calls, heap. Real frame rate is checked by hand on a real
GPU before each milestone.

When that becomes too loose — and it will — the answer is a self-hosted GPU runner, not a
frame-time assertion on a software renderer.

### Golden seeds

Six pinned seeds, recorded in `tools/baseline.json`. The generator is deterministic, so any
drift is a real change. Each seed records its counts and a **digest** — an FNV hash over every
array the generator emits, so a change that moves one voxel or shifts one colour without
changing a single total still fails the gate. Intentional changes are re-recorded deliberately:

```
node tools/smoke.mjs --update
```

Re-recording is a visible diff in a committed file, which is the point. This is the mechanism
that catches a feature silently ceasing to be generated — the failure mode that already
happened once, when making bridges route-driven removed them from every seed and the
screenshots looked fine.
