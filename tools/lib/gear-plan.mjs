// The roster gear plan: which carried item each account character should wear, from an Inventory
// Search survey of the whole account. Pure: it gets the survey, the items' content rows and the
// characters, and returns the moves (pull from the holder, give equipped to the receiver) and the
// items that are an upgrade for someone, which nothing may sell. tools/iqd.mjs runs it in the
// coordinator and queues the moves as a gear task (`iqBot.gear`), tools/handdown.mjs prints it.
//
// Every gain is in tenths of a percent of the wearer's group's XP rate (`xpGain`): what armor and
// jewelry add to the wearer's melee and spells (`outputValue` in tools/lib/gear-data.mjs), weighed by
// its measured share of the party's damage, and what they save the party, with the client's caps on haste and
// regeneration. The main hand is ranked by `weaponRatio` (damage capped at the level's limit over delay,
// the client's flat main-hand bonus and proc damage), for Monks too, whose fists a weapon replaces (docs/client-internals.md,
// Melee damage). A Rogue's main hand stays a piercer for Backstab, and a two-handed weapon is
// offered only to a character with nothing in the off hand.
//
// The off hand (docs/client-internals.md, Off hand and dual wield) takes a shield for its stats, or
// for a class with Dual Wield at its level a one-hander that swings with the chance `offhandChance`,
// so its worth is that chance times the weapon's ratio. Never beside a two-hander. A weapon never
// replaces a shield or an instrument, whose worth is in stat points and not comparable, and a
// shield never replaces a weapon.
import { copyHours, elasticity } from "./acquire.mjs";
import { BIT, CLASS_KEYS, MELEE_SHARE, RACE, SLOT_BY_NUM, groupOf, offhandChance, outputValue, slotName, weaponRatio } from "./gear-data.mjs";

export const ARMOR_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 17, 18, 19, 20];
export const PRIMARY = 13;
export const SECONDARY = 14;
export const TWO_HANDED = new Set([1, 4, 35]);
// Item types a character with Dual Wield may hold in the off hand.
const OFFHAND_WEAPONS = new Set([0, 2, 3, 36]);
const SHIELD = 8;
const PIERCING = 2;
/** Whether a content row is a lore item, one per character: any `loregroup` (-1 for the item alone), the lore flag, or a lore text marked "*". */
export const isLore = (i) => Boolean(i && ((i.loregroup ?? 0) !== 0 || i.loreflag || String(i.lore ?? "").startsWith("*")));
// A Monk's fists by level (`di` in the client, docs/client-internals.md, Off hand and dual wield):
// the levels at which the damage and the delay change, the damage, and the delay of every race but
// Iksar and of Iksar, which gets each delay step one level step later.
const FIST_LEVELS = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 53, 56, 59, 60];
const FIST_DAMAGE = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 14, 14, 14, 14];
const FIST_DELAY = [36, 36, 36, 36, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26];
const FIST_DELAY_IKSAR = [36, 36, 36, 36, 36, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27];
/** What an empty hand swings (`YL` and `di`): a Monk's fists by `race` (lower case name) and level, 1 damage at 36 delay for other classes. */
export const fists = (cls, level, race) => {
  if (cls !== "monk") return { damage: 1, delay: 36 };
  let k = FIST_LEVELS.length - 1;
  while (k > 0 && level < FIST_LEVELS[k]) k--;
  return { damage: FIST_DAMAGE[k], delay: (race === "iksar" ? FIST_DELAY_IKSAR : FIST_DELAY)[k] };
};
// The weapon type each class's main hand must keep.
const MAIN_HAND_TYPE = { rogue: PIERCING };
/**
 * Platinum one gear pass may spend at merchants: what the account earned in the hour before it
 * (`platPerHour` of every group, the pass runs hourly), less the raid budget's share of that hour,
 * so purchases spend income and the standing coin stays for raids (`docs/plans/gear-acquisition.md`).
 * `rows` are `bun tools/groups.mjs --json` rows, `raidPpPerDay` the raid budget.
 */
export const buyBudget = (rows, raidPpPerDay) => Math.max(0, rows.reduce((s, r) => s + (r.platPerHour ?? 0), 0) - raidPpPerDay / 24);
/**
 * How much of the party's XP rate one percent of a member's melee or spell damage is worth: the XP
 * elasticity at its level times its measured share of the party's damage (`p.shares`, from
 * `damageShares`), or for a member not measured yet its class's melee share (`MELEE_SHARE`) of one
 * sixth of the party.
 */
