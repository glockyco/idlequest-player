# idlequest-player

Tools for playing [IdleQuest](https://idlequest.net/play), a browser recreation of classic EverQuest
with an AutoLevel mode, and a diary of the character played with them.

## How it works

The game simulates combat, AutoLevel and party tactics inside the browser client. The server holds
the account, inventory and zone state. A standalone program that talks to the server directly would
have to reimplement the combat engine, so this project drives the real client instead:

- `src/bridge.js` is evaluated inside the game page. It finds the client's state stores and its
  server socket and exposes them as `window.iq`.
- `src/bot.js` runs inside the page next to the bridge as `window.iqBot`. It keeps AutoLevel
  running, banks ingredients and sells cheap loot before the bags fill, rotates zones, runs
  errands for named drops and raises alerts, with or without a script attached.
- `src/client.mjs` injects both into a browser tab and calls them from a script.

Agents that play the account follow [AGENTS.md](AGENTS.md).

Protocol and client internals: [docs/client-internals.md](docs/client-internals.md).

## Setup

1. Open https://idlequest.net/play in Chrome and sign in.
2. Attach a browser tab that supports `evaluate`, `click`, `clickAt`, `fill` and
   `waitForSelector`, for example an omp `browser` tab with the relay enabled.

```js
import { attach } from "./src/client.mjs";
const iq = await attach(tab);
console.log(await iq.status());
```

## Common tasks

```js
const party = await iq.roster();                    // every character: class, level, HP, mana, gear
await iq.setTactic("Edroun", "nuke", false);       // stop a member nuking (also the active character, or "cleric", "warrior", "rogue")
await iq.startAutoLevel({ minCon: 10, maxCon: 15, maxLevelDiff: 2 });  // con values: 2 green, 4 blue, 10 white, 15 yellow, 13 red
await iq.pausedAutoLevel(() => iq.travelTo("gfaydark"));  // pause, teleport, restart if it was running
await iq.setLeader("Tagujazolu");                  // lead the group with another member for good; the bot switches and regroups
await iq.switchCharacter("Edroun");                // play another character for a while; the bot switches back when its pause ends
await iq.handIn({ members: [{ name: "Edroun", counts: { "Greater Lightstone": 2 } }] });  // the bot's task: each member hands in at Smith Tv`ysa, then back to the leader
await iq.quest({ members: ["Tagujazolu"], steps: quests["warrior-epic-1"].steps });  // quest steps from data/quests.json for each member, as the active character
await iq.hunt({ zone: "mistmoore", keep: "gypsy dancer", item: "Power of Wind", waitMin: 3 });  // gray drops through Enemy Targets
await iq.raidTime();                                // price of a raid hour in platinum, expiry (read only)
await iq.dailyBosses();                             // the zone's daily raid bosses and resets, from level 46
await iq.raid({ members: ["Domeyafun", "Edroun"], target: "Nagafen", zone: "soldungb", maxPp: 2500 });  // the bot's raid task: one fight, then back to leveling
```

A new leveling group comes from a `planned` entry in `data/roster.json`. `createGroup` opens the
tab `iq-<id>`, signs in from the local login files, creates the six characters with the race that
has the best creation stats for each class, kits each one in Rivervale (starter weapon, packed
general slots, a Backpack in every free general slot, coin from the richest character outside
group 1), and starts AutoLevel in the level 1 band zone. It writes the names to the roster file as
soon as they exist. It takes about six minutes. Check the machine's free memory before each group.

```js
const { attach } = await import("./src/client.mjs");
const { createGroup } = await import("./src/group.mjs");
await createGroup({ browser, attach, id: "G7" });
```

Merchant spells are bought automatically when the game's missing-spells reminder appears. This
runs inside the page whether or not AutoLevel is active. To trigger it manually or disable it:

```js
await iq.buySpells();
await iq.setChores({ autoBuySpells: false });
```

Unattended play: the bot checks every 15 seconds. `watch` waits until it raises an alert that
needs attention, or until the time is up, and returns a compact report. To play by hand, pause the
bot first, because it starts AutoLevel again a minute after it stops.

```js
const r = await iq.watch({ minutes: 50, sinceSeq: 0, exportDir: "runs/my-run" });
await iq.pauseBot(30, "playing by hand");   // AutoLevel may stay off for 30 minutes
await iq.setBot({ minFreeSlots: 10, keepItemIds: [10015, 13077] });  // settings persist in this tab across reloads
```

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
from the content snapshot (one most-likely NPC per spawn point). Blackburrow, the Qeynos Aqueduct
and Greater Faydark came out within about 10% of live scouts in candidates and nearest-candidate
distance at level 5. Toxxulia Forest did not: the snapshot has two zones with that name (`tox` and
`toxxulia`), `tox` shows 114 candidates against 86 live, and only `toxxulia` matched the live
scout before the client's zone list changed. Check a zone live before committing to it.
`tools/zones.mjs` skips zones the game does not have (`data/idlequest-zones.json`, from the wiki,
with each zone's XP multiplier), but it matches them by long name, so both Toxxulia rows pass.
`tools/predict.mjs` and `tools/gear.mjs` also require the short name to be in
`data/live-zones.json`, the live client's zone list. Zone changes and the bot's rotation use those
names. Refresh the file when a zone change fails with "zone not found":
`JSON.stringify(window.iq.stores.staticData.getState().zones.map((z) => z.shortName).sort())` in a
game tab.

```sh
bun tools/zone-snapshots.mjs runs/zones-content "."          # all zones, about 10 seconds
bun tools/zones.mjs runs/zones-content --level 15
```

Gear: `tools/gear.mjs` lists the best usable item per slot for a class, race and level, with the
mobs that drop it and the merchants that sell it. Armor is ranked by a rough stat score with the
weights documented in the file. Weapons are ranked by base damage capped at the level's limit,
divided by delay, the comparison the IdleQuest wiki gives. `--party` reads a saved `iq.roster()`
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

## Predicting XP per hour

`tools/predict.mjs` estimates XP per hour per character for every zone at a party level, from the content snapshot (clone it as above) and the client's own hit, mitigation and resist formulas. It runs in a second or two.

```sh
bun tools/predict.mjs --level 25 --top 15            # ranked table: kill, recovery and walk seconds, kills/h, XP/h, danger flags
bun tools/predict.mjs --level 25 --zone permafrost   # per-NPC breakdown of one zone
bun tools/predict.mjs --level 29 --spells [--zone unrest]  # compare nuke/tactic policies for a Magician leader (0/1/2 nuke gems, companion nukes/DoTs)
bun tools/predict.mjs --check                        # the model against three measured cases that are written into the tool, with residuals
```

Flags: `--min-diff` and `--max-diff` (levels relative to the leader, default -99 and 5, so with the bot's minimum con Blue only AutoLevel's green rule sets the lower edge), `--dps` and `--dps-level` (party damage per second against a same-level enemy and the leader level it was measured at), `--dps-exp`, `--spell-share`, `--nuke-resist`, `--overhead`, `--mana-per-sec`, `--tank-hp`, `--tank-ac`, `--healer-mana-pool`, `--caster-mana-pool` (the pools default to group 1's at level 24, scaled with the party level), `--magic-melee` (the share of melee and pet damage from magical hits, default 1), `--heal-cost`, `--speed`, `--stay` (minutes in the zone, which spreads the initial stock of enemies), `--party-levels` (a comma list, default six equal levels), `--content` (the content snapshot directory), `--all` (zones the game does not have) and `--json`. The header of the file explains each step. `--fit` refits `--dps`, `--overhead` and `--mana-per-sec` to the three cases, using the quantities each case measured.

The model includes the spawn table with spawn chances and respawn times, enemy HP, damage, special abilities and resists, the party's hit chance and resist penalty by level difference, the tank's damage taken, recovery from mana and HP at 2.5% per 0.6 s, walking between candidate spawn points, and a spawn-rate cap per zone. It leaves out wandering and named spawns beyond their chance, enemy spells, enrage and rampage timing (a fixed extra damage instead), crowd control, pets as separate damage dealers, other players taking spawns, content flags and spawn conditions, the trip to the zone and loot. Melee immunity follows the client: special ability 19 stops all melee, 23 stops only non-magical hits, and magic weapons and pets of level 10 or more count as magical. The other special ability names follow the EQEmu numbering (`tools/mobs.mjs` says it is from memory), not a check against the client. Walking is the distance to the nearest candidate point, lengthened by a detour factor and by the share of points the party and the account's other groups in the zone have emptied. Party damage follows a curve fitted to the live runs below level 18. Read the table as a ranking, and check a zone live before committing to it.

Calibration cases. Permafrost at leader level 24 to 25 measured 2.91 kills per minute, 2.30M XP/h, 13,217 XP per kill, a 13 s mean kill and 64.6% of the time in combat. The City of Guk at level 21 measured 3.19 kills per minute, 1.64M XP/h and a 10.3 s median kill. The Estate of Unrest at level 29 measured 1.92 kills per minute, 2.75M XP/h, 15,051 XP per kill and a 13.0 s median kill. The defaults (`DEFAULTS` in the tool, with their fit in the comments) keep these three cases within 7% for XP per hour after the refit on the live runs below. Residuals, model against measured:

| Quantity | Permafrost | City of Guk | Estate of Unrest |
| --- | ---: | ---: | ---: |
| XP/h per leader | +3% | -1% | -7% |
| Kills per minute | +8% | -12% | +42% |
| XP per kill | -5% | | +4% |
| Mean kill seconds | -12% | | -4% |
| Median kill seconds | -12% | +3% | -3% |

`tools/calibrate.mjs` compares the model with every stretch of at least 20 minutes that a group spent in one zone at one level, from the collector's run logs, and splits the gap into kills per hour, XP per kill and the fight, move, recover and idle seconds per kill. `--compare` shows the model before and after its last refit per level band, and `--fit` refits the damage curve, the walking detour and the damage factor of groups 2 to 12. The model is least certain at levels 1 to 3, 11 to 14 (Crushbone fights take twice the model's time for a reason not found) and above 39, where no group has played yet.

```sh
bun tools/calibrate.mjs --compare
```

`tools/plan.mjs` turns the model into hours of play: for each playing group, the time to the start of levels 46, 50, 55 and 60, from the leader's XP rate over its last hour of AutoLevel (the collector's run logs), the model's rate per level and the XP table the server confirms. Each ETA carries a range of one standard deviation and a word for its certainty. `--stone-xp-h` adds XP per hour from lightstone hand-ins, `--deaths-h` sets the leader's deaths per hour, `--crowd` the other groups per zone and `--new-groups N` adds groups that start at level 1 now. The header says how calibration, deaths and levels above the band rows are handled.

```sh
bun tools/plan.mjs --new-groups 6
```

## Simulating a raid fight

`tools/raidsim.mjs` runs the client's own raid code offline: its member builder, raid tick and boss engine, with a boss from the content snapshot (clone it as above, `bun install` for the DOM shim). It compares roster choices against a boss before the characters exist. It loads the newest saved client release (`--client` picks another one, and a release needs a table in `tools/raidsim/clients.mjs`, which `tools/raidsim/map-client.mjs` writes). Members get the live creation stats of their race and class (`data/char-create.json`) and the server's skill caps for their level (`data/skill-caps.json`, levels 46 to 60), both read from the game. The file header lists what is replaced and what is still assumed. A roster entry overrides race, stats, the bonus-point allocation (`alloc`), skills, items, spells and gear policy.

```sh
bun tools/raidsim.mjs --boss "Hraashna the Warder" --roster tools/raidsim/rosters/groups-1-3.json   # 20 seeded fights, per-member table
bun tools/raidsim.mjs --boss 128093 --roster my-roster.json --class-sweep --slot "G3 monk" --seeds 10 --json
bun tools/raidsim.mjs --boss 128093 --roster my-roster.json --seeds 1 --trace "G1 warrior"   # one member's hit points, damage, healing and hate over time
bun tools/raidsim.mjs --boss 128093 --roster my-roster.json --gear farm --gear-report   # dropped gear and spells, with where each item comes from
```

Every fight runs in its own process and takes a few seconds. A roster file is `{ "level": 60, "members": [{ "name": "Tank", "class": "warrior", "leader": true }, ...] }`. The numbers are as good as the remaining assumptions, so use them to compare rosters and not as a forecast.

A member without `items` or `spells` gets a default kit from a gear policy: `--gear merchant` (the default), `"gear"` in the roster file, or `"gear"` in a member, which wins. `merchant` is the best item per slot that any merchant sells and every merchant scroll. `farm` is, per slot, the best item by the score of `tools/gear.mjs` that the member's class and race can use at its level and can get from a merchant in a live zone or from the drops of an ordinary NPC in a live zone (no Raid Resolve boss, no raid target, none above level 60), where one copy takes at most `--farm-hours` of camping (default 4). That time is the respawn time divided by the spawn chance and the drop chance, for one spawn point. Scrolls follow the same rule and add to the merchant ones. `--gear-report` prints every member's items with their sources, so a pick can be checked against the content tables. The farm kit applies the client's item rules (only the highest haste counts, hit point and mana regeneration stop at 15), leaves out items that need a deity and does not value the worn and focus effects of items. The score and the source tables are in `tools/lib/gear-data.mjs`, shared with `tools/gear.mjs`.

`tools/raidsweep.mjs` runs raidsim over a grid of bosses, levels and roster sizes: the base roster plus 0 or more extra groups of one composition. Every configuration's result is kept under `runs/jobs/<sweep>/`, so a rerun only runs what is missing. Flags after `--` go to raidsim.

```sh
bun tools/raidsweep.mjs --name size-check --bosses resolve --levels 46,55,60 --extra 0,3,6 --seeds 4
bun tools/raidsweep.mjs --name heal-mode --bosses 127098 --levels 60 --extra 3 -- --heal-mode all-balanced
```

## Measuring efficiency

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
each zone's XP multiplier against the content snapshot and the wiki, which disagree for 29 zones,
by testing which one makes every kill's XP fit a whole NPC level.

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

`tools/crossover.mjs` reads a two-period crossover across groups: arm A runs a setting in the
first block and arm B in the second, so each group is compared with itself and the period effect
cancels between the arms. It prints both blocks per group and the setting's effect on XP per hour
(as a ratio), escapes and deaths per hour, each with an interval of two standard errors.

```sh
bun tools/crossover.mjs --start 1794140961654 --block 45 --a G2,G4,G6 --b G3,G5,G7 --label fightingOnly
```

`tools/fights.mjs` splits every recorded run into fights and reports what the guard's escapes and
the deaths cost, which danger signals predicted deaths (the level gap of mobs that hit someone,
incoming damage against the victim's HP, the number of mobs) and a replay of candidate escape
rules on the fights the guard did not leave. `--dump` prints one JSON object per fight.

```sh
bun tools/fights.mjs
```

The roster gear plan (`tools/lib/gear-plan.mjs`) gives each carried item to the account character
and slot where it adds most: armor and jewelry as a set by `tools/gear.mjs`'s stat score, with the
client's haste and regeneration caps, the main hand by damage over delay against what the hand
swings now, and for a Bard each instrument type by the share of its songs it modifies. Merchant
goods in the cities of `data/shop-zones.json` count as further copies with a price, and one pass
buys for at most `BUY_PP` platinum in one city. `iqd run --coordinate` runs the plan every hour:
worn items and the leaders' bags come from each party's own inventories, the companions' carried
items from Inventory Search, and the moves run as one gear task (`iqBot.gear`), which buys or pulls
each item and gives it equipped to its receiver, in the party or not. The items the plan finds to
be an upgrade for anyone go to every bot as `gearKeepIds`, which its cleanup never sells. iqd saves
the survey to `runs/state/account-items.json`, and `bun tools/handdown.mjs` prints the plan for it.
The plan also lists the gear that enemies of each band row's zones drop (`zoneDrops` in
`tools/lib/gear-data.mjs`) where it beats what a character wears, and each coordinator pass gives
every group an errand for its drop with the most gain per hour of hunting among the zones of its
rotation that no other group plays in. The wants stay in the db meta key `gear`, so a restart keeps them.

## Monitoring

`tools/iqd.mjs` (iqd) reads every game tab on a timer, keeps a history and raises attention items, so
an agent sleeps in one `wait` call instead of polling the tabs. It runs outside the agent's loop,
changes nothing in the game and needs no injection: it evaluates one read-only expression per tab
through the relay's browser-level CDP endpoint (`src/cdp.mjs`) and attaches only to pages whose URL
starts with `https://idlequest.net/play`. Every attach is logged in the `attach_log` table.

Start it once as a long-lived process, for example as an omp service named `iqd` that is ready at the
log line `iqd started`, or with `nohup`. A second `run` refuses to start while one is active.

```sh
bun tools/iqd.mjs run --interval 30          # collect until SIGINT or SIGTERM, dashboard on http://127.0.0.1:4790/
bun tools/iqd.mjs serve --port 4791          # only the dashboard, for work on its page while run is active
bun tools/iqd.mjs wait --severity act --max-minutes 60   # background shell job, returns on the next item
bun tools/iqd.mjs status                     # under 40 lines, also written to runs/status.md every cycle
bun tools/iqd.mjs ack 12 "tightened the limits"   # resolve an item
bun tools/iqd.mjs note "moved group 2 to Crushbone" --session Pivorandel   # record an intervention by hand
bun tools/iqd.mjs job add --purpose "predict level 36" --cmd "bun tools/predict.mjs --level 36" --out runs/p36.txt
bun tools/iqd.mjs job done 3 "Permafrost first"
```

The SDK records its own actions there as well: every top-level call that changes the game or the
bot (`ACTIONS` in `src/client.mjs`, such as `setBot`, `travelTo`, `switchCharacter` or `pullItem`)
adds an intervention with actor `sdk`, the leader and the call's arguments.

The dashboard at <http://127.0.0.1:4790/> shows the goal's state (every roster character's level and
the share of the XP to level 60), one card per group with what it does now and how it spent the last
ten minutes, the planner's hours to each level, open and resolved attention items, the intervention
log, interventions and stalls per group-hour by day, each group's level over time and the jobs. It
reads `runs/iq.db` and runs `tools/groups.mjs` and `tools/plan.mjs` for their reports, and it changes
nothing. The page lives in `tools/dashboard/`, its views in `tools/lib/dashboard.mjs`. `--port 0`
starts `run` without it.

