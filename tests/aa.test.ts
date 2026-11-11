// Checks AA training: the order a class trains in (tools/lib/coordinator.mjs) and the page
// function that spends points (tools/iqd.mjs), against a server that answers as the Alternate
// Advancement window's request does. Run with `bun test`.
import { afterEach, expect, test } from "bun:test";
import { aaInPage } from "../tools/iqd.mjs";
import { AA_POLICY, aaOrder } from "../tools/lib/coordinator.mjs";

const STA = 50002;
const WIS = 50006;
const MAGIC = 50008;
const abilities = [
  { id: 50001, name: "Innate Strength", maxRank: 5 },
  { id: STA, name: "Innate Stamina", maxRank: 5 },
  { id: WIS, name: "Innate Wisdom", maxRank: 5 },
  { id: MAGIC, name: "Innate Magic Protection", maxRank: 5 },
];

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

/** A server holding each character's points and ranks, with the requests it got. */
function server(chars: Record<number, { name: string; level: number; points: number; ranks: Record<number, number>; pp: number }>, host: number) {
  const sent: Record<string, unknown>[] = [];
  const stateOf = (id: number) => ({ characterId: id, characterName: chars[id].name, characterLevel: chars[id].level, points: chars[id].points, spent: 0, ranks: { ...chars[id].ranks }, abilities, allocation: 100, unlockLevel: 46, levelRules: { player: { enabled: true, level: 60 }, companions: { enabled: true, level: 60 }, revision: 1 }, party: Object.entries(chars).map(([cid, c]) => ({ characterId: Number(cid), leaseId: `lease-${cid}`, name: c.name, level: c.level, allocation: 100 })) });
  const answer = (p: { action: string; target?: { characterId: number }; abilityId?: number; expectedRank?: number; expectedCostPlatinum?: number }) => {
    sent.push(p);
    const id = p.target?.characterId ?? host;
    const c = chars[id];
    if (p.action === "purchase") {
      if ((c.ranks[p.abilityId!] ?? 0) !== p.expectedRank) return { success: false, error: "rank changed", state: stateOf(id) };
      if (p.expectedCostPlatinum !== 2000) return { success: false, error: "price changed", state: stateOf(id) };
      if (c.pp < 2000) return { success: false, error: "You need 2000 platinum", state: stateOf(id) };
      c.pp -= 2000;
      c.points -= 1;
      c.ranks[p.abilityId!] = (c.ranks[p.abilityId!] ?? 0) + 1;
    }
    return { success: true, state: stateOf(id) };
  };
  // The page function reads the game's page from `window`, which the test stands in for.
  Reflect.set(globalThis, "window", { iq: { stores: { character: { getState: () => ({ characterProfile: { id: host } }) } }, socket: { sendCorrelatedJsonRequest: async (_op: number, _reply: number, p: never) => answer(p) }, query: async (_op: number, p: never) => answer(p) } });
  return sent;
}

test("a class trains its casting stat or stamina first and ends with every ability", () => {
  expect(aaOrder("Cleric").slice(0, 2)).toEqual([WIS, STA]);
  expect(aaOrder("wizard").slice(0, 2)).toEqual([50005, STA]);
  expect(aaOrder("Warrior").slice(0, 4)).toEqual([STA, 50001, 50004, 50003]);
  expect(aaOrder("Shadow Knight")[0]).toBe(STA);
  for (const cls of ["Cleric", "Warrior", null]) expect([...aaOrder(cls)].sort()).toEqual(Array.from({ length: 16 }, (_, k) => 50001 + k));
});

test("points are trained in the class's order, a rank a request, for the leader and the members", async () => {
  const chars = { 1: { name: "Tagujazolu", level: 60, points: 2, ranks: { [STA]: 4 }, pp: 9000 }, 2: { name: "Ewbanaqoa", level: 60, points: 1, ranks: {}, pp: 9000 }, 3: { name: "Qigaa", level: 59, points: 0, ranks: {}, pp: 9000 } };
  const sent = server(chars, 1);
  const orders = { Tagujazolu: aaOrder("Warrior"), Ewbanaqoa: aaOrder("Cleric"), Qigaa: aaOrder("Shaman") };
  const r = await aaInPage({ ...AA_POLICY, orders });
  if (!r) throw new Error("the page function found no page");
  // The warrior's last rank of stamina, then strength. The cleric's wisdom, through the member's lease.
  expect(sent.filter((p) => p.action === "purchase")).toEqual([
    { action: "purchase", abilityId: STA, expectedRank: 4, expectedCostPlatinum: 2000, hostCharacterId: 1 },
    { action: "purchase", abilityId: 50001, expectedRank: 0, expectedCostPlatinum: 2000, hostCharacterId: 1 },
    { action: "purchase", abilityId: WIS, expectedRank: 0, expectedCostPlatinum: 2000, target: { characterId: 2, leaseId: "lease-2" }, hostCharacterId: 1 },
  ]);
  expect(r.done).toEqual(["Tagujazolu trained Innate Stamina 5", "Tagujazolu trained Innate Strength 1", "Ewbanaqoa trained Innate Wisdom 1"]);
  expect(r.state).toMatchObject({ name: "Tagujazolu", points: 0, ranks: { [STA]: 5, 50001: 1 } });
  expect(r.members.map((m: { name: string; points: number }) => [m.name, m.points])).toEqual([["Ewbanaqoa", 0], ["Qigaa", 0]]);
  expect(r.refused).toEqual([]);
});

test("a refused rank ends that character's training and is named, and no order means no training", async () => {
  const chars = { 1: { name: "Tagujazolu", level: 60, points: 3, ranks: {}, pp: 2500 }, 2: { name: "Ewbanaqoa", level: 60, points: 1, ranks: {}, pp: 9000 } };
  const sent = server(chars, 1);
  const r = await aaInPage({ ...AA_POLICY, orders: { Tagujazolu: aaOrder("Warrior") } });
  if (!r) throw new Error("the page function found no page");
  expect(sent.filter((p) => p.action === "purchase")).toHaveLength(2);
  expect(r.done).toEqual(["Tagujazolu trained Innate Stamina 1", "Tagujazolu could not train Innate Stamina 2: You need 2000 platinum"]);
  expect(r.refused).toEqual(["Tagujazolu"]);
  expect(chars[2].points).toBe(1);
});
