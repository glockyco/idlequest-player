# Gear acquisition

How the coordinator decides whether a group gets an item: moved from another character, bought,
hunted inside its rotation, camped, or visited. One model answers all of these, in one currency,
hours of a group's progress, so the choices compare with each other and with plain hunting. Every
group has to reach 60, so an hour of one group's progress counts as much as an hour of another's,
and a group may hunt for a character of another group, because a gear task moves the copy. The
code is `tools/lib/acquire.mjs`, and `decide` in `tools/lib/coordinator.mjs` applies it.

## The decision for one copy

A copy is worth the progress it adds to its taker's group while it is worn, and costs the progress
the hunting group gives up to get it.

    V = g × T        C = H / p × k + D
    g = e × (s_melee × Δmelee + s_spell × Δspells) + Δparty

| Term | Meaning | Source |
| --- | --- | --- |
| g | the copy's gain to the taker's group's XP rate, against what the taker has after this pass's moves (`xpGain`) | `xpGain` in `tools/lib/gear-plan.mjs` |
| Δmelee, Δspells | the change of the taker's own melee and spell damage | `outputValue` and `weaponRatio` in `tools/lib/gear-data.mjs` |
| Δparty | the party time or XP the item saves directly: shorter rests, a Bard's faster walk, survival | `outputValue` and `walkValue` |
| s_melee, s_spell | the taker's melee and spell share of the party's damage | measured from the fight lines the bridge tags by source (`damageShares`), else the class's melee share of one sixth |
| e | the change of XP per hour for a change of party damage, by level | the leveling model, leveling plan lever 7 |
| T | the hours the copy is worn | 10 levels at the pace of the taker's group, its own XP per hour over the last two hours of minute totals without task minutes, the pace of level 59 at 60, where AA XP takes the place of levels. Without a measured pace a copy's worth is unknown, and the target says so |
| H | the expected hunting hours for one copy at a sure kill | the longer of the respawns' bound (respawn over spawn chance, drop chance and points, from the content snapshot) and the kill rate's (one over the hunting group's kills per hour times spawn and drop chance, `copyHours`) |
| p | the hunting group's chance to win a fight against the enemy | [Kill chance](#kill-chance) |
| k | the share of the hunting group's XP lost while it hunts | 0 inside its rotation, 1 outside it, where a camp or a visit earns no XP |
| D | the deaths of the fights one copy takes, won and lost | [Kill chance](#kill-chance) |

`g` is the relative gain of the group's XP rate, so `V` is in hours of the group's progress. The
same `g` decides the gear plan's moves, so an item goes to the member it adds most XP through: a
weapon to the member whose melee deals most of the party's damage, not to a pet class whose pet does.
A copy is worth getting when `V > C`. A group's time is what each choice spends, and a trip takes a
group to one zone, where it hunts every wanted enemy that pays: the zone's cost `k` is paid once,
each enemy adds its drops less its deaths, and the enemies share the group's kills. An enemy hunted
at its full rate takes the share of the group's kills its points give as they respawn, and when the
shares pass all of the group's kills, the enemies that pay most per share keep theirs. The group
kills an enemy at the pace of that enemy's fights: its usual kills per hour, slowed by the
simulator's seconds per fight against its usual fight (`paceOf`). The
assignment is greedy with re-evaluation: the pair of free group and zone whose trip earns the most
per hour goes first, then every other pair is valued again with that trip's taker slots claimed,
its zone occupied, so a second group there pays the shared cost, and its kills taken from its
enemies' spawn points.

A copy serves one character. Each item counts at its best taker, and each character slot once. An
enemy's worth adds its items, since each drop rolls on its own, so a copy of any of them comes every
`1 / sum(1 / H)` hours. An enemy is one group's only while its points feed no more: the Plane of
Hate's Disciples, Dragoons, Agents, Knights and Sages stand on 28 points that respawn every 640 s,
about 157 an hour, against a group's 60 kills. So an enemy stays open to further groups while a
quarter of what its points respawn is left (`minSupply`), each group's take counted as its kills
spread over its trip's enemies by their supply. A further group's copy goes to the item's next
taker (`others` of the gear plan's targets, three of them). A slot another hunt already serves,
with no further taker, still takes a copy that comes sooner: it
is worn until the other hunt's copy would come, and adds for good only what it gains over that copy.
So a group takes a quick lesser upgrade while a stronger group hunts the best one.

## Ways to get a copy

| Way | H | k | When it is chosen |
| --- | --- | --- | --- |
| Move | none | none | the account holds a free copy (the gear plan's moves) |
| Purchase | none | platinum | a merchant in a city sells it, within the pass's platinum budget |
| Errand | hours per copy | 0, or `sharedCost` when another group plays the zone | the enemy's zone is in the group's rotation |
| Camp | hours per copy | 1, since the client's Spawn Camp holds the enemy's points and earns no XP while it waits for their respawns | outside the rotation, when it earns more than a visit |
| Visit | `visitHours`, and the group's time per kill for each enemy up, every kill of its chain for a copy a chain of deaths ends in (`chainKills`) | 1 | outside the rotation, for rare spawns: worth the chance the enemy is up on arrival (`upChanceOf`: the spawn tables' `1 - (1 - spawn)^points` as two visits beside what the visits so far found), times the kill chance and each drop chance and copy value |

A visit reads the zone's spawn list on arrival and fights the enemy only when it is up. It notes which of its enemies stood when it arrived (`up` of the hunt task), and the coordinator counts for each target how many of the visits that looked for it found it. When none is up, it names the first respawn of the enemy's spawn points (`watch` of `iqBot.hunt`), and the coordinator sends the next visit then instead of after an hour. A raid, for an enemy above level 50 that no group kills, is planned with the boss kills ([boss kills](raids.md)).

## Where the copies are

Every live zone's loot tables are a source, for every item the gear plan values: the leveling kit, the raid kit and the account's demand. The highest enemy level in a live zone is 70 (the content's spawn and loot tables, 8,799 gear-dropping enemies). For a level-60 character the best item per slot drops mostly from enemies of level 56 to 60, by the gear score over the content's loot tables:

| Droppers up to level | Share of the best level-60 armor value | Best item per slot (14 classes, 17 slots) |
| --- | --- | --- |
| 55 | 63 to 88% | 89 |
| 60 | 91 to 100% | 112 more |
| 65 | no more than at 60 | 8 more |
| 70 | 100% | 29 more |

So groups at 60 need to kill enemies of their own level, and the last few percent, and some casters' best weapons, come from enemies of 66 to 70, which take a raid.

The pieces of the class epics the account can finish are targets as well ([epic model](epic-model.md)): a piece is worth its reward's gain to the character that lacks the epic, shared by the pieces it lacks. A piece that an enemy drops after a chain of scripted deaths comes from the static enemy that starts the chain, as the Iksar Scale comes from the black reavers of the City of Mist: each static spawn yields the piece at the chain's yield, after the chain's kills (`kills` of the drop row), the hunt kills the chain's enemies too (`also`), and the hardest of them sets the target's level.

## Kill chance

Whether a group kills an enemy is a kill chance per group and enemy, not a level margin. Three kinds
of fights are its evidence. The model counts as one fight, the simulator's fights count until a
live fight says how a group of this level fares, and from then on the live fights decide beside the model:

- a model fitted to every simulated fight of every group (`tools/lib/kill-prior.mjs`), counted as
  one fight: the chance falls with the enemy's level above the group's leader and with its hit
  points, so a doable target is hunted before anyone has simulated it, and the deaths and the
  leader's death a fight costs follow the same two;
- the raid simulator's fights of the group's six as surveyed (`tools/kill-odds.mjs`), for the pairs
  of group and target with the highest expected value under the model and for the boss kills,
  refreshed hourly and kept for a day at the group's level. The simulator fights in the client's
  raid mode, which takes only enemies above level 50;
- the live fights against the enemy (`tools/lib/fight-record.mjs`): each kill by a leader at the
  group's level or below, and each escape of the guard that names the enemy by a leader at its
  level or above, whichever group fought, apart from an escape by the level rule, which refused a
  fight and lost none. The simulator fights an enemy alone, so the enemies that join show only
  here: it gave group 1 four wins of four against Phinigel Autropos, who beat eleven groups 46
  times beside his seahorses.

A copy then takes `H / p` hours, and every fight, won or lost, pays its expected deaths: a
companion's death costs 38 s and the leader's 85 s plus level² × 666.67 XP at the group's pace
(`bun tools/fights.mjs`, "What escapes and deaths cost"). Deaths per fight come from the simulator
for the pair, else from the model's rates at the enemy's level and hit points. The choice is by expected value,
so no chance is too low in itself: the dashboard calls a target too strong when its best group's
chance is below 5% (`tooStrong`). A target is hunted by the way that earns the most: a group's
errand, camp or visit, else a raid.

The guard does not judge an enemy by its level above leader level 8, because level says little about a fight: the level 55 and 56 enemies of the Plane of Hate hit for at most 234, the simulator kills them with most groups of 46 to 48 without a death, and group 7 at 45 loses every fight against the level 51 Knight there. The guard's rules that read the fight itself still end it: the leader dying, three hits killing a member, a member down and a healer without mana.

Measured on 2026-11-11, with the level rule at eight levels still on: 23,230 kills, 78 escapes by level, 62 by a dying leader, 52 by a member down, 43 by the healer's mana, and 8 leader deaths. At leader levels of 35 and more, among fights with an enemy of one known level, six levels up gave 32 kills, 11 escapes of a dying leader and 2 leader deaths, seven levels up 10 kills and 6 such escapes, and no fight ever ran eight or more up. Where the simulator won four of four without a death, the group won all 182 live fights of 18 pairs, and where it won with deaths, 9 of 14. Compare a day without the rule against these: leader deaths, escapes by rule, and the kills of groups under 50 in the Plane of Hate.

The simulator fights one enemy, and a live fight has the ones that join. On 2026-11-12, of 25 pairs the simulator won four of four without a death, 19 had 37 live kills and no escape, and six had 1 kill and 8 escapes, all of them group 1's in dungeons: a wanderer in The Hole brought three templebound spirits of level 56. So the simulator's fights leave the chance once the group has a fight of its own with the enemy.

## Migration

| Step | Change | Removes |
| --- | --- | --- |
| 1 | Every live zone's loot tables as drop sources, for the items the plan values. | The band rotations' zone filter on drops and `data/gear-picks.json` |
| 2 | Kill chances per group and enemy from a model fitted to all fights, the simulator for the pairs of highest expected value and each live fight's outcome per enemy, on expected value with deaths. Trips that hunt every wanted enemy of a zone, and claims that value a sooner lesser copy. | `killMargin`, one enemy per hunt, a claimed slot that blocks every other hunt |
| 3 | The guard no longer leaves a fight for the enemy's level above leader level 8. | The level rule at eight levels, and with it the level range an errand stopped at |
| 4 | The raid way for targets above level 50 that no group kills, batched with the boss kills. | |

## Platinum

Platinum is worth little until its uses run short, of which the raid budget is the largest, and the
account earns far more than it spends. So a gear pass, which runs hourly, may spend what the account
earned in the hour before it (the groups' `platPerHour`) less the raid budget's share of that hour
(`buyBudget`), and a purchase pays when its gain clears the move threshold. The standing coin stays
for raids. A leader that carries too little for a purchase pulls the largest account balance first.

## Measured and assumed

| Quantity | Status |
| --- | --- |
| e by level | modeled (leveling plan, lever 7) |
| s per member | measured over the last two hours once a group's tagged damage lines span an hour, else the class's melee share of one sixth |
| Survival | AC and HP count for one sixth of the leveling model's 0.5% per 100, until the damage each member takes is measured |
| T | assumed 10 levels, while each gear pass records how long items stay in a slot (`wear` table, `tools/lib/wear.mjs`), which replaces the assumption once replaced stints span the level bands |
| `sharedCost` 0.4 | one errand of group 4, to be measured from the next shared errands |
| `visitHours` 0.1 | measured at about 1.6 minutes from a visit's start to the group's next fight for a visit that found nothing up, and kept higher, because the visit's deadline comes from the same hours and has to leave the walk to an enemy that is up. Next: a deadline apart from the expected cost, checked against the scenarios where a cheaper visit beats a camp or an errand |
| Kill chance | the model fitted to every simulated fight, the simulator per pair of group and target, and the live fights per enemy of leaders at the group's level or below (kills) and at it or above (escapes) |
| Deaths | their cost measured from the fight logs (`tools/fights.mjs`), their number per fight from the simulator or the model, for each enemy of a chain of deaths at its own level and hit points |
| Kill shares | modeled: an enemy's points over their respawn against the group's kills per hour from the gear pass, until trips are measured |
| Time of day | read from the spawn conditions (`spawnTimes`): an enemy whose points all spawn only by night or by day is hunted only then, by the tab's game hour |
| Travel | about 2 s a zone change (`travel/zone` time over zone entries), so a trip costs its hunting time and a camp ends at its item |
| A camp's XP | measured as none: the leaders earned nothing while their camps waited on the points, so a camp costs its whole time |
| Drop chance | from the content's loot tables with their drop limit (`dropChance` in `tools/lib/gear-data.mjs`): a lootdrop with a limit gives that many of its items, not each at its own chance. Over 151 enemies with 40 or more kills in two days (45,165 kills, 6,362 pairs of enemy and item) the groups looted 47,972 drops where the limit predicts 57,913 and independent rolls 86,399. An Elite Dragoon's four weapons drop at 6.3% each, measured 6.7% over 60 kills, where the plan had counted 25% each |
| The chance a visit finds its enemy | the spawn tables' chance as two visits, then the visits themselves (`upChanceOf`, `ACQUIRE.upPrior`). On 2026-11-13 the tables alone expected 267 of 314 visits to find an enemy and 141 did. A visit for twenty enemies of Chardok, expected to find one 99 times in 100, found one about every second time: other players hunt the same enemies, and a point holds what stands on it until someone kills that |
| What trips bring | on 2026-11-11, with the drop chances still four to seven times too high: 85 camps took 28.4 group-hours for 33 wanted items (1.2 an hour), 409 visits and hunts 15.4 group-hours for 95 (6.2 an hour), and ordinary play gave 72 in about 233 hours. The coordinator had predicted 165 hours of progress from the camps and 266 from the visits. At the plan's gains the items they brought are worth about 7 and 17 hours. With the corrected chances, from 00:50 to 07:40 on 2026-11-12: 200 hunts took 11.5 group-hours for 68 wanted items (5.9 an hour), three of them camps, 13 errands of unrecorded length brought 20, and ordinary play 25 in about 70 hours. From 00:00 to 12:12 on 2026-11-13: 314 visits took 14.2 group-hours by their tasks' length for 69 wanted items (4.9 an hour), 42 camps 6.7 hours for 21, 119 hunts for quest pieces 4.2 hours for 9, the errands brought 25 and ordinary play 21 in about 70 hours. The coordinator had predicted 294 hours of progress from the visits and 53 from the camps. The 22 of the visits' items worn by noon add 3.7% to their groups' XP rates together, about 5 hours of progress at ten levels of wear (some 130 hours at level 55), so the 69 come to about 15 hours. The groups earned 2.8M XP an hour in the minutes of a visit and 2.3M in those of a camp, against 3.8M in play, and a regression of each group's hourly XP on its trips puts their cost at about 5% of the half day's XP, 6 group-hours. So the visits bring about four times their cost, and a twentieth of what the plan predicted, and the largest part of that gap is the row above. An errand's entry closed minutes after it began until 2026-11-13, so the errands' hours are still to measure |

Each measurement replaces its assumption here and in the code that uses it.
