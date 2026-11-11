// The epic model (docs/plans/epic-model.md): every way the game gives an item, from the quest
// scripts (tools/lib/quest-script.mjs) and the content's tables, and for each class epic the
// cheapest of them for each piece, back to sources the account can reach: a merchant, a ground
// spawn or an NPC's loot. Costs are rough hours of one group, for choosing between ways, not for
// planning time.
import { readdir, readFile } from "node:fs/promises";
import { contentRoot, craftableRecipes, rows } from "./content.mjs";
import { dropChance, dropRow, loadSources, liveZoneNames, spawnSites } from "./gear-data.mjs";
import { meets, parseScript, scriptOwner } from "./quest-script.mjs";

// Rough hours of one group, for choosing between ways to get a piece: talking or buying in passing,
// a trip to a ground spawn, a hand-in trip, a combine, and a fight.
const COST = { say: 0.02, buy: 0.05, ground: 0.2, handin: 0.1, combine: 0.05, kill: 0.1 };
// An NPC above this level needs a raid, which costs a raid hour of the whole account here.
const GROUP_MAX_LEVEL = 60;
const RAID_HOURS = 12;
// An NPC's name as scripts and npc_types both spell it: script file names write a backtick as a hyphen
// (`Oracle_of_K-Arnon.lua` belongs to Oracle_of_K`Arnon).
const nameKey = (name) => name.toLowerCase().replace(/[`-]/g, "-");

/**
 * Every enabled NPC script of the content snapshot, parsed: `[{ file, zone, npc, npcId, events,
 * unread }]`, `npc` the name a file names, `npcId` the id a numbered file names. The export keeps
 * the database's disabled scripts too, which the server does not run, and its index marks them
 * (`reference/effective-quests-index.json`): they are left out and counted in `disabled`. Scripts
 * that do not parse are listed in `failed`.
 */
export async function loadScripts(root) {
  const base = contentRoot(root);
  const index = JSON.parse(await readFile(`${base}/reference/effective-quests-index.json`, "utf8"));
  const off = new Set(index.filter((r) => !r.enabled).map((r) => r.file.replace(/^effective\/quests\//, "")));
  const dir = `${base}/effective/quests`;
  const scripts = [];
  const failed = [];
  let disabled = 0;
  for (const f of (await readdir(dir, { recursive: true })).sort()) {
    if (!f.endsWith(".lua") || !f.includes("/")) continue;
    if (off.has(f)) {
      disabled++;
      continue;
    }
    try {
      scripts.push({ file: f, ...scriptOwner(f), ...parseScript(await readFile(`${dir}/${f}`, "utf8")) });
    } catch (e) {
      failed.push({ file: f, error: e.message });
    }
  }
  return { scripts, failed, disabled };
}

/** The chance that branch `b` runs when its event comes: the product of its read random rolls. */
export const chanceOf = (b) => b.when.reduce((q, c) => q * (c.p ?? 1), 1);

const addWay = (ways, id, way) => id > 0 && (ways.get(id) ?? ways.set(id, []).get(id)).push(way);

/**
 * The model from its parts: parsed `scripts` (`loadScripts`), the `npcs` rows of npc_types, `spawns`,
 * each `{ npcId, zone, points?, respawn?, spawn?, when? }` for a live static spawn site in a live
 * zone (`spawnSites`), `loot`, the loot of each loot table as `Map<loottableId, [{ item, p }]>`, the
 * recipe and summoning spell `edges` (`craftEdges`),
 * the Tradeskill Bank's `catalog`, `Map<itemId, price>`, and other `sources`, each `{ item, way }`.
 * The catalog sells recipe ingredients into the bank, from which a craft takes them, so it prices a
 * combine's inputs and is no way to an item otherwise. The model holds every script branch,
 * `{ file, zone, npc, npcIds, event, when, actions, inputs, line }` with `inputs` the items its trade
 * takes, the NPCs (`npcs`), the NPCs with a static spawn (`staticIds`) and their sites (`sites`,
 * `Map<npcId, Map<zone, site>>`), the branches that spawn each NPC (`spawners`), and `ways`, the ways
 * to get each item, `Map<itemId, [way]>`, each `{ kind, ... }`:
 * - `script`: a branch gives it (`branch`, and `chance` when the script picks one of several);
 * - `scene`: the loot of an NPC that script branches spawn (`npcId`, `drop`);
 * - `drop`: a static NPC's loot (`npc`, `zone`, `level`, `hp`, `drop`, `spawn`, `points`, `respawn`,
 *   `when`);
 * - `buy`: a merchant (`npc`, `zone`);
 * - `ground`: an enabled ground spawn (`zone`, `respawn`);
 * - `combine` and `cast`: a tradeskill recipe or a summoning spell (`inputs`).
 */
export function buildEpicModel({ scripts, npcs: npcRows, spawns = [], loot = new Map(), edges = [], catalog = new Map(), sources = [] }) {
  const npcs = new Map();
  const idsOfName = new Map();
  for (const n of npcRows) {
    const name = n.name.replace(/^#/, "").replace(/_/g, " ").trim();
    npcs.set(n.id, { id: n.id, name, level: n.level, hp: Number(n.hp) || null, loottable: n.loottable });
    (idsOfName.get(nameKey(name)) ?? idsOfName.set(nameKey(name), []).get(nameKey(name))).push(n.id);
  }
  const staticIds = new Set();
  const sites = new Map();
  const zonesOf = new Map();
  const inZone = (id, zone) => (zonesOf.get(id) ?? zonesOf.set(id, new Set()).get(id)).add(zone);
  for (const { npcId, zone, ...site } of spawns) {
    staticIds.add(npcId);
    inZone(npcId, zone);
    (sites.get(npcId) ?? sites.set(npcId, new Map()).get(npcId)).set(zone, { points: 1, respawn: Infinity, spawn: 1, when: null, ...site });
  }

  const branches = [];
  for (const s of scripts) {
    for (const [event, list] of Object.entries(s.events)) {
      for (const b of list) branches.push({ script: s, file: s.file, zone: s.zone, event, when: b.when, actions: b.actions, line: b.line, inputs: Object.assign({}, ...b.when.filter((c) => c.trade).map((c) => c.trade.items)) });
    }
  }
  const ways = new Map();
  const spawners = new Map();
  for (const b of branches) {
    for (const a of b.actions) {
      // A branch that gives back an item its trade takes hands it back rather than making one.
      if (a.give) for (const id of a.give) if (!(String(id) in b.inputs)) addWay(ways, id, { kind: "script", branch: b, chance: 1 / a.give.length });
      if (a.spawn) {
        (spawners.get(a.spawn) ?? spawners.set(a.spawn, []).get(a.spawn)).push(b);
        // A script spawns its NPC in its own zone.
        inZone(a.spawn, b.zone);
      }
    }
  }
  // A script named by NPC name belongs to the NPCs of that name that appear in its zone, by a static
  // spawn there or a script there that spawns them. The snapshot keeps copies of many scripts under
  // a zone's other names, such as freeportwest beside freportn, and a copy whose zone has no such
  // NPC belongs to none.
  for (const s of scripts) {
    const npc = s.npc ?? npcs.get(s.npcId)?.name ?? `#${s.npcId}`;
    const here = (idsOfName.get(nameKey(npc)) ?? []).filter((id) => zonesOf.get(id)?.has(s.zone));
    Object.assign(s, { npcName: npc, npcIds: s.npcId ? [s.npcId] : here });
  }
  // A branch that checks the NPC's type runs only for that NPC of its script.
  for (const b of branches) {
    const only = b.when.find((c) => c.npcType != null)?.npcType;
    Object.assign(b, only != null ? { npc: npcs.get(only)?.name ?? `#${only}`, npcIds: [only] } : { npc: b.script.npcName, npcIds: b.script.npcIds });
  }
  // The loot of the NPCs scripts spawn.
  for (const npcId of spawners.keys()) for (const { item, p } of loot.get(npcs.get(npcId)?.loottable) ?? []) addWay(ways, item, { kind: "scene", npcId, drop: p });
  for (const e of edges) {
    if (e.kind === "combine") for (const id of e.outputs) addWay(ways, id, { kind: "combine", recipe: e.recipe, inputs: e.inputs });
    if (e.kind === "spell") for (const id of e.outputs) addWay(ways, id, { kind: "cast", spell: e.spell, inputs: e.inputs });
  }
  for (const { item, way } of sources) addWay(ways, item, way);
  return { scripts, npcs, staticIds, sites, branches, spawners, ways, catalog };
}

