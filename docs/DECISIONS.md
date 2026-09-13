# Quarterstone — design decisions

Recorded from design interviews, 2026-09-12 and 2026-09-13. This is the record the concept
plate and any engine work should be checked against. Nothing here is built yet.

---

## 1. Premise and fiction

**Three rival traditions fought here.** Tech, magic and biological were competing schools of
the old world that never combined — which is why fusing them is new, and why their ruins,
their machines and their palettes look nothing alike. The war did not end cleanly: each
tradition's weapon is **still running**, and the scars they left are still spreading.

**You are heirs of the builders**, returning to something that was yours, on a **hostile
frontier**. The people who stayed are **neutral holdouts** — no stake in the old war, stayed
because leaving was worse. They trade with anyone, know the land, and are the only place the
fighting is not.

**The drive:** find the three weapons and shut them down, one per tradition.

**The ending:** the three weapons were holding each other in check. Shutting them down
releases whatever the glasslands collision produced. Completion is a new, harder phase in the
same world — not credits.

## 2. Shape of the game

| Decision | Choice |
| --- | --- |
| Session shape | Persistent seeded world, returned to across sessions |
| World extent | Bounded world per seed — a few km² with a real edge |
| Co-op camera | Independent cameras; players separate freely |
| Death | Partner revive; if both fall, respawn at the last landmark and your carried modules stay where you fell |
| Camps | Claim the holdings the generator already places — no building system |
| Difficulty | Scales to party size, so nobody is locked out playing alone |
| Enemy respawn | Everything repopulates over in-game days |

## 3. Combat and movement

