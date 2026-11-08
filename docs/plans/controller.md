# Controller design

How the code that plays the twelve game tabs is meant to be built, and the order in which the
current bot moves to it. The goal is that every tab spends its time on something that pays, that a
crash anywhere heals by itself, and that every choice comes from one measured value model instead
of a constant per symptom.

## Principles

1. Each tab has a desired state and converges to it. A loop in the page compares the desired state
   with what it observes and takes the one next step toward it. Every step can be repeated
   safely, so a crash at any point is repaired on the next pass. Scripts change the desired state
   and never drive a sequence of steps themselves.
2. Hunting is the default activity and never ends. Everything else is a task with steps, a
   timeout per step and a deadline, and every task ends in hunting, whether it finishes, fails or
   times out. An errand's enemies are a priority inside hunting, not a filter that can leave the
   party with nothing to fight.
3. Every second of every tab carries one label: fighting, approaching a target, recovering,
   traveling, a task, dead, or idle with a reason. Idle time is a measured quantity. One table maps
   each idle reason to its remedy, and a remedy that fails twice wakes a person.
4. Choices compare value per hour in one currency, the XP a tab earns in its time. Rates come from
   the live runs (`tools/calibrate.mjs`, `tools/fights.mjs`) and costs are known quantities, such
   as a leader death costing level squared times 666.67 XP. Thresholds follow from the model.
5. Outside control takes a lease with an owner, an expiry and the desired state to return to. When
   the owner disappears, the lease runs out and the tab converges to its desired state again,
   including its leader and its zone.
6. Work of more than one step runs in the page as a state machine that survives a reinstall of the
   bot. A script only queues the task and reads its progress, because one page call may last at
   most about 30 seconds and the script's process can die.
7. Whatever several tabs share is decided in one place, the coordinator in `tools/iqd.mjs`: zones,
   lightstones, coin, experiments and deploys. It writes desired states and never plays.
8. The adapter to the game client has no policy in it. It offers one snapshot of the world and
   actions that check their own effect. `tools/check-client.mjs` checks it against every new
   client release.
9. Policy code is pure. It is tested on situations recorded in the live runs, and against
   invariants: no idle second without a remedy under way, the active character is the desired
   leader unless a lease says otherwise, and every task ends in hunting.

## Parts

| Part | Lives in | Owns |
| --- | --- | --- |
| Adapter | `src/bridge.js` | The world snapshot (party, zone, enemies and their targets, inventory, cursor, open windows, AutoLevel, coin) and the actions: start and stop hunting, travel, target enemies, trade with an NPC, switch the active character, move coin, sell, recover from death, close windows |
| Controller | `src/bot.js` | The loop: desired state and leases, the reconciler (leader, party, zone, AutoLevel, client options), the task runner, the safety decision, the bag and spell chores and the time labels |
| Value model | shared by the page and the tools | Rates per level, zone and group, the death risk model and the costs of escapes, deaths, character switches and trips |
| Coordinator | `tools/iqd.mjs` | Zone assignment from measured rates and spawn capacity, lightstone and coin allocation, task scheduling, experiments with frozen desired states during their blocks, versioned deploys, alerts and the decision log |

## Tasks

| Task | Steps | Ends |
| --- | --- | --- |
| Hunt | AutoLevel in the assigned zone, with priority enemies when an errand applies | Never; it is what every other task returns to |
| Errand | Travel, then Hunt with the errand's enemies first | Item in the bags, deadline, or the party leaves the zone |
| Hand-in | For each member: let the fight end, become active, travel to the NPC's zone, pull the member's share from whoever holds it, walk to the NPC and trade | All shares handed in, or a step fails twice; then the pause ends and the bot restores the leader |
| Recovery | Choose a resurrection or the free respawn, get coin if one is worth buying, return to the zone | The leader is alive in its zone |

## Migration

Each step ships to one group first, is measured with the time labels against the other groups, and
then goes to all of them. The old code a step replaces is deleted in the same step.

1. Time labels and idle causes in the page, kept in every sample, and one stall alert from the
   collector when a tab stays idle or dead for 2 minutes, or makes no kill for 5, in any mode but a
   pause or a raid.
2. The bot's pause becomes the lease: while it holds, the bot leaves the leader, the party, the
   zone and AutoLevel alone, and when it ends the bot restores all four from its settings
   (`leaderId`, `partyIds`, `rotation`). Switching the active character moves into the page.
3. The task runner, with Recovery and Hand-in as its first tasks and errands as priority enemies.
4. The remedy table for idle causes. The stuck restarts, the crowding count, the XP stall and the
   empty-zone handling go.
5. The coordinator's zone assignment, lightstone and coin allocation and experiment runner. The
   zone counts in the browser's shared storage and the band row changes at level-up go.
6. The value model and the safety decision fitted from the fight logs. The guard's fixed triggers
   become its inputs.
