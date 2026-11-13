// Checks the pure parts of the raid kit (tools/lib/raid-kit.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { applySwap, buildBatch, candidates, closestToKill, compareOutcomes, copyFor, dominates, improves, kitState, outcomeOf, probeRounds, spearman, undominated, withSwaps } from "../tools/lib/raid-kit.mjs";

// Content rows: slots, classes and races are bit masks (ear = 1 << 1 | 1 << 4, back = 1 << 8, primary = 1 << 13, secondary = 1 << 14).
const WARRIOR = 1;
const CLERIC = 2;
const HUMAN = 1;
const OGRE = 512;
const ALL = 65535;
const item = (id: number, name: string, over: Record<string, unknown>) => [id, { id, Name: name, classes: ALL, races: ALL, reqlevel: 0, itemclass: 0, ...over }] as const;
const items = new Map([
  item(1, "Plain Cloak", { slots: 1 << 8, ac: 2 }),
  item(2, "Fine Cloak", { slots: 1 << 8, ac: 10, hp: 5 }),
  item(3, "Warrior Cloak", { slots: 1 << 8, ac: 12, classes: WARRIOR }),
  item(4, "Human Cloak", { slots: 1 << 8, ac: 11, races: HUMAN }),
  item(5, "Lofty Cloak", { slots: 1 << 8, ac: 13, reqlevel: 40 }),
  item(6, "Lore Cloak", { slots: 1 << 8, ac: 9, loregroup: -1 }),
  item(7, "Silver Stud", { slots: (1 << 1) | (1 << 4), mana: 5 }),
  item(8, "Long Sword", { slots: 1 << 13, damage: 9, delay: 25, itemtype: 0 }),
  item(9, "Great Axe", { slots: 1 << 13, damage: 20, delay: 40, itemtype: 1 }),
  item(10, "Buckler", { slots: 1 << 14, ac: 6, itemtype: 8 }),
  item(11, "Sack", { slots: 1 << 8, ac: 99, bagslots: 8 }),
  item(12, "Old Sword", { slots: 1 << 13, damage: 4, delay: 30, itemtype: 0 }),
  item(13, "Divine Cloak", { slots: 1 << 8, ac: 50, deity: 396 }),
  item(14, "Proc Cloak", { slots: 1 << 8, ac: 1, proceffect: 77 }),
  item(15, "Dirk", { slots: (1 << 13) | (1 << 14), damage: 5, delay: 20, itemtype: 2 }),
  item(16, "Lore Ring", { slots: (1 << 15) | (1 << 16), ac: 4, loregroup: -1 }),
  item(17, "Plain Ring", { slots: (1 << 15) | (1 << 16), ac: 1 }),
]);

let instance = 0;
const worn = (who: string, itemId: number, slot: number, cls = 1, race = "Human", level = 50) => ({ characterName: who, class: cls, race, level, location: "Equipped", slot, itemId, itemInstanceId: ++instance, blockReason: "" });
const carried = (who: string, itemId: number, cls = 1, level = 50, blockReason = "") => ({ characterName: who, class: cls, level, location: "Carried", slot: 25, itemId, itemInstanceId: ++instance, blockReason });
const state = (rows: unknown[], names: string[]) => kitState({ rows, items, names });
const ids = (list: { character: string; slot: number; itemId: number }[]) => list.map((s) => `${s.character}:${s.slot}:${s.itemId}`).sort();

