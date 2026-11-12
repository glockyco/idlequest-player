#!/usr/bin/env bun
// Predict XP per hour per character for every zone at a party level, from the content snapshot and
// the client's own combat formulas, so a zone can be chosen before the party goes there.
//
//   bun tools/predict.mjs --level 25 [--top 15]          ranked table of zones
//   bun tools/predict.mjs --level 25 --zone permafrost   per-NPC breakdown of one zone (regex on short or long name)
//   bun tools/predict.mjs --level 29 --spells [--zone unrest]  compare nuke/tactic policies
//   bun tools/predict.mjs --check                        model vs the measured runs
//   More flags: --con 10,13 (AutoLevel's minimum and maximum con, instead of --min-diff and --max-diff), --crowd N
//   (other groups hunting the same spawns), --detour, --dps-curve '[[1,0.5],[14,0.4],[18,1]]' or off, --mana-exp,
//   --no-depletion. bun tools/calibrate.mjs measures the model against the live runs and refits these.
// Model, per zone:
//   1. Candidates. Every spawn point (spawn2 version 0) holds one NPC of its spawn group, drawn by
//      spawnentry chance. An NPC is a candidate when its level is in [P+min-diff, P+max-diff] and not
//      green. AutoLevel's con rule (OK.pretty.js Fi/Di) makes green every level below P+Di(P), with
//      Di = -3 up to level 12, then one lower every 4 levels. A point counts for the share of its
//      chance mass that is candidates.
//   2. Party DPS against an NPC is --dps, measured against a same-level mob, scaled as (P/--dps-level)^--dps-exp
//      for the leader's level and by the DEFAULTS.dpsCurve multiplier below level 18, then split into a melee share and a spell share (--spell-share). Melee is
//      scaled by the client's hit chance and AC mitigation at the NPC's level against the same-level case
//      (main.pretty.js ap/kt/bt/ep/Tt). Spells are scaled by the client's resist model (BYHOoN7B.js Ss/Qm).
//      NPCs with special ability 19 lose the melee share, those with 23 lose the non-magical part of it
//      (--magic-melee), and magic-immune NPCs lose the spell share.
//   3. NPC damage to the tank is the client's NPC attack roll (sp/ep/NE): hit chance from NPC accuracy
//      against the tank's avoidance, damage from mindmg to maxdmg by NPC offense against --tank-ac,
//      attacks per round from attack_count or the double attack chance, per attack_delay.
//   4. After a kill everyone refills 2.5% of max HP/mana per 0.6 s. Recovery is the slowest of the
//      tank's HP (damage taken), the healer's mana (healing the damage) and the lead caster's mana
//      (--mana-per-sec for each second of fight, scaled down below --dps-level by --mana-exp), plus --overhead seconds
//      of readiness wait.
//   5. Walking is --detour times the mean distance from a candidate point to its nearest other candidate, divided by --speed.
//      Every kill empties its point until the respawn, so the nearest live candidate is 1/sqrt(f) times as far,
//      with f the alive share of the candidate points over the stay. The party's own kills lower f, and so do
//      those of --crowd other groups hunting the same candidates (--no-depletion turns it off).
//   6. Kills per hour is 3600 over the mean of kill + recovery + walk + overhead. It cannot exceed
//      the spawn rate: candidate mass x 3600 / respawn, plus the initial stock spread over --stay minutes,
//      shared with the --crowd other groups. The ranked XP/h uses the smaller of the two.
//   7. XP per kill for the leader is 120 x NPC level^2 x zone multiplier x leader level / sum of party
//      levels, at most 11% of a level (3000 x level^2).
//
// Left out: wandering and named spawns beyond their chance, NPC spells and procs, enrage and rampage
// timing (counted as a fixed extra damage), crowd control, pets as separate damage dealers, loot and
// platinum, other players than the account's own groups taking spawns, escapes and deaths (1 to 4% of the
// time in stretches of 20 minutes or more, 13% at levels 1 to 4 in tools/fights.mjs), spawn conditions and
// content flags, zone line travel and the time to reach the zone. The calibration runs are in
// docs/plans/leveling-plan.md (Measuring) and
// tools/calibrate.mjs measures the model against every live run, per level band and zone.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { liveSpawnRows, rows as contentRows } from "./lib/content.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const raw = (n) => (has(n) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const num = (n, d) => (raw(n) === undefined ? d : Number(raw(n)));
const list = (n, d) => (raw(n) === undefined ? d : raw(n).split(",").map(Number));

