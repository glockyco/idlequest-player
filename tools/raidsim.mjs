// Raid fight simulator: runs the IdleQuest client's own raid code offline, so roster choices
// (class mix, counts, gear, spells scribed) can be compared against a boss before characters exist.
//
//   bun tools/raidsim.mjs --boss <npc id|name> --roster <file.json> [--seeds 20] [--max-sec 900] [--client <release>] [--json]
//   bun tools/raidsim.mjs --boss <...> --roster <...> --gear farm [--farm-hours 4] [--gear-report]
//   bun tools/raidsim.mjs --boss <...> --roster <...> --class-sweep --slot <name|index>
//
//   --boss        npc_types id, or a name ("Hraashna the Warder")
//   --roster      JSON file: { "level": 60, "gear": "merchant", "members": [...] } or just the array. A member is
//                 { name, class, race?, leader?, gear?, stats?, skills?, items?, spells?, gems? }, documented
//                 in tools/raidsim/roster.mjs. Without "leader" the first member leads. See
//                 tools/raidsim/rosters/groups-1-3.json. "account" is every account character as the last gear
//                 survey found it (tools/raidsim/account.mjs), led by --leader, or only the --members
//                 (comma-separated names)
//   --gear P      where a member's default items and spells come from: merchant (default) or farm. Overrides
//                 the roster file's "gear", and a member's own "gear" overrides both (see "Gear policies")
//   --farm-hours H  farm policy: the most hours of camping one copy of an item or scroll may take (default 4)
//   --gear-report  after the tables, every member's items and spells with where each comes from
//   --seeds N     fights per roster, seeds --seed-base .. +N-1 (default 20, base 1)
//   --max-sec S   fight time limit in seconds (default 900)
//   --dps-mode    dps-balanced | dps-all-out | all-all-out (default dps-all-out), the raid's Auto-DPS
//   --heal-mode   clr-balanced | all-balanced | clr-all-out | all-all-out | off (default clr-balanced)
//   --class-sweep swap the --slot member through all 14 classes (default kit of each class) and
//                 compare kill times with the roster as given
//   --client      the client build to run: a release id under .re/releases/ or "legacy" (.re/js). Default is
//                 the newest saved release. Each build needs a table in tools/raidsim/clients.mjs.
//   --trace M     after the tables, one member's first fight in 10 s rows: hit points, damage taken, healing
//                 received by caster and spell, hate rank, boss target time and Cleric mana (M is a roster name
//                 or index)
//   --jobs N      fights run at once (default: a quarter of the CPU count), each at the lowest priority
//   --calls       also print how often the client functions below ran (first fight)
//   --json        machine output instead of tables
//
// Gear policies. A member without "items" or "spells" gets a default kit (tools/raidsim/kits.mjs):
//   merchant  the best item per slot that any merchant in the content snapshot sells (armor class
//             first, then stat total), the best weapon by damage per delay and every merchant scroll
//             the class can cast, whatever the zone and the price
//   farm      per slot the best item by the stat score of tools/gear.mjs (shared code in
//             tools/lib/gear-data.mjs) that the member's class and race may use at its level and that
//             a character can get: from a merchant in a live zone, or from the drops of an ordinary NPC
//             in a live zone (not a Raid Resolve boss, not a raid target, not above level 60, with a
//             spawn timer) at an expected time of at most --farm-hours of camping per copy. That time
//             is respawn seconds / (spawn chance x drop chance) / 3600 for one spawn point, the fastest
//             source of the item. Weapons rank by base damage capped at the level's limit over delay
//             and a two-hander wins only if it beats the one-hander by the off hand's 35% share.
//             Spells are the merchant scrolls plus the scrolls that pass the same time limit. Each
//             member has its own copies, so lore items only stop one member wearing two of them
//
// What runs. A fight builds the raid in the client's own stores and drives it the way the raid
// view does: the roster members come from the client's member builder with items loaded by id,
// the leader from the client's character and spellbook stores, buffs from `syncRaidBuffs`, the
// start from `beginCombatForTarget`, the attack order from `setAllCommand`, the raid tick (every
// 100 ms and every second) and the boss from the combat service's encounter engine. Melee, pets,
// damage over time, nukes, heals, taunts, buffs, boss melee, rampage, enrage and boss spells are
// all the client's code. Mana, damage and healing come from the combat state's own event log. The
// client's minified names for these are in tools/raidsim/clients.mjs.
//
// What is replaced (each in one place):
//   clock          env.mjs     Date.now, performance.now, setTimeout, setInterval and
//                              requestAnimationFrame run on a virtual clock that only the
//                              simulation advances.
//   randomness     env.mjs     Math.random is a seeded mulberry32 generator.
//   network        fight.mjs   the socket's send methods drop streamed messages and fail requests.
//                              The combat start request is answered with the CombatInit built
//                              from npc_types, 100 ms later.
//   3D scene       fight.mjs   bindScenePorts gets a scene where every member is in melee range
//                              of the boss and in spell range and line of sight of everyone, nobody
//                              stands behind the boss and nothing blocks a cast. Every actor stands
//                              at the boss, so the boss's area spells reach the whole raid up to their
//                              target count, more members than live, where casters stand at range.
//                              Any other scene method answers false (`sceneCalls` in --calls
//                              lists them). The client's own "scene not ready" stand-in has none
//                              of these.
//   raid time      fight.mjs   the raid time store says the account holds raid time, and the
//                              roster counts as validated against the server.
//   rest           fight.mjs   the raid starts at full hit points and mana. A member is built at
//                              its unbuffed maximum and the raid buffs raise it, so without this
//                              the fight would start at about 43% hit points. In the game the
//                              client's out-of-combat regeneration fills that before a pull.
//   spell data     spells.mjs  the client's spell store is filled from spells_new through the shape
//                              of its static spells asset (the asset itself is not downloaded).
//   item service   fight.mjs   items are looked up in the content snapshot.
//   happy-dom      env.mjs     the bundles need browser globals. One extra export in each bundle
//                              evaluates a name in module scope, so non-exported functions and
//                              stores can be used and observed.
//
// Inputs taken from the live game: raw attributes are the creation stats of the member's race and
// class with the server's preset allocation (data/char-create.json), and skill caps come from the
// server for every level (data/skill-caps.json, tools/skill-caps.mjs), classes.mjs. Entries override them.
//
// What this tool assumes, because no client, server or content data says what we will own:
//   - every skill trained to its cap, no AAs, and the default race of a class (Human, Barbarian for
//     a Shaman) when an entry names none
//   - default gear and spells come from a gear policy (above), so they follow the content snapshot's
//     drop, spawn and merchant tables and the score of gear.mjs, not what the account will own. Charm,
//     ranged and ammo slots stay empty, and the simulated characters have no deity (an item that
//     needs one is left out of the farm kit)
//   - a leader memorizes the 8 (Bard 3) highest level spells of the client's auto-cast table that
//     it has scribed (data/class-spells.json), kits.mjs
//   - the boss's spell list: which npc_spells_entries types an engaged NPC casts, and the client
//     category each maps to (boss.mjs); extra attacks flags of the boss (fight.mjs)
//   - one boss, spawned alone; no adds, no zone, no line of sight, no movement
//
// Observation only (they forward everything unchanged): a wrapper on the client's combat event recorder
// that records the combat state's events, and call counters on the client functions listed in
// tools/raidsim/clients.mjs (`counted`) and tools/raidsim/fight.mjs (COUNTED_L2).
//
// Every fight runs in a fresh process (tools/raidsim/worker.mjs), because the client keeps combat
// state in module-level stores and a second fight in the same process would start from the first
// one's leftovers. A fight of several virtual minutes takes a few seconds.
// This file reads the options and prints. The fights run in `simulate` (tools/raidsim/run.mjs), which
// tools/raid-kit.mjs calls as well.
import { readFile } from "node:fs/promises";
import { resolveBossList, resolveClient } from "./raidsim/clients.mjs";
import { CLASS_NAMES } from "./raidsim/classes.mjs";
import { accountRoster } from "./raidsim/account.mjs";
import { findBoss, bossSpec } from "./raidsim/boss.mjs";
import { DEFAULT_FARM_HOURS, GEAR_POLICIES, rosterEntries } from "./raidsim/roster.mjs";
import { byId } from "./raidsim/content.mjs";
import { DEFAULT_JOBS } from "./raidsim/pool.mjs";
import { DPS_MODES, HEAL_MODES, simulate } from "./raidsim/run.mjs";
import { fightLines, gearReport, memberTable, sweepTable, traceLines } from "./raidsim/report.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const fail = (message) => {
  console.error(`raidsim: ${message}`);
  process.exit(1);
};

