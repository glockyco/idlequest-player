// Checks the boss-kill planner (docs/plans/raids.md). Run with `bun test`.
import { expect, test } from "bun:test";
import { LOOK, OPEN_BUY, bossValues, dailyCandidates, hoursLastDay, killId, nextBossKill, nextLook, noteSightings, openBosses, potionSpent, raidHours, standingBosses, watchRows, watchedBosses } from "../tools/lib/boss-plan.mjs";

const boss = (key: string, status = "available") => ({ key, name: key, zone: `${key}zone`, status });
const daily = (resetsRemaining: number, bosses: object[]) => ({ resetsRemaining, resetLimit: 2, bosses });
const win = { kills: 6, fights: 6 };
const lose = { kills: 5, fights: 6 };

test("free summons offer available bosses, and a saved copy resumes without one", () => {
  const d = daily(0, [boss("vox"), boss("nagafen", "cooldown"), boss("trak", "limit"), boss("cazic", "disabled"), boss("phin", "resume")]);
  expect(dailyCandidates(d).map((b) => b.key)).toEqual(["phin"]);
  expect(dailyCandidates({ ...d, resetsRemaining: 1 }).map((b) => b.key)).toEqual(["vox", "phin"]);
});

test("a summon goes by raid even when a group would kill it, and a boss any simulated fight fails is skipped", () => {
  const d = daily(2, [boss("vox"), boss("phin"), boss("cazic")]);
  const odds = { vox: { groups: { G1: win }, raid: win }, phin: { raid: win }, cazic: { raid: lose } };
  const r = nextBossKill({ daily: d, odds, value: { phin: 5, vox: 1 } });
  expect(r.kill).toMatchObject({ key: "phin", way: "raid", source: "summon" });
  expect(r.skipped).toEqual([{ key: "cazic", why: "the simulator kills it in 5 of 6 fights" }]);
});

test("a raid runs as soon as one is due, the most valuable first, potions included", () => {
  const odds = { phin: { raid: win }, lodizal: { raid: win } };
  const potions = [{ key: "lodizal", name: "Lodizal", zone: "iceclad", itemId: 990113, who: "Tagujazolu" }];
  // One summon spent: the other one and the potion run now, the potion led by its holder.
  expect(nextBossKill({ daily: daily(1, [boss("phin")]), potions, odds, value: { lodizal: 3, phin: 1 } }).kill).toMatchObject({ key: "lodizal", way: "raid", source: "potion", who: "Tagujazolu" });
  expect(nextBossKill({ daily: daily(1, [boss("phin")]), potions, odds, value: { lodizal: 1, phin: 3 } }).kill).toMatchObject({ key: "phin", source: "summon" });
  // No summon left: the potion still runs.
  expect(nextBossKill({ daily: daily(0, [boss("phin")]), potions, odds }).kill).toMatchObject({ key: "lodizal" });
});

test("bosses go by worth per raid minute, a goal boss among them, and a goal boss the simulator does not kill waits", () => {
  // After the server's restart of 2026-11-12: Cazic-Thule, a goal boss, fights ten minutes for
  // little loot, and Lady Vox dies in 21 s for more.
  const d = daily(2, [boss("vox"), boss("cazic")]);
  const odds = { vox: { raid: { ...win, meanSec: 21 } }, cazic: { raid: { ...win, meanSec: 589 } } };
  const value = { vox: 2.69, cazic: 1.7 };
  expect(nextBossKill({ daily: d, odds, value, first: ["cazic"] }).kill).toMatchObject({ key: "vox" });
  // Each raid takes three minutes besides its fight, so Vox's loot has to be worth about a third
  // of Cazic's: 0.5 over 3.35 minutes beats 1.7 over 12.8, and 0.3 does not.
  expect(nextBossKill({ daily: d, odds, value: { vox: 0.5, cazic: 1.7 }, first: ["cazic"] }).kill).toMatchObject({ key: "vox" });
  expect(nextBossKill({ daily: d, odds, value: { vox: 0.3, cazic: 1.7 }, first: ["cazic"] }).kill).toMatchObject({ key: "cazic", way: "raid", source: "summon" });
  // A goal boss the simulator does not kill in every fight still waits.
  expect(nextBossKill({ daily: d, odds: { ...odds, cazic: { raid: lose }, vox: { raid: lose } }, value, first: ["cazic"] }).kill).toBeNull();
});

