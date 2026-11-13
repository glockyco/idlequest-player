#!/usr/bin/env bun
// When each group reaches the levels raids ask for, from the live state and the XP model.
//
//   bun tools/plan.mjs [--window 60] [--levels 46,50,55,60] [--new-groups 6] [--json]
//                      [--stone-xp-h 300000 | Leader=300000,Leader=0] [--deaths-h 0.5] [--crowd N]
//
// Inputs:
//   runs/iq.db                   playing groups: the leader and the account characters in its party
//                                (tools/iqd.mjs keeps it)
//   runs/live/<leader>/*.jsonl   the leader's XP over its last --window minutes of AutoLevel, which gives the group's XP per
//                                hour now, and its deaths, XP losses and lightstone hand-ins in that window
//   tools/predict.mjs            XP per hour at each level for the zones of that level's band row
//                                (data/band-rotations.json), with the group's AutoLevel limits and the other
//                                groups in its zone
// A group's rate at a future level is the model's rate there times the group's calibration: its measured
// rate now over the model's rate at its current level. The measured rate is the kill XP, so death losses and
// hand-ins in the window are put back, and the kill XP of an XP event (tools/lib/xp-events.mjs, the
// collector's meta key `xpEvents`) counts at its normal worth, because the levels ahead mostly come after it.
// The model is fitted to group 1 (tools/calibrate.mjs), the other groups
// deal less, so a calibration measured below level 15 holds up to five levels above the current one and then
// fades to 1.00 at --fade-level (default 20), where the groups have the gear the model assumes. Above level 50
// no band row exists, so the model rate is the mean of the three best zones.
// Members at the same level earn the same XP per kill, so the member whose race and class need the most XP sets
// the group's time to a level, and the leader, who alone loses XP in a death, sets it when that takes longer.
// Terms that are not in the model:
//   --stone-xp-h   XP per hour per character from lightstone hand-ins (274,400 for a Greater Lightstone, 137,200
//                  for a Lightstone), added at every level. A bare number applies to every group, Leader=N to one.
//   deaths         the leader's deaths per hour lose level^2 x 666.67 XP from level 5 (companions lose none).
//                  The default per level band is what tools/fights.mjs measured (1.0 per hour up to level 4,
//                  0.4 to level 8, none above), --deaths-h sets one rate for every level.
//   --crowd N      other groups of the account in each zone at the levels ahead, counting for half a group
//                  each. The default is the crowd the group has now.
// Each ETA carries a range and a word. The range is the ETA at rates one standard deviation lower and higher, where
// the deviation combines the error of the group's own rate (the spread of its ten-minute blocks in the window)
// and the model's error at the levels the ETA passes through (MODEL_ERROR, from tools/calibrate.mjs). "firm" is a
// deviation under 15%, "rough" under 30%, "guess" above.
// Hours are hours of play. The tool knows nothing about zone changes, trips or gear.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conLimits, cfgFromFlags, evalZone, loadZones } from "./predict.mjs";
import { factor, xpStart } from "./lib/xp.mjs";
import { xpStep } from "./lib/samples.mjs";
import { normalXp } from "./lib/xp-events.mjs";
import { lastJsonl, readJsonlSince } from "./lib/jsonl.mjs";

const here = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const windowMin = Number(opt("window", 60));
const targets = String(opt("levels", "46,50,55,60")).split(",").map(Number);
const newGroups = Number(opt("new-groups", 0));
const fadeLevel = Number(opt("fade-level", 20));
const deathsFlag = opt("deaths-h") === undefined ? null : Number(opt("deaths-h"));
const crowdFlag = opt("crowd") === undefined ? null : Number(opt("crowd"));
const CROWD_WEIGHT = 0.5; // tools/calibrate.mjs: a group in the same zone takes about half a group's share of the spawns
const stoneFlag = String(opt("stone-xp-h", "0"));
const stoneOf = (leader) => {
  if (!stoneFlag.includes("=")) return Number(stoneFlag);
  const map = new Map(stoneFlag.split(",").map((p) => p.split("=")));
  return Number(map.get(leader) ?? map.get("*") ?? 0);
};

