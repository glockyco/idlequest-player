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
// The attempts a craft step may take on a recipe that can fail, each pulling one set of inputs.
const CRAFT_TRIES = 10;

/**
 * The chains of epic reward `reward` for class `cls` from its tree (`epicTree`), each `{ id, chain }`
 * with `chain` as data/quests.json keeps it: a say or a hand-in at its NPC, with the item it gives as
 * `expect` and a purchase from a merchant of the same zone as `buy`, a kill step for an NPC a hand-in
 * spawns with its loot as `expect`, and a craft step for a combine. A hunted piece (`huntPieces`)
 * and the deaths that bring it are no step: each part that takes hunted pieces starts a new chain
 * whose `needs` are those pieces and the part before's reward. A part's `minLevel` is its hardest
 * kill's level, and the median level of each zone it walks, less `KILL_MARGIN`. None for a tree that
 * is blocked or needs a kind the bot lacks (`missingKinds`). `names` maps item ids to names.
 */
export function epicChains(model, tree, { cls, reward, names }) {
  if (!Number.isFinite(tree.cost) || missingKinds(model, tree).length) return [];
  const pieces = huntPieces(model, tree);
  const hunted = new Set(pieces.map((p) => p.itemId));
  // The NPCs of the hunts, whose deaths belong to the hunt rather than to the chain.
  const huntNpcs = new Set(pieces.flatMap((p) => p.sources.flatMap((s) => [s.npc, ...s.also])));
  const name = (id) => names.get(id) ?? `#${id}`;
  const bought = new Map(tree.steps.filter((s) => s.item && s.way.kind === "buy").map((s) => [s.item, s.way]));
  const parts = [];
  let part = { steps: [], needs: [], level: 0 };
  for (const s of tree.steps) {
    if (s.item) {
      if (s.way.kind === "scene" && !hunted.has(s.item)) {
        part.steps.push({ zone: s.way.by?.zone ?? [...(model.sites.get(s.way.npcId)?.keys() ?? [])][0], kill: s.way.npc, expect: name(s.item), waitSec: SPAWN_WAIT_SEC });
        part.level = Math.max(part.level, s.way.level ?? 0);
      } else if (s.way.kind === "combine") {
        const inputs = Object.keys(s.way.inputs).map(Number).filter((id) => !model.catalog.has(id)).map(name);
        part.steps.push({ zone: part.steps.at(-1)?.zone ?? tree.steps.find((x) => x.branch)?.branch.zone, craft: { recipeId: s.way.recipe, skillId: s.way.skill, quantity: s.way.nofail ? 1 : CRAFT_TRIES, inputs, output: { item: name(s.item), id: s.item } }, expect: name(s.item) });
      }
      continue;
    }
    const b = s.branch;
    if (b.event === "timer" || b.event === "signal" || (b.event === "death" && huntNpcs.has(b.npc))) continue;
    if (b.event === "death") {
      part.steps.push({ zone: b.zone, kill: b.npc, waitSec: SPAWN_WAIT_SEC });
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
    part.steps.push({
      zone: b.zone,
      npc: b.npc,
      // Another NPC of the zone can have this one's name, so the step names its type ids too.
      ...(b.npcIds?.length ? { npcIds: b.npcIds } : {}),
      ...(say ? { say: [say[0]] } : {}),
      ...(takes.length ? { give: takes.map(name) } : {}),
      ...(coin ? { coin } : {}),
      ...(buys.length ? { buy: { merchant: bought.get(buys[0]).npc, items: buys.map(name) } } : {}),
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
  return parts.map((p, k) => {
    const prev = k > 0 ? parts[k - 1].steps.findLast((x) => x.expect)?.expect : null;
    const last = p.steps.findLast((x) => x.expect)?.expect ?? name(reward);
    return {
      id: `epic-${key}-${reward}-${k + 1}`,
      chain: { class: cls, minLevel: Math.max(1, p.level - KILL_MARGIN, ...p.steps.map((x) => zoneLevel(x.zone) - KILL_MARGIN)), reward: last, ...(p.needs.length || prev ? { needs: [...(prev ? [prev] : []), ...p.needs] } : {}), steps: p.steps },
    };
  });
}