// Spell effect 32 summons the item its base value names.
const SUMMON_ITEM = 32;

/**
 * The craftable recipes (`craftableRecipes`) and the summoning spells of the content snapshot as
 * edges `{ kind, inputs: { id: count }, outputs: [id] }`: a `combine` (with its recipe's `recipe`,
 * `skill`, `trivial` and `nofail`) takes its components and makes its products, and a
 * `spell` takes the scroll that teaches it and the components a cast consumes, and gives the item it
 * summons.
 */
async function craftEdges(root) {
  const edges = [];
  const scrolls = new Map();
  for await (const i of rows("items", root)) if (i.scrolleffect > 0) scrolls.set(i.scrolleffect, i.id);
  for await (const s of rows("spells_new", root)) {
    const summons = [];
    for (let k = 1; k <= 12; k++) if (s[`effectid${k}`] === SUMMON_ITEM && s[`effect_base_value${k}`] > 0) summons.push(s[`effect_base_value${k}`]);
    if (!summons.length || !scrolls.has(s.id)) continue;
    const inputs = { [scrolls.get(s.id)]: 1 };
    for (let k = 1; k <= 4; k++) if (s[`components${k}`] > 0) inputs[s[`components${k}`]] = (inputs[s[`components${k}`]] ?? 0) + (s[`component_counts${k}`] || 1);
    edges.push({ kind: "spell", spell: s.id, inputs, outputs: summons });
  }
  for (const r of (await craftableRecipes(root)).values()) {
    if (!r.yields.length) continue;
    const inputs = {};
    for (const p of r.parts) inputs[p.item] = (inputs[p.item] ?? 0) + p.n;
    edges.push({ kind: "combine", recipe: r.id, skill: r.skill, trivial: r.trivial, nofail: r.nofail, inputs, outputs: r.yields.map((y) => y.item) });
  }
  return edges;
}

