// Default gear and spells for a recruit, in two policies (the roster's or an entry's `gear`):
//
//   merchant  what merchants sell in the content snapshot (merchantlist, items with a price): the
//             best item per slot by armor class and the best weapon by damage per delay, and every
//             merchant scroll the class can cast.
//   farm      what a character can get from merchants in live zones or from drops of ordinary
//             NPCs in live zones (not Raid Resolve bosses, not raid targets, none above level 60)
//             that take at most `farmHours` of camping per copy: the best item per slot by the score
//             of tools/gear.mjs, the best weapon by its damage per delay, and the scrolls from the
//             same sources besides the merchant ones.
//
// Both leave out the charm, ranged and ammo slots.
import { contentDir, byId, table } from "./content.mjs";
import { RACE_BIT } from "./classes.mjs";
import { CLASS_KEYS, HASTE_WEIGHT, REGEN_WEIGHT, farmHours, liveZoneNames, loadSources, offhandChanceOf, scoreFor, statScore, weaponRatio } from "../lib/gear-data.mjs";

// The cap the client puts on the hit point and the mana regeneration of worn items.
const CLIENT_REGEN_CAP = 15;
// Equipment slots a kit fills.
const ARMOR_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 17, 18, 19, 20];
const ONE_HAND = { 0: "OneHSlashing", 2: "OneHPiercing", 3: "OneHBlunt" };
// Two-hand weapons by item type. 2H piercing (35) has no skill in the client's skill table, so the
// client cannot rank it.
const TWO_HAND = { 1: "TwoHSlashing", 4: "TwoHBlunt" };
const SHIELD = 8;
const SCROLL = 20;
const PRIMARY = 13;
const SECONDARY = 14;
const ROGUE = 9;
const TANKS = new Set([1, 3, 5]);
// What a tank's shield is worth against its main hand's damage over delay: an estimate, not a rule of
// the client, for the shield's armor class and Bash that a two-hander gives up.
const SHIELD_SHARE = 0.35;

let soldItems;
async function merchantItems() {
  if (soldItems) return soldItems;
  const items = await byId("items");
  const ids = new Set((await table("merchantlist")).map((r) => r.item));
  soldItems = [...ids].map((id) => items.get(id)).filter(Boolean);
  return soldItems;
}

function usable(item, cls, race, level) {
  const raceBit = RACE_BIT[race] ?? 0;
  return (item.classes & (1 << (cls - 1))) !== 0 && (item.races & (1 << raceBit)) !== 0 && (item.reqlevel ?? 0) <= level && item.itemclass === 0 && item.price > 0;
}

const statTotal = (i) => (i.astr ?? 0) + (i.asta ?? 0) + (i.adex ?? 0) + (i.aagi ?? 0) + (i.aint ?? 0) + (i.awis ?? 0) + (i.acha ?? 0) + (i.hp ?? 0) + (i.mana ?? 0);
const best = (list, score) => list.reduce((a, b) => (a && score(a) >= score(b) ? a : b), null);

// Returns { slot: itemId } for a class, race and level, and the skill table the class can train.
export async function defaultGear(cls, race, level, skillCaps) {
  const sold = (await merchantItems()).filter((i) => usable(i, cls, race, level));
  const gear = {};
  for (const slot of ARMOR_SLOTS) {
    const pick = best(
      sold.filter((i) => (i.slots & (1 << slot)) !== 0 && i.damage === 0 && i.itemtype !== SHIELD),
      (i) => (i.ac ?? 0) * 1000 + statTotal(i),
    );
    if (pick && ((pick.ac ?? 0) > 0 || statTotal(pick) > 0)) gear[slot] = pick.id;
  }
  const weapons = sold.filter((i) => ONE_HAND[i.itemtype] && skillCaps[ONE_HAND[i.itemtype]] > 0 && i.damage > 0 && i.delay > 0 && (i.slots & (1 << 13)) !== 0);
  const ratio = (i) => i.damage / i.delay;
  const primaryPool = cls === 9 ? weapons.filter((i) => i.itemtype === 2) : weapons;
  const primary = best(primaryPool, ratio);
  if (primary) gear[13] = primary.id;
  if (TANKS.has(cls)) {
    const shield = best(sold.filter((i) => i.itemtype === SHIELD && (i.slots & (1 << 14)) !== 0), (i) => (i.ac ?? 0) * 1000 + statTotal(i));
    if (shield) gear[14] = shield.id;
  } else if (skillCaps.DualWield > 0) {
    const off = best(weapons.filter((i) => (i.slots & (1 << 14)) !== 0), ratio);
    if (off) gear[14] = off.id;
  }
  return gear;
}