export const damageWeights = (p) => {
  const e = elasticity(p.level);
  const m = MELEE_SHARE[groupOf(p.cls)] ?? 0;
  const s = p.shares ?? { melee: m / 6, spell: (1 - m) / 6 };
  return { melee: e * s.melee, spells: e * s.spell };
};
/** A gain by channel (`outputValue`'s `{ melee, spells, party }`) in tenths of a percent of the party's XP rate. */
export const xpGain = (ch, p) => {
  const w = damageWeights(p);
  return w.melee * ch.melee + w.spells * ch.spells + ch.party;
};
/** A weapon's gain: the change in its melee value over what it swings now, as a melee percent weighed like armor's. */
const meleeGain = (delta, now, p) => (now > 0 ? (damageWeights(p).melee * 1000 * delta) / now : 0);

// Item kinds for Inventory Search, which matches names anywhere and lists at most 200 rows.
const KINDS = ["Bracer", "Ring", "Mask", "Cloak", "Cape", "Boots", "Shoes", "Gloves", "Gauntlets", "Helm", "Cap", "Robe", "Tunic", "Breastplate", "Leggings", "Pants", "Sleeves", "Vambraces", "Belt", "Girdle", "Earring", "Necklace", "Amulet", "Choker", "Shield", "Sword", "Dagger", "Staff", "Mace", "Axe", "Spear", "Bow", "Hammer", "Club", "Wand", "Mantle", "Shoulder", "Collar", "Veil", "Band", "Stud", "Armor", "Coif", "Skullcap", "Wristband", "Greaves", "Jerkin", "Shirt", "Hood", "Scimitar", "Blade", "Rapier", "Flail", "Warhammer", "Knife", "Fist", "Totem", "Idol", "Charm", "Medallion", "Pendant", "Bandolier", "Sash", "Gorget", "Brooch", "Torque", "Circlet", "Crown"];
/** Search words for the carried items: the item kinds and every name part of four letters or more of the worn items, whose relatives are carried. */
export function surveyWords(names) {
  const parts = names.flatMap((n) => String(n ?? "").split(/[^A-Za-z]+/)).filter((w) => w.length >= 4);
  return [...new Set([...KINDS, ...parts].map((w) => w.toLowerCase()))];
}
/**
 * One survey from the parties' own inventories (`inventoryInPage` in tools/iqd.mjs: every worn item
 * of every character in a party, and the leaders' bags) and Inventory Search rows (the companions'
 * carried items). Worn rows come from the parties only, because they are complete there. Inventory
 * Search lists carried items inside bags only, so a leader's item loose in a general slot is missing
 * from it and cannot be pulled: such a row gets a `blockReason`, which keeps it out of the moves.
 */
export function mergeSurvey(party, searched) {
  const reach = new Set(searched.map((r) => `${r.characterId}:${r.itemInstanceId}`));
  const seen = new Map();
  for (const r of party) seen.set(`${r.characterId}:${r.itemInstanceId}`, r.location === "Carried" && !reach.has(`${r.characterId}:${r.itemInstanceId}`) ? { ...r, blockReason: "Not in Inventory Search." } : r);
  for (const r of searched.filter((r) => r.location === "Carried")) seen.set(`${r.characterId}:${r.itemInstanceId}`, r);
  return [...seen.values()];
}

/**
 * A plan (`{ moves, characters }` of `planGear`) without what it decided blind: `unread` names the
 * characters whose party the pass could not read, whose worn rows are those of the pass before and
 * miss what its gear task equipped since. No move goes to or from them, and their sheet and score
 * stay as last known (`last`, `{ sheets, characters }` of the stored plan), so no slot of theirs
 * reads as a change. On 2026-11-12 a pass ran while two groups' bots were paused for their upkeep:
 * it put Embrogg's Charred Guardian Breastplate back over the Bear Skins of Rage of the hour before
 * and reported the Large Ringmail Bracelet he had sold as worn over his Golden Bracer.
 */
export function withoutUnread({ moves, characters }, unread, last = {}) {
  const known = (c) => (unread.has(c.name) ? last.sheets?.[c.name] : null);
  return {
    moves: moves.filter((m) => !unread.has(m.to) && !unread.has(m.from)),
    characters: characters.map((c) => (known(c) ? { ...c, ...(last.characters?.find((p) => p.name === c.name) ?? {}), slots: known(c) } : c)),
  };
}

/** The roster characters of a survey, with class and level from its rows and race from `raceOf` (name to race name). */
export function rosterPeople(survey, groupOf, raceOf) {
  const people = new Map();
  for (const r of survey) if (groupOf.has(r.characterName)) people.set(r.characterName, { name: r.characterName, cls: CLASS_KEYS[r.class], level: r.level, race: String(raceOf.get(r.characterName) ?? "").toLowerCase().replace(/[^a-z]/g, "") });
  return [...people.values()];
}

/** The value of a set of worn armor and jewelry for a person (`{ cls, level, pool?, recovery?, shares? }`), in `xpGain`'s unit. */
export const setValue = (items, p) => xpGain(outputValue(items, p.cls, p.level, { pool: p.pool, recovery: p.recovery }), p);

