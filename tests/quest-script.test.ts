// Checks the quest script analyzer (tools/lib/quest-script.mjs) on script fixtures, one per idiom
// the epic model follows. Run with `bun test`.
import { expect, test } from "bun:test";
import { parseScript, scriptOwner } from "../tools/lib/quest-script.mjs";

const branches = (lua: string, event: string) => parseScript(lua).events[event] ?? [];
const giving = (lua: string, event: string, item: number) => branches(lua, event).find((b) => b.actions.some((a) => a.give?.includes(item)));

test("a keyword inside a class check carries both, and a trade the items and coin it takes", () => {
  const lua = `function event_say(e)
  if e.other:GetClass() == 2 then
    if e.message:findi("water") then
      e.other:SummonItem(5532)
    end
  end
end
function event_trade(e)
  local item_lib = require("items")
  if item_lib.check_turn_in(e.trade, {item1 = 100, item2 = 100, item3 = 200, platinum = 5}) then
    e.other:SummonItem(300)
  elseif eq.handin({[400] = 2}) then
    e.other:QuestReward(e.self, {itemid = 500, exp = 1000})
  end
end`;
  expect(giving(lua, "say", 5532)?.when).toEqual([{ class: "Cleric" }, { say: ["water"] }]);
  expect(giving(lua, "trade", 300)?.when).toEqual([{ trade: { items: { 100: 2, 200: 1 }, coin: { platinum: 5 } } }]);
  const handin = giving(lua, "trade", 500);
  expect(handin?.when).toEqual([{ trade: { items: { 400: 2 } } }]);
  expect(handin?.actions).toContainEqual({ exp: 1000 });
});

test("a flag one branch sets is a condition of the branch that reads it", () => {
  const lua = `function event_say(e)
  local qglobals = eq.get_qglobals(e.other)
  if e.message:findi("ready") then
    eq.set_global("trial", "1", 5, "F")
  elseif e.message:findi("reward") and qglobals["trial"] == "1" then
    e.other:SummonItem(700)
  end
end`;
  expect(branches(lua, "say").find((b) => b.actions.some((a) => a.setFlag))?.actions).toContainEqual({ setFlag: "trial", value: "1" });
  expect(giving(lua, "say", 700)?.when).toEqual([{ say: ["reward"] }, { flag: "trial", op: "==", value: "1" }]);
});

test("a timer a trade starts runs its own branch, and a spawn with a method chained on it or kept in a local still spawns", () => {
  const lua = `function event_trade(e)
  local item_lib = require("items")
  if item_lib.check_turn_in(e.trade, {item1 = 10}) then
    eq.set_timer("scene", 30000)
  end
end
function event_timer(e)
  if e.timer == "scene" then
    eq.stop_timer("scene")
    eq.spawn2(1001, 0, 0, 0, 0, 0, 0):AddToHateList(e.other, 1)
    local guard = eq.unique_spawn(1002, 0, 0, 0, 0, 0, 0)
  end
end`;
  expect(branches(lua, "trade")[0].actions).toContainEqual({ setTimer: "scene", ms: 30000 });
  const scene = branches(lua, "timer")[0];
  expect(scene.when).toEqual([{ timer: "scene" }]);
  expect(scene.actions).toEqual([{ stopTimer: "scene" }, { spawn: 1001 }, { attack: true }, { spawn: 1002 }]);
});

test("a script variable a trade sets is a condition on the death that tests it", () => {
  const lua = `local armed = false
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
    armed = false
  end
end`;
  expect(branches(lua, "trade")[0].actions).toContainEqual({ setVar: "armed", value: true });
  expect(branches(lua, "death")[0].when).toEqual([{ var: "armed", op: "truthy", value: null, initial: false, line: 10 }]);
});

test("an event's own variable stands for the conditions it got its value under, and a computed one stays unread", () => {
  const lua = `function event_trade(e)
  local more = 0
  local count = 0
  local item_lib = require("items")
  if item_lib.check_turn_in(e.trade, {item1 = 13829, item2 = 13829, item3 = 13829, item4 = 13829}) then
    more = 1
  elseif item_lib.check_turn_in(e.trade, {item1 = 13829}) then
    count = count + 1
  end
  if more == 1 then
    e.other:SummonItem(12196)
  end
  if more == 2 then
    e.other:SummonItem(1)
  end
  if count == 3 then
    e.other:SummonItem(2)
  end
end`;
  expect(giving(lua, "trade", 12196)?.when).toEqual([{ trade: { items: { 13829: 4 } } }]);
  expect(giving(lua, "trade", 1)?.when[0]).toMatchObject({ never: "more == 2" });
  expect(giving(lua, "trade", 2)?.when[0]).toMatchObject({ unread: "count == 3" });
});

test("the zone's hour, the NPC's type and grouped alternatives read as conditions", () => {
  const lua = `function event_trade(e)
  local time = eq.get_zone_time()
  local hour = time["zone_hour"]
  if hour >= 6 and e.self:GetNPCTypeID() == 80002 then
    e.other:SummonItem(1)
  end
end
function event_say(e)
  if (e.other:GetClass() == 2 and e.message:findi("a")) or e.other:GetClass() == 3 then
    e.other:SummonItem(2)
  end
end`;
  expect(giving(lua, "trade", 1)?.when).toEqual([{ time: "hour >= 6" }, { npcType: 80002 }]);
  expect(giving(lua, "say", 2)?.when).toEqual([{ any: [{ all: [{ class: "Cleric" }, { say: ["a"] }] }, { class: "Paladin" }] }]);
});

test("a condition the analyzer cannot read is listed with its event and line", () => {
  const { unread } = parseScript(`function event_say(e)
  if some_check(e.other) then
    e.other:SummonItem(1)
  end
end`);
  expect(unread).toEqual([{ event: "say", line: 2, text: "some_check(e.other)" }]);
});

test("a script file names its NPC, decoding a leading # and taking a number as the NPC's id", () => {
  expect(scriptOwner("kithicor/%23Tasi_V-ghera.lua")).toEqual({ zone: "kithicor", npc: "Tasi V-ghera", npcId: null });
  expect(scriptOwner("citymist/90000.lua")).toEqual({ zone: "citymist", npc: null, npcId: 90000 });
});

test("the clauses of a random roll split its values, and an else takes the rest", () => {
  const lua = `function event_death_complete(e)
  local roll = math.random(100)
  if roll <= 50 then
    eq.spawn2(1, 0, 0, 0, 0, 0, 0)
  elseif roll <= 80 then
    eq.spawn2(2, 0, 0, 0, 0, 0, 0)
  else
    eq.spawn2(3, 0, 0, 0, 0, 0, 0)
  end
end`;
  const chance = (npc: number) => branches(lua, "death").find((b) => b.actions.some((a) => a.spawn === npc))?.when.find((c) => c.random)?.p;
  expect([chance(1), chance(2), chance(3)]).toEqual([0.5, 0.3, 0.2]);
});
