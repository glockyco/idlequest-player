// Checks the gear acquisition model (tools/lib/acquire.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { ACQUIRE, bestWay, copyHours, copyValue, deathHours, elasticity, killChanceOf, netRate, paceOf, trip, ways } from "../tools/lib/acquire.mjs";
import { xpStart } from "../tools/lib/xp.mjs";

const member = (name: string, level: number) => ({ name, level });
const tab = (level: number, zone: string) => ({ label: "A", group: "G1", zone, rotation: [zone], members: [member("A0", level)] });
const item = (gain: number, hours: number, drop = 0.1) => ({ item: "X", to: "X1", level: 30, gain, hours, drop });

test("the XP elasticity follows the model's table between its levels", () => {
  expect(elasticity(10)).toBe(0.5);
  expect(elasticity(29)).toBe(0.74);
  expect(elasticity(40)).toBeCloseTo(0.835);
  expect(elasticity(60)).toBe(0.85);
});

test("a copy adds its gain to the group's XP rate for the hours it is worn", () => {
  // 1% of the group's XP rate, 1.5 hours a level: 0.01 x 10 levels x 1.5 hours.
  expect(copyValue(item(10, 1), { X1: 1.5 })).toBeCloseTo(0.01 * ACQUIRE.wearLevels * 1.5);
  // A taker whose group's pace is unknown adds nothing yet.
  expect(copyValue(item(10, 1), {})).toBe(0);
});

test("a copy for a slot another hunt serves pays until that copy would come, and for good only what it adds over it", () => {
  // Ten hours of wear; the other hunt's copy gains 100 and is expected after 4 hours of hunting.
  const claim = { gain: 100, hours: 4 };
  const pace = { X1: 1 };
  expect(copyValue({ ...item(50, 1), claim }, pace, 1)).toBeCloseTo((50 / 1000) * 3);
  expect(copyValue({ ...item(50, 1), claim }, pace, 5)).toBe(0);
  expect(copyValue({ ...item(150, 1), claim }, pace, 1)).toBeCloseTo((50 * 10 + 100 * 3) / 1000);
  expect(copyValue(item(150, 1), pace, 1)).toBeCloseTo(1.5);
});

test("a common drop takes at least one kill-time per expected copy, however many points respawn", () => {
  // 67 points at 400 s would give a copy every 36 s, but a group that kills 84 an hour finds a 13% drop every 5.5 min.
  const wolf = { spawn: 1 };
  expect(copyHours({ hours: 0.01, drop: 0.13 }, wolf, 84)).toBeCloseTo(1 / (84 * 0.13));
  // A rare spawn stays bound by its respawns (1.4 h against 0.6 h of kills), and without a kill rate the respawns alone count.
  expect(copyHours({ hours: 1.4, drop: 1 }, { spawn: 0.02 }, 84)).toBe(1.4);
  expect(copyHours({ hours: 0.01, drop: 0.13 }, wolf, 0)).toBe(0.01);
});

test("drops that roll on their own shorten the hunting for the first copy, and a shared zone costs a share of it", () => {
  const x = { npc: "a fiend", zone: "unrest", npcLevel: 30, spawn: 1, points: 1, items: [item(600, 2), item(300, 2)] };
  const pace = { X1: 1 };
  const [errand] = ways(tab(30, "unrest"), x, { hoursPerLevel: pace });
  expect(errand.kind).toBe("errand");
  expect(errand.hours).toBeCloseTo(1);
  expect(errand.value).toBeCloseTo((copyValue(item(600, 2), pace) + copyValue(item(300, 2), pace)) / 2);
  expect(errand.cost).toBe(0);
  const other = { ...tab(30, "unrest"), label: "B" };
  const [shared] = ways(tab(30, "unrest"), x, { tabs: [other], hoursPerLevel: pace });
  expect(shared.cost).toBeCloseTo(ACQUIRE.sharedCost * shared.hours);
});

test("outside the rotation a camp and a visit each cost their whole time", () => {
  const x = { npc: "Hangman", zone: "trakanon", npcLevel: 30, spawn: 0.02, points: 6, items: [item(1000, 1.39, 1)] };
  const pace = { X1: 1 };
  const [camp, visit] = ways(tab(30, "paw"), x, { hoursPerLevel: pace });
  expect(camp).toMatchObject({ kind: "camp", hours: 1.39 });
  expect(camp.cost).toBeCloseTo(1.39);
  expect(visit.kind).toBe("visit");
  expect(visit.up).toBeCloseTo(1 - 0.98 ** 6);
  expect(visit.value).toBeCloseTo((1 - 0.98 ** 6) * copyValue(item(1000, 1.39, 1), pace));
  expect(visit.cost).toBe(ACQUIRE.visitHours);
  expect(bestWay(tab(30, "paw"), x, { hoursPerLevel: pace, killChance: () => sure })).toEqual(netRate(visit) > netRate(camp) ? visit : camp);
});

const sure = { p: 1, fights: 4, deaths: 0, leaderDeaths: 0 };

