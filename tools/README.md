# tools

Dev-only. Nothing here ships with the game.

```
cd tools && npm install          # playwright-core + three@0.128.0 (r128)
node render-plate.mjs --diag     # generator stats per seed, no rendering
node render-plate.mjs --shots    # page screenshots
node render-plate.mjs --plates   # export the six biome plates as PNGs
```

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
