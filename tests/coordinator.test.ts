// Checks the coordinator's policy (tools/lib/coordinator.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { assignZones, chainSummary, decide, doneItems, experimentSettings, piecesNeeded, progressItems, refusedGoods, settleHistory } from "../tools/lib/coordinator.mjs";
import { ACQUIRE } from "../tools/lib/acquire.mjs";

const NOW = 1_800_000_000_000;
const team = (prefix: string, level: number) => Array.from({ length: 6 }, (_, k) => ({ name: `${prefix}${k}`, level }));
const tab = (label: string, group: string, level: number, extra = {}) => ({ label, group, members: team(label, level), task: null, gameHour: 12, ...extra });
const page = { id: "p3", group: "G1", zone: "gukbottom", keep: "ghoul", item: "Page 3", retryMin: 30 };

test("one leader of 46 or more rolls the casino for the account at the time the last roll named, the one that rolled longest ago", () => {
  const tabs = [tab("A", "G2", 40), tab("B", "G1", 52), tab("C", "G3", 47)];
  const rolls = (now: number, history: object[]) => decide({ now, tabs, history }).actions.filter((a) => a.kind === "casino").map((a) => a.label);
  expect(rolls(NOW, [])).toEqual(["B"]);
  // Nobody rolls before the potion's cooldown ends, and then the leader that has not rolled yet does.
  const won = { t: NOW - 3600000, label: "B", kind: "casino", id: "casino", status: "done", nextAt: NOW + 60000 };
  expect(rolls(NOW, [won])).toEqual([]);
  expect(rolls(NOW + 60000, [won])).toEqual(["C"]);
  const next = { t: NOW + 60000, label: "C", kind: "casino", id: "casino", status: "done", nextAt: NOW + 120000 };
  expect(rolls(NOW + 120000, [won, next])).toEqual(["B"]);
});

test("stones go to the lowest free group only once there are two a member", () => {
  const tabs = [tab("A", "G1", 40), tab("B", "G10", 8), tab("C", "G7", 9)];
  expect(decide({ now: NOW, tabs, stock: { "Greater Lightstone": 6, Lightstone: 5 } }).actions).toEqual([]);
  const [a] = decide({ now: NOW, tabs, stock: { "Greater Lightstone": 6, Lightstone: 6 } }).actions;
  expect(a.label).toBe("B");
  expect(a.kind).toBe("handIn");
  expect(a.spec.members.map((m: { counts: Record<string, number> }) => m.counts)).toEqual(Array(6).fill({ "Greater Lightstone": 1, Lightstone: 1 }));
  // A running task, or a hand-in that failed in the last half hour, passes the stones to the next lowest group.
  const busy = [tab("A", "G1", 40), tab("B", "G10", 8, { task: { kind: "hunt", status: "running" } }), tab("C", "G7", 9)];
  expect(decide({ now: NOW, tabs: busy, stock: { "Greater Lightstone": 12 } }).actions[0].label).toBe("C");
  expect(decide({ now: NOW, tabs, stock: { "Greater Lightstone": 12 }, history: [{ t: NOW - 60000, label: "B", kind: "handIn", status: "failed" }] }).actions[0].label).toBe("C");
  // A task that just ended does not hold its tab: the next one starts at once.
  expect(decide({ now: NOW, tabs, stock: { "Greater Lightstone": 12 }, history: [{ t: NOW - 60000, label: "B", kind: "quest", id: "q", status: "done" }] }).actions[0].label).toBe("B");
});

test("a task past 90 minutes is stopped, and a shorter one runs on", () => {
  const task = (min: number) => ({ task: { kind: "quest", status: "running", step: "wait for Tykar Renlin", startedAt: NOW - min * 60000 } });
  expect(decide({ now: NOW, tabs: [tab("A", "G1", 40, task(91))] }).actions).toEqual([{ label: "A", kind: "stopTask", id: null, spec: null, why: 'quest task running for 91 min at "wait for Tykar Renlin"' }]);
  expect(decide({ now: NOW, tabs: [tab("A", "G1", 40, task(80))] }).actions).toEqual([]);
});

test("a quest piece is needed once for each member of the chain's class and level who has not done it", () => {
  const quests = { "warrior-epic-fiery": { class: "Warrior", minLevel: 10 } };
  const members = [
    { name: "Tank", class: "Warrior", level: 22 },
    { name: "Done", class: "Warrior", level: 45 },
    { name: "Young", class: "Warrior", level: 8 },
    { name: "Healer", class: "Cleric", level: 22 },
  ];
  const heart = { id: "war-heart", item: "Heart of Frost", quest: "warrior-epic-fiery" };
  expect(piecesNeeded(heart, { quests, holders: { "warrior-epic-fiery": ["Done"] }, members })).toBe(1);
  expect(piecesNeeded(heart, { quests, holders: { "warrior-epic-fiery": ["Done", "Tank"] }, members })).toBe(0);
  // Without a quest the fixed count holds.
  expect(piecesNeeded({ id: "x", item: "Ring", count: 3 }, { quests, members })).toBe(3);
});

test("a chain that needs a piece runs for as many members as there are free copies, and its pulls avoid the other needers", () => {
  const quests = { "warrior-epic-fiery": { class: "Warrior", minLevel: 10, needs: ["Heart of Frost"], steps: [{ zone: "eastkarana", npc: "Tenal Redblade", give: ["Heart of Frost"] }] } };
  const war = (label: string, name: string) => tab(label, label, 22, { members: [{ name, class: "Warrior", level: 22 }] });
  const tabs = [war("A", "Tank"), war("B", "Brute")];
  const out = decide({ now: NOW, tabs, quests, have: { "Heart of Frost": 1 } }).actions;
  expect(out).toMatchObject([{ label: "A", kind: "quest", spec: { members: ["Tank"], avoid: ["Brute"] } }]);
  // A needer that carries its own copy runs like one part way through.
  expect(decide({ now: NOW, tabs, quests, have: { "Heart of Frost": 0 }, started: { "warrior-epic-fiery": ["Brute"] } }).actions).toMatchObject([{ label: "B", spec: { members: ["Brute"], avoid: ["Tank"] } }]);
});

test("a quest that said when to come back waits until then instead of its retry interval", () => {
  const quests = { "paladin-epic-note": { class: "Paladin", minLevel: 15, steps: [{ zone: "freporte", npc: "Tykar Renlin", give: ["Drom's Champagne"], waitMin: 45 }] } };
  const tabs = [tab("A", "G2", 20, { members: [{ name: "Pal", class: "Paladin", level: 20 }] })];
  const history = (nextAt: number) => [{ t: NOW - 180 * 60000, label: "A", kind: "quest", id: "paladin-epic-note", nextAt }];
  expect(decide({ now: NOW, tabs, quests, history: history(NOW + 3 * 3600000) }).actions).toEqual([]);
  expect(decide({ now: NOW, tabs, quests, history: history(NOW - 60000) }).actions).toMatchObject([{ kind: "quest", id: "paladin-epic-note" }]);
});

