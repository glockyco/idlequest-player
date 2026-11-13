# Epic model

How the coordinator gets every roster character its class epic: it reads each epic's steps from the
game's quest scripts, the sources of each piece from the content's tables, plans each character's
next steps from what the account holds, and runs them as tasks beside leveling and gear trips. The
research per class stays in [epics.md](epics.md) until the model reproduces it.

## Problem

- The coordinator runs chains from `data/quests.json` beside generated model parts, excluding parts
  whose steps yield a hand-kept chain's reward for the same class. Unsupported steps still block
  their epic's generated chains.
- A hand-written chain drifts from its scripts: a step that spawns a scene, a keyword the NPC wants
  first or a piece a later hand-in replaces has to be found and typed by hand, and a content update
  breaks it silently.
- Nothing plans the drops: the pieces most epics need come from named enemies and raid bosses, many
  NO DROP and LORE, one kill per character.

## Design

### Steps from the scripts

The analyzer reads every NPC script into events with their conditions and actions:

| Event | Condition | Actions |
| --- | --- | --- |
| say | the keyword the branch matches, the class it checks, the flags it reads | items given, flags set, NPCs spawned, timers and signals started |
| trade | the items and coin the branch takes, the class and flags it checks | the same |
| death, timer, signal, spawn | the event of a scripted NPC, which a trade or a say started | the same, and the NPC's loot on death |

A step of an epic is one event with its conditions, so a hand-in that wants a keyword first becomes
a say and a trade at the same NPC, and a hand-in that spawns a scene becomes the trade, the kill of
the scripted NPC and its loot. A flag set by one step and read by another orders them. Where a script
uses an idiom the analyzer cannot read, the step is listed with its script and line, and the check
fails until the analyzer reads it or a data entry beside the step covers it with that line cited.

### Sources

Every piece no step gives comes from the content's tables: an NPC's loot (static or scripted, with
level, hit points, spawn chance, points and respawn), a ground spawn, a merchant, a recipe or a
spell. A piece with no source is a gap, and the check lists it with its class.

### Plan per character

For each character without its epic, the plan walks back from the reward and picks, for each piece,
the cheapest way the account can get it: held already (NO DROP pieces move between account
characters with `pullItem`, and a LORE copy blocks a second), made, bought, looted from a group kill,
or looted from a raid kill. The character's next steps are those whose inputs the account holds or
can get now. A kill that several characters need, one copy each, is planned once for all of them.

Chains, generated or kept in `data/quests.json`, can carry an `ids` map from item
name to item type id. The coordinator and quest task use it to distinguish items
with the same name. A generated part's `needs` lists every copy its steps consume
that an earlier step in that part has not yielded and that the part does not buy.
An earlier yield covers one consumed copy, not every later use of that item.

The coordinator's `decide` uses `own` for pieces a member already holds and `have`
for copies outside the chain's needers. It schedules a member only when each
needed copy is held by that member or covered by a free outside copy. Each free
copy covers one member's missing copy. A member already past the consuming step
can continue without those inputs, and pulls avoid other needers' copies.


### Running the steps

Steps run as quest tasks with the step kinds the bot has: talk with keywords, give, hand in each,
buy, craft, kill with a wait, and a hand-in with coin. The Give Items window takes coin from the
cursor, where the purse's own action puts an amount of one kind, and a member whose purse is short
first takes the smallest balance of the account that covers the trade, with Manage Money's
transfer, which keeps each kind of coin (`coinFor` in `src/bot.js`, `giveToNpc` and `takeCoin` in
`src/bridge.js`). A piece a merchant sells is bought at its hand-in when a merchant of that zone
sells it, and else in a step of its own before it, in a city where any party can shop
(`data/shop-zones.json`) when one sells it. A quest item that lies in a zone is picked up with the
client's own requests (`pickupGround`: the zone's ground items, then the pickup within 20 units),
and one another player took ends the task until its respawn. A part whose craft trivials above 50
waits until a character trains that tradeskill, because a failed attempt uses its components up.
A summoning spell the epic's own class casts is a step of its own (`castSummon`: scribe the scroll,
memorize it into the last gem, click the gem), at the spell's level. One only another class casts,
such as the Enchanter's Enchant Platinum for the Shadow Knight, still keeps the epic's chains out,
and so does a forage. A timer or a signal branch runs by itself once its starter has, so the step after it waits
as a kill step waits for a summoned enemy. A hand-in is made by the active character, so the task
plays the character whose epic it is, as quest tasks do now. A step at an NPC names the NPC's type
ids, because two NPCs of a zone can share a name and answer to different items, as the two Spirit
Sentinels of the Emerald Jungle do. A model part that yields a hand-kept chain's reward of its
class stays out (`uncovered`), because the hand-kept chains carry keywords the model does not
read, and the parts beyond it start from what the hand-kept chain hands on.

