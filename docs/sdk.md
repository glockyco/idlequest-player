# Scripting a game tab

The SDK in `src/client.mjs` drives one game tab from a script: it installs the bridge and the bot in the page and calls them. The account plays without it. Use it for work by hand, for experiments and for bringing up a group. [runbook.md](runbook.md) has the rules for acting in a tab the bot keeps.

## Attach

`attach` takes a browser tab that supports `evaluate`, `click`, `clickAt`, `fill` and `waitForSelector`, such as an omp `browser` tab opened through the relay. Adopt a game tab without navigating it, because a navigation signs the game out.

```js
const tab = await browser.open({ name: "iq", app: { relay: true, target: "idlequest.net/play" } });
const { attach } = await import("./src/client.mjs");
const iq = await attach(tab);
console.log(await iq.status());
```

A script's browser reaches one game tab by its address. To act in a named group's tab, use `bun tools/iqd.mjs page` ([collector.md](collector.md)). `attach` installs the bridge and the bot of the deployed commit, as the collector does ([README](../README.md#deploying-page-code)).

## Common calls

```js
const party = await iq.roster();                    // every character: class, level, HP, mana, gear
await iq.setTactic("Edroun", "nuke", false);       // stop a member nuking (also the active character, or "cleric", "warrior", "rogue")
await iq.startAutoLevel({ minCon: 10, maxCon: 15, maxLevelDiff: 2 });  // con values: 2 green, 4 blue, 10 white, 15 yellow, 13 red
await iq.pausedAutoLevel(() => iq.travelTo("gfaydark"));  // pause, teleport, restart if it was running
await iq.setLeader("Tagujazolu");                  // lead the group with another member for good; the bot switches and regroups
await iq.switchCharacter("Edroun");                // play another character for a while; the bot switches back when its pause ends
await iq.handIn({ members: [{ name: "Edroun", counts: { "Greater Lightstone": 2 } }] });  // the bot's task: each member hands in at Smith Tv`ysa, then back to the leader
await iq.quest({ members: ["Tagujazolu"], steps: quests["warrior-epic-1"].steps });  // quest steps from data/quests.json for each member, as the active character
await iq.hunt({ zone: "mistmoore", keep: "gypsy dancer", item: "Power of Wind", waitMin: 3 });  // gray drops through Enemy Targets
await iq.raidTime();                                // price of a raid hour in platinum, expiry (read only)
await iq.dailyBosses();                             // the zone's daily raid bosses and resets, from level 46
await iq.raid({ members: ["Domeyafun", "Edroun"], target: "Nagafen", zone: "soldungb", maxPp: 2500 });  // the bot's raid task: one fight, then back to leveling
```

## Spells

Merchant spells are bought automatically when the game's missing-spells reminder appears. This
runs inside the page whether or not AutoLevel is active. To trigger it manually or disable it:

```js
await iq.buySpells();
await iq.setChores({ autoBuySpells: false });
```

## Watching one tab

Unattended play: the bot checks every 15 seconds. `watch` waits until it raises an alert that
needs attention, or until the time is up, and returns a compact report. To play by hand, pause the
bot first, because it starts AutoLevel again a minute after it stops.

```js
const r = await iq.watch({ minutes: 50, sinceSeq: 0, exportDir: "runs/my-run" });
await iq.pauseBot(30, "playing by hand");   // AutoLevel may stay off for 30 minutes
await iq.setBot({ minFreeSlots: 10, targetFreeSlots: 16 });  // settings persist in this tab across reloads
```

## Long work

Long work belongs in the page: start it there, keep its progress on `window`, and poll it with short `tab.evaluate` calls. The bridge's `iq.job(name, ...args)` runs its NPC and item actions that way, and the bot runs multi-step work as tasks. An omp browser tab fails a call that runs about 30 seconds or longer.

Use `pausedAutoLevel` for travel or other actions that need AutoLevel stopped. If it was running, it restarts with the saved con and level limits. `travelTo` waits for the current fight to end, then sends the Travel window's zone change, which teleports at once. The bot's pause is renewed while the work runs. If the script dies, the pause runs out within two minutes and the bot restores the leader, the party, the zone and AutoLevel.

Recording a run and comparing settings by label is described in [tools.md](tools.md#measuring-play).

## Bringing up a group

`createGroup` and `restoreGroup` in `src/group.mjs` open a tab for one group of `data/roster.json` ([README](../README.md#setup), steps 5 and 6).

`createGroup` takes a `planned` entry, whose first class leads. It opens the tab `iq-<id>`, signs in from the login files, creates the six characters with the race that has the best creation stats for each class, kits each one in Rivervale (starter weapon, packed general slots, a Backpack in every free general slot, with coin from the account's richest character outside the first group), and starts AutoLevel in the zone of the level 1 band. It has only run on an account that had coin, so on a new account expect the first group to buy fewer bags.

It writes the names to the roster file as soon as they exist. When it stops before all six exist, the roster keeps the created ones under `members` and the others under `planned`, and a second call creates the rest. When it stops after that, the group has `members` only: bring it up with `restoreGroup`, which starts it without the kit.

`restoreGroup` takes a group with `members`. It opens a new tab, signs in, gives the bot the group's leader and members, restores the rotation for the leader's level and starts AutoLevel. The new session takes over from an old one of the same leader, so close the old tab afterwards.

A new tab opens visible, because a hidden tab never finishes loading the game engine. Check the machine's free memory before each group.

## Troubleshooting

- `bridge: could not find ...` when attaching: the client no longer has a store with the state keys `CLIENT_SURFACE` in `src/bridge.js` looks for. Find the new keys in the prettified client and update the entry there. `iq.missingApi` lists parts of that surface the SDK calls and the client no longer has ([runbook.md](runbook.md#after-a-client-update)).
- `opcode table not loaded`: the bridge was evaluated without `attach`. Call `attach(tab)`, which loads `data/opcodes.json`.
- `client function ... not found` in `iqBot.report().recent` (as `tick failed`), or `fn.<name>` in `iq.missingApi`: the bridge finds the client's sale, Auto Bank, auto-place, zone change and hail calls by pieces of their source (`FUNCTIONS` in `CLIENT_SURFACE`), and a release changed them.
- AutoLevel stays off: `iq.botReport()` shows `paused` with a reason and an end time, and `enabled`. `iq.resumeBot()` ends a pause and `iq.setBot({ enabled: true })` turns the bot back on.
- `watch` or `evaluate` throws or never returns: the tab is gone or its renderer crashed, and the bot went with it. Bring the group back with `restoreGroup`.
- `travelTo` fails with `no such zone`: pass the zone's short name (`misty`) or its long name as the game spells it. AutoLevel must be stopped first (use `pausedAutoLevel`).
- An item stays on the cursor: `iq.bagSpace().cursor` names it, and looting and cleanup stop until it is placed. After three minutes the bot settles it (`settleHeld` in `src/bot.js`, the routine every trade, give, craft and raid loot step also uses).
