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
//
// The off hand (docs/client-internals.md, Off hand and dual wield) takes a shield for its stats, or
// for a class with Dual Wield at its level a one-hander that swings with the chance `offhandChance`,
// so its worth is that chance times the weapon's ratio. Never beside a two-hander. A weapon never
// replaces a shield or an instrument, whose worth is in stat points and not comparable, and a
// shield never replaces a weapon.
import { BIT, CLASS_KEYS, HASTE_WEIGHT, RACE, REGEN_WEIGHT, SLOT_BY_NUM, offhandChance, statScore, weaponRatio } from "./gear-data.mjs";

export const ARMOR_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 17, 18, 19, 20];
const PRIMARY = 13;
const SECONDARY = 14;
const REGEN_CAP = 15;
const TWO_HANDED = new Set([1, 4, 35]);
// Item types a character with Dual Wield may hold in the off hand.
const OFFHAND_WEAPONS = new Set([0, 2, 3, 36]);
const SHIELD = 8;
const PIERCING = 2;
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
 * Platinum one gear pass may spend at merchants. Merchant goods within it already replace empty
 * slots and starter items, and a pass an hour keeps the spending small against the account's coin.
 */
export const BUY_PP = 20;
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

// A song's skill and the instrument type that modifies it (docs/client-internals.md, Bard
// instruments). Type 51 modifies every song.
const INSTRUMENT_OF_SKILL = { 54: 23, 49: 24, 12: 25, 70: 26, 41: 50 };
/**
 * Score points for raising every song a Bard sings from no instrument (10) to twice its effect
 * (20). An estimate in the stat score's units until a crossover measures it.
 */
export const INSTRUMENT_WEIGHT = 40;
/**
 * What a Bard's worn instruments add: for each instrument type, the best worn modifier (10 to 36)
 * weighs by the share of the Bard's songs at `level` that use it. `songs`: `[{ minLevel, skill }]`.
 */
export function instrumentValue(items, level, songs) {
  const mine = songs.filter((s) => s.minLevel <= level && INSTRUMENT_OF_SKILL[s.skill]);
  if (!mine.length) return 0;
  let value = 0;
  for (const s of mine) {
    const type = INSTRUMENT_OF_SKILL[s.skill];
    const best = Math.max(10, ...items.filter((i) => i && (i.bardtype === type || i.bardtype === 51)).map((i) => i.bardvalue ?? 0));
    value += (INSTRUMENT_WEIGHT * (Math.min(36, best) - 10)) / 10 / mine.length;
  }
  return value;
}

const fits = (item, p, slot) =>
  item && item.slots & (1 << slot) && !(item.bagslots > 0) && item.classes & BIT[p.cls] && (!p.race || !RACE[p.race] || item.races & RACE[p.race]) && (item.reqlevel ?? 0) <= p.level;

/**
 * `survey`: rows of `iq.searchAccount()` (`characterName`, `itemId`, `itemName`, `itemInstanceId`,
 * `location` "Equipped" with its `slot`, or "Carried", and `blockReason`). `items`: item id to its
 * content row. `people`: the roster characters, `[{ name, cls, level, race }]` with `cls` a
 * gear-data class key. `minGain`: the smallest armor score gain worth a move. `songs`: the Bard's
 * songs, `[{ minLevel, skill }]`. `shop`: merchant goods, `[{ itemId, merchant, zone, price }]`
 * with the price in platinum, which count as copies without end; the plan buys at most `buyPp`
 * platinum in one pass and only in one zone, so one trip serves a pass. `drops`: items enemies drop,
 * `[{ itemId, zone, npc, hours, levels: [min, max] }]` with `hours` the expected hunting per copy,
 * which become wants for characters whose group level is inside `levels`.
 * Returns `{ moves: [{ item, itemId, from, to, slot, slotNum, gain, replaces, buy? }], wanted: [itemId],
 * drops: [{ item, itemId, to, slot, gain, zone, npc, hours }] }`, where a move with
 * `buy: { merchant, zone, price }` buys its item first, and `drops` lists for each character the
 * best drop per slot that beats what it wears after the moves by `2 * minGain` (armor) or
 * `2 * MIN_RATIO_GAIN` (main hand), the dropped items worth hunting for.
 */
