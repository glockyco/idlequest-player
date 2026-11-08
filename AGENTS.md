# Agent instructions

These rules are for agents that play the account with this repository. [README.md](README.md) covers setup, the SDK, the tools and how to measure efficiency. The current plan is in [docs/plans/leveling-plan.md](docs/plans/leveling-plan.md).

## Keep the game playing

- The account progresses only while AutoLevel runs in the connected game tab. End every turn with AutoLevel running unless a stop condition of the goal holds.
- Play runs unattended, so a game decision never waits for an answer here. Do not call the ask tool or open a Plannotator review for one, because a blocked session cannot react while the party keeps running into the problem. Take the reversible choice that keeps XP coming, act on it, and list it under "Decisions to review" in the diary entry with the reason. Stop and ask only for a stop condition of the goal, such as a login form, a character about to be deleted or a warning about automation.
- The bot in `src/bot.js` does the routine work inside the page and keeps running while no agent is attached. It restarts AutoLevel when it stays off without a pause or hangs, clears bag space before the bags fill, puts a forgotten cursor item away and raises alerts. Extend the bot instead of repeating routine work by hand.
- Stop AutoLevel only with `stopAutoLevel` or `pausedAutoLevel`. Both pause the bot with a deadline, so a forgotten stop ends by itself. Renew the pause with `pauseBot(minutes, reason)` for longer work.
- Requests to the server that only read, sent to learn how the game works, are allowed even when the client would not send them in the current state: `window.iq.socket.sendCorrelatedJsonRequest(op, replyOp, payload, 10000)` with opcodes from `data/opcodes.json`. Examples are raid snapshots of account characters (1194), a zone's NPC list (1004) and the raid time quote (1236 with `action: "status"`). Never send a request that spends coin, changes a character or could gain items, XP or coin outside normal play, and space requests so they never load the server.

## Session start

1. Start the session in this repository so these instructions load.
2. Adopt the game tab without navigating it, because navigation logs the game out. The tab's name and target can change between sessions, so list them first with `browser.targets({ app: { relay: true } })`:

   ```js
   const tab = await browser.open({ name: "iq", app: { relay: true, target: "idlequest.net/play" } }); // never pass a url to an adopted tab
   const { attach } = await import("/Users/glockyco/src/github.com/glockyco/idlequest-player/src/client.mjs");
   const iq = await attach(tab);
   await iq.botReport();
   ```

3. Recover on your own. Never wait for a person while the game can be played:
   - No idlequest page in the target list, a tab that cannot be reached, or a login page that stays on "Preparing game engine…": open a tab of your own with `browser.open({ name: "iq-<n>", app: { relay: true }, url: "https://idlequest.net/play", persist: true })`. It opens visible, so the engine loads. A hidden tab never finishes "Preparing game engine…" and keeps CONNECT disabled. Chrome detaches the relay from a tab when a password manager's autofill menu opens in it, and then hides the tab until its URL changes.
   - On the login form, sign in from `~/.config/idlequest/email` and `~/.config/idlequest/password` (mode 600, outside the repository) without printing the values. Never focus or click the inputs and never use `tab.fill`, because focusing opens the autofill menu, which detaches the tab. Set each value with the native `HTMLInputElement` value setter and dispatch an `input` event inside `tab.evaluate`, then `tab.click('role/button[name="CONNECT"]')` and wait for "SELECT A CHARACTER".
   - At character select the list shows eight characters per page. Press "Next page" until the leader's button appears, click it, then ENTER WORLD.
   - Never reload a game tab. A reload turns a broken session into a login page. If fights stop being confirmed ("The combat request could not be confirmed") while the socket is connected, open a new tab and sign in there.
   - Never delete or create characters while a group plays: the world session stopped confirming fights right after deletions. Do it at character select.
   - "LOADING FAILED: IdleQuest could not finish loading the zone" has a TRY AGAIN button, which loads the zone without a reload. A tab that answers "Selected tab is not ready" for a minute has crashed: open a new tab, sign in, and `iq.switchCharacter(leader)` from character select after setting the bot's `partyIds`, because a new tab starts with empty bot settings.
   - Disable the bot (`iq.setBot({ enabled: false })`) for a trip outside the rotation, such as shopping, or it moves the party back into a rotation zone.
   - Ask for help only if the login files are missing or the server rejects the login.
4. After a sign-in the party holds no account characters. The bot asks the characters in its `partyIds` setting to rejoin once it is attached. The ids are the numeric `characterId` of each companion (`iq.roster()` shows them as `character-<id>`). The setting is saved in the tab's session storage, which survives reloads of that tab. Set it again with `iq.setBot({ partyIds: [...] })` when the party changes or in a new tab. `iq.switchCharacter` sets it.

## Unattended loop

The collector `tools/iqd.mjs` watches every game tab, so an agent never polls tabs by hand (README, "Monitoring"):

1. Keep `bun tools/iqd.mjs run` running as a long-lived process. Start it at session start if `bun tools/iqd.mjs status` says the daemon is not running.
2. Start each turn with `bun tools/iqd.mjs status`: sessions, characters, open attention items and open jobs.
3. Handle open attention items first, `act` before `decide`, and close each with `iqd ack <id> <what was done>`.
4. Register background work that a decision waits for with `iqd job add` and close it with `iqd job done`. Results go under `runs/jobs/`, never into a temporary directory.
5. When nothing needs a hand, run `bun tools/iqd.mjs wait --severity decide` as a background job. It ends when an item at or above that severity appears, and its end wakes the agent. Do not use sleep timers for supervision.
6. Record each change of a game setting with `iqd note <text> --session <leader>` until the SDK records changes itself.