test("a raid boss that stands in the open world is killed there, without a summon", () => {
  const NOW = 1_800_000_000_000;
  // Phinigel Autropos in Kedge Keep on 2026-11-12: on the daily list with both summons spent, and
  // alive at his spawn point in a group's zone. A named enemy on neither list is no boss kill.
  const seen = {
    "phinigel autropos": { name: "Phinigel_Autropos", zone: "kedge", level: 53, state: "alive", seenAt: NOW - 5 * 60000 },
    "lord yelinak": { name: "Lord_Yelinak", zone: "skyshrine", level: 70, state: "alive", seenAt: NOW - 10 * 60000 },
    innoruuk: { name: "Innoruuk", zone: "hateplane", level: 70, state: "respawning", seenAt: NOW - 60000 },
    "lady vox": { name: "Lady_Vox", zone: "permafrost", level: 55, state: "alive", seenAt: NOW - 3 * 3600000 },
    "master yael": { name: "Master_Yael", zone: "hole", level: 56, state: "alive", seenAt: NOW - 60000 },
  };
  const d = daily(0, [{ key: "phinigel", name: "Phinigel Autropos", zone: "kedge", status: "limit" }, { key: "innoruuk", name: "Innoruuk", zone: "hateplane", status: "limit" }, { key: "vox", name: "Lady Vox", zone: "permafrost", status: "limit" }]);
  const open = openBosses({ seen, daily: d, goal: ["Lord Yelinak"], now: NOW });
  // The dead one, the one last seen three hours ago and the one on no list are left out.
  expect(open).toEqual([{ key: "phinigel", name: "Phinigel Autropos", zone: "kedge" }, { key: "lord yelinak", name: "Lord Yelinak", zone: "skyshrine" }]);
  const odds = { phinigel: { raid: win, groups: { G1: win } }, "lord yelinak": { raid: lose } };
  const r = nextBossKill({ daily: d, open, odds, value: { phinigel: 0.17 } });
  expect(r.kill).toMatchObject({ key: "phinigel", zone: "kedge", way: "raid", source: "open" });
  expect(killId(r.kill)).toBe("boss:open:phinigel");
  expect(r.skipped).toEqual([{ key: "lord yelinak", why: "the simulator kills it in 5 of 6 fights" }]);
  // A goal boss that stands is planned, and a boss that stands is not summoned.
  const goal = nextBossKill({ daily: daily(2, [...d.bosses.map((b) => ({ ...b, status: "available" }))]), open, odds: { ...odds, "lord yelinak": { raid: win }, innoruuk: { raid: win } }, value: { phinigel: 0.17, innoruuk: 1.2, "lord yelinak": 21 }, first: ["lord yelinak"] });
  expect(goal.kill).toMatchObject({ key: "lord yelinak", source: "open" });
  const noGoal = nextBossKill({ daily: daily(2, [...d.bosses.map((b) => ({ ...b, status: "available" }))]), open: [open[0]], odds: { ...odds, innoruuk: { raid: win } }, value: { phinigel: 5, innoruuk: 1.2 } });
  expect(noGoal.kill).toMatchObject({ key: "phinigel", source: "open" });
  // Without raid time that is paid, a goal boss buys its hour and the others wait for the budget.
  const unpaid = nextBossKill({ daily: d, open, paid: false, odds: { ...odds, "lord yelinak": { raid: win } }, value: { phinigel: 0.17 }, first: ["lord yelinak"] });
  expect(unpaid.kill).toMatchObject({ key: "lord yelinak", source: "open" });
  expect(unpaid.skipped).toEqual([{ key: "phinigel", why: "it stands in the open world, and 2 hours of raid time ran in the last day, the most such bosses may bring it to" }]);
});