// Fitted in two steps. Level 21 to 29: the three measured runs (docs/plans/leveling-plan.md, "The XP model's calibration cases"), which
// `bun tools/predict.mjs --check` prints (XP/h within 7%). Levels 1 to 20: the live stretches of
// `bun tools/calibrate.mjs --fit`, which also refits the walk and the mana spend below. dps and overhead sit between
// the three runs (best blocks) and group 1's 20-minute stretches at 15 to 34 (measured about 10% under the model).
export const DEFAULTS = {
  dps: 52, // party damage per second against a same-level mob at --dps-level
  dpsLevel: 24, // leader level --dps was measured at
  dpsExp: 0.5, // DPS grows with the leader's level to this power
  spellShare: 0.3, // share of party damage from spells (the rest is melee and pets)
  nukeResist: "fr", // resist stat the spell share rolls against: mr, fr, cr, dr, pr
  overhead: 1.5, // seconds per kill of readiness wait, target selection and engage. Measured idle is 1 to 3 s.
  manaPerSec: 10, // mana the lead caster spends per fight second at --dps-level
  manaExp: 0.57, // below --dps-level the spend scales with (P/--dps-level)^this, as the spells' costs do. Fitted to the recovery seconds of levels 1 to 14, where a constant spend gave twice the measured.
  // Pools at --dps-level, scaled linearly with the party level. At 31 to 32 the linear rule is within
  // 5% of group 1's tank HP (1478), healer mana (765) and caster mana (863).
  tankHp: 1060,
  healerManaPool: 560,
  casterManaPool: 680,
  // Share of melee and pet damage from magical hits (magic weapons, pets of level 10 or more), which
  // special ability 23 does not stop (main.pretty.js:63308-63341). All of group 1's weapons and pets
  // are magical.
  magicMelee: 1,
  healCost: 0.25, // healer mana per HP of damage taken
  tankAc: 200, // the tank's mitigation AC as the client uses it (an assumption)
  speed: 35, // units per second while moving. Measured 37 to 38 at levels 1 to 13 and 42 to 48 for group 1 at 33 and up, so speed is not the lever.
  detour: 2.5, // walked distance over the straight line to the nearest candidate point. Fitted to the move seconds of 85 stretches at every level (measured 2.4 to 2.5 whichever levels are fitted): the party walks around terrain and past dead points the nearest-point rule does not know.
  // Multiplier on the party damage below level 18, as [level, multiplier] knots, flat below the first and linear
  // between. Fitted to the fight seconds and XP/h of group 1 at levels 3 to 20 and groups 2 to 12 at 1 to 14 (66
  // stretches of 20 minutes or more, 35 h, Crushbone left out): the party deals about half of the (P/24)^0.5 curve
  // up to level 14 (0.53 at level 1, 0.42 at 14) and the full curve from 18. Between 14 and 18 only group 1's
  // Kurn's Tower stretches (15 to 17) tell, and they fit the straight line.
  dpsCurve: [
    [1, 0.53],
    [14, 0.42],
    [18, 1],
  ],
  stay: 60, // minutes spent in the zone, which spreads the initial stock
};
// --con 10,13 gives the AutoLevel minimum and maximum con instead of --min-diff and --max-diff.
const conFlag = has("con") ? (([a, b]) => (P) => conLimits(P, a, b))(list("con")) : null;
export const cfgFromFlags = (P) => ({
  level: P,
  // The bot runs AutoLevel from Blue up, so every non-green enemy is a candidate and only the con
  // rule sets the lower edge. A tighter --min-diff drops the kills 4 to 8 levels below the leader
  // that the party makes at 22 to 31.
  minDiff: num("min-diff", conFlag?.(P).minDiff ?? -99),
  maxDiff: num("max-diff", conFlag?.(P).maxDiff ?? 5),
  dpsCurve: has("dps-curve") ? (raw("dps-curve") === "off" ? null : JSON.parse(raw("dps-curve"))) : DEFAULTS.dpsCurve,
  depletion: !has("no-depletion"),
  dps: num("dps", DEFAULTS.dps),
  dpsLevel: num("dps-level", DEFAULTS.dpsLevel),
  dpsExp: num("dps-exp", DEFAULTS.dpsExp),
  spellShare: num("spell-share", DEFAULTS.spellShare),
  nukeResist: (raw("nuke-resist") ?? DEFAULTS.nukeResist).toUpperCase(),
  overhead: num("overhead", DEFAULTS.overhead),
  manaPerSec: num("mana-per-sec", DEFAULTS.manaPerSec * Math.min(1, P / DEFAULTS.dpsLevel) ** num("mana-exp", DEFAULTS.manaExp)),
  tankHp: num("tank-hp", (DEFAULTS.tankHp * P) / DEFAULTS.dpsLevel),
  healerManaPool: num("healer-mana-pool", (DEFAULTS.healerManaPool * P) / DEFAULTS.dpsLevel),
  casterManaPool: num("caster-mana-pool", (DEFAULTS.casterManaPool * P) / DEFAULTS.dpsLevel),
  magicMelee: num("magic-melee", DEFAULTS.magicMelee),
  healCost: num("heal-cost", DEFAULTS.healCost),
  tankAc: num("tank-ac", DEFAULTS.tankAc),
  speed: num("speed", DEFAULTS.speed),
  detour: num("detour", DEFAULTS.detour),
  crowd: num("crowd", 0),
  stay: num("stay", DEFAULTS.stay),
  partyLevels: list("party-levels", null),
});

const content = raw("content") ?? process.env.IQ_CONTENT ?? `${homedir()}/src/github.com/brynnb/idlequest-content`;
const REGEN_PER_SEC = 0.025 / 0.6; // wiki "Companions": 2.5% of max HP/mana every 0.6 s
const MIN_ALIVE = 0.04; // floor of the alive share of candidate points
const LINK = 70; // aggro radius plus a margin to join, as tools/zones.mjs
const ARRIVAL = 150;
const HIGH = 8; // NPCs this many levels above the leader are danger

