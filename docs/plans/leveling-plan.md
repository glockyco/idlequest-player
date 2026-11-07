# Leveling and account plan

What to do next and why, ranked by expected account progress per hour of play. The goal needs Domeyafun at 60 with the Magician epic and every roster character at 46 or higher, so the measure is XP per hour for the whole party, not for Domeyafun alone. Measurements behind these choices are in the diary. Raid, AA, tradeskill and income research is in [systems-research.md](systems-research.md), the epic route in [magician-epic.md](magician-epic.md).

## How kill XP works

The kill-XP pool is 120 × NPC level² × zone XP multiplier. It is split among the party's characters in proportion to their levels, and pets take no share. This fits every one of 114 leader kills whose NPC level is known, to within half an XP point, and the companions' shares to within the same margin. The wiki adds the rules that a fit cannot show: the six-member group bonus is part of the 120%, green enemies give nothing, a kill gives a character at most 11% of their level's requirement, and race and class change the XP a level costs (Barbarian 1.05, Warrior 0.90). Sources: <https://idlequest.net/wiki/experience-and-zones>, diary 2026-11-07.

Consequences:

- XP per kill grows with the square of the enemy's level. A level-15 enemy pays a third more than a level-13 one, so the hardest enemies the party kills without extra downtime pay best.
- The zone multiplier scales everything linearly. Permafrost (1.44), Kedge Keep (1.39) and the 1.28 zones pay a third more per kill than a 1.0 zone with the same enemies.
- Every member gets a share, so all six characters level together and reach the raid levels together.

## Levers, ranked

Time is the scarce resource. Each level takes about 47 minutes, so a lever is worth what it saves over the remaining levels, and a change worth a few percent is not worth the time to test it. Re-check the top levers at every second level.

| Rank | Lever | Expected effect | Status |
| ---: | --- | --- | --- |
| 1 | Zone and target band for the current level, alternating zones as reachable spawns run out. | Large: 1.0M XP/h in Kurn's Tower at 18, 1.6M in Guk at 21, 1.95M in Permafrost at 22. | The bot rotates between the zones in its `rotation` setting. Choose them per level band from `tools/zones.mjs` and measured rates. |
| 2 | A second session playing a second group. | Doubles account XP per hour if the server allows it. | Blocked: needs a sign-in in a second window. |
| 3 | Keep the game tab visible. | Possibly 3-4 times: kills took 46-54 s at night against 13-15 s by day in Crushbone. | Unproven. Samples record visibility; compare `analyze.mjs --vis 1` and `--vis 0` once a hidden stretch exists. |
| 4 | Keep the party from standing still: hung route recoveries, readiness waits, cures that fail, root casters. | Up to a tenth of the time each. | The bot restarts hung waits; cures are off for the support casters; `avoidNames` skips root casters. |
| 5 | Damage where it lands. Pets dealt 42% of the party's damage at 20-21, the Bard 15%, the Warrior 12.5%. | A better weapon helps by its owner's share only. | Pet tiers come at 24, 29 and 34 by themselves. Weapon and gear priorities are in the upgrades research. |
| 6 | Epic steps while leveling. | Saves dedicated trips later. | From 29, prefer zones that drop Magician epic pieces when their rate is close. |
| 7 | Platinum. | Matters from 46 (raid time, AA). | About 300 pp an hour from loot; the bot sells cheap single items. |

## Zone candidates

Candidates come from the content snapshot (`tools/zones.mjs`, enemies from level −2 to +3 of the party, fewest strong neighbours) and from classic group routes. None is measured yet except Crushbone. Scout a zone live before moving, because the snapshot overstated Toxxulia by 40%, and stacked dungeon floors make 2D density and danger counts unreliable.