test("a failure under older code is retried at once after a deploy, and only once", () => {
  const quests = { "paladin-epic-note": { class: "Paladin", minLevel: 15, retryMin: 120, steps: [{ zone: "freportw", npc: "a prisoner" }] } };
  const tabs = [tab("A", "G2", 20, { members: [{ name: "Pal", class: "Paladin", level: 20 }] })];
  const failed = (code: string) => [{ t: NOW - 40 * 60000, label: "A", kind: "quest", id: "paladin-epic-note", status: "failed", code }];
  expect(decide({ now: NOW, tabs, quests, history: failed("old"), code: "new" }).actions).toMatchObject([{ kind: "quest", id: "paladin-epic-note" }]);
  // Failed under the code that runs now, it waits its retry interval.
  expect(decide({ now: NOW, tabs, quests, history: failed("new"), code: "new" }).actions).toEqual([]);
  // A run that ended well comes back after its interval, whatever the code.
  expect(decide({ now: NOW, tabs, quests, history: [{ ...failed("old")[0], status: "done" }], code: "new" }).actions).toEqual([]);
  // A failure that repeated the run before it at the same step waits, whatever deploys came since:
  // five runs of one quest in 42 minutes followed five deploys.
  expect(decide({ now: NOW, tabs, quests, history: [{ ...failed("older")[0], t: NOW - 60 * 60000, step: "talk" }, { ...failed("old")[0], step: "talk", repeat: true }], code: "new" }).actions).toEqual([]);
});

test("a run waiting for the world holds every group until its time, also after a deploy, and a failure with a time only under its own code", () => {
  const quests = { "paladin-epic-note": { class: "Paladin", minLevel: 1, reward: "Note", steps: [] } };
  const pal = (label: string, group: string) => ({ ...tab(label, group, 40), members: [{ name: `${label}0`, level: 40, class: "Paladin" }] });
  const tabs = [pal("A", "G1"), pal("B", "G2")];
  const run = (status: string, code: string) => [{ t: NOW - 10 * 60000, label: "A", kind: "quest", id: "paladin-epic-note", status, code, nextAt: NOW + 3600000 }];
  // A spawn point that rolls at a known time holds both groups, whatever code runs, and when the
  // hold ends one group looks at a time, since both would reach the point at once.
  expect(decide({ now: NOW, tabs, quests, history: run("waiting", "old"), code: "new" }).actions).toEqual([]);
  expect(decide({ now: NOW + 3700000, tabs, quests, history: run("waiting", "old"), code: "new" }).actions).toMatchObject([{ label: "A" }]);
  const looking = [...run("waiting", "old"), { t: NOW + 3700000, label: "A", kind: "quest", id: "paladin-epic-note", task: "q2" }];
  const runningA = [{ ...pal("A", "G1"), task: { id: "q2", kind: "quest", status: "running" } }, pal("B", "G2")];
  expect(decide({ now: NOW + 3800000, tabs: runningA, quests, history: looking, code: "new" }).actions).toEqual([]);
  // Once that run has ended, the other group comes.
  expect(decide({ now: NOW + 3900000, tabs, quests, history: [...looking.slice(0, 1), { ...looking[1], status: "done" }], code: "new" }).actions).toMatchObject([{ label: "B" }]);
  // An occupant the group could not clear holds both groups under the code that judged it.
  expect(decide({ now: NOW, tabs, quests, history: run("failed", "new"), code: "new" }).actions).toEqual([]);
  // A deploy may have fixed that judgment, so both groups try again at once.
  expect(decide({ now: NOW, tabs, quests, history: run("failed", "old"), code: "new" }).actions).toHaveLength(2);
});

test("a chain whose reward a later chain takes stays done", () => {
  const quests = {
    note: { class: "Paladin", reward: "Sealed Note", doneIf: ["SoulFire"], needs: ["Fire Beetle Eye"], steps: [{ zone: "freportw", craft: { inputs: ["Fire Beetle Eye"] }, expect: "Edible Goo" }] },
    hayle: { class: "Paladin", reward: "Note", needs: ["Sealed Note"], steps: [{ zone: "freportw", npc: "Brother Hayle", give: ["Sealed Note"], expect: "Note" }] },
    later: { class: "Paladin", reward: "Badge", needs: ["Note"], steps: [{ zone: "x", give: ["Note"], expect: "Badge" }] },
  };
  // Spent on hayle, then on the chain after it: either reward shows the note chain is done.
  expect(doneItems("note", quests).sort()).toEqual(["Badge", "Note", "Sealed Note", "SoulFire"]);
});

// One item for X1, a level 30 character an hour from its next level, one copy an hour of hunting:
// a gain of g tenths of a percent of its group's XP rate adds g/1000 x 10 hours of that group's progress.
// The kill chance these scenarios assume: a group kills what stands up to three levels above its leader.
const byLevel = (t: { members: { level: number }[] }, x: { npcLevel: number }) => ({ p: x.npcLevel <= t.members[0].level + 3 ? 1 : 0, fights: 4, deaths: 0, leaderDeaths: 0 });
const target = (npc: string, zone: string, gain: number, npcLevel = 30, slot = npc) => ({ npc, zone, npcLevel, spawn: 1, points: 1, items: [{ item: `${npc} drop`, to: "X1", slot, level: 30, gain, hours: 1, drop: 0.1 }] });
// A target that is seldom up, so a visit rarely finds it and a camp is its way outside the rotation.
const rare = (npc: string, zone: string, gain: number, slot = npc) => ({ ...target(npc, zone, gain, 30, slot), spawn: 0.1 });
const hoursPerLevel = { X1: 1 };
const place = (t: object, zone: string) => ({ ...t, zone, rotation: [zone] });

test("gear targets go to the pairs of group and target that earn most first, not tab by tab", () => {
  // G1 could camp the fiend at the camp's whole time or hunt the goo in its rotation (0.38). G2
  // hunts the fiend in its own rotation for free (0.75), so G2 takes the fiend and G1 the goo.
  const tabs = [place(tab("A", "G1", 30), "paw"), place(tab("B", "G2", 30), "unrest")];
  const targets = [target("a fiend", "unrest", 75), target("a goo", "paw", 38)];
  const { actions } = decide({ killChance: byLevel, now: NOW, tabs, targets, hoursPerLevel });
  expect(actions.map((a) => [a.label, a.kind, a.id])).toEqual([["B", "errand", "target-unrest-a-fiend"], ["A", "errand", "target-paw-a-goo"]]);
});

test("a zone's enemies go on one trip, and a second group follows only for what the trip leaves", () => {
  const tabs = [place(tab("A", "G1", 30), "paw"), place(tab("B", "G2", 30), "paw")];
  // Both drops would fill X1's waist, and hunting both makes the first copy come sooner, so one
  // camp hunts both and the other group has nothing left there.
  const same = decide({ killChance: byLevel, now: NOW, tabs, targets: [rare("a fiend", "unrest", 300, "waist"), rare("a ghoul", "unrest", 240, "waist")], hoursPerLevel });
  expect(same.actions).toMatchObject([{ label: "A", kind: "hunt", id: "target-unrest-a-fiend", ids: ["target-unrest-a-fiend", "target-unrest-a-ghoul"], spec: { zone: "unrest", keep: "a fiend|a ghoul", minutes: ACQUIRE.campMin } }]);
  expect(same.actions[0].spec).not.toHaveProperty("item");
  expect(same.targets["target-unrest-a-ghoul"]).toMatchObject({ state: "queued", plan: { group: "G1", enemies: 2 } });
  // Enemies that each take all ten kills an hour of a group fill one camp each. The second camp
  // costs its whole half hour, which the 39% chance of a copy worth 2.8 hours in it still pays for.
  const busy = (npc: string, gain: number) => ({ ...target(npc, "unrest", gain, 30, npc), points: 10, respawn: 3600 });
  const two = decide({ killChance: byLevel, now: NOW, tabs, targets: [busy("a fiend", 300), busy("a ghoul", 280)], hoursPerLevel, killsPerHour: { G1: 10, G2: 10 } });
  expect(two.actions.map((a) => [a.label, a.ids])).toEqual([["A", ["target-unrest-a-fiend"]], ["B", ["target-unrest-a-ghoul"]]]);
  expect(two.targets["target-unrest-a-ghoul"].plan.cost).toBeCloseTo(1);
});