// A death costs level^2 x 666.67 XP from level 5 (the client's DeathExperienceLoss, leader only).
const deathXp = (L) => (L >= 5 ? L * L * 666.67 : 0);
// Leader deaths per hour by leader level, tools/fights.mjs "leader deaths/h" per band.
const deathsPerHour = (L) => deathsFlag ?? (L <= 4 ? 1.0 : L <= 8 ? 0.4 : 0);
// Typical error of the model's XP per hour, as ln(1 + the typical error of bun tools/calibrate.mjs --compare), per
// leader level up to the key. The levels 1 to 14 hold groups 2 to 12 and 11 to 14 is mostly Crushbone, where the
// model is twice as fast as group 1 was. Group 1's levels 15 to 39 are the only data above 14, and nothing exists
// above 39, so 40 to 50 is a guess at 0.3 and the levels above 50, which have no band row, at 0.5.
const MODEL_ERROR = [
  [3, 0.48],
  [6, 0.31],
  [10, 0.29],
  [14, 0.6],
  [24, 0.11],
  [34, 0.25],
  [39, 0.13],
  [50, 0.3],
  [Infinity, 0.5],
];
const modelError = (L) => MODEL_ERROR.find(([to]) => L <= to)[1];

// Model rate (XP per hour per character) at each level: the mean of the band row's zones.
const bands = JSON.parse(readFileSync(join(here, "data/band-rotations.json"), "utf8")).sort((a, b) => b[0] - a[0]);
const zones = await loadZones();
const modelCache = new Map();
function modelRate(level, con, crowd) {
  const key = `${level}|${con}|${crowd}`;
  if (modelCache.has(key)) return modelCache.get(key);
  const [minCon, maxCon] = con.split("-").map(Number);
  const cfg = { ...cfgFromFlags(level), ...conLimits(level, minCon, maxCon), crowd };
  const row = level <= 50 ? (bands.find(([from]) => from <= level)?.[1] ?? []) : [];
  const all = [...zones.values()].map((z) => ({ short: z.short, xph: evalZone(z, cfg).xph })).filter((r) => r.xph > 0);
  const inRow = all.filter((r) => row.includes(r.short)).map((r) => r.xph);
  const xph = inRow.length ? inRow : all.map((r) => r.xph).sort((a, b) => b - a).slice(0, 3);
  const v = xph.length ? xph.reduce((a, b) => a + b, 0) / xph.length : null;
  modelCache.set(key, v);
  return v;
}

// Calibration at level L: the group's own factor up to five levels above where it was measured (below level 15),
// fading to 1.00 at fadeLevel.
const calibrationAt = (g, L) => {
  if (g.level >= 15 || L <= g.level + 5) return g.c;
  if (L >= fadeLevel) return 1;
  return g.c + ((1 - g.c) * (L - (g.level + 5))) / Math.max(1, fadeLevel - (g.level + 5));
};
// Where the group is now (up to five levels ahead) the model gets its AutoLevel limits and crowd, beyond that the
// limits G1 ran at levels 15 to 39 (Blue to Red) and no crowd unless --crowd says so.
const rateAt = (g, L) => {
  const near = L <= g.level + 5;
  const m = modelRate(L, near ? g.con : "4-13", crowdFlag ?? (near ? g.crowdNow : 0));
  return m == null ? null : m * calibrationAt(g, L) + g.stone;
};

// Hours per level from (level, xp) to the start of `target` for a member with factor f. The leader's XP also
// falls by its deaths.
function legs(g, f, target, leader) {
  const out = [];
  for (let L = g.level; L < target; L++) {
    const need = (xpStart(L + 1) - Math.max(xpStart(L), L === g.level ? g.xp : 0)) * f;
    const gross = rateAt(g, L);
    if (gross == null) return null;
    const rate = gross - (leader ? deathsPerHour(L) * deathXp(L) : 0);
    if (!(rate > 0)) return null;
    out.push({ L, hours: need / rate });
  }
  return out;
}
// The ETA, its range and how certain it is.
function eta(g, target) {
  const slow = legs(g, g.f, target, g.slowest === g.leader);
  const lead = legs(g, g.fLeader, target, true);
  if (!slow || !lead) return null;
  const parts = slow.map((s, i) => ({ L: s.L, hours: Math.max(s.hours, lead[i].hours) }));
  const hours = parts.reduce((a, p) => a + p.hours, 0);
  // Model errors of different level bands are independent, the errors inside a band and the group's own are shared.
  const byBand = new Map();
  for (const p of parts) byBand.set(modelError(p.L), (byBand.get(modelError(p.L)) ?? 0) + p.hours);
  let v = g.sigma ** 2;
  for (const [s, h] of byBand) v += ((s * h) / hours) ** 2;
  const sigma = Math.sqrt(v);
  return { hours, low: hours * Math.exp(-sigma), high: hours * Math.exp(sigma), sigma };
}

