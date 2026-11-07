// Best gear for a class at a level, and where it drops or who sells it.
//
//   bun tools/gear.mjs <class> --level N [--race dwarf] [--slot head] [--mob-max N] [--top 3] [--data dir]
//   class: warrior cleric paladin ranger shadowknight druid monk bard rogue shaman necromancer wizard magician enchanter
//   race: human barbarian erudite woodelf highelf darkelf halfelf dwarf troll ogre halfling gnome iksar vahshir
//
// Reads the developer's public content snapshot (see tools/drops.mjs). Items are limited to the
// class, the race if given, `reqlevel <= level`, and a source: a drop from an NPC of at most
// `mob-max` levels (default level+6), or a merchant, in a zone IdleQuest has. Prices are the
// item's base price in platinum; what a merchant asks may differ. Items with neither source are
// shown as "quest or unknown".
//
// The score is a rough stat value, not a simulation. Weights, per point:
//   casters (wizard magician enchanter necromancer): mana 1, hp 0.4, ac 1, int and wis from the
//     game's own mana formula (80 * level / 425 mana per point below 200), the unused one at 30%
//   priests (cleric druid shaman): the same with wis as the main stat
//   melee (warrior rogue monk): hp 0.5, ac 1.5, str/sta/dex/agi 1, attack 0.3
//   hybrids (paladin ranger shadowknight bard): melee weights plus mana 0.5
//   all: resists 0.3 each, haste 3 per percent, hp/mana regen 8 per point
// Weapon slots are ranked by base damage capped at the level's limit, divided by delay, the
// comparison the IdleQuest wiki gives (idlequest.net/wiki/choosing-weapons). Haste and procs are
// not valued beyond the haste weight.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const pos = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const cls = (pos[0] ?? "").toLowerCase();
const level = Number(opt("level", NaN));
const BIT = { warrior: 1, cleric: 2, paladin: 4, ranger: 8, shadowknight: 16, druid: 32, monk: 64, bard: 128, rogue: 256, shaman: 512, necromancer: 1024, wizard: 2048, magician: 4096, enchanter: 8192 };
const RACE = { human: 1, barbarian: 2, erudite: 4, woodelf: 8, highelf: 16, darkelf: 32, halfelf: 64, dwarf: 128, troll: 256, ogre: 512, halfling: 1024, gnome: 2048, iksar: 4096, vahshir: 8192 };
const race = opt("race", null)?.toLowerCase().replace(/[^a-z]/g, "");
if (race && !RACE[race]) {
  console.error(`unknown race ${race}; one of ${Object.keys(RACE).join(" ")}`);
  process.exit(2);
}
if (!BIT[cls] || Number.isNaN(level)) {
  console.error("usage: bun tools/gear.mjs <class> --level N [--slot name] [--mob-max N] [--top N] [--data dir]");
  process.exit(2);
}
const root = opt("data", process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`);
const mobMax = Number(opt("mob-max", level + 6));
const top = Number(opt("top", 3));
const slotFilter = opt("slot", null)?.toLowerCase();

const SLOTS = { charm: 0, ear: 1, head: 2, face: 3, neck: 5, shoulders: 6, arms: 7, back: 8, wrist: 9, range: 11, hands: 12, primary: 13, secondary: 14, finger: 15, chest: 17, legs: 18, feet: 19, waist: 20 };
const slotName = (bits) => Object.entries(SLOTS).filter(([, b]) => bits & (1 << b)).map(([n]) => n);
const group = ["wizard", "magician", "enchanter", "necromancer"].includes(cls) ? "caster" : ["cleric", "druid", "shaman"].includes(cls) ? "priest" : ["paladin", "ranger", "shadowknight", "bard"].includes(cls) ? "hybrid" : "melee";
const mpi = (80 * level) / 425; // mana per Int or Wis point below 200
// Base weapon damage cap per hand by level (wiki, "Level caps change weapon rankings").
const CAPS = { melee: [10, 14, 30, 60, 100], priest: [9, 12, 20, 26, 40], caster: [6, 10, 12, 18, 20] };
const capGroup = group === "hybrid" ? "melee" : group;
const damageCap = CAPS[capGroup][level < 10 ? 0 : level < 20 ? 1 : level < 30 ? 2 : level < 40 ? 3 : 4];
const W = {
  caster: { mana: 1, hp: 0.4, ac: 1, int: mpi, wis: mpi * 0.3 },
  priest: { mana: 1, hp: 0.5, ac: 1, wis: mpi, int: mpi * 0.3 },
  melee: { hp: 0.5, ac: 1.5, str: 1, sta: 1, dex: 1, agi: 1, atk: 0.3 },
  hybrid: { hp: 0.5, ac: 1.5, str: 1, sta: 1, dex: 1, agi: 1, atk: 0.3, mana: 0.5, wis: mpi * 0.3, int: mpi * 0.3 },
}[group];
const score = (i) =>
  (W.mana ?? 0) * (i.mana ?? 0) + (W.hp ?? 0) * (i.hp ?? 0) + (W.ac ?? 0) * (i.ac ?? 0) + (W.int ?? 0) * (i.aint ?? 0) + (W.wis ?? 0) * (i.awis ?? 0) +
  (W.str ?? 0) * (i.astr ?? 0) + (W.sta ?? 0) * (i.asta ?? 0) + (W.dex ?? 0) * (i.adex ?? 0) + (W.agi ?? 0) * (i.aagi ?? 0) + (W.atk ?? 0) * (i.attack ?? 0) +
  0.3 * ((i.mr ?? 0) + (i.fr ?? 0) + (i.cr ?? 0) + (i.dr ?? 0) + (i.pr ?? 0)) + 3 * (i.haste ?? 0) + 8 * ((i.regen ?? 0) + (i.manaregen ?? 0));

async function* rows(table) {
  const dir = `${root}/data/${table}`;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".ndjson"))) for (const l of (await readFile(`${dir}/${f}`, "utf8")).split("\n")) if (l) yield JSON.parse(l);
}
const norm = (s) => s.replace(/^the\s+/i, "").trim().toLowerCase();
const gameZones = new Set(Object.keys(JSON.parse(await readFile(new URL("../data/idlequest-zones.json", import.meta.url), "utf8"))).map(norm));
const zoneName = new Map();
for await (const z of rows("zone")) if (gameZones.has(norm(z.long_name))) zoneName.set(z.short_name, z.long_name);

// ---- Candidate items ---------------------------------------------------------------------------
const cands = new Map(); // id -> item with slot names and score
for await (const i of rows("items")) {
  if (!(i.classes & BIT[cls]) || (race && !(i.races & RACE[race])) || (i.reqlevel ?? 0) > level || !i.slots || i.augtype || i.bagslots) continue;
  const slots = slotName(i.slots);
  if (!slots.length) continue;
  const sc = score(i);
  if (sc <= 0 && !((slots.includes("primary") || slots.includes("secondary")) && i.damage)) continue;
  // Item types 1, 4 and 35 are two-handed slash, blunt and pierce.
  const ratio = i.damage && i.delay ? Math.min(i.damage, damageCap) / i.delay : 0;
  cands.set(i.id, { id: i.id, name: i.Name, slots, score: sc, req: i.reqlevel ?? 0, ac: i.ac, hp: i.hp, mana: i.mana, int: i.aint, wis: i.awis, dmg: i.damage, delay: i.delay, ratio, twoHand: [1, 4, 35].includes(i.itemtype), nodrop: i.nodrop, price: i.price });
}

// ---- Sources: item -> lootdrop -> loottable -> NPC -> spawns -> zone -------------------------
const dropsByItem = new Map(); // lootdrop_id -> [{item, chance, mult}]
for await (const e of rows("lootdrop_entries")) if (e.chance > 0 && cands.has(e.item_id)) (dropsByItem.get(e.lootdrop_id) ?? dropsByItem.set(e.lootdrop_id, []).get(e.lootdrop_id)).push({ item: e.item_id, chance: e.chance, mult: e.multiplier || 1 });
const ltsOfDrop = new Map(); // lootdrop_id -> [{lt, prob}]
for await (const e of rows("loottable_entries")) if (dropsByItem.has(e.lootdrop_id)) (ltsOfDrop.get(e.lootdrop_id) ?? ltsOfDrop.set(e.lootdrop_id, []).get(e.lootdrop_id)).push({ lt: e.loottable_id, prob: e.probability });
const itemsOfLt = new Map(); // loottable_id -> Map(item -> p)
for (const [drop, lts] of ltsOfDrop) for (const { lt, prob } of lts) for (const d of dropsByItem.get(drop)) {
  const m = itemsOfLt.get(lt) ?? itemsOfLt.set(lt, new Map()).get(lt);
  const p = (prob / 100) * (1 - (1 - d.chance / 100) ** d.mult);
  m.set(d.item, 1 - (1 - (m.get(d.item) ?? 0)) * (1 - p));
}
// Merchants: merchantlist maps a merchant id to the items it sells, and an NPC with that
// `merchant_id` sells them wherever it spawns.
const itemsOfMerchant = new Map(); // merchant id -> [item id]
for await (const m of rows("merchantlist")) if (cands.has(m.item)) (itemsOfMerchant.get(m.merchantid) ?? itemsOfMerchant.set(m.merchantid, []).get(m.merchantid)).push(m.item);
const npcsOfLt = new Map(); // npc id -> {name, level, lt}
const merchantNpcs = new Map(); // npc id -> {name, items}
for await (const n of rows("npc_types")) {
  if (n.level <= mobMax && itemsOfLt.has(n.loottable_id)) npcsOfLt.set(n.id, { id: n.id, name: n.name, level: n.level, lt: n.loottable_id });
  if (n.merchant_id && itemsOfMerchant.has(n.merchant_id)) merchantNpcs.set(n.id, { name: n.name, items: itemsOfMerchant.get(n.merchant_id) });
}
const groups = new Map(); // npc id -> [{group, chance}]
const groupTotal = new Map();
const needGroups = new Set();
for await (const s of rows("spawnentry")) {
  groupTotal.set(s.spawngroupID, (groupTotal.get(s.spawngroupID) ?? 0) + s.chance);
  if (npcsOfLt.has(s.npcID) || merchantNpcs.has(s.npcID)) {
    (groups.get(s.npcID) ?? groups.set(s.npcID, []).get(s.npcID)).push({ g: s.spawngroupID, chance: s.chance });
    needGroups.add(s.spawngroupID);
  }
}
const pointsOf = new Map(); // group -> {zone -> {n, respawn}}
for await (const sp of rows("spawn2")) {
  if (!needGroups.has(sp.spawngroupID) || !zoneName.has(sp.zone)) continue;
  const z = pointsOf.get(sp.spawngroupID) ?? pointsOf.set(sp.spawngroupID, new Map()).get(sp.spawngroupID);
  const r = z.get(sp.zone) ?? z.set(sp.zone, { n: 0, respawn: Infinity }).get(sp.zone);
  r.n++;
  r.respawn = Math.min(r.respawn, sp.respawntime);
}
const sources = new Map(); // item -> [{npc, level, zone, drop, spawn, points, respawn}]
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
    list.push({ npc: npc.name.replace(/_/g, " "), level: npc.level, zone: zoneName.get(zone), drop: p, spawn: z.spawn, points: z.n, respawn: z.respawn });
  }
}
const sellers = new Map(); // item -> [{npc, zone}]
for (const [id, m] of merchantNpcs) {
  const zones = new Set();
  for (const { g } of groups.get(id) ?? []) for (const zone of (pointsOf.get(g) ?? new Map()).keys()) zones.add(zone);
  for (const zone of zones) for (const item of m.items) (sellers.get(item) ?? sellers.set(item, []).get(item)).push({ npc: m.name.replace(/_/g, " "), zone: zoneName.get(zone) });
}

// ---- Report: top items per slot ---------------------------------------------------------------
console.log(`${cls} (${group})${race ? `, ${race}` : ""}, level ${level}, drops from mobs up to level ${mobMax}\n`);
const bySlot = new Map();
for (const it of cands.values()) for (const s of it.slots) (bySlot.get(s) ?? bySlot.set(s, []).get(s)).push(it);
const obtainable = (i) => sources.has(i.id) || sellers.has(i.id);
for (const [slot] of Object.entries(SLOTS)) {
  if (slotFilter && slot !== slotFilter) continue;
  // In the hands a weapon's capped damage over delay decides ordinary swings; a shield or other
  // non-weapon secondary item is still ranked by its stats after the weapons.
  const hand = slot === "primary" || slot === "secondary";
  const list = (bySlot.get(slot) ?? []).filter((i) => (obtainable(i) || i.score > 0) && !(slot === "secondary" && i.twoHand));
  // Prefer items that can actually be farmed or bought: whether a source exists, then the ratio
  // in the hands, then score.
  list.sort((a, b) => (obtainable(b) ? 1 : 0) - (obtainable(a) ? 1 : 0) || (hand ? b.ratio - a.ratio : 0) || b.score - a.score);
  if (!list.length) continue;
  console.log(`== ${slot}${hand ? ` (damage capped at ${damageCap})` : ""}`);
  for (const it of list.slice(0, top)) {
    const st = [it.ac && `ac ${it.ac}`, it.hp && `hp ${it.hp}`, it.mana && `mana ${it.mana}`, it.int && `int ${it.int}`, it.wis && `wis ${it.wis}`, it.dmg && `${it.dmg}/${it.delay} ratio ${it.ratio.toFixed(2)}${it.twoHand ? " 2H" : ""}`].filter(Boolean).join(" ");
    const src = (sources.get(it.id) ?? []).sort((a, b) => b.drop * b.spawn - a.drop * a.spawn).slice(0, 2);
    const sold = (sellers.get(it.id) ?? []).slice(0, 2);
    console.log(`  ${it.name.padEnd(30)} score ${it.score.toFixed(0).padStart(4)}  ${st}${it.nodrop === 0 ? " [no drop]" : ""}`);
    if (!src.length && !sold.length) console.log("      quest or unknown");
    for (const s of sold) console.log(`      sold by ${s.npc} in ${s.zone}, base price ${((it.price ?? 0) / 1000).toFixed(1)} pp`);
    for (const s of src) console.log(`      ${s.npc} (L${s.level}) in ${s.zone}: ${(s.drop * 100).toFixed(0)}% drop, ${(s.spawn * 100).toFixed(0)}% spawn, ${s.points} points, respawn ${s.respawn}s`);
  }
}
