# Questions from the session of 2026-11-15, with their answers

## 1. Sell crafted items for coin?

Answered: sell them. The items have no other use for the account. A Spyglass has a telescope click, Powered Gloves have 5 STR, and an Aqualung and a Rebreather give only water breathing. The Rebreathers the Warriors' epic takes are kept.

Done on 2026-11-15:

- Sold with the bank window's Sell Stack: 76 Spyglasses for 1,276 platinum, 84 Powered Gloves for 2,856 and 2,046 Aqualungs for about 348,000. A merchant pays 85% of an item's price.
- A coin job crafts for a merchant (`0bfd969`, docs/plans/coin.md, "Crafting for a merchant"). Its first run of 6,000 Powered Gloves made 145,000 platinum in nine minutes of one tab.

Then asked: why stop at 500,000, why not 100 million, and why not buy many more casino credits. Done (`574e9ca`, `da99bca`):

- The coin job crafts 6,000 Rebreathers every hour, about ten minutes of Edroun's tab, until the account holds 100 million. A Rebreather sells for 680 and costs 383, and at Tinkering 175 a hundred attempts bring about 26,000.
- One more casino credit is rolled at every coordinator pass, every five minutes, while fewer than three credits wait for a raid that pays and a credit is worth a tenth of a group-hour on average. A credit's raid runs only for a kill worth that much, since half the casino's 30 bosses drop nothing the account wants.
- A raid hour is bought for kills worth a tenth of a group-hour, merchant gear from what the account holds above 200,000, and a dead leader takes the resurrection that restores 96%.

Left out: crafting Aqualungs for coin. A combine costs 22 platinum and gives 20 Aqualungs, 3,400 platinum, because the recipe's count is the item's charges. Among the recipes that pay, it is the only one with such a count. It would bring 100 million in under an hour where the Rebreathers take some days at ten minutes an hour. The coin job makes Aqualungs only as the Rebreather's component.

## 2. Report the Aqualung count to the game's developer?

Answered: no.

## 3. Should tanks keep a shield?

Answered: enforce shields everywhere if they make a difference in the raid simulator. They do not.

No Warrior, Paladin or Shadow Knight wears a shield now: the five Warriors dual wield, and the four Paladins and four Shadow Knights hold two-handers. The raid of all 72 fought three bosses four times each, as worn, with a Darkmetal Falchion and a Sarnak Battle Shield (AC 25, HP 40) on the eight two-hander wielders, and with that shield also in the Warriors' off hands:

| Boss | As worn | Shields on Paladins and Shadow Knights | Shields on Warriors too |
| --- | --- | --- | --- |
| Cazic-Thule | 4 of 4, 211 s, 1.3 deaths | 4 of 4, 209 s, 1.0 deaths | 4 of 4, 221 s, 2.3 deaths |
| The Avatar of War | 4 of 4, 346 s, 15.8 deaths | 4 of 4, 345 s, 15.8 deaths | 4 of 4, 348 s, 16.5 deaths |
| Ventani the Warder | 0 of 4, 83,016 HP left | 0 of 4, 86,775 HP left | 0 of 4, 86,162 HP left |

The differences are inside the spread of four fights, and none favors the shields. Group 9's six fought an essence carrier and Jaeil the Insane eight times each both ways: 73 s and 75 s as worn, 76 s and 77 s with the shield on its Paladin, who took the same damage, and nobody died. So the plan's choice stands, and no rule for shields was added.