`run --coordinate` also makes iqd the coordinator of `docs/plans/controller.md`. Every five minutes
it reads the account's lightstones and the items of `data/opportunities.json` with Inventory
Search and queues tasks through each bot's own task API (`tools/lib/coordinator.mjs` decides). A
batch of at least two stones per member goes to the group with the lowest levels as a hand-in,
also when it farms: the hand-in ends its farm errand, which the next pass gives back. Each opportunity (an epic or quest piece with its group, zone, enemies, the number of
copies the roster needs or the `quest` chain the piece is for, `when` of `night` or `day`, and `kind`)
runs for its group until the account holds those copies, which for a `quest` is one for each member
of the chain's class and level who has not done it: an
`errand` puts the enemies first inside the group's normal hunting, and the default directed hunt
camps the enemies' spawn points with the client's Spawn Camp, placeholders included. A hunt comes
back when the camp says its points respawn, a held camp after 15 minutes, and otherwise after
`retryMin` minutes. Each farm in `data/farms.json` (an errand for loot, such as lightstones from
Nektulos wisps) runs for at most `maxGroups` free groups, the lowest inside its `levels`, and a
group beyond the cap or outside the levels stops farming. Each quest chain in `data/quests.json` runs as a quest task for the
members of its class and level who carry neither its reward nor an item of `doneIf`, which names
what a later step spends the reward on, one task per tab. Members who carry the
reward of an earlier step always run, and the others at most as many as the account holds copies of
the items it `needs`. A chain that stopped part way goes on after the last step `expect` the member
carries. A step talks to its `npc` with `say` keywords, waiting up to `waitMin` for an NPC that
shares its spawn point to appear, gives it `give`, hands in `each`, buys `buy` from a merchant, or fights
`kill` with the group gathered around the member, waiting up to `waitSec` for a script spawn, or
crafts `craft`: the recipe's catalog ingredients are bought into the Tradeskill Bank, its other inputs
pulled, and the result withdrawn into the bags (`craftItem` in `src/bridge.js`). Each experiment in
`data/experiments.json` is a two-period crossover: arm A plays with `setting` and arm B with
`without` for `blockMin` minutes, then the other way round, and afterwards both keep `without` until
the entry leaves the file. Its groups get no farms and no errands by level range meanwhile, and at
the end iqd registers a job with the `tools/crossover.mjs` command that reads the result. A tab gets at most one coordinator task in
20 minutes, and none while a task or errand runs or a pause holds.

