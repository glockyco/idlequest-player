// Checks the quest chains generated from the epic model (tools/lib/epic-chain.mjs). Run with
// `bun test`.
import { expect, test } from "bun:test";
import { epicChains } from "../tools/lib/epic-chain.mjs";
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
      // The guardian's level less three, above the zone's median level less three.
      chain: { class: "Cleric", minLevel: 37, reward: "Fang", steps: [
        { zone: "z", npc: "Giver", say: ["task"], expect: "Note" },
        { zone: "z", npc: "Giver", give: ["Note"] },
        { zone: "z", kill: "a guardian", expect: "Fang", waitSec: 60 },
      ] },
    },
    {
      id: "epic-cleric-30-2",
      chain: { class: "Cleric", minLevel: 27, reward: "Prize", needs: ["Fang", "Hide"], steps: [{ zone: "z", npc: "Taker", give: ["Fang", "Hide"], expect: "Prize" }] },
    },
  ]);
});
