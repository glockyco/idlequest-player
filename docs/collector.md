# The collector

`tools/iqd.mjs` (iqd) is the program that keeps the account playing: it reads every game tab on a timer, keeps the history in `runs/iq.db`, serves the dashboard, keeps each tab signed in and running the deployed page code, and as the coordinator gives the groups their tasks. `tools/play.sh` runs it with the browser relay ([README](../README.md#run)). [plans/controller.md](plans/controller.md) states the design, and this page describes what runs.

## Reading the tabs

Every cycle iqd evaluates one read-only expression in each game tab through the relay's browser-level CDP endpoint (`src/cdp.mjs`), stores what it returns and raises attention items from it, so an agent sleeps in one `wait` call instead of polling the tabs. It attaches only to pages whose URL starts with `https://idlequest.net/play`, and every attach is logged in the `attach_log` table. It also asks the browser to treat each game tab as focused, because the browser throttles the timers of a hidden tab and its fights stop ending. The tabs therefore need not be in front while iqd runs.

A plain `run` only reads. `--recover` adds the page supervisor, which signs tabs in and installs the page code, and `--coordinate` adds the coordinator, which gives the bots tasks. `tools/play.sh` runs with both.

## Commands

```sh
bun tools/iqd.mjs run --interval 30          # collect until SIGINT or SIGTERM, dashboard on http://127.0.0.1:4790/
bun tools/iqd.mjs serve --port 4791          # only the dashboard, for work on its page while run is active
bun tools/iqd.mjs minutes --hours 336        # rebuild the per-minute totals from runs/live samples, with run stopped
bun tools/iqd.mjs wait --severity act --max-minutes 60   # background shell job, returns on the next item
bun tools/iqd.mjs status                     # under 40 lines, also written to runs/status.md every cycle
bun tools/iqd.mjs ack 12 "tightened the limits"   # resolve an item
bun tools/iqd.mjs note "moved group 2 to Crushbone" --session Pivorandel   # record an intervention by hand
bun tools/iqd.mjs page G10 'window.iqBot.stopTask()' --why "stands without a route"   # act in a group's tab by hand, recorded
bun tools/iqd.mjs load G7 G11 --seconds 8    # how busy each group's page is, and with --stacks 100 what one page was doing
bun tools/iqd.mjs renew G4 G6 --why "three days old"   # give each group's tab a new browser process, a minute apart
bun tools/iqd.mjs job add --purpose "predict level 36" --cmd "bun tools/predict.mjs --level 36" --out runs/p36.txt
bun tools/iqd.mjs job done 3 "Permafrost first"
```

The SDK records its own actions there as well: every top-level call that changes the game or the
bot (`ACTIONS` in `src/client.mjs`, such as `setBot`, `travelTo`, `switchCharacter` or `pullItem`)
adds an intervention with actor `sdk`, the leader and the call's arguments.

## Dashboard

The dashboard at <http://127.0.0.1:4790/> answers, in this order, whether anything needs a person,
how far the account is toward the goal and what the system does (`docs/plans/dashboard.md`): a
status line, the items no mechanism handles, one bar per success criterion with what moved it in
the last 24 hours, one row per group (click for its party, bags, rotation, progress and task
history), the progress feed of what moved the bars in the last two days (the `progress` table,
`tools/lib/progress.mjs`), the coordinator's tasks and decisions, a gear section with a character
sheet per roster character (each slot's worn item beside the best one the account's items,
merchants and wanted drops give, from the gear pass's meta keys `gearPlan` and `gearSheets`) and
the most wanted enemies, and folded sections for engineering health, the roster, epic chains, level
trends, jobs and the alert history. Wherever it names an item, in the sheet, the progress feed and
Most wanted, it shows the game's icon and item window from the item cards iqd stores
(`tools/lib/cards.mjs`). It reads `runs/iq.db` and runs `tools/groups.mjs` and `tools/plan.mjs` for
their reports, and it changes nothing. The page lives in `tools/dashboard/`, its views in
`tools/lib/dashboard.mjs`. `--port 0`
starts `run` without it.

## Coordinator

`run --coordinate` also makes iqd the coordinator of `docs/plans/controller.md`. Every five minutes
it reads the account's lightstones and the items of `data/opportunities.json` (epic and quest
pieces) with Inventory Search and queues tasks through each bot's own task API
(`tools/lib/coordinator.mjs` decides). First, a character of 46 or more rolls the casino for the
day's boss potion (`iqBot.casino`), the one that rolled longest ago (db meta key `casinoRolls`),
playing its tab for the roll, since a potion stays with its winner. The boss pass then queues the
next boss kill (`docs/plans/raids.md`, `tools/lib/boss-plan.mjs`): a free daily summon or a held
casino potion as a raid of all roster characters, led by the potion's holder or the strongest
group's leader, once the simulator kills the boss in every fight (`runs/state/kill-odds.json`, which
`bun tools/kill-odds.mjs` refreshes in the background hourly). A raid runs as soon as one is due,
the most valuable by its loot first, one at a time, and buys raid time at the server's quote. The
same pass watches the raid bosses that stand in the open world, sends a free group to look into a
boss's zone when its respawn is due (`iqBot.look`) and raids one a tab sees standing. A
batch of at least two stones per member goes to the group with the lowest levels as a hand-in,
also when it farms: the hand-in ends its farm errand, which the next pass gives back. Each opportunity (an epic or quest piece with its group, zone, enemies, the number of
copies the roster needs or the `quest` chain the piece is for, `when` of `night` or `day`, and `kind`)
runs for its group until the account holds those copies, which for a `quest` is one for each member
of the chain's class and level who has not done it: an
`errand` puts the enemies first inside the group's normal hunting, and the default directed hunt
camps the enemies' spawn points with the client's Spawn Camp, placeholders included. A hunt comes
back when the camp says its points respawn, a held camp after 15 minutes, and otherwise after
`retryMin` minutes. A piece hunt starts only while the group's hunts took less than `huntShare` of
its last hour, because the gear model does not price pieces. Each farm in `data/farms.json` (an errand for loot, such as lightstones from
Nektulos wisps) runs for at most `maxGroups` free groups, the lowest inside its `levels`, and a
group beyond the cap or outside the levels stops farming. Each quest chain in `data/quests.json` runs as a quest task for the
members of its class and level who carry neither its reward, nor an item of `doneIf` (what a later hand-in outside the file
spends the reward on), nor the done items of a chain in the file that `needs` the reward. One task per tab. Members who carry the item of the step
that uses up what the chain `needs`, or of a later step, always run, and the others at most as many
as the account holds copies of those items. A chain that stopped part way goes on after the last step `expect` the member
carries, so an item that counts only inside a timed encounter is no `expect`: the Damaged Goblin
Crown goes to Natasha Whitewater, whom Shmendrik Lavawalker's hand-in spawns for five minutes, and a
chain that stopped inside the encounter starts it again. A step talks to its `npc` with `say` keywords once the NPC stands on one of its spawn points:
with another NPC on the point, the group's leader becomes active in the step's zone, gathers the
party and clears the point with the client's Spawn Camp, as a directed hunt does, and the task ends
as waiting until the point rolls again, as it does while the point respawns, so the coordinator
brings every member who needs that NPC back then, one group at a time, since the groups would
reach the point together and all but the first find it held. A failure that names a time, such as a point the
leader's party could not clear, holds the chain for all groups until that time, or until the next deploy unless
it repeated the failure before it at its step (`worldHold` in
`tools/lib/coordinator.mjs`). A step gives the NPC `give`, hands in `each`, buys `buy` from a merchant, or fights
`kill` with the group gathered around the member, waiting up to `waitSec` for a script spawn, or
crafts `craft`: up to `quantity` attempts until one succeeds, each buying into the Tradeskill Bank the
catalog ingredients one set lacks, with one of each of its `inputs` (the components the catalog does
not sell) pulled per attempt and the result withdrawn into the bags (`craftItem` in `src/bridge.js`). Each experiment in
`data/experiments.json` is such a crossover: arm A plays with `setting` and arm B with `without`
for `blockMin` minutes, then the other way round, for `blocks` blocks (two by default), and afterwards both keep `without` until
the entry leaves the file. Its groups get no farms and no errands meanwhile, since both change the
AutoLevel limits the arms compare, while their hunts, quests and gear moves run, because
`tools/crossover.mjs` counts XP per hour over the minutes without a task. At the end iqd registers
a job with the `tools/crossover.mjs` command that reads the result. An entry
removed before its end puts its groups back on `without` and registers no job. A tab gets no
coordinator task while a task or errand runs or a pause holds, and the next one as soon as it ends:
each quest, hunt and target comes back on its own retry time, a failure at once after a deploy,
which may have fixed it, unless it failed at the same step as the run before it, and a hand-in or
farm join that failed holds its tab for `failHoldMin` (`tools/lib/coordinator.mjs`). While an XP
event multiplies kill XP (`tools/lib/xp-events.mjs`), quest chains and piece hunts wait for its end
and a gear trip goes only when its value pays the event's factor times its cost, because an hour
of hunting is then worth that many normal hours.

The same pass sets each free group's `rotation` (`assignZones`): the zones of the band row at its
leader's level in `data/band-rotations.json`, and of the next row from two levels below it
(`bandZones`), best first by the XP per hour measured there at levels within two of the leader's
(`tools/lib/rates.mjs`). The rates are rates alone: time outside tasks and errands counts, and time
shared with other groups counts at the share of the zone the crowd factors give them
(docs/plans/zone-crowding.md). XP gained in an XP event counts at its normal worth, so the zones
hunted in it do not outrank the others (docs/plans/leveling-plan.md, XP events). Older time weighs
less, halving every 24 hours. iqd keeps the rates
in the db's meta key `zoneRates` and the time by crowding behind the factors in `zoneCrowding`,
built once from `runs/live/*/samples.jsonl` and grown from every new sample. A zone with little
time there ranks where the XP model (`tools/predict.mjs`) puts it among the measured zones, so it
gets tried, and a zone other groups hunt in counts for what one more group adds to the account
there, its own share less what it takes from the others. A group stays in its zone
until another zone is worth 20% more, and the bot moves along its rotation by itself when a zone
runs dry. A row is the list of zones that are safe and worth trying at its levels, so a zone joins
a row there.

The coordinator's tasks and zone changes are logged as interventions by `coordinator`, apart from
manual ones, and the dashboard's Coordinator section shows its last pass.

### Gear

The roster gear plan (`tools/lib/gear-plan.mjs`) gives each carried item to the account character
and slot where it adds most to its group's XP rate (`xpGain` in `tools/lib/gear-plan.mjs`): armor and jewelry as a set by what they add to the wearer's melee and spells (`outputValue` in `tools/lib/gear-data.mjs`: offense and haste, mana and regeneration, a little for AC and HP), weighed by the wearer's measured share of the party's damage, and by the party time they save, with the
client's haste and regeneration caps, a weapon by its stats like armor and by `weaponRatio`
against what the hand swings now, and for a Bard the percussion instrument in its bags by the walking time its run song
saves the group (docs/client-internals.md, Bard instruments). Merchant
goods in the cities of `data/shop-zones.json` count as further copies with a price, and one pass
buys in one city for at most the account's last hour of income less the raid budget's share
(`buyBudget`), pulling coin from the largest account balance when the leader carries too little.
Goods a merchant refused in a gear task, by not standing in the Path To list or not selling them,
stay out of the plan for a day (`refusedGoods`). `iqd run --coordinate` runs the plan every hour:
worn items and the leaders' bags come from each party's own inventories, the companions' carried
items from Inventory Search. A character whose party the pass cannot read, with its tab out of the
world or a task playing another character, keeps the worn items of the last survey. The moves run as one gear task (`iqBot.gear`), which buys or pulls
each item and gives it equipped to its receiver, or into the bags for a Bard's instrument, in the party or not, and equips an item for the tab's own active character from its bags (`equipOwn`), since a transfer to oneself is refused. Every item passes through the tab's leader, which refuses a second copy of a lore item, so the task goes to the free tab whose leader carries the fewest of the plan's lore items, and moves its leader cannot take wait for a later task. Each bot keeps
the account's demand (`demand`, copies per item, `docs/plans/items.md`): the copies the gear plan is
still short of, the items each class epic's chosen steps take (the epic model,
`tools/lib/epic-model.mjs`), the items of the runnable chains in
`data/quests.json`, the copies of what the coordinator's hunts and errands are for that the roster
still needs, and one of each casino boss potion. It also keeps the copies the plan's moves take
(`gearKeepInstances`). Everything else is surplus to the bag reserve (`docs/plans/inventory.md`). After a
content update, `bun tools/epic-model.mjs` lists each class epic's steps, gaps and blockers
(`--steps`, `--class <Class>`), with `--hand` the hand-kept chain items the model's steps do not
take, and fails while a chosen step uses a script idiom the analyzer cannot read. iqd saves
the survey to `runs/state/account-items.json`, and `bun tools/handdown.mjs` prints the plan for it.
The plan also lists the gear that enemies of every live zone drop (`liveDrops` in
`tools/lib/gear-data.mjs`), where it beats what a character wears, and the pieces a hunt gets of
the class epics the account can finish (`huntPieces` in `tools/lib/epic-model.mjs`), each worth
the epic's reward to its character, shared by the pieces it lacks. It ranks the enemies by the
value an hour of hunting them brings to the account (`targets`), and the pieces the epics hand in
stay unworn, since a hand-in takes them from the bags. Each coordinator pass sends the free groups on the trips that earn most, best pair of
group and zone first: a trip hunts every wanted enemy of its zone that pays, as an errand inside
normal hunting when the zone is in the group's rotation, and as a camp or a short visit when it is
not. A group's chance against an enemy comes from a model fitted to every simulated fight, the
simulator's fights of its six and its own live fights (`runs/state/kill-odds.json`, which
`bun tools/kill-odds.mjs` refreshes in the background hourly). Any group may hunt for any
character, because a gear task moves the copy. A boss of the daily list or the raid goal is left
to the boss plan's raids, and Most wanted shows it as "by raid". `docs/plans/gear-acquisition.md` describes the
model and its assumptions. The dashboard lists every enemy a group hunts or has queued and the top
other targets as Most wanted, each with which group would hunt it for whom, what a copy takes, adds
and costs, and why it is or is not hunted. The wants stay in the db meta key `gear`, so a restart
keeps them.

