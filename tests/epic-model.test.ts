// Checks the epic model (tools/lib/epic-model.mjs) on small worlds built from script fixtures: the
// ways it chooses, their order, and why a way is closed. Run with `bun test`.
import { expect, test } from "bun:test";
import { buildEpicModel, epicTree, huntPieces, treeNeeds } from "../tools/lib/epic-model.mjs";
import { parseScript, scriptOwner } from "../tools/lib/quest-script.mjs";

const script = (file: string, lua: string) => ({ file, ...scriptOwner(file), ...parseScript(lua) });
// A step as the order it runs in: a branch by its event and actions, a piece by its way.
const describe = (s: any) =>
  s.item
    ? `${s.way.kind} ${s.item}`
    : `${s.branch.event} ${s.branch.actions.map((a: any) => (a.give ? `give ${a.give}` : a.spawn ? `spawn ${a.spawn}` : Object.keys(a)[0])).join(", ")}`;
const GIVER = { id: 1, name: "Giver", level: 30, loottable: 0 };

test("the cheapest way runs a keyword, the hand-in that spawns a guardian, its kill and the last hand-in, in order", () => {
  const model = buildEpicModel({
    scripts: [
      script(
        "z/Giver.lua",
        `function event_say(e)
  if e.message:findi("task") then
    e.other:SummonItem(10)
  end
end
function event_trade(e)
  local item_lib = require("items")
  if item_lib.check_turn_in(e.trade, {item1 = 10}) then
    eq.spawn2(500, 0, 0, 0, 0, 0, 0)
  elseif item_lib.check_turn_in(e.trade, {item1 = 20}) then
    e.other:SummonItem(30)
  end
end`,
      ),
    ],
    npcs: [GIVER, { id: 500, name: "a_guardian", level: 40, loottable: 7 }],
    spawns: [{ npcId: 1, zone: "z" }],
    loot: new Map([[7, [{ item: 20, p: 1 }]]]),
  });
  const tree = epicTree(model, "Cleric", 30);
  expect(tree.steps.map(describe)).toEqual(["say give 10", "trade spawn 500", "scene 20", "trade give 30"]);
  expect(tree.gaps).toEqual([]);
  expect(Number.isFinite(tree.cost)).toBe(true);
});

test("a class gate closes its branch for the other classes and names the class", () => {
  const model = buildEpicModel({
    scripts: [script("z/Giver.lua", `function event_say(e)\n  if e.other:GetClass() == 3 and e.message:findi("oath") then\n    e.other:SummonItem(30)\n  end\nend`)],
    npcs: [GIVER],
    spawns: [{ npcId: 1, zone: "z" }],
  });
  const cleric = epicTree(model, "Cleric", 30);
  expect(cleric.cost).toBe(Infinity);
  expect(cleric.blocked.flatMap((b: any) => b.reasons)).toEqual(["only for Paladin"]);
  expect(Number.isFinite(epicTree(model, "Paladin", 30).cost)).toBe(true);
});

test("a branch with a condition the analyzer cannot read is closed, not free", () => {
  const unreadable = `function event_say(e)\n  if mystery(e.other) then\n    e.other:SummonItem(30)\n  end\nend`;
  const trade = `function event_trade(e)\n  local item_lib = require("items")\n  if item_lib.check_turn_in(e.trade, {item1 = 40}) then\n    e.other:SummonItem(30)\n  end\nend`;
  const ground = [{ item: 40, way: { kind: "ground", zone: "z", respawn: 60 } }];
  const both = buildEpicModel({ scripts: [script("z/Giver.lua", unreadable), script("z/Taker.lua", trade)], npcs: [GIVER, { id: 2, name: "Taker", level: 30, loottable: 0 }], spawns: [{ npcId: 1, zone: "z" }, { npcId: 2, zone: "z" }], sources: ground });
  expect(epicTree(both, "Cleric", 30).steps.map(describe)).toEqual(["ground 40", "trade give 30"]);
  const alone = epicTree(buildEpicModel({ scripts: [script("z/Giver.lua", unreadable)], npcs: [GIVER], spawns: [{ npcId: 1, zone: "z" }] }), "Cleric", 30);
  expect(alone.cost).toBe(Infinity);
  expect(alone.blocked[0].reasons).toEqual(["the analyzer cannot read the condition mystery(e.other) (line 2)"]);
});

