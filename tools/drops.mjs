// Where do items drop? Reads the developer's public content snapshot (brynnb/idlequest-content).
//
//   bun tools/drops.mjs item <name regex> [--data <repo dir>] [--max-level N] [--max-expansion N] [--limit N]
//   bun tools/drops.mjs npc  <name regex> [--data <repo dir>] [--max-expansion N] [--limit N]
//
// The data directory defaults to $IQ_CONTENT, then ~/src/github.com/brynnb/idlequest-content.
// Join: item -> lootdrop_entries -> loottable_entries -> npc_types -> spawnentry -> spawn2 -> zone.
//
// Numbers are approximate. They come from a development snapshot and ignore content flags, the
// server's own loot rules and quest-only drops.
//   drop%     chance an NPC kill drops the item: table probability times the item's chance in its drop
//   spawn%    chance that a spawn point of the group puts this NPC up when it respawns
//   points    spawn points that can hold the NPC in the zone
//   respawn   seconds between respawns at a spawn point (smallest seen)
//   rare      spawn% under 20 (the NPC shares a group with more common ones) or a `#` named NPC
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const [mode, pattern] = args.filter((a) => !a.startsWith("--"));
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const root = opt("data", process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`);
const limit = Number(opt("limit", 25));
const maxLevel = Number(opt("max-level", 255));
const maxExpansion = Number(opt("max-expansion", 2)); // 0 Classic, 1 Kunark, 2 Velious. IdleQuest stops at Velious.
if (!["item", "npc"].includes(mode) || !pattern) {
  console.error("usage: bun tools/drops.mjs item|npc <name regex> [--data dir] [--max-level N] [--limit N]");
  process.exit(2);
}
const re = new RegExp(pattern.replace(/ /g, "[ _]"), "i");

async function* rows(table) {
  const dir = `${root}/data/${table}`;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".ndjson"))) {
    for (const line of (await readFile(`${dir}/${f}`, "utf8")).split("\n")) if (line) yield JSON.parse(line);
  }
}

const zoneName = new Map();
const zoneExp = new Map();
for await (const z of rows("zone")) {
  zoneName.set(z.short_name, z.long_name);
  zoneExp.set(z.short_name, z.expansion);
}

// ---- Start from items or NPCs ----------------------------------------------------------------
const items = new Map(); // id -> name
for await (const it of rows("items")) if (mode === "item" && re.test(it.Name)) items.set(it.id, it.Name);
if (mode === "item" && !items.size) {
  console.log("no item matches");
  process.exit(0);
}

const npcs = new Map(); // id -> {id,name,level,lt}
for await (const n of rows("npc_types")) {
  if (mode === "npc" ? re.test(n.name) : n.loottable_id > 0) npcs.set(n.id, { id: n.id, name: n.name, level: n.level, lt: n.loottable_id });
}

// loottable -> lootdrops, lootdrop -> items
const ltEntries = new Map(); // loottable_id -> [{drop, prob, mult}]
for await (const e of rows("loottable_entries")) (ltEntries.get(e.loottable_id) ?? ltEntries.set(e.loottable_id, []).get(e.loottable_id)).push({ drop: e.lootdrop_id, prob: e.probability, mult: e.multiplier });
const dropItems = new Map(); // lootdrop_id -> [{item, chance, mult}]
for await (const e of rows("lootdrop_entries")) {
  if (e.chance <= 0) continue;
  (dropItems.get(e.lootdrop_id) ?? dropItems.set(e.lootdrop_id, []).get(e.lootdrop_id)).push({ item: e.item_id, chance: e.chance, mult: e.multiplier || 1 });
}
const itemNames = new Map(items);
if (mode === "npc") for await (const it of rows("items")) itemNames.set(it.id, it.Name);

// NPC -> [{item, p}]
const pOf = (prob, chance, mult) => (prob / 100) * (1 - (1 - chance / 100) ** mult);
function dropsOfNpc(npc) {
  const out = new Map();
  for (const lt of ltEntries.get(npc.lt) ?? []) {
    for (const d of dropItems.get(lt.drop) ?? []) {
      if (mode === "item" && !items.has(d.item)) continue;
      out.set(d.item, 1 - (1 - (out.get(d.item) ?? 0)) * (1 - pOf(lt.prob, d.chance, d.mult)));
    }
  }
  return out;
}

const wanted = new Map(); // npc id -> drops
for (const n of npcs.values()) {
  if (n.level > maxLevel) continue;
  const d = dropsOfNpc(n);
  if (d.size) wanted.set(n.id, d);
}

// ---- Spawns ------------------------------------------------------------------------------------
const groupTotal = new Map();
const groupsOf = new Map(); // npc id -> [{group, chance}]
const groupsNeeded = new Set();
for await (const s of rows("spawnentry")) {
  groupTotal.set(s.spawngroupID, (groupTotal.get(s.spawngroupID) ?? 0) + s.chance);
  if (wanted.has(s.npcID)) {
    (groupsOf.get(s.npcID) ?? groupsOf.set(s.npcID, []).get(s.npcID)).push({ group: s.spawngroupID, chance: s.chance });
    groupsNeeded.add(s.spawngroupID);
  }
}
const points = new Map(); // group -> [{zone, respawn}]
for await (const sp of rows("spawn2")) if (groupsNeeded.has(sp.spawngroupID)) (points.get(sp.spawngroupID) ?? points.set(sp.spawngroupID, []).get(sp.spawngroupID)).push({ zone: sp.zone, respawn: sp.respawntime });

// ---- Report ------------------------------------------------------------------------------------
const agg = new Map(); // item|npc name|zone -> merged row, so level variants of one NPC type show once
for (const [npcId, drops] of wanted) {
  const npc = npcs.get(npcId);
  const byZone = new Map();
  for (const { group, chance } of groupsOf.get(npcId) ?? []) {
    for (const p of points.get(group) ?? []) {
      const z = byZone.get(p.zone) ?? { points: 0, respawn: Infinity, spawn: 0 };
      z.points++;
      z.respawn = Math.min(z.respawn, p.respawn);
      // A group whose entries all have chance 0 always spawns its single NPC.
      z.spawn = Math.max(z.spawn, groupTotal.get(group) ? chance / groupTotal.get(group) : 1);
      byZone.set(p.zone, z);
    }
  }
  for (const [zone, z] of byZone) {
    if ((zoneExp.get(zone) ?? 0) > maxExpansion) continue;
    for (const [item, p] of drops) {
      const key = `${item}|${npc.name}|${zone}`;
      const r = agg.get(key);
      const row = { item: itemNames.get(item) ?? item, npc: npc.name, lo: npc.level, hi: npc.level, zone: zoneName.get(zone) ?? zone, drop: p, spawn: z.spawn, points: z.points, respawn: z.respawn, rare: z.spawn < 0.2 || npc.name.startsWith("#") };
      if (!r) agg.set(key, row);
      else {
        r.lo = Math.min(r.lo, row.lo);
        r.hi = Math.max(r.hi, row.hi);
        r.points += row.points;
        r.drop = Math.max(r.drop, row.drop);
        r.spawn = Math.max(r.spawn, row.spawn);
        r.respawn = Math.min(r.respawn, row.respawn);
        r.rare ||= row.rare;
      }
    }
  }
}
const lines = [...agg.values()];
// Best first: higher chance to get the item per kill, then more spawn points.
lines.sort((a, b) => b.drop * b.spawn - a.drop * a.spawn || b.points - a.points);
console.log(`${lines.length} sources${lines.length > limit ? `, top ${limit}` : ""}\n`);
console.log("item".padEnd(30) + "npc".padEnd(30) + "lvl".padStart(7) + "  zone".padEnd(34) + "drop%".padStart(7) + "spawn%".padStart(8) + "points".padStart(7) + "respawn".padStart(8) + "  rare");
for (const l of lines.slice(0, limit)) {
  const lvl = l.lo === l.hi ? String(l.lo) : `${l.lo}-${l.hi}`;
  console.log(
    String(l.item).slice(0, 29).padEnd(30) + l.npc.replace(/_/g, " ").slice(0, 29).padEnd(30) + lvl.padStart(7) + ("  " + l.zone).slice(0, 33).padEnd(34) +
      (l.drop * 100).toFixed(1).padStart(7) + (l.spawn * 100).toFixed(0).padStart(8) + String(l.points).padStart(7) + String(Number.isFinite(l.respawn) ? l.respawn : "-").padStart(8) + (l.rare ? "  yes" : ""),
  );
}
