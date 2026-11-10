# Items: demand derived from the game's data, one fate, the right place

## Decision

The coordinator owns the account's demand for items: how many copies of each item the account needs and which character or store each copy belongs to. Demand comes from models of the game's own data, never from hand lists of names. Every item the account gains, from any loot channel, trade or cursor, gets one fate in the bot: kept while demand for it remains, moved to where it belongs, sold when the client can sell it, destroyed otherwise.

## Why

- Item rules live in nine lists in two places. The bot keeps `keepNames` (opportunity items and the open chains of `data/quests.json`), `keepItemIds`, `keepItemIdRange` (casino potions), `questItemIds`, `gearKeepCounts`, `gearKeepInstances`, the reagents of the leader's spells and a food supply. The bridge keeps `data/quest-items.json` out of the sale it makes after a trade. A held item has four separate handlers: the bot's cursor watch, the bridge's trade cleanup, its gives and the raid loot step.
- Hand-kept copies of the epic chains drifted apart. `docs/plans/epics.md` names Kedge Backbone, Blue Crystal Staff and Staff of Elemental Mastery: Water as epic pieces, `data/quests.json` and `data/opportunities.json` do not, and after the first Phinigel raid the reserve rated all three discards.
- A category is no substitute for demand. Keeping every item some quest takes also keeps Battle Plans and Werebat Wings, the NO DROP drops that filled the bags on Nov 9.
- Kept items stay in the leader's bags, the loot buffer. At Lady Vox the leader had no free slot.

## Principles

1. Demand is derived. The hand-written facts are each class's epic reward (`data/epics.json`) and the runnable chain steps of `data/quests.json`, which the quest graph checks. The quest graph, the gear plan, the casino table and the hand-in rewards follow from the content snapshot and the client.
2. An item's fate is its most valuable use: equip, chain input, boss summon, hand-in reward, sale, or none.
3. The leader's bags are a buffer. A kept copy moves to the character who uses it, or to storage while that character cannot take it yet.
4. Every loot channel and every held item goes through the same fate.
5. The bridge offers primitives. Decisions are the bot's for its tab and the coordinator's for the account.
6. The bag reserve keeps its property ([inventory](inventory.md)): `minFreeSlots` free between fights, by Auto Bank, then discards, then sales.

## Design

### Quest graph (`tools/lib/quest-graph.mjs`)

Edges read from the content snapshot:

- Hand-in: an NPC script's `check_turn_in` or `eq.handin` branch, its inputs with counts, and what the branch gives (`SummonItem`, the items and XP of `QuestReward` in either form). A branch that spawns an NPC (`eq.spawn2`, `eq.unique_spawn`) also gives that NPC's loot, which carries the chains whose reward drops from a summoned enemy.
- Talk: an item an NPC gives in dialogue, and the loot of an NPC its dialogue spawns.
- Combine: a tradeskill recipe's components and carried container into its product.
- Spell: a scroll and the components a cast consumes into the item the spell summons, as Summon Orb gives the Orb of Mastery.

An item that no edge produces is a leaf: a drop, a merchant item or a ground spawn, whose sources the gear model already finds. A chain's demand is every input on the paths back from its epic reward. The walk stops at an item a merchant sells, which is bought at its step rather than carried. Two hand-ins that give the same item both count until one is chosen. A scene that a script runs on signals, such as the one that ends in Shmendrik Lavawalker's death, is no edge, so the runnable steps of `data/quests.json` cover those chains, and `bun tools/quest-graph.mjs` lists every chain item the graph does not reach.

### Demand (coordinator)

`demand[itemId]` is the copies the account needs: the gear plan's copies, one epic reward per class member and one chain input per member still without the epic (`chainDemand`), one copy of a runnable chain's items per member still on it (`stepDemand`), one of each boss potion (the client's casino table) and the hand-in items whose reward pays (lightstones today). It replaces `keepNames`, `keepItemIds`, `keepItemIdRange`, `questItemIds`, `gearKeepCounts` and `data/quest-items.json`. Each tab gets its share: the copies its characters carry that the account still needs, and the instances its planned moves take. Until step 2 every tab gets the account's whole count, which keeps at most a few copies too many.

### Fate (bot)

`fates()` keeps a copy while the tab's demand for that item remains, plus the reagents of the leader's spells and the food supply, both of which depend on the tab's own character. It sells the rest when the client can and destroys what is left. One held-item routine places a cursor item, gives it to the character it belongs to or to a party member when the leader cannot hold it, or sells or destroys it by its fate. Loot, trades, gives, crafts and the raid loot step all call it.

### Place (item task)

The gear task becomes the item task. It moves gear to be worn, and kept copies to the character who uses them or to storage. While raid mode is on, raid loot goes from the RAID LOOT tab straight to its recipient with the tab's Give Item and Equip Item.

### Value

Hand-in rewards (XP, coin and items, read from the scripts) value the items a quest takes. Gear is also valued for raids, from the raid simulator, which runs the client's own code for clicks, procs, focus effects and resists that the leveling score leaves out.

## Migration

| Step | Change | Removes | Status |
| --- | --- | --- | --- |
| 1 | Quest graph, `data/epics.json`, chain and step demand, the casino table read from the client, all in one `demand` map. | `questItemIds`, `keepItemIdRange`, `gearKeepCounts`, `setGearKeepInPage`, `questKeepItems` and the chain part of `keepNames` | Done |
| 2 | Each tab's share of the demand, by the copies the account holds elsewhere. | `keepNames`, `keepItemIds`, `data/quest-items.json` and `tools/quest-items.mjs` | Open |
| 3 | One held-item routine in the bot, loot primitives in the bridge, raid loot given in the raid window. | The cursor handling of `clearCursorAfterTrade`, `collectLoot` and `giveItem` | Open |
| 4 | The item task delivers kept copies and stores them. | Kept copies in the leader's bags | Open |
| 5 | Hand-in reward values. | Hand-picked hand-ins such as lightstones | Open |
| 6 | Raid value in the gear score. | | Open |

## Checks

- Every step of `data/quests.json` is an edge of the quest graph, and every bracketed item id in the class tables of `docs/plans/epics.md` lies in its class's closure.
- Tests: `fates()` keeps copies up to demand and no more, and the held-item routine never sells or destroys a copy demand wants.
- Live: after each step, every leader at `minFreeSlots` or more within a cycle, no wanted item sold or destroyed, and the discard log naming only items without demand.
