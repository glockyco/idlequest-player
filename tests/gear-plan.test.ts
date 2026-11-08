// Checks the roster gear plan (tools/lib/gear-plan.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { planGear } from "../tools/lib/gear-plan.mjs";

// Content rows: slots and classes are bit masks (back = 1 << 8, primary = 1 << 13, secondary = 1 << 14).
const ALL = 65535;
const item = (id: number, name: string, over: Record<string, unknown>) => [id, { id, Name: name, classes: ALL, races: ALL, reqlevel: 0, ...over }] as const;
const items = new Map([
  item(1, "Fine Cloak", { slots: 1 << 8, ac: 10, asta: 5 }),
  item(2, "Plain Cloak", { slots: 1 << 8, ac: 2 }),
  item(3, "Long Sword", { slots: 1 << 13, damage: 9, delay: 25, itemtype: 0 }),
  item(4, "Rusty Sword", { slots: 1 << 13, damage: 4, delay: 30, itemtype: 0 }),
  item(5, "Great Axe", { slots: 1 << 13, damage: 20, delay: 40, itemtype: 1 }),
  item(6, "Buckler", { slots: 1 << 14, ac: 3, itemtype: 8 }),
]);
const row = (who: string, itemId: number, location: string, slot: number, inst: number) => ({ characterName: who, characterId: who.length, itemId, itemName: items.get(itemId)!.Name, itemInstanceId: inst, location, slot, blockReason: "" });

test("each carried item goes to the character it adds most to, once", () => {
  const people = [
    { name: "Tank", cls: "warrior", level: 20, race: "" },
    { name: "Pal", cls: "paladin", level: 20, race: "" },
  ];
  const survey = [row("Tank", 2, "Equipped", 8, 1), row("Holder", 1, "Carried", 25, 2)];
  const { moves, wanted } = planGear({ survey, items, people });
  // The Paladin wears no cloak, so the fine cloak adds more there than over the Tank's plain one.
  expect(moves.map((m) => [m.item, m.to, m.slot])).toEqual([["Fine Cloak", "Pal", "back"]]);
  expect(wanted).toEqual([1]);
});

test("a main hand moves by damage over delay, never to a Monk, and a two-hander only beside an empty off hand", () => {
  const people = [
    { name: "War", cls: "warrior", level: 30, race: "" },
    { name: "Mnk", cls: "monk", level: 30, race: "" },
  ];
  const survey = [row("War", 4, "Equipped", 13, 1), row("War", 6, "Equipped", 14, 2), row("Holder", 3, "Carried", 25, 3), row("Holder", 5, "Carried", 26, 4)];
  expect(planGear({ survey, items, people }).moves.map((m) => [m.item, m.to])).toEqual([["Long Sword", "War"]]);
  // Without the shield the two-hander swings hardest.
  const bare = survey.filter((r) => r.itemId !== 6);
  expect(planGear({ survey: bare, items, people }).moves.map((m) => [m.item, m.to])).toEqual([["Great Axe", "War"]]);
});
