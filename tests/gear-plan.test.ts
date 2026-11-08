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

test("a main hand moves by damage over delay, to a Monk too, and a two-hander only beside an empty off hand", () => {
  const people = [
    { name: "War", cls: "warrior", level: 30, race: "" },
    { name: "Mnk", cls: "monk", level: 30, race: "" },
  ];
  const survey = [row("War", 4, "Equipped", 13, 1), row("War", 6, "Equipped", 14, 2), row("Holder", 3, "Carried", 25, 3), row("Holder", 5, "Carried", 26, 4)];
  // A weapon replaces the Monk's fists (10 at 35 delay at level 30) whatever its type, and a
  // two-hander pays for the off-hand fist it ends.
  expect(planGear({ survey, items, people }).moves.map((m) => [m.item, m.to, m.gain])).toEqual([["Long Sword", "War", 0.23], ["Great Axe", "Mnk", 0.1]]);
  // Without the shield the two-hander swings hardest for the Warrior, and the Monk takes the sword.
  const bare = survey.filter((r) => r.itemId !== 6);
  expect(planGear({ survey: bare, items, people }).moves.map((m) => [m.item, m.to])).toEqual([["Great Axe", "War"], ["Long Sword", "Mnk"]]);
});

const BARD_SONGS = [
  { minLevel: 1, skill: 70 }, // percussion
  { minLevel: 6, skill: 49 }, // strings
];
const bardItems = new Map([
  ...items,
  item(20, "Hand Drum", { slots: 1 << 14, bardtype: 26, bardvalue: 18, itemtype: 26 }),
  item(21, "Torch", { slots: 1 << 14, itemtype: 16 }),
  item(22, "Dagger", { slots: (1 << 13) | (1 << 14), damage: 4, delay: 20, itemtype: 2 }),
  item(23, "Fine Robe", { slots: 1 << 17, ac: 4 }),
]);
const bRow = (who: string, itemId: number, location: string, slot: number, inst: number) => ({ ...row("Me", 1, location, slot, inst), characterName: who, characterId: who.length, itemId, itemName: bardItems.get(itemId)!.Name });

test("a Bard takes an instrument into its off hand, also from a weapon, by the share of its songs it modifies", () => {
  const people = [{ name: "Brd", cls: "bard", level: 10, race: "" }];
  // Percussion is half of the two songs: 40 x 0.8 x 1/2 = 16 points.
  const torch = [bRow("Brd", 21, "Equipped", 14, 1), bRow("Holder", 20, "Carried", 25, 2)];
  expect(planGear({ survey: torch, items: bardItems, people, songs: BARD_SONGS }).moves).toMatchObject([{ item: "Hand Drum", to: "Brd", slot: "secondary", gain: 16, replaces: "Torch" }]);
  // An off-hand weapon gives way, and a main-hand weapon stays.
  const dagger = [bRow("Brd", 22, "Equipped", 14, 1), bRow("Holder", 20, "Carried", 25, 2)];
  expect(planGear({ survey: dagger, items: bardItems, people, songs: BARD_SONGS }).moves).toMatchObject([{ item: "Hand Drum", slot: "secondary", replaces: "Dagger" }]);
  const mainOnly = new Map([...bardItems, item(24, "Big Drum", { slots: 1 << 13, bardtype: 26, bardvalue: 18 })]);
  const armed = [bRow("Brd", 22, "Equipped", 13, 1), { ...bRow("Holder", 22, "Carried", 25, 2), itemId: 24, itemName: "Big Drum" }];
  expect(planGear({ survey: armed, items: mainOnly, people, songs: BARD_SONGS }).moves).toEqual([]);
  // A class without songs gets nothing from it.
  expect(planGear({ survey: torch.map((r) => ({ ...r, characterName: r.characterName === "Brd" ? "War" : r.characterName })), items: bardItems, people: [{ name: "War", cls: "warrior", level: 10, race: "" }], songs: BARD_SONGS }).moves).toEqual([]);
});

test("merchant goods are bought within the budget, in one zone, and lose a tie to a copy the account holds", () => {
  const people = [
    { name: "B1", cls: "bard", level: 10, race: "" },
    { name: "B2", cls: "bard", level: 10, race: "" },
    { name: "B3", cls: "bard", level: 10, race: "" },
  ];
  const survey = [bRow("B1", 21, "Equipped", 14, 1), bRow("B2", 21, "Equipped", 14, 2), bRow("B3", 21, "Equipped", 14, 3), bRow("Holder", 20, "Carried", 25, 4)];
  const shop = [
    { itemId: 20, merchant: "Fania Esruc", zone: "freportw", price: 0.1 },
    { itemId: 20, merchant: "Lianna Ferasa", zone: "rathemtn", price: 0.1 },
    { itemId: 23, merchant: "A Tailor", zone: "rathemtn", price: 5 },
  ];
  const { moves, wanted } = planGear({ survey, items: bardItems, people, songs: BARD_SONGS, shop, buyPp: 1 });
  // The held drum goes first, then two bought in the first merchant's zone. The robe costs more
  // than the platinum left.
  expect(moves.map((m) => [m.to, m.from, m.buy?.zone ?? null])).toEqual([
    ["B1", "Holder", null],
    ["B2", null, "freportw"],
    ["B3", null, "freportw"],
  ]);
  expect(wanted).toEqual([20]);
  expect(planGear({ survey, items: bardItems, people, songs: BARD_SONGS, shop }).moves).toHaveLength(1);
});

test("drops become wants for characters in their levels that gain enough after the moves", () => {
  const people = [
    { name: "Tank", cls: "warrior", level: 20, race: "" },
    { name: "Old", cls: "warrior", level: 40, race: "" },
  ];
  const survey = [row("Tank", 2, "Equipped", 8, 1), row("Old", 2, "Equipped", 8, 2)];
  const drops = [{ itemId: 1, zone: "kurn", npc: "a skeleton", hours: 2, levels: [15, 25] }];
  // The Fine Cloak beats the Plain Cloak by far more than twice the armor threshold.
  expect(planGear({ survey, items, people, drops }).drops).toMatchObject([{ item: "Fine Cloak", to: "Tank", slot: "back", zone: "kurn", npc: "a skeleton" }]);
  // A copy the account holds is moved this pass, so the drop is no longer wanted.
  expect(planGear({ survey: [...survey, row("Holder", 1, "Carried", 25, 3)], items, people: people.slice(0, 1), drops }).drops).toEqual([]);
});