The same pass sets each free group's `rotation` (`assignZones`): the zones of the band row at its
leader's level in `data/band-rotations.json`, best first by the XP per hour measured there at levels
within two of the leader's (`tools/lib/rates.mjs`). Only time a group hunted alone in its zone,
outside tasks and errands, counts, and older time weighs less, halving every 24 hours. iqd keeps
the rates in the db's meta key `rates`, built once from `runs/live/*/samples.jsonl` and grown from
every new sample. A zone with little time there ranks near the row's median, so it gets tried, and a
zone another group hunts in counts for less. A group stays in its zone until another zone is worth
20% more, and the bot moves along its rotation by itself when a zone runs dry. A row is the list of
zones that are safe and worth trying at its levels, so a zone joins a row there.

The coordinator's tasks and zone changes are logged as interventions by `coordinator`, apart from
manual ones, and the dashboard's Coordinator section shows its last pass.

`run --recover` deploys the bridge and bot to every tab whose installed code differs from the
repository's (`codeVersion` in `src/install.mjs`, outside raids), and brings back a game tab that is
reachable but has lost the bridge or the bot, as a
page reload does: it signs in with the stored login when the login form shows and installs both as
`attach` does (`src/install.mjs`), at most every two minutes per tab. The bot keeps its settings in
the tab's sessionStorage, so it enters the world as its leader and regroups by itself, and a tab
without them gets its group from `data/roster.json`. A crashed tab needs a new tab, which iqd
cannot open, so `restoreGroup` in `src/group.mjs` stays the way back from a crash.

