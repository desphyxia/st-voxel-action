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
| Movement budget | **Revised 2026-09-27.** Walk up 0.5 m · a vertical face of 1 m takes a jump, 2 m a double jump, 3 m and more is a wall · jump a 3 m gap, double-jump a 4.4 m one · survive a 6 m drop (fall damage is **off** until decided otherwise, 2026-09-28 — the 6 m still sizes the terrain) · wade 0.75 m · swim deeper · magma lethal. The vault is gone: a climb that anything 2 m tall allowed made every cliff a staircase. It may return as an unlocked verb. *Was: step up 1 m · vault 2 m · jump a 2.5 m gap* |
| Double jump | One air jump per time off the ground, restored on landing, allowed after walking off a ledge; costs stamina, so height is a resource like a swing |
| Faces and slopes | **What is a wall is decided, not incidental.** Ordinary ground climbs in 0.25 m steps and is walked; a 1 m face exists only where a feature puts one — a ledge, a stepping stone, a terrace edge — and every such face is a jump |
| Swing shape | **Wind-up, active, recovery — committed throughout.** The active window pins you in place and cannot be cancelled by jump, vault or dodge; a dodge cancels the *recovery* and nothing else, which is the only escape hatch and costs stamina you wanted for the next swing |
| What is drawn vs what is dangerous | **Different questions.** The hitbox is the active window; the arc on screen outlives it and fades. At 45° the active window is an eighth of a second and the character is forty pixels tall — a visual that lasted exactly as long as the hitbox would not be seen |
| Character physics | **Solved from the budget, not tuned.** Run speed and the jump's height are the chosen numbers; gravity, jump speed and airtime follow from them so that a jump clears exactly `MOVE.jump` and no more. A jump that quietly cleared more would stop canyons being obstacles, and nobody would notice for months |

### Combat numbers, the targets (interview 2026-10-06, #9)

These are targets to tune toward, not constants. The numbers in `combat.mjs`, `enemy.mjs`,
`reel.mjs` and `lattice.mjs` stay placeholders until the tuning issue lands them.

