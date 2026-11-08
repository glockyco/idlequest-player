# Agent instructions

These rules are for agents that play the account with this repository. [README.md](README.md) covers setup, the SDK, the tools and how to measure efficiency. The current plan is in [docs/plans/leveling-plan.md](docs/plans/leveling-plan.md).

## Keep the game playing

- The account progresses only while AutoLevel runs in the connected game tab. End every turn with AutoLevel running unless a stop condition of the goal holds.
- Play runs unattended, so a game decision never waits for an answer here. Do not call the ask tool or open a Plannotator review for one, because a blocked session cannot react while the party keeps running into the problem. Take the reversible choice that keeps XP coming, act on it, and list it under "Decisions to review" in the diary entry with the reason. Stop and ask only for a stop condition of the goal, such as a login form, a character about to be deleted or a warning about automation.
- The bot in `src/bot.js` does the routine work inside the page and keeps running while no agent is attached. It restarts AutoLevel when it stays off without a pause or hangs, clears bag space before the bags fill, puts a forgotten cursor item away and raises alerts. Extend the bot instead of repeating routine work by hand.
- Stop AutoLevel only with `stopAutoLevel` or `pausedAutoLevel`. Both pause the bot with a deadline, so a forgotten stop ends by itself. Renew the pause with `pauseBot(minutes, reason)` for longer work.

## Session start

1. Start the session in this repository so these instructions load.
2. Adopt the game tab without navigating it, because navigation logs the game out:

   ```js
   const tab = await browser.open({ name: "iq", app: { relay: true, target: "idlequest.net/play" } }); // never pass a url
   const { attach } = await import("/Users/glockyco/src/github.com/glockyco/idlequest-player/src/client.mjs");
   const iq = await attach(tab);
   await iq.botReport();
   ```

3. If the tab shows the login form, stop and ask for a sign-in. If the tab cannot be reached, for example after its renderer crashed, the bot is gone with the page and `watch` fails instead of alerting. Do not reload the tab yourself: stop and ask for a reload and a sign-in.
4. After a sign-in the party holds no account characters. The bot asks the characters in its `partyIds` setting to rejoin once it is attached. The ids are the numeric `characterId` of each companion (`iq.roster()` shows them as `character-<id>`). The setting is saved in the browser, so set it again with `iq.setBot({ partyIds: [...] })` only when the party changes.

## Unattended loop

Call `watch` in one eval cell with a timeout a few minutes above its `minutes`, act on what woke it, and call it again with the returned `alertSeq`. One call covers up to 55 minutes of play.

```js
const r = await iq.watch({ minutes: 50, sinceSeq: seq, exportDir: "runs/<date>-live" });
```

| Alert | Response |
| --- | --- |
| `levelUp` | Take a screenshot for the diary at milestones. Check that new spells were bought and check the plan for the new level. The bot fills the leader's gems with the best learned spell of each role from the client's auto-cast table for its class (`data/class-spells.json`, see `iqBot.spellPlan()`) and replaces the leader's pet once a new summon is memorized and its reagent is in the bags. Warrior, Monk and Rogue leaders cast nothing, so their gems are left alone. Companions' pets are replaced for every owner class. |
| `death` | Read the chat around it. If the guard did not leave, tighten the AutoLevel limits or change zone, and record the decision. |
| `lootFull` | Check `iq.bagSpace()` and `iqBot.surplus()` in the page, then free space or raise `minFreeSlots`. Items left on a corpse are gone after 7.5 minutes, or 25 minutes for enemies of level 55 and above (wiki, Loot & Inventory). |
| `cursor` | An item sits on the cursor. The bot puts it away after three minutes. If it cannot, free a general slot or place the item by hand until `bagSpace().cursor` is null. |
| `xpStall` | AutoLevel ran ten minutes without XP although the bot restarts it after a hung route recovery, a readiness wait with everyone full, or three idle minutes out of combat (`stuckRestart` notes). Look for a pending cure, a mana loop or no targets in the con range, then change limits or zone. |
| `autoLevelRestarted`, repeated | Something keeps stopping AutoLevel. Find it in the event log. |
| `offline` | The page left the game world. Never reload or navigate the tab. The client tries to resume the session by itself, and if the login form shows, stop and ask for a sign-in. |
| `guard` | Our own pulls triggered repeated escapes and the guard lowered the level cap, or an escape failed to restart AutoLevel. Escapes from wanderers alone do not alert: judge the zone by its measured XP per hour, which `analyze.mjs` reports with the escapes and their cost. |
| `noEnemies` | Nothing in the zone passes AutoLevel's limits even after the bot restored guard-tightened limits and a blue minimum con, and `rotation` names no other zone. Usually the party outleveled the zone or emptied what it can reach. Set `rotation` to two or three zones measured for the level band. |
| `rotate` | The bot moved to the next zone in `rotation`, because the current one ran out of reachable enemies, its last 10 minutes earned under 60% of the visit's best, or `rotateEscapes` guard escapes happened there in 10 minutes. Only a failed move wakes a script. When `rotation` is not empty, the bot also rewrites it from `BAND_ROTATIONS` in `src/bot.js` each time the leader reaches a level from 22 up. Only the rows for 31 and 34 were checked against `tools/predict.mjs --level N`, so check the row for each new band from that tool and the measured rate per zone. |
| `crowded` | Spawns are contested. Weigh the options in [docs/guide.md](docs/guide.md#deciding-where-to-hunt-and-what-to-do), such as staying, a wider target range, another zone or an errand. Then measure the choice and record it with the reason. |
| `errand` | An errand ended without its item: its deadline passed, the party left the zone or the guard escaped repeatedly. The bot rotates on by itself. Decide from [docs/plans/epics.md](docs/plans/epics.md) whether to run it again. |
| `memory` | The page's JS heap passed 80% of its limit (`memoryAlertShare`). Record `iq.botReport().memoryMB` in the diary. The renderer has crashed after many hours, and a crash needs a person to reload the tab and sign in. |

## Inventory and the game UI

- Bag 0 slots 22-29 are the general slots and slot 30 is the cursor. Bag N is the container in general slot N-1. A bag held on the cursor takes all its slots out of play and blocks looting.
- Left-click picks an item up onto the cursor and right-click opens a bag. After any UI work, check that `iq.bagSpace().cursor` is null and close windows with `iq.clearWindows()`.
- Selling needs no merchant. The bot uses the client's own sale call, and the Sell Item button sells the cursor item.
- When fewer than `minFreeSlots` bag slots are free, the bot first runs the game's Auto Bank (at most every ten minutes), which sends crafting ingredients and spell scrolls to the tradeskill bank. Then it sells copies beyond `keepCopies` of each item, then single items priced at most `junkMaxCopper` that have no proc, click, worn or focus effect, cheapest first. It never sells `keepItemIds`, containers, NO DROP or NO RENT items, items without a merchant price, equipped items or items in No Sell bags. A single food, drink or spell research piece (`keepNamePattern`) is kept as well, but extra copies of them are sold. Dearer single items stay for hand-downs or a person to review. `iqBot.surplus()` lists what it would sell next.

## Experiments and records

- Tag every configuration change with `setLabel` and compare labels with `tools/analyze.mjs` as the README describes. Record the label, window, result and decision in the diary.
- Write one diary entry per session in `diary/` with screenshots in `diary/media/`, including one for each milestone and raid kill.
- Commit verified work in small commits whose body says why. Never push.