`--runs <dir>` or `IQD_RUNS` moves the data directory. The tables are created in `runs/iq.db` by
`SCHEMA` in `tools/iqd.mjs`. Recorder rows go to `runs/live/<leader>/samples.jsonl` and
`events.jsonl` in `exportRun`'s format, read from the page's buffers without removing anything, so
`tools/analyze.mjs runs/live/<leader>` works on them and `iq.exportRun` can still run on the same
tab.

`wait` returns every unresolved item at or above its severity (`act` above `decide` above `info`)
that no earlier `wait` of that severity returned, prints it with the status and exits 0. After the
time is up it prints the status and exits 0 as well. Between `wait` calls nothing is lost, because
the position is stored in the database. The first `wait` of a severity starts after the items that
exist then, and `status` lists those.

`status` labels each session and lists the characters by leveling group from `data/roster.json`, where the first member of a group leads and planned groups name the classes still to create and the first letter of their names. Edit the file when groups change. Each session line shows what the party does now and for how long, its rates and the idle share of the last 10 minutes. Open `info` items are counted, not listed.

The bridge labels every recorded second with what the party does (`act`, and `why` for idle and travel time): fight, approach, recover, travel, task, dead or idle. The labels and their order are in the "Activity" section of `src/bridge.js`, `iq.activity()` returns the current one and `iq.activitySeconds(ms)` sums them.