test("the strongest group takes the zone where its targets add most, and the others hunt what they reach", () => {
  const strong = place(tab("A", "G1", 51), "velketor");
  const weak = place(tab("B", "G2", 40), "paw");
  const hate = (npc: string, level: number) => target(npc, "hateplane", 300, level, npc);
  const targets = [target("a broodling", "velketor", 125, 48), hate("an elite dragoon", 50), hate("an agent", 52), hate("a rat", 53), target("a goo", "paw", 38)];
  // The day's casino roll is done, which would otherwise take G1's leader of 51 first.
  const rolledToday = [{ t: NOW - 60000, label: "A", kind: "casino", id: "casino", nextAt: NOW + 86400000 }];
  const { actions } = decide({ killChance: byLevel, now: NOW, tabs: [strong, weak], targets, hoursPerLevel, history: rolledToday });
  // Three enemies of 3 hours each in the Plane of Hate earn G1 more than its errand on the broodling.
  expect(actions.map((a) => [a.label, a.ids])).toEqual([
    ["A", ["target-hateplane-an-elite-dragoon", "target-hateplane-an-agent", "target-hateplane-a-rat"]],
    ["B", ["target-paw-a-goo"]],
  ]);
});

test("a slot another hunt serves still takes a copy that comes sooner, for the hours until that one", () => {
  // G1's errand hunts a waist piece of 100 that takes 5 hours a copy, G2's own zone drops one of 50
  // in an hour: it is worn 4 hours, worth 0.05 x 4 = 0.2 hours.
  const slow = { ...target("a slow one", "velketor", 100, 30, "waist"), items: [{ item: "Belt", to: "X1", slot: "waist", level: 30, gain: 100, hours: 5, drop: 0.1 }] };
  const g1 = { ...place(tab("A", "G1", 30), "velketor"), errand: { zone: "velketor", keep: "a slow one" } };
  const g2 = place(tab("B", "G2", 30), "paw");
  const quick = target("a quick one", "paw", 50, 30, "waist");
  const sooner = decide({ killChance: byLevel, now: NOW, tabs: [g1, g2], targets: [slow, quick], hoursPerLevel });
  expect(sooner.actions).toMatchObject([{ label: "B", ids: ["target-paw-a-quick-one"] }]);
  expect(sooner.targets["target-paw-a-quick-one"].plan.value).toBeCloseTo(0.2);
  // A lesser copy that comes no sooner than the claimed one adds nothing.
  const later = decide({ killChance: byLevel, now: NOW, tabs: [g1, g2], targets: [{ ...slow, items: [{ ...slow.items[0], hours: 1 }] }, quick], hoursPerLevel });
  expect(later.actions).toEqual([]);
  expect(later.targets["target-paw-a-quick-one"]).toMatchObject({ state: "covered", by: ["a slow one"] });
});

test("a group an experiment holds still camps outside its rotation, but runs no errand", () => {
  const tabs = [place(tab("A", "G1", 30), "paw")];
  const held = new Set(["G1"]);
  expect(decide({ killChance: byLevel, now: NOW, tabs, targets: [target("a fiend", "unrest", 300)], hoursPerLevel, held }).actions).toMatchObject([{ label: "A", kind: "hunt" }]);
  expect(decide({ killChance: byLevel, now: NOW, tabs, targets: [target("a goo", "paw", 38)], hoursPerLevel, held }).actions).toEqual([]);
});

test("a target whose best group is busy goes to a free group that still gains, and otherwise waits", () => {
  const busy = { ...place(tab("B", "G2", 30), "unrest"), task: { kind: "quest", status: "running" } };
  const tabs = [place(tab("A", "G1", 30), "paw"), busy];
  // A copy worth 3 hours pays G1's camp of half an hour.
  const paid = decide({ killChance: byLevel, now: NOW, tabs, targets: [rare("a fiend", "unrest", 300)], hoursPerLevel });
  expect(paid.actions).toMatchObject([{ label: "A", kind: "hunt", spec: { zone: "unrest", minutes: 30, waitMin: 0 } }]);
  expect(paid.targets["target-unrest-a-fiend"]).toMatchObject({ state: "queued", plan: { group: "G1", kind: "camp" } });
  // A copy worth 0.75 hours costs G1 more than it adds, so the fiend waits for G2.
  const targets = [target("a fiend", "unrest", 75)];
  const unpaid = decide({ killChance: byLevel, now: NOW, tabs, targets, hoursPerLevel });
  expect(unpaid.actions).toEqual([]);
  expect(unpaid.targets["target-unrest-a-fiend"]).toMatchObject({ state: "busy", group: "G2", only: false, on: { kind: "quest" }, plan: { group: "G2", kind: "errand" } });
});

test("a target only one group reaches waits for that group by its reach, and a weaker free group leaves it", () => {
  const strong = { ...place(tab("A", "G1", 51), "velketor"), task: { kind: "hunt", status: "running" } };
  const weak = place(tab("B", "G2", 36), "paw");
  const { actions, targets } = decide({ killChance: byLevel, now: NOW, tabs: [strong, weak], targets: [target("a broodling", "velketor", 125, 48)], hoursPerLevel });
  expect(actions).toEqual([]);
  expect(targets["target-velketor-a-broodling"]).toMatchObject({ state: "busy", group: "G1", only: true, on: { kind: "hunt" } });
});

test("each gear target says why it is not hunted", () => {
  const tabs = [place(tab("A", "G1", 30), "paw")];
  const state = (targets: object[], extra = {}) => Object.values(decide({ killChance: byLevel, now: NOW, tabs, targets, hoursPerLevel, ...extra }).targets).map((e: { state: string }) => e.state);
  expect(Object.values(decide({ killChance: byLevel, now: NOW, tabs, targets: [target("a broodling", "velketor", 125, 34)], hoursPerLevel }).targets)).toMatchObject([{ state: "tooStrong", level: 34 }]);
  // Without a fight record or a simulated fight there is no kill chance yet, which is not "too strong".
  expect(Object.values(decide({ now: NOW, tabs, targets: [target("a broodling", "velketor", 125, 34)], hoursPerLevel }).targets)).toMatchObject([{ state: "untested", level: 34 }]);
  expect(state([target("a king", "soldunga", 75)], { crowded: new Set(["soldunga"]) })).toEqual(["crowded"]);
  // A camp worth 0.5 hours a copy against a whole hour of G1's XP does not pay.
  expect(state([target("a warder", "nurga", 50)])).toEqual(["notWorth"]);
  expect(state([target("a goo", "paw", 38)], { held: new Set(["G1"]) })).toEqual(["experiment"]);
  const last = [{ t: NOW - 30 * 60000, label: "A", kind: "errand", id: "target-paw-a-goo", nextAt: NOW + 60000 }];
  expect(Object.values(decide({ killChance: byLevel, now: NOW, tabs, targets: [target("a goo", "paw", 38)], hoursPerLevel, history: last }).targets)).toMatchObject([{ state: "retry", at: NOW + 60000 }]);
  // A group on the target's errand hunts it.
  const on = [{ ...tabs[0], errand: { zone: "paw", keep: "a goo" } }];
  expect(Object.values(decide({ killChance: byLevel, now: NOW, tabs: on, targets: [target("a goo", "paw", 38)], hoursPerLevel }).targets)).toMatchObject([{ state: "hunting", group: "G1" }]);
  // A camp marks only the target it was queued for, not every target in its zone.
  const camping = [{ ...tabs[0], zone: "unrest", task: { id: "k1", kind: "hunt", status: "running" } }];
  const queued = [{ t: NOW - 60000, label: "A", kind: "hunt", id: "target-unrest-a-fiend", task: "k1", nextAt: NOW + 3600000 }];
  const both = decide({ killChance: byLevel, now: NOW, tabs: camping, targets: [target("a fiend", "unrest", 75), target("a ghoul", "unrest", 60)], hoursPerLevel, history: queued }).targets;
  expect([both["target-unrest-a-fiend"].state, both["target-unrest-a-ghoul"].state === "hunting"]).toEqual(["hunting", false]);
  // Without its group's measured pace a copy's worth is unknown.
  expect(state([target("a goo", "paw", 38)], { hoursPerLevel: {} })).toEqual(["noPace"]);
  // A night spawn waits for the night, by the tab's game hour (12 here).
  expect(Object.values(decide({ killChance: byLevel, now: NOW, tabs, targets: [{ ...target("a dread wolf", "paw", 38), when: "night" }], hoursPerLevel }).targets)).toMatchObject([{ state: "time", when: "night" }]);
  expect(decide({ killChance: byLevel, now: NOW, tabs: [{ ...tabs[0], gameHour: 22 }], targets: [{ ...target("a dread wolf", "paw", 38), when: "night" }], hoursPerLevel }).actions).toMatchObject([{ kind: "errand" }]);
});

