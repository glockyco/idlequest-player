# idlequest-player

Tools for playing [IdleQuest](https://idlequest.net/play), a browser recreation of classic EverQuest
with an AutoLevel mode, and a diary of the character played with them.

## How it works

The game simulates combat, AutoLevel and party tactics inside the browser client. The server holds
the account, inventory and zone state. A standalone program that talks to the server directly would
have to reimplement the combat engine, so this project drives the real client instead:

- `src/bridge.js` is evaluated inside the game page. It finds the client's state stores and its
  server socket and exposes them as `window.iq`.
- `src/bot.js` runs inside the page next to the bridge as `window.iqBot`. It keeps AutoLevel
  running, banks ingredients and sells cheap loot before the bags fill and raises alerts, with or
  without a script attached.
- `src/client.mjs` injects both into a browser tab and calls them from a script.

Agents that play the account follow [AGENTS.md](AGENTS.md).

Protocol and client internals: [docs/client-internals.md](docs/client-internals.md).

## Setup

1. Open https://idlequest.net/play in Chrome and sign in.
2. Attach a browser tab that supports `evaluate`, `click`, `clickAt`, `fill`, `type` and
   `waitForSelector`, for example an omp `browser` tab with the relay enabled.

```js
import { attach } from "./src/client.mjs";
const iq = await attach(tab);
console.log(await iq.status());
```

## Common tasks

```js
const party = await iq.roster();                    // every character: class, level, HP, mana, gear
await iq.setTactic("Edroun", "nuke", false);       // stop a member nuking (also the active character, or "cleric", "warrior", "rogue")
await iq.startAutoLevel({ minCon: 10, maxCon: 15, maxLevelDiff: 2 });
await iq.pausedAutoLevel(() => iq.travelTo("Greater Faydark"));  // pause, run, always restart
```

Merchant spells are bought automatically when the game reports that spells are missing. This runs
inside the page while AutoLevel is active. To trigger it manually or disable it:

```js
await iq.buySpells();
await tab.evaluate(() => window.iq.setChores({ autoBuySpells: false }));
```

Unattended play: the bot checks every 15 seconds. `watch` waits until it raises an alert that
needs attention, or until the time is up, and returns a compact report. To play by hand, pause the
bot first, because it starts AutoLevel again two minutes after it stops.

```js
const r = await iq.watch({ minutes: 50, sinceSeq: 0, exportDir: "runs/my-run" });
await iq.pauseBot(30, "playing by hand");   // AutoLevel may stay off for 30 minutes
await iq.setBot({ minFreeSlots: 10, keepItemIds: [10015, 13077] });  // settings persist in the browser
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

Gear: `tools/gear.mjs` lists the best usable item per slot for a class, race and level, with the
mobs that drop it and the merchants that sell it. Armor is ranked by a rough stat score with the
weights documented in the file. Weapons are ranked by base damage capped at the level's limit,
divided by delay, the comparison the IdleQuest wiki gives.

```sh
bun tools/gear.mjs warrior --level 21 --race dwarf --slot primary --top 5
```

## Predicting XP per hour

`tools/predict.mjs` estimates XP per hour per character for every zone at a party level, from the content snapshot (clone it as above) and the client's own hit, mitigation and resist formulas. It runs in about a second.

```sh
bun tools/predict.mjs --level 25 --top 15            # ranked table: kill, recovery and walk seconds, kills/h, XP/h, danger flags
bun tools/predict.mjs --level 25 --zone permafrost   # per-NPC breakdown of one zone
bun tools/predict.mjs --check                        # the model against the two measured runs, with residuals
```

Flags: `--min-diff` and `--max-diff` (levels relative to the leader, default -3 and 5, and never green by AutoLevel's con rule), `--dps` and `--dps-level` (party damage per second against a same-level enemy and the leader level it was measured at), `--dps-exp`, `--spell-share`, `--overhead`, `--mana-per-sec`, `--tank-hp`, `--tank-ac`, `--healer-mana-pool`, `--caster-mana-pool`, `--speed`, `--stay` (minutes in the zone, which spreads the initial stock of enemies) and `--party-levels` (a comma list, default six equal levels). The header of the file explains each step. `--fit` refits `--dps`, `--overhead` and `--mana-per-sec` to the two runs.

The model includes the spawn table with spawn chances and respawn times, enemy HP, damage, special abilities and resists, the party's hit chance and resist penalty by level difference, the tank's damage taken, recovery from mana and HP at 2.5% per 0.6 s, walking between candidate spawn points, and a spawn-rate cap per zone. It leaves out wandering and named spawns beyond their chance, enemy spells, enrage and rampage timing (a fixed extra damage instead), crowd control, pets as separate damage dealers, other players taking spawns, content flags and spawn conditions, the trip to the zone and loot. Walking is the distance to the nearest candidate point, which is shorter than the 64 units per kill measured in Permafrost, so the overhead absorbs the difference. How damage grows with the leader's level (`--dps-exp`) is not identified by two runs at levels 21 and 24, so predictions far from level 24 depend on it. Read the table as a ranking, and check a zone live before committing to it.

Calibration, from the 2026-11-07 run. Permafrost at leader level 24 to 25 measured 2.91 kills per minute, 2.30M XP/h, 13,217 XP per kill, a 13 s mean kill and 64.6% of the time in combat. The City of Guk at level 21 measured 3.19 kills per minute, 1.64M XP/h and a 10.3 s median kill. The fitted values are `--dps 49` at level 24, `--overhead 2` and `--mana-per-sec 10`. `--dps-exp 0.5` is set between the 0 and 1 that bracket the best fit, and the party's pool sizes and levels come from the run's samples. Residuals, model against measured:

| Quantity | Permafrost | City of Guk |
| --- | ---: | ---: |
| XP/h per leader | +2% | +2% |
| Kills per minute | +7% | -10% |
| XP per kill | -5% | |
| Mean kill seconds | -6% | |
| Median kill seconds | -7% | +9% |
| Combat share of time | -2% | |

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

- Run `bun test` after changing `src/bot.js`. It runs the bot against a fake page, because a loop
  in the page freezes and then crashes the game tab, and the sign-in it costs needs a person.
- Never assign to `socket.onJson` or another callback slot on the game's objects. The client's own
  packet dispatch lives there, and replacing it leaves the world stuck on the loading screen.
  Tee traffic by wrapping instance methods, as `src/bridge.js` does.
- Avoid reloading or navigating the game tab while signed in. The page keeps no credentials in
  cookies, localStorage or IndexedDB, so a lost session means signing in again.
- `.re/` holds downloaded copies of the game client for reverse engineering and is not committed.
  Regenerate `data/opcodes.json` with `tools/extract-opcodes.ts` after a client release.
- Use `pausedAutoLevel` for travel or other actions that need AutoLevel stopped. If it was running,
  it restarts with the saved con and level limits. `travelTo` waits for the current fight to end
  before opening the Travel window. The bot's pause is renewed while the work runs. If the script
  dies, the pause runs out and the bot starts AutoLevel again.
- `tab.evaluate` calls time out after 30 seconds. Start long work in the page, keep its progress on
  `window`, and poll it with short calls.
- Never call `warpPlayerToCombatEntity` or `teleportPlayerToEQPosition`. They are debug functions
  that a player cannot use.

## Diary

[diary/](diary/) has one entry per session, with screenshots in `diary/media/`.
