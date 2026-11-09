#!/usr/bin/env bun
// Crossover across groups in alternating blocks: arm A runs a setting in even blocks and without it
// in odd ones, arm B the other way round. Each group is compared with itself, so differences between
// groups (class mix, zone, level) cancel, more blocks cancel a group's slow drifts (level-ups, zone
// changes), and the period effect cancels between the arms. Per group it reports XP per hour,
// escapes and deaths with the setting on and off, then the setting's effect:
//   XP per hour: exp of the mean over both arms of each group's mean ln(XP per hour) on less off,
//   as a ratio, because XP per hour grows with level and a ratio keeps fast and slow groups on one
//   scale. It counts the minute totals without the minutes a task ran in, so hunts, quests and
//   gear moves can run during an experiment without moving its numbers.
//   Escapes and deaths per hour: the same mean of on less off, from tools/groups.mjs.
// The interval is the effect plus or minus two standard errors of the two arms' means.
//
//   bun tools/crossover.mjs --start <ms> --block 45 [--blocks 2] --a G2,G4,G6 --b G3,G5,G7 [--label fightingOnly]
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({ options: { start: { type: "string" }, block: { type: "string", default: "45" }, blocks: { type: "string", default: "2" }, a: { type: "string" }, b: { type: "string" }, label: { type: "string", default: "setting" } } });
if (!opt.start || !opt.a || !opt.b) throw new Error("usage: crossover.mjs --start <ms> --block <min> [--blocks N] --a G2,G4 --b G3,G5 [--label name]");
const REPO = new URL("..", import.meta.url).pathname;
const start = Number(opt.start);
const block = Number(opt.block) * 60000;
const blocks = Number(opt.blocks);
const arms = { A: opt.a.split(","), B: opt.b.split(",") };

const db = new Database(`${REPO}runs/iq.db`, { readonly: true });
// A group's XP per hour over the minutes of [since, until) without a task in them.
function huntingRate(group, since, until) {
  let xp = 0;
  let sec = 0;
  for (const m of db.query("SELECT sec, xp FROM minutes WHERE grp = ? AND minute >= ? AND minute < ?").all(group, Math.floor(since / 60000), Math.floor(until / 60000))) {
    const s = JSON.parse(m.sec);
    if (s.task > 0) continue;
    xp += m.xp;
    sec += Object.values(s).reduce((a, b) => a + b, 0);
  }
  return sec > 0 ? (3600 * xp) / sec : null;
}

async function period(since, until) {
  const proc = Bun.spawn(["bun", `${REPO}tools/groups.mjs`, "--since", String(since), "--until", String(until), "--json"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const hours = (until - since) / 3600000;
  return new Map(JSON.parse(out).map((r) => [r.group, { ...r, xpPerHour: huntingRate(r.group, since, until), escH: r.escapes / hours, deadH: r.deaths / hours, leadH: r.leaderDeaths / hours }]));
}
const end = start + blocks * block;
if (Date.now() < end) console.log(`The last block ends ${new Date(end).toTimeString().slice(0, 8)}; the numbers below are partial.`);
const spans = Array.from({ length: blocks }, (_, k) => [start + k * block, Math.min(Date.now(), start + (k + 1) * block)]).filter(([a, b]) => b - a >= 60000);
const periods = await Promise.all(spans.map(([a, b]) => period(a, b)));

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const se = (xs) => (xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length) : NaN);
// Arm A has the setting in even blocks, arm B in odd ones.
const on = (arm, k) => (k % 2 === 0) === (arm === "A");
const rows = [];
for (const [arm, ids] of Object.entries(arms)) {
  for (const id of ids) {
    const seen = periods.map((p, k) => ({ k, r: p.get(id) })).filter((x) => x.r);
    const side = (yes, f) => seen.filter((x) => on(arm, x.k) === yes).map((x) => f(x.r)).filter(Number.isFinite);
    const both = (f) => [mean(side(true, f)), mean(side(false, f))];
    rows.push({ arm, id, leader: seen[0]?.r.leader ?? "?", level: `${seen[0]?.r.level ?? "?"}`, lnXp: both((r) => (r.xpPerHour > 0 ? Math.log(r.xpPerHour) : NaN)), esc: both((r) => r.escH), dead: both((r) => r.deadH), lead: both((r) => r.leadH) });
  }
}
function effect(f) {
  const d = { A: rows.filter((r) => r.arm === "A").map((r) => f(r)[0] - f(r)[1]).filter(Number.isFinite), B: rows.filter((r) => r.arm === "B").map((r) => f(r)[0] - f(r)[1]).filter(Number.isFinite) };
  if (!d.A.length || !d.B.length) return null;
  const est = (mean(d.A) + mean(d.B)) / 2;
  const err = Math.sqrt(se(d.A) ** 2 + se(d.B) ** 2) / 2;
  return { est, lo: est - 2 * err, hi: est + 2 * err, n: d.A.length + d.B.length };
}

const k = (n) => (!Number.isFinite(n) ? "-" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "-");
console.log(`${opt.label}: ${blocks} blocks of ${opt.block} min from ${new Date(start).toTimeString().slice(0, 5)}, arm A on in blocks 1, 3, ..., arm B in blocks 2, 4, ...`);
console.log("arm group leader        lvl     XP/h on    off   esc/h on  off  dead/h on  off  leader on  off");
for (const r of rows) console.log(`${r.arm}   ${r.id.padEnd(5)} ${r.leader.padEnd(13)} ${r.level.padStart(3)}  ${k(Math.exp(r.lnXp[0])).padStart(10)} ${k(Math.exp(r.lnXp[1])).padStart(6)}  ${f1(r.esc[0]).padStart(9)} ${f1(r.esc[1]).padStart(4)}  ${f1(r.dead[0]).padStart(9)} ${f1(r.dead[1]).padStart(4)}  ${f1(r.lead[0]).padStart(9)} ${f1(r.lead[1]).padStart(4)}`);
const xp = effect((r) => r.lnXp);
const pct = (x) => `${x >= 0 ? "+" : ""}${Math.round(100 * (Math.exp(x) - 1))}%`;
if (xp) console.log(`\nXP per hour with ${opt.label}: ${pct(xp.est)} (${pct(xp.lo)} to ${pct(xp.hi)}), ${xp.n} groups`);
for (const [what, f, digits] of [["Escapes", (r) => r.esc, 1], ["Deaths", (r) => r.dead, 1], ["Leader deaths", (r) => r.lead, 2]]) {
  const e = effect(f);
  if (e) console.log(`${what} per hour with ${opt.label}: ${e.est >= 0 ? "+" : ""}${e.est.toFixed(digits)} (${e.lo.toFixed(digits)} to ${e.hi.toFixed(digits)})`);
}