test("a swap needs the slot, class, race and level of its character", () => {
  const rows = [worn("Tank", 1, 8), carried("Tank", 2), carried("Tank", 3), carried("Tank", 4), carried("Tank", 5), carried("Tank", 11), carried("Tank", 13), worn("Healer", 1, 8, 2, "Ogre", 30), carried("Healer", 2, 2, 30), carried("Healer", 3, 2, 30), carried("Healer", 4, 2, 30), carried("Healer", 5, 2, 30)];
  const swaps = candidates(state(rows, ["Tank", "Healer"]));
  // The Warrior-only, Human-only and level 40 cloaks fit the level 50 Human Warrior. The bag and the cloak that needs a deity fit nobody.
  expect(ids(swaps.filter((s) => s.character === "Tank"))).toEqual(["Tank:8:2", "Tank:8:3", "Tank:8:4", "Tank:8:5"]);
  // The level 30 Ogre Cleric wears only the cloak without limits.
  expect(ids(swaps.filter((s) => s.character === "Healer"))).toEqual(["Healer:8:2"]);
});

test("a jewelry item fits both ear slots and reports what the slot wears", () => {
  const rows = [worn("Tank", 1, 8), worn("Tank", 7, 1), carried("Tank", 7)];
  const swaps = candidates(state(rows, ["Tank"]));
  // The Stud is worn in slot 1 already, so only the second ear takes the other copy.
  expect(swaps.map((s) => [s.slot, s.itemId, s.from])).toEqual([[4, 7, null]]);
});

test("a copy serves one swap", () => {
  const rows = [worn("A", 1, 8), worn("B", 1, 8), carried("Holder", 2), carried("A", 7)];
  const s = state(rows.concat([worn("Holder", 1, 8)]), ["A", "B", "Holder"]);
  const first = candidates(s).find((c) => c.character === "A" && c.itemId === 2)!;
  expect(applySwap(s, first)).toBe("Holder");
  expect(candidates(s).filter((c) => c.itemId === 2)).toEqual([]);
  expect(() => applySwap(s, first)).toThrow();
});

test("two copies of an item serve two characters", () => {
  const rows = [worn("A", 1, 8), worn("B", 1, 8), carried("A", 2), carried("B", 2)];
  const s = state(rows, ["A", "B"]);
  // Each character wears its own copy, because one copy serves one swap.
  expect(copyFor(s, "A", 2)).not.toBe(copyFor(s, "B", 2));
  const batch = buildBatch(s, [], candidates(s));
  expect(ids(batch)).toEqual(["A:8:2", "B:8:2"]);
});

test("a lore item is one copy per character, and a copy serves one character", () => {
  const rows = [worn("Own", 1, 8), carried("Own", 6), worn("Wants", 1, 8), worn("Giver", 1, 8), carried("Giver", 6)];
  const s = state(rows, ["Own", "Wants", "Giver"]);
  const swaps = candidates(s).filter((c) => c.itemId === 6);
  // Each holder wears its own copy, and Wants takes either one.
  expect(ids(swaps)).toEqual(["Giver:8:6", "Own:8:6", "Wants:8:6"]);
  // Two copies serve two of them, in ranked order, and the third gets none.
  const ranked = ["Giver", "Own", "Wants"].map((who) => swaps.find((c) => c.character === who)!);
  expect(ids(buildBatch(s, [], ranked))).toEqual(["Giver:8:6", "Own:8:6"]);
});

test("a character that wears a lore item takes no second copy in its other ring slot", () => {
  const rows = [worn("B", 16, 15), worn("C", 17, 15), carried("C", 16)];
  const rings = candidates(state(rows, ["B", "C"])).filter((c) => c.itemId === 16);
  // B wears the Lore Ring in one slot, so a second copy from C is refused for the other. C takes its own copy in either slot.
  expect(rings.map((c) => `${c.character}:${c.slot}`).sort()).toEqual(["C:15", "C:16"]);
});

test("a two-hander needs an empty off hand and a shield needs a free hand", () => {
  const free = state([worn("A", 12, 13), carried("A", 9)], ["A"]);
  expect(candidates(free).map((c) => [c.slot, c.itemId])).toContainEqual([13, 9]);
  const shielded = state([worn("A", 12, 13), worn("A", 10, 14), carried("A", 9)], ["A"]);
  expect(candidates(shielded)).toEqual([]);
  const held = state([worn("A", 9, 13), carried("A", 10)], ["A"]);
  expect(candidates(held)).toEqual([]);
});

