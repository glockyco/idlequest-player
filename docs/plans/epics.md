# Epic quests for the roster

The 1.0 class epics for every roster class: whether IdleQuest implements them, what each step needs and where it comes from, which pieces the party meets while leveling from 22 to 46, and which epics add most to the account. The Magician's epic is in [magician-epic.md](magician-epic.md) and appears here only where this plan adds to it. Zone rotation is the band rows in `data/band-rotations.json` and [leveling-plan.md](leveling-plan.md), the roster is in [raid-roster.md](raid-roster.md).

This is a content-backed plan. No chain was played in the running game. Minutes are estimates from spawn arithmetic, not measurements.

## Evidence labels

Each row names its evidence with these labels. A claim with only `inf` is reasoning, not an observation.

- `Q`: the quest script the server runs, `C/effective/quests/<zone>/<npc>.lua`. A step counts as implemented only if its script exists there. `C` is `~/src/github.com/brynnb/idlequest-content`.
- `S`: the snapshot, `C/data/*.ndjson` (items, npc_types, spawn2, spawnentry, loot tables, merchantlist, ground_spawns, tradeskill recipes, spells_new, zone). Spawn percent is the chance that one respawn of a spawn point yields that NPC, which is the entry's `chance` divided by the group's total. Drop percent is per kill: `loottable_entries.probability` times the item's `lootdrop_entries.chance`, rolled `multiplier` times. Pools with a `droplimit` are read the same way, and how the server picks inside a pool is not visible, so those figures are first-order. Ground pickups count only when `idlequest_enabled_ground_spawns` lists them. The snapshot ignores content flags, so a source can still be missing in the live game. Only zones with `expansion` 2 or lower count, and spawn rows with `min_expansion` above 2 are treated as absent.
- `T`: server tests and audit notes in `C/reference/` (`reference/server/internal/quest/*_test.go`, `reference/docs/quest-audit-review-notes.md`, `quest-ui-verification-status.md`, `content_exclusions.json`).
- `W`: the IdleQuest wiki, <https://idlequest.net/wiki>. `.re/wiki-loot.txt` records its loot and inventory article.
- `K`: the client, `.re/js/*.pretty.js`.
- `P99`: a classic EverQuest guide in `C/reference/p99-wiki/raw-pages/`, used as a map only.
- `inf`: inference.

Zone names are short names. Zones named `freeporteast`, `freeportwest`, `highpasshold`, `oceanoftears`, `steamfontmts` and similar are later-era copies. The classic copies `freporte`, `freportw`, `highpass`, `oot` and `steamfont` are the ones used.

## Rules that hold for every epic

1. All fourteen 1.0 epics have a script for every NPC step (`Q`). Two kinds of gap remain. The Druid's four foraged items and the Rose of Firiona have no source in the snapshot, and the Ranger's Swiftwind needs the same Hardened Mixture. The Rogue and the Monk have spawn blockers listed in their sections (`S`). The 1.5 and 2.0 continuations need zones or items that the Velious-era snapshot lacks and are out of scope (`Q`, `S`).
2. No 1.0 script checks the player's level. The wiki says epic steps can be completed at any level, and the server policy records the same (`W` overview, `T` `content_exclusions.json`). Real limits are zone minimums (Plane of Hate, Plane of Fear and Plane of Sky need level 46 in `S`) and mob strength.
3. Quest-only faction checks always pass (`W` overview, `T` `faction_policy.go`: `GetFaction` returns Ally and `GetCharacterFactionLevel` returns the maximum). Class, item and quest-flag checks still apply.
4. Only the active (logged-in) character hands items in. The Give window offers the active character's inventory slots to the targeted NPC (`K` `engine.pretty.js` `QGe`: `characterProfile.inventory`, NPC id, current zone). A companion cannot hand in. Hostile actors that a hand-in spawns attack the hand-in character (`Q`, for example Rak, Lhranc, the Necromancer's golem).
5. Almost every epic piece is NO DROP. The client treats `nodrop === 0` as NO DROP (`K` `main.pretty.js:15989`, `engine.pretty.js:18813`). Tradable pieces (`nodrop` 1) are named in each class section.
6. Almost every piece is LORE. The client shows LORE for any `loregroup` other than 0 and blocks a second copy of the same item (`K` `engine.pretty.js:18811`, `main.pretty.js:22414-22430`). No item name starts with an asterisk, so `loregroup` is the only marker. Lore conflicts include banked items (`W`).
7. NO DROP pieces move between account characters with Inventory Search's Transfer button (`pullItem` in `src/bridge.js`), also from a character another tab is playing: Pivorandel pulled a NO DROP Power of Water from Tagujazolu while Tagujazolu led group 1. Only a lore copy the receiver already holds blocks the transfer ("Already on this character."). So any group can loot a piece for any character, and the hand-in pulls it to whoever turns it in. Auto hand-downs cover looted equipment upgrades only (`W`).
8. Hand-in scripts with no class check accept the hand-in from any leader, and `SummonItem` puts the reward into that leader's inventory (`Q`). A Magician leader could therefore run the class-free steps of another class and give the finished item on. Whether the server refuses a class-locked reward for another class is untested (`inf`). Class-gated steps are listed per class below.
9. Options > General > Keep Epic Quest Items (on by default) protects epic items, intermediates and ingredients for all fourteen classes from selling and decluttering, including duplicates and items held for another class (`W`).
10. Hand-in XP is large and goes only to the hand-in character, for example Kargek 1,000,000 and Jeb Lumsed 1,500,000 (`Q`). Level 30 costs about 5.3M XP and level 31 about 3.1M at race and class factor 1.0 (the measured level model). Whether IdleQuest caps `AddEXP` is unknown.
11. Several quest NPCs and bosses have no static spawn because a script spawns them (`Q`). A spawn group with a sole entry at weight 0 (the seven Kithicor aides, Echo of Nortlav, `#Brother_Hayle` in southkarana) appears in the snapshot, but whether the server spawns it is not visible. `tools/drops.mjs` counts it as spawning. `leveling-plan.md` treats zero weight as unsupported. This plan does not count such sources.
12. Two zones exist in two copies. `hateplane` and `hateplaneb` (Plane of Hate) both have minimum level 46, and `citymist` has spawn rows for version 0 and version 1 whose placeholder rates differ. This plan names `hateplane` and gives both citymist versions where they differ. Which copy IdleQuest offers is not checked (`S`).

## Summary by class

"Rotation" means a zone in the band row for the party level in `data/band-rotations.json`. Any other zone is an errand (`iq.errand`), which hunts named enemies without keeping the zone in the rotation. "Late" means a step the party cannot reasonably do before level 50 (NPC level 55 or higher, hp 25,000 or more, or a respawn of 12 hours or more). The number after a class is its characters in groups 1 to 3 of [raid-roster.md](raid-roster.md). Groups 4 to 6 are chosen after the raid test. Class sections below give each step.

