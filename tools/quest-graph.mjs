#!/usr/bin/env bun
// Checks the quest graph (tools/lib/quest-graph.mjs) against the hand-kept chains after a content
// update (docs/plans/items.md, "Checks"): the items of data/quests.json that the class epics' chain
// demand leaves out, and the bracketed item ids of each class section of docs/plans/epics.md that
// lie outside its class's closure. Both lists name steps the graph cannot follow yet, such as a
// scene that ends in a kill, which stepDemand covers from data/quests.json.
//
//   bun tools/quest-graph.mjs
import { readFile } from "node:fs/promises";
import { loadItemModel } from "./lib/item-demand.mjs";
import { needFor } from "./lib/quest-graph.mjs";

const REPO = new URL("../", import.meta.url).pathname;
const model = await loadItemModel();
const quests = JSON.parse(await readFile(`${REPO}data/quests.json`, "utf8"));
const closure = new Map(Object.entries(model.epics).map(([cls, rewards]) => [cls, new Set(rewards.flatMap((r) => [r, ...needFor(model.edges, r, new Set(), model.buyable).keys()]))]));
const covered = (cls, id) => closure.get(cls)?.has(id) || model.buyable.has(id);

let gaps = 0;
for (const [id, q] of Object.entries(quests)) {
  const names = [...(q.needs ?? []), ...q.steps.flatMap((s) => [...(s.give ?? []), ...(s.craft?.inputs ?? []), ...Object.keys(s.each ?? {}), s.expect])].filter(Boolean);
  const out = [...new Set(names)].filter((n) => !(model.ids.get(n) ?? []).some((x) => covered(q.class, x)));
  if (out.length) console.log(`quests.json ${id}: ${out.join(", ")}`);
  gaps += out.length;
}
// A class section of epics.md starts at "### <Class>:" and names pieces as "[id]".
const epics = await readFile(`${REPO}docs/plans/epics.md`, "utf8");
for (const section of epics.split(/^### /m).slice(1)) {
  const cls = Object.keys(model.epics).find((c) => section.startsWith(`${c}:`));
  if (!cls) continue;
  const out = [...new Set([...section.matchAll(/\[(\d{4,6})\]/g)].map((m) => Number(m[1])))].filter((id) => !covered(cls, id));
  if (out.length) console.log(`epics.md ${cls}: ${out.map((id) => `${model.names.get(id) ?? "?"} [${id}]`).join(", ")}`);
  gaps += out.length;
}
console.log(`${model.edges.length} edges, ${gaps} items outside the graph's chains`);
