// Reads the content snapshot (github.com/brynnb/idlequest-content): NDJSON tables under
// <root>/data/<table>/*.ndjson. The root defaults to $IQ_CONTENT, then
// ~/src/github.com/brynnb/idlequest-content.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";

export const contentRoot = (root) => root ?? process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`;

/** Every row of `table`, one object per NDJSON line. */
export async function* rows(table, root) {
  const dir = `${contentRoot(root)}/data/${table}`;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".ndjson"))) {
    for (const line of (await readFile(`${dir}/${f}`, "utf8")).split("\n")) if (line) yield JSON.parse(line);
  }
}

/**
 * The spawn points (spawn2 ids) in `zone` whose spawn groups can put up an NPC whose name matches
 * `pattern` (spaces match underscores). A directed hunt watches these points: the one that
 * respawns first is when the next wanted enemy can appear.
 */
export async function spawnPoints(zone, pattern, root) {
  const re = new RegExp(pattern.replace(/ /g, "[ _]"), "i");
  const npcs = new Set();
  for await (const n of rows("npc_types", root)) if (re.test(n.name)) npcs.add(n.id);
  const groups = new Set();
  for await (const s of rows("spawnentry", root)) if (npcs.has(s.npcID)) groups.add(s.spawngroupID);
  const points = [];
  for await (const p of rows("spawn2", root)) if (p.zone === zone && groups.has(p.spawngroupID)) points.push(p.id);
  return points;
}