## Page supervisor

`run --recover` keeps every reachable game tab's page playing through the page supervisor
(`tools/lib/page.mjs`), which looks at each page every cycle and gives at most one action. It signs
in with the stored login when the login form shows, at once on a fresh page and after a minute on
one that left the game, so the client can resume the session by itself first, at most every two
minutes per tab, because a sign-in outlasts a cycle, and six times in the fleet per half minute,
because the server refuses a burst ("Too many login attempts"), and a page that shows that refusal
holds every sign-in for the minute the server asks. A character select without a connection for a
minute is a session the server ended ("Log in before entering the world."), so its page reloads to
show the login form. It installs the bridge and bot as
`attach` does (`src/install.mjs`) where either is missing, at once after the tab's sign-in and
otherwise at most every two minutes, and installs the deployed code in a tab that runs other code
(`iqd deploy`), outside raids and after a task that plays in the world. iqd loads `src/install.mjs` once,
so a change to that file needs an iqd restart. A signed-out tab keeps its bot, which enters the
world from the character select. The bot keeps its settings in the tab's sessionStorage, so it
enters the world as its leader and regroups by itself, and a tab without them gets its group from
`data/roster.json`. The supervisor gives a tab a new browser process when the floor of its page's
JS heap, the lowest reading over 10 minutes, stays at `heapShare` of its limit (`PAGE` in
`tools/lib/page.mjs`). The client keeps memory it no longer needs, and a tab's process keeps what
a reload frees, so a reload is not enough: the tab goes to a page the collector serves, which ends
its process, and that page returns to the game by itself in a new one (`Relay.renew` in
`src/cdp.mjs`). The supervisor reloads a page for two faults of the client: 25 kills in a row
without a "You loot" line, which a failed zone load can leave behind although the bridge repairs
that in the page (docs/client-internals.md, Loot messages), and a travel the client refused for
want of its zone's state, which a page that entered the world through a server restart can lack
until it reconnects (docs/client-internals.md, Zone change). A new process and a reload wait for
a moment without a task, fight, raid or zone load, with every recorded row on disk, one tab of the
fleet per 10 minutes. `iqd renew` does the same by hand, for a process that is old with a small
heap. A crashed tab needs a new tab, which iqd cannot open, so `restoreGroup` in `src/group.mjs`
stays the way back from a crash.

