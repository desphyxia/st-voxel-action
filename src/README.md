# src

The game. Today that is the terrain generator and nothing else — see
`docs/PROTOTYPE.md` for what lands next and in what order.

| Path | What it is |
| --- | --- |
| `gen/` | The seeded terrain generator. Plain ES modules: no DOM, no three.js, no renderer. |

## src/gen

`buildWorld(cfg)` takes a seed, a size and a world offset, and returns one window
of world as plain arrays:

```js
import { buildWorld } from './src/gen/index.mjs';
const w = buildWorld({ seed: 'QUARTERSTONE', size: 64, force: null, ox: 0, oz: 0 });
// w.pos / w.col     voxel centres and colours, 3 floats each
// w.mpos / w.mcol   the emissive ones — magma, lamps, landmark lights
// w.grass, w.water  blade clouds and water surface geometry
// w.cells, w.Hs     the 1 m cell grid and the 25 cm height field
// w.reach, w.unreach, w.spawn   what the movement budget can actually get to
```

It runs identically in Node, in a worker and in the browser. `index.mjs` lists the
passes in the order they run, which is also the order the random stream is
consumed: **reordering a pass changes every world**. That is what
`tools/baseline.json` pins, and what `node tools/smoke.mjs` checks.

### Two things to know before editing

**The concept plate inlines this code, it does not import it.** `docs/concept/index.html`
has to stay one self-contained file — it is opened from disk and published as an
artifact whose CSP admits no module graph. `node tools/bundle-gen.mjs` writes the
generator into the marked block near the top of the plate; the smoke test fails if
the block and `src/gen` have drifted. Edit the modules, run the bundler, commit both.

**The style is the plate's, deliberately.** The bodies were moved across
character-for-character so the extraction could be proved: all six golden seeds
still hash to the same digest they did inside the plate. That is why this reads
like dense ES5 with `var`. Modernising it is a separate change, one that has to
keep the digests green on its own merits.

### Known debt

- Colours are still chosen here, per voxel, from the biome palettes. Issue #14
  replaces them with material ids and hands the choice of how a material looks
  back to the renderer, where it belongs.
- One window at a time. The generator is positional in `cell(x, z)` but the
  world-build stream is ordered, so two overlapping windows do not agree at the
  seam. Issue #16 is region-level determinism, and it blocks chunk streaming.
