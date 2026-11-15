# Coin

What the account earns, what it can spend platinum on, and what each use buys. The ledger is the collector's (`bun tools/iqd.mjs coin`, `tools/lib/coin.mjs`).

## Measured, 2026-11-13 to 2026-11-15

All groups at level 58 to 60. Platinum a day, from the tabs' event lines.

| | 2026-11-13 | 2026-11-14 |
| --- | ---: | ---: |
| Coin looted | 54,782 | 60,912 |
| Sales of surplus | 114,554 | 125,681 |
| Income | 169,336 | 186,593 |
| Raid time, 4 hours | 40,000 | 40,000 |
| Courier fees, about 1,000 visits | 19,720 | 21,140 |
| Casino | 1,800 | 1,200 |

- The account held 123,000 on 2026-11-13 around noon and 212,186 on 2026-11-15 at 08:40. So of about 326,000 earned in those 44 hours, 237,000 were spent, 130,000 of them on the lines above. The other 107,000, about 58,000 a day, went to spells at level-ups, merchant gear and quest hand-ins, which the logs of those days do not separate. The ledger does from 2026-11-15.
- The Tradeskill Bank holds 39,674 ingredients of 331 kinds, worth about 148,000 at merchants, and the Spell Bank 910 scrolls of 119 kinds, worth about 44,000. No party member of 55 read lacked a banked scroll its class can scribe at its level. The ingredients stay for tradeskill training, so the courier's fee is the price of keeping them.

## Crafting for a merchant

A merchant pays 85% of an item's price, and the crafting catalog sells components for less than that for 170 of the 741 recipes it supplies in full (`runs/tmp/profit.mjs` on 2026-11-15, from the content snapshot). Sold on 2026-11-15 with the bank window's Sell Stack: Powered Gloves at 34 platinum, Spyglasses at 16.8 and Aqualungs at 170.

- Powered Gloves (Tinkering recipe 491, trivial 122) cost 8.1 in components. A hundred attempts at Tinkering 153 gave 95 and 96 pairs, about 3,250 platinum for 820, and took about 9 s with the recipe window's x100 buy and craft. That is about 16,000 platinum a minute of one tab.
  A run of 6,000 took nine minutes and brought 194,650 for 49,212.
- A Rebreather (Tinkering recipe 492, trivial 175) sells for 680 and costs 383 in components, with an Aqualung and a Firewater the crafter makes. Of 200 attempts from Tinkering 153 on, 132 succeeded, and the skill rose to 171. At 175 the success rule gives 95%, about 26,000 platinum a hundred attempts, which take about 12 s.
- With crafted components counted (`runs/tmp/profit2.mjs`), nothing plain pays more an attempt than the Rebreather but Alchemy's 10 Doses Of Greater Rejuvenation, which takes a Shaman's trained Alchemy. Fletching's bows at a trivial of 215 to 282 pay 103 to 134, and neither skill is trained.
- An Aqualung combine (recipe 347) costs 22 and gives 20 Aqualungs, 3,400 platinum. It is the one recipe whose count is an item's charges, so it is left out of crafting for coin, and made only as the Rebreather's component. The 2,046 that the Tinkering training left were sold for about 348,000.

The coin job of `data/crafts.json` crafts 6,000 Rebreathers every hour in Edroun's tab, about ten minutes, while the account holds under 100 million platinum (`crafts` in `tools/lib/coordinator.mjs`, `craftTask` in `src/bot.js`). The hoard is there in case the game's prices change. Coin weighs nothing: the client counts the weight of items only.

## What a platinum bought before crafting for a merchant

The unit is an hour of one group's progress (`copyValue` in `tools/lib/acquire.mjs`), as the boss plan values kills.

| Use | Price | Brings | Platinum per group-hour |
| --- | ---: | --- | ---: |
| Raid time for the two free summons | 10,000 an hour | Talendor 4.0 and Lord Nagafen 3.7 on 2026-11-15 | 1,300 |
| Raid time for the Skyshrine Crusaders | 10,000 an hour | 0.7 a kill, four at a time, back in about ten minutes | 600 to 3,600 |
| The day's casino credit | 3,366 | a boss of 30, 2.6 on average over those the raid kills | 1,300 |
| One more casino credit | 12,500 | the same | 4,800 |
| An AA rank | 2,000 and a point | the median character's best stat rank adds 0.016% to its group's XP rate, the top tenth 0.038% | 12,500 and 5,300 over 1,000 hours of play |

- A credit's worth is uneven: Lord Yelinak 26.2, Tunare 21.4, Nanzata the Warder 7.4 and Tukaarak the Warder 4.9 hold 60 of the 78 hours the raid can kill, and half the 30 bosses are worth under half an hour. The raid does not kill Hraashna the Warder (25.3), Ventani the Warder (15.9), Vulak`Aerr (14.5) or The Avatar of War (3.7) in the simulator, under any nuke and heal order. The server refused a Tunare potion on 2026-11-14 for a missing spawn point, and without her a credit averages 1.9.
- An AA rank is also a goal of its own (docs/goal.md). Once every character is 60, the account earns about 115 points a day, 230,000 platinum of ranks, more than it earns in coin. Until then points limit the ranks, not coin.

## Policy

Since crafting for a merchant, platinum is priced by the time of the tab that spends it, not by what it costs.

1. The coin job crafts for a merchant until the account holds 100 million ("Crafting for a merchant").
2. Raid time whenever a kill is worth the raid: an open-world boss or a credit's boss buys its hour for kills worth a tenth of a group-hour, what a raid of about two and a half minutes costs its leader's tab (`OPEN_BUY` in `tools/lib/boss-plan.mjs`). A summon buys its hour, since an unused summon is lost.
3. The day's casino credit, then one more at every coordinator pass, while fewer than three credits wait for a raid that kills their boss and pays, and a credit is worth a tenth of a group-hour on average over the casino's 30 bosses (`casino` of `DEFAULTS` in `tools/lib/coordinator.mjs`, `creditMean` from the boss pass). A credit for a boss that drops nothing wanted or that the raid does not kill keeps without a raid (`creditPays`). Kill odds fights every casino boss for that.
4. AA ranks from what is above the reserve (`AA_POLICY`), the rank that adds most to its group first (`aaPlan`, `aaGain`). Points limit them, not coin.
5. Merchant gear from what the account holds above 200,000 (`buyBudget`).
6. A dead leader takes the resurrection that restores most (`rezMaxPp` in `src/bot.js`).

## Open

- The prices under "What a platinum bought before crafting for a merchant" no longer decide anything. Read what a day of rolls at every pass wins: the credits by boss, the raids they got, and the gear those brought.
- Whether the server limits the credits a day or the price of a roll rises.
- Weigh ranks against credits once coin limits the ranks.
- The Spell Bank's scrolls: sell the copies nobody can use, or stop banking them.
- The courier came at every cleanup, about 87 times a day for each group. Ingredients stack and take few slots, so it now comes once enough stacks wait (`bankAtStacks` in `src/bot.js`), and the reserve sells no ingredient meanwhile. Read the ledger's courier line after a day.
- Larger bags for the leaders are not bought. The reserve sells surplus from where the leader stands, the courier comes by gathered stacks and not by free slots, and the only loot left on corpses is a container, which needs a free general slot whatever the bags hold. So more slots save neither coin nor trips.
