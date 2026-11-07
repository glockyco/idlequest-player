# Agent instructions

These rules are for agents that play the account with this repository. [README.md](README.md) covers setup, the SDK, the tools and how to measure efficiency. The current plan is in [docs/plans/leveling-plan.md](docs/plans/leveling-plan.md).

## Keep the game playing

- The account progresses only while AutoLevel runs in the connected game tab. End every turn with AutoLevel running unless a stop condition of the goal holds.
- Play runs unattended, so a game decision never waits for an answer here. Do not call the ask tool or open a Plannotator review for one, because a blocked session cannot react while the party keeps running into the problem. Take the reversible choice that keeps XP coming, act on it, and list it under "Decisions to review" in the diary entry with the reason. Stop and ask only for a stop condition of the goal, such as a login form, a character about to be deleted or a warning about automation.
- The bot in `src/bot.js` does the routine work inside the page and keeps running while no agent is attached. It restarts AutoLevel when it stays off without a pause, sells surplus copies before the bags fill, puts a forgotten cursor item away and raises alerts. Extend the bot instead of repeating routine work by hand.
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

## Unattended loop

Call `watch` in one eval cell with a timeout a few minutes above its `minutes`, act on what woke it, and call it again with the returned `alertSeq`. One call covers up to 55 minutes of play.

```js
const r = await iq.watch({ minutes: 50, sinceSeq: seq, exportDir: "runs/2026-11-07-live" });
```

| Alert | Response |
| --- | --- |
| `levelUp` | Take a screenshot for the diary at milestones. Check that new spells were bought, memorize better spells into Domeyafun's gems, replace a pet of an older tier, and check the plan for the new level. |
| `death` | Read the chat around it. If the guard did not leave, tighten the AutoLevel limits or change zone, and record the decision. |
| `lootFull` | Check `iq.bagSpace()` and `iqBot.surplus()` in the page, then free space or raise `minFreeSlots`. Items left on a corpse are gone after 7.5 minutes. |
| `cursor` | An item sits on the cursor. The bot puts it away after three minutes. If it cannot, free a general slot or place the item by hand until `bagSpace().cursor` is null. |
| `xpStall` | AutoLevel runs without XP. Look for a readiness loop ("Waiting for party to be ready"), a pending cure or no targets in the con range, then change limits or zone. |
| `autoLevelRestarted`, repeated | Something keeps stopping AutoLevel. Find it in the event log. |
| `offline` | The page left the game world. Never reload or navigate the tab. The client reconnects by itself, and if the login form shows, stop and ask for a sign-in. |
| `guard` | Repeated escapes tightened the limits or moved the party. Review the hunting ground. |

## Inventory and the game UI

- Bag 0 slots 22-29 are the general slots and slot 30 is the cursor. Bag N is the container in general slot N-1. A bag held on the cursor takes all its slots out of play and blocks looting.
- Left-click picks an item up onto the cursor and right-click opens a bag. After any UI work, check that `iq.bagSpace().cursor` is null and close windows with `iq.clearWindows()`.
- Selling needs no merchant. The bot uses the client's own sale call, and the Sell Item button sells the cursor item.
- The game's cleanup keeps every duplicate of protected items such as valuable gear and quest keep-list items, so its Auto Sell cannot clear them. The bot keeps one copy or stack of each item and sells the rest when space runs low. Add item ids that must never be sold to `keepItemIds` with `iq.setBot`.

## Experiments and records

- Tag every configuration change with `setLabel` and compare labels with `tools/analyze.mjs` as the README describes. Record the label, window, result and decision in the diary.
- Write one diary entry per session in `diary/` with screenshots in `diary/media/`, including one for each milestone and raid kill.
- Commit verified work in small commits whose body says why. Never push.
