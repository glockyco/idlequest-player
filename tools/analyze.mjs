// Efficiency analysis of a recorded run.
//
//   bun tools/analyze.mjs <run dir> [--last 30m] [--since <ms epoch>] [--until <ms epoch>] [--label name] [--vis 0|1] [--member <name>] [--json]
//
// `--vis 1` keeps only seconds while the game tab was visible, `--vis 0` only hidden ones. Browsers
// throttle timers in hidden tabs, and the client simulates combat, so compare both before blaming a
// zone or a setting for a change in speed.
//
// `--member <name>` adds that party member's XP per hour and XP per kill, read from its
// "<name> gains N experience." lines. The leader's own kill lines depend on the leader's level share
// and class factor, so compare setups with different leaders through a companion that is in both.
//
// The "Zone multiplier" section checks each zone's XP multiplier against the kills. A leader kill pays
// 120 x NPC level^2 x zone multiplier x (leader level / sum of the party characters' levels), so the
// NPC level it implies must be a whole number when the multiplier is right. The section reports, per
// zone, the share of kills that fit under the content snapshot's multiplier and under
// data/idlequest-zones.json (the wiki's), and the multiplier that fits best when neither does. The
// snapshot is read from $IQ_CONTENT or ~/src/github.com/brynnb/idlequest-content.
//
// Input is `samples.jsonl` and `events.jsonl` written by `exportRun` (src/client.mjs).
//
// Every second of play is placed in exactly one cell, with no assumption about causes:
//   combat                 in combat
//   move                   out of combat, position changed
//   recover                out of combat, still, someone below max HP or mana
//   ready-idle             out of combat, still, everyone full  (nothing explains this second yet)
// Time in `ready-idle` is attributed from the game's own messages seen in the same stretch.
//
// Samples recorded since the bridge labels its seconds also carry `act` and `why` (the "Activity"
// section of src/bridge.js), read from the client's own state. "Activity" reports their seconds, keyed
// `act` or `act/why` for idle and travel, over the covered seconds that carry a label.
import { readFile, readdir } from "node:fs/promises";
import { lastJsonl, readJsonlSince } from "./lib/jsonl.mjs";
import { homedir } from "node:os";
import { ESCAPE_END, ESCAPE_START } from "./lib/guard-log.mjs";
import { xpStep } from "./lib/samples.mjs";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
if (!dir) {
  console.error("usage: bun tools/analyze.mjs <run dir> [--last 30m] [--since ms] [--until ms] [--label name] [--vis 0|1] [--member name] [--json]");
  process.exit(2);
}

// The window comes first, and each log is read from where it starts (tools/lib/jsonl.mjs): a
// leader's event log holds days, and a report asks for its last hour or two.
const parseDuration = (s) => {
  const m = /^(\d+)(s|m|h)$/.exec(s ?? "");
  return m ? Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]] : null;
};
const end = opt("until") ? Number(opt("until")) : lastJsonl(`${dir}/samples.jsonl`)?.t;
const start = opt("since") ? Number(opt("since")) : opt("last") ? end - parseDuration(opt("last")) : 0;
let samples = readJsonlSince(`${dir}/samples.jsonl`, start).filter((s) => s.t <= end);
let events = [];
try {
  events = readJsonlSince(`${dir}/events.jsonl`, start - 2000).filter((e) => e.t <= end + 2000);
} catch {
  /* a run without an event log */
}
if (opt("label")) samples = samples.filter((s) => s.label === opt("label"));
if (opt("vis") != null) samples = samples.filter((s) => s.vis === Number(opt("vis")));
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
const activity = {}; // ms per page label
let labeled = 0; // covered ms whose sample carries a label
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
  const dxp = xpStep(a, b);
  if (dxp != null) xpSum += dxp;
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
  if (b.act) {
    const key = b.why && (b.act === "idle" || b.act === "travel") ? `${b.act}/${b.why}` : b.act;
    activity[key] = (activity[key] ?? 0) + dt;
    labeled += dt;
  }
}