if (!opt("boss") || !opt("roster")) fail("usage: bun tools/raidsim.mjs --boss <npc id|name> --roster <file.json> [--seeds 20] [--max-sec 900] [--client <release>] [--gear merchant|farm] [--farm-hours 4] [--gear-report] [--json] [--class-sweep --slot <name|index>]");
const seeds = Number(opt("seeds", 20));
const seedBase = Number(opt("seed-base", 1));
const maxSec = Number(opt("max-sec", 900));
const jobs = Number(opt("jobs", DEFAULT_JOBS));
const dpsMode = opt("dps-mode", "dps-all-out");
const healMode = opt("heal-mode", "clr-balanced");
if (!(seeds >= 1) || !(maxSec > 0)) fail("--seeds and --max-sec must be positive numbers");
if (!DPS_MODES.includes(dpsMode)) fail(`--dps-mode must be one of ${DPS_MODES.join(", ")}`);
if (!HEAL_MODES.includes(healMode)) fail(`--heal-mode must be one of ${HEAL_MODES.join(", ")}`);
const farmHours = Number(opt("farm-hours", DEFAULT_FARM_HOURS));
if (!(farmHours > 0)) fail("--farm-hours must be a positive number");
if (opt("gear") !== undefined && !GEAR_POLICIES.includes(opt("gear"))) fail(`--gear must be one of ${GEAR_POLICIES.join(", ")}`);

