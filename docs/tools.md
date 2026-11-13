# Tools

The command-line tools under `tools/` answer questions about zones, drops, gear, XP and raids from the content snapshot, the saved game client and the collector's data. They read only. The few that ask the live game say so. Each tool's header comment lists its options. The collector and its commands are in [collector.md](collector.md).

Most tools need the content snapshot ([README](../README.md#setup), step 2). The raid simulator also needs `bun install` and a saved client release (`bun tools/client-snapshot.mjs`).

## Zones and drops

Hunting grounds: `scoutZones` saves each zone's spawn list once, and `tools/zones.mjs` ranks zones
for any level by target density and by how many targets have a much stronger monster beside them.

```js
await iq.pausedAutoLevel(() => iq.scoutZones(["Toxxulia Forest", "Crushbone"], "runs/zones"));
```

```sh
bun tools/zones.mjs runs/zones --level 5
```

Where does an item drop? `tools/drops.mjs` joins the developer's public content snapshot (loot
tables, spawn groups, spawn points). Clone it once, then ask. Chances are approximate.

```sh
git clone --depth 1 https://github.com/brynnb/idlequest-content ~/src/github.com/brynnb/idlequest-content   # about 1 GB
bun tools/drops.mjs item "Crushbone Belt"        # NPC, zone, drop chance, spawn chance, respawn, rare
bun tools/drops.mjs npc "orc centurion"          # what an NPC can drop
```

What do the groups actually loot? `tools/loot.mjs` counts each group's kills per enemy in its live
run log and the items looted right after them, with the rate per kill and per hour, so a farm's
yield and the snapshot's chances can be checked against play.

```sh
bun tools/loot.mjs --groups G1 --last 600 --enemy wisp   # kills, stones per kill and per hour
```

Scouting without stopping AutoLevel: `tools/zone-snapshots.mjs` builds the same zone files offline
from the content snapshot (one most-likely NPC per spawn point). Check a zone live before
committing to it, because this approximation does not reproduce every live spawn.
`tools/zones.mjs` filters zones by long name using `data/idlequest-zones.json`, so duplicate
versions of a zone can pass that filter. Confirm the short name against the live client's zone
list before choosing a destination.
`tools/predict.mjs` and `tools/gear.mjs` also require the short name to be in
`data/live-zones.json`, the live client's zone list. Zone changes and the bot's rotation use those
names. Refresh the file when a zone change fails with "zone not found":
`JSON.stringify(window.iq.stores.staticData.getState().zones.map((z) => z.shortName).sort())` in a
game tab.

```sh
bun tools/zone-snapshots.mjs runs/zones-content "."          # all zones, about 10 seconds
bun tools/zones.mjs runs/zones-content --level 15
```

## Gear and tradeskills

Gear: `tools/gear.mjs` lists the best usable item per slot for a class, race and level, with the
mobs that drop it and the merchants that sell it. Armor is ranked by a rough stat score with the
weights documented in the file. Weapons are ranked by base damage capped at the level's limit over
delay, plus the client's flat main-hand bonus and the weapon's proc damage (`weaponRatio` in `tools/lib/gear-data.mjs`). `--party` reads a saved `iq.roster()`
result (`me` and `party`, each with class, race and `items`). Save the roster from an eval cell
first: `await Bun.write("runs/roster.json", JSON.stringify(await iq.roster()))`. The rotation zones
it prints are the bot's band rows (`data/band-rotations.json`) for the level and the next band.
At high levels the score ranks raid drops first, so `--list data/gear/p99-velious-preraid.json`
limits it to the P99 wiki's pre-raid picks, items one group can get. `bun tools/drops.mjs item
--list <names.json>` checks such a list for drop sources.

```sh
bun tools/gear.mjs warrior --level 21 --race dwarf --slot primary --top 5
bun tools/gear.mjs --party runs/roster.json --level 30   # whole-party upgrade plan (merchant, in-rotation, high-gain drops)
bun tools/gear.mjs warrior --level 60 --list data/gear/p99-velious-preraid.json   # best pre-raid item per slot
```

Tradeskills: `tools/tradeskills.mjs` lists a skill's recipes with their cost per attempt from the
crafting catalog, or the components no catalog sells, and the cheapest catalog ladder between two
skill values. Its success rule matched the measured attempts, and its skill-up rate is a model
until crafting measures it ([systems research](plans/systems-research.md), section 2).

```sh
bun tools/tradeskills.mjs tinkering --recipes --to 148   # every recipe, and the ladder up to skill 148
```

## Predicting XP per hour

`tools/predict.mjs` estimates XP per hour per character for every zone at a party level, from the content snapshot and the client's own hit, mitigation and resist formulas. It runs in a few seconds.

```sh
bun tools/predict.mjs --level 25 --top 15            # ranked table: kill, recovery and walk seconds, kills/h, XP/h, danger flags
bun tools/predict.mjs --level 25 --zone permafrost   # per-NPC breakdown of one zone
bun tools/predict.mjs --level 29 --spells [--zone unrest]  # compare nuke/tactic policies for a Magician leader (0/1/2 nuke gems, companion nukes/DoTs)
bun tools/predict.mjs --check                        # the model against three measured cases that are written into the tool, with residuals
```

Flags: `--min-diff` and `--max-diff` (levels relative to the leader, default -99 and 5, so with the bot's minimum con Blue only AutoLevel's green rule sets the lower edge), `--dps` and `--dps-level` (party damage per second against a same-level enemy and the leader level it was measured at), `--dps-exp`, `--spell-share`, `--nuke-resist`, `--overhead`, `--mana-per-sec`, `--tank-hp`, `--tank-ac`, `--healer-mana-pool`, `--caster-mana-pool` (the pools default to group 1's at level 24, scaled with the party level), `--magic-melee` (the share of melee and pet damage from magical hits, default 1), `--heal-cost`, `--speed`, `--stay` (minutes in the zone, which spreads the initial stock of enemies), `--party-levels` (a comma list, default six equal levels), `--content` (the content snapshot directory), `--all` (zones the game does not have) and `--json`. The header of the file explains each step. `--fit` refits `--dps`, `--overhead` and `--mana-per-sec` to the three cases, using the quantities each case measured.

The model includes the spawn table with spawn chances and respawn times, enemy HP, damage, special abilities and resists, the party's hit chance and resist penalty by level difference, the tank's damage taken, recovery from mana and HP at 2.5% per 0.6 s, walking between candidate spawn points, and a spawn-rate cap per zone. It leaves out wandering and named spawns beyond their chance, enemy spells, enrage and rampage timing (a fixed extra damage instead), crowd control, pets as separate damage dealers, other players taking spawns, content flags and spawn conditions, the trip to the zone and loot. Melee immunity follows the client: special ability 19 stops all melee, 23 stops only non-magical hits, and magic weapons and pets of level 10 or more count as magical. The other special ability names follow the EQEmu numbering (`tools/mobs.mjs` says it is from memory), not a check against the client. Walking is the distance to the nearest candidate point, lengthened by a detour factor and by the share of points the party and the account's other groups in the zone have emptied. Party damage follows a curve fitted to the live runs below level 18. Read the table as a ranking, and check a zone live before committing to it.
`tools/calibrate.mjs` compares the model with every stretch of at least 20 minutes that a group spent in one zone at one level, from the collector's run logs, and splits the gap into kills per hour, XP per kill and the fight, move, recover and idle seconds per kill. `--compare` shows the model before and after its last refit per level band, and `--fit` refits the damage curve, the walking detour and the damage factor of groups 2 to 12. Check the calibration output for the level and zone before relying on a prediction, because a fitted damage curve does not account for every zone's fight conditions.

```sh
bun tools/calibrate.mjs --compare
```

`tools/plan.mjs` turns the model into hours of play: for each playing group, the time to the start of levels 46, 50, 55 and 60, from the leader's XP rate over its last hour of AutoLevel (the collector's run logs), the model's rate per level and the XP table the server confirms. Each ETA carries a range of one standard deviation and a word for its certainty. `--stone-xp-h` adds XP per hour from lightstone hand-ins, `--deaths-h` sets the leader's deaths per hour, `--crowd` the other groups per zone and `--new-groups N` adds groups that start at level 1 now. The header says how calibration, deaths and levels above the band rows are handled.

```sh
bun tools/plan.mjs --new-groups 6
```

## Simulating a raid fight

`tools/raidsim.mjs` runs the client's own raid code offline: its member builder, raid tick and boss engine, with a boss from the content snapshot. It compares roster choices against a boss before the characters exist, or the account as the last gear survey found it (`--roster account --leader <name>`). It loads the newest saved client release with a table in `tools/raidsim/clients.mjs` (`--client` picks another one, and `tools/raidsim/map-client.mjs` writes the table). Members get the live creation stats of their race and class (`data/char-create.json`) and the server's skill caps for their level (`data/skill-caps.json`, which `bun tools/skill-caps.mjs` refreshes after a server update), both read from the game. The file header lists what is replaced and what is still assumed. A roster entry overrides race, stats, the bonus-point allocation (`alloc`), skills, items, spells and gear policy.

```sh
bun tools/raidsim.mjs --boss "Hraashna the Warder" --roster tools/raidsim/rosters/groups-1-3.json   # 20 seeded fights, per-member table
bun tools/raidsim.mjs --boss 128093 --roster my-roster.json --class-sweep --slot "G3 monk" --seeds 10 --json
bun tools/raidsim.mjs --boss 128093 --roster my-roster.json --seeds 1 --trace "G1 warrior"   # one member's hit points, damage, healing and hate over time
bun tools/raidsim.mjs --boss 128093 --roster my-roster.json --gear farm --gear-report   # dropped gear and spells, with where each item comes from
```

Every fight runs in its own process and normally takes a few seconds. A fight process that runs for ten minutes is killed and reported as a timeout. A roster file is `{ "level": 60, "members": [{ "name": "Tank", "class": "warrior", "leader": true }, ...] }`. The numbers are as good as the remaining assumptions, so use them to compare rosters and not as a forecast.

A member without `items` or `spells` gets a default kit from a gear policy: `--gear merchant` (the default), `"gear"` in the roster file, or `"gear"` in a member, which wins. `merchant` is the best item per slot that any merchant sells and every merchant scroll. `farm` is, per slot, the best item by the score of `tools/gear.mjs` that the member's class and race can use at its level and can get from a merchant in a live zone or from the drops of an ordinary NPC in a live zone (no Raid Resolve boss, no raid target, none above level 60), where one copy takes at most `--farm-hours` of camping (default 4). That time is the respawn time divided by the spawn chance and the drop chance, for one spawn point. Scrolls follow the same rule and add to the merchant ones. `--gear-report` prints every member's items with their sources, so a pick can be checked against the content tables. The farm kit applies the client's item rules (only the highest haste counts, hit point and mana regeneration stop at 15), leaves out items that need a deity and does not value the worn and focus effects of items. The score and the source tables are in `tools/lib/gear-data.mjs`, shared with `tools/gear.mjs`.

`tools/raidsweep.mjs` runs raidsim over a grid of bosses, levels and roster sizes: the base roster plus 0 or more extra groups of one composition. Every configuration's result is kept under `runs/jobs/<sweep>/`, so a rerun only runs what is missing. Flags after `--` go to raidsim.

```sh
bun tools/raidsweep.mjs --name size-check --bosses resolve --levels 46,55,60 --extra 0,3,6 --seeds 4
bun tools/raidsweep.mjs --name heal-mode --bosses 127098 --levels 60 --extra 3 -- --heal-mode all-balanced
```

`tools/raid-kit.mjs` finds the gear swaps among the roster's carried items that make a boss fight go better in the simulator: a higher kill chance, then a shorter mean kill time, then less boss hit points left. It writes the kit to `runs/state/raid-kit.json` (needs a gear survey, `runs/state/account-items.json`) and prints a table. Without `--boss` it takes the goal boss that is closest to a kill. A full run takes up to `--budget` minutes, and the header of the file lists the options and how the search works.

```sh
bun tools/raid-kit.mjs --boss 72003 --seeds 6   # Cazic-Thule
```

`tools/kill-odds.mjs` fights each daily boss and each casino potion boss the survey finds with all roster characters and with the strongest group's six, and the pairs of group and gear target with the highest expected value under the model fitted to every simulated fight (`tools/lib/kill-prior.mjs`). Its fights run in the client's raid mode, which takes only enemies above level 50. It writes the kill chances and the model to `runs/state/kill-odds.json`, keeps a result for a day at its group's level, and fights `--pairs` pairs a run.

Kill odds uses the newest saved client release that has a table in `tools/raidsim/clients.mjs`. It prints a notice when a newer saved release lacks a table. A failed group or raid simulation is saved as an error for that variant, while the remaining variants and targets proceed. Errors are not treated as fresh successful results on the next run.

## Measuring play

The bridge records one sample per second (level, XP, position, combat state, every party member's
HP and mana, the active experiment label) and every chat line with the game's own timestamp.

```js
await iq.setLabel("B-some-change");   // tag the samples that follow
await iq.exportRun("runs/my-run");    // append new rows to runs/my-run/*.jsonl, resumable
```

```sh
bun tools/analyze.mjs runs/my-run --label B-some-change
bun tools/analyze.mjs runs/my-run --last 30m --member Ewbanaqoa   # one member's rate, for setups with different leaders
```

The analyzer puts every second outside combat into exactly one cell: moving, recovering (standing
still while someone is below full HP or mana) or ready-idle, and names the party member that fills
last. Compare configurations by label, with similar level and enemy mix, and never on one block.
The leader's rate depends on the leader's race and class factor, so compare setups with different
leaders by a member who is a companion in both (`--member`). The "Zone multiplier" section checks
each zone's XP multiplier against the content snapshot and the wiki by testing which one makes
every kill's XP fit a whole NPC level. Use the fit shares rather than assuming either source is correct.

- Check that a setting took effect in the event log before trusting a comparison. A tactic written
  under the wrong key is stored and silently ignored.
- Read position from the client's position packets. The character profile's `x`/`y` only updates on
  zone entry.
- Validate any new indicator against the game's messages before building on it.
`tools/characters.mjs` lists every account character with its class, race, level, worn gear and
armor class, grouped by `data/roster.json`. It asks the server for each character's raid
projection (opcode 1194, the read-only request the raid window uses to load a recruit) in any game
tab through the relay, and writes every worn item to `runs/state/characters.json`.

```sh
bun tools/characters.mjs
```

`tools/groups.mjs` runs the analyzer on every group's live run (`runs/live/<leader>`, kept by iqd)
and prints one line per group from `data/roster.json`: level, zone, class mix, XP per hour, the
shares of fighting, moving and recovering, guard escapes, deaths and the member the party waited
for most. It is the side-by-side view for comparing class mixes and checking a change on all groups.

```sh
bun tools/groups.mjs --last 60
bun tools/groups.mjs --since 1794140961654 --until 1794143661654   # one block of an experiment
```

`tools/crossover.mjs` reads a crossover across groups in alternating blocks: arm A runs a setting in
odd blocks and arm B in even ones, so each group is compared with itself, more blocks cancel a
group's slow drifts, and the period effect cancels between the arms. It prints each group's
numbers with the setting on and off and the setting's effect on XP per hour (as a ratio), escapes
and deaths per hour, each with an interval of two standard errors.

```sh
bun tools/crossover.mjs --start 1794140961654 --block 20 --blocks 6 --a G2,G4,G6 --b G3,G5,G7 --label fightingOnly
```

`tools/fights.mjs` splits every recorded run into fights and reports what the guard's escapes and
the deaths cost, which danger signals predicted deaths (the level gap of mobs that hit someone,
incoming damage against the victim's HP, the number of mobs) and a replay of candidate escape
rules on the fights the guard did not leave. `--dump` prints one JSON object per fight.

```sh
bun tools/fights.mjs
```