test("an open-world boss outside the goal buys an hour within the day's hours, for kills worth one", () => {
  // Cazic-Thule and Trakanon come back two minutes apart on 2026-11-13: one hour for both.
  const open = [{ key: "trakanon", name: "Trakanon", zone: "sebilis" }, { key: "venril", name: "Venril Sathir", zone: "karnor" }];
  const odds = { trakanon: { raid: win }, venril: { raid: win } };
  const buys = nextBossKill({ open, paid: false, canBuy: true, odds, value: { trakanon: 1.05, venril: 0.16 } });
  expect(buys.kill).toMatchObject({ key: "trakanon", source: "open" });
  // Venril Sathir alone is worth too little, and a boss the raid loses adds nothing to the hour.
  const cheap = nextBossKill({ open, paid: false, canBuy: true, odds: { ...odds, trakanon: { raid: lose } }, value: { trakanon: 1.05, venril: 0.16 } });
  expect(cheap.kill).toBeNull();
  expect(cheap.skipped.find((s) => s.key === "venril")!.why).toBe("it stands in the open world, and an hour of raid time would bring kills worth 0.16 h, under the 1 h it has to bring");
  // In an hour that is paid already, every one of them is killed.
  expect(nextBossKill({ open: [open[1]], paid: true, odds, value: { venril: 0.16 } }).kill).toMatchObject({ key: "venril" });

  // The hours on record: a renewal is another hour, the same end read twice is one.
  const NOW = 1_800_000_000_000;
  const H = 3600000;
  let ledger = raidHours([], { active: true, expiresAt: NOW + H }, NOW);
  ledger = raidHours(ledger, { active: true, expiresAt: NOW + H + 20000 }, NOW + 300000);
  ledger = raidHours(ledger, { active: true, expiresAt: NOW + 2 * H }, NOW + 50 * 60000);
  ledger = raidHours(ledger, { active: false, expiresAt: NOW + 2 * H }, NOW + 3 * H);
  expect(ledger).toEqual([NOW + H, NOW + 2 * H]);
  expect(hoursLastDay(ledger, NOW + 3 * H)).toBe(OPEN_BUY.hoursADay);
  expect(hoursLastDay(ledger, NOW + 25.5 * H)).toBe(1);
});

test("the watched bosses are those a live spawn point puts up, and a look goes where one is due or unknown", () => {
  const NOW = 1_800_000_000_000;
  const H = 3600000;
  const d = daily(0, [{ key: "cazic", name: "Cazic-Thule", zone: "fearplane", status: "limit" }, { key: "phinigel", name: "Phinigel Autropos", zone: "kedge", status: "limit" }, { key: "vox", name: "Lady Vox", zone: "permafrost", status: "limit" }]);
  const goal = ["Cazic-Thule", "Lord Yelinak", "Tunare"];
  const spawns = new Map([
    ["Cazic-Thule", [{ zone: "fearplane", point: 13816, respawnMs: 72 * H }]],
    ["Phinigel Autropos", [{ zone: "kedge", point: 4685, respawnMs: 12 * H }]],
    // A point in another zone than the list's is not the list's boss, and Tunare has none.
    ["Lady Vox", [{ zone: "tutorial", point: 1, respawnMs: H }]],
    ["Lord Yelinak", [{ zone: "skyshrine", point: 24841, respawnMs: 72 * H }]],
    ["Tunare", []],
  ]);
  const watch = watchedBosses({ daily: d, goal, spawns });
  expect(watch).toEqual([
    { key: "cazic", name: "Cazic-Thule", zone: "fearplane", respawnMs: 72 * H, goal: true },
    { key: "phinigel", name: "Phinigel Autropos", zone: "kedge", respawnMs: 12 * H, goal: false },
    { key: "lord yelinak", name: "Lord Yelinak", zone: "skyshrine", respawnMs: 72 * H, goal: true },
  ]);

  // Nobody has seen any of them: the goal's bosses first.
  expect(nextLook({ watch, seen: {}, now: NOW })).toMatchObject({ key: "cazic", zone: "fearplane", until: 0, why: "no tab has seen it yet" });
  const seen = {
    "cazic thule": { name: "Cazic_Thule", zone: "fearplane", state: "respawning", respawnAt: NOW + 20 * 60000, seenAt: NOW - H },
    "lord yelinak": { name: "Lord_Yelinak", zone: "skyshrine", state: "respawning", respawnAt: NOW + 4 * 60000, seenAt: NOW - 5 * H },
    "phinigel autropos": { name: "Phinigel_Autropos", zone: "kedge", state: "alive", seenAt: NOW - 2 * H },
  };
  // A respawn inside the lead time goes first, and the look stays past it.
  const notPhinigel = (w: { key: string }) => w.key !== "phinigel";
  expect(nextLook({ watch, seen, now: NOW, wanted: notPhinigel })).toEqual({ key: "lord yelinak", name: "Lord Yelinak", zone: "skyshrine", until: NOW + 4 * 60000 + LOOK.waitMs, why: expect.stringMatching(/^its respawn is due at \d\d:\d\d$/) });
  // A look sent for him a quarter of an hour ago is not sent again, and nothing else is due,
  // unless the plan would kill the boss that stood two hours ago.
  const lastLook = (key: string) => (key === "lord yelinak" ? NOW - 15 * 60000 : 0);
  expect(nextLook({ watch, seen, now: NOW, lastLook, wanted: notPhinigel })).toBeNull();
  expect(nextLook({ watch, seen, now: NOW, lastLook })).toMatchObject({ key: "phinigel", until: 0 });
  // A respawn that passed with no tab there is looked at once, without a wait. A boss the plan
  // would not kill gets no look at all.
  expect(nextLook({ watch, seen, now: NOW + 2 * H, wanted: notPhinigel })).toMatchObject({ key: "lord yelinak", until: 0, why: expect.stringMatching(/^its respawn was due at/) });
  expect(nextLook({ watch, seen, now: NOW + 2 * H, wanted: () => false })).toBeNull();
});

