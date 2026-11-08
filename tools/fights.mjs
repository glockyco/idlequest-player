// Per-fight dataset from the recorded event logs, and what predicts deaths in it.
//
//   bun tools/fights.mjs [--dump] [--gap 10] [dir ...]
//
// Without `dir` it reads every party under runs/live/<leader>/ (events.jsonl + samples.jsonl) and the
// first party's older runs (2026-11-06-tox-ab, 2026-11-07-live, 2026-11-08-lead), whose overlapping
// rows are merged by (session, sequence). A `dir` argument reads that run directory as one party.
// Reads only, never contacts the game.
//   (default)  report: 1 escapes by trigger and deaths per leader level band, 2 deaths against the level
//              gap of the mobs that hit someone, incoming damage per second against the victim's max
//              HP, the number of mobs and the hitters' content damage, 3 what escapes and deaths cost
//              in seconds, 4 level escapes against comparable fights that were not escaped and the
//              survivors at a member's death, 5 a replay of candidate escape rules on the fights, 6 the
//              guard today against the recommended rule
//   --dump     one JSON object per fight on stdout instead of the report
//   --gap N    seconds without a combat line that end a fight (default 10)
//
// A fight runs from the first combat line after a quiet gap, or from "You engage", to the last combat
// line before a quiet gap, a kill followed by the next "You engage", or the guard's "[guard] leaving".
// Mobs that hit someone come from "<mob> hits <member> for N damage" lines. Their level is the one the
// guard printed for that mob in that zone, else the content snapshot's NPC level for that name in that
// zone (npc_types through spawn2 and spawnentry; $IQ_CONTENT or ~/src/github.com/brynnb/
// idlequest-content), the median of the NPCs sharing the name, and unknown when neither has the name.
// Members are the characters of data/roster.json and runs/iq.db: every other name is a pet. Member
// max HP, the leader's level and the zone come from the one-second samples.
import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (flag(n) ? args[args.indexOf(`--${n}`) + 1] : d);
const QUIET = Number(opt("gap", 10)) * 1000;
const dirArgs = args.filter((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--gap"));
const content = process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`;
const root = new URL("../runs/", import.meta.url).pathname;

// ---------------------------------------------------------------- input
const readJsonl = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
async function loadParty(name, dirs) {
  const seen = new Set();
  const merge = async (file) => {
    const out = [];
    for (const d of dirs) {
      if (!existsSync(`${d}/${file}`)) continue;
      for (const r of await readJsonl(`${d}/${file}`)) {
        const k = `${r.ses}:${r.seq}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(r);
      }
    }
    return out.sort((a, b) => a.t - b.t);
  };
  const events = await merge("events.jsonl");
  seen.clear();
  const samples = await merge("samples.jsonl");
  return { name, events, samples };
}
async function loadAll() {
  if (dirArgs.length) return Promise.all(dirArgs.map((d) => loadParty(d.replace(/\/$/, "").split("/").pop(), [d])));
  const parties = [];
  const live = existsSync(`${root}live`) ? await readdir(`${root}live`) : [];
  for (const l of live.sort()) {
    if (existsSync(`${root}live/${l}/events.jsonl`) && existsSync(`${root}live/${l}/samples.jsonl`)) {
      const p = await loadParty(l, [`${root}live/${l}`]);
      if (p.events.length > 1000) parties.push(p); // runs that ended after a minute carry no fights
    }
  }
  const old = ["2026-11-06-tox-ab", "2026-11-07-live", "2026-11-08-lead"].map((d) => `${root}${d}`).filter((d) => existsSync(`${d}/events.jsonl`));
  if (old.length) parties.push(await loadParty("first", old));
  return parties;
}

// Party members are the characters of data/roster.json and runs/iq.db and the free helpers of the
// first runs. Every other name in a sample's party list or a death line is a generated pet name.
function realNames() {
  const names = new Set(["Warrior", "Cleric", "Rogue"]);
  const roster = JSON.parse(readFileSync(new URL("../data/roster.json", import.meta.url), "utf8"));
  for (const g of roster.groups ?? []) for (const n of g.members ?? []) names.add(n);
  if (existsSync(`${root}iq.db`)) {
    const db = new Database(`${root}iq.db`, { readonly: true });
    for (const r of db.query("select name from characters").all()) names.add(r.name);
    db.close();
  }
  return names;
}

