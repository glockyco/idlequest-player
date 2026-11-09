// Checks the coordinator's policy (tools/lib/coordinator.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { assignZones, chainSummary, decide, doneItems, experimentSettings, piecesNeeded, progressItems, questKeepItems, settleHistory } from "../tools/lib/coordinator.mjs";

const NOW = 1_800_000_000_000;
const team = (prefix: string, level: number) => Array.from({ length: 6 }, (_, k) => ({ name: `${prefix}${k}`, level }));
const tab = (label: string, group: string, level: number, extra = {}) => ({ label, group, members: team(label, level), task: null, gameHour: 12, ...extra });
const page = { id: "p3", group: "G1", zone: "gukbottom", keep: "ghoul", item: "Page 3", retryMin: 30 };

test("stones go to the lowest free group only once there are two a member", () => {
  const tabs = [tab("A", "G1", 40), tab("B", "G10", 8), tab("C", "G7", 9)];
  expect(decide({ now: NOW, tabs, stock: { "Greater Lightstone": 6, Lightstone: 5 } }).actions).toEqual([]);
  const [a] = decide({ now: NOW, tabs, stock: { "Greater Lightstone": 6, Lightstone: 6 } }).actions;
  expect(a.label).toBe("B");
  expect(a.kind).toBe("handIn");
  expect(a.spec.members.map((m: { counts: Record<string, number> }) => m.counts)).toEqual(Array(6).fill({ "Greater Lightstone": 1, Lightstone: 1 }));
  // A running task or a recent coordinator task passes the stones to the next lowest group.
  const busy = [tab("A", "G1", 40), tab("B", "G10", 8, { task: { kind: "hunt", status: "running" } }), tab("C", "G7", 9)];
  expect(decide({ now: NOW, tabs: busy, stock: { "Greater Lightstone": 12 } }).actions[0].label).toBe("C");
  expect(decide({ now: NOW, tabs, stock: { "Greater Lightstone": 12 }, history: [{ t: NOW - 60000, label: "B", kind: "handIn" }] }).actions[0].label).toBe("C");
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
});

test("a chain whose reward a later chain takes stays done, and a finished chain's inputs are let go", () => {
  const quests = {
    note: { class: "Paladin", reward: "Sealed Note", doneIf: ["SoulFire"], needs: ["Fire Beetle Eye"], steps: [{ zone: "freportw", craft: { inputs: ["Fire Beetle Eye"] }, expect: "Edible Goo" }] },
    hayle: { class: "Paladin", reward: "Note", needs: ["Sealed Note"], steps: [{ zone: "freportw", npc: "Brother Hayle", give: ["Sealed Note"], expect: "Note" }] },
    later: { class: "Paladin", reward: "Badge", needs: ["Note"], steps: [{ zone: "x", give: ["Note"], expect: "Badge" }] },
  };
  // Spent on hayle, then on the chain after it: either reward shows the note chain is done.
  expect(doneItems("note", quests).sort()).toEqual(["Badge", "Note", "Sealed Note", "SoulFire"]);
  const members = [{ name: "Pal", class: "Paladin", level: 5 }];
  // Open for a level 5 Paladin: its inputs are kept even below the chain's level.
  expect(questKeepItems({ quests, holders: {}, members })).toContain("Fire Beetle Eye");
  // Done: the inputs go, the items that show progress stay.
  const keep = questKeepItems({ quests, holders: { note: ["Pal"], hayle: ["Pal"], later: ["Pal"] }, members });
  expect(keep).not.toContain("Fire Beetle Eye");
  expect(keep).not.toContain("Edible Goo");
  expect(keep).toEqual(expect.arrayContaining(["Sealed Note", "Note", "Badge", "SoulFire"]));
});

// One item for X1, a level 30 character an hour from its next level, one copy an hour of hunting:
// a gain of g tenths of a percent adds g/1000 x 1/6 x 0.753 x 10 hours of X1's group's progress.
const target = (npc: string, zone: string, gain: number, npcLevel = 30) => ({ npc, zone, npcLevel, spawn: 1, points: 1, items: [{ item: `${npc} drop`, to: "X1", level: 30, gain, hours: 1, drop: 0.1 }] });
const hoursPerLevel = { X1: 1 };
const place = (t: object, zone: string) => ({ ...t, zone, rotation: [zone] });

test("gear targets go to the pairs of group and target that earn most first, not tab by tab", () => {
  // G1 could camp the fiend (0.75 - 0.1 an hour) or hunt the goo in its rotation (0.38). G2 hunts
  // the fiend in its own rotation for free (0.75), so G2 takes the fiend and G1 the goo.
  const tabs = [place(tab("A", "G1", 30), "paw"), place(tab("B", "G2", 30), "unrest")];
  const targets = [target("a fiend", "unrest", 600), target("a goo", "paw", 300)];
  const { actions } = decide({ now: NOW, tabs, targets, hoursPerLevel, zoneShare: () => 0.9 });
  expect(actions.map((a) => [a.label, a.kind, a.id])).toEqual([["B", "errand", "target-unrest-a-fiend"], ["A", "errand", "target-paw-a-goo"]]);
});

