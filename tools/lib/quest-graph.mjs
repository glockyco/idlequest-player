// The account's quest graph, read from the content snapshot (docs/plans/items.md, "Quest graph"):
// which items an NPC takes and what it gives back, also through an NPC its script spawns, which it
// gives in dialogue, which items a tradeskill combine makes and which a spell summons. Demand for a
// chain is every input on the paths back from its reward.
import { readdir, readFile } from "node:fs/promises";
import { contentRoot, rows } from "./content.mjs";

const HANDIN = /check_turn_in|eq\.handin/;
// An event function ends at an unindented `end`, and its hand-in branches with it.
const FUNCTION_END = /^end\b/;

/** The item ids and counts a hand-in line takes: `{ item1 = 20380, item2 = 20524 }` or `{[14337] = 1}`. */
function handinInputs(line) {
  const inputs = {};
  if (line.includes("check_turn_in")) for (const m of line.matchAll(/item\d+\s*=\s*(\d+)/g)) inputs[m[1]] = (inputs[m[1]] ?? 0) + 1;
  if (line.includes("eq.handin")) for (const m of line.matchAll(/\[(\d+)\]\s*=\s*(\d+)/g)) inputs[m[1]] = (inputs[m[1]] ?? 0) + Number(m[2]);
  return inputs;
}

/**
 * The items, XP and NPC spawns a line gives: `SummonItem(20535)`, `QuestReward(e.self, {itemid =
 * 14339, exp = 500})` or its positional form `QuestReward(e.self, copper, silver, gold, platinum,
 * itemid, exp)`, `items = {1, 2}`, and `eq.spawn2(128089, ...)` or `eq.unique_spawn(...)`.
 */