test("a group's own fights replace the simulator's, and no evidence means no kill chance", () => {
  expect(killChanceOf({})).toBeNull();
  expect(killChanceOf({ sim: { kills: 4, fights: 4, deathsPerFight: 1.25, leaderDeathsPerFight: 0.25 } })).toEqual({ p: 1, fights: 4, deaths: 1.25, leaderDeaths: 0.25 });
  // The group's own fights replace the simulator's, which knows nothing of the enemies that join:
  // two live escapes after four simulated wins leave the prior's one fight against them.
  const sim = { kills: 4, fights: 4, meanSec: 46, deathsPerFight: 0, leaderDeathsPerFight: 0 };
  expect(killChanceOf({ record: { kills: 0, escapes: 2 }, sim, prior: { p: 0.9, deaths: 0.1, leaderDeaths: 0 } })).toEqual({ p: 0.3, fights: 6, deaths: 0, leaderDeaths: 0, sec: 46 });
  expect(killChanceOf({ record: { kills: 0, escapes: 2 }, sim })!.p).toBe(0);
  expect(killChanceOf({ record: { kills: 3, escapes: 0 }, sim: { ...sim, kills: 2 }, prior: { p: 0.6, deaths: 0, leaderDeaths: 0 } })!.p).toBeCloseTo(0.9);
  expect(killChanceOf({ record: { kills: 3, escapes: 1 } })).toEqual({ p: 0.75, fights: 4, deaths: 0, leaderDeaths: 0 });
});

test("an enemy that takes longer to kill is hunted at its own pace", () => {
  // Group 2 on 2026-11-11: 56 kills an hour where it hunts, and a simulated 293 s for one Disciple
  // of Innoruuk, against about 38 s for its usual fight.
  expect(paceOf(56, { sec: 293 })).toBeCloseTo(56 / (293 / ((0.59 * 3600) / 56)), 5);
  expect(paceOf(56, { sec: 20 })).toBe(56);
  expect(paceOf(56, {})).toBe(56);
  expect(killChanceOf({ sim: { kills: 4, fights: 4, meanSec: 293, deathsPerFight: 0, leaderDeathsPerFight: 0 } })!.sec).toBe(293);
  // A camp of a common enemy whose copies come by the kill: a fifth of the kills, a fifth of the copies.
  const x = { npc: "a disciple", zone: "hateplane", npcLevel: 56, spawn: 1, points: 7, respawn: 640, items: [{ ...item(100, 0.01, 0.02), respawnHours: 0.01 }] };
  const t = { ...tab(48, "frozenshadow"), group: "G2" };
  const ctx = { hoursPerLevel: { X1: 1 }, killsPerHour: { G2: 60 } };
  const k = { p: 1, fights: 4, deaths: 0, leaderDeaths: 0 };
  const quick = ways(t, x, ctx, k).find((w: { kind: string }) => w.kind === "camp")!;
  const slow = ways(t, x, ctx, { ...k, sec: 5 * 35.4 }).find((w: { kind: string }) => w.kind === "camp")!;
  expect(slow.hours / quick.hours).toBeCloseTo(5, 5);
});

test("a hunt is valued at its kill chance, and every fight pays its deaths", () => {
  const x = { npc: "a broodling", zone: "paw", npcLevel: 34, spawn: 1, points: 1, items: [item(100, 1, 0.5)] };
  // The zone is in the group's rotation, so an errand is the only way.
  const pace = { X1: 1, A0: 2 };
  const at = (k: object | null) => bestWay(tab(30, "paw"), x, { hoursPerLevel: pace, killChance: () => k });
  expect(at(null)).toBeNull();
  expect(at({ ...sure, p: 0 })).toBeNull();
  // Half the fights lost: the copy takes twice the hours, and is still taken when it pays.
  const half = at({ ...sure, p: 0.5 })!;
  expect(half.hours).toBeCloseTo(at(sure)!.hours * 2);
  // A leader death per fight costs its time and its XP at the leader's pace, for each of the four
  // fights a copy takes at a 50% drop and a 50% chance.
  const dying = { ...sure, p: 0.5, deaths: 1, leaderDeaths: 1 };
  const perFight = 85 / 3600 + (30 * 30 * 666.67) / ((xpStart(31) - xpStart(30)) / 2);
  expect(deathHours(tab(30, "paw"), dying, pace)).toBeCloseTo(perFight);
  expect(at(dying)!.cost).toBeCloseTo(4 * perFight);
});