// ---- Outcome ---------------------------------------------------------------------------------
const KILL = /^You have (?:defeated|slain) (.+?) and gained (\d+) experience/;
const kills = events.filter((e) => coveredSec.has(Math.floor(e.t / 1000))).flatMap((e) => {
  const m = KILL.exec(e.text);
  return m ? [{ t: e.t, enemy: m[1], xp: Number(m[2]) }] : [];
});
const xpGained = xpSum;
const mins = covered / 60000;

// ---- Time to kill ----------------------------------------------------------------------------
// Combat stretch starts: the first sample of each run of `combat` samples (a gap ends the run).
const combatStarts = [];
for (let i = 0; i < samples.length; i++) {
  const prevCombat = i > 0 && samples[i].t - samples[i - 1].t <= GAP_MS && samples[i - 1].combat;
  if (samples[i].combat && !prevCombat) combatStarts.push(samples[i].t);
}
const ttk = [];
{
  let prevKill = 0;
  let k = 0;
  for (const kill of kills) {
    while (k + 1 < combatStarts.length && combatStarts[k + 1] <= kill.t) k++;
    const start = Math.max(combatStarts[k] ?? kill.t, prevKill);
    const d = (kill.t - start) / 1000;
    // Kills outside any observed fight, or more than 3 minutes long, are not a normal pull.
    if (combatStarts.length && d >= 0 && d < 180) ttk.push(d);
    prevKill = kill.t;
  }
}
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

// ---- Between pulls: what each wait from a kill to the next engage was spent on ------------------
// The readiness wait ends only when everyone is full, nobody is rooted and no cure or dispel was
// cast in the last pass, so a cure that keeps failing holds the whole party. Waits are grouped by
// the first matching cause: a cure or dispel cast during the wait, the game's root message, or
// neither (plain HP and mana recovery, travel and target search).
const CURE = /^(\w+) begins casting (Cancel Magic|Nullify Magic|Cure \w+|Counteract \w+|Remove \w+|Abolish \w+)/;
const CURED = /^\w+ (dispelled .+ from \w+|cured \w+ of )/;
const pulls = [];
{
  let cur = null;
  for (const e of events) {
    if (!coveredSec.has(Math.floor(e.t / 1000))) continue;
    if (KILL.test(e.text)) {
      cur = { start: e.t, casts: {}, cured: 0, root: false };
      continue;
    }
    if (!cur) continue;
    if (/^You engage .+ in combat/.test(e.text) || / joins the fight!$/.test(e.text)) {
      cur.secs = (e.t - cur.start) / 1000;
      if (cur.secs < 300) pulls.push(cur);
      cur = null;
      continue;
    }
    if (/^Waiting for root to wear off/.test(e.text)) cur.root = true;
    const m = CURE.exec(e.text);
    if (m) cur.casts[`${m[1]} ${m[2]}`] = (cur.casts[`${m[1]} ${m[2]}`] ?? 0) + 1;
    if (CURED.test(e.text)) cur.cured++;
  }
}
const pullGroups = { cure: [], root: [], plain: [] };
for (const p of pulls) pullGroups[Object.keys(p.casts).length ? "cure" : p.root ? "root" : "plain"].push(p);
const cureCasts = {};
for (const p of pulls) for (const [k, n] of Object.entries(p.casts)) cureCasts[k] = (cureCasts[k] ?? 0) + n;

// ---- Guard escapes: each one abandons the fight and re-enters the zone --------------------------
const escapes = [];
{
  let open = null;
  for (const e of events) {
    if (e.type !== "guard" || !coveredSec.has(Math.floor(e.t / 1000))) continue;
    const m = ESCAPE_START.exec(e.text);
    if (m) open = { t: e.t, why: m[1] };
    else if (open && ESCAPE_END.test(e.text)) {
      escapes.push({ ...open, secs: (e.t - open.t) / 1000 });
      open = null;
    }
  }
}

