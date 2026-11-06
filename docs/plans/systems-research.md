# Systems research for a raid-capable account

## Evidence and limits

This is read-only research, not a report of game tests. `C/` below means `~/src/github.com/brynnb/idlequest-content/`. Paths beginning `.re/` or `diary/` are relative to this repository. Exported content describes the local snapshot, not a verified live-server result. The content contract explicitly warns that imported data and a compiling quest are not proof of runtime behavior. Source: `C/docs/runtime-contract.md:43-49`.

The public wiki is a JavaScript application. Reading its page URLs returns an HTML shell. Its published module contains the actual Markdown for all eight articles, including Overview, Companions, Experience & Zones, Loot & Inventory, Raiding, and Tradeskills. The article text below was read from that module, not inferred from search snippets. Sources: <https://idlequest.net/wiki>, <https://idlequest.net/assets/DoZSjMzU.js:545-1478>, and the module's article registry at line 1609.

Four requested quantities remain unverified because the available sources do not expose them: the AA ability/rank catalog, the server's level-to-hourly-raid-price formula, a hard character limit, and the policy for two simultaneous same-account character sessions. Likewise, there is no measured higher-level IdleQuest platinum/hour comparison or market-sales dataset here. These limits are identified in the relevant sections rather than filled with P99 assumptions.

## 1. Alternate Advancement

### Unlock, earnings, and purchase costs

- The client defines the AA unlock level as 46, progress per point as 75,000,000 XP, and training price as 2,000 platinum. Its training UI says each rank costs 1 AA point plus that platinum price. Sources: `.re/js/engine.pretty.js:19363-19365,408215-408220`.
- XP allocation is per character, from 0% through 100%, in 5-percentage-point increments. The UI has Party and Account tabs, individual allocations, and party-wide 0% and 100% actions. Sources: `.re/js/engine.pretty.js:408038-408047,408090-408125,408189-408204`.
- Same-account companions can have their own AA allocation and training target. Default bot companions have a disabled allocation control and the explicit message "Default companions do not earn AA." Sources: `.re/js/engine.pretty.js:407699-407715,408150-408175`.
- Separate player and party-companion rules can temporarily force AA allocation to 0% below a chosen level. The saved percentage resumes at that level. Sources: `.re/js/engine.pretty.js:407966-407995,408063-408069`.
- The exact current unlock, XP-per-point, abilities, maximum ranks, descriptions, and owned ranks also arrive in a server response. The UI does not contain a local ability catalog. It requests advancement state and renders `H.abilities`, `fe.maxRank`, and `fe.description`. Consequently the constants above are client evidence, while actual offered ranks and any server override remain unverified. Sources: `.re/js/engine.pretty.js:407475-407482,407824-407834,407933-407937,408224-408260`.

### What is implemented in the client, and class priorities

The ordinary stat calculation consumes AA bonuses to STR, STA, DEX, AGI, INT, WIS, CHA, five elemental/disease/poison resists, HP regeneration, and run speed. Run speed uses the greater of the spell movement bonus and AA speed, not their sum. AA lung capacity also extends the breath limit. These are supported bonus fields, not verified ability names or per-rank values. Sources: `.re/js/main.pretty.js:21845-21879,21928-21952,21963-21968,22022-22027` and `.re/js/engine.pretty.js:458308-458312`.