let client;
try {
  client = await resolveClient(opt("client"));
} catch (error) {
  fail(error.message);
}
process.env.RAIDSIM_CLIENT = client.id; // read by every fight process (env.mjs)

const json = flag("json");
const progress = (done, total) => {
  if (!json && process.stderr.isTTY) process.stderr.write(`\r${done}/${total} fights`);
};

let boss;
let file;
try {
  boss = await bossSpec(await findBoss(opt("boss")));
  // The account roster is the members of data/roster.json unless --members names others, because
  // Inventory Search also lists the items of deleted characters.
  const members = opt("members")?.split(",") ?? JSON.parse(await readFile("data/roster.json", "utf8")).groups.flatMap((g) => g.members ?? []);
  file =
    opt("roster") === "account"
      ? accountRoster(JSON.parse(await readFile("runs/state/account-items.json", "utf8")), { leader: opt("leader") ?? fail("--roster account needs --leader"), names: members })
      : JSON.parse(await readFile(opt("roster"), "utf8"));
} catch (error) {
  fail(error.message);
}
const { entries, level, gear: fileGear } = rosterEntries(file);

// Variants of the roster to fight: the roster as given, or with one slot set to each class.
const variants = [{ label: "as given", entries }];
if (flag("class-sweep")) {
  const slot = opt("slot");
  if (slot === undefined) fail("--class-sweep needs --slot <member name or index>");
  const index = /^\d+$/.test(slot) ? Number(slot) : entries.findIndex((e) => e.name === slot);
  if (!entries[index]) fail(`no roster member ${JSON.stringify(slot)}`);
  for (let cls = 1; cls <= 14; cls++) {
    const swapped = entries.map((e, i) => (i === index ? { name: e.name, class: cls, ...(e.gear ? { gear: e.gear } : {}), ...(e.leader ? { leader: true } : {}) } : e));
    variants.push({ label: CLASS_NAMES[cls], entries: swapped });
  }
}