Which commit's page code the tabs run is set with `iqd deploy` ([README](../README.md#deploying-page-code)).

## Data

`--runs <dir>` or `IQD_RUNS` moves the data directory, `runs/` by default, which is not in git. The tables are created in `runs/iq.db` by `SCHEMA` in `tools/iqd.mjs`. Recorder rows go to `runs/live/<leader>/samples.jsonl` and `events.jsonl` of the tab's group leader, also while a task plays a member, in `exportRun`'s format, read from the page's buffers without removing anything, once each, so `tools/analyze.mjs runs/live/<leader>` works on them and `iq.exportRun` can still run on the same tab. Surveys and plans the tools share are under `runs/state/`. What `run` prints, such as the coordinator's decisions, the page supervisor's actions and the cycles that took long, also goes to `runs/log/iqd-<day>.log`.

`status` labels each session and lists the characters by leveling group from `data/roster.json`, where the first member of a group leads and planned groups name the classes still to create and the first letter of their names. Edit the file when groups change. Each session line shows what the party does now and for how long, its rates and the idle share of the last 10 minutes. It lists the items that need a person and counts the others by kind.

The bridge labels every recorded second with what the party does (`act`, and `why` for idle and travel time): fight, approach, recover, travel, task, dead or idle. The labels and their order are in the "Activity" section of `src/bridge.js`, `iq.activity()` returns the current one and `iq.activitySeconds(ms)` sums them.