test("the sightings keep each kill and respawn, and a boss that is down shows how long it stood", () => {
  const H = 3600000;
  const T = 1_800_000_000_000;
  const watch = [{ key: "trakanon", name: "Trakanon", zone: "sebilis", respawnMs: 72 * H, goal: false }, { key: "vox", name: "Lady Vox", zone: "permafrost", respawnMs: 72 * H, goal: false }];
  const at = (state: string, seenAt: number, respawnAt: number | null = null) => ({ trakanon: { name: "Trakanon", zone: "sebilis", state, seenAt, respawnAt } });
  // Down with a respawn at T, seen twice: one row. Then up, then down again 25 minutes after T.
  let log = noteSightings([], watch, at("respawning", T - 10 * H, T));
  log = noteSightings(log, watch, at("respawning", T - 5 * H, T));
  log = noteSightings(log, watch, at("alive", T + 60000));
  const down = at("respawning", T + H, T + 25 * 60000 + 72 * H);
  log = noteSightings(log, watch, down);
  expect(log.map((r) => [r.state, r.respawnAt])).toEqual([["respawning", T], ["alive", null], ["respawning", T + 25 * 60000 + 72 * H]]);
  expect(watchRows({ watch, seen: down, log, value: { trakanon: 1.05 }, odds: { trakanon: { raid: win } } })).toEqual([
    { key: "trakanon", name: "Trakanon", zone: "sebilis", goal: false, state: "down", seenAt: T + H, respawnAt: T + 25 * 60000 + 72 * H, killedAt: T + 25 * 60000, livedMs: 25 * 60000, value: 1.05, raid: win },
    { key: "vox", name: "Lady Vox", zone: "permafrost", goal: false, state: "unknown", seenAt: null, respawnAt: null, killedAt: null, livedMs: null, value: null, raid: null },
  ]);
});

test("a boss is worth its wanted drops at their chances, one copy per taker's slot", () => {
  // X1 reaches its next level in 2 hours, so a gain of 100 tenths of a percent worn 10 levels is
  // worth 2 hours: the cloak's 25% gives 0.5, and of two back pieces only the better one counts.
  const targets = [{ npc: "#Lord Nagafen", items: [
    { item: "Cloak", to: "X1", slot: "back", gain: 100, drop: 0.25 },
    { item: "Cape", to: "X1", slot: "back", gain: 40, drop: 0.25 },
    { item: "Crook", to: "X2", slot: "primary", gain: 50, drop: 0.5 },
  ] }];
  const values = bossValues({ bosses: [{ key: "nagafen", name: "Lord Nagafen" }, { key: "vox", name: "Lady Vox" }, { key: "cazic", name: "Cazic-Thule" }], targets: [...targets, { npc: "Cazic_Thule", items: [{ item: "Bone", to: "X1", slot: "range", gain: 50, drop: 1 }] }], hoursPerLevel: { X1: 2, X2: 2 } });
  expect(values.nagafen).toBeCloseTo(0.25 * 2 + 0.5 * 1);
  expect(values.vox).toBe(0);
  // The daily list's "Cazic-Thule" is the content's "Cazic_Thule".
  expect(values.cazic).toBeCloseTo(1);
});