test("a rare spawn gets a short visit, and a camp clears the target's spawn points", () => {
  const tabs = [place(tab("A", "G1", 30), "paw")];
  // 2% on each of 6 points: up on arrival 11% of the time, so a 6-minute visit adds 0.114 x 1.26
  // hours against 0.1, where a camp of 1.39 hours a copy adds 1.26 against 1.39.
  const hangman = { ...target("Hangman", "trakanon", 126), spawn: 0.02, points: 6, items: [{ item: "Noose", to: "X1", level: 30, gain: 126, hours: 1.39, drop: 1 }] };
  expect(decide({ killChance: byLevel, now: NOW, tabs, targets: [hangman], hoursPerLevel }).actions).toEqual([expect.objectContaining({ kind: "hunt", spec: { zone: "trakanon", keep: "Hangman", item: "Noose", waitMin: 0, minutes: 6 } })]);
  const camp = decide({ killChance: byLevel, now: NOW, tabs, targets: [rare("a fiend", "unrest", 300)], hoursPerLevel, points: { "target-unrest-a-fiend": [11, 12] } });
  expect(camp.actions[0].spec.points).toEqual([11, 12]);
});

test("a piece is hunted by its group until owned, waits for its time of day and for its retry", () => {
  const tabs = [tab("A", "G1", 40)];
  expect(decide({ now: NOW, tabs, opportunities: [page] }).actions).toMatchObject([{ label: "A", kind: "hunt", id: "p3", spec: { zone: "gukbottom", waitMin: 0 } }]);
  expect(decide({ now: NOW, tabs, opportunities: [page], missing: { p3: 0 } }).actions).toEqual([]);
  expect(decide({ now: NOW, tabs, opportunities: [{ ...page, when: "night" }] }).actions).toEqual([]);
  expect(decide({ now: NOW, tabs: [tab("A", "G1", 40, { gameHour: 21 })], opportunities: [{ ...page, when: "night" }] }).actions).toHaveLength(1);
  const history = [{ t: NOW - 25 * 60000, label: "A", kind: "hunt", id: "p3", ms: 120000 }];
  expect(decide({ now: NOW, tabs, opportunities: [page], history }).actions).toEqual([]);
  expect(decide({ now: NOW + 6 * 60000, tabs, opportunities: [page], history }).actions).toHaveLength(1);
});

test("quest pieces go first, the one most characters still miss first, and gear hunts keep the file order", () => {
  const tabs = [tab("A", "G1", 40)];
  const gear = { id: "gear-belt", group: "G1", zone: "kurn", keep: "a skeleton", item: "Belt" };
  const head = { id: "nec-motte", group: "G1", zone: "freporte", keep: "Sir Edwin Motte", item: "Head", quest: "nec" };
  const ring = { id: "clr-gimblox", group: "G1", zone: "soldunga", keep: "Lord Gimblox", item: "Ring", quest: "clr" };
  expect(decide({ now: NOW, tabs, opportunities: [gear, ring, head], missing: { "nec-motte": 7, "clr-gimblox": 1 } }).actions[0].id).toBe("nec-motte");
  expect(decide({ now: NOW, tabs, opportunities: [gear, ring, head], missing: { "nec-motte": 0, "clr-gimblox": 1 } }).actions[0].id).toBe("clr-gimblox");
  expect(decide({ now: NOW, tabs, opportunities: [gear, ring, head], missing: { "nec-motte": 0, "clr-gimblox": 0 } }).actions[0].id).toBe("gear-belt");
});

test("a group whose leader carries the piece does not hunt it", () => {
  const tabs = [tab("A", "G1", 40)];
  expect(decide({ now: NOW, tabs, opportunities: [page], carriedBy: { p3: ["A0"] } }).actions).toEqual([]);
  // A copy another character carries leaves the hunt to the group.
  expect(decide({ now: NOW, tabs, opportunities: [page], carriedBy: { p3: ["A3"] } }).actions).toHaveLength(1);
});

test("a hunt that reported its next respawn comes back then, earlier or later than the retry interval", () => {
  const tabs = [tab("A", "G1", 40)];
  const hunted = (nextAt: number) => [{ t: NOW - 25 * 60000, label: "A", kind: "hunt", id: "p3", nextAt, ms: 120000 }];
  expect(decide({ now: NOW, tabs, opportunities: [page], history: hunted(NOW + 60000) }).actions).toEqual([]);
  // Five minutes after a hunt whose return time has passed, it runs again.
  const soon = [{ t: NOW - 5 * 60000, label: "A", kind: "hunt", id: "p3", nextAt: NOW - 1000, ms: 120000 }];
  expect(decide({ now: NOW, tabs, opportunities: [page], history: soon }).actions).toHaveLength(1);
  expect(decide({ now: NOW, tabs, opportunities: [{ ...page, points: [7] }], history: hunted(NOW - 1000) }).actions).toMatchObject([{ spec: { points: [7] } }]);
});

test("hunts stop for a tab once they took its share of the last hour", () => {
  const tabs = [tab("A", "G1", 40)];
  const ring = { ...page, id: "ring" };
  const busy = [6, 4].map((m) => ({ t: NOW - m * 60000, label: "A", kind: "hunt", id: "p3", nextAt: NOW + 3600000, ms: 4.5 * 60000 }));
  expect(decide({ now: NOW, tabs, opportunities: [ring], history: busy }).actions).toEqual([]);
  expect(decide({ now: NOW, tabs, opportunities: [ring], history: busy.slice(0, 1) }).actions).toHaveLength(1);
});

