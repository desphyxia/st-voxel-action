# tools

Dev-only. Nothing here ships with the game.

```
cd tools && npm install          # playwright-core + three@0.128.0 (r128)
cd .. && node tools/hooks/install.mjs   # pre-push gate, once per clone

node tools/bundle-gen.mjs        # re-inline src/gen into the concept plate
node tools/bundle-gen.mjs --check # fail if the plate is out of date

node tools/smoke.mjs             # the gate: sync, node, boot, parity, golden, render
node tools/smoke.mjs --quick     # same without rendering (seconds)
node tools/smoke.mjs --update    # re-record tools/baseline.json, deliberately

node tools/render-plate.mjs --diag     # generator stats per seed, no rendering
node tools/render-plate.mjs --shots    # page screenshots
node tools/render-plate.mjs --plates   # export the six biome plates as PNGs

node tools/compare-renderers.mjs  # the play build's two terrain renderers, measured
node tools/compare-plates.mjs     # and composed into plates a human can judge
```

`smoke.mjs` is the assertion gate and runs in CI; `render-plate.mjs` is for looking at things.

The two `compare-*` scripts run in that order and answer different halves of one question.
`compare-renderers.mjs` drives the build's renderer flag, screenshots both, and reports a mean
luma difference and a local 3x3 variance. **Both are proxies, and the header says why**: adding
grain moves the first one the wrong way, and at this zoom the second cannot separate a geometric
edge from surface dither. `compare-plates.mjs` takes those two shots and crops the same four
places out of each at 3x, because which renderer is better depends on *where* the difference
falls, and no single number carries that. It generates nothing — re-run `compare-renderers.mjs`
first or the plates are of a build that no longer exists.
Shared plumbing lives in `lib/harness.mjs` — both scripts rewrite the plate's three.js CDN tag
the same way, and both measure a world the same way, and that logic must not be duplicated.
See `docs/PROTOTYPE.md` for the rules the gate enforces.

`bundle-gen.mjs` inlines `src/gen` into the plate. The generator is ES modules; the plate must
stay one self-contained file, so the bundler is what reconciles the two. Its `--check` mode is
also an assertion inside the smoke test, so a forgotten re-bundle fails the gate rather than
shipping a stale plate.

**Measuring a world.** `measureWorld` returns the counts *and* a digest — an FNV hash over
every array the generator emits, down to each voxel colour. The counts catch a feature that
stopped being produced; the digest catches a change that moved a voxel or shifted a shade
without changing any total. Both are recorded in `baseline.json`.

Output lands in `.render/` at the repo root (gitignored).

**Why a local three.js.** The plate loads three.js from cdnjs, which is blocked in some
sandboxes and unavailable offline. The harness rewrites that one tag in a temp copy of the
plate to point at `tools/node_modules/three`. The version must stay in step with the plate:
both are **r128**.

**Chromium.** Defaults to the Playwright build bundled in Claude Code's remote sandbox. Set
`CHROMIUM_PATH` anywhere else. Rendering falls back to software (swiftshader), so a full run
takes minutes — the `--diag` mode skips rendering and is much faster.

**Use `--diag` before and after any generator change.** A feature that silently stops being
generated looks exactly like one that was never there. Counting bridges across six seeds is
how the "no crossings anywhere" regression was caught.
