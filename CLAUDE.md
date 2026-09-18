# Quarterstone

A 45° isometric two-player online co-op action RPG on three.js. Worlds are seeded and bounded;
terrain features are sized in whole metres on a 1 m grid and built from 25 cm voxels.

**Status: move, fight and fuse.** Phase 0 is complete and Phase 1 has started. What exists is
the seeded terrain generator (`src/gen/`), collision, a character controller, an isometric
camera, a remappable input layer, one committed swing, a dodge, one enemy archetype, a hex
socket lattice with modules and fusion, and loot to fill it from (`src/sim/`),
host-authoritative netcode with client prediction (`src/net/`), and a build you can open and
fight in, with a second window if you want company (`docs/play/`) — plus the concept plate and
a design decision record.

What it still cannot tell you is whether the *game* is good: one frame of eight, one archetype
of twelve, no set-pieces, and a world one window wide. Check `docs/DECISIONS.md` before starting
anything.

## Where things are

| Path | What it is |
| --- | --- |
| `docs/DECISIONS.md` | **Read this first.** 43 decisions from design interviews, plus open items and unresolved tensions. The authority on what the game is. |
| `docs/PROTOTYPE.md` | **Read this second.** What "playable" means, the path to it, and the rules that keep every merge playable. |
| `src/gen/` | The terrain generator. Plain ES modules — no DOM, no three.js. See `src/README.md`. |
| `src/sim/` | Collision, the character controller, the isometric camera, the input table, combat, the first enemy, the socket lattice and what is lying on the ground — all written against the movement budget and all free of the DOM and three.js, which is why they can be asserted in node. |
| `src/net/` | The wire: a three-method transport interface, a loopback double with latency and loss, and the host/guest sessions. No DOM either. |
| `docs/play/index.html` | **The playable build.** Open it in a browser and walk around; *Host a game* opens a second window and puts another character in the same world. Carries an inlined copy of `src/gen`, `src/sim` and `src/net`. |
| `src/sim/lattice.mjs` | The spine of progression. Read it before touching combat numbers: every constant in `combat.mjs` is now a *base*, and `statsOf(a)` is what an actor actually plays with. |
| `docs/concept/index.html` | The concept plate: the design document, the renderer, and an inlined copy of `src/gen` it draws. |
| `tools/` | Headless render and verify harness. Dev only. |
| `README.md` | Short public summary of the project. |

**Published artifacts.** Both are live, interactive copies of a file in this repo. To
**update** one from a session that did not publish it, pass its URL as the `url` argument —
publishing without it silently creates a second artifact instead.

| Page | Artifact |
| --- | --- |
| `docs/play/index.html` — the playable build | https://claude.ai/artifact/H3kZLpjDurCiH2DMEFfr8k |
| `docs/concept/index.html` — the concept plate | https://claude.ai/code/artifact/10034b02-a25d-4f5b-ab04-cea2076ceee8 |

**The playable build moved to a new artifact**, and the old one is abandoned rather than
retired on purpose. From 2026-09-18 the artifact service returns HTTP 503 for *content reads*
of `f9c19fb9-115e-4055-8990-b0ae823c4f5c` — through both of its address forms — while
`action: "list"` still returns its metadata happily. A publish will not overwrite a page it
cannot first read, so that artifact can no longer be updated from here. It is still live and
still serves the build as it stood before the fullscreen option, which makes it actively
misleading: prefer the URL above. If the read ever recovers, the two can be reconciled.

Neither is published automatically. When a change lands that alters what either page *shows*,
republish it, or the live copy quietly drifts from the repo.

## Working on the generator

`src/gen/` is the source. The plate has an **inlined copy** of it, because the plate has to
stay one self-contained file — it is opened from disk and published as an artifact whose CSP
admits no module graph.

```
node tools/bundle-gen.mjs           # rewrite the inlined blocks from src/
node tools/bundle-gen.mjs --check   # fail if either page is out of date
```

Two pages carry a bundle: the plate gets `src/gen`, the playable build gets `src/gen`,
`src/sim` **and** `src/net`. `MODULES` in `tools/bundle-gen.mjs` is the dependency order, and
it is also the concatenation order — a module may only use names defined above it. Two traps the bundler now fails on rather than letting through,
because it concatenates everything into one scope: a module missing from `MODULES`, and an
import that **renames** anything (`import { advance as advanceCombat }` bundles to a scope that
only ever defined `advance`). Rename the export instead.

Edit the modules, run the bundler, commit both. The smoke test fails if they have drifted, and
also fails if the plate's worlds stop matching the ones node generates from `src/gen`.

