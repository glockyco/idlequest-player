// Generates quest chains from the epic model (docs/plans/epic-model.md, step 2). An epic tree's
// steps are converted to the bot's chain format (data/quests.json) and split into parts that can
// each run as soon as their inputs are available.
import { huntPieces, missingKinds } from "./epic-model.mjs";

// A script spawns its NPC a moment after the hand-in that summons it, and a kill step tries again
// until this many seconds have passed.
const SPAWN_WAIT_SEC = 60;
// A part waits for members this many levels below its hardest kill at most, where the kill chance
// model gives a sure kill (1.00 three levels above the leader, runs/state/kill-odds.json), and as
// far below the median level of the static NPCs of each zone it walks.
const KILL_MARGIN = 3;
// No character passes this level, so a part asks for no more, and its fight waits for the kill chance.
const LEVEL_CAP = 60;
// The attempts a craft step may take on a recipe that can fail, each pulling one set of inputs.
const CRAFT_TRIES = 10;
// The highest trivial of a craft a chain runs while no character has trained a tradeskill.
const CRAFT_TRIVIAL_MAX = 50;

/** Strips the ` [id]` suffix that `epicChains` adds to the second item of a shared name. */
export const plainName = (name) => String(name).replace(/ \[\d+\]$/, "");

/**
 * Builds the chains for epic `reward` of class `cls` from its tree (`epicTree`). Returns
 * `[{ id, chain }]`, with `chain` in the format of data/quests.json. Returns `[]` for a blocked
 * tree or one that needs a step kind the bot lacks (`missingKinds`).
 *
 * Step kinds: say or hand-in at an NPC (`expect` is the item it gives, `buy` a purchase in the
 * same zone), buy-only step for a merchant in another zone, kill of an NPC a hand-in spawns, craft,
 * cast, ground pickup. Hunted pieces (`huntPieces`) and the kills that drop them are not steps.
 *
 * Splitting into parts: a step stays in the current part if it consumes an item the part produced,
 * or if the part spawned its NPC or ran a branch it depends on (`after` of the tree step).
 * Otherwise it starts a new part. A step that consumes a hunted piece also starts a new part,
 * unless the part spawned its NPC, because the NPC would despawn while the hunt runs.
 *
 * - `needs`: inputs the part neither produces nor buys. Parts have no other ordering.
 * - `reward`: the last item the part produces. The coordinator treats a character as done with a
 *   part if it carries the reward or something a later part made from it (`doneItems`). This is
 *   only valid because every part is a single dependency chain.
 * - `flow`: per step, the items it consumes (`ins`, without bought ones) and produces (`outs`).
 * - `calledBy` on a step: index of the step in the same part that spawned its NPC.
 * - `id`: ends in the reward's item id, so it is stable when other parts of the tree change.
 * - `minLevel`: the highest of the hardest kill's level and each zone's median NPC level, minus
 *   `KILL_MARGIN`.
 *
 * A scripted NPC that drops several pieces gets one kill step. A later part that consumes the
 * other piece lists it in `needs`.
 *
 * `names` maps item ids to names. `shopZones` lists the cities where any party can shop
 * (data/shop-zones.json).
 */
