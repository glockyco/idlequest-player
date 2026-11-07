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

Only Cazic-Thule of these is in the client's raid target catalog (`MB`, `.re/js/main.pretty.js:25529-27778`), which otherwise lists Classic and Kunark targets from Lord Nagafen to Veeshan's Peak. The other goal bosses are in the Raid Resolve list (`Ed`, `.re/js/main.pretty.js:22714-22726`), and all but Vyemm and Kerafyrm are in the daily summon list (`.re/js/OK.pretty.js:4651-5003`). How raid mode offers a target outside the catalog is open.

These are level-60 fights. Level 46 starts raids, and the client caps raid-buff scaling at level 60 (`.re/js/main.pretty.js:22686-22687`). On the first qualifying boss engaged in a fight, Raid Resolve (`encounterAid`, `.re/js/main.pretty.js:22693-22735`) doubles max HP and heals to full for Warriors, Paladins and Shadow Knights, and doubles max mana and refills to full for Clerics. It does not stack across multiple bosses in the same fight, and rune pools (`runePoolsGranted`, `.re/js/main.pretty.js:72050-72065`) are granted once per raid session rather than once per fight.

## How big a raid

Planning ranges, not measured requirements. They assume learned level-60 spells and pets, real tank gear and every support line present. The client also carries a budget per target and leader level (`IB.budgetsByLeaderLevel`, `.re/js/main.pretty.js:25085-25528`) and a cost per class, but no client code reads either: nothing reads `.cost`, and the catalog only fills a `Map` that is thrown away (`.re/js/main.pretty.js:50646`). They do not size the raid. Whether the server caps raid size is open.

| Targets | Characters | Tanks / Clerics |
| --- | ---: | --- |
| The four Warders | 12-18 | 2-3 / 3-5 |
| Cazic-Thule, Yelinak | 18-24 | 3-4 / 5-6 |
| Vyemm, Tunare | 24-36 | 4-6 / 6-8 |
| Avatar of War, Vulak`Aerr | 30-42 | 5-7 / 8-10 |

### Kerafyrm and Destroy (`.re/js/BQ.pretty.js` and `C/data/`)

- Death Touch is blocked: the client explicitly filters out NPC casts of Death Touch (`24660` and `982`) via `i5 = [982, 3087, 7477, 24660, 24661, ...]` (`.re/js/BQ.pretty.js:26563-26567`).
- Destroy (`spell 1948`) is a 50-unit caster AE: Kerafyrm (`128089` and `128095`, `npc_spells_id: 489`) has a single spell entry, `Destroy` (`1948`, `recast_delay: 1800` in `npc_spells_entries`, `recast_time: 0` in `spells_new`). It deals `100,000` unresistable (`resisttype: 0`) damage to all raid members and pets within `aoerange: 50` with line of sight (`.re/js/BQ.pretty.js:4803-4900, 26428-26545`).
- Mitigation versus range: Divine Aura only covers the active player actor in raid mode (`.re/js/BQ.pretty.js:4535`), resists do not apply to `resisttype: 0`, and rune pools plus Raid Resolve tank HP are far below `100,000`. Actors standing outside 50 units (caster nukes and ranged attacks have 100 to 200 range) are outside `Destroy`'s `aoerange`.
- Kerafyrm does not size the roster. All three of his rows are `untargetable: 1`, his scripts in `C/effective/quests/sleeper/` and `C/effective/quests/skyshrine/` are empty files, and he is in neither the daily summon list nor the raid catalog.

Recruited characters fight as `guildCharacter` members built from a server snapshot of their level, stats, skills, AAs, gear and scribed spells (`yQ`, `.re/js/main.pretty.js:64332-64375`). Their raid-wide buffs come from the spells they have scribed (`QQ`, `.re/js/main.pretty.js:65539-65616`), and a second copy of a buff, or a weaker spell of the same family, does not stack (`.re/js/main.pretty.js:20210-20235`). One provider per buff line is therefore enough, as long as it has the spell scribed. The leader is the exception. It joins as `kind: "player"` (`Yt`, `.re/js/main.pretty.js:54123-54163`), and `n8` adds the generated package of its class instead of its spells (`.re/js/main.pretty.js:66202-66259`). A Wizard leader gives every member a 700-point Spellshield rune (`Ir`, `.re/js/main.pretty.js:66113,66234-66236`).

### What scales

The level-60 class templates (`NB.classes`, `.re/js/main.pretty.js:27780-34944`) give the numbers below. The client calls its class data a generated first pass that needs hand-tuning before live raid combat (`.re/js/main.pretty.js:43143-43147`), and recruits fight with their own combat profiles, so read the numbers as relative strengths.

- Warriors take 0.54 of boss damage with 12% avoidance, and Defensive Discipline has a 0.45 mitigation multiplier. Paladins take 0.64 and have Lay on Hands. Shadow Knights take 0.65 and have Harm Touch and Leechcurse. Raid Resolve doubles the HP of all three once per fight.
- Clerics have 3,350 mana, which Raid Resolve doubles once per fight, and Complete Heal restores 7,500 HP for 400 mana.
- Rogues deal 80 to 116 melee DPS, and Duelist Discipline multiplies it by 1.5. Raid melee sets `canDefend: false` for Rogue attacks, so bosses never parry, riposte, dodge or block them (`o61`, `.re/js/main.pretty.js:65693-65723`).
- Monks deal 66 to 94 melee DPS, take 0.78 of boss damage with 24% avoidance, and Inner Flame doubles their melee damage for 12 seconds.
- Magicians add a pet with 62 to 90 DPS and Shock of Steel for 1,120 every 3.8 seconds.
- Necromancers add 115 DPS over time, a pet with 40 to 64 DPS and a 720-point lifetap.

## Roster and leveling groups

Six groups of six, built in this order. Each group levels on its own, and the last column says what it adds to the raid.

| Order | Leveling group | What it adds to the raid |
| ---: | --- | --- |
| 1 | Magician, Warrior, Cleric, Bard, Shaman, Enchanter | Exists. Cleric, Bard, Shaman and Enchanter buffs, slows and crowd control. |
| 2 | Magician, Paladin, Cleric, Enchanter, Rogue, Druid | A second tank with Lay on Hands, Druid buffs and heals, the first Rogue, a second Cleric, Magician and Enchanter. |
| 3 | Magician, Shadow Knight, Cleric, Bard, Rogue, Wizard | A third tank, Wizard nukes, a second Bard and Rogue, a third Cleric and Magician. |
| 4 | Magician, Warrior, Cleric, Shaman, Monk, Ranger | Ranger buffs, the first Monk, a second Warrior and Shaman, a fourth Cleric and Magician. |
| 5 | Magician, Warrior, Cleric, Enchanter, Rogue, Necromancer | The first Necromancer, a third Warrior, Rogue and Enchanter, a fifth Cleric and Magician. |
| 6 | Necromancer, Warrior, Cleric, Bard, Rogue, Monk | A fourth Warrior and Rogue, a second Monk and Necromancer, a sixth Cleric and a third Bard. A melee class leads it. |

The 36 characters are 6 tanks (4 Warriors, a Paladin and a Shadow Knight), 7 healers (6 Clerics and a Druid), 7 melee (4 Rogues, 2 Monks and a Ranger), 8 pet and nuke casters (5 Magicians, 2 Necromancers and a Wizard) and 8 support characters (3 Enchanters, 3 Bards and 2 Shamans).

### How this roster was chosen

1. Support does not stack, so one provider per buff line is enough. Slots beyond the first of each support class go to what adds up across members: tank HP and mitigation, Cleric mana and damage. Raid Resolve doubles tank HP and Cleric mana once per fight, which makes those two the best scaling roles.
2. Damage slots go to Rogues first (the strongest melee template, and bosses cannot defend against them), then Magicians (pet and nuke), then Monks (less damage than Rogues, but sturdier).
3. Each group copies group 1's shape so it can level unattended: a tank, a Cleric, a pet class and an Enchanter, Bard or Shaman. Pets dealt 42% of group 1's damage at levels 20 to 21, and roots stalled the party until the Enchanter's and the Cleric's dispels cleared them. The bot's spell upkeep knows Magician spells only, so a Magician or a melee class leads each group ([guide](../guide.md)).
4. The order front-loads coverage. Groups 1 to 3 hold eleven of the fourteen classes, so a raid can start at 18 characters, and stopping after any group leaves a usable roster.
5. 36 is a planning size from the Avatar of War and Vulak`Aerr range above. The raid tests at level 46 decide whether the roster grows toward the 72 slots.