test("an errand opportunity queues an errand, and a tab on an errand gets no other task", () => {
  const pages = { id: "m1", group: "G2", kind: "errand", zone: "najena", keep: "magician", item: "Page" };
  expect(decide({ now: NOW, tabs: [tab("B", "G2", 17)], opportunities: [pages] }).actions).toMatchObject([{ kind: "errand", spec: { zone: "najena", keep: "magician", minutes: 60 } }]);
  const busy = [tab("B", "G2", 17, { errand: { zone: "nektulos" } }), tab("C", "G7", 20)];
  expect(decide({ now: NOW, tabs: busy, opportunities: [pages], stock: { "Greater Lightstone": 12 } }).actions).toMatchObject([{ label: "C", kind: "handIn" }]);
});

test("a farm keeps at most maxGroups groups, the lowest in its levels, and fills free places", () => {
  const wisps = { id: "wisp", zone: "nektulos", keep: "wisp", levels: [10, 15], maxGroups: 2, minutes: 120 };
  const farming = { zone: "nektulos", keep: "wisp" };
  const tabs = [tab("A", "G3", 13, { errand: farming }), tab("B", "G6", 11, { errand: farming }), tab("C", "G8", 12, { errand: farming }), tab("D", "G1", 41)];
  // Three on the farm: the highest stops, and nobody joins.
  expect(decide({ now: NOW, tabs, farms: [wisps] }).actions.map((a) => [a.label, a.kind])).toEqual([["A", "stopErrand"]]);
  // One on the farm, one free group in its levels: that group joins, the level 41 group does not.
  const one = [tab("A", "G3", 13), tab("B", "G6", 11, { errand: farming }), tab("D", "G1", 41), tab("E", "G9", 16)];
  expect(decide({ now: NOW, tabs: one, farms: [wisps] }).actions).toMatchObject([{ label: "A", kind: "errand", spec: { zone: "nektulos", keep: "wisp", minutes: 120 } }]);
  // A farming group that outgrew the levels stops.
  expect(decide({ now: NOW, tabs: [tab("E", "G9", 16, { errand: farming })], farms: [wisps] }).actions).toMatchObject([{ label: "E", kind: "stopErrand" }]);
});

test("an opportunity with levels goes to a free group inside them, one already in the zone first", () => {
  const pages = { id: "m1", levels: [11, 21], kind: "errand", zone: "najena", keep: "magician", item: "Page" };
  const tabs = [tab("A", "G1", 41), tab("B", "G5", 12), tab("C", "G2", 18, { zone: "najena" }), tab("D", "G9", 13)];
  expect(decide({ now: NOW, tabs, opportunities: [pages] }).actions).toMatchObject([{ label: "C", kind: "errand", why: "Page for G2" }]);
  const elsewhere = tabs.map((t) => ({ ...t, zone: "warrens" }));
  expect(decide({ now: NOW, tabs: elsewhere, opportunities: [pages] }).actions).toMatchObject([{ label: "B" }]);
});

test("errands for pieces from the same enemies go to one group", () => {
  const page = (id: string) => ({ id, levels: [11, 21], kind: "errand", zone: "najena", keep: "magician", item: id });
  const tabs = [tab("B", "G5", 12), tab("D", "G9", 13)];
  expect(decide({ now: NOW, tabs, opportunities: [page("p1"), page("p2")] }).actions).toHaveLength(1);
  const busy = [tab("B", "G5", 12, { errand: { zone: "najena", keep: "magician" } }), tab("D", "G9", 13)];
  expect(decide({ now: NOW, tabs: busy, opportunities: [page("p1")] }).actions).toEqual([]);
});

test("a quest chain runs for the members of its class who lack the reward", () => {
  const quests = { w1: { class: "Warrior", minLevel: 10, reward: "Totem", steps: [{ zone: "freporte", npc: "Kargek" }] } };
  const war = (label: string, group: string, level: number, name: string) => ({ ...tab(label, group, level), members: [{ name, level, class: "Warrior" }, { name: `${label}c`, level, class: "Cleric" }] });
  const tabs = [war("A", "G1", 41, "Tagu"), war("B", "G4", 12, "Thal"), war("C", "G6", 8, "Low")];
  expect(decide({ now: NOW, tabs, quests, holders: { w1: ["Tagu"] } }).actions).toMatchObject([{ label: "B", kind: "quest", spec: { members: ["Thal"] } }]);
  expect(decide({ now: NOW, tabs, quests, holders: { w1: ["Tagu"] }, history: [{ t: NOW - 60 * 60000, label: "B", kind: "quest", id: "w1" }] }).actions).toEqual([]);
});

test("gear moves go to the free tab with the lowest levels", () => {
  const tabs = [tab("A", "G1", 41), tab("B", "G5", 12, { task: { kind: "hunt", status: "running" } }), tab("C", "G9", 13)];
  const moves = [{ item: "Cloak", from: "X", to: "Y", slot: "back" }];
  expect(decide({ now: NOW, tabs, gear: { moves } }).actions).toMatchObject([{ label: "C", kind: "gear", spec: { moves } }]);
  expect(decide({ now: NOW, tabs, gear: { moves: [] } }).actions).toEqual([]);
  // The plan's moves take the only free tab before a target hunt that would pay.
  const one = [place(tab("A", "G1", 30), "paw")];
  expect(decide({ killChance: byLevel, now: NOW, tabs: one, gear: { moves }, targets: [target("a goo", "paw", 38)], hoursPerLevel }).actions).toMatchObject([{ label: "A", kind: "gear" }]);
});

test("a gear task goes to a leader that can take every lore item it moves, and a move no free leader can take waits", () => {
  const tabs = [tab("A", "G1", 41), tab("C", "G9", 13)];
  const cloak = { item: "Cloak", from: "X", to: "Y", slot: "back" };
  // C's leader carries a lore Ring already, so the task goes to A despite C's lower levels.
  const ring = { item: "Ring", from: "Z", to: "Y", slot: "finger", loreHolders: ["C0"] };
  expect(decide({ now: NOW, tabs, gear: { moves: [cloak, ring] } }).actions).toMatchObject([{ label: "A", kind: "gear", spec: { moves: [cloak, ring] } }]);
  // A ring both leaders carry waits, and the cloak goes with the lowest group.
  const both = { ...ring, loreHolders: ["A0", "C0"] };
  expect(decide({ now: NOW, tabs, gear: { moves: [cloak, both] } }).actions).toMatchObject([{ label: "C", kind: "gear", spec: { moves: [cloak] } }]);
});


test("a quest chain takes a tab before a camp would", () => {
  const quests = { b1: { class: "Bard", minLevel: 20, reward: "Page", steps: [{ zone: "qey2hh1", npc: "Konia" }] } };
  const tabs = [{ ...tab("A", "G1", 40), members: [{ name: "Ugfeu", level: 40, class: "Bard" }] }];
  expect(decide({ now: NOW, tabs, quests, opportunities: [page] }).actions).toMatchObject([{ label: "A", kind: "quest" }]);
});

