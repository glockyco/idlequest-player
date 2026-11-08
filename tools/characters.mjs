#!/usr/bin/env bun
// Every account character's class, race, level and worn gear, from the server's raid character
// projection (opcode 1194, answered on 1195, the read-only request the raid window sends to load a
// recruit), asked in any game tab through the browser relay. Character ids come from the iqd
// database, groups from data/roster.json and item stats from the content snapshot. Writes
// runs/state/characters.json.
//
//   bun tools/characters.mjs [--json] [--content <idlequest-content clone>]
import { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { Relay } from "../src/cdp.mjs";
import { SLOT_BY_NUM, rows } from "./lib/gear-data.mjs";

const { values: opt } = parseArgs({ options: { json: { type: "boolean", default: false }, content: { type: "string", default: `${homedir()}/src/github.com/brynnb/idlequest-content` } } });
const REPO = new URL("..", import.meta.url).pathname;
const db = new Database(`${REPO}runs/iq.db`, { readonly: true });
const known = db.query("SELECT id, name FROM characters ORDER BY id").all();
const roster = JSON.parse(await readFile(`${REPO}data/roster.json`, "utf8"));
const groupOf = new Map(roster.groups.flatMap((g) => (g.members ?? []).map((n) => [n, g.id])));

// Runs in the page: one projection per character, a quarter second apart.
const inPage = async (ids) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sd = window.iq.stores.staticData.getState();
  const cls = Object.fromEntries((sd.classes ?? []).map((c) => [c.id, c.name]));
  const race = Object.fromEntries((sd.races ?? []).map((r) => [r.id, r.name]));
  const out = [];
  for (const id of ids) {
    try {
      const r = await window.iq.socket.sendCorrelatedJsonRequest(1194, 1195, { characterId: id }, 8000);
      const s = r?.snapshot ?? r;
      out.push({ id, name: s?.name ?? null, class: cls[s?.classId] ?? s?.classId ?? null, race: race[s?.raceId] ?? s?.raceId ?? null, level: s?.level ?? null, equipped: (s?.equippedItems ?? []).map((e) => [e.slot, e.itemId]), error: s?.name ? null : String(r?.error ?? "no snapshot") });
    } catch (e) {
      out.push({ id, error: String(e?.message ?? e) });
    }
    await sleep(250);
  }
  return out;
};

// A tab cannot project its own active character ("Your active character already leads the raid"),
// so characters a tab refuses go to the next game tab.
const relay = new Relay();
await relay.start();
const byId = new Map();
let pending = known.map((k) => k.id);
for (const targetId of relay.tabs().keys()) {
  if (!pending.length) break;
  try {
    if (!(await relay.evaluate(targetId, "Boolean(window.iq?.socket?.isConnected)"))) continue;
    const got = await relay.evaluate(targetId, `(${inPage})(${JSON.stringify(pending)})`, { timeout: 120000 });
    for (const c of got) if (!c.error || !byId.has(c.id)) byId.set(c.id, c);
    pending = got.filter((c) => c.error).map((c) => c.id);
  } catch {
    /* try the next game tab */
  }
}
await relay.stop();
if (!byId.size) throw new Error("no connected game tab answered");
const chars = [...byId.values()];

const ids = new Set(chars.flatMap((c) => (c.equipped ?? []).map(([, id]) => id)));
const items = new Map();
for await (const i of rows(opt.content, "items")) if (ids.has(i.id)) items.set(i.id, i);
for (const c of chars) {
  c.group = groupOf.get(c.name) ?? null;
  c.gear = (c.equipped ?? []).map(([slot, id]) => ({ slot: SLOT_BY_NUM[slot] ?? String(slot), item: items.get(id)?.Name ?? `item ${id}`, ac: items.get(id)?.ac ?? 0 }));
  delete c.equipped;
}
await writeFile(`${REPO}runs/state/characters.json`, JSON.stringify(chars, null, 1));

if (opt.json) console.log(JSON.stringify(chars));
else {
  const order = (c) => [Number(String(c.group ?? "G99").slice(1)), c.name ?? ""];
  chars.sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1].localeCompare(order(b)[1]));
  console.log(`${chars.length} characters (runs/state/characters.json has every worn item)`);
  for (const c of chars) {
    if (c.error) {
      console.log(`${String(c.group ?? "--").padEnd(4)} ${String(c.id).padEnd(12)} ${c.error}`);
      continue;
    }
    const ac = c.gear.reduce((s, g) => s + g.ac, 0);
    const weapon = c.gear.find((g) => g.slot === "primary")?.item ?? "no weapon";
    console.log(`${String(c.group ?? "--").padEnd(4)} ${c.name.padEnd(12)} ${String(c.class).padEnd(13)} ${String(c.race).padEnd(10)} L${String(c.level).padStart(2)}  ${String(c.gear.length).padStart(2)} worn, AC ${String(ac).padStart(3)}, ${weapon}`);
  }
}