| Class | Epic (item id) | In IdleQuest | Hand-in class gate | Pieces in rotation zones, 22 to 46 | Late steps | Effort | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Warrior (5) | Jagged Blade of War (10908) | Yes. Combine in Red Scabbard, recipe 9834. Do not use Gartrog (summons absent item 66175) | Kargek and Wenden answer only a Warrior in dialogue. Hand-ins open | Heart of Frost (permafrost, 22 to 27). From 41 velketor, sebilis and chardok drop the gems (errands) | Red and Green Dragon Scales, Hand of the Maestro, Spiroc Wingblade, Ball of Everliving Golem, Ancient Blade (six raid kills) | Very high | `Q` `S` `T` |
| Cleric (8) | Water Sprinkler of Nem Ankh (5532) | Yes, a script for every step, no class or level check | None | Lord Gimblox's Signet Ring (soldunga, 28 to 37) | Ixiblat Fer L62, Overking Bathezid L65, Zordak L60 and Zordakalicus L54, plasmatic priest L55. All script-spawned except Bathezid | Very high | `Q` `S` `T` `W` |
| Bard (5) | Singing Short Sword (20542) | Yes, 13 scripts | None | Mechanical Doll hand-in (soldunga, 28 to 37), Serra hand-in (unrest, 26 to 30) | Phinigel, Amygdalan, Drolvarg Warlord, two dragon scales, Undead Bard then Trakanon L65 | Very high | `Q` `S` |
| Shaman (8) | Spear of Fate (10651) | Yes. The last script needs only an Iksar Scale | None | None | Lord Rak L54 (or Child's Tear from Fear golems) | High | `Q` `S` |
| Enchanter (5) | Staff of the Serpent (10650) | Yes, no class or level check | None | Lost Scroll (dalnir, 31 to 33) | Prince Selrach L61, Vessel Drozlin, Verina Tomb, Wraith of a Shissar, Tangrin, Thrackin L55 | Very high | `Q` `S` `T` |
| Rogue (4) | Ragebringer (11057) | Yes, with spawn blockers (Anson, Kithicor aides) | Anson needs a Rogue | None | Renux L51, General V`ghera L65, Book of Souls in Hate | High | `Q` `S` `T` |
| Monk (4) | Celestial Fists (10652) | Yes. 36224 is not given by any script | Class check in nine scripts | None | Eejag, Gwan, Trunt, Vorash, Xenevorash L65, Robe of the Whistling Fists sub-quest | Very high | `Q` `S` `T` |
| Druid (5) | Nature Walkers Scimitar (20490) | Scripts yes. Five ingredients have no source in the snapshot | None | None (Antonica spirit set is errands) | Venril Sathir, Faydedar, Ulump Pujluk, many L46 to 55 corrupted fights | Very high | `Q` `S` `T` |
| Necromancer (7) | Scythe of the Shadowed Soul (20544) | Yes, Plane of Sky parts simplified | None (dialogue only) | None | Silver Disc, Spiroc Feathers, Cape (Sky), Eye (Hate), Slime Blood (Fear) | Very high | `Q` `S` `T` |
| Paladin (4) | Fiery Defender (10099) | Yes, every step scripted | Only the peasant woman | Ghoulbane (guktop, 22 to 25), Brother Hayle hand-in (paw, 26 to 37) | Keeper of the Tombs, Kirak Vil, dragon-dropped book halves, Miragul L53, Plane of Hate banshee | Very high | `Q` `S` `T` |
| Shadow Knight (4) | Innoruuk's Curse (14383) | Yes. Reward drops from the hostile #Lhranc | Teydar greeting only | Ghoulbane (guktop, 22 to 25) | Fear golems, Blade of Abrogation, Hole chain L55, Lhranc L60 | Very high | `Q` `S` `T` |
| Wizard (4) | Staff of the Four (14341) | Yes | None | None | Enraged golem L65 175,000 hp, Phinigel, Venril. About 1,850 pp cash at base price | Very high | `Q` `S` `T` |
| Ranger (5) | Earthcaller (20488), Swiftwind (20487) | Yes. Earthcaller needs no foraged item. Swiftwind needs the Druid's Hardened Mixture | None in the epic scripts | None | Essence carrier L54 and tamer L56 (Sky), Jaeil the Insane L55, Shattered Emerald from Plane of Hate bosses L55 to 58 | High | `Q` `S` `T` |
| Magician (4) | Orb of Mastery from Summon Orb | Yes, see the Magician plan | None | Page 2 (unrest, 26 to 30), Power of Fire (soldunga, 28 to 37) | Planar and named kills in the plan | Very high | `Q` `S` |

## Raid targets that serve several epics

Kills the account needs for the late steps, sorted by how many epics use them (`S`, `Q`). Each entry assumes one kill per character that needs the drop, since pieces are NO DROP or lore unless noted.

| Target (zone, level, respawn) | Pieces and drop chance |
| --- | --- |
| Phinigel Autropos (kedge, L53, 18,000 hp, 43,200 s) | Magician Water staff 10%, Bard Kedge Backbone 20%, Wizard Blue Crystal Staff 10%, Rogue optional Robe of the Kedge 10% |
| Fear golems Terror, Fright, Dread (fearplane, L55, 32,500 hp, 259,200 s each) | Warrior Ball of Everliving Golem 10%, Necromancer Slime Blood 10%, Shadow Knight Soul Leech 10%, Shaman Child's Tear (75% broodling after death, optional) |
| Lord Nagafen (soldungb, L55) or Talendor (skyfire, L60), 259,200 s | Red Dragon Scales for the Warrior and the Bard (26.8% and 31.2%). Scales are tradable. Paladin Burnt Book half (28.6% and 26.8%) |
| Lady Vox (permafrost, L55) or Gorenaire (dreadlands, L60), 259,200 s | White Dragon Scales for the Bard (27.7% and 33.6%). Paladin Frost Book half (13.7% and 31.3%). Warrior Block of Permafrost from Vox 17% |
| Severilous (emeraldjungle, L60) or Hoshkar (veeshan, L65, zone minimum 55) | Green Dragon Scales for the Warrior (30.6%, or 5% and 100% on the two Hoshkar rows) |
| Magi P`Tasa (hateplane, L56, 29,543 hp, 1,920 s) | Magician Earth staff 36%, Necromancer Eye of Innoruuk 36% |
| Plane of Hate (zone minimum 46) | Warrior Hand of the Maestro (L51, 100%, or Maestro of Rancor L53, 30%, both 259,200 s), Paladin Tainted Breastplate (scorn banshee L50, 25%), Shadow Knight Decrepit Hide (ashenbone drake L51, 25%), Enchanter Essence of a Vampire (forsaken revenant L49 to 51, 20%), Ranger Shattered Emerald (20% on eight L55 to 58 bosses with 1,920 s respawn, five of them always spawn), Rogue Book of Souls (ground pickup) |
| Plane of Sky (zone minimum 46) | Magician Crown (drakes, sphinx and undine spirit L53 to 60, 3.8 to 12.4%, 86,400 s), Ranger Swirling Sphere (essence tamer L56, 100%, script-spawned), Warrior Spiroc Wingblade (Spiroc Lord L63, 50.4%, 14,400 s), Enchanter Charm and Sacrifice (ground pickup), Monk Gwan, Necromancer Disc (azarack L53, 6.5%) and Feathers (7.5 to 10%), Shadow Knight Blade of Abrogation (8.7% best) |
| Venril Sathir (karnor, L55, 18,325 hp) | Wizard Gnarled Staff 50% from the static #Venril_Sathir (259,200 s). The script-spawned Venril Sathir of the Druid chain drops the Pulsing Green Stone 100% |

Echo of Nortlav (Red Scales 35%) has weight 0 in its only spawn group and is not counted (`S`, rule 11).

## Collect while leveling

Pieces by the party level at which they become practical. "Rotation" rows need no extra time beyond the normal rotation, and the levels given are those of the band rows that list the zone (`data/band-rotations.json`). "Errand" rows run as `iq.errand` for the named enemies, and their minutes include a few minutes of travel and are estimates. Every row is `S` and `Q` unless marked. Later groups meet the same bands when they level, so rows for classes not yet in the party are for those groups. Kaesora is in the rows from 34, so its pieces are errands only at 31 to 33.

| Party level | Zone | Piece (class and step) | How | Minutes |
| --- | --- | --- | --- | --- |
| 22 to 27 | permafrost, rotation | Heart of Frost (Warrior W5) | goblin wizard L22 to 25, drop 20%, spawn 100% on 2 points, 50% on 3, 25% on 2, respawn 640 s | About 5 kills, 10 to 15 inf |
| 22 to 25 | guktop, rotation | Ghoulbane (Paladin G, Shadow Knight 11) | the_froglok_shin_lord L30 named, drop 25%, spawn 25%, 1 point, 960 s | About 4 h of camp per copy inf |
| 28 to 37 | soldunga, rotation | Mechanical Doll (Bard 6 to 9) | Marfen Binkdirple L31 (spawn 100%, 640 s) takes Baenar's Solusek Mining Co. Invoice, which Baenar gives in southkarana for the word "doll". The Baenar visit comes before the 28 row | 5 plus the Baenar visit |
| 31 to 33 | dalnir, rotation | Lost Scroll (Enchanter E8) | ground pickup, 300 s respawn. At other levels it is a short visit | About 5 inf |
| 25 and up | swampofnohope, errand | Black Sapphire (Warrior W9) | Soblohg L25, drop 55%, spawn 50% on 2 points, 640 s | 20 to 30 inf |
| 26 to 30 | unrest, rotation | Serra's note (Bard 6 to 9) | Serra takes the doll, so Marfen's doll comes first. Soldunga and unrest share the 28 row. The same zone gives Magician page 2 | In the rotation |
| 26 to 30 | lakerathe lake floor, errand | Unjeweled Dragon Head Hilt (Warrior W9) | ground pickup at (919, 2530, -189) underwater, 300 s | 10 to 15 inf |
| 28 to 37 | soldunga, rotation | Lord Gimblox's Signet Ring (Cleric 7) | L30 named, drop 100%, spawn 10%, 1 point, 930 s | About 155 camp expected, 90% within 6 h inf |
| 28 to 35 | rathemtn, errand | Onyx Drake Gut (Bard 14) | Blackwing L35, drop 100%, spawn 24%, 1 point, 600 s | 45 to 50 inf |
| 31 to 35 | kaesora, errand | Dull Diamond charm for the spectral librarian (Enchanter E9) | spawn 20% of its point, 640 s. Hostile after the hand-in, L35 | About 50 if camped alone inf |
| 33 and up | gukbottom, errand | Ink of the Dark (Enchanter E3) | ghoul scribe L35, spawn 34%, 1740 s. Needs the vial from Reania Jukle (qcat, no kill) first | 60 to 90 plus 10 travel inf |
| 33 to 39 | mistmoore, errand | Glowing Sword Hilt (Paladin F) | Xicotl L39, drop 100%, spawn 20%, 1720 s. `#Brother_Hayle` in southkarana also gives one but has weight 0 (rule 11) | About 2.5 h inf |
| 34 and up | lakerathe, errand | Lord Bergurgle's Crown (Cleric 1) | L40 named, drop 100%, spawn 10%, 1 point, 1440 s. Underwater goblin cave. Shmendrik also has a 3 h respawn | 4 to 5 h inf |
| 36 and up | burningwood, errand | Jeb Lumsed hand-ins (Enchanter E6, E11). Jeb is the NPC a_sarnak_imitator | Two visits | 15 each inf |
| 38 to 40 | qey2hh1, errand | Maligar's Head (Bard 10 to 13) | Maligar L40 spawns a L45 doppleganger, 6,000 hp, script-spawned. Drop 100% | About 15 inf |
| 38 to 46 | timorous, errand | Severely Damaged Dragon Head Hilt (Warrior W10) | ground pickup, 300 s | 15 to 25 inf |
| 39 and up | gukbottom, errand | Shining Metallic Robes (Enchanter E4, Rogue optional) | the_ghoul_arch_magus L45, drop 25%, spawn 25% on each of two ids at one point, 1740 s. Yendar Starpyre (steamfont, L65, 6 h) also drops it at 100% | About 4 h inf. Camp it together with the scribe |
| 40 and up | skyfire errand, citymist errand | Felia Goldenwing and Wraith of Jaxion (Enchanter E9) | Felia spawn 11% on one point, 640 s. Jaxion 20% (version 1, 640 s) or 25% (version 0, 1,440 s). Citymist is not in the rotation | 90 to 100 and 55 to 95 inf |
| 40 and up | nurga, permafrost, dreadlands, errands | Diamond, Block of Permafrost, Giant Sized Monocle (Warrior W9 to W11) | goblin stabbers L43 to 45, drop 55%, spawn 25 to 50% on 8 points, 960 s. Ice giants L36 to 50, drop 35%, 14,400 s. Mountain giant patriarch L44, drop 30%, spawn 5 to 6% on 20 points, 640 s | 20 to 30, 30 to 45, 60 to 120 inf. Mentrax adds 15 to 25 |
| 41 and up | velketor, chardok, sebilis, errands | Diamond, Jacinth, Black Sapphire (Warrior W9) | velketor crystal guardian L55 (Diamond 27.5 to 55%), sebilis skeletal crusader L46 to 50 (Diamond 27.5%, spawn 12 to 25%), chardok imperial construct L55 to 57 (Jacinth 55%), chardok enslaved iksar miner L55 (Black Sapphire 27.5%). The mobs are 10 or more levels above the band, so whether the party fights them at 41 to 45 is unverified | Errands, because these zones are not in the rotation (see "Rotation changes") |
| 42 and up | wakening, errand | Jacinth (Warrior W9) | Grand Vizier Poolakacha`tei L45, drop 55%, spawn 25%, 640 s | 60 to 90 inf |
| 44 and up | skyfire, errand | Immortals (Monk M1) | Faerie of Dismay L47, a_soul_devourer L47 and a_lava_walker L50, drop 35%, spawn 11% each, 640 s. Other skyfire mobs drop 4 to 15% | 45 to 90 inf |
| 44 to 46 | overthere, oasis, hole, errands | Tzilug emerald, Cazel's Spoon, Kindle's Essence (Enchanter E9, E8, E10) | Tzilug spawn 100%. Cazel L51, drop 50%, spawn 50% on 2 points, 7,200 s. Kindle L52, 100%, 640 s | 15, 120 and 20 inf |
| 46 | hateplane, airplane | Essence of a Vampire, Charm and Sacrifice (Enchanter E10, E8) | forsaken revenant L49 to 51, drop 20%, spawn 100% on 16 points, 640 s. Ground pickup in Sky | 40 and 20 inf. Zone minimum 46, mobs L49 to 60 |

Magician pieces by band are in the Magician rates table below.

Pieces with no level gate that can be done at any time:

- Warrior W1 to W4 (Kargek, Oknoggin, Tenal first test), about 40 minutes of walking inf.
- Bard steps 1 to 6, the Torch of Misty relay across five zones, about 30 minutes inf.
- Rogue: Stanos' Pouch (Malka Rale, 34% spawn, 640 s, about 35), Founy and Tani parchment halves (say "pickpocket", about 25), Eldreth (needs two Bottles of Milk and 100 pp), Yendar's first exchange. All inf.
- Shaman steps 1 to 6 (Tiny Gem through the Small Gem). The Ooglyn timer chain is 50 to 110 minutes inf.
- Necromancer: Sir Edwin Motte's head (L33, freporte 32% spawn, 300 s, 15 to 20), Najena's robe (L28, 35% drop, 33% spawn, 1200 s, about 3 h) or Utandar Rizndown (overthere L40, drop 100%, 640 s, about 20 at party 34), and about 25 for the symbol hand-ins. Inf.
- Wizard: about 1,850 platinum at base price (1,000 pp to Camin and the 850 pp Ro's Breath) and 45 to 60 minutes for Solomen, Camin, Dargon, Challice, Kandin and the sprocket. Inf.
- Druid Antonica set at party 25 to 46: Chunk of Tundra (a tainted wooly mammoth L25 in everfrost, spawn 8%, one point, 640 s, turns into the corrupted L30 that drops it at 100%, about 140), Clean Lakewater (lakerathe aquagoblin L36, about 25), Ancient Rock (rathemtn hill giant L37 to 40, about 40), Pure Lakewater (lakeofillomen barracuda L46, about 25). Inf.
- Paladin low-level pieces (Pure Crystal, Bucket of Pure Water, Testimony, Bog Juice, Edible Goo, Bunker Cell), about 1.5 to 2 h in total inf.

Everything else is raid or late.

## Ranking by value and effort

Value is what the finished item adds to the account that nothing else supplies, read from item, spell and wiki data. Effort counts the late kills, respawn lockouts and errand hours in the class sections. Each epic is class-locked and almost every piece is NO DROP, so a second character of the same class repeats the whole chain. The order is an inference.

| Rank | Epic (roster characters of the class) | Value | Effort | Note |
| ---: | --- | --- | --- | --- |
| 1 | Cleric (8), Water Sprinkler of Nem Ankh | High. Click is Reviviscence, a 96% resurrection. The click skips mana and uses the item's own 10 s cast time (`K` `engine.pretty.js:15129-15176`, `W`). The spell itself casts in 7 s with a 15 s recast and costs 600 mana (`S`). Clerics can be set to epic-only combat rez (`W`). The click needs level 50 (`S`) | Very high, but the late fights are script-spawned on demand. Only Bathezid has a 2 h timer. Add 4 to 5 h for Bergurgle | The only combat resurrection that costs no mana, which matters in the long boss fights in raid-roster.md (`inf`) |
| 2 | Warrior (5), Jagged Blade of War | High for the main tank. 36/41 two-hander, hp +100, STR +20, +10 to each resist, proc 175 fire and 500 hate (`S`) | Very high. Six late kills, four of them with 3-day lockouts (two dragon scales, Hand of the Maestro, Fear golem), Tinkering for Rebreathers | The scales and the Fear golem drop are shared with the Bard, Necromancer and Shadow Knight |
| 3 | Rogue (4), Ragebringer | Medium to high. Haste 40%, attack +40, hp +100, backstab +15 (`S`) | High. Two script-spawned fights (Renux L51, V`ghera L65), no lockout kills. Blocked until a live check shows that Anson and the Kithicor aides spawn | Each Rogue needs its own copy |
| 4 | Ranger (5), Earthcaller | Medium. 14/24 one-hander, hp +50, STR +15, STA +5, DEX +10, resists +5, proc Earthcall (`S`) | High. Two script-spawned Sky fights, Jaeil the Insane (the Wretched respawns every 6.5 h), a Corruptor L45 for the Druid-start bowl, a Shattered Emerald from L55 to 58 Plane of Hate bosses (20%, 1,920 s). No multi-day lockout | Independent of the Druid's foraged items. Swiftwind is blocked by them |
| 5 | Bard (5), Singing Short Sword | Medium. Hp +100, CHA +20, resists +10, proc Dance of the Blade (group target, attack speed +55%, STR +30, attack +30, proc level 46) (`S`) | Very high. Phinigel, two dragon scales, Fear Amygdalans, Warlord, Undead Bard then Trakanon L65 | Needed for only one Bard in the raid (`inf`) |
| 6 | Enchanter (5), Staff of the Serpent | Medium. Click Speed of the Shissar: haste +66%, 30 minutes, single target, level 50. Clicks do not expire in IdleQuest, so one click holds (`S`, `W`). Stacking with the Enchanter's own haste is unknown | Very high. Six named kills, three with 3-day lockouts and one with 16 h, 12 to 14 h of errands | The Lower Guk camps are the longest non-raid part |
| 7 | Shaman (8), Spear of Fate | Low. Hp 30, mana 70, WIS 20. The click Curse of the Spirits decodes to no combat effect (`S`) | High, and the cheapest of the high ones. One L54 kill if the Rak route works | Do it when the party is 50 or higher and Lord Rak is spawnable |
| 8 | Magician (4), Orb of Mastery | Medium. The click summons a level 49 pet with 4,000 hp and 52 to 67 damage every 1.7 s, about twice the raw melee of the level 60 Water pet (22 to 81 every 2.8 s, `npc_types` 598 and 612). The Orb adds INT 20, STR 15, STA 10, DEX 5 and mana 100. It has one charge, and recasting does not refill it (`S`, `W`), so whether a lost epic pet can be replaced is unverified | Very high. Phinigel, Captain Rottgrime, Magi P`Tasa in Plane of Hate, the Crown in Plane of Sky, Neh, Undertow, Slixin, Tarbul | Most late targets are shared with the Warrior, Bard, Necromancer, Ranger and Wizard chains. The cheap pieces are already in the bags |
| 9 | Monk (4), Celestial Fists | Medium. Hp +100, AC +15, click 40% haste, attack +40, AC +40 for 3 ticks (`S`) | Very high. Five boss kills, a robe sub-quest of about 6 h | |
| 10 | Paladin (4), Fiery Defender, and Shadow Knight (4), Innoruuk's Curse | Medium. Tank weapons with procs (Holy Shock 155 magic and a stun, Soul Consumption 50 magic) (`S`) | Very high. Many 3-day lockouts and L55 to 60 kills | Raid Resolve makes tank count the lever, not one weapon |
| 11 | Druid (5), Nature Walkers Scimitar | Low. Mana 90, WIS 20, click Wrath of Nature (55 damage per tick, up to 30 ticks) (`S`) | Very high, plus five ingredients with no source in the snapshot | Possibly impossible from data alone |
| 12 | Necromancer (7), Scythe | Low to medium. Click about 1,200 damage over 16 ticks (`S`) | Very high. Three planes, Slime Blood about 11 days expected | |
| 13 | Wizard (4), Staff of the Four | Low to medium. INT 25, mana 100, 800-point absorb rune (`S`) | Very high. 175,000 hp golem, 12 h and 72 h targets, about 1,850 pp | |

Every roster character completes its class epic. The rank above sets the order in which the chains run, by what each finished item adds to the account. Each kill that serves several chains is planned for all characters that need it, because the pieces are NO DROP and every character repeats its chain. The cheap pieces come during leveling as errands and hunts the coordinator queues (`data/opportunities.json`), and the 46 to 56 raid work is planned around the shared targets above.

### Rotation changes

`data/band-rotations.json` holds the rotation rows, and `tools/predict.mjs --level N` ranks zones by modeled XP per hour. An errand takes a named piece without keeping a weak zone in the rotation, so a zone joins the rotation only when its XP pays. The table lists what the current rows supply and which pieces stay errands.

| Party level | Rotation row | Pieces the rotation supplies | Errands in the band |
| --- | --- | --- | --- |
| 22 to 25 | permafrost, runnyeye, guktop | Heart of Frost (Warrior W5), Ghoulbane (Paladin G, Shadow Knight 11) | Soblohg (Black Sapphire), lakerathe hilt |
| 26 to 27 | permafrost, paw, unrest | Heart of Frost, Brother Hayle hand-in (Paladin F, paw), Magician page 2 (tentacle terrors, 90%) | Baenar's invoice (southkarana) |
| 28 to 30 | unrest, soldunga, paw | Page 2, Marfen's doll and Serra's note (Bard 6 to 9), Gimblox's ring (Cleric 7), Power of Fire from blazing elementals (2%) | Power of Wind (mistmoore), Power of Earth (lfaydark), Cyclops Toes (qey2hh1), Quillmane, Blackwing |
| 31 to 33 | soldunga, unrest, paw | Gimblox's ring, Power of Fire (lava elemental L35, 28%), Hayle | Kaesora (Power of Water, spectral librarian), Lost Scroll (Enchanter E8, dalnir), Hill Giant Toes (dreadlands) |
| 34 to 37 | soldunga, kaesora, unrest | Gimblox's ring, Power of Fire, Power of Water and the spectral librarian (kaesora) | Hayle (paw), Xicotl, Bergurgle, page 3 (gukbottom), ghoul scribe |
| 38 to 43 | soldunga, kaesora, paw | Gimblox's ring, Power of Fire, the spectral librarian, Hayle | Star Ruby (citymist mist golem L42 to 46, 27.5%, also sold by merchants) for the Magician's Broom of Trilon, page 1 (kithicor), Elemental Binder (hole), Burning Embers (burningwood), Maligar, arch magus, Felia |
| 44 to 47 | kaesora, soltemple, droga | The spectral librarian (kaesora). The other two zones are not checked for pieces | Gems for Warrior W9 (velketor, chardok, sebilis, L46 to 57 mobs), Jacinth (wakening), Rain (Tarbul), Dirt (Slixin), Immortals and Felia (skyfire) |
| 48 and up | highkeep, soltemple, kedge | Not checked for pieces | Warrior W9 gems, planar raid kills. Chardok and sebilis hold Bathezid, Selrach, Velazul, Mak`ha, the Undead Bard and Trakanon, all raid level |

