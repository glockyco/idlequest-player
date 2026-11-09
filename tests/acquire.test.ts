// Checks the gear acquisition model (tools/lib/acquire.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { ACQUIRE, bestWay, copyValue, elasticity, netRate, ways } from "../tools/lib/acquire.mjs";

const member = (name: string, level: number) => ({ name, level });
const tab = (level: number, zone: string) => ({ label: "A", group: "G1", zone, rotation: [zone], members: [member("A0", level)] });
const item = (gain: number, hours: number, drop = 0.1) => ({ item: "X", to: "X1", level: 30, gain, hours, drop });

test("the XP elasticity follows the model's table between its levels", () => {
  expect(elasticity(10)).toBe(0.5);
  expect(elasticity(29)).toBe(0.74);
  expect(elasticity(40)).toBeCloseTo(0.835);
  expect(elasticity(60)).toBe(0.85);
});

test("a copy adds its gain to the group's XP rate for the hours it is worn", () => {
  // 1% of the group's XP rate, 1.5 hours a level: 0.01 x 10 levels x 1.5 hours.
  expect(copyValue(item(10, 1), { X1: 1.5 })).toBeCloseTo(0.01 * ACQUIRE.wearLevels * 1.5);
  // A taker whose group's pace is unknown adds nothing yet.
  expect(copyValue(item(10, 1), {})).toBe(0);
});

test("drops that roll on their own shorten the hunting for the first copy, and a shared zone costs a share of it", () => {
  const x = { npc: "a fiend", zone: "unrest", npcLevel: 30, spawn: 1, points: 1, items: [item(600, 2), item(300, 2)] };
  const pace = { X1: 1 };
  const [errand] = ways(tab(30, "unrest"), x, { hoursPerLevel: pace });
  expect(errand.kind).toBe("errand");
  expect(errand.hours).toBeCloseTo(1);
  expect(errand.value).toBeCloseTo((copyValue(item(600, 2), pace) + copyValue(item(300, 2), pace)) / 2);
  expect(errand.cost).toBe(0);
  const other = { ...tab(30, "unrest"), label: "B" };
  const [shared] = ways(tab(30, "unrest"), x, { tabs: [other], hoursPerLevel: pace });
  expect(shared.cost).toBeCloseTo(ACQUIRE.sharedCost * shared.hours);
});

test("outside the rotation a camp costs what the trip zone does not pay, and a visit its whole time", () => {
  const x = { npc: "Hangman", zone: "trakanon", npcLevel: 30, spawn: 0.02, points: 6, items: [item(1000, 1.39, 1)] };
  const pace = { X1: 1 };
  const [camp, visit] = ways(tab(30, "paw"), x, { hoursPerLevel: pace, zoneShare: () => 0.25 });
  expect(camp).toMatchObject({ kind: "camp", hours: 1.39 });
  expect(camp.cost).toBeCloseTo(0.75 * 1.39);
  expect(visit.kind).toBe("visit");
  expect(visit.up).toBeCloseTo(1 - 0.98 ** 6);
  expect(visit.value).toBeCloseTo((1 - 0.98 ** 6) * copyValue(item(1000, 1.39, 1), pace));
  expect(visit.cost).toBe(ACQUIRE.visitHours);
  expect(bestWay(tab(30, "paw"), x, { hoursPerLevel: pace, zoneShare: () => 0.25 })).toEqual(netRate(visit) > netRate(camp) ? visit : camp);
});

test("an enemy more than the kill margin above the leader has no way", () => {
  const x = (npcLevel: number) => ({ npc: "a broodling", zone: "paw", npcLevel, spawn: 1, points: 1, items: [item(100, 1)] });
  expect(bestWay(tab(30, "paw"), x(30 + ACQUIRE.killMargin), {})).not.toBeNull();
  expect(bestWay(tab(30, "paw"), x(31 + ACQUIRE.killMargin), {})).toBeNull();
});
