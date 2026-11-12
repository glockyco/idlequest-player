# Fault handling

How the bot, the adapter and iqd handle what goes wrong in the server and the client, so each fault
has one owner, one cure and a test, and the fixes of 2026-11-10 become one design instead of a
stack of special cases. This plan extends the [controller design](controller.md), whose principles
3 and 8 and page supervisor part follow from it.

## Why

The server was slow and restarted several times on 2026-11-10, and each fault showed in a
different place:

| Fault | Cost | Fixed where |
| --- | --- | --- |
| A failed zone load, retried with Try Again, left the client's loot preview on a disposed scene | Six groups lost their loot lines and waited about 6 s after every kill for 3 to 5 hours, 11 to 16% of their time, labelled `noTarget` | A reload rule in iqd, then a wrap in the adapter |
| The client paused AutoLevel when the server did not confirm a fight in time | About 10% of all group time in a slow hour, because the bot waited 60 s to restart | A marker in `keepAutoLevel`, outside the remedy table |
| A server restart signed every tab out | Twelve groups at the login form for 1.9 hours | A new trigger and timers in `recoverTab` |
| Inventory Search requests timed out | Two gear passes failed and the hourly schedule lost 2.3 hours of moves and the targets | Retries in the adapter and a retry timer in the gear pass |
| Rows of a page went into several characters' logs | 46% of the loot rows were copies | A cursor per page |

Each fix works, but together they break the controller design's principles. Principle 3 says one
table maps each idle cause to its remedy, yet the stuck loot hid under `noTarget` because the
labels have no cause for it, and the client's pauses are handled outside the table. Principle 8
says the adapter has no policy, yet it now compensates a client defect and retries requests by its
own counts. Principle 9 says policy code is pure and tested, yet page recovery in iqd is imperative
code with five flags and timers (`recovery.at`, `signedInAt`, `offlineSince`, `renderingOff`,
`lootless`). The design has no part for the page itself, although sign-outs, failed loads and
reloads are everyday events. Seven places in the bot and the adapter start AutoLevel, each with its
own conditions.

## Fault model

