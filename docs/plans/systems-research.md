# Systems research for a raid-capable account

## Evidence and limits

This is mostly read-only research, not a report of game tests. The measured numbers are the rates taken from `runs/2026-11-07-live` with `tools/analyze.mjs` and the diary's level-7 price quote. `C/` below means `~/src/github.com/brynnb/idlequest-content/`. Paths beginning `.re/` or `diary/` are relative to this repository. Exported content describes the local snapshot, not a verified live-server result. The content contract explicitly warns that imported data and a compiling quest are not proof of runtime behavior. Source: `C/docs/runtime-contract.md:43-49`.

The public wiki is a JavaScript application. Reading its page URLs returns an HTML shell. Its published module contains the actual Markdown for all eight articles, including Overview, Companions, Experience & Zones, Loot & Inventory, Raiding, and Tradeskills. The article text below was read from that module, not inferred from search snippets. Sources: <https://idlequest.net/wiki>, <https://idlequest.net/assets/DoZSjMzU.js:545-1478>, and the module's article registry at line 1609.

Two requested quantities remain unverified because the available sources do not expose them: the server's level-to-hourly-raid-price formula (and the price at level 46 or higher), and a server-enforced limit on characters or raid size. Platinum per hour is measured only as gross coin pickup from level 8 to 31 (section 4), and there is no market-sales dataset. These limits are identified in the relevant sections rather than filled with P99 assumptions.

## 1. Alternate Advancement

### Catalog, costs and requests

The server sends the catalog with the window's own request, which works at any level: `sendCorrelatedJsonRequest(1237, 1238, { action: "get", scope: "account", hostCharacterId })` (`CVEP2_Ra.js:407750-408080` in `.re/releases/20261108T004644-064bc896/pretty/`). A reply is saved in `runs/state/aa-catalog.json`. It unlocks at 46 and counts to 60, a point costs 75,000,000 XP, and the client asks 2,000 platinum per rank from the character's carried coin.

| Ability (id) | Ranks | Per rank |
| --- | ---: | --- |
| Innate Strength, Stamina, Agility, Dexterity, Intelligence, Wisdom, Charisma (50001 to 50007) | 5 each | +2 of the stat |
| Innate Magic, Cold, Fire, Poison, Disease Protection (50008 to 50012) | 5 each | +2 of the resist |
| Innate Run Speed (50013) | 3 | 8, 14, 21% faster running, not stacking with speed buffs |
| Innate Regeneration (50014) | 3 | +1 HP per tick |
| Innate Metabolism (50015) | 3 | food and drink last 10, 25, 50% longer |
| Innate Lung Capacity (50016) | 3 | 10, 25, 50% more breath |

All 72 ranks cost 5.4 billion XP and 144,000 platinum per character. The same request with `action` `"purchase"` (`abilityId`, `expectedRank`, `expectedCostPlatinum`) trains a rank, `"allocate"` (`allocation` 0 to 100 in steps of 5, `targets` of `{ characterId, leaseId }`) sets the XP share of the active character and its account companions, and `"levelRule"` (`ruleScope` `"player"` or `"companions"`, `levelRule: { enabled, level }`, `expectedRulesRevision`) pauses the share below a level and resumes the saved share there. Default companions earn no AA. The bonuses enter the ordinary stat calculation (`Bt`, `OSTsR53r.js:21853-22029`), run speed as the greater of spell speed and AA speed, and breath through `airCapacitySeconds`.

### When and what to train

A rank adds 2 stat points for 75M XP, while a level costs 5M at 30, 17M at 45 and 50M at 55 at the base race and class factor (89M at 59, `tools/lib/xp.mjs`) and gives far more: HP, mana, spells and the weapon damage cap. XP therefore goes to levels until 60, and to AA from 60: the share is 100% with the level rule pausing it below 60 for the player and the companions. Metabolism and lung capacity add nothing to play the bot runs (the server refills food from carried meals, leveling plan lever 5, and no route is underwater), and run speed does not stack with Bard and Shaman speed songs. The order by value per point is the casting stat for casters and priests below its cap (INT for Magician, Wizard, Necromancer and Enchanter, WIS for Cleric, Druid and Shaman), STA for tanks and everyone after that, then the resists a raid target uses, then regeneration, with STR, DEX and AGI for melee. Mana gains per casting-stat point halve above 200 and stats cap at 255, so a stat at its cap is skipped (`.re/js/main.pretty.js:21063,21821-21823,21894-21900,20576-20585`).

