// Checks the progress record (tools/lib/progress.mjs) and its dashboard rows. Run with `bun test`.
import { expect, test } from "bun:test";
import { openDb } from "../tools/iqd.mjs";
import { aaChanges, chainChanges, gearChanges, lootProgress, progressCounts, recordProgress, snapshotProgress } from "../tools/lib/progress.mjs";
import { itemIdsOf, progressRows } from "../tools/lib/dashboard.mjs";

const leader = (level: number) => ({ id: 1, name: "Tank", level, class: "Warrior" });
const snap = (level: number, extra: Record<string, unknown> = {}) => ({ pageSession: 7, leader: leader(level), party: [], ...extra });
const GOAL = ["The Avatar of War", "Vulak`Aerr"];

test("a level-up is one event per level gained, a first look is none, and a repeat counts once", () => {
  const db = openDb(":memory:");
  // A character without a stored level is new to the collector, not one that gained a level.
  expect(snapshotProgress({ snap: snap(49), levels: {}, now: 1000 })).toEqual([]);
  const events = snapshotProgress({ snap: snap(51), levels: { 1: 49 }, now: 2000 });
  expect(events.map((e) => [e.text, e.sig])).toEqual([
    ["Tank reached level 50", 2],
    ["Tank reached level 51", 1],
  ]);
  expect(recordProgress(db, events, new Map([["Tank", "G1"]]))).toBe(2);
  expect(recordProgress(db, snapshotProgress({ snap: snap(51), levels: { 1: 49 }, now: 3000 }))).toBe(0);
  expect(db.query("SELECT grp FROM progress").all()).toEqual([{ grp: "G1" }, { grp: "G1" }]);
});

test("a raid kill counts once across a bridge reinstall, and a boss of the goal is a milestone", () => {
  const db = openDb(":memory:");
  const alerts = [
    { seq: 4, t: 5000, kind: "raid", killed: "the Avatar of War" },
    { seq: 5, t: 6000, kind: "raid", killed: "an unkempt fanatic" },
  ];
  const first = snapshotProgress({ snap: snap(50, { bot: { alerts } }), levels: {}, now: 7000, goal: GOAL });
  expect(first.map((e) => [e.text, e.sig, e.data.goal])).toEqual([
    ["Tank's raid killed the Avatar of War", 2, "The Avatar of War"],
    ["Tank's raid killed an unkempt fanatic", 1, null],
  ]);
  expect(recordProgress(db, first)).toBe(2);
  // A code update reinstalls the bridge: a new page session sends the same alerts with new seqs.
  const again = snapshotProgress({ snap: snap(50, { pageSession: 8, bot: { alerts: alerts.map((a) => ({ ...a, seq: a.seq + 100 })) } }), levels: {}, now: 8000, goal: GOAL });
  expect(recordProgress(db, again)).toBe(0);
});

test("a loot line of a wanted item is progress, once, and coin, other items and full bags are not", () => {
  const db = openDb(":memory:");
  const itemFor = (item: string) => (item === "Ink of the Dark" ? { for: "the Enchanter chain for Staff of the Serpent", piece: true } : item === "Runed Circlet" ? { for: "Kiasiby", piece: false } : null);
  const row = (seq: number, text: string) => ({ ses: 7, seq, t: seq, type: "LOOT", text });
  const events = [row(1, "You loot 3 platinum, 2 gold, 5 copper!"), row(2, "You loot Ink of the Dark!"), row(3, "You loot Bone Chips!"), row(4, "Your inventory is full, you could not loot Runed Circlet."), row(5, "You loot Runed Circlet!")];
  const found = lootProgress({ events, name: "Tank", itemFor });
  expect(found.map((e) => [e.t, e.text, e.data.piece])).toEqual([
    [2, "Tank looted Ink of the Dark for the Enchanter chain for Staff of the Serpent", true],
    [5, "Tank looted Runed Circlet for Kiasiby", false],
  ]);
  expect(recordProgress(db, found)).toBe(2);
  // A tab that switched characters exports the same rows into another character's log.
  expect(recordProgress(db, lootProgress({ events, name: "Mage", itemFor }))).toBe(0);
});

const sheet = (worn: string, wornId: number, plan: Record<string, unknown> = {}) => [{ slotNum: 1, slot: "head", worn: { itemId: wornId, name: worn }, move: null, drop: null, ...plan }];

test("gear counts an upgrade the earlier pass planned or one that raised the set score", () => {
  const before = { sheets: { Tank: sheet("Cap", 1, { move: { itemId: 2, item: "Helm", gain: 3.5 } }), Mage: sheet("Hood", 5) }, scores: { Tank: { now: 10, target: 40 }, Mage: { now: 8, target: 40 } } };
  const after = { sheets: { Tank: sheet("Helm", 2), Mage: sheet("Rag", 6) }, scores: { Tank: { now: 10, target: 40 }, Mage: { now: 8, target: 40 } } };
  // Tank wears the planned move, and Mage's swap neither was planned nor raised the score.
  expect(gearChanges({ before, after, t: 9 }).map((e) => [e.name, e.text, e.data.slots[0].gain])).toEqual([["Tank", "Tank wears Helm (head)", 3.5]]);
  const rose = { ...after, scores: { ...after.scores, Mage: { now: 9, target: 40 } } };
  expect(gearChanges({ before, after: rose, t: 9 }).map((e) => e.name)).toEqual(["Tank", "Mage"]);
});