Kaesora ranks fourth at level 31 (2.45M XP/h), third at 33 (2.67M) and second at 36 (2.84M) in `tools/predict.mjs`, and the rows from 34 list it, so Power of Water and the spectral librarian come with the rotation from 34 and are errands before that. Kithicor ranks eleventh at 34 (2.15M) and seventh at 38, so page 1 (enraged dread wolf, two always-spawning points) is an errand. At levels 31, 33, 34, 36, 38 and 41 dreadlands, gukbottom and burningwood are not among the top eleven zones, and hole is eighth at 41 (1.79M), so their pieces are errands too.

## Magician additions

Everything not listed here is in [magician-epic.md](magician-epic.md). Numbers are `S` unless marked.

| Piece | Source | Drop, spawn, points, respawn | Where it falls | Minutes |
| --- | --- | --- | --- | --- |
| Four Torn Pages of Mastery | a_magician L10 to 22 (najena) | Drop 5% for each page, spawn 33 to 100% on 1 to 3 points per id, 1,200 s. Goblin magicians L17 to 19 drop each page at 1.0 to 1.5% | Errand, before 22 | About 20 kills per page inf |
| Broom, Shovel | goblin magicians L17 to 19 (najena) | Drop 3.5% each. Linara Parlone 1.1% (Broom). Injured halfling 1.4% and feerrott alligators L23 to 24 6.3% (Shovel) | With the pages | With the pages |
| Power of Wind | a_gypsy_dancer L24 or L25, mistmoore | Drop 100%. The two ids share one point at 50% each, so one dancer per 1,720 s | Errand, 28 to 30 | 20 to 35 inf |
| Power of Fire | lava elemental L35 (soldunga) | Drop 28%, spawn 25%, 1 point, 640 s | Rotation zone, 31 to 37 | See below |
| Power of Fire | blazing elemental L25 (soldunga) | Drop 2%, spawn 100% on 2 points at 640 s, 50% on a third point at 4,200 s | Rotation zone, 28 to 37 | Expected about 50 kills |
| Power of Water | ravener L32 to 36 (kaesora) | Drop 100% on seven ids, one point each, 640 s. Gorged L35 and famished L36 spawn at 100%, the other five at 25 to 34%. Hungered L35 drops at 35% | Errand, 31 and up | One kill |
| Power of Earth | faerie or fairy guard L24 to 26 (lfaydark) | Drop 11.6 to 16.5%, spawn 50 to 100% on 6 points, 640 s | Errand, 24 to 30 | 10 to 20 inf |
| Page 1 | enraged dread wolf L40 (kithicor) | Drop 64.7%, spawn 100% on 2 of 67 points and 5% on the other 65, 400 s | Errand, 34 and up | 10 to 20 inf |
| Page 2 | tentacle terror L29 to 33 (unrest) | Drop 90%, spawn 25 to 34% on 2 points, 640 s | Rotation zone, 26 to 30 | In the rotation |
| Page 3 | bloodthirsty ghoul L40 to 42 (gukbottom) | Drop 91%, spawn 25 to 40%, 1 to 2 points, 1,740 s | Errand, 36 to 41 | 30 to 60 inf |
| Cyclops Toes | cyclops L28 (qey2hh1, western Karana) | Drop 100%, spawn 50%, 1 point, 640 s | Errand, 24 to 30 | 10 to 15 inf. Rathemtn drops it at only 11.9% |
| Hill Giant Toes | mountain giants L30 to 40 (dreadlands) | Drop 36 to 40%. Spawn 15 to 100% by point, 95 to 100% on 16 of 48 points | Errand, 31 to 38 | About 3 kills. Rathemtn hill giants drop it at 10% |
| Gargoyle Eye | gargoyle L19 (oot, 43.8%, 8 points, 420 s). Basalt and granite gargoyles L30 to 42 (gukbottom, 58 to 69%) | See source | With page 3 | With page 3 |
| Pegasus Feather Cloak | #Quillmane L30 (southkarana) | Drop 40%, spawn 9%, 1 point, 78 s | Errand, 30 and up | About 15 inf |
| Elemental Binder | elementals L38 to 45 (hole) | Drop 5%, spawn 14 to 100% by point on 1 to 30 points per id, 1,200 s | Errand, 38 to 44 | About 20 kills inf |
| Burning Embers | Gylton L42 (own point), Phurzikon L47 and Nezekezena L51 (share one point) (burningwood) | Drop 10 to 13%, spawn 10 to 11%, 80 to 172 s | Errand, 38 and up | 40 to 60 camp inf |
| Dirt of Underfoot | Slixin Klex L50 (burningwood) | Drop 35%, spawn 100%, 640 s | Errand, 44 and up | About 30 inf |
| Rain of Karana | Tarbul Earthstrider L48 (eastkarana) | Drop 100%, spawn 10%, 60 s | Errand, 42 and up | 10 to 20 inf. Faster than Undertow, whose respawn is 25,200 s |
| Blazing Wand | Undertow L49 (kedge) | Drop 70%, 25,200 s. Undertow also drops Rain of Karana at 100% | Errand, 44 and up | One kill per 7 h |
| Torch of the Elements | #Neh`Ashiir L54 (citymist), script-spawned | Drop 25%. Each black reaver placeholder death spawns Neh with 20% (version 0, 90000) or 15% (version 1, 90192), otherwise the placeholder respawns at once | Raid, 46 and up | About 5 to 7 reaver kills in a chain inf |
| Staff of Elemental Mastery: Earth | Magi P`Tasa L56 (hateplane) | Drop 36%, spawn 100%, 1,920 s. Forsaken revenants drop it at 0.04% | Raid, 46 and up | |
| Staff of Elemental Mastery: Water | Phinigel Autropos L53 (kedge) | Drop 10%, 43,200 s | Raid | |
| Tears of Erollisi | Captain Rottgrime L55 (overthere) | Drop 100%, spawn 100%, 640 s | Raid | |
| Crown of Elemental Mastery | greater sphinx L54, undine spirit L53, drakes L56 to 60 (airplane) | Drop 3.8 to 12.4%, 86,400 s | Raid, zone 46 | |
| Star Ruby, Ruby | Merchants | Item price field 65,000 and 125,000. Merchant markup was not read | Any time | |

Corrections and findings:

- The plan's "blazing elementals" source for Power of Fire drops it at only 2%. The lava elemental drops it at 28% but spawns on 25% of one point. If every spawn is killed at once, both sources together give about 0.63 pieces per hour (lava 0.39, blazing 0.23 and 0.01), so one Power of Fire takes at least 1.6 hours of continuous soldunga work, or about 5 hours at a third of the rotation (`inf`).
- Gem merchants exist in the snapshot. Turga (lakerathe) sells Ruby and Star Ruby. Zok_Pirk (Star Ruby), Zok_Prolo and Darfumpel_Zirubbel (Ruby) are in rathemtn, next to the toe farms (`S` merchantlist).
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
| W7 | Tenal | Mark, Hand of the Maestro [20676] | Tenal's note [20684], 100,000 XP | Hand_of_the_Maestro L51 hateplane 100%, 259,200 s, or Maestro_of_Rancor L53 30%, 259,200 s | Raid, zone 46 |
| W8 | Kargek | Note, Spiroc Wingblade [20679] | Red Scabbard [17859], 1,000,000 XP | The_Spiroc_Lord L63, 33,261 hp, airplane, 50.4%, 14,400 s | Raid, zone 46 |
| W9 | Wenden Blackhammer, freporte | Unjeweled Hilt [20668], Diamond [10037], Black Sapphire [10036], Jacinth [10053] | Jeweled Dragon Head Hilt [20671] | Hilt: ground spawn, lakerathe, 300 s. Diamond: goblin stabber L43 to 45 nurga 55%, spawn 25 to 50% on 8 points, 960 s, or skeletal crusader L46 to 50 sebilis 27.5%. Sapphire: Soblohg L25 swampofnohope 55%, spawn 50% on 2 points, 640 s. Jacinth: Grand Vizier Poolakacha`tei L45 wakening 55%, spawn 25%, 640 s. No merchant in a zone of expansion 2 or lower sells them | 25 to 42 |
| W10 | Mentrax Mountainbone, frontiermtns, then Wenden | Monocle [20678], then Damaged Hilt [20669], Rejesiam Ore [20666], Ball of Everliving Golem [20677] | Ore, then Finely Crafted Dragon Head Hilt [20672] | Monocle: patriarch L44 dreadlands 30%, spawn 5 to 6% on 20 points, 640 s. Damaged Hilt: ground spawn, timorous, 300 s. Ball: Fear golem L55, 10%, 259,200 s | 40 to Fear |
| W11 | Denken Strongpick, oot | Two Rebreathers [16889], Block of Permafrost [20665], Keg of Vox Tail Ale [20664] | Ancient Sword Blade [20667] | Keg: merchants, 1 copper. Block: ice giants L36 to 50 permafrost 35%, 14,400 s, or Lady Vox 17%. Rebreather: no merchant, Tinkering recipe 492 (trivial 175) with two sub-recipes | 40 |
| W12 | none (drop) | none | Ancient Blade [20670] | Queen_Velazul_Di`zok L62, 30,000 hp, chardok, 100%, 7,200 s | Raid |
| W13 | Combine in Red Scabbard | the four items [20667, 20670, 20671, 20672] | Jagged Blade of War | W8 to W12 | After all |

Turn-in: Kargek and Wenden answer dialogue only for a Warrior, so a Warrior must say the keywords. All hand-ins have no class check, and no script checks level, race or faction (`Q`). Tradable pieces are the gems, Dragon Scales, Keg, Block of Permafrost, Rebreathers and the Monocle (`nodrop` 1). Another character can farm and give them. Every other piece, including both hilts picked up from the ground, is NO DROP and lore, so the looter holds it (`S`).

### Cleric: Water Sprinkler of Nem Ankh [5532]

Reward: one-hand blunt 20/32, mana +100, WIS +25, STA +10, CHA +15, classes Cleric. Click Reviviscence: 96% resurrection, click level 50. The item's cast time is 10 s, the spell's own 7 s with a 15 s recast and 600 mana, and the click skips mana (`S`, `K` `engine.pretty.js:15129-15176`). The later Ceramic Water Sprinkler of Marr [29032] and the Unfired one [32232] are tradeskill items for all classes and belong to another quest (`S`). `nedaria/Tavon_Vastsea` is the 1.5 and 2.0 start (GM-only zone), not 1.0 (`Q`, `S`).

Scripts: `lakerathe/Shmendrik_Lavawalker`, `lakerathe/#Natasha_Whitewater`, `timorous/Omat_Vastsea`, `soltemple/a_seeker` and `80002`, `timorous/Natasha_Whitewater`, `burningwood/Naxot_Deepwater`, `soldungb/Zordak_Ragefire`, `soldungb/Zordakalicus_Ragefire`, `timorous/Jhassad_Oceanson`, `timorous/Avatar_of_Water` (`Q`). Natasha does not fight Shmendrik because NPC-versus-NPC combat is deferred, so the party kills Shmendrik to trigger the next spawn (`T`). Natasha depops 5 minutes after spawning, so hand in right after Omat. Natasha 51138 and 96080, the spirit of flame, the plasmatic priest 80042, Ixiblat Fer, the hostile Zordak 91096, Zordakalicus, Jhassad and the Avatar have no static spawn. Shmendrik, Omat, Naxot and the peaceful Zordak Ragefire (32038, soldungb, 640 s) have static spawns (`S`).

