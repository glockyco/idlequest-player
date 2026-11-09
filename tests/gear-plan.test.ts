// Checks the roster gear plan (tools/lib/gear-plan.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { dualWieldSkill, offhandChance } from "../tools/lib/gear-data.mjs";
import { fists, itemCard, planGear, walkValue } from "../tools/lib/gear-plan.mjs";

// Content rows: slots and classes are bit masks (back = 1 << 8, primary = 1 << 13, secondary = 1 << 14).
const ALL = 65535;
const item = (id: number, name: string, over: Record<string, unknown>) => [id, { id, Name: name, classes: ALL, races: ALL, reqlevel: 0, ...over }] as const;
// Armor counts by what its stats add to output (`outputValue`): attack for melee, mana for spell casters.
const items = new Map([
  item(1, "Fine Cloak", { slots: 1 << 8, ac: 10, asta: 5, attack: 12 }),
  item(2, "Plain Cloak", { slots: 1 << 8, ac: 2, attack: 8 }),
  item(3, "Long Sword", { slots: 1 << 13, damage: 9, delay: 25, itemtype: 0 }),
  item(4, "Rusty Sword", { slots: 1 << 13, damage: 4, delay: 30, itemtype: 0 }),
  item(5, "Great Axe", { slots: 1 << 13, damage: 20, delay: 40, itemtype: 1 }),
  item(6, "Buckler", { slots: 1 << 14, ac: 6, mana: 30, attack: 4, itemtype: 8 }),
  item(7, "Twin Dagger", { slots: (1 << 13) | (1 << 14), damage: 6, delay: 20, itemtype: 2 }),
]);
const row = (who: string, itemId: number, location: string, slot: number, inst: number) => ({ characterName: who, characterId: who.length, itemId, itemName: items.get(itemId)!.Name, itemInstanceId: inst, location, slot, blockReason: "" });

test("each carried item goes to the character it adds most to, once", () => {
  const people = [
    { name: "Tank", cls: "warrior", level: 20, race: "" },
    { name: "Pal", cls: "paladin", level: 20, race: "" },
  ];
  const survey = [row("Tank", 2, "Equipped", 8, 1), row("Holder", 1, "Carried", 25, 2)];
  const { moves, keep } = planGear({ survey, items, people });
  // The Paladin wears no cloak, so the fine cloak adds more there than over the Tank's plain one.
  expect(moves.map((m) => [m.item, m.to, m.slot])).toEqual([["Fine Cloak", "Pal", "back"]]);
  // The moved copy is kept, and the Tank would still gain from a second one.
  expect(keep).toEqual({ counts: { 1: 1 }, instances: [2] });
  // A second copy nobody needs is not kept once the Tank wears one.
  const both = planGear({ survey: [...survey, row("Holder", 1, "Carried", 26, 3), row("Holder", 1, "Carried", 27, 4)], items, people });
  expect(both.keep).toEqual({ counts: {}, instances: [2, 3] });
});

test("a main hand moves by damage over delay, to a Monk too, and a two-hander only beside an empty off hand", () => {
  const people = [
    { name: "War", cls: "warrior", level: 30, race: "" },
    { name: "Mnk", cls: "monk", level: 30, race: "" },
  ];
  const survey = [row("War", 4, "Equipped", 13, 1), row("War", 6, "Equipped", 14, 2), row("Holder", 3, "Carried", 25, 3), row("Holder", 5, "Carried", 26, 4)];
  // A weapon replaces the Monk's fists (10 at 34 delay at level 30) whatever its type, and a
  // two-hander pays for the off-hand fist it ends, which swings 0.49 of the time. Gains are the
  // change of the melee value in tenths of a percent: the Long Sword is 143% over the Rusty Sword,
  // the Great Axe 22% over the Monk's two fists.
  expect(planGear({ survey, items, people }).moves.map((m) => [m.item, m.to, m.gain])).toEqual([["Long Sword", "War", 1426.99], ["Great Axe", "Mnk", 218.43]]);
  // Without the shield the two-hander swings hardest for the Warrior, and the Monk takes the sword.
  const bare = survey.filter((r) => r.itemId !== 6);
  expect(planGear({ survey: bare, items, people }).moves.map((m) => [m.item, m.to])).toEqual([["Great Axe", "War"], ["Long Sword", "Mnk"]]);
});