export function epicChains(model, tree, { cls, reward, names, shopZones = new Set() }) {
  if (!Number.isFinite(tree.cost) || missingKinds(model, tree).length) return [];
  const pieces = huntPieces(model, tree);
  const hunted = new Set(pieces.map((p) => p.itemId));
  // The NPCs of the hunts, whose deaths belong to the hunt rather than to the chain.
  const npcKey = (n) => n.replace(/^#/, "").replace(/_/g, " ").trim();
  const huntIds = new Set(pieces.flatMap((p) => p.sources.flatMap((s) => [s.npcId, ...(s.alsoIds ?? [])])).filter((id) => id != null));
  const huntNpcs = new Set(pieces.flatMap((p) => p.sources.flatMap((s) => [s.npc, ...s.also])).map(npcKey));
  const unnamedHunts = new Set(pieces.flatMap((p) => p.sources.filter((s) => s.npcId == null).flatMap((s) => [s.npc, ...s.also])).map(npcKey));
  // All items the tree references, in step order. If two ids share a name, the later one is
  // named "Name [id]" so that steps can tell them apart.
  const treeItems = tree.steps.flatMap((s) => (s.item ? [s.item, ...Object.keys(s.way.inputs ?? {}).map(Number)] : [...Object.keys(s.branch.inputs).map(Number), ...s.branch.actions.flatMap((a) => a.give ?? [])]));
  const firstOf = new Map();
  for (const id of treeItems) if (names.has(id) && !firstOf.has(names.get(id))) firstOf.set(names.get(id), id);
  const name = (id) => (!names.has(id) ? `#${id}` : (firstOf.get(names.get(id)) ?? id) === id ? names.get(id) : `${names.get(id)} [${id}]`);
  const bought = new Map(tree.steps.filter((s) => s.item && s.way.kind === "buy").map((s) => [s.item, s.way]));
  // Where a bought piece is bought for a hand-in in `zone`: at a merchant of that zone when one
  // sells it, else in a city where any party can shop, else at the merchant the tree chose.
  const sellerOf = (id, zone) => {
    const all = (model.ways.get(id) ?? []).filter((w) => w.kind === "buy");
    return all.find((w) => w.zone === zone) ?? all.find((w) => shopZones.has(w.zone)) ?? bought.get(id);
  };
  const parts = [];
  // The part being built. `flow` parallels `steps`. `branches` are the script branches already
  // run, `spawned` maps a spawned NPC id to `{ zone, at }` (the spawning step), and `met` maps the
  // NPC ids of earlier steps to their zone.
  const fresh = () => ({ steps: [], flow: [], needs: [], level: 0, branches: new Set(), spawned: new Map(), met: new Map() });
  let part = fresh();
  let available = new Map();
  // Scripted NPC id to the `{ part, at }` of its kill step.
  const fights = new Map();
  const copies = (inputs) => Object.entries(inputs).flatMap(([id, n]) => Array(n).fill(Number(id)));
  // The step of the current part that spawned one of `npcIds` in `zone`. The zone must match
  // because the same NPC type can also have a permanent spawn elsewhere.
  const caller = (npcIds, zone) => npcIds.map((id) => part.spawned.get(id)).find((c) => c?.zone === zone) ?? null;
  const calledBy = (npcIds, zone) => (caller(npcIds, zone) ? { calledBy: caller(npcIds, zone).at } : {});
  // Closes the current part unless the next step belongs to it (see "Splitting into parts"
  // above). For a kill, an earlier step at the same NPC also counts as a dependency.
  const begin = ({ inputs = {}, after = [], npcIds = [], zone = null, kill = false }) => {
    const takes = copies(inputs);
    const called = after.some((b) => part.branches.has(b)) || Boolean(caller(npcIds, zone)) || (kill && npcIds.some((id) => part.met.get(id) === zone));
    const linked = called || takes.some((id) => (available.get(id) ?? 0) > 0);
    if (!part.steps.length || (linked && (called || !takes.some((id) => hunted.has(id))))) return;
    parts.push(part);
    part = fresh();
    available = new Map();
  };
  const push = (step, ins = []) => {
    part.steps.push(step);
    part.flow.push({ ins: ins.filter((id) => !bought.has(id)).map(name), outs: [] });
    return part.steps.length - 1;
  };
  const take = (inputs) => {
    const takes = copies(inputs);
    for (const id of takes) {
      if (bought.has(id)) continue;
      const n = available.get(id) ?? 0;
      if (n) available.set(id, n - 1);
      else part.needs.push(name(id));
    }
    return takes;
  };
  // Records that branch `b` ran at step `at`: the branch, its NPC and the NPCs it spawns.
  const ran = (b, at) => {
    part.branches.add(b);
    for (const id of b.npcIds ?? []) part.met.set(id, b.zone);
    for (const a of b.actions) if (a.spawn != null) part.spawned.set(a.spawn, { zone: b.zone, at });
  };
  const yieldItem = (id, at) => {
    available.set(id, (available.get(id) ?? 0) + 1);
    part.flow[at]?.outs.push(name(id));
  };
  const buyInputs = (inputs, zone) => {
    for (const [raw, n] of Object.entries(inputs)) {
      const id = Number(raw);
      if (!bought.has(id)) continue;
      const w = sellerOf(id, zone);
      push({ zone: w.zone, buy: { merchant: w.npc, items: [name(id)], counts: { [name(id)]: n } } });
    }
  };
  for (const s of tree.steps) {
    if (s.item) {
      if (s.way.kind === "scene" && !hunted.has(s.item)) {
        // This NPC already has a kill step, and one kill drops all of its pieces. The piece is
        // available in that step's part and becomes a need in any other part.
        const fought = fights.get(s.way.npcId);
        if (fought) {
          if (fought.part === part) yieldItem(s.item, fought.at);
          else fought.part.flow[fought.at].outs.push(name(s.item));
          continue;
        }
        const zone = s.way.by?.zone ?? [...(model.sites.get(s.way.npcId)?.keys() ?? [])][0];
        begin({ after: s.way.by ? [s.way.by] : [], npcIds: [s.way.npcId], zone, kill: true });
        // A kill names its enemy's level and hit points, for the group's chance against it.
        const at = push({ zone, kill: s.way.npc, level: s.way.level ?? model.npcs.get(s.way.npcId)?.level ?? null, hp: model.npcs.get(s.way.npcId)?.hp ?? null, expect: name(s.item), waitSec: SPAWN_WAIT_SEC, ...calledBy([s.way.npcId], zone) });
        part.level = Math.max(part.level, s.way.level ?? 0);
        fights.set(s.way.npcId, { part, at });
        yieldItem(s.item, at);
      } else if (s.way.kind === "combine") {
        const carried = Object.fromEntries(Object.entries(s.way.inputs).filter(([id]) => !model.catalog.has(Number(id))));
        begin({ inputs: carried });
        const inputs = take(carried).map(name);
        const zone = part.steps.at(-1)?.zone ?? tree.steps.find((x) => x.branch)?.branch.zone;
        buyInputs(carried, zone);
        const at = push({ zone, craft: { recipeId: s.way.recipe, skillId: s.way.skill, quantity: s.way.nofail ? 1 : CRAFT_TRIES, inputs, output: { item: name(s.item), id: s.item } }, expect: name(s.item) }, copies(carried));
        if (!s.way.nofail) part.trivial = Math.max(part.trivial ?? 0, s.way.trivial ?? 0);
        yieldItem(s.item, at);
      } else if (s.way.kind === "ground") {
        // A quest item that lies in its zone, picked up as a click on it does, and back after its respawn.
        begin({});
        yieldItem(s.item, push({ zone: s.way.zone, pick: name(s.item), expect: name(s.item), respawnSec: s.way.respawn ?? null }));
      } else if (s.way.kind === "cast") {
        // The epic's own character casts the summoning spell where the part stands: the model
        // leaves a cast by another class out (`missingKinds`). It needs the spell's level.
        begin({ inputs: s.way.inputs });
        const inputs = take(s.way.inputs).map(name);
        const zone = part.steps.at(-1)?.zone ?? tree.steps.find((x) => x.branch)?.branch.zone;
        buyInputs(s.way.inputs, zone);
        yieldItem(s.item, push({ zone, cast: { spellId: s.way.spell, spell: s.way.name, inputs }, expect: name(s.item) }, copies(s.way.inputs)));
        part.castLevel = Math.max(part.castLevel ?? 0, s.way.classes?.[cls] ?? 0);
      }
      continue;
    }
    const b = s.branch;
    const after = s.after ?? [];
    const npcIds = b.npcIds ?? [];
    if (b.event === "death" && (npcIds.length ? npcIds.some((id) => huntIds.has(id)) || unnamedHunts.has(npcKey(b.npc)) : huntNpcs.has(npcKey(b.npc)))) continue;
    // Timer and signal branches run without a step once the branch that starts them has run.
    // Their gives and spawns are attributed to the last step.
    if (b.event === "timer" || b.event === "signal") {
      if (!after.some((x) => part.branches.has(x))) continue;
      const at = part.steps.length - 1;
      ran(b, at);
      for (const id of b.actions.flatMap((a) => a.give ?? [])) yieldItem(id, at);
      continue;
    }
    if (b.event === "death") {
      begin({ after, npcIds, zone: b.zone, kill: true });
      const hardest = npcIds.map((id) => model.npcs.get(id)).filter(Boolean).sort((x, y) => (y.level ?? 0) - (x.level ?? 0))[0];
      const gives = b.actions.flatMap((a) => a.give ?? []);
      const at = push({ zone: b.zone, kill: b.npc, level: hardest?.level ?? null, hp: hardest?.hp ?? null, ...(gives.length ? { expect: name(gives[0]) } : {}), waitSec: SPAWN_WAIT_SEC, ...calledBy(npcIds, b.zone) });
      ran(b, at);
      for (const id of gives) yieldItem(id, at);
      part.level = Math.max(part.level, ...npcIds.map((id) => model.npcs.get(id)?.level ?? 0));
      continue;
    }
    begin({ inputs: b.inputs, after, npcIds, zone: b.zone });
    const takes = take(b.inputs);
    const say = b.when.find((c) => c.say)?.say;
    const coin = b.when.find((c) => c.trade?.coin)?.trade.coin;
    const gives = b.actions.flatMap((a) => a.give ?? []).filter((id) => !(String(id) in b.inputs));
    const buys = [...new Set(takes.filter((id) => bought.has(id)))];
    const near = buys.filter((id) => sellerOf(id, b.zone).zone === b.zone);
    // A merchant of another zone sells in a step of its own, before the hand-in.
    for (const id of buys.filter((x) => !near.includes(x))) {
      const w = sellerOf(id, b.zone);
      push({ zone: w.zone, buy: { merchant: w.npc, items: [name(id)], counts: { [name(id)]: b.inputs[id] } } });
    }
    const at = push({
      zone: b.zone,
      npc: b.npc,
      // Another NPC of the zone can have this one's name, so the step names its type ids too.
      ...(npcIds.length ? { npcIds } : {}),
      ...(say ? { say: [say[0]] } : {}),
      ...(takes.length ? { give: takes.map(name) } : {}),
      ...(coin ? { coin } : {}),
      ...(near.length ? { buy: { merchant: sellerOf(near[0], b.zone).npc, items: near.map(name) } } : {}),
      ...(gives.length ? { expect: name(gives[0]) } : {}),
      // Set if a step of this part spawned the NPC. The bot repeats that step when it resumes.
      ...calledBy(npcIds, b.zone),
    }, takes);
    ran(b, at);
    for (const id of b.actions.flatMap((a) => a.give ?? [])) yieldItem(id, at);
  }
  if (part.steps.length || !parts.length) parts.push(part);
  // The median level of each zone's static NPCs.
  const levels = new Map();
  for (const [id, sites] of model.sites) for (const zone of sites.keys()) (levels.get(zone) ?? levels.set(zone, []).get(zone)).push(model.npcs.get(id)?.level ?? 0);
  const zoneLevel = (zone) => {
    const l = (levels.get(zone) ?? []).sort((a, b) => a - b);
    return l.length ? l[Math.floor(l.length / 2)] : 0;
  };
  const key = cls.toLowerCase().replace(/ /g, "-");
  const ids = Object.fromEntries(treeItems.map((id) => [name(id), id]));
  const taken = new Set();
  return parts
    .map((p, k) => {
      const last = p.steps.findLast((x) => x.expect)?.expect ?? name(reward);
      // The id suffix is the produced item's id. It falls back to the part's position if the part
      // produces nothing or another part already uses that id.
      const made = p.steps.some((x) => x.expect) && !taken.has(ids[last]) ? ids[last] : `part${k + 1}`;
      taken.add(made);
      return {
        id: `epic-${key}-${reward}-${made}`,
        trivial: p.trivial ?? 0,
        chain: { class: cls, minLevel: Math.min(LEVEL_CAP, Math.max(1, p.castLevel ?? 0, p.level - KILL_MARGIN, ...p.steps.map((x) => zoneLevel(x.zone) - KILL_MARGIN))), reward: last, ids: Object.fromEntries([...new Set([last, ...p.needs, ...p.steps.flatMap((s) => [s.expect, s.pick, ...(s.give ?? []), ...(s.buy?.items ?? []), ...(s.craft?.inputs ?? []), s.craft?.output?.item, ...(s.cast?.inputs ?? [])])].filter(Boolean))].map((n) => [n, ids[n]])), ...(p.needs.length ? { needs: p.needs } : {}), steps: p.steps, flow: p.flow },
      };
    })
    // A part with a craft that trivials above `CRAFT_TRIVIAL_MAX` waits until the account trains
    // its skill, because each failed attempt uses its components up: the Warrior's Rebreather
    // trivials at 175 and costs 383 pp an attempt.
    .filter((c) => c.trivial <= CRAFT_TRIVIAL_MAX)
    .map(({ id, chain }) => ({ id, chain }));
}

/**
 * Removes from the generated chains (`{ [id]: chain }`) what the hand-kept chains (`hand`,
 * data/quests.json) of the same class already do, so that no stretch runs twice. Hand-kept chains
 * take precedence because they hold details the model cannot read, such as keyword sequences.
 *
 * A generated part is cut after its last step whose `expect` a hand-kept chain also produces (as a
 * step's `expect` or as its reward):
 * - no such step: the part is kept unchanged
 * - nothing produced after the cut: the part is dropped
 * - otherwise: the steps after the cut are kept, and `needs` is recomputed from `flow`, which adds
 *   the hand-kept chain's item
 *
 * A part without `flow` cannot be cut and is dropped if any of its steps is covered.
 */
export function uncovered(chains, hand) {
  // Items the hand-kept chains produce, per class. Keyed by id where the chain has one in `ids`,
  // because names are not unique, and by name otherwise.
  const covered = new Map();
  for (const q of Object.values(hand)) for (const item of [q.reward, ...(q.steps ?? []).map((s) => s.expect)].filter(Boolean)) (covered.get(q.class) ?? covered.set(q.class, new Set()).get(q.class)).add(q.ids?.[item] ?? item);
  const out = {};
  for (const [id, c] of Object.entries(chains)) {
    const yields = covered.get(c.class);
    const at = c.steps.findLastIndex((s) => s.expect && (yields?.has(c.ids?.[s.expect]) || yields?.has(plainName(s.expect))));
    if (at < 0) out[id] = c;
    if (at < 0 || !c.flow || !c.steps.slice(at + 1).some((s) => s.expect)) continue;
    const have = new Map();
    const needs = [];
    for (const f of c.flow.slice(at + 1)) {
      for (const n of f.ins) {
        if (have.get(n) > 0) have.set(n, have.get(n) - 1);
        else needs.push(n);
      }
      for (const n of f.outs) have.set(n, (have.get(n) ?? 0) + 1);
    }
    // Drop `calledBy` where the calling step was cut, and shift the others.
    const steps = c.steps.slice(at + 1).map(({ calledBy, ...s }) => (calledBy > at ? { ...s, calledBy: calledBy - at - 1 } : s));
    const { needs: _, ...rest } = c;
    out[id] = { ...rest, ...(needs.length ? { needs } : {}), steps, flow: c.flow.slice(at + 1) };
  }
  return out;
}
