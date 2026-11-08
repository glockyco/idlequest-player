// The roster gear plan: which carried item each account character should wear, from an Inventory
// Search survey of the whole account. Pure: it gets the survey, the items' content rows and the
// characters, and returns the moves (pull from the holder, give equipped to the receiver) and the
// items that are an upgrade for someone, which nothing may sell. tools/iqd.mjs runs it in the
// coordinator and queues the moves as a gear task (`iqBot.gear`), tools/handdown.mjs prints it.
//
// Armor and jewelry are scored as a set with tools/lib/gear-data.mjs's stat score, because the
// client counts only the highest worn haste and caps worn regeneration at 15 HP and 15 mana per
// tick. The main hand is ranked by base damage, capped at the level's limit, over delay, as
// tools/raidsim/kits.mjs does, for Monks too, whose fists a weapon replaces (docs/client-internals.md,
// Melee damage). A Rogue's main hand stays a piercer for Backstab, and a two-handed weapon is
// offered only to a character with nothing in the off hand.
import { BIT, CLASS_KEYS, HASTE_WEIGHT, OFFHAND_WEIGHT, RACE, REGEN_WEIGHT, SLOT_BY_NUM, statScore, weaponRatio } from "./gear-data.mjs";

export const ARMOR_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 17, 18, 19, 20];
const PRIMARY = 13;
const SECONDARY = 14;
const REGEN_CAP = 15;
const TWO_HANDED = new Set([1, 4, 35]);
const PIERCING = 2;
// What an empty main hand swings (`YL` and `di` in the client, docs/client-internals.md): Monk fists
// gain a point of damage every five levels, from 4 to 14 at 50, at 36 delay that falls to 26 by
// 60, and other classes hit for 1 at 36.
const fists = (cls, level) => (cls === "monk" ? { damage: Math.min(14, 4 + Math.floor(level / 5)), delay: level < 25 ? 36 : Math.max(26, 35 - Math.floor((level - 25) / 4)) } : { damage: 1, delay: 36 });
// The weapon type each class's main hand must keep.
const MAIN_HAND_TYPE = { rogue: PIERCING };
/** A main hand must beat the worn one by this much damage per delay to be worth a move. */
export const MIN_RATIO_GAIN = 0.03;

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
 * carried items). Worn rows come from the parties only, because they are complete there.
 */
export function mergeSurvey(party, searched) {
  const seen = new Map();
  for (const r of [...party, ...searched.filter((r) => r.location === "Carried")]) seen.set(`${r.characterId}:${r.itemInstanceId}`, r);
  return [...seen.values()];
}

/** The roster characters of a survey, with class and level from its rows and race from `raceOf` (name to race name). */
export function rosterPeople(survey, groupOf, raceOf) {
  const people = new Map();
  for (const r of survey) if (groupOf.has(r.characterName)) people.set(r.characterName, { name: r.characterName, cls: CLASS_KEYS[r.class], level: r.level, race: String(raceOf.get(r.characterName) ?? "").toLowerCase().replace(/[^a-z]/g, "") });
  return [...people.values()];
}

/** The value of a set of worn armor and jewelry for a class at a level. */
export function setValue(items, cls, level) {
  let stats = 0;
  let haste = 0;
  let regen = 0;
  let manaregen = 0;
  for (const i of items) {
    if (!i) continue;
    stats += statScore(i, cls, level);
    haste = Math.max(haste, i.haste ?? 0);
    regen += i.regen ?? 0;
    manaregen += i.manaregen ?? 0;
  }
  return stats + HASTE_WEIGHT * haste + REGEN_WEIGHT * (Math.min(regen, REGEN_CAP) + Math.min(manaregen, REGEN_CAP));
}

const fits = (item, p, slot) =>
  item && item.slots & (1 << slot) && !(item.bagslots > 0) && item.classes & BIT[p.cls] && (!p.race || !RACE[p.race] || item.races & RACE[p.race]) && (item.reqlevel ?? 0) <= p.level;

/**
 * `survey`: rows of `iq.searchAccount()` (`characterName`, `itemId`, `itemName`, `itemInstanceId`,
 * `location` "Equipped" with its `slot`, or "Carried", and `blockReason`). `items`: item id to its
 * content row. `people`: the roster characters, `[{ name, cls, level, race }]` with `cls` a
 * gear-data class key. `minGain`: the smallest armor score gain worth a move.
 * Returns `{ moves: [{ item, itemId, from, to, slot, slotNum, gain, replaces }], wanted: [itemId] }`.
 */
