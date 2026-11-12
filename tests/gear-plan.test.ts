// Checks the roster gear plan (tools/lib/gear-plan.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { elasticity } from "../tools/lib/acquire.mjs";
import { dualWieldSkill, offhandChance } from "../tools/lib/gear-data.mjs";
import { damageShares, fists, itemCard, mergeSurvey, planGear, setValue, walkValue, withoutUnread } from "../tools/lib/gear-plan.mjs";

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

test("a move of a lore item names the other characters that carry one, which a gear task's leader must not be", () => {
  const lore = new Map([...items, item(8, "Lore Cloak", { slots: 1 << 8, ac: 10, asta: 5, attack: 12, loregroup: -1 })]);
  const people = [
    { name: "Pal", cls: "paladin", level: 20, race: "" },
    { name: "Lead", cls: "warrior", level: 20, race: "" },
  ];
  const survey = [{ ...row("Lead", 2, "Equipped", 8, 1), itemId: 8, itemName: "Lore Cloak" }, { ...row("Holder", 2, "Carried", 25, 2), itemId: 8, itemName: "Lore Cloak" }];
  expect(planGear({ survey, items: lore, people }).moves).toMatchObject([{ item: "Lore Cloak", from: "Holder", to: "Pal", loreHolders: ["Lead"] }]);
});

test("a main hand moves by damage over delay, to a Monk too, and a two-hander only beside an empty off hand", () => {
  const people = [
    { name: "War", cls: "warrior", level: 30, race: "" },
    { name: "Mnk", cls: "monk", level: 30, race: "" },
  ];
  const survey = [row("War", 4, "Equipped", 13, 1), row("War", 6, "Equipped", 14, 2), row("Holder", 3, "Carried", 25, 3), row("Holder", 5, "Carried", 26, 4)];
  // A weapon replaces the Monk's fists (10 at 34 delay at level 30) whatever its type, and a
  // two-hander pays for the off-hand fist it ends, which swings 0.61 of the time at the server's
  // Dual Wield cap of 215. The Long Sword's melee is 143% over the Rusty Sword, the Great Axe's 13% over the Monk's two fists, and an
  // unmeasured member's melee counts for one sixth of the party's damage at the XP elasticity.
  const weight = elasticity(30) / 6;
  const plan = planGear({ survey, items, people }).moves;
  expect(plan.map((m) => [m.item, m.to])).toEqual([["Long Sword", "War"], ["Great Axe", "Mnk"]]);
  expect(plan.map((m) => m.gain / weight)).toEqual([expect.closeTo(1427, 0), expect.closeTo(132.5, 0)]);
  // Without the shield the two-hander swings hardest for the Warrior, and the Monk takes the sword.
  const bare = survey.filter((r) => r.itemId !== 6);
  expect(planGear({ survey: bare, items, people }).moves.map((m) => [m.item, m.to])).toEqual([["Great Axe", "War"], ["Long Sword", "Mnk"]]);
});

test("a weapon for either hand that replaces a worn one is marked to be placed, and no other move is", () => {
  // The server puts a given weapon for either hand into the empty hand, else over the weapon it
  // ranks lower, so only these moves depend on a slot the give cannot name.
  const both = new Map([...items, item(9, "Fast Whip", { slots: (1 << 13) | (1 << 14), damage: 9, delay: 14, itemtype: 0 })]);
  const people = [{ name: "War", cls: "warrior", level: 30, race: "" }];
  const whip = { ...row("Holder", 3, "Carried", 25, 3), itemId: 9, itemName: "Fast Whip" };
  // Over the Rusty Sword in the main hand, beside a dagger: the give could land in either hand.
  const full = planGear({ survey: [row("War", 4, "Equipped", 13, 1), row("War", 7, "Equipped", 14, 2), whip], items: both, people }).moves;
  expect(full).toMatchObject([{ item: "Fast Whip", to: "War", slot: "primary", exact: true }]);
  // Into an empty main hand the server puts it by itself, and a main-hand-only sword has one slot.
  const empty = planGear({ survey: [row("War", 7, "Equipped", 14, 2), whip], items: both, people }).moves;
  expect(empty.find((m) => m.item === "Fast Whip")).not.toHaveProperty("exact");
  const sword = planGear({ survey: [row("War", 4, "Equipped", 13, 1), row("Holder", 3, "Carried", 25, 3)], items: both, people }).moves;
  expect(sword).toMatchObject([{ item: "Long Sword", slot: "primary" }]);
  expect(sword[0]).not.toHaveProperty("exact");
});

