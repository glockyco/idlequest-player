// Checks the coordinator's policy (tools/lib/coordinator.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { decide } from "../tools/lib/coordinator.mjs";

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
  const history = [{ t: NOW - 25 * 60000, label: "A", kind: "hunt", id: "p3" }];
  expect(decide({ now: NOW, tabs, opportunities: [page], history })).toEqual([]);
  expect(decide({ now: NOW + 6 * 60000, tabs, opportunities: [page], history })).toHaveLength(1);
});

test("a hunt that reported its next respawn comes back then, earlier or later than the retry interval", () => {
  const tabs = [tab("A", "G1", 40)];
  const hunted = (nextAt: number) => [{ t: NOW - 25 * 60000, label: "A", kind: "hunt", id: "p3", nextAt }];
  expect(decide({ now: NOW, tabs, opportunities: [page], history: hunted(NOW + 60000) })).toEqual([]);
  // Five minutes after a hunt that set its return time, the 20 minute gap does not hold the tab.
  const soon = [{ t: NOW - 5 * 60000, label: "A", kind: "hunt", id: "p3", nextAt: NOW - 1000 }];
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
