# Items: demand derived from the game's data, one fate, the right place

## Decision

The coordinator owns the account's demand for items: how many copies of each item the account needs and which character or store each copy belongs to. Demand comes from models of the game's own data, never from hand lists of names. Every item the account gains, from any loot channel, trade or cursor, gets one fate in the bot: kept while demand for it remains, moved to where it belongs, sold when the client can sell it, destroyed otherwise.

## Why

- Item rules live in nine lists in two places. The bot keeps `keepNames` (opportunity items and the open chains of `data/quests.json`), `keepItemIds`, `keepItemIdRange` (casino potions), `questItemIds`, `gearKeepCounts`, `gearKeepInstances`, the reagents of the leader's spells and a food supply. The bridge keeps `data/quest-items.json` out of the sale it makes after a trade. A held item has four separate handlers: the bot's cursor watch, the bridge's trade cleanup, its gives and the raid loot step.
- Hand-kept copies of the epic chains drifted apart. `docs/plans/epics.md` names Kedge Backbone, Blue Crystal Staff and Staff of Elemental Mastery: Water as epic pieces, `data/quests.json` and `data/opportunities.json` do not, and after the first Phinigel raid the reserve rated all three discards.
- A category is no substitute for demand. Keeping every item some quest takes also keeps Battle Plans and Werebat Wings, the NO DROP drops that filled the bags on Nov 9.
- Kept items stay in the leader's bags, the loot buffer. At Lady Vox the leader had no free slot.

## Principles

1. Demand is derived. The hand-written facts are each class's epic reward (`data/epics.json`) and the runnable chain steps of `data/quests.json`, which the epic model's check compares with its own steps. The epic model, the gear plan, the casino table and the hand-in rewards follow from the content snapshot and the client.
2. An item's fate is its most valuable use: equip, chain input, boss summon, hand-in reward, sale, or none.
3. The leader's bags are a buffer. A kept copy moves to the character who uses it, or to storage while that character cannot take it yet.
4. Every loot channel and every held item goes through the same fate.
5. The bridge offers primitives. Decisions are the bot's for its tab and the coordinator's for the account.
6. The bag reserve keeps its property ([inventory](inventory.md)): `minFreeSlots` free between fights, by Auto Bank for what the banks take, then discards, then sales.

## Design

### Epic steps ([epic model](epic-model.md))

A class epic's demand is the items its chosen steps take (`treeNeeds` of `epicTree` in `tools/lib/epic-model.mjs`): every hand-in's inputs and the items its conditions want held, and every combine's and summoning cast's inputs, along the cheapest way to each piece the model finds in the quest scripts and the content's tables. A piece bought at its step, from a merchant or the Tradeskill Bank's catalog, is not carried, so it is no demand. The runnable steps of `data/quests.json` keep their own items (`stepDemand`), and `bun tools/epic-model.mjs --hand` lists those the model's steps do not take.

### Demand (coordinator)

`demand[itemId]` is the copies the account needs: one epic reward per class member and the items of each epic's chosen steps per member still without the epic (`chainDemand`), one copy of a runnable chain's items per member still on it (`stepDemand`), the copies the hunts and errands are for (`opportunityDemand`), one of each boss potion (the client's casino table), every copy of the items a coordinator hand-in task pays XP for (`handInDemand`, Smith Tv`ysa's lightstones) and the gear plan's copies still to acquire. Each tab gets its leader's share (`tabShares`), because the bag reserve acts on the active leader's carried items only. Copies worn or carried by others count first. Each leader then keeps the carried copies the account still needs, and every leader keeps the shortfall and the gear plan's copies, because any tab may loot the missing one. The shares come from the last gear pass's survey, so a copy looted since then can be kept twice until the next pass. The gear plan's moves add the instances they take (`gearKeepInstances`).

### Fate (bot)

`fates()` keeps a copy while the tab's demand for that item remains, plus the reagents of the leader's spells and the food supply, both of which depend on the tab's own character. It sells the rest when the client can and destroys what is left. One held-item routine places a cursor item, gives it to the character it belongs to or to a party member when the leader cannot hold it, or sells or destroys it by its fate. Loot, trades, gives, crafts and the raid loot step all call it.

### Place (item task)

Quest steps pull the pieces they need from any account character when they run (`pullOne`), so a kept copy needs no delivery to its user, only room: the bag reserve gives the demanded copies a leader carries to party members with room when nothing else can go (`storeKept`). The gear task moves gear to be worn. While raid mode is on, raid loot goes from the RAID LOOT tab straight to its recipient with the tab's Give Item and Equip Item.

### Value

Hand-in rewards (XP, coin and items) are read from the scripts. An item a hand-in pays for is kept in every copy while a coordinator task hands it in, because without the task the copies only fill bags. The XP the coordinator reports for a lightstone batch comes from the same edges.

Gear has one kit, scored raids first (`gearGain`, docs/plans/gear-acquisition.md): what an item adds to the raid's result against the hard bosses, by stat weights the raid simulator measures per role (`tools/raid-weights.mjs`), and a quarter of what it adds to its group's XP rate. One kit needs no swap around each raid. The raid simulator runs the client's own code for clicks, procs, focus effects and resists, and the weights carry only what its probes measure: HP, AC, resists, mana and attack. `tools/raid-kit.mjs` checks the kit against one boss in full fights.

## Migration

| Step | Change | Removes | Status |
| --- | --- | --- | --- |
| 1 | Quest graph, `data/epics.json`, chain and step demand, the casino table read from the client, all in one `demand` map. | `questItemIds`, `keepItemIdRange`, `gearKeepCounts`, `setGearKeepInPage`, `questKeepItems` and the chain part of `keepNames` | Done |
| 2 | The hunts' and errands' items in the demand, and each tab's share of it. | `keepNames`, `data/quest-items.json` and `tools/quest-items.mjs` | Done |
| 3 | One held-item routine in the bot (`settleHeld`), cursor and raid loot primitives in the bridge (`placeCursor`, `giveCursor`, `raid.loot`), passed to the bridge's actions as `settle`. | `clearCursorAfterTrade`, `collectLoot`'s placement, and the auto-place in `giveItem` and `craftItem` | Done |
| 4 | Kept copies stored with party members by the bag reserve, and raid loot given straight to its recipient with the raid window's Give Item and Equip Item. | Kept items alone filling a leader's bags | Under way: the store step is in, the raid recipient waits for the raid kit |
| 5 | Hand-in reward values from the scripts, for the hand-ins a coordinator task runs. | `keepItemIds`, the coordinator's hand-written `STONE_XP` | Done |
| 6 | Raid value for gear: stat weights from the raid simulator in the gear plan's gain. | Raid drops rated sell | Under way: the weights and the gain are in |

## Checks

- Every step of `data/quests.json` is an edge of the quest graph, and every bracketed item id in the class tables of `docs/plans/epics.md` lies in its class's closure.
- Tests: `fates()` keeps copies up to demand and no more, and the held-item routine never sells or destroys a copy demand wants.
- Live: after each step, every leader at `minFreeSlots` or more within a cycle, no wanted item sold or destroyed, and the discard log naming only items without demand.