// Playing groups from the collector's database.
const db = new Database(join(here, "runs/iq.db"), { readonly: true });
const xpEvents = JSON.parse(db.query("SELECT v FROM meta WHERE k = 'xpEvents'").get()?.v ?? "null");
const sessions = db.query("SELECT leader, snap FROM sessions WHERE ended IS NULL").all().map((r) => ({ leader: r.leader, snap: JSON.parse(r.snap ?? "{}") }));
const playing = sessions.filter(({ snap }) => snap.bot?.enabled !== false && snap.autoLevel?.running);
// The logs are read from where the window starts (tools/lib/jsonl.mjs): the samples of the last
// six hours, which is as far back as the window looks, and the events since the window's start.
const groups = [];
const idle = []; // playing groups with under 15 minutes of AutoLevel in the last 6 hours
for (const { leader, snap } of playing) {
  const file = join(here, "runs/live", leader, "samples.jsonl");
  if (!existsSync(file)) continue;
  const now = lastJsonl(file);
  if (!now) continue;
  const rows = readJsonlSince(file, now.t - 6 * 3600000);
  // The last --window minutes of AutoLevel played by the leader itself, looking back up to 6 hours. The collector's
  // samples follow the active character, which changes during lightstone trips and other errands, and errands run
  // other modes. Only pairs of samples at the leader's level or one below count.
  const leaderLevel = snap.leader?.level ?? now.lvl;
  let secs = 0;
  let kill = 0;
  let lost = 0;
  let stone = 0;
  let net = 0;
  let fromT = now.t;
  const blockRates = [];
  let block = { secs: 0, kill: 0 };
  for (let i = rows.length - 1; i >= 1 && secs < windowMin * 60 && rows[i].t > now.t - 6 * 3600000; i--) {
    const a = rows[i - 1];
    const b = rows[i];
    const dxp = xpStep(a, b);
    if (b.t - a.t > 3500 || a.lvl !== b.lvl || (b.lvl !== leaderLevel && b.lvl !== leaderLevel - 1) || a.ses !== b.ses || a.mode !== "auto-level" || b.mode !== "auto-level" || dxp == null) continue;
    const dt = (b.t - a.t) / 1000;
    fromT = a.t;
    secs += dt;
    net += dxp;
    block.secs += dt;
    if (dxp < 0) lost -= dxp;
    else if (dxp >= 137200 && dxp % 137200 === 0) stone += dxp;
    else {
      kill += normalXp(xpEvents, dxp, b.t);
      block.kill += normalXp(xpEvents, dxp, b.t);
    }
    if (block.secs >= 600) {
      blockRates.push((block.kill * 3600) / block.secs);
      block = { secs: 0, kill: 0 };
    }
  }
  const hours = secs / 3600;
  if (hours < 0.25) {
    idle.push(leader);
    continue;
  }
  let deaths = 0;
  const evFile = join(here, "runs/live", leader, "events.jsonl");
  if (existsSync(evFile)) deaths = readJsonlSince(evFile, fromT).filter((e) => e.t <= now.t && e.type === "DEATH" && /^You have been slain/.test(e.text)).length;
  const rateNow = net / hours;
  const killRate = kill / hours;
  // The group's own rate noise: the spread of the ten-minute blocks of kill XP in the window.
  const lnb = blockRates.filter((x) => x > 0).map(Math.log);
  const mean = lnb.reduce((a, b) => a + b, 0) / (lnb.length || 1);
  const sd = Math.sqrt(lnb.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lnb.length - 1));
  // Below level 15 the calibration is carried to higher levels on an assumption (it fades to 1.00), worth 0.2.
  const sigma = Math.sqrt(Math.max(0.05, lnb.length >= 3 ? sd / Math.sqrt(lnb.length) : 0.3) ** 2 + (leaderLevel < 15 ? 0.2 ** 2 : 0));
  const members = [{ name: leader, race: snap.leader?.race, cls: snap.leader?.class }, ...(snap.party ?? []).filter((m) => m.type === 2).map((m) => ({ name: m.name, race: m.race, cls: m.class }))];
  const fLeader = factor(snap.leader?.race, snap.leader?.class);
  const slowest = members.reduce((a, m) => (factor(m.race, m.cls) > factor(a.race, a.cls) ? m : a), members[0]);
  groups.push({ leader, zone: snap.zone, level: leaderLevel, xp: (snap.leader?.xp ?? now.xp) / fLeader, rateNow, killRate, deaths: deaths / ((now.t - fromT) / 3600000), fLeader, f: factor(slowest.race, slowest.cls), slowest: slowest.name, size: members.length, minutes: Math.round(hours * 60), sigma, con: `${snap.autoLevel?.minCon ?? 4}-${snap.autoLevel?.maxCon ?? 13}`, stone: stoneOf(leader) });
}
// Crowd: other playing groups in the same zone, now and ahead.
for (const g of groups) {
  const now = playing.filter(({ snap, leader }) => leader !== g.leader && snap.zone === g.zone).length * CROWD_WEIGHT;
  g.crowdNow = now;
  g.c = g.killRate / modelRate(g.level, g.con, now);
}

