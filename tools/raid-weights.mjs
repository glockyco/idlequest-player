#!/usr/bin/env bun
// Raid stat weights: what one point of a stat on one member of a role is worth in the raid
// simulator's fights against the hard bosses, measured by giving every member of the role a probe
// of the stat and fighting the same seeds as the baseline. Writes runs/state/raid-weights.json.
//
//   bun tools/raid-weights.mjs [--bosses 128093,128091] [--seeds 8] [--jobs 2] [--roles tank,melee]
//     [--stats hp,ac] [--out <file>]
//
//   --bosses  npc ids of the bosses to fight (default: a screen of two fights against each boss
//             the last kill odds call a loss and each of the raid kit's hard bosses keeps the four
//             the raid kills sometimes or leaves under half their hit points, nearest a kill first,
//             since gear moves the raid's results only there)
//   --seeds   fights per variant and boss, the same seeds in every variant (default 8)
//   --roles   roles to probe (default all four: tank, melee, priest, caster)
//   --stats   probes to give (default all of PROBES)
//
// The roster is every roster character as runs/state/account-items.json found it, with the raid's
// orders (`RAID_MODES`). A probe is a copy of the item a member wears in its first worn slot with the
// probe's amounts added, under an id the content does not use. A fight's score is the share of the
// boss's hit points the raid took, plus for a kill the share of the time limit it left. A weight is
// the mean change of the score against the baseline fight of the same seed, per point and per member
// of the role, with its standard error.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { findBoss, bossSpec } from "./raidsim/boss.mjs";
import { resolveClient } from "./raidsim/clients.mjs";
import { accountRoster } from "./raidsim/account.mjs";
import { rosterEntries } from "./raidsim/roster.mjs";
import { byId } from "./raidsim/content.mjs";
import { simulate } from "./raidsim/run.mjs";
import { RAID_MODES } from "./lib/boss-plan.mjs";
import { PROBES, ROLES, fightScore, pickBosses, probeRow, roleOf, weightOf } from "./lib/raid-weights.mjs";
import { HARD_BOSSES } from "./lib/raid-kit.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const fail = (message) => {
  console.error(`raid-weights: ${message}`);
  process.exit(1);
};
const started = Date.now();
const log = (message) => console.error(`[${((Date.now() - started) / 60000).toFixed(1)} min] ${message}`);

const seeds = Number(opt("seeds", 8));
const jobs = Number(opt("jobs", 2));
const maxSec = 900;
// The screen's fights per candidate boss, and the bosses it keeps.
const SCREEN_SEEDS = 2;
const BOSSES = 4;
const roles = opt("roles", Object.keys(ROLES).join(",")).split(",");
const stats = opt("stats", Object.keys(PROBES).join(",")).split(",");
for (const r of roles) if (!ROLES[r]) fail(`unknown role ${r}, one of ${Object.keys(ROLES).join(", ")}`);
for (const s of stats) if (!PROBES[s]) fail(`unknown probe ${s}, one of ${Object.keys(PROBES).join(", ")}`);
const out = opt("out", new URL("../runs/state/raid-weights.json", import.meta.url).pathname);

try {
  process.env.RAIDSIM_CLIENT = (await resolveClient(opt("client"))).id;
} catch (error) {
  fail(error.message);
}

const rows = JSON.parse(await readFile(new URL("../runs/state/account-items.json", import.meta.url), "utf8"));
const groups = JSON.parse(await readFile(new URL("../data/roster.json", import.meta.url), "utf8")).groups;
const names = groups.flatMap((g) => g.members ?? []);
const { entries, level } = rosterEntries(accountRoster(rows, { leader: names[0], names }));
const items = await byId("items");

// The default bosses come from a screen with the roster as it is now, since kill odds up to a day
// old miss what the roster gained since: on 2026-11-16 they called Zlexak a loss that the screen
// won 8 times in 8.
const bossIds = opt("bosses")
  ? opt("bosses").split(",").map(Number)
  : await (async () => {
      const odds = JSON.parse(await readFile(new URL("../runs/state/kill-odds.json", import.meta.url), "utf8")).odds;
      const byNpc = new Map();
      for (const o of Object.values(odds)) if (o.raid && !o.raid.error && o.hp > 0 && o.raid.fights > 0 && o.raid.kills < o.raid.fights) byNpc.set(o.npc, o);
      for (const b of HARD_BOSSES) byNpc.set(b.npc, { npc: b.npc });
      const screened = [];
      for (const npc of byNpc.keys()) {
        const boss = await bossSpec(await findBoss(npc));
        const [r] = await simulate({ boss, level, seeds: SCREEN_SEEDS, maxSec, jobs, dpsMode: RAID_MODES.nuke, healMode: RAID_MODES.heal, revive: RAID_MODES.revive, rods: RAID_MODES.rods, variants: [{ label: "screen", entries }] });
        const s = r.summary;
        log(`screen: ${boss.row.name}: ${s.kills}/${s.fights} kills, boss hit points left ${s.bossHpLeftMean} of ${s.bossMaxHp}`);
        screened.push({ npc, chance: s.kills / s.fights, left: s.bossHpLeftMean / s.bossMaxHp });
      }
      return pickBosses(screened, BOSSES);
    })();