## 2. Tradeskills

### Availability and mechanics

The client has containers for Fishing, Make Poison, Tinkering, Research, Alchemy, Baking, Tailoring, Blacksmithing, Fletching, Brewing, Jewelry Making, and Pottery. The offline enabled recipe data includes all of their skill IDs. The wiki explicitly opens tradeskills to all races and classes, including the ordinarily restricted Alchemy, Make Poison, Research, and Tinkering. Cultural containers and individual recipes can still impose restrictions. Sources: `.re/js/engine.pretty.js:12267-12275,12643-12650,13138-13145,13301-13448,14400-14585`, `C/data/tradeskill_recipe/*.ndjson` fields `enabled` and `tradeskill`, and <https://idlequest.net/wiki/tradeskills>, opening paragraphs.

- Advanced crafting supports 1, 20, or 100 attempts. These are attempts, not guaranteed outputs. It consumes banked ingredients before carried ones and deposits results in the ingredient bank. Source: <https://idlequest.net/wiki/tradeskills>, "Crafting from a recipe".
- Ingredient purchases can be made remotely through Buy, x20, or x100. Dropped ingredients are not thereby made purchasable. Farm Items gives categories and zone suggestions rather than guaranteed drops. Source: <https://idlequest.net/wiki/tradeskills>, "Buying and farming ingredients".
- Trivial is the skill-up cutoff, not a no-failure threshold. Failed ordinary combines generally consume materials. Shawl combines are manual-only and absent from Advanced. Source: <https://idlequest.net/wiki/tradeskills>, "Trivial does not mean guaranteed" and "Classic containers and special combines".
- The Advanced jewelry list presents enchanted, stat-bearing results. Statless plain-bar combines are manual. Both have the same difficulty, and the crafting merchant sells enchanted bars at the same price as plain bars. There are four ordinary metal tiers in the imbued-deity recipe description and 15 deity families. The buyer can obtain the enchanted bar and imbued gem directly, without an Enchanter preparing them. Source: <https://idlequest.net/wiki/tradeskills>, "Jewelry recipes" and "Imbued deity jewelry".

### Requests

