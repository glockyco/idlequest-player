// Checks the boss-kill planner (docs/plans/raids.md). Run with `bun test`.
import { expect, test } from "bun:test";
import { bossValues, dailyCandidates, killId, nextBossKill, openBosses, potionSpent, standingBosses } from "../tools/lib/boss-plan.mjs";

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

test("a boss of the raid goal that no raid has killed goes before the more valuable ones", () => {
  // Cazic-Thule is on the daily list and in the goal, and his loot is worth little next to Nagafen's.
  const d = daily(2, [boss("nagafen"), boss("cazic")]);
  const odds = { nagafen: { raid: win }, cazic: { raid: win } };
  const value = { nagafen: 1.6, cazic: 0 };
  expect(nextBossKill({ daily: d, odds, value }).kill).toMatchObject({ key: "nagafen" });
  expect(nextBossKill({ daily: d, odds, value, first: ["cazic"] }).kill).toMatchObject({ key: "cazic", way: "raid", source: "summon" });
  // A goal boss the simulator does not kill in every fight still waits.
  expect(nextBossKill({ daily: d, odds: { ...odds, cazic: { raid: lose } }, value, first: ["cazic"] }).kill).toMatchObject({ key: "nagafen" });
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
  // A goal boss that stands and that the raid kills goes first, and a boss that stands is not summoned.
  const goal = nextBossKill({ daily: daily(2, [...d.bosses.map((b) => ({ ...b, status: "available" }))]), open, odds: { ...odds, "lord yelinak": { raid: win }, innoruuk: { raid: win } }, value: { phinigel: 0.17, innoruuk: 1.2 }, first: ["lord yelinak"] });
  expect(goal.kill).toMatchObject({ key: "lord yelinak", source: "open" });
  const noGoal = nextBossKill({ daily: daily(2, [...d.bosses.map((b) => ({ ...b, status: "available" }))]), open: [open[0]], odds: { ...odds, innoruuk: { raid: win } }, value: { phinigel: 5, innoruuk: 1.2 } });
  expect(noGoal.kill).toMatchObject({ key: "phinigel", source: "open" });
  // Without raid time that is paid, an open-world boss buys no hour, unless the goal needs it.
  const unpaid = nextBossKill({ daily: d, open, paid: false, odds: { ...odds, "lord yelinak": { raid: win } }, value: { phinigel: 0.17 }, first: ["lord yelinak"] });
  expect(unpaid.kill).toMatchObject({ key: "lord yelinak", source: "open" });
  expect(unpaid.skipped).toEqual([{ key: "phinigel", why: "it stands in the open world, and its raid waits for raid time that is paid" }]);
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
