#!/usr/bin/env bun
// Two-period crossover across groups: arm A runs a setting in the first block and without it in the
// second, arm B the other way round. Each group is compared with itself, so differences between
// groups (class mix, zone, level) cancel, and the period effect (groups level up, zones fill)
// cancels between the arms. Per group it reports XP per hour, escapes and deaths in both blocks
// from tools/groups.mjs, then the setting's effect:
//   XP per hour: exp(mean over A of ln(P1/P2) - mean over B of ln(P1/P2)) / 2 as a ratio, because
//   XP per hour grows with level and a ratio keeps fast and slow groups on one scale.
//   Escapes and deaths per hour: (mean over A of P1-P2 - mean over B of P1-P2) / 2.
// The interval is the effect plus or minus two standard errors of the two arms' means.
//
//   bun tools/crossover.mjs --start <ms> --block 45 --a G2,G4,G6 --b G3,G5,G7 [--label fightingOnly]
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({ options: { start: { type: "string" }, block: { type: "string", default: "45" }, a: { type: "string" }, b: { type: "string" }, label: { type: "string", default: "setting" } } });
if (!opt.start || !opt.a || !opt.b) throw new Error("usage: crossover.mjs --start <ms> --block <min> --a G2,G4 --b G3,G5 [--label name]");
const REPO = new URL("..", import.meta.url).pathname;
const start = Number(opt.start);
const block = Number(opt.block) * 60000;
const arms = { A: opt.a.split(","), B: opt.b.split(",") };

async function period(since, until) {
  const proc = Bun.spawn(["bun", `${REPO}tools/groups.mjs`, "--since", String(since), "--until", String(until), "--json"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return new Map(JSON.parse(out).map((r) => [r.group, r]));
}
if (Date.now() < start + 2 * block) console.log(`Second block ends ${new Date(start + 2 * block).toTimeString().slice(0, 8)}; the numbers below are partial.`);
const [p1, p2] = await Promise.all([period(start, start + block), period(start + block, Math.min(Date.now(), start + 2 * block))]);
const hours = [block / 3600000, Math.max(1, Math.min(Date.now(), start + 2 * block) - start - block) / 3600000];

const rows = [];
for (const [arm, ids] of Object.entries(arms)) {
  for (const id of ids) {
    const a = p1.get(id);
    const b = p2.get(id);
    if (!a || !b) continue;
    rows.push({ arm, id, leader: a.leader, level: `${a.level ?? "?"}`, xp: [a.xpPerHour, b.xpPerHour], esc: [a.escapes / hours[0], b.escapes / hours[1]], dead: [a.deaths / hours[0], b.deaths / hours[1]] });
  }
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const se = (xs) => (xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length) : NaN);
function effect(diff) {
  const d = { A: rows.filter((r) => r.arm === "A").map(diff).filter(Number.isFinite), B: rows.filter((r) => r.arm === "B").map(diff).filter(Number.isFinite) };
  if (!d.A.length || !d.B.length) return null;
  const est = (mean(d.A) - mean(d.B)) / 2;
  const err = Math.sqrt(se(d.A) ** 2 + se(d.B) ** 2) / 2;
  return { est, lo: est - 2 * err, hi: est + 2 * err, n: d.A.length + d.B.length };
}

const k = (n) => (n == null ? "-" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "-");
console.log(`${opt.label}: arm A on in block 1 (${new Date(start).toTimeString().slice(0, 5)}), arm B on in block 2 (${new Date(start + block).toTimeString().slice(0, 5)}), ${opt.block} min each`);
console.log("arm group leader        lvl  XP/h block1 block2   esc/h b1   b2  dead/h b1   b2");
for (const r of rows) console.log(`${r.arm}   ${r.id.padEnd(5)} ${r.leader.padEnd(13)} ${r.level.padStart(3)}  ${k(r.xp[0]).padStart(12)} ${k(r.xp[1]).padStart(6)}  ${f1(r.esc[0]).padStart(9)} ${f1(r.esc[1]).padStart(4)}  ${f1(r.dead[0]).padStart(9)} ${f1(r.dead[1]).padStart(4)}`);
const xp = effect((r) => Math.log(r.xp[0] / r.xp[1]));
const esc = effect((r) => r.esc[0] - r.esc[1]);
const dead = effect((r) => r.dead[0] - r.dead[1]);
const pct = (x) => `${x >= 0 ? "+" : ""}${Math.round(100 * (Math.exp(x) - 1))}%`;
if (xp) console.log(`\nXP per hour with ${opt.label}: ${pct(xp.est)} (${pct(xp.lo)} to ${pct(xp.hi)}), ${xp.n} groups`);
if (esc) console.log(`Escapes per hour with ${opt.label}: ${esc.est >= 0 ? "+" : ""}${esc.est.toFixed(1)} (${esc.lo.toFixed(1)} to ${esc.hi.toFixed(1)})`);
if (dead) console.log(`Deaths per hour with ${opt.label}: ${dead.est >= 0 ? "+" : ""}${dead.est.toFixed(1)} (${dead.lo.toFixed(1)} to ${dead.hi.toFixed(1)})`);
