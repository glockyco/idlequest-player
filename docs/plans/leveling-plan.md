# Leveling and account plan

What to do next and why, ranked by expected account progress per hour of play. The goal needs every raid-roster character at level 46 or higher, raid boss kills and class epics. Its success criterion names Domeyafun at level 60 with the Orb of Mastery, so one character's level has a deadline, but each group levels together, and the measure is XP per hour per character. Measurements behind these choices are in the diary. Raid, AA, tradeskill and income research is in [systems-research.md](systems-research.md), the epic route in [magician-epic.md](magician-epic.md).

## How kill XP works

The kill-XP pool is 120 × NPC level² × zone XP multiplier. It is split among the party's characters in proportion to their levels, and pets take no share. This reproduces the XP line of each of the 3,132 leader kills in `runs/2026-11-07-live` within half an XP point. The NPC level is the only free input and comes out as a whole number every time. The zone multipliers are the content snapshot's `zone_exp_multiplier` values for the seven zones visited, and companions' lines follow the same level shares. The wiki adds rules a fit cannot show: the six-member group bonus is part of the 120%, green enemies give nothing, a kill gives a character at most 11% of their level's requirement (never reached in the run), and race and class change the XP a level costs (Barbarian 1.05, Warrior 0.90). The wiki also says a character far below the party's highest level gets no XP (it allows a five-level gap, or a highest level up to about 1.5 times the lower), so a new character cannot ride along in a leveled party. Sources: <https://idlequest.net/wiki/experience-and-zones>, diary 2026-11-07. The XP a level costs is in [raid-roster.md](raid-roster.md#how-long-it-takes).

Consequences:

