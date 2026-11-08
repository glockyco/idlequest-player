// What tools/gear.mjs and the raid simulator's farmed kits (tools/raidsim/kits.mjs) share: the stat
// score of an item for a class, the damage cap of a weapon, and where an item comes from (a drop or
// a merchant) in the zones the live game has, with the time it takes to farm a copy.
import { readdir, readFile } from "node:fs/promises";

export const BIT = { warrior: 1, cleric: 2, paladin: 4, ranger: 8, shadowknight: 16, druid: 32, monk: 64, bard: 128, rogue: 256, shaman: 512, necromancer: 1024, wizard: 2048, magician: 4096, enchanter: 8192 };
export const RACE = { human: 1, barbarian: 2, erudite: 4, woodelf: 8, highelf: 16, darkelf: 32, halfelf: 64, dwarf: 128, troll: 256, ogre: 512, halfling: 1024, gnome: 2048, iksar: 4096, vahshir: 8192 };
// Class names by the game's class id (1 to 14), as `BIT` spells them.
export const CLASS_KEYS = [null, "warrior", "cleric", "paladin", "ranger", "shadowknight", "druid", "monk", "bard", "rogue", "shaman", "necromancer", "wizard", "magician", "enchanter"];

export const SLOTS = { charm: 0, ear: 1, head: 2, face: 3, neck: 5, shoulders: 6, arms: 7, back: 8, wrist: 9, range: 11, hands: 12, primary: 13, secondary: 14, finger: 15, chest: 17, legs: 18, feet: 19, waist: 20 };
export const SLOT_BY_NUM = { 0: "charm", 1: "ear", 2: "head", 3: "face", 4: "ear", 5: "neck", 6: "shoulders", 7: "arms", 8: "back", 9: "wrist", 10: "wrist", 11: "range", 12: "hands", 13: "primary", 14: "secondary", 15: "finger", 16: "finger", 17: "chest", 18: "legs", 19: "feet", 20: "waist" };
export const slotName = (bits) => Object.entries(SLOTS).filter(([, b]) => bits & (1 << b)).map(([n]) => n);

export const groupOf = (c) => (["wizard", "magician", "enchanter", "necromancer"].includes(c) ? "caster" : ["cleric", "druid", "shaman"].includes(c) ? "priest" : ["paladin", "ranger", "shadowknight", "bard"].includes(c) ? "hybrid" : "melee");

// Base weapon damage cap per hand by level (wiki, "Level caps change weapon rankings").
const CAPS = { melee: [10, 14, 30, 60, 100], priest: [9, 12, 20, 26, 40], caster: [6, 10, 12, 18, 20] };
export const capFor = (c, level) => {
  const g = groupOf(c);
  return CAPS[g === "hybrid" ? "melee" : g][level < 10 ? 0 : level < 20 ? 1 : level < 30 ? 2 : level < 40 ? 3 : 4];
};

const weightsFor = (c, level) => {
  const mpi = (80 * level) / 425; // mana per Int or Wis point below 200
  return {
    caster: { mana: 1, hp: 0.4, ac: 1, int: mpi, wis: mpi * 0.3 },
    priest: { mana: 1, hp: 0.5, ac: 1, wis: mpi, int: mpi * 0.3 },
    melee: { hp: 0.5, ac: 1.5, str: 1, sta: 1, dex: 1, agi: 1, atk: 0.3 },
    hybrid: { hp: 0.5, ac: 1.5, str: 1, sta: 1, dex: 1, agi: 1, atk: 0.3, mana: 0.5, wis: mpi * 0.3, int: mpi * 0.3 },
  }[groupOf(c)];
};

// Points per percent of haste and per point of hit point or mana regeneration.
export const HASTE_WEIGHT = 3;
export const REGEN_WEIGHT = 8;

// Stat score of an item row for a class (name as in `BIT`) at a level, without haste and regeneration.
export const statScore = (i, c, level) => {
  const W = weightsFor(c, level);
  return (
    (W.mana ?? 0) * (i.mana ?? 0) + (W.hp ?? 0) * (i.hp ?? 0) + (W.ac ?? 0) * (i.ac ?? 0) + (W.int ?? 0) * (i.aint ?? 0) + (W.wis ?? 0) * (i.awis ?? 0) +
    (W.str ?? 0) * (i.astr ?? 0) + (W.sta ?? 0) * (i.asta ?? 0) + (W.dex ?? 0) * (i.adex ?? 0) + (W.agi ?? 0) * (i.aagi ?? 0) + (W.atk ?? 0) * (i.attack ?? 0) +
    0.3 * ((i.mr ?? 0) + (i.fr ?? 0) + (i.cr ?? 0) + (i.dr ?? 0) + (i.pr ?? 0))
  );
};

