#!/usr/bin/env bun
// Print the roster gear plan (tools/lib/gear-plan.mjs) for an Inventory Search survey of the
// account: which carried item each character should wear, and from whom it comes. The coordinator
// in tools/iqd.mjs runs the same plan and carries it out as a gear task.
//
//   bun tools/handdown.mjs [items.json] [--content <idlequest-content clone>] [--min-gain 5] [--json]
//
// `items.json` is the survey (`iq.searchAccount()` writes runs/state/account-items.json). Races
// come from the iqd database (runs/iq.db), groups from data/roster.json and item stats from the
// content snapshot.
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { rows } from "./lib/gear-data.mjs";
import { planGear, rosterPeople } from "./lib/gear-plan.mjs";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    content: { type: "string", default: `${homedir()}/src/github.com/brynnb/idlequest-content` },
    "min-gain": { type: "string", default: "5" },
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
const items = new Map();
for await (const i of rows(opt.content, "items")) if (ids.has(i.id)) items.set(i.id, i);

const { moves } = planGear({ survey, items, people: rosterPeople(survey, groupOf, raceOf), minGain: Number(opt["min-gain"]) });
if (opt.json) console.log(JSON.stringify(moves.map((m) => ({ ...m, fromGroup: groupOf.get(m.from) ?? "--", toGroup: groupOf.get(m.to) }))));
else {
  const byGroup = Map.groupBy(moves, (m) => groupOf.get(m.to));
  const order = [...byGroup.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  console.log(`${moves.length} moves from ${new Set(moves.map((m) => m.from)).size} carriers to ${new Set(moves.map((m) => m.to)).size} characters (survey of ${survey.length} rows)`);
  for (const g of order) {
    console.log(g);
    for (const m of byGroup.get(g)) console.log(`  ${m.to.padEnd(12)} ${m.slot.padEnd(9)} ${m.item.padEnd(30)} +${String(m.gain).padStart(5)}  from ${m.from} (${groupOf.get(m.from) ?? "--"})${m.replaces ? `, replaces ${m.replaces}` : ""}`);
  }
}
