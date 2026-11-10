#!/usr/bin/env bun
// The epic model's check (docs/plans/epic-model.md, "Checks"): for each class epic of
// data/epics.json, the steps the model chooses from the quest scripts and the content's tables, the
// pieces no open way gives (gaps), the kills that need a raid, and the conditions and actions of the
// chosen branches the script analyzer cannot read. Run it after every content update. It exits with
// 1 while a chosen branch holds a condition or an action the analyzer cannot read.
//
//   bun tools/epic-model.mjs              one summary line per class
//   bun tools/epic-model.mjs --steps      and every class's steps
//   bun tools/epic-model.mjs --class Bard the steps of one class
//   bun tools/epic-model.mjs --hand       and the items of the hand-kept chains (data/quests.json)
//                                         and the class sections of docs/plans/epics.md that the
//                                         model's steps do not take
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { rows } from "./lib/content.mjs";
import { dependencies, epicTree, loadEpicModel } from "./lib/epic-model.mjs";

const REPO = new URL("../", import.meta.url).pathname;
const { values: opt } = parseArgs({ options: { steps: { type: "boolean" }, class: { type: "string" }, hand: { type: "boolean" } } });
const epics = JSON.parse(await readFile(`${REPO}data/epics.json`, "utf8"));
const model = await loadEpicModel();
const names = new Map();
const ids = new Map();
for await (const i of rows("items")) {
  names.set(i.id, i.Name);
  ids.set(i.Name, [...(ids.get(i.Name) ?? []), i.id]);
}
const classes = Object.entries(epics).filter(([cls]) => !opt.class || cls === opt.class);
const needed = new Set();
for (const [, rewards] of classes) for (const r of rewards) for (const id of dependencies(model, r).items) needed.add(id);
await model.addStatic([...needed]);

const itemList = (o) => Object.keys(o).map((i) => names.get(Number(i)) ?? i).join(", ");
const branchText = (b) => {
  const say = b.when.find((c) => c.say)?.say;
  const gives = b.actions.flatMap((a) => a.give ?? []).map((i) => names.get(i) ?? i);
  const spawns = b.actions.filter((a) => a.spawn).map((a) => model.npcs.get(a.spawn)?.name ?? a.spawn);
  return `${b.event} ${b.npc} (${b.zone})${say ? ` say "${say.join("/")}"` : ""}${Object.keys(b.inputs).length ? ` takes ${itemList(b.inputs)}` : ""}${gives.length ? ` gives ${gives.join(", ")}` : ""}${spawns.length ? ` spawns ${spawns.join(", ")}` : ""} [${b.file}:${b.line}]`;
};
const wayText = (w) => {
  if (w.kind === "scene") return `kill scripted ${w.npc} L${w.level} (${Math.round(w.drop * 100)}%)`;
  if (w.kind === "drop") return `drop of ${w.npc} L${w.level} (${w.zone}) ${(w.drop * 100).toFixed(1)}%`;
  if (w.kind === "buy") return `buy from ${w.npc} (${w.zone})`;
  if (w.kind === "ground") return `ground spawn (${w.zone})`;
  if (w.kind === "catalog") return `Tradeskill Bank catalog, ${w.price} copper`;
  if (w.kind === "combine") return `combine ${itemList(w.inputs)} (recipe ${w.recipe})`;
  if (w.kind === "cast") return `cast spell ${w.spell} on ${itemList(w.inputs)}`;
  return w.kind;
};
const killLevel = (s) => (s.item ? (s.way.level ?? 0) : s.branch.event === "death" ? Math.max(0, ...s.branch.npcIds.map((id) => model.npcs.get(id)?.level ?? 0)) : 0);
// Every item a tree touches: its pieces, the branches' inputs, held items and gifts.
const treeItems = (tree) => new Set(tree.steps.flatMap((s) => (s.item ? [s.item] : [...Object.keys(s.branch.inputs).map(Number), ...s.held, ...s.branch.actions.flatMap((a) => a.give ?? [])])));

let unreadable = 0;
const touched = new Map();
for (const [cls, rewards] of classes) {
  touched.set(cls, new Set(rewards));
  for (const reward of rewards) {
    const tree = epicTree(model, cls, reward);
    for (const id of treeItems(tree)) touched.get(cls).add(id);
    const raids = tree.steps.filter((s) => killLevel(s) > 60);
    const unread = tree.steps.filter((s) => s.branch).flatMap((s) => [...s.branch.when, ...s.branch.actions].filter((x) => x.unread).map((x) => `${s.branch.file}:${x.line} ${x.unread}`));
    // A blocker is a gap or a branch blocked for its own reason, not only through a blocked input.
    const blockers = tree.blocked.filter((b) => b.reasons.some((r) => r !== "an input cannot be had"));
    unreadable += unread.length;
    console.log(`${cls}: ${names.get(reward)} [${reward}], ${tree.steps.length} steps, ${Number.isFinite(tree.cost) ? "open" : "blocked"}, ${tree.gaps.length} gaps, ${blockers.length} blocked branches, ${raids.length} raid kills, ${unread.length} unread`);
    if (!opt.steps && !opt.class) continue;
    for (const s of tree.steps) console.log(`  ${Number.isFinite(s.cost) ? "" : "x "}${s.item ? `${names.get(s.item)} [${s.item}]: ${wayText(s.way)}` : branchText(s.branch)}`);
    for (const g of tree.gaps) console.log(`  gap: ${names.get(g)} [${g}] has no source`);
    for (const b of blockers) console.log(`  blocked: ${b.branch ? branchText(b.branch) : `${names.get(b.item)} [${b.item}]`}: ${b.reasons.filter((r) => r !== "an input cannot be had").join("; ")}`);
    for (const u of unread) console.log(`  unread: ${u}`);
  }
}
console.log(`${model.scripts.length} scripts read, ${model.disabled} disabled, ${model.failed.length} that do not parse`);

if (opt.hand) {
  const covered = (cls, id) => touched.get(cls)?.has(id);
  const quests = JSON.parse(await readFile(`${REPO}data/quests.json`, "utf8"));
  for (const [id, q] of Object.entries(quests)) {
    if (!touched.has(q.class)) continue;
    const items = [...(q.needs ?? []), ...q.steps.flatMap((s) => [...(s.give ?? []), ...(s.craft?.inputs ?? []), ...Object.keys(s.each ?? {}), s.expect])].filter(Boolean);
    const out = [...new Set(items)].filter((n) => !(ids.get(n) ?? []).some((x) => covered(q.class, x)));
    if (out.length) console.log(`quests.json ${id}: ${out.join(", ")}`);
  }
  // A class section of epics.md starts at "### <Class>:" and names pieces as "[id]".
  const notes = await readFile(`${REPO}docs/plans/epics.md`, "utf8");
  for (const section of notes.split(/^### /m).slice(1)) {
    const cls = [...touched.keys()].find((c) => section.startsWith(`${c}:`));
    if (!cls) continue;
    const out = [...new Set([...section.matchAll(/\[(\d{4,6})\]/g)].map((m) => Number(m[1])))].filter((id) => !covered(cls, id));
    if (out.length) console.log(`epics.md ${cls}: ${out.map((id) => `${names.get(id) ?? "?"} [${id}]`).join(", ")}`);
  }
}
if (unreadable) process.exitCode = 1;
