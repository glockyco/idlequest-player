# Progression guide

How to take this account from new characters to a raid roster without repeating the first group's mistakes. It is written for whoever starts the next group, agent or person. The current hunting plan for group 1 is in [plans/leveling-plan.md](plans/leveling-plan.md), and the measurements behind each rule are in the diary.

IdleQuest recreates classic EverQuest through Velious, so classic guides such as the P99 wiki, Almar's and EQProgression are a good first source for zones, camps, spells and quests. Treat what they say as a candidate and confirm it with the IdleQuest wiki, the content snapshot or a measured run before relying on it, because IdleQuest changes XP sharing, buffs, cures and much of the automation.

## Plan the raid roster first

The raid list ends with Kerafyrm, so the unit that matters is the raid roster, not a single party. Leveling groups are how the roster gets built, and their make-up follows from what the raid needs:

- Raid tanking and healing scale with numbers. Raid Resolve doubles the HP of Warriors, Paladins and Shadow Knights and the mana of Clerics once per fight, so the roster wants several of each.
- The raid shares one set of permanent support and drops duplicates of the same buff, so one Bard, Shaman, Enchanter, Druid and Necromancer serve the whole raid. Duplicate classes earn their place through damage, healing or tanking, not buffs.
- Kill XP is split by character level, so a group levels best when its members are at the same level. A low character in a high group gets a small share and levels slowly, so that only makes sense for a short errand, not as a way to catch up.
- Each leveling group still has to hunt on its own: a tank, a healer, damage, and slow or crowd control if possible.
- One session plays one party at a time until a second session is shown to work, so groups level one after another. Finish group 1's levels that matter for raids before starting the next group, or level the next group while group 1 waits for raid resets.

The current roster, the raid sizes per boss, the proposed groups 2 to 6 and the open questions are in [plans/raid-roster.md](plans/raid-roster.md).

## Build a leveling group

