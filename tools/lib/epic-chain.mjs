// Quest chains from the epic model (docs/plans/epic-model.md, step 2): an epic tree's steps in the
// bot's chain format (data/quests.json), split where a hunted piece comes in, so each part runs as
// soon as the pieces it takes are held, as the hand-kept chains are split.
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

/**
 * The chains of epic reward `reward` for class `cls` from its tree (`epicTree`), each `{ id, chain }`
 * with `chain` as data/quests.json keeps it: a say or a hand-in at its NPC, with the item it gives as
 * `expect` and a purchase from a merchant of the same zone as `buy`, a step that only buys for a
 * merchant of another zone, a kill step for an NPC a hand-in spawns with its loot as `expect`, and
 * a craft step for a combine. A hunted piece (`huntPieces`) and the deaths that bring it are no
 * step: each part that takes hunted pieces starts a new chain whose `needs` are those pieces and
 * the part before's reward. A part's `minLevel` is its hardest kill's level, and the median level
 * of each zone it walks, less `KILL_MARGIN`. None for a tree that is blocked or needs a kind the
 * bot lacks (`missingKinds`). `names` maps item ids to names, and `shopZones` are the cities where
 * a party of any level can shop (data/shop-zones.json).
 */
export function epicChains(model, tree, { cls, reward, names, shopZones = new Set() }) {
  if (!Number.isFinite(tree.cost) || missingKinds(model, tree).length) return [];
  const pieces = huntPieces(model, tree);
  const hunted = new Set(pieces.map((p) => p.itemId));
  // The NPCs of the hunts, whose deaths belong to the hunt rather than to the chain.
  const huntNpcs = new Set(pieces.flatMap((p) => p.sources.flatMap((s) => [s.npc, ...s.also])));
  const name = (id) => names.get(id) ?? `#${id}`;
  const bought = new Map(tree.steps.filter((s) => s.item && s.way.kind === "buy").map((s) => [s.item, s.way]));
  // Where a bought piece is bought for a hand-in in `zone`: at a merchant of that zone when one
  // sells it, else in a city where any party can shop, else at the merchant the tree chose.
  const sellerOf = (id, zone) => {
    const all = (model.ways.get(id) ?? []).filter((w) => w.kind === "buy");
    return all.find((w) => w.zone === zone) ?? all.find((w) => shopZones.has(w.zone)) ?? bought.get(id);
  };
  const parts = [];
  let part = { steps: [], needs: [], level: 0 };
  for (const s of tree.steps) {
    if (s.item) {
      if (s.way.kind === "scene" && !hunted.has(s.item)) {
        // A kill names its enemy's level and hit points, for the group's chance against it.
        part.steps.push({ zone: s.way.by?.zone ?? [...(model.sites.get(s.way.npcId)?.keys() ?? [])][0], kill: s.way.npc, level: s.way.level ?? model.npcs.get(s.way.npcId)?.level ?? null, hp: model.npcs.get(s.way.npcId)?.hp ?? null, expect: name(s.item), waitSec: SPAWN_WAIT_SEC });
        part.level = Math.max(part.level, s.way.level ?? 0);
      } else if (s.way.kind === "combine") {
        const inputs = Object.keys(s.way.inputs).map(Number).filter((id) => !model.catalog.has(id)).map(name);
        part.steps.push({ zone: part.steps.at(-1)?.zone ?? tree.steps.find((x) => x.branch)?.branch.zone, craft: { recipeId: s.way.recipe, skillId: s.way.skill, quantity: s.way.nofail ? 1 : CRAFT_TRIES, inputs, output: { item: name(s.item), id: s.item } }, expect: name(s.item) });
        if (!s.way.nofail) part.trivial = Math.max(part.trivial ?? 0, s.way.trivial ?? 0);
      } else if (s.way.kind === "ground") {
        // A quest item that lies in its zone, picked up as a click on it does, and back after its respawn.
        part.steps.push({ zone: s.way.zone, pick: name(s.item), expect: name(s.item), respawnSec: s.way.respawn ?? null });
      } else if (s.way.kind === "cast") {
        // The epic's own character casts the summoning spell where the part stands: the model
        // leaves a cast by another class out (`missingKinds`). It needs the spell's level.
        part.steps.push({ zone: part.steps.at(-1)?.zone ?? tree.steps.find((x) => x.branch)?.branch.zone, cast: { spellId: s.way.spell, spell: s.way.name }, expect: name(s.item) });
        part.castLevel = Math.max(part.castLevel ?? 0, s.way.classes?.[cls] ?? 0);
      }
      continue;
    }
    const b = s.branch;
    if (b.event === "timer" || b.event === "signal" || (b.event === "death" && huntNpcs.has(b.npc))) continue;
    if (b.event === "death") {
      const hardest = b.npcIds.map((id) => model.npcs.get(id)).filter(Boolean).sort((x, y) => (y.level ?? 0) - (x.level ?? 0))[0];
      part.steps.push({ zone: b.zone, kill: b.npc, level: hardest?.level ?? null, hp: hardest?.hp ?? null, waitSec: SPAWN_WAIT_SEC });
      part.level = Math.max(part.level, ...b.npcIds.map((id) => model.npcs.get(id)?.level ?? 0));
      continue;
    }
    const takes = Object.entries(b.inputs).flatMap(([id, n]) => Array(n).fill(Number(id)));
    const fresh = [...new Set(takes.filter((id) => hunted.has(id)))].map(name);
    if (fresh.length && part.steps.length) {
      parts.push(part);
      part = { steps: [], needs: [], level: 0 };
    }
    part.needs.push(...fresh);
    const say = b.when.find((c) => c.say)?.say;
    const coin = b.when.find((c) => c.trade?.coin)?.trade.coin;
    const gives = b.actions.flatMap((a) => a.give ?? []).filter((id) => !(String(id) in b.inputs));
    const buys = [...new Set(takes.filter((id) => bought.has(id)))];
    const near = buys.filter((id) => sellerOf(id, b.zone).zone === b.zone);
    // A merchant of another zone sells in a step of its own, before the hand-in.
    for (const id of buys.filter((x) => !near.includes(x))) {
      const w = sellerOf(id, b.zone);
      part.steps.push({ zone: w.zone, buy: { merchant: w.npc, items: [name(id)], counts: { [name(id)]: b.inputs[id] } } });
    }
    part.steps.push({
      zone: b.zone,
      npc: b.npc,
      // Another NPC of the zone can have this one's name, so the step names its type ids too.
      ...(b.npcIds?.length ? { npcIds: b.npcIds } : {}),
      ...(say ? { say: [say[0]] } : {}),
      ...(takes.length ? { give: takes.map(name) } : {}),
      ...(coin ? { coin } : {}),
      ...(near.length ? { buy: { merchant: sellerOf(near[0], b.zone).npc, items: near.map(name) } } : {}),
      ...(gives.length ? { expect: name(gives[0]) } : {}),
    });
  }
  parts.push(part);
  // The median level of each zone's static NPCs.
  const levels = new Map();
  for (const [id, sites] of model.sites) for (const zone of sites.keys()) (levels.get(zone) ?? levels.set(zone, []).get(zone)).push(model.npcs.get(id)?.level ?? 0);
  const zoneLevel = (zone) => {
    const l = (levels.get(zone) ?? []).sort((a, b) => a - b);
    return l.length ? l[Math.floor(l.length / 2)] : 0;
  };
  const key = cls.toLowerCase().replace(/ /g, "-");
  return parts
    .map((p, k) => {
      const prev = k > 0 ? parts[k - 1].steps.findLast((x) => x.expect)?.expect : null;
      const last = p.steps.findLast((x) => x.expect)?.expect ?? name(reward);
      return {
        id: `epic-${key}-${reward}-${k + 1}`,
        trivial: p.trivial ?? 0,
        chain: { class: cls, minLevel: Math.min(LEVEL_CAP, Math.max(1, p.castLevel ?? 0, p.level - KILL_MARGIN, ...p.steps.map((x) => zoneLevel(x.zone) - KILL_MARGIN))), reward: last, ...(p.needs.length || prev ? { needs: [...(prev ? [prev] : []), ...p.needs] } : {}), steps: p.steps },
      };
    })
    // A part with a craft that trivials above `CRAFT_TRIVIAL_MAX` waits until the account trains
    // its skill, because each failed attempt uses its components up: the Warrior's Rebreather
    // trivials at 175 and costs 383 pp an attempt.
    .filter((c) => c.trivial <= CRAFT_TRIVIAL_MAX)
    .map(({ id, chain }) => ({ id, chain }));
}

/**
 * The model's chains (`{ [id]: chain }`) without each part a hand-kept chain of its class covers:
 * a part that yields a hand-kept chain's reward on the way. The hand-kept chains carry what the
 * model does not read, such as the keywords Baenar Swiftsong needs one after another, and two
 * chains for one stretch would send two members after one crown. The parts beyond a hand-kept
 * chain stay, and start from the items it hands on.
 */
export function uncovered(chains, hand) {
  const covered = new Map();
  for (const q of Object.values(hand)) (covered.get(q.class) ?? covered.set(q.class, new Set()).get(q.class)).add(q.reward);
  return Object.fromEntries(Object.entries(chains).filter(([, c]) => !c.steps.some((s) => s.expect && covered.get(c.class)?.has(s.expect))));
}
