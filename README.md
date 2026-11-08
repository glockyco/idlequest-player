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
await iq.pausedAutoLevel(() => iq.travelTo("Greater Faydark"));  // pause, run, restart if it was running
await iq.switchCharacter("Tagujazolu");            // camp, enter as another account character, regroup the party
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

```sh
bun tools/gear.mjs warrior --level 21 --race dwarf --slot primary --top 5
bun tools/gear.mjs --party runs/roster.json --level 30   # whole-party upgrade plan (merchant, in-rotation, high-gain drops)
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

The model includes the spawn table with spawn chances and respawn times, enemy HP, damage, special abilities and resists, the party's hit chance and resist penalty by level difference, the tank's damage taken, recovery from mana and HP at 2.5% per 0.6 s, walking between candidate spawn points, and a spawn-rate cap per zone. It leaves out wandering and named spawns beyond their chance, enemy spells, enrage and rampage timing (a fixed extra damage instead), crowd control, pets as separate damage dealers, other players taking spawns, content flags and spawn conditions, the trip to the zone and loot. Melee immunity follows the client: special ability 19 stops all melee, 23 stops only non-magical hits, and magic weapons and pets of level 10 or more count as magical. The other special ability names follow the EQEmu numbering (`tools/mobs.mjs` says it is from memory), not a check against the client. Walking is the distance to the nearest candidate point, which is shorter than the 66 units per kill measured in Permafrost, so the overhead absorbs the difference. How damage grows with the leader's level (`--dps-exp`) is not identified by three runs at levels 21, 24 and 29, so predictions far from level 24 depend on it. Read the table as a ranking, and check a zone live before committing to it.

Calibration cases. Permafrost at leader level 24 to 25 measured 2.91 kills per minute, 2.30M XP/h, 13,217 XP per kill, a 13 s mean kill and 64.6% of the time in combat. The City of Guk at level 21 measured 3.19 kills per minute, 1.64M XP/h and a 10.3 s median kill. The Estate of Unrest at level 29 measured 1.92 kills per minute, 2.75M XP/h, 15,051 XP per kill and a 13.0 s median kill. The defaults are `--dps 49` at level 24, `--overhead 2` and `--mana-per-sec 10`, fitted to Permafrost and Guk, so Unrest is a check outside that fit. `--dps-exp 0.5` is set between the 0 and 1 that bracket the best fit, and the party's pool sizes and levels come from the run's samples. Residuals, model against measured:

| Quantity | Permafrost | City of Guk | Estate of Unrest |
| --- | ---: | ---: | ---: |
| XP/h per leader | +2% | -1% | -7% |
| Kills per minute | +7% | -12% | +42% |
| XP per kill | -5% | | +4% |
| Mean kill seconds | -6% | | +2% |
| Median kill seconds | -7% | +9% | +3% |
| Combat share of time | -2% | | |

`tools/plan.mjs` turns the model into hours of play: for each playing group, the time to the start of levels 46, 50, 55 and 60, from the leader's XP rate over the last hour (the collector's run logs), the model's rate per level and the XP table the server confirms. `--new-groups N` adds groups that start at level 1 now. The header says how calibration and levels above the band rows are handled.

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

## Monitoring

`tools/iqd.mjs` (iqd) reads every game tab on a timer, keeps a history and raises attention items, so
an agent sleeps in one `wait` call instead of polling the tabs. It runs outside the agent's loop,
changes nothing in the game and needs no injection: it evaluates one read-only expression per tab
through the relay's browser-level CDP endpoint (`src/cdp.mjs`) and attaches only to pages whose URL
starts with `https://idlequest.net/play`. Every attach is logged in the `attach_log` table.

Start it once as a long-lived process, for example as an omp service named `iqd` that is ready at the
log line `iqd started`, or with `nohup`. A second `run` refuses to start while one is active.

```sh
bun tools/iqd.mjs run --interval 30          # collect until SIGINT or SIGTERM
bun tools/iqd.mjs wait --severity act --max-minutes 60   # background shell job, returns on the next item
bun tools/iqd.mjs status                     # under 40 lines, also written to runs/status.md every cycle
bun tools/iqd.mjs ack 12 "tightened the limits"   # resolve an item
bun tools/iqd.mjs note "moved group 2 to Crushbone" --session Pivorandel   # record an intervention
bun tools/iqd.mjs job add --purpose "predict level 36" --cmd "bun tools/predict.mjs --level 36" --out runs/p36.txt
bun tools/iqd.mjs job done 3 "Permafrost first"
```

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

| Kind | Severity | Raised when | Clears |
| --- | --- | --- | --- |
| `gone` | act | The tab is missing from the relay or does not answer for 60 s. Also raised for a parked tab. | When the tab answers again, or `ack` ends the session |
| `nobridge` | act | `window.iq` or `window.iqBot` is missing, or the snapshot fails | When both answer |
| `autolevel-off` | act | AutoLevel is off for 3 min while the bot is enabled, outside raid mode, errands and bot pauses | When AutoLevel runs |
| `nokill` | act | AutoLevel runs for 10 min without a kill, outside raid mode, errands and bot pauses | At the next kill |
| `heap` | act | The page's JS heap is above 85% of its limit | Below 85% |
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
   (`src/bridge.js`) or `CLIENT_FN` (`src/bot.js`) before attaching.
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
  it restarts with the saved con and level limits. `travelTo` waits for the current fight to end
  before opening the Travel window. The bot's pause is renewed while the work runs. If the script
  dies, the pause runs out within two minutes and the bot starts AutoLevel again a minute later.
- Long work belongs in the page: start it there, keep its progress on `window`, and poll it with
  short `tab.evaluate` calls, as `iq.errand` does. An omp browser tab fails a call that runs about
  30 seconds or longer (not verified against the omp source).
- Never call `warpPlayerToCombatEntity` or `teleportPlayerToEQPosition`. They are debug functions
  that a player cannot use.

## Troubleshooting

- `bridge: could not find ...` when attaching: the client no longer has a store with the state keys
  `CLIENT_SURFACE` in `src/bridge.js` looks for. Find the new keys in the prettified client and
  update the entry there. `iq.missingApi` lists parts of that surface the SDK calls and the
  client no longer has.
- `opcode table not loaded`: the bridge was evaluated without `attach`. Call `attach(tab)`, which
  loads `data/opcodes.json`.
- `client function containing "..." not found` in `iqBot.report().recent` (as `tick failed`): the
  bot finds the client's sell, Auto Bank and auto-place calls by a text they contain (`CLIENT_FN`
  in `src/bot.js`), and a release changed that text. Bag cleanup stops until the text is updated.
- The world sticks on the loading screen: something replaced `socket.onJson` or another callback
  slot. Reload and sign in, and wrap instance methods instead.
- AutoLevel stays off: `iq.botReport()` shows `paused` with a reason and an end time, and
  `enabled`. `iq.resumeBot()` ends a pause and `iq.setBot({ enabled: true })` turns the bot back on.
- `watch` or `evaluate` throws or never returns: the tab is gone or its renderer crashed, and the
  bot went with it. Reload the tab, sign in and attach again.
- `travelTo` fails with `travel to <zone> failed`: the Travel window lists zones without a leading
  "The", and AutoLevel must be stopped first (use `pausedAutoLevel`).
- An item stays on the cursor: `iq.bagSpace().cursor` names it, and looting and cleanup stop until
  it is placed. The bot places it after three minutes.

## Diary

[diary/](diary/) has one entry per session, with screenshots in `diary/media/`.
