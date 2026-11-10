#!/usr/bin/env bun
// How far tools/predict.mjs is from the live runs, per stretch, level band and zone.
//
//   bun tools/calibrate.mjs [--min 20] [--rows] [--shares] [--compare] [--fit] [--json] [--leaders A,B] [--dps ..] [...]
//
//   (default)  per level band and zone: measured over model XP per hour, kills per hour, XP per kill, the cycle term
//              that explains the gap, and escapes and deaths. A * after the stretch count marks fewer than 2 hours.
//   --rows     one line per stretch
//   --shares   time shares per level band: fight, move, recover, idle and off measured, kill, walk, recovery and
//              overhead in the model
//   --compare  the model before the refit (--baseline: no depletion of spawn points, no damage curve, no group
//              factor) against the model now, per band: measured over model and the typical error
//   --fit      refits the damage curve, the walking detour and the factor of groups 2 to 12, see below
//   --json     everything above as JSON
//
// Input is runs/live/<leader>/samples.jsonl and events.jsonl of every group in data/roster.json (written by
// tools/iqd.mjs), and for the first group its earlier runs in runs/2026-11-06-tox-ab, 2026-11-07-live and
// 2026-11-08-lead (levels 3 to 34, merged by session and sequence, --no-history leaves them out). A stretch is one
// zone at one leader level with at least --min minutes (default 20) of covered play. A visit to another zone of at
// most --hop seconds (default 180, a vendor trip or an escape) does not end it, and its time is left out.
// Predict's own flags (--dps, --overhead, --speed ...) apply to the model. --crowd-weight (default 0.5) is how
// much of a group the other account groups in the same zone count for, --no-crowd leaves them out.
//
// Per stretch the model is tools/predict.mjs for the zone and the leader's level, with the level range the
// stretch's AutoLevel limits give (minCon and maxCon of the samples), the characters' levels and --stay set to
// the stretch length. Measured against it:
//   XP/h     the leader's kill XP over covered time (the kill lines of the events, so lightstone hand-ins and
//            death losses are not in it). Stretches whose kill lines do not add up to the XP counter are left out.
//   cycle    covered seconds per kill, split like tools/analyze.mjs: fight (combat), move, recover (out of
//            combat, still, someone below full HP or mana) and idle (everyone full and still, plus the seconds
//            AutoLevel was off). The model's terms are kill, walk, recovery and overhead.
// The aggregate ratio is measured XP over model XP, summed over the same hours. It splits into the ratio of kills
// per hour and the ratio of XP per kill. The gap is explained by "mix" when XP per kill differs more than kills
// per hour do, else by the cycle term whose seconds per kill differ most from the model in the direction of the
// gap, and by "spawns" when the model is held back by its spawn limit.
import { readFile } from "node:fs/promises";
import { DEFAULTS, cfgFromFlags, conLimits, evalZone, loadZones } from "./predict.mjs";
import { ESCAPE_END, ESCAPE_START } from "./lib/guard-log.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const opt = (n, d) => (has(n) ? args[args.indexOf(`--${n}`) + 1] : d);
const MIN_SECS = Number(opt("min", 20)) * 60;
const HOP = Number(opt("hop", 180)) * 1000;
const GAP_MS = 3500; // gaps longer than this are not play time (tools/analyze.mjs)
const RUN_GAP = 300000; // a hole this long ends a stretch
const MOVE_EPS = 1.5;
const REPO = new URL("..", import.meta.url).pathname;
export const BANDS = [
  [1, 3],
  [4, 6],
  [7, 10],
  [11, 14],
  [15, 24],
  [25, 34],
  [35, 60],
];
export const bandOf = (l) => BANDS.find(([a, b]) => l >= a && l <= b);
const bandName = (b) => `${b[0]}-${b[1]}`;

