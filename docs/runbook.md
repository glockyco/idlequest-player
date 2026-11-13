# Operating a game tab by hand

The bot, the page supervisor and the coordinator operate the tabs. This page describes how to do their work by hand, for finding a fault and for getting a group playing again while its mechanism is repaired. [../README.md](../README.md) covers setup and running, [collector.md](collector.md) the collector, and [sdk.md](sdk.md) the calls a script makes in a tab.

## The bot keeps the tab

- The bot in `src/bot.js` does the routine work inside the page and keeps running while no agent is attached. It restarts AutoLevel when it stays off without a pause or hangs, clears bag space before the bags fill, puts a forgotten cursor item away and raises alerts. Extend the bot instead of repeating routine work by hand.
- Stop AutoLevel only with `stopAutoLevel` or `pausedAutoLevel`. Both pause the bot with a deadline, so a forgotten stop ends by itself. Renew the pause with `pauseBot(minutes, reason)` for longer work. When a pause ends, the bot brings back the tab's leader, party, zone and AutoLevel at once.
- Requests to the server that only read, sent to learn how the game works, are allowed even when the client would not send them in the current state: `window.iq.socket.sendCorrelatedJsonRequest(op, replyOp, payload, 10000)` with opcodes from `data/opcodes.json`. Examples are raid snapshots of account characters (1194), a zone's NPC list (1004) and the raid time quote (1236 with `action: "status"`). Never send a request that spends coin, changes a character or could gain items, XP or coin outside normal play, and space requests so they never load the server.

## Driving a game tab from a session

1. Adopt the game tab without navigating it, because navigation logs the game out. The tab's name and target can change between sessions, so list them first with `browser.targets({ app: { relay: true } })`:

   ```js
   const tab = await browser.open({ name: "iq", app: { relay: true, target: "idlequest.net/play" } }); // never pass a url to an adopted tab
   const { attach } = await import("/path/to/idlequest-player/src/client.mjs"); // the path of your clone
   const iq = await attach(tab);
   await iq.botReport();
   ```

   A session's browser reaches only one of the game tabs, because they share a title and an address. Any group's tab is reached through the collector's record of it, and the step is written to the steps by hand that the dashboard counts per day:

   ```sh
   bun tools/iqd.mjs page G10 'window.iqBot.stopTask()' --why "the hunt stands without a route to its enemy"
   bun tools/iqd.mjs page G10 'window.iqBot.state.task' --read   # changes nothing, so it is not recorded
   ```

   Record a step taken any other way with `bun tools/iqd.mjs note`, also an edit of the database, so that a day's count of steps by hand is true.