// The score of tools/gear.mjs for one item: the stat score plus haste and regeneration at their weights.
export const scoreFor = (i, c, level) => statScore(i, c, level) + HASTE_WEIGHT * (i.haste ?? 0) + REGEN_WEIGHT * ((i.regen ?? 0) + (i.manaregen ?? 0));

// A weapon's base damage, capped at the level's limit, over its delay.
export const weaponRatio = (i, c, level) => (i.damage && i.delay ? Math.min(i.damage, capFor(c, level)) / i.delay : 0);

// Weight of the off hand next to the main hand when both swing (gear.mjs --party).
export const OFFHAND_WEIGHT = 0.35;

export async function* rows(root, table) {
  const dir = `${root}/data/${table}`;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".ndjson"))) for (const l of (await readFile(`${dir}/${f}`, "utf8")).split("\n")) if (l) yield JSON.parse(l);
}

const norm = (s) => s.replace(/^the\s+/i, "").trim().toLowerCase();
// Zones the live game has: short name to long name. A zone counts when the wiki lists it and the
// live client has it.
export async function liveZoneNames(root) {
  const gameZones = new Set(Object.keys(JSON.parse(await readFile(new URL("../../data/idlequest-zones.json", import.meta.url), "utf8"))).map(norm));
  const liveZones = new Set(JSON.parse(await readFile(new URL("../../data/live-zones.json", import.meta.url), "utf8")));
  const zoneName = new Map();
  for await (const z of rows(root, "zone")) if (gameZones.has(norm(z.long_name)) && liveZones.has(z.short_name)) zoneName.set(z.short_name, z.long_name);
  return zoneName;
}

