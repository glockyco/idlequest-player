// What tools/gear.mjs and the raid simulator's farmed kits (tools/raidsim/kits.mjs) share: the stat
// score of an item for a class, the damage cap of a weapon, and where an item comes from (a drop or
// a merchant) in the zones the live game has, with the time it takes to farm a copy.
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { effectValue } from "./spell-value.mjs";

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

// Classes whose mana comes from WIS (`gD` in the client); the other mana classes use INT.
const WIS_CLASSES = new Set(["cleric", "paladin", "ranger", "druid", "shaman"]);
const NO_MANA = new Set(["warrior", "monk", "rogue"]);
// The share of a class's output that is melee; the rest is spells, paid for with mana.
export const MELEE_SHARE = { melee: 1, hybrid: 0.5, priest: 0, caster: 0 };
/**
 * What a set of worn armor and jewelry adds to a character's own output, in tenths of a percent, from
 * the client's formulas (docs/client-internals.md, "What item stats and effects do"):
 * - melee: offense (2/3 a point of STR, 1 a point of ATK) through the damage roll, and the highest
 *   item haste (at most 50) as swing rate;
 * - spells: the share of the wearer's maximum mana (`pool`, else a typical 30 mana a level) that item mana and INT or WIS add (80 ×
 *   level / 425 mana a point), because out-of-fight regeneration is 2.5% of the maximum per 600 ms,
 *   so recovery shortens with the pool, and 2% faster regeneration a point of `manaregen` (at most 15);
 * - survival: AC and HP (STA at about 6 HP a point at 60) at the leveling model's 0.5% per 100
 *   (leveling plan, lever 7), which undervalues them for raids until the raid model weighs them.
 * Resists and the stats the client does not use for this class count for nothing.
 */
export const outputValue = (items, c, level, { pool } = {}) => {
  let str = 0, atk = 0, mana = 0, stat = 0, haste = 0, manaregen = 0, ac = 0, hp = 0, sta = 0;
  for (const i of items) {
    if (!i) continue;
    str += i.astr ?? 0;
    atk += i.attack ?? 0;
    mana += i.mana ?? 0;
    stat += (WIS_CLASSES.has(c) ? i.awis : i.aint) ?? 0;
    haste = Math.max(haste, i.haste ?? 0);
    manaregen += i.manaregen ?? 0;
    ac += i.ac ?? 0;
    hp += i.hp ?? 0;
    sta += i.asta ?? 0;
  }
  const meleeShare = MELEE_SHARE[groupOf(c)];
  const melee = meleeShare * (((2 / 3) * str + atk) * damagePctPerOffense(level) + Math.min(haste, 50));
  const spells = NO_MANA.has(c) ? 0 : (1 - meleeShare) * ((100 * (mana + ((80 * level) / 425) * stat)) / (pool > 0 ? pool : 30 * level) + 2 * Math.min(manaregen, 15));
  const survival = 0.005 * (ac + hp + ((6 * level) / 60) * sta);
  return 10 * (melee + spells + survival);
};