/**
 * The model of the content snapshot at `root` (`buildEpicModel`), with its recipes and summoning
 * spells (`craftEdges`), the Tradeskill Bank's catalog, and the enabled ground spawns as sources. Also the scripts that do not parse in `failed`, the number of disabled ones in
 * `disabled`, and `addStatic(itemIds)`, which adds the static drops and merchants of those items:
 * they need the spawn tables and are read for the items an epic may take only.
 */
export async function loadEpicModel(root) {
  const [{ scripts, failed, disabled }, edges] = await Promise.all([loadScripts(root), craftEdges(root)]);
  const npcs = [];
  for await (const n of rows("npc_types", root)) npcs.push({ id: n.id, name: n.name, level: n.level, hp: n.hp, loottable: n.loottable_id });
  const live = await liveZoneNames(root);
  const spawns = [...(await spawnSites(root, { zoneName: live }))].flatMap(([npcId, zones]) => [...zones].map(([zone, site]) => ({ npcId, zone, ...site })));
  const drops = new Map();
  for await (const d of rows("lootdrop_entries", root)) (drops.get(d.lootdrop_id) ?? drops.set(d.lootdrop_id, []).get(d.lootdrop_id)).push(d);
  const loot = new Map();
  for await (const t of rows("loottable_entries", root)) {
    const ds = (drops.get(t.lootdrop_id) ?? []).filter((d) => d.chance > 0);
    const sum = ds.reduce((s, d) => s + Number(d.chance), 0);
    const table = { probability: Number(t.probability), multiplier: Number(t.multiplier) || 1, droplimit: Number(t.droplimit) || 0, mindrop: Number(t.mindrop) || 0 };
    for (const d of ds) (loot.get(t.loottable_id) ?? loot.set(t.loottable_id, []).get(t.loottable_id)).push({ item: d.item_id, p: dropChance({ chance: Number(d.chance), sum, entryMult: d.multiplier || 1 }, table) });
  }
  const catalog = new Map();
  for await (const c of rows("crafting_merchant_items", root)) catalog.set(c.item_id, c.price);
  const sources = [];
  const enabled = new Set();
  for await (const g of rows("idlequest_enabled_ground_spawns", root)) enabled.add(g.ground_spawn_id);
  const zoneById = new Map();
  for await (const z of rows("zone", root)) zoneById.set(z.zoneidnumber, z.short_name);
  for await (const g of rows("ground_spawns", root)) if (enabled.has(g.id)) sources.push({ item: g.item, way: { kind: "ground", zone: zoneById.get(g.zoneid) ?? String(g.zoneid), respawn: g.respawn_timer } });
  const model = buildEpicModel({ scripts, npcs, spawns, loot, edges, catalog, sources });
  const addStatic = async (itemIds) => {
    const { sources: drops, sellers } = await loadSources(root, { itemIds: new Set(itemIds), zoneName: live });
    for (const [item, list] of drops) for (const s of list) addWay(model.ways, item, { kind: "drop", npcId: s.npcId, npc: s.npc, zone: s.zoneShort, level: s.level, hp: s.hp, drop: s.drop, spawn: s.spawn, points: s.points, respawn: s.respawn, when: s.when });
    for (const [item, list] of sellers) for (const s of list) addWay(model.ways, item, { kind: "buy", npc: s.npc, zone: s.zoneShort });
  };
  return { ...model, failed, disabled, addStatic };
}

// Whether a flag condition expects the flag set, so a branch that sets it has to run first:
// `qglobals.x == "1"`, `qglobals.x ~= nil` or a comparison of its number.
const needsFlag = (c) => (c.op === "==" && c.value != null) || (c.op === "~=" && c.value == null) || [">", ">=", "<", "<="].includes(c.op);

