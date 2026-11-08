// Default gear and spells for a recruit, both taken from what merchants sell in the content
// snapshot (merchantlist, items with a price), so a roster entry without "items" or "spells" is a
// plain, buyable kit.
import { byId, table } from "./content.mjs";
import { RACE_BIT } from "./classes.mjs";

// Equipment slots a kit fills. Charm, ranged and ammo stay empty.
const ARMOR_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 17, 18, 19, 20];
const ONE_HAND = { 0: "OneHSlashing", 2: "OneHPiercing", 3: "OneHBlunt" };
const SHIELD = 8;
const TANKS = new Set([1, 3, 5]);
const DUAL_WIELDERS = new Set([4, 8, 9]);

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
  } else if (DUAL_WIELDERS.has(cls) && skillCaps.DualWield > 0) {
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
    if (item.itemtype !== 20 || !(item.scrolleffect > 0)) continue;
    const spell = spells.get(item.scrolleffect);
    const at = spell?.[`classes${cls}`];
    if (at > 0 && at <= level) out.add(spell.id);
  }
  return [...out].sort((a, b) => a - b);
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