// A weapon's worth per swing, in damage over delay (tenths of a second), from the client's melee
// hit (docs/client-internals.md, "What item stats and effects do"): the base damage capped at the
// level's limit, the flat damage bonus of a main-hand hit (`sd`) divided by the typical roll
// multiplier, and its procs, `(0.5 + DEX/170) (1 + procrate/100)` a minute at the wearer's level,
// converted to the same unit. Hit chance, double attack and haste scale every weapon alike and are
// left out. Procs count their damage only, and an item's proc spell comes from `attachProcs`.
const MELEE_BONUS = new Set(["warrior", "paladin", "ranger", "shadowknight", "monk", "bard", "rogue"]);
const TWO_HANDED = new Set([1, 4, 35]);
const TWO_HAND_BONUS = JSON.parse(readFileSync(new URL("../../data/two-hand-bonus.json", import.meta.url), "utf8")).rows;
/** The flat bonus of a main-hand hit (`sd` in the client): from level 28 for melee classes, by delay for two-handers. */
export const damageBonus = (i, c, level) => {
  if (level < 28 || !MELEE_BONUS.has(c)) return 0;
  const l = Math.min(60, Math.trunc(level));
  return TWO_HANDED.has(i.itemtype) ? TWO_HAND_BONUS[l - 28][Math.max(0, Math.min(150, i.delay))] : 1 + Math.floor((l - 28) / 3);
};
// The mean of the client's damage roll (`ap`, 0.1 to 2.0) for an offense of five points a level (at most
// 250) plus `extra` against a same-level NPC's AC, about 4.5 a level (median of npc_types).
const multCache = new Map();
export const expectedMult = (level, extra = 0) => {
  const key = `${level}:${extra}`;
  if (!multCache.has(key)) {
    const o = Math.min(5 * level, 250) + extra;
    const a = 4.5 * level;
    const half = (o + a + 10) / 2;
    let sum = 0;
    for (let x = 0.01; x < 1; x += 0.02) for (let y = 0.01; y < 1; y += 0.02) sum += (Math.max(0, Math.min(19, Math.floor(((x * (o + 5) - y * (a + 5) + half / 2) * 20) / half))) + 1) / 10;
    multCache.set(key, sum / 2500);
  }
  return multCache.get(key);
};
/** Percent more melee damage per point of offense at `level`, the slope of the damage roll over 30 points. */
export const damagePctPerOffense = (level) => (100 * (expectedMult(level, 30) / expectedMult(level) - 1)) / 30;
/** Proc damage a minute of a weapon at the wearer's `level` and `dex`, 0 without a damage proc or below the proc's level. */
export const procDamagePerMinute = (i, level, dex = 75) => {
  if (!i.procSpell || level < (i.proclevel2 || i.proclevel || 0)) return 0;
  const hit = i.procSpell.effects.reduce((a, e) => a + Math.max(0, -effectValue(e.formula, e.base, e.max, level)), 0);
  return (0.5 + Math.min(255, dex) / 170) * Math.max(0, 1 + (i.procrate ?? 0) / 100) * hit * Math.max(1, i.procSpell.ticks);
};
export const weaponRatio = (i, c, level, { primary = true, dex = 75 } = {}) => {
  if (!(i.damage && i.delay)) return 0;
  const m = expectedMult(level);
  const bonus = primary ? damageBonus(i, c, level) : 0;
  return (Math.min(i.damage, capFor(c, level)) + bonus / m) / i.delay + procDamagePerMinute(i, level, dex) / 60 / (10 * m);
};

/** Adds `procSpell` (the proc spell's hit point effects and its duration in ticks) to the weapons of `items`, a Map of item rows. */
export async function attachProcs(items, root) {
  const want = new Set([...items.values()].filter((i) => i.proceffect > 0 && i.proceffect !== 255 && (i.proctype ?? 0) <= 1).map((i) => i.proceffect));
  if (!want.size) return items;
  const spells = new Map();
  for await (const s of rows(root, "spells_new")) if (want.has(s.id)) spells.set(s.id, s);
  for (const i of items.values()) {
    const s = spells.get(i.proceffect);
    if (!s || !want.has(i.proceffect)) continue;
    const effects = [];
    for (let k = 1; k <= 12; k++) if (s[`effectid${k}`] === 0 && s[`effect_base_value${k}`] < 0) effects.push({ formula: s[`formula${k}`], base: s[`effect_base_value${k}`], max: s[`max${k}`] });
    i.procSpell = { name: s.name, effects, ticks: s.buffduration > 0 ? s.buffduration : 0 };
  }
  return items;
}

// Dual Wield (docs/client-internals.md, Off hand and dual wield). The server's cap of the skill is
// in data/skill-caps.json for levels 46 to 60 only. Below 46 the cap is interpolated linearly from
// the level the class first has the skill, with the cap read from the server then, to the cap at 46.
const DUAL_WIELD_SKILL = 22;
const DUAL_WIELD_FROM = { warrior: [13, 70], ranger: [17, 90], monk: [1, 12], bard: [17, 90], rogue: [13, 83] };
const SKILL_CAP_ROWS = JSON.parse(readFileSync(new URL("../../data/skill-caps.json", import.meta.url), "utf8")).caps;
const capAt = (cls, level) => SKILL_CAP_ROWS[`${CLASS_KEYS.indexOf(cls)}-${level}`]?.[DUAL_WIELD_SKILL] ?? 0;
/** A character's Dual Wield skill at `level`, trained to the class's cap; 0 before the class has it and for a class that never does. */
export function dualWieldSkill(cls, level) {
  const from = DUAL_WIELD_FROM[cls];
  if (!from || level < from[0]) return 0;
  if (level >= 46) return capAt(cls, Math.min(level, 60));
  return Math.round(from[1] + ((capAt(cls, 46) - from[1]) * (level - from[0])) / (46 - from[0]));
}
/** The chance that a due off-hand swing happens (`IZ` in the client) for a Dual Wield skill: `min(1, (skill + level) / 400)`, 0 without the skill. */
export const offhandChanceOf = (skill, level) => (skill > 0 ? Math.min(1, (skill + level) / 400) : 0);
/** The chance of an off-hand swing for a class at a level, with the skill trained to the cap. */
export const offhandChance = (cls, level) => offhandChanceOf(dualWieldSkill(cls, level), level);

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
//   sellers  item id -> [{ npc, zone, zoneShort }] merchants that sell it and stand in a live zone
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
    for (const zone of zones) for (const item of m.items) (sellers.get(item) ?? sellers.set(item, []).get(item)).push({ npc: m.name.replace(/_/g, " "), zone: zoneName.get(zone), zoneShort: zone });
  }
  return { sources, sellers };
}