/**
 * The cheapest way to each piece of epic reward `reward` for a character of `cls`. A branch costs
 * its own trip, its inputs, the cheapest branch that sets a flag it expects, an item it wants
 * carried, and what starts its event: its NPC present (a static spawn, or the cheapest branch that
 * spawns it), a kill for a death or a fight, the cheapest branch that sends its signal, or the
 * branch of its script that sets its timer. A branch gated on another class is closed, a kill above
 * level 60 costs a raid, and an item with no open way stays at an infinite cost, which marks a gap.
 * The costs are a fixpoint over the items and branches the reward can depend on: every cost starts
 * infinite and falls as its parts become known, and since every step costs more than nothing, a
 * cycle never lowers a cost. Returns `itemCost`, `branchCost`, `chosen(id)` (`{ cost, way, needs }`,
 * a scene's way with `by`, the branch that spawns its NPC), `startOf(branch)` and `needsOf(branch)`.
 */
export function cheapest(model, cls, reward) {
  const { ways, npcs, staticIds, spawners, catalog } = model;
  const { starters, setters } = links(model);
  const { items: itemSet, branches: branchSet } = dependencies(model, reward);

  const itemCost = new Map();
  const branchCost = new Map();
  const ic = (id) => itemCost.get(id) ?? Infinity;
  const bc = (b) => branchCost.get(b) ?? Infinity;
  const minOf = (list, f) => list.reduce((best, x) => {
    const c = f(x);
    return c < best.cost ? { cost: c, of: x } : best;
  }, { cost: Infinity, of: null });
  const inputsCost = (inputs) => Object.entries(inputs ?? {}).reduce((s, [id, n]) => s + n * ic(Number(id)), 0);
  // A combine buys the inputs the Tradeskill Bank's catalog sells.
  const craftInputsCost = (inputs) => Object.entries(inputs ?? {}).reduce((s, [id, n]) => s + n * (catalog.has(Number(id)) ? COST.buy : ic(Number(id))), 0);
  const killHours = (level, drop = 1) => (level > GROUP_MAX_LEVEL ? RAID_HOURS : COST.kill) / Math.max(drop, 1e-3);
  const presence = (ids) => (ids.some((id) => staticIds.has(id)) ? { cost: 0, of: null } : minOf(ids.flatMap((id) => spawners.get(id) ?? []), bc));
  // What a branch waits on: its NPC present, and for a signal or a timer the branch that sends it.
  const startOf = (b) => {
    const p = presence(b.npcIds);
    const t = b.event === "signal" || b.event === "timer" ? minOf(starters(b), bc) : { cost: 0, of: null };
    return { cost: p.cost + t.cost, of: [p.of, t.of].filter(Boolean) };
  };
  // What a setter costs condition `c` of branch `b`: the cheapest other branch that sets the flag
  // or the script variable. A script variable whose first value fails the test needs one, while a
  // flag no branch sets is taken as set some other way.
  const setterCost = (c, b) => {
    const all = setters(c, b);
    if (!all.length) return c.var != null && !meets(c.op, c.initial, c.value) ? Infinity : 0;
    return minOf(all.filter((x) => x !== b), bc).cost;
  };
  // What condition `c` of branch `b` costs beyond the branch itself: a setter, a carried item, a
  // trade inside an `or` (a top-level trade is the branch's inputs), and for an `or` its cheapest
  // part. A gate for another class closes the branch, and so does a condition the analyzer cannot
  // read, since it could ask for anything, and a test no value passes.
  const condCost = (c, b, top = true) => {
    if ((c.class && c.class !== cls) || (c.not?.class && c.not.class === cls)) return Infinity;
    if (c.unread || c.never) return Infinity;
    if (c.any) return Math.min(...c.any.map((p) => condCost(p, b, false)));
    if (c.all) return c.all.reduce((s, p) => s + condCost(p, b, false), 0);
    return (c.trade && !top ? inputsCost(c.trade.items) : 0) + (c.has ? ic(c.has) : 0) + setterCost(c, b);
  };
  // A branch behind random rolls runs once in 1/p tries on average, and each try costs it again.
  const branchValue = (b) => {
    let cost = b.event === "say" ? COST.say : COST.handin;
    for (const c of b.when) cost += condCost(c, b);
    cost += inputsCost(b.inputs) + startOf(b).cost;
    if (["death", "combat", "hp", "slay"].includes(b.event)) cost += killHours(Math.max(0, ...b.npcIds.map((id) => npcs.get(id)?.level ?? 0)));
    return cost / Math.max(chanceOf(b), 1e-3);
  };
  const wayValue = (w) => {
    switch (w.kind) {
      case "buy":
        return COST.buy;
      case "ground":
        return COST.ground;
      case "drop": {
        const hours = w.respawn > 0 && Number.isFinite(w.respawn) ? w.respawn / 3600 / Math.max(w.spawn * w.drop, 1e-3) / Math.max(1, w.points) : Infinity;
        return Math.max(hours, killHours(w.level, w.drop));
      }
      case "combine":
        return COST.combine + craftInputsCost(w.inputs);
      case "cast":
        return COST.combine + inputsCost(w.inputs);
      case "scene":
        return presence([w.npcId]).cost + killHours(npcs.get(w.npcId)?.level ?? 0, w.drop);
      case "script":
        return bc(w.branch) / Math.max(w.chance ?? 1, 1e-3);
      default:
        return Infinity;
    }
  };
  for (let changed = true, round = 0; changed && round < 500; round++) {
    changed = false;
    for (const b of branchSet) {
      const c = branchValue(b);
      if (c < bc(b) - 1e-9) {
        branchCost.set(b, c);
        changed = true;
      }
    }
    for (const id of itemSet) {
      const c = Math.min(Infinity, ...(ways.get(id) ?? []).map(wayValue));
      if (c < ic(id) - 1e-9) {
        itemCost.set(id, c);
        changed = true;
      }
    }
  }
  const sceneWay = (w) => (w.kind === "scene" ? { ...w, npc: npcs.get(w.npcId)?.name, level: npcs.get(w.npcId)?.level, by: presence([w.npcId]).of } : w);
  const chosen = (id) => {
    const best = minOf(ways.get(id) ?? [], wayValue);
    if (!best.of) return null;
    return { cost: best.cost, way: sceneWay(best.of), needs: best.of.branch?.inputs ?? best.of.inputs ?? {} };
  };
  // Why condition `c` of branch `b` cannot hold, each `{ reason, item?, branch? }`.
  const whyNot = (c, b) => {
    if (c.class && c.class !== cls) return [{ reason: `only for ${c.class}` }];
    if (c.not?.class && c.not.class === cls) return [{ reason: `not for ${cls}` }];
    if (c.unread) return [{ reason: `the analyzer cannot read the condition ${c.unread} (line ${c.line})` }];
    if (c.never) return [{ reason: `no value the event gives passes ${c.never} (line ${c.line})` }];
    if (c.any) return [{ reason: `no alternative holds: ${c.any.flatMap((p) => whyNot(p, b)).map((r) => r.reason).join(" or ")}` }];
    if (c.all) return c.all.filter((p) => !Number.isFinite(condCost(p, b, false))).flatMap((p) => whyNot(p, b));
    const out = [];
    if (c.trade) for (const id of Object.keys(c.trade.items)) if (!Number.isFinite(ic(Number(id)))) out.push({ reason: "an input cannot be had", item: Number(id) });
    if (c.has && !Number.isFinite(ic(c.has))) out.push({ reason: "a carried item cannot be had", item: c.has });
    if (!Number.isFinite(setterCost(c, b))) {
      const others = setters(c, b).filter((x) => x !== b);
      const name = c.flag != null ? `flag ${c.flag}` : `variable ${c.var}`;
      out.push(others.length ? { reason: `${name} is set only by blocked branches`, branch: others[0] } : { reason: `no other branch sets ${name} so that it passes (line ${c.line})` });
    }
    return out;
  };
  // Why branch `b` cannot run, each `{ reason, item?, branch? }`: a condition that cannot hold, its
  // NPC absent, its signal or timer never sent, or an input that cannot be had.
  const explain = (b) => {
    const out = [];
    for (const c of b.when) if (!Number.isFinite(condCost(c, b))) out.push(...whyNot(c, b));
    const p = presence(b.npcIds);
    if (!Number.isFinite(p.cost)) {
      const any = b.npcIds.flatMap((id) => spawners.get(id) ?? [])[0];
      out.push(any ? { reason: `${b.npc} appears only through a blocked branch`, branch: any } : { reason: `${b.npc} has no live spawn and no script spawns it` });
    }
    if (b.event === "signal" || b.event === "timer") {
      const t = starters(b);
      if (!Number.isFinite(minOf(t, bc).cost)) out.push(t.length ? { reason: `its ${b.event} comes only from a blocked branch`, branch: t[0] } : { reason: `no script sends its ${b.event}` });
    }
    for (const id of Object.keys(b.inputs)) if (!Number.isFinite(ic(Number(id)))) out.push({ reason: "an input cannot be had", item: Number(id) });
    return out;
  };
  // The way to follow for an item no way gives at a finite cost: the one with the fewest blocked parts.
  const leastBlocked = (id) => {
    const blockedInput = (w, i) => !(w.kind === "combine" && catalog.has(Number(i))) && !Number.isFinite(ic(Number(i)));
    const parts = (w) => (w.branch ? explain(w.branch).length : Object.keys(w.inputs ?? {}).filter((i) => blockedInput(w, i)).length + (w.kind === "scene" && !Number.isFinite(presence([w.npcId]).cost) ? 1 : 0));
    const w = minOf(ways.get(id) ?? [], parts).of;
    return w && { way: sceneWay(w), needs: w.branch?.inputs ?? w.inputs ?? {} };
  };
  // The items and setter branches the conditions of branch `b` need, following the cheapest part of
  // each `or`, or its first part when none holds.
  const needsOf = (b) => {
    const items = [];
    const branches = [];
    const walk = (c, top) => {
      if (c.any) return walk(minOf(c.any, (p) => condCost(p, b, false)).of ?? c.any[0], false);
      if (c.all) return c.all.forEach((p) => walk(p, false));
      if (c.trade && !top) items.push(...Object.keys(c.trade.items).map(Number));
      if (c.has) items.push(c.has);
      const others = setters(c, b).filter((x) => x !== b);
      if (others.length) branches.push(minOf(others, bc).of ?? others[0]);
    };
    for (const c of b.when) walk(c, true);
    return { items, branches };
  };
  return { itemCost: ic, branchCost: bc, chosen, explain, leastBlocked, startOf: (b) => startOf(b).of, needsOf };
}