/**
 * Each member's share of its party's damage, melee and spells apart, from `bun tools/groups.mjs
 * --json` rows (`damage`, the lines the bridge tagged by source). A group counts once its tagged
 * lines span `minMinutes` of play, since one zone's or one fight's mix says little, and then a
 * member without a line of its own has a share of 0. `members` maps each group to its members'
 * names. Returns a Map of name to `{ melee, spell }`.
 */
export function damageShares(rows, members, minMinutes = 60) {
  const out = new Map();
  for (const r of rows) {
    const d = r.damage;
    if (!(d?.total > 0) || !(d.minutes >= minMinutes)) continue;
    for (const name of members.get(r.group) ?? []) out.set(name, { melee: (d.melee?.[name] ?? 0) / d.total, spell: (d.spell?.[name] ?? 0) / d.total });
  }
  return out;
}

/**
 * Each character's part in its group's recovery, from `bun tools/groups.mjs --json` rows: the
 * recovery share of the group's time times the share of the waits its mana bar held the party
 * (`limiters`, "me" the leader), with the supply's mana regeneration, as `outputValue`'s
 * `recovery`. Waits on HP count in the total but give no member a share, since mana regeneration
 * does not shorten them. Returns a Map of name to `{ share, regen }`.
 */
export function recoveryShares(rows) {
  const out = new Map();
  for (const r of rows) {
    const total = Object.values(r.limiters ?? {}).reduce((a, b) => a + b, 0);
    if (!(total > 0) || !(r.recover > 0)) continue;
    for (const [key, sec] of Object.entries(r.limiters)) {
      const [who, bar] = key.split(":");
      if (bar !== "mana") continue;
      out.set(who === "me" ? r.leader : who, { share: (r.recover * sec) / total, regen: r.supportManaRegen ?? 0 });
    }
  }
  return out;
}

// A Bard's percussion modifier sets its run song (Selo's Accelerando), which the party supply
// applies while everyone is full, the walk to the next pull (docs/client-internals.md, Bard
// instruments). Its other supplied songs gain little from an instrument at these levels: brass
// songs start at 42, strings only raise Hymn's HP regeneration, and mana regeneration and haste
// never scale.
const PERCUSSION = 26;
/** Whether an item is an instrument the party supply takes from the bags: `itemtype` equal to a strings, brass or percussion `bardtype`. */
export const bagInstrument = (i) => [24, 25, 26].includes(i?.bardtype) && i.itemtype === i.bardtype && i.bardvalue > 0;
/** A Bard's percussion modifier (10 to 36): the best worn percussion or all-instrument item, or percussion instrument in the bags. */
export function percussionMod(worn, bags = []) {
  const best = Math.max(10, ...worn.filter((i) => i?.bardtype === PERCUSSION || i?.bardtype === 51).map((i) => i.bardvalue ?? 0), ...bags.filter((i) => bagInstrument(i) && i.bardtype === PERCUSSION).map((i) => i.bardvalue));
  return Math.min(36, best);
}
/**
 * What a percussion modifier is worth, in `xpGain`'s unit, against none: the share of the group's
 * time spent moving (`walk.share`) times the walking time a faster party saves.
 * The party walks at 1 + run speed / 100, where the run speed is the other supplied speed
 * (`walk.other`, percent) plus the run song's (`walk.selo`, percent at modifier 10) times mod / 10.
 */
export function walkValue(mod, walk) {
  if (!walk || !(walk.share > 0)) return 0;
  const speed = (m) => 100 + (walk.other ?? 0) + ((walk.selo ?? 0) * m) / 10;
  return 10 * 100 * walk.share * (1 - speed(10) / speed(mod));
}
/**
 * Each Bard's walk, from `bun tools/groups.mjs --json` rows: the group's move share, and from the
 * leader's snapshot the party's run speed and the Bard's run song (`runSpeed: { total, bard: { name,
 * level, mod, spellId } }`). `seloAt(spellId, level)` gives the song's run speed at modifier 10.
 * Returns a Map of the Bard's name to `{ share, other, selo }`.
 */
export function walkShares(rows, seloAt) {
  const out = new Map();
  for (const r of rows) {
    const b = r.runSpeed?.bard;
    if (!b || !(r.move > 0) || r.runSpeed.total == null) continue;
    const selo = seloAt(b.spellId, b.level);
    if (!(selo > 0)) continue;
    out.set(b.name, { share: r.move, other: r.runSpeed.total - (selo * b.mod) / 10, selo });
  }
  return out;
}

/**
 * The slots of the paper doll in the order of EverQuest's inventory window: the left column, the
 * right column, then the hands, the ammo and the charm. Slot 21 is the ammo slot.
 */
export const DOLL_SLOTS = [1, 5, 3, 2, 6, 7, 8, 9, 10, 11, 4, 15, 16, 17, 12, 20, 18, 19, 13, 14, 21, 0];
const slotLabel = (n) => SLOT_BY_NUM[n] ?? "ammo";
const round1 = (x) => Math.round(x * 10) / 10;

