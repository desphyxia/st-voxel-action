/**
 * Every colour the generator can emit, in one table — issue #28.
 *
 * Until now a voxel carried three floats of RGB, chosen at generation time by
 * `pickFrom(b.surf, R)` and a shade multiplier, and collapsed on the spot. That
 * made the look part of the per-voxel record: the renderer could not restyle a
 * material without regenerating the world, which is why day/night, weather and
 * the scars had nowhere to stand.
 *
 * So the pick is no longer collapsed. A voxel carries **which entry** and
 * **what shade**, and the multiply happens at draw time against this table.
 * Two bytes instead of twelve, and a biome restyles by editing one row here.
 *
 * Why an index rather than the hex itself: `0xc08a52` appears in both the mesa
 * surface and the mesa rock. Keyed by colour, those would collapse to one entry
 * and restyling the ground would silently restyle the cliffs. The index has to
 * say *which palette slot*, not just what colour came out of it.
 *
 * Groups are declared by name and flattened on load, so PALETTE is contiguous
 * and PAL.X is the run inside it. Insertion order of string keys is specified,
 * so the table is the same in every engine — the same reason src/gen/exact.mjs
 * exists.
 */

/** Named runs. Add a row rather than reusing one: two things that happen to be
    the same colour today are two things that can be restyled apart tomorrow. */
const GROUPS = {
  /* ---- biome ground, four slots each ---- */
  MEADOW_SURF: [0x5f8f3e, 0x6b9a45, 0x557f36, 0x74a24e],
  MEADOW_SOIL: [0x6b4f33, 0x5a4229, 0x7a5a3c],
  MEADOW_ROCK: [0x7d7a72, 0x8b877e, 0x6d6a63],
  MEADOW_BED:  [0xcbb187, 0xd6bd94],
  MESA_SURF:   [0xc98f55, 0xd6a066, 0xb97f49, 0xc08a52],
  MESA_SOIL:   [0xa9723f, 0x8f5f34],
  MESA_ROCK:   [0xb07a45, 0xc08a52, 0x9a6a3f, 0xd1a06a],
  MESA_BED:    [0xd8c08c, 0xc9ad7a],
  PINE_SURF:   [0x4f7a5e, 0x5a866a, 0x466f55, 0x628e70],
  PINE_SOIL:   [0x4a4036, 0x3d352d],
  PINE_ROCK:   [0x7a7f84, 0x6a6f75, 0x898e92],
  PINE_BED:    [0x8f969a, 0xa3a9ab],
  THORN_SURF:  [0x6f6d3c, 0x7c7843, 0x625f35, 0x85804a],
  THORN_SOIL:  [0x5e4630, 0x4f3a28],
  THORN_ROCK:  [0x857a68, 0x756b5a, 0x93887a],
  THORN_BED:   [0xb8a47e, 0xa89470],
  ASH_SURF:    [0x3a3532, 0x46403c, 0x2f2a28, 0x4d4642],
  ASH_SOIL:    [0x2b2726, 0x241f1e],
  ASH_ROCK:    [0x33302f, 0x3f3a38, 0x282524],
  ASH_BED:     [0x1e1a19, 0x272322],
  RIME_SURF:   [0xdfe7ee, 0xe9eef4, 0xcfd9e2, 0xd7e0e8],
  RIME_SOIL:   [0x8b95a0, 0x79838e],
  RIME_ROCK:   [0x6b7480, 0x7c8590, 0x5d6670],
  RIME_BED:    [0x2c3a46, 0x384a58],
  SPORE_SURF:  [0x6d5a78, 0x7a6586, 0x5f4f6a, 0x86709a],
  SPORE_SOIL:  [0x3a2f34, 0x2e252a],
  SPORE_ROCK:  [0x5b5860, 0x4c4a52],
  SPORE_BED:   [0x4a4036, 0x3c3530],
  GLASS_SURF:  [0x2f3b3a, 0x3c4d4a, 0x243030, 0x4a615c],
  GLASS_SOIL:  [0x5a5048, 0x4a423c],
  GLASS_ROCK:  [0x33423f, 0x405450, 0x283533],
  GLASS_BED:   [0x1d2828, 0x263434],
  /* ---- what settles on top, and what a route wears ---- */
  SNOWFALL:    [0xe7eef4, 0xdae3ec, 0xf1f6fa],
  ASHFALL:     [0x6b635c, 0x746c64, 0x5c554f],
  TRODDEN:     [0x9a7c54, 0x8d7049, 0xa68960, 0x7f6641],
  MAGMA_CRUST: [0x2b2422],

  /* ---- trees ---- */
  CONIFER_TRUNK:      [0x4a3a2c],
  CONIFER_TRUNK_COLD: [0x4a4038],
  CONIFER_LEAF:       [0x2f5233, 0x3c6b3e],
  CONIFER_CAP:        [0xdfe7ee],
  SCRUB_TRUNK:        [0x6b5233],
  SCRUB_LEAF:         [0x6f7f42, 0x87904a],
  SNAG_TRUNK:         [0x2e2825, 0x3a322e],
  SNAG_BRANCH:        [0x332b27],
  BROAD_TRUNK:        [0x5a4130],
  BROAD_LEAF:         [0x4f7a3a, 0x628f45],
  BROAD_LEAF_PALE:    [0x8ea84b],
  THORN_TRUNK:        [0x3a2c24, 0x46352a],
  THORN_LEAF:         [0x4a5a2e, 0x3c4a26],
  THORN_BERRY:        [0x8a2a2a],
  FUNGUS_STALK:       [0xd8cfc0, 0xc9bfae],
  FUNGUS_CAP:         [0x7a4f8a, 0x8e5e9e, 0x5f6f9a],
  SHARD:              [0x9fd8d0, 0x7fc0c0, 0xcff0ea],

  /* ---- undergrowth and deadfall ---- */
  BUSH_COLD:   [0x6f8390, 0x8aa3ad],
  BUSH_BURNT:  [0x3b332e, 0x4a403a],
  BUSH_DRY:    [0x6f7f42, 0x87904a],
  BUSH_GREEN:  [0x3f6b34, 0x4e7d3e, 0x5d8c46],
  BUSH_THORN:  [0x3f4a2a, 0x4a4430, 0x55502e],
  BUSH_SPORE:  [0x7a5f86, 0x5f7a8a],
  BUSH_GLASS:  [0x6f8f88, 0x86a8a0],
  STUMP_WOOD:  [0x5a4130],
  STUMP_CUT:   [0x8a6a4a],
  FALLEN_BARK: [0x4c3728],
  FALLEN_MOSS: [0x6b5a45],

  /* ---- built things ---- */
  FENCE_POST: [0x6b5a45],
  FENCE_RAIL: [0x5f5040],
  LAMP_POST:  [0x3f4650],
  HUT_ROOF:   [0x5a4130],
  DECK_PLANK: [0x5a4a38],
  DECK_WORN:  [0x6b5a45],
  DECK_RAIL:  [0x4c3f30],

  /* ---- landmarks ---- */
  HIVE_TRUNK: [0x4c3728],
  HIVE_BARK:  [0x6b5a45],
  HIVE_LEAF:  [0x3f6630, 0x507f3c],
  HIVE_BLOOM: [0xb7d84f],
  WRECK_HULL: [0x4a443e],
  WRECK_TRIM: [0x6a6259],

  /* ---- emissive. Drawn as its own pass, same table. ---- */
  EM_MAGMA:   [0xff6a1e, 0xffa23c],
  EM_LAMP:    [0xffd08a],
  EM_OBELISK: [0x9fe3ff],
  EM_HIVE:    [0xb7f04f],
  EM_WRECK:   [0xff9a3c],
  EM_SPORE:   [0xb8f07a, 0x8fe8c8],

  /* ---- the authored hero (#34), after everything else so no index moves ---- */
  HERO_HAIR:    [0x3a2a1e],
  HERO_LEATHER: [0x5a3f2a],
  HERO_BOOT:    [0x2e2622],
  HERO_TROUSER: [0x3b3834],
  HERO_CANVAS:  [0x6b604c],
  HERO_EYE:     [0x16181c],
  HERO_IRON:    [0x6b6660],
  HERO_STEEL:   [0xa9b0b6],
  HERO_MARK:    [0xd9a25e],
};