test("a weapon in the off hand needs Dual Wield", () => {
  // A Cleric has no Dual Wield and a Warrior has it at level 50.
  const cleric = candidates(state([worn("A", 12, 13, 2), carried("A", 15, 2)], ["A"]));
  expect(cleric.map((c) => c.slot)).toEqual([13]);
  const warrior = candidates(state([worn("A", 12, 13), carried("A", 15)], ["A"]));
  expect(warrior.map((c) => c.slot).sort()).toEqual([13, 14]);
});

test("deleted characters and non-roster holders give nothing", () => {
  const rows = [worn("A", 1, 8), carried("Gone-DELETED-1", 2), carried("Outsider", 2)];
  expect(candidates(state(rows, ["A"]))).toEqual([]);
});

test("a blocked item can only be used by its own holder", () => {
  const rows = [worn("A", 1, 8), worn("B", 1, 8), carried("A", 2, 1, 50, "Not in Inventory Search.")];
  const swaps = candidates(state(rows, ["A", "B"]));
  expect(ids(swaps)).toEqual(["A:8:2"]);
});

test("an applied swap keeps the displaced item with its member and the slot taken", () => {
  const rows = [worn("A", 1, 8), carried("A", 2)];
  const s = state(rows, ["A"]);
  applySwap(s, candidates(s)[0]);
  expect(s.worn.get("A")!.get(8)).toBe(2);
  expect(s.bags.get("A")).toEqual([1]);
  expect(candidates(s)).toEqual([]);
});

test("a stat-for-stat worse item is dropped, an item with an effect or a trade stays", () => {
  const rows = [worn("A", 2, 8), carried("A", 1), carried("A", 4), carried("A", 14)];
  const s = state(rows, ["A"]);
  const all = candidates(s);
  expect(ids(all)).toEqual(["A:8:1", "A:8:14", "A:8:4"]);
  // The Plain Cloak has less of every stat than the worn Fine Cloak. The Human Cloak has more armor class and less hit points, and the Proc Cloak has an effect.
  expect(ids(undominated(s, all))).toEqual(["A:8:14", "A:8:4"]);
  expect(dominates(items.get(2)!, items.get(1)!)).toBe(true);
  expect(dominates(items.get(1)!, items.get(2)!)).toBe(false);
});

test("of two candidates one beats in every stat, the worse one is dropped", () => {
  const rows = [worn("A", 1, 8), carried("A", 2), carried("A", 3), carried("A", 4)];
  const s = state(rows, ["A"]);
  const kept = undominated(s, candidates(s));
  // Warrior Cloak (12 AC) beats Human Cloak (11), which beats Fine Cloak only in armor class: Fine has hit points, so it stays.
  expect(ids(kept)).toEqual(["A:8:2", "A:8:3"]);
});

test("probe rounds hold one swap per member", () => {
  const swaps = [{ character: "A", slot: 1, itemId: 1 }, { character: "A", slot: 2, itemId: 2 }, { character: "B", slot: 1, itemId: 3 }];
  const rounds = probeRounds(swaps);
  expect(rounds.map((r) => r.map((s) => `${s.character}${s.itemId}`))).toEqual([["A1", "B3"], ["A2"]]);
});

test("a batch takes one swap per member and never a slot the kit holds", () => {
  const rows = [worn("A", 1, 8), worn("A", 7, 1), carried("A", 2), carried("A", 7), worn("B", 1, 8), carried("B", 2)];
  const s = state(rows, ["A", "B"]);
  const ranked = candidates(s);
  const batch = buildBatch(s, [], ranked);
  expect(batch.map((b) => b.character).sort()).toEqual(["A", "B"]);
  const kit = [{ character: "A", slot: 8, itemId: 2 }];
  expect(buildBatch(s, kit, ranked).every((b) => !(b.character === "A" && b.slot === 8))).toBe(true);
});

