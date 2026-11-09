// Checks the coordinator's policy (tools/lib/coordinator.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { assignZones, decide } from "../tools/lib/coordinator.mjs";

const NOW = 1_800_000_000_000;
const team = (prefix: string, level: number) => Array.from({ length: 6 }, (_, k) => ({ name: `${prefix}${k}`, level }));
const tab = (label: string, group: string, level: number, extra = {}) => ({ label, group, members: team(label, level), task: null, gameHour: 12, ...extra });
const page = { id: "p3", group: "G1", zone: "gukbottom", keep: "ghoul", item: "Page 3", retryMin: 30 };

test("stones go to the lowest free group only once there are two a member", () => {
  const tabs = [tab("A", "G1", 40), tab("B", "G10", 8), tab("C", "G7", 9)];
  expect(decide({ now: NOW, tabs, stock: { "Greater Lightstone": 6, Lightstone: 5 } })).toEqual([]);
  const [a] = decide({ now: NOW, tabs, stock: { "Greater Lightstone": 6, Lightstone: 6 } });
  expect(a.label).toBe("B");
  expect(a.kind).toBe("handIn");
  expect(a.spec.members.map((m: { counts: Record<string, number> }) => m.counts)).toEqual(Array(6).fill({ "Greater Lightstone": 1, Lightstone: 1 }));
  // A running task or a recent coordinator task passes the stones to the next lowest group.
  const busy = [tab("A", "G1", 40), tab("B", "G10", 8, { task: { kind: "hunt", status: "running" } }), tab("C", "G7", 9)];
  expect(decide({ now: NOW, tabs: busy, stock: { "Greater Lightstone": 12 } })[0].label).toBe("C");
  expect(decide({ now: NOW, tabs, stock: { "Greater Lightstone": 12 }, history: [{ t: NOW - 60000, label: "B", kind: "handIn" }] })[0].label).toBe("C");
});

test("a piece is hunted by its group until owned, waits for its time of day and for its retry", () => {
  const tabs = [tab("A", "G1", 40)];
  expect(decide({ now: NOW, tabs, opportunities: [page] })).toMatchObject([{ label: "A", kind: "hunt", id: "p3", spec: { zone: "gukbottom", waitMin: 0 } }]);
  expect(decide({ now: NOW, tabs, opportunities: [page], owned: { p3: true } })).toEqual([]);
  expect(decide({ now: NOW, tabs, opportunities: [{ ...page, when: "night" }] })).toEqual([]);
  expect(decide({ now: NOW, tabs: [tab("A", "G1", 40, { gameHour: 21 })], opportunities: [{ ...page, when: "night" }] })).toHaveLength(1);
  const history = [{ t: NOW - 25 * 60000, label: "A", kind: "hunt", id: "p3", ms: 120000 }];
  expect(decide({ now: NOW, tabs, opportunities: [page], history })).toEqual([]);
  expect(decide({ now: NOW + 6 * 60000, tabs, opportunities: [page], history })).toHaveLength(1);
});

test("a hunt that reported its next respawn comes back then, earlier or later than the retry interval", () => {
  const tabs = [tab("A", "G1", 40)];
  const hunted = (nextAt: number) => [{ t: NOW - 25 * 60000, label: "A", kind: "hunt", id: "p3", nextAt, ms: 120000 }];
  expect(decide({ now: NOW, tabs, opportunities: [page], history: hunted(NOW + 60000) })).toEqual([]);
  // Five minutes after a hunt that set its return time, the 20 minute gap does not hold the tab.
  const soon = [{ t: NOW - 5 * 60000, label: "A", kind: "hunt", id: "p3", nextAt: NOW - 1000, ms: 120000 }];
  expect(decide({ now: NOW, tabs, opportunities: [page], history: soon })).toHaveLength(1);
  expect(decide({ now: NOW, tabs, opportunities: [{ ...page, points: [7] }], history: hunted(NOW - 1000) })).toMatchObject([{ spec: { points: [7] } }]);
});

test("hunts stop for a tab once they took its share of the last hour", () => {
  const tabs = [tab("A", "G1", 40)];
  const ring = { ...page, id: "ring" };
  const busy = [6, 4].map((m) => ({ t: NOW - m * 60000, label: "A", kind: "hunt", id: "p3", nextAt: NOW + 3600000, ms: 4.5 * 60000 }));
  expect(decide({ now: NOW, tabs, opportunities: [ring], history: busy })).toEqual([]);
  expect(decide({ now: NOW, tabs, opportunities: [ring], history: busy.slice(0, 1) })).toHaveLength(1);
});