/** One person's entry of `planGear`'s `characters`. */
function characterReport(p, { wornRows, worn, scoreNow, moves, wants, items, value }) {
  const lastMove = new Map(moves.map((m) => [m.slotNum, m]));
  const wanted = new Map(wants.map((w) => [w.slotNum, w]));
  const target = new Map(worn);
  for (const w of wants) target.set(w.slotNum, items.get(w.itemId));
  const afterMoves = value(p, worn);
  return {
    name: p.name,
    cls: p.cls,
    level: p.level,
    score: { now: round1(scoreNow), moves: round1(afterMoves), target: round1(Math.max(afterMoves, value(p, target))) },
    slots: DOLL_SLOTS.map((n) => {
      const m = lastMove.get(n);
      const w = wanted.get(n);
      return {
        slotNum: n,
        slot: slotLabel(n),
        worn: wornRows.get(n) ?? null,
        move: m ? { itemId: m.itemId, item: m.item, from: m.from, gain: m.gain, replaces: m.replaces, ...(m.buy ? { buy: m.buy } : {}) } : null,
        drop: w ? { itemId: w.itemId, item: w.item, zone: w.zone, npc: w.npc, hours: w.hours, gain: w.gain } : null,
      };
    }),
  };
}

/**
 * The facts of an item row that the dashboard's tooltip shows, without the zeros: name, icon file
 * number, the slots, classes and races as bit masks, AC, HP, mana, stats, resists, damage and delay,
 * and the flags the client prints (NO DROP is `nodrop` 0, LORE any `loregroup`, MAGIC `magic` 1).
 */
export function itemCard(i) {
  const out = { id: i.id, name: i.Name, icon: i.icon ?? 0, slots: slotName(i.slots ?? 0), classes: i.classes ?? 0, races: i.races ?? 0, reqlevel: i.reqlevel ?? 0, type: i.itemtype ?? 0 };
  const put = (k, v) => v && (out[k] = v);
  for (const k of ["ac", "hp", "mana", "endur", "astr", "asta", "aagi", "adex", "awis", "aint", "acha", "mr", "fr", "cr", "dr", "pr", "attack", "haste", "regen", "manaregen", "damage", "delay", "weight", "bardtype", "bardvalue", "damageshield", "avoidance", "accuracy"]) put(k, i[k]);
  const flags = [];
  if (i.nodrop === 0) flags.push("NO DROP");
  if (isLore(i)) flags.push("LORE");
  if (i.magic === 1) flags.push("MAGIC");
  if (i.artifactflag) flags.push("ARTIFACT");
  if (flags.length) out.flags = flags;
  return out;
}

/** Whether `item` may be worn in `slot` by a person (`{ cls, level, race? }`, `cls` and `race` as `BIT` and `RACE` name them): slot, class, race and level, and not a bag. */
export const fits = (item, p, slot) =>
  item && item.slots & (1 << slot) && !(item.bagslots > 0) && item.classes & BIT[p.cls] && (!p.race || !RACE[p.race] || item.races & RACE[p.race]) && (item.reqlevel ?? 0) <= p.level;