// ---------------------------------------------------------------- client formulas
// Level -> lowest non-green offset, OK.pretty.js Di().
const conOffset = (p) => (p <= 12 ? -3 : p <= 57 ? -4 - Math.floor((Math.max(p, 14) - 14) / 4) : -15);
// The level range AutoLevel pulls from for a minimum and maximum con (con values: 2 green, 4 blue, 10 white,
// 15 yellow, 13 red), as offsets from the leader's level. Blue starts at the lowest non-green level, white is
// the leader's own level, and the maximum con sets the level cap (white 0, yellow 2, red 5, where yellow
// reaches 3, 4 or 5 levels up above level 50, 53 and 56). OSTsR53r.js g21/v21 and setMaxCon.
export const conLimits = (P, minCon = 4, maxCon = 13) => ({
  minDiff: minCon >= 10 ? 0 : -99,
  maxDiff: maxCon === 10 ? 0 : maxCon === 15 ? (P > 56 ? 5 : P > 53 ? 4 : P > 50 ? 3 : 2) : 5,
});
const skillOf = (l) => (Math.trunc(l) > 50 ? 250 : Math.min(210, Math.max(1, Math.trunc(l)) * 5)); // main.pretty.js j5
const accuracy = (a, extra = 0, mod = 0) => ((2 * a + 7 + extra + 10) * 121 / 100) * Math.max(0, 100 + mod) / 100; // kt(a, a, extra, mod) for NPCs, kt(skill, skill) for players
const avoidance = (def, agi) => Math.max(0, (def * 400) / 225 + 10 + ((Math.min(255, Math.max(1, agi)) - 40) * 800) / 3600); // bt
const hitProb = (att, def) => (att <= 0 ? 0 : def <= 0 ? 1 : att >= def ? 1 - def / (2 * att) : att / (2 * def)); // P(rand*att > rand*def), ed()
const npcOffense = (l) => {
  // NE(l)
  const s = l >= 46 && l <= 50 ? 45 : Math.max(1, Math.trunc(l));
  const n = s < 6 ? s * 4 : Math.min(320, Math.floor(s * 5.5) - 4);
  const i = s < 6 ? s : s < 30 ? Math.floor(s / 2) + 1 : s * 2 - 40;
  return Math.max(1, n + Math.max(0, i));
};
// Tt(ac, level) without gear: the level term, or the NPC's own AC once the level term reaches 200 (level 53 up).
const npcMitAc = (l, ac = 0) => {
  const i = l < 15 ? l * 3 + (l < 3 ? 2 : 0) : Math.min(200, Math.floor(l * 4.1) - 15);
  return i === 200 ? Math.max(200, ac) : i;
};
const doubleChance = (l) => Math.min(1, l <= 35 ? l * 0.0122 : (skillOf(l) + l) / 500); // sd()
// ep(offense, ac): the damage roll index 0..19 behind the multiplier (idx + 1) / 10, averaged over both uniform draws.
const epCache = new Map();
function epMeanIdx(off, ac) {
  const key = `${off}|${ac}`;
  if (epCache.has(key)) return epCache.get(key);
  const o = Math.max(0, off);
  const a = Math.max(0, ac);
  const i = (o + a + 10) / 2;
  const N = 48;
  let sum = 0;
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      const r = Math.floor((((x + 0.5) / N) * (o + 5) - ((y + 0.5) / N) * (a + 5) + i / 2) * 20 / i);
      sum += Math.max(0, Math.min(19, r));
    }
  }
  const v = sum / (N * N);
  epCache.set(key, v);
  return v;
}
// Expected spell effectiveness (0..1) against an NPC, BYHOoN7B.js Ss/Qm averaged over the 0..200 roll, ys().
const spellCache = new Map();
function spellEffectiveness(npcLevel, casterLevel, stat) {
  const key = `${npcLevel}|${casterLevel}|${stat}`;
  if (spellCache.has(key)) return spellCache.get(key);
  const v = spellEffectivenessRaw(npcLevel, casterLevel, stat);
  spellCache.set(key, v);
  return v;
}
function spellEffectivenessRaw(npcLevel, casterLevel, stat) {
  const r = npcLevel;
  const t = casterLevel;
  let o = r - t;
  if (r >= 67) o = Math.max(0, 66 - t);
  if (o < -9) o = -9;
  let d = Math.floor((o * o) / 2);
  if (o < 0) d = -d;
  if (r - t > 20) d = 1000;
  if (r >= 17) d += 2 * (r >= 67 ? Math.max(0, 66 - t) : r - t);
  const chance = d + stat;
  let sum = 0;
  for (let a = 0; a <= 200; a++) {
    if (a > chance) {
      sum += 100;
      continue;
    }
    const c = Math.max(1, chance);
    let s = Math.floor((150 * (c - a)) / c);
    if (r > t && r >= 17 && t <= 50) s += 5;
    if (r >= 30 && t < 50) s += t - 25;
    if (r < 15) s -= 5;
    sum += s <= 0 ? 100 : s >= 100 ? 0 : 100 - s;
  }
  return sum / 201 / 100;
}