const bardItems = new Map([
  ...items,
  item(20, "Hand Drum", { slots: 1 << 14, bardtype: 26, bardvalue: 18, itemtype: 26 }),
  item(21, "Torch", { slots: 1 << 14, itemtype: 16 }),
  item(22, "Dagger", { slots: (1 << 13) | (1 << 14), damage: 4, delay: 20, itemtype: 2 }),
  item(23, "Fine Robe", { slots: 1 << 17, ac: 4 }),
]);
const bRow = (who: string, itemId: number, location: string, slot: number, inst: number) => ({ ...row("Me", 1, location, slot, inst), characterName: who, characterId: who.length, itemId, itemName: bardItems.get(itemId)!.Name });

// A group that moves 12% of its time, with Spirit of Wolf at 45 and Selo's at 45 for modifier 10.
const walk = { share: 0.12, other: 45, selo: 45 };
test("a Bard carries a percussion instrument in its bags by the walk it speeds up, and keeps its own", () => {
  const people = [{ name: "Brd", cls: "bard", level: 30, race: "", walk }];
  // A Hand Drum (18) raises the walk from 190% to 226% of base speed: 12% x (1 - 190/226) of the
  // group's time, counted for six members. The off-hand dagger stays.
  expect(walkValue(18, walk)).toBeCloseTo(10 * 6 * 100 * 0.12 * (1 - 190 / 226));
  const survey = [bRow("Brd", 22, "Equipped", 14, 1), bRow("Holder", 20, "Carried", 25, 2)];
  expect(planGear({ survey, items: bardItems, people }).moves).toMatchObject([{ item: "Hand Drum", to: "Brd", slot: "bags", slotNum: null, gain: Math.round(walkValue(18, walk) * 100) / 100, replaces: null }]);
  // Without a run song to speed up, an instrument is worth nothing.
  expect(planGear({ survey, items: bardItems, people: [{ ...people[0], walk: undefined }] }).moves).toEqual([]);
  // A drum in a Bard's bags already serves it, and no other Bard takes it from there.
  const kept = [bRow("Brd", 20, "Carried", 25, 1), bRow("Brd2", 22, "Equipped", 14, 2)];
  expect(planGear({ survey: kept, items: bardItems, people: [...people, { name: "Brd2", cls: "bard", level: 30, race: "", walk }] }).moves).toEqual([]);
  // An instrument whose itemtype is not its bardtype does not count from the bags.
  const odd = new Map([...bardItems, item(24, "Drum Skin", { slots: 1 << 14, bardtype: 26, bardvalue: 18, itemtype: 16 })]);
  expect(planGear({ survey: [bRow("Brd", 22, "Equipped", 14, 1), { ...bRow("Holder", 22, "Carried", 25, 2), itemId: 24, itemName: "Drum Skin" }], items: odd, people }).moves).toEqual([]);
});

test("merchant goods are bought within the budget, in one zone, and lose a tie to a copy the account holds", () => {
  const people = [
    { name: "B1", cls: "bard", level: 30, race: "", walk },
    { name: "B2", cls: "bard", level: 30, race: "", walk },
    { name: "B3", cls: "bard", level: 30, race: "", walk },
  ];
  const survey = [bRow("B1", 21, "Equipped", 14, 1), bRow("B2", 21, "Equipped", 14, 2), bRow("B3", 21, "Equipped", 14, 3), bRow("Holder", 20, "Carried", 25, 4)];
  const shop = [
    { itemId: 20, merchant: "Fania Esruc", zone: "freportw", price: 0.1 },
    { itemId: 20, merchant: "Lianna Ferasa", zone: "rathemtn", price: 0.1 },
    { itemId: 23, merchant: "A Tailor", zone: "rathemtn", price: 5 },
  ];
  const { moves, keep } = planGear({ survey, items: bardItems, people, shop, buyPp: 1 });
  // The held drum goes first, then two bought in the first merchant's zone. The robe costs more
  // than the platinum left.
  expect(moves.map((m) => [m.to, m.from, m.buy?.zone ?? null])).toEqual([
    ["B1", "Holder", null],
    ["B2", null, "freportw"],
    ["B3", null, "freportw"],
  ]);
  expect(keep).toEqual({ counts: { 20: 2 }, instances: [4] });
  expect(planGear({ survey, items: bardItems, people, shop }).moves).toHaveLength(1);
});

