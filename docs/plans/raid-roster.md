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

These are level-60 fights. Level 46 starts raids, and the client caps raid-buff scaling at level 60 (`.re/js/main.pretty.js:22686-22687`). On the first qualifying boss engaged in a fight, Raid Resolve (`encounterAid`, `.re/js/main.pretty.js:22693-22735`) doubles max HP and heals to full for Warriors, Paladins and Shadow Knights, and doubles max mana and refills to full for Clerics. It does not stack across multiple bosses in the same fight, and rune pools (`runePoolsGranted`, `.re/js/main.pretty.js:72050-72065`) are granted once per raid session rather than once per fight.

## How big a raid

Planning ranges, not measured requirements. They assume learned level-60 spells and pets, real tank gear and every unique support line present.

| Targets | Characters | Tanks / Clerics |
| --- | ---: | --- |
| The four Warders | 12-18 | 2-3 / 3-5 |
| Cazic-Thule, Yelinak | 18-24 | 3-4 / 5-6 |
| Vyemm, Tunare | 24-36 | 4-6 / 6-8 |
| Avatar of War, Vulak`Aerr | 30-42 | 5-7 / 8-10 |
| Awakened Kerafyrm | 36 (ranged/caster focus) | 5-6 / 8-10 |

### Kerafyrm and Destroy (`.re/js/BQ.pretty.js` and `C/data/`)

- Death Touch is blocked: the client explicitly filters out NPC casts of Death Touch (`24660` and `982`) via `i5 = [982, 3087, 7477, 24660, 24661, ...]` (`.re/js/BQ.pretty.js:26563-26567`).
- Destroy (`spell 1948`) is a 50-unit caster AE: Kerafyrm (`128089` and `128095`, `npc_spells_id: 489`) has a single spell entry, `Destroy` (`1948`, `recast_delay: 1800` in `npc_spells_entries`, `recast_time: 0` in `spells_new`). It deals `100,000` unresistable (`resisttype: 0`) damage to all raid members and pets within `aoerange: 50` with line of sight (`.re/js/BQ.pretty.js:4803-4900, 26428-26545`).
- Mitigation versus range: Divine Aura only covers the active player actor in raid mode (`.re/js/BQ.pretty.js:4535`), resists do not apply to `resisttype: 0`, and rune pools plus Raid Resolve tank HP are far below `100,000`. Actors standing outside 50 units (caster nukes and ranged attacks have 100 to 200 range) are outside `Destroy`'s `aoerange`.
- Roster decision: do not commit to leveling characters beyond the 36-character (6-group) raid before testing Kerafyrm at level 60, because adding more melee or tanks inside 50 units does not counter `Destroy`.

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

Every level from 14 to 29 followed `1000 * (L-1)^3` cumulative XP (`3,000 * L^2` per level). At level 30 the cumulative requirement steps up by `1.1x` (`levelEnd(30) = 29,700,000 = 1.1 * 1000 * 30^3`, requiring `5,311,000` XP for level 30, about 2 hours at 2.65M XP/h in Unrest). Because the multiplier applies to cumulative XP at the tier boundary, non-transition levels within the same multiplier band return to normal steps.

## Resolved and open questions

- Character-slot limit (resolved): 9 pages of 8 slots give 72 character slots on the account.
- Concurrent sessions (resolved): two browser sessions on the same account can stay in the game world at the same time without disconnecting each other, as long as they control different characters.
- Kerafyrm's Destroy (resolved in code): `spell 1948` is a 50-unit caster AE (`100,000` unresistable damage), while single-target Death Touch (`982`, `24660`) is blocked by the client. Range (>50 units) and the client's handling of `recast_delay: 1800`, not extra tanks beyond 36, decide the fight.
- Open: the server's raid-time price at level 46 to 60, whether the server enforces a raid-size cap, and how Awakened Kerafyrm (`128089` in Sleeper's Tomb versus `114583` in Skyshrine, which has `npc_spells_id: 0`) is spawned or summoned in IdleQuest.