| Party level | First candidates (multiplier) | Notes |
| --- | --- | --- |
| 14-15 | Crushbone (1.19) | Current camp. 31 targets in band, few strong neighbours. |
| 16-18 | Kurn's Tower (1.28), Najena (1.19), the Warrens (1.28) | Kurn has the densest band at 16 and no strong neighbours at 18. Najena holds Magician epic pages. |
| 20-23 | Permafrost Caverns (1.44), Kerra Isle (1.0), Runnyeye (1.28) | Permafrost's entrance goblins at the highest multiplier. Keep the giants and deep floors out of the route. |
| 24-26 | Mines of Droga (0.96), Estate of Unrest (1.13), Solusek's Eye (1.19) | Droga has hundreds of level-29 targets. Unrest and Solusek's Eye carry epic work. |
| 28-33 | Droga, Crypt of Dalnir (1.01), Mines of Nurga (0.96), Splitpaw (1.28), Crystal Caverns (1.22) | Splitpaw and Crystal Caverns pay more per kill if the party holds. |
| 35-46 | Ruins of Old Guk (0.86), Kedge Keep (1.39), the Hole (1.28), City of Mist (0.94), Karnor's Castle (0.94) | Kedge and the Hole combine high multipliers with Magician epic steps. |
| 46-60 | Chardok, Sebilis, Velketor's Labyrinth (all 0.94), the Hole | Choose by measured rate: the multipliers are equal. |

## Spell and pet unlocks for Domeyafun

Memorize the summon of the newest tier and replace the living pet. Damage shields and Burnout come from passive party support once learned, so they need no gem. Sources: `spells_new` in the content snapshot and <https://idlequest.net/wiki/companions#permanent-party-support>.

| Level | Pet tier | Direct damage |
| ---: | --- | --- |
| 12 | Elemental | Shock of Blades and Flame Bolt (8) |
| 16 | Minor Summoning | Shock of Flame |
| 20 | Lesser Summoning | Bolt of Flame |
| 24 | Summoning | Shock of Spikes |
| 29 | Greater Summoning | |
| 34 | Minor Conjuration | Blaze, Cinder Bolt |
| 39 | Lesser Conjuration | |
| 44 | Conjuration | Shock of Swords |
| 49 | Greater Conjuration | Lava Bolt |
| 51-54, 57-60 | Vocarate, then Greater Vocaration | Char, Scars of Sigil, Shock of Steel, Seeking Flame of Seukor |

Each Magician summon uses one Malachite. Keep a stack, and buy more from Hanlore Escaval in South Qeynos.

## Gear and items with lasting value

- Bard instruments: Minotaur Horn (wind 20) from the bags. Hand Drum (percussion 18, North Freeport), Lute (stringed 20, South Karana) and Horn (brass 20, South Qeynos) cost at most 1 pp each. Match them to the songs Ugfeu sings.
- Warrior weapon: Iksar Berserker Club (7/18) in Kurn's Tower, later the Blackened Alloy Bastard Sword in Runnyeye.
- Casters: Runed Circlet (4 INT, 4 WIS, all six can wear) from the goblin preacher in Permafrost, Hexed Kerran Doll (30 mana) from the Kerran Sha`rr on Kerra Isle.
- Clicky buffs never expire in IdleQuest, so one click item gives a permanent effect. The haste items the snapshot supports drop from level 38 to 47 enemies.
- Skip camps the snapshot cannot support: Sporali Gloves and Journeyman's Boots have zero spawn weight, and Manastone has no spawning source.

## Measuring

Measure during normal play: label the blocks and compare them with `analyze.mjs`. Two 10-minute blocks with the same setting differ by up to 15%, so a dedicated A/B test is worth its time only when the expected effect is larger than that and a decision depends on it. Prefer reading the cause from the analyzer (between-pull waits, recovery limiter, damage by source, escapes) over comparing XP per hour.

## Bot roadmap

1. Done: AutoLevel keeper with pause deadlines, restarts after hung route recoveries and readiness waits, bag cleanup with Auto Bank, cursor watch, party rejoin, spells and pets after level-ups, zone rotation, target skipping, alerts and `watch`.
2. Next: choose the rotation zones from this plan by level, so a level band change needs no agent.
3. Then: hand weapons and gear to the party member who gains most, and never sell an item that is an upgrade for someone.
