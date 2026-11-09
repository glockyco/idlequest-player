# Magician epic plan

## Scope and evidence

This is a content-backed route, not a claim that the entire quest has been exercised in the running game. The snapshot contains the required quest NPCs, items and final turn-in scripts. Spawn and loot availability in the deployed game remain unverified. Do not substitute P99 spawn timers, faction tricks, underwater mechanics or island travel instructions for observed IdleQuest behavior.

Source shorthand below resolves to these local files:

- `C` = `~/src/github.com/brynnb/idlequest-content`.
- `P99` = `C/reference/p99-wiki/raw-pages/magician-epic-quest-0b99903f7d.wiki`. Its checklist and walkthrough provide the collection order and encounter context.
- `N/<file>` = `C/data/npc_types/<file>.ndjson`. NPC IDs identify the exact records, including names containing punctuation.
- `I/<file>` = `C/data/items/<file>.ndjson`. Item IDs identify the exact records.
- `Q/<zone>/<name>` = `C/effective/quests/<zone>/<name>.lua`. These are executable snapshot turn-in definitions, not just P99 dialogue.
- `L` = `C/data/loottable_entries/*.ndjson` joined to `C/data/lootdrop_entries/*.ndjson` by `lootdrop_id`, then to each NPC's `loottable_id`.
- `S` = `C/data/spawnentry/*.ndjson` joined to `C/data/spawn2/*.ndjson` by `spawngroupID`. The zone short names below come from these spawn records. Zone names and entry levels come from `C/data/zone/*.ndjson`.

