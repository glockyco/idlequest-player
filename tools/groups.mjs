#!/usr/bin/env bun
// One line per leveling group: level, zone, XP per hour, coin per hour, where the time went, the idle share by the
// page's activity labels with its main cause, escapes, deaths and the member whose recovery the
// party waited for most, over the last `--last` minutes of each leader's live run (runs/live/<leader>,
// written by iqd), or between `--since` and `--until` (ms epoch) for the blocks of an experiment.
// Groups come from data/roster.json and class mixes from the iqd database, so mixes can be compared
// side by side.
//
//   bun tools/groups.mjs [--last 60 | --since <ms> --until <ms>] [--json]
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({ options: { last: { type: "string", default: "60" }, since: { type: "string" }, until: { type: "string" }, json: { type: "boolean", default: false } } });
const REPO = new URL("..", import.meta.url).pathname;
const until = opt.until ? Number(opt.until) : Date.now();
const since = opt.since ? Number(opt.since) : until - Number(opt.last) * 60000;
const minutes = Math.round((until - since) / 60000);
const roster = JSON.parse(await readFile(`${REPO}data/roster.json`, "utf8"));
const db = new Database(`${REPO}runs/iq.db`, { readonly: true });
const classOf = new Map(db.query("SELECT name, class FROM characters").all().map((r) => [r.name, r.class]));
const SHORT = { Warrior: "War", Cleric: "Clr", Paladin: "Pal", Ranger: "Rng", "Shadow Knight": "SK", Druid: "Dru", Monk: "Mnk", Bard: "Brd", Rogue: "Rog", Shaman: "Shm", Necromancer: "Nec", Wizard: "Wiz", Magician: "Mag", Enchanter: "Enc" };

async function analyze(leader) {
  const proc = Bun.spawn(["bun", `${REPO}tools/analyze.mjs`, `${REPO}runs/live/${leader}`, "--since", String(since), "--until", String(until), "--json"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// Deaths of the group's own characters, and the leader's among them with the XP they cost ("You
// lose N experience."). The bot repeats each death as a line of its own, and pets with generated
// names die as well, so only chat lines naming the leader or a member count.
async function deaths(leader, members) {
  try {
    const lines = (await readFile(`${REPO}runs/live/${leader}/events.jsonl`, "utf8")).trimEnd().split("\n");
    const n = { all: 0, leader: 0, xpLost: 0 };
    for (let k = lines.length - 1; k >= 0; k--) {
      const e = JSON.parse(lines[k]);
      if (e.t < since) break;
      if (e.t > until || e.type === "bot") continue;
      const victim = /^(.+?) has been slain!$/.exec(e.text)?.[1];
      const mine = /^You have been slain/.test(e.text);
      if (mine || members.includes(victim)) n.all++;
      if (mine) n.leader++;
      n.xpLost += Number(/^You lose (\d+) experience/.exec(e.text)?.[1] ?? 0);
    }
    return n;
  } catch {
    return null;
  }
}

const out = [];
for (const g of roster.groups.filter((x) => x.members?.length)) {
  const leader = g.members[0];
  const a = await analyze(leader);
  const snap = db.query("SELECT snap FROM sessions WHERE leader = ? AND ended IS NULL ORDER BY id DESC LIMIT 1").get(leader);
  const sn = snap?.snap ? JSON.parse(snap.snap) : null;
  const limiter = Object.entries(a?.recover?.limiterSeconds ?? {}).sort((x, y) => y[1] - x[1])[0];
  // Idle and dead shares of the labeled seconds, and the idle cause with the most seconds.
  const idleRows = Object.entries(a?.activity ?? {}).filter(([k]) => k.startsWith("idle") || k === "dead");
  const idleCause = idleRows.sort((x, y) => y[1].sec - x[1].sec)[0];
  out.push({
    group: g.id,
    leader,
    mix: g.members.map((n) => SHORT[classOf.get(n)] ?? "?").join(" "),
    level: sn?.leader?.level ?? null,
    zone: sn?.zone ?? null,
    xpPerHour: a?.outcome?.xpPerHour ?? null,
    killsPerMin: a?.outcome?.killsPerMin ?? null,
    // Gross coin the leader picked up, in platinum per hour (tools/analyze.mjs), for the raid budget.
    platPerHour: a?.outcome?.platPerHour ?? null,
    combat: a?.timeShare?.combat?.share ?? null,
    move: a?.timeShare?.move?.share ?? null,
    recover: a?.timeShare?.recover?.share ?? null,
    idle: a?.activity ? idleRows.reduce((s, [, v]) => s + v.share, 0) : null,
    idleCause: idleCause ? idleCause[0].replace(/^idle\//, "") : null,
    escapes: a?.escapes?.count ?? null,
    ...(await deaths(leader, g.members).then((d) => ({ deaths: d?.all ?? null, leaderDeaths: d?.leader ?? null, xpLost: d?.xpLost ?? null }))),
    waitedFor: limiter ? `${limiter[0]} ${Math.round(limiter[1])}s` : null,
    // Seconds of recovery each member's bar held the party, by `<name>:<hp|mana>` ("me" is the leader).
    limiters: a?.recover?.limiterSeconds ?? {},
    // The party supply's mana regeneration, from the leader's last snapshot.
    supportManaRegen: sn?.leader?.supportManaRegen ?? null,
    // The party's run speed and its Bard's run song, from the leader's last snapshot.
    runSpeed: sn?.runSpeed ?? null,
  });
}

if (opt.json) console.log(JSON.stringify(out));
else {
  const pct = (x) => (x == null ? "  -" : `${Math.round(100 * x)}%`.padStart(4));
  const big = (n) => (n == null ? "-" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);
  console.log(`${minutes} min per group, ${new Date(since).toTimeString().slice(0, 5)} to ${new Date(until).toTimeString().slice(0, 5)} (runs/live/<leader>)`);
  console.log("group leader        lvl  mix                      zone                   XP/h   k/min  pp/h fight move recov idle (cause)       esc dead (leader, XP lost)  waited for");
  for (const r of out)
    console.log(
      `${r.group.padEnd(5)} ${r.leader.padEnd(13)} ${String(r.level ?? "-").padStart(3)}  ${r.mix.padEnd(24)} ${String(r.zone ?? "-").slice(0, 21).padEnd(21)} ${big(r.xpPerHour).padStart(6)} ${String(r.killsPerMin ?? "-").padStart(6)} ${String(r.platPerHour != null ? Math.round(r.platPerHour) : "-").padStart(5)} ${pct(r.combat)} ${pct(r.move)} ${pct(r.recover)} ${pct(r.idle)} ${`(${r.idleCause ?? "-"})`.padEnd(13)} ${String(r.escapes ?? "-").padStart(4)} ${String(r.deaths ?? "-").padStart(4)} (${r.leaderDeaths ?? "-"}, ${r.xpLost ? big(r.xpLost) : "0"})`.padEnd(171) + `  ${r.waitedFor ?? ""}`,
    );
}