/**
 * The merchant goods the roster gear plan may buy (tools/lib/gear-plan.mjs `shop`): items sold in a
 * city of data/shop-zones.json at a base price of at most `maxPp` platinum that carry stats, armor,
 * a weapon's damage or an instrument, with up to two sellers each. Only cities, because a party of
 * any level can shop there. Resolves with `{ shop: [{ itemId, merchant, zone,
 * price }], items: Map(id -> content row) }`.
 */
export async function merchantGoods(root, { maxPp }) {
  const sold = new Set();
  for await (const m of rows(root, "merchantlist")) sold.add(m.item);
  const items = new Map();
  const stats = ["ac", "hp", "mana", "astr", "asta", "adex", "aagi", "aint", "awis", "acha", "damage", "bardvalue", "haste", "regen", "manaregen"];
  for await (const i of rows(root, "items")) if (sold.has(i.id) && i.price / 1000 <= maxPp && i.slots > 0 && stats.some((k) => i[k] > 0)) items.set(i.id, i);
  const { sellers } = await loadSources(root, { itemIds: new Set(items.keys()), zoneName: await liveZoneNames(root), maxNpcLevel: -1 });
  const cities = new Set(JSON.parse(await readFile(new URL("../../data/shop-zones.json", import.meta.url), "utf8")));
  const shop = [];
  for (const [id, list] of sellers) for (const s of list.filter((x) => cities.has(x.zoneShort)).slice(0, 2)) shop.push({ itemId: id, merchant: s.npc, zone: s.zoneShort, price: items.get(id).price / 1000 });
  return { shop, items };
}

/** A Bard's songs, `[{ minLevel, skill }]`, from data/class-spells.json, for `instrumentValue`. */
export async function bardSongs() {
  const table = JSON.parse(await readFile(new URL("../../data/class-spells.json", import.meta.url), "utf8"));
  return (table[8]?.spells ?? []).map((s) => ({ minLevel: s.minLevel, skill: s.skill }));
}

// Expected hours of camping for one copy: the NPC's spawn point cycles once per respawn time, the
// spawn group picks this NPC with the `spawn` chance and one kill drops the item with the `drop`
// chance. One spawn point is assumed, however many the zone has. Infinity without a spawn timer.
export const farmHours = (s) => (s.respawn > 0 && Number.isFinite(s.respawn) && s.spawn * s.drop > 0 ? s.respawn / (s.spawn * s.drop) / 3600 : Infinity);

/**
 * The gear enemies drop in each band row's zones (data/band-rotations.json), for the roster gear
 * plan's `drops`: `[{ itemId, zone, npc, hours, levels: [min, max] }]`, where `levels` are the
 * row's leader levels and `hours` the expected hunting for one copy while every spawn point of the
 * enemy is cleared as it respawns. Only enemies up to five levels above the row and items that fit
 * a slot and carry stats, armor or damage count. Resolves with `{ drops, items }`.
 */
export async function zoneDrops(root, bandRows) {
  const sorted = [...bandRows].sort((a, b) => a[0] - b[0]);
  const bands = sorted.map(([min, zones], k) => ({ min, max: (sorted[k + 1]?.[0] ?? 61) - 1, zones }));
  const stats = ["ac", "hp", "mana", "astr", "asta", "adex", "aagi", "aint", "awis", "acha", "damage", "bardvalue", "haste", "regen", "manaregen"];
  const items = new Map();
  for await (const i of rows(root, "items")) if (i.slots > 0 && !(i.bagslots > 0) && stats.some((k) => i[k] > 0)) items.set(i.id, i);
  const { sources } = await loadSources(root, { itemIds: new Set(items.keys()), zoneName: await liveZoneNames(root) });
  const drops = [];
  for (const [itemId, list] of sources) {
    for (const b of bands) {
      for (const s of list) {
        if (!b.zones.includes(s.zoneShort) || s.level > b.max + 5) continue;
        const hours = farmHours(s) / Math.max(1, s.points);
        if (Number.isFinite(hours)) drops.push({ itemId, zone: s.zoneShort, npc: s.npc, hours: Math.round(hours * 100) / 100, levels: [b.min, b.max] });
      }
    }
  }
  return { drops, items };
}