// The branches that start or enable others, indexed once per model: senders of each signal, setters
// of each timer, of each flag and of each script variable. `starters(b)` lists the branches that
// start a signal or a timer branch `b`, and `setters(c, b)` the branches that make condition `c` of
// branch `b` hold: for a flag it expects set, the branches that set it, and for a script variable
// whose first value fails the test, the branches of the same script that give it a passing one.
// The branches that spawn an NPC are the model's `spawners`.
const LINKS = new WeakMap();
function links(model) {
  if (LINKS.has(model)) return LINKS.get(model);
  const index = (key, b, list) => (list.get(key) ?? list.set(key, []).get(key)).push(b);
  const signalers = new Map();
  const timerSetters = new Map();
  const flagSetters = new Map();
  const varSetters = new Map();
  for (const b of model.branches) {
    for (const a of b.actions) {
      if (a.signal != null) index(`${a.signal}:${a.n}`, b, signalers);
      if (a.setTimer != null) index(`${b.file}:${a.setTimer}`, b, timerSetters);
      if (a.setFlag != null) index(a.setFlag, b, flagSetters);
      if (a.setVar != null) index(`${b.file}:${a.setVar}`, b, varSetters);
    }
  }
  const starters = (b) => {
    if (b.event === "signal") return b.npcIds.flatMap((id) => signalers.get(`${id}:${b.when.find((c) => c.signal != null)?.signal}`) ?? []);
    if (b.event === "timer") return timerSetters.get(`${b.file}:${b.when.find((c) => c.timer != null)?.timer}`) ?? [];
    return [];
  };
  const setters = (c, b) => {
    if (c.flag != null) return needsFlag(c) ? (flagSetters.get(c.flag) ?? []) : [];
    if (c.var != null && !meets(c.op, c.initial, c.value)) return (varSetters.get(`${b.file}:${c.var}`) ?? []).filter((x) => x.actions.some((a) => a.setVar === c.var && meets(c.op, a.value, c.value)));
    return [];
  };
  const out = { starters, setters };
  LINKS.set(model, out);
  return out;
}

