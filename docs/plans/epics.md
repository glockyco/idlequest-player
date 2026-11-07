# Epic quests for the roster

The 1.0 class epics for every roster class: whether IdleQuest implements them, what each step needs and where it comes from, which pieces the party meets while leveling from 23 to 46, and which epics are worth the effort. The Magician's epic is in [magician-epic.md](magician-epic.md) and appears here only where this plan adds to it. Zone rotation is in [leveling-plan.md](leveling-plan.md), the roster in [raid-roster.md](raid-roster.md).

This is a content-backed plan. No chain was played in the running game. Minutes are estimates from spawn arithmetic, not measurements.

## Evidence labels

Each row names its evidence with these labels. A claim with only `inf` is reasoning, not an observation.

- `Q`: the quest script the server runs, `C/effective/quests/<zone>/<npc>.lua`. A step counts as implemented only if its script exists there. `C` is `~/src/github.com/brynnb/idlequest-content`.
- `S`: the snapshot, `C/data/*.ndjson` (items, npc_types, spawn2, spawnentry, loot tables, merchantlist, ground_spawns, tradeskill recipes, spells_new, zone). Spawn percent is the chance that one respawn of a spawn point yields that NPC. Drop percent is per kill. The snapshot ignores content flags, so a source can still be missing in the live game. Only zones with `expansion` 2 or lower count, and spawn rows with `min_expansion` above 2 are treated as absent.
- `T`: server tests and audit notes in `C/reference/` (`reference/server/internal/quest/*_test.go`, `reference/docs/quest-audit-review-notes.md`, `quest-ui-verification-status.md`, `content_exclusions.json`).
- `W`: the IdleQuest wiki text (`/tmp/iq-wiki.js`, `.re/wiki-loot.txt`).
- `K`: the client, `.re/js/*.pretty.js`.
- `P99`: a classic EverQuest guide in `C/reference/p99-wiki/raw-pages/`, used as a map only.
- `inf`: inference.

Zone names are short names. Zones named `freeporteast`, `freeportwest`, `highpasshold`, `oceanoftears`, `steamfontmts` and similar are later-era copies. The classic copies `freporte`, `freportw`, `highpass`, `oot` and `steamfont` are the ones used.

## Rules that hold for every epic

1. All thirteen 1.0 epics have a script for every NPC step (`Q`). Two kinds of gap remain. The Druid's four foraged items and the Rose of Firiona have no source in the snapshot, and the Rogue and the Monk have spawn blockers listed in their sections (`S`). The 1.5 and 2.0 continuations need zones or items that the Velious-era snapshot lacks and are out of scope (`Q`, `S`).
2. No 1.0 script checks the player's level. The wiki says epic steps can be completed at any level, and the server policy records the same (`W` overview, `T` `content_exclusions.json`). Real limits are zone minimums (Plane of Hate, Plane of Fear and Plane of Sky need level 46 in `S`) and mob strength.
3. Quest-only faction checks always pass (`W` overview, `T` `faction_policy.go`: `GetFaction` returns Ally and `GetCharacterFactionLevel` returns the maximum). Class, item and quest-flag checks still apply.
4. Only the active (logged-in) character hands items in. The Give window offers the active character's inventory slots to the targeted NPC (`K` `engine.pretty.js` `QGe`: `characterProfile.inventory`, NPC id, current zone). A companion cannot hand in. Hostile actors that a hand-in spawns attack the hand-in character (`Q`, for example Rak, Lhranc, the Necromancer's golem).
5. Almost every epic piece is NO DROP. The client treats `nodrop === 0` as NO DROP (`K` `main.pretty.js:15989`, `engine.pretty.js:18813`). Tradable pieces (`nodrop` 1) are named in each class section.
6. Almost every piece is LORE. The client shows LORE for any `loregroup` other than 0 and blocks a second copy of the same item (`K` `engine.pretty.js:18811`, `main.pretty.js:22414-22430`). No item name starts with an asterisk, so `loregroup` is the only marker. Lore conflicts include banked items (`W`).
7. A companion can hold a piece only through Give Held Item. The wiki says NO DROP items may be given between characters of one account. The recipient must be offline and not recruited, and a lore conflict rejects the transfer (`W` companions). Auto hand-downs cover looted equipment upgrades only, so a quest piece stays with the active character that looted it (`W`).
8. Hand-in scripts with no class check accept the hand-in from any leader, and `SummonItem` puts the reward into that leader's inventory (`Q`). A Magician leader could therefore run the class-free steps of another class and give the finished item on. Whether the server refuses a class-locked reward for another class is untested (`inf`). Class-gated steps are listed per class below.
9. Options > General > Keep Epic Quest Items (on by default) protects epic items, intermediates and ingredients for all fourteen classes from selling and decluttering, including duplicates and items held for another class (`W`).
10. Hand-in XP is large and goes only to the hand-in character, for example Kargek 1,000,000 and Jeb Lumsed 1,500,000 (`Q`). A level at 30 costs about 2.7M. Whether IdleQuest caps `AddEXP` is unknown.
11. Several quest NPCs and bosses have no static spawn because a script spawns them (`Q`). A spawn group with a sole entry at weight 0 (the seven Kithicor aides, Echo of Nortlav) appears in the snapshot, but whether the server spawns it is not visible. `tools/drops.mjs` counts it as spawning. `leveling-plan.md` treats zero weight as unsupported. This plan does not count such sources.

## Summary by class

"Rotation" means a zone in the leveling-plan rotation for that band. "Late" means a step the party cannot reasonably do before level 50 (NPC level 55 or higher, hp 25,000 or more, or a respawn of 12 hours or more). Class sections below give each step.