test("a potion a raid task used is spent until the next survey, and one a task never reached is not", () => {
  const p = { key: "lodizal", name: "Lodizal", zone: "iceclad", itemId: 990113, who: "Tagujazolu" };
  const id = killId({ ...p, source: "potion" });
  // The raid fought and ended, with or without the kill: the potion is gone.
  expect(potionSpent([{ t: 200, id, status: "done", step: "fight Lodizal" }], p, 100)).toBe(true);
  expect(potionSpent([{ t: 200, id, status: "failed", step: "use potion 990113" }], p, 100)).toBe(true);
  // A task still running has no outcome yet, so it counts until it has one.
  expect(potionSpent([{ t: 200, id }], p, 100)).toBe(true);
  // A fight that did not end before the task could start left the potion in the bags.
  expect(potionSpent([{ t: 200, id, status: "failed", step: "stop" }], p, 100)).toBe(false);
  // A newer survey lists what the bags hold after that raid, and another holder's potion is its own.
  expect(potionSpent([{ t: 200, id, status: "done", step: "fight Lodizal" }], p, 300)).toBe(false);
  expect(potionSpent([{ t: 200, id, status: "done", step: "fight Lodizal" }], { ...p, who: "Thalgrimm" }, 100)).toBe(false);
});

test("a summoned boss that no raid killed stands until one does, and comes before every other potion", () => {
  const casino = [{ key: "lodizal", name: "Lodizal", zone: "iceclad", itemId: 990113 }, { key: "tolapumj", name: "Tolapumj", zone: "sebilis", itemId: 990107 }];
  const id = "boss:potion:990113:Tagujazolu";
  const raid = (t: number, rest: object) => ({ t, kind: "raid", id, ...rest });
  const NOW = 10_000_000;
  // The fight ended without a kill: Lodizal fled and stands at his spawn point.
  const fled = [raid(1000, { status: "done", step: "fight Lodizal", result: "ended Lodizal in 49 s with 71 of 71 standing" })];
  expect(standingBosses(fled, casino, NOW)).toEqual([{ key: "lodizal", name: "Lodizal", zone: "iceclad", itemId: 990113, who: "Tagujazolu", since: 1000, fights: 1 }]);
  // A task that never reached him changes nothing, and neither does a potion the server refused.
  const again = [...fled, raid(2000, { status: "failed", step: "stop" }), { t: 2500, kind: "raid", id: "boss:potion:990107:Ibaegrix", status: "failed", step: "use potion 990107" }];
  expect(standingBosses(again, casino, NOW).map((s) => [s.key, s.fights])).toEqual([["lodizal", 1]]);
  // A kill ends it, and so does a raid that finds him gone.
  expect(standingBosses([...again, raid(3000, { status: "done", step: "collect the loot", result: "killed Lodizal in 55 s with 71 of 71 standing, looted 6 items" })], casino, NOW)).toEqual([]);
  expect(standingBosses([...again, raid(3000, { status: "failed", step: "target" })], casino, NOW)).toEqual([]);
  expect(standingBosses(fled, casino, 1000 + 25 * 3600000)).toEqual([]);

  // While he stands, his raid runs without a potion, and the other potion waits.
  const standing = standingBosses(fled, casino, NOW);
  const potions = [{ key: "tolapumj", name: "Tolapumj", zone: "sebilis", itemId: 990107, who: "Ibaegrix" }];
  const odds = { lodizal: { raid: win }, tolapumj: { raid: win } };
  const plan = nextBossKill({ daily: daily(0, []), potions, standing, odds, value: { tolapumj: 9 } });
  expect(plan.kill).toMatchObject({ key: "lodizal", source: "standing", who: "Tagujazolu", zone: "iceclad" });
  expect(killId(plan.kill)).toBe(id);
  expect(plan.skipped).toEqual([{ key: "tolapumj", why: "Lodizal stands summoned, and the server takes no other potion until it is dead" }]);
});