// ---- Damage by source: who and what kills the enemies -----------------------------------------
// Party members and pets are the names the samples list; the player's own lines start "You" or
// "Your". Melee lines end "for N damage", spells "for N points of damage". A DoT tick names its
// caster but not its spell ("<enemy> has taken N damage from <caster>'s spell.", or "your spell").
// An enemy's negative regeneration ticks "from a spell." with no caster, the same text a party
// member's incoming tick carries, so those count as "no caster" only on names outside the party.
const ours = new Set(samples.flatMap((s) => (s.party ?? []).map((m) => m[0])));
const damage = {};
{
  const add = (who, kind, n) => ((damage[who] ??= {})[kind] = (damage[who][kind] ?? 0) + n);
  for (const e of events) {
    if (!coveredSec.has(Math.floor(e.t / 1000))) continue;
    let m;
    if ((m = /^Your (.+?) hit .+? for (\d+) points? of damage/.exec(e.text))) add("me", m[1], +m[2]);
    else if ((m = /^You \w+ .+? for (\d+) (?:points? of )?damage/.exec(e.text))) add("me", "melee", +m[1]);
    else if ((m = /^(\w+)'s damage shield hit .+? for (\d+)/.exec(e.text))) { if (ours.has(m[1])) add(m[1], "damage shield", +m[2]); }
    else if ((m = /^(\w+)'s (.+?) hit .+? for (\d+) points? of damage/.exec(e.text))) { if (ours.has(m[1])) add(m[1], m[2], +m[3]); }
    else if ((m = /^.+? has taken (\d+) damage from your spell\.$/.exec(e.text))) add("me", "DoT ticks", +m[1]);
    else if ((m = /^.+? has taken (\d+) damage from (\w+)'s spell\.$/.exec(e.text))) { if (ours.has(m[2])) add(m[2], "DoT ticks", +m[1]); }
    else if ((m = /^(.+?) has taken (\d+) damage from a spell\.$/.exec(e.text))) { if (!ours.has(m[1])) add("no caster", "DoT ticks", +m[2]); }
    else if ((m = /^(\w+) \w+ .+? for (\d+) (?:points? of )?damage/.exec(e.text))) { if (ours.has(m[1])) add(m[1], "melee", +m[2]); }
  }
}
const damageTotal = Object.values(damage).reduce((s, o) => s + Object.values(o).reduce((a, b) => a + b, 0), 0);

// ---- One party member's XP ---------------------------------------------------------------------
// The member's own "<name> gains N experience." lines, over the same covered seconds.
const memberName = opt("member");
let member = null;
if (memberName) {
  const re = new RegExp(`^${memberName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} gains (\\d+) experience`);
  const xps = events.flatMap((e) => (coveredSec.has(Math.floor(e.t / 1000)) && re.exec(e.text) ? [Number(re.exec(e.text)[1])] : []));
  member = { name: memberName, kills: xps.length, xpPerHour: Math.round((xps.reduce((a, b) => a + b, 0) / mins) * 60), xpPerKill: xps.length ? Math.round(xps.reduce((a, b) => a + b, 0) / xps.length) : 0 };
}

// ---- Zone multiplier -------------------------------------------------------------------------
// Each leader kill gives 120 x NPC level^2 x zone multiplier x leader level / sum of the levels of
// the party's characters (pets take no share). With the right multiplier the NPC
// level this implies is a whole number, so "fits" means some whole level reproduces the XP within 1.
// Kills at the 11%-of-a-level cap are skipped. Null without kills or without the content snapshot.
const zoneMultiplier = await (async () => {
  if (!kills.length) return null;
  const root = process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`;
  const normName = (s) => s.replace(/^the\s+/i, "").replace(/[`']/g, "").trim().toLowerCase();
  let wiki;
  const byId = new Map();
  try {
    wiki = new Map(Object.entries(JSON.parse(await readFile(new URL("../data/idlequest-zones.json", import.meta.url), "utf8"))).map(([k, v]) => [normName(k), v]));
    for (const f of (await readdir(`${root}/data/zone`)).filter((f) => f.endsWith(".ndjson")))
      for (const l of (await readFile(`${root}/data/zone/${f}`, "utf8")).split("\n")) {
        if (!l) continue;
        const z = JSON.parse(l);
        if (z.version === 0 && !byId.has(z.zoneidnumber)) byId.set(z.zoneidnumber, { short: z.short_name, name: z.long_name, content: Number(z.zone_exp_multiplier) });
      }
  } catch {
    return null;
  }
  // The characters are the leader and every member with an XP line in the window. A single kill can
  // miss a member's line, so the set is taken over the whole window.
  const characters = [...new Set(events.flatMap((e) => /^(\w+) gains \d+ experience/.exec(e.text)?.slice(1) ?? []))];
  const perZone = new Map();
  let si = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!KILL.test(e.text) || !coveredSec.has(Math.floor(e.t / 1000))) continue;
    while (si + 1 < samples.length && samples[si + 1].t <= e.t) si++;
    const s = samples[si];
    if (e.t - s.t > 2000 || !s.lv || !s.party) continue;
    const names = ["me", ...characters].filter((n) => s.party.some((p) => p[0] === n));
    const lv = names.map((n) => s.lv[s.party.findIndex((p) => p[0] === n)]);
    if (lv.some((v) => !(v > 0))) continue;
    const xp = Number(KILL.exec(e.text)[2]);
    if (xp >= 0.11 * 3000 * lv[0] ** 2 - 1) continue;
    (perZone.get(s.zone) ?? perZone.set(s.zone, []).get(s.zone)).push({ xp, share: lv[0] / lv.reduce((a, b) => a + b, 0) });
  }
  const fit = (k, m) => {
    const L = Math.round(Math.sqrt(k.xp / (120 * m * k.share)));
    return L >= 1 && Math.abs(120 * L * L * m * k.share - k.xp) <= 1;
  };
  const share = (ks, m) => ks.filter((k) => fit(k, m)).length / ks.length;
  const out = [];
  for (const [id, ks] of perZone) {
    const z = byId.get(id);
    const row = { zone: z?.short ?? String(id), id, name: z?.name ?? null, kills: ks.length, content: null, wiki: null, best: null };
    if (z && Number.isFinite(z.content)) row.content = { multiplier: z.content, fitShare: +share(ks, z.content).toFixed(3) };
    const w = z ? wiki.get(normName(z.name)) : undefined;
    if (w !== undefined) row.wiki = { multiplier: w, fitShare: +share(ks, w).toFixed(3) };
    if (!((row.content?.fitShare ?? 0) >= 0.9 || (row.wiki?.fitShare ?? 0) >= 0.9)) {
      let best = { multiplier: 0, fitShare: -1 };
      for (let c = 50; c <= 160; c++) {
        const f = share(ks, c / 100);
        if (f > best.fitShare) best = { multiplier: c / 100, fitShare: +f.toFixed(3) };
      }
      row.best = best;
    }
    out.push(row);
  }
  return out.sort((a, b) => b.kills - a.kills);
})();
const pct = (x) => `${((100 * x) / covered).toFixed(1)}%`;
const sec = (x) => `${(x / 1000).toFixed(0)}s`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);

const result = {
  window: { from: new Date(samples[0].t).toISOString(), to: new Date(samples.at(-1).t).toISOString(), coveredMin: +mins.toFixed(1), stoppedSec: Math.round(stopped / 1000) },
  levels: [samples[0].lvl, samples.at(-1).lvl],
  config: { zone: samples.at(-1).zone, minCon: samples.at(-1).minCon, maxCon: samples.at(-1).maxCon, aggr: samples.at(-1).aggr },
  member,
  zoneMultiplier,
  outcome: {
    xpPerHour: Math.round((xpGained / mins) * 60),
    // Gross coin picked up (purchases are not subtracted), in platinum per hour. Null before samples carried coin.
    platPerHour: coinSeen ? +(coinSum / 1000 / (mins / 60)).toFixed(1) : null,
    killsPerMin: +(kills.length / mins).toFixed(2),
    xpPerKill: kills.length ? Math.round(mean(kills.map((k) => k.xp))) : 0,
    // Seconds from the start of the combat stretch (or the previous kill in it) to each kill.
    ttkSec: ttk.length ? { mean: +mean(ttk).toFixed(1), median: +median(ttk).toFixed(1), p90: +[...ttk].sort((x, y) => x - y)[Math.floor(ttk.length * 0.9)].toFixed(1) } : null,
    // XP per minute if every idle second were removed: the ceiling for pure efficiency work.
    xpPerHourIfNoDowntime: cells.combat ? Math.round(((xpGained / (cells.combat / 60000)) * 60) / 1) : null,
  },
  timeShare: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, { sec: Math.round(v / 1000), share: +(v / covered).toFixed(3) }])),
  // Seconds by the page's own label, as shares of the labeled seconds. Null before samples carried labels.
  activity: labeled ? { labeledMin: +(labeled / 60000).toFixed(1), ...Object.fromEntries(top(activity, 99).map(([k, v]) => [k, { sec: Math.round(v / 1000), share: +(v / labeled).toFixed(3) }])) } : null,
  movement: { moveWhileNotFullSec: Math.round(moveNotFull / 1000), pathUnits: Math.round(pathLen), unitsPerKill: kills.length ? Math.round(pathLen / kills.length) : null, unitsPerSecWhileMoving: cells.move ? +(pathLen / (cells.move / 1000)).toFixed(1) : null },
  recover: { stretches: recoverRuns.length, meanSec: +mean(recoverRuns).toFixed(1), limiterSeconds: Object.fromEntries(top(limiter, 6).map(([k, v]) => [k, Math.round(v)])) },
  readyIdle: { stretches: idleRuns.length, meanSec: +mean(idleRuns).toFixed(1), maxSec: Math.max(0, ...idleRuns), messagesDuringIdleSeconds: Object.fromEntries(top(idleText, 8).map(([k, v]) => [k, Math.round(v)])) },
  betweenPulls: {
    ...Object.fromEntries(Object.entries(pullGroups).map(([k, a]) => [k, { waits: a.length, meanSec: +mean(a.map((p) => p.secs)).toFixed(1), totalSec: Math.round(a.reduce((s, p) => s + p.secs, 0)) }])),
    cureCasts,
    cureSuccesses: pulls.reduce((s, p) => s + p.cured, 0),
  },
  // The seconds from leaving to the escape's end in a zone. The abandoned fight and the walk back
  // from the zone-in are not counted here, but show in kills per minute.
  escapes: { count: escapes.length, meanSec: +mean(escapes.map((e) => e.secs)).toFixed(1), totalSec: Math.round(escapes.reduce((s, e) => s + e.secs, 0)), byTrigger: escapes.reduce((o, e) => ((o[e.why] = (o[e.why] ?? 0) + 1), o), {}) },
  // Share of the party's logged damage per member or pet, and "no caster" for caster-less ticks, with
  // its parts (melee, each spell, DoT ticks, damage shield).
  damage: Object.fromEntries(
    Object.entries(damage)
      .map(([who, parts]) => [who, Object.values(parts).reduce((a, b) => a + b, 0), parts])
      .sort((a, b) => b[1] - a[1])
      .map(([who, n, parts]) => [who, { share: damageTotal ? +(n / damageTotal).toFixed(3) : 0, total: n, parts }]),
  ),
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
  if (r.outcome.ttkSec) console.log(`Time to kill (s)   mean ${r.outcome.ttkSec.mean}   median ${r.outcome.ttkSec.median}   p90 ${r.outcome.ttkSec.p90}`);
  console.log("\nWhere the time goes");
  for (const [k, v] of Object.entries(cells)) console.log(`  ${k.padEnd(11)} ${sec(v).padStart(6)}  ${pct(v).padStart(6)}`);
  console.log(`  of the move time, ${sec(moveNotFull)} (${((100 * moveNotFull) / Math.max(cells.move, 1)).toFixed(0)}%) overlapped with someone still below full; path ${r.movement.pathUnits} units, ${r.movement.unitsPerKill} per kill, ${r.movement.unitsPerSecWhileMoving} units/s while moving`);
  if (r.activity) {
    console.log(`\nActivity by the page's labels (${r.activity.labeledMin} min labeled)`);
    for (const [k, v] of Object.entries(r.activity)) if (k !== "labeledMin") console.log(`  ${k.padEnd(16)} ${String(v.sec).padStart(6)}s  ${(100 * v.share).toFixed(1).padStart(5)}%`);
  }
  console.log(`\nRecovery  ${r.recover.stretches} stretches, mean ${r.recover.meanSec}s. Last member still not full, by seconds:`);
  for (const [k, v] of Object.entries(r.recover.limiterSeconds)) console.log(`  ${k.padEnd(16)} ${v}s`);
  console.log(`\nReady-idle  ${r.readyIdle.stretches} stretches, mean ${r.readyIdle.meanSec}s, longest ${r.readyIdle.maxSec}s. Messages seen during those stretches (seconds):`);
  for (const [k, v] of Object.entries(r.readyIdle.messagesDuringIdleSeconds)) console.log(`  ${String(v).padStart(5)}  ${k.slice(0, 110)}`);
  const bp = r.betweenPulls;
  console.log("\nBetween pulls (kill to next engage), grouped by cause");
  for (const k of ["plain", "root", "cure"]) console.log(`  ${k.padEnd(6)} ${String(bp[k].waits).padStart(4)} waits  mean ${String(bp[k].meanSec).padStart(5)}s  total ${bp[k].totalSec}s`);
  const casts = Object.entries(bp.cureCasts);
  if (casts.length) console.log(`  cure and dispel casts: ${casts.map(([k, n]) => `${k} ${n}`).join(", ")}; ${bp.cureSuccesses} removed an effect`);
  const es = r.escapes;
  console.log(`\nGuard escapes ${es.count}, mean ${es.meanSec}s until AutoLevel ran again, total ${es.totalSec}s${es.count ? ` (${Object.entries(es.byTrigger).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}`);
  console.log(`\nDamage by source (${damageTotal} logged)`);
  for (const [who, d] of Object.entries(r.damage)) console.log(`  ${who.padEnd(12)} ${(100 * d.share).toFixed(1).padStart(5)}%  ${Object.entries(d.parts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log("\nBy enemy");
  for (const [k, v] of Object.entries(r.byEnemy)) console.log(`  ${k.padEnd(28)} ${String(v.kills).padStart(4)} kills  ${String(v.avgXp).padStart(5)} XP`);
  if (r.member) console.log(`\nMember ${r.member.name}   XP/h ${r.member.xpPerHour}   kills ${r.member.kills}   XP/kill ${r.member.xpPerKill}   (leader XP/h ${r.outcome.xpPerHour}, XP/kill ${r.outcome.xpPerKill})`);
  if (r.zoneMultiplier?.length) {
    console.log("\nZone multiplier (share of kills whose XP implies a whole-number NPC level)");
    const f = (x) => (x ? `${x.multiplier} fits ${(100 * x.fitShare).toFixed(0)}%` : "n/a");
    for (const z of r.zoneMultiplier) console.log(`  ${z.zone.padEnd(14)} ${String(z.kills).padStart(5)} kills  content ${f(z.content)}  wiki ${f(z.wiki)}${z.best ? `  best ${f(z.best)}` : ""}`);
  }
}