A script crafts with the Advanced recipe window's own requests (`B7YhzEJy.js:300-427`, `CVEP2_Ra.js:409745-410580` in `.re/releases/20261108T004644-064bc896/pretty/`): 1045 (reply 1046) `{ recipeId }` lists the recipe's catalog ingredients with `priceEach`, 1047 (1048) `{ recipeId, quantity }` buys that many sets of them into the Tradeskill Bank from the active character's coin, and 1043 (1044) `{ recipeId, quantity, skillId, containerItemId }` crafts 1, 20 or 100 attempts and answers with `producedItems`, `successes`, `failures`, `skillUp` and `newSkillValue`. The window sends the recipe's skill and the container the character holds (a portable container in its bags) or the world station it stands at. Ingredients come from the bank first, then the bags, and results go to the bank, which every account character shares (1225 reads it and withdraws to the cursor). Success and skill-ups are the server's, so only craft replies measure them. Recipes are `C/data/tradeskill_recipe` and its entries: `iscontainer` rows name the allowed containers, `componentcount` the inputs and `successcount` the outputs.

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
- Raid mode attacks and casts only on NPCs above level 50 or enemies already engaged. The client refuses a raid attack command on any other NPC with "Select an NPC above level 50 or an already engaged enemy", refuses one with an empty roster ("Add raid members before attacking"), and blocks ordinary attacks and casts on lower NPCs while raid mode is active. AutoLevel is off in raid mode, so every fight starts from the NPC the leader targets in the current zone. The leader's level range is 46 to 60. Sources: `.re/js/main.pretty.js:22686-22687,50654-50656,72040-72059,72325-72341` and <https://idlequest.net/wiki/raiding>, "Getting started".
- A normal party has 6 characters including the active character. The client has no raid member limit. Recruitment checks eligibility (leader level 46 or higher), duplicate and loading characters and a combat lock, loads up to 4 recruits at a time, then appends the recruit. Recruits carry `cost: 0`. The raid catalog and the per-target budgets are never read: only a discarded Map is built from them. A server-side raid limit remains unverified. Do not state 54 or 72 as an established raid cap. Sources: <https://idlequest.net/wiki/overview>, "What is different from EverQuest?", and `.re/js/main.pretty.js:50644-50647,54135,64376,71544-71648`.
- Lower-level recruits retain their actual level. The wiki warns that raid spell and pet commands start at level 46, leaving lower-level caster support incomplete. Source: <https://idlequest.net/wiki/raiding>, "What is unfinished?".
- Recruits snapshot level, equipment, skills, and learned spells. Raid damage, mana, death, location, and supply usage do not mutate the original character's saved state. Remove and re-add to refresh equipment and spell snapshots. Source: <https://idlequest.net/wiki/raiding>, "How raid members work".
- The projection code additionally carries base stats, AA bonuses, quiver haste, deity, and carried click-item IDs. Sources: `.re/js/main.pretty.js:64145-64225`.
- The server answers the projection request (`GuildRaidCharacterProjectionRequest` 1194, `{ characterId }`) for any other character on the account, outside raid mode and with a level-1 active character, and refuses only the active character ("Your active character already leads the raid."). The snapshot holds base stats, AA bonuses, skills by id, equipped items with charges, scribed spell ids, click items and `experienceProgress` (current XP and the level's start and end). It is the way to read a companion's real stats, skills, gear and spells without signing in as it. Snapshots of all account characters are kept in `runs/state/projections/`.
- Ordinary support buffs remain after a recruited character dies. Bard songs require the Bard alive. Removing the recruit removes its support. Source: <https://idlequest.net/wiki/raiding>, "How raid members work".
- Recruits join as snapshots of real characters (`yQ`) and give raid buffs from the spells they have scribed (`QQ`). Duplicate buffs and weaker buffs of the same family do not stack. Only the leader adds its class's generated package (`n8`), so a Wizard leader gives every member a 700-point Spellshield rune, and the leader's class decides which package the raid gets. Sources: `.re/js/main.pretty.js:20210-20235,54123-54163,64332-64376,65539-65616,66113,66202-66259`.
- Kerafyrm (The Sleeper) is on the Raid Resolve list. His content spawn rows are `untargetable: 1` and his effective quest scripts under `C/effective/quests/` are empty files. On the live server his NPC definition is targetable but his spawn is `disabled` (raid roster plan, "Where a boss comes from"). Do not size a roster on him.

### Boss summons and daily allowance

The Resets tab provides 2 free boss summons per account in a rolling 24-hour period, shared across characters, with one kill per boss. Travel to the boss's zone, summon, then use Move & Attack. A new summon spends a reset. Resuming a saved boss or retrying a wipe does not. A private copy expires 24 hours after summoning. A listed boss has its own 24-hour kill cooldown beginning on death. The list of daily bosses comes from the server, so which bosses it offers is unverified. Sources: <https://idlequest.net/wiki/raiding>, "Daily raid resets", and the Resets panel text at `.re/js/engine.pretty.js:414960-414980`.

Casino boss potions do not spend those free resets. The wiki permits as many as the account has, but only 1 active casino boss at a time until it dies or expires. The client's casino potion table (`.re/releases/20261108T004644-064bc896/pretty/CAUokwED.js:4659-5085`) lists 30 bosses, among them Lord Yelinak, Vulak`Aerr, The Avatar of War, Tunare and the four Warders, but not Lord Vyemm, Cazic-Thule or Kerafyrm. It is not the daily list. Source: <https://idlequest.net/wiki/raiding>, "Daily raid resets".

The potions come from Fansy's Famous Casino (`/casino`, or `openGamblePane` on the UI store). Its Items prize unlocks at level 46 and plays Crown and Anchor: each die that shows the chosen symbol is a match. Two matches give a potion or a gem (50/50), three or more give one boss potion, and the account gets at most one boss potion per 24 hours (no prize during the cooldown). The panel's odds, read in the live client:

| Roll | Price | Two matches | Boss potion | Platinum per boss potion |
| --- | ---: | ---: | ---: | ---: |
| 3 dice | 15 pp | 6.94% | 0.463% | 3,240 |
| 6 dice | 210 pp | 20.09% | 6.229% | 3,371 |
| 9 dice | 600 pp | 27.91% | 17.826% | 3,366 |

A boss potion therefore costs about 3,300 pp on average, which adds a third boss a day to the two free resets. The potion and gem prizes are the classic stat, resist and rejuvenation potions and crushed gems. No Double Experience potion is among them. Using a boss potion sends `casinoPotion: true` with the item's instance and the character's id.

### Hourly price, and what "free" does not establish

The client displays a separate Raid Time purchase, priced per hour from the account's highest-level character. Time is shared account-wide and continues while offline. Auto-renew buys another hour only while raiding. Without it, the current fight can finish, but a new fight needs renewal. Source: `.re/js/engine.pretty.js:8870-8878,8934-8965`.

The server supplies `priceCopper`. The client validates and displays it, rather than computing a level-based price locally. Purchases log "one hour" and the server's `chargedCopper`. Source: `.re/js/main.pretty.js:70792-70848`.

The server quotes 2,000 platinum an hour with the highest character at level 7, 35, 41 and 46 (`RaidAccess` 1236 with `action: "status"`, which only reads the quote, `iq.raid.time()`), so the hearsay quote of 10,000 is not the tier at 46. An hour of raid time covers every kill of a day, the two free resets and a casino potion, so the price is small next to the income of several groups at 46 or higher.

The daily boss list (`DailyRaidBossesRequest` 1222, reply 1223, `{ characterId, zoneId }`, `iq.raid.bosses()`) answers "Daily raid bosses unlock at level 46." for a lower character. At 46 it offers ten bosses with two resets: Lord Nagafen (Nagafen's Lair), Lady Vox (Permafrost Keep), Phinigel Autropos (Kedge Keep), Trakanon (Old Sebilis), Venril Sathir (Karnor's Castle), Faydedar (Timorous Deep), Talendor (Skyfire Mountains), Gorenaire (Dreadlands), Innoruuk (Plane of Hate) and Cazic-Thule (Plane of Fear). Each is summoned from its own zone (`runs/state/daily-bosses.json`). Cazic-Thule is the only boss of the goal on it, so Tunare, the Avatar of War, Vulak`Aerr, Lord Yelinak and the four Warders come from casino potions or open-world spawns. Also, "two free summons" is not evidence that raid combat time is free. The sources expose separate summon and time mechanisms. Sources: <https://idlequest.net/wiki/raiding>, "Daily raid resets", `.re/js/main.pretty.js:70810-70848`.

### Raid Resolve

Against Cazic-Thule, Tunare, Avatar of War, Vulak`Aerr, Lord Vyemm, Lord Yelinak, Nanzata, Ventani, Tukaarak, Hraashna, and awakened Kerafyrm, raid Warriors, Paladins, and Shadow Knights receive double maximum HP and a full heal. Clerics receive double maximum mana and a full refill. It includes existing gear and buffs, applies to the leader and recruited members, and affects only living characters. It is 1 refill per fight, not resurrection or continuous regeneration. Multiple qualifying bosses do not stack it or grant more refills. Daily and casino copies qualify. Source: <https://idlequest.net/wiki/raiding>, "Raid Resolve". The client implements +100% maximum HP for class IDs 1, 3, and 5 and +100% maximum mana for class 2, and only when one of the listed NPC IDs with HP above 0 is in the fight. Source: `.re/js/main.pretty.js:22708-22745`. Kerafyrm cannot be targeted in the current content (see "Access, roster, and snapshots"), so his entry does nothing yet.

Recommendation: additional trained Clerics and tanks directly exploit the qualifying-encounter bonuses, but this is not a measured optimal roster composition. The source establishes the bonuses, not how many tanks or healers a particular account needs.

## 4. Platinum and income by level band

### What can be earned without other players

Platinum does not require player trading. The game supports defeated-enemy coin, NPC quest cash, remote explicit item sales, bulk Auto Sell, and explicit ingredient-bank Sell or Sell Stack. Sources: <https://idlequest.net/wiki/loot-and-inventory>, "What happens when your inventory fills" and "Automatic hand-downs and coin split", <https://idlequest.net/wiki/tradeskills>, "The ingredient bank", and `C/effective/quests/qeynos/Chesgard_Sydwen.lua:30-40`.

Coin Split changes distribution among same-account characters, not item ownership or XP. It is off by default and does not pay the built-in bots. Source: <https://idlequest.net/wiki/loot-and-inventory>, "Automatic hand-downs and coin split". Track total account coin when comparing camps so distribution is not mistaken for income.

### Best-supported candidates, not invented hourly rankings

Measured platinum is gross coin picked up per hour, taken from the analyzer's `coin gained` over `runs/2026-11-07-live` with purchases not subtracted and loot sales left out. The other rows are research-backed camp candidates. Planning bands below are recommendations, not unlock thresholds or a claim that each camp is the fastest possible platinum/hour.

| Planning band | First sources to compare | Concrete evidence | Platinum/hour status |
| --- | --- | --- | --- |
| 1-11 | Continue efficient leveling and vendor spare drops. Treat the measured rates as a baseline, not as the cap on income. | About 25 platinum/hour loose coin plus 1 platinum/hour sales at level 7 in the account diary (`diary/2026-11-06-d.md:31-35`), and about 60 platinum/hour gross coin at levels 8 to 11 in Steamfont Mountains. | Measured coin only. |
| 12-19 | Bronze-dropping Nybright sisters or Karana bandits with sash turn-ins. | Jayla is level 12 with 264 HP in both the local export and P99 page. Her exported loot table has 242-1,619 copper. The P99 page lists bronze weapons. `C/data/npc_types/b.ndjson:3492`, `C/data/loottable/e.ndjson:650`, `C/reference/p99-wiki/npc-pages/jayla-nybright-33c0f9d72f.wiki:11-21,33-45`. | Measured while leveling: about 65 platinum/hour gross coin at 12-15 in Crushbone, 220 to 230 at 15-19 in Kurn's Tower and Permafrost. The Nybright and sash camps are unmeasured. Sashes add a quantified reward per turn-in below. |
| 20-32 | Compare the existing bronze/sash route against new camps that actually drop fine-steel weapons. Do not abandon a productive camp solely for a higher mob level. | P99 fine-steel sale examples range from 5.2 to 6.7 platinum for the listed weapon types. These are P99 vendor observations, not IdleQuest quotes. `C/reference/p99-wiki/npc-pages/a-hill-giant-27a2b830b6.wiki:138-156`. | Measured while leveling: about 330 platinum/hour at 20-21 in City of Guk, 360 to 400 at 22-27 in Permafrost, 640 at 29-31 in Unrest and 860 at 31 in Solusek's Eye. Coin rose with the zone's enemy levels, so the leveling zones are already the coin camps in this band. No separate camp has been measured against them. |
| 33-45 | Hill giants are the strongest coin-first candidate in this sample. Compare spectres when their lower HP permits much faster kills. | An exported hill giant is level 36, 3,477 HP, with 704-52,567 copper. If cash were uniform between those bounds a giant would average about 27 platinum a kill, against roughly 4 to 6 platinum a kill measured at 29-31 (estimate, the cash distribution is not verified). An exported spectre is level 37, 1,739 HP, with 792-5,249 copper. `C/data/npc_types/2.ndjson:300,3.ndjson:2573`, `C/data/loottable/a.ndjson:670,b.ndjson:634`. | Unverified. Cash ranges are not averages or hourly returns. |
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

The selector renders 8 characters per page and at least 9 pages. Its page count is `Math.max(9, Math.ceil(characters.length / 8))`, so the visible minimum is 72 positions, with page count able to grow when the returned character list is larger. An empty position opens character creation. This is a UI affordance, not proof of a server-enforced 72-character limit. The raid roster plan lists 72 slots as resolved. Create a character on page 9 before relying on the 72 for a 36-character roster. Source: `.re/js/engine.pretty.js:1412-1449`.

A hard per-account creation cap is unverified. Neither the read wiki's Overview/Companions/Raiding articles nor the public Discord invite publishes one. Therefore, do not plan an exact maximum roster from either the normal-party size of 6 or the selector's 72 visible minimum positions. Sources inspected: <https://idlequest.net/wiki/overview>, <https://idlequest.net/wiki/companions>, <https://idlequest.net/wiki/raiding>, their Markdown at <https://idlequest.net/assets/DoZSjMzU.js:823-1054,1300-1403>, and <https://discord.com/invite/vH4GPChWKY>.

### Two sessions on one account

The wiki explains same-account companion progression and independent raid copies, but does not say whether several sessions may run different characters of one account at once. Three sessions do: each plays its own group in a visible relay tab signed in from the local login, and none disconnects the others ([raid roster](raid-roster.md#resolved-and-open-questions)). A hidden tab never finishes loading the game, so every session needs a visible tab. Sources: <https://idlequest.net/wiki/overview>, <https://idlequest.net/wiki/companions>, <https://idlequest.net/wiki/raiding>.

## 6. Experience boosts

- The patched client's spell data holds Double Experience (spell 62007): an XP bonus of 100% (SPA 337), 300 ticks, target type 41 (the group) with a range of 100 (`.re/releases/20261108T004644-064bc896/spells-DnHviMCR.json`). The potion that casts it is handed out as a reward for bug reports and the like, not obtainable in normal play, so the plans leave it out.
- The older boosts in the snapshot (Potion of Adventure 40605 and II 40994, Bottle of Adventure I and II 41961 and 41962, Bottle of Shared Adventure I and II 48083 and 48084, Elixir of Greater Learning 40893) use SPA 337 at 10% to 50%. No merchant list and no NPC loot table in the snapshot carries them.
- The casino's prizes and Olyna Mudel's potions in West Freeport hold no XP boost either.

## 7. Race

The roster is chosen for its final raid strength, so a race's XP factor does not decide it. What race changes, read in the live client (`.re/releases/20261108T004644-064bc896/pretty/OSTsR53r.js` unless named):

- Starting attributes. The live creation table is in `data/char-create.json`: a base row per race and class and the server's preset allocation of the class's bonus points (20 to 30). Attributes never grow with level, so after creation only gear, buffs and AAs raise them, up to 255 plus cap modifiers (`Bt` 21847-22200, `kL` 21065).
- HP is a class and level factor times STA, with STA above 255 counting half (`kD` 20565-20577). At level 46 a STA point is worth about 4 HP for a Warrior and 1.8 for a pure caster, about 6 and 2.7 at 60. Mana is INT for most casters and WIS for Clerics, Paladins, Rangers, Druids and Shamans, about 9 mana per point at 46 and 11 at 60 below 200 (`bD` 20578-20589). STR adds about 0.67 attack per point (`je` 16715-16718), AGI adds avoidance and AC (`xt` 16679-16684, `F6` 20762-20785), DEX adds Warrior and Ranger crit chance and weapon proc rate.
- Racial resists: at most 10 to 15 points apart against caps of 500 (`HD` 20800-20870).
- Iksar: natural AC equal to the level, clamped to 10 to 35 (`ID` 20590-20640), and slower martial arts as a Monk (`di` 21748-21757). Troll and Iksar regenerate 12 HP per tick at 60 against 4 for other races (`KF`, `0eakiHJI.js:20175-20182`). Barbarian, Troll and Ogre tanks bash without a shield (Slam, same damage as a bash, `rp` 62395-62398).
- Item restrictions: items carry a race and a deity mask (`B7YhzEJy.js:2309-2317`), and some sets are race-locked. Cultural armor quests need the matching race.
- Not in the client: Ogre frontal stun immunity, race bonuses to skills or skill caps, race size in combat, and the XP factor, which the server applies.
- Raid recruits go through the same stat function with their race (`bp` 64277-64292), and Raid Resolve is by class only.

`tools/raidsim.mjs` uses the creation table, so a roster entry's race changes the fight the way the client computes it.

## 8. Guilds

A guild of our own characters changes nothing in raids. The recruit list is every account character plus guild members (`f11`, `.re/js/main.pretty.js:70581-70603`), every recruit is built as a `guildCharacter` snapshot whatever its guild (`yQ` 64332-64376), and no raid code reads guild membership for buffs, the leader's class package, raid time, daily resets or the casino. The client has no guild bank, perks, buffs, tribute or hall: those names appear only in the opcode map. A guild has Leader, Officer and Member ranks, a message of the day, invites by character name and public notes (`.re/releases/20261108T004644-064bc896/pretty/CVEP2_Ra.js:418694-419075`). Each character accepts its own invite, and the guild name shows over every member. The creation fee and requirements are on the server and unknown. Recruiting other players' characters is the only thing a guild adds, and this account does not do that.

## 9. Other systems

From the live client (`CVEP2_Ra.js` unless named):

- Specializations (Abilities window, 408620-408830): a caster picks one school, and only that school trains past 50. Its skill lowers mana cost by `floor(baseMana * skill / 1870)`, about 10.7% at skill 200 (`.re/js/BQ.pretty.js:3558-3588`), from level 20 for Necromancers, Wizards, Magicians and Enchanters and from 30 for Clerics, Druids and Shamans. The panel belongs to the active character, so a companion's school is chosen while signed in as it. Reset drops the school to 49. The raid code does not read the skill, so it helps leveling, not raids [inferred from `.re/js/main.pretty.js`].
- Saved Groups (414637-414870): a party saved in this browser's local storage and recruited with one click from an empty party outside combat.
- Recharge merchants (Maslow in the East Commonlands tunnel): refill a click item's charges for a fee (wiki, loot-and-inventory).
- Free practice: casting trains undertrained schools by up to 5 points per cast until 80% of the cap, and meditating trains Meditate out of combat (wiki, autolevel).
- Minor or none for account strength: fishing and foraging, coin wagers at the casino, name changes, pizza, trade and auction commands. There is no paid shop, no achievements or login rewards, and no offline progress.
- Off-hand slot (`.re/releases/20261108T004644-064bc896/pretty/`): a one-handed weapon (item types 0, 2, 3 and 36) goes into the secondary slot only for a character with Dual Wield skill 1 or more ("You cannot dual wield without the dual wield skill.", `B7YhzEJy.js:2357-2380`), and none goes in beside a two-handed weapon. Once there, any off-hand item with damage swings on its own delay with no further roll (`kc`, `DFjfiI7e.js:6029-6045`, `7215-7237`). A shield (item type 8) adds its AC and lets a Warrior, Paladin or Shadow Knight bash, which Barbarian, Troll and Ogre tanks of those classes do without one (`Vs`, `DFjfiI7e.js:6532-6535`). An off-hand item with neither damage nor AC, such as a rod, does nothing in combat. Which gives a tank's group more XP per hour, the off-hand weapon's damage or the shield's AC and bash, is not measured.

## Five highest-value actions

1. Keep the six own-character party leveling and buy missing merchant spells deliberately. The documented party supports persistent companion XP, and the raid command set starts at 46. Do not substitute default bots for roster progress. Sources: <https://idlequest.net/wiki/experience-and-zones>, <https://idlequest.net/wiki/companions>, "Buying companion spells", and <https://idlequest.net/wiki/raiding>, "What is unfinished?".
2. Establish a measured platinum route before buying raid time. Compare account-wide coin plus actual vendor proceeds against expenses, using the gross coin measured at levels 8 to 31 as the baseline and the raid price read at level 46 as the cost. Hill giants, ice giants, and the sash quest have concrete coin evidence, but no higher-level hourly winner is verified. Sources: `diary/2026-11-06-d.md:29-35`, `C/data/loottable/a.ndjson:670,e.ndjson:594`, and `C/effective/quests/qeynos/Chesgard_Sydwen.lua:30-40`.
3. Craft for an explicit missing benefit, not speculative resale. Start by pricing the low-trivial INT/WIS rings and needed research scrolls. Avoid funding high-trivial jewelry on an unverified profit claim. Sources: `C/data/tradeskill_recipe/7.ndjson:1299,f.ndjson:1254,c.ndjson:1271,a.ndjson:1238` and <https://idlequest.net/wiki/tradeskills>.
4. Build tank and Cleric depth for the named endgame bosses, then refresh raid recruits after gearing or learning spells. Raid Resolve doubles tank HP and Cleric mana, while roster snapshots do not automatically become the original character's latest equipment and spell state. At each leveling band, use the live roster to identify weak slots, then `tools/gear.mjs --party` and `tools/drops.mjs` to find realistic replacements. Prioritize repeatable drops and verify rare-spawn availability before pausing leveling to camp. Source: <https://idlequest.net/wiki/raiding>, "Raid Resolve" and "How raid members work".
5. Prepare the roster, location, and target before paying for a raid hour: raid mode only fights an NPC above level 50 that the leader targets in the current zone, with AutoLevel off. Use the account's two daily summons deliberately and avoid leaving paid account time idle offline. Keep AA purchases and further character creation conditional on the server's actual catalog, quote, and limits rather than assumed EQ rules. Sources: <https://idlequest.net/wiki/raiding>, "Daily raid resets", `.re/js/main.pretty.js:72040-72059`, `.re/js/engine.pretty.js:8870-8878,8934-8965,408215-408249,1412-1417`.