test("drops become wants for characters in their levels that gain enough after the moves, and are kept once looted", () => {
  const people = [
    { name: "Tank", cls: "warrior", level: 20, race: "" },
    { name: "Old", cls: "warrior", level: 40, race: "" },
  ];
  const survey = [row("Tank", 2, "Equipped", 8, 1), row("Old", 2, "Equipped", 8, 2)];
  const drops = [{ itemId: 1, zone: "kurn", npc: "a skeleton", hours: 2, levels: [15, 25] }];
  // The Fine Cloak beats the Plain Cloak by far more than twice the armor threshold.
  const plan = planGear({ survey, items, people, drops });
  expect(plan.drops).toMatchObject([{ item: "Fine Cloak", to: "Tank", slot: "back", zone: "kurn", npc: "a skeleton" }]);
  expect(plan.keep.counts[1]).toBe(2);
  // A copy the account holds is moved this pass, so the drop is no longer wanted.
  expect(planGear({ survey: [...survey, row("Holder", 1, "Carried", 25, 3)], items, people: people.slice(0, 1), drops }).drops).toEqual([]);
  // A character outside the drop's levels gets no errand for it, but a looted copy is still kept for it.
  const old = planGear({ survey, items, people: people.slice(1), drops });
  expect([old.drops, old.keep.counts[1]]).toEqual([[], 1]);
});

test("the off-hand chance is (Dual Wield + level) / 400 for a class with the skill", () => {
  expect(dualWieldSkill("warrior", 12)).toBe(0);
  expect(offhandChance("warrior", 12)).toBe(0);
  // Warrior: cap 70 at 13 and 240 at 60, the figures of docs/client-internals.md.
  expect(offhandChance("warrior", 13)).toBeCloseTo(83 / 400);
  expect(offhandChance("warrior", 60)).toBeCloseTo(0.75);
  expect(offhandChance("monk", 60)).toBeCloseTo(0.78);
  expect(offhandChance("bard", 60)).toBeCloseTo(0.675);
  expect(offhandChance("rogue", 60)).toBeCloseTo(0.7625);
  for (const cls of ["paladin", "shadowknight", "cleric", "wizard"]) expect(offhandChance(cls, 60)).toBe(0);
});

test("the off hand takes a one-hander for a Warrior from level 13, a shield for a Paladin, and nothing beside a two-hander", () => {
  const carried = [row("Holder", 7, "Carried", 25, 3), row("Holder", 6, "Carried", 26, 4)];
  const main = (who: string) => row(who, 3, "Equipped", 13, 1);
  const person = (cls: string, level: number) => ({ name: "Me", cls, level, race: "" });
  const moves = (cls: string, level: number, survey: ReturnType<typeof row>[]) => planGear({ survey, items, people: [person(cls, level)] }).moves.map((m) => [m.item, m.slot, m.gain]);
  // The Warrior at 13 swings the off hand 83/400 of the time: 0.2075 x 6/20 over a 9/25 sword, 17%.
  expect(moves("warrior", 13, [main("Me"), carried[0]])).toEqual([["Twin Dagger", "secondary", 172.92]]);
  expect(moves("warrior", 12, [main("Me"), carried[0]])).toEqual([]);
  // A Paladin never has the skill, so only the shield is offered.
  expect(moves("paladin", 30, [main("Me"), ...carried])).toEqual([["Buckler", "secondary", expect.any(Number)]]);
  expect(moves("paladin", 30, [main("Me"), carried[0]])).toEqual([]);
  // A Warrior with both takes the dagger, whose off-hand swings add more output than the shield's
  // stats, and keeps it, because a shield replaces no weapon.
  expect(moves("warrior", 30, [main("Me"), ...carried]).map((m) => m[0])).toEqual(["Twin Dagger"]);
  // A two-hander in the main hand takes neither.
  const axe = row("Me", 5, "Equipped", 13, 1);
  expect(moves("warrior", 30, [axe, ...carried])).toEqual([]);
});

