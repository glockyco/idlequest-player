// Checks the boss-kill planner (docs/plans/raids.md). Run with `bun test`.
import { expect, test } from "bun:test";
import { bossValues, dailyCandidates, killId, nextBossKill, potionSpent, standingBosses } from "../tools/lib/boss-plan.mjs";

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

test("a boss is worth its wanted drops at their chances, one copy per taker's slot", () => {
  // X1 reaches its next level in 2 hours, so a gain of 100 tenths of a percent worn 10 levels is
  // worth 2 hours: the cloak's 25% gives 0.5, and of two back pieces only the better one counts.
  const targets = [{ npc: "#Lord Nagafen", items: [
    { item: "Cloak", to: "X1", slot: "back", gain: 100, drop: 0.25 },
    { item: "Cape", to: "X1", slot: "back", gain: 40, drop: 0.25 },
    { item: "Crook", to: "X2", slot: "primary", gain: 50, drop: 0.5 },
  ] }];
  const values = bossValues({ bosses: [{ key: "nagafen", name: "Lord Nagafen" }, { key: "vox", name: "Lady Vox" }], targets, hoursPerLevel: { X1: 2, X2: 2 } });
  expect(values.nagafen).toBeCloseTo(0.25 * 2 + 0.5 * 1);
  expect(values.vox).toBe(0);
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