export function planGear({ survey, items, people, minGain = 5, songs = [], shop = [], buyPp = 0, drops = [] }) {
  const byName = new Map(people.map((p) => [p.name, p]));
  const worn = new Map(people.map((p) => [p.name, new Map()]));
  const owned = new Map(people.map((p) => [p.name, new Set()]));
  for (const r of survey) {
    owned.get(r.characterName)?.add(r.itemId);
    if (r.location === "Equipped") worn.get(r.characterName)?.set(r.slot, items.get(r.itemId) ?? null);
  }
  const free = survey.filter((r) => r.location === "Carried" && (!r.blockReason || r.blockReason === "Already on this character.") && items.has(r.itemId));
  const goods = shop.filter((s) => items.has(s.itemId) && s.price <= buyPp).map((s) => ({ characterName: null, itemId: s.itemId, itemName: items.get(s.itemId).Name, itemInstanceId: `shop:${s.itemId}`, buy: s }));

  // A character's armor and jewelry by the set score, plus for a Bard everything it wears by the
  // instruments' value.
  // A shield or an instrument in the off hand counts with its stats, a weapon there does not.
  const value = (p, mine) => setValue([...mine].filter(([s, i]) => ARMOR_SLOTS.includes(s) || (s === SECONDARY && !(i?.damage > 0))).map(([, i]) => i), p.cls, p.level) + (p.cls === "bard" ? instrumentValue([...mine.values()], p.level, songs) : 0);
  // What one copy is worth to one character in one slot, against what it wears now.
  const offer = (r, p) => {
    const item = items.get(r.itemId);
    // A lore item (loregroup -1 in the content rows) is one per character, so a second copy is refused.
    const lore = item.loregroup === -1 || item.loreflag || String(item.lore ?? "").startsWith("*");
    if (lore && r.characterName !== p.name && owned.get(p.name).has(r.itemId)) return [];
    const mine = worn.get(p.name);
    const out = [];
    const gainIn = (slot) => value(p, new Map([...mine, [slot, item]])) - value(p, mine);
    for (const slot of ARMOR_SLOTS) {
      if (!fits(item, p, slot) || item.damage > 0) continue;
      const gain = gainIn(slot);
      if (gain >= minGain) out.push({ r, p, slot, gain });
    }
    // A Bard's instrument takes the off hand, also from a weapon: it scales the songs of the whole
    // group, while an off-hand weapon adds only the Bard's own off-hand swings. The main hand keeps
    // its weapon.
    if (p.cls === "bard" && item.bardtype > 0 && !(item.damage > 0)) {
      for (const slot of [SECONDARY, PRIMARY]) {
        if (!fits(item, p, slot) || (slot === PRIMARY && mine.get(slot)?.damage > 0)) continue;
        const gain = gainIn(slot);
        if (gain >= minGain) out.push({ r, p, slot, gain });
        break;
      }
    }
    const held = mine.get(PRIMARY) ?? null;
    const offHeld = mine.get(SECONDARY) ?? null;
    const chance = offhandChance(p.cls, p.level);
    const fist = fists(p.cls, p.level, p.race);
    // A Monk's empty off hand swings a fist beside any main hand but a two-hander, with the
    // off-hand chance, and a weapon in the off hand or a two-hander ends it.
    const offSwing = (main, off) => (off ? chance * weaponRatio(off, p.cls, p.level) : p.cls === "monk" && !TWO_HANDED.has(main?.itemtype) ? chance * weaponRatio(fist, p.cls, p.level) : 0);
    // Beside a two-hander the off hand stays empty.
    if (!TWO_HANDED.has(held?.itemtype) && fits(item, p, SECONDARY)) {
      // A shield counts for its stats and replaces no weapon.
      if (item.itemtype === SHIELD && !(offHeld?.damage > 0)) {
        const gain = gainIn(SECONDARY);
        if (gain >= minGain) out.push({ r, p, slot: SECONDARY, gain });
      }
      // A one-hander counts for its swings, with the chance that they happen, and replaces only
      // a weapon or nothing.
      if (chance > 0 && OFFHAND_WEAPONS.has(item.itemtype) && item.damage > 0 && item.delay > 0 && (!offHeld || offHeld.damage > 0)) {
        const gain = chance * weaponRatio(item, p.cls, p.level) - offSwing(held, offHeld);
        if (gain >= MIN_RATIO_GAIN) out.push({ r, p, slot: SECONDARY, gain, weapon: true });
      }
    }
    // A main hand that swings harder replaces one only if it does not carry fewer stats, because
    // casters and priests often wear a main hand for its stats.
    if (fits(item, p, PRIMARY) && item.damage > 0 && item.delay > 0 && (!MAIN_HAND_TYPE[p.cls] || item.itemtype === MAIN_HAND_TYPE[p.cls]) && (!TWO_HANDED.has(item.itemtype) || !mine.get(SECONDARY)) && statScore(item, p.cls, p.level) >= (held ? statScore(held, p.cls, p.level) : 0)) {
      const gain = weaponRatio(item, p.cls, p.level) + offSwing(item, offHeld) - weaponRatio(held ?? fist, p.cls, p.level) - offSwing(held, offHeld);
      if (gain >= MIN_RATIO_GAIN) out.push({ r, p, slot: PRIMARY, gain, weapon: true });
    }
    return out;
  };
  const sources = () => [...free, ...goods];

  let offers = sources().flatMap((r) => people.flatMap((p) => offer(r, p)));
  // Everything on the account that is an upgrade for someone is kept, also copies this pass
  // gives nobody.
  const wanted = new Set(offers.filter((o) => !o.r.buy).map((o) => o.r.itemId));

  // Greedy by gain: the best offer is taken, its copy and the receiver's slot are spent, and the
  // receiver's other offers are scored again against the set it now wears. Armor and weapons use
  // different units, but never compete for one copy, because only items without damage count as
  // armor. An item on the account wins a tie with a merchant's, and a merchant's copies never run
  // out, while the platinum and the one zone of a pass do.
  const moves = [];
  const spent = new Set();
  let budget = buyPp;
  let zone = null;
  const key = (r) => `${r.characterName}:${r.itemInstanceId}`;
  const affordable = (o) => !o.r.buy || (o.r.buy.price <= budget && (zone == null || o.r.buy.zone === zone));
  const top = (list) => list.reduce((a, o) => (!a || o.gain > a.gain || (o.gain === a.gain && a.r.buy && !o.r.buy) ? o : a), null);
  for (offers = offers.filter(affordable); offers.length; offers = offers.filter(affordable)) {
    const best = top(offers.filter((o) => !o.weapon)) ?? top(offers);
    const { r, p, slot, gain } = best;
    const replaced = worn.get(p.name).get(slot) ?? null;
    moves.push({ item: r.itemName, itemId: r.itemId, from: r.characterName, to: p.name, slot: SLOT_BY_NUM[slot], slotNum: slot, gain: Math.round(gain * 100) / 100, replaces: replaced?.Name ?? null, ...(r.buy ? { buy: { merchant: r.buy.merchant, zone: r.buy.zone, price: r.buy.price } } : {}) });
    if (r.buy) {
      budget -= r.buy.price;
      zone = r.buy.zone;
      wanted.add(r.itemId);
    } else spent.add(key(r));
    worn.get(p.name).set(slot, items.get(r.itemId));
    owned.get(p.name).add(r.itemId);
    offers = offers.filter((o) => !spent.has(key(o.r)) && o.p.name !== p.name);
    for (const f of sources()) if (!spent.has(key(f))) offers.push(...offer(f, byName.get(p.name)));
  }
  // The drops worth hunting for, against what each character wears after this pass.
  const want = new Map();
  for (const d of drops) {
    if (!items.has(d.itemId)) continue;
    const r = { characterName: null, itemId: d.itemId, itemName: items.get(d.itemId).Name, itemInstanceId: `drop:${d.itemId}` };
    for (const p of people) {
      if (d.levels && (p.level < d.levels[0] || p.level > d.levels[1])) continue;
      for (const o of offer(r, p)) {
        if (o.gain < (o.weapon ? 2 * MIN_RATIO_GAIN : 2 * minGain)) continue;
        const k = `${p.name}:${o.slot}`;
        const best = want.get(k);
        if (!best || o.gain > best.gain || (o.gain === best.gain && d.hours < best.hours)) want.set(k, { item: r.itemName, itemId: d.itemId, to: p.name, slot: SLOT_BY_NUM[o.slot], gain: Math.round(o.gain * 100) / 100, zone: d.zone, npc: d.npc, hours: d.hours });
      }
    }
  }
  return { moves, wanted: [...wanted], drops: [...want.values()] };
}