| Kind | Severity | Raised when | Clears |
| --- | --- | --- | --- |
| `gone` | act | The tab is missing from the relay or does not answer for 60 s. Also raised for a parked tab. | When the tab answers again, or `ack` ends the session |
| `nobridge` | act | `window.iq` or `window.iqBot` is missing, or the snapshot fails | When both answer |
| `stall` | act | The party is idle or dead for 2 min, or makes no kill for 5 min, outside raid mode and bot pauses. Errands count. The text names the cause and the activity shares of the last 10 minutes. | When the party is busy and killing again |
| `heap` | act | The page's JS heap is above 85% of its limit | Below 85% |
| `longtask` | act | A bot task has run for over an hour, which the stall rule does not see because a task holds its tab under a bot pause. The coordinator stops a task at 90 minutes and logs it as an intervention. | When the task ends |
| `death` | act | The bot's `death` alert with `wake`, which means the leader or a party member died | `ack` |
| `alert-<kind>` | act | Any other bot alert with `wake`, with its text copied. `levelUp` is left out because the level rules report it. | `ack` |
| `levelup` | info | A leader or an account companion is above its last stored level | `ack` |
| `trigger` | decide | A leader crosses a level listed in `data/triggers.json` (`level`, `text`, `doc`) | `ack` |