| Character | Conditional priority when the server offers the relevant general ability | Basis |
| --- | --- | --- |
| Domeyafun, Magician | INT for mana when below the effective cap. Then survival through STA, resists, and HP regeneration. Do not budget for an assumed pet-DPS AA. | AA INT and STA enter ordinary stats. Mana uses INT for class 13. No pet-DPS AA is established by the inspected AA consumers. `.re/js/main.pretty.js:20417-20431,20448-20452,20563-20585,21845-21879,22022-22027`. |
| Tagujazolu, Warrior | STA and encounter resists for tank survival. Consider AGI or STR only after checking the resulting tank stats. | STA enters HP, AGI enters defense calculations, STR enters offense. `.re/js/main.pretty.js:20563-20574,21854-21867,21901-21923,21999-22003`. |
| Ewbanaqoa, Cleric | WIS for mana when below the effective cap, then survival. | Class 2 uses WIS in the mana formula. `.re/js/main.pretty.js:20417-20431,20448-20452,20576-20585,21872-21875`. |
| Ugfeu, Bard | Survival first, especially STA, resists, and HP regeneration. This is a recommendation, not an established optimal AA build. | These bonus fields affect the character. Bard songs stop on death, unlike other ordinary raid support. `.re/js/main.pretty.js:21854-21859,21928-21952,22022-22027` and <https://idlequest.net/wiki/raiding>, "How raid members work". |
| Qigaa, Shaman | WIS for mana when below the effective cap, then STA, resists, and HP regeneration. | Class 10 uses WIS. `.re/js/main.pretty.js:20417-20431,20448-20452,20576-20585,21854-21859,22022-22027`. |
| Edroun, Enchanter | INT for mana when below the effective cap, then survival. Do not buy CHA solely on an unverified claim about an AA's charm benefit. | Class 14 uses INT. CHA is a supported stat bonus, but this research did not establish the server's offered CHA rank effects or a charm-specific AA. `.re/js/main.pretty.js:20417-20431,20448-20452,20576-20585,21868-21879`. |

The base ordinary stat cap is 255, modified by applicable cap bonuses. Mana gains per casting-stat point are halved above 200 in the client formula. Buying an already capped stat is therefore not automatically useful. Sources: `.re/js/main.pretty.js:21063,21821-21823,21894-21900,20576-20585`.

Recommendation: preserve level XP while assembling the roster rather than assuming AA should begin immediately at 46. Training costs platinum as well as XP. The temporary allocation rules can preserve a desired setting while leveling. The exact best allocation and per-class purchase order cannot be calculated without the server ability catalog. Sources for the tradeoff: `.re/js/engine.pretty.js:407966-407995,408215-408249`.

## 2. Tradeskills

### Availability and mechanics

The client has containers for Fishing, Make Poison, Tinkering, Research, Alchemy, Baking, Tailoring, Blacksmithing, Fletching, Brewing, Jewelry Making, and Pottery. The offline enabled recipe data includes all of their skill IDs. The wiki explicitly opens tradeskills to all races and classes, including the ordinarily restricted Alchemy, Make Poison, Research, and Tinkering. Cultural containers and individual recipes can still impose restrictions. Sources: `.re/js/engine.pretty.js:12267-12275,12643-12650,13138-13145,13301-13448,14400-14585`, `C/data/tradeskill_recipe/*.ndjson` fields `enabled` and `tradeskill`, and <https://idlequest.net/wiki/tradeskills>, opening paragraphs.

- Advanced crafting supports 1, 20, or 100 attempts. These are attempts, not guaranteed outputs. It consumes banked ingredients before carried ones and deposits results in the ingredient bank. Source: <https://idlequest.net/wiki/tradeskills>, "Crafting from a recipe".
- Ingredient purchases can be made remotely through Buy, x20, or x100. Dropped ingredients are not thereby made purchasable. Farm Items gives categories and zone suggestions rather than guaranteed drops. Source: <https://idlequest.net/wiki/tradeskills>, "Buying and farming ingredients".
- Trivial is the skill-up cutoff, not a no-failure threshold. Failed ordinary combines generally consume materials. Shawl combines are manual-only and absent from Advanced. Source: <https://idlequest.net/wiki/tradeskills>, "Trivial does not mean guaranteed" and "Classic containers and special combines".
- The Advanced jewelry list presents enchanted, stat-bearing results. Statless plain-bar combines are manual. Both have the same difficulty, and the crafting merchant sells enchanted bars at the same price as plain bars. There are four ordinary metal tiers in the imbued-deity recipe description and 15 deity families. The buyer can obtain the enchanted bar and imbued gem directly, without an Enchanter preparing them. Source: <https://idlequest.net/wiki/tradeskills>, "Jewelry recipes" and "Imbued deity jewelry".