- Use six account characters. The free Warrior, Rogue and Cleric bots take XP shares and do not level or gear up.
- Create all six at once and level them together. Group 1's companions joined when the Magician was level 5 and took their share from then on.
- The character you log in with leads. It casts only its memorized spells, while companions cast from their whole spellbook. A pet class or a melee class needs the least care as leader. The bot's spell upkeep knows Magician spells only.
- Race and class change the XP a level costs: Troll and Iksar 1.20, Ogre 1.15, Barbarian 1.05, Halfling 0.95, Warrior 0.90, Rogue 0.91, everyone else 1.00 (<https://idlequest.net/wiki/experience-and-zones#race-and-class-requirements>).

## Hand over from an earlier group

A new group does not have to start empty. Before switching leaders (<https://idlequest.net/wiki/companions#handing-down-equipment>):

1. Put spare gear, a weapon for each melee character, food and drink and the new leader's pet reagents in a bag marked No Sell and No Declutter.
2. Recruit the new characters to the old leader. Give items with Give Held Item (`iq.giveItem`), whole bags included. A recipient must not be recruited by another leader.
3. Leave scrolls the new characters need in the shared Spell Bank. It teaches them while they are in the party, one scroll per character.
4. Run Buy Companion Spells with the old leader's money for the remaining merchant spells.
5. After switching, Inventory Search on the macro bar can pull gear from other characters' bags and banks, and Manage Money pulls another character's whole balance.

Halfling lowers the XP a Warrior, Rogue, Cleric or Druid needs (Halfling Warrior 0.855 of normal). A missing raid role usually costs more later than cheaper levels save, so pick the race after the role.

## First hour of a new group

These settings worked for group 1. Treat them as a starting point and change them when a measurement says so.

1. Options, General: Auto-Upgrade and Auto-Upgrade Companions on, Keep Epic Quest Items, Keep Valuable Gear and Keep Pet Reagents on. Check that Death XP Loss is off.
2. Tactics: turn off nukes and DoTs for the support casters (Cleric, Shaman, Enchanter). That made group 1 about 40% faster at level 6, because the whole party waits for their mana between fights.
3. Turn off cures for the support casters. The readiness wait holds the whole party while any cure or dispel is still being cast, and dispels against same-level or higher casters mostly fail (see `docs/client-internals.md`), so an Enchanter's Cancel Magic on a Snare can hold the party until the Snare wears off. The bot turns cures on between fights only for a root that would outlast the expected dispel time by `dispelMinSavedSec`, and back off afterwards. Check `analyze.mjs`'s "Between pulls" lines before turning cures back on for good.
4. AutoLevel targets blue through red (con 4 to 13), at most five levels above the leader, with the guard on. Where enemies root the party, the readiness wait stands still until the root wears off, about 25 to 45 seconds a time. Skip them as targets with the bot's `avoidNames`, for example `iq.setBot({ avoidNames: "shaman|idealist" })` for the froglok shamans in Guk, which cost about a tenth of the time there. They can still join a fight.
5. Attach the bot and save the group in it: `iq.setBot({ partyIds: [...] })`. It keeps AutoLevel on, brings the companions back after a sign-in, sells surplus loot and refreshes the leader's spells and pet.

## Where to hunt

Rates are XP per hour for group 1, measured with the analyzer. The late-evening and morning blocks ran with the tab visible, the night blocks probably did not, so compare like with like.

| Levels | Zone (multiplier) | Measured | Notes |
| --- | --- | --- | --- |
| 1-5 | Toxxulia Forest | 43k-125k | Starting area for the Erudite. Go to a full group as soon as possible. |
| 5-7 | Greater Faydark | 96k-193k | Runs dry at 7: XP fell to about 70k with half the time spent walking. |
| 7-11 | Steamfont Mountains | 190k-350k | Best with targets white to red, up to three levels above. |
| 11-15 | Crushbone (1.19) | 205k-560k | Busy when other players hunt the same orcs. |
| 15-18 | Kurn's Tower (1.28) | 0.9M-1.1M | Burynai excavators root the tank, a short wait each time. |

Avoid at these levels: Blackburrow at 5 (a level-15 gnoll shaman joined a fight and killed the leader) and Upper Guk at 12 (the guard kept fleeing from level-22 to 27 froglok warriors). The zone candidates beyond level 18 are in the leveling plan.

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
- A rare worth farming: estimate the expected hours to get it from drop chance, spawn chance and respawn time, the XP given up meanwhile, and what it saves afterwards. A weapon that speeds every kill for twenty levels can be worth hours of slower XP. Spawn Camp follows a rare spawn, but a death there gets no automatic restart.
- A harder zone: XP per kill grows with the square of the enemy's level, so a zone above the band can pay more if the party holds. Try it while someone watches, with the guard on, and fall back when it escapes or someone dies.
- An epic or quest errand close to the current zone is cheapest done on the way. Run it with `iq.errand({ zone, keep, item })`: the bot pulls only enemies whose names match `keep`, holds the rotation until the item is in the bags or 40 minutes pass, and then rotates on. Pass `minCon: 2` for green enemies.
- For unattended hours, the zone with the steadiest rate and the fewest escapes usually beats the one with the best peak.

Whatever the choice, label the block, compare it with the one before, and record the reasoning and the result in the diary, so the next decision starts from evidence.

## At every level-up

- Missing merchant spells are bought by the bridge's spell chore for the leader and the companions.
- The bot memorizes the best summon, two nukes and the pet heal, and replaces a pet made by an older summon. A living pet is kept when its owner levels, so without this the pet stays at its old tier.
- Check whether the new level changes the best use of the next hours, as described under "Deciding where to hunt and what to do".

## Gear and items

- Before farming or buying a weapon, check `analyze.mjs`'s "Damage by source" lines: a weapon upgrade speeds kills only by its owner's share of the damage. Pets dealt over 40% of group 1's damage at level 20, which is why the pet tier matters more than any weapon then.
- Check weapons yourself: Auto-Upgrade's weapon choices do not follow damage over delay, and it left the tank with a slower weapon than the Cleric's. Compare weapons with `tools/gear.mjs`, which uses the level's damage cap, and give a better one with `iq.giveItem`.
- Auto-Upgrade Companions equips loot that suits a companion, but it checks race: the Dwarves and the Gnome cannot wear Legionnaire's Bracers.
- Bard instruments work only while equipped. Give one with `iq.giveItem(name, "Ugfeu")`. One copy of each instrument type is enough.
- Beneficial click effects never expire in IdleQuest, so a click item is a permanent buff.
- Keep Valuable Gear keeps every duplicate, and most loot is single copies of cheap weapons, so the game's Auto Sell frees little. When fewer than eight slots are free the bot banks ingredients with Auto Bank, then sells extra copies and cheap single items (see the inventory rules in `AGENTS.md`).

## Mistakes to avoid

- Asking a question and waiting for the answer while the party plays: AutoLevel stayed off or the loot was lost for hours.
- Leaving an item on the cursor: a backpack held there took eight slots out of play and the loot stayed on corpses.
- Old spells: the Magician fought with a level-1 nuke for 5 damage and a level-9 pet at level 14.
- Picking a zone by target density alone, without looking at the stronger monsters nearby.
- Reloading or navigating the game tab: the page keeps no login, so it needs a new sign-in.

## Decisions to revisit

| When | Revisit |
| --- | --- |
| Every level-up | Zone band, AutoLevel limits, new spells and pet tier. |
| New support spells, such as Clarity, slows or better heals | Whether support casters should nuke or cure again. |
| Deaths or HP dips from poison or disease | Turning cures back on for one healer. |
| `crowded` alert or falling kills per minute | Whether the drop is real and worth a move within the level band. |
| Level 46 | AA allocation, raid unlock and the raid time price, epic steps. |
| New login message or wiki article | Events, new mechanics and prizes. |
| New game client release | Rerun `tools/extract-opcodes.ts` and check that the bridge and bot still install. |
