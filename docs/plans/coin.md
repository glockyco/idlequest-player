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

## What a platinum buys

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

1. Raid time first. A summon buys its hour, since an unused summon is lost. A credit keeps, so its raid runs in paid time or buys an hour as an open-world boss's does (`OPEN_BUY`).
2. The day's casino credit, then more while the account's coin allows and few credits wait for their raid (`casino` of `DEFAULTS` in `tools/lib/coordinator.mjs`).
3. AA ranks from what is above the reserve (`AA_POLICY`), the rank that adds most to its group first (`aaPlan`, `aaGain`).
4. Merchant gear from the hour's income less the raid budget (`buyBudget`).

## Open

- Weigh ranks against credits once coin limits the ranks.
- The Spell Bank's scrolls: sell the copies nobody can use, or stop banking them.
- The courier came at every cleanup, about 87 times a day for each group. Ingredients stack and take few slots, so it now comes once enough stacks wait (`bankAtStacks` in `src/bot.js`), and the reserve sells no ingredient meanwhile. Read the ledger's courier line after a day.
- 10-slot bags for the leaders: White Cauldron, 90 platinum, Firiona Vie, weight 20, and Bag of the Tinkerers, 5,000 platinum, Solusek's Eye, weightless.
