# The developer's post of 2026-11-15, 17:46, and what it means for this account

The post says the patch fixed exploits by which "a couple" of players gathered over 100 million platinum, that their platinum and tradeskill bank items were taken back, that exploits which are not reported "may be treated more harshly", and that flagged accounts can no longer trade.

This account used the same kind of loop for forty minutes that afternoon: it sold crafted items to a merchant for more than their components cost.

| Sold | Platinum |
|---|---:|
|2,046 Aqualungs left by the Tinkering training (one combine gives 20)|about 348,000|
|About 6,010 Powered Gloves from 6,300 attempts, crafted to sell|about 204,000|
|132 Rebreathers crafted to sell|89,760|
|84 Powered Gloves and 76 Spyglasses left by the training|4,132|

The account's coin rose from about 203,000 at 16:40 to about 715,000 at 17:20. Since then about 29,000 went to two more casino credits (Dain Frostreaver IV, Tukaarak the Warder) and some to raid time. It holds 681,575 now, so nothing was taken back from it so far.

## Answered, 2026-11-15 18:35

The developer said in a follow-up message that a minor amount like this is fine, so the account is not affected by the rollback.

- No hold on the 512,000 platinum, and no report.
- The two casino credits are used normally.
- The jewelry goes on.

Done after the answer: the hold on the platinum and on the credits is removed, and the jewelry training may spend 200,000 platinum in one run. Crafting for a merchant stays off, since the post says further exploits may be treated more harshly, and a craft task still sells nothing.

## Done without asking

- The coin job is removed and no craft task sells anything (`c16c3c2`, `9a5f903`). No coin job ran after the patch.
- The 512,000 platinum the loop brought were held out of every spending decision, until the answer above.
- The spending rules of this afternoon that rested on free coin are back to what they were: a raid hour for kills worth a group-hour, one more casino credit every four hours, 200 platinum for a resurrection.
- The bots keep playing. The post is about exploits, not about automation.

## 1. Report it to the developer?

Earlier today the answer to "report the Aqualung count" was no. The post changes what not reporting costs.

- **Recommended: report it yourself, today.** The post says a player who "used it a little bit" and reports keeps what they have, and that unreported exploits may be treated more harshly. The developer can see every sale in the server's records, and 2,046 Aqualungs in one sale stand out. A draft is below.
- Do not report. The account keeps the platinum unspent and hopes it is not looked at.

Draft, to adapt:

> I used the crafting profit before your patch and want to report it. On Nov 15 between about 16:55 and 17:20 my account sold crafted Tinkering items from the tradeskill bank for more than the components cost: about 2,050 Aqualungs (recipe 347 gives 20 a combine, which looks like its charge count), about 6,000 Powered Gloves and 132 Rebreathers, about 646,000 platinum in total against roughly 121,000 of components. I have stopped and have not spent the gain. Take it back if you want to.

## 2. What becomes of the 512,000 held platinum?

- **Recommended: keep it held until the developer has answered the report**, then set `HELD_PP` to what he leaves.
- Spend it as before. This is what the post calls benefiting from an exploit.
- Destroy or give it away. The account trades with nobody, and the client has no way to drop coin that I know of.

## 3. The two casino credits bought with that coin

Dain Frostreaver IV (Ibaegrix) and Tukaarak the Warder (Tagujazolu) were won with 28,800 platinum of the gain. Their raids have not run.

- **Recommended: name them in the report and leave them unused until the answer.** They were held until the answer above.
- Use them. They are won, and a credit cannot be given back.

## 4. Jewelry for the roster

Built today (`ad07462`): Edroun trains Jewelry Making and makes rings and earrings for 58 characters, about 208 pieces, from catalog components. It sells nothing. The training costs about 100,000 platinum and the pieces about 38,000, now paid from the account's own coin in steps of 50,000.

- **Recommended: go on.** Crafting gear to wear is ordinary play.
- Wait with it until the developer has answered.