/**
 * `survey`: rows of `iq.searchAccount()` (`characterName`, `itemId`, `itemName`, `itemInstanceId`,
 * `location` "Equipped" with its `slot`, or "Carried", and `blockReason`). `items`: item id to its
 * content row. `people`: the roster characters, `[{ name, cls, level, race, pool?, recovery?, walk?, shares? }]`
 * with `cls` a gear-data class key, `walk` a Bard's (`walkShares`) and `shares` its damage shares
 * (`damageShares`). `minGain`: the smallest gain
 * worth a move. `shop`: merchant goods, `[{ itemId, merchant, zone, price }]`
 * with the price in platinum, which count as copies without end; the plan buys at most `buyPp`
 * platinum in one pass and only in one zone, so one trip serves a pass. `drops`: items enemies drop,
 * `[{ itemId, zone, npc, npcLevel, hours, spawn, drop, points, respawn }]` with `hours` the expected
 * hunting per copy, which become wants for every character they would serve. `copyValue(w)` weighs
 * a wanted copy for ranking the enemies, the acquisition model's `copyValue` (tools/lib/acquire.mjs),
 * and by default its gain. `killsPerHour`, the account's typical kill rate, bounds the hours per
 * copy of a common drop (`copyHours`).
 * Returns `{ moves: [{ item, itemId, from, to, slot, slotNum, gain, replaces, buy? }], keep: { counts:
 * { [itemId]: copies }, instances: [itemInstanceId] }, drops: [{ item, itemId, to, slot, gain, zone, npc, hours }],
 * targets: [{ zone, npc, rate, firstHours, items }] }`,
 * where a Bard's instrument for the party supply moves to slot "bags" (`slotNum` null), given
 * without equipping it, and `targets` ranks the enemies by the value an hour of hunting them brings
 * (`rankTargets`), with every character's slot it serves in `items`,
 * where a move with `buy: { merchant, zone, price }` buys its item first. `keep` is what the bots
 * must not sell: the copies this pass's moves take, the copies it buys, and for an item the account
 * holds no free copy of, as many copies as characters would still gain from one after the moves,
 * which covers the drops. A copy beyond that demand is surplus.
 * `epics` lists the class epics characters still lack, each `{ rewardId, to, pieces: [{ itemId, name,
 * sources }] }` with the pieces a hunt gets that the account does not hold and their drop rows
 * (`huntPieces` in tools/lib/epic-model.mjs). Each piece is worth the reward's gain to `to`, shared by
 * the pieces it lacks, and its sources join the targets with `slot` "epic", not the per-slot
 * `drops`. A target keeps its hardest enemy's level and hit points and, in `also`, the enemies a
 * chain of deaths brings, which its hunt kills too, with each enemy's own fights in `fights`. `unworn` lists items no move puts on, the
 * pieces a quest hands in, since a hand-in takes them from the bags.
 * `drops` lists for each character the best drop per slot that beats what it wears after the moves
 * by `2 * minGain`, the dropped items worth hunting for. Every gain, of armor and of weapons, is in
 * `xpGain`'s unit, tenths of a percent of the wearer's group's XP rate, and `minGain` is 0.05% of it.
 * `characters` has one entry per person for the dashboard, `{ name, cls, level, score: { now, moves,
 * target }, slots: [{ slotNum, slot, worn, move, drop }] }`: the set score of the armor and jewelry
 * worn now (`setValue`, a weapon for its stats, plus a Bard's walk value), after this pass's moves, and after the moves and every wanted drop; and for each
 * of the 22 slots of the paper doll (`DOLL_SLOTS`) the item worn now (`{ itemId, name }`), the last
 * move to it (`{ itemId, item, from, buy?, gain, replaces }`) and its wanted drop (`{ itemId, item,
 * zone, npc, hours, gain }`).
 */
