#!/usr/bin/env bun
// Plan hand-me-downs: armor and jewelry that one account character carries and another can wear
// better than what it has equipped in that slot.
//
//   bun tools/handdown.mjs [items.json] [--content <idlequest-content clone>] [--min-gain 5] [--json]
//
// `items.json` is an Inventory Search survey of the account (`iq.searchAccount()`, which writes
// runs/state/account-items.json): one row per carried, banked or equipped item with its owner,
// class and level. Races come from the iqd database (runs/iq.db), groups from
// data/roster.json, and item stats from the content snapshot. Weapons are left out, because their
// damage is capped by level and Auto-Upgrade Companions already takes better ones. The score is
// tools/gear.mjs's stat score for the receiver's class and level.
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { BIT, RACE, CLASS_KEYS, SLOT_BY_NUM, rows, scoreFor } from "./lib/gear-data.mjs";

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
const raceKey = (r) => String(r ?? "").toLowerCase().replace(/[^a-z]/g, "");

// Wearable slots without the weapon slots (primary 13, secondary 14, range 11, ammo 21).
const ARMOR_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 17, 18, 19, 20];
const ids = new Set(survey.map((r) => r.itemId));
const items = new Map();
for await (const i of rows(opt.content, "items")) if (ids.has(i.id)) items.set(i.id, i);

// Characters that can receive: everyone in data/roster.json, with class and level from the survey.
const people = new Map();
for (const r of survey) if (groupOf.has(r.characterName)) people.set(r.characterName, { name: r.characterName, cls: CLASS_KEYS[r.class], level: r.level, race: raceKey(raceOf.get(r.characterName)), id: r.characterId });
const equipped = new Map(); // name -> slot -> item row
const owned = new Map(); // name -> Set of item ids (lore checks)
for (const r of survey) {
  if (!owned.has(r.characterName)) owned.set(r.characterName, new Set());
  owned.get(r.characterName).add(r.itemId);
  if (r.location === "Equipped") {
    if (!equipped.has(r.characterName)) equipped.set(r.characterName, new Map());
    equipped.get(r.characterName).set(r.slot, items.get(r.itemId));
  }
}

const score = (item, p) => (item ? scoreFor(item, p.cls, p.level) : 0);
const fits = (item, p, slot) =>
  item && item.slots & (1 << slot) && !(item.bagslots > 0) && item.classes & BIT[p.cls] && (!p.race || !RACE[p.race] || item.races & RACE[p.race]) && (item.reqlevel ?? 0) <= p.level;

const offers = [];
for (const r of survey) {
  if (r.location !== "Carried" || (r.blockReason && r.blockReason !== "Already on this character.")) continue;
  const item = items.get(r.itemId);
  if (!item || !ARMOR_SLOTS.some((s) => item.slots & (1 << s))) continue;
  for (const p of people.values()) {
    if (item.loreflag && p.name !== r.characterName && owned.get(p.name)?.has(r.itemId)) continue;
    for (const slot of ARMOR_SLOTS) {
      if (!fits(item, p, slot)) continue;
      const gain = score(item, p) - score(equipped.get(p.name)?.get(slot), p);
      if (gain >= Number(opt["min-gain"])) offers.push({ row: r, item, to: p, slot, gain });
    }
  }
}
// Greedy by gain: each copy goes once, and each receiver slot takes one item.
offers.sort((a, b) => b.gain - a.gain);
const usedRow = new Set();
const usedSlot = new Set();
const moves = [];
for (const o of offers) {
  const rk = `${o.row.characterId}:${o.row.itemInstanceId}`;
  const sk = `${o.to.name}:${o.slot}`;
  if (usedRow.has(rk) || usedSlot.has(sk)) continue;
  usedRow.add(rk);
  usedSlot.add(sk);
  moves.push({
    item: o.row.itemName,
    itemId: o.row.itemId,
    from: o.row.characterName,
    fromGroup: groupOf.get(o.row.characterName) ?? "--",
    to: o.to.name,
    toGroup: groupOf.get(o.to.name),
    slot: SLOT_BY_NUM[o.slot],
    slotNum: o.slot,
    gain: Math.round(o.gain),
    replaces: equipped.get(o.to.name)?.get(o.slot)?.Name ?? null,
  });
}

if (opt.json) console.log(JSON.stringify(moves));
else {
  const byGroup = Map.groupBy(moves, (m) => m.toGroup);
  const order = [...byGroup.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  console.log(`${moves.length} moves from ${new Set(moves.map((m) => m.from)).size} carriers to ${new Set(moves.map((m) => m.to)).size} characters (survey of ${survey.length} rows)`);
  for (const g of order) {
    console.log(g);
    for (const m of byGroup.get(g)) console.log(`  ${m.to.padEnd(12)} ${m.slot.padEnd(9)} ${m.item.padEnd(30)} +${String(m.gain).padStart(3)}  from ${m.from} (${m.fromGroup})${m.replaces ? `, replaces ${m.replaces}` : ""}`);
  }
}
