// Build zone snapshots offline from the developer's content snapshot, in the format `scoutZones`
// saves, so `tools/zones.mjs` can rank zones without visiting them (and without stopping AutoLevel).
//
//   bun tools/zone-snapshots.mjs <out dir> <zone short name or long name regex>...  [--data <repo dir>]
//
// Each spawn point becomes one spawn of its most likely NPC, with the other group members in `alt`. Positions come from `spawn2` (x, y), levels from
// `npc_types`. This is the static spawn table: no wandering, no script spawns, no content flags,
// so treat counts as approximate and check against a live scout once (Blackburrow at level 5 scouts
// at 86 candidates and nn 34).
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { liveSpawnRows, rows as contentRows } from "./lib/content.mjs";

const args = process.argv.slice(2);
const pos = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--data");
const di = args.indexOf("--data");
const root = di >= 0 ? args[di + 1] : (process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`);
const [outDir, ...patterns] = pos;
if (!outDir || !patterns.length) {
  console.error("usage: bun tools/zone-snapshots.mjs <out dir> <zone regex>... [--data dir]");
  process.exit(2);
}
const rows = (table) => contentRows(table, root);
const res = patterns.map((p) => new RegExp(p, "i"));
const zones = new Map(); // short -> row
for await (const z of rows("zone")) if (res.some((r) => r.test(z.short_name) || r.test(z.long_name)) && !zones.has(z.short_name)) zones.set(z.short_name, z);
if (!zones.size) {
  console.error("no zone matches");
  process.exit(1);
}
const points = new Map(); // group -> [{zone,x,y}]
for await (const s of liveSpawnRows("spawn2", root)) {
  if (!zones.has(s.zone)) continue;
  (points.get(s.spawngroupID) ?? points.set(s.spawngroupID, []).get(s.spawngroupID)).push({ zone: s.zone, x: s.x, y: s.y });
}
const members = new Map(); // group -> [{npcID, chance}]
const npcIds = new Set();
for await (const e of liveSpawnRows("spawnentry", root)) {
  if (!points.has(e.spawngroupID)) continue;
  (members.get(e.spawngroupID) ?? members.set(e.spawngroupID, []).get(e.spawngroupID)).push({ npcID: e.npcID, chance: e.chance });
  npcIds.add(e.npcID);
}
const npcs = new Map();
for await (const n of rows("npc_types")) if (npcIds.has(n.id)) npcs.set(n.id, n);

await mkdir(outDir, { recursive: true });
for (const [short, z] of zones) {
  const spawns = [];
  const defs = new Map();
  for (const [g, pts] of points) {
    for (const p of pts.filter((p) => p.zone === short)) {
      // A spawn point holds one NPC at a time. The most likely one stands for the point; the rest
      // are listed in `alt` with their chance, so rares and placeholders stay visible.
      const list = (members.get(g) ?? []).filter((m) => npcs.has(m.npcID)).sort((a, b) => b.chance - a.chance);
      if (!list.length) continue;
      const total = list.reduce((a, m) => a + m.chance, 0);
      const n = npcs.get(list[0].npcID);
      spawns.push({
        npcId: n.id, name: n.name, level: n.level, x: Math.round(p.x), y: Math.round(p.y), aggro: n.aggroradius, grid: 0,
        alt: list.slice(1).map((m) => ({ npcId: m.npcID, name: npcs.get(m.npcID).name, level: npcs.get(m.npcID).level, chance: +(m.chance / total).toFixed(3) })),
      });
      for (const m of list) {
        const d = npcs.get(m.npcID);
        defs.set(d.id, { id: d.id, cls: d.class, merchant: d.merchant_id, quest: 0, body: d.bodytype });
      }
    }
  }
  const file = `${outDir}/${short}.json`;
  await writeFile(file, JSON.stringify({ zone: z.long_name, shortName: short, safe: { x: z.safe_x, y: z.safe_y }, takenAt: null, source: "content", spawns, defs: [...defs.values()] }));
  console.log(`${z.long_name.padEnd(36)} ${String(spawns.length).padStart(5)} spawns -> ${file}`);
}
