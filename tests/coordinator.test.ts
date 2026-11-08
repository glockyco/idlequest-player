// Checks the coordinator's policy (tools/lib/coordinator.mjs). Run with `bun test`.
import { expect, test } from "bun:test";
import { decide } from "../tools/lib/coordinator.mjs";

const NOW = 1_800_000_000_000;
const team = (prefix: string, level: number) => Array.from({ length: 6 }, (_, k) => ({ name: `${prefix}${k}`, level }));
const tab = (label: string, group: string, level: number, extra = {}) => ({ label, group, members: team(label, level), task: null, gameHour: 12, ...extra });
const page = { id: "p3", group: "G1", as: "Dom", zone: "gukbottom", keep: "ghoul", item: "Page 3", retryMin: 30 };

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
  expect(decide({ now: NOW, tabs, opportunities: [page] })).toMatchObject([{ label: "A", kind: "hunt", id: "p3", spec: { zone: "gukbottom", as: "Dom", waitMin: 0 } }]);
  expect(decide({ now: NOW, tabs, opportunities: [page], owned: { p3: true } })).toEqual([]);
  expect(decide({ now: NOW, tabs, opportunities: [{ ...page, when: "night" }] })).toEqual([]);
  expect(decide({ now: NOW, tabs: [tab("A", "G1", 40, { gameHour: 21 })], opportunities: [{ ...page, when: "night" }] })).toHaveLength(1);
  const history = [{ t: NOW - 25 * 60000, label: "A", kind: "hunt", id: "p3" }];
  expect(decide({ now: NOW, tabs, opportunities: [page], history })).toEqual([]);
  expect(decide({ now: NOW + 6 * 60000, tabs, opportunities: [page], history })).toHaveLength(1);
});
