// Where do items drop? Reads the developer's public content snapshot (brynnb/idlequest-content).
//
//   bun tools/drops.mjs item <name regex> [--data <repo dir>] [--max-level N] [--max-expansion N] [--limit N] [--json]
//   bun tools/drops.mjs item --list <names.json> [--json]   exact item names from a JSON array, such as a gear list
//   bun tools/drops.mjs npc  <name regex> [--data <repo dir>] [--max-expansion N] [--limit N] [--json]
//
// The data directory defaults to $IQ_CONTENT, then ~/src/github.com/brynnb/idlequest-content. The
// join is `loadSources` in tools/lib/gear-data.mjs, which the gear plan uses too.
//
// Numbers are approximate. They come from a development snapshot and ignore content flags, the
// server's own loot rules and quest-only drops.
//   drop%     chance an NPC kill drops the item: table probability times the item's chance in its drop
//   spawn%    chance that a spawn point of the group puts this NPC up when it respawns
//   points    spawn points that can hold the NPC in the zone
//   respawn   seconds between respawns at a spawn point (smallest seen)
//   when      night or day for an NPC whose points spawn only then (iq.gameHour() gives the game's hour, night is 20 to 5)
//   rare      spawn% under 20 (the NPC shares a group with more common ones) or a `#` named NPC
import { contentRoot, rows as contentRows } from "./lib/content.mjs";
import { loadSources } from "./lib/gear-data.mjs";

const args = process.argv.slice(2);
const [mode, pattern] = args.filter((a) => !a.startsWith("--"));
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const root = contentRoot(opt("data", undefined));
const limit = Number(opt("limit", 25));
const maxLevel = Number(opt("max-level", 255));
const maxExpansion = Number(opt("max-expansion", 2)); // 0 Classic, 1 Kunark, 2 Velious. IdleQuest stops at Velious.
const list = opt("list", null) ? new Set(JSON.parse(await Bun.file(opt("list")).text())) : null;
if (!["item", "npc"].includes(mode) || (!pattern && !list)) {
  console.error("usage: bun tools/drops.mjs item|npc <name regex> [--list names.json] [--data dir] [--max-level N] [--limit N] [--json]");
  process.exit(2);
}
const re = list ? { test: (name) => list.has(name) } : new RegExp(pattern.replace(/ /g, "[ _]"), "i");
const rows = (table) => contentRows(table, root);

const zoneName = new Map();
for await (const z of rows("zone")) if ((z.expansion ?? 0) <= maxExpansion && !zoneName.has(z.short_name)) zoneName.set(z.short_name, z.long_name);
// Item mode asks for the matching items, NPC mode for every item of the matching NPCs.
const itemNames = new Map();
for await (const it of rows("items")) if (mode === "npc" || re.test(it.Name)) itemNames.set(it.id, it.Name);
if (mode === "item" && !itemNames.size) {
  console.log("no item matches");
  process.exit(0);
}
const { sources } = await loadSources(root, { itemIds: new Set(itemNames.keys()), maxNpcLevel: maxLevel, zoneName, skipNpc: mode === "npc" ? (n) => !re.test(n.name) : () => false });

// Level variants of one NPC type show once per item and zone.
const agg = new Map();
for (const [item, list] of sources) {
  for (const s of list) {
    const key = `${item}|${s.npc}|${s.zoneShort}`;
    const r = agg.get(key);
    const when = s.when ?? "always";
    if (!r) agg.set(key, { item: itemNames.get(item) ?? item, npc: s.npc, lo: s.level, hi: s.level, zone: s.zone, drop: s.drop, spawn: s.spawn, points: s.points, respawn: s.respawn, when: new Set([when]), rare: s.spawn < 0.2 || s.npc.startsWith("#") });
    else {
      r.lo = Math.min(r.lo, s.level);
      r.hi = Math.max(r.hi, s.level);
      r.points += s.points;
      r.drop = Math.max(r.drop, s.drop);
      r.spawn = Math.max(r.spawn, s.spawn);
      r.respawn = Math.min(r.respawn, s.respawn);
      r.when.add(when);
      r.rare ||= s.spawn < 0.2 || s.npc.startsWith("#");
    }
  }
}
const lines = [...agg.values()];
// Best first: higher chance to get the item per kill, then more spawn points.
lines.sort((a, b) => b.drop * b.spawn - a.drop * a.spawn || b.points - a.points);
if (args.includes("--json")) {
  console.log(JSON.stringify(lines.map((l) => ({ ...l, when: [...l.when].sort() }))));
  process.exit(0);
}
console.log(`${lines.length} sources${lines.length > limit ? `, top ${limit}` : ""}\n`);
console.log("item".padEnd(30) + "npc".padEnd(30) + "lvl".padStart(7) + "  zone".padEnd(34) + "drop%".padStart(7) + "spawn%".padStart(8) + "points".padStart(7) + "respawn".padStart(8) + "  when".padEnd(14) + "rare");
for (const l of lines.slice(0, limit)) {
  const lvl = l.lo === l.hi ? String(l.lo) : `${l.lo}-${l.hi}`;
  console.log(
    String(l.item).slice(0, 29).padEnd(30) + l.npc.slice(0, 29).padEnd(30) + lvl.padStart(7) + ("  " + l.zone).slice(0, 33).padEnd(34) +
      (l.drop * 100).toFixed(1).padStart(7) + (l.spawn * 100).toFixed(0).padStart(8) + String(l.points).padStart(7) + String(Number.isFinite(l.respawn) ? l.respawn : "-").padStart(8) + ("  " + [...l.when].sort().join("/")).padEnd(14) + (l.rare ? "yes" : ""),
  );
}
