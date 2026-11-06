# idlequest-player

Tools for playing [IdleQuest](https://idlequest.net/play), a browser recreation of classic EverQuest
with an AutoLevel mode, and a diary of the character played with them.

## How it works

The game simulates combat, AutoLevel and party tactics inside the browser client. The server holds
the account, inventory and zone state. A standalone program that talks to the server directly would
have to reimplement the combat engine, so this project drives the real client instead:

- `src/bridge.js` is evaluated inside the game page. It finds the client's state stores and its
  server socket and exposes them as `window.iq`.
- `src/client.mjs` injects the bridge into a browser tab and calls it from a script.

Protocol and client internals: [docs/client-internals.md](docs/client-internals.md).

## Setup

1. Open https://idlequest.net/play in Chrome and sign in.
2. Attach a tab object that has `evaluate`, `click` and `type`, for example one from omp's `browser`
   tool with the relay enabled, then:

```js
import { attach } from "./src/client.mjs";
const iq = await attach(tab);
console.log(await iq.status());
```

## Common tasks

```js
const party = await iq.roster();                    // every character: class, level, HP, mana, gear
await iq.setTactic("Edroun", "nuke", false);       // stop a member nuking (also "cleric", "warrior", "rogue")
await iq.startAutoLevel({ minCon: 10, maxCon: 15, maxLevelDiff: 2 });
await iq.pausedAutoLevel(() => iq.travelTo("Greater Faydark"));  // pause, run, always restart
```

Hunting grounds: `scoutZones` saves each zone's spawn list once, and `tools/zones.mjs` ranks zones
for any level by target density and by how many targets have a much stronger monster beside them.

```js
await iq.pausedAutoLevel(() => iq.scoutZones(["Toxxulia Forest", "Crushbone"], "runs/zones"));
```

```sh
bun tools/zones.mjs runs/zones --level 5
```

Where does an item drop? `tools/drops.mjs` joins the developer's public content snapshot (loot
tables, spawn groups, spawn points). Clone it once, then ask. Chances are approximate.

```sh
git clone --depth 1 https://github.com/brynnb/idlequest-content ~/src/github.com/brynnb/idlequest-content   # about 1 GB
bun tools/drops.mjs item "Crushbone Belt"        # NPC, zone, drop chance, spawn chance, respawn, rare
bun tools/drops.mjs npc "orc centurion"          # what an NPC can drop
```

Scouting without stopping AutoLevel: `tools/zone-snapshots.mjs` builds the same zone files offline
from the content snapshot (one most-likely NPC per spawn point). It matched live scouts to within
about 5% for Blackburrow, the Qeynos Aqueduct and Greater Faydark, and is 40% high for Toxxulia,
so check a zone live before committing to it. `tools/zones.mjs` skips zones the game does not have
(`data/idlequest-zones.json`, from the wiki, with each zone's XP multiplier).

```sh
bun tools/zone-snapshots.mjs runs/zones-content "."          # all zones, about 10 seconds
bun tools/zones.mjs runs/zones-content --level 15
```

Gear: `tools/gear.mjs` lists the best usable item per slot for a class and level and where it drops.
The score is a rough stat value with the weights documented in the file, not a simulation.

```sh
bun tools/gear.mjs magician --level 20 --slot head --top 3
```

## Measuring efficiency

The bridge records one sample per second (level, XP, position, combat state, every party member's
HP and mana, the active experiment label) and every chat line with the game's own timestamp.

```js
await iq.setLabel("B-some-change");   // tag the samples that follow
await iq.exportRun("runs/my-run");    // append new rows to runs/my-run/*.jsonl, resumable
```

```sh
bun tools/analyze.mjs runs/my-run --label B-some-change
```

The analyzer puts every second outside combat into exactly one cell: moving, recovering (standing
still while someone is below full HP or mana) or ready-idle, and names the party member that fills
last. Compare configurations by label, with similar level and enemy mix, and never on one block.

- Check that a setting took effect in the event log before trusting a comparison. A tactic written
  under the wrong key is stored and silently ignored.
- Read position from the client's position packets. The character profile's `x`/`y` only updates on
  zone entry.
- Validate any new indicator against the game's messages before building on it.

## Rules for contributors

- Never assign to `socket.onJson` or another callback slot on the game's objects. The client's own
  packet dispatch lives there, and replacing it leaves the world stuck on the loading screen.
  Tee traffic by wrapping instance methods, as `src/bridge.js` does.
- Avoid reloading or navigating the game tab while signed in. The page keeps no credentials in
  cookies, localStorage or IndexedDB, so a lost session means signing in again.
- `.re/` holds downloaded copies of the game client for reverse engineering and is not committed.
  Regenerate `data/opcodes.json` with `tools/extract-opcodes.ts` after a client release.
- Run anything that needs the party standing still inside `pausedAutoLevel`. A pause left in place
  leaves every character idle.
- `tab.evaluate` calls time out after 30 seconds. Start long work in the page, keep its progress on
  `window`, and poll it with short calls.
- Never call `warpPlayerToCombatEntity` or `teleportPlayerToEQPosition`. They are debug functions
  that a player cannot use.

## Diary

[diary/](diary/) has one entry per session, with screenshots in `diary/media/`.
