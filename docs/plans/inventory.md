# Inventory: one owner, demand-bounded keeping, a reserve that holds

## Decision

Unwanted items without a merchant price leave the bags by the bot's own discard, by the account's demand lists, as soon as the reserve runs low. NO DROP and NO RENT items cannot be sold (`OST` 16077-16081), so an unwanted one can only be stored or destroyed, and storing only delays full bags. The server's Delete Clutter, which destroyed them until Nov 9 07:48 but only once the bags were already full, stays off.

## Why the bags fill

Loot lands only in the leader's bags. When they are full the drop stays on the corpse and a hunt fails at "make room". At 18:00 on Nov 9 Kimorili and Higraesir had 0 free slots and Tagujazolu 2, and the cleanup found nothing it could sell in any of them.

The 9,256 items looted in the six hours to 18:00, about 129 per group-hour:

| Class | Share | Way out today |
| --- | ---: | --- |
| Has a merchant price, nobody wants it | 91% | the bot sells it |
| Wanted by the account | 4% | none: kept in every copy |
| No price, nobody wants it | 5% | none since 07:48 |

The unwanted items without a price are NO DROP quest drops (Battle Plans, Werebat Wings, Small Gears, Ghoul's Hearts), NO RENT torches and keys. Kimorili's 62 slots held 51 such items. At 07:48 the bot exempted LORE and quest items from the server cleanup to save Giant Wood Spider Femurs, which no chain uses, and since then they stay: about six per group-hour.

The wanted class is nearly all the gear plan's, which keeps every copy of every item that is an upgrade for anyone: 29 Split Paw Hide Gloves, 27 Split Paw Hide Masks and 23 Small Bronze Helms in six hours. Nothing bounds those copies, so a last-resort tier sells them again when two slots are left.

Twelve fixes since Nov 9 03:19 each adjusted one rule: Auto-Sell off, a protected bag for kept items without a price, quest and effect items sold at two free slots, LORE cleanup off, gear items sold at two free slots. Each answered one symptom, and none stated the property they serve.

## Principles

1. The property is a reserve: between fights the leader's bags keep at least `minFreeSlots` free, so a drop always fits. Every rule below serves it, and an alert fires only when it cannot hold.
2. One owner. The bot decides each item's fate. The server's Auto-Sell and Delete Clutter act only on full bags, too late for the drop, and by rules that do not know what the account needs. With both off, no item's fate depends on the bag it lies in.
3. Kept by demand, not by category. An item stays because someone needs that many copies: the gear plan's copies still missing on the account, the items a hunt, errand or quest chain is for, the reagents of the leader's spells, lightstones. Categories such as quest item, has an effect or research page say nothing about demand.
4. Every class has a way out, cheapest loss first: the tradeskill and spell banks (nothing lost), selling (coin), discarding unwanted items without a price (nothing lost), delivery to the character an item is for.
5. Wanted items that alone break the reserve are the one case that needs a decision, so that raises one alert listing them. Nothing sells or discards a wanted item to make room.

## Design

Bot (`src/bot.js`):
- `fate(row)` returns keep, sell or discard. Copies of an item up to its demand are kept. Copies beyond it are sold when the client can sell them (a price, not NO DROP, not NO RENT) and discarded otherwise. Containers and equipped items are outside it.
- Demand: `gearKeep` (item id to copies, from the coordinator), `keepNames` (every copy, from the coordinator), `keepItemIds` (every copy), the reagents of the leader's class spells (every copy), and one stack each of food and drink.
- `keepReserve()` runs each tick out of combat and before a task that needs room. Below `minFreeSlots` it runs Auto Bank (at most every ten minutes), then sells surplus cheapest first, then discards surplus, until `targetFreeSlots` are free. If wanted items alone leave less, it raises the alert of principle 5.
- Client options held: Auto-Sell off and Delete Clutter off.
- Removed: `keepBag` and its No Sell and No Declutter marks, the single and last-resort sale tiers, `keepCopies`, `keepNamePattern`, the effect, food and quest-item exceptions, and the rule that a No Sell bag's contents count as kept.

Coordinator (`tools/lib/gear-plan.mjs`, `tools/iqd.mjs`):
- The gear plan's `wanted` list becomes counts per tab: the copies a tab's characters hold that this pass's moves take, the copies still needed for upgrades left after the moves, and the copies of rotation drops the account is still missing. An item whose demand the account already holds is surplus on the next pass.

## Checks

- Tests: `fate` keeps copies up to demand and never sells or discards a wanted copy, sells before it discards, and keeps the reserve order. The gear plan counts copies beyond demand as surplus.
- Live: every leader at `minFreeSlots` or more within a cycle of the deploy, no `lootFull` alert and no hunt failing at "make room" for a day, and the discard log naming only unwanted items.