/**
 * The items and branches reward `reward` can depend on: the ways to each item, the inputs, carried
 * items and flag setters of each branch, and what starts it. `addStatic` needs the items, since
 * static drops and merchants are read for these only.
 */
export function dependencies(model, reward) {
  const { starters, setters } = links(model);
  const items = new Set();
  const branches = new Set();
  const stack = [reward];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === "number") {
      if (items.has(x)) continue;
      items.add(x);
      for (const w of model.ways.get(x) ?? []) {
        if (w.branch) stack.push(w.branch);
        for (const i of Object.keys(w.inputs ?? {})) stack.push(Number(i));
        if (w.kind === "scene") stack.push(...(model.spawners.get(w.npcId) ?? []));
      }
    } else {
      if (branches.has(x)) continue;
      branches.add(x);
      for (const i of Object.keys(x.inputs)) stack.push(Number(i));
      const walk = (c) => {
        if (c.any) return c.any.forEach(walk);
        if (c.all) return c.all.forEach(walk);
        if (c.has) stack.push(c.has);
        if (c.trade) for (const i of Object.keys(c.trade.items)) stack.push(Number(i));
        stack.push(...setters(c, x));
      };
      x.when.forEach(walk);
      stack.push(...starters(x));
      if (!x.npcIds.some((id) => model.staticIds.has(id))) for (const id of x.npcIds) stack.push(...(model.spawners.get(id) ?? []));
    }
  }
  return { items, branches };
}

