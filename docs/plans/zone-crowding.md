# Zone crowding: shares of a zone's supply

## Decision

A zone supplies a number of in-band kills an hour, and the account's groups in it share that
supply: they lose little until their combined demand exceeds it, then a lot. `crowdFactor(zone,
level, n)` in `tools/iqd.mjs` is the share of its rate alone a group earns beside `n` others. It
weighs the zone's own measurement by its hours against the physical model in `tools/predict.mjs`
as a quarter hour (`CROWD_PRIOR_H`), so the measurement takes over once the account has shared a
zone. The measured share (`crowdShare` in `tools/lib/rates.mjs`) is the time a group hunts beside
`n` others, which is the time it does not stand idle for want of a target, over the same with the
fewest others on record. It pools the levels within two of the group's, counts from ten minutes of
play at a number of groups, and never rises with that number. The model's share is
`predict(zone, level, n) / predict(zone, level, 0)`. In that model every kill empties a point until
its respawn, the other groups' kills empty the same candidates, which lengthens the walk, and kills
cannot exceed the zone's spawn rate shared among the groups. A zone the model lacks counts as
shared evenly.

`assignZones` in `tools/lib/coordinator.mjs` values a zone for a group by what it adds to the
account there: its rate alone times `(n+1) f(n) - n f(n-1)`, its own share less what it takes
from the `n` groups already there. Valued by its own share alone, a group counts none of that
loss, and six groups gathered in Solusek's Eye.

The rate alone is measured over all of a zone's time (`tools/lib/rates.mjs`): a second shared with
`n` other groups counts as `crowdFactor(zone, level, n)` seconds alone. Measured over the minutes
a group was alone only, it overrates a zone the account keeps busy, because those minutes follow
the other groups' departure with every spawn point up.

A rotation that already holds the right zones stays only while the group should stay in its zone,
since the bot moves along its rotation only when a zone runs dry. A group that moves gets its new
zone without the old one, so its bot goes, and the next zones once it stays there, so its bot has
somewhere to go when the zone fills.

A group within two levels of the next band row also ranks that row's zones (`bandZones`), so the
groups of one band spread over more zones than one row holds.

## Why

A fixed loss per extra group cannot fit what the samples show at matched leader levels:

| Zone | Measured, XP per hour against fewer groups | Model factor at 34 |
| --- | --- | --- |
| Solusek's Eye | about 1.0 with up to four others, 0.71 to 0.75 with five, 0.56 with six | 0.89 with four, 0.76 with six |
| Unrest at 31 to 35 | 0.62 to 0.87 with one other | 0.63 |
| Dalnir | 0.84 to 0.93 with one or two others | 0.98 to 0.99 |

The earlier weight of 0.5 a group valued Solusek's Eye at a third with four others and sent groups
to zones that measure worse.

The model alone misjudges the zones the account shares most. Beside three other groups at level
42, a group earned 0.65 of its rate alone in Solusek's Eye and 0.74 in Paw, where the model gives
0.50 and 0.49. With the model's factors those zones looked worse to share than they are, so five to
seven groups gathered in Kaesora and idled for crowding. One band row's three zones also served
nine groups.

The measured share was first the zone's XP per hour beside `n` others over its XP per hour alone
at one leader level. Two things kept it from counting. A busy zone has almost no time alone at the
groups' level, and the hours of the scarcer side weighed the measurement: Kedge Keep at 51 and 52
had 0.1 to 0.5 hours alone, against the model's two. And XP per hour by count swings by half from
one cell to the next (Kedge Keep at 52: 4.24M beside one group, 2.23M beside two, 3.35M beside
three, 1.89M beside four). So the model's 0.89 stood for Kedge Keep beside four groups, five groups
hunted there on 2026-11-12, and four of them stood idle for 37 to 62% of an hour.

The time a group waits for a target needs no time alone and is steady. Over 100 group-hours of
2026-11-12 by the number of other account groups in the zone:

| Zone | Time idle for want of a target |
| --- | --- |
| The Tower of Frozen Shadow | 0% with one to seven others (71 hours) |
| Kedge Keep | 4% alone, 3% with one, 7% with two, 13% with three, 31% with four |

The two zones pay about the same alone at 51 and 52 (3.5M to 3.8M an hour at normal XP), so Kedge
Keep is worth two or three groups and the tower the rest.

## Open

- The factors count each other group fully. `tools/plan.mjs` and `tools/calibrate.mjs` count
  another group as half (`--crowd-weight`), a fit from earlier runs that today's crowded rates do
  not support. Refit it with `tools/calibrate.mjs --fit` once a day of crowded stretches per zone
  exists, and use one value in both places.