test("an errand opportunity queues an errand, and a tab on an errand gets no other task", () => {
  const pages = { id: "m1", group: "G2", kind: "errand", zone: "najena", keep: "magician", item: "Page" };
  expect(decide({ now: NOW, tabs: [tab("B", "G2", 17)], opportunities: [pages] })).toMatchObject([{ kind: "errand", spec: { zone: "najena", keep: "magician", minutes: 60 } }]);
  const busy = [tab("B", "G2", 17, { errand: { zone: "nektulos" } }), tab("C", "G7", 20)];
  expect(decide({ now: NOW, tabs: busy, opportunities: [pages], stock: { "Greater Lightstone": 12 } })).toMatchObject([{ label: "C", kind: "handIn" }]);
});

test("a farm keeps at most maxGroups groups, the lowest in its levels, and fills free places", () => {
  const wisps = { id: "wisp", zone: "nektulos", keep: "wisp", levels: [10, 15], maxGroups: 2, minutes: 120 };
  const farming = { zone: "nektulos", keep: "wisp" };
  const tabs = [tab("A", "G3", 13, { errand: farming }), tab("B", "G6", 11, { errand: farming }), tab("C", "G8", 12, { errand: farming }), tab("D", "G1", 41)];
  // Three on the farm: the highest stops, and nobody joins.
  expect(decide({ now: NOW, tabs, farms: [wisps] }).map((a) => [a.label, a.kind])).toEqual([["A", "stopErrand"]]);
  // One on the farm, one free group in its levels: that group joins, the level 41 group does not.
  const one = [tab("A", "G3", 13), tab("B", "G6", 11, { errand: farming }), tab("D", "G1", 41), tab("E", "G9", 16)];
  expect(decide({ now: NOW, tabs: one, farms: [wisps] })).toMatchObject([{ label: "A", kind: "errand", spec: { zone: "nektulos", keep: "wisp", minutes: 120 } }]);
  // A farming group that outgrew the levels stops.
  expect(decide({ now: NOW, tabs: [tab("E", "G9", 16, { errand: farming })], farms: [wisps] })).toMatchObject([{ label: "E", kind: "stopErrand" }]);
});

test("an opportunity with levels goes to a free group inside them, one already in the zone first", () => {
  const pages = { id: "m1", levels: [11, 21], kind: "errand", zone: "najena", keep: "magician", item: "Page" };
  const tabs = [tab("A", "G1", 41), tab("B", "G5", 12), tab("C", "G2", 18, { zone: "najena" }), tab("D", "G9", 13)];
  expect(decide({ now: NOW, tabs, opportunities: [pages] })).toMatchObject([{ label: "C", kind: "errand", why: "Page for G2" }]);
  const elsewhere = tabs.map((t) => ({ ...t, zone: "warrens" }));
  expect(decide({ now: NOW, tabs: elsewhere, opportunities: [pages] })).toMatchObject([{ label: "B" }]);
});

test("errands for pieces from the same enemies go to one group", () => {
  const page = (id: string) => ({ id, levels: [11, 21], kind: "errand", zone: "najena", keep: "magician", item: id });
  const tabs = [tab("B", "G5", 12), tab("D", "G9", 13)];
  expect(decide({ now: NOW, tabs, opportunities: [page("p1"), page("p2")] })).toHaveLength(1);
  const busy = [tab("B", "G5", 12, { errand: { zone: "najena", keep: "magician" } }), tab("D", "G9", 13)];
  expect(decide({ now: NOW, tabs: busy, opportunities: [page("p1")] })).toEqual([]);
});

test("a quest chain runs for the members of its class who lack the reward", () => {
  const quests = { w1: { class: "Warrior", minLevel: 10, reward: "Totem", steps: [{ zone: "freporte", npc: "Kargek" }] } };
  const war = (label: string, group: string, level: number, name: string) => ({ ...tab(label, group, level), members: [{ name, level, class: "Warrior" }, { name: `${label}c`, level, class: "Cleric" }] });
  const tabs = [war("A", "G1", 41, "Tagu"), war("B", "G4", 12, "Thal"), war("C", "G6", 8, "Low")];
  expect(decide({ now: NOW, tabs, quests, holders: { w1: ["Tagu"] } })).toMatchObject([{ label: "B", kind: "quest", spec: { members: ["Thal"] } }]);
  expect(decide({ now: NOW, tabs, quests, holders: { w1: ["Tagu"] }, history: [{ t: NOW - 60 * 60000, label: "B", kind: "quest", id: "w1" }] })).toEqual([]);
});

test("gear moves go to the free tab with the lowest levels", () => {
  const tabs = [tab("A", "G1", 41), tab("B", "G5", 12, { task: { kind: "hunt", status: "running" } }), tab("C", "G9", 13)];
  const moves = [{ item: "Cloak", from: "X", to: "Y", slot: "back" }];
  expect(decide({ now: NOW, tabs, gear: { moves } })).toMatchObject([{ label: "C", kind: "gear", spec: { moves } }]);
  expect(decide({ now: NOW, tabs, gear: { moves: [] } })).toEqual([]);
});

