# Raid roster plan

Which characters the raid goal needs, how to split them into leveling groups, and what is still unknown. The rules for building and running a group are in the [progression guide](../guide.md). Raid access, resets and Raid Resolve are described in [systems-research.md](systems-research.md), the epic ranking in [epics.md](epics.md).

`C/` is the content snapshot (`~/src/github.com/brynnb/idlequest-content`), `.re/js/` the downloaded client. Boss numbers are snapshot fields, not measured fights. Every character is one roster member. No class holds a slot because of the bot or because of who leads group 1. Claims carry one of three labels: a file and line or a measurement (verified), "assumption" (a number this plan chose) or "inference" (reasoning from outside the client, such as P99 or EQEmu knowledge).

## What the raids ask for

| Boss | Level | HP | Melee per hit | Weakest resist | Notes |
| --- | ---: | ---: | --- | --- | --- |
| Nanzata the Warder | 70 | 200,000 | 115-442 | cold | Frost Breath, 500 cold area damage and a dispel. |
| Ventani the Warder | 70 | 200,000 | 136-415 | disease | Rampage. Freezing Breath (750 cold and a slow) and a silence. |
| Tukaarak the Warder | 70 | 200,000 | 126-405 | fire | Rampage. Silence. |
| Hraashna the Warder | 70 | 200,000 | 137-509 | magic | Rampage. Stream of Acid (fire resist type, 500 and 500 damage effects) and a snare. |
| Lord Vyemm | 66 | 350,000 | 250-1,200 | disease, fire | Scream of Chaos 100 magic area damage, summons. |
| Cazic-Thule | 70 | 450,000 | 223-603 | cold | Rampage, slow immune, Panic proc. |
| Lord Yelinak | 70 | 500,000 | 204-804 | fire | Rampage, slow immune, Ice breath (300 and a 50 mana drain). |
| Tunare | 70 | 530,000 | 166-926 | none low | Flurry, unresistable root, 800 poison proc. |
| Vulak`Aerr | 70 | 890,000 | 355-1,400 | magic, fire, cold | Ancient Breath area damage and slow, Gift of Aerr area damage, summons. |
| The Avatar of War | 70 | 900,000 | 299-1,154 | cold | Triple and flurry, slow immune. |

Sources: `npc_types`, `npc_spells`, `npc_spells_entries` and `spells_new` rows for the Resolve boss IDs in `C/data/` (re-read against the rows, the weakest resist is the lowest of MR, FR, CR, DR and PR). The Resolve list is `Ed` in `.re/js/main.pretty.js:22714-22726`. Resists of the Warders run from 79 to 324 and Vyemm's from 80 to 1,000, so resists decide how much of a nuke lands (see "What the engine uses").

Where a boss comes from:

- Raid mode fights the NPC above level 50 that the leader targets in the current zone (`Vd`, `.re/js/main.pretty.js:50654-50656`), with AutoLevel off. The raid target catalog (`MB`, `.re/js/main.pretty.js:25529-27778`) and its budgets (`IB`, 25085-25528) are never read. Only a discarded `Map` is built from the catalog (`.re/js/main.pretty.js:50646`). Unattended raids need raid commands in the SDK.
- In the open world the live server spawns most of them. The spawn list each zone sends on entry (`GetZoneSpawnsResponse`, read with a level-1 character, `runs/state/raid-zone-spawns.json` and `runs/state/sleeper-spawns.json`) gives each NPC a state and a respawn time:

  | Boss | Zone | Open-world state |
  | --- | --- | --- |
  | Cazic-Thule | fearplane | respawning, a timer of a few days |
  | Lord Yelinak | skyshrine | respawning, a timer of a few days |
  | Vulak`Aerr | templeveeshan | respawning, a timer of about a week |
  | Lord Vyemm | templeveeshan | respawning, a timer of under a day, so the game makes him fightable |
  | Tunare | growthplane | the field actor `#_Tunare` (127001) is up. Engaging it spawns the Resolve boss `#Tunare` (127098) and despawns the actor (`growthplane/#_Tunare.lua`) |
  | The Avatar of War | kael | spawned when The Statue of Rallos Zek (113071, level 59, 400,750 HP) dies (`kael/#The_Idol_of_Rallos_Zek.lua`). The statue was respawning |
  | The four Warders | sleeper | `disabled`, so only the daily list or a casino potion brings them |
  | Kerafyrm and The Sleeper | sleeper | `disabled` (128089 and 128094), so Kerafyrm is not fightable in the open world |

  Other players can kill the open-world bosses first, and a kill there starts the respawn timer for everyone.