| Class | Epic (item id) | In IdleQuest | Hand-in class gate | Pieces in rotation zones, 23 to 46 | Late steps | Effort | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Warrior | Jagged Blade of War (10908) | Yes. Combine in Red Scabbard, recipe 9834. Do not use Gartrog (summons absent item 66175) | Kargek and Wenden answer only a Warrior in dialogue. Hand-ins open | Heart of Frost (permafrost, 22 to 25) | Red and Green Dragon Scales, Hand of the Maestro, Spiroc Wingblade, Ball of Everliving Golem, Ancient Blade (six raid kills) | Very high | `Q` `S` `T` |
| Cleric | Water Sprinkler of Nem Ankh (5532) | Yes, 10 scripts, no class or level check | None | Lord Gimblox's Signet Ring (soldunga, 27 to 33) | Ixiblat Fer L62, Overking Bathezid L65, Zordak L60 and Zordakalicus L54, plasmatic priest L55. All script-spawned except Bathezid | Very high | `Q` `S` `T` `W` |
| Bard | Singing Short Sword (20542) | Yes, 13 scripts | None | Mechanical Doll hand-in (soldunga), Serra hand-in (Unrest pass) | Phinigel, Amygdalan, Drolvarg Warlord, two dragon scales, Undead Bard then Trakanon L65 | Very high | `Q` `S` |
| Shaman | Spear of Fate (10651) | Yes. The last script needs only an Iksar Scale | None | None | Lord Rak L54 (or Child's Tear from Fear golems) | High | `Q` `S` |
| Enchanter | Staff of the Serpent (10650) | Yes, no class or level check | None | Lost Scroll (dalnir), spectral librarian charm (kaesora) | Prince Selrach L61, Vessel Drozlin, Verina Tomb, Wraith of a Shissar, Tangrin, Thrackin L55 | Very high | `Q` `S` `T` |
| Rogue | Ragebringer (11057) | Yes, with spawn blockers (Anson, Kithicor aides) | Anson needs a Rogue | None | Renux L51, General V`ghera L65, Book of Souls in Hate | High | `Q` `S` `T` |
| Monk | Celestial Fists (10652) | Yes. 36224 is not given by any script | Monk check at seven NPCs | None | Eejag, Gwan, Trunt, Vorash, Xenevorash L65, Robe of the Whistling Fists sub-quest | Very high | `Q` `S` `T` |
| Druid | Nature Walkers Scimitar (20490) | Scripts yes. Five ingredients have no source in the snapshot | None | None (Antonica spirit set is errands) | Venril Sathir, Faydedar, Ulump Pujluk, many L46 to 55 corrupted fights | Very high | `Q` `S` `T` |
| Necromancer | Scythe of the Shadowed Soul (20544) | Yes, Plane of Sky parts simplified | None (dialogue only) | None | Silver Disc, Spiroc Feathers, Cape (Sky), Eye (Hate), Slime Blood (Fear) | Very high | `Q` `S` `T` |
| Paladin | Fiery Defender (10099) | Yes, every step scripted | Only the peasant woman | Ghoulbane (guktop), Brother Hayle hand-in (paw) | Keeper of the Tombs, Kirak Vil, dragon-dropped book halves, Miragul L53, Plane of Hate banshee | Very high | `Q` `S` `T` |
| Shadow Knight | Innoruuk's Curse (14383) | Yes. Reward drops from the hostile #Lhranc | Teydar greeting only | Ghoulbane (guktop) | Fear golems, Blade of Abrogation, Hole chain L55, Lhranc L60 | Very high | `Q` `S` `T` |
| Wizard | Staff of the Four (14341) | Yes | None | None | Enraged golem L65 175,000 hp, Phinigel, Venril. About 2,000 pp cash | Very high | `Q` `S` `T` |
| Magician | Orb of Mastery from Summon Orb | Yes, see the Magician plan | None | Power of Water (kaesora), Power of Fire (soldunga) | Planar and named kills in the plan | Very high | `Q` `S` |

## Raid targets that serve several epics

Kills the account needs for the late steps, sorted by how many epics use them (`S`, `Q`). Each entry assumes one kill per character that needs the drop, since pieces are NO DROP or lore unless noted.

| Target (zone, level, respawn) | Pieces and drop chance |
| --- | --- |
| Phinigel Autropos (kedge, L53, 18,000 hp, 43,200 s) | Magician Water staff 10%, Bard Kedge Backbone 20%, Wizard Blue Crystal Staff 10%, Rogue optional Robe of the Kedge 10% |
| Fear golems Terror, Fright, Dread (fearplane, L55, 32,500 hp, 259,200 s each) | Warrior Ball of Everliving Golem 10%, Necromancer Slime Blood 10%, Shadow Knight Soul Leech 10%, Shaman Child's Tear (75% broodling after death, optional) |
| Lord Nagafen (soldungb, L55) or Talendor (skyfire, L60), 259,200 s | Red Dragon Scales for the Warrior and the Bard (26.8% and 31.2%). Scales are tradable. Paladin Burnt Book half |
| Lady Vox (permafrost, L55) or Gorenaire (dreadlands, L60), 259,200 s | White Dragon Scales for the Bard (27.7% and 33.6%). Paladin Frost Book half |
| Severilous (emeraldjungle, L60) or Hoshkar (veeshan, L65) | Green Dragon Scales for the Warrior (30.6%, or 5% and 100% on the two Hoshkar rows) |
| Magi P`Tasa (hateplane, L56, 1,920 s) | Magician Earth staff 36%, Necromancer Eye of Innoruuk 36% |
| Plane of Hate mobs (zone minimum 46) | Warrior Hand of the Maestro, Paladin Tainted Breastplate (scorn banshee L50, 25%), Shadow Knight Decrepit Hide (ashenbone drake L51, 25%), Enchanter Essence of a Vampire (forsaken revenant, 20%), Rogue Book of Souls (ground pickup) |
| Plane of Sky (zone minimum 46) | Magician Crown, Warrior Spiroc Wingblade (Spiroc Lord L63, 50.4%), Enchanter Charm and Sacrifice (ground pickup), Monk Gwan, Necromancer Disc and Feathers, Shadow Knight Blade of Abrogation (8.7% best) |
| Venril Sathir (karnor, L55, 259,200 s, script-spawned in the Druid chain) | Wizard Gnarled Staff 50%, Druid Pulsing Green Stone 100% |

Echo of Nortlav (Red Scales 35%) has weight 0 in its only spawn group and is not counted (`S`, rule 11).

## Collect while leveling

Pieces by the party level at which they become practical. "Rotation" rows need no extra time beyond the normal rotation. "Errand" minutes include a few minutes of travel and are estimates. Every row is `S` and `Q` unless marked. Later groups meet the same bands when they level, so rows for classes not yet in the party are for those groups.

| Party level | Zone | Piece (class and step) | How | Minutes |
| --- | --- | --- | --- | --- |
| 22 to 25 | permafrost, rotation | Heart of Frost (Warrior W5) | goblin wizard L22 to 25, drop 20%, spawn 100% on 2 points, 50% on 3, 25% on 2, respawn 640 s | About 5 kills, 10 to 15 inf |
| 22 to 24 | guktop, rotation | Ghoulbane (Paladin G, Shadow Knight 11) | the_froglok_shin_lord L30 named, drop 25%, spawn 25%, 1 point, 960 s | About 4 h of camp per copy inf |
| 22 to 33 | soldunga, rotation | Mechanical Doll (Bard 6 to 9) | Marfen Binkdirple L31 takes Baenar's Solusek Mining Co. Invoice, which Baenar gives in southkarana for the word "doll" | 5 plus the Baenar visit |
| 24 to 27 | dalnir, rotation | Lost Scroll (Enchanter E8) | ground pickup, 300 s respawn | About 5 inf |
| 25 and up | swampofnohope, errand | Black Sapphire (Warrior W9) | Soblohg L25, drop 55%, spawn 50% on 2 points, 640 s | 20 to 30 inf |
| 26 to 27 | unrest, planned pass | Serra's note (Bard 6 to 9) | Serra takes the doll. The same pass gives Magician page 2 | In the pass |
| 26 to 30 | lakerathe lake floor, errand | Unjeweled Dragon Head Hilt (Warrior W9) | ground pickup at (919, 2530, -189) underwater, 300 s | 10 to 15 inf |
| 27 to 33 | soldunga, rotation | Lord Gimblox's Signet Ring (Cleric 7) | L30 named, drop 100%, spawn 10%, 1 point, 930 s | About 155 camp expected, 90% within 6 h inf |
| 28 to 35 | rathemtn, errand | Onyx Drake Gut (Bard 14) | Blackwing L35, drop 100%, spawn 24%, 1 point, 600 s | 45 to 50 inf |
| 31 to 35 | kaesora, rotation | Dull Diamond charm for the spectral librarian (Enchanter E9) | spawn 20% of its point, 640 s. Hostile after the hand-in, L35 | About 50 if camped alone, free in rotation inf |
| 33 and up | gukbottom, errand | Ink of the Dark (Enchanter E3) | ghoul scribe L35, combined spawn 34%, 1740 s. Needs the vial from Reania Jukle (qcat, no kill) first | 60 to 90 plus 10 travel inf |
| 33 to 39 | mistmoore, errand | Glowing Sword Hilt (Paladin F) | Xicotl L39, drop 100%, spawn 20%, 1720 s. Brother Hayle also gives one in `southkarana` (`#Brother_Hayle`) | About 2.5 h inf |
| 34 and up | lakerathe, errand | Lord Bergurgle's Crown (Cleric 1) | L40 named, drop 100%, spawn 10%, 1 point, 1440 s. Underwater goblin cave. Shmendrik also has a 3 h respawn | 4 to 5 h inf |
| 36 and up | burningwood, errand | Jeb Lumsed hand-ins (Enchanter E6, E11) | Two visits | 15 each inf |
| 38 to 40 | qey2hh1, errand | Maligar's Head (Bard 10 to 13) | Maligar spawns a L45 doppleganger, 6,000 hp, script-spawned. Drop 100% | About 15 inf |
| 38 to 46 | timorous, errand | Severely Damaged Dragon Head Hilt (Warrior W10) | ground pickup, 300 s | 15 to 25 inf |
| 39 and up | gukbottom, errand | Shining Metallic Robes (Enchanter E4, Rogue optional) | the_ghoul_arch_magus L45, drop 25%, spawn 25% on each of two ids at one point, 1740 s | About 4 h inf. Camp it together with the scribe |
| 40 and up | skyfire, citymist, errand | Felia Goldenwing and Wraith of Jaxion (Enchanter E9) | Felia spawn 11% on one point. Jaxion 20% (v1) or 25% (v0) | 90 to 100 and 55 to 95 inf |
| 40 and up | nurga, permafrost, dreadlands, errands | Diamond, Block of Permafrost, Giant Sized Monocle (Warrior W9 to W11) | goblin stabbers L43 to 45, drop 55%. Ice giants L44 to 50, drop 35%. Mountain giant patriarch L44, drop 30%, spawn 5% on 20 points | 20 to 30, 30 to 45, 60 to 120 inf. Mentrax adds 15 to 25 |
| 42 and up | wakening, errand | Jacinth (Warrior W9) | Grand Vizier Poolakacha`tei L45, drop 55%, spawn 25%, 640 s | 60 to 90 inf |
| 44 and up | skyfire, errand | Immortals (Monk M1) | named L47 to 50 at 35% and 4 to 11% spawn | 45 to 90 inf |
| 44 to 46 | overthere, oasis, hole, errands | Tzilug emerald, Cazel's Spoon, Kindle's Essence (Enchanter E9, E8, E10) | Tzilug spawn 100%. Cazel L51, 50% on 2 points, 7,200 s. Kindle L52, 100%, 640 s | 15, 120 and 20 inf |
| 46 | hateplane, airplane | Essence of a Vampire, Charm and Sacrifice (Enchanter E10, E8) | forsaken revenant 20% on 16 points. Ground pickup in Sky | 40 and 20 inf. Zone minimum 46, mobs L49 to 60 |

Magician pieces by band are in the Magician rates table below.

Pieces with no level gate that can be done at any time:

- Warrior W1 to W4 (Kargek, Oknoggin, Tenal first test), about 40 minutes of walking inf.
- Bard steps 1 to 6, the Torch of Misty relay across five zones, about 30 minutes inf.
- Rogue: Stanos' Pouch (Malka Rale, 34% spawn, 640 s, about 35), Founy and Tani parchment halves (say "pickpocket", about 25), Eldreth (needs two Bottles of Milk and 100 pp), Yendar's first exchange. All inf.
- Shaman steps 1 to 6 (Tiny Gem through the Small Gem). The Ooglyn timer chain is 50 to 110 minutes inf.
- Necromancer: Sir Edwin Motte's head (L33, freporte 32% spawn, 300 s, 15 to 20), Najena's robe (L28, 35% drop, 33% spawn, 1200 s, about 3 h) or Utandar Rizndown (overthere L40, drop 100%, 640 s, about 20 at party 34), and about 25 for the symbol hand-ins. Inf.
- Wizard: about 1,850 to 2,100 platinum and 45 to 60 minutes for Solomen, Camin, Dargon, Challice, Kandin and the sprocket. Inf.
- Druid Antonica set at party 25 to 46: Chunk of Tundra (everfrost mammoth L30, 8%, one point, 640 s, about 140), Clean Lakewater (lakerathe aquagoblin L36, about 25), Ancient Rock (rathemtn hill giant L37 to 40, about 40), Pure Lakewater (lakeofillomen barracuda L46, about 25). Inf.
- Paladin low-level pieces (Pure Crystal, Bucket of Pure Water, Testimony, Bog Juice, Edible Goo, Bunker Cell), about 1.5 to 2 h in total inf.

Everything else is raid or late.

## Ranking by value and effort

Value is what the finished item adds that nothing else supplies, read from item, spell and wiki data. Effort counts the late kills, respawn lockouts and errand hours in the class sections. The order is an inference. It does not rank the Magician, whose epic is a goal of the account.

| Rank | Epic | Value | Effort | Note |
| ---: | --- | --- | --- | --- |
| 1 | Cleric, Water Sprinkler of Nem Ankh | High. Click is Reviviscence, a 96% resurrection with a 7 s cast and 15 s recast. The wiki says the epic rez runs without mana and Clerics can be set to epic-only combat rez. The click needs level 50 (`S`, `W`) | Very high, but the late fights are script-spawned on demand. Only Bathezid has a 2 h timer. Add 4 to 5 h for Bergurgle | The only combat resurrection that costs no mana, which matters in the long boss fights in raid-roster.md (`inf`) |
| 2 | Warrior, Jagged Blade of War | High for the main tank. 36/41 two-hander, hp +100, STR +20, +10 to each resist, proc 175 fire and 500 hate (`S`) | Very high. Six late kills with 3-day lockouts, Tinkering for Rebreathers | The scales and the Fear golem drop are shared with the Bard, Necromancer and Shadow Knight |
| 3 | Bard, Singing Short Sword | Medium. Hp +100, CHA +20, resists +10, proc Dance of the Blade (group target, attack speed +55%, STR +30, attack +30, proc level 46) (`S`) | Very high. Phinigel, two dragon scales, Fear Amygdalans, Warlord, Undead Bard then Trakanon L65 | Needed for only one Bard in the raid |
| 4 | Rogue, Ragebringer | Medium to high for one Rogue. Haste 40%, attack +40, hp +100, backstab +15 (`S`) | High. Two script-spawned fights (Renux L51, V`ghera L65), no lockout kills. Anson blocker | Eight Rogues are planned, each needs its own copy |
| 5 | Enchanter, Staff of the Serpent | Medium. Click Speed of the Shissar: haste +66%, 30 minutes, single target, level 50. Clicks do not expire in IdleQuest, so one click holds (`S`, `leveling-plan.md`). Stacking with the Enchanter's own haste is unknown | Very high. Five named kills with 3-day or 16 h lockouts, 12 to 14 h of errands | The Lower Guk camps are the longest non-raid part |
| 6 | Shaman, Spear of Fate | Low. Hp 30, mana 70, WIS 20. The click Curse of the Spirits decodes to no combat effect (`S`) | High, and the cheapest of the high ones. One L54 kill if the Rak route works | Do it when the party is 50 or higher and Lord Rak is spawnable |
| 7 | Monk, Celestial Fists | Medium. Hp +100, AC +15, click 40% haste, attack +40, AC +40 for 3 ticks (`S`) | Very high. Five boss kills, a six-hour robe sub-quest | Four Monks planned |
| 8 | Paladin, Fiery Defender, and Shadow Knight, Innoruuk's Curse | Medium. Tank weapons with procs (Holy Shock 155 magic and a stun, Soul Consumption 50 magic) (`S`) | Very high. Many 3-day lockouts and L55 to 60 kills | Raid Resolve makes tank count the lever, not one weapon |
| 9 | Druid, Nature Walkers Scimitar | Low. Mana 90, WIS 20, click 55 damage (`S`) | Very high, plus five ingredients with no source in the snapshot | Possibly impossible from data alone |
| 10 | Necromancer, Scythe | Low to medium. Click about 1,200 damage over 16 ticks (`S`) | Very high. Three planes, Slime Blood about 11 days expected | |
| 11 | Wizard, Staff of the Four | Low to medium. INT 25, mana 100, 800-point absorb rune (`S`) | Very high. 175,000 hp golem, 12 h and 72 h targets, 2,000 pp | |