test("the feed names a looted item and an upgrade's new and replaced items by id, and an empty slot replaced nothing", () => {
  const db = openDb(":memory:");
  const groups = new Map([["Tank", "G1"]]);
  const loot = lootProgress({ events: [{ ses: 7, seq: 1, t: 1, type: "LOOT", text: "You loot Runed Circlet!", itemId: 77 }], name: "Tank", itemFor: () => ({ for: "Tank", piece: false }) });
  const before = { sheets: { Tank: [...sheet("Cap", 1), { slotNum: 2, slot: "neck", worn: null, move: null, drop: null }] }, scores: { Tank: { now: 10, target: 40 } } };
  const after = { sheets: { Tank: [...sheet("Helm", 2), { slotNum: 2, slot: "neck", worn: { itemId: 3, name: "Collar" }, move: null, drop: null }] }, scores: { Tank: { now: 12, target: 40 } } };
  recordProgress(db, [...loot, ...gearChanges({ before, after, t: 2 })], groups);
  const rows = progressRows(db, 0);
  expect(rows.map((r) => r.items)).toEqual([
    [{ id: 2, name: "Helm", was: { id: 1, name: "Cap" } }, { id: 3, name: "Collar", was: null }],
    [{ id: 77, name: "Runed Circlet" }],
  ]);
  expect(itemIdsOf(rows).sort((a, b) => a - b)).toEqual([1, 2, 3, 77]);
});

test("AA reports each trained rank and earned points as a minor step", () => {
  const before = { Tank: { points: 1, spent: 0, ranks: { 3: 0 }, names: { 3: "Innate Strength" } } };
  const after = { Tank: { points: 0, spent: 3, ranks: { 3: 2 }, names: { 3: "Innate Strength" } } };
  expect(aaChanges(before, after, 9).map((e) => [e.text, e.sig])).toEqual([
    ["Tank trained Innate Strength to rank 1", 1],
    ["Tank trained Innate Strength to rank 2", 1],
    ["Tank earned AA points (0 unspent)", 0],
  ]);
});

test("a chain finished is a milestone, a chain started a minor step, and a new chain neither", () => {
  const chain = (holders: string[], started: string[]) => ({ class: "Enchanter", reward: "Staff", holders, started });
  const events = chainChanges({ ench: chain([], ["A"]) }, { ench: chain(["A"], ["B"]), mage: chain(["C"], []) }, 9);
  expect(events.map((e) => [e.text, e.sig])).toEqual([
    ["A finished the Enchanter chain for Staff", 2],
    ["B started the Enchanter chain for Staff", 0],
  ]);
});

test("a group's level-ups of a day share a row, milestones within half an hour, a gear pass one row", () => {
  const db = openDb(":memory:");
  const min = 60000;
  const level = (name: string, lvl: number, t: number) => ({ t, kind: "level", sig: lvl === 50 ? 2 : 1, name, text: `${name} reached level ${lvl}`, data: { level: lvl }, key: `level:${name}:${lvl}` });
  const groups = new Map([["A", "G1"], ["B", "G1"], ["C", "G1"], ["D", "G2"]]);
  recordProgress(db, [level("A", 30, 0), level("B", 31, 10 * min), level("D", 30, 12 * min), level("C", 30, 50 * min)], groups);
  // A and B reach the milestone ten minutes apart, C forty minutes after B.
  recordProgress(db, [level("A", 50, 100 * min), level("B", 50, 110 * min), level("C", 50, 150 * min)], groups);
  recordProgress(db, [{ t: 160 * min, kind: "gear", sig: 1, name: "A", text: "A wears Helm (head)", data: { slots: [{ slot: "head", gain: 2 }, { slot: "feet", gain: 1 }] }, key: "gear:A:160" }, { t: 160 * min, kind: "gear", sig: 1, name: "B", text: "B wears Boots (feet)", data: { slots: [{ slot: "feet", gain: 1 }] }, key: "gear:B:160" }], groups);
  recordProgress(db, [{ t: 161 * min, kind: "aa", sig: 0, name: "A", text: "A earned AA points (1 unspent)", data: {}, key: "aa-points:A:1" }], groups);
  const rows = progressRows(db, 0).map((r) => [r.group, r.kind, r.sig, r.text, r.detail, r.parts.map((p: { text: string }) => p.text)]);
  expect(rows).toEqual([
    ["G1", "aa", 0, "A earned AA points (1 unspent)", null, []],
    ["G1", "gear", 1, "A and B wear 3 upgrades", "slot score +4", ["A wears Helm (head)", "B wears Boots (feet)"]],
    ["G1", "level", 2, "C reached level 50", null, []],
    ["G1", "level", 2, "A and B reached level 50", null, ["A reached level 50", "B reached level 50"]],
    ["G1", "level", 1, "A, B and C reached levels 30 to 31", "3 levels", ["A reached level 30", "B reached level 31", "C reached level 30"]],
    ["G2", "level", 1, "D reached level 30", null, []],
  ]);
  expect(progressRows(db, 0, { group: "G2" }).map((r) => r.text)).toEqual(["D reached level 30"]);
  // Minor steps do not count, and gear counts its slots.
  expect(progressCounts(db, 0)).toEqual({ level: 7, gear: 3, item: 0, chain: 0, aa: 0, raid: 0 });
});