export function planGear({ survey, items, people, minGain = 5 }) {
  const byName = new Map(people.map((p) => [p.name, p]));
  const worn = new Map(people.map((p) => [p.name, new Map()]));
  const owned = new Map(people.map((p) => [p.name, new Set()]));
  for (const r of survey) {
    owned.get(r.characterName)?.add(r.itemId);
    if (r.location === "Equipped") worn.get(r.characterName)?.set(r.slot, items.get(r.itemId) ?? null);
  }
  const free = survey.filter((r) => r.location === "Carried" && (!r.blockReason || r.blockReason === "Already on this character.") && items.has(r.itemId));

  // What one carried copy is worth to one character in one slot, against what it wears now.
  const offer = (r, p) => {
    const item = items.get(r.itemId);
    if (item.loreflag && r.characterName !== p.name && owned.get(p.name).has(r.itemId)) return [];
    const mine = worn.get(p.name);
    const out = [];
    for (const slot of ARMOR_SLOTS) {
      if (!fits(item, p, slot) || item.damage > 0) continue;
      const now = [...mine].filter(([s]) => ARMOR_SLOTS.includes(s)).map(([s, i]) => (s === slot ? null : i));
      const gain = setValue([...now, item], p.cls, p.level) - setValue([...mine].filter(([s]) => ARMOR_SLOTS.includes(s)).map(([, i]) => i), p.cls, p.level);
      if (gain >= minGain) out.push({ r, p, slot, gain });
    }
    // A main hand that swings harder replaces one only if it does not carry fewer stats, because
    // casters and priests often wear a main hand for its stats.
    const held = mine.get(PRIMARY) ?? null;
    if (fits(item, p, PRIMARY) && item.damage > 0 && item.delay > 0 && (!MAIN_HAND_TYPE[p.cls] || item.itemtype === MAIN_HAND_TYPE[p.cls]) && (!TWO_HANDED.has(item.itemtype) || !mine.get(SECONDARY)) && statScore(item, p.cls, p.level) >= (held ? statScore(held, p.cls, p.level) : 0)) {
      // A two-hander also ends a Monk's off-hand fist, which swings beside an empty off hand.
      const offFist = p.cls === "monk" && TWO_HANDED.has(item.itemtype) ? OFFHAND_WEIGHT * weaponRatio(fists(p.cls, p.level), p.cls, p.level) : 0;
      const gain = weaponRatio(item, p.cls, p.level) - weaponRatio(held ?? fists(p.cls, p.level), p.cls, p.level) - offFist;
      if (gain >= MIN_RATIO_GAIN) out.push({ r, p, slot: PRIMARY, gain, weapon: true });
    }
    return out;
  };

  let offers = free.flatMap((r) => people.flatMap((p) => offer(r, p)));
  // Everything that is an upgrade for someone is kept, also copies this pass gives nobody.
  const wanted = [...new Set(offers.map((o) => o.r.itemId))];

  // Greedy by gain: the best offer is taken, its copy and the receiver's slot are spent, and the
  // receiver's other offers are scored again against the set it now wears. Armor and weapons use
  // different units, but never compete for one copy, because only items without damage count as
  // armor.
  const moves = [];
  const spent = new Set();
  const key = (r) => `${r.characterName}:${r.itemInstanceId}`;
  const top = (list) => list.reduce((a, o) => (!a || o.gain > a.gain ? o : a), null);
  while (offers.length) {
    const best = top(offers.filter((o) => !o.weapon)) ?? top(offers);
    const { r, p, slot, gain } = best;
    const replaced = worn.get(p.name).get(slot) ?? null;
    moves.push({ item: r.itemName, itemId: r.itemId, from: r.characterName, to: p.name, slot: SLOT_BY_NUM[slot], slotNum: slot, gain: Math.round(gain * 100) / 100, replaces: replaced?.Name ?? null });
    spent.add(key(r));
    worn.get(p.name).set(slot, items.get(r.itemId));
    owned.get(p.name).add(r.itemId);
    offers = offers.filter((o) => !spent.has(key(o.r)) && o.p.name !== p.name);
    for (const f of free) if (!spent.has(key(f))) offers.push(...offer(f, byName.get(p.name)));
  }
  return { moves, wanted };
}