Limits of what the page offers: only the leader has an XP value (`experienceProgress`), so party members are stored with level, HP and mana only. The kill log carries the enemy's raw name with underscores and nothing else. Per-hour rates come from the kills of the last 30 minutes.

## Attention items

The collector raises an item for every trouble it sees. An open item needs a person when it is a decision, when no mechanism is named for its kind, or when it is still open after the time its mechanism takes (`KINDS` in `tools/lib/attention.mjs`). The dashboard's "Needs you", `status` and `wait` all go by that rule.

`wait` returns every such item that no earlier `wait` returned, prints it with the status and exits 0. With `--severity decide` it returns only decisions, and with `--severity info` every open item. After the time is up it prints the status and exits 0 as well. Between `wait` calls nothing is lost, because the items already returned are stored in the database. The first `wait` of a severity starts after the items that count then, and `status` lists those.

| Kind | Severity | Raised when | Closes |
| --- | --- | --- | --- |
| `gone` | act | The tab is missing from the relay or does not answer for 60 s, also when its bot is disabled | When the tab answers again, or `ack` ends the session |
| `nobridge` | act | `window.iq` or `window.iqBot` is missing, or the snapshot fails | When both answer |
| `stall` | act | The party is idle or dead for 2 min, or makes no kill for 5 min, outside raid mode and bot pauses. Errands count. The text names the cause and the activity shares of the last 10 minutes. | When the party is busy and killing again |
| `heap` | act | The page's JS heap is above 85% of its limit | Below 85% |
| `longtask` | act | A bot task has run for over an hour, which the stall rule does not see because a task holds its tab under a bot pause. The coordinator stops a task at 90 minutes and logs it as an intervention. | When the task ends |
| `death` | act | The bot's `death` alert with `wake`, which means the leader or a party member died | As an event, see below |
| `alert-<kind>` | act | Any other bot alert with `wake`, with its text copied. `levelUp` is left out because the level rules report it. | As an event, see below |
| `levelup` | info | A leader or an account companion is above its last stored level | After ten minutes |
| `trigger` | decide | A leader crosses a level listed in `data/triggers.json` (`level`, `text`, `doc`) | `ack` |

The first five are conditions and close when their state ends. The others are events: one closes at once when the tab's state shows it is over (a later task finished, the bags have room, the page is back in the world), when a newer one of its kind for the tab replaces it, an info event after ten minutes and an act event after an hour without an open condition on the tab (`EVENT_TTL_MS` in `tools/iqd.mjs`). A decision stays open until `ack`.

A tab whose bot is disabled is parked: `status` shows it as `PARKED`, and it raises nothing but `gone` when it cannot be reached. On its first look at a page, iqd takes the bot's wake alerts of the last 15 minutes and raises no level rules for a character it has not stored before. The thresholds are in `THRESHOLDS` in `tools/iqd.mjs` and the rules are tested in `tests/iqd.test.ts`.