test("a weapon goes to the member whose melee is the larger share of the party's damage", () => {
  const people = [
    { name: "War", cls: "warrior", level: 30, race: "", shares: { melee: 0.05, spell: 0 } },
    { name: "Mnk", cls: "monk", level: 30, race: "", shares: { melee: 0.4, spell: 0 } },
  ];
  const survey = [row("War", 4, "Equipped", 13, 1), row("Mnk", 4, "Equipped", 13, 2), row("Holder", 3, "Carried", 26, 3)];
  // The Long Sword adds about as much melee to either, so it goes to the Monk, whose melee deals 40%.
  expect(planGear({ survey, items, people }).moves.map((m) => [m.item, m.to])).toEqual([["Long Sword", "Mnk"]]);
});

test("damage shares count once a group's tagged lines span an hour, and a silent member's share is 0", () => {
  const members = new Map([["G1", ["War", "Mag", "Clr"]]]);
  const row = (minutes: number) => ({ group: "G1", damage: { total: 1000, minutes, melee: { War: 300, Mag: 50 }, spell: { Mag: 150 }, pet: { Mag: 500 }, shield: {} } });
  expect(damageShares([row(59)], members).size).toBe(0);
  const shares = damageShares([row(60)], members);
  // The Magician's pet counts in the total but not in its own share, which its gear does not raise.
  expect(Object.fromEntries(shares)).toEqual({ War: { melee: 0.3, spell: 0 }, Mag: { melee: 0.05, spell: 0.15 }, Clr: { melee: 0, spell: 0 } });
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
  // A Hand Drum (18) raises the walk from 190% to 226% of base speed, which saves the group 12% x
  // (1 - 190/226) of its time. The off-hand dagger stays.
  expect(walkValue(18, walk)).toBeCloseTo(10 * 100 * 0.12 * (1 - 190 / 226));
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

test("a target counts each item once at its best taker and each character slot once", () => {
  const people = [{ name: "B1", cls: "bard", level: 30, race: "", walk }, { name: "B2", cls: "bard", level: 30, race: "", walk }];
  const survey = [bRow("B1", 22, "Equipped", 14, 1), bRow("B2", 22, "Equipped", 14, 2)];
  const items2 = new Map([...bardItems, item(25, "Big Drum", { slots: 1 << 14, bardtype: 26, bardvalue: 20, itemtype: 26 })]);
  const drops = [
    { itemId: 20, zone: "kurn", npc: "a drummer", hours: 2 },
    { itemId: 25, zone: "kurn", npc: "a drummer", hours: 4 },
    { itemId: 20, zone: "befallen", npc: "a skeleton", hours: 1 },
  ];
  const { targets } = planGear({ survey, items: items2, people, drops });
  // One Hand Drum serves one Bard, so the drummer's second Bard counts with the Big Drum, at its
  // own hours per copy: the Hand Drum's gain over 2 h plus the Big Drum's over 4 h.
  const drummer = targets.find((t) => t.npc === "a drummer")!;
  expect(drummer.items.map((w) => [w.to, w.item, w.takers])).toEqual([["B1", "Hand Drum", 2], ["B2", "Big Drum", 2]]);
  expect(drummer.rate).toBeCloseTo(walkValue(18, walk) / 2 + walkValue(20, walk) / 4, 1);
  expect(drummer.firstHours).toBeCloseTo(1 / (1 / 2 + 1 / 4), 2);
  // The skeleton drops the Hand Drum twice as often, which is worth more than both drops of the drummer.
  expect(targets[0].npc).toBe("a skeleton");
  expect(targets[0].rate).toBeCloseTo(walkValue(18, walk), 1);
});

test("an epic piece is worth the reward's gain to its character, shared by the pieces it lacks, and its target names the chain's enemies", () => {
  const people = [{ name: "B1", cls: "bard", level: 30, race: "", walk }];
  const survey = [bRow("B1", 22, "Equipped", 14, 1)];
  const items2 = new Map([...bardItems, item(25, "Big Drum", { slots: 1 << 14, bardtype: 26, bardvalue: 20, itemtype: 26 })]);
  const source = (also: string[]) => ({ zone: "kurn", npc: "a keeper", npcLevel: 30, hours: 2, drop: 1, spawn: 1, also });
  const epics = [{ rewardId: 25, to: "B1", pieces: [{ itemId: 900, name: "Piece A", sources: [source(["a guardian"])] }, { itemId: 901, name: "Piece B", sources: [source([])] }] }];
  const { targets, drops } = planGear({ survey, items: items2, people, epics });
  const share = Math.round((walkValue(20, walk) / 2) * 100) / 100;
  const keeper = targets.find((t) => t.npc === "a keeper")!;
  expect(keeper.items.map((w) => [w.item, w.slot, w.gain]).sort()).toEqual([["Piece A", "epic", share], ["Piece B", "epic", share]]);
  expect(keeper.also).toEqual(["a guardian"]);
  // Pieces are hunted for their epic, not worn, so they stay out of the per-slot drops.
  expect(drops).toEqual([]);
});

test("a leader's carried item that Inventory Search does not list stays out of the moves", () => {
  const people = [{ name: "War", cls: "warrior", level: 30, race: "" }];
  const loose = { ...row("Lead", 6, "Carried", 0, 9), characterName: "Lead", characterId: 9, bag: 22 };
  const worn = { ...row("War", 1, "Equipped", 14, 1), characterName: "War", characterId: 1, itemId: 21, itemName: "Torch" };
  // Not found by the search: blocked, so no move pulls it.
  const survey = mergeSurvey([loose, worn], []);
  expect(survey.find((r) => r.itemInstanceId === 9)?.blockReason).toBe("Not in Inventory Search.");
  expect(planGear({ survey, items: bardItems, people }).moves).toEqual([]);
  // Found by the search: free to move, and the Warrior takes the shield.
  const reached = mergeSurvey([loose, worn], [{ ...loose }]);
  expect(reached.find((r) => r.itemInstanceId === 9)?.blockReason).toBe("");
  expect(planGear({ survey: reached, items: bardItems, people }).moves).toMatchObject([{ item: "Buckler", to: "War" }]);
});

test("a character whose party the pass could not read gets no move and keeps its last sheet", () => {
  // Embrogg on 2026-11-12: his worn rows were an hour old, so his chest read as empty and the
  // breastplate he had taken off an hour before as the best he could wear.
  const moves = [
    { item: "Charred Guardian Breastplate", from: "Embrogg", to: "Embrogg", slot: "chest" },
    { item: "Spider Fur Collar", from: "Embrogg", to: "Eskarn", slot: "neck" },
    { item: "Hierophant's Cloak", from: "Kimorili", to: "Ivelugias", slot: "back" },
  ];
  const characters = [
    { name: "Embrogg", score: { now: 127.7, target: 265.6 }, slots: [{ slot: "wrist", slotNum: 10, worn: { itemId: 3133, name: "Large Ringmail Bracelet" } }] },
    { name: "Ivelugias", score: { now: 90, target: 200 }, slots: [] },
  ];
  const last = { sheets: { Embrogg: [{ slot: "wrist", slotNum: 10, worn: { itemId: 4780, name: "Golden Bracer" } }] }, characters: [{ name: "Embrogg", score: { now: 119.1, target: 262 } }] };
  const r = withoutUnread({ moves, characters }, new Set(["Embrogg"]), last);
  expect(r.moves.map((m) => m.item)).toEqual(["Hierophant's Cloak"]);
  expect(r.characters[0]).toEqual({ name: "Embrogg", score: { now: 119.1, target: 262 }, slots: last.sheets.Embrogg });
  expect(r.characters[1]).toBe(characters[1]);
  // A character the stored plan does not know yet keeps what the pass made of it.
  expect(withoutUnread({ moves: [], characters }, new Set(["Embrogg"]), {}).characters[0]).toBe(characters[0]);
  expect(withoutUnread({ moves, characters }, new Set(), last)).toEqual({ moves, characters });
});

test("drops become wants for every character that gains enough after the moves, and are kept once looted", () => {
  const people = [
    { name: "Tank", cls: "warrior", level: 20, race: "" },
    { name: "Old", cls: "warrior", level: 40, race: "" },
  ];
  const survey = [row("Tank", 2, "Equipped", 8, 1), row("Old", 2, "Equipped", 8, 2)];
  const drops = [{ itemId: 1, zone: "kurn", npc: "a skeleton", hours: 2 }];
  // The Fine Cloak beats the Plain Cloak by far more than twice the armor threshold, for both, since
  // any group may hunt it and a gear task moves the copy.
  const plan = planGear({ survey, items, people, drops });
  expect(plan.drops).toMatchObject([{ item: "Fine Cloak", to: "Tank", slot: "back", zone: "kurn", npc: "a skeleton" }, { to: "Old" }]);
  expect(plan.keep.counts[1]).toBe(2);
  // A copy the account holds is moved this pass, so the drop is no longer wanted.
  expect(planGear({ survey: [...survey, row("Holder", 1, "Carried", 25, 3)], items, people: people.slice(0, 1), drops }).drops).toEqual([]);
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
  // The Warrior at 13 swings the off hand 83/400 of the time: 0.2075 x 6/20 over a 9/25 sword, 17%
  // of its melee, weighed as an unmeasured member's at the XP elasticity of level 13.
  expect(moves("warrior", 13, [main("Me"), carried[0]])).toEqual([["Twin Dagger", "secondary", expect.closeTo((172.92 * elasticity(13)) / 6, 1)]]);
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

test("a main hand counts for its stats as well as its swings, so a caster takes a stat staff, and a quest piece kept unworn moves nowhere", () => {
  const caster = new Map([
    ...items,
    item(8, "Mana Staff", { slots: 1 << 13, damage: 5, delay: 40, itemtype: 4, mana: 60, aint: 10 }),
    item(9, "Iron Mace", { slots: 1 << 13, damage: 9, delay: 30, itemtype: 3 }),
  ]);
  const crow = (who: string, id: number, location: string, slot: number, inst: number) => ({ ...row(who, 1, location, slot, inst), itemId: id, itemName: caster.get(id)!.Name });
  const wiz = { name: "Wiz", cls: "wizard", level: 30, race: "" };
  const survey = [crow("Wiz", 9, "Equipped", 13, 1), crow("Holder", 8, "Carried", 25, 2)];
  // A Wizard's output has no melee share, so the staff's mana and INT are its whole gain over the
  // mace, which carries no stats.
  const moves = planGear({ survey, items: caster, people: [wiz] }).moves;
  expect(moves.map((m) => [m.item, m.slot, m.gain])).toEqual([["Mana Staff", "primary", expect.closeTo(setValue([caster.get(8)], wiz), 1)]]);
  expect(planGear({ survey, items: caster, people: [wiz], unworn: new Set([8]) }).moves).toEqual([]);
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