test("a batch rejects stale hand swaps after the kit changes the other hand", () => {
  const s = state([worn("A", 12, 13), carried("A", 9), carried("A", 10)], ["A"]);
  const ranked = candidates(s);
  const axe = ranked.find((c) => c.itemId === 9)!;
  const shield = ranked.find((c) => c.itemId === 10)!;
  const withAxe = state([worn("A", 12, 13), carried("A", 9), carried("A", 10)], ["A"]);
  applySwap(withAxe, axe);
  expect(buildBatch(withAxe, [axe], [shield])).toEqual([]);
  const withShield = state([worn("A", 12, 13), carried("A", 9), carried("A", 10)], ["A"]);
  applySwap(withShield, shield);
  expect(buildBatch(withShield, [shield], [axe])).toEqual([]);
});

test("swaps change only their members' entries", () => {
  const entries = [{ name: "A", items: { 8: 1, 1: 7 } }, { name: "B", items: { 8: 1 } }];
  const next = withSwaps(entries, [{ character: "A", slot: 8, itemId: 2 }]);
  expect(next[0].items).toEqual({ 8: 2, 1: 7 });
  expect(next[1]).toBe(entries[1]);
  expect(entries[0].items[8]).toBe(1);
});

// Summaries as `summarize` makes them.
const summary = (kills: number, killMean: number | null, hpLeft: number, fights = 6) => ({ fights, kills, killSec: { mean: killMean }, bossHpLeftMean: hpLeft });

test("outcomes order by kill chance, then kill time, then boss hit points left", () => {
  expect(compareOutcomes(summary(3, 90, 0), summary(2, 60, 0))).toBeLessThan(0);
  expect(compareOutcomes(summary(2, 60, 0), summary(2, 70, 0))).toBeLessThan(0);
  expect(compareOutcomes(summary(0, null, 100), summary(0, null, 200))).toBeLessThan(0);
  expect(compareOutcomes(summary(1, 800, 5000), summary(0, null, 0))).toBeLessThan(0);
  expect(compareOutcomes(summary(0, null, 100), summary(0, null, 100))).toBe(0);
  expect(outcomeOf(summary(3, 90, 10)).killChance).toBe(0.5);
});

test("an improvement needs a margin where time or hit points decide it", () => {
  const before = summary(0, null, 300_000);
  expect(improves(before, summary(0, null, 299_000))).toBe(true);
  expect(improves(before, summary(0, null, 299_000), { hpLeft: 4_000 })).toBe(false);
  expect(improves(before, summary(0, null, 290_000), { hpLeft: 4_000 })).toBe(true);
  // A kill where there was none is an improvement whatever the margin.
  expect(improves(before, summary(1, 880, 250_000), { hpLeft: 1e9, killSec: 1e9 })).toBe(true);
  expect(improves(summary(2, 100, 0), summary(2, 99, 0), { killSec: 2 })).toBe(false);
});

test("rank correlation", () => {
  expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
  expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
  expect(spearman([1, 2], [1, 2])).toBeNull();
});

test("the goal boss closest to a kill is the one with the best outcome, by share of hit points left", () => {
  const row = (boss: string, kills: number, killMean: number | null, hpLeft: number, max: number) => ({ boss, summary: { ...summary(kills, killMean, hpLeft), bossMaxHp: max } });
  // A kill beats any miss, a faster kill beats a slower one, and among misses the smaller share left wins whatever the boss's size.
  expect(closestToKill([row("big", 0, null, 700_000, 900_000), row("small", 0, null, 190_000, 200_000), row("mid", 0, null, 300_000, 500_000)]).boss).toBe("mid");
  expect(closestToKill([row("miss", 0, null, 10, 200_000), row("slow", 2, 300, 0, 200_000), row("fast", 2, 80, 0, 200_000)]).boss).toBe("fast");
});
