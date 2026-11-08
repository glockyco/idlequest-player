#!/usr/bin/env bun
// When each group reaches the levels raids ask for, from the live state and the XP model.
//
//   bun tools/plan.mjs [--window 60] [--levels 46,50,55,60] [--new-groups 6]
//
// Inputs:
//   runs/iq.db                   playing groups: the leader and the account characters in its party
//                                (tools/iqd.mjs keeps it)
//   runs/live/<leader>/*.jsonl   the leader's total XP over the last --window minutes, which gives the
//                                group's XP per hour now
//   tools/predict.mjs            XP per hour at each level for the zones of that level's band row
//                                (data/band-rotations.json), cached under runs/jobs/plan-predict/
// A group's rate at a future level is the model's rate there times the group's calibration: its
// measured rate now over the model's rate at its current level. The model was fit on levels 15 to 35,
// so a calibration measured below level 15 applies only up to five levels above the current one, and
// the model's own rate is used beyond. Above level 50 no band row exists, so the model rate is the
// mean of the three best live zones. Members at the same level earn the same XP per kill, so the
// member whose race and class need the most XP sets the group's time to a level.
// A new group starts at level 1 with the median calibration of the playing groups, and all new
// groups level in parallel, one session each, so they reach a level together.
// Hours are hours of play. The tool knows nothing about deaths, crowding or zone changes.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const windowMin = Number(opt("window", 60));
const targets = String(opt("levels", "46,50,55,60")).split(",").map(Number);
const newGroups = Number(opt("new-groups", 0));

// XP to reach the start of level L for a factor of 1.00. The table is EQEmu's GetEXPForLevel, which
// the server's experienceProgress matches (start of 35 at 43,234,400, end at 51,450,000).
const MOD = (L) => (L < 31 ? 1.0 : L < 36 ? 1.1 : L < 41 ? 1.2 : L < 46 ? 1.3 : L < 52 ? 1.4 : ({ 52: 1.5, 53: 1.6, 54: 1.7, 55: 1.9, 56: 2.1, 57: 2.3, 58: 2.5, 59: 2.7, 60: 3.0 })[L] ?? 3.1);
export const xpStart = (L) => (L <= 1 ? 0 : Math.round((L - 1) ** 3 * MOD(L) * 1000));
// Race and class factors from the wiki (experience-and-zones, "Race and class requirements").
const RACE = { Troll: 1.2, Iksar: 1.2, Ogre: 1.15, Barbarian: 1.05, Halfling: 0.95 };
const CLASS = { Warrior: 0.9, Rogue: 0.91 };
export const factor = (race, cls) => (RACE[race] ?? 1) * (CLASS[cls] ?? 1);

// Model rate (XP per hour per character) at each level: the mean of the band row's zones.
const bands = JSON.parse(readFileSync(join(here, "data/band-rotations.json"), "utf8")).sort((a, b) => b[0] - a[0]);
const cacheDir = join(here, "runs/jobs/plan-predict");
mkdirSync(cacheDir, { recursive: true });
async function modelRate(level) {
  const file = join(cacheDir, `${level}.json`);
  let rows;
  if (existsSync(file)) rows = JSON.parse(readFileSync(file, "utf8"));
  else {
    const run = Bun.spawnSync([process.execPath, join(here, "tools/predict.mjs"), "--level", String(level), "--json"], { cwd: here, stdout: "pipe", stderr: "pipe" });
    rows = JSON.parse(run.stdout.toString());
    await writeFile(file, JSON.stringify(rows.map((r) => ({ short: r.short, xph: r.xph }))));
  }
  const row = level <= 50 ? (bands.find(([from]) => from <= level)?.[1] ?? []) : [];
  const inRow = rows.filter((r) => row.includes(r.short)).map((r) => r.xph);
  const xph = inRow.length ? inRow : rows.map((r) => r.xph).sort((a, b) => b - a).slice(0, 3);
  return xph.length ? xph.reduce((a, b) => a + b, 0) / xph.length : null;
}

