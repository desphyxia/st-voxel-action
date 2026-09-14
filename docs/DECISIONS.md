# Quarterstone — design decisions

Recorded from design interviews, 2026-09-12 and 2026-09-13. This is the record the concept
plate and any engine work should be checked against. Nothing here is built yet.

**Concept plate:** `docs/concept/index.html` — published at
https://claude.ai/code/artifact/10034b02-a25d-4f5b-ab04-cea2076ceee8
(to update that artifact, a session must pass the URL explicitly, or it creates a second one).
Remaining work is tracked in GitHub issues; this file records decisions, not tasks.

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
| Swing shape | **Wind-up, active, recovery — committed throughout.** The active window pins you in place and cannot be cancelled by jump, vault or dodge; a dodge cancels the *recovery* and nothing else, which is the only escape hatch and costs stamina you wanted for the next swing |
| What is drawn vs what is dangerous | **Different questions.** The hitbox is the active window; the arc on screen outlives it and fades. At 45° the active window is an eighth of a second and the character is forty pixels tall — a visual that lasted exactly as long as the hitbox would not be seen |
| Character physics | **Solved from the budget, not tuned.** Run speed is the only free number; gravity, jump speed and airtime follow from it so that a jump clears exactly `MOVE.jump` and no more. A jump that quietly cleared 3.2 m would stop canyons being obstacles, and nobody would notice for months |

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
| Scar hazards | **A distinct hazard per scar** — ashfall burns and blocks sight, rime drains stamina and freezes water, spores infect over time. Each scar is a place you prepare for differently |
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

### The first archetype, specified

One of the three tradition sources, taken to the level #6 asks for, because #24 needed it built.
The other eleven are still open.

**Sentry automaton** — tech, still holding a position against an enemy that left.

| | |
| --- | --- |
| Silhouette | Squat and wide. From 45° you mostly see the **top** of things, so the readable surface is its top plate — and that is where the tell goes |
| Telegraph | **It stops dead, rises, and the plate flares.** The stopping is the tell that works at any zoom: everything else in a fight is moving. The rise changes its footprint, which is the one silhouette change an overhead view can see. A wedge on the ground says where |
| Opening | A recovery **longer than the player's whole swing**, so dodging through the strike buys a free hit rather than only survival |
| Against the budget | Walks the same budget the player does, through the same controller — steps a metre, falls, drowns, burns. **Does not vault**: a heavy machine goes around. It outranges the player, so closing is a decision |

The general rule this produced, and which every later archetype inherits: **the tell goes on the
surface the camera can see.** Anything staged in a vertical plane — a raised arm, a leaned-back
wind-up — is foreshortened to nothing from above.

### Weapon sites

The destinations of the main drive, one per tradition: a **tech furnace** half-buried in the
ashfall's basalt and still venting; a **rime engine** holding a winter in place at the centre
of the ice; a **spore core** still seeding the bloom. A fourth site is whatever the glasslands
collision produced, which the other three were holding in check.

| Decision | Choice |
| --- | --- |
| How they are made | **Set-piece grammar** — the generator learns a vocabulary for climactic sites (approach, gate, arena, core) assembled from per-tradition parts. They vary by seed like everything else |
| Boss | A **guardian construct** built to protect the weapon — conventional telegraphs, openings and positioning, not an environmental puzzle |

**All encounters and sites are procedural**, including these. No hand-built interiors, no
authored dungeons. The set-piece grammar is what makes that possible, and it is a substantial
generator workstream in its own right — not a content pass.

## 7. Technical

| Decision | Choice |
| --- | --- |
| Terrain rendering | Greedy-meshed chunks with baked per-face AO; props stay instanced |
| Netcode | Host-authoritative peer-to-peer over Steam Networking |
| Client model | **The guest predicts and reconciles.** It applies its own input immediately, and on each authoritative snapshot restores the host's state wholesale and replays every input the host had not yet seen. The replay lands on the host's answer *exactly*, not near it, because the controller is deterministic — which is what the pinned arithmetic was for |
| What crosses the wire | **A seed and two characters.** The world is a pure function of its seed, so terrain is never sent; later, edits, enemies and loot are deltas against something both ends already have |
| Save ownership | **Shared world, host only** — accepted deliberately. One world, one save, one owner; the pair plays together or not at all |
| Platform | Steam desktop first, wrapped (Electron or Tauri); browser build is a test harness |
| Art pipeline | Hybrid — hand-authored `.vox` for characters, creatures and hero structures; trees, boulders, walls and clutter stay procedural |
| Generator arithmetic | **Only operations the spec pins exactly.** `Math.sin`, `cos`, `exp`, `pow` and `hypot` are implementation-approximated and differ between engine versions; `src/gen/exact.mjs` replaces them. A seed has to grow the same world on both players' machines, and in the tooling that measures it |

## 8. Presentation

| Decision | Choice |
| --- | --- |
| Camera | **Orthographic 45°, following one player, snapping in quarter turns** — the plate's view, made to follow. Movement is camera-relative, so a snap turns the world and not the controls |
| HUD | Classic — bars, cooldowns, fusion states, partner status |
| Audio | Material-driven and sparse: footsteps, impacts and carving read off the voxel material; wind drives ambience; music is rare and marks moments |

---

## Still open

- Enemy archetypes, telegraphs and AI behaviour within the three sources above.
- What the glasslands releases once all three weapons are down.
- The set-piece grammar's actual vocabulary — what an approach, a gate, an arena and a core
  are made of, and how each tradition's parts differ.
- Quest and objective plumbing (minimal, given the drive is self-evident).
- Stamina numbers, damage types, status stacking rules.
- Accessibility.

## Tensions to resolve

1. **Two aiming models, one ability set.** Mouse free-aim gives a point; twin-stick gives a
   direction. Ground-targeted abilities — the censer's fields, the tuning stake — need a
   placement rule that is fair on both: likely "cast at a fixed range along the aim direction,
   with the mouse setting the point directly".

2. **Repopulation versus claiming.** Everything returns over days, but claimed holdings are
   supposed to be yours and anchor the persistence radius. Claimed sites need an exemption, or
   a weaker repopulation, or claiming means nothing.

3. **"Eight biomes" is four biomes and four overlays.** Worth being precise in the generator
   and the plate: the climate field has four anchors; the scar field paints four contamination
   layers over them. The climate chart on the concept plate currently shows five anchors and is
   simply wrong now.

4. **Party scaling does not cover environmental danger.** Scars are still running, so their
   hazards are environmental rather than enemies. Scaling to party size does nothing for them —
   which may be correct (the map is the difficulty curve) but should be deliberate.

5. **Materials without crafting.** Materials serve audio, carving, fire and conduction only.
   Coherent, but harvesting has no purpose unless crafting returns.

## What the current concept plate contradicts

`docs/concept/index.html` predates most of this and is now wrong in six places: it ships five
biomes including Boreal Fen and Frostmoor; its climate chart has five anchors and no scar
overlay; it has no Cloudpine Highlands or Thornwood; it renders caves as though they mattered;
its voxels carry colour only; and it draws instanced boxes rather than meshed chunks.

The generator's *structure* is unaffected — chunking, whole-metre features, the detail pass,
trails, reach, erosion, the water table, accumulation, the wind field and destructibility all
stand.