test("an experiment gives arm A the setting and arm B the other in the first block, swaps, then ends on the other", () => {
  const x = { id: "con", a: ["G4"], b: ["G5"], blockMin: 90, setting: { limits: { minCon: 10 } }, without: { limits: { minCon: 4 } } };
  const first = experimentSettings({ now: NOW, experiments: [x] });
  expect(first.events).toEqual([{ id: "con", kind: "start", start: NOW }]);
  expect(first.settings).toEqual({ G4: x.setting, G5: x.without });
  expect([...first.held]).toEqual(["G4", "G5"]);
  const second = experimentSettings({ now: NOW + 100 * 60000, experiments: [x], started: { con: NOW } });
  expect([second.settings, second.events]).toEqual([{ G4: x.without, G5: x.setting }, []]);
  const after = experimentSettings({ now: NOW + 181 * 60000, experiments: [x], started: { con: NOW } });
  expect([after.settings, after.events, after.held.size]).toEqual([{ G4: x.without, G5: x.without }, [{ id: "con", kind: "end", start: NOW }], 0]);
  expect(experimentSettings({ now: NOW + 200 * 60000, experiments: [x], started: { con: NOW }, ended: { con: NOW } }).events).toEqual([]);
  // With four blocks the arms swap every block and the experiment ends after the fourth.
  const four = { ...x, blocks: 4, blockMin: 20 };
  const at = (min: number) => experimentSettings({ now: NOW + min * 60000, experiments: [four], started: { con: NOW } });
  expect([at(45).settings, at(65).settings]).toEqual([{ G4: x.setting, G5: x.without }, { G4: x.without, G5: x.setting }]);
  expect(at(81).events).toEqual([{ id: "con", kind: "end", start: NOW }]);
  // A held group's errand stops, whatever it hunts for.
  expect(decide({ now: NOW, tabs: [tab("A", "G4", 12, { errand: { zone: "najena", keep: "magician" } })], held: new Set(["G4"]) }).actions).toMatchObject([{ kind: "stopErrand" }]);
  // A held group gets no new errand, also one that names it, such as a wanted target.
  const drop = { id: "target-kurn-a-skeleton", group: "G4", kind: "errand", zone: "kurn", keep: "a skeleton", item: "Fine Cloak", count: 1 };
  expect(decide({ now: NOW, tabs: [tab("A", "G4", 12)], opportunities: [drop], held: new Set(["G4"]) }).actions).toEqual([]);
  expect(decide({ now: NOW, tabs: [tab("A", "G4", 12)], opportunities: [drop] }).actions).toMatchObject([{ kind: "errand" }]);
  // A farm skips a held group and stops it when it farms.
  const farm = { id: "w", zone: "nektulos", keep: "wisp", levels: [10, 15], maxGroups: 2, minutes: 120 };
  expect(decide({ now: NOW, tabs: [tab("A", "G4", 12, { errand: { zone: "nektulos", keep: "wisp" } })], farms: [farm], held: new Set(["G4"]) }).actions).toMatchObject([{ kind: "stopErrand" }]);
});

test("an experiment that leaves the file before its end returns its groups to the other setting once", () => {
  const x = { id: "con", a: ["G4"], b: ["G5"], blockMin: 90, setting: { limits: { minCon: 10 } }, without: { limits: { minCon: 4 } } };
  const running = { con: { a: x.a, b: x.b, without: x.without } };
  expect(experimentSettings({ now: NOW + 100 * 60000, experiments: [x], started: { con: NOW }, running }).events).toEqual([]);
  const dropped = experimentSettings({ now: NOW + 100 * 60000, experiments: [], started: { con: NOW }, running });
  expect([dropped.settings, dropped.events, dropped.held.size]).toEqual([{ G4: x.without, G5: x.without }, [{ id: "con", kind: "dropped", start: NOW }], 0]);
  expect(experimentSettings({ now: NOW + 101 * 60000, experiments: [], started: { con: NOW }, ended: { con: NOW + 100 * 60000 }, running }).events).toEqual([]);
});

test("an experiment queued after another starts once that one has ended", () => {
  const first = { id: "floor", a: ["G4"], b: ["G5"], blockMin: 90, setting: { limits: { minCon: 10 } }, without: { limits: { minCon: 4 } } };
  const next = { id: "dots", after: "floor", a: ["G4"], b: ["G5"], blockMin: 90, setting: { dotMaxTicks: 9 }, without: { dotMaxTicks: 0 } };
  // While the first runs, the queued one neither starts nor sets anything.
  const during = experimentSettings({ now: NOW + 60 * 60000, experiments: [first, next], started: { floor: NOW } });
  expect(during.events).toEqual([]);
  expect(during.settings).toEqual({ G4: first.setting, G5: first.without });
  // Once the end is reported, it starts and its arms add their setting to the first one's `without`.
  const later = experimentSettings({ now: NOW + 185 * 60000, experiments: [first, next], started: { floor: NOW }, ended: { floor: NOW + 181 * 60000 } });
  expect(later.events).toEqual([{ id: "dots", kind: "start", start: NOW + 185 * 60000 }]);
  expect(later.settings).toEqual({ G4: { ...first.without, ...next.setting }, G5: { ...first.without, ...next.without } });
});

test("stones reach the lowest group also while it farms", () => {
  const farm = { id: "w", zone: "nektulos", keep: "wisp", levels: [10, 15], maxGroups: 2, minutes: 120 };
  const tabs = [tab("A", "G6", 12, { errand: { zone: "nektulos", keep: "wisp" } }), tab("B", "G9", 15)];
  expect(decide({ now: NOW, tabs, farms: [farm], stock: { "Greater Lightstone": 12 } }).actions.find((a) => a.kind === "handIn")?.label).toBe("A");
});

test("a quest that needs a dropped item runs for as many members as the account holds copies", () => {
  const quests = { n1: { class: "Necromancer", reward: "Symbol", needs: ["Head"], steps: [{ zone: "lakerathe", npc: "Kazen" }] } };
  const necro = (label: string, group: string, names: string[]) => ({ ...tab(label, group, 14), members: names.map((name) => ({ name, level: 14, class: "Necromancer" })) });
  const tabs = [necro("A", "G4", ["N1", "N2"]), necro("B", "G5", ["N3"])];
  expect(decide({ now: NOW, tabs, quests, have: { Head: 0 } }).actions).toEqual([]);
  expect(decide({ now: NOW, tabs, quests, have: { Head: 1 } }).actions).toMatchObject([{ label: "A", spec: { members: ["N1"] } }]);
  expect(decide({ now: NOW, tabs, quests, have: { Head: 3 } }).actions.map((a) => a.spec.members)).toEqual([["N1", "N2"], ["N3"]]);
});

test("a member part way through a quest runs it without a copy of what it needs", () => {
  const quests = { n1: { class: "Necromancer", reward: "Symbol", needs: ["Head"], steps: [{ zone: "lakerathe", npc: "Kazen" }] } };
  const tabs = [{ ...tab("A", "G4", 14), members: ["N1", "N2"].map((name) => ({ name, level: 14, class: "Necromancer" })) }];
  expect(decide({ now: NOW, tabs, quests, have: { Head: 0 }, started: { n1: ["N2"] } }).actions).toMatchObject([{ spec: { members: ["N2"] } }]);
  expect(decide({ now: NOW, tabs, quests, have: { Head: 1 }, started: { n1: ["N2"] } }).actions).toMatchObject([{ spec: { members: ["N2", "N1"] } }]);
});

const ROWS = [[14, ["warrens", "kurn", "runnyeye", "najena", "guktop"]]];
const measured = (xph: Record<string, number>) => Object.fromEntries(Object.entries(xph).map(([z, v]) => [z, { 15: { s: 3600, xp: v, t: NOW } }]));
const RATES = measured({ kurn: 800000, runnyeye: 600000, warrens: 580000, najena: 420000 });