// Spell ids a merchant sells as a scroll that the class can cast at `level`.
export async function merchantSpells(cls, level) {
  const spells = await byId("spells_new");
  const out = new Set();
  for (const item of await merchantItems()) {
    if (item.itemtype !== SCROLL || !(item.scrolleffect > 0)) continue;
    const spell = spells.get(item.scrolleffect);
    const at = spell?.[`classes${cls}`];
    if (at > 0 && at <= level) out.add(spell.id);
  }
  return [...out].sort((a, b) => a - b);
}

// ---- Farmed kits -------------------------------------------------------------------------------

// The level cap of the game: no item needs more, and the farm kit leaves out NPCs above it.
const MAX_LEVEL = 60;
const normName = (s) => s.replace(/[#_]/g, " ").trim().toLowerCase();

let farmPoolCache;
// Every item and scroll a level 60 character could use and where it comes from, read once. `resolve`
// is { ids: Set of npc ids, names: Set of names } of the client's Raid Resolve bosses.
function farmPool(resolve) {
  farmPoolCache ??= (async () => {
    const rows = await table("items");
    const itemIds = new Set();
    for (const i of rows) {
      if (i.reqlevel > MAX_LEVEL) continue;
      const wearable = i.slots && !i.augtype && !i.bagslots && i.itemclass === 0;
      if (wearable || (i.itemtype === SCROLL && i.scrolleffect > 0)) itemIds.add(i.id);
    }
    const names = new Set([...resolve.names].map(normName));
    const skipNpc = (n) => resolve.ids.has(n.id) || names.has(normName(n.name)) || n.raid_target || n.untargetable;
    const zoneName = await liveZoneNames(contentDir);
    const { sources, sellers } = await loadSources(contentDir, { itemIds, maxNpcLevel: MAX_LEVEL, skipNpc, zoneName });
    return { sources, sellers, itemIds, origins: new Map() };
  })();
  return farmPoolCache;
}

// How a character gets one copy of an item: a merchant in a live zone, else the drop that takes the
// fewest hours of camping, if that is at most `maxHours`. null when there is no such way.
function originOf(pool, id, maxHours) {
  const key = `${id}:${maxHours}`;
  if (pool.origins.has(key)) return pool.origins.get(key);
  let origin = null;
  const sold = pool.sellers.get(id);
  if (sold?.length) origin = { kind: "merchant", npc: sold[0].npc, zone: sold[0].zone };
  else {
    for (const s of pool.sources.get(id) ?? []) {
      const hours = farmHours(s);
      if (hours <= maxHours && (!origin || hours < origin.hours)) origin = { kind: "drop", npc: s.npc, npcId: s.npcId, level: s.level, zone: s.zone, drop: s.drop, spawn: s.spawn, respawn: s.respawn, hours };
    }
  }
  pool.origins.set(key, origin);
  return origin;
}

// A lore item can be carried once, `loregroup` -1 alone and a positive group with its members.
const loreKey = (i) => (i.loregroup > 0 ? `group ${i.loregroup}` : i.loregroup < 0 ? `item ${i.id}` : null);

// Highest `value`, then highest `tie`.
function pick(list, value, tie = () => 0) {
  let top = null;
  for (const item of list) {
    if (!top) top = item;
    else {
      const d = value(item) - value(top);
      if (d > 1e-9 || (Math.abs(d) <= 1e-9 && tie(item) > tie(top))) top = item;
    }
  }
  return top;
}

// { gear: { slot: itemId }, origins: { slot: origin } } for a class, race and level: per slot the
// item with the best score (tools/gear.mjs) that the class and race may use at the level and that
// has an origin within `farm.hours`. Every member gets its own copies, so lore only stops one member
// from wearing two of an item or of a lore group.
export async function farmGear(cls, race, level, skillCaps, farm) {
  const pool = await farmPool(farm.resolve);
  const key = CLASS_KEYS[cls];
  const items = await byId("items");
  const raceBit = 1 << (RACE_BIT[race] ?? 0);
  const classBit = 1 << (cls - 1);
  const usableHere = [];
  for (const id of pool.itemIds) {
    const i = items.get(id);
    // The simulated characters have no deity, so an item that needs one is left out.
    if (i.itemtype === SCROLL || !(i.classes & classBit) || !(i.races & raceBit) || (i.reqlevel ?? 0) > level || i.deity) continue;
    const origin = originOf(pool, id, farm.hours);
    if (origin) usableHere.push({ item: i, origin });
  }
  const gear = {};
  const origins = {};
  const carried = new Set();
  const take = (slot, pickedEntry) => {
    if (!pickedEntry) return;
    gear[slot] = pickedEntry.item.id;
    origins[slot] = pickedEntry.origin;
    const lore = loreKey(pickedEntry.item);
    if (lore) carried.add(lore);
  };
  const free = (e) => !carried.has(loreKey(e.item));
  const score = (e) => scoreFor(e.item, key, level);
  const ratio = (e) => weaponRatio(e.item, key, level);
  const inSlot = (slot) => usableHere.filter((e) => (e.item.slots & (1 << slot)) !== 0 && free(e));
  const isWeapon = (e) => e.item.damage > 0 && e.item.delay > 0;

  // The client does not add up haste (the highest worn haste counts) and caps the regeneration of
  // hit points and of mana at 15 each (`Sd` in the main bundle), so the armor slots are chosen in two
  // steps: each slot by its stat score, then slot by slot the item that gives the whole set the most,
  // until no slot changes.
  const bonus = (entries) => {
    const sum = (k) => entries.reduce((t, e) => t + (e.item[k] ?? 0), 0);
    return HASTE_WEIGHT * Math.max(0, ...entries.map((e) => e.item.haste ?? 0)) + REGEN_WEIGHT * (Math.min(sum("regen"), CLIENT_REGEN_CAP) + Math.min(sum("manaregen"), CLIENT_REGEN_CAP));
  };
  const setValue = (entries) => entries.reduce((t, e) => t + statScore(e.item, key, level), 0) + bonus(entries);
  const loreFree = (e, others) => !loreKey(e.item) || !others.some((o) => loreKey(o.item) === loreKey(e.item));
  const candidates = new Map(ARMOR_SLOTS.map((slot) => [slot, usableHere.filter((e) => (e.item.slots & (1 << slot)) !== 0 && !isWeapon(e) && e.item.itemtype !== SHIELD && score(e) > 0)]));
  const armor = new Map();
  for (const slot of ARMOR_SLOTS) {
    const others = [...armor.values()];
    const top = pick(candidates.get(slot).filter((e) => loreFree(e, others)), (e) => statScore(e.item, key, level), (e) => e.item.ac ?? 0);
    if (top) armor.set(slot, top);
  }
  for (let pass = 0, changed = true; changed && pass < 8; pass++) {
    changed = false;
    for (const slot of ARMOR_SLOTS) {
      if (!armor.has(slot)) continue;
      const others = [...armor].filter(([s]) => s !== slot).map(([, e]) => e);
      const top = pick(candidates.get(slot).filter((e) => loreFree(e, others)), (e) => setValue([...others, e]), (e) => e.item.ac ?? 0);
      if (top !== armor.get(slot) && setValue([...others, top]) > setValue([...others, armor.get(slot)]) + 1e-9) {
        armor.set(slot, top);
        changed = true;
      }
    }
  }
  for (const slot of ARMOR_SLOTS) if (armor.has(slot)) take(slot, armor.get(slot));

  // Weapons rank by damage over delay with the damage capped (gear.mjs). A two-hander replaces the
  // main hand and what would be in the off hand when it beats the one-hander by more than the off
  // hand's share: for a class with Dual Wield the off hand's ratio times the chance that an off-hand
  // swing happens (docs/client-internals.md, Off hand and dual wield), and for a tank SHIELD_SHARE of
  // the main hand's ratio in place of its shield. A Warrior keeps its shield, for armor class and Bash.
  const oneHand = (e) => ONE_HAND[e.item.itemtype] && skillCaps[ONE_HAND[e.item.itemtype]] > 0 && isWeapon(e);
  const twoHand = (e) => TWO_HAND[e.item.itemtype] && skillCaps[TWO_HAND[e.item.itemtype]] > 0 && isWeapon(e);
  const mainHands = inSlot(PRIMARY).filter((e) => oneHand(e) && (cls !== ROGUE || e.item.itemtype === 2));
  const main = pick(mainHands, ratio, score);
  const dualWields = skillCaps.DualWield > 0;
  const offhandChance = offhandChanceOf(skillCaps.DualWield ?? 0, level);
  let off = null;
  if (main) {
    take(PRIMARY, main); // the lore of the main hand now blocks a second copy in the off hand
    if (TANKS.has(cls)) off = pick(inSlot(SECONDARY).filter((e) => e.item.itemtype === SHIELD), score, (e) => e.item.ac ?? 0);
    else if (dualWields) off = pick(inSlot(SECONDARY).filter(oneHand), ratio, score);
    else off = pick(inSlot(SECONDARY).filter((e) => !isWeapon(e) && score(e) > 0), score);
  }
  const twoHanders = cls === ROGUE ? [] : usableHere.filter((e) => (e.item.slots & (1 << PRIMARY)) !== 0 && twoHand(e));
  const two = pick(twoHanders, ratio, score);
  const offShare = main ? (off && isWeapon(off) ? offhandChance * ratio(off) : off && TANKS.has(cls) ? SHIELD_SHARE * ratio(main) : 0) : 0;
  if (two && (!main || ratio(two) > ratio(main) + offShare + 0.03)) {
    for (const slot of [PRIMARY, SECONDARY]) {
      delete gear[slot];
      delete origins[slot];
    }
    take(PRIMARY, two);
  } else if (off) {
    // The main hand was taken above, the off hand is not blocked by its own copy.
    take(SECONDARY, off);
  }
  return { gear, origins };
}

// { spells: [spell id], farmed: [{ id, name, origin }] } for a class and level: the merchant scrolls
// (as `merchantSpells` lists) and the scrolls with a farm origin within `farm.hours`.
export async function farmSpells(cls, level, farm) {
  const pool = await farmPool(farm.resolve);
  const spells = await byId("spells_new");
  const items = await byId("items");
  const out = new Set(await merchantSpells(cls, level));
  const farmed = new Map();
  for (const id of pool.itemIds) {
    const item = items.get(id);
    if (item.itemtype !== SCROLL) continue;
    const spell = spells.get(item.scrolleffect);
    const at = spell?.[`classes${cls}`];
    if (!(at > 0 && at <= level) || out.has(spell.id)) continue;
    const origin = originOf(pool, id, farm.hours);
    if (!origin) continue;
    const had = farmed.get(spell.id);
    if (!had || origin.kind === "merchant" || (had.origin.kind === "drop" && origin.hours < had.origin.hours)) farmed.set(spell.id, { id: spell.id, name: spell.name, origin });
  }
  for (const id of farmed.keys()) out.add(id);
  return { spells: [...out].sort((a, b) => a - b), farmed: [...farmed.values()].sort((a, b) => a.id - b.id) };
}

// Memorized spells of the leader. The client's auto-cast table for the class (data/class-spells.json,
// built by tools/class-spells.mjs) lists what the leader may cast, and only memorized spells are
// cast. The default takes the highest level spells of that table the leader has scribed.
export async function defaultGems(member) {
  const file = await Bun.file(new URL("../../data/class-spells.json", import.meta.url)).json();
  const entry = file[String(member.cls)];
  if (!entry) return [];
  const scribed = new Set(member.spells);
  const limit = member.cls === 8 ? 3 : 8;
  return entry.spells
    .filter((s) => scribed.has(s.spellId))
    .sort((a, b) => b.minLevel - a.minLevel || a.spellId - b.spellId)
    .slice(0, limit)
    .map((s) => s.spellId);
}