// Hours from (level, xp) to the start of `target` for a member with factor f. `c` is the group's
// calibration measured at `level`.
async function hoursTo(level, xp, f, c, target) {
  let hours = 0;
  for (let L = level; L < target; L++) {
    const need = (xpStart(L + 1) - Math.max(xpStart(L), L === level ? xp : 0)) * f;
    const cl = level >= 15 || L <= level + 5 ? c : 1;
    const rate = (await modelRate(L)) * cl;
    if (!(rate > 0)) return null;
    hours += need / rate;
  }
  return hours;
}
// Playing groups from the collector's database.
const db = new Database(join(here, "runs/iq.db"), { readonly: true });
const sessions = db.query("SELECT leader, snap FROM sessions WHERE ended IS NULL").all().map((r) => ({ leader: r.leader, snap: JSON.parse(r.snap ?? "{}") }));
const groups = [];
for (const { leader, snap } of sessions) {
  if (snap.bot?.enabled === false || !snap.autoLevel?.running) continue;
  const file = join(here, "runs/live", leader, "samples.jsonl");
  if (!existsSync(file)) continue;
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const now = rows.at(-1);
  const from = rows.find((r) => r.t >= now.t - windowMin * 60000 && r.ses === now.ses) ?? rows[0];
  const hours = (now.t - from.t) / 3600000;
  if (hours < 0.25) continue;
  const rateNow = (now.xp - from.xp) / hours;
  const members = [{ name: leader, race: snap.leader?.race, cls: snap.leader?.class }, ...(snap.party ?? []).filter((m) => m.type === 2).map((m) => ({ name: m.name, race: m.race, cls: m.class }))];
  const fLeader = factor(snap.leader?.race, snap.leader?.class);
  const slowest = members.reduce((a, m) => (factor(m.race, m.cls) > factor(a.race, a.cls) ? m : a), members[0]);
  // The leader's XP stands in for the group's progress through the level, in the slowest member's terms.
  const xpNow = xpStart(now.lvl) + ((now.xp / fLeader) - xpStart(now.lvl));
  const c = rateNow / (await modelRate(now.lvl));
  groups.push({ leader, level: now.lvl, xp: xpNow, rateNow, c, f: factor(slowest.race, slowest.cls), slowest: slowest.name, size: members.length, minutes: Math.round(hours * 60) });
}

const fmtH = (h) => (h == null ? "n/a" : h < 48 ? `${h.toFixed(0)} h` : `${(h / 24).toFixed(1)} d`);
const fmtR = (r) => (r >= 1e6 ? `${(r / 1e6).toFixed(2)}M` : `${Math.round(r / 1e3)}k`);
const lines = [];
const head = ["Group", "Level", "XP/h now", "Calib", "Slowest", ...targets.map((t) => `to ${t}`)];
lines.push(head);
for (const g of groups) {
  const etas = [];
  for (const t of targets) etas.push(fmtH(await hoursTo(g.level, g.xp, g.f, g.c, t)));
  lines.push([g.leader, `${g.level}`, fmtR(g.rateNow), g.c.toFixed(2), g.slowest, ...etas]);
}
if (newGroups > 0 && groups.length) {
  const cs = groups.map((g) => g.c).sort((a, b) => a - b);
  const c = cs[Math.floor(cs.length / 2)];
  const etas = [];
  for (const t of targets) etas.push(fmtH(await hoursTo(1, 0, 1.0, c, t)));
  lines.push([`${newGroups} new groups`, "1", "", c.toFixed(2), "factor 1.00", ...etas]);
}
const width = head.map((_, i) => Math.max(...lines.map((r) => String(r[i]).length)));
console.log(`Hours of play to the start of each level. Rates over the last ${windowMin} min, model tools/predict.mjs on the band rows.\n`);
for (const r of lines) console.log(r.map((c, i) => (i === 0 || i === 4 ? String(c).padEnd(width[i]) : String(c).padStart(width[i]))).join("  "));