| Step | NPC, zone, level | Hand in | Receive | Source of each item | Party |
| --- | --- | --- | --- | --- | --- |
| 1 | Shmendrik Lavawalker, lakerathe, L30 | Lord Bergurgle's Crown [28044] | Oil of Fennin Ro [28045], spawns Natasha | Lord_Bergurgle L40 lakerathe, drop 100%, spawn 10%, 1,440 s | 34 |
| 2 | kill Shmendrik, then a_spirit_of_flame L40 | none | Damaged Goblin Crown [28046] | Natasha's signal spawns the spirit | 34 |
| 3 | Natasha | Damaged Goblin Crown | Ornate Sea Shell [28047] | step 2 | 34 |
| 4 | Omat Vastsea, timorous, L60 | Sea Shell | Coral Statue of Tarew [28051] | step 3 | any |
| 5 | a_seeker, soltemple, L34 (id 80002 only in zone hours 9 to 20, the other seekers at any hour) | Statue | seeker becomes a_plasmatic_priest L55, 13,750 hp. Drops Robe 1299 | step 4 | Raid, 47+ |
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
| 14 | Kelkim Menkia, southkarana | Chromodrac Gut [20527], Red Wurm Gut [20528], Onyx Drake Gut [20529] | Page 25 [20377] | Onyx: Blackwing L35 rathemtn 100%, spawn 24%, 600 s. Red Wurm: Phurzikon L47 (100%) or Nezekezena L51 (80%) burningwood, spawn 10%, 80 s respawn. Chromodrac: Eldrig the Old L51 skyfire, drop 50%, spawn 13% on 2 points, 640 s | 30 for Onyx, 48 to 50 for the rest |
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
| E4 | Rilgor Plegnog, akanon | Shining Metallic Robes [1360] (tradable) | Mechanical Pen | arch magus L45 gukbottom, 25% drop, 50% combined spawn, 1,740 s, or Yendar Starpyre L65 steamfont, 100%, 6 h | 39 |
| E5 | Chrislin Baker, qey2hh1 | Piece of Parchment [13063], Quill [13051] (merchants) | Bandit Sash, spawns Thrackin Griften L55, 15,750 hp. Thrackin drops White Paper 100% | merchants in erudnext, qeynos, akanon, felwitheb | Thrackin 49 |
| E6 | Jeb Lumsed (a_sarnak_imitator), burningwood, L55 | Copy of Notes | Jeb's Seal [10604] | E1 | 36 |
| E7 | Joren Nobleheart (felwitheb), Bozlum Blossom and Brokk Boxtripper (oggok), then the Sack, then Modani (overthere) | Head of a Prince [10627] gives Chalice of Kings [10608]. Sandals [10628] through Bozlum, Brokk and Bozlum again give Snow Blossoms [10609]. Combine Xolion Rod [10606], Innoruuk's Word [10607], Chalice and Blossoms in the Sack (recipe 9642) | Sack For Modani [10635], which Modani turns into the 1st Piece of Staff [10610] | Head: Prince Selrach L61 chardok 100%, 7,200 s. Rod: Vessel_Drozlin L60 cabeast 100%, 3 d. Word: Verina_Tomb L60 neriakc 100%, 3 d. Sandals: ground pickup in oggok, 300 s | Raid |
| E8 | Mizzle (Clockwork_VIIX, akanon) | Combine Spoon [10614], The One Key [10615], Lost Scroll [10616], Charm and Sacrifice [10617] in the Sack (recipe 9641). Hand in Sack For Mizzle [10636] | 2nd Piece [10611] | Spoon: Cazel L51 oasis 50% on 2 points, 7,200 s. One Key: ground pickup overthere, 3,600 s. Lost Scroll: ground pickup dalnir, 300 s. Charm and Sacrifice: ground pickup airplane, 864 s | 24 to 46 |
| E9 | Nadia Starfeast, firiona | Dull Diamond, Sapphire, Ruby and Emerald, each enchanted by hand-in to a charmed NPC, then combined (recipe 9643) into Sack For Nadia [10637] | 3rd Piece [10612] | Librarian L35 kaesora 20% spawn, 640 s. Felia L45 skyfire 11%, 640 s. Jaxion L45 citymist 20% (version 1, 640 s) or 25% (version 0, 1,440 s). Tzilug L50 overthere 100% | 30 to 44 |
| E10 | Polzin Mrid, hole | Head of the Serpent [10622], Ghost Essence [10623], Vampire Essence [10624], Sands of the Mystics [10625] | 4th Piece [10613] | Wraith of a Shissar L55 fearplane 100%, 281,232 s. Ghost of Kindle L52 hole 100%, 640 s. Forsaken revenant hateplane 20%. The_Tangrin L54 fieldofbone, 32,000 hp, 57,600 s | Raid |
| E11 | Combine four pieces, then Jeb | Bundle of Staves [10639] | Staff of the Serpent | E7 to E10 | After all |

