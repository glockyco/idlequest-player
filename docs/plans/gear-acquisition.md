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

    V = g × T        C = H × k
    g = e × (s_melee × Δmelee + s_spell × Δspells) + Δparty

| Term | Meaning | Source |
| --- | --- | --- |
| g | the copy's gain to the taker's group's XP rate, against what the taker has after this pass's moves (`xpGain`) | `xpGain` in `tools/lib/gear-plan.mjs` |
| Δmelee, Δspells | the change of the taker's own melee and spell damage | `outputValue` and `weaponRatio` in `tools/lib/gear-data.mjs` |
| Δparty | the party time or XP the item saves directly: shorter rests, a Bard's faster walk, survival | `outputValue` and `walkValue` |
| s_melee, s_spell | the taker's melee and spell share of the party's damage | measured from the fight lines the bridge tags by source (`damageShares`), else the class's melee share of one sixth |
| e | the change of XP per hour for a change of party damage, by level | the leveling model, leveling plan lever 7 |
| T | the hours the copy is worn | 10 levels at the pace of the taker's group, its own XP per hour over the last two hours of minute totals without task minutes, the pace of level 59 at 60, where AA XP takes the place of levels. Without a measured pace a copy's worth is unknown, and the target says so |
| H | the expected hunting hours for one copy | the longer of the respawns' bound (respawn over spawn chance, drop chance and points, from the content snapshot) and the kill rate's (one over the hunting group's kills per hour times spawn and drop chance, `copyHours`) |
| k | the share of the hunting group's XP lost while it hunts | 0 inside its rotation, the measured or modeled rate of the trip zone outside it |

`g` is the relative gain of the group's XP rate, so `V` is in hours of the group's progress. The
same `g` decides the gear plan's moves, so an item goes to the member it adds most XP through: a
weapon to the member whose melee deals most of the party's damage, not to a pet class whose pet does.
A copy is worth getting when `V > C`. A group's time is what each choice spends, and one copy fills
one character's slot, so the assignment is greedy with re-evaluation: the pair of free group and
target with the most `(V - C) / H` goes first, then every other pair is valued again without the
taker slots that pair serves and with its zone occupied, so a second group there pays the shared
cost. A target whose best group is busy goes to another free group while it still gains there, and
otherwise waits.

A copy serves one character. Each item counts at its best taker, and each character slot once. An
enemy's worth adds its items, since each drop rolls on its own, so a copy of any of them comes every
`1 / sum(1 / H)` hours.

## Ways to get a copy

| Way | H | k | When it is chosen |
| --- | --- | --- | --- |
| Move | none | none | the account holds a free copy (the gear plan's moves) |
| Purchase | none | platinum | a merchant in a city sells it, within the pass's platinum budget |
| Errand | hours per copy | 0, or `sharedCost` when another group plays the zone | the enemy's zone is in the group's rotation |
| Camp | hours per copy | 1 less the share of the group's XP the trip zone pays | outside the rotation, when it earns more than a visit |
| Visit | `visitHours` | 1 | outside the rotation, for rare spawns: worth the chance the enemy is up on arrival, `1 - (1 - spawn)^points`, times each drop chance and copy value |

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

Whether a group kills an enemy is a kill chance per group and enemy, not a level margin. The raid simulator fights the enemy with the group's six as surveyed, for the enemies of the plan's best targets, and the result is kept until the next survey. Each live fight of a hunt, a camp or a visit records its outcome per enemy (kill, the guard's escape and why, deaths), and the live record replaces the simulator's chance once it holds a few fights. A target is hunted by the cheapest way that kills it: a group's errand, camp or visit, else a raid. Group 1's six at 51 and 52 kill Lady Vox (55) in the simulator and did in normal play, and lose to Lodizal (60) and Trakanon (65) in the simulator.

The guard's level rule stops a fight against an enemy the plan did not choose. A planned target with a kill chance is exempt from it, and the guard's rules on hit points, a down member, a healer without mana and a fight without headway still end the fight.

## Migration

| Step | Change | Removes |
| --- | --- | --- |
| 1 | Every live zone's loot tables as drop sources, for the items the plan values. | The band rotations' zone filter on drops and `data/gear-picks.json` |
| 2 | Kill chances per group and enemy from the simulator, for the best targets, and each live fight's outcome per enemy. | `killMargin` |
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
| Kill chance | the simulator per group and enemy, replaced by each enemy's live record (step 2 of the migration). `killMargin` 3 applies until then |
| Time of day | read from the spawn conditions (`spawnTimes`): an enemy whose points all spawn only by night or by day is hunted only then, by the tab's game hour |
| Travel | about 2 s a zone change (`travel/zone` time over zone entries), so a trip costs its hunting time and a camp ends at its item |
| Trip zone's share of XP | measured rates where both zones have them, else the leveling model's prediction for both, which is unchecked for zones no group has played |

Each measurement replaces its assumption here and in the code that uses it.