One rule across **all of `src/`**: **no `Math.sin`, `cos`, `exp`, `pow` or `hypot`.** The spec
only approximates them and engines disagree — node 22 and Chromium 141 already return different
sines. In `src/gen` that gives two players different worlds from the same seed; in `src/sim` and
`src/net` it gives them different trajectories through it, and a guest that can never quite land
on the host's answer. Use `src/gen/exact.mjs`. The smoke test's MATH check catches it.

## Working on the plate

The plate is a concept artefact that has been iterated many times. Edit it; do not rebuild it
from scratch.

- three.js is pinned to **r128** deliberately: it is the last version with a UMD build reliably
  on cdnjs, which is the only script host the artifact CSP admits.
- cdnjs is **blocked** in this sandbox — from `curl` and from headless Chromium alike. Local
  verification uses `tools/node_modules/three` instead; see `tools/README.md`.
- Rendering falls back to software here, so a full render takes minutes. Budget for it.

### Every merge must leave the build playable

This is enforced, not aspirational — see `docs/PROTOTYPE.md`.

```
node tools/smoke.mjs            # everything
node tools/smoke.mjs --node     # only what needs no browser — a few seconds
node tools/smoke.mjs --browser  # only what does — minutes, software rendering
node tools/smoke.mjs --quick    # everything but the render pass
node tools/smoke.mjs --update   # re-record the golden baseline, deliberately
node tools/hooks/install.mjs    # install the pre-push hook (once per clone)
```

CI runs the two halves as two required jobs in parallel, so a regression in the half that
matters comes back in well under a minute. The pre-push hook runs `--node` for the same reason.

The smoke test is the executable specification of what the prototype can do. **An issue that
adds a player-facing verb must add an assertion covering it.** Internal systems only have to
keep the existing assertions green.

Bypass is `SKIP_SMOKE=1 git push` plus a `Smoke-Skipped: <reason>` commit trailer. Use it
rarely and visibly.

### Verify generator changes by measuring, not looking

```
node tools/render-plate.mjs --diag      # per-seed counts: voxels, water, trails, bridges, reach
node tools/render-plate.mjs --shots     # page screenshots
node tools/render-plate.mjs --plates    # the six biome plates as PNGs
```

Run `--diag` before and after any change to the generator. A feature that silently stops being
produced looks identical to one that was never there. That is not hypothetical: making bridges
route-driven removed them from every seed, and it took counting across six seeds to notice —
the screenshots looked fine.

`--diag` and the baseline both carry a **digest** per seed: an FNV hash over every array the
generator emits. The counts catch a feature that vanished; the digest catches a voxel that
moved or a shade that shifted while every total stayed the same.

## Conventions

- Work on the current branch. It is also the repo's default branch.
- Do not open pull requests unless asked — **except** for architectural work (anything behind a
  feature flag, or touching the voxel data layout, meshing, or netcode authority), which goes
  through a PR so CI is a hard gate. See `docs/PROTOTYPE.md`.
- Commit messages end with the attribution trailers used in the existing history.
- The concept plate is documentation, not a prototype of the engine. Its instanced-box
  renderer is explicitly not the shipping approach — see `docs/DECISIONS.md` §7.

## What to work on

The backlog is GitHub issues, indexed by the tracking issue:
https://github.com/desphyxia/st-voxel-action/issues/18

`docs/DECISIONS.md` records **decisions**; issues record **work**. Don't duplicate one into
the other. Two ordering notes worth knowing before picking something up:

- Material ids (#14) come before the greedy mesher (#12) — they change the per-voxel data
  layout that the mesher, the save deltas and the netcode all read.
- Region-level determinism (#16) **landed**, which is what unblocked chunk streaming (#13).
  Sites, trails, crossings and landmarks are decided per 64 m region in `src/gen/region.mjs`
  and a window only reports what falls inside it. Props, clutter, grass and the span
  undercuts are still window-scoped and still draw from the ordered stream — streaming will
  need them moved too.

**Phase 0 comes first.** The path to a playable build is a short, specific sequence in
`docs/PROTOTYPE.md`, and most of the engine backlog is deliberately deferred behind it. Do not
start on meshing or streaming while there is still nothing to play.

## What the plate now contradicts

The plate predates the later decisions and disagrees with the record in six places — biome
set, climate chart, cave treatment, voxel materials and rendering approach. They are listed at
the end of `docs/DECISIONS.md`. Reconciling them is tracked in the issues, not here.
