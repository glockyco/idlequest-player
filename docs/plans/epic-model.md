# Epic model

How the coordinator gets every roster character its class epic: it reads each epic's steps from the
game's quest scripts, the sources of each piece from the content's tables, plans each character's
next steps from what the account holds, and runs them as tasks beside leveling and gear trips. The
research per class stays in [epics.md](epics.md) until the model reproduces it.

## Problem

- The coordinator runs 21 hand-written chains (`data/quests.json`) that cover the early steps of ten
  epics. The rest of every epic is prose in `epics.md`, so no character progresses past those steps.
- A hand-written chain drifts from its scripts: a step that spawns a scene, a keyword the NPC wants
  first or a piece a later hand-in replaces has to be found and typed by hand, and a content update
  breaks it silently.
- The quest graph (`tools/lib/quest-graph.mjs`) already reads hand-ins, rewards, combines and summoning
  spells. It sees no spoken keyword, no quest flag, no class check and no scene that a timer or a
  signal runs, and it follows every edge that gives an item, so the Warrior's closure reaches 98
  scripts, most of them other quests that give a common item the epic also takes.
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

### Running the steps

Steps run as quest tasks with the step kinds the bot has: talk with keywords, give, hand in each,
buy, craft and kill with a wait. A pickup of a ground spawn, the cast of a summoning spell and a
forage are new kinds, added when an epic in the plan needs them. A hand-in is made by the active
character, so the task plays the character whose epic it is, as quest tasks do now.

A piece that drops becomes a gear acquisition target (docs/plans/gear-acquisition.md) worth the
progress the epic adds to its character's group, shared by the pieces still missing, so trips and
camps take it by expected value like any drop. A piece that needs a raid joins the raid way and the
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
| 4 | New step kinds as the epics in the plan reach them: ground pickup, summoning cast, forage. | |
| 5 | Raid pieces with the raid way and the boss kills. | |
| 6 | The model covers every epic. | The class sections of `epics.md` and the remaining epic chains |

## Checks

- Tests: the analyzer on script fixtures for each idiom (a keyword before a trade, a class check, a
  flag that orders two steps, a scene with a timer, a scripted NPC's loot), and the plan's choice of
  source and its shared kills.
- The check tool lists, per class, the steps, the sources, the gaps and the unread idioms, and runs
  after every content update.
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