| Decision | Choice |
| --- | --- |
| One machine against a careful player | **Forgiving: about eight hits to kill you.** A lone machine is a puzzle you win; danger comes from groups, terrain and mistakes stacking. Placeholder today is six (sentry 18 against 100) |
| Groups | **The real fights.** A pack of three is much harder than three singles, because they flank and overlap tells (#110). Singles are the warm-up. A second player still adds a member and a little health, never damage (§6) |
| Fight length | **Mixed by archetype.** Hounds die fast, the sentry is a slow wall, the mortar sits between. The roster sets the pace, not one rule. Today: sentry 3 swings, mortar 2, hound 2 |
| Stamina | **Rarely empty.** A few swings and a dodge before you wait; it stops button-mashing and is never the thing you manage. Modules that cut cost are a smaller win than ones that add reach or damage |
| Module power | **Noticeable, about +25% per module.** You feel the first one, and a full line or lattice roughly doubles you. Fusion stays the larger step |
| The Reel against the blade | **Utility, not damage.** The Reel's yank and arrival strike are worth a third to a half of a blade swing; it earns its slot by moving things and you. The blade stays the killer |
| Recovery | **Regen when nothing is hunting you, and a partner revive.** Health refills slowly out of combat, which keeps a long streamed world playable with no heal item. Spoils do not heal |
| Death | **Downed; the partner stands you up** (§2 already decides this). If both fall, respawn at the last landmark and your carried modules stay where you fell |

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

### The first frame, specified

One of eight, taken to the level the sockets need, because the prototype needed something to
seat modules in. The other seven are not built, in the same way eleven of the twelve enemy
archetypes are not.

**Warden frame** — the longblade's. Four sockets in a rhombus: two triangles sharing an edge,
which is **five edges between four cells**. The two ends of the long diagonal touch two
neighbours each and never each other, so where a module goes is always a question.

**Nine modules**, three per tradition. Tech: governor (stamina), servo (recovery), plating
(hit points). Magic: keening edge (damage), lengthening sigil (reach), blink rune (dodge).
Biological: sinew (run speed), thewed cord (swing cost), bloom (regeneration).

**Six fusions**, two per pair of traditions, each along a shared edge: regulated edge, slipdrive,
ironthew, reaching vine, deep well, bloodedge.

Three rules came out of building it, and every later frame inherits them:

- **Only across traditions.** Two tech modules side by side do nothing extra, however good each
  one is. This is §1 made mechanical: the three schools never combined, so combining them is the
  only thing that is new.
- **A machine drops its own discipline**, which §6 already said — but the consequence only shows
  up once fusion exists. Every machine in the prototype is tech, so *fighting alone can never
  give you two traditions*. The lattice cannot be filled by combat. That is what turns the
  landmark on the horizon into somewhere you have to go.
- **Knowledge is the scarce half, not the modules.** An adjacency you have no recipe for is
  inert. Caches hold a module *and* a recipe, and the recipes in one world walk the list from a
  seed-dependent start, so four caches teach four different fusions: a second copy of something
  you already know is not a reason to cross a valley.

None of the numbers are balance, on exactly the terms §3's combat numbers are not: #9 decides
what a hit is worth and what a module is worth at the same time.

### The second frame, the Reel (interview 2026-10-05)

Asked for because one sword makes every fight the same fight, and the roster (§6) now asks things
a sword answers badly: a mortar that holds a firing band 7–11 m off, hounds that flank from both
sides. The second frame is the **reach** one, and it is built to change how you *move*, not only
what you hit.

**Reel frame** — the tether's. **Five cells in a line**: four edges, the two ends touching one
neighbour each and the three inside touching two. Next to the rhombus it is thin and ordered, where
the rhombus is cramped and cross-wired: fewer fusions per module, and the order you lay a line in
is the question.

**The Reel** — hold to aim, and a line is drawn on the ground; release and a barbed tether flies
up to 9 m along it.

| Hits | What happens |
| --- | --- |
| A **light** target (a hound, most wildlife) | It is hauled to you and staggered. A lunge you stepped out of becomes a hound at your feet |
| A **heavy** target (a sentry, a mortar) | The tether anchors and you are hauled to it, ending in a short strike. The answer to a mortar's range, and a way into a sentry's recovery from outside its reach |
| Open ground or a prop | You are hauled there as a dash: a repositioning verb |

**Weight is a property of the archetype**, not a number the tether compares. A haul is a dash along
the ground through the same controller everything else uses, so **it stops at a ledge and never
crosses a gap**: the movement budget (§3) is untouched, and no module can make the Reel a way over
a canyon.

| Decision | Choice |
| --- | --- |
| Carrying | **Two frames at once**, each with its own lattice |
| Switching | **The scroll wheel** (unbound until now; zoom stays on its buttons), and **an on-screen button** for touch. Swapping is instant but not free of the committed rule: not during a swing or a dodge |
| Modules | **One shared pool** across frames; each frame's layout decides which fusions are possible there. Knowing a recipe is per fusion, not per frame |
| What a frame changes | **Only the attack.** Dodge, the jump and stamina stay universal (§3); a frame is a weapon, not a class |
| Aim | **A player's own aimed attacks show a short line on the ground while aiming**, so a partner reads them the way anyone reads an enemy's. §6's rule applied to the players: danger is on the ground before it lands |
| Friendly | A tether never hauls, hurts or anchors to a partner |

Still open here, and for the build to settle against #9: the numbers (reach, stamina, cooldown, how
long a miss takes to retract), whether a tether can be cut by anything, and what a haul that is
interrupted by a hit does.

## 5. World and terrain