- The server's daily boss list gives two free resets per account every rolling 24 hours, one kill per boss, and a private copy lasts 24 hours with free resumes and retries (`.re/js/engine.pretty.js:414980`). Which bosses it offers comes from the server.
- The casino table (`.re/releases/20261108T004644-064bc896/pretty/CAUokwED.js:4664-5009`, not the daily list) holds 30 bosses, among them Yelinak, Vulak`Aerr, the Avatar of War, Tunare and the four Warders. It does not hold Vyemm or Cazic-Thule. From level 46 the casino's Items prize wins one boss potion per account per 24 hours for about 3,300 pp on average ([systems-research.md](systems-research.md#boss-summons-and-daily-allowance)).

The daily allowance caps kills at two bosses a day from the daily list plus one from a casino potion, and each boss has a 24-hour cooldown. Ten Resolve bosses therefore take at least four days after the roster is ready. A roster that can kill the four Warders early starts that clock sooner than a larger roster that is ready later.

These are level-60 fights. Level 46 starts raids and only the leader's level is checked (`O7`, `.re/js/main.pretty.js:50651-50653`, `71576`). Recruits of any level can join and keep their level, but the raid spell and pet command set starts at 46 (wiki, raiding). The leader's class package is scaled by its level clamped to 46 to 60 (`$8`, `.re/js/main.pretty.js:50647-50650`). On the first qualifying boss engaged in a fight, Raid Resolve doubles max HP and heals to full for Warriors, Paladins and Shadow Knights, and doubles max mana and refills to full for Clerics (`Dd` and `x01`, `.re/js/main.pretty.js:22734-22757`, `66267-66288`, leader: `y11`, `70726-70750`). It does not stack across several bosses in the same fight. Rune pools are granted once per raid session, not once per fight (`runePoolsGranted`, `.re/js/main.pretty.js:72063-72082`).

Raid time costs platinum per hour for the whole account at a price set by its highest-level character (`.re/js/engine.pretty.js:8944-8947`), so recruits cost no extra. The client has no member limit: recruiting checks only the leader's level, the combat lock, that the character is on the account or in the guild, and duplicates, then asks the server for the recruit's snapshot, and every recruit carries `cost: 0` (`addGuildMember`, `.re/releases/20261108T004644-064bc896/pretty/OSTsR53r.js:71607-71697`). The wiki states no raid size.

The server does not cap raid size at the account's 72. With the leader at 46 it accepted all 71 other account characters as recruits (levels 23 to 45) in about 15 seconds while their groups kept playing them, and a fight with all 72 started and killed an unkempt fanatic in 25 seconds. The client also carries an unused design that would cap it. Each class has a cost of 5 to 7 (Warrior, Paladin, Shadow Knight, Bard, Shaman and Enchanter 6, Cleric 7, the others 5), and 21 budget groups give a budget that shrinks as the leader levels, Cazic-Thule's from 190 at 46 to 142 at 60 (`TB` and the class profiles, `OSTsR53r.js:25091-27782`, 27795 on). Enforced, that would admit 27 to 38 characters to Cazic-Thule under a level-46 leader and 20 to 28 under a level-60 one, depending on the class mix. The client only builds a map from this catalog and discards it (`OSTsR53r.js:50651`), and the server does not apply it.

## What the engine uses

Recruits fight as `guildCharacter` snapshots of their level, stats, skills, AAs, gear and scribed spells (`yQ`, `.re/js/main.pretty.js:64332-64398`). The per-class templates (`NB.classes`, `.re/js/main.pretty.js:27793-34944`, "first-pass raid runner profiles") are mostly not what recruits run on, so numbers from them are not recruit numbers:

- Melee. A recruit's damage comes from its own weapon, skills, double attack, dual wield and backstab through the client's melee engine (`dQ` and `mQ`, `.re/js/main.pretty.js:64069-64108`, called from `o61`, 65693-65740). The template `dpsMin` and `dpsMax` are read only for a roster member without a combat profile (65726), and recruits always have one (64369). Raid Rogue attacks also set `canDefend: false` (65713-65715), so bosses cannot parry, riposte, dodge or block them.
- Defense. A recruit takes full boss damage reduced by its own AC and skills. Its template multiplier is 1 with 0 avoidance (`kp`, 64300, `dJ`, 66067-66074, `Se1`, 68205-68225). The template values (Warrior 0.54 and so on) are not applied.
- Pets. A raid pet's damage is its summon table's min to max damage per attack delay, with a hit chance of 40% to 95% from the pet level against the target level (`c61`, 65741-65770, `Qs`, 65247-65251, tables from `p6`, 65269-65278). The template pet DPS is never read. A level 48 Magician pet ("Greater Vocaration: Earth", 42-60 per 1.8 s) hits a level 70 boss 40% of the time, about 11 DPS before haste and about 20 with the largest haste the pet level allows (`fd`, 20934-20936). A Necromancer pet (level 47, 16-61 per 2.8 s) is about 5.5 to 9.6 DPS and an Enchanter pet about 5 to 9.
- Damage over time. Every attacking member adds the damage per six seconds of the DoT spells it has scribed from its class package, at no mana cost, rolled against the same level based hit chance (60% for level 60 against level 70, `m61`, 65801-65811, `_Ot` in `.re/js/engine.pretty.js:5800-5847`). Per six seconds at level 60 with every package spell scribed: Necromancer 567 (Envenomed Bolt, Cessation of Cor, Vexing Replenishment, Pyrocruor, Heart Flutter), Shaman 400, Shadow Knight 223, Druid 200, Enchanter 168, Magician 132, Ranger 103, Cleric 95. Whether the engine applies resists or immunities to this damage is not visible in the client code read here (unverified). The package spells are on merchant lists in the snapshot.
- Nukes. A recruit nukes with every damage spell it has scribed whose class level it meets (`IQ`, 64464-64511), not with the template list. Only Necromancers, Wizards and Magicians (role "Caster DPS") nuke in the Auto-DPS modes "DPS: Balanced" and "DPS: All Out". Other casters nuke only in "All: All Out" (`s61`, 65178-65180, modes at `.re/js/engine.pretty.js:5511-5530`). The planner scores spells by expected damage after the resist roll, mana efficiency and damage per second of cast plus 1.5 s recovery, and "All Out" scores damage per second alone (`rY`, 60697-60752, weights `WV`, 57820-57825, recovery `l61`, 65680). Resists matter. Against a level 70 boss a level 60 caster faces a resist chance of 30 plus the boss resist (`Ss`, 57022-57056, `Qm`, 57058-57080, `ys`, 57096-57108), so a boss resist of 250 lets about 15% of a nuke through and a resist of 100 lets about 55% through (computed from those functions).
- Mana. Recruits regenerate in combat a small amount per six-second tick: 4 plus one fifteenth of the meditation skill, plus spell and item mana regen (`ZF`, `.re/js/BQ.pretty.js:20173-20175`, `US`, 20325-20338, `ob`, 33016-33061, `e71`, `.re/js/main.pretty.js:57866-57871`). With Clarity II (11) or Koadic's Endless Intellect (14) and some gear that is roughly 30 to 48 per tick, 5 to 8 mana per second (assumption for meditation 235). A level 60 nuke costs 200 to 480 mana per 4 to 9 seconds, so a nuker spends its pool in about 60 to 90 seconds and then casts about one spell a minute. The pool is about 2,600 mana from stats alone at 255 INT or WIS and level 60 (`yD`, 20576-20587) plus gear, and Resolve doubles a Cleric's. Mod Rod (225 HP for 150 mana, spell 1502) is a raid command and the only real top-up. The Necromancer's Covetous and Sedulous Subversion spend 300 or 400 mana to give 100 or 150.
- Buffs. Recruits give raid buffs only from scribed spells in the support catalog `xt` (`.re/js/main.pretty.js:17074-19513`, `Rt`, 20109-20148, `QQ`, 65539-65616). Warriors, Monks and Rogues have no entries. Duplicates and weaker same-family buffs do not stack (20210-20235). One provider per buff line is enough if it has the spell scribed. Each Bard sings at most three chosen songs (`z9`, 51069), so a second Bard adds three songs only if they do not conflict.
- The leader. It joins as `kind: "player"` with no combat profile (`Yt`, 54123-54163). `n8` adds the generated level 60 package of its class instead of its scribed spells, for every class except Bard (66202-66259). The packages that give much are Enchanter (haste 70, mana regen 14 per tick, 700 absorb, stats), Shaman (haste 40 to 50, HP 271 to 510, stats), Cleric (HP 1,150, AC 200, resists 40), Paladin (HP 525), Druid (HP 470, damage shield 32) and Ranger. A Wizard leader adds only a 700-point Spellshield rune (`Ir`, 66113, 66234-66236), a Magician a 35-point damage shield, and Warrior, Monk and Rogue add nothing.
- Disciplines. A real catalog with long reuse (`WW`, `.re/js/main.pretty.js:50669+`). Warrior Defensive lasts 180 s with a 15 minute reuse, Rogue Duelist and Monk Inner Flame add 100% damage for 12 s with a 30 minute reuse, so each is used about once per fight and is worth a few percent of a long fight's damage.

The client calls its class data a generated first pass that needs hand-tuning before live raid combat (`.re/js/main.pretty.js:43143-43147`). The template numbers that stay in use are the `commands` list, the heal list filtered by scribed spells (`MQ`, 64573-64595), the DoT package, the pet tables and the leader package.

### One slot's damage

Model: a level 60 caster, nuke lists from `spells_new` with values from the client's formula (`h2`, `.re/js/main.pretty.js:16735-16893`), the resist model above against the boss resists in `C/data/npc_types`, "All Out" casting from the template mana pool (3,150 to 3,550, an assumption), regeneration 6 mana per second, every merchant spell of level 60 or lower scribed, every DoT package spell scribed. Nuke totals shrink with the pool and the resists, not with fight length. Melee rows are template proxies, not engine output. Totals in thousands of damage per slot:

| Slot | 90 s vs a Warder | 6 min vs Avatar of War or Vulak`Aerr | What drives it |
| --- | ---: | ---: | --- |
| Rogue (template proxy) | 7-10 | 29-42 | Melee, bosses cannot defend. Real value needs gear. |
| Monk (template proxy) | 6-9 | 24-34 | Melee. Real value needs gear. |
| Ranger (template proxy) | 5-7 | 19-28 | Melee and a free DoT of about 10 DPS. |
| Necromancer | 8-11 | 27-29 | Free DoT about 57 DPS, nukes 3-5, pet 0.5-0.9 in 90 s. |
| Shaman | 5-7 | 21-24 | Free DoT 40 DPS, nukes poison and cold. |
| Druid | 8-9 | 16-20 | Nukes 6-9 in 90 s, free DoT 20 DPS. |
| Wizard | 8 | 9-13 | Nukes only, finds the weakest resist, about 5 damage per mana at best. |
| Magician | 4-9 | 13-18 | Nukes magic and fire only (2-6 in 90 s), pet 12-20 DPS, DoT 13 DPS. |
| Enchanter | 3-8 | 10-16 | Nukes 2-7, DoT 17 DPS. |

