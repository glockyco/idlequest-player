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

    V = g × s × e × T        C = H × k

| Term | Meaning | Source |
| --- | --- | --- |
| g | the item's gain to its wearer's output, against what the wearer has after this pass's moves | `outputValue` and `weaponRatio` in `tools/lib/gear-data.mjs` |
| s | the wearer's share of the party's damage | 1/6 for every member |
| e | the change of XP per hour for a change of party damage, by level | the leveling model, leveling plan lever 7 |
| T | the hours the copy is worn | 10 levels at the pace of the wearer's group, the pace of level 59 at 60, where AA XP takes the place of levels |
| H | the expected hunting hours for one copy | respawn over spawn chance, drop chance and points, from the content snapshot |
| k | the share of the hunting group's XP lost while it hunts | 0 inside its rotation, the measured or modeled rate of the trip zone outside it |

`g × s × e` is the relative gain of the group's XP rate, so `V` is in hours of the group's progress.
A copy is worth getting when `V > C`. A group's time is what each choice spends, so the pair of free
group and target with the most `(V - C) / H` goes first, then the best pair of what is left. A target
whose best group is busy goes to another free group while it still gains there, and otherwise waits.

A copy serves one character. Each item counts at its best taker, and each character slot once. An
enemy's worth adds its items, since each drop rolls on its own, so a copy of any of them comes every
`1 / sum(1 / H)` hours.

## Ways to get a copy

| Way | H | k | When it is chosen |
| --- | --- | --- | --- |
| Move | none | none | the account holds a free copy (the gear plan's moves) |
| Purchase | none | platinum | a merchant in a city sells it, within `BUY_PP` platinum a pass |
| Errand | hours per copy | 0, or `sharedCost` when another group plays the zone | the enemy's zone is in the group's rotation |
| Camp | hours per copy | 1 less the share of the group's XP the trip zone pays | outside the rotation, when it earns more than a visit |
| Visit | `visitHours` | 1 | outside the rotation, for rare spawns: worth the chance the enemy is up on arrival, `1 - (1 - spawn)^points`, times each drop chance and copy value |

A visit reads the zone's spawn list on arrival and fights the enemy only when it is up. An enemy more
than `killMargin` levels above the hunting group's leader is not hunted.

## Platinum

The account earns about 5,600 pp an hour and holds far more than it spends, so a fixed budget per
pass (`BUY_PP`) leaves purchases undone that would pay. Platinum is worth little until its uses run
short, of which the raid budget is the largest. The rule to build: a purchase pays when `V > 0` and
the account's platinum after it stays above the raid budget of the coming days.

## Measured and assumed

| Quantity | Status |
| --- | --- |
| e by level | modeled (leveling plan, lever 7) |
| s per member | assumed 1/6, while at 29-31 the two pets dealt 42% of the damage and two companions 4% each (leveling plan, lever 7), to be measured per member from the fight logs |
| T | assumed 10 levels, until the gear plan tracks what replaces an item |
| `sharedCost` 0.4 | one errand of group 4, to be measured from the next shared errands |
| `visitHours` 0.1 | assumed, to be measured from the first visits |
| `killMargin` 3 | assumed, to be checked against the guard's escapes |
| Time of day | not read: the sources ignore day and night spawn conditions, so a hunt for a night spawn can come by day |
| Travel | about 2 s a zone change (`travel/zone` time over zone entries), so a trip costs its hunting time and a camp ends at its item |
| Trip zone's share of XP | measured rates where both zones have them, else the leveling model's prediction for both, which is unchecked for zones no group has played |

Each measurement replaces its assumption here and in the code that uses it.