A tab whose bot is disabled is parked and raises nothing except `gone`. On its first look at a page,
iqd takes the bot's wake alerts of the last 15 minutes and raises no level rules for a character it
has not stored before. The thresholds are in `THRESHOLDS` in `tools/iqd.mjs` and the rules are
tested in `tests/iqd.test.ts`.

Limits of what the page offers: only the leader has an XP value (`experienceProgress`), so party
members are stored with level, HP and mana only. The kill log carries the enemy's raw name with
underscores and nothing else. Per-hour rates come from the kills of the last 30 minutes.

## After a client update

The bot raises a wake alert `clientUpdate` when the page runs a different client release than the
one this tab or browser saw last, when the client lacks something the SDK uses, and when the site
serves a release newer than the page runs (checked every `releaseProbeMin` minutes). `iq.release`
names the running client and `iq.missingApi` lists the missing parts.

1. `bun tools/client-snapshot.mjs` saves the live client to `.re/releases/<release>/` and prints
   the release id. A release that is saved already is skipped.
2. `bun tools/check-client.mjs [release dir]` runs the bridge's discovery on the saved bundles
   and prints PASS or FAIL for every store, action, state key, dispatcher and client function the
   SDK and the bot use. It exits with 1 on a FAIL. Fix each FAIL in `CLIENT_SURFACE`
   (`src/bridge.js`) before attaching.
