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
 * Every item id some quest script accepts in a hand-in (`item_lib.check_turn_in(e.trade, { item1 = id })`
 * or `eq.handin({ [id] = n })` under <root>/effective/quests), sorted. Epic pieces are among them, and many have no price and
 * are NO DROP, which the bag reserve would otherwise destroy.
 */
export async function questItemIds(root) {
  const dir = `${contentRoot(root)}/effective/quests`;
  const ids = new Set();
  for (const f of await readdir(dir, { recursive: true })) {
    if (!f.endsWith(".lua")) continue;
    for (const line of (await readFile(`${dir}/${f}`, "utf8")).split("\n")) {
      if (line.includes("check_turn_in")) for (const m of line.matchAll(/item\d+\s*=\s*(\d+)/g)) ids.add(Number(m[1]));
      if (line.includes("eq.handin")) for (const m of line.matchAll(/\[(\d+)\]\s*=/g)) ids.add(Number(m[1]));
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * When a spawn point spawns: a point with a `_condition` spawns only while that zone condition is
 * on, such as Kithicor's night (spawn_conditions, switched by spawn_events). Resolves with
 * `timeOf(zone, condition)`, "night", "day", the condition's name for other conditions, or null
 * for a point without one.
 */
export async function spawnTimes(root) {
  const names = new Map();
  for await (const c of rows("spawn_conditions", root)) names.set(`${c.zone}:${c.id}`, c.name);
  return (zone, cond) => {
    if (!cond) return null;
    const name = names.get(`${zone}:${cond}`) ?? `condition ${cond}`;
    return /night/i.test(name) ? "night" : /day/i.test(name) ? "day" : name;
  };
}

/**
 * The spawn points (spawn2 ids) in each query's `zone` whose spawn groups can put up an NPC whose
 * name matches its `pattern` (spaces match underscores), for many queries in one read of the
 * spawn tables. A directed hunt camps these points, and a quest step looks at its NPC's. Resolves
 * with one array of point ids per query, in the queries' order.
 */
export async function spawnPoints(queries, root) {
  const res = queries.map((q) => new RegExp(q.pattern.replace(/ /g, "[ _]"), "i"));
  const npcs = queries.map(() => new Set());
  for await (const n of rows("npc_types", root)) res.forEach((re, k) => re.test(n.name) && npcs[k].add(n.id));
  const groups = queries.map(() => new Set());
  for await (const s of rows("spawnentry", root)) npcs.forEach((set, k) => set.has(s.npcID) && groups[k].add(s.spawngroupID));
  const points = queries.map(() => []);
  for await (const p of rows("spawn2", root)) queries.forEach((q, k) => p.zone === q.zone && groups[k].has(p.spawngroupID) && points[k].push(p.id));
  return points;
}
