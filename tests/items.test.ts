// Checks the item demand model (docs/plans/items.md): the demand sources and the client table
// reader. Run with `bun test`.
import { expect, test } from "bun:test";
import { arrayLiteral } from "../tools/lib/client-tables.mjs";
import { ALL_COPIES, addDemand, chainDemand, handInDemand, potionDemand, stepDemand, tabShares } from "../tools/lib/item-demand.mjs";

test("chain demand counts each reward's step items once per member that still needs the epic, and one reward per member", () => {
  const epicNeeds = new Map([[10, { 20: 1, 21: 2 }]]);
  const epics = { Bard: [10], Wizard: [11] };
  const members = [{ name: "A", class: "Bard" }, { name: "B", class: "Bard" }, { name: "C", class: "Wizard" }];
  // B holds the epic, so only A needs its steps' items.
  expect(chainDemand({ epicNeeds, epics, members, epicHolders: new Set(["B"]) })).toEqual({ 10: 2, 11: 1, 20: 1, 21: 2 });
});

test("step demand keeps an open chain's items for its class and a done chain's proof for every member", () => {
  const quests = {
    note: { class: "Paladin", reward: "Sealed Note", needs: ["Fire Beetle Eye"], steps: [{ zone: "x", give: ["Fire Beetle Eye"], expect: "Sealed Note" }] },
  };
  const ids = new Map([["Fire Beetle Eye", [1]], ["Sealed Note", [2]]]);
  const members = [{ name: "P", class: "Paladin" }, { name: "Q", class: "Paladin" }, { name: "W", class: "Warrior" }];
  expect(stepDemand({ quests, members, ids })).toEqual({ 1: 2, 2: 4 });
  // Both Paladins done: the input goes, the note that proves it stays.
  expect(stepDemand({ quests, holders: { note: ["P", "Q"] }, members, ids })).toEqual({ 2: 2 });
});

test("boss potions are one copy each, and demand maps add up", () => {
  expect(addDemand(potionDemand([{ itemId: 990113 }, { itemId: 990124 }]), { 990113: 1, 5: 2 })).toEqual({ 990113: 2, 990124: 1, 5: 2 });
});

test("a client table is read only as a plain literal", () => {
  const text = 'x=1;Si=[{key:"tunare",npcId:127098,itemId:990124,scriptedSpawn:{x:-247,questSource:"a(b).lua"}}],y=2';
  expect(arrayLiteral(text, text.indexOf("[{"))).toEqual([{ key: "tunare", npcId: 127098, itemId: 990124, scriptedSpawn: { x: -247, questSource: "a(b).lua" } }]);
  expect(() => arrayLiteral('[{key:"a",v:alert(1)}]', 0)).toThrow("not a plain literal");
});

test("each leader keeps its carried copies up to the need left after others' copies, and every leader keeps the shortfall", () => {
  const row = (characterName: string, itemId: number, location = "Carried", quantity?: number) => ({ characterName, itemId, location, ...(quantity ? { quantity } : {}) });
  const rows = [
    // Item 1: need 3. A member carries one and leader A wears one, both out of the reserve's reach.
    row("Member", 1), row("A", 1, "Equipped"),
    // A carries a stack of 4: one copy is still needed, the rest is surplus.
    row("A", 1, "Carried", 4),
    // Item 2: need 2, leaders A and B carry one each, nothing short.
    row("A", 2), row("B", 2),
    // Item 9 has no need and is ignored.
    row("A", 9),
  ];
  const shares = tabShares({ need: { 1: 3, 2: 2, 3: 1 }, short: { 7: 2 }, rows, leaders: ["A", "B"] });
  // Item 3 is short everywhere, and the gear plan's two copies of item 7 go to every leader.
  expect(shares).toEqual({ A: { 1: 1, 2: 1, 3: 1, 7: 2 }, B: { 2: 1, 3: 1, 7: 2 } });
});

test("every copy of an item the hand-in NPC takes alone for XP is kept, and nothing it takes in sets or for no XP", () => {
  const branch = (npc: string, inputs: Record<number, number>, exp: number) => ({ event: "trade", script: { npc }, inputs, actions: exp ? [{ exp }] : [] });
  const branches = [
    branch("Smith Tv-ysa", { 10300: 1 }, 137200),
    // A second branch for the same stone pays more, and the larger reward counts.
    branch("Smith Tv-ysa", { 10300: 1 }, 140000),
    // Two of one item, a set of two items, and a hand-in without XP are no repeatable XP hand-ins.
    branch("Smith Tv-ysa", { 10400: 2 }, 274400),
    branch("Smith Tv-ysa", { 10015: 1, 10016: 1 }, 5000),
    branch("Smith Tv-ysa", { 13077: 1 }, 0),
    // Another NPC's hand-in is not the task's.
    branch("Mrysila", { 10500: 1 }, 14500),
  ];
  expect(handInDemand(branches, "Smith Tv-ysa")).toEqual({ demand: { 10300: ALL_COPIES }, xp: { 10300: 140000 } });
});