test("a Monk's fists follow the client's table by race", () => {
  expect(fists("monk", 1, "human")).toEqual({ damage: 4, delay: 36 });
  expect(fists("monk", 30, "human")).toEqual({ damage: 10, delay: 34 });
  expect(fists("monk", 30, "iksar")).toEqual({ damage: 10, delay: 35 });
  expect(fists("monk", 52, "human")).toEqual({ damage: 14, delay: 30 });
  expect(fists("monk", 60, "human")).toEqual({ damage: 14, delay: 26 });
  expect(fists("monk", 60, "iksar")).toEqual({ damage: 14, delay: 27 });
  expect(fists("warrior", 60, "human")).toEqual({ damage: 1, delay: 36 });
});

test("the character report gives each person's scores now, after the moves and with the wanted drops, and each slot's worn item, move and drop", () => {
  const people = [
    { name: "Tank", cls: "warrior", level: 20, race: "" },
    { name: "Pal", cls: "paladin", level: 20, race: "" },
  ];
  // Pal wears no cloak and takes the carried Fine Cloak. Tank keeps the Plain Cloak, and a dropped Fine Cloak would beat it.
  const survey = [row("Tank", 2, "Equipped", 8, 1), row("Holder", 1, "Carried", 25, 3)];
  const drops = [{ itemId: 1, zone: "kurn", npc: "a skeleton", hours: 2, levels: [15, 25] }];
  const { characters } = planGear({ survey, items, people, drops });
  const [tank, pal] = characters;
  const back = (c: { slots: { slot: string }[] }) => c.slots.find((s) => s.slot === "back");
  expect(tank.score.now).toBe(tank.score.moves); // Tank gets no move
  expect(tank.score.target).toBeGreaterThan(tank.score.now);
  expect(back(tank)).toMatchObject({ worn: { itemId: 2, name: "Plain Cloak" }, move: null, drop: { item: "Fine Cloak", zone: "kurn", npc: "a skeleton", hours: 2 } });
  expect(pal.score.now).toBe(0);
  expect(pal.score.moves).toBeGreaterThan(0);
  expect(pal.score.target).toBe(pal.score.moves); // nothing beats the Fine Cloak
  expect(back(pal)).toMatchObject({ worn: null, move: { item: "Fine Cloak", from: "Holder", replaces: null }, drop: null });
  // Every character lists the 22 slots of the paper doll in the inventory window's order, the ammo slot last but one.
  expect(pal.slots.map((s) => s.slot).slice(0, 4)).toEqual(["ear", "neck", "face", "head"]);
  expect(pal.slots.map((s) => s.slot).slice(-4)).toEqual(["primary", "secondary", "ammo", "charm"]);
  expect(pal.slots.length).toBe(22);
});

test("an item card keeps the facts a tooltip prints and leaves out the zeros", () => {
  const card = itemCard({ id: 3213, Name: "Kylong War Helm", icon: 625, slots: 4, classes: 33695, races: 65535, ac: 12, hp: 20, mana: 20, mr: 7, pr: 4, astr: 0, nodrop: 0, loregroup: -1, magic: 1, itemtype: 10 });
  expect(card).toEqual({ id: 3213, name: "Kylong War Helm", icon: 625, slots: ["head"], classes: 33695, races: 65535, reqlevel: 0, type: 10, ac: 12, hp: 20, mana: 20, mr: 7, pr: 4, flags: ["NO DROP", "LORE", "MAGIC"] });
});