// Sources of the items in `itemIds`: item -> lootdrop -> loottable -> NPC -> spawns -> zone.
//   sources  item id -> [{ npcId, npc, level, zone, zoneShort, drop, spawn, points, respawn }]
//              drop     chance that one kill of the NPC drops the item
//              spawn    chance that a spawn point of the group spawns this NPC
//              points   spawn points of the NPC in the zone, respawn the shortest respawn time (s)
//   sellers  item id -> [{ npc, zone }] merchants that sell it and stand in a live zone
// NPCs above `maxNpcLevel` and NPCs `skipNpc(row)` accepts are left out of the drop sources.
export async function loadSources(root, { itemIds, maxNpcLevel = Infinity, skipNpc = () => false, zoneName }) {
  const dropsByLootdrop = new Map(); // lootdrop_id -> [{item, chance, mult}]
  for await (const e of rows(root, "lootdrop_entries")) if (e.chance > 0 && itemIds.has(e.item_id)) (dropsByLootdrop.get(e.lootdrop_id) ?? dropsByLootdrop.set(e.lootdrop_id, []).get(e.lootdrop_id)).push({ item: e.item_id, chance: e.chance, mult: e.multiplier || 1 });
  const ltsOfDrop = new Map(); // lootdrop_id -> [{lt, prob}]
  for await (const e of rows(root, "loottable_entries")) if (dropsByLootdrop.has(e.lootdrop_id)) (ltsOfDrop.get(e.lootdrop_id) ?? ltsOfDrop.set(e.lootdrop_id, []).get(e.lootdrop_id)).push({ lt: e.loottable_id, prob: e.probability });
  const itemsOfLt = new Map(); // loottable_id -> Map(item -> p)
  for (const [drop, lts] of ltsOfDrop) for (const { lt, prob } of lts) for (const d of dropsByLootdrop.get(drop)) {
    const m = itemsOfLt.get(lt) ?? itemsOfLt.set(lt, new Map()).get(lt);
    const p = (prob / 100) * (1 - (1 - d.chance / 100) ** d.mult);
    m.set(d.item, 1 - (1 - (m.get(d.item) ?? 0)) * (1 - p));
  }
  // Merchants: merchantlist maps a merchant id to the items it sells, and an NPC with that
  // `merchant_id` sells them wherever it spawns.
  const itemsOfMerchant = new Map(); // merchant id -> [item id]
  for await (const m of rows(root, "merchantlist")) if (itemIds.has(m.item)) (itemsOfMerchant.get(m.merchantid) ?? itemsOfMerchant.set(m.merchantid, []).get(m.merchantid)).push(m.item);
  const npcsOfLt = new Map(); // npc id -> {name, level, lt}
  const merchantNpcs = new Map(); // npc id -> {name, items}
  for await (const n of rows(root, "npc_types")) {
    if (n.level <= maxNpcLevel && itemsOfLt.has(n.loottable_id) && !skipNpc(n)) npcsOfLt.set(n.id, { id: n.id, name: n.name, level: n.level, lt: n.loottable_id });
    if (n.merchant_id && itemsOfMerchant.has(n.merchant_id)) merchantNpcs.set(n.id, { name: n.name, items: itemsOfMerchant.get(n.merchant_id) });
  }
  const groups = new Map(); // npc id -> [{group, chance}]
  const groupTotal = new Map();
  const needGroups = new Set();
  for await (const s of rows(root, "spawnentry")) {
    groupTotal.set(s.spawngroupID, (groupTotal.get(s.spawngroupID) ?? 0) + s.chance);
    if (npcsOfLt.has(s.npcID) || merchantNpcs.has(s.npcID)) {
      (groups.get(s.npcID) ?? groups.set(s.npcID, []).get(s.npcID)).push({ g: s.spawngroupID, chance: s.chance });
      needGroups.add(s.spawngroupID);
    }
  }
  const pointsOf = new Map(); // group -> {zone -> {n, respawn}}
  for await (const sp of rows(root, "spawn2")) {
    // Spawn points with a version above 0 belong to instanced copies of the zone, not to the zone itself.
    if (!needGroups.has(sp.spawngroupID) || !zoneName.has(sp.zone) || sp.version > 0) continue;
    const z = pointsOf.get(sp.spawngroupID) ?? pointsOf.set(sp.spawngroupID, new Map()).get(sp.spawngroupID);
    const r = z.get(sp.zone) ?? z.set(sp.zone, { n: 0, respawn: Infinity }).get(sp.zone);
    r.n++;
    if (sp.respawntime > 0) r.respawn = Math.min(r.respawn, sp.respawntime); // 0 means no respawn timer
  }
  const sources = new Map();
  for (const npc of npcsOfLt.values()) {
    const byZone = new Map();
    for (const { g, chance } of groups.get(npc.id) ?? []) for (const [zone, r] of pointsOf.get(g) ?? []) {
      const z = byZone.get(zone) ?? byZone.set(zone, { n: 0, respawn: Infinity, spawn: 0 }).get(zone);
      z.n += r.n;
      z.respawn = Math.min(z.respawn, r.respawn);
      z.spawn = Math.max(z.spawn, groupTotal.get(g) ? chance / groupTotal.get(g) : 1);
    }
    for (const [zone, z] of byZone) for (const [item, p] of itemsOfLt.get(npc.lt)) {
      const list = sources.get(item) ?? sources.set(item, []).get(item);
      list.push({ npcId: npc.id, npc: npc.name.replace(/_/g, " "), level: npc.level, zone: zoneName.get(zone), zoneShort: zone, drop: p, spawn: z.spawn, points: z.n, respawn: z.respawn });
    }
  }
  const sellers = new Map();
  for (const [id, m] of merchantNpcs) {
    const zones = new Set();
    for (const { g } of groups.get(id) ?? []) for (const zone of (pointsOf.get(g) ?? new Map()).keys()) zones.add(zone);
    for (const zone of zones) for (const item of m.items) (sellers.get(item) ?? sellers.set(item, []).get(item)).push({ npc: m.name.replace(/_/g, " "), zone: zoneName.get(zone) });
  }
  return { sources, sellers };
}

// Expected hours of camping for one copy: the NPC's spawn point cycles once per respawn time, the
// spawn group picks this NPC with the `spawn` chance and one kill drops the item with the `drop`
// chance. One spawn point is assumed, however many the zone has. Infinity without a spawn timer.
export const farmHours = (s) => (s.respawn > 0 && Number.isFinite(s.respawn) && s.spawn * s.drop > 0 ? s.respawn / (s.spawn * s.drop) / 3600 : Infinity);