/**
 * The chosen steps of an epic reward for class `cls`, in the order they run: `{ branch, cost, held }`
 * for a script branch (a say, a hand-in, or an event a hand-in starts), `held` the items its
 * conditions want besides its trade's inputs, and `{ item, way, cost }` for a piece from a source or
 * a kill. Where no way is open, the tree follows the least blocked one and lists each blocked branch
 * in `blocked` with its reasons, so it reaches the actual blockers: `gaps`, the items nothing gives,
 * and branches no class, spawn or signal can run. Also the reward's `cost`.
 */
export function epicTree(model, cls, reward) {
  const pick = cheapest(model, cls, reward);
  const steps = [];
  const gaps = [];
  const blocked = [];
  const seenItems = new Set();
  const seenBranches = new Set();
  const doBranch = (b) => {
    if (!b || seenBranches.has(b)) return;
    seenBranches.add(b);
    for (const id of Object.keys(b.inputs)) doItem(Number(id));
    const needs = pick.needsOf(b);
    for (const id of needs.items) doItem(id);
    for (const s of needs.branches) doBranch(s);
    for (const s of pick.startOf(b)) doBranch(s);
    if (!Number.isFinite(pick.branchCost(b))) {
      const reasons = pick.explain(b);
      blocked.push({ branch: b, reasons: reasons.map((r) => r.reason) });
      for (const r of reasons) if (r.branch) doBranch(r.branch);
    }
    steps.push({ branch: b, cost: pick.branchCost(b), held: needs.items });
  };
  const doItem = (id) => {
    if (seenItems.has(id)) return;
    seenItems.add(id);
    const c = pick.chosen(id);
    const open = c && Number.isFinite(c.cost) ? c : pick.leastBlocked(id);
    if (!open) {
      gaps.push(id);
      return;
    }
    if (open.way.kind === "script") return doBranch(open.way.branch);
    // A scripted NPC without a static spawn needs the branch that spawns it, and when every spawner is
    // blocked, the tree follows them to their own reasons.
    if (open.way.kind === "scene" && !model.staticIds.has(open.way.npcId)) {
      if (open.way.by) doBranch(open.way.by);
      else {
        blocked.push({ item: id, reasons: [`${open.way.npc} appears only through blocked branches`] });
        for (const s of model.spawners.get(open.way.npcId) ?? []) doBranch(s);
      }
    }
    for (const input of Object.keys(open.needs).map(Number)) {
      if (open.way.kind !== "combine" || !model.catalog.has(input)) doItem(input);
      else if (!seenItems.has(input)) {
        seenItems.add(input);
        steps.push({ item: input, cost: COST.buy, way: { kind: "catalog", price: model.catalog.get(input) } });
      }
    }
    steps.push({ item: id, cost: c?.cost ?? Infinity, way: open.way });
  };
  doItem(reward);
  return { steps, gaps, blocked, cost: pick.itemCost(reward) };
}

/**
 * The step kinds the bot lacks for epic tree `tree` (docs/plans/epic-model.md, "Running the
 * steps"): a raid kill, of an NPC above level 60, a ground pickup, a summoning cast, a hand-in with
 * coin, a hand-in of more than four items, an item a branch wants held, or a purchase from a merchant
 * outside the zone of the hand-in that takes it, since a step buys only for its own hand-in. A timer
 * or a signal branch runs by itself, and dropped pieces come from hunts.
 */
export function missingKinds(model, tree) {
  const out = new Set();
  for (const s of tree.steps) {
    if (s.item) {
      if (s.way.kind === "ground") out.add("ground pickup");
      if (s.way.kind === "cast") out.add("summoning cast");
      if (s.way.kind === "buy" && !tree.steps.some((x) => x.branch && String(s.item) in x.branch.inputs && x.branch.zone === s.way.zone)) out.add("purchase in another zone");
      if ((s.way.kind === "drop" || s.way.kind === "scene") && (s.way.level ?? 0) > GROUP_MAX_LEVEL) out.add("raid kill");
      continue;
    }
    const b = s.branch;
    if (b.when.some((c) => c.trade?.coin)) out.add("coin hand-in");
    if (Object.values(b.inputs).reduce((a, n) => a + n, 0) > 4) out.add("hand-in of more than four items");
    if (s.held.length) out.add("held item");
    if (b.event === "death" && b.npcIds.some((id) => (model.npcs.get(id)?.level ?? 0) > GROUP_MAX_LEVEL)) out.add("raid kill");
  }
  return [...out];
}

/**
 * How a hunt meets NPC `npcId`: at its own static spawns, or through a chain of deaths that starts
 * at a static NPC, each death spawning the next with its branch's chance `q`. A death that spawns
 * its own NPC again, with chance `r`, keeps that NPC's line going, so a line ends in the next NPC
 * with the chance `q / (1 - r)`, after `1 / q` deaths on average. Returns `{ root, yield, kills,
 * also, level, hp, fights }`: the static NPC, the copies of `npcId` one of its spawns brings, the
 * kills one meeting takes, the chain's other NPCs by name, the hardest NPC's level and hit points,
 * and `fights`, each NPC of the chain with its level, hit points and the kills one meeting takes of
 * it, or null when only a hand-in or a keyword spawns it.
 */