Choose each race by the XP factors in the [guide](../guide.md), which also describes the handover from an earlier group.

Epics worth chasing after the Magician's: the Cleric's Water Sprinkler, Rogue Ragebringer, the main Warrior's Jagged Blade, the Bard's Singing Short Sword, Monk Celestial Fists and the Enchanter's Staff of the Serpent.

## How long it takes

Level L ends at `1000 * L^3 * m` XP times the race and class factor. `m` was 1.0 up to level 29 and 1.1 at 30 and 31, so level 30 cost 5,311,000 XP and level 31 cost 3,070,100. If the steps follow EQEmu's table, `m` becomes 1.2 at 35, 1.3 at 40 and 1.4 at 45 and rises at every level from 51 to 59, so those levels cost more than the levels around them. Level 46 then starts at 127,575,000 XP and level 60 at 616,137,000 for a factor of 1.00. Check the step at 35. From 21 to 31 the party's XP per hour grew more slowly than the square of the level, so group 1 needs roughly 25 more hours of play to reach 46 and 65 to 95 more from there to 60. A new group needs roughly 40 hours to reach 46.

## Resolved and open questions

- Character-slot limit (resolved): 9 pages of 8 slots give 72 character slots on the account.
- Concurrent sessions (resolved): two browser sessions on the same account can stay in the game world at the same time without disconnecting each other, as long as they control different characters.
- Kerafyrm (resolved): untargetable in the current content, so the roster is not sized for him. If that changes, Destroy's 50-unit range decides the fight (see above).
- Raid members and budgets (resolved in code): recruits fight from server snapshots, and the client reads neither the per-target budgets nor the class costs.
- Open: the server's raid-time price at level 46 to 60, whether the server caps raid size, how raid mode offers the Velious targets that are missing from the catalog, whether level-60 raid buffs such as Aegolism can be bought or must drop, and which class should lead raids, since the leader adds its class package instead of its spells.

## Revisit when

- Group 1 reaches 46: open Start Raid, record the offered targets, the price and any member limit, and fight the smallest target with group 1 alone. Resize the roster and the ranges in "How big a raid" from that fight.
- The client bundle changes: diff the raid catalog `MB`, the Resolve list `Ed`, the summon list and Kerafyrm's rows. A Velious target in the catalog or a targetable Kerafyrm changes what the roster has to beat.
- Group 2 has leveled for two hours: compare its XP per hour with group 1's at the same levels before fixing the shape of groups 3 to 6.
- Raid fights show the limit: move groups 4 to 6 toward Clerics and Warriors when healing or tanking runs out first, and toward Rogues and Magicians when fights run long.
- A second session is approved: level two groups at once, each led by a Magician or a melee class.
