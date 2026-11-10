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

// The expansion the live server plays, Classic through Velious: a spawn row or a recipe that needs
// a later expansion does not exist there. -1 bounds a range on neither side.
export const LIVE_EXPANSION = 2;
const inLiveExpansion = (r) => !(r.min_expansion > LIVE_EXPANSION || (r.max_expansion >= 0 && r.max_expansion < LIVE_EXPANSION));

/**
 * The rows of spawn table `table` (`spawn2` or `spawnentry`) the live server uses: inside the live
 * expansion's range, for spawn points the zone's base version, since a higher version belongs to an
 * instanced copy of the zone, and for spawn entries a weight above 0, since an entry at weight 0
 * counts as never spawning (docs/plans/epics.md, rule 11). A spawn point's zone comes in lower
 * case, since the server's database compares zone names without case and Everfrost's points name it
 * "Everfrost". Every reader of the spawn tables goes through this.
 */
export async function* liveSpawnRows(table, root) {
  for await (const r of rows(table, root)) {
    if (r.version > 0) continue;
    if (table === "spawnentry" && !(r.chance > 0)) continue;
    if (!inLiveExpansion(r)) continue;
    yield typeof r.zone === "string" && r.zone !== r.zone.toLowerCase() ? { ...r, zone: r.zone.toLowerCase() } : r;
  }
}

/**
 * The recipes a character can craft, `Map<id, { id, name, skill, trivial, nofail, parts, yields }>`
 * with `parts` and `yields` as `[{ item, n }]`: enabled, shown in the Advanced recipe window, whose
 * requests `craftItem` (src/bridge.js) sends, and inside the live expansion. The server crafts
 * without a container, so a recipe's container is no part, and a part the recipe hands back, such as
 * a tool, is no yield.
 */
export async function craftableRecipes(root) {
  const recipes = new Map();
  for await (const r of rows("tradeskill_recipe", root)) {
    if (r.enabled && r.show_in_advanced && inLiveExpansion(r)) recipes.set(r.id, { id: r.id, name: r.name, skill: r.tradeskill, trivial: r.trivial, nofail: Boolean(r.nofail), parts: [], yields: [] });
  }
  for await (const e of rows("tradeskill_recipe_entries", root)) {
    const r = recipes.get(e.recipe_id);
    if (!r || e.iscontainer) continue;
    if (e.componentcount > 0) r.parts.push({ item: e.item_id, n: e.componentcount });
    if (e.successcount > 0) r.yields.push({ item: e.item_id, n: e.successcount });
  }
  for (const r of recipes.values()) r.yields = r.yields.filter((y) => !r.parts.some((p) => p.item === y.item));
  return recipes;
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
  for await (const s of liveSpawnRows("spawnentry", root)) npcs.forEach((set, k) => set.has(s.npcID) && groups[k].add(s.spawngroupID));
  const points = queries.map(() => []);
  for await (const p of liveSpawnRows("spawn2", root)) queries.forEach((q, k) => p.zone === q.zone && groups[k].has(p.spawngroupID) && points[k].push(p.id));
  return points;
}