test("a group moves to the best zone only once it is worth the margin more than its own", () => {
  // Kurn is 38% better than Warrens, so Warrens leaves the rotation, and the unmeasured Upper Guk
  // ranks as the median measured zone, after Runnyeye by row order.
  expect(assignZones({ now: NOW, tabs: [tab("A", "G3", 15, { zone: "warrens" })], rows: ROWS, rates: RATES })).toMatchObject([{ label: "A", rotation: ["kurn", "runnyeye", "guktop"] }]);
  // Kurn 13% better than Runnyeye keeps the group where it is.
  const close = measured({ kurn: 680000, runnyeye: 600000, warrens: 580000, najena: 420000 });
  const [a] = assignZones({ now: NOW, tabs: [tab("A", "G3", 15, { zone: "runnyeye" })], rows: ROWS, rates: close });
  expect(a.rotation).toContain("runnyeye");
  // A rotation with the right zones is not set again, whatever their order.
  expect(assignZones({ now: NOW, tabs: [tab("A", "G3", 15, { zone: "runnyeye", rotation: [...a.rotation].reverse() })], rows: ROWS, rates: close })).toEqual([]);
});

// A small zone's supply, which the groups in it share evenly.
const shared = (_zone: string, _level: number, n: number) => 1 / (1 + n);

test("the lowest group takes the best zone first, and the next counts it as crowded", () => {
  const tabs = [tab("B", "G4", 16, { zone: "najena" }), tab("A", "G3", 15, { zone: "warrens" })];
  const out = assignZones({ now: NOW, tabs, rows: ROWS, rates: RATES, crowdFactor: shared });
  expect(out.find((z) => z.label === "A")!.rotation[0]).toBe("kurn");
  expect(out.find((z) => z.label === "B")!.rotation[0]).toBe("runnyeye");
});

test("a group goes where it adds most to the account, counting what it takes from the groups there", () => {
  // Kurn's Tower pays 800k alone and 80% of that to each of two groups. Beside the busy group there
  // a second one would earn 640k for itself, more than Runnyeye's 600k, but the pair earns 1,280k
  // instead of 800k, 480k more, so the group goes to Runnyeye.
  const curve = (zone: string, _level: number, n: number) => (zone === "kurn" ? [1, 0.8, 0.55][n] : 1 / (1 + n));
  const tabs = [tab("H", "G5", 14, { zone: "kurn", task: { status: "running" } }), tab("A", "G3", 15, { zone: "warrens" })];
  expect(assignZones({ now: NOW, tabs, rows: ROWS, rates: RATES, crowdFactor: curve })[0].rotation[0]).toBe("runnyeye");
});

test("a group within two levels of the next band row also ranks that row's zones", () => {
  const rows = [[14, ["warrens", "kurn"]], [18, ["befallen"]]];
  const rates = measured({ befallen: 900000, kurn: 800000, warrens: 580000 });
  // At 15 the next row is three levels away, so the group keeps to its own row.
  expect(assignZones({ now: NOW, tabs: [tab("A", "G3", 15, { zone: "warrens" })], rows, rates })[0].rotation).not.toContain("befallen");
  // At 16 it is two away, and Befallen pays most.
  expect(assignZones({ now: NOW, tabs: [tab("A", "G3", 16, { zone: "warrens" })], rows, rates })[0].rotation[0]).toBe("befallen");
});

test("an unmeasured zone ranks where the model puts it against the measured zones", () => {
  const rows = [[14, ["kurn", "runnyeye", "guktop"]]];
  const rates = measured({ kurn: 800000, runnyeye: 600000 });
  const rotation = (model?: (z: string) => number) => assignZones({ now: NOW, tabs: [tab("A", "G3", 15, { zone: "warrens" })], rows, rates, model })[0].rotation;
  // Without a model the unmeasured Upper Guk ranks as the median measured zone, ahead of Runnyeye.
  expect(rotation()).toEqual(["kurn", "guktop", "runnyeye"]);
  // The model puts it at half of Runnyeye, and the measured zones pay what the model says.
  expect(rotation((z) => ({ kurn: 800000, runnyeye: 600000, guktop: 300000 })[z]!)).toEqual(["kurn", "runnyeye", "guktop"]);
  // The measured zones pay twice the model, so its 350k for Upper Guk counts as 700k.
  expect(rotation((z) => ({ kurn: 400000, runnyeye: 300000, guktop: 350000 })[z]!)).toEqual(["kurn", "guktop", "runnyeye"]);
});

test("zones found crowded lately drop out of the rotation, and the report ages out", () => {
  // Kurn was crowded ten minutes ago in another group's tab, so the group starts in Runnyeye.
  const other = tab("Z", "G9", 40, { zone: "kurn", crowdedAt: { kurn: NOW - 10 * 60000 } });
  const [a] = assignZones({ now: NOW, tabs: [tab("A", "G3", 15, { zone: "warrens" }), other], rows: ROWS, rates: RATES });
  expect(a.rotation[0]).toBe("runnyeye");
  // After 45 minutes the report no longer counts.
  const [b] = assignZones({ now: NOW + 40 * 60000, tabs: [tab("A", "G3", 15, { zone: "warrens" }), other], rows: ROWS, rates: RATES });
  expect(b.rotation[0]).toBe("kurn");
});

test("a rotation of the whole row, or one with a crowded zone, is trimmed to the best zones", () => {
  const close = measured({ kurn: 680000, runnyeye: 600000, warrens: 580000, najena: 420000 });
  // restoreGroup gives the whole row, which the bot would walk through in row order.
  const whole = tab("A", "G3", 15, { zone: "runnyeye", rotation: ROWS[0][1] });
  expect(assignZones({ now: NOW, tabs: [whole], rows: ROWS, rates: close })[0].rotation).toHaveLength(3);
  // A three-zone rotation that holds a zone crowded ten minutes ago is ranked again without it.
  const crowded = tab("A", "G3", 15, { zone: "runnyeye", rotation: ["runnyeye", "kurn", "warrens"], crowdedAt: { kurn: NOW - 10 * 60000 } });
  expect(assignZones({ now: NOW, tabs: [crowded], rows: ROWS, rates: close })[0].rotation).not.toContain("kurn");
});

test("busy groups keep their rotation and count for the zone they are in", () => {
  const tabs = [tab("A", "G3", 14, { zone: "kurn", errand: { zone: "kurn" } }), tab("H", "G5", 14, { zone: "runnyeye", task: { status: "running" } }), tab("B", "G4", 15, { zone: "najena" })];
  const out = assignZones({ now: NOW, tabs, rows: ROWS, rates: RATES, crowdFactor: shared });
  expect(out.map((z) => z.label)).toEqual(["B"]);
  // Kurn and Runnyeye each hold a group, so Upper Guk and Warrens rank first.
  expect(out[0].rotation.slice(0, 2)).toEqual(["guktop", "warrens"]);
});

test("a group that stays keeps its rotation, and one that should move gets a new one", () => {
  // Runnyeye is within the margin of Kurn's Tower, so the group there keeps its rotation, whatever
  // the other zones rank.
  const close = measured({ kurn: 680000, runnyeye: 600000, warrens: 580000, najena: 420000 });
  const stays = tab("A", "G3", 15, { zone: "runnyeye", rotation: ["runnyeye", "najena", "warrens"] });
  expect(assignZones({ now: NOW, tabs: [stays], rows: ROWS, rates: close })).toEqual([]);
  // A zone that left the band row, or a group that should move, gets a new rotation.
  const old = tab("A", "G3", 15, { zone: "runnyeye", rotation: ["runnyeye", "befallen"] });
  expect(assignZones({ now: NOW, tabs: [old], rows: ROWS, rates: close })).toHaveLength(1);
  // A group in its rotation's weaker zone moves when the best zone is worth the margin more, even if
  // that zone is in its rotation, since the bot would stay where it is.
  expect(assignZones({ now: NOW, tabs: [tab("A", "G3", 15, { zone: "najena", rotation: ["najena", "runnyeye"] })], rows: ROWS, rates: close })).toHaveLength(1);
  const far = tab("A", "G3", 15, { zone: "najena", rotation: ["najena", "warrens", "runnyeye"] });
  expect(assignZones({ now: NOW, tabs: [far], rows: ROWS, rates: RATES })).toMatchObject([{ rotation: ["kurn", "runnyeye", "guktop"] }]);
});

