#!/usr/bin/env bun
// Print the roster gear plan (tools/lib/gear-plan.mjs) for an Inventory Search survey of the
// account: which carried item each character should wear, and from whom it comes. The coordinator
// in tools/iqd.mjs runs the same plan and carries it out as a gear task.
//
//   bun tools/handdown.mjs [items.json] [--content <idlequest-content clone>] [--min-gain 0.5] [--buy-pp 0] [--weights <file>] [--json]
//
// `--min-gain` is in the gear plan's unit (`gearGain`), and `--buy-pp` the platinum the plan may
// spend at merchants (iqd spends the account's last hour of income less the raid budget). The raid
// weights come from `--weights`, by default runs/state/raid-weights.json as in the coordinator's plan.
//
// `items.json` is the survey (`iq.searchAccount()` writes runs/state/account-items.json). Races
// come from the iqd database (runs/iq.db), groups from data/roster.json and item stats from the
// content snapshot.
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { rows } from "./lib/content.mjs";
import { attachEffects, merchantGoods } from "./lib/gear-data.mjs";
import { planGear, raidWeights, rosterPeople } from "./lib/gear-plan.mjs";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    content: { type: "string", default: `${homedir()}/src/github.com/brynnb/idlequest-content` },
    "min-gain": { type: "string", default: "0.5" },
    "buy-pp": { type: "string", default: "0" },
    weights: { type: "string" },
    json: { type: "boolean", default: false },
  },
});
const REPO = new URL("..", import.meta.url).pathname;
const survey = JSON.parse(await readFile(positionals[0] ?? `${REPO}runs/state/account-items.json`, "utf8"));
const roster = JSON.parse(await readFile(`${REPO}data/roster.json`, "utf8"));
const groupOf = new Map(roster.groups.flatMap((g) => (g.members ?? []).map((n) => [n, g.id])));
const db = new Database(`${REPO}runs/iq.db`, { readonly: true });
const raceOf = new Map(db.query("SELECT name, race FROM characters").all().map((r) => [r.name, r.race]));
const ids = new Set(survey.map((r) => r.itemId));
const { shop, items } = await merchantGoods(opt.content);
for await (const i of rows("items", opt.content)) if (ids.has(i.id)) items.set(i.id, i);
await attachEffects(items, opt.content);

const poolOf = new Map(db.query("SELECT c.name, s.max_mana FROM char_snapshots s JOIN characters c ON c.id = s.char_id WHERE s.id IN (SELECT MAX(id) FROM char_snapshots WHERE max_mana > 0 GROUP BY char_id)").all().map((r) => [r.name, r.max_mana]));
const raidDoc = await readFile(opt.weights ?? `${REPO}runs/state/raid-weights.json`, "utf8").then(JSON.parse, () => null);
const people = rosterPeople(survey, groupOf, raceOf).map((p) => ({ ...p, pool: poolOf.get(p.name), raid: raidWeights(raidDoc, p.cls, p.level) }));
// The class epics stay with whoever carries them, as in the coordinator's plan.
const bound = new Set(Object.values(JSON.parse(await readFile(new URL("../data/epics.json", import.meta.url), "utf8"))).flat());
const { moves } = planGear({ survey, items, people, minGain: Number(opt["min-gain"]), shop, buyPp: Number(opt["buy-pp"]), bound });
if (opt.json) console.log(JSON.stringify(moves.map((m) => ({ ...m, fromGroup: groupOf.get(m.from) ?? "--", toGroup: groupOf.get(m.to) }))));
else {
  const byGroup = Map.groupBy(moves, (m) => groupOf.get(m.to));
  const order = [...byGroup.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  console.log(`${moves.length} moves from ${new Set(moves.map((m) => m.from)).size} carriers to ${new Set(moves.map((m) => m.to)).size} characters (survey of ${survey.length} rows)`);
  for (const g of order) {
    console.log(g);
    for (const m of byGroup.get(g)) console.log(`  ${m.to.padEnd(12)} ${m.slot.padEnd(9)} ${m.item.padEnd(30)} +${String(m.gain).padStart(5)}  ${m.buy ? `buy from ${m.buy.merchant} in ${m.buy.zone} for ${m.buy.price} pp` : `from ${m.from} (${groupOf.get(m.from) ?? "--"})`}${m.replaces ? `, replaces ${m.replaces}` : ""}`);
  }
}