function meeting(model, npcId, seen = new Set()) {
  const npc = model.npcs.get(npcId);
  const fight = { npc: npc?.name ?? `#${npcId}`, level: npc?.level ?? 0, hp: npc?.hp ?? null, kills: 1 };
  if (model.staticIds.has(npcId)) return { root: npcId, yield: 1, kills: 1, also: [], level: fight.level, hp: fight.hp, fights: [fight] };
  let best = null;
  for (const b of model.spawners.get(npcId) ?? []) {
    if (b.event !== "death") continue;
    const q = chanceOf(b);
    for (const dying of b.npcIds) {
      if (dying === npcId || seen.has(dying)) continue;
      const prev = meeting(model, dying, new Set([...seen, npcId]));
      if (!prev) continue;
      const r = (model.spawners.get(dying) ?? []).filter((x) => x.event === "death" && x.npcIds.includes(dying)).reduce((s, x) => s + chanceOf(x), 0);
      const m = {
        root: prev.root,
        yield: prev.yield * Math.min(1, q / Math.max(q, 1 - r)),
        kills: prev.kills / Math.max(q, 1e-3) + 1,
        also: [...prev.also, npc?.name ?? `#${npcId}`],
        level: Math.max(prev.level, npc?.level ?? 0),
        hp: Math.max(prev.hp ?? 0, npc?.hp ?? 0) || null,
        fights: [...prev.fights.map((f) => ({ ...f, kills: f.kills / Math.max(q, 1e-3) })), fight],
      };
      if (!best || m.kills / m.yield < best.kills / best.yield) best = m;
    }
  }
  return best;
}

/**
 * The pieces of epic tree `tree` (`epicTree`) that a hunt gets rather than a chain step, each
 * `{ itemId, sources }` with `sources` drop rows of the roster gear plan (`dropRow`): every live
 * static NPC that drops the piece, and for the loot of an NPC a chain of deaths spawns (`meeting`),
 * the static NPC at the chain's start, whose spawns give the piece at the chain's yield times its
 * drop, after the chain's kills, with the chain's other NPCs in `also`, which the hunt kills too, and
 * its `fights` per copy.
 */
export function huntPieces(model, tree) {
  const out = [];
  for (const s of tree.steps) {
    if (!s.item || !Number.isFinite(s.cost)) continue;
    let sources = [];
    if (s.way.kind === "drop") {
      sources = (model.ways.get(s.item) ?? []).filter((w) => w.kind === "drop").map((w) => ({ ...dropRow(s.item, { ...w, zoneShort: w.zone }), also: [] }));
    } else if (s.way.kind === "scene") {
      const m = meeting(model, s.way.npcId);
      if (!m) continue;
      const root = model.npcs.get(m.root)?.name ?? `#${m.root}`;
      const fights = m.fights.map((f) => ({ ...f, kills: f.kills / Math.max(s.way.drop, 1e-3) }));
      sources = [...(model.sites.get(m.root) ?? [])].map(([zone, site]) => ({ ...dropRow(s.item, { zoneShort: zone, npc: root, level: m.level, hp: m.hp, spawn: site.spawn, drop: m.yield * s.way.drop, points: site.points, respawn: site.respawn, when: site.when, kills: m.kills / Math.max(s.way.drop, 1e-3) }), also: m.also, fights }));
    }
    sources = sources.filter((r) => r.itemId != null);
    if (sources.length) out.push({ itemId: s.item, sources });
  }
  return out;
}

/**
 * The copies of each item the steps of epic tree `tree` (`epicTree`) take: each branch's trade
 * inputs and the items its conditions want held, and each combine's and summoning cast's inputs. A
 * piece bought at its step, from a merchant or the Tradeskill Bank's catalog, is not carried, so it
 * is no need. Returns `{ [itemId]: copies }`.
 */
export function treeNeeds(tree) {
  const bought = new Set(tree.steps.filter((s) => s.item && (s.way.kind === "buy" || s.way.kind === "catalog")).map((s) => s.item));
  const out = {};
  const add = (id, n) => {
    if (!bought.has(id)) out[id] = (out[id] ?? 0) + n;
  };
  for (const s of tree.steps) {
    const inputs = s.branch ? s.branch.inputs : (s.way.inputs ?? {});
    for (const [id, n] of Object.entries(inputs)) add(Number(id), n);
    for (const id of s.held ?? []) if (!(String(id) in inputs)) add(id, 1);
  }
  return out;
}