export function planGear({ survey, items, people, minGain = 0.5, shop = [], buyPp = 0, drops = [], epics = [], unworn = new Set(), copyValue = (w) => w.gain, killsPerHour = 0 }) {
  const byName = new Map(people.map((p) => [p.name, p]));
  const worn = new Map(people.map((p) => [p.name, new Map()]));
  const owned = new Map(people.map((p) => [p.name, new Set()]));
  // The instruments in each Bard's bags, which the party supply uses.
  const bags = new Map(people.filter((p) => p.cls === "bard").map((p) => [p.name, []]));
  for (const r of survey) {
    owned.get(r.characterName)?.add(r.itemId);
    if (r.location === "Equipped") worn.get(r.characterName)?.set(r.slot, items.get(r.itemId) ?? null);
    else if (r.location === "Carried" && bagInstrument(items.get(r.itemId))) bags.get(r.characterName)?.push(items.get(r.itemId));
  }
  // A Bard's own bag instruments serve it where they are, so they are not free to move.
  const free = survey.filter((r) => r.location === "Carried" && (!r.blockReason || r.blockReason === "Already on this character.") && items.has(r.itemId) && !(bags.has(r.characterName) && bagInstrument(items.get(r.itemId))));
  const goods = shop.filter((s) => items.has(s.itemId) && s.price <= buyPp).map((s) => ({ characterName: null, itemId: s.itemId, itemName: items.get(s.itemId).Name, itemInstanceId: `shop:${s.itemId}`, buy: s }));

  // A character's worn items by the set score, a weapon for its stats as well, since its swings
  // count apart (`meleeGain`), plus for a Bard the walk its percussion instrument, worn or in the
  // bags, speeds up.
  const value = (p, mine, bag = bags.get(p.name) ?? []) => setValue([...mine].filter(([s]) => ARMOR_SLOTS.includes(s) || s === PRIMARY || s === SECONDARY).map(([, i]) => i), p) + (p.cls === "bard" ? walkValue(percussionMod([...mine.values()], bag), p.walk) : 0);
  // What one copy is worth to one character in one slot, against what it wears now.
  const offer = (r, p) => {
    const item = items.get(r.itemId);
    if (unworn.has(r.itemId)) return [];
    // A lore item is one per character, so a second copy is refused.
    if (isLore(item) && r.characterName !== p.name && owned.get(p.name).has(r.itemId)) return [];
    const mine = worn.get(p.name);
    const out = [];
    const gainIn = (slot) => value(p, new Map([...mine, [slot, item]])) - value(p, mine);
    for (const slot of ARMOR_SLOTS) {
      if (!fits(item, p, slot) || item.damage > 0) continue;
      const gain = gainIn(slot);
      if (gain >= minGain) out.push({ r, p, slot, gain });
    }
    // A Bard carries an instrument for the party supply in its bags, where it costs no hand.
    if (p.cls === "bard" && bagInstrument(item) && r.characterName !== p.name) {
      const gain = value(p, mine, [...(bags.get(p.name) ?? []), item]) - value(p, mine);
      if (gain >= minGain) out.push({ r, p, slot: "bags", gain });
    }
    const held = mine.get(PRIMARY) ?? null;
    const offHeld = mine.get(SECONDARY) ?? null;
    const chance = offhandChance(p.cls, p.level);
    const fist = fists(p.cls, p.level, p.race);
    // A Monk's empty off hand swings a fist beside any main hand but a two-hander, with the
    // off-hand chance, and a weapon in the off hand or a two-hander ends it.
    const off = { primary: false };
    const offSwing = (main, offItem) => (offItem ? chance * weaponRatio(offItem, p.cls, p.level, off) : p.cls === "monk" && !TWO_HANDED.has(main?.itemtype) ? chance * weaponRatio(fist, p.cls, p.level, off) : 0);
    // Beside a two-hander the off hand stays empty.
    if (!TWO_HANDED.has(held?.itemtype) && fits(item, p, SECONDARY)) {
      // A shield counts for its stats and replaces no weapon.
      if (item.itemtype === SHIELD && !(offHeld?.damage > 0)) {
        const gain = gainIn(SECONDARY);
        if (gain >= minGain) out.push({ r, p, slot: SECONDARY, gain });
      }
      // A one-hander counts for its stats and its swings, with the chance that they happen, and
      // replaces only a weapon or nothing.
      if (chance > 0 && OFFHAND_WEAPONS.has(item.itemtype) && item.damage > 0 && item.delay > 0 && (!offHeld || offHeld.damage > 0)) {
        const gain = gainIn(SECONDARY) + meleeGain(chance * weaponRatio(item, p.cls, p.level, off) - offSwing(held, offHeld), weaponRatio(held ?? fist, p.cls, p.level) + offSwing(held, offHeld), p);
        if (gain >= minGain) out.push({ r, p, slot: SECONDARY, gain, weapon: true });
      }
    }
    // A main hand counts for its stats and its swings against the one it replaces, so a caster
    // keeps a main hand worn for its stats unless the new one's stats and swings beat it.
    if (fits(item, p, PRIMARY) && item.damage > 0 && item.delay > 0 && (!MAIN_HAND_TYPE[p.cls] || item.itemtype === MAIN_HAND_TYPE[p.cls]) && (!TWO_HANDED.has(item.itemtype) || !mine.get(SECONDARY))) {
      const gain = gainIn(PRIMARY) + meleeGain(weaponRatio(item, p.cls, p.level) + offSwing(item, offHeld) - weaponRatio(held ?? fist, p.cls, p.level) - offSwing(held, offHeld), weaponRatio(held ?? fist, p.cls, p.level) + offSwing(held, offHeld), p);
      if (gain >= minGain) out.push({ r, p, slot: PRIMARY, gain, weapon: true });
    }
    return out;
  };
  const sources = () => [...free, ...goods];
  // What each character wears before the moves, for the per-character report.
  const wornNow = new Map(people.map((p) => [p.name, new Map(worn.get(p.name))]));
  const wornRows = new Map(people.map((p) => [p.name, new Map(survey.filter((r) => r.location === "Equipped" && r.characterName === p.name).map((r) => [r.slot, { itemId: r.itemId, name: r.itemName }]))]));
  const scoreNow = new Map(people.map((p) => [p.name, value(p, wornNow.get(p.name))]));

  let offers = sources().flatMap((r) => people.flatMap((p) => offer(r, p)));
  // The items the account holds that are an upgrade for someone, whose demand is checked again
  // after the moves.
  const candidates = new Set(offers.filter((o) => !o.r.buy).map((o) => o.r.itemId));
  const bought = new Map();
  const keepInstances = new Set();

  // Greedy by gain: the best offer is taken, its copy and the receiver's slot are spent, and the
  // receiver's other offers are scored again against the set it now wears. Armor and weapons share
  // one unit, and only items without damage count as armor. An item on the account wins a tie with
  // a merchant's, and a merchant's copies never run out, while the platinum and the one zone of a
  // pass do.
  const moves = [];
  const spent = new Set();
  let budget = buyPp;
  let zone = null;
  const key = (r) => `${r.characterName}:${r.itemInstanceId}`;
  const affordable = (o) => !o.r.buy || (o.r.buy.price <= budget && (zone == null || o.r.buy.zone === zone));
  const top = (list) => list.reduce((a, o) => (!a || o.gain > a.gain || (o.gain === a.gain && a.r.buy && !o.r.buy) ? o : a), null);
  for (offers = offers.filter(affordable); offers.length; offers = offers.filter(affordable)) {
    const best = top(offers);
    const { r, p, slot, gain } = best;
    const toBags = slot === "bags";
    const replaced = toBags ? null : (worn.get(p.name).get(slot) ?? null);
    // A gear task pulls the item to its tab's leader first, which a leader carrying a lore copy
    // already refuses, so the move names the characters that carry one.
    const loreHolders = isLore(items.get(r.itemId)) ? [...owned].filter(([n, ids]) => n !== r.characterName && ids.has(r.itemId)).map(([n]) => n) : [];
    // A weapon for either hand that replaces a worn one has to be placed (`exact`): a give that
    // equips carries no slot, and the server puts such a weapon into the empty hand, else over the
    // weapon it ranks lower, whatever the plan meant (docs/client-internals.md, "Account-wide sharing
    // rules"). The receiver wears it in the planned hand while it is the active character.
    const exact = !toBags && Boolean(replaced) && [PRIMARY, SECONDARY].includes(slot) && Boolean(fits(items.get(r.itemId), p, PRIMARY) && fits(items.get(r.itemId), p, SECONDARY));
    moves.push({ item: r.itemName, itemId: r.itemId, from: r.characterName, to: p.name, slot: toBags ? "bags" : SLOT_BY_NUM[slot], slotNum: toBags ? null : slot, gain: Math.round(gain * 100) / 100, replaces: replaced?.Name ?? null, ...(exact ? { exact } : {}), ...(loreHolders.length ? { loreHolders } : {}), ...(r.buy ? { buy: { merchant: r.buy.merchant, zone: r.buy.zone, price: r.buy.price } } : {}) });
    if (r.buy) {
      budget -= r.buy.price;
      zone = r.buy.zone;
      bought.set(r.itemId, (bought.get(r.itemId) ?? 0) + 1);
    } else {
      spent.add(key(r));
      keepInstances.add(r.itemInstanceId);
    }
    if (toBags) bags.get(p.name).push(items.get(r.itemId));
    else worn.get(p.name).set(slot, items.get(r.itemId));
    owned.get(p.name).add(r.itemId);
    offers = offers.filter((o) => !spent.has(key(o.r)) && o.p.name !== p.name);
    for (const f of sources()) if (!spent.has(key(f))) offers.push(...offer(f, byName.get(p.name)));
  }
  // Characters who would still take a virtual copy after the moves mean the account is short of the
  // item, because a free copy would have been moved: that many looted copies are kept until the next pass.
  const virtual = (itemId) => ({ characterName: null, itemId, itemName: items.get(itemId).Name, itemInstanceId: `drop:${itemId}` });
  // What each character would take of one copy, computed once per item: the drops list an item for
  // every enemy that drops it, about 18 rows per item across the live zones.
  const offersOf = new Map();
  const offersFor = (itemId) => offersOf.get(itemId) ?? offersOf.set(itemId, people.map((p) => [p, offer(virtual(itemId), p)])).get(itemId);
  const takers = (itemId) => offersFor(itemId).filter(([, o]) => o.length > 0).length;
  const counts = {};
  for (const [id, n] of bought) counts[id] = n;
  for (const id of new Set([...candidates, ...drops.filter((d) => items.has(d.itemId)).map((d) => d.itemId)])) {
    const n = takers(id);
    if (n > 0) counts[id] = Math.max(counts[id] ?? 0, n);
  }
  // The drops worth hunting for, against what each character wears after this pass.
  const want = new Map();
  const wantSlot = new Map();
  // Each enemy's wanted drops, every item with every character slot it would serve (`rankTargets`).
  const byTarget = new Map();
  for (const d of drops) {
    if (!items.has(d.itemId)) continue;
    const r = virtual(d.itemId);
    for (const [p, offers] of offersFor(d.itemId)) {
      for (const o of offers) {
        if (o.gain < 2 * minGain) continue;
        const k = `${p.name}:${o.slot}`;
        // Hours per copy at the account's typical kill rate (`copyHours`), and the respawns' bound
        // alone (`respawnHours`), from which the coordinator takes each group's own kill rate.
        const entry = { item: r.itemName, itemId: d.itemId, to: p.name, slot: o.slot === "bags" ? "bags" : SLOT_BY_NUM[o.slot], gain: Math.round(o.gain * 100) / 100, zone: d.zone, npc: d.npc, hours: Math.round(100 * copyHours(d, d, killsPerHour)) / 100 };
        const best = want.get(k);
        if (!best || o.gain > best.gain || (o.gain === best.gain && entry.hours < best.hours)) {
          want.set(k, entry);
          wantSlot.set(k, o.slot);
        }
        const tk = `${d.zone}|${d.npc}`;
        // The taker's level and the enemy's level, spawn chance per point, points, respawn and time
        // of day, and the item's drop chance, for weighing a camp or a visit (tools/lib/acquire.mjs).
        (byTarget.get(tk) ?? byTarget.set(tk, { zone: d.zone, npc: d.npc, npcLevel: d.npcLevel ?? null, npcHp: d.npcHp ?? null, spawn: d.spawn ?? null, points: d.points ?? null, respawn: d.respawn ?? null, when: d.when ?? null, offers: [] }).get(tk)).offers.push({ ...entry, respawnHours: d.hours, level: p.level, drop: d.drop ?? null, key: k });
      }
    }
  }
  for (const e of epics) {
    const p = people.find((x) => x.name === e.to);
    if (!p || !items.has(e.rewardId) || !e.pieces.length) continue;
    const gain = Math.max(0, ...offer(virtual(e.rewardId), p).map((o) => o.gain));
    if (gain < 2 * minGain) continue;
    const share = Math.round((gain / e.pieces.length) * 100) / 100;
    for (const piece of e.pieces) {
      for (const d of piece.sources) {
        const k = `${p.name}:epic ${piece.itemId}`;
        const entry = { item: piece.name, itemId: piece.itemId, to: p.name, slot: "epic", gain: share, zone: d.zone, npc: d.npc, hours: Math.round(100 * copyHours(d, d, killsPerHour)) / 100 };
        const tk = `${d.zone}|${d.npc}`;
        const t = byTarget.get(tk) ?? byTarget.set(tk, { zone: d.zone, npc: d.npc, npcLevel: null, npcHp: null, spawn: d.spawn ?? null, points: d.points ?? null, respawn: d.respawn ?? null, when: d.when ?? null, offers: [] }).get(tk);
        t.npcLevel = Math.max(t.npcLevel ?? 0, d.npcLevel ?? 0) || null;
        t.npcHp = Math.max(t.npcHp ?? 0, d.npcHp ?? 0) || null;
        t.also = [...new Set([...(t.also ?? []), ...(d.also ?? [])])];
        t.fights ??= d.fights;
        t.offers.push({ ...entry, respawnHours: d.hours, level: p.level, drop: d.drop ?? null, ...(d.kills != null ? { kills: d.kills } : {}), key: k });
      }
    }
  }
  return { moves, keep: { counts, instances: [...keepInstances] }, drops: [...want.values()], targets: rankTargets(byTarget, copyValue), characters: people.map((p) => characterReport(p, { wornRows: wornRows.get(p.name), worn: worn.get(p.name), scoreNow: scoreNow.get(p.name), moves: moves.filter((m) => m.to === p.name), wants: [...want].filter(([, w]) => w.to === p.name).map(([k, w]) => ({ ...w, slotNum: wantSlot.get(k) })), items, value }) ) };
}

