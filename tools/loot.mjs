#!/usr/bin/env bun
// Measured loot per enemy from the live run logs (runs/live/<leader>/events.jsonl, written by iqd):
// kills of each enemy name, the items looted right after those kills and their rate per kill, and
// both per hour of the window. A loot line belongs to the kill line before it when it follows
// within 3 s. Use it to check a farm's yield and the content snapshot's drop rates
// (`tools/drops.mjs`) against what the groups actually get.
//
//   bun tools/loot.mjs [--groups G5,G10 | --leaders A,B] [--last 60 | --since <ms> --until <ms>]
//                      [--enemy <regex>] [--item <regex>] [--json]
//
// Groups come from data/roster.json, and each group's log is its leader's. Coin lines are left
// out. Kills while another member led the tab (a hand-in task) are in that member's own log.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    groups: { type: "string" },
    leaders: { type: "string" },
    last: { type: "string", default: "60" },
    since: { type: "string" },
    until: { type: "string" },
    enemy: { type: "string" },
    item: { type: "string" },
    json: { type: "boolean", default: false },
  },
});
const REPO = new URL("..", import.meta.url).pathname;
const until = opt.until ? Number(opt.until) : Date.now();
const since = opt.since ? Number(opt.since) : until - Number(opt.last) * 60000;
const hours = (until - since) / 3600000;
const enemyRe = opt.enemy ? new RegExp(opt.enemy, "i") : null;
const itemRe = opt.item ? new RegExp(opt.item, "i") : null;
const roster = JSON.parse(await readFile(`${REPO}data/roster.json`, "utf8"));
const wanted = opt.groups ? new Set(opt.groups.split(",")) : null;
const leaders = opt.leaders
  ? opt.leaders.split(",").map((l) => ({ group: roster.groups.find((g) => g.members?.[0] === l)?.id ?? "-", leader: l }))
  : roster.groups.filter((g) => g.members?.length && (!wanted || wanted.has(g.id))).map((g) => ({ group: g.id, leader: g.members[0] }));

const KILL = /^You have (?:defeated|slain) (.+?)(?: and gained \d+ experience!|, but gain no experience\.)/;
const LOOT = /^You loot (.+?)!$/;
const COIN = /^\d+ (?:platinum|gold|silver|copper)\b/;

/** Kills and loot per enemy name for one leader's log inside the window. */
async function tally(leader) {
  let text = "";
  try {
    text = await readFile(`${REPO}runs/live/${leader}/events.jsonl`, "utf8");
  } catch {
    return null;
  }
  const enemies = new Map();
  let last = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const e = JSON.parse(line);
    if (e.t < since || e.t > until || e.type === "bot") continue;
    const k = KILL.exec(e.text);
    if (k) {
      const name = k[1];
      const row = enemies.get(name) ?? enemies.set(name, { kills: 0, items: {} }).get(name);
      row.kills++;
      last = { row, t: e.t };
      continue;
    }
    const l = LOOT.exec(e.text);
    if (l && last && e.t - last.t <= 3000 && !COIN.test(l[1])) last.row.items[l[1]] = (last.row.items[l[1]] ?? 0) + 1;
  }
  return enemies;
}

const out = [];
for (const { group, leader } of leaders) {
  const enemies = await tally(leader);
  if (!enemies) continue;
  for (const [enemy, row] of enemies) {
    if (enemyRe && !enemyRe.test(enemy)) continue;
    const items = Object.entries(row.items).filter(([name]) => !itemRe || itemRe.test(name));
    if (itemRe && !items.length && !enemyRe) continue;
    out.push({ group, leader, enemy, kills: row.kills, killsPerHour: +(row.kills / hours).toFixed(1), items: Object.fromEntries(items.map(([name, n]) => [name, { n, perKill: +(n / row.kills).toFixed(3), perHour: +(n / hours).toFixed(2) }])) });
  }
}

if (opt.json) console.log(JSON.stringify({ since, until, rows: out }));
else {
  console.log(`${Math.round(hours * 60)} min, ${new Date(since).toTimeString().slice(0, 5)} to ${new Date(until).toTimeString().slice(0, 5)} (runs/live/<leader>/events.jsonl)`);
  console.log("group leader        enemy                          kills  k/h   items (count, per kill, per hour)");
  for (const r of out.sort((a, b) => a.group.localeCompare(b.group, undefined, { numeric: true }) || b.kills - a.kills)) {
    const items = Object.entries(r.items).map(([name, v]) => `${name} ${v.n} (${v.perKill}, ${v.perHour}/h)`).join(", ");
    console.log(`${r.group.padEnd(5)} ${r.leader.padEnd(13)} ${r.enemy.slice(0, 30).padEnd(30)} ${String(r.kills).padStart(5)} ${String(r.killsPerHour).padStart(5)}   ${items}`);
  }
}