test("a death that tests a script variable needs the hand-in that sets it first, and a handed-back item is no way to it", () => {
  const model = buildEpicModel({
    scripts: [
      script(
        "sebilis/An_Undead_Bard.lua",
        `local armed = false
function event_trade(e)
  local item_lib = require("items")
  if item_lib.check_turn_in(e.trade, {item1 = 20536}) then
    e.other:SummonItem(20536)
    armed = true
  end
end
function event_death_complete(e)
  if armed then
    eq.spawn2(89181, 0, 0, 0, 0, 0, 0)
  end
end`,
      ),
    ],
    npcs: [{ id: 2, name: "An_Undead_Bard", level: 50, loottable: 0 }, { id: 89181, name: "#Trakanon", level: 65, loottable: 9 }],
    spawns: [{ npcId: 2, zone: "sebilis" }],
    loot: new Map([[9, [{ item: 20526, p: 1 }]]]),
    sources: [{ item: 20536, way: { kind: "ground", zone: "steamfont", respawn: 60 } }],
  });
  expect(model.ways.get(20536).map((w: any) => w.kind)).toEqual(["ground"]);
  expect(epicTree(model, "Bard", 20526).steps.map(describe)).toEqual(["ground 20536", "trade give 20536, setVar", "death spawn 89181", "scene 20526"]);
});

test("items that only make each other are blocked, and the search ends", () => {
  const lua = `function event_trade(e)
  local item_lib = require("items")
  if item_lib.check_turn_in(e.trade, {item1 = 50}) then
    e.other:SummonItem(51)
  elseif item_lib.check_turn_in(e.trade, {item1 = 51}) then
    e.other:SummonItem(50)
  end
end`;
  const tree = epicTree(buildEpicModel({ scripts: [script("z/Giver.lua", lua)], npcs: [GIVER], spawns: [{ npcId: 1, zone: "z" }] }), "Cleric", 51);
  expect(tree.cost).toBe(Infinity);
  expect(tree.steps.map(describe)).toEqual(["trade give 50", "trade give 51"]);
});

test("a copy of a script under a zone where its NPC does not appear belongs to no NPC", () => {
  const lua = `function event_say(e)\n  if e.message:findi("hail") then\n    e.other:SummonItem(60)\n  end\nend`;
  const model = buildEpicModel({ scripts: [script("oldname/Giver.lua", lua)], npcs: [GIVER], spawns: [{ npcId: 1, zone: "z" }] });
  const tree = epicTree(model, "Cleric", 60);
  expect(tree.cost).toBe(Infinity);
  expect(tree.blocked[0].reasons).toEqual(["Giver has no live spawn and no script spawns it"]);
  const both = buildEpicModel({ scripts: [script("oldname/Giver.lua", lua), script("z/Giver.lua", lua)], npcs: [GIVER], spawns: [{ npcId: 1, zone: "z" }] });
  expect(epicTree(both, "Cleric", 60).steps.map((s: any) => s.branch.file)).toEqual(["z/Giver.lua"]);
});

test("an epic's needs count each hand-in's inputs and held items, and leave out a piece its step buys", () => {
  const lua = `function event_trade(e)
  local item_lib = require("items")
  if e.other:HasItem(72) and item_lib.check_turn_in(e.trade, {item1 = 70, item2 = 70, item3 = 71}) then
    e.other:SummonItem(80)
  end
end`;
  const model = buildEpicModel({
    scripts: [script("z/Giver.lua", lua)],
    npcs: [GIVER],
    spawns: [{ npcId: 1, zone: "z" }],
    sources: [
      { item: 70, way: { kind: "ground", zone: "z", respawn: 60 } },
      { item: 71, way: { kind: "buy", npc: "a merchant", zone: "z" } },
      { item: 72, way: { kind: "ground", zone: "z", respawn: 60 } },
    ],
  });
  expect(treeNeeds(epicTree(model, "Cleric", 80))).toEqual({ 70: 2, 72: 1 });
});

