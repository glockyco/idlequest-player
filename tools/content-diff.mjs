#!/usr/bin/env bun
// What a content update changes for play: zones, NPC types and spawns that differ between two
// revisions of the idlequest-content repository, and which zones the XP model now ranks into the
// top 3 of a level band.
//
//   bun tools/content-diff.mjs [old..new] [--repo dir] [--levels 10,20,30] [--top 12]
//
// The revisions default to HEAD@{1}..HEAD, which is what the last `git pull` changed (HEAD~1 when
// the repository has no reflog entry). The repository defaults to $IQ_CONTENT or
// ~/src/github.com/brynnb/idlequest-content. Both revisions are extracted to a temporary directory
// and ranked with `tools/predict.mjs`, so the comparison uses one model for both. A zone is flagged
// when it is in the new top 3 at a level but not in that level's row of data/band-rotations.json.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const range = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "HEAD@{1}..HEAD";
const repo = flag("repo", process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`);
const top = Number(flag("top", 12));
const levels = flag("levels", "10,20,30,33,38,44,50").split(",").map(Number);
const here = new URL("../", import.meta.url).pathname;
const TABLES = ["zone", "spawn2", "spawnentry", "npc_types"];

const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).trim();
const resolve = (rev) => git("rev-parse", "--verify", `${rev}^{commit}`);

const [oldRev, newRev] = range.split("..");
let oldSha;
let note = "";
try {
  oldSha = resolve(oldRev);
} catch {
  if (oldRev !== "HEAD@{1}") throw new Error(`cannot resolve ${oldRev} in ${repo}`);
  oldSha = resolve("HEAD~1");
  note = " (no reflog entry for HEAD@{1}, using HEAD~1)";
}
const newSha = resolve(newRev || "HEAD");
console.log(`content ${git("log", "-1", "--format=%h %ad %s", "--date=short", oldSha)}`);
console.log(`     -> ${git("log", "-1", "--format=%h %ad %s", "--date=short", newSha)}${note}\n`);

// Extracts the tables the comparison reads to a directory that looks like the content repository.
const scratch = mkdtempSync(join(tmpdir(), "content-diff-"));
const extract = (sha, name) => {
  const dir = join(scratch, name);
  execFileSync("mkdir", ["-p", dir]);
  const tar = execFileSync("git", ["-C", repo, "archive", sha, ...TABLES.map((t) => `data/${t}`)], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar, maxBuffer: 1 << 30 });
  return dir;
};
const rows = (dir, table) => {
  const out = [];
  const base = join(dir, "data", table);
  for (const f of readdirSync(base).filter((f) => f.endsWith(".ndjson"))) {
    for (const l of readFileSync(join(base, f), "utf8").split("\n")) if (l) out.push(JSON.parse(l));
  }
  return out;
};
const byKey = (list, key) => new Map(list.map((r) => [typeof key === "function" ? key(r) : r[key], r]));
const show = (title, lines) => {
  console.log(`${title}${lines.length ? "" : ": none"}`);
  for (const l of lines.slice(0, top)) console.log(`  ${l}`);
  if (lines.length > top) console.log(`  ... ${lines.length - top} more`);
  console.log();
};

try {
  const oldDir = extract(oldSha, "old");
  const newDir = extract(newSha, "new");

  // Zones: version 0 rows by short name.
  const zonesOf = (dir) => byKey(rows(dir, "zone").filter((z) => z.version === 0), "short_name");
  const zOld = zonesOf(oldDir);
  const zNew = zonesOf(newDir);
  const zoneLine = (z) => `${z.short_name} "${z.long_name}" zem ${z.zone_exp_multiplier} min_level ${z.min_level}`;
  show("Zones added", [...zNew.values()].filter((z) => !zOld.has(z.short_name)).map(zoneLine));
  show("Zones removed", [...zOld.values()].filter((z) => !zNew.has(z.short_name)).map(zoneLine));
  const zoneChanges = [];
  for (const [short, z] of zNew) {
    const o = zOld.get(short);
    if (!o) continue;
    const diffs = ["zone_exp_multiplier", "min_level"].filter((k) => String(o[k]) !== String(z[k])).map((k) => `${k} ${o[k]} -> ${z[k]}`);
    if (diffs.length) zoneChanges.push(`${short} "${z.long_name}": ${diffs.join(", ")}`);
  }
  show("Zones changed (zone_exp_multiplier, min_level)", zoneChanges);

  // NPC types by id.
  const nOld = byKey(rows(oldDir, "npc_types"), "id");
  const nNew = byKey(rows(newDir, "npc_types"), "id");
  const npcName = (id) => (nNew.get(id) ?? nOld.get(id))?.name?.replace(/^#/, "").replaceAll("_", " ") ?? `#${id}`;
  const npcAdded = [...nNew.values()].filter((n) => !nOld.has(n.id));
  const npcRemoved = [...nOld.values()].filter((n) => !nNew.has(n.id));
  console.log(`NPC types: ${npcAdded.length} added, ${npcRemoved.length} removed, ${[...nNew.values()].filter((n) => nOld.has(n.id) && ["level", "hp", "mindmg", "maxdmg", "AC"].some((k) => String(nOld.get(n.id)[k]) !== String(n[k]))).length} with changed level, HP, damage or AC`);
  const byLevel = npcAdded.sort((a, b) => b.level - a.level || a.id - b.id);
  show("NPC types added (highest level first)", byLevel.map((n) => `${n.id} ${npcName(n.id)} L${n.level} hp ${n.hp}`));

  // Spawns: spawn2 points per zone (version 0) and the NPCs of the spawn groups they use.
  const sOld = rows(oldDir, "spawn2").filter((s) => s.version === 0);
  const sNew = rows(newDir, "spawn2").filter((s) => s.version === 0);
  const pointsOld = byKey(sOld, "id");
  const pointsNew = byKey(sNew, "id");
  const entries = (dir) => {
    const m = new Map();
    for (const e of rows(dir, "spawnentry")) (m.get(e.spawngroupID) ?? m.set(e.spawngroupID, new Set()).get(e.spawngroupID)).add(e.npcID);
    return m;
  };
  const eOld = entries(oldDir);
  const eNew = entries(newDir);
  const zoneOfGroup = new Map();
  for (const s of [...sOld, ...sNew]) zoneOfGroup.set(s.spawngroupID, s.zone);
  const perZone = new Map();
  const bucket = (z) => perZone.get(z) ?? perZone.set(z, { added: 0, removed: 0, moved: 0, npcsIn: new Set(), npcsOut: new Set() }).get(z);
  for (const [id, s] of pointsNew) {
    const o = pointsOld.get(id);
    if (!o) bucket(s.zone).added++;
    else if (o.x !== s.x || o.y !== s.y || o.spawngroupID !== s.spawngroupID || o.respawntime !== s.respawntime) bucket(s.zone).moved++;
  }
  for (const [id, s] of pointsOld) if (!pointsNew.has(id)) bucket(s.zone).removed++;
  for (const g of new Set([...eOld.keys(), ...eNew.keys()])) {
    const z = zoneOfGroup.get(g);
    if (!z) continue;
    const a = eOld.get(g) ?? new Set();
    const b = eNew.get(g) ?? new Set();
    for (const id of b) if (!a.has(id)) bucket(z).npcsIn.add(id);
    for (const id of a) if (!b.has(id)) bucket(z).npcsOut.add(id);
  }
  const names = (set) => [...set].slice(0, 4).map(npcName).join(", ") + (set.size > 4 ? `, +${set.size - 4}` : "");
  const spawnLines = [...perZone.entries()]
    .filter(([, b]) => b.added || b.removed || b.moved || b.npcsIn.size || b.npcsOut.size)
    .sort((a, b) => b[1].added + b[1].removed + b[1].moved + b[1].npcsIn.size + b[1].npcsOut.size - (a[1].added + a[1].removed + a[1].moved + a[1].npcsIn.size + a[1].npcsOut.size))
    .map(([z, b]) => `${z}: points +${b.added} -${b.removed} changed ${b.moved}${b.npcsIn.size ? `; NPCs in spawn groups +${b.npcsIn.size} (${names(b.npcsIn)})` : ""}${b.npcsOut.size ? `; -${b.npcsOut.size} (${names(b.npcsOut)})` : ""}`);
  show(`Spawn changes per zone (${spawnLines.length} zones)`, spawnLines);

  // Ranking: the XP model at each level on the old and the new content.
  const bands = JSON.parse(readFileSync(join(here, "data/band-rotations.json"), "utf8")).sort((a, b) => b[0] - a[0]);
  const bandRow = (level) => bands.find(([from]) => from <= level)?.[1] ?? [];
  const rank = (dir, level) => {
    const out = execFileSync("bun", [join(here, "tools/predict.mjs"), "--level", String(level), "--json", "--content", dir], { encoding: "utf8", maxBuffer: 1 << 28 });
    return JSON.parse(out.slice(out.indexOf("["))).slice(0, 3).map((r) => r.short);
  };
  console.log("Top 3 by predicted XP/h (tools/predict.mjs), band row = data/band-rotations.json");
  const flagged = [];
  const drift = [];
  for (const level of levels) {
    const before = rank(oldDir, level);
    const after = rank(newDir, level);
    const row = bandRow(level);
    const notInRow = after.filter((z) => !row.includes(z));
    const entered = after.filter((z) => !before.includes(z));
    console.log(`  L${String(level).padEnd(3)} old [${before.join(", ")}]  new [${after.join(", ")}]  band row [${row.join(", ")}]`);
    for (const z of entered) flagged.push(`L${level}: ${z} newly enters the top 3${row.includes(z) ? ", already in the band row" : " and is not in the band row"}`);
    for (const z of before.filter((z) => !after.includes(z))) flagged.push(`L${level}: ${z} leaves the top 3${row.includes(z) ? " and is in the band row" : ""}`);
    for (const z of notInRow.filter((z) => !entered.includes(z))) drift.push(`L${level}: ${z}`);
  }
  console.log();
  show("Flags: top 3 changed by this update", flagged);
  show("Not caused by this update: in the top 3 before and after, but not in the band row", drift);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