Order of pursuit for the current party (Warrior, Cleric, Bard, Shaman, Enchanter, Magician): Magician, Cleric, Warrior, Bard, Enchanter, Shaman. Start the cheap pieces during leveling, and plan the 46 to 56 raid work around the shared targets above.

### Rotation changes

Only a few pieces justify moving the rotation. The rest fit the planned rows or are errands. Zone stock figures here are crude snapshot counts of spawn points with mobs 1 below to 4 above the band (`S`, `inf`), not measurements.

| Band | Change | Reason |
| --- | --- | --- |
| 22 to 23 | None. Kill goblin wizards in permafrost until Heart of Frost drops | Warrior W5 at 20% |
| 24 to 27 | None. Pick up the Lost Scroll on each Dalnir visit | Enchanter E8 |
| 22 to 33 | None. Keep soldunga in every row | Marfen's doll (Bard), Gimblox's ring (Cleric, from 27), Power of Fire (Magician) |
| 26 to 27 | Visit Baenar (southkarana) and Marfen (soldunga) before the Unrest pass | The same pass then hands Serra the doll as well as collecting Magician page 2 |
| 31 to 35 | Kaesora as an errand, not a rotation zone | Most of its in-band mobs are immune to melee. Power of Water drops at 100% from enraged, famished and gorged raveners, and the spectral librarian (Enchanter) needs its own errand |
| 34 to 40 | Add kithicor | Enraged dread wolf L40 drops Magician page 1 at 64.7% with spawn 100% on 67 points (P99 says night only, not checked). `tools/zones.mjs` ranks Kithicor first at level 36 and second at 39 among the 20 scouted zones |
| 33 to 38 | Test dreadlands as an alternative to crystal or paw | Mountain giants L33 to 40 drop Hill Giant Toes at 36 to 40% with spawn 95 to 100%. The crude stock count is 191 at band 31 to 33 and 224 at 34 to 36, among the highest of all zones (`inf`) |
| 36 to 41 | Use gukbottom for errands, with a short stay for XP | Bloodthirsty ghouls L40 to 42 drop Magician page 3 at 91%. Basalt and granite gargoyles drop Gargoyle Eye at 58 to 69%. The Enchanter's scribe and robe camps sit in the same area |
| 38 to 42 | Add burningwood | Gylton L42 and the embers point, Slixin Klex L50, and the Enchanter's Jeb are there |
| 40 to 44 | Add hole | Elemental Binder from L38 to 40 elementals at 5% on many 1,200 s points (Magician) |

## Magician additions

Everything not listed here is in [magician-epic.md](magician-epic.md). Numbers are `S` unless marked.

Rates that the plan lacks:

| Piece | Source | Drop, spawn, points, respawn | Where it falls | Minutes |
| --- | --- | --- | --- | --- |
| Power of Wind | a_gypsy_dancer L24 or L25, mistmoore | Drop 100%. The two ids share one point at 50% each, so one dancer per 1,720 s | Errand, 28 to 30 | 20 to 35 inf |
| Power of Fire | lava elemental L35 (soldunga) | Drop 28%, spawn 25%, 1 point, 640 s | Rotation zone, 29 to 33 | See below |
| Power of Fire | blazing elemental L25 (soldunga) | Drop 2%, spawn 100% on 3 points, 640 s | Rotation zone, 22 to 33 | Expected about 50 kills |
| Power of Water | ravener L32 to 36 (kaesora) | Drop 100% on seven ids, one point each, 640 s | Errand, 31 to 35 | One kill |
| Power of Earth | faerie or fairy guard L24 to 26 (lfaydark) | Drop 11.6 to 16.5%, spawn 50 to 100% on 6 points, 640 s | Errand, 24 to 30 | 10 to 20 inf |
| Page 1 | enraged dread wolf L40 (kithicor) | Drop 64.7%, spawn 100% on 67 points, 400 s | Rotation if kithicor is added, 34 and up | In the rotation |
| Page 2 | tentacle terror L29 to 33 (unrest) | Drop 90%, spawn 25 to 34% on 2 points, 640 s | Unrest pass, 26 to 27 | In the pass |
| Page 3 | bloodthirsty ghoul L40 to 42 (gukbottom) | Drop 91%, spawn 25 to 40%, 1 to 2 points, 1,740 s | Errand, 36 to 41 | 30 to 60 inf |
| Cyclops Toes | cyclops L28 (qey2hh1, western Karana) | Drop 100%, spawn 50%, 1 point, 640 s | Errand, 24 to 30 | 10 to 15 inf. Rathemtn drops it at only 11.9% |
| Hill Giant Toes | mountain giants L33 to 40 (dreadlands) | Drop 36 to 40%, spawn 95 to 100% | Dreadlands if added, 33 to 38 | About 3 kills |
| Gargoyle Eye | basalt and granite gargoyles L30 to 42 (gukbottom) | Drop 58 to 69% | With page 3 | With page 3 |
| Pegasus Feather Cloak | #Quillmane L30 (southkarana) | Drop 40%, spawn 9%, 1 point, 78 s | Errand, 30 and up | About 15 inf |
| Elemental Binder | elementals L38 to 45 (hole) | Drop 5%, spawn 100% on 2 to 30 points per id, 1,200 s | 38 to 44 | About 20 kills inf |
| Burning Embers | Gylton L42, Phurzikon L47, Nezekezena L51 (burningwood) | Drop 10 to 13%, spawn 10 to 11%, one shared point, 80 to 172 s | 38 and up | 40 to 60 camp inf |
| Dirt of Underfoot | Slixin Klex L50 (burningwood) | Drop 35%, spawn 100%, 640 s | 44 and up | About 30 inf |
| Rain of Karana | Tarbul Earthstrider L48 (eastkarana) | Drop 100%, spawn 10%, 60 s | 42 and up | 10 to 20 inf. Faster than Undertow, whose respawn is 25,200 s |
| Blazing Wand | Undertow L49 (kedge) | Drop 70%, 25,200 s | 44 and up | One kill per 7 h |

Corrections and findings:

- The plan's "blazing elementals" source for Power of Fire drops it at only 2%. The lava elemental drops it at 28% but spawns on 25% of one point. Clearing both sources should yield one Power of Fire in about 1.4 hours of continuous soldunga work, or about 4 hours at a third of the rotation (`inf`).
- Gem merchants exist in the snapshot. Turga (lakerathe) sells Ruby and Star Ruby. Zok_Pirk (Star Ruby), Zok_Prolo and Darfumpel_Zirubbel (Ruby) are in rathemtn, next to the toe farms. Prices were not read (`S` merchantlist).
- Torn pages, the four Powers, the Staffs, the Elements (except Fire) and Power of the Orb are NO DROP and lore. Burning Embers, Torch of the Elements, Element of Fire, Words of Mastery and the Summon Orb scroll are NO DROP but not lore. Broom, Shovel, Cyclops Toes, Hill Giant Toes, Griffon Feathers, Gargoyle Eye, the Crown of Elemental Mastery [20764] and the Elemental Binder [28043] are tradable (`nodrop` 1), so another character can farm and give them to the Magician (`S`).
- No script in the Magician chain checks class or level (`Q`), so the leader hands in every step. The Summon Orb scroll (19436) is class 4096 and NO DROP. The wiki says Summon Orb creates the Orb of Mastery only if its caster owns none, and an Orb anywhere (worn, bag, cursor, bank) prevents a duplicate (`W` companions).
- Hand-ins need the party at 46 only in the Plane of Sky (Kihun Solstin and the Master of Elements). All other hand-ins are in normal zones (`S` zone minimums).

## Class chains

Step IDs are item ids in brackets. "Party" is the minimum party level for a group of six (`inf` from the mob level and the zone minimum). Items are consumed by a matching hand-in and returned otherwise unless noted.

### Warrior: Jagged Blade of War [10908]

Reward: two-handed slash 36/41 (`itemtype` 1), hp +100, STR +20, STA +15, DEX +15, resists +10, proc Rage of Zek (175 fire and 500 hate, proc level 50), classes Warrior (`S`). Splitting it (recipe 9689) gives Blade of Strategy [10910] and Blade of Tactics [10909] for dual wield (`S`).

Scripts: `freporte/Kargek_Redblade`, `feerrott/Oknoggin_Stonesmacker`, `eastkarana/Tenal_Redblade`, `freporte/Wenden_Blackhammer`, `oot/Denken_Strongpick`, `frontiermtns/Mentrax_Mountainbone`. The Red Scabbard [17859] is the container for recipe 9834 (enabled, no fail, no class gate), and the client has a `quest-container-17859` entry (`Q`, `S`, `K` `engine.pretty.js:12989-13007`). A server note says all 16 Warrior UI scenarios passed (`T`, the checklist file itself is not in the snapshot).

Do not hand the Red Scabbard and the blade to `freporte/Gartrog_Smitehammer`. His script consumes both and summons item 66175, which is not in the snapshot items or the client (`Q`, `S`, `K`).

| Step | NPC, zone, level | Hand in | Receive | Source of each item | Party |
| --- | --- | --- | --- | --- | --- |
| W1 | Kargek Redblade, freporte, L50 | say "scabbard", "favor" (Warrior) | Wax Sealed Note [20673] | none | any |
| W2 | Oknoggin Stonesmacker, feerrott, L55 | Note | Tiny Lute [20674] | W1 | any |
| W3 | Kargek | Tiny Lute | Redblade's Legacy [18083] | W2 | any |
| W4 | Tenal Redblade, eastkarana, L50 | Legacy | Totem of the Freezing War [20680], 100,000 XP | W3 | any |
| W5 | Tenal | Totem, Heart of Frost [10549] | Totem of Fiery War [20681], 100,000 XP | Goblin wizard L22 to 25, permafrost, 20%, 7 points | 22 |
| W6 | Tenal | Totem, Red Dragon Scales [11622], Green Dragon Scales [11582] | Mark of the Sword [20683], 100,000 XP | Red: Nagafen L55 soldungb 26.8%, Talendor L60 skyfire 31.2%. Green: Severilous L60 emeraldjungle 30.6%, Hoshkar L65 veeshan (zone minimum 55) | Raid |
| W7 | Tenal | Mark, Hand of the Maestro [20676] | Tenal's note [20684], 100,000 XP | #Hand_of_the_Maestro L51 hateplane 100%, 259,200 s, or Maestro_of_Rancor L53 30% | Raid, zone 46 |
| W8 | Kargek | Note, Spiroc Wingblade [20679] | Red Scabbard [17859], 1,000,000 XP | The_Spiroc_Lord L63, 33,261 hp, airplane, 50.4%, 14,400 s | Raid, zone 46 |
| W9 | Wenden Blackhammer, freporte | Unjeweled Hilt [20668], Diamond [10037], Black Sapphire [10036], Jacinth [10053] | Jeweled Dragon Head Hilt [20671] | Hilt: ground spawn, lakerathe, 300 s. Diamond: goblin stabber L43 to 45 nurga 55%, spawn 50%, 8 points, 960 s, or skeletal crusader L46 sebilis 27.5%. Sapphire: Soblohg L25 swampofnohope 55%. Jacinth: Grand Vizier Poolakacha`tei L45 wakening 55%, 25%. No merchant sells the gems | 25 to 42 |
| W10 | Mentrax Mountainbone, frontiermtns, then Wenden | Monocle [20678], then Damaged Hilt [20669], Rejesiam Ore [20666], Ball of Everliving Golem [20677] | Ore, then Finely Crafted Dragon Head Hilt [20672] | Monocle: patriarch L44 dreadlands 30%, spawn 5% on 20 points. Damaged Hilt: ground spawn, timorous, 300 s. Ball: Fear golem L55, 10%, 259,200 s | 40 to Fear |
| W11 | Denken Strongpick, oot | Two Rebreathers [16889], Block of Permafrost [20665], Keg of Vox Tail Ale [20664] | Ancient Sword Blade [20667] | Keg: merchants, 1 copper. Block: ice giants L36 to 50 permafrost 35%, 14,400 s, or Lady Vox 17%. Rebreather: no merchant, Tinkering recipe 492 (trivial 175) with two sub-recipes | 40 |
| W12 | none (drop) | none | Ancient Blade [20670] | Queen_Velazul_Di`zok L62, 30,000 hp, chardok, 100%, 7,200 s | Raid |
| W13 | Combine in Red Scabbard | the four items [20667, 20670, 20671, 20672] | Jagged Blade of War | W8 to W12 | After all |

Turn-in: Kargek and Wenden answer dialogue only for a Warrior, so a Warrior must say the keywords. All hand-ins have no class check, and no script checks level, race or faction (`Q`). Tradable pieces are the gems, Dragon Scales, Keg, Block of Permafrost, Rebreathers and the Monocle (`nodrop` 1). Another character can farm and give them. Every other piece, including both hilts picked up from the ground, is NO DROP and lore, so the looter holds it (`S`).

### Cleric: Water Sprinkler of Nem Ankh [5532]

Reward: one-hand blunt 20/32, mana +100, WIS +25, STA +10, CHA +15, classes Cleric. Click Reviviscence: 96% resurrection, 7 s cast, 15 s recast, click level 50 (`S`). The later Ceramic Water Sprinkler of Marr [29032] and the Unfired one [32232] are tradeskill items for all classes and belong to another quest (`S`). `nedaria/Tavon_Vastsea` is the 1.5 and 2.0 start (GM-only zone), not 1.0 (`Q`, `S`).

Scripts: `lakerathe/Shmendrik_Lavawalker`, `lakerathe/#Natasha_Whitewater`, `timorous/Omat_Vastsea`, `soltemple/a_seeker` and `80002`, `timorous/Natasha_Whitewater`, `burningwood/Naxot_Deepwater`, `soldungb/Zordak_Ragefire`, `soldungb/Zordakalicus_Ragefire`, `timorous/Jhassad_Oceanson`, `timorous/Avatar_of_Water` (`Q`). Natasha does not fight Shmendrik because NPC-versus-NPC combat is deferred, so the party kills Shmendrik to trigger the next spawn (`T`). Natasha depops 5 minutes after spawning, so hand in right after Omat. Natasha 51138, the spirit of flame, the plasmatic priest 80042, Ixiblat Fer, both Zordaks, Jhassad and the Avatar have no static spawn (`S`).

| Step | NPC, zone, level | Hand in | Receive | Source of each item | Party |
| --- | --- | --- | --- | --- | --- |
| 1 | Shmendrik Lavawalker, lakerathe, L30 | Lord Bergurgle's Crown [28044] | Oil of Fennin Ro [28045], spawns Natasha | Lord_Bergurgle L40 lakerathe, drop 100%, spawn 10%, 1,440 s | 34 |
| 2 | kill Shmendrik, then a_spirit_of_flame L40 | none | Damaged Goblin Crown [28046] | Natasha's signal spawns the spirit | 34 |
| 3 | Natasha | Damaged Goblin Crown | Ornate Sea Shell [28047] | step 2 | 34 |
| 4 | Omat Vastsea, timorous, L60 | Sea Shell | Coral Statue of Tarew [28051] | step 3 | any |
| 5 | a_seeker, soltemple, L34 (id 80002 only 09:00 to 20:00 game time) | Statue | seeker becomes a_plasmatic_priest L55, 13,750 hp. Drops Robe 1299 | step 4 | Raid, 47+ |
| 6 | Omat | Robe [1299] (tradable) | Orb of Frozen Water [28049], 100,000 XP, Natasha | step 5 | 47+ |
| 7 | kill Lord_Gimblox L30, soldunga | none | Lord Gimblox's Signet Ring [28018], drop 100% | spawn 10%, 930 s | 27 |
| 8 | Natasha, timorous | Ring | Ornate Sea Shell II [28056] | step 7 | 27 |
| 9 | Naxot Deepwater, burningwood, L25 | Sea Shell II | Message to Natasha [28052], spawns Ixiblat_Fer | step 8 | any |
| 10 | kill Ixiblat_Fer L62, 32,000 hp | none | Sceptre of Ixiblat Fer [28017] | script spawn | Raid |
| 11 | kill Overking_Bathezid L65, chardok, 7,200 s | none | Singed Scroll [18170] | spawn 100% | Raid |
| 12 | Omat | Scroll, Sceptre | Orb of Clear Water [28048], 100,000 XP | steps 10, 11 | Raid |
| 13 | Natasha | Message to Natasha | Shimmering Pearl [28054] | step 9 | 27 |
| 14 | Zordak Ragefire, soldungb | Pearl | hostile Zordak L60 (19,000 hp), then Zordakalicus L54 (32,000 hp) | step 13 | Raid |
| 15 | kill Zordakalicus | none | Zordak Ragefire's Heart [28019] | script spawn | Raid |
| 16 | Omat | Heart | Orb of Vapor [28050], 100,000 XP, Jhassad | step 15 | Raid |
| 17 | Jhassad Oceanson | Orbs of Frozen Water, Clear Water, Vapor | Orb of the Triumvirate [28023], Avatar of Water spawns | steps 6, 12, 16 | Raid |
| 18 | Avatar_of_Water L60, timorous | Orb of the Triumvirate | Nem Ankh, 200,000 XP | step 17 | Raid |