let results;
try {
  results = await simulate({
    boss,
    variants,
    level,
    gear: opt("gear") ?? fileGear,
    farmHours,
    resolve: (opt("gear") ?? fileGear) === "farm" || entries.some((e) => e.gear === "farm") ? await resolveBossList(client) : undefined,
    seeds,
    seedBase,
    maxSec,
    dpsMode,
    healMode,
    jobs,
    onProgress: progress,
    trace: opt("trace"),
  });
} catch (error) {
  fail(error.message);
}
if (!json && process.stderr.isTTY) process.stderr.write("\r");

const normalized = results.map((r) => r.roster);
const traceIndex = opt("trace") === undefined ? undefined : /^\d+$/.test(opt("trace")) ? Number(opt("trace")) : normalized[0].findIndex((m) => m.name === opt("trace"));
const baseline = results[0].summary;
const meta = { client: client.id, boss: { id: boss.row.id, name: boss.row.name, level: boss.row.level, hp: Number(boss.row.hp) }, seeds, seedBase, maxSec, dpsMode, healMode, level };

if (json) {
  console.log(JSON.stringify({ ...meta, results: results.map((r) => ({ label: r.label, summary: r.summary, fights: r.fights })) }));
  process.exit(0);
}

const bossLine = `${boss.row.name.replace(/#/g, "").replace(/_/g, " ")} (npc ${boss.row.id}, level ${boss.row.level}, ${Number(boss.row.hp).toLocaleString("en-US")} HP)`;
console.log(`${bossLine}; ${normalized[0].length} members at level ${level}; Auto-DPS ${dpsMode}, auto-heal ${healMode}; client ${client.id}\n`);
console.log("Damage is the average per fight and member. HP, AC and Mana: maximum hit points, armor class and mana the client computes before the fight (raid buffs included, Raid Resolve not). Melee: weapon attacks. Pet: pet melee and procs. Nuke: cast damage spells. DoT: damage over time. Proc: weapon and item procs. Heal and Spent: healing done and mana spent. * marks the leader.\n");
console.log(memberTable(baseline));
console.log();
for (const line of fightLines(baseline, maxSec)) console.log(line);
if (flag("class-sweep")) {
  console.log(`\nClass sweep: slot ${opt("slot")} set to each class\n`);
  console.log(sweepTable(results, baseline, maxSec));
}
if (flag("gear-report")) {
  console.log("\nGear of each member (as given)\n");
  for (const line of gearReport(normalized[0], await byId("items"))) console.log(line);
}
if (traceIndex !== undefined) {
  console.log();
  for (const line of traceLines(normalized[0][traceIndex].name, results[0].fights[0].trace)) console.log(line);
}
if (flag("calls")) {
  const calls = results[0].fights[0].calls;
  console.log("\nClient function calls in the first fight");
  console.log(Object.entries(calls).map(([k, v]) => `${k} ${v}`).join("\n"));
  console.log("\nCombat events recorded in the first fight: " + JSON.stringify(results[0].fights[0].eventTypes));
  console.log("\nScene methods the raid code called on the stub scene: " + JSON.stringify(results[0].fights[0].sceneCalls));
}
const errors = results.flatMap((r) => r.fights.flatMap((f) => f.clockErrors));
if (errors.length) console.log(`\n${errors.length} timer callbacks threw; first: ${errors[0]}`);
process.exit(0);
