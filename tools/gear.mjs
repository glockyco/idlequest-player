// Best gear for a class at a level, and where it drops.
//
//   bun tools/gear.mjs <class> --level N [--slot head] [--mob-max N] [--top 3] [--data dir]
//   class: warrior cleric paladin ranger shadowknight druid monk bard rogue shaman necromancer wizard magician enchanter
//
// Reads the developer's public content snapshot (see tools/drops.mjs). Items are limited to the
// class, `reqlevel <= level`, and a drop source whose NPC is at most `mob-max` levels (default
// level+6) in a zone IdleQuest has. Items nobody drops are shown as "merchant or quest".
//
// The score is a rough stat value, not a simulation. Weights, per point:
//   casters (wizard magician enchanter necromancer): mana 1, hp 0.4, ac 1, int and wis from the
//     game's own mana formula (80 * level / 425 mana per point below 200), the unused one at 30%
//   priests (cleric druid shaman): the same with wis as the main stat
//   melee (warrior rogue monk): hp 0.5, ac 1.5, str/sta/dex/agi 1, attack 0.3
//   hybrids (paladin ranger shadowknight bard): melee weights plus mana 0.5
//   all: resists 0.3 each, haste 3 per percent, hp/mana regen 8 per point
// Weapons also show damage/delay. Haste and procs are not valued beyond the haste weight.
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
  if (!(i.classes & BIT[cls]) || (i.reqlevel ?? 0) > level || !i.slots || i.augtype || i.bagslots) continue;
  const slots = slotName(i.slots);
  if (!slots.length) continue;
  const sc = score(i);
  if (sc <= 0 && !(slots.includes("primary") && i.damage)) continue;
  cands.set(i.id, { id: i.id, name: i.Name, slots, score: sc, req: i.reqlevel ?? 0, ac: i.ac, hp: i.hp, mana: i.mana, int: i.aint, wis: i.awis, dmg: i.damage, delay: i.delay, nodrop: i.nodrop });
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
const npcsOfLt = new Map(); // npc id -> {name, level, lt}
for await (const n of rows("npc_types")) if (n.level <= mobMax && itemsOfLt.has(n.loottable_id)) npcsOfLt.set(n.id, { id: n.id, name: n.name, level: n.level, lt: n.loottable_id });
const groups = new Map(); // npc id -> [{group, chance}]
const groupTotal = new Map();
const needGroups = new Set();
for await (const s of rows("spawnentry")) {
  groupTotal.set(s.spawngroupID, (groupTotal.get(s.spawngroupID) ?? 0) + s.chance);
  if (npcsOfLt.has(s.npcID)) {
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

// ---- Report: top items per slot ---------------------------------------------------------------
console.log(`${cls} (${group}), level ${level}, sources up to mob level ${mobMax}\n`);
const bySlot = new Map();
for (const it of cands.values()) for (const s of it.slots) (bySlot.get(s) ?? bySlot.set(s, []).get(s)).push(it);
for (const [slot] of Object.entries(SLOTS)) {
  if (slotFilter && slot !== slotFilter) continue;
  const list = (bySlot.get(slot) ?? []).filter((i) => sources.has(i.id) || i.score > 0);
  // Prefer items that can actually be farmed: score, then whether a source exists.
  list.sort((a, b) => (sources.has(b.id) ? 1 : 0) - (sources.has(a.id) ? 1 : 0) || b.score - a.score);
  if (!list.length) continue;
  console.log(`== ${slot}`);
  for (const it of list.slice(0, top)) {
    const st = [it.ac && `ac ${it.ac}`, it.hp && `hp ${it.hp}`, it.mana && `mana ${it.mana}`, it.int && `int ${it.int}`, it.wis && `wis ${it.wis}`, it.dmg && `${it.dmg}/${it.delay}`].filter(Boolean).join(" ");
    const src = (sources.get(it.id) ?? []).sort((a, b) => b.drop * b.spawn - a.drop * a.spawn).slice(0, 2);
    console.log(`  ${it.name.padEnd(30)} score ${it.score.toFixed(0).padStart(4)}  ${st}${it.nodrop ? " [no drop]" : ""}`);
    if (!src.length) console.log("      merchant or quest");
    for (const s of src) console.log(`      ${s.npc} (L${s.level}) in ${s.zone}: ${(s.drop * 100).toFixed(0)}% drop, ${(s.spawn * 100).toFixed(0)}% spawn, ${s.points} points, respawn ${s.respawn}s`);
  }
}
