# Leveling and account plan

What to do next and why, ranked by expected account progress per hour of play. The goal needs Domeyafun at 60 with the Magician epic and every roster character at 46 or higher, so the measure is XP per hour for the whole party, not for Domeyafun alone. Measurements behind these choices are in the diary. Raid, AA, tradeskill and income research is in [systems-research.md](systems-research.md), the epic route in [magician-epic.md](magician-epic.md).

## How kill XP works

The kill-XP pool is 120 × NPC level² × zone XP multiplier. It is split among the party's characters in proportion to their levels, and pets take no share. This fits every one of 114 leader kills whose NPC level is known, to within half an XP point, and the companions' shares to within the same margin. The wiki adds the rules that a fit cannot show: the six-member group bonus is part of the 120%, green enemies give nothing, a kill gives a character at most 11% of their level's requirement, and race and class change the XP a level costs (Barbarian 1.05, Warrior 0.90). Sources: <https://idlequest.net/wiki/experience-and-zones>, diary 2026-11-07.

Consequences:

- XP per kill grows with the square of the enemy's level. A level-15 enemy pays a third more than a level-13 one, so the hardest enemies the party kills without extra downtime pay best.
- The zone multiplier scales everything linearly. Permafrost (1.44), Kedge Keep (1.39) and the 1.28 zones pay a third more per kill than a 1.0 zone with the same enemies.
- Every member gets a share, so all six characters level together and reach the raid levels together.

## Levers, ranked

| Rank | Lever | Status |
| ---: | --- | --- |
| 1 | Keep the game running and looting. AutoLevel off or full bags cost hours of progress while nobody watched. | Done: the in-page bot keeps AutoLevel on, sells surplus copies and raises alerts. |
| 2 | Keep the game tab visible. In Crushbone, kills took a median 46-54 s from 03:00 to 06:00 UTC and 13-15 s in the late-evening and morning blocks, and XP per hour moved between about 205k and 560k. Browsers throttle timers in hidden tabs, and the client simulates combat. | Unproven. Samples record visibility now. Compare with `analyze.mjs --vis 1` and `--vis 0`. If it holds, give the game its own browser window and keep the display awake while unattended. |
| 3 | Memorize the best spells and replace pets after each unlock. A living pet is kept after level-ups, and the active character casts only memorized spells. | Done once at 14: Domeyafun's pet went from level 9 to 13, his nuke from 5 to 35 damage, Edroun's pet from level 5 to 12. To automate in the bot. |
| 4 | Harder targets and the zone multiplier, chosen by measured XP per hour with the guard on. | Next: see the zone table and experiments. |
| 5 | Gear from loot. Auto-Upgrade and Auto-Upgrade Companions are on. Equip instruments by hand: they work only when equipped. | Next: equip a Minotaur Horn on Ugfeu, buy the missing instrument families. |
| 6 | Platinum. Raid time and each AA rank cost about 2,000 pp, so income matters from level 46. | Later: the bot sells surplus without the courier fee. Compare loot value per kill when choosing zones. |
| 7 | Epic steps while leveling. Najena, Solusek's Eye, Unrest, Mistmoore and Kedge hold Magician epic items and steps of other roster epics. | Later: prefer these zones when their XP per hour is close. |

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

## Experiments

Each runs as labelled blocks of 10 to 15 minutes in the order A, B, A, B at one level and zone, with the setting checked in the event log. A level-up ends a block.

| Order | Labels | Question |
| ---: | --- | --- |
| 1 | `E-vis-front`, `E-vis-back` | Does a hidden tab slow combat? Compare kill time and XP per hour. |
| 2 | `E-nuke-on`, `E-nuke-off` for Domeyafun | Do the new nukes speed kills more than their mana slows recovery? |
| 3 | `E-con13`, `E-con15` | Do yellow targets pay more per hour than they cost in recovery and risk? |
| 4 | `E-zone-crush`, `E-zone-kurn` at 16 | Is Kurn's Tower faster than Crushbone, counting travel? |
| 5 | `E-tactics-roles`, `E-tactics-damage` | Does keeping support casters off nukes still pay with their current spells? |

## Bot roadmap

1. Done: AutoLevel keeper with pause deadlines, surplus sale, cursor watch, alerts, `watch` for cheap supervision.
2. Next: at each level-up, memorize the best summon and nukes and replace an older pet, out of combat.
3. Then: move to the next zone from this table when the level band is reached and a live scout passed, with the guard's retreat as the fallback.
4. Then: equip hand-down gear and instruments, track platinum per hour, and bound paid death restarts.
