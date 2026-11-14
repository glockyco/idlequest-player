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
 * requests `craftItem` (src/bridge.js) sends, and inside the live expansion. A recipe's container
 * is no part: `craftItem` crafts world-container recipes without one, and a recipe whose only
 * container is an item, such as the Enchanters Sack, still fails there. A part the recipe hands
 * back, such as a tool, is no yield.
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

// The spawn tables as lookups, read once per content root and process: NPC ids by name, spawn
// groups by NPC and each zone's spawn points in the table's order.
const spawnTables = new Map();
function spawnLookups(root) {
  const key = contentRoot(root);
  if (!spawnTables.has(key)) {
    spawnTables.set(
      key,
      (async () => {
        const ids = new Map();
        for await (const n of rows("npc_types", root)) (ids.get(n.name) ?? ids.set(n.name, []).get(n.name)).push(n.id);
        const groups = new Map();
        for await (const s of liveSpawnRows("spawnentry", root)) (groups.get(s.npcID) ?? groups.set(s.npcID, []).get(s.npcID)).push(s.spawngroupID);
        const points = new Map();
        for await (const p of liveSpawnRows("spawn2", root)) (points.get(p.zone) ?? points.set(p.zone, []).get(p.zone)).push(p);
        // A pattern that is one whole name is looked up, not matched against every name.
        const byKey = new Map();
        for (const name of ids.keys()) (byKey.get(nameKey(name)) ?? byKey.set(nameKey(name), []).get(nameKey(name))).push(name);
        return { ids, groups, points, byKey };
      })(),
    );
  }
  return spawnTables.get(key);
}
const nameKey = (name) => name.replace(/ /g, "_").toLowerCase();
const WHOLE_NAME = /^\^((?:[^\\^$.*+?()[\]{}|]|\\.)+)\$$/;

/**
 * The spawn points (spawn2 ids) in each query's `zone` whose spawn groups can put up an NPC whose
 * name matches its `pattern` (spaces match underscores), for many queries at once. A directed hunt
 * camps these points, and a quest step looks at its NPC's. Resolves with one array of point ids
 * per query, in the queries' order. The tables are read once: matching every query against every
 * row took the collector's thread for minutes after each start, with a query per gear target.
 */
export async function spawnPoints(queries, root) {
  const { ids, groups, points, byKey } = await spawnLookups(root);
  return queries.map((q) => {
    const whole = WHOLE_NAME.exec(q.pattern);
    const re = new RegExp(q.pattern.replace(/ /g, "[ _]"), "i");
    const names = whole ? (byKey.get(nameKey(whole[1].replace(/\\(.)/g, "$1"))) ?? []) : [...ids.keys()];
    const wanted = new Set();
    for (const name of names) if (re.test(name)) for (const id of ids.get(name)) for (const g of groups.get(id) ?? []) wanted.add(g);
    return (points.get(q.zone) ?? []).filter((p) => wanted.has(p.spawngroupID)).map((p) => p.id);
  });
}

/**
 * Where each of `names` spawns in the live world: a Map from the name to its spawn points,
 * `[{ zone, point, respawnMs, varianceMs }]`, empty for an NPC no live spawn group puts up, such as a boss a
 * script summons. `key` makes a content name and a wanted name comparable, since a list can say
 * "Cazic-Thule" for the content's "#Cazic_Thule".
 */
export async function namedSpawns(names, key, root) {
  const { ids, groups, points } = await spawnLookups(root);
  const wanted = new Map(names.map((n) => [key(n), n]));
  const nameOf = new Map();
  for (const [name, list] of ids) {
    const n = wanted.get(key(name));
    if (n != null) for (const id of list) for (const g of groups.get(id) ?? []) nameOf.set(g, n);
  }
  const out = new Map(names.map((n) => [n, []]));
  for (const [zone, list] of points) {
    for (const p of list) if (nameOf.has(p.spawngroupID)) out.get(nameOf.get(p.spawngroupID)).push({ zone, point: p.id, respawnMs: p.respawntime * 1000, varianceMs: (p.variance ?? 0) * 1000 });
  }
  return out;
}