Each farming row below was checked against NPC records, item records, `L` and `S`. Presence means snapshot presence, not a guaranteed drop or a live-game test. A scripted spawn can legitimately have no static spawn record. Drop chances, spawn chances, points and respawn times for the farm rows are in the Magician additions table in [epics.md](epics.md#magician-additions).

The public IdleQuest wiki is https://idlequest.net/wiki. A direct read returns the application shell, not its rendered article. The repository's recorded wiki text, `.re/wiki-loot.txt`, says that Options > General > Keep Epic Quest Items protects epic items, intermediate items and prerequisite ingredients, including duplicates, from automatic cleanup. Leave it enabled. This is recorded wiki guidance, not a fresh verification of the setting. The recorded wiki zone inventory, `data/idlequest-zones.json`, includes the route's classic zones, including West Commonlands, Plane of Sky, Plane of Hate and Lesser Faydark. Neither capture establishes live NPC availability.

## Level and difficulty key

The spell itself requires Magician level 46: spell 1944, `Summon Orb`, has `classes13 = 46` in `C/data/spells_new/3.ndjson`. The inspected turn-in scripts do not impose a separate player-level check. The snapshot zone records require level 46 for `airplane`, `hateplane` and `hateplaneb`, and level 0 for `hole` (`C/data/zone/0.ndjson`, `1.ndjson`). Earlier collection therefore can begin before 46.

In the tables, "none in script" means no explicit level gate was found in that turn-in script. Mob levels are copied from the snapshot. Solo, group and raid are planning estimates, not measured IdleQuest encounter results. Treat dungeon pulls as group work while leveling and the planar objectives as raid work. P99 recommends level 46+ for the overall quest and describes the hardest fights as group or raid encounters (`P99`, lines 13-14, 200-219, 231-255).

Keep one of every listed component. Turn-ins consume the components. Do not confuse raw Shovel and Broom with Shovel of Ponz and Broom of Trilon, or the item named Power of the Orb with another item having the same name.

## 1. Optional introduction

| Action | NPC and zone | Required items and result | Required level and difficulty | Snapshot evidence |
|---|---|---|---|---|
| Ask about Magi'kot | Rykas, `lakerathe` | No input. Say `Magi` to obtain Token of Mastery (28035). | None in script. Solo travel. | NPC 51045 present in `N/9`. Token in `I/c`. `S`, `Q/lakerathe/Rykas`, `P99` lines 94-104. |
| Deliver token | Jahsohn Aksot, `commons` | Token of Mastery. This introduces the page collection, not a required ingredient for later turn-ins. | None in script. Solo travel. | NPC 21043 present in `N/4`, static spawn in `commons`. `Q/commons/Jahsohn_Aksot`, `P99` lines 104-120. |

P99 calls this introduction optional. The snapshot's later page turn-in does not require a token or prior quest flag (`Q/commons/Jahsohn_Aksot`). Use `commons` for West Commonlands. There is also a Jahsohn record and script for the later zone `commonlands`, but that is not the classic West Commonlands zone (`N/c`, NPC 408027, `C/data/zone/2.ndjson`, `4.ndjson`).

## 2. Words of Magi'kot

Collect all three different pages, then trade them together.

| Farm or turn-in | Zone | Required item or result | Required level and expected difficulty | Snapshot evidence |
|---|---|---|---|---|
| enraged dread wolf, level 40 | `kithicor` | Torn Page of Magi`kot pg. 1 (28000) | No known item gate. Group around the mob's level, solo later. P99 says nighttime. IdleQuest time restriction unverified. | NPC 20050, `N/0`. Item `I/5`. `L`, `S`, `P99` lines 114-116. The snapshot also gives this page to dread wolf 20280, level 30 (`N/8`). |
| a tentacle terror, levels 29-33 | `unrest` | Torn Page of Magi`kot pg. 2 (28001) | No known item gate. Group while leveling, solo later. | NPCs 63043, 63044, 63081, 63090 in `N/7`, `8`, `c`. Item `I/5`. `L`, `S`, `P99` line 115. Do not substitute Najena terrors. |
| a bloodthirsty ghoul, levels 40-42 | `gukbottom` | Torn Page of Magi`kot pg. 3 (28002) | No known item gate. Group, solo later if capable. | NPCs 66137, 66138, 66147 in `N/d`, `f`, `4`. Item `I/d`. `L`, `S`, `P99` line 116. |
| Jahsohn Aksot | `commons` | Pages 28000 + 28001 + 28002 give Words of Magi`kot (28003) | None in script. Solo turn-in. | NPC 21043, `N/4`. Result `I/c`. `Q/commons/Jahsohn_Aksot`. |

## 3. Power of the Elements

| Farm or turn-in | Zone | Required item or result | Required level and expected difficulty | Snapshot evidence |
|---|---|---|---|---|
| a gypsy dancer, levels 24-25 | `mistmoore` | Power of Wind (28037) | No known item gate. Group at camp level, solo later. | NPCs 59144, 59084 in `N/b`, `e`. Item `I/4`. `L`, `S`, `P99` lines 140-141. |
| blazing elemental, level 25, or lava elemental, level 35 | `soldunga` | Power of Fire (28036) | No known item gate. Group while leveling, solo later. The lava elemental is the better source (28% drop on a 25% spawn, against 2% for the blazing elemental). | NPCs 31006, 31143 in `N/5`, `2`. Item `I/6`. `L`, `S`, `P99` lines 143-146. |
| enraged, famished or gorged ravener (100%), or hungered ravener (35%), levels 32-36 | `kaesora` | Power of Water (28039) | No known item gate. Group while leveling, solo later. | NPCs 88029, 88094, 88038, 88083, 88069 in `N/9`, `3`, `1`. Item `I/e`. `L`, `S`, `P99` lines 148-151. |
| a faerie guard, levels 24-26, or a fairy guard, level 25 | `lfaydark` | Power of Earth (28038) | No known item gate. Group at camp level, solo later. | NPCs 57053, 57101, 57051, 57123 in `N/8`, `d`, `9`, `c`. Item `I/e`. `L`, `S`, `P99` lines 153-154. |
| Walnan | `butcher` | Powers of Fire 28036 + Wind 28037 + Earth 28038 + Water 28039 give Power of the Elements (28031) | None in script. Solo turn-in. | NPC 68087, `N/8`. Result `I/7`. `Q/butcher/Walnan`. |

## 4. Words of Mastery

| Farm or turn-in | Zone | Required item or result | Required level and expected difficulty | Snapshot evidence |
|---|---|---|---|---|
| a magician, levels 10-22, or a goblin magician, levels 17-19 | `najena` | Torn Page of Mastery Fire (28027), Wind (28028), Earth (28029), Water (28030). Save raw Broom (16544) and Shovel (16545) here too. | No known item gate. Group while leveling, solo later. Lowest-level useful collection stop in this route. | Examples: NPC 44088 in `N/0`, 44075 in `N/3`, 44019 in `N/8`. Pages in `I/2`, `e`, `8`. Raw tools in `I/3`, `d`. `L`, `S`, `P99` lines 170-172, 218-219. |
| Akksstaff | `najena` | Four different Mastery pages give Words of Mastery (28004) | None in script. Solo turn-in if the camp is safe. | NPC 44063, `N/7`. Result `I/9`. `Q/najena/Akksstaff`. |

P99 also lists alligators in `ct` as page sources. The inspected snapshot loot joins did not produce a `ct` alligator with these pages. Use the verified Najena route rather than relying on that P99 alternative. The same query did produce the pages on Najena magicians, so this is not merely an empty search (`L`, `S`, `P99` lines 51-56, 172).

## 5. Power of the Orb

Give Rykas in `lakerathe` Words of Magi`kot (28003), Words of Mastery (28004) and Power of the Elements (28031) together. Receive Power of the Orb (18958). Required level: none in script. Difficulty: solo turn-in. NPC 51045 and the output item are present (`N/9`, `I/8`, `Q/lakerathe/Rykas`, `P99` lines 178-186).

Use item 18958. The snapshot also contains another Power of the Orb, item 28005 in `I/1`, but Jennus explicitly requires 18958. The first three branches and this tome are prerequisites for Fire, not inputs to the Earth, Water or Wind turn-ins (`Q/skyfire/Jennus_Lyklobar`, `Q/firiona/Tiblner_Milnik`, `Q/cauldron/Jinalis_Andir`, `Q/airplane/Kihun_Solstin`).

## 6. Element of Fire

| Farm or turn-in | Zone | Required item or result | Required level and expected difficulty | Snapshot evidence |
|---|---|---|---|---|
| #Neh`Ashiir, level 54 | `citymist` | Torch of the Elements (28007) | No known item gate. Strong group. P99 describes the target as level 53 and recommends a solid group. | NPC 90184, `N/3`. Item `I/3`. `L` contains a torch entry with chance 25 in `C/data/lootdrop_entries/0.ndjson`. `P99` line 200. |
| Gylton, level 42, or Phurzikon, level 47, or Nezekezena, level 51 | `burningwood` | Burning Embers (28008) | No known item gate. Group while leveling. Gylton is the first target to try by mob level. | NPCs 87070, 87148, 87034 in `N/2`, `8`, `4`. Item `I/d`. `L`, `S`, `P99` line 201. |
| Undertow, level 49 | `kedge` | Blazing Wand (10376) | No known item gate. Group. | NPC 64087, `N/b`. Item `I/9`. `L`, `S`, `P99` line 202. |
| Jennus Lyklobar | `skyfire` | Power of the Orb 18958 + Torch 28007 + Blazing Wand 10376 + Burning Embers 28008 give Element of Fire (28009) | None in script. Solo turn-in with safe travel. | NPC 91046, `N/0`. Result `I/5`. `Q/skyfire/Jennus_Lyklobar`. |

Neh is a triggered encounter, not a missing NPC. Black reaver death scripts can spawn NPC 90184 (`Q/citymist/90000`, `Q/citymist/90192`). Kill that version for the torch. The version 0 placeholder (NPC 90000) spawns Neh on 20% of its deaths and the version 1 placeholder (NPC 90192) on 15%, and otherwise the placeholder respawns at once, so the reavers die in a chain. The separate hostile Shaman turn-in replacement, NPC 90181, exists but its loot table does not contain the torch (`N/c`, `L`, `Q/citymist/%23Neh-Ashiir`, `Q/citymist/%23Neh-Ashiir_`). Do not assume every similarly named Neh is interchangeable.

## 7. Earth prerequisite tools

Vira in `soltemple` constructs both tools. NPC 80015 is present (`N/d`, `S`). Required level: none in script. Turn-ins are solo, with farming difficulty noted below. P99 mentions Temple of Solusek Ro faction requirements, but `Q/soltemple/Vira` has no explicit faction check in its item branches. Actual safe NPC interaction remains unverified.

| Tool | Collect one of each | Source NPCs and zones | Snapshot evidence |
|---|---|---|---|
| Broom of Trilon (6360) | Broom (16544), Cyclops Toes (16543), Griffon Feathers (16538), Star Ruby (10032) | Broom from Najena magicians. Toes from a cyclops, levels 28-31, in `rathemtn` (11.9%), or from the western Karana cyclops NPC 12197 in `qey2hh1` (100%). Feathers from a griffawn, levels 13-17, in `northkarana` or `eastkarana`. Merchants sell Star Ruby, among them Turga in `lakerathe` and Zok_Pirk in `rathemtn`. Solo feather farming, group for cyclops at camp level. | Raw and reward items present in `I/3`, `1`, `6`, `8`, `d`. Example NPCs 50305 (`N/4`), 50316 (`N/0`), 13003 (`N/0`), 15038 (`N/2`). `L`, `S`, `Q/soltemple/Vira`, `P99` line 219. Merchant rows checked in `S` merchantlist. |
| Shovel of Ponz (6361) | Shovel (16545), Hill Giant Toes (16539), Gargoyle Eye (10014), Ruby (10035) | Shovel from Najena magicians. Toes from a hill giant, levels 33-37, in `rathemtn` (10%), or from a dreadlands mountain giant, levels 30-40 (36 to 40%). Eye from a gargoyle, level 19, in `oot`. Merchants sell Ruby, among them Turga in `lakerathe` and Zok_Prolo and Darfumpel_Zirubbel in `rathemtn`. Group for hill giants while leveling, solo eye farming later. | Items present in `I/d`, `3`, `5`, `a`. Example NPCs 50279 (`N/0`), 50297 (`N/e`), 69123 (`N/0`). `L`, `S`, `Q/soltemple/Vira`, `P99` line 218. Merchant rows checked in `S` merchantlist. |

Trade each recipe's four ingredients together to Vira. Do not hand the raw tools to Tiblner. Najena avoids relying on P99's Feerrott tool alternatives and lets the Mastery pages and both tools be collected together (`L`, `Q/soltemple/Vira`, `P99` lines 218-219).

## 8. Element of Earth

| Farm or turn-in | Zone | Required item or result | Required level and expected difficulty | Snapshot evidence |
|---|---|---|---|---|
| Magi P`Tasa, level 56 | `hateplane` or `hateplaneb` | Staff of Elemental Mastery: Earth (11567) | Zone minimum 46. Raid plan, although P99 allows a very strong group. | NPCs 76019 (`N/d`) and 186157 (`N/3`). Item `I/3`. `L`, `S`, `P99` line 216. The `hateplaneb` NPC has spawn weight 0. Forsaken revenants carry the staff too, at 0.04% in `hateplane` and 2.7 to 3.0% in `hateplaneb`. |
| Slixin Klex, level 50 | `burningwood` | Dirt of Underfoot (28042) | No known item gate. Group. | NPC 87047, `N/7`. Item `I/6`. `L`, `S`, `P99` line 217. |
| Tiblner Milnik | `firiona` | Earth staff 11567 + Dirt 28042 + Broom of Trilon 6360 + Shovel of Ponz 6361 give Element of Earth (28032) | None in script. Solo turn-in with safe travel. | NPC 84160, `N/e`. Result `I/6`. `Q/firiona/Tiblner_Milnik`. |

The snapshot also gives the Earth staff to Innoruuk, NPC 76007, level 70 (`N/5`, `L`, `S`). P99 describes Innoruuk as the former pre-Velious source. Do not make that harder encounter the primary route. Use the staff-bearing Magi or revenants instead (`P99` line 216).

## 9. Element of Water

| Farm or turn-in | Zone | Required item or result | Required level and expected difficulty | Snapshot evidence |
|---|---|---|---|---|
| Phinigel Autropos, level 53 | `kedge` | Staff of Elemental Mastery: Water (11569) | No explicit item gate. Raid or multiple strong groups. P99 describes a level 50 target and two to three groups. | NPC 64001, `N/e`. Item `I/e`. `L`, `S`, `P99` line 231. |
| Captain Rottgrime, level 55 | `overthere` | Tears of Erollisi (28040) | No known item gate. Strong group or raid, including nearby adds. | NPC 93085, `N/f`. Item `I/9`. `L`, `S`, `P99` line 232. |
| Tarbul Earthstrider, level 48 | `eastkarana` | Rain of Karana (28041) | No known item gate. Group. | NPC 15171, `N/d`. Item `I/c`. `L`, `S`, `P99` line 233. |
| Jinalis Andir | `cauldron` | Water staff 11569 + Tears 28040 + Rain 28041 give Element of Water (28006) | None in script. Solo turn-in if faction allows safe interaction. | NPC 70028, `N/e`. Result `I/7`. `Q/cauldron/Jinalis_Andir`, `P99` lines 235-237. |

P99 inconsistently spells the giant Tarbul and Trabul. The snapshot record is Tarbul_Earthstrider. The snapshot also places Rain of Karana on Undertow, so check his loot while farming the Blazing Wand before making a separate giant trip (`N/b`, NPC 64087, `L`). P99's evil-race faction warning does not prove this Erudite character's actual standing with Jinalis (`P99` lines 233-237).

## 10. Element of Wind

| Farm or turn-in | Zone | Required item or result | Required level and expected difficulty | Snapshot evidence |
|---|---|---|---|---|
| a greater sphinx, level 54, an undine spirit, level 53, or crown-bearing drakes | `airplane` | Crown of Elemental Mastery (20764) | Zone minimum 46. Raid. | NPCs 71001 (`N/7`), 71000 (`N/6`), and drakes 71002-71004 (`N/1`, `2`). Item `I/3`. `L`, `S`. P99 says seventh-island mobs, lines 251-253. Snapshot island access and positions have not been checked, so do not assume a P99 seventh-island restriction applies to every listed source. |
| an elemental warrior, levels 38-40 | `hole` | Elemental Binder (28043) | Snapshot zone minimum 0. Group while leveling, solo later if capable. | NPCs 39005 (`N/d`), 39000 (`N/3`), 39001 (`N/0`). Item `I/3`. `L`, `S`, `P99` line 252. |
| #Quillmane, level 30 | `southkarana` | Pegasus Feather Cloak (2463) | No known item gate. Solo later. Spawn discovery may need separate attention. | NPC 14139, `N/5`. Item `I/9`. `L`, `S`, `P99` lines 253-261. P99's exact placeholder and tracking procedure is not verified for IdleQuest. |
| Kihun Solstin | `airplane` | Crown 20764 + Binder 28043 + Cloak 2463 give Element of Wind (28033) and Master of Elements spawn | Zone minimum 46. Solo turn-in within a raid-zone trip. | NPC 71055, `N/e`. Result `I/4`. `Q/airplane/Kihun_Solstin`. |

## 11. Final spell and orb

Have all four Elements ready before the final turn-in. In `airplane`, give Master of Elements Earth (28032), Fire (28009), Water (28006) and Wind (28033) together. Receive Spell: Summon Orb (19436). Required level: 46 for the zone and for scribing the spell. Difficulty: solo turn-in after raid collection (`Q/airplane/%23Master_of_Elements`, `I/7`, `C/data/spells_new/3.ndjson`, `P99` line 267).

If the Master is absent, tell Kihun Solstin `I want to see the master`. His script matches `see the master` and spawns NPC 71040. The Master has no static spawn record because this is a scripted spawn. His script sets a depop timer of 180000 milliseconds, so prepare the four items before summoning him (`N/9`, `Q/airplane/Kihun_Solstin`, `Q/airplane/%23Master_of_Elements`).

Scribe spell 1944, named `Summon Orb` in the snapshot, and cast it to summon Orb of Mastery (28034). The orb's click effect is spell 1936. This resolves the naming difference from the requested "Summon Orb of Mastery": the verified scroll is Spell: Summon Orb, the spell is Summon Orb, and its summoned item is Orb of Mastery (`I/7`, `I/c`, `C/data/spells_new/3.ndjson`). Casting and pet behavior have not been tested in IdleQuest.

## Snapshot differences and remaining uncertainties

- No mandatory NPC or item in this route was absent from the inspected snapshot. Neh and the Master need scripted spawning rather than a static spawn (`Q/citymist/90000`, `Q/citymist/90192`, `Q/airplane/Kihun_Solstin`). This does not establish deployed-game completion.
- P99's `ct` alligator page alternative was not found in the checked loot and spawn joins. Najena is present and covers the requirement (`L`, `S`, `P99` line 172).
- Some levels differ from P99, including Neh, Phinigel, Gylton, Nezekezena and the raveners. Use the snapshot levels in the tables for planning, not P99 level descriptions (`N/3`, `e`, `2`, `4`, `9`, `P99` lines 149, 200-202, 231).
- The snapshot has additional useful drop sources, including Rain on Undertow, the western Karana cyclops for Cyclops Toes and page 1 on dread wolves. These are alternatives in the data, not observed farming results (`L`, `S`).
- P99 timers, multiquesting, lockpicking, crowd-control tactics, faction workarounds, exact placeholders and raid sizes are not confirmed IdleQuest requirements. The public wiki shell and recorded loot article do not settle them (https://idlequest.net/wiki, `.re/wiki-loot.txt`).

## Start farming while leveling

These are planning bands, not new hard level requirements. The party's zone rotation is the band rows in `data/band-rotations.json`. Pieces from rotation zones need no extra trip. Every other piece is an errand (`iq.errand`) that hunts the named enemies without keeping a weak zone in the rotation. Use a group at the lower end of each band and defer anything the party cannot safely kill. Mob levels and sources are in the numbered steps above, rates in [epics.md](epics.md#magician-additions).

1. Levels 10-22: collect all four Mastery pages plus raw Broom and Shovel in `najena`, which is in the rotation rows from 14 to 21, so a group passing those levels hunts there when it is the row's least crowded zone or the next one in turn. Pull the pages to a Magician with Inventory Search. Save Griffon Feathers from level 13-17 griffawns in the Karanas and Gargoyle Eye from the level 19 gargoyle in `oot` (steps 4 and 7).
2. Levels 22-30: `unrest` is in the rotation from 26 to 30 (page 2) and `soldunga` from 26 (Fire). Run errands for Wind in `mistmoore`, Earth in `lfaydark`, Cyclops Toes in `qey2hh1` and the cloak from level 30 Quillmane (steps 3, 7 and 10).
3. Levels 31-37: `soldunga` stays in the rotation (Fire from lava elementals). Run errands for Power of Water in `kaesora`, Hill Giant Toes in `dreadlands` and page 2 in `unrest`. Buy the two gems and complete Vira's tools when ingredients are ready (steps 2, 3 and 7).
4. Levels 38-42: run errands for Elemental Binder in `hole`, page 1 in `kithicor`, page 3 in `gukbottom` and Burning Embers in `burningwood`. `citymist` is in the rotation from 38. Complete the preliminary turn-ins for Power of the Orb (steps 2, 5, 6 and 10).
5. Level 46+: organize planar farming for Earth staff and Crown. In parallel, group for Tarbul, Undertow, Slixin and Neh. Check Undertow for both Wand and Rain (steps 6, 8, 9 and 10).
6. Once the raid or strong groups can handle them: kill Phinigel and Captain Rottgrime, finish all four Element turn-ins, then summon the Master and obtain the spell (steps 9-11).