function rewards(line) {
  const items = [...line.matchAll(/SummonItem\((\d+)/g), ...line.matchAll(/itemid\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  for (const m of line.matchAll(/items\s*=\s*\{([^}]*)\}/g)) items.push(...[...m[1].matchAll(/\d+/g)].map((x) => Number(x[0])));
  let exp = [...line.matchAll(/exp\s*=\s*(\d+)/g), ...line.matchAll(/AddEXP\((\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
  for (const m of line.matchAll(/QuestReward\(\s*e\.self\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d+)(?:\s*,\s*(\d+))?/g)) {
    if (Number(m[1]) > 0) items.push(Number(m[1]));
    exp += Number(m[2] ?? 0);
  }
  const spawns = [...line.matchAll(/eq\.(?:spawn2|unique_spawn)\((\d+)/g)].map((m) => Number(m[1]));
  return { items, exp, spawns };
}

/**
 * The edges of one NPC script: a hand-in per `check_turn_in` or `eq.handin` branch, with what the
 * lines up to the next branch or the function's end give, and a talk edge for what it gives outside
 * any branch. A branch's outputs leave out its own inputs, which a script hands back when a trade
 * does not match. `spawns` lists the NPCs an edge spawns, whose loot `questGraph` adds to its outputs.
 */
export function scriptEdges(text, { zone, npc }) {
  const edges = [];
  let open = null;
  const talk = { kind: "talk", zone, npc, inputs: {}, outputs: [], exp: 0, spawns: [] };
  for (const line of text.split("\n")) {
    if (HANDIN.test(line)) {
      open = { kind: "handin", zone, npc, inputs: handinInputs(line), outputs: [], exp: 0, spawns: [] };
      edges.push(open);
    } else if (FUNCTION_END.test(line)) open = null;
    const r = rewards(line);
    const at = open ?? talk;
    at.outputs.push(...r.items.filter((id) => !(String(id) in at.inputs)));
    at.exp += r.exp;
    at.spawns.push(...r.spawns);
  }
  if (talk.outputs.length || talk.spawns.length) edges.push(talk);
  for (const e of edges) {
    e.outputs = [...new Set(e.outputs)];
    e.spawns = [...new Set(e.spawns)];
  }
  return edges.filter((e) => e.outputs.length || e.exp > 0 || e.spawns.length);
}

// Spell effect 32 summons the item its base value names.
const SUMMON_ITEM = 32;

/**
 * Every hand-in, talk, combine and spell edge of the content snapshot, as `{ kind, zone, npc,
 * inputs: { id: count }, outputs: [id], exp }`. A hand-in or talk that spawns an NPC also gives
 * that NPC's loot. A spell edge takes the scroll that teaches the spell and the components a cast
 * consumes, and gives the item the spell summons.
 */
export async function questGraph(root) {
  const dir = `${contentRoot(root)}/effective/quests`;
  const edges = [];
  for (const f of await readdir(dir, { recursive: true })) {
    if (!f.endsWith(".lua")) continue;
    const [zone, file] = f.split("/");
    if (!file) continue;
    edges.push(...scriptEdges(await readFile(`${dir}/${f}`, "utf8"), { zone, npc: file.replace(/\.lua$/, "").replace(/^#/, "").replace(/_/g, " ") }));
  }
  // The loot of the NPCs scripts spawn: npc_types to loottable_entries to lootdrop_entries.
  const spawned = new Set(edges.flatMap((e) => e.spawns));
  const tableOf = new Map();
  for await (const n of rows("npc_types", root)) if (spawned.has(n.id) && n.loottable_id) tableOf.set(n.id, n.loottable_id);
  const dropsOf = new Map();
  for await (const t of rows("loottable_entries", root)) dropsOf.set(t.loottable_id, [...(dropsOf.get(t.loottable_id) ?? []), t.lootdrop_id]);
  const itemsOf = new Map();
  for await (const d of rows("lootdrop_entries", root)) itemsOf.set(d.lootdrop_id, [...(itemsOf.get(d.lootdrop_id) ?? []), d.item_id]);
  for (const e of edges) {
    const loot = e.spawns.flatMap((npc) => (dropsOf.get(tableOf.get(npc)) ?? []).flatMap((d) => itemsOf.get(d) ?? []));
    e.outputs = [...new Set([...e.outputs, ...loot.filter((id) => !(String(id) in e.inputs))])];
    delete e.spawns;
  }
  const scrolls = new Map();
  for await (const i of rows("items", root)) if (i.scrolleffect > 0) scrolls.set(i.scrolleffect, i.id);
  for await (const s of rows("spells_new", root)) {
    const summons = [];
    for (let k = 1; k <= 12; k++) if (s[`effectid${k}`] === SUMMON_ITEM && s[`effect_base_value${k}`] > 0) summons.push(s[`effect_base_value${k}`]);
    if (!summons.length || !scrolls.has(s.id)) continue;
    const inputs = { [scrolls.get(s.id)]: 1 };
    for (let k = 1; k <= 4; k++) if (s[`components${k}`] > 0) inputs[s[`components${k}`]] = (inputs[s[`components${k}`]] ?? 0) + (s[`component_counts${k}`] || 1);
    edges.push({ kind: "spell", zone: null, npc: null, spell: s.id, inputs, outputs: summons, exp: 0 });
  }
  const recipes = new Map();
  for await (const r of rows("tradeskill_recipe_entries", root)) {
    const e = recipes.get(r.recipe_id) ?? { kind: "combine", zone: null, npc: null, recipe: r.recipe_id, inputs: {}, outputs: [], exp: 0 };
    if (r.successcount > 0) e.outputs.push(r.item_id);
    // A container below id 1000 is a world object type, such as a forge, not an item to carry.
    if (r.componentcount > 0 || (r.iscontainer && r.item_id >= 1000)) e.inputs[r.item_id] = (e.inputs[r.item_id] ?? 0) + (r.componentcount || 1);
    recipes.set(r.recipe_id, e);
  }
  // A product that is also a component (a returned tool or container) is no output of its combine.
  for (const e of recipes.values()) e.outputs = e.outputs.filter((id) => !(String(id) in e.inputs));
  edges.push(...[...recipes.values()].filter((e) => e.outputs.length));
  return edges;
}

/**
 * The items a character needs for `target` (an item id): the inputs of every edge that gives it,
 * and of the edges that give those inputs, walking back until an item the character `holds` (a Set
 * of ids), an item a merchant sells (`buyable`, bought rather than made) or one no edge gives (a
 * drop or a ground item). Two edges that give the same item both count. Returns a Map of item id
 * to the copies one target takes.
 */
export function needFor(edges, target, holds = new Set(), buyable = new Set()) {
  const by = new Map();
  for (const e of edges) for (const id of e.outputs) by.set(id, [...(by.get(id) ?? []), e]);
  const need = new Map();
  const seen = new Set();
  const walk = (id) => {
    if (holds.has(id) || seen.has(id) || (id !== target && buyable.has(id))) return;
    seen.add(id);
    for (const e of by.get(id) ?? []) {
      for (const [input, count] of Object.entries(e.inputs)) {
        const n = Number(input);
        if (holds.has(n)) continue;
        need.set(n, Math.max(need.get(n) ?? 0, count));
        walk(n);
      }
    }
  };
  walk(target);
  return need;
}
