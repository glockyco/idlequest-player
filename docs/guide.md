# Progression guide

How to take this account from new characters to a raid roster without repeating the first group's mistakes. It is written for whoever starts the next group, agent or person. The current hunting plan for group 1 is in [plans/leveling-plan.md](plans/leveling-plan.md), and the measurements behind each rule are in the diary.

IdleQuest recreates classic EverQuest through Velious, so classic guides such as the P99 wiki, Almar's and EQProgression are a good first source for zones, camps, spells and quests. Treat what they say as a candidate and confirm it with the IdleQuest wiki, the content snapshot or a measured run before relying on it, because IdleQuest changes XP sharing, buffs, cures and much of the automation.

## Plan the raid roster first

Raids open at level 46 and recruit characters from the account roster, so the unit that matters is the roster, not a single party (<https://idlequest.net/wiki/raiding>). The built-in Warrior, Rogue and Cleric bots are not raid recruits. Leveling groups are how the roster gets built, and their make-up follows from what the raid needs:

- Raid Resolve doubles the HP of Warriors, Paladins and Shadow Knights and the mana of Clerics once per fight against the named raid bosses (`.re/js/main.pretty.js:22711-22740`). More tanks and Clerics therefore add more than more of other classes. The counts per boss in [plans/raid-roster.md](plans/raid-roster.md) are planning ranges, not measured requirements.
- Raid members' buffs do not stack. A second copy of a buff, or a weaker spell of the same family, adds nothing (`.re/js/main.pretty.js:20210-20235`), so one member with the spell scribed covers each buff line. Which classes cover which lines is in the raid roster plan. Extra members of a class earn their place through damage, healing or tanking, not buffs.
- Kill XP is split by character level (fit to 114 kills), so a group levels best when its members are at the same level. The wiki adds that a character must stay close to the group's highest member to get XP at all: at least a five-level gap, or a highest member no more than about one and a half times its level (<https://idlequest.net/wiki/experience-and-zones#group-experience>, not checked in the client). A low character in a high group therefore gets a small share or none, which only makes sense for a short errand.
- Each leveling group still has to hunt on its own: a tank, a healer, damage, and slow or crowd control if possible.
- A second session can play a second party at the same time ([raid roster](plans/raid-roster.md#resolved-and-open-questions)). Ask before starting one. Without it, groups level one after another: finish group 1's levels that matter for raids before starting the next group, or level the next group while group 1 waits for raid resets.

The current roster, the raid sizes per boss, the proposed groups 2 to 6 and the open questions are in [plans/raid-roster.md](plans/raid-roster.md).

## Build a leveling group

- Use six account characters. The free Warrior, Rogue and Cleric bots count as group members and take XP shares, but they are not account characters, they follow their own level-based gear schedule and they cannot join a raid (<https://idlequest.net/wiki/companions>).
- Create all six at once and level them together. Group 1's companions joined at level 5 and took their share from then on.
- The character you log in with leads. Its automation casts only its memorized spells, while companions cast from their whole learned spellbook (<https://idlequest.net/wiki/autolevel#spell-and-melee-choices>). What the bot keeps memorized for the leader is described in `AGENTS.md` under the `levelUp` alert. A raid leader adds its class package instead of its spells ([raid roster](plans/raid-roster.md)).
- Race and class change the XP a level costs, and the two factors combine: Troll and Iksar 1.20, Ogre 1.15, Barbarian 1.05, Halfling 0.95, Warrior 0.90, Rogue 0.91, everyone else 1.00 (<https://idlequest.net/wiki/experience-and-zones#race-and-class-requirements>). A Halfling Warrior needs 0.855 of the normal XP. Pick the race for the role the roster needs. The factor only moves a level's cost between 0.855 and 1.2.

## Hand over from an earlier group

A new group does not have to start empty. Before switching leaders (<https://idlequest.net/wiki/companions#handing-down-equipment>):

1. Put spare gear, a weapon for each melee character, food and drink and the new leader's pet reagents in a bag marked No Sell and No Declutter.
2. Give the items to the new characters with Give Held Item (`iq.giveItem`), whole bags included. The wiki requires the recipient to be offline and not recruited, and says to remove a recruited character first. The client itself only checks that the recipient is a character on the account (`docs/client-internals.md`), so giving to a recruited member is unverified. A LORE conflict rejects the transfer.
3. Recruit the new characters. Scrolls in the shared Spell Bank teach them while they are in the party, one scroll per character, checked every five seconds.
4. Run Buy Companion Spells for the remaining merchant spells. It spends the active character's carried money.
5. After switching, Inventory Search on the macro bar can pull gear from other characters' bags and banks, and Manage Money pulls another character's whole balance.

## Kit for new characters

New characters start with no weapon equipped and with their eight general slots full of starter items, which the client does not show for companions. Kit every member before the first hunt:

1. Coin: Manage Money (`iq.manageMoney({ transferFrom })`) moves an earlier character's whole balance to the new leader.
2. Free the general slots: enter the world as each new character (`iq.switchCharacter`), sell what sells, and pack the rest (starter food, the note, the starred starter weapon and bandages, which cannot be sold) into the starter `Backpack*`. Starter spell scrolls are already scribed.
3. Weapons: buy one per member from a weapons merchant and give it with `iq.giveItem(name, member, true)`. Tyeg Envil in West Freeport sells a Two Handed Sword (22 pp, Paladin and other plate melee) and a Warhammer (6 pp, Cleric, Druid, Shaman). Nothing there fits a Necromancer. The merchant item's class bits are in `item.classes`.
4. Bags: disable the bot first (`iq.setBot({ enabled: false })`), because its cleanup sells a surplus Backpack, and a bag cannot go inside a bag, so each purchase needs a free top-level slot. Buy one Backpack, give it with `iq.giveItem("Backpack", member, false)`, and repeat until the member reports a full inventory. Check a purchase by the inventory, not the last chat line, because the food auto-buy writes chat in between. Enable the bot again afterwards.

## First hour of a new group

These settings worked for group 1. Treat them as a starting point and change them when a measurement says so.

1. Options, General: turn Auto-Upgrade Companions on, because it is off by default. Auto-Upgrade, Keep Epic Quest Items, Keep Valuable Gear and Keep Pet Reagents are on by default and Death XP Loss is off by default, so check that nobody changed them (`.re/js/main.pretty.js:189308-189352`).
2. Tactics: turn off nukes and DoTs for the support casters (Cleric, Shaman, Enchanter). At about level 6 that made group 1 30 to 45% faster in two measurements, because the whole party waits for their mana between fights. The measurements were at low levels, so re-check as mana pools grow. The model agrees at level 29, where a Cleric or Enchanter nuke lowers XP per hour by 7 to 8% (`bun tools/predict.mjs --level 29 --spells`, model only).
3. Turn off cures for the support casters. The readiness wait holds the whole party until every cure or dispel cast has finished, and a dispel succeeds with 32% plus 7% per level the caster is above the effect's caster, or minus 2% per level below (`docs/client-internals.md`). Against a same-level caster the weaker dispels mostly fail, so an Enchanter's Cancel Magic on a Snare can hold the party until the Snare wears off. The bot turns cures on between fights only for a root that would outlast the expected dispel time by `dispelMinSavedSec`, and back off afterwards. Check `analyze.mjs`'s "Between pulls" lines before turning cures back on for good.

   `iq.applyRoleTactics()` sets steps 2 and 3 for the whole party. It treats a Druid like a Shaman and turns off a Paladin's cures as for the Bard, which group 1 has not measured.
4. AutoLevel: the client default is Blue through White with no level cap. Group 1 ran Blue through Red (`minCon` 4, `maxCon` 13, which the client pairs with a cap of 5 levels above the leader) with the guard on, which is its default. The only comparison behind that is one 4 to 5 minute block per setting at level 9, so treat it as a hint. Where enemies root the party, the readiness wait stands still until the root wears off, 25 seconds on average and over a minute at times. Skip the root casters as targets with the bot's `avoidNames`, for example `iq.setBot({ avoidNames: "shaman|idealist" })` for the froglok shamans in the City of Guk, which had cost about a tenth of the time there. They can still join a fight.
5. Attach the bot and save the group in it: `iq.setBot({ partyIds: [...] })`. It keeps AutoLevel on, brings the companions back after a sign-in, sells surplus loot, and refreshes the leader's gems and pet for any class (see `AGENTS.md`).

## Where to hunt

Rates are the leader's XP per hour while AutoLevel ran, taken per character level and zone from the recorded runs of group 1 (`runs/2026-11-06-tox-ab`, `runs/2026-11-07-live`, local only) for levels with at least 10 minutes in a zone. The samples record whether the tab was visible, and whether a hidden tab is slower is unproven ([leveling plan](plans/leveling-plan.md)), so compare like with like.

| Levels | Zone (multiplier) | Measured | Notes |
| --- | --- | --- | --- |
| 3-5 | Toxxulia Forest (1.00) | 37k-121k | Levels 1 and 2 are not in the recorded runs. Go to a full group as soon as possible. |
| 5-7 | Greater Faydark (1.00) | 79k-156k | Few targets are left at 7: XP fell to about 70k with half the time spent walking. |
| 8-11 | Steamfont Mountains (1.00) | 152k-279k | White to Red, up to three levels above, gave 351k against 201k for Blue to Yellow, one 4 to 5 minute block each. |
| 11-14 | Crushbone (1.19) | 208k-394k | Other players hunt the same orcs and leave AutoLevel waiting for spawns at times. |
| 15-17 | Kurn's Tower (1.28) | 0.87M-1.03M | Burynai excavators cast Root on the party. By 18 most kills were level 12 to 15. |
| 18-19 | Permafrost Caverns (1.44) | 1.47M-1.54M | |
| 20-21 | The City of Guk (1.19) | 1.55M-1.66M | Froglok shamans cast Root about once a minute. A level-30 froglok tsu shaman caused 16 guard escapes at 20. |
| 22-27 | Permafrost Caverns (1.44) | 1.75M-2.46M | The stock of in-band enemies shrinks as the party levels. |
| 28 | Lair of the Splitpaw (1.28) | 2.32M | Permafrost fell to 1.72M the same level. |
| 29-31 | The Estate of Unrest (1.13) | 2.04M-2.59M | Level 31 has only 10 minutes recorded. |

The bot's band rows (`data/band-rotations.json`) choose the zones at every level, and the leveling plan gives the evidence for each row. Below level 22 the rows put the Warrens first on the model's ranking, which group 1 never visited, so its first visit is the check.

Avoid at these levels, from guard events and deaths in the same runs: Blackburrow at 5 (a level-15 gnoll high shaman joined a fight and killed the leader), the City of Guk at 12 (21 guard escapes from froglok warriors, knights and shamans of level 22 to 27) and Permafrost at 28 (189 guard escapes from ice giants of level 47 to 50 and a giant wooly spider).

## Deciding where to hunt and what to do

No fixed rule says when to stay, move or do something else. Weigh what moves the account forward fastest over the next hours, try it, measure it and write down why.

Progress comes in several forms:

- XP for every roster character, weighed by how far each one is from the levels that matter: 46 for raids, the next epic step, the next spell or pet tier.
- Items that make later work faster: a weapon or haste item that speeds every kill for many levels, a click item with a permanent buff, instruments, epic components, gear to hand to the next group.
- Platinum for spells, AA ranks and raid time.
- Knowledge: a scouting trip or short trial that settles a question for every later group.

Against that stand the costs and risks:

- Deaths and wipes cost time, and an unattended death can end the run. Accept more risk while someone watches than overnight.
- Travel, setup, and the attention a camp needs.
- Uncertain payoffs, such as a rare item with a low drop or spawn chance.

No signal decides alone. Read them together: XP per hour and kills per minute in labelled blocks, the share of time spent waiting for enemies, recovering or walking, guard escapes, the lowest HP in fights, deaths, loot value, which enemies get pulled, and the time of day.

Some trade-offs we have met or expect:

- A crowded zone can still be the best choice. Another zone that pays a tenth less but has no competition can win, and so can a wider target range in the same zone. Crowds come and go with the time of day.
- A rare worth farming: estimate the expected hours to get it from drop chance, spawn chance and respawn time, the XP given up meanwhile, and what it saves afterwards. A weapon that speeds every kill for twenty levels can be worth hours of slower XP. Spawn Camp follows one spawn through its respawn cycle and does not make the next roll of a rare certain (<https://idlequest.net/wiki/autolevel#enemy-targets-and-spawn-camp>).
- A harder zone: XP per kill grows with the square of the enemy's level and a kill gives a character at most 11% of its level's requirement, but a much harder fight is not automatically better XP per minute (<https://idlequest.net/wiki/experience-and-zones#which-kills-give-experience>). Try it while someone watches, with the guard on, and fall back when it escapes or someone dies.
- An epic or quest errand close to the current zone is cheapest done on the way. Run it with `iq.errand({ zone, keep, item })`: the bot pulls only enemies whose names match `keep`, holds the rotation until `item` is in the leader's inventory, the party leaves the zone, the guard escapes repeatedly or 40 minutes pass (`minutes`), and then rotates on. Pass `minCon: 2` for green enemies, which give no XP.
- For unattended hours, prefer the zone with the steadiest rate and the fewest escapes over the one with the best peak. This is a rule of thumb, not measured.

Whatever the choice, label the block, compare it with the one before, and record the reasoning and the result in the diary, so the next decision starts from evidence.

## At every level-up

- Missing merchant spells are bought by the bridge's spell chore when the game's reminder appears and by the bot's upkeep after a level-up.
- The bot fills the leader's gems with the best learned spell of each role that the client lets the leader cast, and replaces a pet made by an older summon. A living pet is kept when its owner levels (<https://idlequest.net/wiki/companions#pets-and-healing>), so without a replacement the pet stays at its old tier. Companions' pets are replaced for every owner class once they fall `petGap` levels behind.
- Check whether the new level changes the best use of the next hours, as described under "Deciding where to hunt and what to do".

## Gear and items

- Before farming or buying a weapon, check `analyze.mjs`'s "Damage by source" lines: a weapon upgrade speeds kills only by its owner's share of the damage. Pets dealt about 40% of group 1's damage at level 20 and 39% at level 30, which is why the pet tier matters more than any weapon.
- Check weapons yourself: Auto-Upgrade compares item haste first and then a class-based score (<https://idlequest.net/wiki/loot-and-inventory#automatic-upgrades>), so its weapon choices do not follow damage over delay, and it left the tank with a slower weapon than the Cleric's. Compare weapons with `tools/gear.mjs`, which uses the level's damage cap, and give a better one with `iq.giveItem`.
- Auto-Upgrade Companions equips loot that suits a companion, but class and race restrictions still apply: Legionnaire's Bracer cannot be worn by Dwarves, Halflings or Gnomes (item 2299, `races` 62335 in the content snapshot).
- A Bard's songs use instruments, and a weapon that replaces an instrument can cost the support (<https://idlequest.net/wiki/choosing-weapons>). Give an instrument with `iq.giveItem(name, "Ugfeu")`. Which instrument types the songs need is in the leveling plan.
- Beneficial click effects have no expiry in IdleQuest, so a click item is a lasting buff unless a dispel, a stronger buff or a rune ends it. Item charges and reuse timers still apply (<https://idlequest.net/wiki/loot-and-inventory#clicky-buffs>).
- Keep Valuable Gear keeps every duplicate, and most loot is single copies of cheap weapons, so the game's Auto Sell frees little. When fewer than `minFreeSlots` slots are free the bot banks ingredients with Auto Bank, then sells extra copies and cheap single items (see the inventory rules in `AGENTS.md`).

## Mistakes to avoid

- Asking a question and waiting for the answer while the party plays: AutoLevel stayed off or the loot was lost for hours.
- Leaving an item on the cursor: a backpack held there took eight slots out of play and the loot stayed on corpses.
- Old spells: the active character casts only memorized spells and a living pet keeps its tier, so a new spell or pet tier sits unused until it is memorized or the pet is replaced.
- Picking a zone by target density alone, without looking at the stronger monsters nearby.
- Reloading or navigating the game tab: the login session lives in page memory, so it needs a new sign-in.

## Decisions to revisit

| When | Revisit |
| --- | --- |
| Every level-up | Zone band, AutoLevel limits, new spells and pet tier. |
| New support spells, such as Clarity, slows or better heals | Whether support casters should nuke or cure again. |
| Deaths or HP dips from poison or disease | Turning cures back on for one healer. |
| `crowded` alert or falling kills per minute | Whether the drop is real and worth a move within the level band. |
| Level 46 | AA allocation, raid unlock and the raid time price, epic steps. |
| New login message or wiki article | Events, new mechanics and prizes. |
| New game client release | The client refresh steps in the README, under "Rules for contributors". |