test("a combine buys the inputs the Tradeskill Bank's catalog sells, and the catalog is no way to a hand-in's input", () => {
  const lua = `function event_trade(e)\n  local item_lib = require("items")\n  if item_lib.check_turn_in(e.trade, {item1 = 91}) then\n    e.other:SummonItem(92)\n  end\nend`;
  const parts = {
    npcs: [GIVER],
    spawns: [{ npcId: 1, zone: "z" }],
    edges: [{ kind: "combine", recipe: 7, inputs: { 90: 1 }, outputs: [91] }],
    catalog: new Map([[90, 500], [91, 900]]),
  };
  const crafted = epicTree(buildEpicModel({ scripts: [script("z/Giver.lua", lua)], ...parts }), "Cleric", 92);
  expect(crafted.steps.map(describe)).toEqual(["catalog 90", "combine 91", "trade give 92"]);
  expect(treeNeeds(crafted)).toEqual({ 91: 1 });
  const handedIn = epicTree(buildEpicModel({ scripts: [script("z/Giver.lua", lua)], ...parts, edges: [] }), "Cleric", 92);
  expect(handedIn.gaps).toEqual([91]);
});

test("a branch behind a random roll costs its tries, so a sure hand-in beats a guardian one sentry death in ten spawns", () => {
  const sentry = `function event_death_complete(e)\n  local roll = math.random(10)\n  if roll == 1 then\n    eq.spawn2(500, 0, 0, 0, 0, 0, 0)\n  end\nend`;
  const taker = `function event_trade(e)\n  local item_lib = require("items")\n  if item_lib.check_turn_in(e.trade, {item1 = 40, item2 = 40}) then\n    e.other:SummonItem(30)\n  end\nend`;
  const model = buildEpicModel({
    scripts: [script("z/a_sentry.lua", sentry), script("z/Taker.lua", taker)],
    npcs: [{ id: 3, name: "a_sentry", level: 30, loottable: 0 }, { id: 500, name: "a_guardian", level: 30, loottable: 7 }, { id: 2, name: "Taker", level: 30, loottable: 0 }],
    spawns: [{ npcId: 3, zone: "z" }, { npcId: 2, zone: "z" }],
    loot: new Map([[7, [{ item: 30, p: 1 }]]]),
    sources: [{ item: 40, way: { kind: "ground", zone: "z", respawn: 60 } }],
  });
  expect(epicTree(model, "Cleric", 30).steps.map(describe)).toEqual(["ground 40", "trade give 30"]);
});

test("a piece a chain of deaths brings comes from the static enemy that starts it, whose every line ends in the named", () => {
  // A reaver's death respawns a reaver on rolls 1 to 8 and the named otherwise, so each static
  // spawn of the reaver brings the named once, after five reaver kills on average.
  const reaver = `function event_death_complete(e)\n  local roll = math.random(10)\n  if roll <= 8 then\n    eq.spawn2(90010, 0, 0, 0, 0, 0, 0)\n  else\n    eq.unique_spawn(90174, 0, 0, 0, 0, 0, 0)\n  end\nend`;
  const sentinel = `function event_trade(e)\n  local item_lib = require("items")\n  if item_lib.check_turn_in(e.trade, {item1 = 1674}) then\n    e.other:SummonItem(10651)\n  end\nend`;
  const model = buildEpicModel({
    scripts: [script("citymist/90010.lua", reaver), script("emeraldjungle/Spirit_Sentinel.lua", sentinel)],
    npcs: [{ id: 90010, name: "a_black_reaver", level: 50, hp: 9980, loottable: 0 }, { id: 90174, name: "#Lord_Rak`Ashiir", level: 54, hp: 11000, loottable: 7 }, { id: 3, name: "Spirit_Sentinel", level: 50, loottable: 0 }],
    spawns: [{ npcId: 90010, zone: "citymist", points: 1, respawn: 7200, spawn: 1 }, { npcId: 3, zone: "emeraldjungle" }],
    loot: new Map([[7, [{ item: 1674, p: 1 }]]]),
  });
  const pieces = huntPieces(model, epicTree(model, "Shaman", 10651));
  expect(pieces).toEqual([{ itemId: 1674, sources: [expect.objectContaining({ zone: "citymist", npc: "a black reaver", npcLevel: 54, npcHp: 11000, drop: 1, kills: 6, hours: 2, also: ["Lord Rak`Ashiir"] })] }]);
});