const readJsonl = async (p) => {
  try {
    return (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const sum = (a, f) => a.reduce((x, r) => x + f(r), 0);
const full = (s) => s.party.every(([, hp, maxHp, mp, maxMp]) => hp >= maxHp && (!(maxMp > 0) || mp >= maxMp));

// ---------------------------------------------------------------- stretches from one leader's samples
// Consecutive samples in one zone at one level form a run. A run that follows a short visit elsewhere (at most
// HOP milliseconds in total) joins the earlier run of its zone and level.
function stretchesOf(samples, members) {
  const runs = [];
  let cur = null;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const key = `${b.zone}|${b.lvl}`;
    if (!cur || cur.key !== key || b.t - cur.t1 > RUN_GAP) {
      cur = { key, zone: b.zone, lvl: b.lvl, t0: b.t, t1: b.t, secs: 0, cells: { combat: 0, move: 0, recover: 0, idle: 0, off: 0 }, xp: 0, con: new Map(), lv: [], parts: [] };
      runs.push(cur);
    }
    cur.t1 = b.t;
    cur.parts[0] = [cur.t0, cur.t1];
    const dt = b.t - a.t;
    if (dt > GAP_MS) continue;
    const moved = (b.pst != null && b.pst !== "idle") || (a.x != null && b.x != null && Math.hypot(b.x - a.x, b.y - a.y) > MOVE_EPS);
    const active = b.mode === "auto-level" || b.mode === "directed-combat";
    const cell = b.combat ? "combat" : !active ? "off" : moved ? "move" : !full(b) ? "recover" : "idle";
    cur.secs += dt / 1000;
    cur.cells[cell] += dt / 1000;
    if (a.xp != null && b.xp != null) cur.xp += b.xp - a.xp;
    const ck = `${b.minCon}|${b.maxCon}`;
    cur.con.set(ck, (cur.con.get(ck) ?? 0) + dt);
    if (b.lv && b.party) {
      const lv = b.party.flatMap(([name], k) => (name === "me" || members.has(name) ? [b.lv[k]] : []));
      if (lv.length) cur.lv.push(lv.reduce((x, y) => x + y, 0) / lv.length);
    }
  }
  const out = [];
  for (const r of runs) {
    let j = out.length - 1;
    let span = 0;
    while (j >= 0 && out[j].key !== r.key && span <= HOP) {
      span += out[j].t1 - out[j].t0;
      j--;
    }
    if (j >= 0 && out[j].key === r.key && span <= HOP && r.t0 - out[j].t1 <= HOP + RUN_GAP) {
      const s = out[j];
      out.length = j + 1;
      s.t1 = r.t1;
      s.secs += r.secs;
      for (const k of Object.keys(s.cells)) s.cells[k] += r.cells[k];
      s.xp += r.xp;
      for (const [k, v] of r.con) s.con.set(k, (s.con.get(k) ?? 0) + v);
      s.lv.push(...r.lv);
      s.parts.push(...r.parts);
    } else out.push(r);
  }
  return out;
}

const KILL = /^You have (?:defeated|slain) (.+?) and gained (\d+) experience/;
function addEvents(stretches, events, members) {
  const bounds = stretches.flatMap((s) => s.parts.map(([a, b]) => [a - 1000, b + 1000, s])).sort((x, y) => x[0] - y[0]);
  for (const s of stretches) Object.assign(s, { kills: 0, killXp: 0, deaths: 0, leaderDeaths: 0, xpLost: 0, stone: 0, escapes: [] });
  let k = 0;
  let open = null;
  for (const e of events) {
    while (k < bounds.length && bounds[k][1] < e.t) k++;
    let s = null;
    for (let j = k; j < bounds.length && bounds[j][0] <= e.t; j++) if (bounds[j][1] >= e.t) s = bounds[j][2];
    if (!s) continue;
    const m = KILL.exec(e.text);
    if (m) {
      s.kills++;
      s.killXp += Number(m[2]);
      continue;
    }
    if (e.type === "DEATH") {
      const victim = /^(.+?) has been slain!$/.exec(e.text)?.[1];
      if (/^You have been slain/.test(e.text)) (s.leaderDeaths++, s.deaths++);
      else if (members.has(victim)) s.deaths++;
      continue;
    }
    s.xpLost += Number(/^You lose (\d+) experience/.exec(e.text)?.[1] ?? 0);
    s.stone += Number(/^You gain experience!! \((\d+)\)/.exec(e.text)?.[1] ?? 0);
    if (e.type === "guard") {
      const g = ESCAPE_START.exec(e.text);
      if (g) open = { t: e.t, why: g[1], s };
      else if (open && ESCAPE_END.test(e.text)) {
        open.s.escapes.push({ why: open.why, secs: (e.t - open.t) / 1000 });
        open = null;
      }
    }
  }
}

// ---------------------------------------------------------------- measure and model every stretch
const roster = JSON.parse(await readFile(`${REPO}data/roster.json`, "utf8"));
const wanted = opt("leaders") ? new Set(opt("leaders").split(",")) : null;
const zones = await loadZones();
const byId = new Map([...zones.values()].map((z) => [z.id, z]));
const rows = [];
const presence = []; // every stretch of every group, for crowding
const skipped = new Map();
const incomplete = [];
// The first group's older runs (levels 3 to 31 before runs/live starts) are merged by (session, sequence), as tools/fights.mjs does.
const OLDER = ["2026-11-06-tox-ab", "2026-11-07-live", "2026-11-08-lead"];
async function load(dirs, file) {
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    for (const r of await readJsonl(`${REPO}runs/${d}/${file}`)) {
      const key = `${r.ses}:${r.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
for (const [gi, g] of roster.groups.filter((x) => x.members?.length).entries()) {
  const leader = g.members[0];
  if (wanted && !wanted.has(leader)) continue;
  const members = new Set(g.members);
  const dirs = gi === 0 && !has("no-history") ? [...OLDER, `live/${leader}`] : [`live/${leader}`];
  const samples = (await load(dirs, "samples.jsonl")).filter((s) => s.t != null && s.zone != null);
  if (samples.length < 2) continue;
  const everything = stretchesOf(samples, members);
  for (const s of everything) presence.push({ leader, zone: s.zone, parts: s.parts });
  const stretches = everything.filter((s) => s.secs >= MIN_SECS);
  addEvents(stretches, await load(dirs, "events.jsonl"), members);
  for (const s of stretches) rows.push({ group: g.id, leader, ...s });
}

// Other groups of the account in the same zone: the share of the stretch's time another leader spent there.
function crowdOf(s) {
  let overlap = 0;
  let own = 0;
  for (const [a, b] of s.parts) own += b - a;
  for (const o of presence) if (o.leader !== s.leader && o.zone === s.zone) for (const [a, b] of s.parts) for (const [c, d] of o.parts) overlap += Math.max(0, Math.min(b, d) - Math.max(a, c));
  return own ? overlap / own : 0;
}

// --baseline is the model before the refit: no depletion of spawn points or crowd, no damage curve below level 18,
// straight-line walks, 2 s of overhead, a lead caster that spends 10 mana per fight second at every level, 49 dps.
const BASELINE = { depletion: false, dpsCurve: null, detour: 1, overhead: 2, manaPerSec: 10, dps: 49, crowd: 0 };
// Groups 2 to 12 deal about 0.9 of group 1's damage at the same level (--fit). The model of a new group takes it;
// group 1 is the reference party of predict's --dps.
const OTHERS = Number(opt("others", 0.9));
const evalRow = (ctx, over = {}, baseline = has("baseline")) => {
  const cfg = { ...ctx.cfg, ...(baseline ? BASELINE : {}), ...over };
  if (!baseline && ctx.group !== "G1" && over.dps === undefined) cfg.dps = ctx.cfg.dps * OTHERS;
  return evalZone(ctx.z, cfg);
};
const out = [];
for (const s of rows) {
  const z = byId.get(s.zone);
  if (!z) {
    skipped.set(s.zone, (skipped.get(s.zone) ?? 0) + s.secs);
    continue;
  }
  // Event lines can be missing (a log that starts late, a dropped batch). The kill XP must match what the XP
  // counter gained over the same seconds, with losses and hand-ins put back.
  const counted = s.xp + s.xpLost - s.stone;
  if (!(s.kills >= 5) || Math.abs(s.killXp / counted - 1) > 0.1) {
    incomplete.push(`${s.leader} ${z.short} ${s.lvl} ${Math.round(s.secs / 60)} min`);
    continue;
  }
  const [minCon, maxCon] = [...s.con.entries()].sort((a, b) => b[1] - a[1])[0][0].split("|").map(Number);
  const lvMean = s.lv.length ? s.lv.reduce((a, b) => a + b, 0) / s.lv.length : s.lvl;
  const others = Math.max(s.lvl, (6 * lvMean - s.lvl) / 5);
  const cfg = { ...cfgFromFlags(s.lvl), ...conLimits(s.lvl, minCon, maxCon), partyLevels: [s.lvl, ...Array(5).fill(others)], stay: s.secs / 60, crowd: has("no-crowd") ? 0 : crowdOf(s) * Number(opt("crowd-weight", 0.5)) };
  const ctx = { z, cfg, group: s.group };
  const r = evalRow(ctx);
  if (!r.cycle) {
    skipped.set(z.short, (skipped.get(z.short) ?? 0) + s.secs);
    continue;
  }
  const hours = s.secs / 3600;
  out.push({
    group: s.group,
    leader: s.leader,
    zone: z.short,
    level: s.lvl,
    minutes: s.secs / 60,
    con: `${minCon}-${maxCon}`,
    crowd: cfg.crowd,
    kills: s.kills,
    xph: s.killXp / hours,
    netXph: s.xp / hours,
    xpKill: s.killXp / s.kills,
    secsKill: s.secs / s.kills,
    cells: Object.fromEntries(Object.entries(s.cells).map(([k, v]) => [k, v / s.kills])),
    escapes: s.escapes.length,
    escapeSecs: s.escapes.reduce((a, e) => a + e.secs, 0),
    deaths: s.deaths,
    leaderDeaths: s.leaderDeaths,
    xpLost: s.xpLost,
    stone: s.stone,
    ctx,
    model: { xph: r.xph, kh: r.kh, xpKill: r.xpKill, cycle: r.cycle, kill: r.kill, walk: r.walk, recovery: r.recovery, overhead: cfg.overhead, spawnLimited: r.spawnKh < r.combatKh, mass: r.mass },
  });
}

// ---------------------------------------------------------------- --fit
// Least squares over the stretches up to --fit-max (default 60, every level) outside the zones of --fit-skip (default crushbone,
// whose fights run 3 to 4 times as long as the model's at levels 11 to 14 for a reason the data do not show), each
// weighted by its minutes: the squared log of measured over model XP per hour, plus --term-weight (default 0.5)
// times the squared log of measured over model seconds per kill for fight vs kill, move vs walk and recover vs
// recovery (with a second added to each, so that zero does not dominate). Free: a multiplier on the damage of
// group 1 at the levels of --knots (default 1,14, flat below the first, 1.00 from level 18, linear between), the
// walking detour, a multiplier on the damage of groups 2 to 12 against group 1's, and the exponent of the lead
// caster's mana spend below level 24 (DEFAULTS.manaExp). A small penalty keeps neighbouring knots alike.
if (has("fit")) {
  const KNOTS = opt("knots", "1,14").split(",").map(Number);
  const maxLevel = Number(opt("fit-max", 60));
  const termWeight = Number(opt("term-weight", 0.5));
  const skip = new Set(opt("fit-skip", "crushbone").split(","));
  const list = out.filter((r) => r.level <= maxLevel && !skip.has(r.zone));
  // x: log multipliers at the knots, log detour, log of the damage of groups 2 to 12 against group 1's, mana exponent.
  const K = KNOTS.length;
  const over = (x, r) => ({
    dpsCurve: [...KNOTS.map((l, i) => [l, Math.exp(x[i])]), [18, 1]],
    detour: Math.exp(x[K]),
    dps: r.ctx.cfg.dps * (r.group === "G1" ? 1 : Math.exp(x[K + 1])),
    manaPerSec: DEFAULTS.manaPerSec * Math.min(1, r.ctx.cfg.level / DEFAULTS.dpsLevel) ** x[K + 2],
  });
  const lg = (m, model) => Math.log((m + 1) / (model + 1)) ** 2;
  const err = (x) => {
    let e = 0;
    for (const r of list) {
      const m = evalRow(r.ctx, over(x, r));
      e += (r.minutes / 30) * (Math.log(r.xph / m.xph) ** 2 + termWeight * (lg(r.cells.combat, m.kill) + lg(r.cells.move, m.walk) + lg(r.cells.recover, m.recovery)));
    }
    for (let i = 1; i < K; i++) e += 2 * (x[i] - x[i - 1]) ** 2;
    return e;
  };
  console.log(`fit on ${list.length} stretches, ${(sum(list, (r) => r.minutes) / 60).toFixed(1)} h (levels up to ${maxLevel}, zones other than ${[...skip].join(", ")})`);
  const x = [...KNOTS.map(() => -0.3), 0, -0.3, 0.5];
  let cur = err(x);
  for (const step of [0.4, 0.2, 0.1, 0.05, 0.02, 0.01])
    for (let pass = 0; pass < 10; pass++) {
      let moved = false;
      for (let i = 0; i < x.length; i++)
        for (const d of [step, -step]) {
          const y = [...x];
          y[i] += d;
          if (i === K) y[i] = Math.max(0, y[i]); // a walk cannot be shorter than the straight line
          if (i === K + 2) y[i] = Math.min(2, Math.max(0, y[i]));
          const e = err(y);
          if (e < cur - 1e-9) (x.splice(0, x.length, ...y), (cur = e), (moved = true));
        }
      if (!moved) break;
    }
  const curve = KNOTS.map((l, i) => [l, +Math.exp(x[i]).toFixed(2)]).concat([[18, 1]]);
  console.log(`squared error ${cur.toFixed(3)}: dpsCurve ${JSON.stringify(curve)}, detour ${Math.exp(x[K]).toFixed(2)}, manaExp ${x[K + 2].toFixed(2)}, groups 2-12 deal ${Math.exp(x[K + 1]).toFixed(2)} of group 1's damage (--others)`);
  process.exit(0);
}

// ---------------------------------------------------------------- aggregate
function aggregate(list) {
  const hours = sum(list, (r) => r.minutes / 60);
  const kills = sum(list, (r) => r.kills);
  const killXp = sum(list, (r) => r.xph * (r.minutes / 60));
  const modelXp = sum(list, (r) => r.model.xph * (r.minutes / 60));
  const modelKills = sum(list, (r) => r.model.kh * (r.minutes / 60));
  const modelXpKill = sum(list, (r) => r.model.xpKill * r.kills) / kills;
  const perKill = (f) => sum(list, (r) => f(r) * r.kills) / kills; // measured seconds per kill, weighted by kills
  const meas = { fight: perKill((r) => r.cells.combat), move: perKill((r) => r.cells.move), recover: perKill((r) => r.cells.recover), idle: perKill((r) => r.cells.idle + r.cells.off) };
  const mod = { fight: perKill((r) => r.model.kill), move: perKill((r) => r.model.walk), recover: perKill((r) => r.model.recovery), idle: perKill((r) => r.model.overhead) };
  const ratio = killXp / modelXp;
  const rKills = kills / modelKills;
  const rXpKill = (killXp / kills) / modelXpKill;
  let why;
  if (Math.abs(Math.log(rXpKill)) > Math.abs(Math.log(rKills))) why = "mix";
  else if (sum(list, (r) => (r.model.spawnLimited ? r.minutes : 0)) > 0.5 * sum(list, (r) => r.minutes) && ratio > 1) why = "spawns";
  else {
    const dir = rKills < 1 ? 1 : -1; // measured cycle longer than the model's
    const d = Object.keys(meas).map((k) => [k, dir * (meas[k] - mod[k])]).sort((a, b) => b[1] - a[1])[0];
    why = d[0];
  }
  return {
    n: list.length,
    hours,
    kills,
    xph: killXp / hours,
    modelXph: modelXp / hours,
    ratio,
    rKills,
    rXpKill,
    meas,
    mod,
    why,
    escPerH: sum(list, (r) => r.escapes) / hours,
    escShare: sum(list, (r) => r.escapeSecs) / (hours * 3600),
    leaderDeathsPerH: sum(list, (r) => r.leaderDeaths) / hours,
    deathsPerH: sum(list, (r) => r.deaths) / hours,
    lostShare: sum(list, (r) => r.xpLost) / sum(list, (r) => r.xph * (r.minutes / 60)),
    ratios: list.map((r) => r.xph / r.model.xph),
  };
}
const groupBy = (list, f) => {
  const m = new Map();
  for (const r of list) m.set(f(r), [...(m.get(f(r)) ?? []), r]);
  return m;
};
const summary = [];
for (const b of BANDS) {
  const inBand = out.filter((r) => r.level >= b[0] && r.level <= b[1]);
  if (!inBand.length) continue;
  summary.push({ band: bandName(b), zone: "all", ...aggregate(inBand) });
  for (const [name, test] of [["group 1", (r) => r.group === "G1"], ["groups 2-12", (r) => r.group !== "G1"]]) {
    const part = inBand.filter(test);
    if (part.length) summary.push({ band: bandName(b), zone: name, group: true, ...aggregate(part) });
  }
  for (const [zone, list] of [...groupBy(inBand, (r) => r.zone)].sort((x, y) => sum(y[1], (r) => r.minutes) - sum(x[1], (r) => r.minutes))) summary.push({ band: bandName(b), zone, ...aggregate(list) });
}

if (has("json")) {
  console.log(JSON.stringify({ stretches: out.map(({ ctx, ...r }) => r), summary, skipped: Object.fromEntries(skipped), incomplete }, null, 1));
  process.exit(0);
}

if (has("compare")) {
  // Model error per level band before the refit (no depletion, no damage curve, no group factor) and after.
  const rms = (list, f) => {
    const w = sum(list, (r) => r.minutes);
    return Math.exp(Math.sqrt(sum(list, (r) => r.minutes * Math.log(r.xph / f(r)) ** 2) / w)) - 1;
  };
  const pooled = (list, f) => sum(list, (r) => r.xph * r.minutes) / sum(list, (r) => f(r) * r.minutes);
  const before = new Map(out.map((r) => [r, evalRow(r.ctx, {}, true).xph]));
  const after = new Map(out.map((r) => [r, evalRow(r.ctx, {}, false).xph]));
  console.log("band   n     h   groups  measured/model before  after   typical error before  after");
  for (const b of BANDS) {
    for (const [name, test] of [["all", () => true], ["grp 1", (r) => r.group === "G1"], ["2-12", (r) => r.group !== "G1"]]) {
      const list = out.filter((r) => r.level >= b[0] && r.level <= b[1] && test(r));
      if (!list.length) continue;
      console.log(`${bandName(b).padEnd(6)} ${String(list.length).padStart(2)} ${(sum(list, (r) => r.minutes) / 60).toFixed(1).padStart(5)}  ${name.padEnd(6)}  ${pooled(list, (r) => before.get(r)).toFixed(2).padStart(20)} ${pooled(list, (r) => after.get(r)).toFixed(2).padStart(6)} ${(100 * rms(list, (r) => before.get(r))).toFixed(0).padStart(19)}% ${(100 * rms(list, (r) => after.get(r))).toFixed(0).padStart(5)}%`);
    }
  }
  process.exit(0);
}

if (has("shares")) {
  // Where the time goes per level band: measured cells against the model's cycle terms, as shares of the time.
  console.log("Shares of the time, measured / model: fight vs kill, move vs walk, recover vs recovery, idle and off vs overhead");
  console.log("band   h      fight        move       recover       idle        off");
  for (const b of BANDS) {
    const list = out.filter((r) => r.level >= b[0] && r.level <= b[1]);
    if (!list.length) continue;
    const secs = sum(list, (r) => r.minutes * 60);
    const m = (f) => sum(list, (r) => f(r) * r.kills) / secs; // measured seconds per kill x kills
    const mod = (f) => sum(list, (r) => (r.minutes * 60 * f(r.model)) / r.model.cycle) / secs;
    const pair = (a, c) => `${(100 * a).toFixed(0).padStart(3)}%/${(100 * c).toFixed(0).padStart(2)}%`.padStart(10);
    console.log(`${bandName(b).padEnd(6)} ${(secs / 3600).toFixed(1).padStart(4)} ${pair(m((r) => r.cells.combat), mod((x) => x.kill))} ${pair(m((r) => r.cells.move), mod((x) => x.walk))} ${pair(m((r) => r.cells.recover), mod((x) => x.recovery))} ${pair(m((r) => r.cells.idle), mod((x) => x.overhead))} ${(100 * m((r) => r.cells.off)).toFixed(0).padStart(7)}%`);
  }
  process.exit(0);
}

const k = (v) => (v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : Math.round(v / 1e3) + "k");
const f1 = (v) => v.toFixed(1);
const cell = (a, b) => `${f1(a)}/${f1(b)}`;
if (has("rows")) {
  console.log("group leader        zone        lvl  min con   crowd kills  XP/h meas  model ratio | k/h ratio xp/kill ratio | s/kill fight move recover idle (measured/model) | esc dead");
  for (const r of out) {
    const m = r.model;
    console.log(
      `${r.group.padEnd(4)} ${r.leader.padEnd(12)} ${r.zone.padEnd(11)} ${String(r.level).padStart(3)} ${String(Math.round(r.minutes)).padStart(4)} ${r.con.padEnd(5)} ${r.crowd.toFixed(1).padStart(4)} ${String(r.kills).padStart(5)} ${k(r.xph).padStart(10)} ${k(m.xph).padStart(6)} ${(r.xph / m.xph).toFixed(2).padStart(5)} | ${(r.kills / (r.minutes / 60) / m.kh).toFixed(2).padStart(7)} ${(r.xpKill / m.xpKill).toFixed(2).padStart(14)} | ${cell(r.secsKill, m.cycle).padStart(9)} ${cell(r.cells.combat, m.kill)} ${cell(r.cells.move, m.walk)} ${cell(r.cells.recover, m.recovery)} ${cell(r.cells.idle + r.cells.off, m.overhead)} | ${r.escapes} ${r.deaths}`,
    );
  }
  console.log();
}

console.log(`Measured leader XP/h over the model, per level band and zone. Stretches of at least ${MIN_SECS / 60} min in one zone at one level, ${out.length} of them, ${f1(sum(out, (r) => r.minutes) / 60)} h.`);
console.log("Seconds per kill are measured/model for fight vs kill, move vs walk, recover vs recovery, idle (and off) vs overhead.\n");
console.log("band  zone         n    h   XP/h   model ratio  k/h xp/kill  gap     fight      move     recover      idle       esc/h esc% dead/h lost%");
for (const s of summary) {
  const all = s.zone === "all";
  console.log(
    `${s.band.padEnd(5)} ${(all ? "ALL" : s.group ? s.zone.replace("groups", "grp") : s.zone).padEnd(11)} ${(String(s.n) + (s.hours < 2 ? "*" : "")).padStart(3)} ${f1(s.hours).padStart(4)} ${k(s.xph).padStart(6)} ${k(s.modelXph).padStart(6)} ${s.ratio.toFixed(2).padStart(5)} ${s.rKills.toFixed(2).padStart(5)} ${s.rXpKill.toFixed(2).padStart(5)}  ${s.why.padEnd(7)} ${cell(s.meas.fight, s.mod.fight).padStart(9)} ${cell(s.meas.move, s.mod.move).padStart(9)} ${cell(s.meas.recover, s.mod.recover).padStart(9)} ${cell(s.meas.idle, s.mod.idle).padStart(9)}  ${s.escPerH.toFixed(1).padStart(5)} ${(100 * s.escShare).toFixed(0).padStart(4)} ${s.leaderDeathsPerH.toFixed(2).padStart(5)} ${(100 * s.lostShare).toFixed(0).padStart(5)}`,
  );
  if (all) console.log("");
}
if (incomplete.length) console.log(`\nLeft out, kill lines do not match the XP counter: ${incomplete.join(", ")}`);
if (skipped.size) console.log(`\nLeft out, not in the model: ${[...skipped].map(([z, s]) => `${z} ${Math.round(s / 60)} min`).join(", ")}`);