test("a trip pays its zone's cost once and adds each enemy's drops", () => {
  const pace = { X1: 1 };
  const ctx = { hoursPerLevel: pace, killChance: () => sure };
  const fiend = { npc: "a fiend", zone: "unrest", npcLevel: 30, spawn: 1, points: 1, items: [item(75, 1)] };
  const ghoul = { npc: "a ghoul", zone: "unrest", npcLevel: 30, spawn: 1, points: 1, items: [{ ...item(60, 1), slot: "neck" }] };
  const camp = (x: object, kind: string) => kind === "camp";
  // A copy an hour of each, worth 0.75 and 0.6 hours: the half-hour camp fills each slot with the
  // chance 1 - e^-0.5 that its copy comes, and costs its half hour once.
  const both = trip(tab(30, "paw"), [fiend, ghoul], ctx, camp)!;
  expect(both).toMatchObject({ kind: "camp", zone: "unrest", hours: ACQUIRE.campMin / 60 });
  expect(both.members.map((m) => m.x.npc)).toEqual(["a fiend", "a ghoul"]);
  expect(netRate(both)).toBeCloseTo(((0.75 + 0.6) * (1 - Math.exp(-0.5)) - 0.5) / 0.5);
  // An enemy not due for a camp stays out of it.
  expect(trip(tab(30, "paw"), [fiend, ghoul], ctx, (x, kind) => camp(x, kind) && x !== ghoul)!.members.map((m) => m.x.npc)).toEqual(["a fiend"]);
});

test("a trip fills a slot once, however fast its copies come", () => {
  // Ten copies an hour of a 0.75-hour piece: a half-hour camp fills the slot almost surely, and
  // earns the copy once, not five times.
  const fast = { npc: "a fiend", zone: "unrest", npcLevel: 30, spawn: 1, points: 1, items: [item(75, 0.1)] };
  const camp = trip(tab(30, "paw"), [fast], { hoursPerLevel: { X1: 1 }, killChance: () => sure })!;
  expect(camp.value).toBeCloseTo(0.75 * (1 - Math.exp(-5)));
});

test("enemies that each take all of the group's kills do not add up on one trip", () => {
  const pace = { X1: 1 };
  // Ten points respawning hourly give ten kills an hour, all a group of ten kills an hour takes.
  const busy = (npc: string, gain: number) => ({ npc, zone: "unrest", npcLevel: 30, spawn: 1, points: 10, respawn: 3600, items: [{ ...item(gain, 1), slot: npc }] });
  const both = trip(tab(30, "paw"), [busy("a fiend", 75), busy("a ghoul", 60)], { hoursPerLevel: pace, killChance: () => sure, killsPerHour: { G1: 10 } })!;
  expect(both.members.map((m) => m.x.npc)).toEqual(["a fiend"]);
  expect(netRate(both)).toBeCloseTo((0.75 * (1 - Math.exp(-0.5)) - 0.5) / 0.5);
});

test("a hunt for a copy at the end of a chain of deaths takes the whole chain", () => {
  // The black reaver's line: one copy from a chain of six kills on average. At twelve kills an hour
  // a visit spends half an hour on the chain, and every fight of it pays its deaths.
  const reaver = { npc: "a black reaver", zone: "citymist", npcLevel: 54, spawn: 1, points: 1, also: ["Lord Rak`Ashiir"], items: [{ ...item(5000, 2, 1), kills: 6 }] };
  const ctx = { hoursPerLevel: { X1: 1 }, killChance: () => sure, killsPerHour: { G1: 12 } };
  expect(trip(tab(30, "paw"), [reaver], ctx, (_x, kind) => kind === "visit")!.hours).toBeCloseTo(ACQUIRE.visitHours + 6 / 12);
  const dying = { ...sure, deaths: 1, leaderDeaths: 1 };
  const [camp, visit] = ways(tab(30, "paw"), reaver, ctx, dying);
  expect(visit.cost).toBeCloseTo(ACQUIRE.visitHours + 6 * deathHours(tab(30, "paw"), dying, { X1: 1 }));
  expect(camp.cost - camp.zoneRate * camp.hours).toBeCloseTo(6 * deathHours(tab(30, "paw"), dying, { X1: 1 }));
});

test("each fight of a chain pays the deaths of its own enemy", () => {
  // Five reavers that kill nobody, then the named, whose fight costs a leader's death.
  const reaver = {
    npc: "a black reaver",
    zone: "citymist",
    npcLevel: 54,
    npcHp: 11000,
    spawn: 1,
    points: 1,
    also: ["Lord Rak`Ashiir"],
    fights: [{ npc: "a black reaver", level: 50, hp: 9980, kills: 5 }, { npc: "Lord Rak`Ashiir", level: 54, hp: 11000, kills: 1 }],
    items: [{ ...item(5000, 2, 1), kills: 6 }],
  };
  const dying = { ...sure, deaths: 1, leaderDeaths: 1 };
  const killChance = (_t: object, x: { npcLevel: number }) => (x.npcLevel >= 54 ? dying : sure);
  const [camp, visit] = ways(tab(30, "paw"), reaver, { hoursPerLevel: { X1: 1 }, killChance, killsPerHour: { G1: 12 } }, dying);
  const one = deathHours(tab(30, "paw"), dying, { X1: 1 });
  expect(visit.cost).toBeCloseTo(ACQUIRE.visitHours + one);
  expect(camp.cost - camp.hours).toBeCloseTo(one);
});
