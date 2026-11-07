# Raid roster plan

Which characters the raid goal needs, how to split them into leveling groups, and what is still unknown. The rules for building and running a group are in the [progression guide](../guide.md). Raid access, resets and Raid Resolve are described in [systems-research.md](systems-research.md).

`C/` is the developer's content snapshot (`~/src/github.com/brynnb/idlequest-content`), `.re/js/` the downloaded client. Boss numbers are snapshot fields, not measured fights.

## What the raids ask for

| Boss | Level | HP | Melee per hit | Weakest resist | Notes |
| --- | ---: | ---: | --- | --- | --- |
| Nanzata the Warder | 70 | 200,000 | 115-442 | cold | Frost Breath, 500 cold area damage and a dispel. |
| Ventani the Warder | 70 | 200,000 | 136-415 | disease | Rampage. Freezing Breath and a silence. |
| Tukaarak the Warder | 70 | 200,000 | 126-405 | fire | Rampage. Silence. |
| Hraashna the Warder | 70 | 200,000 | 137-509 | magic | Rampage. Stream of Acid, 500 per tick and snare. |
| Lord Vyemm | 66 | 350,000 | 250-1,200 | fire, disease | Scream of Chaos area damage, summons. |
| Cazic-Thule | 70 | 450,000 | 223-603 | cold | Rampage, slow immune, Panic proc. |
| Lord Yelinak | 70 | 500,000 | 204-804 | fire | Rampage, slow immune, Ice breath drains mana. |
| Tunare | 70 | 530,000 | 166-926 | none low | Flurry, unresistable root, 800 poison proc. |
| Vulak`Aerr | 70 | 890,000 | 355-1,400 | magic, fire, cold | Ancient Breath, area damage, summons. |
| Avatar of War | 70 | 900,000 | 299-1,154 | cold | Triple and flurry, slow immune. |
| Awakened Kerafyrm | 99 | 3,500,000 | 2,000-7,003 | all 192 | Slow immune. Destroy: unresistable 100,000 area damage. |

Sources: the `npc_types`, `npc_spells` and `spells_new` rows for the Raid Resolve boss IDs in `C/data/`, and the Resolve list in `.re/js/main.pretty.js:22711-22757`.

These are level-60 fights. Level 46 starts raids, but a raid of level-46 characters is not a raid of level-60 ones. Kerafyrm needs a mechanics check before any headcount can be called enough: one Destroy kills anyone without a way to avoid or survive it.

## How big a raid

Planning ranges, not measured requirements. They assume learned level-60 spells and pets, real tank gear and every unique support line present.

| Targets | Characters | Tanks / Clerics |
| --- | ---: | --- |
| The four Warders | 12-18 | 2-3 / 3-5 |
| Cazic-Thule, Yelinak | 18-24 | 3-4 / 5-6 |
| Vyemm, Tunare | 24-36 | 4-6 / 6-8 |
| Avatar of War, Vulak`Aerr | 30-42 | 5-7 / 8-10 |
| Awakened Kerafyrm | 54-72 or more | 8-12 / 14-20 |

The raid shares one set of permanent support and suppresses duplicates of the same spell or family (`.re/js/main.pretty.js:20210-20235,65539-65616`). One Bard, Shaman, Enchanter, Druid and Necromancer cover their lines for the whole raid. Tanks, Clerics and damage are what scale: Raid Resolve doubles tank HP and Cleric mana once per fight, and each Cleric casts independently. A second Bard adds only songs the first does not sing.

## Roster and leveling groups

An 18-character core for the Warders and the first named targets, then a 36-character working raid:

| Order | Leveling group | What it adds |
| ---: | --- | --- |
| 1 | Magician, Warrior, Cleric, Bard, Shaman, Enchanter | The unique support core. Exists. |
| 2 | Warrior, Cleric, Cleric, Rogue, Monk, Druid | Second tank, two Cleric mana pools, melee damage, the Druid's lines. |
| 3 | Warrior, Cleric, Cleric, Rogue, Magician, Necromancer | Completes the core: three tanks, five Clerics, pet damage, mana transfer. |
| 4 | Paladin, Cleric, Rogue, Rogue, Monk, Magician | Fourth tank and more damage. |
| 5 | Shadow Knight, Cleric, Rogue, Rogue, Monk, Wizard | Fifth tank and a second spell damage channel. |
| 6 | Warrior, Cleric, Rogue, Rogue, Monk, Magician | Sixth tank and the last damage tranche. |

Groups 2 and 3 have no slow or crowd control, so they need safer pulls than group 1. If a group cannot level well, repartition within this roster before adding classes it does not need. For the race, Halfling lowers the XP cost of Warriors, Clerics, Druids and Rogues. Human or another neutral race suits Monks, knights and casters.

Epics the roster makes worth chasing, after the Magician's: the Cleric's Water Sprinkler (resurrection click), Rogue Ragebringer, the main Warrior's Jagged Blade, the Bard's Singing Short Sword, Monk Celestial Fists, and the Enchanter's Staff of the Serpent.

## How long it takes

Level 14's live XP values fit `1000 × (L-1)³` cumulative. The high levels are unknown: the wiki says requirements rise unevenly, and classic EQ adds hell-level multipliers from 30. With that classic curve, a character needs about 128M XP to reach 46 and 616M to reach 60.

At group 1's current rate of about 0.9-1.1M XP per character per hour, a character takes about 115-140 hours from 15 to 46 and about 560-680 hours to 60, if the rate holds. Higher levels may pay more per hour, which nothing here measures. Groups level one after another unless two sessions of one account can play at once, so the roster's hours add up group by group.

## Open questions

- The account's character limit. The selector shows at least 72 positions and grows with the count, which is not a cap.
- The raid size limit. The client adds recruits without a numeric cap. The server may still have one.
- Whether two sessions of this account can play at once. This decides whether groups can level in parallel.
- The raid time price at higher levels. It was 2,000 pp an hour at level 7, and the server computes it.
- The XP curve above level 30, and the XP per hour high-level zones pay.
- How Kerafyrm's Destroy is timed and whether anything survives it.