Turn-in: no class, level or quest-flag check. Jeb's Seal is returned by each master. Only the Spoon, Quill, Parchment and Shining Metallic Robes are tradable. Everything else is NO DROP and lore. Wraith of a Shissir (a spelling variant) has no static spawn and no script spawns it, so use the fearplane Wraith of a Shissar (`Q`, `S`).

### Rogue: Ragebringer [11057]

Reward: one-hand pierce 15/25, haste 40%, attack +40, hp +100, STR +20, STA, AGI and DEX +10, backstab +15, worn effect AC +30, classes Rogue (`S`). No 1.5 script exists (`Q`).

Scripts: `qcat/Malka_Rale`, `highpass/Anson_McBale`, `highpass/Stanos_Herkanor`, `kaladimb/Founy_Jestands`, `neriakc/Tani_N-Mar`, `lakerathe/Eldreth`, `steamfont/Yendar_Starpyre`, seven Kithicor aides, optional `qey2hh1/Vilnius_the_Small` (`Q`). Pickpocket is a dialogue keyword that skips the skill check (`T`).

Blockers (`S`, `inf`):

1. The classic Anson's spawn row (`spawn2` 2265, highpass, group 1973) has `min_expansion` 12. Anson is L61 with 32,000 hp, spawn 25% and a 1,320 s respawn. If the server filters spawns by expansion, Anson never appears, and only Anson spawns Stanos. The later `highpasshold` copy has Anson at 50% with a 215 s respawn.
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
| M1 | Tomekeeper Danl, erudnext (Monk only) | Immortals [18195] | Danl's Reference [1682] | Skyfire: Faerie of Dismay L47, a_soul_devourer L47 and a_lava_walker L50 drop it at 35% with spawn 11% each, 640 s. Other skyfire mobs drop 4 to 15% | 44 |
| M2 | Brother Balatin, dreadlands | Metal Pipe Zan [12979], Metal Pipe Fi [12980], Robe of the Lost Circle [12256] | Robe of the Whistling Fists [12970] | Zan: Drolvarg pawbuster L51 karnor 100%, spawn 5% on 4 points, 1,440 s. Fi: Iksar betrayer L53 chardok 100%, spawn 10%. Robe: Brother_Zephyl L61 rathemtn, spawn 5%, 150 s, drop 23%, or #Qwinn (weight 0) | 46 and about 6 h |
| M3 | Lheao, timorous | Robe, Reference | Book of Celestial Fists [1683] | M1, M2 | 40 |
| M4 | Fire sprite, lavastorm: say "I challenge Eejag" | none | kill Eejag L55 (monk class), Charred Scale [1684] | script spawn | 50 |
| M5 | a_presence, airplane (Monk only) | Charred Scale | Gwan L57 spawns, drops Breath of Gwan [1685] | M4 | 52, zone 46 |
| M6 | a_sleeping_ogre, nurga | Breath | Trunt L59, drops Trunt's Head [1686] | M5 | 52 |
| M8 | Astral Projection, overthere | Trunt's Head | Eye of Kaiaren [1687] | M6 | 52 |
| M9 | Astral Projection, lakeofillomen (Monk only) | Eye | Vorash L59, then Xenevorash L65, drops Demon Fangs [1688] | M8 | 58 to 60 |
| M10 and M11 | Kaiaren, trakanon, L52 (Monk only) | Book, then sane #Kaiaren | Book of Celestial Fists [1689] | M3 | 48 |
| M12 | #Kaiaren (sane) | Fangs, Book | Celestial Fists | M9, M11 | After all |