| Fault | How it shows | Cure | Owner |
| --- | --- | --- | --- |
| A read-only request times out (Inventory Search, opcode 1241) | The request's error | Ask again after a pause, up to three times, then report what was not found | The adapter's query |
| The server is slow to confirm an action (a fight's start, a zone change, a cancellation) | The client's own line: "AutoLevel paused: ... try again", "Request timeout for opcode 313" | Retry the action, as the client's text asks | The controller's remedy table |
| The server ends the session (a restart, a camping it could not confirm) | The login form, or the socket down | Sign in with the stored login, spread over the tabs, because the server refuses a burst ("Too many login attempts") | The page supervisor |
| A zone load fails | The "Loading Failed" window | Try Again, then the shim for the defect it is known to leave | The remedy table and a shim |
| The client keeps a defect that no shim covers | A symptom the adapter can name, such as loot that never settles | A fresh page | The page supervisor |
| The client keeps memory | The heap floor over 10 minutes | A fresh page at a quiet moment | The page supervisor |
| The page lost the bridge or the bot, or runs older code | The snapshot | Install | The page supervisor |
| The tab is gone | The relay | A new tab (`restoreGroup`) | An agent |

## Design

### Causes are named where they are observed

The adapter's activity label gives every idle second the cause the page shows for it, so the remedy
table sees each fault by name. With AutoLevel off, the cause is the latest evidence since it last
ran. New causes:

| Cause | Evidence |
| --- | --- |
| `held` | AutoLevel off since one of the bot's holds (`iqBot.state.heldAt`) |
| `clientPause` | AutoLevel off since the client's "AutoLevel paused: ..." line |
| `contested` | AutoLevel off since "Looking for another target.", which stops AutoLevel only when it had stopped or fought a single target. While AutoLevel runs, the client tries another target after 500 ms by itself. |
| `lootSettle` | AutoLevel waits for a kill's pending loot (`pendingAutoLevelLoot` of the combat runtime) |
| `loadFailed` | The Loading Failed window is open (the message of the client's load failure store) |

`noTarget` then means that AutoLevel runs with nothing to approach, no loot pending and no enemy to
wait for, and a second the rules cannot place, such as one without the combat runtime, is
`unknown`, never folded into a neighbouring cause. The rules are pure (`ACTIVITY_RULES`) and tested
on their own.

### One owner starts AutoLevel

Whether AutoLevel runs is part of the desired state, and the remedy table is the only code that
starts it. A hold keeps it off: a pause, a raid, a page out of the world or in a zone change, a
character switch, the guard's escape, a dead leader, members still joining or a discard the client
has not taken off the cursor yet, which would leave the next kill's loot on its corpse. The bot stops
AutoLevel only under a hold or for a fresh start, and it notes every hold in `state.heldAt`, so
the label names AutoLevel that went off under one `held`. Every cause has its delay in the table:
`held` and `contested` at once, `clientPause` after 5 s, `off` after 60 s (manual movement cancels
AutoLevel, so a person's stop gets a minute). `loadFailed` presses Try Again, also under a hold,
once for every failure. `lootSettle` that outlasts the client's deadline on several kills in a row
is a page fault the bot reports to iqd. The markers `clientStop` and `restartNow`, the start in
`keepAutoLevel`, the guard's restart loop and the Try Again click in `watchConnection` go, and the
task runner, the raid and the guard hand AutoLevel back by ending their hold. The end of a hold and
the end of a cause's delay wake the tick, so the delays hold to the second.

Rendering off becomes a client option the bot keeps (`clientOptions.disable3D`, whose toggle is
`toggleDisable3D`), like Auto-Sell, so no sign-in or reload needs its own step. A screenshot of the
world lifts it for its moment (`iqBot.render(seconds)`), and raid mode for its duration, because
the client moves the raid leader and starts his attacks only on rendered frames
(docs/client-internals.md, "Running a raid from a script").

### The page supervisor

Each tab's page has a desired state too: loaded, signed in, in the world, with the current bridge
and bot, within its memory, and without a known client fault. One pure function in
`tools/lib/page.mjs` takes a tab's look (the snapshot with the page's screen), its supervisor state
and the fleet's budgets and returns one action (none, sign in, install, reload) with the new state:

| Observed | Action | Limits |
| --- | --- | --- |
| Loading | None | |
| Login form on a fresh page, or for a minute after the page left the game | Sign in | Every 2 minutes per tab, and six in the fleet per half minute: twelve sign-ins at once saw two or three refused, nine none |
| Bridge or bot missing, or older code outside a raid | Install | Every 2 minutes per tab, at once after this tab's sign-in |
| Heap floor at half the limit for 10 minutes, or 25 kills in a row without a loot line, which the bridge counts (`faults.lootless`) | Reload at a quiet moment with every row on disk | One reload in the fleet per 10 minutes |

A tab that does not answer stays with the attention rules (`gone`), since no action in it can help.
The supervisor replaces `recoverTab`'s timers, `recycleTab`, `recycleReason` and iqd's lootless
count, and the executor in iqd only carries out the action in the tab (`pageAction`). Its tests
replay recorded situations: twelve tabs signed out at once, a reloaded page that signs in and
installs, a reload that waits for its moment while another tab signs in, the loot fault and a heap
dip.

### Client defects are shims

The adapter has no game policy. A known defect of the client is compensated in a shim, kept apart
in one section of the adapter (`SHIMS` in `src/bridge.js`), each with the defect it answers, the
evidence, and a count of how often it stood in for the client, which the snapshot carries. A shim
leaves the client's healthy path alone. `tools/check-client.mjs` checks for every shim that its
anchor, the client code it relies on, still exists in a new client release, and notes when its
defect is gone, so a shim whose count stays at zero on that release is deleted. The first is the
loot preview, which calls back when a disposed scene cannot. The second freezes the world matrix
of the scene's root nodes, because the client's ray casts recompute every collision mesh on each
cast while a root is free (docs/client-internals.md, "What a page spends its time on"). Principle
8 becomes: the adapter has no policy, it retries idempotent reads, and it compensates documented
client defects in shims.

### One query for read-only requests

The adapter offers `query(op, payload)` (`READS` in `src/bridge.js`): a read-only request with a
timeout, asked up to three times with a growing pause, which refuses any request it does not know
to be read-only. A request that can also act, such as the daily boss list that summons a boss
with a key, names the payloads that only read. Inventory Search in the gear survey and the
coordinator's `searchInPage`, the zone's spawns, the daily boss list, the AA state and a
tradeskill bank's contents use it, and the searches lost their own retries. Actions keep their
effect checks, and a task step retries an action that changes the game, because only the step
knows whether it took effect.

### Samples name their character

Each sample carries the active character's id (`cid`), and every reader takes an XP difference
only between two samples of one character (`xpStep` in `tools/lib/samples.mjs`): the minute
totals, the zone rates, `analyze.mjs`, `calibrate.mjs`, `plan.mjs` and the bot's report. A switch
to a lower-level member showed as -22M XP per hour for group 1 and a switch back as 32M for group
8. Samples recorded before the id fall back to the party's size and first companion.

## Decisions

- A failed zone load is answered with Try Again, and a shim compensates the defect it leaves.
  Failed loads came 0.31 times per tab-hour on 2026-11-10, and with the shim those pages played at
  the rate of fresh ones, while a reload costs 60 to 90 s and a new zone load, which can fail again.
- The adapter compensates documented client defects in shims, and a fresh page cures what no shim
  covers.
- Page recovery is one pure state machine in `tools/lib/page.mjs`, run by iqd.