// The further takers of an item a target lists, for the copies of groups that hunt it at one time.
const OTHER_TAKERS = 3;

/**
 * The enemies worth hunting for gear, best first. A kill yields one copy, which serves one
 * character, so each item counts once, at the best of its takers, and each character slot once, at
 * the item that pays most there per hour: items are given to slots in the order of `copyValue` over
 * hours per copy. An enemy's `rate` is the value an hour of hunting it brings, the sum of each item's
 * value over its hours per copy, since each drop rolls on its own, with `takers` the characters each
 * item would serve, `others` the next `OTHER_TAKERS` of them, each at its best slot and best first,
 * and `firstHours` the hours until the first copy drops.
 */
function rankTargets(byTarget, copyValue) {
  return [...byTarget.values()]
    .map((t) => {
      const rate = (w) => copyValue(w) / w.hours;
      const usedItems = new Set();
      const usedSlots = new Set();
      const items = [];
      for (const w of [...t.offers].sort((a, b) => rate(b) - rate(a))) {
        if (usedItems.has(w.itemId) || usedSlots.has(w.key)) continue;
        usedItems.add(w.itemId);
        usedSlots.add(w.key);
        const { key, ...rest } = w;
        const same = t.offers.filter((o) => o.itemId === w.itemId);
        const others = [];
        for (const o of [...same].sort((a, b) => rate(b) - rate(a))) {
          if (o.to === w.to || others.some((x) => x.to === o.to) || others.length >= OTHER_TAKERS) continue;
          others.push({ to: o.to, slot: o.slot, gain: o.gain, level: o.level });
        }
        items.push({ ...rest, takers: new Set(same.map((o) => o.to)).size, ...(others.length ? { others } : {}) });
      }
      const copies = items.reduce((s, w) => s + 1 / w.hours, 0);
      return { zone: t.zone, npc: t.npc, npcLevel: t.npcLevel, npcHp: t.npcHp, spawn: t.spawn, points: t.points, respawn: t.respawn, when: t.when, also: t.also ?? [], ...(t.fights ? { fights: t.fights } : {}), rate: items.reduce((s, w) => s + rate(w), 0), firstHours: Math.round(100 / copies) / 100, items };
    })
    .filter((t) => t.rate > 0)
    .sort((a, b) => b.rate - a.rate);
}