### Concrete low- and mid-level crafts

These are exported enabled recipes and item stats, not tested live combines. Every ingredient quantity below is copied from the recipe-entry data. Where two items share a display name, the item IDs distinguish them.

| Craft | Trivial | Components for one attempt | Output and decision value | Sources |
| --- | --- | --- | --- | --- |
| Silver Jasper Ring, enchanted recipe 8333 | 30 | 1 Jasper, 1 Enchanted Silver Bar | +2 WIS. Low-cost caster jewelry candidate for Cleric or Shaman. | `C/data/tradeskill_recipe/7.ndjson:1299`, `C/data/tradeskill_recipe_entries/6.ndjson:7655,e.ndjson:7493`, `C/data/items/d.ndjson:281`. |
| Silver Rose Engagement Ring, enchanted recipe 8347 | 34 | 1 Star Rose Quartz, 1 Enchanted Silver Bar | +2 INT. Low-cost jewelry candidate for Magician or Enchanter. | `C/data/tradeskill_recipe/f.ndjson:1254`, `C/data/tradeskill_recipe_entries/6.ndjson:7658,2.ndjson:7694`, `C/data/items/5.ndjson:314`. |
| Golden Jaded Bracelet, enchanted recipe 8047 | 178 | 1 Jade, 1 Enchanted Gold Bar | 2 AC, 15 HP, 15 mana. Broader party value, but a much higher skill requirement for reliable production. | `C/data/tradeskill_recipe/3.ndjson:1311`, `C/data/tradeskill_recipe_entries/4.ndjson:7563,b.ndjson:7415`, `C/data/items/a.ndjson:276`. |
| Platinum Fire Wedding Ring, enchanted recipe 8196 | 268 | 1 Fire Opal, 1 Enchanted Platinum Bar | 5 AC, 55 HP. Tank and general survival candidate, not a cheap beginner skill-up. | `C/data/tradeskill_recipe/c.ndjson:1292`, `C/data/tradeskill_recipe_entries/2.ndjson:7678,1.ndjson:7590`, `C/data/items/5.ndjson:319`. |
| Velium Rose Engagement Ring, enchanted recipe 8281 | 244 | 1 Star Rose Quartz, 1 Enchanted Velium Bar | +5 INT. Compare the small stat increase with the material cost before skilling for it. | `C/data/tradeskill_recipe/f.ndjson:1250`, `C/data/tradeskill_recipe_entries/0.ndjson:7766,7.ndjson:7596`, `C/data/items/b.ndjson:1201`. |
| Hand Made Backpack, recipe 2686 | 88 | 1 Backpack Pattern, 1 High Quality Bear Skin, item 13752 | 10 slots, 10% weight reduction. Account utility or a player-sale candidate, not a verified cash farm. | `C/data/tradeskill_recipe/d.ndjson:688`, `C/data/tradeskill_recipe_entries/2.ndjson:4886-4887`, `C/data/items/7.ndjson:481`. |
| Silk Swatch, recipe 3187 | 15 | 2 Spider Silk | 1 swatch. An accessible Tailoring input, not evidence of profitable NPC resale. | `C/data/tradeskill_recipe/6.ndjson:970`, `C/data/tradeskill_recipe_entries/6.ndjson:6797,c.ndjson:6726`. |

The ingredient catalog quotes Jasper at 750 copper, Star Rose Quartz at 1,000, Enchanted Silver Bar at 600, Jade at 3,500, Enchanted Gold Bar at 12,000, Fire Opal at 40,000, Enchanted Platinum Bar at 120,000, Enchanted Velium Bar at 300,000, and Backpack Pattern at 500. These are catalog component prices, not the completed item's sale proceeds. Sources: `C/data/crafting_merchant_items/1.ndjson:2,c.ndjson:3,9.ndjson:78,e.ndjson:1,d.ndjson:73,3.ndjson:3,b.ndjson:64,b.ndjson:98,d.ndjson:15`. The client uses 1,000 copper per platinum in its currency display. Source: `.re/js/engine.pretty.js:8935-8947`.