const fmtH = (h) => (h == null ? "n/a" : h < 48 ? `${h.toFixed(0)} h` : `${(h / 24).toFixed(1)} d`);
const fmtR = (r) => (r >= 1e6 ? `${(r / 1e6).toFixed(2)}M` : `${Math.round(r / 1e3)}k`);
const word = (s) => (s < 0.15 ? "firm" : s < 0.3 ? "rough" : "guess");
const cell = (e) => (e ? `${fmtH(e.hours)} (${fmtH(e.low)}-${fmtH(e.high)}) ${word(e.sigma)}` : "n/a");
if (args.includes("--json")) {
  const rows = groups.map((g) => ({ leader: g.leader, level: g.level, rateNow: g.rateNow, calibration: g.c, deathsPerHour: g.deaths, slowest: g.slowest, eta: Object.fromEntries(targets.map((t) => [t, eta(g, t)])) }));
  console.log(JSON.stringify({ windowMin, targets, groups: rows, idle }));
  process.exit(0);
}
const lines = [];
const head = ["Group", "Level", "XP/h now", "Calib", "Deaths/h", "Slowest", ...targets.map((t) => `to ${t}`)];
lines.push(head);
for (const g of groups) lines.push([g.leader, `${g.level}`, fmtR(g.rateNow), g.c.toFixed(2), g.deaths.toFixed(1), g.slowest, ...targets.map((t) => cell(eta(g, t)))]);
if (newGroups > 0 && groups.length) {
  const cs = groups.map((g) => g.c).sort((a, b) => a - b);
  const c = cs[Math.floor(cs.length / 2)];
  const g = { leader: "new", level: 1, xp: 0, f: 1, fLeader: 1, slowest: "new", c, con: "10-13", crowdNow: 0, stone: stoneOf("new"), sigma: 0.3 };
  lines.push([`${newGroups} new groups`, "1", "", c.toFixed(2), "", "factor 1.00", ...targets.map((t) => cell(eta(g, t)))]);
}
const width = head.map((_, i) => Math.max(...lines.map((r) => String(r[i]).length)));
console.log(`Hours of play to the start of each level, with the range at one standard deviation and how certain it is. Rates over the last ${windowMin} min of AutoLevel, model tools/predict.mjs on the band rows.\n`);
for (const r of lines) console.log(r.map((c, i) => (i === 0 || i === 5 ? String(c).padEnd(width[i]) : String(c).padStart(width[i]))).join("  "));
const notes = [];
if (stoneFlag !== "0") notes.push(`Lightstone hand-ins add ${stoneFlag.includes("=") ? stoneFlag : `${Number(stoneFlag).toLocaleString("en-US")} XP per hour per character`} at every level.`);
if (deathsFlag != null) notes.push(`Leader deaths: ${deathsFlag} per hour at every level.`);
notes.push(`Calibration is measured at the current level and fades to 1.00 at level ${fadeLevel}. Crowd: ${crowdFlag ?? "each group's crowd now for five levels, none beyond"}.`);
if (idle.length) notes.push(`No ETA for ${idle.join(", ")}: under 15 minutes of AutoLevel in the last 6 hours.`);
console.log(`\n${notes.join(" ")}`);