test("a rotation set within the settle time stays while the group travels", () => {
  const travelling = tab("A", "G3", 15, { zone: "kerraridge", rotation: ["najena", "warrens", "runnyeye"], rotationSetAt: NOW - 5 * 60000 });
  expect(assignZones({ now: NOW, tabs: [travelling], rows: ROWS, rates: RATES })).toEqual([]);
  expect(assignZones({ now: NOW, tabs: [{ ...travelling, rotationSetAt: NOW - 15 * 60000 }], rows: ROWS, rates: RATES })).toHaveLength(1);
});

test("a running hunt counts by its elapsed time, and a new hunt gets only what is left of the share", () => {
  const tabs = [tab("A", "G1", 40)];
  // A camp started 9 minutes ago is still running, so 0.15 h minus 9 minutes leaves none.
  expect(decide({ now: NOW, tabs, opportunities: [page], history: [{ t: NOW - 9 * 60000, label: "A", kind: "hunt", id: "x" }] }).actions).toEqual([]);
  // One finished 2-minute hunt leaves 7 minutes for the next.
  const [a] = decide({ now: NOW, tabs, opportunities: [page], history: [{ t: NOW - 25 * 60000, label: "A", kind: "hunt", id: "x", ms: 120000 }] }).actions;
  expect(a.spec.minutes).toBe(7);
});

test("no two quest chains give the same reward to the same class, and every hunt names a chain that exists", async () => {
  // Two copies of one chain start together for one piece, and the one that loses the pull fails.
  const quests = JSON.parse(await Bun.file(new URL("../data/quests.json", import.meta.url)).text());
  const keys = Object.values(quests).map((q: { class: string; reward: string }) => `${q.class}: ${q.reward}`);
  expect(keys.filter((k, n) => keys.indexOf(k) !== n)).toEqual([]);
  const ops = JSON.parse(await Bun.file(new URL("../data/opportunities.json", import.meta.url)).text());
  expect(ops.filter((o: { quest?: string }) => o.quest && !quests[o.quest]).map((o: { id: string }) => o.id)).toEqual([]);
});

test("every hunt and farm names a zone the live game has", async () => {
  // A zone of the content snapshot that the live game lacks fails the bot's travel, as Bayle's
  // Forest did for the first Magi`kot page, whose wolves the live game has in Kithicor Forest.
  const read = async (f: string) => JSON.parse(await Bun.file(new URL(`../data/${f}.json`, import.meta.url)).text());
  const live = new Set(await read("live-zones"));
  for (const f of ["opportunities", "farms"]) expect([f, (await read(f)).filter((o: { zone: string }) => !live.has(o.zone)).map((o: { zone: string }) => o.zone)]).toEqual([f, []]);
});

test("a chain member is past its needed pieces only from the step that uses them up", () => {
  // The Paladin's Sealed Note chain: its craft takes the Fire Beetle Eye at the third step.
  const q = {
    reward: "Sealed Note",
    needs: ["Fire Beetle Eye"],
    steps: [
      { give: ["Drom's Champagne"], expect: "Bunker Cell #1" },
      { craft: { inputs: [] }, expect: "Bog Juice" },
      { craft: { inputs: ["Fire Beetle Eye"] }, expect: "Edible Goo" },
      { give: ["Bunker Cell #1", "Bog Juice", "Edible Goo"], expect: "H. K. 102" },
      { give: ["H. K. 102"], expect: "Sealed Note" },
    ],
  };
  // A Bunker Cell or Bog Juice holder still needs an eye, and the reward is no progress item.
  expect(progressItems(q)).toEqual(["Edible Goo", "H. K. 102"]);
  // A chain that needs nothing is under way from its first step's item, and a hand-in of the needed
  // piece counts like a craft.
  expect(progressItems({ ...q, needs: [] })).toEqual(["Bunker Cell #1", "Bog Juice", "Edible Goo", "H. K. 102"]);
  expect(progressItems({ ...q, needs: ["Drom's Champagne"] })).toEqual(["Bunker Cell #1", "Bog Juice", "Edible Goo", "H. K. 102"]);
});

test("settleHistory writes an ended task's outcome into its entry once, and leaves running tasks alone", () => {
  const history = [
    { t: 1000, label: "A", kind: "hunt", id: "o1", task: "hunt-1" },
    { t: 2000, label: "B", kind: "quest", id: "q1", task: "quest-1" },
    { t: 3000, label: "C", kind: "hunt", id: "o2", task: "hunt-2" },
  ];
  const tasks = [
    { id: "hunt-1", status: "failed", step: "make room", error: "no free bag slot", startedAt: 1100, endedAt: 4100, nextAt: 9000 },
    { id: "quest-1", status: "done", result: "got Sealed Note", startedAt: 2100, endedAt: 2600 },
    { id: "hunt-2", status: "running", startedAt: 3100 },
  ];
  expect(settleHistory(history, tasks)).toBe(true);
  expect(history[0]).toMatchObject({ status: "failed", step: "make room", error: "no free bag slot", result: null, ms: 3000, endedAt: 4100, nextAt: 9000, repeat: false });
  expect(history[1]).toMatchObject({ status: "done", result: "got Sealed Note", ms: 500 });
  expect(history[2].status).toBeUndefined();
  // Settled again with the same tasks, nothing changes.
  expect(settleHistory(history, tasks)).toBe(false);
  // The tab's next run of the hunt fails at the same step, which is a repeat, and a third at another step is not.
  history.push({ t: 5000, label: "A", kind: "hunt", id: "o1", task: "hunt-3" }, { t: 6000, label: "A", kind: "hunt", id: "o1", task: "hunt-4" });
  settleHistory(history, [{ id: "hunt-3", status: "failed", step: "make room", startedAt: 5100, endedAt: 5200 }, { id: "hunt-4", status: "failed", step: "travel", startedAt: 6100, endedAt: 6200 }]);
  expect(history.slice(3).map((h) => h.repeat)).toEqual([true, false]);
});

test("chainSummary lists holders, those who started a chain and those who still need it", () => {
  const quests = { "paladin-epic-note": { class: "Paladin", reward: "Sealed Note", minLevel: 15, steps: [] } };
  const members = [
    { name: "Pal1", level: 30, class: "Paladin" },
    { name: "Pal2", level: 30, class: "Paladin" },
    { name: "Pal3", level: 30, class: "Paladin" },
    { name: "Pal4", level: 10, class: "Paladin" }, // below the chain's level
    { name: "Mage", level: 30, class: "Magician" },
  ];
  const summary = chainSummary({ quests, holders: { "paladin-epic-note": ["Pal1"] }, started: { "paladin-epic-note": ["Pal1", "Pal2"] }, members });
  expect(summary).toEqual({ "paladin-epic-note": { class: "Paladin", reward: "Sealed Note", minLevel: 15, holders: ["Pal1"], started: ["Pal2"], needers: ["Pal2", "Pal3"] } });
});