### Spell Research

| Spell craft | Trivial | Spell use level from exported spell data | Components | Sources |
| --- | --- | --- | --- | --- |
| Mesmerization, recipe 791 | 21 | Enchanter 16 | 1 each of Tasarin's Grimoire Pg. 26 items 16072 and 16073 | `C/data/tradeskill_recipe/c.ndjson:1271`, `C/data/tradeskill_recipe_entries/6.ndjson:9912,0.ndjson:9992`, `C/data/spells_new/0.ndjson:1420`. |
| Color Shift, recipe 643 | 41 | Enchanter 20 | 1 each of Tasarin's Grimoire Pg. 312 items 16076 and 16077 | `C/data/tradeskill_recipe/a.ndjson:1238`, `C/data/tradeskill_recipe_entries/9.ndjson:9162,a.ndjson:9124`, `C/data/spells_new/f.ndjson:516`. |
| Minor Conjuration: Air, recipe 795 | 120 | Magician 34 | 1 Greater Summoning: Air scroll, 1 Words of Duress, 1 The Scent of Marr | `C/data/tradeskill_recipe/0.ndjson:1314`, `C/data/tradeskill_recipe_entries/6.ndjson:9932,5.ndjson:9781,e.ndjson:9858`, `C/data/spells_new/3.ndjson:2305`. |
| Conjuration: Earth, recipe 649 | 162 | Magician 44 | 1 Lesser Conjuration: Earth scroll, 1 Words of Incarceration, 1 Essence of Rathe | `C/data/tradeskill_recipe/5.ndjson:1186`, `C/data/tradeskill_recipe_entries/6.ndjson:9141,e.ndjson:9076,7.ndjson:9062`, `C/data/spells_new/8.ndjson:2310`. |
| Greater Conjuration: Water, recipe 719 | 182 | Magician 49 | 1 Conjuration: Water scroll, 1 Words of Bondage, 1 Tears of Prexus | `C/data/tradeskill_recipe/f.ndjson:1199`, `C/data/tradeskill_recipe_entries/e.ndjson:9468,9.ndjson:9583,1.ndjson:9542`, `C/data/spells_new/b.ndjson:2224`. |
| Allure, recipe 604 | 182 | Enchanter 49 | 1 Nilitim's Grimoire Pg. 378 and 1 Pg. 379 | `C/data/tradeskill_recipe/0.ndjson:1200`, `C/data/tradeskill_recipe_entries/f.ndjson:8956,8.ndjson:8842`, `C/data/spells_new/b.ndjson:565`. |

Lower-level Magician research also exists. Minor Summoning: Earth has trivial 21, Lesser Summoning: Air has 41, and Summoning: Air has 57. Sources: `C/data/tradeskill_recipe/5.ndjson:1284,8.ndjson:1229,b.ndjson:1280`. Research is therefore a potential spell-acquisition route before the larger pet spells, not merely an endgame skill.

Do not infer that a known recipe is the cheapest or exclusive way to acquire its scroll. The wiki provides direct Buy Spells and Buy Companion Spells actions for merchant spells, while quest, research-only, and drop-only spells retain their acquisition routes. Banked scrolls can teach the active character and eligible same-account companions every five seconds. Source: <https://idlequest.net/wiki/companions>, "Buying companion spells".

### Income verdict and sale candidates

The offline P99 Jewelcrafting guide describes potentially popular products and long-run income, but also reports substantial skill-up costs. Its examples for reaching skill 162 include 1,410 and 2,500 platinum, and its general warning says upwards of 3,000 platinum. These are P99 anecdotes, not an IdleQuest cost estimate. Source: `C/reference/p99-wiki/crafting-restoration-2026-10-09/Jewelcrafting.wiki:1-6`.

