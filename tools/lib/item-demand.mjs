// The account's demand for items (docs/plans/items.md, "Demand"): how many copies of each item the
// account needs. Each source is a pure function from the game's data, and `addDemand` sums them,
// because two uses of one item each need their own copy.
import { readFile } from "node:fs/promises";
import { casinoBosses } from "./client-tables.mjs";
import { rows } from "./content.mjs";
import { doneItems } from "./coordinator.mjs";
import { needFor, questGraph } from "./quest-graph.mjs";

/**
 * What demand is computed from, read once because it changes only with a content or client update:
 * the quest graph's `edges`, the class `epics` (`data/epics.json`), the items a merchant sells
 * (`buyable`), the casino's potion `bosses`, item `names` by id and `ids` by name.
 */
export async function loadItemModel(root) {
  const [edges, bosses, epics] = await Promise.all([questGraph(root), casinoBosses(), readFile(new URL("../../data/epics.json", import.meta.url), "utf8").then(JSON.parse)]);
  const buyable = new Set();
  for await (const m of rows("merchantlist", root)) buyable.add(m.item);
  const names = new Map();
  const ids = new Map();
  for await (const i of rows("items", root)) {
    names.set(i.id, i.Name);
    ids.set(i.Name, [...(ids.get(i.Name) ?? []), i.id]);
  }
  return { edges, bosses, epics, buyable, names, ids };
}

/**
 * Copies of each item the roster's class epics take: one copy of a class's epic reward for each of
 * its members, and for each member that holds none of the rewards (`epicHolders`, names), the
 * copies one reward takes on the paths back from it (`needFor` of the quest graph `edges`, walking
 * back to items a merchant sells, `buyable`). A buyable input is bought at its step rather than
 * carried, so it is no demand.
 */
export function chainDemand({ edges, epics, members, epicHolders = new Set(), buyable = new Set() }) {
  const out = {};
  const add = (id, n) => (out[id] = (out[id] ?? 0) + n);
  for (const [cls, rewards] of Object.entries(epics)) {
    const ofClass = members.filter((m) => m.class === cls);
    for (const reward of rewards) add(reward, ofClass.length);
    const needers = ofClass.filter((m) => !epicHolders.has(m.name)).length;
    if (!needers) continue;
    const each = new Map();
    for (const reward of rewards) for (const [id, n] of needFor(edges, reward, new Set(), buyable)) if (!buyable.has(id)) each.set(id, Math.max(each.get(id) ?? 0, n));
    for (const [id, n] of each) add(id, n * needers);
  }
  return out;
}

/**
 * Copies of the items the runnable chains of `data/quests.json` use, for the steps the quest graph
 * cannot follow, such as a scene that ends in a kill: one copy of each step's items for every class
 * member, at any level, that does not hold the chain (`holders`), and one copy of each item that
 * shows a chain done (`doneItems`) for every class member. `ids` maps an item name to its ids.
 */
export function stepDemand({ quests, holders = {}, members, ids }) {
  const out = {};
  const add = (name, n) => {
    for (const id of ids.get(name) ?? []) out[id] = (out[id] ?? 0) + n;
  };
  for (const [id, q] of Object.entries(quests)) {
    const ofClass = members.filter((m) => m.class === q.class);
    for (const name of doneItems(id, quests)) add(name, ofClass.length);
    const open = ofClass.filter((m) => !(holders[id] ?? []).includes(m.name)).length;
    if (!open) continue;
    const items = [...(q.needs ?? []), ...q.steps.flatMap((s) => [...(s.give ?? []), ...(s.craft?.inputs ?? []), ...Object.keys(s.each ?? {}), s.expect])];
    for (const name of new Set(items.filter(Boolean))) add(name, open);
  }
  return out;
}

/**
 * Copies of the items the coordinator's hunts and errands are for (`opportunities` of
 * data/opportunities.json): `need(o)` copies of each opportunity's item, by its ids (`ids`).
 */
export function opportunityDemand({ opportunities, need, ids }) {
  const out = {};
  for (const o of opportunities) for (const id of ids.get(o.item) ?? []) out[id] = (out[id] ?? 0) + need(o);
  return out;
}

/**
 * Each leader's share of the account's demand, since the bag reserve acts on the active leader's
 * carried items only. `need` is total copies per item id, `short` the gear plan's copies still to
 * acquire, `rows` the account survey (Equipped and Carried rows) and `leaders` the tabs' leaders.
 * Copies worn or carried by others are out of the reserve's reach, so they count first. Then each
 * leader keeps the carried copies the account still needs, most first, and every leader keeps the
 * shortfall and the gear plan's copies, because any tab may loot the missing one. Returns
 * `{ [leader]: { [itemId]: copies } }`.
 */
export function tabShares({ need, short = {}, rows, leaders }) {
  const lead = new Set(leaders);
  const held = new Map();
  for (const r of rows) {
    if (!need[r.itemId]) continue;
    const who = r.location === "Carried" && lead.has(r.characterName) ? r.characterName : "";
    const m = held.get(r.itemId) ?? new Map();
    m.set(who, (m.get(who) ?? 0) + (r.quantity ?? 1));
    held.set(r.itemId, m);
  }
  const out = Object.fromEntries(leaders.map((l) => [l, {}]));
  const add = (l, id, n) => n > 0 && (out[l][id] = (out[l][id] ?? 0) + n);
  for (const [id, n] of Object.entries(need)) {
    const m = held.get(Number(id)) ?? new Map();
    let left = n - Math.min(n, m.get("") ?? 0);
    for (const [l, c] of [...m].filter(([l]) => l).sort((a, b) => b[1] - a[1])) {
      const take = Math.min(left, c);
      add(l, id, take);
      left -= take;
    }
    for (const l of leaders) add(l, id, left);
  }
  for (const [id, n] of Object.entries(short)) for (const l of leaders) add(l, id, n);
  return out;
}

/** A count no bag reaches, for an item whose every copy is kept. */
export const ALL_COPIES = 1_000_000;

/**
 * Every copy of the items NPC `npc` takes one at a time for XP (`edges` of the quest graph, by the
 * NPC's script file name), because each copy pays its reward again and a coordinator task hands
 * them in: Smith Tv`ysa's lightstones today. Returns `{ demand, xp }`, `xp` mapping each item id to
 * the XP one copy pays.
 */
export function handInDemand(edges, npc) {
  const xp = {};
  for (const e of edges) {
    const ids = Object.keys(e.inputs);
    if (e.kind === "handin" && e.npc === npc && e.exp > 0 && ids.length === 1 && e.inputs[ids[0]] === 1) xp[ids[0]] = Math.max(xp[ids[0]] ?? 0, e.exp);
  }
  return { demand: Object.fromEntries(Object.keys(xp).map((id) => [id, ALL_COPIES])), xp };
}

/**
 * One copy of every casino boss potion (`bosses`, the client's casino table): a potion is LORE
 * and stays with the character that won it, so a tab never carries two of one boss.
 */
export const potionDemand = (bosses) => Object.fromEntries(bosses.map((b) => [b.itemId, 1]));

/** The sum of demand maps `{ [itemId]: copies }`. */
export function addDemand(...maps) {
  const out = {};
  for (const m of maps) for (const [id, n] of Object.entries(m)) out[id] = (out[id] ?? 0) + n;
  return out;
}
