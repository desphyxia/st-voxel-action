# Quarterstone

A 45° isometric two-player online co-op action RPG on three.js. Worlds are seeded and bounded;
terrain features are sized in whole metres on a 1 m grid and built from 25 cm voxels.

**Status: pre-production. There is no engine and no game code.** What exists is a concept
plate — a working seeded terrain generator that renders itself — and a design decision record.
Do not start engine work without checking `docs/DECISIONS.md` first.

## Where things are

| Path | What it is |
| --- | --- |
| `docs/DECISIONS.md` | **Read this first.** 43 decisions from design interviews, plus open items and unresolved tensions. The authority on what the game is. |
| `docs/concept/index.html` | The concept plate: one self-contained file holding the seeded generator, the renderer and the design document it illustrates. ~1900 lines. |
| `tools/` | Headless render and verify harness. Dev only. |
| `README.md` | Short public summary of the project. |

**Published artifact:** https://claude.ai/code/artifact/10034b02-a25d-4f5b-ab04-cea2076ceee8

That is the live, interactive version of `docs/concept/index.html`. To **update** it from a
session that did not publish it, pass that URL as the `url` argument — publishing without it
silently creates a second artifact instead.

## Working on the plate

The plate is a concept artefact that has been iterated many times. Edit it; do not rebuild it
from scratch.

- three.js is pinned to **r128** deliberately: it is the last version with a UMD build reliably
  on cdnjs, which is the only script host the artifact CSP admits.
- cdnjs is **blocked** in this sandbox — from `curl` and from headless Chromium alike. Local
  verification uses `tools/node_modules/three` instead; see `tools/README.md`.
- Rendering falls back to software here, so a full render takes minutes. Budget for it.

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

## Conventions

- Work on the current branch. It is also the repo's default branch.
- Do not open pull requests unless asked.
- Commit messages end with the attribution trailers used in the existing history.
- The concept plate is documentation, not a prototype of the engine. Its instanced-box
  renderer is explicitly not the shipping approach — see `docs/DECISIONS.md` §7.

## What the plate now contradicts

The plate predates the later decisions and disagrees with the record in six places — biome
set, climate chart, cave treatment, voxel materials and rendering approach. They are listed at
the end of `docs/DECISIONS.md`. Reconciling them is tracked in the issues, not here.