3. `bun tools/client-snapshot.mjs --diff <old> <new>` lists what changed by names that survive
   minification: text and message templates, enum members such as option ids, action names, zone
   names and renamed bundles. Arguments are release ids or directories.
4. After `git pull` in the content repository, `bun tools/content-diff.mjs` lists the zones, NPC
   types and spawns that changed and flags zones that enter the top 3 of a level band.

## Rules for contributors

- Run `bun test` after changing `src/bot.js`. It runs the bot against a fake page, because a loop
  in the page freezes and then crashes the game tab, and the sign-in it costs needs a person.
- Never assign to `socket.onJson` or another callback slot on the game's objects. The client's own
  packet dispatch lives there, and replacing it leaves the world stuck on the loading screen.
  Tee traffic by wrapping instance methods, as `src/bridge.js` does.
- Avoid reloading or navigating the game tab while signed in. The login session lives in page
  memory only ([docs/client-internals.md](docs/client-internals.md#authentication)), so a lost
  session means signing in again.
- `.re/` holds downloaded copies of the game client for reverse engineering and is not committed.
  `bun tools/client-snapshot.mjs` saves each release to `.re/releases/<release>/`, with readable
  copies in `pretty/` (see [After a client update](#after-a-client-update)). Regenerate the opcode
  table with `bun tools/extract-opcodes.ts <release dir>/pretty/<entry>.js data/opcodes.json` and
  the leader's spell table with `bun install && bun tools/class-spells.mjs`, which loads the
  client's bundles under a DOM shim. After a content snapshot update, regenerate the quest
  turn-in items the bot keeps with `bun tools/quest-items.mjs`.
- Use `pausedAutoLevel` for travel or other actions that need AutoLevel stopped. If it was running,
  it restarts with the saved con and level limits. `travelTo` waits for the current fight to end,
  then sends the Travel window's zone change, which teleports at once. The bot's pause is renewed
  while the work runs. If the script dies, the pause runs out within two minutes and the bot
  restores the leader, the party, the zone and AutoLevel at once.
- Long work belongs in the page: start it there, keep its progress on `window`, and poll it with
  short `tab.evaluate` calls. The bridge's `iq.job(name, ...args)` runs its NPC and item actions
  that way, and the bot runs multi-step work as tasks. An omp browser tab fails a call that runs
  about 30 seconds or longer (not verified against the omp source).
- Never call `warpPlayerToCombatEntity` or `teleportPlayerToEQPosition`. They are debug functions
  that a player cannot use.

## Troubleshooting

- `bridge: could not find ...` when attaching: the client no longer has a store with the state keys
  `CLIENT_SURFACE` in `src/bridge.js` looks for. Find the new keys in the prettified client and
  update the entry there. `iq.missingApi` lists parts of that surface the SDK calls and the
  client no longer has.
- `opcode table not loaded`: the bridge was evaluated without `attach`. Call `attach(tab)`, which
  loads `data/opcodes.json`.
- `client function ... not found` in `iqBot.report().recent` (as `tick failed`), or `fn.<name>` in
  `iq.missingApi`: the bridge finds the client's sale, Auto Bank, auto-place, zone change and hail
  calls by pieces of their source (`FUNCTIONS` in `CLIENT_SURFACE`), and a release changed them.
- The world sticks on the loading screen: something replaced `socket.onJson` or another callback
  slot. Reload and sign in, and wrap instance methods instead.
- AutoLevel stays off: `iq.botReport()` shows `paused` with a reason and an end time, and
  `enabled`. `iq.resumeBot()` ends a pause and `iq.setBot({ enabled: true })` turns the bot back on.
- `watch` or `evaluate` throws or never returns: the tab is gone or its renderer crashed, and the
  bot went with it. Bring the group back with `restoreGroup` (`AGENTS.md`, "Session start").
- `travelTo` fails with `no such zone`: pass the zone's short name (`misty`) or its long name as
  the game spells it. AutoLevel must be stopped first (use `pausedAutoLevel`).
- An item stays on the cursor: `iq.bagSpace().cursor` names it, and looting and cleanup stop until
  it is placed. The bot places it after three minutes.

## Diary

[diary/](diary/) has one entry per session, with screenshots in `diary/media/`. Game tabs run with
rendering off (Options, Graphics, Disable Rendering), which pauses 3D drawing while AutoLevel keeps
running, and `createGroup` and `restoreGroup` turn it off because the client forgets it at sign-in.
For a screenshot of the world, such as a raid kill, press Enable Rendering in that tab first and
turn rendering off again afterwards.