No recipe is established here as an IdleQuest NPC-sale profit loop or as a measured good seller to other players. Hand Made Backpacks, survival jewelry, and missing research scrolls are products to compare against actual demand, not demonstrated sales. The direct account-power case is stronger than the income case: cheap INT/WIS rings, a needed spell, or extra bag slots have explicit outputs above. Do not divert a raid fund into bulk Jewelcrafting on an unsupported resale assumption. Sources for those outputs and prices are the recipe tables and ingredient catalog above.

## 3. Raids

### Access, roster, and snapshots

- The wiki says Start Raid unlocks at level 46, asks you to disband the normal party, and permits recruits from the account or guild, including offline guild characters. Same-account recruits do not need the leader's guild. The active character is already the leader, each character can appear once, and the default Warrior, Rogue, and Cleric bots are excluded. Source: <https://idlequest.net/wiki/raiding>, "Getting started".
- The wiki says raid combat can engage otherwise attackable NPCs above level 50 and handle adds. This is separate from the leader's level-46 unlock. Source: <https://idlequest.net/wiki/raiding>, "Getting started".
- A normal party has 6 characters including the active character. This is not a published raid-member limit. The inspected raid recruitment code checks eligibility, duplicate/loading characters, and a combat lock, then appends the recruit. It contains no numeric roster-cap check in that path. A hard server raid limit remains unverified. Do not state 54 or 72 as an established raid cap. Sources: <https://idlequest.net/wiki/overview>, "What is different from EverQuest?", and `.re/js/main.pretty.js:71544-71648`.
- Lower-level recruits retain their actual level. The wiki warns that raid spell and pet commands start at level 46, leaving lower-level caster support incomplete. Source: <https://idlequest.net/wiki/raiding>, "What is unfinished?".
- Recruits snapshot level, equipment, skills, and learned spells. Raid damage, mana, death, location, and supply usage do not mutate the original character's saved state. Remove and re-add to refresh equipment and spell snapshots. Source: <https://idlequest.net/wiki/raiding>, "How raid members work".
- The projection code additionally carries base stats, AA bonuses, quiver haste, deity, and carried click-item IDs. Sources: `.re/js/main.pretty.js:64145-64225`.
- Ordinary support buffs remain after a recruited character dies. Bard songs require the Bard alive. Removing the recruit removes its support. Source: <https://idlequest.net/wiki/raiding>, "How raid members work".

### Boss summons and daily allowance

The Resets tab provides 2 free boss summons per account in a rolling 24-hour period, shared across characters. Travel to the boss's zone, summon, then use Move & Attack. A new summon spends a reset. Resuming a saved boss or retrying a wipe does not. A private copy expires 24 hours after summoning. A listed boss has its own 24-hour kill cooldown beginning on death. Source: <https://idlequest.net/wiki/raiding>, "Daily raid resets".

Casino boss potions do not spend those free resets. The wiki permits as many as the account has, but only 1 active casino boss at a time until it dies or expires. Source: <https://idlequest.net/wiki/raiding>, "Daily raid resets".

### Hourly price, and what "free" does not establish

The client displays a separate Raid Time purchase, priced per hour from the account's highest-level character. Time is shared account-wide and continues while offline. Auto-renew buys another hour only while raiding. Without it, the current fight can finish, but a new fight needs renewal. Source: `.re/js/engine.pretty.js:8870-8878,8934-8965`.

The server supplies `priceCopper`. The client validates and displays it, rather than computing a level-based price locally. Purchases log "one hour" and the server's `chargedCopper`. Source: `.re/js/main.pretty.js:70792-70848`.

The account diary records a quote of 2,000 platinum/hour while level 7, with about 25 platinum/hour loose coin and 1 platinum/hour from loot sales. The separate hearsay quote of 10k is not a verified price tier. Source: `diary/2026-11-06-d.md:29-35`.

