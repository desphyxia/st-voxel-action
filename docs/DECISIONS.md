# Quarterstone — design decisions

Recorded from a design interview, 2026-09-12. This is the decision record the concept plate
and any future engine work should be checked against. Items marked **open** are not yet
decided; items under *Tensions* are decided but conflict with something else and need a
follow-up call.

## Shape of the game

| # | Decision | Choice |
| --- | --- | --- |
| 1 | Session shape | **Persistent seeded world** — one world per seed that both players return to |
| 2 | Co-op camera | **Independent cameras** — each player has their own 45° view, free separation |
| 3 | Combat feel | **Methodical, stamina-gated** — deliberate spacing, committed swings, readable telegraphs |
| 4 | Progression | **All four axes**: gear/modules, unlocked movement verbs, character stats, module refinement |
| 6 | Death | **Partner revive**, then respawn at the last landmark; carried modules stay where you fell |
| 7 | World extent | **Bounded world per seed** — a few km² with a real edge |

## Terrain

| # | Decision | Choice |
| --- | --- | --- |
| 5 | Terrain edits | **Persist near settlements; wilderness heals** over a few in-game days |
| 9 | Vertical budget | **16 m ceiling for terrain; props exempt** (obelisks, hive trees, arcs may exceed) |
| 10 | Caves | **Cliff-face decoration** — mouths, alcoves, undercuts; no walkable interior |
| 11 | Materials | **Full material ids** — stone, soil, grass, sand, ice, basalt, wood, snow, magma, driving audio, carve hardness, flammability, conduction, friction, emission |
| 12 | Weather | **Full day/night and weather** — rain wets materials, snow accumulates, fog for distance |

## Technical

| # | Decision | Choice |
| --- | --- | --- |
| 13 | Terrain rendering | **Greedy-meshed chunks with baked per-face AO; props stay instanced** |
| 14 | Netcode | **Host-authoritative peer-to-peer over Steam Networking**; host owns the save |
| 15 | Targeting | **Mouse free-aim** |
| 16 | Platform | **Steam desktop first**, wrapped (Electron or Tauri); browser build is a test harness |

## Content

| # | Decision | Choice |
| --- | --- | --- |
| 17 | Module sourcing | **Landmark caches + enemy drops + bought from survivors** (not crafted) |
| 18 | Inventory | **Limited carried slots, stash at camp** |
| 19 | Navigation | **Map filled by exploration** |
| 20 | Art pipeline | **Hybrid** — hand-authored `.vox` for characters, creatures and hero structures; trees, boulders, walls and clutter stay procedural |

## Deferred

- **Enemies, factions and lore** (#8) — to be derived from a separate lore questionnaire.
- Audio design, HUD layout, quest and objective structure, boss and elite structure, NPC
  survivors as characters.

## Tensions to resolve

1. **Four progression axes.** "Gear only" and "character stats" are in direct opposition, and
   with verbs and refinement alongside them there are four currencies competing for the same
   reward moments. Needs a hierarchy: which is the spine, and which are seasoning.
2. **"Endless" now means endless seeds, not endless walking.** The original brief asked for
   potentially endless worlds; the decision is a bounded world per seed. Both can be true —
   unlimited seeds, each finite — but nobody should build infinite streaming on the strength
   of the old wording.
3. **Camps are load-bearing and undesigned.** Three separate decisions lean on them: edits
   persist near settlements (#5), the stash lives at camp (#18), and respawn is at a landmark
   (#6). What a camp is, who places it, what it anchors and whether players build it are all
   open.
4. **Mouse free-aim versus a Steam-first release.** Free-aim makes the gamepad second-class,
   but Steam Input is expected. A gamepad scheme — stick-aimed cursor or soft lock — still
   needs deciding.
5. **Designed content has no home.** Caves are decoration only, so authored spaces currently
   have nowhere to live except surface ruins and holdings. If hand-built encounters are
   wanted, they need a container.
6. **Materials without crafting.** Full material ids were chosen but crafting was not, so
   materials serve audio, carving, fire and conduction only. That is coherent — just note
   that harvesting has no purpose unless crafting returns.

## What this changes about the current concept plate

The plate at `docs/concept/index.html` predates these decisions and now disagrees with them
in three places: it draws instanced boxes rather than meshed chunks (#13), it renders caves
as if they mattered (#10), and its voxels carry colour only (#11). The generator's structure
is unaffected — chunking, biomes, features, trails, reach and the movement budget all stand.
