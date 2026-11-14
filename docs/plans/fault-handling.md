# Fault handling

The bot owns game-action remedies, the adapter names observed causes and compensates client
defects, and the page supervisor restores the page. This is the fault-handling part of the
[controller design](controller.md).

## Causes and remedies

`ACTIVITY_RULES` in `src/bridge.js` labels activity from the evidence available in the page.
`REMEDIES` in `src/bot.js` maps idle causes to delays and remedy ladders. Read that table and the
bot's configuration for the current delays rather than duplicating them here.

The remedy table is the only owner that starts AutoLevel. Holds stop it for work that must not
hunt, and ending a hold lets the `held` remedy start it again. A restart remedy stops AutoLevel
for a fresh start rather than starting it directly.

| Cause | Remedy |
| --- | --- |
| `loadFailed` | Press Try Again, including under a hold |
| `deadFight` | Leave the dead fight, including under a hold |
| `held`, `contested`, `clientPause`, `off` | Start after the cause's configured delay |
| `clientRejoin` | Rejoin the world, then let the resulting hold release AutoLevel |
| `noEnemies` | Widen limits, move, then start |
| `waitAttack`, `readyWait` | Stop for a fresh start |
| `stuckApproach` | Skip the target, stop for a fresh start, then move |
| `noTarget` | Stop for a fresh start, widen limits, then move |
| `crowded` | Widen limits, then move. During an errand, end the errand instead |

Ladders marked `untilKill` persist until the next kill. Errands leave out ordinary rungs that
change zones or limits. The client's post-kill waits and an `unknown` cause have no remedy.

## Page supervisor

`pageStep` in `tools/lib/page.mjs` is a pure decision function. It takes a page observation,
per-page state, fleet budgets and export status, then returns updated state and at most one
action. iqd executes that action through `pageAction`.

`PAGE` in that module defines the thresholds and budgets.

| Observation | Action and limits |
| --- | --- |
| Loading | Wait until `PAGE.loadingMin`, then reload under the sign-in budgets |
| Disconnected character select | Reload after `PAGE.offlineSec`, under the sign-in budgets |
| Game shown without a connection | Reload after `PAGE.gameOfflineMin`, under the sign-in budgets |
| Login form | Sign in immediately on a fresh page, otherwise after `PAGE.offlineSec`. Per-page spacing and the fleet burst window limit attempts. A refusal holds fleet sign-ins for `PAGE.refusedHoldSec` |
| Bridge or bot missing | Install, with per-page spacing and an exception after sign-in |
| Older code | Install outside raids and running in-world tasks younger than `PAGE.taskWaitMin` |
| Client travel desynchronization or `faults.lootless` reaching `PAGE.lootlessKills` | Reload at a quiet moment after export, under the fleet restart budget |
| Sustained heap floor | Renew the tab's process at a quiet moment after export, under the same fleet restart budget |

Heap renewal uses the minimum reading over `PAGE.heapWindowMin`, compared with
`PAGE.heapShare` of the heap limit. It requires history spanning the full window, at least three
readings within it, and no gap larger than half the window, including the gap at its start.
Readings reset when the page session changes. Renewal replaces the process because a reload
alone does not release everything the tab's process keeps.

A quiet moment requires the world to be ready, no running task, raid, fight or zone load, and no
recently ended raid within the supervisor's protected interval. Fault reloads and renewals also
require every recorded row to be exported and respect `PAGE.reloadGapMin`. Loading and
connection recovery use the sign-in budgets instead. An unreachable or erroneous observation
produces no page action.

## Adapter boundaries

`SHIMS` in `src/bridge.js` compensates documented client defects without changing the healthy
path. `READS` identifies read-only requests and payloads that `query` may retry. Actions remain
with the controller or task that can check their effect.

Activity labels belong to `ACTIVITY_RULES`, game-action recovery belongs to `REMEDIES`, and
page sign-in, installation, reload and process renewal belong to `pageStep`.
