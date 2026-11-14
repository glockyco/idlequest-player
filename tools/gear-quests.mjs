// Writes the quest rewards the gear plan can take, with their pieces and chains, to
// runs/state/gear-quests.json (docs/plans/gear-acquisition.md, "Quest rewards").
//
//   bun tools/gear-quests.mjs [--force]
//
// The file names the content's source commit, and a run for the same commit does nothing unless
// `--force` is given, because building the chains takes about half a minute and the content
// changes rarely. Reads the content only, never contacts the game. iqd runs it from its gear pass.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentRoot, rows } from "./lib/content.mjs";
import { dependencies, loadEpicModel } from "./lib/epic-model.mjs";
import { questChains, questRewards } from "./lib/gear-quests.mjs";

const OUT = "runs/state/gear-quests.json";
const root = contentRoot();
const commit = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")).sourceCommit ?? null;
const before = await readFile(OUT, "utf8").then(JSON.parse).catch(() => null);
if (before?.commit === commit && !process.argv.includes("--force")) process.exit(0);

const model = await loadEpicModel(root);
const items = new Map();
const names = new Map();
const scripted = new Set([...model.ways].filter(([, ws]) => ws.some((w) => w.kind === "script")).map(([id]) => id));
for await (const i of rows("items", root)) {
  names.set(i.id, i.Name);
  if (scripted.has(i.id)) items.set(i.id, i);
}
await model.addStatic([...new Set([...scripted].filter((id) => items.get(id)?.slots > 0).flatMap((id) => [...dependencies(model, id).items]))]);
const epics = new Set(Object.values(JSON.parse(await readFile(new URL("../data/epics.json", import.meta.url), "utf8"))).flat());
const shopZones = new Set(JSON.parse(await readFile(new URL("../data/shop-zones.json", import.meta.url), "utf8")));
const rewards = questRewards(model, { items, exclude: epics }).map(({ tree, ...q }) => ({ ...q, pieces: q.pieces.map((x) => ({ ...x, name: names.get(x.itemId) })), chains: questChains(model, { ...q, tree }, { names, shopZones }) })).filter((q) => q.chains.length);
await mkdir("runs/state", { recursive: true });
await writeFile(`${OUT}.tmp`, JSON.stringify({ t: Date.now(), commit, rewards }));
await rename(`${OUT}.tmp`, OUT);
console.log(`${rewards.length} quest rewards written to ${OUT}`);
