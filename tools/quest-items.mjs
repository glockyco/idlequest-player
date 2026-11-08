#!/usr/bin/env bun
// Write data/quest-items.json: every item id a quest script in the content snapshot accepts in a
// turn-in (`check_turn_in(e.trade, {item1 = ...})`). The bot never sells the last copy of these as
// a cheap single item, because its explicit sales bypass the client's Keep Epic Quest Items option,
// which the server applies only to Auto Sell. Epic routes mix NO DROP pieces with tradable ones
// (raw Broom and Shovel, toes, feathers, gems), and nothing in the item rows marks the tradable
// ones as quest pieces.
//
//   bun tools/quest-items.mjs [--content <snapshot dir>]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const at = args.indexOf("--content");
const content = at >= 0 ? args[at + 1] : (process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`);
const root = join(content, "effective", "quests");

async function* luaFiles(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* luaFiles(p);
    else if (e.name.endsWith(".lua")) yield p;
  }
}

const ids = new Set();
let scripts = 0;
for await (const file of luaFiles(root)) {
  const text = await readFile(file, "utf8");
  let found = false;
  for (const call of text.matchAll(/check_turn_in\s*\([^{]*\{([^}]*)\}/g)) {
    for (const m of call[1].matchAll(/item\d+\s*=\s*(\d{3,6})/g)) {
      ids.add(Number(m[1]));
      found = true;
    }
  }
  if (found) scripts++;
}
if (ids.size < 1000) {
  console.error(`only ${ids.size} turn-in items found under ${root}; is the content snapshot complete?`);
  process.exit(1);
}
const out = new URL("../data/quest-items.json", import.meta.url);
await writeFile(out, JSON.stringify([...ids].sort((a, b) => a - b)) + "\n");
console.log(`${ids.size} turn-in items from ${scripts} scripts, written to ${out.pathname}`);
