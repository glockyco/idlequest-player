// Checks the quest chains generated from the epic model (tools/lib/epic-chain.mjs). Run with
// `bun test`.
import { expect, test } from "bun:test";
import { epicChains, uncovered } from "../tools/lib/epic-chain.mjs";
import { buildEpicModel, epicTree } from "../tools/lib/epic-model.mjs";
import { parseScript, scriptOwner } from "../tools/lib/quest-script.mjs";

const script = (file: string, lua: string) => ({ file, ...scriptOwner(file), ...parseScript(lua) });

test("an epic's chain says, hands in and kills the NPC a hand-in spawns, and starts a part where a hunted piece comes in", () => {
  const giver = `function event_say(e)
  if e.message:findi("task") then
    e.other:SummonItem(10)
  end
end
function event_trade(e)
  local item_lib = require("items")
  if item_lib.check_turn_in(e.trade, {item1 = 10}) then
    eq.spawn2(500, 0, 0, 0, 0, 0, 0)
  end
end`;
  const taker = `function event_trade(e)\n  local item_lib = require("items")\n  if item_lib.check_turn_in(e.trade, {item1 = 20, item2 = 60}) then\n    e.other:SummonItem(30)\n  end\nend`;
  const model = buildEpicModel({
    scripts: [script("z/Giver.lua", giver), script("z/Taker.lua", taker)],
    npcs: [{ id: 1, name: "Giver", level: 30, loottable: 0 }, { id: 2, name: "Taker", level: 30, loottable: 0 }, { id: 7, name: "a_beast", level: 35, loottable: 0 }, { id: 500, name: "a_guardian", level: 40, loottable: 9 }],
    spawns: [{ npcId: 1, zone: "z" }, { npcId: 2, zone: "z" }, { npcId: 7, zone: "z", points: 2, respawn: 600, spawn: 1 }],
    loot: new Map([[9, [{ item: 20, p: 1 }]]]),
    // The hide drops from a static beast, so a hunt gets it.
    sources: [{ item: 60, way: { kind: "drop", npcId: 7, npc: "a beast", zone: "z", level: 35, drop: 0.5, spawn: 1, points: 2, respawn: 600 } }],
  });
  const names = new Map([[10, "Note"], [20, "Fang"], [30, "Prize"], [60, "Hide"]]);
  const chains = epicChains(model, epicTree(model, "Cleric", 30), { cls: "Cleric", reward: 30, names });
  expect(chains).toEqual([
    {
      id: "epic-cleric-30-1",
      // The guardian's level less three, above the zone's median level less three. A step at an NPC
      // names its type ids, which tell it from another NPC of its name.
      chain: { class: "Cleric", minLevel: 37, reward: "Fang", steps: [
        { zone: "z", npc: "Giver", npcIds: [1], say: ["task"], expect: "Note" },
        { zone: "z", npc: "Giver", npcIds: [1], give: ["Note"] },
        { zone: "z", kill: "a guardian", level: 40, hp: null, expect: "Fang", waitSec: 60 },
      ] },
    },
    {
      id: "epic-cleric-30-2",
      chain: { class: "Cleric", minLevel: 27, reward: "Prize", needs: ["Fang", "Hide"], steps: [{ zone: "z", npc: "Taker", npcIds: [2], give: ["Fang", "Hide"], expect: "Prize" }] },
    },
  ]);
});

test("a piece sold in another zone is bought in a step of its own, in a city before a dungeon, and a hand-in carries its coin", () => {
  const taker = `function event_trade(e)\n  local item_lib = require("items")\n  if item_lib.check_turn_in(e.trade, {item1 = 70, item2 = 71, gold = 10}) then\n    e.other:SummonItem(30)\n  end\nend`;
  const model = buildEpicModel({
    scripts: [script("z/Taker.lua", taker)],
    npcs: [{ id: 2, name: "Taker", level: 30, loottable: 0 }],
    spawns: [{ npcId: 2, zone: "z" }],
    sources: [
      // The shirt has a seller in a dungeon and one in a city, and the wine one beside the taker.
      { item: 70, way: { kind: "buy", npc: "Dungeon Trader", zone: "dungeon" } },
      { item: 70, way: { kind: "buy", npc: "City Tailor", zone: "city" } },
      { item: 71, way: { kind: "buy", npc: "Vintner", zone: "z" } },
    ],
  });
  const names = new Map([[30, "Prize"], [70, "Shirt"], [71, "Wine"]]);
  const [chain] = epicChains(model, epicTree(model, "Cleric", 30), { cls: "Cleric", reward: 30, names, shopZones: new Set(["city"]) });
  expect(chain.chain.steps).toEqual([
    { zone: "city", buy: { merchant: "City Tailor", items: ["Shirt"], counts: { Shirt: 1 } } },
    { zone: "z", npc: "Taker", npcIds: [2], give: ["Shirt", "Wine"], coin: { gold: 10 }, buy: { merchant: "Vintner", items: ["Wine"] }, expect: "Prize" },
  ]);
});

test("a chain with a kill above level 60 exists, asks for the level cap and names the enemy for the kill chance", () => {
  const giver = `function event_trade(e)\n  local item_lib = require("items")\n  if item_lib.check_turn_in(e.trade, {item1 = 10}) then\n    eq.spawn2(500, 0, 0, 0, 0, 0, 0)\n  end\nend`;
  const model = buildEpicModel({
    scripts: [script("z/Giver.lua", giver)],
    npcs: [{ id: 1, name: "Giver", level: 30, loottable: 0 }, { id: 500, name: "a_dragon", level: 65, hp: 32500, loottable: 9 }],
    spawns: [{ npcId: 1, zone: "z" }],
    loot: new Map([[9, [{ item: 30, p: 1 }]]]),
    sources: [{ item: 10, way: { kind: "buy", npc: "Vintner", zone: "z" } }],
  });
  const [chain] = epicChains(model, epicTree(model, "Monk", 30), { cls: "Monk", reward: 30, names: new Map([[10, "Wine"], [30, "Fangs"]]) });
  expect(chain.chain.minLevel).toBe(60);
  expect(chain.chain.steps.at(-1)).toEqual({ zone: "z", kill: "a dragon", level: 65, hp: 32500, expect: "Fangs", waitSec: 60 });
});

test("a model chain part that yields a hand-kept chain's reward of its class is left out, and the parts beyond it stay", () => {
  const part = (cls: string, expects: string[]) => ({ class: cls, steps: expects.map((expect) => ({ zone: "z", npc: "N", expect })) });
  const chains = { a: part("Cleric", ["Crown", "Statue", "Orb"]), b: part("Cleric", ["Sceptre"]), c: part("Monk", ["Statue"]) };
  const hand = { h: { class: "Cleric", reward: "Statue", steps: [] } };
  expect(Object.keys(uncovered(chains, hand))).toEqual(["b", "c"]);
});