test("a target whose best group is busy goes to a free group that still gains, and otherwise waits", () => {
  const busy = { ...place(tab("B", "G2", 30), "unrest"), task: { kind: "quest", status: "running" } };
  const tabs = [place(tab("A", "G1", 30), "paw"), busy];
  const targets = [target("a fiend", "unrest", 600)];
  // A trip zone that pays 90% of G1's XP makes the camp pay.
  const paid = decide({ now: NOW, tabs, targets, hoursPerLevel, zoneShare: () => 0.9 });
  expect(paid.actions).toMatchObject([{ label: "A", kind: "hunt", spec: { zone: "unrest", minutes: 30, waitMin: 0 } }]);
  expect(paid.targets["target-unrest-a-fiend"]).toMatchObject({ group: "G1", kind: "camp" });
  // A trip that earns no XP costs G1 more than the copy adds, so the fiend waits for G2.
  const unpaid = decide({ now: NOW, tabs, targets, hoursPerLevel });
  expect(unpaid.actions).toEqual([]);
  expect(unpaid.targets["target-unrest-a-fiend"]).toMatchObject({ group: "G2", kind: "errand", status: expect.stringMatching(/^waits for a busy group/) });
});

test("each gear target says why it is not hunted", () => {
  const tabs = [place(tab("A", "G1", 30), "paw")];
  const status = (targets: object[], extra = {}) => Object.values(decide({ now: NOW, tabs, targets, hoursPerLevel, ...extra }).targets).map((e: { status: string }) => e.status);
  expect(status([target("a broodling", "velketor", 1000, 34)])).toEqual([expect.stringMatching(/^too strong for every group/)]);
  expect(status([target("a king", "soldunga", 600)], { crowded: new Set(["soldunga"]) })).toEqual(["zone crowded by other players"]);
  // A camp worth 0.5 hours a copy against a whole hour of G1's XP does not pay.
  expect(status([target("a warder", "nurga", 400)])).toEqual([expect.stringMatching(/^not worth it yet/)]);
  expect(status([target("a goo", "paw", 300)], { held: new Set(["G1"]) })).toEqual([expect.stringMatching(/^waits for an experiment to end/)]);
  const last = [{ t: NOW - 30 * 60000, label: "A", kind: "errand", id: "target-paw-a-goo", nextAt: NOW + 60000 }];
  expect(status([target("a goo", "paw", 300)], { history: last })).toEqual([expect.stringMatching(/^waits for its retry/)]);
  // A group on the target's errand hunts it.
  const on = [{ ...tabs[0], errand: { zone: "paw", keep: "a goo" } }];
  expect(Object.values(decide({ now: NOW, tabs: on, targets: [target("a goo", "paw", 300)], hoursPerLevel }).targets)).toMatchObject([{ status: "hunting: G1" }]);
});

test("a rare spawn gets a short visit, and a camp clears the target's spawn points", () => {
  const tabs = [place(tab("A", "G1", 30), "paw")];
  // 2% on each of 6 points: up on arrival 11% of the time, so a 6-minute visit adds 0.114 x 1.26
  // hours against 0.1, where a camp of 1.39 hours a copy adds 1.26 against 1.39.
  const rare = { ...target("Hangman", "trakanon", 1000), spawn: 0.02, points: 6, items: [{ item: "Noose", to: "X1", level: 30, gain: 1000, hours: 1.39, drop: 1 }] };
  expect(decide({ now: NOW, tabs, targets: [rare], hoursPerLevel }).actions).toEqual([expect.objectContaining({ kind: "hunt", spec: { zone: "trakanon", keep: "Hangman", item: "Noose", waitMin: 0, minutes: 6 } })]);
  const camp = decide({ now: NOW, tabs, targets: [target("a fiend", "unrest", 600)], hoursPerLevel, zoneShare: () => 0.9, points: { "target-unrest-a-fiend": [11, 12] } });
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
  // Five minutes after a hunt that set its return time, the 20 minute gap does not hold the tab.
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

test("the lowest group takes the best zone first, and the next counts it as crowded", () => {
  const tabs = [tab("B", "G4", 16, { zone: "najena" }), tab("A", "G3", 15, { zone: "warrens" })];
  const out = assignZones({ now: NOW, tabs, rows: ROWS, rates: RATES });
  expect(out.find((z) => z.label === "A")!.rotation[0]).toBe("kurn");
  expect(out.find((z) => z.label === "B")!.rotation[0]).toBe("runnyeye");
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
  const out = assignZones({ now: NOW, tabs, rows: ROWS, rates: RATES });
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
  // A group in its rotation's weaker zone keeps it while the rotation's best zone is within the margin.
  expect(assignZones({ now: NOW, tabs: [tab("A", "G3", 15, { zone: "najena", rotation: ["najena", "runnyeye"] })], rows: ROWS, rates: close })).toEqual([]);
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

test("every hunt, pick and farm names a zone the live game has", async () => {
  // A zone of the content snapshot that the live game lacks fails the bot's travel, as Bayle's
  // Forest did for the first Magi`kot page, whose wolves the live game has in Kithicor Forest.
  const read = async (f: string) => JSON.parse(await Bun.file(new URL(`../data/${f}.json`, import.meta.url)).text());
  const live = new Set(await read("live-zones"));
  for (const f of ["opportunities", "gear-picks", "farms"]) expect([f, (await read(f)).filter((o: { zone: string }) => !live.has(o.zone)).map((o: { zone: string }) => o.zone)]).toEqual([f, []]);
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
  expect(history[0]).toMatchObject({ status: "failed", step: "make room", error: "no free bag slot", result: null, ms: 3000, endedAt: 4100, nextAt: 9000 });
  expect(history[1]).toMatchObject({ status: "done", result: "got Sealed Note", ms: 500 });
  expect(history[2].status).toBeUndefined();
  // Settled again with the same tasks, nothing changes.
  expect(settleHistory(history, tasks)).toBe(false);
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
