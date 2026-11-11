# Boss kills

How the coordinator decides which bosses and named enemies the account kills, how, and when. A boss kill is one more way to get gear and quest pieces, valued in the currency of [gear acquisition](gear-acquisition.md), hours of a group's progress, so it compares with hunting, camps and visits.

## Problem

- The daily list's two free summons went unused every day until 2026-11-10, and the raids since were started by hand. A casino potion waits for a hand too, and the bot had no way to use one.
- The bosses also spawn in the open world, and nothing hunts them there.

## What is known, and how

Verified in the game or in the client's code:

- A group of six kills some bosses without raid mode: group 1 at levels 51 and 52 killed the open-world Lady Vox at 20:52 on 2026-11-10 in normal play, and Tagujazolu gained 88,539 XP (G1's game log).
- Raid kills pay the leader XP: Phinigel Autropos 390,451 per kill, Lady Vox 435,600 (G1's game log).
- A daily summon makes a private copy. The client's panel: "Two free resets per account every rolling 24 hours, with one kill per boss. Resuming a boss or retrying a wipe is free. Casino potions do not use resets. Private bosses last 24 hours; nearby enemies remain shared."
- An open-world kill sets the boss's daily cooldown too: after the 20:52 kill the daily list showed Lady Vox on cooldown until 20:52 the next day.
- Raid recruits fought while their own groups kept playing them (the raids of 2026-11-10).
- Raid time is bought by the hour, quoted at 8,000 pp with the highest character at 52 (`iq.raid.time()`).
- A casino potion is used with the client's consume function (`ds` in `Bip1bGL8.js`), which sends `casinoPotion: true`. The client's casino table names each boss's zone and spawn point.

From the server's content tables, not yet checked live: open-world respawn times of about 12 h for Phinigel Autropos and Lodizal, 72 h for Lady Vox, Lord Nagafen, Venril Sathir, Trakanon and Lord Yelinak, 168 h for Vulak`Aerr, spawn chance 0 for the four Warders, and no open-world spawn for Tunare and the Avatar of War. The first visit to each zone reads its live spawn list and replaces these.

## Design

### Sources and ways

A boss kill has a source and a way. Sources: the open-world spawn on its respawn timer (shared with other players), a private copy from a free daily summon (two a day) or from a casino potion (its holder's). Ways: the boss's zone visited by one group in normal play, or a raid of all 72 characters in raid mode, which needs raid time. Each pair is a candidate, and the coordinator takes the cheapest way that kills.

### Kill chance

The raid simulator fights each candidate with the surveyed characters: the group's six for a group kill, all 72 for a raid. A background job refreshes the results after each gear survey and keeps them in the db meta key `raidOdds`, so a decision never waits for a fight. A candidate counts as killable when every simulated fight kills it. The first live kill of each kind checks the simulator, as group 1's Lady Vox did for a group of six. A live wipe holds the candidate until the next survey changes the roster, and the fight's trace names the cause.

### Value and cost

A kill is worth the XP it pays and the items of its loot table at their drop chances: each copy the account's demand still needs (`docs/plans/items.md`) and each gear upgrade at its `copyValue`. A group kill costs the group's trip and fight time against its hunting. A raid costs the leading group's time and its share of the raid hour, which covers every raid kill in it.

### Schedule

- Open-world spawns: a boss whose respawn has passed gets a visit, a group's when a group kills it, else a raid. The spawn list on arrival says whether it is up.
- Free summons: used every day on the killable bosses of most value whose cooldown has passed, because an unused summon is lost.
- Potions: used in a raid by their holders.
- Raids run as soon as one is due, the most valuable first: a free summon comes back 24 hours after its use, so waiting for the second shifts the first, and the account's platinum far outruns the raid time it buys.

## Migration

| Step | Change | Status |
| --- | --- | --- |
| 1 | Kill chances from the simulator in the background (`tools/kill-odds.mjs`, `runs/state/kill-odds.json`), for the raid and every group, shared with gear acquisition. | Built, hourly refresh live at the next iqd restart |
| 2 | Potion use in the bridge (the client's consume function) and potion raids in the bot's raid task. | Built, live at the first potion raid |
| 3 | Boss candidates in the coordinator's boss pass (`tools/lib/boss-plan.mjs`): free summons and potions by raid, each as soon as it is due. Open-world spawns follow with their live spawn lists. | Built for summons and potions, live at the next reset |
| 4 | Loot values rank the candidates (`bossValues`: each wanted drop of the gear pass's target for the boss at its chance, the best copy per taker's slot). A kill's XP stays out, since summons and potions are time gated and their drops come from nowhere else. | Built |
| 5 | Named enemies above a group's reach as gear targets with a raid way in `tools/lib/acquire.mjs`. | Open |

## Checks

- Tests: the planner's boundaries (free summons left, a boss's cooldown, unkillable odds, group before raid, the order by value, the potion holder leading).
- Live: at the next reset of the free summons the coordinator kills the best daily bosses and the held potion's boss without a hand, and the loot reaches the bags.
