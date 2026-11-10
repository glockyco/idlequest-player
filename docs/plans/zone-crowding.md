# Zone crowding: shares of a zone's supply

## Decision

A zone supplies a number of in-band kills an hour, and the account's groups in it share that
supply: they lose little until their combined demand exceeds it, then a lot. So `assignZones` in
`tools/lib/coordinator.mjs` values a zone for a group as its measured rate alone times
`crowdFactor(zone, level, n)` for the `n` groups already there, and iqd takes the factor from the
physical model in `tools/predict.mjs`: `predict(zone, level, n) / predict(zone, level, 0)`. In that
model every kill empties a point until its respawn, the other groups' kills empty the same
candidates, which lengthens the walk, and kills cannot exceed the zone's spawn rate shared among
the groups. A zone the model lacks counts as shared evenly.

The rate alone is measured over all of a zone's time (`tools/lib/rates.mjs`): a second shared with
`n` other groups counts as `crowdFactor(zone, level, n)` seconds alone. Measured over the minutes
a group was alone only, it overrates a zone the account keeps busy, because those minutes follow
the other groups' departure with every spawn point up.

A rotation that already holds the right zones stays only while the group should stay in its zone,
since the bot moves along its rotation only when a zone runs dry.

## Why

A fixed loss per extra group cannot fit what the samples show at matched leader levels:

| Zone | Measured, XP per hour against fewer groups | Model factor at 34 |
| --- | --- | --- |
| Solusek's Eye | about 1.0 with up to four others, 0.71 to 0.75 with five, 0.56 with six | 0.89 with four, 0.76 with six |
| Unrest at 31 to 35 | 0.62 to 0.87 with one other | 0.63 |
| Dalnir | 0.84 to 0.93 with one or two others | 0.98 to 0.99 |

The earlier weight of 0.5 a group valued Solusek's Eye at a third with four others and sent groups
to zones that measure worse.

## Open

- The factors count each other group fully. `tools/plan.mjs` and `tools/calibrate.mjs` count
  another group as half (`--crowd-weight`), a fit from earlier runs that today's crowded rates do
  not support. Refit it with `tools/calibrate.mjs --fit` once a day of crowded stretches per zone
  exists, and use one value in both places.
- Fit the factors to the measured rates per number of groups once the rates alone stop moving, and
  replace the model's factors where they disagree beyond the measurement noise.
