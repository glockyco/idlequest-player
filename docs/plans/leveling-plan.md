# Leveling and account plan

What to do next and why, ranked by expected account progress per hour of play. The goal needs Domeyafun at 60 with the Magician epic and every roster character at 46 or higher, so the measure is XP per hour for the whole party, not for Domeyafun alone. Measurements behind these choices are in the diary. Raid, AA, tradeskill and income research is in [systems-research.md](systems-research.md), the epic route in [magician-epic.md](magician-epic.md).

## How kill XP works

The kill-XP pool is 120 × NPC level² × zone XP multiplier. It is split among the party's characters in proportion to their levels, and pets take no share. This fits every one of 114 leader kills whose NPC level is known, to within half an XP point, and the companions' shares to within the same margin. The wiki adds the rules that a fit cannot show: the six-member group bonus is part of the 120%, green enemies give nothing, a kill gives a character at most 11% of their level's requirement, and race and class change the XP a level costs (Barbarian 1.05, Warrior 0.90). Sources: <https://idlequest.net/wiki/experience-and-zones>, diary 2026-11-07.

Consequences:

- XP per kill grows with the square of the enemy's level. A level-15 enemy pays a third more than a level-13 one, so the hardest enemies the party kills without extra downtime pay best.
- The zone multiplier scales everything linearly. Permafrost (1.44), Kedge Keep (1.39) and the 1.28 zones pay a third more per kill than a 1.0 zone with the same enemies.
- Every member gets a share, so all six characters level together and reach the raid levels together.

## Levers, ranked

Time is the scarce resource. A level took about 70 minutes at 31, and the step levels take longer ([how long it takes](raid-roster.md#how-long-it-takes)), so a lever is worth what it saves over the remaining levels, and a change worth a few percent is not worth the time to test it. Re-check the top levers at every second level.

| Rank | Lever | Expected effect | Status |
| ---: | --- | --- | --- |
| 1 | Zone and target band for the current level, alternating zones as reachable spawns run out. | Large: 1.0M XP/h in Kurn's Tower at 18, 1.6M in Guk at 21, 1.95M in Permafrost at 22. | The bot rotates between the zones in its `rotation` setting. Choose them per level band from `tools/zones.mjs` and measured rates. |
| 2 | A second session playing a second group. | Doubles account XP per hour. | Two sessions on the account stay in the world together ([raid roster](raid-roster.md#resolved-and-open-questions)). Needs a second group. Ask before starting one. |
| 3 | Keep the game tab visible. | Possibly 3-4 times: kills took 46-54 s at night against 13-15 s by day in Crushbone. | Unproven. Samples record visibility; compare `analyze.mjs --vis 1` and `--vis 0` once a hidden stretch exists. |
| 4 | Keep the party from standing still: hung route recoveries, readiness waits, cures that fail, root casters. | Up to a tenth of the time each. | The bot restarts hung waits; cures are off for the support casters; `avoidNames` skips root casters. |
| 5 | Damage where it lands. Pets dealt 42% of the party's damage at 20-21, the Bard 15%, the Warrior 12.5%. | A better weapon helps by its owner's share only. | Pet tiers come at 24, 29 and 34 by themselves. Weapon and gear priorities are in the upgrades research. |
| 6 | Epic steps while leveling. | Saves dedicated trips later. | From 29, prefer zones that drop Magician epic pieces when their rate is close. |
| 7 | Platinum. | Matters from 46 (raid time, AA). | About 300 pp an hour from loot; the bot sells cheap single items. |

## Zone rotation by level

Every candidate zone holds only 12 to 45 minutes of in-band kills at 3 kills a minute, and a level needs 100 to 135 kills, so the bot rotates between two or three zones (`rotation`). Permafrost ran dry after 40 minutes at level 19, which matches its modeled stock. Set the band's row when the leader enters it. Rows from 24 up come from the content snapshot (spawn points with an in-band mob, respawn times, mobs 8 or more levels above the leader near the camp) and are not measured yet. Measured rates: Kurn's Tower 1.0M XP/h per character at 18, Guk 1.6M at 21, Permafrost 1.8M to 1.95M at 22 to 23.

| Party level | Rotation (short names) | Notes |
| --- | --- | --- |
| 22-23 | permafrost, soldunga, guktop | Permafrost's stock falls from 79 points at 22 to 35 at 24. Solusek's Eye has level-30 casters near the camp, exactly 8 above a level-22 leader. |
| 24 | soldunga, guktop, dalnir | Dalnir drops the Warrior's next weapons (Charred Tulwar 25%, Tower Guard's Blade 5%). Kly wanderers at 30 to 35. |
| 25-27 | paw, soldunga, dalnir | Splitpaw pays most per hour but needs 20 minutes away between visits. Add crystal at 27. One Unrest pass at 26-27 for Torn Page 2 (tentacle terrors, 90%). |
| 28-30 | soldunga, paw, crystal | Droga alone is the unattended fallback, about 15% slower. Mistmoore's gypsy dancer drops Power of Wind (100%, one spawn per 29 minutes): an errand in this band. |
| 31-33 | soldunga, paw, dalnir | The model ranks Crystal Caverns and Frozen Shadow near 2.0M and Kaesora near 1.0M, where 63-79% of the in-band mobs are immune to melee. Get Power of Water from Kaesora's enraged, famished or gorged raveners (32 to 36, 100%) with `iq.errand`. |
| 34-37 | soldunga, paw, droga | Solusek's Eye runs out of in-band spawns from 36, then Splitpaw leads. Lava elementals (35) in Solusek's Eye drop Power of Fire. |

The kill rate decides how long the higher levels take: in-band HP doubles from about 690 at level 20 to 1,400-1,560 at 32, and XP per HP is about the same everywhere. Read kills per minute and "Damage by source" at each band start.

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
2. Done: `BAND_ROTATIONS` sets the rotation at each level-up, so a band change needs no agent.
3. Next: hand weapons and gear to the party member who gains most, and never sell an item that is an upgrade for someone.
