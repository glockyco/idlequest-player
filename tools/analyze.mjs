// Efficiency analysis of a recorded run.
//
//   bun tools/analyze.mjs <run dir> [--last 30m] [--since <ms epoch>] [--until <ms epoch>] [--json]
//
// Input is `samples.jsonl` and `events.jsonl` written by `exportRun` (src/client.mjs).
//
// Every second of play is placed in exactly one cell, with no assumption about causes:
//   combat                 in combat
//   move                   out of combat, position changed
//   recover                out of combat, still, someone below max HP or mana
//   ready-idle             out of combat, still, everyone full  (nothing explains this second yet)
// Time in `ready-idle` is attributed from the game's own messages seen in the same stretch.
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
if (!dir) {
  console.error("usage: bun tools/analyze.mjs <run dir> [--last 30m] [--since ms] [--until ms] [--label name] [--json]");
  process.exit(2);
}

const readJsonl = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
let samples = await readJsonl(`${dir}/samples.jsonl`);
let events = await readJsonl(`${dir}/events.jsonl`).catch(() => []);

const parseDuration = (s) => {
  const m = /^(\d+)(s|m|h)$/.exec(s ?? "");
  return m ? Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]] : null;
};
const end = opt("until") ? Number(opt("until")) : samples.at(-1)?.t;
const start = opt("since") ? Number(opt("since")) : opt("last") ? end - parseDuration(opt("last")) : samples[0]?.t;
samples = samples.filter((s) => s.t >= start && s.t <= end);
if (opt("label")) samples = samples.filter((s) => s.label === opt("label"));
events = events.filter((e) => e.t >= start - 2000 && e.t <= end + 2000);
if (samples.length < 2) {
  console.error("not enough samples in the selected window");
  process.exit(1);
}

const MOVE_EPS = 1.5; // world units per sample; standing characters do not drift
const GAP_MS = 3500; // gaps longer than this are not counted as play time
const full = (s) => s.party.every(([, hp, maxHp, mp, maxMp]) => hp >= maxHp && (!(maxMp > 0) || mp >= maxMp));
const notFull = (s) => s.party.filter(([, hp, maxHp, mp, maxMp]) => hp < maxHp || (maxMp > 0 && mp < maxMp));

const cells = { combat: 0, move: 0, recover: 0, "ready-idle": 0 };
let moveNotFull = 0; // move seconds during which someone was still below full HP/mana
let pathLen = 0; // distance covered outside combat, from position packets
const cellOf = [];
let covered = 0;
let xpSum = 0; // XP gained over covered seconds only, so label filters and gaps do not distort it
let coinSum = 0; // copper picked up over covered seconds
let coinSeen = false;
const coveredSec = new Set();
let stopped = 0; // seconds where AutoLevel was not running
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1];
  const b = samples[i];
  const dt = b.t - a.t;
  if (dt > GAP_MS) {
    cellOf.push(null);
    continue;
  }
  covered += dt;
  for (let s = Math.floor(a.t / 1000) + 1; s <= Math.floor(b.t / 1000); s++) coveredSec.add(s);
  if (a.xp != null && b.xp != null) xpSum += b.xp - a.xp;
  if (a.cp != null && b.cp != null) {
    coinSeen = true;
    if (b.cp > a.cp) coinSum += b.cp - a.cp;
  }
  if (!b.run) stopped += dt;
  // Position comes from the client's own position packets (null until the first one arrives).
  const moved = (b.pst != null && b.pst !== "idle") || (a.x != null && b.x != null && Math.hypot(b.x - a.x, b.y - a.y) > MOVE_EPS);
  const cell = b.combat ? "combat" : moved ? "move" : !full(b) ? "recover" : "ready-idle";
  cells[cell] += dt;
  if (cell === "move" && !full(b)) moveNotFull += dt;
  if (a.x != null && b.x != null && !b.combat) pathLen += Math.hypot(b.x - a.x, b.y - a.y);
  cellOf.push(cell);
}

// ---- Outcome ---------------------------------------------------------------------------------
const KILL = /^You have (?:defeated|slain) (.+?) and gained (\d+) experience/;
const kills = events.filter((e) => coveredSec.has(Math.floor(e.t / 1000))).flatMap((e) => {
  const m = KILL.exec(e.text);
  return m ? [{ t: e.t, enemy: m[1], xp: Number(m[2]) }] : [];
});
const xpGained = xpSum;
const mins = covered / 60000;

// ---- Recovery: which member is last to fill --------------------------------------------------
const limiter = {};
const recoverRuns = [];
for (let i = 0; i < cellOf.length; i++) {
  if (cellOf[i] !== "recover") continue;
  let j = i;
  while (j + 1 < cellOf.length && cellOf[j + 1] === "recover") j++;
  const secs = (samples[j + 1].t - samples[i].t) / 1000 + 1;
  // The limiter is whoever is still not full at the last second of the stretch.
  for (const [name, hp, maxHp, mp, maxMp] of notFull(samples[j + 1])) {
    const what = `${name}:${mp < maxMp ? "mana" : "hp"}`;
    limiter[what] = (limiter[what] ?? 0) + secs;
  }
  recoverRuns.push(secs);
  i = j;
}