**Four natural biomes**, in the climate field: Meadowlands · Redrock Mesa · Cloudpine
Highlands · Thornwood. (Boreal Fen and Frostmoor are dropped — they overlapped their scar
counterparts and wasted contrast.) **Marshes stay, as a place rather than a biome** (#102): low,
flat, wet ground in Meadowlands and Thornwood breaks into wadeable standing water half a metre
deep between grassy hummocks, one level per marsh, crossed on stepping stones or a deck where a
route meets it. Sporeverge's slow water is its bog.

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
| Canyons | **Gorges, not trenches.** Vertical walls 5–8 m deep and 6–10 m wide — no jump climbs out and none crosses. In and out by breaches every 40–60 m and at the ends, across by bridge or arch where a trail meets one, or down where the drop is survivable. Floors are dry washes; a stream only where a river happens to cross |
| Biome traversal features | **Each biome has one way the ground stands in your way.** Redrock Mesa: mesas, tables with sheer 4–6 m sides reached by stepping-stone routes of 1 m rises. Cloudpine: cliff bands climbed by ledge lines. Thornwood: thickets with fallen-log shortcuts. Ashfall: basalt column fields over magma. Rimewaste: ice and crevasses. Sporeverge: fungal towers of shelf steps. Glasslands: shard fields crossed on vitrified plates. Meadowlands: low walls and hedges. A feature counts as traversable only if the reach pass finds a route under the movement budget; the generator adds stones or breaches until it does |
| Seeing into the ground | **A cutaway around each player, and silhouettes through the rest.** Terrain and props in front of a player and above their head are cut away inside a dithered oval, cut faces shown dark; players, machines and loot are drawn as silhouettes wherever they are hidden. Shadows are cast by the whole world. Deep ground is not playable without it |
| Materials | Full material ids driving audio, carve hardness, flammability, conduction, friction, emission |
| Weather | Full day/night and weather; rain wets materials, snow accumulates, fog for distance. **A storm is the sky's too** (#102): some rain carries lightning, struck by the seed and the second so both players see the same flash. What a storm makes of a biome is that biome's — thunder over green ground, ash in the burn, dust on the mesa, a blizzard in the rime. Display only: nothing in the simulation reads it yet |
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

### The roster (#6, interview 2026-09-30)

Twelve archetypes, **four per source**: four war machines (the sentry, plus one more tech, one
magic and one biological), **one scar-born per scar**, and **one wildlife per natural biome**.
Every place has a signature enemy, and a scar's creature carries that scar's hazard into the
fight.

| Decision | Choice |
| --- | --- |
| Encounters | **Mixed small groups** of two to four, whose roles combine: one pins you while another hits hard. Machines still hold posts (#42's affordances); wildlife roams its ground. Two players can split a group, which is what co-op buys in a fight |
| Ranged attacks | **Only ground-marked.** Anything that hits at range marks the ground first: a lobbed shot shows where it lands, a beam shows its line. From above you always see where danger will be. No free-flying projectiles |
| Factions | **The sources fight each other.** Rival traditions' machines attack each other on sight; wildlife flees machines and scar-born. Players can lure one into another. The war is still going |
| Co-op | **Better with two, never required.** Some archetypes are easier with a partner (the rime stalker freezes while someone faces it; a warden's dome can be contested from both sides), and every one is beatable alone |
| Party scaling | **Both, a little.** A second player adds one member to a group and gives enemies somewhat more health; damage is unchanged, so a tell reads the same alone or together. The exact numbers belong to #9 |
| Drops | War machines drop their tradition's **modules** (a fight previews its loot). Scar-born carry **fusion recipe fragments**, which is how fusion knowledge is learned from the world. Wildlife drops **trade goods** holdouts buy, the first use for materials without crafting (tension 5) |

Every archetype inherits the sentry's rule: **the tell goes on the surface the camera can see.**

**War machines**

| Archetype | Role | What it does | What tells you | What you do about it |
| --- | --- | --- | --- | --- |
| **Sentry automaton** (tech) | Bruiser | Holds a post, closes, strikes | Stops dead, rises, top plate flares, wedge on the ground | Dodge through; its recovery outlasts your whole swing (built, #24) |
| **Mortar crawler** (tech) | Artillery | Low, spider-legged; lobs shells over the group from range | The barrel plate glows and landing rings appear on the ground | Leave the rings, then rush it: after a volley it vents, top vents open, and it is weak up close. Walks, cannot jump |
| **Warden obelisk** (magic) | Holds ground | A hovering carved stone. Its dome protects **whoever stands inside it** — machines of any tradition, wildlife, and players | The crown runes light in sequence, then a ring pulses out along the ground | Jump or dodge the ring. The dome drops while it pulses, so strike then. It floats, so it crosses water and gaps you cannot. A fight around a warden is a fight over who stands in its dome (built, #6: it does not move, the dome shields anything inside it from every blow, a ring that jumping clears runs out when it drops; the numbers are placeholders for #9, and it does not yet cross water) |
| **Grafted hounds** (biological) | Flankers, always two | Low fast beasts that circle and lunge | Back spines rise and a lunge line is drawn on the ground | Step off the line: an overshot lunge leaves it stumbling. Jumps 1 m faces like you, cannot swim |

**Scar-born**, one per scar, each carrying its scar's hazard

| Archetype | What it does | What tells you | What you do about it |
| --- | --- | --- | --- |
| **Cinder crawler** (Ashfall) | Surfaces from magma seams and leaves a burning trail | The crust on its back cracks and glows; an eruption circle on the ground | Keep off the trail. After a dive it resurfaces cooled and brittle, which is the time to hit it |
| **Rime stalker** (Rimewaste) | A figure frozen mid-motion that moves **only while no player faces it**; its presence drains stamina | Frost creeps along the ground toward where it will strike | Face it to hold it still. With two, one watches while the other closes; alone, you advance facing it |
| **Spore bloater** (Sporeverge) | Slow fungal mass that swells and bursts into an infection cloud | Its cap swells and its gills glow; a burst circle on the ground | Back out of the circle; after bursting it is deflated and still |
| **Prism shard** (Glasslands) | Crystal that turns sunlight into lines of light | Facets on its top align and brighten; the lines are drawn on the ground first | Step off the lines. It is fragile and shatters into a ring of shards when broken, so don't stand close for the last hit |

**Wildlife**, one per natural biome, territorial rather than hunting, each using its biome's
traversal feature

| Archetype | What it does | What tells you | What you do about it |
| --- | --- | --- | --- |
| **Tusk boar** (Meadowlands) | Herds; charges anyone near its young | Paws the ground; a charge lane is drawn on the ground | Step out of the lane; it skids to a stop after a miss |
| **Cliff raptor** (Redrock Mesa) | Nests on mesa tops and dives at anyone climbing | Its shadow circles, then shrinks to where it will land (a natural top-down tell) | Move off the shrinking shadow; it lands exposed |
| **Ridge ram** (Cloudpine) | Holds the ledge lines and butts you back and off them | Lowers its head; a short push line on the ground | The danger is the fall, not the hit: keep your back off the edge |
| **Thorn lurker** (Thornwood) | Hides in thickets, lashes out and drags you in | The thicket shakes and parts along the lash line | Step off the line; while it drags it is exposed |

**Build order:** the mortar crawler and the grafted hounds first. With the sentry they make the
first mixed tech group (bruiser plus artillery), and tech against biological puts the faction
rule on screen at once.

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

### The set-piece grammar, the shape (interview 2026-10-06, #7)

What a weapon site is, before what it is made of. The part lists, the assembly rules and the
arena are still to decide (below).

| Decision | Choice |
| --- | --- |
| Scale | **A long set-piece, about 20 to 30 minutes in one sitting**, from the first step of the approach to the core going dark. The place the forty hours were for, not a boss room and not a dungeon |
| Approach | **A route of escalating encounters in the scar.** The tradition's machine groups get denser and mix archetypes as the site nears, and the scar's own terrain features and hazards get harder. The groups, packs and traversal features already built do the work; the grammar chooses and orders them |
| Gate | **A requirement you carry: a fusion that crosses into the site's tradition.** Any seated fusion that includes that school opens it, on either frame. Tech: regulated edge, slipdrive, ironthew, deep well. Magic: regulated edge, slipdrive, reaching vine, bloodedge. Biological: ironthew, reaching vine, deep well, bloodedge. The gate shows a glyph for the pairs that would work and the approach's drops lean toward them, so there is always a way in. The lattice is the gate, which ties the climax to progression |
| Guardian | **Entirely new moves per tradition, authored,** with conventional telegraphs, openings and positioning (§6 above). Not assembled from the roster's verbs |
| What varies by seed | **The setting and which moves.** Each tradition authors a pool of about six guardian moves; the seed picks four and their phase order, and shapes the approach and the arena round them. Two seeds give two fights of the same family |
| Core | **Hold it while it shuts down, defended.** About two minutes standing at the core while the site throws its machines at you in waves. A partner guards while the other holds; alone you do both, so the wave scales to party size |
| Failure | **Progress holds, the guardian heals.** A wipe respawns you at the last landmark; the gate stays open and the cleared approach stays cleared, but the guardian returns at full health. A wipe costs the walk back and the fight, never the whole site |
| Finding a site | **Visible from afar, and the holdouts point.** The furnace's vent plume, the engine's frozen eye and the core's glow are landmarks across the scar, and the holdouts say which way. No marker, journal or map |
| When one goes down | **That scar calms, and the others press harder.** Haze clears and its machines go dormant; the two remaining sites lose a check, so their scars grow harsher. It builds the pressure toward the glasslands and makes the order you choose matter |

**The arena, the climb and the consequence (second round, same day).**

| Decision | Choice |
| --- | --- |
| Arena boundary | **A bowl you are held in until it ends.** Walls or terrain close it once the guardian wakes, so the fight is a place and not a chase. The way out is winning or a wipe |
| What the terrain does | **It changes with the phases, by tradition.** Each tradition's arena has its own hazard that the guardian's phases move: vents and magma rising in the furnace, ice closing in the engine, spores thickening in the core. You reposition with the jump, the dodge and the Reel. The fight is partly the room |
| Guardian scale | **A big mobile machine, about three or four sentries wide** (four to five metres across). It walks the arena floor, reads at a distance in the isometric view, and leaves room to move |
| Phases | **Four phases, a move each as health falls.** It opens with one move and each quarter of its health unlocks the next; earlier moves stay in play and layer up. The seed's order is the fight's story |
| Guardian look | **Left to the art pass.** Recorded: what it does and how big it is. How it looks is decided when the model is made |
| The approach's shape | **Three escalating beats with a breather between.** A first beat of groups, a second that mixes archetypes and brings the scar's harder terrain, a third that is the heaviest, with a short quiet stretch after each so the climb has a shape and the party can recover |
| "Harsher" | **Turn up what already exists.** The remaining scars' fields spread and strengthen: more haze, stronger weather, hazards on more of the ground, denser and mixed machine groups. It reuses the scar and weather systems and is measurable in the gate |
| The last landmark | **A holding, or a rest point at the foot of a site's approach once you have walked up to it.** A wipe at the core costs the walk back up and not across the world. No rest point inside a site |

**Footprint, parts, moves and co-op (third round, same day).**

| Decision | Choice |
| --- | --- |
| Footprint | **About 300 to 400 m from the foot of the approach to the core**, roughly ten chunks, with the arena bowl about 40 m across at the far end. Bigger than the 64 m region the generator decides things in today, so a site is a larger unit than any it has made |
| What a part is | **Shaped terrain plus stamped dressing.** The generator carves and grades the terrain itself (the climb, the gate cut, the arena bowl, the core dais) and places stamps and props for the walls, the vents and the glyph. Terrain parts carry the gameplay, stamps carry the look |
| Guardian move pools | **About six a tradition, and every pool holds each of four kinds:** a melee slam or sweep, a ranged volley, area denial or moving the tradition's hazard, and summons. The seed picks four, so a fight always has a close threat, a far one, a shrinking floor and a crowd, in an order the seed chose |
| Co-op | **Some moves split attention between the players.** Alone it targets you; with two, certain moves go to each player separately or need both answered at once. Health scales a little and damage not at all, as for every machine (§6) |

**The guardians' signatures (fourth round, same day).** What each is remembered by. The six
moves of each pool are to be written round these, one in each of the four kinds (slam or sweep,
volley, area denial or hazard, summons).

| Tradition | Guardian | Signature |
| --- | --- | --- |
| Tech | The furnace's warden, in the ashfall | **Pressure: it builds, then vents.** A great pistoned machine whose slams and slag volleys quicken through the four phases. Each big move ends in a long venting opening, the sentry's recovery at scale, which a well-timed dodge turns into a free hit |
| Magic | The rime engine's warden, in the rimewaste | **A closing winter.** A carved stone figure that drives the cold in: frost creeps along the ground toward where it will strike, ice walls close the bowl, and your stamina drains in the cold. The fight is about staying warm in the right places |
| Biological | The spore core's warden, in the sporeverge | **Bloom and infection.** A grown thing that swells and bursts: spore clouds that infect over time, caps that swell with a circle on the ground. You manage infection as well as hits, which is the scar's own hazard turned up |
| Split move (all three) | A move that splits attention between players | **It marks both and strikes each on its own clock.** Two tells appear at once, one on each player, with different timings, so each of you dodges your own while watching your partner's. Alone you get only your own mark, and the fight stays readable |

**The guardian's pacing (fifth round, same day).**

| Decision | Choice |
| --- | --- |
| Fight length | **About five minutes,** from the gate opening to the guardian down. Around a quarter of the site; the approach and the core's last wave carry the rest |
| Big hit | **A quarter of your health: four hits.** Its heavy moves (the slam, the volley's centre) take about 25 against your 100, clearly deadlier than a sentry's 13, while its ordinary hits stay near a sentry's |
| Phase change | **A short beat that changes the arena.** At each quarter of its health the guardian stops for two or three seconds, untouchable, and the arena shifts: the hazard advances and the next move is shown. A breath, a marker of progress, and a place to revive |
| Summons | **A few of its tradition's roster, capped.** Two or three machines of its own school at a time, never more than three alive at once, and none while its recovery is open: a crowd to handle, never a flood |

*A starting number, derived and not decided.* Five minutes against about nine damage a second a
player (a 20-damage swing every 0.77 s at roughly a third uptime, the rest spent dodging and
repositioning) is about 2,000 health for a guardian met by one player with a couple of modules,
500 a phase. A second player adds the usual 15% and fights faster, because their damage adds
and the guardian's does not (§6). It is to be measured and tuned by playing it, not argued.

**Draft part lists: a proposal derived from the answers above, not decided.** The issue's "done
when" asks for part lists and assembly rules; this is the first pass to react to. Each stage is
terrain the generator carves, then stamps and props over it.

| Stage | Terrain parts | Dressing | Seeded choices |
| --- | --- | --- | --- |
| Approach | A graded climb of three beats and two breathers (level terraces); encounter pads where the groups stand; patches of the scar's hazard | The landmark seen from afar; ruined plating, ribs or growth along the way; a rest stone at the foot | Route line; how many groups each beat; which packs (`PACKS`); where the hazard patches fall |
| Gate | A cut through the bowl's rim, one door wide | A sealed door with the glyph of the four pairs that open it | Door style within the tradition; where in the rim |
| Arena | A bowl about 40 m across with a rim wall of 3 m or more; two to four raised footholds; a floor the hazard can fill | The hazard's source (vents, an engine, a bloom); props for the rim | Bowl shape; foothold count and place; which four moves, and their order |
| Core | A dais at the far side, sealed until the guardian is down; breaches where the last wave comes from | The core itself, lit; its shutdown glow | Dais height; breach count (scaled to party size) |

| Tradition | Site, in its scar | The hazard the arena moves | Reads as |
| --- | --- | --- | --- |
| Tech | The furnace, in the ashfall's basalt | Vents and magma rising across the floor (the scar's burn and smoke) | Plate, pipe and heat |
| Magic | The rime engine, in the rimewaste | Ice closing in and the cold draining stamina (the scar's chill) | Carved stone and frost |
| Biological | The spore core, in the sporeverge | Spores thickening and infecting (the scar's bloom) | Bone, vine and fungus |

**The risk this takes on, written down.** A fusion gate can stall a player who has not found a
recipe or the two modules it needs. Four recipes satisfy each gate, the approach's drops lean
toward them, and the glyph says which pairs work; whether that is enough is a thing to find out
by playing it, not by arguing it.

**Sketch of one site, derived only from the above, to react to.** The tech furnace: the vent
plume is seen from the ashfall's edge; holdouts say it is a day's walk. The approach is a long
climb through basalt where sentry and mortar groups thicken into mixed packs and the magma
causeways run longer. The gate is a sealed vent door whose glyph names the tech pairs; with a
fusion seated it opens. The arena is the furnace floor, where a guardian with four of the tech
pool's moves, in an order the seed picked, is fought conventionally. The core is behind it:
two minutes at the vent while the furnace sends everything it has left. The ashfall quiets, and
the rime and the spore bloom grow harsher.

### Build order after the first set-piece (proposal, 2026-10-08 — not an interview)

Recorded as a **proposal to be argued with**, not a decision: it is an ordering of work, drawn
from what depends on what, and the first thing it asks for is a person's verdict.

Where things stand: the furnace is playable end to end (#116–#120) — three of twelve
archetypes (sentry, mortar, hound), two of eight frames (the Warden and the Reel), and no
magic war machine at all, so magic modules come only from caches.

What depends on what:

- The furnace's gate wants a seated tech fusion, and a fusion needs modules of two schools. A
  machine drops its own school's modules (§6), so the loop that feeds a gate needs machines
  from the other schools.
- A set-piece's approach and summons draw on its own tradition's roster; the other two sites
  will be thin with only the tech and biological machines.
- Scar-born creatures carry the fusion recipe fragments, which is how recipes are learned from
  the world and not only found in caches. They belong with a scar's harder terrain and with the
  other scars pressing harder when a weapon goes dark.
- Wildlife drops trade goods, which have no use until the holdout traders exist, and those are
  deferred.

The order proposed:

1. **Play the furnace.** Nobody has. Its numbers (the guardian's ~2,000 health, the beats'
   group counts, the two-minute core) are first values, and everything built next stands on
   them.
2. **The magic war machine**, and the other war machines as the sites need them, so all three
   schools can drop and the second site has something to be built from.
3. **The second set-piece**, with its scar-born creature and the scar-hardening work. A second
   one shows which parts of the grammar generalise and which were the furnace's alone.
4. **New frames, roughly one per set-piece**, each with the modules and fusions it needs; a
   cleared site is a natural place for one to be found. (This pairing is a suggestion.)
5. **Wildlife last**, once there is somewhere to trade what it drops.

The roster (§6) and the frames (§4) stay as decided; this is only when. Revisit it after step 1.

---

## 7. Technical

| Decision | Choice |
| --- | --- |
| Terrain rendering | Greedy-meshed chunks with baked per-face AO; props stay instanced |
| Netcode | Host-authoritative peer-to-peer over Steam Networking |
| Browser transport | **A WebRTC data channel**, joined by copy-paste codes with no server: the host's invite, the guest's reply. The browser build is the test harness, and this is how it plays between two homes before there is a Steam build. It sits behind the same three-method transport as Steam will, and everything above that — ordering, loss, a partner going quiet — is the session's, so Steam later is an adapter, not a rewrite. No TURN relay: a pair whose networks refuse a direct link cannot play in the browser (#95) |
| Client model | **The guest predicts and reconciles.** It applies its own input immediately, and on each authoritative snapshot restores the host's state wholesale and replays every input the host had not yet seen. The replay lands on the host's answer *exactly*, not near it, because the controller is deterministic — which is what the pinned arithmetic was for |
| What crosses the wire | **A seed and two characters.** The world is a pure function of its seed, so terrain is never sent; later, edits, enemies and loot are deltas against something both ends already have |
| What crosses for loot | **One integer.** Caches are derived from the world, which both machines grew from the same seed, and a machine's spoil lies where that machine fell — which the guest is already told. So all that is left to send is a bitmask of what has been picked up. Gear is the exception: a lattice is derivable from nothing, and `step` reads it, so it rides the snapshot |
| Gear is not an input | Inputs are replayed after a correction, and "seat the module I am carrying in slot 2" is not idempotent. Socketing goes as its own message, applied by the host exactly once; the snapshot is the answer. A menu click can afford the round trip |
| Save ownership | **Shared world, host only** — accepted deliberately. One world, one save, one owner; the pair plays together or not at all |
| Platform | Steam desktop first, wrapped (Electron or Tauri); browser build is a test harness |
| Art pipeline | Hybrid — hand-authored `.vox` for characters, creatures and hero structures; trees, boulders, walls and clutter stay procedural |
| What a window decides | **Nothing larger than itself, and nothing about its own edge.** Sites, the trail between them, its grading, its crossings, the landmark and where the lamps stand are decided per **region** (64 m, keyed on world coordinates) and a window reports what falls inside it. A window is a view, not an authority. It is still wrong within **4 m** of its own rim, because a stamp reaches past its anchor and reads a surface that clamps there — a measured number, and the skirt streaming has to generate and discard |
| Generator randomness | **Positional, everywhere.** A stream's nth value depends on n, so a pass that walks a window draws differently than the same pass walking a window offset by a chunk — the same square metre, a different answer. Erosion was the case that mattered first, because routes are chosen over the heights it produces; the rest followed. There is no ordered stream left in `src/gen`, and a pass that wants one is a pass that has not said what place its answer belongs to |
| Generator arithmetic | **Only operations the spec pins exactly.** `Math.sin`, `cos`, `exp`, `pow` and `hypot` are implementation-approximated and differ between engine versions; `src/gen/exact.mjs` replaces them. A seed has to grow the same world on both players' machines, and in the tooling that measures it |

## 8. Presentation

| Decision | Choice |
| --- | --- |
| Camera | **Orthographic 45°, following one player, snapping in quarter turns** — the plate's view, made to follow. Movement is camera-relative, so a snap turns the world and not the controls |
| HUD | Classic — bars, cooldowns, fusion states, partner status |
| Audio | Material-driven and sparse: footsteps, impacts and carving read off the voxel material; wind drives ambience; music is rare and marks moments |

---

## Still open

- The other six frames, and the rest of the modules and fusions. Nine and six are what one
  frame needed; the set is not closed. The Reel (§4) is the second.
- Refinement, and the stash. Carried slots are limited and there is nowhere to put the overflow,
  because there is no camp.
- Each archetype's actual numbers (health, damage, timings, ranges) — #9. The targets are
  decided (§3, 2026-10-06); landing them is the tuning issue. The roster, tells and counters
  are decided (§6, #6).
- What the glasslands releases once all three weapons are down.
- The set-piece grammar's parts — what an approach, a gate, an arena and a core are made of
  and how each tradition's parts differ. Their shape is decided (§6, 2026-10-06, two rounds);
  the guardian moves themselves (their signatures are decided), the assembly rules and the numbers (how many machines a beat,
  how fast an arena closes, how large a core wave) are not, and the part lists above are a draft.
- Quest and objective plumbing (minimal, given the drive is self-evident).
- Damage types, status stacking rules, and the exact regen delay and revive time.
- Accessibility.

## Tensions to resolve

1. **Two aiming models, one ability set.** Mouse free-aim gives a point; twin-stick gives a
   direction. Ground-targeted abilities — the censer's fields, the tuning stake — need a
   placement rule that is fair on both: likely "cast at a fixed range along the aim direction,
   with the mouse setting the point directly".

2. **Repopulation versus claiming.** Everything returns over days, but claimed holdings are
   supposed to be yours and anchor the persistence radius. Claimed sites need an exemption, or
   a weaker repopulation, or claiming means nothing.

3. ~~**"Eight biomes" is four biomes and four overlays.**~~ Resolved (#3). The generator has a
   climate field with four anchors and an independent scar field that paints four overlays over
   them; the plate's chart shows four anchors and lists the scars as overlays.

4. **Party scaling does not cover environmental danger.** Scars are still running, so their
   hazards are environmental rather than enemies. Scaling to party size does nothing for them —
   which may be correct (the map is the difficulty curve) but should be deliberate.

5. **Materials without crafting.** Materials serve audio, carving, fire and conduction only.
   Coherent, but harvesting has no purpose unless crafting returns.

6. **A calmed scar versus repopulation.** Shutting a weapon down makes its scar's machines go
   dormant (§6, 2026-10-06), but everything repopulates over days (§2). A calmed scar needs an
   exemption from repopulation, or the weapon's shutdown means nothing a day later. It is the
   same shape as tension 2, and the answer may be the same one.

## What the current concept plate contradicts

`docs/concept/index.html` predates most of this. The biome set, the climate chart and the
missing Cloudpine Highlands and Thornwood were reconciled by #3. It is still wrong in three
places: it renders caves as though they mattered; it describes voxels as carrying colour only;
and it draws instanced boxes rather than meshed chunks.

The generator's *structure* is unaffected — chunking, whole-metre features, the detail pass,
trails, reach, erosion, the water table, accumulation, the wind field and destructibility all
stand.