2. Recover on your own. Never wait for a person while the game can be played:
   - A tab at the login form is signed in again by `iqd run --recover` after a minute ([collector.md](collector.md#page-supervisor)). Do not sign it in by hand meanwhile, because the server refuses a burst of sign-ins ("Too many login attempts").
   - A group's tab is gone, cannot be reached, answers "Selected tab is not ready" for a minute or still shows the login form after five minutes: run `restoreGroup({ browser, attach, id })` from `src/group.mjs` with the group's id from `data/roster.json`. It opens a tab of its own, signs in, enters the world as the group's leader with the other members, restores the bot's rotation and starts AutoLevel, in about half a minute. Then close the old tab, if it still exists, in the browser: it is the game tab that shows the login form or a game that stands still. When `iqd status` still lists the old session as `GONE` after that, `ack` its item, which ends the session. A new tab opens visible, so the engine loads. A hidden tab never finishes "Preparing game engine…" and keeps CONNECT disabled. Chrome detaches the relay from a tab when a password manager's autofill menu opens in it, and then hides the tab until its URL changes.
   - `signIn` in `src/group.mjs` signs in from `~/.config/idlequest/email` and `~/.config/idlequest/password` (mode 600, outside the repository) without printing the values. By hand, never focus or click the inputs and never use `tab.fill`, because focusing opens the autofill menu, which detaches the tab. Set each value with the native `HTMLInputElement` value setter and dispatch an `input` event inside `tab.evaluate`, then `tab.click('role/button[name="CONNECT"]')` and wait for "SELECT A CHARACTER".
   - A tab left at character select needs nothing: the bot enters the world as its `leaderId` by itself.
   - Never reload a game tab by hand. A reload turns a broken session into a login page. iqd gives a tab a new process when its page heap stays high, reloads one whose loot lines stopped, and signs it in again ([collector.md](collector.md#page-supervisor)). `bun tools/iqd.mjs renew <group> --why <reason>` gives a tab a new process by hand. If fights stop being confirmed ("The combat request could not be confirmed") while the socket is connected, restore the group in a new tab with `restoreGroup`.
   - Never delete or create characters in the tab of a group that plays: the world session stopped confirming fights right after deletions. Do it at the character select, as `createGroup` does in a tab of its own while the other groups play.
   - "LOADING FAILED: IdleQuest could not finish loading the zone" has a TRY AGAIN button, which loads the zone without a reload. The bot presses it once for every failure (`loadFailed` in the remedy table), so a window that stays open needs a fresh page.
   - Disable the bot (`iq.setBot({ enabled: false })`) for a trip outside the rotation, such as shopping, or it moves the party back into a rotation zone. Play another character only under a pause (`iq.switchCharacter` takes one), because without one the bot switches back to its leader.
   - Ask for help only if the login files are missing or the server rejects the login.
3. Each tab's bot keeps its leader active and its members in the party: `leaderId` and `partyIds` are the numeric character ids (`iq.roster()` shows companions as `character-<id>`). They are saved in the tab's session storage, which survives reloads of that tab. `iq.setLeader(name)` sets both, and in a new tab `restoreGroup` does.

## Supervising by hand

The collector `tools/iqd.mjs` watches every game tab, so an agent never polls tabs by hand ([collector.md](collector.md)):

1. `tools/play.sh` runs the collector, and `bun tools/iqd.mjs status` says whether it runs.
2. `bun tools/iqd.mjs status` lists sessions, characters, open attention items and open jobs.
3. Close an attention item you handled with `iqd ack <id> <what was done>`. Conditions (`CONDITION_KINDS` in `tools/iqd.mjs`) close when they clear. An event closes when the tab shows it is over (a later task finished after a failed one, the tab plays again after an idle alert), when a newer one of its kind for the tab replaces it, an info event after ten minutes and an act event after an hour without an open condition on the tab (`EVENT_TTL_MS` in `tools/iqd.mjs`), so read the closed ones in the dashboard's attention list as well. Decisions stay open until answered.
4. Register background work that a decision waits for with `iqd job add` and close it with `iqd job done`. Results go under `runs/jobs/`, never into a temporary directory.
5. Run `bun tools/iqd.mjs wait --severity act` as a background job to wake when an item needs a person. `--severity decide` returns only decisions, not all items needing attention. Do not use sleep timers for supervision, because `wait` applies the same attention policy as `status`.

Attention items mirror the bot's wake alerts. The responses per bot alert:

| Alert | Response |
| --- | --- |
| `levelUp` | Take a screenshot for the diary at milestones. Check that new spells were bought and check the plan for the new level. The bot fills the leader's gems with the best learned spell of each role from the client's auto-cast table for its class (`data/class-spells.json`, see `iqBot.spellPlan()`) and replaces the leader's pet once a new summon is memorized and its reagent is in the bags. Warrior, Monk and Rogue leaders cast nothing, so their gems are left alone. Companions' pets are replaced for every owner class. |
| `deaths` | The deaths of the last hour cost more than a tenth of it (`deathCostShareAlert`, `watchDeaths` in `src/bot.js`), at most one alert an hour. A companion death costs about 38 s beyond a kill, so ten an hour wake, and a leader death about 85 s plus its lost XP at the hour's XP rate. Change the zone or the limits when the deaths cost more than the tougher targets pay. From level 5 the leader's death costs level squared times 666.67 XP, so a leader death costs about 10 to 17 minutes of the group's XP at every level. Companions keep their XP. The bot buys the best resurrection the leader can pay (`rezMaxPp`, keeping `rezReservePp`), which restores 50% for 50pp or 90% for 200pp and returns the leader to the corpse. A leader short of coin first pulls the largest account balance with Manage Money (`rezPullCoin`, never from `coinKeepNames`), because Manage Money moves only whole balances. Otherwise the bot takes the free respawn after `respawnAfterSec`. The bot then moves the party back into its rotation and companions rejoin. Read the deaths in `tools/groups.mjs` and the event log, then change the zone or the AutoLevel limits and record why. |
| `lootFull` | Loot stayed on corpses. It wakes only when fewer than `minFreeSlots` bag slots are free or the cursor is taken, because a looted container needs a free general slot and is refused even with free bag slots. Check `iq.bagSpace()` and `iqBot.fates()` in the page. Items left on a corpse are gone after 7.5 minutes, or 25 minutes for enemies of level 55 and above (wiki, Loot & Inventory). |
| `bags` | The bag reserve cannot hold because kept items alone fill the bags. The alert lists them: hand items to their characters, or narrow what the coordinator keeps. |
| `cursor` | An item sits on the cursor. The bot puts it away after three minutes. If it cannot, free a general slot or place the item by hand until `bagSpace().cursor` is null. |
| `idle` | An idle cause outlasted every rung of the remedy table (`REMEDIES` in `src/bot.js`), such as a crowded zone with no other rotation zone, an errand, which keeps its zone and limits, an AutoLevel that would not start, or a Loading Failed window that Try Again left open, which needs a fresh page. Weigh another zone, a wider target range or ending the errand as the [guide](guide.md#deciding-where-to-hunt-and-what-to-do) describes, then measure the choice and record it with the reason. |
| `task` | A hand-in, hunt or raid task failed at the step the alert names. `iqBot.state.task` holds the step and the error, and the tab is back with its leader. |
| `raid` | The raid task killed its target. The collector saves a screenshot to `diary/media/` on its first look after the kill. Keep the kill lines for the diary. |
| `autoLevelRestarted`, repeated | Something keeps stopping AutoLevel for no reason the page states. Find it in the event log. The client's own stops and the bot's holds are not behind it: the activity label names those (`clientPause`, `clientRejoin`, `contested`, `held`). `REMEDIES` in `src/bot.js` answers those with a start, or a rejoin for `clientRejoin`. For `noEnemies`, it first widens the limits, then tries moving zones, and finally starts another search. |
| `offline` | The page left the game world. Never reload or navigate the tab. The client tries to resume the session by itself, and `iqd run --recover` signs it in after a minute at the login form. The alert closes once the page is back in the world. If it still shows the login form after five minutes, restore the group as "Recover on your own" describes. |
| `guard` | Notes only: a lowered cap after repeated escapes and an escape whose zone change failed. The escape is one of the bot's holds, so the bot starts AutoLevel again after it. Escapes from wanderers alone never alert: judge the zone by its measured XP per hour, which `analyze.mjs` reports with the escapes and their cost. An escape re-enters the zone at its safe spot, and a second escape within the guard's `loopSec` leaves for another zone of the rotation, because a mob camping the safe spot would start the same fight again. |
| `rotate` | The bot moved to the next zone in `rotation`, because the current one ran out of reachable enemies, its XP per hour of play over the last 10 minutes fell under 60% of the visit's best, or `rotateEscapes` guard escapes happened there in 10 minutes. Minutes signed out, held, travelling or on a task are not play, so a party that just came back keeps its zone. A party that spends `outsideRotationSec` in a zone outside `rotation`, such as a home city, the bind point after a respawn or a zone the coordinator took out of the rotation, moves to its first zone. A failed move backs off from 30 s, doubling, and only the third failure in a row wakes a script, because a slow server times moves out and a later try goes through. The coordinator sets `rotation` from the band rows and the measured rates ([collector.md](collector.md#coordinator)), so a zone that falls short leaves the rotation by itself, and a row needs a change only to add a zone. |
| `errand` | An errand ended without its item: the party left the zone, the guard escaped repeatedly or the zone stayed crowded. AutoLevel's limits come back and the rotation rules take over by themselves, and the coordinator decides at its next pass whether to send the group again, so the item only informs. |
| `memory` | The page's JS heap passed 80% of its limit (`memoryAlertShare`). The page supervisor gives a tab a new process when its heap stays over `heapShare` of its limit for ten minutes, at a moment without a task or a fight, one page at a time, and signs it in again (`tools/lib/page.mjs`). The item asks for a person when it is still open after the time that takes (`RELOAD_MS` in `tools/lib/attention.mjs`), and closes once the heap is under that share. A collector that is restarted more often than every ten minutes never gathers the readings for it. |

## Inventory and the game UI

- Bag 0 slots 22-29 are the general slots and slot 30 is the cursor. Bag N is the container in general slot N-1. A bag held on the cursor takes all its slots out of play and blocks looting.
- Left-click picks an item up onto the cursor and right-click opens a bag. After any UI work, check that `iq.bagSpace().cursor` is null and close windows with `iq.clearWindows()`.
- Selling needs no merchant. The bot uses the client's own sale call, and the Sell Item button sells the cursor item.
- The bot holds a bag reserve (`keepReserve`, `docs/plans/inventory.md`). Below `minFreeSlots` free slots between fights it runs the game's Auto Bank (at most every ten minutes), then destroys surplus the client cannot sell (no price, NO DROP or NO RENT), then sells surplus cheapest first, until `targetFreeSlots` are free. Surplus is every copy beyond demand: the tab's share of the account's `demand` from the coordinator (`docs/plans/items.md`) up to its count, the gear plan's `gearKeepInstances` and the reagents of the leader's class spells in every copy, and food and drink up to `keepSupply` units of each type from the largest stacks. The server's Auto-Sell and Delete Clutter stay off. `iqBot.fates()` lists each carried item's fate. When kept items alone break the reserve, a `bags` alert lists them.

## Experiments

- Tag every configuration change with `setLabel` and compare labels with `tools/analyze.mjs` ([tools.md](tools.md#measuring-play)). Record the label, window, result and decision in the diary.

## Screenshots

Game tabs run with rendering off (Options, Graphics, Disable Rendering), which pauses 3D drawing while AutoLevel keeps running, and the bot keeps that setting as one of its client options. For a screenshot of the world, such as a raid kill, call `iqBot.render(seconds)` in that tab, which draws the world for that long.

## After a client update

The bot raises a wake alert `clientUpdate` when the page runs a different client release than the one this tab or browser saw last, when the client lacks something the SDK uses, and when the site serves a release newer than the page runs (checked every `releaseProbeMin` minutes). `iq.release` names the running client and `iq.missingApi` lists the missing parts. The collector saves and checks each new release by itself (`checkRelease` in `tools/iqd.mjs`) and raises an item only for what the release lacks. By hand:

1. `bun tools/client-snapshot.mjs` saves the live client to `.re/releases/<release>/` and prints
   the release id. A release that is saved already is skipped.
2. `bun tools/check-client.mjs [release dir]` runs the bridge's discovery on the saved bundles
   and prints PASS or FAIL for every store, action, state key, dispatcher and client function the
   SDK and the bot use, and for the anchor of every shim (`SHIMS` in `src/bridge.js`). It exits
   with 1 on a FAIL. Fix each FAIL in `CLIENT_SURFACE` or `SHIMS` before attaching. A NOTE says
   that a shim's defect is no longer in the release: delete the shim once its count in
   `iq.shimCounts` stays at zero on that release.
3. `bun tools/client-snapshot.mjs --diff <old> <new>` lists what changed by names that survive
   minification: text and message templates, enum members such as option ids, action names, zone
   names and renamed bundles. Arguments are release ids or directories.
4. After `git pull` in the content repository, `bun tools/content-diff.mjs` lists the zones, NPC
   types and spawns that changed and flags zones that enter the top 3 of a level band.
5. `.re/` holds the saved releases and is not committed. Regenerate the opcode table with `bun tools/extract-opcodes.ts <release dir>/pretty/<entry>.js data/opcodes.json` and the leaders' spell table with `bun tools/class-spells.mjs`, which loads the client's bundles under a DOM shim.