test("a quest chain takes a tab before a camp would", () => {
  const quests = { b1: { class: "Bard", minLevel: 20, reward: "Page", steps: [{ zone: "qey2hh1", npc: "Konia" }] } };
  const tabs = [{ ...tab("A", "G1", 40), members: [{ name: "Ugfeu", level: 40, class: "Bard" }] }];
  expect(decide({ now: NOW, tabs, quests, opportunities: [page] })).toMatchObject([{ label: "A", kind: "quest" }]);
});

test("an experiment gives arm A the setting and arm B the other in the first block, swaps, then ends on the other", async () => {
  const { experimentSettings } = await import("../tools/lib/coordinator.mjs");
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
  expect(decide({ now: NOW, tabs: [tab("A", "G4", 12, { errand: { zone: "najena", keep: "magician" } })], held: new Set(["G4"]) })).toMatchObject([{ kind: "stopErrand" }]);
  // A held group gets no new errand, also one that names it, such as a wanted drop.
  const drop = { id: "drop-A-back", group: "G4", kind: "errand", zone: "kurn", keep: "a skeleton", item: "Fine Cloak", count: 1 };
  expect(decide({ now: NOW, tabs: [tab("A", "G4", 12)], opportunities: [drop], held: new Set(["G4"]) })).toEqual([]);
  expect(decide({ now: NOW, tabs: [tab("A", "G4", 12)], opportunities: [drop] })).toMatchObject([{ kind: "errand" }]);
  // A farm skips a held group and stops it when it farms.
  const farm = { id: "w", zone: "nektulos", keep: "wisp", levels: [10, 15], maxGroups: 2, minutes: 120 };
  expect(decide({ now: NOW, tabs: [tab("A", "G4", 12, { errand: { zone: "nektulos", keep: "wisp" } })], farms: [farm], held: new Set(["G4"]) })).toMatchObject([{ kind: "stopErrand" }]);
});

test("stones reach the lowest group also while it farms", () => {
  const farm = { id: "w", zone: "nektulos", keep: "wisp", levels: [10, 15], maxGroups: 2, minutes: 120 };
  const tabs = [tab("A", "G6", 12, { errand: { zone: "nektulos", keep: "wisp" } }), tab("B", "G9", 15)];
  expect(decide({ now: NOW, tabs, farms: [farm], stock: { "Greater Lightstone": 12 } }).find((a) => a.kind === "handIn")?.label).toBe("A");
});

test("a quest that needs a dropped item runs for as many members as the account holds copies", () => {
  const quests = { n1: { class: "Necromancer", reward: "Symbol", needs: ["Head"], steps: [{ zone: "lakerathe", npc: "Kazen" }] } };
  const necro = (label: string, group: string, names: string[]) => ({ ...tab(label, group, 14), members: names.map((name) => ({ name, level: 14, class: "Necromancer" })) });
  const tabs = [necro("A", "G4", ["N1", "N2"]), necro("B", "G5", ["N3"])];
  expect(decide({ now: NOW, tabs, quests, have: { Head: 0 } })).toEqual([]);
  expect(decide({ now: NOW, tabs, quests, have: { Head: 1 } })).toMatchObject([{ label: "A", spec: { members: ["N1"] } }]);
  expect(decide({ now: NOW, tabs, quests, have: { Head: 3 } }).map((a) => a.spec.members)).toEqual([["N1", "N2"], ["N3"]]);
});

test("a member part way through a quest runs it without a copy of what it needs", () => {
  const quests = { n1: { class: "Necromancer", reward: "Symbol", needs: ["Head"], steps: [{ zone: "lakerathe", npc: "Kazen" }] } };
  const tabs = [{ ...tab("A", "G4", 14), members: ["N1", "N2"].map((name) => ({ name, level: 14, class: "Necromancer" })) }];
  expect(decide({ now: NOW, tabs, quests, have: { Head: 0 }, started: { n1: ["N2"] } })).toMatchObject([{ spec: { members: ["N2"] } }]);
  expect(decide({ now: NOW, tabs, quests, have: { Head: 1 }, started: { n1: ["N2"] } })).toMatchObject([{ spec: { members: ["N2", "N1"] } }]);
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
  expect(decide({ now: NOW, tabs, opportunities: [page], history: [{ t: NOW - 9 * 60000, label: "A", kind: "hunt", id: "x" }] })).toEqual([]);
  // One finished 2-minute hunt leaves 7 minutes for the next.
  const [a] = decide({ now: NOW, tabs, opportunities: [page], history: [{ t: NOW - 25 * 60000, label: "A", kind: "hunt", id: "x", ms: 120000 }] });
  expect(a.spec.minutes).toBe(7);
});