- XP per kill grows with the square of the enemy's level. A level-15 enemy pays a third more than a level-13 one.
- Enemy HP in the content snapshot follows about 1.3 × level² up to level 36, so XP per point of enemy HP is nearly flat there and a harder enemy pays more per kill but not per second of fighting. From level 37 most spawned enemies carry 1.5 to 3 times that HP (median 3,250 at level 40 and 5,875 at level 45, while the lowest quarter stays near the curve), so XP per HP falls by a third at 40 and by more than half at 45. From 37 on, which enemies the party fights matters as much as which zone. The flat part is measured to level 31, the drop is read from the snapshot.
- The zone multiplier scales everything linearly. Permafrost (1.44), Kedge Keep (1.39), the Temple of Solusek Ro (1.33) and the 1.28 zones (Kurn's Tower, Runnyeye, Splitpaw) pay 28% to 44% more per kill than a 1.0 zone with the same enemies. The wiki's multiplier table is copied from P99 estimates, so use the snapshot's values.
- Every member gets a share, so all six characters level together, within a level or two of each other because the race and class factors differ.

## Levers, ranked

Time is the scarce resource. A level took about 70 minutes at 31 (3,070,100 XP at 2.4M to 2.6M XP/h), and the step levels take longer ([how long it takes](raid-roster.md#how-long-it-takes)), so a lever is worth what it saves over the remaining levels, and a change worth a few percent is not worth the time to test it. Re-check the top levers at every second level.

| Rank | Lever | Expected effect | Status |
| ---: | --- | --- | --- |
| 1 | A second session playing a second group. | Doubles account XP per hour, because a second party earns its own XP (estimate, not run yet). | Two sessions on the account stay in the world together when they control different characters ([raid roster](raid-roster.md#resolved-and-open-questions)). Needs a second group. Ask before starting one. A session in a background tab runs as a hidden tab, see lever 3. |
| 2 | Zone and target band for the current level, alternating zones as reachable spawns run out. | Measured: 0.8M to 1.0M XP/h at 15-17 in Kurn's Tower, 1.5M at 18-19 and 1.8M at 22 in Permafrost against 1.5M to 1.65M in Guk at 20-21, 2.5M at 30-31 in Unrest and Solusek's Eye. Estimate: the model puts the top zones at 2.5M to 3.5M from 31 up against 1.75M for the 30th-ranked zone at 31, but its error (about 10%) hides the order among the top three or four. | The bot rotates between the zones of its `BAND_ROTATIONS` row. Rows from 38 on have not been checked against the model. The rows below 38 and their evidence are under "Zone rotation by level". Leaving a zone that turned bad (Permafrost at 28) is worth more than choosing among the top zones. |
| 3 | Keep the game tab visible. | Possibly 3-4 times. In Crushbone kills took 46-54 s at night against 13-15 s by day. In the 4.9 minutes of hidden samples in `runs/2026-11-07-live` kills averaged 46 s against 12.5 s visible at the same level, and the party dealt 4 times less damage per combat second (15 against 63 at 29-31). | Supported by two observations, cause untested: the hidden sample holds 3 kills and the Crushbone stretch also had other players taking spawns. Compare `analyze.mjs --vis 1` and `--vis 0` once a longer hidden stretch exists. |
| 4 | Keep the party from standing still. At 29-31 combat was 61% of the time, recovery 19%, moving 13% and ready-idle 7%. | Recovery is the largest cell. The leader's mana was the last bar to fill in 62% of the listed recovery seconds, Ewbanaqoa's in 18%. Cure and dispel waits took 7% of the time (26 waits averaging 41 s), root waits 1.5%. | The bot restarts hung waits, cures are off for the support casters, `avoidNames` skips root casters and Nullify Magic clears roots. The model says the nuke pays for its recovery (2.5M against 2.1M XP/h without nukes at 31, Magician-only policies), so the open question is mana supply, not fewer casts. Untested. |
| 5 | Damage where it lands. At 29-31 the two pets (Magician and Enchanter) dealt 42% of the logged damage, the Warrior 21%, the Bard 14%, the leader's spells and melee 14%, Qigaa and Ewbanaqoa 4% each. | A better weapon helps by its owner's share only. | Pet tiers come at 24, 29 and 34 for both pet classes after the bot replaces the pet at the level-up. Weapon and gear priorities come from `tools/gear.mjs --party`. |
| 6 | Epic steps while leveling. | Saves dedicated trips later. | Prefer zones that drop pieces for any roster class's epic when their rates are within the model's error ([epics.md](epics.md) lists the pieces by band). The Magician's Powers are errands (`iq.errand`) because the success criterion names the Orb. |
| 7 | Platinum. | Matters from 46 (raid time, AA). Gross coin picked up per hour in `runs/2026-11-07-live`: about 60 pp at 8-15, 220 at 15-19, 330 to 400 at 20-27, 640 to 860 at 29-31. | The bot sells cheap single items. Loot sales are not in these numbers. The raid price at 46 or higher is unknown, see [systems-research.md](systems-research.md#hourly-price-and-what-free-does-not-establish). |

## Zone rotation by level

The bot's rows are `BAND_ROTATIONS` in `src/bot.js`. This section gives the evidence behind them. Rates are XP per hour per character. "Measured" is the leader's XP over the time spent at that level and zone in `runs/2026-11-07-live`. "Model" is `tools/predict.mjs`, an estimate: run with `--min-diff -99` (the band AutoLevel actually fights, every enemy that is not green) it matched 17 measured level and zone windows within 10% for 13 of them and ran 20% to 31% high for the rest (Kurn's Tower at 16-17, Permafrost at 22, Unrest at 29). Every measured zone was one the model had ranked first or second, so the order of lower-ranked zones is untested. Its default band (3 levels below to 5 above the leader) leaves out about half of the kills at 22 to 31, so its stock counts and the order of close zones differ between the two bands. Both bands are listed where the order differs. The model has not predicted a dry zone: Permafrost ran dry at 19 after 63 minutes at 1.5M to 1.8M, and the model shows 8 times more spawns than the party can kill there.

The party stayed in Permafrost from 23 to 28 (255 minutes at 2.3M to 2.5M) and in Unrest from 29 to 31, so the "rotation" is a safeguard, not a schedule. The bot moves on when the last 10 minutes earned less than a share of the visit's best or after repeated guard escapes.

| Party level | Rotation | Measured | Model | Notes |
| --- | --- | --- | --- | --- |
| 22-25 | permafrost, runnyeye, guktop | Permafrost 1.8M at 22, 2.1M at 23, 2.3M to 2.4M at 24-25 | Permafrost 2.1M to 2.35M, Runnyeye 1.9M to 2.1M, Guk 1.7M to 1.9M | Runnyeye is second in the model and has not been visited. |
| 26-27 | permafrost, paw, unrest | Permafrost 2.4M to 2.5M | Permafrost 2.5M, Splitpaw 2.2M, Unrest 2.2M | At 28 outer goblins turn green and AutoLevel paths toward ice giants (level 47 to 50): 189 guard escapes in 25 minutes at 1.2M to 1.5M. The model does not see this, so leave Permafrost at 28. |
| 28-30 | unrest, soldunga, paw | Splitpaw 2.3M at 28, Unrest 2.0M at 29 and 2.5M at 30 | Unrest 2.4M to 2.6M, Solusek's Eye 2.3M, Splitpaw 2.2M at 28 | Mistmoore's gypsy dancer (level 24 to 25) drops Power of Wind (100%, one spawn per 29 minutes): an errand in this band. |
| 31-33 | soldunga, kaesora, paw | Unrest 2.5M and Solusek's Eye 2.6M at 31 | Solusek's Eye 2.6M to 3.0M, Kaesora 2.45M to 2.7M, Splitpaw 2.4M to 2.7M, Dalnir 2.2M to 2.4M, Crystal Caverns 2.15M to 2.3M, Frozen Shadow 2.0M to 2.2M | Kaesora's melee-proof enemies carry special ability 23, which the client reads as immunity to non-magical melee only. Magic weapons and pets of level 10 or more get through, and every weapon and pet in group 1 is magical. Kaesora has not been farmed, so its first visits are the check. Power of Water drops there from enraged, famished and gorged raveners (level 32 to 36, 100%): `iq.errand`. |
| 34-37 | soldunga, kaesora, paw | none | Solusek's Eye 2.85M to 3.15M at 34 and 2.9M to 3.3M at 35 (default and con-rule band), Kaesora 2.8M to 2.9M, Splitpaw 2.5M to 2.9M | In the default band Solusek's Eye falls from 51 candidate spawn points at 35 to 25 at 36 and 9 at 37, then Kaesora and Splitpaw lead. In the con-rule band it keeps over 100 points and stays first through 37 (3.4M), so the first minutes at 36 decide which band applies. The Temple of Solusek Ro tops the model (3.0M) with 36% to 40% of its candidate spawns next to enemies 8 or more levels above the leader, which is the pattern that sank Permafrost at 28. Lava elementals (level 35) in Solusek's Eye drop Power of Fire (28%, rare spawn). |
| 38 and up | not set from a model | none | Con-rule band: Solusek's Eye 3.5M at 38 and 41, Kaesora 3.1M to 3.6M, the Temple 3.2M to 3.6M, Splitpaw 3.0M to 3.2M. Default band: the Temple 3.05M at 38, Ocean of Tears 2.7M at 41, the Freeport zones 3.0M at 46 | The two bands disagree from 38 because the HP cliff at 37 to 45 makes lower-level enemies pay better per second. Whether AutoLevel keeps targeting the lowest non-green levels at party level 41 and up is untested (the lowest offset seen is -8 at 31). Check the first rates at 38 against both lists before leaving Solusek's Eye and Kaesora. |

In-band HP is about the same everywhere at a given level through 36, so the kill rate decides how long the higher levels take. The average killed enemy's HP rose from about 580 at party level 20-22 to about 950 at 29-31, and the party's damage per second (HP of the kills over time to kill, with HP from the snapshot's median for each level) rose from about 45 to 72, so kills stayed at 12 to 15 s. The model grows damage as the square root of the level and so lags this rise. Read kills per minute and "Damage by source" at each band start.

## Spell and pet unlocks

Memorize the summon of the newest tier and replace the living pet. Damage shields and Burnout come from passive party support once learned, so they need no gem. Sources: `spells_new` in the content snapshot and <https://idlequest.net/wiki/companions#permanent-party-support>.

| Level | Magician pet | Enchanter pet | Magician direct damage |
| ---: | --- | --- | --- |
| 12 | Elemental | Kilan's Animation | Shock of Blades and Flame Bolt (8) |
| 16 | Minor Summoning | Shalee's Animation | Shock of Flame |
| 20 | Lesser Summoning | Sisna's Animation | Bolt of Flame |
| 24 | Summoning | Sagar's Animation | Shock of Spikes |
| 29 | Greater Summoning | Uleen's Animation | |
| 34 | Minor Conjuration | Boltran's Animation | Blaze, Cinder Bolt |
| 39 | Lesser Conjuration | Aanya's Animation | |
| 44 | Conjuration | Yegoreff's Animation | Shock of Swords |
| 49 | Greater Conjuration | Kintaz's Animation | Lava Bolt |
| 51-54, 57-60 | Vocarate, then Greater Vocaration | 55: Zumaik's Animation | Char, Scars of Sigil, Shock of Steel, Seeking Flame of Seukor |

Each Magician summon uses one Malachite. Keep a stack, and buy more from Hanlore Escaval in South Qeynos.

## Gear and items with lasting value

- Bard instruments: Minotaur Horn (wind 20) from the bags. Hand Drum (percussion 18, North Freeport), Lute (stringed 20, South Karana) and Horn (brass 20, South Qeynos) cost at most 1 pp each. Match them to the songs Ugfeu sings.
- Weapons: compare any drop or purchase against both hands of a dual-wielder with `tools/gear.mjs --party`. Dalnir's Charred Tulwar (25%) and Tower Guard's Blade (5%) are two-handed swords at damage per delay of 0.39 and 0.44, no better than the one-handed Iksar Berserker Club at 0.39.
- Casters: Runed Circlet (4 INT, 4 WIS, all six can wear) from the goblin preacher in Permafrost (60% of the preacher's drops), Hexed Kerran Doll (30 mana) from the Kerran Sha`rr on Kerra Isle (40%).
- Clicky buffs from items have no expiration in IdleQuest (wiki "Clicky buffs"), so one click gives a permanent effect, subject to charges, reuse timers, dispels and stronger buffs. Worn haste items (haste 20 to 31) drop from level 40 to 47 enemies in the snapshot, for example Nightknife's Armband (haste 21, 25% to 33% from the Grimling Outpost leaders), the Flowing Black Silk Sash (haste 21, 20% from Lower Guk ghouls) and Silver Chitin Hand Wraps (haste 22, 65% from Velketor's broodlings).
- Skip camps the snapshot cannot support: Sporali Gloves and Journeyman's Boots have zero spawn weight, and Manastone has no spawning source.

## Measuring

Measure during normal play: label the blocks and compare them with `analyze.mjs`. Ten-minute blocks in one zone with unchanged settings ranged from 15% below to 15% above their median (2.1M to 2.7M XP/h in Permafrost at 24-27), so two blocks can differ by 30% and a dedicated A/B test is worth its time only when the expected effect is larger than that and a decision depends on it. Prefer reading the cause from the analyzer (between-pull waits, recovery limiter, damage by source, escapes) over comparing XP per hour.

## Bot roadmap

1. Done: AutoLevel keeper with pause deadlines, restarts after hung route recoveries and readiness waits, bag cleanup with Auto Bank, cursor watch, party rejoin, spells and pets after level-ups, zone rotation, target skipping, alerts and `watch`.
2. Done: `BAND_ROTATIONS` sets the rotation at each level-up, so a band change needs no agent.
3. Next: hand weapons and gear to the party member who gains most, and never sell an item that is an upgrade for someone.
4. Next: set the `BAND_ROTATIONS` rows from 38 on from `tools/predict.mjs` in both bands (see "Zone rotation by level") and put Kaesora into the 31 to 37 rows.