Attention items mirror the bot's wake alerts. The responses per bot alert:

| Alert | Response |
| --- | --- |
| `levelUp` | Take a screenshot for the diary at milestones. Check that new spells were bought and check the plan for the new level. The bot fills the leader's gems with the best learned spell of each role from the client's auto-cast table for its class (`data/class-spells.json`, see `iqBot.spellPlan()`) and replaces the leader's pet once a new summon is memorized and its reagent is in the bags. Warrior, Monk and Rogue leaders cast nothing, so their gems are left alone. Companions' pets are replaced for every owner class. |
| `death` | Read the chat around it. If the guard did not leave, tighten the AutoLevel limits or change zone, and record the decision. A dead leader takes the free respawn at the bind point after `respawnAfterSec` (a `respawn` note), and the bot then moves the party back into its rotation. |
| `lootFull` | Loot stayed on corpses. It wakes only when fewer than `minFreeSlots` bag slots are free or the cursor is taken, because a looted container needs a free general slot and is refused even with free bag slots. Check `iq.bagSpace()` and `iqBot.surplus()` in the page, then free space or raise `minFreeSlots`. Items left on a corpse are gone after 7.5 minutes, or 25 minutes for enemies of level 55 and above (wiki, Loot & Inventory). |
| `cursor` | An item sits on the cursor. The bot puts it away after three minutes. If it cannot, free a general slot or place the item by hand until `bagSpace().cursor` is null. |
| `xpStall` | AutoLevel ran ten minutes without XP although the bot restarts it after a hung route recovery, a readiness wait with everyone full, or three idle minutes out of combat (`stuckRestart` notes). Look for a pending cure, a mana loop or no targets in the con range, then change limits or zone. |
| `autoLevelRestarted`, repeated | Something keeps stopping AutoLevel. Find it in the event log. |
| `offline` | The page left the game world. Never reload or navigate the tab. The client tries to resume the session by itself. If the login form shows, sign in from the local login files as "Session start" describes. |
| `guard` | Our own pulls triggered repeated escapes and the guard lowered the level cap, or an escape failed to restart AutoLevel. Escapes from wanderers alone do not alert: judge the zone by its measured XP per hour, which `analyze.mjs` reports with the escapes and their cost. An escape re-enters the zone at its safe spot, and a second escape within the guard's `loopSec` leaves for another zone of the rotation, because a mob camping the safe spot would start the same fight again. |
| `noEnemies` | Nothing in the zone passes AutoLevel's limits even after the bot restored guard-tightened limits and a blue minimum con, and `rotation` names no other zone. Usually the party outleveled the zone or emptied what it can reach. Set `rotation` to two or three zones measured for the level band. |
| `rotate` | The bot moved to the next zone in `rotation`, because the current one ran out of reachable enemies, its last 10 minutes earned under 60% of the visit's best, or `rotateEscapes` guard escapes happened there in 10 minutes. A party that spends `outsideRotationSec` in a zone outside `rotation`, such as a home city or the bind point after a respawn, moves to its first zone. Only a failed move wakes a script. When `rotation` is not empty, the bot also rewrites it from the band rows in `data/band-rotations.json` each time the leader reaches a new row. Every row follows `tools/predict.mjs --level N`, and rows from 38 have no measured rate yet, so compare the first hour at a new row with the model (`tools/plan.mjs` shows the calibration) and replace a zone that falls short. |
| `crowded` | Spawns are contested. Weigh the options in [docs/guide.md](docs/guide.md#deciding-where-to-hunt-and-what-to-do), such as staying, a wider target range, another zone or an errand. Then measure the choice and record it with the reason. |
| `errand` | An errand ended without its item: its deadline passed, the party left the zone or the guard escaped repeatedly. The bot rotates on by itself. Decide from [docs/plans/epics.md](docs/plans/epics.md) whether to run it again. |
| `memory` | The page's JS heap passed 80% of its limit (`memoryAlertShare`). Record `iq.botReport().memoryMB` in the diary. A renderer that crashes is replaced by a new signed-in tab as "Session start" describes. |

## Inventory and the game UI

- Bag 0 slots 22-29 are the general slots and slot 30 is the cursor. Bag N is the container in general slot N-1. A bag held on the cursor takes all its slots out of play and blocks looting.
- Left-click picks an item up onto the cursor and right-click opens a bag. After any UI work, check that `iq.bagSpace().cursor` is null and close windows with `iq.clearWindows()`.
- Selling needs no merchant. The bot uses the client's own sale call, and the Sell Item button sells the cursor item.
- When fewer than `minFreeSlots` bag slots are free, the bot first runs the game's Auto Bank (at most every ten minutes), which sends crafting ingredients and spell scrolls to the tradeskill bank. Then it sells copies beyond `keepCopies` of each item, then single items priced at most `junkMaxCopper` that have no proc, click, worn or focus effect, cheapest first. It never sells `keepItemIds`, the reagents of the leader's class spells, containers, NO DROP or NO RENT items, items without a merchant price, equipped items or items in No Sell bags. A single food, drink, spell research piece (`keepNamePattern`) or quest turn-in item (`data/quest-items.json`) is kept as well, but extra copies of them are sold. Dearer single items stay for hand-downs or a person to review. `iqBot.surplus()` lists what it would sell next.

## Experiments and records

- Tag every configuration change with `setLabel` and compare labels with `tools/analyze.mjs` as the README describes. Record the label, window, result and decision in the diary.
- Write one diary entry per session in `diary/` with screenshots in `diary/media/`, including one for each milestone and raid kill.
- Commit verified work in small commits whose body says why. Never push.
