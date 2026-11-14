// Quest rewards as a source of gear (docs/plans/gear-acquisition.md, "Quest rewards"): the
// wearable items quest scripts give, each with the epic model's cheapest way and its chains.

import { CLASS_KEYS } from "./gear-data.mjs";
import { epicChains } from "./epic-chain.mjs";
import { epicTree, huntPieces, missingKinds } from "./epic-model.mjs";
import { CLASS_BY_NUMBER } from "./quest-script.mjs";

// No character passes this level, so a reward that needs more is out of reach.
const LEVEL_CAP = 60;
// Rough hours of a chain step with the walk to its NPC, beside the model's cost of the pieces.
export const STEP_HOURS = 0.1;

/**
 * The quest rewards characters can wear and get: `[{ rewardId, classes, className, tree, pieces,
 * cost, steps }]`. A reward counts when a script gives it (`script` ways of the epic model), it can
 * be worn (`slots`, no bag) at `LEVEL_CAP` or below, it is no class epic (`exclude`), and its tree
 * for a class the item allows has a finite cost, no step kind the bot lacks and no hunt of the
 * reward itself. `classes` lists
 * those classes as the gear plan's keys. The tree, pieces and cost are those of the first class,
 * because in the content every class that can get a reward gets it the same way.
 * `items` maps an item id to its content row. Call the model's `addStatic` for the rewards'
 * dependencies first, since the ordinary drops and merchants of their inputs come from there.
 */
export function questRewards(model, { items, exclude = new Set() }) {
  const out = [];
  for (const [rewardId, ways] of model.ways) {
    if (exclude.has(rewardId) || !ways.some((w) => w.kind === "script")) continue;
    const item = items.get(rewardId);
    if (!item || !(item.slots > 0) || item.bagslots > 0 || (item.reqlevel ?? 0) > LEVEL_CAP) continue;
    let first = null;
    const classes = [];
    for (let n = 1; n <= 14; n++) {
      if (!(item.classes & (1 << (n - 1)))) continue;
      const tree = epicTree(model, CLASS_BY_NUMBER[n], rewardId);
      if (!Number.isFinite(tree.cost) || missingKinds(model, tree).length) continue;
      classes.push(CLASS_KEYS[n]);
      first ??= { className: CLASS_BY_NUMBER[n], tree };
    }
    if (!first) continue;
    // A reward whose cheapest way is to loot it is a drop, which the gear plan's drops cover.
    const pieces = huntPieces(model, first.tree);
    if (pieces.some((p) => p.itemId === rewardId)) continue;
    out.push({ rewardId, classes, className: first.className, tree: first.tree, pieces, cost: first.tree.cost, steps: first.tree.steps.filter((s) => !s.item).length });
  }
  return out;
}

/**
 * The chains of quest reward `q` (`questRewards`), as `epicChains` makes them for an epic, with ids
 * `gear-...` in place of `epic-...`, leaving out a part without steps.
 */
export function questChains(model, q, { names, shopZones }) {
  return epicChains(model, q.tree, { cls: q.className, reward: q.rewardId, names, shopZones }).filter(({ chain }) => chain.steps.length).map(({ id, chain }) => ({ id: id.replace(/^epic-/, "gear-"), chain }));
}
