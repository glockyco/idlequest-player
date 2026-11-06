#!/usr/bin/env bun
// What an enemy actually is, not just its level: HP, melee damage per second, AC, casting and
// special abilities, from the content snapshot (the same data the server loads).
//
//   bun tools/mobs.mjs <zone short name> [--levels 9-14] [--data runs/zones-content] [--content ~/src/.../idlequest-content]
//
// One row per NPC type that spawns in the zone, with how many spawn points it has. Melee damage per
// second is (min + max) / 2 over the attack delay, before AC, hit chance and the NPC's own
// attack_count, so it ranks enemies against each other rather than predicting damage taken.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);
const zone = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!zone) {
  console.error("usage: bun tools/mobs.mjs <zone short name> [--levels a-b] [--data dir] [--content dir]");
  process.exit(1);
}
const [lo, hi] = (opt("levels", "0-99")).split("-").map(Number);
const dataDir = opt("data", new URL("../runs/zones-content", import.meta.url).pathname);
const content = opt("content", `${homedir()}/src/github.com/brynnb/idlequest-content`);

const snap = JSON.parse(await readFile(`${dataDir}/${zone}.json`, "utf8"));
const bySpawn = new Map();
for (const s of snap.spawns) bySpawn.set(s.npcId, (bySpawn.get(s.npcId) ?? 0) + 1);

// Special ability ids follow the EQEmu server's numbering. They come from memory of that project,
// not from this repository, so an unknown id is printed as a number.
const SPECIAL = { 1: "summon", 2: "enrage", 3: "rampage", 4: "area-rampage", 5: "flurry", 6: "triple", 7: "quad", 8: "dual-wield", 9: "bane-only", 10: "magical-attack", 11: "ranged", 12: "unslowable", 13: "unmezzable", 14: "uncharmable", 15: "unstunnable", 16: "unsnarable", 17: "unfearable", 18: "undispellable", 19: "immune-melee", 20: "immune-magic", 21: "immune-flee", 22: "immune-melee-except-bane", 23: "immune-nonmagical-melee", 24: "immune-aggro", 25: "immune-target", 26: "casting-resist-diff", 27: "counter-avoid-damage", 28: "immune-ranged", 29: "immune-damage-shield", 30: "immune-no-bane" };

const rows = [];
for (const f of (await readdir(`${content}/data/npc_types`)).filter((n) => n.endsWith(".ndjson"))) {
  for (const line of (await readFile(`${content}/data/npc_types/${f}`, "utf8")).split("\n")) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (!bySpawn.has(o.id) || o.level < lo || o.level > hi) continue;
    const delay = (o.attack_delay || 30) / 10;
    const avg = ((Number(o.mindmg) || 0) + (Number(o.maxdmg) || 0)) / 2;
    const specials = String(o.special_abilities ?? "")
      .split("^")
      .filter(Boolean)
      .map((p) => p.split(","))
      .filter(([, v]) => v !== "0")
      .map(([id]) => SPECIAL[id] ?? `#${id}`);
    rows.push({
      name: o.name.replace(/^#/, "").replaceAll("_", " "),
      level: o.level,
      spawns: bySpawn.get(o.id),
      hp: Number(o.hp),
      dps: +(avg / delay).toFixed(1),
      maxHit: Number(o.maxdmg) || 0,
      ac: o.AC,
      caster: Number(o.npc_spells_id) > 0,
      specials: specials.filter((s) => !s.startsWith("un") && !s.startsWith("immune") && s !== "uncharmable"),
      immune: specials.filter((s) => s.startsWith("un") || s.startsWith("immune")),
    });
  }
}
rows.sort((a, b) => a.level - b.level || b.spawns - a.spawns);

console.log(`${snap.zone?.long_name ?? zone}: ${rows.length} NPC types with spawns, levels ${lo}-${hi}\n`);
console.log("level  spawns  hp     dps   maxhit  ac   name                          caster  specials / immunities");
for (const r of rows) {
  console.log(`${String(r.level).padStart(3)}  ${String(r.spawns).padStart(6)}  ${String(r.hp).padStart(5)}  ${String(r.dps).padStart(5)}  ${String(r.maxHit).padStart(5)}  ${String(r.ac).padStart(4)}  ${r.name.padEnd(30)}${r.caster ? "yes   " : "      "}  ${[...r.specials, ...r.immune.map((s) => "(" + s + ")")].join(" ")}`);
}