Reading the table:

- In 90 seconds every damage slot lands between about 3 and 11 thousand, and nukers have spent their mana by then. With the Ancient spells (quest or drop, no merchant) the Wizard rises by 2 to 3 thousand in 90 seconds and 3 to 4 in six minutes. The other classes change by less than 15%, except the Magician against Vulak`Aerr (6 to 11 in six minutes).
- In six minutes the slots that need no mana pull ahead: the Necromancer and Shaman DoT packages and, if the templates are right, melee. A nuker adds little after the first 90 seconds. Mana regeneration changes a nuker's six-minute total by about 15% either way.
- The Magician's pet is about 1 to 2 thousand in 90 seconds and 4 to 7 in six minutes. The earlier claim of 62-90 pet DPS was the unused template. The Magician is not a better raid damage slot than any other caster.
- Bosses with high fire and magic resists (Nanzata, the Avatar of War, Tunare) cut a Magician to a quarter or a half of what it does against Hraashna. A Wizard, with fire, cold, magic, poison and disease spells, is hurt least.
- What would change this: real melee DPS from geared recruits, whether raid DoT damage is resisted, real mana pools and regeneration, how many package spells a recruit has scribed, and whether Mod Rod is used. The first fights at level 46 (below) were against a level 52 enemy without Raid Resolve, so a Resolve boss fight settles these. Until then the simulator below gives a second estimate.

### Simulated fights

`tools/raidsim.mjs` runs the client's own member builder, raid tick and boss engine offline on the newest saved client release, with per-class stats, skills and merchant kits that are assumptions (its header lists them). Against Hraashna the Warder with groups 1 to 3 at level 60, Auto-DPS all out and "CLR: Balanced" auto-heal, all 20 seeded fights ended in a kill after 343 to 606 s (mean 459 s). The Warrior, Paladin and Shadow Knight died in all 20 fights (median 156, 167 and 188 s), the three Clerics in 19 to 20 (median 260 to 291 s) and the Rogue, Wizard, Ranger, Monk, Bard and Magician in 20 of 20 (medians 160 to 291 s). The Shamans, the Druid and the Enchanter never died. DoT damage adds no hate (`_Ot`, `.re/js/engine.pretty.js:5800-5847`), so they are never in the boss's hate list and finish the boss after the rest of the raid is dead.

The deaths are what the client's engine does with these inputs. The boss lands about 109,000 damage per fight on the raid, 240 per second over a fight, spread over most of the members. The three Clerics hold 5,438 mana each under Resolve (`.re/js/main.pretty.js:22711-22740`) and regenerate about 5 per second in combat (`ZF` and `US`, `.re/js/BQ.pretty.js:20173-20175`, `20325-20338`). The auto-heal turns that into 2.3 healed hit points per mana. It casts Complete Healing (25 per mana) only at a target between 30% and 50% of its HP and otherwise picks heals of 1 to 3 per mana (`oq`, `.re/js/main.pretty.js:58079-58171`), so the Clerics are out of mana 100 to 130 s into the fight and the Warrior's median death comes at 156 s. What moves it, 20 seeds each:

| Change | Mean kill | Warrior dies |
| --- | ---: | ---: |
| No auto-heal | 743 s | 20 of 20 at 147 s |
| Three Clerics, "CLR: Balanced" | 459 s | 20 of 20 at 156 s |
| Three Clerics, "CLR: All Out" | 502 s | 20 of 20 at 152 s |
| Six Clerics (three added), "CLR: Balanced" | 306 s | 20 of 20 at 205 s |
| Three Clerics, "All: Balanced" (every class heals) | 317 s | 9 of 20 at 277 s |

Without auto-heal the Paladin and the Shadow Knight die at 71 and 88 s and the Warrior at 147 s, so healing roughly doubles the first two and adds 10 s to the Warrior. More Clerics or healers in other classes help most, because the planner's choice of spells stays the same.

Swapping the group 3 Monk slot through every class (20 seeds each) changed the mean kill time by: Necromancer -123 s, Shaman -81 s, Rogue -49 s, Magician -49 s, Shadow Knight -41 s, Cleric -38 s, Enchanter -36 s, Wizard -23 s, Warrior -19 s, Paladin -17 s, Druid -15 s, Ranger +16 s, Bard +36 s. With these assumed stats, a Necromancer or Shaman is the best extra slot and a Bard, Ranger or Monk the weakest. Re-run it when real recruit stats can replace the assumed ones.

### First fights at level 46

Group 1 (Warrior leader at 46, recruits at 45) fought an unkempt fanatic in the Rathe Mountains (level 52, 3,224 HP, no Raid Resolve) with the raid task (`iqBot.raid`, docs/client-internals.md "How a raid fight runs"). Damage per member, as the raid store counts it:

| Orders | Raid | Kill | Leader (Warrior) | Magician | Bard | Others |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| All Attack only | group 1 | none in 15 min | died twice | 0 | 281, died | Cleric, Shaman, Enchanter 0 |
| Heal, nuke (DPS: Balanced), Run To Target | group 1 | 217 s | 1,462 | 1,403 | 738 | 0 |
| Same plus kept slow and a resist debuff | group 1 | 71 s | 95 (rooted) | 2,818 | 250 | 0 |
| Same | group 1 and a level 26 Paladin | 67 s | 869 | 2,188 | 154 | Paladin 137 |
| Same | all 72 | 25 s | 414 | 923 | among the others | the other 70 recruits, the Bard among them, 1,776 together, at most 105 each |

- Only the Magician nukes under "DPS: Balanced". The Cleric and the Shaman heal, and the Enchanter has no order that fits it until the slow and debuff orders choose its spells. A resist debuff (Malaisement) doubled the Magician's damage per second.
- The fanatic roots the tank with Engulfing Roots, strips slows and debuffs with Nullify Magic every 15 to 20 s and flees at about 20%. The rooted leader cannot follow, so the fight's end waits on nukes.
- "All: Balanced" healing kept every member alive in every fight with orders. Two deaths of the leader in the first fight cost no XP, and a raid Cleric revived him.
- Recruits of levels 23 to 31 add 70 to 105 damage each against a level 52 target. Against level 60 to 70 bosses the roster's damage comes from characters near 60, so these numbers do not size boss raids. The next measurement is a Raid Resolve boss.

### How big a raid

Damage slots needed for a kill in six minutes are the boss HP divided by 360 seconds and a slot's DPS. At 15,000 to 30,000 damage per slot in six minutes (the Avatar column above):

| Boss | HP | Damage slots |
| --- | ---: | ---: |
| The four Warders | 200,000 | 7-13 |
| Lord Vyemm | 350,000 | 12-23 |
| Cazic-Thule | 450,000 | 15-30 |
| Lord Yelinak | 500,000 | 17-33 |
| Tunare | 530,000 | 18-35 |
| Vulak`Aerr, Avatar of War | 890,000-900,000 | 30-60 |