The complete hourly formula and higher-level brackets are unverified. One observed price cannot distinguish a flat floor from level brackets or another function. Also, "two free summons" is not evidence that raid combat time is free. The sources expose separate summon and time mechanisms. Sources: <https://idlequest.net/wiki/raiding>, "Daily raid resets", `.re/js/main.pretty.js:70810-70848`, and `diary/2026-11-06-d.md:31-35`.

### Raid Resolve

Against Cazic-Thule, Tunare, Avatar of War, Vulak`Aerr, Lord Vyemm, Lord Yelinak, Nanzata, Ventani, Tukaarak, Hraashna, and awakened Kerafyrm, raid Warriors, Paladins, and Shadow Knights receive double maximum HP and a full heal. Clerics receive double maximum mana and a full refill. It includes existing gear and buffs, applies to the leader and recruited members, and affects only living characters. It is 1 refill per fight, not resurrection or continuous regeneration. Multiple qualifying bosses do not stack it or grant more refills. Daily and casino copies qualify. Source: <https://idlequest.net/wiki/raiding>, "Raid Resolve". The client implements +100% maximum HP for class IDs 1, 3, and 5 and +100% maximum mana for class 2. Source: `.re/js/main.pretty.js:22711-22740`.

Recommendation: additional trained Clerics and tanks directly exploit the qualifying-encounter bonuses, but this is not a measured optimal roster composition. The source establishes the bonuses, not how many tanks or healers a particular account needs.

## 4. Platinum and income by level band

### What can be earned without other players

Platinum does not require player trading. The game supports defeated-enemy coin, NPC quest cash, remote explicit item sales, bulk Auto Sell, and explicit ingredient-bank Sell or Sell Stack. Sources: <https://idlequest.net/wiki/loot-and-inventory>, "What happens when your inventory fills" and "Automatic hand-downs and coin split", <https://idlequest.net/wiki/tradeskills>, "The ingredient bank", and `C/effective/quests/qeynos/Chesgard_Sydwen.lua:30-40`.

Coin Split changes distribution among same-account characters, not item ownership or XP. It is off by default and does not pay the built-in bots. Source: <https://idlequest.net/wiki/loot-and-inventory>, "Automatic hand-downs and coin split". Track total account coin when comparing camps so distribution is not mistaken for income.

### Best-supported candidates, not invented hourly rankings

Only the level-7 income above is measured for this IdleQuest account. The other rows are research-backed camp candidates. Planning bands below are recommendations, not unlock thresholds or a claim that each camp is the fastest possible platinum/hour.

| Planning band | First sources to compare | Concrete evidence | Platinum/hour status |
| --- | --- | --- | --- |
| 1-11 | Continue efficient leveling and vendor spare drops. Treat the level-7 sample as the baseline, not as the cap on income. | About 25 platinum/hour loose coin plus 1 platinum/hour sales in the account diary. `diary/2026-11-06-d.md:31-35`. | Measured account baseline only. |
| 12-19 | Bronze-dropping Nybright sisters or Karana bandits with sash turn-ins. | Jayla is level 12 with 264 HP in both the local export and P99 page. Her exported loot table has 242-1,619 copper. The P99 page lists bronze weapons. `C/data/npc_types/b.ndjson:3492`, `C/data/loottable/e.ndjson:650`, `C/reference/p99-wiki/npc-pages/jayla-nybright-33c0f9d72f.wiki:11-21,33-45`. | Unverified. Sashes add a quantified reward per turn-in below, not a measured hourly rate. |
| 20-32 | Compare the existing bronze/sash route against new camps that actually drop fine-steel weapons. Do not abandon a productive camp solely for a higher mob level. | P99 fine-steel sale examples range from 5.2 to 6.7 platinum for the listed weapon types. These are P99 vendor observations, not IdleQuest quotes. `C/reference/p99-wiki/npc-pages/a-hill-giant-27a2b830b6.wiki:138-156`. | Unverified. No measured IdleQuest winner in this band. |
| 33-45 | Hill giants are the strongest coin-first candidate in this sample. Compare spectres when their lower HP permits much faster kills. | An exported hill giant is level 36, 3,477 HP, with 704-52,567 copper. An exported spectre is level 37, 1,739 HP, with 792-5,249 copper. `C/data/npc_types/2.ndjson:300,3.ndjson:2573`, `C/data/loottable/a.ndjson:670,b.ndjson:634`. | Unverified. Cash ranges are not averages or hourly returns. |
| 46-60 | Re-evaluate hill giants against Everfrost ice giants and Ocean of Tears seafuries, including item proceeds and travel. Higher-level characters can still use a lower-level cash camp. | The exported ice giant is level 42 with 4,822 HP and 704-52,567 copper. The seafury is level 40 with 4,835 HP and 814-5,394 copper. P99 seafury loot includes Fire Opal, Star Ruby, Fire Emerald, and Sapphire. `C/data/npc_types/7.ndjson:2066,9.ndjson:3672`, `C/data/loottable/e.ndjson:594,0.ndjson:747`, `C/reference/p99-wiki/npc-pages/a-seafury-cyclops-59b9e2e7d0.wiki:41-48`. | Unverified. Seafury gem drops must compensate for lower exported loose-coin range. |

The P99 spectre page lists different respawn times by zone: 16 minutes 30 seconds in Oasis, 6 minutes 40 seconds in Feerrott, and 6 minutes in Ocean of Tears. Those are P99 timers, not verified IdleQuest farm throughput. Source: `C/reference/p99-wiki/npc-pages/a-spectre-5116d5f6e1.wiki:35-48`.

Do not transplant P99 NPC durability into IdleQuest calculations. For example, the P99 hill-giant page reports 2,477 HP, while the inspected IdleQuest-content record has 3,477. Likewise, the P99 seafury page warns that older high-drop-rate advice is obsolete even on P99. Sources: `C/reference/p99-wiki/npc-pages/a-hill-giant-27a2b830b6.wiki:19-20`, `C/data/npc_types/2.ndjson:300`, and `C/reference/p99-wiki/npc-pages/a-seafury-cyclops-59b9e2e7d0.wiki:31-33`.

### Specific quest and item decisions

- A Bandit Sash, item 12100, yields 4-15 gold, 6,200 XP, and one random bronze item in the inspected quest implementation. The random item pool includes armor as well as weapons. This differs from treating every reward as a bronze weapon. Sources: `C/effective/quests/qeynos/Chesgard_Sydwen.lua:30-40` and `C/reference/p99-wiki/raw-pages/bandit-sashes-b3cddaa63c.wiki:23-32`.
- Research Aid accepts a Greater Lightstone and returns a Concordance of Research plus 16,000 XP. The ordinary Lightstone gives one research volume and 14,500 XP. There is no cash-award call in those branches. Source: `C/effective/quests/northkarana/Mrysila.lua:16-32`.
- Greater Lightstone and Concordance of Research both have exported base `price` 4,500, but different `sellrate` fields. These raw fields do not establish their final live vendor payouts. Do not assume the familiar P99 lightstone-to-book strategy multiplies platinum in IdleQuest without a sale quote. Sources: `C/data/items/b.ndjson:19,5.ndjson:494`.
- P99's seafury table records individual vendor values of 38 platinum for Fire Opal, 62 for Star Ruby, 81 for Fire Emerald, and 95 for Sapphire. These identify valuable-drop candidates, not guaranteed IdleQuest sale prices or drop frequencies. Source: `C/reference/p99-wiki/npc-pages/a-seafury-cyclops-59b9e2e7d0.wiki:95-117`.
- Protect research components and intended upgrades before bulk sales. No Sell and No Declutter bags protect selected items. The wiki also protects epic materials by default, and Auto Sell Spells is off by default. Sources: <https://idlequest.net/wiki/loot-and-inventory>, "Protecting items you want to keep" and "Scribing spells from loot".

A defensible camp comparison needs observed account coin, actual sale proceeds, supply/spell expenses, and elapsed wall time. Static min/max cash is insufficient because kill speed, drops, recovery, and spawn availability remain unknown. The client/wiki evidence supports gathering those measurements, not assigning a fabricated platinum/hour ranking.

## 5. Account limits and concurrent sessions

### Character slots

The selector renders 8 characters per page and at least 9 pages. Its page count is `Math.max(9, Math.ceil(characters.length / 8))`, so the visible minimum is 72 positions, with page count able to grow when the returned character list is larger. An empty position opens character creation. This is a UI affordance, not proof of a server-enforced 72-character limit. Source: `.re/js/engine.pretty.js:1412-1449`.

A hard per-account creation cap is unverified. Neither the read wiki's Overview/Companions/Raiding articles nor the public Discord invite publishes one. Therefore, do not plan an exact maximum roster from either the normal-party size of 6 or the selector's 72 visible minimum positions. Sources inspected: <https://idlequest.net/wiki/overview>, <https://idlequest.net/wiki/companions>, <https://idlequest.net/wiki/raiding>, their Markdown at <https://idlequest.net/assets/DoZSjMzU.js:823-1054,1300-1403>, and <https://discord.com/invite/vH4GPChWKY>.

### Two tabs on one account

Unverified. The wiki says automated adventuring requires leaving the game running and is not offline progression. It explains same-account companion progression and independent raid copies, but does not state whether two tabs may actively run two different characters from the same account at once. The linked public Discord invite exposes the community description, not a login-concurrency rule or readable channel discussion. Sources: <https://idlequest.net/wiki/overview>, <https://idlequest.net/wiki/companions>, <https://idlequest.net/wiki/raiding>, and <https://discord.com/invite/vH4GPChWKY>.

No browser, tab, relay, login, or concurrency experiment was used for this research. The usable documented alternative is one active character plus same-account companions in a 6-character normal party. The wiki says those account characters earn their own persistent XP. Sources: <https://idlequest.net/wiki/overview>, "What is different from EverQuest?", and <https://idlequest.net/wiki/experience-and-zones>, "Party experience".

## Five highest-value actions

1. Keep the six own-character party leveling and buy missing merchant spells deliberately. The documented party supports persistent companion XP, and the raid command set starts at 46. Do not substitute default bots for roster progress. Sources: <https://idlequest.net/wiki/experience-and-zones>, <https://idlequest.net/wiki/companions>, "Buying companion spells", and <https://idlequest.net/wiki/raiding>, "What is unfinished?".
2. Establish a measured platinum route before buying raid time. Compare account-wide coin plus actual vendor proceeds against expenses, using the level-7 diary as the only current observed baseline. Hill giants, ice giants, and the sash quest have concrete coin evidence, but no higher-level hourly winner is verified. Sources: `diary/2026-11-06-d.md:29-35`, `C/data/loottable/a.ndjson:670,e.ndjson:594`, and `C/effective/quests/qeynos/Chesgard_Sydwen.lua:30-40`.
3. Craft for an explicit missing benefit, not speculative resale. Start by pricing the low-trivial INT/WIS rings and needed research scrolls. Avoid funding high-trivial jewelry on an unverified profit claim. Sources: `C/data/tradeskill_recipe/7.ndjson:1299,f.ndjson:1254,c.ndjson:1271,a.ndjson:1238` and <https://idlequest.net/wiki/tradeskills>.
4. Build tank and Cleric depth for the named endgame bosses, then refresh raid recruits after gearing or learning spells. Raid Resolve doubles tank HP and Cleric mana, while roster snapshots do not automatically become the original character's latest equipment and spell state. Source: <https://idlequest.net/wiki/raiding>, "Raid Resolve" and "How raid members work".
5. Prepare the roster, location, and target before paying for a raid hour. Use the account's two daily summons deliberately and avoid leaving paid account time idle offline. Keep AA purchases and further character creation conditional on the server's actual catalog, quote, and limits rather than assumed EQ rules. Sources: <https://idlequest.net/wiki/raiding>, "Daily raid resets", `.re/js/engine.pretty.js:8870-8878,8934-8965,408215-408249,1412-1417`.