// ---------------------------------------------------------------- content snapshot
const normName = (s) =>
  s
    .replace(/^#/, "")
    .replace(/[`']/g, "")
    .replaceAll("_", " ")
    .replace(/^(an?|the)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
async function* rows(table) {
  const dir = `${content}/data/${table}`;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".ndjson")))
    for (const l of (await readFile(`${dir}/${f}`, "utf8")).split("\n")) if (l) yield JSON.parse(l);
}
/** zone id -> { short, mobs: Map(normalised name -> [{ level, hp, min, max, delay }]) } for the zone ids asked for. */
async function loadNpcs(zoneIds) {
  const zones = new Map(); // id -> short
  const byShort = new Map();
  for await (const z of rows("zone")) {
    if (z.version !== 0 || !zoneIds.has(z.zoneidnumber) || zones.has(z.zoneidnumber)) continue;
    zones.set(z.zoneidnumber, z.short_name);
    byShort.set(z.short_name, { id: z.zoneidnumber, short: z.short_name, long: z.long_name, mobs: new Map() });
  }
  const groupZone = new Map();
  for await (const s of rows("spawn2")) if (s.version === 0 && byShort.has(s.zone)) groupZone.set(s.spawngroupID, s.zone);
  const npcZones = new Map(); // npc id -> Set(zone short)
  for await (const e of rows("spawnentry")) {
    const z = groupZone.get(e.spawngroupID);
    if (!z || e.chance <= 0) continue;
    (npcZones.get(e.npcID) ?? npcZones.set(e.npcID, new Set()).get(e.npcID)).add(z);
  }
  for await (const n of rows("npc_types")) {
    const zs = npcZones.get(n.id);
    if (!zs || !(n.level > 0)) continue;
    const mob = { level: n.level, hp: Number(n.hp), min: Number(n.mindmg) || 0, max: Number(n.maxdmg) || 0, delay: (Number(n.attack_delay) || 30) / 10 };
    for (const z of zs) {
      const m = byShort.get(z).mobs;
      const k = normName(n.name);
      (m.get(k) ?? m.set(k, []).get(k)).push(mob);
    }
  }
  return new Map([...byShort.values()].map((z) => [z.id, z]));
}

// ---------------------------------------------------------------- parsing helpers
const ACT = new Set(["COMBAT_INCOMING", "COMBAT_OUTGOING", "COMBAT_MISS"]);
const HIT = /^(.+?) hits (\S+) for (\d+) damage[!.]$/;
const SPELL_DMG = /^(You|\S+) (?:have|has) taken (\d+) damage from a spell\.$/;
const ENGAGE = /^You engage (.+) in combat!$/;
const JOIN = /^(.+) joins the fight!$/;
const KILL = /^You have (?:defeated|slain) (.+?) and gained (\d+) experience/;
const LEAVE = /^\[guard\] leaving: (\w+): (.*)$/;
const bandOf = (l) => (l <= 4 ? "1-4" : l <= 8 ? "5-8" : l <= 14 ? "9-14" : "15+");
const BANDS = ["1-4", "5-8", "9-14", "15+"];

function sampleIndex(samples) {
  const ts = samples.map((s) => s.t);
  return (t) => {
    let lo = 0;
    let hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

// ---------------------------------------------------------------- fights of one party
function fightsOf(party, zonesById) {
  const { events, samples } = party;
  const at = sampleIndex(samples);
  const memberNames = realNames();
  const fights = [];
  let cur = null;
  let lastClosed = null;
  let pendingEscape = null;
  const guardLevels = new Map(); // `${zone}|${name}` -> level the guard printed

  const open = (t) => {
    const s = samples[at(t)];
    cur = { start: t, last: t, zone: s?.zone ?? null, leaderLevel: s?.lvl ?? null, hits: [], spell: [], kills: [], joins: [], engages: [], deaths: [], escape: null };
    return cur;
  };
  const close = (why) => {
    if (!cur) return;
    cur.end = cur.last;
    cur.closedBy = why;
    fights.push(cur);
    lastClosed = cur;
    cur = null;
  };

  for (const e of events) {
    if (cur && e.t - cur.last > QUIET) close("quiet");
    const text = e.text;
    if (e.type === "guard") {
      const m = LEAVE.exec(text);
      if (m) {
        if (!cur) {
          // The guard fired on mobs that never touched the party, so no combat line opened a fight.
          open(e.t);
        }
        const lm = /^(.+?) L(\d+) against leader L(\d+)/.exec(m[2]);
        cur.escape = { t: e.t, trigger: m[1], detail: m[2], mob: lm ? normName(lm[1]) : null, mobLevel: lm ? Number(lm[2]) : null };
        if (lm) guardLevels.set(`${cur.zone}|${normName(lm[1])}`, Number(lm[2]));
        cur.last = Math.max(cur.last, e.t);
        pendingEscape = cur;
        close("escape");
      } else if (pendingEscape && /AutoLevel (running again|did NOT restart)/.test(text)) {
        pendingEscape.escape.secs = (e.t - pendingEscape.escape.t) / 1000;
        pendingEscape = null;
      }
      continue;
    }
    // Lines in the seconds after an escape still belong to the fight that was left: the client logs
    // the guard's "leaving" a few ms before the death that caused it and hits until the zone change.
    const tail = !cur && lastClosed?.escape && e.t - lastClosed.escape.t <= 4000 ? lastClosed : null;
    if (e.type === "DEATH") {
      if (!cur && !tail) open(e.t);
      const target = tail ?? cur;
      const slain = /^You have been slain by (.+)!$/.exec(text);
      const drowned = /^You have drowned/.test(text);
      const who = slain || drowned ? "me" : (/^(\S+) has been slain!$/.exec(text) ?? [])[1];
      if (who) target.deaths.push({ t: e.t, who, kind: who === "me" ? "leader" : memberNames.has(who) ? "member" : "pet", killer: slain ? normName(slain[1]) : null, drowned });
      if (!tail) cur.last = e.t;
      continue;
    }
    if (tail) {
      let tm;
      if (e.type === "COMBAT_INCOMING" && (tm = HIT.exec(text))) tail.hits.push({ t: e.t, mob: normName(tm[1].replace(/'s [A-Z].*$/, "")), victim: tm[2] === "you" ? "me" : tm[2], dmg: Number(tm[3]), proc: /'s [A-Z]/.test(tm[1]) });
      else if (e.type === "COMBAT_INCOMING" && (tm = SPELL_DMG.exec(text))) tail.spell.push({ t: e.t, victim: tm[1] === "You" ? "me" : tm[1], dmg: Number(tm[2]) });
      if (ACT.has(e.type)) continue;
    }
    const act = ACT.has(e.type) && !/^You are too far away/.test(text);
    const sys = e.type === "SYSTEM" || e.type === "EXPERIENCE_GAIN";
    let m;
    if (sys && (m = ENGAGE.exec(text))) {
      if (cur && cur.kills.length) close("next-engage");
      cur ??= open(e.t);
      cur.engages.push({ t: e.t, mob: normName(m[1]) });
      cur.last = e.t;
      continue;
    }
    if (sys && (m = JOIN.exec(text))) {
      cur ??= open(e.t);
      cur.joins.push({ t: e.t, mob: normName(m[1]) });
      cur.last = e.t;
      continue;
    }
    if (sys && (m = KILL.exec(text))) {
      cur ??= open(e.t);
      cur.kills.push({ t: e.t, mob: normName(m[1]), xp: Number(m[2]) });
      cur.last = e.t;
      continue;
    }
    if (e.type === "COMBAT_INCOMING") {
      if ((m = HIT.exec(text))) {
        cur ??= open(e.t);
        const mob = normName(m[1].replace(/'s [A-Z].*$/, ""));
        cur.hits.push({ t: e.t, mob, victim: m[2] === "you" ? "me" : m[2], dmg: Number(m[3]), proc: /'s [A-Z]/.test(m[1]) });
        cur.last = e.t;
        continue;
      }
      if ((m = SPELL_DMG.exec(text))) {
        cur ??= open(e.t);
        cur.spell.push({ t: e.t, victim: m[1] === "You" ? "me" : m[1], dmg: Number(m[2]) });
        cur.last = e.t;
        continue;
      }
    }
    if (act) {
      cur ??= open(e.t);
      cur.last = e.t;
    }
  }
  close("end");
  return finish(party, fights, zonesById, guardLevels, at, memberNames);
}

// A fight that starts with only a kill line, a spell tick or a death is a tail of the previous fight.
function finish(party, fights, zonesById, guardLevels, at, memberNames) {
  const { samples } = party;
  const out = [];
  for (const f of fights) {
    const i0 = at(f.start - 2000);
    const i1 = at(f.end + 1000);
    const window = samples.slice(i0, i1 + 1).filter((s) => s.t >= f.start - 2000 && s.t <= f.end + 1000);
    const maxHp = new Map();
    const minFrac = new Map();
    const levels = new Map();
    for (const s of window) {
      s.party.forEach(([n, hp, mx], k) => {
        if (n !== "me" && !memberNames.has(n)) return;
        if (mx > 0) maxHp.set(n, Math.max(maxHp.get(n) ?? 0, mx));
        if (mx > 0) minFrac.set(n, Math.min(minFrac.get(n) ?? 1, hp / mx));
        if (s.lv?.[k] != null) levels.set(n, s.lv[k]);
      });
    }
    const zone = zonesById.get(f.zone);
    const levelOf = (mob) => {
      const g = guardLevels.get(`${f.zone}|${mob}`);
      const c = zone?.mobs.get(mob);
      let level = g ?? null;
      let range = null;
      if (level == null && c) {
        const ls = [...new Set(c.map((x) => x.level))].sort((a, b) => a - b);
        // Several NPCs share a name in some zones. The median keeps the gap honest for the usual one.
        level = ls[Math.floor((ls.length - 1) / 2)];
        range = ls.length > 1 ? [ls[0], ls.at(-1)] : null;
      }
      if (level == null) return { level: null, src: null };
      const npc = c?.find((x) => x.level === level) ?? c?.[0];
      return { level, range, src: g != null ? "guard" : "content", npcMax: npc?.max ?? null, npcHp: npc?.hp ?? null, npcDelay: npc?.delay ?? null };
    };
    const hitters = new Map();
    for (const h of f.hits) {
      if (h.proc) continue; // "<mob>'s Spell hits X": the same mob's weapon hits are the melee lines
      const o = hitters.get(h.mob) ?? hitters.set(h.mob, { name: h.mob, hits: 0, dmg: 0, max: 0 }).get(h.mob);
      o.hits++;
      o.dmg += h.dmg;
      o.max = Math.max(o.max, h.dmg);
    }
    for (const h of f.hits) if (h.proc && !hitters.has(h.mob)) hitters.set(h.mob, { name: h.mob, hits: 0, dmg: 0, max: 0 });
    const mobs = [...hitters.values()].map((h) => ({ ...h, ...levelOf(h.name), npc: undefined }));
    // Every mob the log shows in the fight, hit or not: the guard's level rule looks at all of them.
    const engagedNames = [...new Set([...f.engages, ...f.joins, ...f.kills].map((x) => x.mob).concat([...hitters.keys()]))];
    const engaged = engagedNames.map((name) => ({ name, ...levelOf(name), npc: undefined }));
    const L = f.leaderLevel ?? samples[at(f.start)]?.lvl ?? null;
    // Damage per victim
    const victims = new Map();
    const addDmg = (v, t, d, kind) => {
      const o = victims.get(v) ?? victims.set(v, { name: v, dmg: 0, spell: 0, hits: [] }).get(v);
      o.dmg += d;
      if (kind === "spell") o.spell += d;
      o.hits.push([t, d]);
    };
    for (const h of f.hits) addDmg(h.victim, h.t, h.dmg, "melee");
    for (const h of f.spell) addDmg(h.victim, h.t, h.dmg, "spell");
    const dur = Math.max(1, (f.end - f.start) / 1000);
    const perMember = [...victims.values()].map((v) => {
      const mx = maxHp.get(v.name) ?? null;
      // Worst 6 s window of damage taken by this victim
      let peak = 0;
      const hs = v.hits.sort((a, b) => a[0] - b[0]);
      for (let a = 0, sum = 0, b = 0; b < hs.length; b++) {
        sum += hs[b][1];
        while (hs[b][0] - hs[a][0] > 6000) sum -= hs[a++][1];
        peak = Math.max(peak, sum);
      }
      return { name: v.name, kind: v.name === "me" ? "leader" : memberNames.has(v.name) ? "member" : "pet", dmg: v.dmg, spell: v.spell, dps: v.dmg / dur, maxHp: mx, peak6: peak, peakFrac: mx ? peak / mx : null, totalFrac: mx ? v.dmg / mx : null, minHpFrac: minFrac.get(v.name) ?? null };
    });
    const partyHp = [...maxHp].filter(([n]) => n === "me" || memberNames.has(n)).map(([, v]) => v);
    const real = f.deaths.filter((d) => d.kind !== "pet" && !d.drowned);
    const nMobs = Math.max(f.engages.length + f.joins.length, f.kills.length, hitters.size);
    const gaps = mobs.filter((m) => m.level != null && L != null).map((m) => m.level - L);
    const engagedGaps = engaged.filter((m) => m.level != null && L != null).map((m) => m.level - L);
    out.push({
      party: party.name,
      start: f.start,
      secs: dur,
      zone: f.zone,
      zoneName: zone?.long ?? null,
      leaderLevel: L,
      band: L == null ? null : bandOf(L),
      minMemberLevel: levels.size ? Math.min(...[...levels].filter(([n]) => n === "me" || memberNames.has(n)).map(([, v]) => v)) : null,
      minMaxHp: partyHp.length ? Math.min(...partyHp) : null,
      mobs,
      unknownLevelMobs: mobs.filter((m) => m.level == null).length,
      maxGap: gaps.length ? Math.max(...gaps) : null,
      nMobs,
      nHitters: hitters.size,
      kills: f.kills.length,
      xp: f.kills.reduce((s, k) => s + k.xp, 0),
      members: perMember,
      maxHit: Math.max(0, ...f.hits.map((h) => h.dmg)),
      dmgTaken: perMember.reduce((s, m) => s + m.dmg, 0),
      deaths: f.deaths,
      memberDeaths: real.length,
      drownings: f.deaths.filter((d) => d.drowned).length,
      engaged,
      maxGapEngaged: engagedGaps.length ? Math.max(...engagedGaps) : null,
      escape: f.escape,
      outcome: f.escape ? `escape:${f.escape.trigger}` : f.kills.length ? "kill" : "none",
      closedBy: f.closedBy,
      firstDeath: real.length ? Math.min(...real.map((d) => d.t)) : null,
      raw: {
        hits: f.hits,
        spell: f.spell,
        deaths: f.deaths,
        kills: f.kills,
        end: f.end,
        tl: window.map((s) => [s.t, s.party.filter(([n, , mx]) => (n === "me" || memberNames.has(n)) && mx > 0).map(([n, hp, mx]) => [n, hp, mx])]),
      },
    });
  }
  // Time to the next fight: what each outcome costs in cycle time.
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i < out.length; i++) {
    const n = out[i + 1];
    out[i].cycle = n && n.start - out[i].start < 20 * 60000 ? (n.start - out[i].start) / 1000 : null;
    out[i].toNext = n && n.start - out[i].raw.end < 20 * 60000 ? (n.start - out[i].raw.end) / 1000 : null;
  }
  return out;
}

// ---------------------------------------------------------------- coverage (hours of play per band)
function coverage(party) {
  const hours = Object.fromEntries(BANDS.map((b) => [b, 0]));
  const s = party.samples;
  for (let i = 1; i < s.length; i++) {
    const dt = s[i].t - s[i - 1].t;
    if (dt > 5000 || s[i - 1].lvl == null) continue;
    hours[bandOf(s[i - 1].lvl)] += dt / 3600000;
  }
  return hours;
}

// ---------------------------------------------------------------- main
const parties = await loadAll();
const zoneIds = new Set(parties.flatMap((p) => p.samples.map((s) => s.zone)).filter((z) => z != null));
const zonesById = await loadNpcs(zoneIds);
const all = [];
const hours = Object.fromEntries(BANDS.map((b) => [b, 0]));
for (const p of parties) {
  const fs = fightsOf(p, zonesById);
  all.push(...fs);
  const c = coverage(p);
  for (const b of BANDS) hours[b] += c[b];
}

if (flag("dump")) {
  for (const f of all) console.log(JSON.stringify({ ...f, raw: undefined }));
  process.exit(0);
}

// ---------------------------------------------------------------- report
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const f1 = (v) => (v == null || !Number.isFinite(v) ? "-" : v.toFixed(1));
const pad = (v, n) => String(v).padStart(n);
const out = (s = "") => console.log(s);
// `testGuard` escapes are forced by hand, not danger.
const fights = all.filter((f) => f.band && f.escape?.trigger !== "test");
const inBand = (b) => fights.filter((f) => f.band === b);
// A fight the guard left for a reason other than a death has no observed outcome: whether it would
// have ended in a death is unknown. Tables on deaths use the others.
const natural = (f) => !f.escape || f.escape.trigger === "down";
const died = (f) => f.memberDeaths > 0;
const leaderDied = (f) => f.deaths.some((d) => d.kind === "leader" && !d.drowned);
const totalHours = sum(BANDS.map((b) => hours[b]));

out(`Fights ${fights.length} from ${parties.length} parties, ${totalHours.toFixed(1)} h of samples, ${sum(fights.map((f) => f.kills))} kills, ${sum(fights.map((f) => f.memberDeaths))} member or leader deaths (${sum(fights.map((f) => f.deaths.filter((d) => d.kind === "pet").length))} pet deaths and ${sum(fights.map((f) => f.drownings))} drownings not counted).`);
out("\n1. Per leader level band: escapes by trigger, deaths");
out("band    hours fights | escapes level hit down healer | esc/h | fights with a death, per 100 | deaths/h (leader deaths/h)");
for (const b of BANDS) {
  const fs = inBand(b);
  const esc = (t) => fs.filter((f) => f.escape?.trigger === t).length;
  const dd = fs.filter(died);
  const nEsc = fs.filter((f) => f.escape).length;
  const deaths = sum(fs.map((f) => f.memberDeaths));
  const leaderDeaths = sum(fs.map((f) => f.deaths.filter((d) => d.kind === "leader" && !d.drowned).length));
  out(`${b.padEnd(5)} ${pad(hours[b].toFixed(1), 6)} ${pad(fs.length, 6)} | ${pad(esc("level"), 14)} ${pad(esc("hit"), 3)} ${pad(esc("down"), 4)} ${pad(esc("healer"), 6)} | ${pad(f1(nEsc / hours[b]), 5)} | ${pad(dd.length, 4)} ${pad(f1((100 * dd.length) / fs.length), 5)}               | ${pad(f1(deaths / hours[b]), 5)} (${f1(leaderDeaths / hours[b])})`);
}

// ---- 2. Deaths against the danger signals, natural fights with damage taken only
const taken = fights.filter((f) => natural(f) && f.dmgTaken > 0);
const gapBucket = (g) => (g == null ? "unknown" : g <= 0 ? "<=0" : g <= 1 ? "1" : g <= 3 ? "2-3" : g <= 5 ? "4-5" : g <= 7 ? "6-7" : ">=8");
const realMembers = (f) => f.members.filter((m) => m.kind !== "pet" && m.maxHp);
// Worst victim's average incoming damage as % of its max HP per second of the fight.
const dpsFrac = (f) => {
  const ms = realMembers(f);
  return ms.length ? Math.max(...ms.map((m) => m.dps / m.maxHp)) * 100 : null;
};
const dpsB = (v) => (v == null ? "unknown" : v < 1 ? "<1" : v < 2 ? "1-2" : v < 4 ? "2-4" : v < 8 ? "4-8" : ">=8");
const atkB = (f) => (f.nMobs <= 1 ? "1" : f.nMobs === 2 ? "2" : f.nMobs === 3 ? "3" : "4+");
// What the hitters could do at most: their content max hit per swing delay, as a share of the weakest
// victim's max HP per second. 0.1 means the weakest victim dies in 10 s if every mob hits for its max.
const threatOf = (f) => {
  const hp = Math.min(...realMembers(f).map((m) => m.maxHp));
  const known = f.mobs.filter((m) => m.npcMax != null);
  return known.length && Number.isFinite(hp) ? sum(known.map((m) => m.npcMax / m.npcDelay)) / hp : null;
};
const thrB = (f) => {
  const v = threatOf(f);
  return v == null ? "unknown" : v < 0.05 ? "<0.05" : v < 0.1 ? "0.05-0.1" : v < 0.2 ? "0.1-0.2" : v < 0.4 ? "0.2-0.4" : ">=0.4";
};
const table = (title, rowsOrder, key) => {
  out(`\n${title}`);
  out(`${"".padEnd(9)}${BANDS.map((b) => pad(b, 11)).join("")}`);
  for (const r of rowsOrder) {
    const cells = BANDS.map((b) => {
      const fs = taken.filter((f) => f.band === b && key(f) === r);
      return pad(fs.length ? `${fs.filter(died).length}/${fs.length}` : ".", 11);
    });
    out(`${r.padEnd(9)}${cells.join("")}`);
  }
};
out("\n2. Fights with a member or leader death / fights, by danger signal (fights not left for level, hit or healer, with damage taken)");
table("2a. highest level gap (mob level - leader level) among mobs that hit someone", ["<=0", "1", "2-3", "4-5", "6-7", ">=8", "unknown"], (f) => gapBucket(f.maxGap));
table("2b. worst victim's average incoming damage, % of its max HP per second of the fight", ["<1", "1-2", "2-4", "4-8", ">=8", "unknown"], (f) => dpsB(dpsFrac(f)));
table("2c. mobs in the fight (engage + joins, at least the kills and the mobs that hit)", ["1", "2", "3", "4+"], atkB);
table("2d. hitters' content max damage per second / weakest victim's max HP", ["<0.05", "0.05-0.1", "0.1-0.2", "0.2-0.4", ">=0.4", "unknown"], thrB);

// ---- 3. Cost of the escapes
out("\n3. What escapes and deaths cost: fight seconds + seconds from its end to the next fight start");
const cat = (f) => (leaderDied(f) ? "leader death" : f.memberDeaths ? "member death" : f.escape ? `escape ${f.escape.trigger}` : f.outcome);
const cyc = (f) => (f.secs ?? 0) + (f.toNext ?? NaN);
const groups = new Map();
for (const f of fights) (groups.get(cat(f)) ?? groups.set(cat(f), []).get(cat(f))).push(f);
const costOf = (c) => mean((groups.get(c) ?? []).map(cyc).filter(Number.isFinite));
const nextOf = (c) => mean((groups.get(c) ?? []).map((f) => f.toNext).filter((v) => v != null));
for (const [c, fs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  out(`  ${c.padEnd(15)} n=${pad(fs.length, 4)} fight ${pad(f1(mean(fs.map((f) => f.secs))), 5)} s + next ${pad(f1(nextOf(c)), 5)} s = ${pad(f1(costOf(c)), 5)} s${c === "kill" ? `  (${f1(mean(fs.map((f) => f.kills)))} kills)` : ""}`);
}
const lvEsc = fights.filter((f) => f.escape?.trigger === "level");
const idle = (f) => f.dmgTaken === 0 && f.kills === 0 && f.engaged.length === 0;
out(`  level escapes ${lvEsc.length}: no combat line at all ${lvEsc.filter(idle).length}, the named mob hit someone ${lvEsc.filter((f) => f.mobs.some((m) => m.name === f.escape.mob)).length}, a member took damage ${lvEsc.filter((f) => f.dmgTaken > 0).length}, a member died ${lvEsc.filter(died).length}`);
out("  escapes per party-hour   level / hit / down / healer");
for (const b of BANDS) {
  const fs = inBand(b);
  const n = (t) => fs.filter((f) => f.escape?.trigger === t).length;
  const r = (t) => pad(f1(n(t) / hours[b]), 5);
  out(`    ${b.padEnd(5)} ${r("level")} ${r("hit")} ${r("down")} ${r("healer")}   level escapes use ${f1((100 * n("level") * costOf("escape level")) / (hours[b] * 3600))}% of the time, down escapes with their deaths ${f1((100 * n("down") * costOf("member death")) / (hours[b] * 3600))}%`);
}

// ---- 4. Comparable fights without an escape
out("\n4. Level escapes against comparable fights that were not escaped (same zone, leader level +-2, mob engaged)");
{
  const byMob = new Map();
  for (const e of lvEsc) {
    const k = `${e.escape.mob} L${e.escape.mobLevel}`;
    (byMob.get(k) ?? byMob.set(k, []).get(k)).push(e);
  }
  out("  mob (level the guard saw)    escapes  leader lv | comparable fights: n, mob hit someone, kill, death, leader death");
  for (const [k, es] of [...byMob].sort((a, b) => b[1].length - a[1].length).slice(0, 9)) {
    const comp = fights.filter((f) => natural(f) && es.some((e) => f.zone === e.zone && Math.abs(f.leaderLevel - e.leaderLevel) <= 2) && f.engaged.some((m) => m.name === es[0].escape.mob));
    const lv = es.map((e) => e.leaderLevel);
    out(`  ${k.padEnd(28)} ${pad(es.length, 6)}  ${pad(Math.min(...lv) + "-" + Math.max(...lv), 7)} | ${pad(comp.length, 3)} ${pad(comp.filter((f) => f.mobs.some((m) => m.name === es[0].escape.mob)).length, 3)} ${pad(comp.filter((f) => f.kills).length, 3)} ${pad(comp.filter(died).length, 3)} ${pad(comp.filter(leaderDied).length, 3)}`);
  }
  out("  fights not left early, by the highest gap among mobs that hit (leader level 1-8 | 9+): fights, with a death, with a leader death");
  for (const [lo, hi] of [[2, 3], [4, 5], [6, 7], [8, 99]]) {
    const cell = (l0, l1) => {
      const fs = fights.filter((f) => natural(f) && f.maxGap != null && f.maxGap >= lo && f.maxGap <= hi && f.leaderLevel >= l0 && f.leaderLevel <= l1);
      return `${pad(fs.length, 4)} ${pad(fs.filter(died).length, 3)} ${pad(fs.filter(leaderDied).length, 3)}`;
    };
    out(`    gap ${(hi === 99 ? `${lo}+` : `${lo}-${hi}`).padEnd(4)} ${cell(1, 8)}  |  ${cell(9, 99)}`);
  }
}

// ---- 4b. Which level escapes were on mobs that ever hit anyone
{
  // Zone-independent: a name seen in any "<mob> hits <member>" line of any fight, including escaped ones.
  const hitNames = new Set(fights.flatMap((f) => f.mobs.map((m) => m.name)));
  out("\n4b. Level escapes by whether the named mob hit anyone in any fight of any log (it cannot if the party always leaves first)");
  for (const b of BANDS) {
    const es = inBand(b).filter((f) => f.escape?.trigger === "level");
    const seen = es.filter((f) => hitNames.has(f.escape.mob));
    out(`  ${b.padEnd(5)} ${pad(es.length, 4)} level escapes: ${pad(seen.length, 4)} on mobs seen hitting (${f1(seen.length / hours[b])}/h), ${pad(es.length - seen.length, 4)} on mobs never seen hitting (${f1((es.length - seen.length) / hours[b])}/h)`);
  }
}

// ---- 4c. What the down escape leaves behind: the survivors' state when a member died
{
  out("\n4c. Member deaths ended by the down escape (not the leader): the survivors when the member died");
  const ds = fights.filter((f) => f.escape?.trigger === "down" && f.memberDeaths && !leaderDied(f) && f.leaderLevel <= 14);
  let safe = 0;
  for (const f of ds) {
    const t = f.firstDeath;
    const row = f.raw.tl.filter(([st]) => st <= t).at(-1);
    if (!row) continue;
    const dead = new Set(f.deaths.map((d) => d.who));
    const surv = row[1].filter(([n, hp]) => !dead.has(n) && hp > 0);
    const rate = (n) => sum([...f.raw.hits, ...f.raw.spell].filter((h) => h.victim === n && h.t <= t && h.t > t - 6000).map((h) => h.dmg)) / 6;
    const minFrac = Math.min(...surv.map(([, hp, mx]) => hp / mx));
    const ttd = Math.min(...surv.map(([n, hp]) => (rate(n) > 0 ? hp / rate(n) : Infinity)));
    if (minFrac >= 0.5 && ttd >= 10) safe++;
  }
  out(`  ${ds.length} fights (leader level <= 14): survivors all >= 50% HP and >= 10 s from death at the member's death in ${safe} (${f1((100 * safe) / Math.max(1, ds.length))}%); fight so far ${f1(mean(ds.map((f) => f.secs)))} s, kills so far ${f1(mean(ds.map((f) => f.kills)))}, mobs ${f1(mean(ds.map((f) => f.nMobs)))}`);
  const stay = fights.filter((f) => !f.escape && f.memberDeaths && !leaderDied(f));
  out(`  Fights where a member died and the guard did not leave: ${stay.length}, ${stay.filter((f) => f.kills).length} ended in a kill; leader deaths without an escape ${fights.filter((f) => !f.escape && leaderDied(f)).length}`);
}

// ---------------------------------------------------------------- replay of danger rules
// Rules see what the guard can see once a second: each member's HP and max HP (samples), the damage
// it took in the last 6 s (log lines) and the mobs that have hit someone so far with their levels.
function timeline(f) {
  const dmg = new Map();
  for (const h of [...f.raw.hits, ...f.raw.spell]) (dmg.get(h.victim) ?? dmg.set(h.victim, []).get(h.victim)).push([h.t, h.dmg]);
  const firstHit = new Map();
  for (const h of f.raw.hits) if (!firstHit.has(h.mob)) firstHit.set(h.mob, h.t);
  const info = new Map(f.mobs.map((m) => [m.name, m]));
  const endT = f.escape ? f.escape.t : f.raw.end + 1000;
  const rows = [];
  for (const [t, mem] of f.raw.tl) {
    if (t < f.start - 1000 || t > endT) continue;
    const row = { t, el: Math.max(0, (t - f.start) / 1000), ttd: Infinity, fracHit: 1, frac: 1, leaderTtd: Infinity, leaderFrac: 1, gap: -99, thr: 0 };
    let hurtMx = Infinity;
    for (const [n, hp, mx] of mem) {
      const taken6 = sum((dmg.get(n) ?? []).filter(([ht]) => ht <= t && ht > t - 6000).map(([, d]) => d));
      const fr = hp / mx;
      row.frac = Math.min(row.frac, fr);
      if ((dmg.get(n) ?? []).some(([ht]) => ht <= t)) hurtMx = Math.min(hurtMx, mx);
      if (taken6 > 0) {
        row.fracHit = Math.min(row.fracHit, fr);
        row.ttd = Math.min(row.ttd, hp / (taken6 / 6));
        if (n === "me") {
          row.leaderFrac = fr;
          row.leaderTtd = hp / (taken6 / 6);
        }
      }
    }
    let dps = 0;
    for (const [m, ht] of firstHit) {
      if (ht > t) continue;
      const i = info.get(m);
      if (i?.level != null && f.leaderLevel != null) row.gap = Math.max(row.gap, i.level - f.leaderLevel);
      if (i?.npcMax != null) dps += i.npcMax / i.npcDelay;
    }
    row.thr = Number.isFinite(hurtMx) ? dps / hurtMx : 0;
    rows.push(row);
  }
  return rows;
}
const rules = [
  ["hitter gap >= 3", (r) => r.gap >= 3],
  ["hitter gap >= 4", (r) => r.gap >= 4],
  ["hitter gap >= 5", (r) => r.gap >= 5],
  ["hitter gap >= 6", (r) => r.gap >= 6],
  ["hitter gap >= 8 (today's gap, hitters only)", (r) => r.gap >= 8],
  ["threat >= 0.10", (r) => r.thr >= 0.1],
  ["threat >= 0.15", (r) => r.thr >= 0.15],
  ["threat >= 0.20", (r) => r.thr >= 0.2],
  ["any member <= 50% HP, dead in <= 4 s", (r) => r.ttd <= 4 && r.fracHit <= 0.5],
  ["any member <= 35% HP, dead in <= 4 s", (r) => r.ttd <= 4 && r.fracHit <= 0.35],
  ["leader <= 50% HP, dead in <= 4 s", (r) => r.leaderTtd <= 4 && r.leaderFrac <= 0.5],
  ["leader <= 50% HP, dead in <= 6 s", (r) => r.leaderTtd <= 6 && r.leaderFrac <= 0.5],
  ["gap >= 5 or leader <= 50% HP, dead in <= 6 s", (r) => r.gap >= 5 || (r.leaderTtd <= 6 && r.leaderFrac <= 0.5)],
  ["gap >= 4 or leader <= 50% HP, dead in <= 6 s", (r) => r.gap >= 4 || (r.leaderTtd <= 6 && r.leaderFrac <= 0.5)],
  ["threat >= 0.15 or leader <= 50% HP, dead in <= 6 s", (r) => r.thr >= 0.15 || (r.leaderTtd <= 6 && r.leaderFrac <= 0.5)],
  ["gap >= 6 or leader <= 50% HP, dead in <= 4 s", (r) => r.gap >= 6 || (r.leaderTtd <= 4 && r.leaderFrac <= 0.5)],
  ["gap >= 6 or any member <= 35% HP, dead in <= 4 s", (r) => r.gap >= 6 || (r.ttd <= 4 && r.fracHit <= 0.35)],
  ["gap >= 5 or any member <= 35% HP, dead in <= 4 s", (r) => r.gap >= 5 || (r.ttd <= 4 && r.fracHit <= 0.35)],
];
// Time lost with an escape at a row: the fight so far plus the way back. The way back is short when
// nobody is hurt (what level escapes cost) and as long as the healer escapes' when the party is.
const backHurt = nextOf("escape healer");
const backClean = nextOf("escape level");
const escCost = (row) => row.el + (row.frac < 0.7 ? backHurt : backClean);

out("\n5. Replay of escape rules on fights with an observed outcome (not left for level, hit or healer)");
out("   saved = fights with a death where the rule fires >= 0.5 s before it, extra = fights without a death where it fires,");
out("   gain = seconds per party-hour: (what the death fight cost - what the escape costs) for saved, minus the escape's cost for extra");
const replayed = taken.map((f) => ({ f, rows: timeline(f) }));
for (const [lo, hi, label, bands] of [[1, 8, "leader level 1-8", ["1-4", "5-8"]], [9, 99, "leader level 9+", ["9-14", "15+"]]]) {
  const h = sum(bands.map((b) => hours[b]));
  const rs = replayed.filter(({ f }) => f.leaderLevel >= lo && f.leaderLevel <= hi);
  const dfs = rs.filter(({ f }) => died(f));
  const deathsNow = sum(dfs.map(({ f }) => f.memberDeaths));
  out(`  ${label}: ${h.toFixed(1)} h, ${rs.length} fights with damage, ${dfs.length} with a death (${dfs.filter(({ f }) => leaderDied(f)).length} leader), ${f1(deathsNow / h)} deaths/h, ${f1(sum(dfs.map(({ f }) => (Number.isFinite(cyc(f)) ? cyc(f) : costOf(cat(f))))) / h)} s/h lost to them, ${f1(rs.filter(({ f }) => f.escape).length / h)} escapes/h`);
  out(`    ${"rule".padEnd(52)} saved (leader) extra  escapes/h  deaths/h  gain s/h   lead s`);
  for (const [name, pred] of rules) {
    let saved = 0;
    let savedDeaths = 0;
    let savedLeader = 0;
    let extra = 0;
    let gain = 0;
    const lead = [];
    for (const { f, rows } of rs) {
      const row = rows.find(pred);
      if (!row) continue;
      if (died(f)) {
        if (row.t < f.firstDeath - 500) {
          saved++;
          savedDeaths += f.memberDeaths;
          if (leaderDied(f)) savedLeader++;
          lead.push((f.firstDeath - row.t) / 1000);
          gain += (Number.isFinite(cyc(f)) ? cyc(f) : costOf(cat(f))) - escCost(row);
        }
      } else {
        extra++;
        gain -= escCost(row);
      }
    }
    out(`    ${name.padEnd(52)} ${pad(saved, 4)} (${pad(savedLeader, 2)})  ${pad(extra, 5)}  ${pad(f1((saved + extra) / h), 9)} ${pad(f1((deathsNow - savedDeaths) / h), 9)} ${pad(f1(gain / h), 9)} ${pad(f1(mean(lead)), 8)}`);
  }
}

// ---- 6. Today's guard against the recommended rule, per band
// Recommended: a mob counts for the level rule only once it has hit someone, at gap >= 6; leave when the
// leader is <= 50% HP and would be dead in <= 4 s; no escape for a level gap on a mob that has never
// been seen hitting anyone; healer, hit and down escapes as they are. Escapes on mobs never seen hitting
// are assumed harmless, which the logs cannot confirm (the guard always left before they could act).
out("\n6. Today's guard against the recommended rule (per party-hour; time lost = fight seconds + seconds to the next fight, of fights that gave no kill or ended in a death)");
out("   rule: level escape only after the mob has hit someone, hitter gap >= 6, or leader <= 50% HP and dead in <= 4 s at the last 6 s's damage rate");
{
  const hitNames = new Set(fights.flatMap((f) => f.mobs.map((m) => m.name)));
  const rule = (r) => r.gap >= 6 || (r.leaderTtd <= 4 && r.leaderFrac <= 0.5);
  const rowsOf = new Map(replayed.map(({ f, rows }) => [f, rows]));
  const loss = (f) => (Number.isFinite(cyc(f)) ? cyc(f) : costOf(cat(f)));
  out("  band    | escapes/h today -> rule | deaths/h (leader) today -> rule | time lost % today -> rule | level escapes dropped per h");
  for (const b of BANDS) {
    const h = hours[b];
    let escNow = 0;
    let escNew = 0;
    let dNow = 0;
    let dNew = 0;
    let lNow = 0;
    let lNew = 0;
    let lossNow = 0;
    let lossNew = 0;
    let dropped = 0;
    for (const f of inBand(b)) {
      if (f.escape?.trigger === "test") continue;
      dNow += f.memberDeaths;
      lNow += f.deaths.filter((d) => d.kind === "leader" && !d.drowned).length;
      if (f.escape) escNow++;
      const bad = f.escape || died(f);
      if (bad) lossNow += loss(f);
      const rows = rowsOf.get(f);
      if (f.escape && !natural(f)) {
        // Escapes the replay cannot judge: kept, except level escapes on mobs never seen hitting.
        if (f.escape.trigger === "level" && !hitNames.has(f.escape.mob)) {
          dropped++;
          continue;
        }
        escNew++;
        lossNew += loss(f);
        continue;
      }
      const row = rows?.find(rule);
      if (row && (!died(f) || row.t < f.firstDeath - 500)) {
        escNew++;
        lossNew += escCost(row);
        continue; // deaths of this fight did not happen
      }
      dNew += f.memberDeaths;
      lNew += f.deaths.filter((d) => d.kind === "leader" && !d.drowned).length;
      if (f.escape) escNew++;
      if (bad) lossNew += loss(f);
    }
    const pctT = (v) => f1((100 * v) / (h * 3600));
    out(`  ${b.padEnd(7)} | ${pad(f1(escNow / h), 5)} -> ${pad(f1(escNew / h), 5)}          | ${pad(f1(dNow / h), 4)} (${f1(lNow / h)}) -> ${pad(f1(dNew / h), 4)} (${f1(lNew / h)})       | ${pad(pctT(lossNow), 5)}% -> ${pad(pctT(lossNew), 5)}%     | ${f1(dropped / h)}`);
  }
}