if (!bossIds.length) fail("no boss to fight");

// Variants: the baseline and one per role and probe.
const variants = [{ label: "baseline", role: null, probe: null, entries }];
let nextId = 9_000_000;
for (const role of roles) {
  for (const stat of stats) {
    const added = new Map();
    const probed = entries.map((e) => {
      if (roleOf(e.class) !== role) return e;
      const slot = Object.keys(e.items).find((s) => items.has(e.items[s]));
      if (slot === undefined) return e;
      const id = nextId++;
      added.set(id, probeRow(items.get(e.items[slot]), id, PROBES[stat]));
      return { ...e, items: { ...e.items, [slot]: id } };
    });
    variants.push({ label: `${role} ${stat}`, role, probe: stat, members: added.size, entries: probed, items: added });
  }
}
log(`${bossIds.length} bosses × ${variants.length} variants × ${seeds} seeds, ${jobs} at once`);

const results = [];
const baselines = {};
// Written after every boss beside the weights file, so a run cut short keeps the bosses it
// finished, and moved over it at the end, so the gear pass never reads a part of a run.
const save = (file) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ t: Date.now(), seeds, bosses: bossIds, orders: RAID_MODES, probes: PROBES, baselines, results }, null, 2)}\n`);
};
for (const npc of bossIds) {
  const boss = await bossSpec(await findBoss(npc));
  const name = boss.row.name.replace(/#/g, "").replace(/_/g, " ");
  // A fight that outlasts the pool's wall-clock limit ends the boss, not the run: Cazic-Thule's
  // fights did on 2026-11-16 after three bosses had finished.
  const runs = await simulate({ boss, level, seeds, maxSec, jobs, dpsMode: RAID_MODES.nuke, healMode: RAID_MODES.heal, revive: RAID_MODES.revive, rods: RAID_MODES.rods, variants: variants.map((v) => ({ label: v.label, entries: v.entries, items: v.items })) }).catch((error) => {
    log(`${name}: left out, a fight failed: ${error.message}`);
    return null;
  });
  if (!runs) continue;
  const base = runs[0].fights.map((f) => fightScore(f, maxSec));
  log(`${name}: baseline ${runs[0].summary.kills}/${seeds} kills, score ${(base.reduce((a, b) => a + b, 0) / seeds).toFixed(3)}`);
  // A boss the raid kills in every fight shows only noise: on 2026-11-16 Hraashna the Warder, Zlexak
  // and The Final Arbiter moved by nothing beyond their spread for any probe.
  if (runs[0].summary.kills === seeds) {
    log(`${name}: left out, the raid kills it in every fight, so gear moves nothing there`);
    continue;
  }
  baselines[npc] = base.reduce((a, b) => a + b, 0) / seeds;
  for (const [i, v] of variants.entries()) {
    if (!v.role) continue;
    const w = weightOf(base, runs[i].fights.map((f) => fightScore(f, maxSec)), PROBES[v.probe], v.members);
    // What the probe did to its members' hit points, armor class and mana in the fights, which
    // shows that the client applied it.
    const probed = runs[i].summary.members.map((m, k) => [m, runs[0].summary.members[k]]).filter(([m]) => roleOf(m.cls) === v.role);
    const shift = Object.fromEntries(["hp", "ac", "mana"].map((k) => [k, Math.round(probed.reduce((a, [m, b]) => a + (m.stats?.[k] ?? 0) - (b.stats?.[k] ?? 0), 0) / Math.max(1, probed.length))]));
    results.push({ boss: name, npc, role: v.role, probe: v.probe, members: v.members, shift, ...w });
    log(`${name} ${v.label}: ${w.perPoint.toExponential(2)} ± ${w.se.toExponential(2)} per point and member, stats ${JSON.stringify(shift)}`);
  }
  save(`${out}.partial`);
}
save(out);
rmSync(`${out}.partial`, { force: true });
log(`wrote ${out}`);