/** The flat table the renderer indexes. */
export const PALETTE = [];
/** name -> { at, n }: where that group starts and how long it is. */
export const PAL = {};
(function () {
  var k, i, g;
  for (k in GROUPS) {
    if (!Object.prototype.hasOwnProperty.call(GROUPS, k)) continue;
    g = GROUPS[k];
    PAL[k] = { at: PALETTE.length, n: g.length };
    for (i = 0; i < g.length; i++) PALETTE.push(g[i]);
  }
})();

/** One entry out of a group, as an index into PALETTE. */
export function pickPal(p, r) { return p.at + ((r() * p.n) | 0); }

/**
 * A shade multiplier as one byte.
 *
 * Every k in the generator falls in roughly 0.6 to 1.3 — talus is 0.72, a
 * banded soil stripe reaches 1.26 — so the byte spans 0.5 to 1.5 and resolves
 * to about 0.004. The dithering it carries varies by 0.2 and more, so the
 * quantisation is well under what the eye or the palette can show, and it is
 * applied in the generator so node and the page quantise identically.
 */
export function shadeByte(k) {
  var b = Math.round((k - 0.5) * 255);
  return b < 0 ? 0 : (b > 255 ? 255 : b);
}
export function shadeValue(b) { return 0.5 + b / 255; }

/** The colour a voxel actually draws, for a renderer that wants it resolved. */
export function palR(idx, b) { return ((PALETTE[idx] >> 16 & 255) / 255) * shadeValue(b); }
export function palG(idx, b) { return ((PALETTE[idx] >> 8 & 255) / 255) * shadeValue(b); }
export function palB(idx, b) { return ((PALETTE[idx] & 255) / 255) * shadeValue(b); }
