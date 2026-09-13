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
2. **Material ids** (#14). The one "do it anyway" item — it changes the per-voxel layout that
   the mesher, the save deltas and the netcode all read, and it is cheap now.
3. **Collision and a character controller** — the movement budget, made real.
4. **Camera and input** — isometric follow camera, mouse and twin-stick aim.
5. **Two players moving.** Earlier than comfortable: authority discovered late is a rewrite,
   discovered now it is an interface. Plain WebRTC or WebSockets behind an interface Steam
   Networking can later implement. No Electron wrapper needed to prototype.
6. **One frame, one attack, stamina, dodge.** Longblade only.
7. **One enemy** with a telegraph and a death.

**Deliberately deferred, and recorded as debt:** the instanced-box renderer stays until
streaming forces the mesher — it handles a single window fine. Also deferred: LOD, region
determinism, save deltas, the Steam wrapper, seven of the eight frames, and every module the
first attack does not need.

## Enforcement

The real audience for these rules is a future session with no memory of the decision. A hook
can be skipped and a red check can be ignored; a rule written where the next person reads it
is what actually holds.

| Layer | What it does |
| --- | --- |
| `tools/smoke.mjs` | The assertions. Bundle sync, headless generation, boot, cross-engine math, plate/node parity, golden-master, sanity invariants, render. |
| `tools/hooks/pre-push` | Runs `--quick` before anything leaves the machine. Seconds. Install: `node tools/hooks/install.mjs` |
| `.github/workflows/ci.yml` | Full smoke on every push and PR, with the render pass. |
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
