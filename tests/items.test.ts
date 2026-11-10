// Checks the item demand model (docs/plans/items.md): the quest graph's script edges and walk, the
// demand sources and the client table reader. Run with `bun test`.
import { expect, test } from "bun:test";
import { arrayLiteral } from "../tools/lib/client-tables.mjs";
import { addDemand, chainDemand, potionDemand, stepDemand, tabShares } from "../tools/lib/item-demand.mjs";
import { needFor, scriptEdges } from "../tools/lib/quest-graph.mjs";

const FORPAR = `function event_say(e)
	if e.message:findi("components") then
		e.other:SummonItem(20380)
	end
end

function event_trade(e)
	if item_lib.check_turn_in(e.trade, {item1 = 20378}) then
		e.other:SummonItem(20380)
	elseif item_lib.check_turn_in(e.trade, {item1 = 20380, item2 = 20524, item3 = 20525, item4 = 5520}) then
		e.other:SummonItem(20535)
	end
	item_lib.return_items(e.self, e.other, e.trade)
end`;

test("a script gives one hand-in edge per branch, a talk edge for what dialogue gives, and the spawns and rewards of each", () => {
  const edges = scriptEdges(FORPAR, { zone: "steamfont", npc: "Forpar Fizfla" });
  expect(edges.map((e) => [e.kind, e.inputs, e.outputs])).toEqual([
    ["handin", { 20378: 1 }, [20380]],
    ["handin", { 20380: 1, 20524: 1, 20525: 1, 5520: 1 }, [20535]],
    ["talk", {}, [20380]],
  ]);
  // The positional QuestReward names its item and XP, eq.handin its counts, and a branch that
  // spawns an NPC lists it for its loot.
  const other = scriptEdges(
    `function event_trade(e)
	if (eq.handin({[14337] = 1, [13073] = 2})) then
		e.other:QuestReward(e.self,0,0,0,0,10651,350000)
		eq.spawn2(80042,0,0,1,2,3,0)
	end
end`,
    { zone: "z", npc: "n" },
  );
  expect(other).toMatchObject([{ kind: "handin", inputs: { 14337: 1, 13073: 2 }, outputs: [10651], exp: 350000, spawns: [80042] }]);
});

test("the walk back from a reward takes every alternative, and stops at what is held or bought", () => {
  const edge = (inputs: Record<number, number>, outputs: number[]) => ({ kind: "handin", inputs, outputs, exp: 0 });
  // 1 comes from 2 and 3, 3 from 4 or from 5 and 6, and 6 from a merchant item 7.
  const edges = [edge({ 2: 1, 3: 1 }, [1]), edge({ 4: 1 }, [3]), edge({ 5: 1, 6: 2 }, [3]), edge({ 7: 1 }, [6])];
  expect([...needFor(edges, 1).entries()].sort()).toEqual([[2, 1], [3, 1], [4, 1], [5, 1], [6, 2], [7, 1]]);
  // Holding 3 ends that branch, and a merchant's 6 is bought, not made.
  expect([...needFor(edges, 1, new Set([3])).keys()]).toEqual([2]);
  expect([...needFor(edges, 1, new Set(), new Set([6])).keys()].sort()).toEqual([2, 3, 4, 5, 6]);
});

test("chain demand counts a copy per member that still needs the epic, and one reward per member", () => {
  const edges = [{ kind: "handin", inputs: { 20: 1, 21: 2, 22: 1 }, outputs: [10], exp: 0 }];
  const epics = { Bard: [10], Wizard: [11] };
  const members = [{ name: "A", class: "Bard" }, { name: "B", class: "Bard" }, { name: "C", class: "Wizard" }];
  // B holds the epic, so only A needs its inputs. Item 22 is sold by a merchant and bought at the step.
  expect(chainDemand({ edges, epics, members, epicHolders: new Set(["B"]), buyable: new Set([22]) })).toEqual({ 10: 2, 11: 1, 20: 1, 21: 2 });
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