Every character adds some damage, healers and tanks included, so these are upper bounds for the damage-class count. The last two rows are out of reach of 36 characters in six minutes unless the real per-slot damage is at the top of the range. Fights longer than six minutes are limited by healing. A Cleric under Resolve has about 6,700 mana (twice the template's 3,350, an assumption), so 16 Complete Heals of 7,500 HP for 400 mana each (spell 13, cast 10 s plus 2.5 s recovery in `C/data/spells_new`, 7,500 is the template's figure and the client's complete-heal rule `a71`, `.re/js/main.pretty.js:57872-57874`), about 120,000 HP and 200 seconds of sustained casting. Boss melee before mitigation, reading `attack_delay` as tenths of a second (an assumption) and ignoring misses, mitigation, rampage and flurry, is about 150 to 180 DPS for a Warder, 320 to 450 for Cazic-Thule, Yelinak, Tunare and the Avatar of War, and 660 and 880 for Vyemm and Vulak`Aerr. Over six minutes that is 55,000 to 65,000 for a Warder and up to 316,000 for Vulak`Aerr on one tank, so the large bosses need three or more Cleric pools on the tanks plus the raid-wide breaths (200 to 750 each). Low-HP casters take those breaths as tanks do.

Planning ranges, assumptions until a Raid Resolve boss fight:

| Targets | Characters | Tanks / Clerics |
| --- | ---: | --- |
| The four Warders | 12-18 | 2-3 / 3-5 |
| Cazic-Thule, Yelinak | 18-24 | 3-4 / 5-6 |
| Vyemm, Tunare | 24-36 | 4-6 / 6-8 |
| Avatar of War, Vulak`Aerr | 30-42 | 5-7 / 8-10 |

### Kerafyrm

Kerafyrm does not size the roster. All three of his rows in the content snapshot are `untargetable: 1`, his scripts in `C/effective/quests/sleeper/` and `skyshrine/` are empty files, and he is not in the casino table or the raid catalog. The live server's NPC list for `sleeper` marks him targetable (`untargetable: 0`, level 99, 3,500,000 HP), but his spawn and The Sleeper's are `disabled`. If he spawns, re-plan from the Resolve list.

After a client or content update, check again: the client's casino table and Resolve list (the boss lines of the bundle against the last saved release in `.re/releases/`), his NPC definition, which the read-only `iq.query(1004, { zoneName: "sleeper" })` returns from any zone, and his spawn, which the spawn list (opcode 1062) shows only to a character inside the zone ("Your zone is out of sync" from elsewhere).

## Roster and leveling groups

The goal is the strongest roster the account can field at the level cap of 60. Raid kills at 46 are welcome earlier, but no choice of class, race or group may trade strength at 60 for an earlier kill, so class mixes are judged by simulated fights of level-60 rosters first and by fights at 46 to 50 second. The goal also needs every roster character at level 46 or higher, the raid bosses killed and the class epics. The epic of each class needs a character of that class, so the roster holds every class at least once. The groups below are built in this order. Each group levels on its own, and the last column says what it adds to the raid.

| Order | Leveling group | What it adds to the raid |
| ---: | --- | --- |
| 1 | Magician, Warrior, Cleric, Bard, Shaman, Enchanter | Exists. First tank, first Cleric, Magician, Bard songs, Shaman and Enchanter buffs, haste and slows. |
| 2 | Paladin, Cleric, Druid, Necromancer, Rogue, Shaman | Second tank, second Cleric and a Druid healer, first Necromancer and Rogue, a second Shaman. |
| 3 | Shadow Knight, Cleric, Necromancer, Wizard, Ranger, Monk | Third tank, third Cleric, a second Necromancer, the first Wizard, Ranger and Monk. |
| 4 | Warrior, Cleric, Cleric, Shaman, Necromancer, Necromancer | Leveling. |
| 5 to 12 | The groups in `data/roster.json` | See below. |

The roster grows to the 72 slots the character select shows, as 12 groups of six. Three rules shape groups 5 to 12:

1. Each class holds 4 to 8 of the 72, so no class crowds the others out of their gear and epics.
2. Each group levels on its own: a tank (Warrior, Paladin or Shadow Knight), a healer (a Cleric or Druid, or in group 11 a Shaman with a Paladin), a slower (Shaman or Enchanter), pet, DoT or nuke damage, and a leader without a spell table where one fits.
3. Within those limits, Clerics and Shamans sit at the top of the range, because both carry raids and leveling.

That gives 8 Clerics and 8 Shamans, 7 Necromancers, 5 each of Warriors, Druids, Enchanters, Rangers and Bards, and 4 each of the other classes. Simulated level-60 fights with farmable gear (`runs/jobs/2026-11-08-roster72`, 6 fights per boss, up to 1,500 s) show what the balance costs:

| Boss | Balanced 72 | 72 with 19 Shamans and 20 Necromancers |
| --- | --- | --- |
| Vulak`Aerr | 6 of 6 kills, 578 s, 52 deaths | 6 of 6, 265 s, 15 deaths |
| The Avatar of War | 6 of 6, 465 s, 49 deaths | 6 of 6, 269 s, 10 deaths |
| Tunare | 6 of 6, 185 s, 3 deaths | 6 of 6, 152 s, 1 death |
| Lord Yelinak | 6 of 6, 136 s | 6 of 6, 111 s |
| Cazic-Thule | 6 of 6, 132 s | 6 of 6, 98 s |

The balanced roster kills every boss but loses most of the raid on the two hardest. Shamans are the strongest slot in every sweep (a group of a Warrior, a Cleric and four Shamans kills Vulak`Aerr with 36 characters at 60), so the place to buy back margin is more Shamans within rule 1, or a longer fight, not a single-class roster.

### What a leveling group needs

Only group 1 has been measured, from level 8 to 31, so the evidence for any other shape is thin. Its measurements (`bun tools/analyze.mjs runs/2026-11-07-live`, full window and `--last 240m`):

- Damage. At levels 29 to 31 the Magician's two pets dealt 42.5% of the damage, the Warrior 21%, the Magician's own nukes and melee 14%, the Bard 13.6%, the Shaman 4.6%, the Cleric 3.9%, the Enchanter 0%. Over levels 8 to 31 the pets dealt about 42%. These are shares of one group at one level.
- Recovery. The Magician's mana was the last to fill in 2,055 of the 2,713 recovery seconds (76%), the Cleric's in 564 and the Enchanter's in 307. Recovery is 19% of play time and the Magician's nukes are 12% of group damage. Without those nukes the saved recovery is at most 14% of play time and the extra combat time is about 8%, so the net is zero to a few percent, inside the 15% noise between equal blocks. It is not tested.
- Waits. Root and cure waits are about 9% of play time (levels 8 to 31) and 8% (29 to 31). Cure and dispel casts came from the Cleric, Shaman and Enchanter.

No group has levelled without a pet class, a Cleric or a haste, slow and dispel class, so what each is worth is not measured. The roles a group needs, from this evidence and from the code:

| Role | Needed to level unattended? | Scales in a raid? |
| --- | --- | --- |
| Tank | Yes. The Warrior takes the hits and deals 21%. An unattended death ends the run (guide). | Yes. Resolve doubles Warrior, Paladin and Shadow Knight HP. The three tank classes each have an epic. |
| Healer | Yes. Cleric mana is the second recovery limiter. Druid and Shaman healing is unmeasured, so each group keeps a Cleric. | Yes. Resolve doubles Cleric mana, and Complete Heal is the largest heal. |
| Damage, with a pet | Yes, in group 1 pets are 42%. A group without a pet class is untested. | Little. Raid pets are weak (about 11 to 20 DPS for a Magician). A Necromancer's free DoT is the part that scales. |
| Haste, slow, dispel | Unknown. Group 1 has Shaman, Enchanter and Bard and spends 8 to 9% of its time on root and cure waits. | One provider per buff line, the leader's package aside. |
| Melee damage | Unmeasured below level 46. Warrior and Bard melee are 21% and 14% at level 31. | Yes if the real engine DPS is near the templates. Unknown. |

### Choices and alternatives

1. Every class once, so the epic list and the Resolve tanks are complete. Groups 2 and 3 hold the eight classes group 1 lacks (Paladin, Druid, Necromancer, Rogue, Shadow Knight, Wizard, Ranger, Monk). The older plan copied group 1 five times and gave 5 Magicians, 4 Warriors and 6 Clerics, with no evidence that more of those classes help a raid. Mirroring group 1 is the alternative if the raid test shows tanking and healing running out first, and then groups 4 to 6 do it.
2. A Cleric in every group. A tank and a healer are the unmeasured-risk minimum and Clerics scale under Resolve, so the duplicates are not wasted. An all-Druid or Druid and Shaman healing group would save a Cleric slot and risks unattended deaths. Group 2 holds a Druid next to its Cleric so its healing can be compared with group 1's.
3. A pet class in every group, a Necromancer in groups 2 and 3. Pets were 42% of group 1's damage, and the Necromancer adds the largest free DoT in a raid. A second Magician is not chosen. Its raid value is below the Necromancer's, and its pet tables are stronger than the Necromancer's (42-60 per 1.8 s against 16-61 per 2.8 s at the top tier), which matters only for leveling and is untested for a group without the Magician. The Necromancer's leveling value is unmeasured.
4. A second Shaman in group 2 for haste, slow and dispels, because group 2 has no Enchanter or Bard, and its DoT is a raid damage slot (21-24 thousand in six minutes) for a class that levels at the neutral XP factor. A second Enchanter would add only nukes and a DoT in a raid (10-16), and the Bard adds songs only up to three per Bard, so neither is chosen.
5. Wizard once. It is the best burst damage in the first 90 seconds and the only class that always finds a weak resist, but it has no pet, no free DoT, the lowest template HP and AC, and its nukes stop when mana does.
6. Melee once each (Rogue, Ranger, Monk) until the raid test measures the real engine. A Rogue levels on a 0.91 XP factor and a Warrior on 0.90 (wiki, experience-and-zones), about a tenth less XP per level, and a Halfling lowers it by 5% more. That saves some hours over the climb to 46 and does not outweigh a measured raid DPS. Rogue attacks are the only ones bosses cannot defend against (`o61`).
7. Wizard, Enchanter, Necromancer and Magician have the lowest template HP and AC (1,900 to 2,100 HP at level 46 against 3,050 for a Warrior). Their real HP is not measured. They are the group members most at risk from area breaths of 200 to 750 and from unattended deaths in a leveling group.

### Who leads

The leader casts only its memorized spells from the client's static table for its class, with 8 gems and 3 for a Bard (`buildMergedAutoCastData`, `.re/js/BQ.pretty.js:45082-45103`, `.re/js/main.pretty.js:24568-24569`). Companions cast from their whole list. Warrior, Monk and Rogue have no table, so a melee leader loses nothing to the gem limit. A caster leader gives up its spells beyond eight, so each leveling group is best led by a class with no table: Warrior in group 1, Rogue in group 2 and Monk in group 3. The other classes have tables. Epic hand-ins need the active character to be the one doing the step (epics.md), so the leader changes for those steps.

In a raid the leader adds its class package instead of its scribed spells (`n8`). Warrior, Monk and Rogue leaders add nothing, which costs nothing if recruits cover every buff line, and an Enchanter or Shaman leader adds a haste of 40 to 70% without scribing. A recruit gives the same haste only if it has the spell scribed, and the two do not stack. Which class should lead raids therefore depends on which buff lines the scribed recruits leave open. That is a measurement: compare the raid's buff list with and without the leader's package.

Group 1 is led by its Warrior. Under Tagujazolu at levels 33 to 34 in Solusek's Eye the party earned 2.99M XP per hour (Ewbanaqoa 2.89M, `runs/2026-11-08-lead`), 5% below the model's 3.0M to 3.15M. Under Domeyafun at 32 in the same zone the bot reported 3.02M, 5% above the model's 2.87M. Both are inside the 15% noise between equal blocks, so leading with the Warrior costs nothing measurable, and it frees the Magician to cast from his whole spellbook as a companion.

### After the raid test

Groups 4 to 6 follow what the group 1 raid at level 46 and the first full roster show:

- Tanking or healing runs out first: add Warriors and Clerics, one tank and one Cleric in each new group, filled with a Shaman or Necromancer.
- Damage runs out first: add what the test measures as best per slot. If melee matches the templates that is Rogues and Monks, with a Shaman or Necromancer per group for free DoT. If melee is weak it is Necromancers and Shamans.
- Fights end inside 90 seconds: add a second Wizard.
- Buff lines stay open: fill them, one provider per line.

Choose each race by the XP factors in the [guide](../guide.md), which also describes the handover from an earlier group.

## How long it takes

Level L ends at `1000 * L^3 * m` XP times the race and class factor. `m` was 1.0 up to level 29 and 1.1 at 30 and 31 (measured), so level 30 cost 5,311,000 XP and level 31 cost 3,070,100. The steps beyond 31 come from EQEmu's table and are an inference: `m` becomes 1.2 at 35, 1.3 at 40 and 1.4 at 45 and rises at every level from 51 to 59, which puts the start of level 46 at 127,575,000 XP and of level 60 at 616,137,000 for a factor of 1.00 (the second figure assumes `m` of 3.0 at level 59). The client does not hold the table, so check the step at 35. From 21 to 31 the party's XP per hour grew from 1.6M to about 2.4M, slower than the square of the level. By that trend group 1 needs roughly 25 more hours of play to reach 46 and 65 to 95 more from there to 60. Group 1 took about 26 hours from level 8 to 31, so a new group needs about 40 to 55 hours to reach 46. These are planning estimates.

## Resolved and open questions

- Character slots (partly verified): the selector shows at least 9 pages of 8 slots, 72 positions (`.re/js/engine.pretty.js:1415`). That is a user interface minimum, not a server cap. No creation limit has been seen.
- Concurrent sessions (resolved): three sessions on the account play three groups at once, each in its own visible relay tab signed in from the local login, without disconnecting each other (`diary/2026-11-08-c.md`). A hidden tab cannot finish loading the game.
- Kerafyrm (resolved): his open-world spawn is disabled on the live server, so the roster is not sized for him. The daily list is unread until a character reaches 46.
- Raid members and budgets (resolved in code): recruits fight from server snapshots, and the client reads neither the per-target budgets nor the class costs.
- Raid targeting (resolved in code): AutoLevel is off in raid mode and every fight starts from a target the leader picks, so unattended raids need raid commands in the SDK.
- Raid price and daily list (resolved): an hour of raid time costs 2,000 pp with the highest character at 46 or below and 8,000 pp at 52, and the daily list offers ten bosses, of which only Cazic-Thule is a goal boss (systems research, "Hourly price").
- Daily bosses within reach (simulated): `bun tools/raidsim.mjs --roster account --leader Tagujazolu --members <group 1>` kills Phinigel Autropos, Lady Vox, Faydedar, Lord Nagafen and Venril Sathir with group 1's six at 51 and 52, and times out on Talendor, Gorenaire, Trakanon, Innoruuk and Cazic-Thule. A live raid on one of the five checks the simulator before the coordinator spends the free resets on them.
- Raid size (resolved): the server accepted all 71 other account characters as recruits and started a fight with all 72, while their own groups kept playing them ("What the raids ask for").
- Open: the raid-time price at 53 to 60, whether raid DoT damage is resisted, the real damage and HP of geared level 46 to 60 recruits, how a companion Magician or Necromancer replaces its pet at a new tier when it is not the leader, whether level-60 raid buffs such as Aegolism can be bought or must drop, and which class should lead raids.

## Revisit when

- A Raid Resolve boss is within reach (a daily boss summon or a casino potion): fight it and record per-member damage and mana, the buff list and Resolve effects. Then resize the roster and the ranges in "How big a raid" and choose groups 4 to 6 from that fight. The fanatic fights at 46 (above) measured an enemy without Resolve only.
- The client bundle changes: diff the raid-mode code (`Vd`, `yQ`, `QQ`, `n8`, `o61`, `c61`, `m61`), the Resolve list `Ed`, the casino table and Kerafyrm's rows. A raid member limit, a new route to a boss or a targetable Kerafyrm changes what the roster has to beat.
- Group 2 has leveled for two hours: compare its XP per hour, recovery time and root and cure waits with group 1's at the same levels. If a Druid and Cleric healing pair or a group without a Bard or Enchanter does as well, reduce the Cleric and haste duplicates in group 3.
- Raid fights show the limit: move groups 4 to 6 toward Clerics and Warriors when healing or tanking runs out first, and toward the best measured damage slots when fights run long.
