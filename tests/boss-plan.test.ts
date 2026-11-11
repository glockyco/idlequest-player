// Checks the boss-kill planner (docs/plans/raids.md). Run with `bun test`.
import { expect, test } from "bun:test";
import { bossValues, dailyCandidates, nextBossKill } from "../tools/lib/boss-plan.mjs";

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
