#!/usr/bin/env bun
// Sweep rosters through tools/raidsim.mjs by boss, level and roster size, and keep every result.
//
//   bun tools/raidsweep.mjs --name <sweep> [--bosses resolve|<id,...>] [--levels 46,50,55,60]
//     [--base tools/raidsim/rosters/groups-1-3.json] [--group warrior,cleric,cleric,shaman,necromancer,necromancer]
//     [--extra 0,3,6] [--seeds 6] [-- <raidsim flags, e.g. --heal-mode all-balanced>]
//
// A roster is the --base members plus N extra groups of the --group classes, all at the level of
// the row. Each configuration runs once: raidsim's JSON goes to runs/jobs/<sweep>/<key>.json and a
// summary row to runs/jobs/<sweep>/summary.jsonl, so a rerun after an interruption only runs what
// is missing. Runs are sequential because each raidsim run already spreads its fights over the
// cores it may use. The table at the end lists every configuration of the sweep.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;
const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const args = split >= 0 ? argv.slice(0, split) : argv;
const passthrough = split >= 0 ? argv.slice(split + 1) : [];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const list = (s) => String(s).split(",").map((x) => x.trim()).filter(Boolean);

// The Raid Resolve bosses (`Ed`, .re/js/main.pretty.js:22714-22726) without Kerafyrm, whose rows
// are untargetable.
const RESOLVE = [128090, 128091, 128092, 128093, 124017, 72003, 114106, 127098, 124155, 113457];

const name = opt("name");
if (!name) {
  console.error("raidsweep: --name <sweep> is required (results go to runs/jobs/<sweep>/)");
  process.exit(1);
}
const bosses = opt("bosses", "resolve") === "resolve" ? RESOLVE : list(opt("bosses")).map(Number);
const levels = list(opt("levels", "46,50,55,60")).map(Number);
const extras = list(opt("extra", "0")).map(Number);
const group = list(opt("group", "warrior,cleric,cleric,shaman,necromancer,necromancer"));
const seeds = String(Number(opt("seeds", 6)));
const basePath = opt("base", join(here, "tools/raidsim/rosters/groups-1-3.json"));
const base = JSON.parse(readFileSync(basePath, "utf8"));
const baseMembers = Array.isArray(base) ? base : base.members;

const dir = join(here, "runs/jobs", name);
mkdirSync(dir, { recursive: true });
const summaryPath = join(dir, "summary.jsonl");

const roster = (level, extra) => {
  const members = baseMembers.map((m) => ({ ...m }));
  const firstGroup = 1 + Math.max(0, ...baseMembers.map((m) => Number(/^G(\d+)/.exec(m.name ?? "")?.[1] ?? 0)));
  for (let g = 0; g < extra; g++) group.forEach((cls, i) => members.push({ name: `G${firstGroup + g} ${cls} ${i + 1}`, class: cls }));
  return { level, members };
};

const rows = [];
for (const boss of bosses) {
  for (const level of levels) {
    for (const extra of extras) {
      const spec = roster(level, extra);
      const config = { boss, seeds, flags: passthrough, roster: spec };
      const key = createHash("sha1").update(JSON.stringify(config)).digest("hex").slice(0, 12);
      const out = join(dir, `${key}.json`);
      let result;
      if (existsSync(out)) {
        result = JSON.parse(await readFile(out, "utf8"));
      } else {
        const rosterPath = join(dir, `${key}.roster.json`);
        await writeFile(rosterPath, JSON.stringify(spec));
        const run = Bun.spawnSync([process.execPath, join(here, "tools/raidsim.mjs"), "--boss", String(boss), "--roster", rosterPath, "--seeds", seeds, "--json", ...passthrough], { cwd: here, stdout: "pipe", stderr: "pipe" });
        if (run.exitCode !== 0) {
          console.error(`raidsweep: boss ${boss} level ${level} extra ${extra}: ${run.stderr.toString().trim().split("\n").slice(-2).join(" | ")}`);
          continue;
        }
        result = JSON.parse(run.stdout.toString());
        await writeFile(out, JSON.stringify(result));
        const s = result.results[0].summary;
        const deaths = s.members.reduce((n, m) => n + m.deaths, 0) / s.fights;
        await appendFile(summaryPath, JSON.stringify({ key, t: new Date().toISOString(), boss, bossName: result.boss.name, level, members: spec.members.length, extra, group, flags: passthrough, seeds: s.fights, kills: s.kills, wipes: s.wipes, meanSec: s.meanSecOrLimit, hpLeftPct: (100 * s.bossHpLeftMean) / s.bossMaxHp, deathsPerFight: deaths }) + "\n");
      }
      const s = result.results[0].summary;
      const deaths = s.members.reduce((n, m) => n + m.deaths, 0) / s.fights;
      rows.push([result.boss.name.replace(/#/g, "").replace(/_/g, " "), level, spec.members.length, `${s.kills}/${s.fights}`, Math.round(s.meanSecOrLimit), `${((100 * s.bossHpLeftMean) / s.bossMaxHp).toFixed(0)}%`, deaths.toFixed(1)]);
      console.error(`${rows.at(-1).join("  ")}`);
    }
  }
}

const head = ["Boss", "Level", "Members", "Kills", "Mean s", "HP left", "Deaths/fight"];
const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const line = (r) => r.map((c, i) => (i === 0 ? String(c).padEnd(width[i]) : String(c).padStart(width[i]))).join("  ");
console.log(`Sweep ${name}: ${seeds} seeds per row, group ${group.join(" ")}${passthrough.length ? `, raidsim ${passthrough.join(" ")}` : ""}\n`);
console.log(line(head));
for (const r of rows) console.log(line(r));