| Decision | Choice |
| --- | --- |
| Feel | Methodical, stamina-gated: deliberate spacing, committed swings, readable telegraphs |
| Defence | Dodge is universal; blocking is frame-dependent (the bulwark's root wall is the extreme case) |
| Targeting | Mouse free-aim; **twin-stick free aim** on gamepad |
| Movement budget | Step up 1 m · vault 2 m · jump a 2.5 m gap · survive a 6 m drop · wade 0.75 m · swim deeper · magma lethal |

## 4. Gear and progression

**Modules and sockets are the spine.** Character stats, unlocked movement verbs and module
refinement all exist, but as seasoning — the hex lattice carries the sense of getting
stronger.

| Decision | Choice |
| --- | --- |
| Frames | 8, each a hex socket lattice; frames never level up |
| Modules | 9 across tech, magic and biological; fuse only across shared hex edges |
| Fusion knowledge | **Learned from the world** — recovered from ruins, dead machines and holdout traders, not known from the start |
| Sourcing | Landmark caches, enemy drops, bought from holdouts (not crafted) |
| Inventory | Limited carried slots, stash at camp |

## 5. World and terrain

**Four natural biomes**, in the climate field: Meadowlands · Redrock Mesa · Cloudpine
Highlands · Thornwood. (Boreal Fen and Frostmoor are dropped — they overlapped their scar
counterparts and wasted contrast.)

**Four scars**, painted as an **overlay on the climate field** rather than as biomes of their
own, so a scar can cut across several biomes and you can still see what the land used to be
underneath:

- **Ashfall Barrens** — the tech weapon's burn: basalt columns, magma seams, grey crust
- **Rimewaste** — a magical winter that never lifted: black ice, things frozen mid-motion
- **Sporeverge** — a biological bloom that got out: fungal towers, spore fog
- **Glasslands** — where two weapons met: vitrified ground, shard fields

| Decision | Choice |
| --- | --- |
| Chunk | 32 × 32 m footprint, 16 m ceiling — 128 × 128 × 64 voxels |
| Feature grid | 1 m; every feature dimension is a whole number of metres |
| Voxel | 25 cm, for surface detail, palette dithering and silhouette |
| Ceiling | 16 m applies to terrain; props (obelisks, hive trees, arcs) may exceed it |
| Caves | Cliff-face decoration — mouths, alcoves, undercuts, no walkable interior |
| Materials | Full material ids driving audio, carve hardness, flammability, conduction, friction, emission |
| Weather | Full day/night and weather; rain wets materials, snow accumulates, fog for distance |
| Terrain edits | Persist near settlements; wilderness heals over a few in-game days |
| Navigation | A map you fill by walking |

## 6. Content and enemies

Three sources, all derived from the premise:

- **Each tradition's war machines** — tech automata, magical constructs, biological weapons,
  still holding positions against enemies who left. They drop their own discipline's modules,
  so a fight previews its loot.
- **Scar-born things** — whatever crawled out of the contaminated ground. One threat
  signature per scar, and they spread as the scars do.
- **Wildlife adapted to the damage** — populates the natural biomes and makes the scars read
  as worse by comparison.

Rival heirs were explicitly excluded: there is no human opposition.

**All encounters and sites are procedural.** No hand-built interiors, no authored dungeons.

## 7. Technical

| Decision | Choice |
| --- | --- |
| Terrain rendering | Greedy-meshed chunks with baked per-face AO; props stay instanced |
| Netcode | Host-authoritative peer-to-peer over Steam Networking |
| Save ownership | **Shared world, host only** — the world can be played only when the host is online |
| Platform | Steam desktop first, wrapped (Electron or Tauri); browser build is a test harness |
| Art pipeline | Hybrid — hand-authored `.vox` for characters, creatures and hero structures; trees, boulders, walls and clutter stay procedural |

## 8. Presentation

| Decision | Choice |
| --- | --- |
| HUD | Classic — bars, cooldowns, fusion states, partner status |
| Audio | Material-driven and sparse: footsteps, impacts and carving read off the voxel material; wind drives ambience; music is rare and marks moments |

---

## Still open

- Enemy archetypes, telegraphs and AI behaviour within the three sources above.
- What a scar does to you mechanically, per scar, now that they are "still running".
- Boss structure for the three weapon sites, and what the glasslands releases.
- Quest and objective plumbing (minimal, given the drive is self-evident).
- Stamina numbers, damage types, status stacking rules.
- Accessibility.

## Tensions to resolve

1. **Procedural everything versus three climactic weapon sites.** The drive is to find and
   shut down three specific things, and the ending escalates from there — but no hand-built
   content is allowed. Those sites are the game's spine and its climax, and they must come out
   of rules. This is the sharpest conflict in the document and it should be resolved before
   encounter work starts. Either the generator gets a real set-piece grammar, or the "keep
   everything procedural" call gets a carve-out for exactly four places.

2. **Host-only saves gatekeep a persistent world.** One player cannot touch the world when the
   other is offline. Proposed mitigation, not yet decided: split the save — the **world** belongs
   to the host, but each player's **character** (modules, stats, learned fusions) is local to
   them, so progress is never hostage even though the world is.

3. **Two aiming models, one ability set.** Mouse free-aim gives a point; twin-stick gives a
   direction. Ground-targeted abilities — the censer's fields, the tuning stake — need a
   placement rule that is fair on both: likely "cast at a fixed range along the aim direction,
   with the mouse setting the point directly".

4. **Repopulation versus claiming.** Everything returns over days, but claimed holdings are
   supposed to be yours and anchor the persistence radius. Claimed sites need an exemption, or
   a weaker repopulation, or claiming means nothing.

5. **"Eight biomes" is four biomes and four overlays.** Worth being precise in the generator
   and the plate: the climate field has four anchors; the scar field paints four contamination
   layers over them. The climate chart on the concept plate currently shows five anchors and is
   simply wrong now.

6. **Party scaling does not cover environmental danger.** Scars are still running, so their
   hazards are environmental rather than enemies. Scaling to party size does nothing for them —
   which may be correct (the map is the difficulty curve) but should be deliberate.

7. **Materials without crafting.** Materials serve audio, carving, fire and conduction only.
   Coherent, but harvesting has no purpose unless crafting returns.

## What the current concept plate contradicts

`docs/concept/index.html` predates most of this and is now wrong in six places: it ships five
biomes including Boreal Fen and Frostmoor; its climate chart has five anchors and no scar
overlay; it has no Cloudpine Highlands or Thornwood; it renders caves as though they mattered;
its voxels carry colour only; and it draws instanced boxes rather than meshed chunks.

The generator's *structure* is unaffected — chunking, whole-metre features, the detail pass,
trails, reach, erosion, the water table, accumulation, the wind field and destructibility all
stand.
