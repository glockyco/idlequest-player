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
| k | the share of the hunting group's XP lost while it hunts | 0 inside its rotation, the measured or modeled rate of the trip zone outside it |
| D | the deaths of the fights one copy takes, won and lost | [Kill chance](#kill-chance) |

`g` is the relative gain of the group's XP rate, so `V` is in hours of the group's progress. The
same `g` decides the gear plan's moves, so an item goes to the member it adds most XP through: a
weapon to the member whose melee deals most of the party's damage, not to a pet class whose pet does.
A copy is worth getting when `V > C`. A group's time is what each choice spends, and a trip takes a
group to one zone, where it hunts every wanted enemy that pays: the zone's cost `k` is paid once,
each enemy adds its drops less its deaths, and the enemies share the group's kills. An enemy hunted
at its full rate takes the share of the group's kills its points give as they respawn, and when the
shares pass all of the group's kills, the enemies that pay most per share keep theirs. The
assignment is greedy with re-evaluation: the pair of free group and zone whose trip earns the most
per hour goes first, then every other pair is valued again with that trip's taker slots claimed and
its zone occupied, so a second group there pays the shared cost.

A copy serves one character. Each item counts at its best taker, and each character slot once. An
enemy's worth adds its items, since each drop rolls on its own, so a copy of any of them comes every
`1 / sum(1 / H)` hours. A slot another hunt already serves still takes a copy that comes sooner: it
is worn until the other hunt's copy would come, and adds for good only what it gains over that copy.
So a group takes a quick lesser upgrade while a stronger group hunts the best one.

## Ways to get a copy

| Way | H | k | When it is chosen |
| --- | --- | --- | --- |
| Move | none | none | the account holds a free copy (the gear plan's moves) |
| Purchase | none | platinum | a merchant in a city sells it, within the pass's platinum budget |
| Errand | hours per copy | 0, or `sharedCost` when another group plays the zone | the enemy's zone is in the group's rotation |
| Camp | hours per copy | 1 less the share of the group's XP the trip zone pays | outside the rotation, when it earns more than a visit |
| Visit | `visitHours`, and the group's time per kill for each enemy up | 1 | outside the rotation, for rare spawns: worth the chance the enemy is up on arrival, `1 - (1 - spawn)^points`, times the kill chance and each drop chance and copy value |

A visit reads the zone's spawn list on arrival and fights the enemy only when it is up. A raid, for an enemy above level 50 that no group kills, is planned with the boss kills ([boss kills](raids.md)).

## Where the copies are

Every live zone's loot tables are a source, for every item the gear plan values: the leveling kit, the raid kit and the account's demand. The highest enemy level in a live zone is 70 (the content's spawn and loot tables, 8,799 gear-dropping enemies). For a level-60 character the best item per slot drops mostly from enemies of level 56 to 60, by the gear score over the content's loot tables:

| Droppers up to level | Share of the best level-60 armor value | Best item per slot (14 classes, 17 slots) |
| --- | --- | --- |
| 55 | 63 to 88% | 89 |
| 60 | 91 to 100% | 112 more |
| 65 | no more than at 60 | 8 more |
| 70 | 100% | 29 more |

So groups at 60 need to kill enemies of their own level, and the last few percent, and some casters' best weapons, come from enemies of 66 to 70, which take a raid.

## Kill chance

Whether a group kills an enemy is a kill chance per group and enemy, not a level margin. Three kinds
of fights are its evidence, and each fight counts once, so the pair's own fights outweigh the rest
as they come:

- a model fitted to every simulated fight of every group (`tools/lib/kill-prior.mjs`), counted as
  one fight: the chance falls with the enemy's level above the group's leader and with its hit
  points, so a doable target is hunted before anyone has simulated it;
- the raid simulator's fights of the group's six as surveyed (`tools/kill-odds.mjs`), for the pairs
  of group and target with the highest expected value under the model and for the boss kills,
  refreshed hourly and kept for a day at the group's level. The simulator fights in the client's
  raid mode, which takes only enemies above level 50;
- the group's live fights against the enemy at its current level (`tools/lib/fight-record.mjs`):
  each kill, and each escape of the guard that names the enemy.

A copy then takes `H / p` hours, and every fight, won or lost, pays its expected deaths: a
companion's death costs 38 s and the leader's 85 s plus level² × 666.67 XP at the group's pace
(`bun tools/fights.mjs`, "What escapes and deaths cost"). Deaths per fight come from the simulator
for the pair, else from the model's means for won and lost fights. The choice is by expected value,
so no chance is too low in itself: the dashboard calls a target too strong when its best group's
chance is below 5% (`tooStrong`). A target is hunted by the way that earns the most: a group's
errand, camp or visit, else a raid.

The guard's level rule stops a fight against an enemy the plan did not choose. A planned target with a kill chance is exempt from it, and the guard's rules on hit points, a down member, a healer without mana and a fight without headway still end the fight.

## Migration

| Step | Change | Removes |
| --- | --- | --- |
| 1 | Every live zone's loot tables as drop sources, for the items the plan values. | The band rotations' zone filter on drops and `data/gear-picks.json` |
| 2 | Kill chances per group and enemy from a model fitted to all fights, the simulator for the pairs of highest expected value and each live fight's outcome per enemy, on expected value with deaths. Trips that hunt every wanted enemy of a zone, and claims that value a sooner lesser copy. | `killMargin`, one enemy per hunt, a claimed slot that blocks every other hunt |
| 3 | The guard exempts a planned target from its level rule. | |
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
| `visitHours` 0.1 | assumed, to be measured from the first visits |
| Kill chance | the model fitted to every simulated fight, the simulator per pair of group and target, and the group's live fights per enemy at its level |
| Deaths | their cost measured from the fight logs (`tools/fights.mjs`), their number per fight from the simulator or the model |
| Kill shares | modeled: an enemy's points over their respawn against the group's kills per hour from the gear pass, until trips are measured |
| Time of day | read from the spawn conditions (`spawnTimes`): an enemy whose points all spawn only by night or by day is hunted only then, by the tab's game hour |
| Travel | about 2 s a zone change (`travel/zone` time over zone entries), so a trip costs its hunting time and a camp ends at its item |
| Trip zone's share of XP | measured rates where both zones have them, else the leveling model's prediction for both, which is unchecked for zones no group has played |

Each measurement replaces its assumption here and in the code that uses it.