// ---------------------------------------------------------------- content loading
const rows = (table) => contentRows(table, content);
const norm = (s) => s.replace(/^the\s+/i, "").replace(/[`']/g, "").trim().toLowerCase();
// The client reads 19 as melee immunity and 23 as immunity to non-magical melee (main.pretty.js:62126-62127,
// 63336-63341). It never reads 22. Magic immunity (20) follows EQEmu's numbering and is not checked in the client.
const SPECIAL = { 1: "summon", 2: "enrage", 3: "rampage", 4: "area-rampage", 5: "flurry", 6: "triple", 7: "quad", 8: "dual-wield", 19: "immune-melee", 20: "immune-magic", 23: "immune-nonmagic-melee" };
const parseSpecials = (s) =>
  new Set(
    String(s ?? "")
      .split("^")
      .filter(Boolean)
      .map((p) => p.split(","))
      .filter(([, v]) => v !== "0")
      .map(([id]) => SPECIAL[Number(id)])
      .filter(Boolean),
  );

export async function loadZones(pattern) {
  const gameZones = new Set(Object.keys(JSON.parse(await readFile(new URL("../data/idlequest-zones.json", import.meta.url), "utf8"))).map(norm));
  // The snapshot holds classic and later copies of some zones under one long name (oot and
  // oceanoftears). The live client's zone list (data/live-zones.json) decides which copy exists.
  const liveZones = new Set(JSON.parse(await readFile(new URL("../data/live-zones.json", import.meta.url), "utf8")));
  const re = pattern ? new RegExp(pattern, "i") : null;
  const zones = new Map();
  for await (const z of rows("zone")) {
    if (z.version !== 0 || zones.has(z.short_name)) continue;
    if (re ? !(re.test(z.short_name) || re.test(z.long_name)) : !has("all") && !(gameZones.has(norm(z.long_name)) && liveZones.has(z.short_name))) continue;
    zones.set(z.short_name, { short: z.short_name, id: z.zoneidnumber, name: z.long_name, zem: Number(z.zone_exp_multiplier), safe: { x: z.safe_x, y: z.safe_y }, points: [] });
  }
  const groups = new Map(); // group -> points
  for await (const s of liveSpawnRows("spawn2", content)) {
    if (!zones.has(s.zone)) continue;
    const p = { x: s.x, y: s.y, respawn: s.respawntime, members: [] };
    zones.get(s.zone).points.push(p);
    (groups.get(s.spawngroupID) ?? groups.set(s.spawngroupID, []).get(s.spawngroupID)).push(p);
  }
  const ids = new Set();
  for await (const e of liveSpawnRows("spawnentry", content)) {
    const pts = groups.get(e.spawngroupID);
    if (!pts) continue;
    for (const p of pts) p.members.push({ id: e.npcID, chance: e.chance });
    ids.add(e.npcID);
  }
  const npcs = new Map();
  for await (const n of rows("npc_types")) {
    if (!ids.has(n.id)) continue;
    npcs.set(n.id, {
      id: n.id,
      name: n.name.replace(/^#/, "").replaceAll("_", " "),
      level: n.level,
      hp: Number(n.hp),
      min: Number(n.mindmg) || 0,
      max: Number(n.maxdmg) || 0,
      attackCount: Number(n.attack_count) || 0,
      delay: (Number(n.attack_delay) || 30) / 10,
      accuracy: Number(n.Accuracy) || 0,
      ac: Number(n.AC) || 0,
      res: { MR: n.MR, FR: n.FR, CR: n.CR, DR: n.DR, PR: n.PR },
      specials: parseSpecials(n.special_abilities),
      // As tools/zones.mjs: no guildmasters, merchants or named placeholders, and nothing untargetable.
      real: n.class < 20 && !n.merchant_id && !n.name.startsWith("#") && n.level > 0 && !n.untargetable && ![11, 60].includes(n.bodytype),
      caster: Number(n.npc_spells_id) > 0,
    });
  }
  for (const z of zones.values()) {
    for (const p of z.points) {
      const total = p.members.reduce((a, m) => a + m.chance, 0);
      p.members = p.members.filter((m) => npcs.has(m.id)).map((m) => ({ npc: npcs.get(m.id), w: m.chance / total }));
    }
    z.points = z.points.filter((p) => p.members.length);
  }
  return zones;
}

// ---------------------------------------------------------------- the model
function npcModel(n, c) {
  const P = c.level;
  const melee = (1 - c.spellShare) * meleeFactor(n.level, P, n.ac);
  const spell = c.spellShare * spellFactor(n.level, P, n.res[c.nukeResist]);
  const meleeImmune = n.specials.has("immune-melee");
  const nonMagicImmune = n.specials.has("immune-nonmagic-melee");
  const magicImmune = n.specials.has("immune-magic");
  const meleePart = meleeImmune ? 0 : nonMagicImmune ? melee * c.magicMelee : melee;
  const dps = c.dps * Math.pow(P / c.dpsLevel, c.dpsExp) * curveAt(c.dpsCurve, P) * (meleePart + (magicImmune ? 0 : spell));
  const kill = dps > 0 ? n.hp / dps : Infinity;
  // NPC damage against the tank.
  const A = accuracy(skillOf(n.level), n.accuracy);
  const D = avoidance(skillOf(P), 100);
  const pHit = hitProb(A, D);
  const lo = Math.max(1, n.max < 1 ? 1 : n.min);
  const hi = Math.max(lo, n.max);
  const perHit = lo + ((hi - lo) / 19) * epMeanIdx(npcOffense(n.level), c.tankAc);
  let attacks = n.attackCount > 0 ? n.attackCount : 1 + doubleChance(n.level);
  if (n.specials.has("triple")) attacks = Math.max(attacks, 2.5);
  if (n.specials.has("quad")) attacks = Math.max(attacks, 3.2);
  if (n.specials.has("dual-wield")) attacks += 0.5;
  if (n.specials.has("flurry")) attacks += 0.4; // 20% of rounds, 2 extra hits
  if (n.specials.has("rampage") || n.specials.has("area-rampage")) attacks += 0.5; // 20% of rounds, a few extra hits
  const tankDps = (pHit * perHit * attacks) / n.delay;
  const taken = tankDps * kill;
  const recovery = Number.isFinite(kill) ? Math.max(Math.min(1, taken / c.tankHp), Math.min(1, (kill * c.manaPerSec) / c.casterManaPool), Math.min(1, (taken * c.healCost) / c.healerManaPool)) / REGEN_PER_SEC : 0;
  return { dps, kill, tankDps, taken, recovery, melee, spell, meleeImmune: meleeImmune || (nonMagicImmune && c.magicMelee < 1), magicImmune };
}
// Piecewise-linear multiplier over the leader level from [level, multiplier] knots, flat beyond the ends.
function curveAt(knots, P) {
  if (!knots) return 1;
  if (P <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    if (P <= knots[i][0]) {
      const [x0, y0] = knots[i - 1];
      const [x1, y1] = knots[i];
      return y0 + ((y1 - y0) * (P - x0)) / (x1 - x0);
    }
  }
  return knots.at(-1)[1];
}
const meleeFactorCache = new Map();
function meleeFactor(L, P, ac = 0) {
  // Hit chance and AC mitigation at level L relative to the same-level case, for a player whose skills are at 5 per level.
  const key = `${L}|${P}|${ac}`;
  if (meleeFactorCache.has(key)) return meleeFactorCache.get(key);
  const acc = accuracy(skillOf(P)); // kt(skill, skill)
  const off = skillOf(P) + 50; // weapon skill plus (2 * 150 - 150) / 3 strength offense
  const at = (l, a) => hitProb(acc, avoidance(skillOf(l), 75)) * ((epMeanIdx(off, npcMitAc(l, a)) + 1) / 10);
  const v = at(L, ac) / at(P, 0);
  meleeFactorCache.set(key, v);
  return v;
}
function spellFactor(L, P, stat) {
  return spellEffectiveness(L, P, stat ?? 0) / Math.max(1e-9, spellEffectiveness(P, P, stat ?? 0));
}

// The part of a zone's evaluation that depends only on the leader level and the level band, so a fit can reuse it.
function prepare(z, P, minDiff, maxDiff) {
  const key = `${P}|${minDiff}|${maxDiff}`;
  z.prep ??= new Map();
  if (z.prep.has(key)) return z.prep.get(key);
  const minLevel = Math.max(P + minDiff, P + conOffset(P)); // not green
  const maxLevel = P + maxDiff;
  const byNpc = new Map();
  const cand = []; // {x, y, w, respawn}
  const high = []; // points with a danger NPC: {x, y, w}
  for (const p of z.points) {
    let w = 0;
    let hw = 0;
    for (const m of p.members) {
      if (!m.npc.real) continue;
      if (m.npc.level >= P + HIGH) hw = Math.max(hw, m.w);
      if (m.npc.level < minLevel || m.npc.level > maxLevel) continue;
      w += m.w;
      const e = byNpc.get(m.npc.id) ?? byNpc.set(m.npc.id, { npc: m.npc, mass: 0 }).get(m.npc.id);
      e.mass += m.w;
    }
    if (w > 0) cand.push({ x: p.x, y: p.y, w, respawn: Math.max(10, p.respawn) });
    if (hw > 0) high.push({ x: p.x, y: p.y, w: hw });
  }
  const mass = cand.reduce((a, p) => a + p.w, 0);
  // Walking: weighted mean distance from a candidate point to the nearest other candidate point.
  let nn = 0;
  for (const a of cand) {
    let best = Infinity;
    for (const b of cand) if (a !== b) best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y));
    nn += (best === Infinity ? 0 : best) * a.w;
  }
  let exposed = 0;
  for (const a of cand) {
    let hw = 0;
    for (const h of high) if (Math.hypot(a.x - h.x, a.y - h.y) <= LINK) hw = Math.max(hw, h.w);
    exposed += hw * a.w;
  }
  const prep = {
    minLevel,
    maxLevel,
    entries: [...byNpc.values()],
    cand: cand.length,
    mass,
    nn: mass ? nn / mass : 0,
    tbar: mass ? cand.reduce((a, p) => a + p.w * p.respawn, 0) / mass : 0, // mean respawn seconds of a candidate point
    rate: cand.reduce((a, p) => a + (p.w * 3600) / p.respawn, 0),
    exposed: mass ? exposed / mass : 0,
    arrival: high.filter((h) => Math.hypot(h.x - z.safe.x, h.y - z.safe.y) <= ARRIVAL).length,
  };
  z.prep.set(key, prep);
  return prep;
}

export function evalZone(z, c) {
  const P = c.level;
  const pr = prepare(z, P, c.minDiff, c.maxDiff);
  const { mass } = pr;
  const out = { zone: z.name, short: z.short, zem: z.zem, mass, cand: pr.cand, npcs: [], level: P, minLevel: pr.minLevel, maxLevel: pr.maxLevel };
  if (!pr.cand) return out;
  // Per-NPC model, with the kill mix weighted by spawn mass. NPCs the party cannot damage drop out and count as stuck.
  let share = 0;
  let stuck = 0;
  const sumLevels = c.partyLevels ? c.partyLevels.reduce((a, b) => a + b, 0) : 6 * P;
  const leaderShare = P / sumLevels;
  const cap = 0.11 * 3000 * P * P;
  for (const e0 of pr.entries) {
    const m = npcModel(e0.npc, c);
    const xp = Math.min(cap, 120 * e0.npc.level ** 2 * z.zem * leaderShare);
    const e = { ...e0, ...m, xp, share: e0.mass / mass };
    if (!Number.isFinite(m.kill)) stuck += e.share;
    else share += e.share;
    out.npcs.push(e);
  }
  const killable = out.npcs.filter((e) => Number.isFinite(e.kill));
  if (!killable.length) return out;
  const norm_ = (f) => killable.reduce((a, e) => a + e.share * f(e), 0) / share;
  const kill = norm_((e) => e.kill);
  const recovery = norm_((e) => e.recovery);
  // Walking is the distance to the nearest candidate that is alive. Every kill empties a point for its respawn
  // time, so of the candidate points a share f is alive, on average over the stay, and the nearest live one is
  // 1/sqrt(f) times as far as the nearest point (points scattered at random). The party's kills and the
  // --crowd other groups' kills lower f, and f depends on the walk, so the walk is solved by iteration.
  const stayS = c.stay * 60;
  const deadSeconds = c.depletion === false ? 0 : stayS > pr.tbar ? pr.tbar * (1 - pr.tbar / (2 * stayS)) : stayS / 2;
  const crowd = c.crowd ?? 0;
  let f = 1;
  let walk = 0;
  let cycle = 0;
  let combatKh = 0;
  for (let i = 0; i < 60; i++) {
    walk = (pr.nn * c.detour) / Math.sqrt(f) / c.speed;
    cycle = kill + recovery + walk + c.overhead;
    combatKh = 3600 / cycle;
    const next = Math.min(1, Math.max(MIN_ALIVE, 1 - ((combatKh / 3600) * (1 + crowd) * deadSeconds) / mass));
    f = (f + next) / 2;
  }
  const rate = pr.rate;
  const spawnKh = (rate + (mass * 60) / c.stay) / (1 + crowd);
  const xpKill = norm_((e) => e.xp);
  const { exposed, arrival, nn } = pr;
  Object.assign(out, {
    alive: f,
    kill,
    recovery,
    walk,
    nn,
    cycle,
    combatKh,
    spawnKh,
    rate,
    xpKill,
    kh: Math.min(combatKh, spawnKh),
    xph: Math.min(combatKh, spawnKh) * xpKill,
    xphCombat: combatKh * xpKill,
    meanLevel: norm_((e) => e.npc.level),
    exposed,
    arrival,
    stuck,
    summon: norm_((e) => (e.npc.specials.has("summon") ? 1 : 0)),
    immune: norm_((e) => (e.meleeImmune || e.magicImmune ? 1 : 0)),
    tankRisk: norm_((e) => (e.taken > 0.5 * c.tankHp ? 1 : 0)),
    combatShare: kill / cycle,
    medianKill: weightedMedian(killable.map((e) => [e.kill, e.share])),
  });
  return out;
}
function weightedMedian(pairs) {
  const s = [...pairs].sort((a, b) => a[0] - b[0]);
  const tot = s.reduce((a, p) => a + p[1], 0);
  let acc = 0;
  for (const [v, w] of s) {
    acc += w;
    if (acc >= tot / 2) return v;
  }
  return NaN;
}
const flags = (r) =>
  [
    r.exposed >= 0.05 ? `hi${HIGH}:${Math.round(r.exposed * 100)}%` : "",
    r.arrival ? `arr:${r.arrival}` : "",
    r.summon >= 0.02 ? `summon:${Math.round(r.summon * 100)}%` : "",
    r.immune >= 0.02 ? `immune:${Math.round(r.immune * 100)}%` : "",
    r.stuck >= 0.02 ? `stuck:${Math.round(r.stuck * 100)}%` : "",
    r.tankRisk >= 0.05 ? `tank:${Math.round(r.tankRisk * 100)}%` : "",
  ]
    .filter(Boolean)
    .join(" ");
const fmtX = (v) => (v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : (v / 1e3).toFixed(0) + "k");

// ---------------------------------------------------------------- calibration
const CASES = [
  { label: "Permafrost Caverns, leader 24-25", zone: "^permafrost$", level: 24, stay: 50, measured: { khMin: 2.91, xph: 2304068, killMean: 13, killMedian: 11.8, combat: 0.646, recovery: 4.24, xpKill: 13217 }, partyLevels: [24, 25, 24, 24, 23, 24] },
  { label: "City of Guk, leader 21", zone: "^guktop$", level: 21, stay: 45, measured: { khMin: 3.19, xph: 1640000, killMedian: 10.3 }, partyLevels: [21, 22, 21, 21, 20, 21] },
  { label: "Estate of Unrest, leader 29", zone: "^unrest$", level: 29, stay: 45, measured: { khMin: 1.92, xph: 2753334, killMean: 14.8, killMedian: 13.0, xpKill: 15051 }, partyLevels: [29, 30, 29, 29, 28, 29] },
];
// The runs used AutoLevel's blue-to-red con range, so the con rule alone sets the lower bound.
const checkCfg = (k) => ({ ...cfgFromFlags(k.level), minDiff: -99, maxDiff: 5, stay: num("stay", k.stay), partyLevels: list("party-levels", k.partyLevels) });
const pct = (m, v) => `${v >= m ? "+" : ""}${(((v - m) / m) * 100).toFixed(0)}%`;
function printCheck(zones) {
  for (const k of CASES) {
    const c = checkCfg(k);
    const z = zones.get(k.zone.replace(/[\^$]/g, ""));
    const r = evalZone(z, c);
    console.log(`\n${k.label}: levels ${r.minLevel}-${r.maxLevel}, ${r.cand} points, mass ${r.mass.toFixed(1)}, zem ${r.zem}`);
    const m = k.measured;
    const line = (name, model, meas, f = (v) => v.toFixed(2)) => meas !== undefined && console.log(`  ${name.padEnd(22)} model ${f(model).padStart(10)}  measured ${f(meas).padStart(10)}  ${pct(meas, model)}`);
    line("kills per minute", r.kh / 60, m.khMin);
    line("XP/h per leader", r.xph, m.xph, (v) => v.toFixed(0));
    line("XP per kill", r.xpKill, m.xpKill, (v) => v.toFixed(0));
    line("mean kill seconds", r.kill, m.killMean, (v) => v.toFixed(1));
    line("median kill seconds", r.medianKill, m.killMedian, (v) => v.toFixed(1));
    line("combat share of time", r.combatShare, m.combat, (v) => v.toFixed(3));
    console.log(`  cycle ${r.cycle.toFixed(1)} s = kill ${r.kill.toFixed(1)} + recovery ${r.recovery.toFixed(1)} + walk ${r.walk.toFixed(1)} + overhead ${c.overhead}; combat-limited ${r.combatKh.toFixed(0)}/h, spawn-limited ${r.spawnKh.toFixed(0)}/h`);
  }
}

// Least-squares fit of --dps, --overhead and --mana-per-sec to the measured cases, on log ratios,
// using only the quantities each case measured. Permafrost's recovery is 20.6% of its 20.6 s cycle.
function fit(zones) {
  const ks = CASES.map((k) => ({ k, z: zones.get(k.zone.replace(/[\^$]/g, "")), c: checkCfg(k) }));
  let best = { err: Infinity };
  const lg = (model, meas) => Math.log(model / meas) ** 2;
  for (let dps = 30; dps <= 90; dps += 1)
    for (let manaPerSec = 3; manaPerSec <= 15; manaPerSec += 1)
      for (let overhead = 0; overhead <= 6; overhead += 0.1) {
        let err = 0;
        const res = ks.map(({ k, z, c }) => {
          const r = evalZone(z, { ...c, dps, manaPerSec, overhead });
          const m = k.measured;
          err += lg(r.kh / 60, m.khMin) + lg(r.xph, m.xph);
          if (m.killMean) err += lg(r.kill, m.killMean);
          if (m.combat) err += lg(r.combatShare, m.combat);
          if (m.recovery) err += lg(r.recovery, m.recovery);
          if (m.killMedian) err += lg(r.medianKill, m.killMedian);
          return r;
        });
        if (err < best.err) best = { err, dps, manaPerSec, overhead: +overhead.toFixed(1) };
      }
  console.log(`best fit: --dps ${best.dps} --mana-per-sec ${best.manaPerSec} --overhead ${best.overhead} (squared log error ${best.err.toFixed(4)})`);
}

// ---------------------------------------------------------------- spell & tactic evaluation (--spells)
// Magician direct-damage nukes from spells_new: [id, minLevel, name, maxDmg, mana, cycleSec, resist].
// Every Magician nuke in spells_new has recast_time (2.25 s) <= recovery_time (2.5 s), so the best
// nuke is already off cooldown when global spell recovery ends.
const MAG_NUKES = [
  [93, 1, "Burst of Flame", 5, 7, 4.0, "FR"],
  [94, 4, "Burn", 14, 15, 4.25, "FR"],
  [324, 8, "Shock of Blades", 35, 30, 4.6, "MR"],
  [322, 8, "Flame Bolt", 47, 40, 5.0, "FR"],
  [334, 16, "Shock of Flame", 96, 70, 5.25, "FR"],
  [68, 20, "Bolt of Flame", 156, 105, 5.75, "FR"],
  [113, 24, "Shock of Spikes", 176, 110, 6.0, "MR"],
  [120, 34, "Blaze", 295, 155, 7.1, "FR"],
  [69, 34, "Cinder Bolt", 333, 175, 7.5, "FR"],
  [114, 44, "Shock of Swords", 600, 250, 8.6, "MR"],
  [70, 49, "Lava Bolt", 810, 300, 9.5, "FR"],
  [1660, 52, "Char", 702, 260, 7.0, "FR"],
  [1661, 54, "Scars of Sigil", 525, 175, 4.5, "FR"],
  [1663, 57, "Shock of Steel", 825, 275, 8.5, "MR"],
  [1664, 59, "Seeking Flame", 1024, 320, 9.5, "FR"],
  [2540, 60, "Shock of Fiery Blades", 1294, 335, 7.85, "FR"],
  [2118, 60, "Ancient: Shock of Sun", 1350, 285, 7.5, "FR"],
];
function magNukesForLevel(P, count) {
  if (count <= 0) return [];
  return MAG_NUKES.filter((s) => s[1] <= P)
    .sort((a, b) => b[1] - a[1] || b[3] - a[3])
    .slice(0, count);
}
function printSpells(zones, c) {
  const P = c.level;
  const scale = Math.pow(P / c.dpsLevel, c.dpsExp);
  // Calibrated against the analyzer's combat mana spend (--mana-per-sec 10 at L24-29) and "Damage
  // by source": in combat the Magician casts at ~55% of the theoretical cast+recovery cycle (target
  // switches, fizzles and finishing blows), and spellEffectiveness(P, P, 25) (~0.78) accounts for
  // same-level partial resists.
  const duty = 0.55;
  const sameLevelEff = spellEffectiveness(P, P, 25);
  const ref2 = magNukesForLevel(c.dpsLevel, 2);
  const refNukeDps = (ref2.reduce((s, x) => s + x[3] / x[5], 0) / ref2.length) * duty * sameLevelEff;
  const basePartyDps = (c.dps - refNukeDps) * scale;
  const casterManaPool = c.casterManaPool;
  const healerManaPool = c.healerManaPool;
  const enchManaPool = 550 * (P / 24);
  const shmManaPool = 500 * (P / 24);
  const top1 = magNukesForLevel(P, 1);
  const top2 = magNukesForLevel(P, 2);
  const nukeStats = (spells) => {
    if (!spells.length) return { rawDps: 0, manaPerSec: 0, resist: "FR", desc: "none (melee only)" };
    const rawDps = (spells.reduce((s, x) => s + x[3] / x[5], 0) / spells.length) * duty * sameLevelEff;
    const manaPerSec = (spells.reduce((s, x) => s + x[4] / x[5], 0) / spells.length) * duty;
    return { rawDps, manaPerSec, resist: spells[0][6], desc: spells.map((x) => `${x[2]} (${x[3]}d/${x[4]}m ${x[6]})`).join(" + ") };
  };
  const s0 = nukeStats([]);
  const s1 = nukeStats(top1);
  const s2 = nukeStats(top2);
  const policies = [
    { name: "nukeGems=1 (best nuke)", ...s1, extraDps: 0, extraRecov: () => 0 },
    { name: "nukeGems=2 (top 2 nukes)", ...s2, extraDps: 0, extraRecov: () => 0 },
    { name: "nukeGems=0 (no nukes)", ...s0, extraDps: 1.5, extraRecov: () => 0 },
    { name: "nukeGems=1 + cleric nuke", ...s1, extraDps: 3.8 * scale, extraRecov: (kill, taken) => ((taken * c.healCost + kill * 11) / healerManaPool) / REGEN_PER_SEC },
    { name: "nukeGems=1 + shaman DoT", ...s1, extraDps: 3.2 * scale, extraRecov: (kill) => ((kill * 10) / shmManaPool) / REGEN_PER_SEC },
    { name: "nukeGems=1 + ench nuke", ...s1, extraDps: 4.0 * scale, extraRecov: (kill) => ((kill * (4 + 11)) / enchManaPool) / REGEN_PER_SEC },
  ];
  const ranked = [...zones.values()].map((z) => ({ z, r: evalZone(z, c) })).filter((x) => x.r.xph > 0).sort((a, b) => b.r.xph - a.r.xph);
  const targetZones = (has("zone") ? ranked : ranked.slice(0, 3)).map((x) => x.z);
  for (const z of targetZones) {
    console.log(`\nSpell & tactic comparison in ${z.name} (${z.short}) at party level ${P}:`);
    console.log(`  1-nuke gem:  ${s1.desc}`);
    console.log(`  2-nuke gems: ${s2.desc}\n`);
    console.log(["policy".padEnd(26), "pDPS".padStart(6), "kill".padStart(6), "recov".padStart(6), "cycle".padStart(6), "k/h cmb".padStart(8), "XP/h cmb".padStart(9), "XP/h net".padStart(9), " bottleneck"].join(" "));
    for (const p of policies) {
      const totalAtLevel = ( basePartyDps + p.rawDps + p.extraDps ) / scale;
      const spellShare = Math.min(0.6, (0.18 * basePartyDps + p.rawDps + p.extraDps) / (basePartyDps + p.rawDps + p.extraDps));
      const cfg = { ...c, dps: totalAtLevel, spellShare, nukeResist: p.resist, manaPerSec: p.manaPerSec, casterManaPool, healerManaPool };
      const r = evalZone(z, cfg);
      const extraR = p.extraRecov(r.kill, r.kill * 15);
      const recov = Math.max(r.recovery, (r.kill * 4 / enchManaPool) / REGEN_PER_SEC, extraR);
      const cycle = r.kill + recov + r.walk + c.overhead;
      const cmbKh = 3600 / cycle;
      const netKh = Math.min(cmbKh, r.spawnKh);
      const domRecov = ((r.kill * p.manaPerSec) / casterManaPool) / REGEN_PER_SEC;
      const bottleneck = extraR >= recov - 0.05 && extraR > 0 ? "comp:mana" : domRecov >= recov - 0.05 && p.manaPerSec > 0 ? "me:mana" : "healer/cc:mana";
      console.log([p.name.padEnd(26), (totalAtLevel * scale).toFixed(1).padStart(6), r.kill.toFixed(1).padStart(6), recov.toFixed(1).padStart(6), cycle.toFixed(1).padStart(6), cmbKh.toFixed(0).padStart(8), fmtX(cmbKh * r.xpKill).padStart(9), fmtX(netKh * r.xpKill).padStart(9), " " + bottleneck].join(" "));
    }
  }
}

// ---------------------------------------------------------------- output
function printTable(results, c, top) {
  console.log(`Party level ${c.level}, candidate levels ${c.level + c.minDiff} to ${c.level + c.maxDiff} and above green (${c.level + conOffset(c.level)}), dps ${c.dps} at level ${c.dpsLevel}, stay ${c.stay} min\n`);
  console.log(["zone".padEnd(26), "zem".padStart(5), "cand".padStart(5), "lvl".padStart(5), "kill".padStart(6), "recov".padStart(6), "walk".padStart(5), "k/h cmb".padStart(8), "k/h spn".padStart(8), "XP/h".padStart(8), "  flags"].join(" "));
  for (const r of results.slice(0, top)) {
    console.log(
      [r.short.padEnd(26), r.zem.toFixed(2).padStart(5), r.mass.toFixed(0).padStart(5), r.meanLevel.toFixed(1).padStart(5), r.kill.toFixed(1).padStart(6), r.recovery.toFixed(1).padStart(6), r.walk.toFixed(1).padStart(5), r.combatKh.toFixed(0).padStart(8), r.spawnKh.toFixed(0).padStart(8), fmtX(r.xph).padStart(8), " " + flags(r)].join(" "),
    );
  }
}
function printZone(r, c) {
  console.log(`${r.zone} (${r.short}), zem ${r.zem}, party level ${c.level}, candidate levels ${r.minLevel}-${r.maxLevel}, ${r.cand} points, mass ${r.mass.toFixed(1)}`);
  if (r.cycle) {
    console.log(`kill ${r.kill.toFixed(1)} s, recovery ${r.recovery.toFixed(1)} s, walk ${r.walk.toFixed(1)} s (nearest candidate ${r.nn.toFixed(0)} units), overhead ${c.overhead} s, cycle ${r.cycle.toFixed(1)} s`);
    console.log(`kills/h combat-limited ${r.combatKh.toFixed(0)}, spawn-limited ${r.spawnKh.toFixed(0)} (respawn ${r.rate.toFixed(0)}/h plus stock ${((r.mass * 60) / c.stay).toFixed(0)}/h over ${c.stay} min), XP/kill ${r.xpKill.toFixed(0)}, XP/h ${fmtX(r.xph)} (combat-limited ${fmtX(r.xphCombat)}), flags: ${flags(r) || "none"}\n`);
  }
  console.log("name".padEnd(30) + "lvl".padStart(4) + "mass".padStart(6) + "hp".padStart(6) + "pDPS".padStart(6) + "kill".padStart(6) + "tDPS".padStart(6) + "taken".padStart(6) + "recov".padStart(6) + "XP".padStart(7) + "  abilities");
  for (const e of r.npcs.sort((a, b) => b.mass - a.mass)) {
    const ab = [...e.npc.specials, e.npc.caster ? "caster" : ""].filter(Boolean).join(" ");
    console.log(e.npc.name.slice(0, 29).padEnd(30) + String(e.npc.level).padStart(4) + e.mass.toFixed(1).padStart(6) + String(e.npc.hp).padStart(6) + e.dps.toFixed(0).padStart(6) + (Number.isFinite(e.kill) ? e.kill.toFixed(1) : "inf").padStart(6) + e.tankDps.toFixed(1).padStart(6) + e.taken.toFixed(0).padStart(6) + e.recovery.toFixed(1).padStart(6) + e.xp.toFixed(0).padStart(7) + "  " + ab);
  }
}

if (import.meta.main) await main();
async function main() {
  if (!has("check") && !has("fit") && raw("level") === undefined) {
    console.error("usage: bun tools/predict.mjs --level N [--top 15] [--zone regex] [--min-diff -3] [--max-diff 5] [--dps ..] [--overhead ..] [--check]\nflags are documented in docs/tools.md and at the top of tools/predict.mjs");
    process.exit(2);
  }
  const zones = await loadZones(has("check") || has("fit") ? "^(permafrost|guktop|unrest)$" : raw("zone"));
  if (has("fit")) fit(zones);
  else if (has("check")) printCheck(zones);
  else if (has("spells")) printSpells(zones, cfgFromFlags(num("level", NaN)));
  else {
    const c = cfgFromFlags(num("level", NaN));
    const results = [...zones.values()].map((z) => evalZone(z, c));
    if (has("zone")) for (const r of results) printZone(r, c);
    else {
      const ranked = results.filter((r) => r.xph > 0).sort((a, b) => b.xph - a.xph);
      if (has("json")) console.log(JSON.stringify(ranked.map(({ npcs, ...r }) => r), null, 2));
      else printTable(ranked, c, num("top", 15));
    }
  }
}