Turn-in: no class, level, race or quest-flag check anywhere (`Q`). Everything but the Robe is NO DROP. The three Orbs and the Triumvirate are lore, so do not hold two Natasha messages (`S`).

### Bard: Singing Short Sword [20542]

Reward: one-hand slash 16/26, hp +100, CHA +20, STR +15, DEX +10, STA +5, resists +10, proc Dance of the Blade (see ranking), classes Bard. `wakening/#Lantaric-Dar` is the 1.5 step (`S`, `Q`).

Scripts: `qey2hh1/Konia_Swiftfoot`, `misty/Fajio_Knejo`, `sro/Andad_Filla`, `lakerathe/Misty_Tekcihta`, `southkarana/Baenar_Swiftsong`, `soldunga/Marfen_Binkdirple`, `unrest/Serra`, `qey2hh1/Maligar`, `southkarana/Kelkim_Menkia`, `butcher/Vedico_Windwisper`, `steamfont/Forpar_Fizfla`, `sebilis/An_Undead_Bard`, `dreadlands/Baldric_Slezaf` (`Q`). The horn route through Vedico is optional because Forpar hands out his note on the word "components".

| Step | NPC, zone, level | Hand in | Receive | Source of each item | Party |
| --- | --- | --- | --- | --- | --- |
| 1 to 5 | Konia Swiftfoot (qey2hh1), Fajio Knejo (misty), Andad Filla (sro), Misty Tekcihta (lakerathe), Konia | the torch relay | Page 24 Top [20376], 1,000 XP | quest rewards | any |
| 6 to 9 | Baenar (southkarana), Marfen (soldunga L31), Serra (unrest), Baenar | none, then invoice, doll, note | Note to Maligar [20368] | quest rewards | 22 to 27 |
| 10 to 13 | Maligar (qey2hh1), kill his L45 doppleganger, Baenar, Konia | Note, then Head [20367], then Bongos | Mahlin's Mystical Bongos [20366], Page 24 Bottom [20383] | doppleganger is script-spawned, drop 100% | 38 |
| 14 | Kelkim Menkia, southkarana | Chromodrac Gut [20527], Red Wurm Gut [20528], Onyx Drake Gut [20529] | Page 25 [20377] | Onyx: Blackwing L35 rathemtn 100%, spawn 24%, 600 s. Red Wurm: Phurzikon L47 or Nezekezena L51 burningwood, 80 s respawn. Chromodrac: Eldrig the Old L51 skyfire, 50%, 2 points at 13% | 30 for Onyx, 48 to 50 for the rest |
| 15 to 16 | Vedico (butcher, optional), Forpar Fizfla (steamfont) | Alluring Horn [20530], or say "components" | Forpar's Note [20380] | Quag Maelstrom L45 oot 100% for the horn | any |
| 17 | Forpar | Note, Kedge Backbone [20524], Petrified Werewolf Skull [20525], Amygdalan Tendril [5520] | Mystical Lute Head [20535] | Backbone: Phinigel 20%, 43,200 s. Skull: Drolvarg warlord L52 karnor 35%, 17 to 25% on 4 points. Tendril: Amygdalan warrior L48 fearplane 8.5% | 48 to 50, Fear zone 46 |
| 18 | Forpar | Red Dragon Scales [11622], White Dragon Scales [11602], Metal Bits [16905] | Mystical Lute Body [20536] | Scales: see raid targets. Bits: smithing recipe 5458 with Water Flask and two Small Pieces of Ore | Raid |
| 19 to 20 | An Undead Bard, sebilis (L57, 15,750 hp, 18 h) then #Trakanon L65 (32,000 hp) | Lute Body (returned) | Undead Dragongut Strings [20526], 100% | spawned by the Bard's death | Raid |
| 21 | Forpar | Lute Head, Lute Body, Strings | Mystical Lute [20538] | steps 17 to 20 | Raid |
| 22 | Baldric Slezaf, dreadlands, L55 | Page 24 Top, Page 24 Bottom, Page 25, Mystical Lute | Singing Short Sword, 350,000 XP | steps 5, 13, 14, 21 | |

Turn-in: no class, level, faction or quest-flag check (`Q`). Bongos, the Mystical Lute, Dragon Scales and Metal Bits are tradable. Everything else is NO DROP and lore. The sword is class-locked, so the Bard's items stay with whoever earned them.

### Shaman: Spear of Fate [10651]

Reward: one-hand pierce 20/30, hp +30, mana +70, WIS +20, STR, STA and DEX +10, resists +10, classes Shaman, click Curse of the Spirits (no combat effect decoded) (`S`). Item 36223 is a later copy that no script gives (`Q`).

The last script (`emeraldjungle/Spirit_Sentinel_`) needs only an Iksar Scale [1674]. No faction, class or item check. The other steps raise Truespirit faction, which the server ignores (rule 3). The scripts keep two routes:

