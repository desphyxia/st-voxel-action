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
| `src/mesh/` | Greedy meshing with baked per-face AO, and the edit layer a carve writes into. Reads the generator's spans, not its voxels. No DOM either. |
| `src/gen/chunk.mjs`, `src/sim/chunks.mjs`, `src/sim/stream.mjs` | Chunk streaming (#13), in three layers: what to generate, what is solid across what is loaded, and which chunk next. Open the build with **`?stream=1`** to play a world with no edge — see below. |
| `docs/play/index.html` | **The playable build.** Open it in a browser and walk around; *Host a game* opens a second window and puts another character in the same world. Carries an inlined copy of `src/gen`, `src/mesh`, `src/sim` and `src/net`. |
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
| `docs/concept/index.html` — the concept plate | https://claude.ai/artifact/2ygm73vB9KdneTeDAQEwWf |

**Use the URLs above, not a `/code/artifact/<uuid>` form.** Both artifacts answer to two
address forms — a UUID and a short id — and the short id is what `action: "list"` reports and
what the publish result hands back. They reach the same artifact, but the UUID form is what the
two publishing failures below were tangled up in, so prefer the short one.

**The playable build moved to a new artifact**, and the old one is abandoned rather than
retired on purpose. From 2026-09-18 the artifact service returns HTTP 503 for *content reads*
of `f9c19fb9-115e-4055-8990-b0ae823c4f5c` — through both of its address forms — while
`action: "list"` still returns its metadata happily. A publish will not overwrite a page it
cannot first read, so that artifact can no longer be updated from here. It is still live and
still serves the build as it stood before the fullscreen option, which makes it actively
misleading: prefer the URL above. If the read ever recovers, the two can be reconciled.

**Force is needed once per session, not once per publish.** A publish will not overwrite a
version the session has not "viewed" — but *publishing* a version counts as viewing it. So the
first republish in a fresh session is refused and every later one in that session goes straight
through. On 2026-09-18 both pages were forced once and then republished twice more with no
argument at all.

**When the first one is refused, reading harder will not help.** Viewing means reading the saved
copy *whole*, and **chunked reads do not satisfy the check**: the play build was read completely,
all 5,447 lines in six contiguous chunks, and the publish was refused anyway. At 239 KB and
151 KB against the Read tool's 25k-token single-call cap there is no way through by reading. Do
not spend the context finding that out again — that mistake cost about 90k tokens.

The safe check takes one command, and it is stronger than eyeballing a diff. If anything had
been edited from inside a page, its live copy would differ from the repo file **as it stood at
the last publish**:

```
strip() { grep -v '^<!doctype html><html><head>' "$1" | grep -v '^</body></html>$' | grep -v '^$'; }
git show <last-published-sha>:docs/play/index.html | grep -v '^$' > /tmp/was.html
diff <(strip saved.html) /tmp/was.html
```

**Blank lines must come off both sides.** The saved copy keeps them and an earlier version of
this recipe stripped them only from the repo file, which reported 454 differing lines on a page
nobody had touched — every one of them an empty line. That looks exactly like someone having
typed into the page, which is the one thing the check exists to rule out.

If no commit matches, loop over the last twenty: `git log --format=%H -20 -- docs/play/index.html`
and diff each. The last-published sha is rarely the one you remember — this note said
`487222d` and the live pages were actually at **`5113762`** (play) and **`77d6278`** (concept)
when the loop was run on 2026-09-19. On 2026-09-20 the loop found play at **`46776c9`** and
concept at **`669c55e`** — two different shas again, and neither the one the note named. Run the
loop; do not trust this line for which sha, only for the recipe.

Both pages are published from **`7434073`**: play **version 18**, concept **version 17**.
`9c26036` was version 14 of each, forced after the loop found both clean; the publishes since
have gone through with no argument, which is the once-per-session rule above working as described.

Identical means nobody has typed into the page and forcing loses nothing. On 2026-09-18 both
pages came back identical to `487222d`. **Force is still the user's call, not yours** — show
them that result and ask.

Neither is published automatically, and a stale artifact is worse than no artifact: it is a
live link, already in circulation, quietly serving a build that no longer exists.

### Republishing is part of finishing an issue

An issue is not finished when CI goes green. It is finished when the live pages match the repo.

**The trigger is mechanical, not a judgement call.** If the commits that close an issue touch
`docs/play/index.html` or `docs/concept/index.html` — *including when only the generated bundle
moved* — that page's artifact is stale and is republished before the issue is closed.
`git diff --name-only <last-published-sha>..HEAD -- docs/` answers it. Nobody has to decide
whether the change "alters what the page shows"; touching the file is the test. That distinction
is not pedantic — #41 read as a *generator* change and still moved both bundles and both grass
shaders, which is exactly the reasoning that leaves a page behind.

**Republish only after CI is green on the pushed commit.** A page that boots in node and hangs in
a browser is what the browser half exists to catch, and #41's first push was one. Publishing
before CI reports puts a broken build behind a link people already have.

**One publish per page, not per commit.** If several issues land together, one republish covers
them all.

**Force is still the user's call.** Attempt the publish. If it is refused because the saved copy
cannot be read whole, stop and show the diff against the repo file ignoring the bundle — never
force unprompted. See the note above.

**Record where it went.** The closing comment on the issue names the artifact URL and the version
the publish returned, so *which build is live* is answerable from the issue rather than from
someone's memory.

## Working on the generator

`src/gen/` is the source. The plate has an **inlined copy** of it, because the plate has to
stay one self-contained file — it is opened from disk and published as an artifact whose CSP
admits no module graph.

```
node tools/bundle-gen.mjs           # rewrite the inlined blocks from src/
node tools/bundle-gen.mjs --check   # fail if either page is out of date
```

Two pages carry a bundle: the plate gets `src/gen`, the playable build gets `src/gen`,
`src/mesh`, `src/sim` **and** `src/net`. `MODULES` in `tools/bundle-gen.mjs` is the dependency order, and
it is also the concatenation order — a module may only use names defined above it. Three traps
the bundler now fails on rather than letting through, all of them consequences of concatenating
everything into one scope:

- a module missing from `MODULES`;
- an import that **renames** anything (`import { advance as advanceCombat }` bundles to a scope
  that only ever defined `advance`) — rename the export instead;
- **two modules declaring the same top-level name.** They do not shadow: the later declaration
  wins *everywhere*, including inside the earlier module's own code. A `groundAt` in `src/gen`
  silently captured every call meant for the one `src/sim/camera.mjs` has always exported. The
  plate stayed green because it bundles `src/gen` alone; only the build carrying both
  directories broke, and only past where the node half can see.

Edit the modules, run the bundler, commit both. The smoke test fails if they have drifted, and
also fails if the plate's worlds stop matching the ones node generates from `src/gen`.

## Streaming is an option below the view, off by default

**Streaming** in the control row under the stage replaces the one 64 m window
with a field of 32 m chunks that load and unload around the players.
`?stream=1` still works when the page is opened from disk, but it is not the
way in: **published as an artifact the page runs inside an iframe whose own
URL carries no query**, so the flag never reached it and the feature was
unreachable there for as long as it was the only switch. The button is
asserted by the browser half; the flag cannot be. It is measured — ten node
assertions across `CHUNK`, `FIELD`, `STREAM` and `SEAM`, plus four in the
browser half — and it is still not the default, for one reason:

**A chunk does not fit in a frame.** Generating one 40 m window costs 86–290 ms
cold and a 60 Hz frame is 16.7 ms, so a chunk arriving on the main thread is a
freeze a dozen frames long. Generation *and meshing* now both go to a worker
built from the page's own inlined bundle — measured off-thread over HTTP, since
a `blob:` worker is refused from a `file:` origin and the local gate can only
ever report that refusal. What this thread still pays is **67 ms**: 18 ms to
take the transferred buffers back in, and 49 ms to build the chunk's collider
and put it in the scene. Four frames rather than fifteen, and the collider is
what is left. The readout shows every figure, so it has numbers on it rather
than an opinion — which is also why the option is offered rather than made the
default.

Two things the worker cost a session to learn, both worth not relearning:
**a world cannot be structured-cloned** — it carries its generator on `w.G`,
nine closures, and `postMessage` refuses the whole object over them, so the
worker is sent no generator and the main thread reattaches one with `makeGen`;
and **readiness cannot be a wall-clock timeout**, because the reply is
delivered on a main thread that is blocked by construction, so a healthy pool
reads as a refused one.

**A streamed world is a different world from the same seed.** The generator is
not size-invariant — a 40 m window and a 64 m window centred on the same point
disagree on 87% of the cells they share — so `?stream=1` is not a rendering
option, it is another world. `src/gen/chunk.mjs` measures that and explains why
every streamed window is therefore one fixed size forever.

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

node tools/look.mjs                     # the look gate: twelve plates vs the baseline
node tools/look.mjs --update            # re-record it, deliberately
node tools/look.mjs --noise             # what two renders of identical input differ by
```

**How the world looks is measured too, now** (issue #29). `tools/look-baseline.json` holds a
signature per plate — layout, palette, texture and coverage — and the `LOOK` checks in
`smoke.mjs --browser` compare against it. It is not a pixel diff: the bar is *would a person
notice*. A change to shading, to the palette, or to which renderer draws the terrain will trip
it, and if the change was intended the answer is `node tools/look.mjs --update`, not a wider
tolerance.

Run `--diag` before and after any change to the generator. A feature that silently stops being
produced looks identical to one that was never there. That is not hypothetical: making bridges
route-driven removed them from every seed, and it took counting across six seeds to notice —
the screenshots looked fine.

`--diag` and the baseline both carry a **digest** per seed: an FNV hash over every array the
generator emits. The counts catch a feature that vanished; the digest catches a voxel that
moved or a shade that shifted while every total stayed the same.

## Conventions

- Work on `main`. It is the repo's default branch. The history before
  2026-09-19 is on `claude/isometric-voxel-rpg-concept-4kpykc`, which was the
  default until then and which `main` was branched from — same commits, same
  shas, nothing rewritten. Nothing needs to be done with that branch; it is
  kept so links to it keep resolving.
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
- Region-level determinism (#16) and the rest of the ordered stream (#41) both **landed**,
  which is what unblocked chunk streaming (#13). Sites, trails, crossings and landmarks are
  decided per 64 m region in `src/gen/region.mjs`; everything else is keyed on the place it
  belongs to. **There is no ordered stream left in `src/gen`.** Two windows onto the same
  ground now agree voxel for voxel outside a measured **4 m skirt** — which is the overlap
  #13 will have to generate and discard. See `src/README.md`.

**Phase 0 is complete**, and the rule it carried — *do not start on meshing or streaming
while there is still nothing to play* — has been served: there is a build you can open and
fight in. The engine backlog is no longer deferred behind it. What still gates the rest is
ordering, not phase: `docs/PROTOTYPE.md` remains the authority on what "playable" means and
on the rules that keep every merge playable.

## What the plate now contradicts

The plate predates the later decisions and disagrees with the record in six places — biome
set, climate chart, cave treatment, voxel materials and rendering approach. They are listed at
the end of `docs/DECISIONS.md`. Reconciling them is tracked in the issues, not here.
