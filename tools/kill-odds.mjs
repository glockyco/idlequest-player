#!/usr/bin/env bun
// Kill chances from the raid simulator, for the coordinator's boss kills (docs/plans/raids.md) and
// gear targets (docs/plans/gear-acquisition.md, "Kill chance"), written to runs/state/kill-odds.json.
// - Bosses: each daily boss (runs/state/daily-bosses.json) and each casino potion boss the survey
//   finds fights the raid of all roster characters and the strongest group's six.
// - Gear targets (the db meta key `gear`): the pairs of group and target with the highest expected
//   value, the target's value per hour times the prior's chance for the pair, that have no result
//   younger than a day at the group's current level, `--pairs` of them per run. So the simulator
//   checks what the coordinator is about to choose, and a target no group can win costs nothing.
//   The simulator fights in the client's raid mode, which takes only an NPC above level 50 ("Select
//   an NPC above level 50 or an already engaged enemy.", `beginCombatForTarget` in the raid store),
//   so a target of 50 or below keeps the prior and the live record.
// - The prior (tools/lib/kill-prior.mjs) is fitted again to every group result on file.
// One `simulate` run fights all of an enemy's rosters, and the file is written after each enemy.
// The coordinator adds each group's own fight record (tools/lib/fight-record.mjs) to these.
//
//   bun tools/kill-odds.mjs [--seeds 4] [--pairs 150]
//   bun tools/kill-odds.mjs --refit    the prior alone, after a change to its model, without fights
import { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { casinoBosses } from "./lib/client-tables.mjs";
import { liveSpawnRows, rows } from "./lib/content.mjs";
import { npcKey } from "./lib/fight-record.mjs";
import { fitPrior, priorOf } from "./lib/kill-prior.mjs";
import { accountRoster } from "./raidsim/account.mjs";
import { bossSpec, findBoss } from "./raidsim/boss.mjs";
import { resolveClient } from "./raidsim/clients.mjs";
import { rosterEntries } from "./raidsim/roster.mjs";
import { SIM_VERSION, simulate } from "./raidsim/run.mjs";

const { values: opt } = parseArgs({ options: { seeds: { type: "string", default: "4" }, pairs: { type: "string", default: "150" }, refit: { type: "boolean" } } });
const read = async (path, fallback) => JSON.parse(await readFile(path, "utf8").catch(() => JSON.stringify(fallback)));
const OUT = "runs/state/kill-odds.json";
const FRESH_MS = 24 * 3600000;

const roster = (await read("data/roster.json", { groups: [] })).groups.filter((g) => g.members?.length);
const survey = await read("runs/state/account-items.json", []);
const daily = await read("runs/state/daily-bosses.json", { bosses: [] });
const casino = await casinoBosses();
const before = await read(OUT, { odds: {} });
process.env.RAIDSIM_CLIENT = (await resolveClient()).id; // read by every fight process (raidsim/env.mjs)

// Each group's leader level from the survey, and the strongest group by its members' mean level,
// whose leader leads the simulated raid.
const level = new Map(survey.map((r) => [r.characterName, r.level]));
const mean = (g) => g.members.reduce((a, m) => a + (level.get(m) ?? 0), 0) / g.members.length;
const strongest = [...roster].sort((a, b) => mean(b) - mean(a))[0];
const leaderLevel = (g) => level.get(g.members[0]) ?? 0;
const entriesOf = (leader, names) => rosterEntries(accountRoster(survey, { leader, names })).entries;

const fresh = (o, lvl) => o && !o.error && o.sim === SIM_VERSION && Date.now() - o.t < FRESH_MS && (lvl == null || o.level === lvl);
// Every group result on file as an observation for the prior: the enemy's level above the leader's and its hit points.
const observations = (odds) => Object.values(odds).flatMap((e) => Object.values(e.groups ?? {}).filter((g) => !g.error && e.level != null && e.hp != null && g.level != null).map((g) => ({ gap: e.level - g.level, hp: e.hp, kills: g.kills, fights: g.fights, deaths: g.deathsPerFight, leaderDeaths: g.leaderDeathsPerFight ?? 0 })));
const odds = { ...before.odds };
const db = new Database("runs/iq.db", { readonly: true });
const targets = JSON.parse(db.query("SELECT v FROM meta WHERE k = 'gear'").get()?.v ?? "{}").targets ?? [];
const held = new Set(survey.map((r) => r.itemId));

// Raid bosses of the goal that stand in the open world and that the daily list does not name,
// from the boss plan's watch (the db meta key `bossPlan`, `watchedBosses` of
// tools/lib/boss-plan.mjs): the raid fights them too, by their name key, so the boss plan knows
// before a group looks for one whether a raid there is worth its travel.
const watch = JSON.parse(db.query("SELECT v FROM meta WHERE k = 'bossPlan'").get()?.v ?? "{}").watch ?? [];
const openGoal = watch.filter((w) => w.goal && !(daily.bosses ?? []).some((b) => b.key === w.key)).map((w) => ({ key: w.key, name: w.name, zone: w.zone }));

// An enemy is the NPC of its name that spawns in its zone, since a name alone is ambiguous in the
// content (Talendor has a level-90 `#Talendor` beside the level-60 boss). Read once for every
// enemy this run may fight and every one on file.
const wanted = new Set([...(daily.bosses ?? []).map((b) => b.name), ...openGoal.map((b) => b.name), ...targets.map((x) => x.npc), ...Object.values(odds).map((e) => e.name).filter(Boolean)].map(npcKey));
const named = new Map();
for await (const n of rows("npc_types")) if (wanted.has(npcKey(n.name))) named.set(n.id, n);
const groupsOf = new Map();
for await (const e of liveSpawnRows("spawnentry")) {
  const npc = e.npcID ?? e.npc_id;
  const group = e.spawngroupID ?? e.spawngroup_id;
  if (named.has(npc)) (groupsOf.get(group) ?? groupsOf.set(group, []).get(group)).push(npc);
}
const spawnsIn = new Map();
for await (const s of liveSpawnRows("spawn2")) for (const id of groupsOf.get(s.spawngroupID ?? s.spawngroup_id) ?? []) (spawnsIn.get(id) ?? spawnsIn.set(id, new Set()).get(id)).add(s.zone);
const npcOf = (e) => e.npcId ?? [...named.values()].find((n) => npcKey(n.name) === npcKey(e.name) && spawnsIn.get(n.id)?.has(e.zone))?.id ?? null;
// Results written before an entry carried its enemy's level and hit points get them from the content.
for (const e of Object.values(odds)) {
  const row = e.npc != null ? named.get(e.npc) : null;
  if (row && e.hp == null) Object.assign(e, { level: e.level ?? row.level, hp: Number(row.hp) || null });
}
const prior = fitPrior(observations(odds));

// Enemies: `{ key, name, zone, raid, groups }`, `raid` for a boss's raid fight and `groups` the
// groups whose six fight it.
const enemies = new Map();
const add = (e, group) => {
  const have = enemies.get(e.key) ?? enemies.set(e.key, { ...e, groups: new Set() }).get(e.key);
  if (group) have.groups.add(group);
};
for (const b of daily.bosses ?? []) add({ key: b.key, name: b.name, zone: b.zone, raid: true }, strongest);
for (const c of casino) if (held.has(c.itemId)) add({ key: c.key, name: c.name, zone: c.zone, npcId: c.npcId, raid: true }, strongest);
for (const b of openGoal) add({ ...b, raid: true }, strongest);
const pairs = [];
for (const x of targets.filter((t) => t.npcLevel > 50)) {
  const key = `${x.zone}|${npcKey(x.npc)}`;
  for (const g of roster) {
    if (fresh(odds[key]?.groups?.[g.id], leaderLevel(g))) continue;
    // Without a prior yet, the first run takes the most valuable targets for every group.
    const p = prior && x.npcLevel != null ? priorOf(prior, x.npcLevel - leaderLevel(g), x.npcHp).p : 1;
    pairs.push({ key, x, g, priority: x.rate * p });
  }
}
for (const { key, x, g } of pairs.sort((a, b) => b.priority - a.priority).slice(0, Number(opt.pairs))) add({ key, name: x.npc, zone: x.zone, raid: false }, g);

// Leader deaths count apart from companions', because only the leader's death costs XP (`deathHours` in tools/lib/acquire.mjs).
const result = (s) => ({ t: Date.now(), sim: SIM_VERSION, kills: s.kills, fights: s.fights, meanSec: s.killSec.mean, deathsPerFight: s.deathsPerFight, leaderDeathsPerFight: (s.members.find((m) => m.leader)?.deaths ?? 0) / s.fights, hpLeft: s.bossHpLeftMean });
const save = () => writeFile(OUT, JSON.stringify({ t: Date.now(), seeds: Number(opt.seeds), strongest: strongest.id, prior: fitPrior(observations(odds)), odds }, null, 1));

console.log(`${enemies.size} enemies, ${pairs.length} open pairs of group and target, prior ${prior ? `fitted to ${prior.fights} fights` : "not fitted yet"}`);
// `--refit` only writes the prior fitted again to the results on file, as after a change to its model.
if (opt.refit) {
  await save();
  process.exit(0);
}
for (const e of enemies.values()) {
  const npc = npcOf(e);
  const old = odds[e.key] ?? {};
  if (npc == null) {
    odds[e.key] = { name: e.name, zone: e.zone, error: `no NPC ${e.name} spawns in ${e.zone}` };
    continue;
  }
  const row = named.get(npc);
  const entry = { npc, name: e.name, zone: e.zone, level: row?.level ?? old.level ?? null, hp: Number(row?.hp) || old.hp || null, raid: old.raid, groups: { ...(old.groups ?? {}) } };
  const variants = [];
  if (e.raid && !fresh(old.raid)) variants.push({ label: "raid", entries: entriesOf(strongest.members[0], roster.flatMap((g) => g.members)) });
  for (const g of e.groups) if (!fresh(old.groups?.[g.id], leaderLevel(g))) variants.push({ label: g.id, level: leaderLevel(g), entries: entriesOf(g.members[0], g.members) });
  if (variants.length) {
    try {
      const boss = await bossSpec(await findBoss(String(npc)));
      const results = await simulate({ boss, variants, seeds: Number(opt.seeds), maxSec: 900, dpsMode: "dps-all-out", healMode: "all-balanced" });
      for (const [k, r] of results.entries()) {
        if (r.label === "raid") entry.raid = result(r.summary);
        else entry.groups[r.label] = { level: variants[k].level, ...result(r.summary) };
      }
    } catch (error) {
      entry.error = error.message;
    }
  }
  odds[e.key] = entry;
  await save();
  const said = Object.entries(entry.groups).map(([id, o]) => `${id} ${o.kills}/${o.fights}`).join(", ");
  console.log(`${e.key} (${npc}, level ${entry.level}): ${entry.error ?? `${entry.raid ? `raid ${entry.raid.kills}/${entry.raid.fights}${said ? ", " : ""}` : ""}${said}`}`);
}
await save();