Turn-in: nine scripts check the class: Danl, a_presence, Deep, the lakeofillomen Astral Projection, both Kaiarens, Eejag, Gwan and Vorash (`Q`, `T`). Eejag, Gwan, Vorash and Xenevorash attack only a Monk. Every intermediate is NO DROP and lore, so the Monk must loot and hand in everything.

### Druid: Nature Walkers Scimitar [20490]

Reward: one-hand slash 20/30, hp +10, mana +90, STR +15, STA +15, WIS +20, click Wrath of Nature (55 damage, click level 50), classes Druid (`S`). Staff of Living Brambles is the 2.0 epic and is not in the snapshot.

Five items have no source in the snapshot. The four foraged items (Ripened Heartfruit [20464], Sweetened Mudroot [20465], Speckled Molded Mushroom [20466], Chilled Tundra Root [20467]) and the Rose of Firiona [12774] have no drop, merchant, ground spawn, quest or recipe source, and the snapshot has no forage table. Whether Forage yields them in the game is unknown (`S`, `inf`). The server audit does not mark the Druid chain P99-aligned (`T`).

Scripts (44 steps) are grouped here (`Q`):

| Group | NPCs and zones | Hand in and receive | Source of each item | Party |
| --- | --- | --- | --- | --- |
| Start (1 to 9) | Telin Darkforest (burningwood), Faelin (gfaydark), Giz X`Tin (kithicor), Althele, Sionae, Nuien, Teloa (eastkarana), Ella Foodcrafter (misty) | Worn Note to Earth Stained Note [18959] and Shiny Tin Bowl [17860] | Corruptor L45 drops Fleshbound Tome 100%. Telin needs a Kindly faction, which always passes | 45 to 48 |
| Bowl (10) | Combine four foraged items in the Shiny Tin Bowl | Hardened Mixture [20473] | no source found | Unknown |
| Pattern chain (11 to 21) | Alrik (timorous), Farios (felwitheb), Nora (felwithea), Merdan, Niera (qrg), skeleton (frontiermtns), Kinlo (kaladimb), Pottery Wheel combine | Runecrested Bowl [20460], Softly Glowing Stone [20462] | Jade Reaver [5664] from black reavers L50 citymist, 7 to 10% on 12 spawn rows (6 in each citymist version), 7,200 s. Rose: no source | 48 |
| Venril (22 to 26) | Dance of the Fireflies (Druid spell) to Firefly Globe [10295], Venril Sathirs remains (karnor), Spirit, Venril L55 18,325 hp, Foloal Stormforest (firiona) | Warmly Glowing Stone [20468], then Elaborate Scimitar [20440] at Ella | Resurrection scroll: merchants in rathemtn, freportn, qeynos | Raid |
| Antonica (28 to 32) | tainted mammoth (everfrost), aquagoblin (lakerathe), hill giant (rathemtn), then corrupted versions, Withered Treant (northkarana), Yeka Ias (southkarana) | Chunk of Tundra [20690], Clean Lakewater [20689], Ancient Rock [20688] to Cleansed Spirit of Antonica [20698] | Corrupted mobs L30 to 40 drop at 100%. Tainted mammoth L25 spawn 8%, tainted aquagoblin L36 spawn 20%, tainted hill giant L37 spawn 10% | 25 to 40 |
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
| 2 to 3 | Caradon (hole, L55), then kill Kyrenna L55 | Cell Key [14373] | Blood [14381], Heart [14380] | Key: mimic a_chest L45 to 47 hole, 25%, 6 points over three ids, 640 s | About 50 |
| 4 | Marl Kastane, kerraridge | Blood | Dark Shroud [14377] | step 3 | 46 |
| 5 and 6 | #Ghost_of_Glohnor (hole), kill Mummy of Glohnor L56 | Shroud | Head [14378], Wrappings [14379] | script spawn | About 50 |
| 7 and 8 | Gerot Kastane (paineel), Marl | Head, then Wrappings | Head of the Valiant [14369], Will of Innoruuk [14370] | step 6 | 46 |
| 9 | combine in the Soulcase | Soulcase, Heart | Heart of the Innocent [14368] | steps 1, 3 | any |
| 10 | Teydar, qcat | Drake Spine [14372], Decrepit Hide [14371], Enchanted Platinum Bar [16507] | Decrepit Sheath [14366] | Spine: Rharzar L55 rathemtn 100%, 5% spawn on 7 points. Hide: ashenbone drake L51 hateplane 25%. Bar: Enchanter spell Enchant Platinum (level 34) on a Platinum Bar from merchants | 48 |
| 11 | Duriek Bloodpool, paineel | Ghoulbane [5403], Soul Leech Dark Sword of Blood [11609], Blade of Abrogation [5430], Decrepit Sheath [14366] | Corrupted Ghoulbane [14367] | Ghoulbane: guktop. Soul Leech: Fear golems 10%. Blade of Abrogation: Gorgalosk L60 8.7%, thunder spirit princess L53 8.0%, windrider drake 5.8%, Spiroc Lord 3.3%, most other Sky mobs under 2% | 46 and raid |
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
| W14 | #Venril_Sathir (static), karnor, L55 (50% drop, 72 h) | kill | Gnarled Staff [14338] | | Raid |
| W16 and W17 | Arantir (flag `wizepicB`), Solomen | three staves, then the Magically Sealed Bag [14340] | Staff of the Four | | After all |

Turn-in: no class or level check, and the flags `wizepic`, `wizepicA` and `wizepicB` are quest flags, whose per-character scope is unknown (`inf`). Everything is NO DROP and lore except the Golem Sprocket.

### Ranger: Earthcaller [20488] and Swiftwind [20487]

Rewards: Earthcaller, one-hand slash 14/24, hp +50, STR +15, STA +5, DEX +10, resists +5, proc Earthcall (a 25-tick effect with 20 damage per tick, proc level 50), classes Ranger. Swiftwind, 13/21, haste 40, attack 30, hp +50, STR +15, STA +10, DEX +5, classes Ranger. Both are NO DROP and lore (`S`). Xanuusus gives Earthcaller and Faelin Bloodbriar gives Swiftwind (`Q`).

Scripts: `burningwood/Telin_Darkforest`, `burningwood/Faelin_Bloodbriar`, `kithicor/Giz_X-Tin`, `misty/Ella_Foodcrafter`, `hole/Jaeil_the_Wretched`, `erudnint/Mairee_Silentone`, `kaladimb/Kinlo_Strongarm`, `kaladimb/Usbak_the_Old`, `northkarana/Xanuusus`, `airplane/an_essence_carrier` and `an_essence_harvester`. None of the epic scripts checks the class. Only the Plane of Sky armor tests (`airplane/Ranger_Spirit`) do (`Q`). The server audit keeps the chain enabled but does not call it P99-aligned end to end (`T`).

| Step | NPC, zone, level | Hand in | Receive | Source of each item | Party |
| --- | --- | --- | --- | --- | --- |
| 1 | Druid start (Druid table rows 1 to 9): Telin, Faelin, Giz, Althele, Sionae, Nuien, Teloa, Ella | Fleshbound Tome and the quest items in between | Shiny Tin Bowl [17860] | Dark Elf Corruptor L45 (script-spawned by Teloa), Fleshbound Tome 100% | 45 to 48 |
| 2 | Jaeil the Wretched, hole, L55 (static, 23,400 s) | Shiny Tin Bowl | spawns hostile Jaeil the Insane L55, 20,000 hp, which drops Soulbound Hammer [20478] at 100% | step 1 | About 50 |
| 3 | Mairee Silentone, erudnint, L60 | Soulbound Hammer | Dwarven Smiths Hammer [20479] | step 2 | any |
| 4 | Mairee | Dwarven Smiths Hammer, Swirling Sphere of Color [20494] | Hammer of the Ancients [20485] | Sphere: an_essence_tamer L56 (23,000 hp), drop 100%. It spawns when an_essence_carrier L54 (20,000 hp) dies. Both are in the Plane of Sky and have no static spawn. The carrier's own spawn path was not traced | Raid, zone 46 |
| 5 | Kinlo Strongarm, kaladimb, L50 | Hammer of the Ancients | Small bit of Mithril Ore [20482], spawns Usbak the Old | step 4 | any |
| 6 | Kinlo | Small bit of Mithril Ore | Refined Mithril Blade [20483] | step 5 | any |
| 7 | none (drop) | none | Shattered Emerald of Corruption [20484] | Plane of Hate: Lord of Loathing, Avatar of Abhorrence, Magi P`Tasa, Mistress of Scorn and Master of Spite (spawn 100%), Ashenbone Broodmaster, Grandmaster R`Tal and Coercer T`vala (spawn 50%), all L55 to 58, drop 20%, 1,920 s. Maestro of Rancor and Innoruuk (259,200 s) also drop it at 20% | Raid, zone 46 |
| 8 | Xanuusus, northkarana, L50 | Refined Mithril Blade, Shattered Emerald | Earthcaller, 2,500,000 XP | steps 6, 7 | After all |

Swiftwind follows the Druid chain's Hardened Mixture and Runecrested Bowl (four foraged items without a source, see the Druid section), the Venril Sathir stone, and then Telin (Ancient Longsword, 1,000,000 XP), Usbak, Telin again and Faelin (Swiftwind, 1,000,000 XP). It is blocked by the foraged items (`Q`, `S`).

## Not verified

- No chain was played. The audit docs say the Enchanter, Druid and Ranger chains are not yet P99-aligned end to end, and that the Cleric chain approximates its spawned combat (`T`).
- Whether the live server filters spawn rows by `min_expansion` (Anson) or spawns sole zero-weight groups (Kithicor aides, Echo of Nortlav, `#Brother_Hayle`). The spawning code is not in the exported server (`S`, `T`).
- Whether a class-locked reward can be summoned into another class's inventory (rule 8), whether `AddEXP` is capped (rule 10), and whether a hostile NPC accepts a trade without a charm (Enchanter).
- Whether the Druid's four foraged items and the Rose of Firiona can be obtained in the game.
- Which copy of Plane of Hate (`hateplane` or `hateplaneb`) and of the City of Mist (version 0 or 1) the game uses.
- All minute estimates and all party-level estimates.