| Step | NPC, zone, level | Hand in | Receive | Source | Party |
| --- | --- | --- | --- | --- | --- |
| 1 | a_lesser_spirit (spawned when Peg_Leg butcher L13, Capt Surestout oot L20, Blinde the Cutpurse rathemtn L20 or an iksar manslayer fieldofbone L17 dies) | say the dialogue | Tiny Gem [1665] | kill drops the spirit | 12 to 21 |
| 2 to 6 | Bondl Felligan (freportn), two greater spirits, Ooglyn (erudsxing, 4,000 s, timed events of 50 to 110 minutes), a_greater_spirit, a_wandering_spirit (qey2hh1) | gems in order | Opaque [1666], Small [1667] | quest rewards | any to 30 |
| 7 to 12 | Glaron and Tabien (rathemtn L32), Black Dire (mistmoore L45), Kirn and Neh (optional, faction only) | Marr's Promise [1675], Woe [1676], Envy [1677], Black Dire Pelt [1672] | faction only | tradable pieces: Marr's Promise, Woe, Envy | 26 to 50 |
| 13 | Lord Rak`Ashiir L54 citymist, 11,000 hp, unique on 20% of placeholder black reaver deaths (reaver 90010, L50) | Child's Tear [1673] (optional) or kill him | Iksar Scale [1674], drop 100% from either Rak | Tear: Iksar_broodling after Dread, Fright or Terror dies, 75% | 50 |
| 14 | Spirit Sentinel_ (94141), emeraldjungle | Iksar Scale | Spear of Fate, 350,000 XP | step 13 | n/a |

The scripts' faction gate on Rak reads `GetModCharacterFactionLevel(GetPrimaryFaction())` and the server returns the maximum, so Rak does not aggro on proximity and accepts the Tear (`Q`, `T`). Killing him directly gives the Scale and skips Fear and the Ooglyn timers (route B). Both routes are scripts only (`inf`). Rak and Neh's snapshot rows share faction row 404, which resolves to another faction, a data oddity that the always-pass policy makes irrelevant (`S`).

Turn-in: no class check on any hand-in. Spawned Kirn and Rak attack the hand-in character's name. Everything but Marr's Promise, Woe and Envy is NO DROP and lore (`S`).

### Enchanter: Staff of the Serpent [10650]

Reward: one-hand blunt 11/24, hp +40, mana +60, INT +20, CHA +15, resists +10, click Speed of the Shissar (haste +66%, 300 ticks, single target, click level 50), classes Enchanter (`S`). Jeb also gives 1,500,000 XP (`Q`).

Scripts: `erudnext/Stofo_Olan`, `qcat/Reania_Jukle`, `gukbottom/a_ghoul_scribe`, `akanon/Rilgor_Plegnog`, `qey2hh1/Chrislin_Baker`, `burningwood/a_sarnak_imitator`, `felwitheb/Joren_Nobleheart`, `oggok/Bozlum_Blossom`, `oggok/Brokk_Boxtripper`, `overthere/Modani_Qu-Loni`, `akanon/Clockwork_VIIX`, `firiona/Nadia_Starfeast`, `kaesora/spectral_librarian`, `skyfire/Felia_Goldenwing`, `citymist/Wraith_of_Jaxion`, `overthere/Impaler_Tzilug`, `hole/Polzin_Mrid` (`Q`). Combines in the Enchanters Sack [17861] are recipes 9641 to 9644 and 9632 (`S`). The scripts accept a trade from a hostile NPC. `P99` says to charm the NPC, and whether a hostile NPC opens a trade window is not visible (`inf`). The server audit marks this chain not P99-aligned yet (`T`).

| Step | NPC, zone, level | Hand in | Receive | Source of each item | Party |
| --- | --- | --- | --- | --- | --- |
| E1 | Stofo Olan, erudnext, L50 | Mechanical Pen [10600], Ink of the Dark [10601], White Paper [10602] | Copy of Notes [10603] | Pen: E4. Ink: E3. Paper: E5 | any |
| E2 | Reania Jukle, qcat, L61 | say "ink of the dark", "supply" | Empty Ink Vial [10626] | none | any |
| E3 | a_ghoul_scribe, gukbottom, L35 | Vial | Ink of the Dark | scribe spawn 34%, 1,740 s | 33 |
| E4 | Rilgor Plegnog, akanon | Shining Metallic Robes [1360] (tradable) | Mechanical Pen | arch magus L45 gukbottom, 25% drop, 50% combined spawn, 1,740 s | 39 |
| E5 | Chrislin Baker, qey2hh1 | Piece of Parchment [13063], Quill [13051] (merchants) | Bandit Sash, spawns Thrackin Griften L55, 15,750 hp. Thrackin drops White Paper 100% | merchants in erudnext, qeynos, akanon, felwitheb | Thrackin 49 |
| E6 | Jeb Lumsed, burningwood, L55 | Copy of Notes | Jeb's Seal [10604] | E1 | 36 |
| E7 | Joren Nobleheart (felwitheb), Bozlum Blossom and Brokk Boxtripper (oggok), then the Sack, then Modani (overthere) | Head of a Prince [10627] gives Chalice of Kings [10608]. Sandals [10628] through Bozlum, Brokk and Bozlum again give Snow Blossoms [10609]. Combine Xolion Rod [10606], Innoruuk's Word [10607], Chalice and Blossoms in the Sack (recipe 9642) | Sack For Modani [10635], which Modani turns into the 1st Piece of Staff [10610] | Head: Prince Selrach L61 chardok 100%, 7,200 s. Rod: Vessel_Drozlin L60 cabeast 100%, 3 d. Word: Verina_Tomb L60 neriakc 100%, 3 d. Sandals: ground pickup in oggok, 300 s | Raid |
| E8 | Mizzle (Clockwork_VIIX, akanon) | Combine Spoon [10614], The One Key [10615], Lost Scroll [10616], Charm and Sacrifice [10617] in the Sack (recipe 9641). Hand in Sack For Mizzle [10636] | 2nd Piece [10611] | Spoon: Cazel L51 oasis 50% on 2 points, 7,200 s. One Key: ground pickup overthere, 3,600 s. Lost Scroll: ground pickup dalnir, 300 s. Charm and Sacrifice: ground pickup airplane, 864 s | 24 to 46 |
| E9 | Nadia Starfeast, firiona | Dull Diamond, Sapphire, Ruby and Emerald, each enchanted by hand-in to a charmed NPC, then combined (recipe 9643) into Sack For Nadia [10637] | 3rd Piece [10612] | Librarian L35 kaesora 20% spawn. Felia L45 skyfire 11%. Jaxion L45 citymist 20% or 25%. Tzilug L50 overthere 100% | 30 to 44 |
| E10 | Polzin Mrid, hole | Head of the Serpent [10622], Ghost Essence [10623], Vampire Essence [10624], Sands of the Mystics [10625] | 4th Piece [10613] | Wraith of a Shissar L55 fearplane 100%, 281,232 s. Ghost of Kindle L52 hole 100%, 640 s. Forsaken revenant hateplane 20%. The_Tangrin L54 fieldofbone, 32,000 hp, 57,600 s | Raid |
| E11 | Combine four pieces, then Jeb | Bundle of Staves [10639] | Staff of the Serpent | E7 to E10 | After all |

Turn-in: no class, level or quest-flag check. Jeb's Seal is returned by each master. Only the Spoon, Quill, Parchment and Shining Metallic Robes are tradable. Everything else is NO DROP and lore. Wraith of a Shissir (a spelling variant) has no static spawn and no script spawns it, so use the fearplane Wraith of a Shissar (`Q`, `S`).

### Rogue: Ragebringer [11057]

Reward: one-hand pierce 15/25, haste 40%, attack +40, hp +100, STR +20, STA, AGI and DEX +10, backstab +15, worn effect AC +30, classes Rogue (`S`). No 1.5 script exists (`Q`).

Scripts: `qcat/Malka_Rale`, `highpass/Anson_McBale`, `highpass/Stanos_Herkanor`, `kaladimb/Founy_Jestands`, `neriakc/Tani_N-Mar`, `lakerathe/Eldreth`, `steamfont/Yendar_Starpyre`, seven Kithicor aides, optional `qey2hh1/Vilnius_the_Small` (`Q`). Pickpocket is a dialogue keyword that skips the skill check (`T`).

Blockers (`S`, `inf`):

1. The classic Anson's spawn row (`spawn2` 2265, highpass, group 1973) has `min_expansion` 12. If the server filters spawns by expansion, Anson never appears, and only Anson spawns Stanos. The later `highpasshold` copy has Anson at 50%.
2. All seven Kithicor aides have weight 0 in sole-entry groups. The audit tested them only with spawned fixtures (`T`).
3. Malka Rale spawns on 34% of respawns at one point, 640 s.

| Step | NPC, zone, level | Hand in | Receive | Source | Party |
| --- | --- | --- | --- | --- | --- |
| R1 | Malka Rale, qcat, L48 | say "hanns", "help" | Stanos' Pouch [28014] | quest reward | any |
| R2 | Anson McBale, highpass (Rogue only, faction 5 or better) | Pouch or "see stanos" | Spawns Stanos Herkanor, 35 pp | R1 | any |
| R3 and R4 | Founy Jestands (kaladimb), Tani N`Mar (neriakc), time-gated | say "pickpocket" | Stained Parchment Top [28010] and Bottom [28011] | quest rewards | any |
| R5 | Stanos | both halves | Combined Parchment [28012] | R3, R4 | any |
| R6 | Eldreth, lakerathe, L49 | Combined Parchment, two Bottles of Milk [13087], 100 pp | Scribbled Parchment [28053] | milk: merchants, 5 copper | any |
| R7 | Yendar Starpyre, steamfont, L65, roaming, 6 h | Scribbled Parchment | Tattered Parchment [28055] | R6 | 20 |
| R8 | Book of Souls [28016], hateplane | pickup | none | ground spawn, 36,000 s | 50 |
| R9 and R10 | Yendar, then kill Renux Herkanor L51, 10,000 hp, quad attack | Tattered Parchment, Book of Souls | Translated Parchment [18961], Jagged Diamond Dagger [7506] | Renux drops 100% | 50 |
| R11 | Stanos | Translated Parchment | Sealed Box [28057] | R10 | 50 |
| R12 and R13 | any Kithicor aide L53 to 59, then kill General V`ghera L65, 26,000 hp | Sealed Box | General's Pouch [28013], Cazic Quill [7505] at 5% | V`ghera drops the pouch 100% | 58 and raid |
| R14 | Stanos (respawn him through Anson) | Pouch, Dagger, Quill | Ragebringer, 10,000 XP | R10, R13 | After all |

Shortcut (`Q`, `inf`, untested): `sro/Rathmana_Allin` gives the Translated Parchment for the three Bayle Lists and 20 gold, which would skip R6 to R10. The Dagger would then come from Vilnius the Small's four blades. The Quill's alternative is Vilnius's four robes (about 4 h, hardest low-level piece).

Turn-in: only Anson requires a Rogue. Tradable pieces are the dagger [7506], the parchment halves, Bottles of Milk and three robes. Everything else is NO DROP and lore.

### Monk: Celestial Fists [10652]

Reward: hands slot, hp +100, STR +20, AGI, DEX and STA +10, AC +15, resists +10, click Celestial Tranquility (instant, 3 ticks, attack +40, AC +40, haste 40%, click level 50), classes Monk (`S`). `lakerathe/Vortix`, `a_fallen_student` and item 36224 are the 1.5 continuation and cannot spawn at Velious (`Q`, `T`).

Scripts: `erudnext/Tomekeeper_Danl`, `dreadlands/Brother_Balatin`, `rathemtn/Brother_Zephyl`, `southkarana/#Brother_Qwinn`, `timorous/Lheao`, `lavastorm/a_fire_sprite` and `Eejag`, `airplane/a_presence` and `Gwan`, `nurga/a_sleeping_ogre`, `overthere/Astral_Projection`, `lakeofillomen/Astral_Projection`, `Vorash`, `Xenevorash`, `trakanon/Kaiaren` and `#Kaiaren` (`Q`). The audit says Trunt's hate list may not engage (`T`).

| Step | NPC, zone, level | Hand in | Receive | Source | Party |
| --- | --- | --- | --- | --- | --- |
| M1 | Tomekeeper Danl, erudnext (Monk only) | Immortals [18195] | Danl's Reference [1682] | Skyfire named L47 to 50 at 35% (spawn 11%), commons at 4% | 44 |
| M2 | Brother Balatin, dreadlands | Metal Pipe Zan [12979], Metal Pipe Fi [12980], Robe of the Lost Circle [12256] | Robe of the Whistling Fists [12970] | Zan: Drolvarg pawbuster L51 karnor 100%, spawn 5% on 4 points, 1,440 s. Fi: Iksar betrayer L53 chardok 100%, spawn 10%. Robe: Brother_Zephyl L61 rathemtn, spawn 5%, 150 s, drop 23%, or #Qwinn (weight 0) | 46 and about 6 h |
| M3 | Lheao, timorous | Robe, Reference | Book of Celestial Fists [1683] | M1, M2 | 40 |
| M4 | Fire sprite, lavastorm: say "I challenge Eejag" | none | kill Eejag L55 (monk class), Charred Scale [1684] | script spawn | 50 |
| M5 | a_presence, airplane (Monk only) | Charred Scale | Gwan L57 spawns, drops Breath of Gwan [1685] | M4 | 52, zone 46 |
| M6 | a_sleeping_ogre, nurga | Breath | Trunt L59, drops Trunt's Head [1686] | M5 | 52 |
| M8 | Astral Projection, overthere | Trunt's Head | Eye of Kaiaren [1687] | M6 | 52 |
| M9 | Astral Projection, lakeofillomen (Monk only) | Eye | Vorash L59, then Xenevorash L65, drops Demon Fangs [1688] | M8 | 58 to 60 |
| M10 and M11 | Kaiaren, trakanon, L52 (Monk only) | Book, then sane #Kaiaren | Book of Celestial Fists [1689] | M3 | 48 |
| M12 | #Kaiaren (sane) | Fangs, Book | Celestial Fists | M9, M11 | After all |