// ---- Ready-idle: what the game said during those stretches -----------------------------------
const norm = (t) => t.replace(/\d+/g, "#").replace(/\b(a|an|the) [a-z ]+?(?= (is|has|misses|hits|tries|regards)\b)/gi, "<mob>");
const idleRuns = [];
const idleText = {};
for (let i = 0; i < cellOf.length; i++) {
  if (cellOf[i] !== "ready-idle") continue;
  let j = i;
  while (j + 1 < cellOf.length && cellOf[j + 1] === "ready-idle") j++;
  const t0 = samples[i].t;
  const t1 = samples[j + 1].t;
  const secs = (t1 - t0) / 1000 + 1;
  idleRuns.push(secs);
  // Only messages strictly inside the stretch: a wider window pulls in neighbouring fights.
  const seen = new Set(events.filter((e) => e.t > t0 && e.t < t1).map((e) => norm(e.text)));
  for (const t of seen) idleText[t] = (idleText[t] ?? 0) + secs;
  i = j;
}

const pct = (x) => `${((100 * x) / covered).toFixed(1)}%`;
const sec = (x) => `${(x / 1000).toFixed(0)}s`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);

const result = {
  window: { from: new Date(samples[0].t).toISOString(), to: new Date(samples.at(-1).t).toISOString(), coveredMin: +mins.toFixed(1), stoppedSec: Math.round(stopped / 1000) },
  levels: [samples[0].lvl, samples.at(-1).lvl],
  config: { zone: samples.at(-1).zone, minCon: samples.at(-1).minCon, maxCon: samples.at(-1).maxCon, aggr: samples.at(-1).aggr },
  outcome: {
    xpPerHour: Math.round((xpGained / mins) * 60),
    // Gross coin picked up (purchases are not subtracted), in platinum per hour. Null before samples carried coin.
    platPerHour: coinSeen ? +(coinSum / 1000 / (mins / 60)).toFixed(1) : null,
    killsPerMin: +(kills.length / mins).toFixed(2),
    xpPerKill: kills.length ? Math.round(mean(kills.map((k) => k.xp))) : 0,
    // XP per minute if every idle second were removed: the ceiling for pure efficiency work.
    xpPerHourIfNoDowntime: cells.combat ? Math.round(((xpGained / (cells.combat / 60000)) * 60) / 1) : null,
  },
  timeShare: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, { sec: Math.round(v / 1000), share: +(v / covered).toFixed(3) }])),
  movement: { moveWhileNotFullSec: Math.round(moveNotFull / 1000), pathUnits: Math.round(pathLen), unitsPerKill: kills.length ? Math.round(pathLen / kills.length) : null, unitsPerSecWhileMoving: cells.move ? +(pathLen / (cells.move / 1000)).toFixed(1) : null },
  recover: { stretches: recoverRuns.length, meanSec: +mean(recoverRuns).toFixed(1), limiterSeconds: Object.fromEntries(top(limiter, 6).map(([k, v]) => [k, Math.round(v)])) },
  readyIdle: { stretches: idleRuns.length, meanSec: +mean(idleRuns).toFixed(1), maxSec: Math.max(0, ...idleRuns), messagesDuringIdleSeconds: Object.fromEntries(top(idleText, 8).map(([k, v]) => [k, Math.round(v)])) },
  byEnemy: Object.fromEntries(
    top(
      kills.reduce((o, k) => ((o[k.enemy] = (o[k.enemy] ?? 0) + 1), o), {}),
      12,
    ).map(([name, n]) => [name, { kills: n, avgXp: Math.round(mean(kills.filter((k) => k.enemy === name).map((k) => k.xp))) }]),
  ),
};

if (args.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const r = result;
  console.log(`Window ${r.window.from} .. ${r.window.to}  (${r.window.coveredMin} min covered, AutoLevel stopped ${r.window.stoppedSec}s)`);
  console.log(`Level ${r.levels[0]} -> ${r.levels[1]}   zone ${r.config.zone}  con ${r.config.minCon}..${r.config.maxCon}  companion aggression ${r.config.aggr}`);
  console.log(`\nOutcome   XP/h ${r.outcome.xpPerHour}   kills/min ${r.outcome.killsPerMin}   XP/kill ${r.outcome.xpPerKill}   XP/h with zero downtime ${r.outcome.xpPerHourIfNoDowntime}   coin gained ${r.outcome.platPerHour ?? "n/a"} pp/h`);
  console.log("\nWhere the time goes");
  for (const [k, v] of Object.entries(cells)) console.log(`  ${k.padEnd(11)} ${sec(v).padStart(6)}  ${pct(v).padStart(6)}`);
  console.log(`  of the move time, ${sec(moveNotFull)} (${((100 * moveNotFull) / Math.max(cells.move, 1)).toFixed(0)}%) overlapped with someone still below full; path ${r.movement.pathUnits} units, ${r.movement.unitsPerKill} per kill, ${r.movement.unitsPerSecWhileMoving} units/s while moving`);
  console.log(`\nRecovery  ${r.recover.stretches} stretches, mean ${r.recover.meanSec}s. Last member still not full, by seconds:`);
  for (const [k, v] of Object.entries(r.recover.limiterSeconds)) console.log(`  ${k.padEnd(16)} ${v}s`);
  console.log(`\nReady-idle  ${r.readyIdle.stretches} stretches, mean ${r.readyIdle.meanSec}s, longest ${r.readyIdle.maxSec}s. Messages seen during those stretches (seconds):`);
  for (const [k, v] of Object.entries(r.readyIdle.messagesDuringIdleSeconds)) console.log(`  ${String(v).padStart(5)}  ${k.slice(0, 110)}`);
  console.log("\nBy enemy");
  for (const [k, v] of Object.entries(r.byEnemy)) console.log(`  ${k.padEnd(28)} ${String(v.kills).padStart(4)} kills  ${String(v.avgXp).padStart(5)} XP`);
}