A chain part with a fight runs in one tab at a time, because a hand-in calls one enemy and takes
its giver away until the respawn, and it waits for a group whose kill chance against the enemy is
under a half (`questKillChance` in `tools/lib/coordinator.mjs`, the chance of
[gear-acquisition.md](gear-acquisition.md)). An enemy above level 60 is held the same way, not
left out: a chain exists for every epic whose steps the bot can run, and its part waits at the
fight, while the parts before it run. A part asks for level 60 at most.

A piece that drops becomes a gear acquisition target (docs/plans/gear-acquisition.md) worth the
progress the epic adds to its character's group, shared by the pieces still missing, so trips and
camps take it by expected value like any drop. Only an epic the account can finish has its pieces
hunted: its steps are open and use the kinds the bot has (`missingKinds`). A piece that needs a raid joins the raid way and the
boss kills of [raids.md](raids.md).

### Order

An epic is worth what its finished item adds to the account: its stats and procs by `xpGain` like any
gear, and its click by what the click does for the account, such as the Cleric's resurrection
without mana in a raid. The chains run by value per hour of the whole chain, and a step's task comes
before a gear trip, because each step is certain progress.

## Migration

| Step | Change | Removes |
| --- | --- | --- |
| 1 | The analyzer reads events, conditions and actions, and a check lists every epic's steps, sources and gaps. | The `needFor` closure as the epic's definition |
| 2 | The plan per character, and quest tasks generated from it for the epics whose steps use the existing kinds. | Their chains in `data/quests.json` |
| 3 | Dropped pieces as acquisition targets with the epic's value. | `data/opportunities.json` epic pieces |
| 4 | New step kinds as the epics in the plan reach them. Built: the coin hand-in, the purchase in a step of its own, the ground pickup and the summoning cast by the epic's own class, which with hard kills held by the kill chance give chains to the Necromancer, Paladin, Cleric, Monk, Bard, Wizard, Warrior, Enchanter and Magician beside the Ranger's Earthcaller and the Shaman. A part whose craft trivials above 50 waits for a trained tradeskill (the Warrior's Rebreathers). To build: a cast by another class (the Shadow Knight's Enchanted Platinum Bar), forage, tradeskill training. | |
| 5 | Kills and raid pieces a group cannot win, such as the Wizard's enraged golem at 65 with 175,000 HP, with the raid way and the boss kills. | |
| 6 | The model covers every epic. | The class sections of `epics.md` and the remaining epic chains |

## Checks

- Tests: the analyzer on script fixtures for each idiom (a keyword before a trade, a class check, a
  flag that orders two steps, a scene with a timer, a scripted NPC's loot), and the plan's choice of
  source and its shared kills.
- The check tool (`bun tools/epic-model.mjs`, docs/collector.md, Gear) lists, per class, the steps, the sources, the
  gaps and the unread idioms, and runs after every content update.
- Live: the first step of each new kind runs once for one character before the coordinator runs it
  for all, and each epic's first completion is recorded in the diary with its time and kills.

## Decisions for review

- Data beside the scripts: allowed only for an idiom the analyzer cannot read yet, each entry citing
  its script and line, with a check that fails when that script changes. Recommended, because a few
  scripts run long timed scenes that cost more to analyze than to describe.
- Epic value: `xpGain` for stats and procs plus a value per click effect. Recommended over the
  ranking in `epics.md`, which is an inference.
- Raid pieces: planned with the raid way, which needs the first raid hour's live check of the raid
  task and its loot. Recommended to build steps 1 to 4 first, which need no raid.