Turn-in: Danl, a_presence, Deep, the lakeofillomen Astral Projection and both Kaiarens check `Class() == "Monk"` (`Q`, `T`). Eejag, Gwan, Vorash and Xenevorash attack only a Monk. Every intermediate is NO DROP and lore, so the Monk must loot and hand in everything.

### Druid: Nature Walkers Scimitar [20490]

Reward: one-hand slash 20/30, hp +10, mana +90, STR +15, STA +15, WIS +20, click Wrath of Nature (55 damage, click level 50), classes Druid (`S`). Staff of Living Brambles is the 2.0 epic and is not in the snapshot.

Five items have no source in the snapshot. The four foraged items (Ripened Heartfruit [20464], Sweetened Mudroot [20465], Speckled Molded Mushroom [20466], Chilled Tundra Root [20467]) and the Rose of Firiona [12774] have no drop, merchant, ground spawn, quest or recipe source, and the snapshot has no forage table. Whether Forage yields them in the game is unknown (`S`, `inf`). The server audit does not mark the Druid chain P99-aligned (`T`).

Scripts (44 steps) are grouped here (`Q`):

| Group | NPCs and zones | Hand in and receive | Source of each item | Party |
| --- | --- | --- | --- | --- |
| Start (1 to 9) | Telin Darkforest (burningwood), Faelin (gfaydark), Giz X`Tin (kithicor), Althele, Sionae, Nuien, Teloa (eastkarana), Ella Foodcrafter (misty) | Worn Note to Earth Stained Note [18959] and Shiny Tin Bowl [17860] | Corruptor L45 drops Fleshbound Tome 100%. Telin needs a Kindly faction, which always passes | 45 to 48 |
| Bowl (10) | Combine four foraged items in the Shiny Tin Bowl | Hardened Mixture [20473] | no source found | Unknown |
| Pattern chain (11 to 21) | Alrik (timorous), Farios (felwitheb), Nora (felwithea), Merdan, Niera (qrg), skeleton (frontiermtns), Kinlo (kaladimb), Pottery Wheel combine | Runecrested Bowl [20460], Softly Glowing Stone [20462] | Jade Reaver [5664] from black reavers L50 citymist, 7 to 10% on 12 points, 7,200 s. Rose: no source | 48 |
| Venril (22 to 26) | Dance of the Fireflies (Druid spell) to Firefly Globe [10295], Venril Sathirs remains (karnor), Spirit, Venril L55 18,325 hp, Foloal Stormforest (firiona) | Warmly Glowing Stone [20468], then Elaborate Scimitar [20440] at Ella | Resurrection scroll: merchants in rathemtn, freportn, qeynos | Raid |
| Antonica (28 to 32) | tainted mammoth (everfrost), aquagoblin (lakerathe), hill giant (rathemtn), then corrupted versions, Withered Treant (northkarana), Yeka Ias (southkarana) | Chunk of Tundra [20690], Clean Lakewater [20689], Ancient Rock [20688] to Cleansed Spirit of Antonica [20698] | Corrupted mobs L30 to 40 drop at 100%. Tainted mammoth 8%, aquagoblin 20%, hill giant 10% | 25 to 40 |
| Faydwer (33 to 37) | tainted seahorse (kedge L51), seafury cyclops (oot L46, 1% on 22 points), brownie (lfaydark L45), Pained Unicorn, Silox Azrix | Cleansed Spirit of Faydwer [20697] | corrupted forms L51 to 53 | 48 to 50 |
| Kunark (38 to 43) | Ulump Pujluk (swampofnohope L55, 32,000 hp), Dolgin Codslayer (timorous) spawns Faydedar L55, tainted gorilla (emeraldjungle), barracuda (lakeofillomen), Nekexin Virulence (overthere) | Cleansed Spirit of Kunark [20699] | Froglok Essence, Pod of Seawater, Green Tree Bark, Pure Lakewater | Raid |
| Final | Xanuusus, northkarana | Cleansed Spirits of Kunark, Faydwer and Antonica, Elaborate Scimitar | Scimitar, 2,500,000 XP | the four items above |

Turn-in: no class or level check, no quest flag. Only Telin and Farios check faction, which always passes. Every chain item is NO DROP and lore except Rose, Jade Reaver and the 8922 Enchanted Clay (`nodrop` 1). Spawned fighters attack the hand-in character.

### Necromancer: Scythe of the Shadowed Soul [20544]

Reward: one-hand blunt 22/34, hp +20, mana +80, INT +20, STA +10, resists 5 to 15, click Torment of Shadows (16 ticks of 75 damage and a slow, click level 50), classes Necromancer (`S`). The 1.5 epic is excluded by a server test (`T`). Plane of Sky is simplified: Drakis spawns Jzil directly and ten gold to the thunder spirit princess spawns Gkzzallk (`T`).

Scripts: `lakerathe/Kazen_Fecae` and its combat chain (`a_bone_golem`, `a_failed_apprentice`, `a_tortured_soul`), `nektulos/Venenzi_Oberzendi`, `lakerathe/Emkel_Kabae`, `swampofnohope/Ssessthrass`, `timorous/Drendico_Metalbones`, `airplane/Drakis_Bloodcaster`, `Jzil_GSix`, `a_thunder_spirit_princess`, `Gkzzallk`, `Key_Master`, `Keeper_of_Souls` (`Q`). Killing Kazen spawns the bone golem and skips steps N1 to N10 (`Q`, `P99`).

| Step | NPC, zone, level | Hand in | Receive | Source | Party |
| --- | --- | --- | --- | --- | --- |
| N1 and N2 | Sir Edwin Motte L33 (freporte 32%, 300 s), Kazen Fecae (lakerathe, L59) | Head [20641] (say "dark arts") | Symbol of the Apprentice [20642] | head drop 100% | 27 |
| N3 to N7 | Venenzi (nektulos), Najena (robe), Emkel (lakerathe), Ssessthrass (swampofnohope) | Symbols, Flowing Black Robe [1320] | Scaled Symbol of the Serpent [20645] | Robe: Najena L28 35% drop, 33% spawn, 1,200 s, or Utandar Rizndown L40 overthere 100% | 22 to 34 |
| N8 to N10 | Grand Herbalist Mak`ha (chardok L56, 14,750 hp, 65% drop, 33% spawn, 640 s), Ssessthrass, Emkel | Manisi Herb [20654] | Symbol of Testing [20647] | | 50 |
| N11 | Kazen: bone golem L55 (20,750 hp), failed apprentice L48, tortured soul L55 (20,000 hp) | Symbol of Testing | Symbol of Insanity [20648] | script chain, three fights | 50 |
| N12 | Drendico Metalbones, timorous | Symbol of Insanity | Journal of Drendico [18086] | N11 | 46 |
| N13 and N14 | Drakis, Jzil_GSix (airplane) | Silver Disc [20938], Spiroc Feathers [20782], Black Silk Cape [20783] | Cloak of Spiroc Feathers [1278], 1,000,000 XP | Disc: azarack L53, 6.5%, 10 points, 14,400 s. Feathers: gorgalask, harpie, guard, gazer L54 to 59, 7 to 10%. Cape: Keeper of Souls L60, 60%, script-spawned | Raid |
| N15 and N16 | Eye of Innoruuk [20656] (hateplane, Magi P`Tasa and others 20 to 36%), Slime Blood [20655] (Fear golems, 10%) | | | | Raid |
| N17 to N21 | Drendico, Kazen, thunder spirit princess, Gkzzallk | Cloak, Eye, Slime Blood, Journal, then Tome, then Box | Reagent Box, Tome of Instruction [18087], Gkzzallk in a Box [20652], Scythe | | Raid |

Turn-in: Kazen's "dark arts" dialogue checks the Necromancer class. No hand-in checks class. Tradable pieces are the Disc, Feathers, Eye, Slime Blood and Robe. The Cape and everything from Kazen onward is NO DROP and lore, so the Necromancer holds them.

### Paladin: Fiery Defender [10099]

Reward: two-handed slash 35/40 (`itemtype` 1), hp +70, mana +30, AC +15, STR +20, STA +10, WIS +15, proc Holy Shock (155 magic damage and a 1.5 s stun, proc level 50), classes Paladin (`S`). Fiery Avenger [11050] is the intermediate weapon. `hohonora/#Irak_Altil` is the 1.5 start, not 1.0 (`Q`, `S`).

Scripts include `fearplane/Irak_Altil` (final), `erudnext/Reklon_Gnallen`, `felwithea/Elia_the_Pure`, `kaladimb/Jark` and `Nella_Stonebraids`, `freportw/peasant_woman`, `Joshua`, `a_prisoner` and `Sir_Lucan_D-Lere`, `airplane/Dason_Goldblade`, `Dirkog_Steelhand`, `Inte_Akera`, `neriakb/Rysva_To-Biath`, `oot/Oracle_of_K-Arnon`, `everfrost/Lich_of_Miragul`, `paw/Brother_Hayle` and the freport helper NPCs (`Q`). Tests cover the Pure Crystal and SoulFire hand-ins. The lich charm gate is simplified away (`T`). Ghoulbane's combine recipe 9809 is disabled, so the froglok drop is the route (`S`).

| Part | NPC, zone, level | Hand in | Receive | Source | Party |
| --- | --- | --- | --- | --- | --- |
| A | Jark (kaladimb) to Pure Crystal [29006]. Tainted Darksteel Breastplate [29001], Reklon Gnallen (erudnext) | Breastplate, Crystal | Gleaming Crested Breastplate [29004] | Breastplate: scorn banshee L50 hateplane 25%, 9 points, 640 s, or Thought Destroyer L55 | 46 |
| B | peasant woman (freportw, Paladin only), Joshua, Keeper_of_the_Tombs L55 (hole, 172,800 s), Reklon | Bucket of Pure Water [29009], Tainted Darksteel Sword [29000] | Gleaming Crested Sword [29003] | Keeper drops 100% | Late |
| C | Kirak_Vil L56 (nektulos, 1,800 s), Elia the Pure (felwithea) | Tainted Darksteel Shield [29002] | Gleaming Crested Shield [29005] | Kirak drops 100% | About 50, many tanks |
| D | Reklon | Sword, Breastplate, Shield | Mark of Atonement [29010] | A to C | After all |
| E | Dason Goldblade, Dirkog Steelhand (500 pp), Inte Akera, all airplane | SoulFire [5504] alone gives the First Blessing [18033]. Ghoulbane [5403] alone gives the Second Blessing [18034]. Both blessings, Miragul's Head [19073] and Miragul's Robe [1254] together | Fiery Avenger, 1,000,000 XP | Inte and Dirkog depop 5 minutes after spawning | 46 |
| F | Brother Hayle (paw, L24) | Sealed Note [18936], Note [18937], Brilliant Sword of Faith [13947], Testimony [18828], Glowing Sword Hilt [12197] | SoulFire [5504] | Sealed Note: H.K. 102 [12143] from a_prisoner (Bunker Cell from Tykar Renlin, Bog Juice, Edible Goo). Testimony: Merko Quetalis and Guard Willia. Sword of Faith: Valeron Dushire for Testimony of Truth from #Sir_Lucan (L48, 14,400 s). Hilt: Xicotl L39 mistmoore 100%, 20% spawn | 33 to 42 |
| G | Ghoulbane | | | froglok shin lord L30 guktop 25% drop, 25% spawn, 960 s. Alternative: Joren Nobleheart L60 felwitheb 100% | 24 |
| M | Rysva To`Biath (neriakb, 1,000 pp), Oracle of K`Arnon (oot), Lich of Miragul (everfrost), kill Miragul L53 | Burnt Book [19071] and Frost Book [19070] give the Book of Scale [18302]. The Oracle turns it into the Phylactery [19072] and the Lich spawns Miragul | Miragul's Head and Robe, 100% | Burnt Book: Nagafen 28.6%, Severilous, Talendor. Frost Book: Lady Vox 13.7%, Faydedar, Gorenaire 31.3%. All are 3-day respawns | Raid |
| Z | Irak Altil, fearplane, L51 | Mark of Atonement, Fiery Avenger | Fiery Defender | D, E | 46 |

Turn-in: the peasant woman is the only class check (Paladin). No script checks level or flags, and no step needs a quest flag. Everything is NO DROP and lore. Ghoulbane is shared with the Shadow Knight chain, one copy per character.

### Shadow Knight: Innoruuk's Curse [14383]

Reward: two-handed slash 40/45 (`itemtype` 1), hp +60, mana +40, STR +20, DEX +15, INT +15, proc Soul Consumption (50 magic damage, proc level 50), classes Shadow Knight (`S`). The 1.5 epic is `poknowledge/Sienn_Kastane` (`Q`).

Required path read from the scripts (`Q`, `inf`). The Kurron Ni, Darkforge armor, Cough Elixir, Dusty Tome and Seal steps only raise a faction that always passes (rule 3), so the scripts do not need them. The audit tested the chain in segments with seeded items, not end to end (`T`).

| Step | NPC, zone, level | Hand in | Receive | Source | Party |
| --- | --- | --- | --- | --- | --- |
| 1 | Knarthenne Skurl, tox (say "heart of an innocent") | none | Soulcase [17051] | none | any |
| 2 to 3 | Caradon (hole, L55), then kill Kyrenna L55 | Cell Key [14373] | Blood [14381], Heart [14380] | Key: mimic a_chest L45 to 47 hole, 25%, 3 points | About 50 |
| 4 | Marl Kastane, kerraridge | Blood | Dark Shroud [14377] | step 3 | 46 |
| 5 and 6 | #Ghost_of_Glohnor (hole), kill Mummy of Glohnor L56 | Shroud | Head [14378], Wrappings [14379] | script spawn | About 50 |
| 7 and 8 | Gerot Kastane (paineel), Marl | Head, then Wrappings | Head of the Valiant [14369], Will of Innoruuk [14370] | step 6 | 46 |
| 9 | combine in the Soulcase | Soulcase, Heart | Heart of the Innocent [14368] | steps 1, 3 | any |
| 10 | Teydar, qcat | Drake Spine [14372], Decrepit Hide [14371], Enchanted Platinum Bar [16507] | Decrepit Sheath [14366] | Spine: Rharzar L55 rathemtn 100%, 5% spawn on 7 points. Hide: ashenbone drake L51 hateplane 25%. Bar: Enchanter spell Enchant Platinum (level 34) on a Platinum Bar from merchants | 48 |
| 11 | Duriek Bloodpool, paineel | Ghoulbane [5403], Soul Leech Dark Sword of Blood [11609], Blade of Abrogation [5430], Decrepit Sheath [14366] | Corrupted Ghoulbane [14367] | Ghoulbane: guktop. Soul Leech: Fear golems 10%. Blade of Abrogation: Sky mobs 3 to 9% | 46 and raid |
| 12 | Lhranc, citymist, L60, 65,620 s | Corrupted Ghoulbane, Heart, Head, Will | spawns hostile #Lhranc | steps 7, 8, 9, 11 | 46 to 50 |
| 13 | kill #Lhranc | none | Innoruuk's Curse, 100% | script spawn | After all |

Turn-in: only Teydar's greeting checks the class. No hand-in checks class, level or flags. Everything is NO DROP and lore.

### Wizard: Staff of the Four [14341]

Reward: one-hand blunt 20/30, mana +100, INT +25, STA +10, STR +10, DEX +5, click Barrier of Force (800-point absorb for 100 minutes, +3 mana per tick, click level 50), classes Wizard (`S`). `v1/Talwyn_Flamecaller` is the 1.5 and 2.0 step and spawns only in a version of Lavastorm with `min_expansion` 9 (`Q`, `S`).

Scripts: `soltemple/Solomen`, `erudnext/Camin`, `halas/Dargon` and `Arantir_Karondor`, `felwithea/Challice`, `butcher/Kandin_Firepot`, `fearplane/a_broken_golem` (`Q`). Camin requires a 1,000 platinum hand-in before he takes Ro's Breath, which `P99` calls optional. The Cazic's Skin and Mistletoe Powder branch has no source, so Green Oil is the only route. Arantir despawns after 3 minutes of silence, so bring all three staves in one trip (`Q`, `T`).

| Step | NPC, zone, level | Hand in | Receive | Source | Party |
| --- | --- | --- | --- | --- | --- |
| W0 to W2 | Solomen (soltemple), Camin (erudnext) | 1,000 pp, Note to Camin [18088] | flag `wizepic` for 30 days | cash | any |
| W3 to W5 | Dargon (halas merchant), Camin, Dargon | Ro's Breath [14330] (850 pp) | Ro's Breath [14331], Arantir spawns | merchant | any |
| W6 to W8 | Arantir, Challice (felwithea), Dargon | Arantir's Ring | flag `wizepicA` | | any |
| W10 | Kandin Firepot, butcher | say "what oil" | Golem Sprocket [14319] (tradable) | none | any |
| W11 | a_broken_golem, fearplane (zone 46, 259,200 s) | Sprocket | an_enraged_golem L65, 175,000 hp, enrage and triple. Drops Green Oil [14349] 100% | W10 | Raid |
| W12 | Kandin | Green Oil | Staff of Gabstik [14339], Note to Arantir [18168] | W11 | Raid |
| W13 | Phinigel, kedge (10% drop) | kill | Blue Crystal Staff [14337] | 12 h respawn | Raid |
| W14 | #Venril_Sathir, karnor, L55 (50% drop, 72 h) | kill | Gnarled Staff [14338] | | Raid |
| W16 and W17 | Arantir (flag `wizepicB`), Solomen | three staves, then the Magically Sealed Bag [14340] | Staff of the Four | | After all |

Turn-in: no class or level check, and the flags `wizepic`, `wizepicA` and `wizepicB` are quest flags, whose per-character scope is unknown (`inf`). Everything is NO DROP and lore except the Golem Sprocket.

## Not verified

- No chain was played. The audit docs say the Enchanter and Druid chains are not yet P99-aligned end to end, and that the Cleric chain approximates its spawned combat (`T`).
- Whether the live server filters spawn rows by `min_expansion` (Anson) or spawns sole zero-weight groups (Kithicor aides, Echo of Nortlav). The spawning code is not in the exported server (`S`, `T`).
- Whether a class-locked reward can be summoned into another class's inventory (rule 8), whether `AddEXP` is capped (rule 10), and whether a hostile NPC accepts a trade without a charm (Enchanter).
- Whether the Druid's four foraged items and the Rose of Firiona can be obtained in the game.
- All minute estimates and all party-level estimates.
