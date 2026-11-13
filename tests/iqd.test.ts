// Checks the attention rules of tools/iqd.mjs on fixture snapshots. No browser, no relay, no clock.
// Run with `bun test`.
import { expect, spyOn, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gearPlan from "../tools/lib/gear-plan.mjs";
import * as coordinator from "../tools/lib/coordinator.mjs";
import * as content from "../tools/lib/content.mjs";
import { settleHistory } from "../tools/lib/coordinator.mjs";
import { Daemon, openDb, raiseItem, renderStatus, resolveItem, searchInPage, stepSession, sweepOrphans, syncAttention, tabWasBusy } from "../tools/iqd.mjs";

const T0 = 1_800_000_000_000;
const SEC = 1000;

type Snap = Record<string, unknown>;
interface Item {
  severity: string;
  kind: string;
  key: string;
  text: string;
}
interface Result {
  state: Record<string, unknown>;
  items: Item[];
  evaluated: string[];
  parked?: boolean;
}
interface Obs {
  reachable: boolean;
  present: boolean;
  error?: string;
  snap?: Snap;
}
interface Opts {
  levels?: Record<number, number>;
  triggers?: { level: number; text: string; doc?: string }[];
}

const bot = (over: Snap = {}): Snap => ({ enabled: true, pauseUntil: 0, errand: null, alerts: [], alertSeq: 0, ...over });

// A running tab that killed something five seconds before T0.
const snap = (over: Snap = {}): Snap => ({
  t: T0,
  hasBridge: true,
  hasBot: true,
  pageSession: 111,
  zone: "Permafrost",
  leader: { id: 1, name: "Tagu", level: 35, class: "Warrior" },
  party: [
    { id: 2, name: "Dome", level: 34, type: 2 },
    { id: null, name: "pet", level: 20, type: 1 },
  ],
  autoLevel: { running: true },
  activity: { act: "fight", why: null, since: T0 - 3 * SEC },
  raid: false,
  kills: { last: T0 - 5 * SEC },
  heap: { used: 400, limit: 4000 },
  bot: bot(),
  ...over,
});
const ok = (snapshot: Snap): Obs => ({ reachable: true, present: true, snap: snapshot });
const goneObs: Obs = { reachable: false, present: false };

/** Run the rule step `steps` times, `gap` seconds apart, and return the last result. */
function run(obsAt: (i: number) => Obs, steps: number, gap: number, opts: Opts = {}): Result {
  let state: Record<string, unknown> = {};
  let res: Result = { state, items: [], evaluated: [] };
  for (let i = 0; i < steps; i++) {
    res = stepSession({ state, obs: obsAt(i), now: T0 + i * gap * SEC, label: "Tagu", ...opts });
    state = res.state;
  }
  return res;
}
const kinds = (res: Result) => res.items.map((i) => i.kind);

// An idle tab since T0 with no kill since T0 - 5 s, for the stall rule.
const idleSnap = (why: string, over: Snap = {}): Snap => snap({ autoLevel: { running: why !== "off" }, activity: { act: "idle", why, since: T0 }, ...over });

test("idle for two minutes raises a stall that names the cause", () => {
  const idle = ok(idleSnap("crowded", { activitySec: { "idle/crowded": 90, fight: 30 } }));
  expect(kinds(run(() => idle, 4, 30))).toEqual([]); // 90 s
  const res = run(() => idle, 5, 30); // 120 s
  expect(kinds(res)).toEqual(["stall"]);
  expect(res.items[0].text).toContain("idle (crowded) for 120 s");
  expect(res.items[0].text).toContain("idle/crowded 75%");
});

test("a dead leader counts as idle", () => {
  const dead = ok(snap({ activity: { act: "dead", why: null, since: T0 } }));
  expect(kinds(run(() => dead, 5, 30))).toEqual(["stall"]);
});

test("an errand that idles raises, a pause or a raid does not", () => {
  const errand = ok(idleSnap("noTarget", { bot: bot({ errand: { zone: "x", item: "y" } }) }));
  expect(kinds(run(() => errand, 5, 30))).toEqual(["stall"]);
  for (const over of [{ raid: true }, { bot: bot({ pauseUntil: T0 + 3600 * SEC }) }]) {
    expect(kinds(run(() => ok(idleSnap("off", over)), 20, 30))).toEqual([]);
  }
});

test("after a pause the idle time counts from its end", () => {
  // Idle since T0, paused for the first five minutes, then 90 s without the pause.
  const pausedThenNot = () => ok(idleSnap("off", { bot: bot({ pauseUntil: T0 + 300 * SEC }) }));
  expect(kinds(run(pausedThenNot, 13, 30))).toEqual([]);
  expect(kinds(run(pausedThenNot, 15, 30))).toEqual(["stall"]);
});

test("busy without a kill for five minutes raises, a fresh kill does not", () => {
  const stale = ok(snap({ activity: { act: "approach", why: null, since: T0 - 20 * SEC }, kills: { last: T0 - 11 * 60 * SEC } }));
  expect(kinds(run(() => stale, 1, 30))).toEqual([]); // counted from the first look
  expect(kinds(run(() => stale, 10, 30))).toEqual([]); // 270 s
  const res = run(() => stale, 11, 30); // 300 s
  expect(kinds(res)).toEqual(["stall"]);
  expect(res.items[0].text).toContain("no kill for 5 min");
  const fresh = (i: number) => ok(snap({ kills: { last: T0 + i * 30 * SEC - 5 * SEC } }));
  expect(kinds(run(fresh, 40, 30))).toEqual([]);
});

test("a parked tab raises nothing but a vanished tab", () => {
  const wakeDeath = { seq: 1, kind: "death", wake: true, text: "You have been slain" };
  const parked = ok(snap({ autoLevel: { running: false }, bot: bot({ enabled: false, alerts: [wakeDeath] }), heap: { used: 3900, limit: 4000 } }));
  const res = run(() => parked, 40, 30);
  expect(res.items).toEqual([]);
  expect(res.parked).toBe(true);

  // The tab answers once, then disappears. The first miss is at 30 s, so 60 s of misses end at 90 s.
  const vanishing = (i: number) => (i === 0 ? parked : goneObs);
  expect(kinds(run(vanishing, 3, 30))).toEqual([]);
  const after = run(vanishing, 4, 30);
  expect(kinds(after)).toEqual(["gone"]);
  expect(after.items[0].text).toContain("not in the relay list");
});

test("a tab that answers again clears the gone condition", () => {
  const silent: Obs = { reachable: false, present: true, error: "timed out" };
  const res = run((i) => (i < 4 ? silent : ok(snap())), 5, 30);
  expect(res.items).toEqual([]);
  expect(res.evaluated).toContain("gone");
});

test("a missing bridge or bot raises and stops the other rules", () => {
  expect(kinds(run(() => ok(snap({ hasBridge: false })), 1, 30))).toEqual(["nobridge"]);
  const res = run(() => ok(snap({ hasBot: false, autoLevel: { running: false } })), 20, 30);
  expect(kinds(res)).toEqual(["nobridge"]);
  expect(res.items[0].text).toContain("window.iqBot");
});

test("wake alerts keep their text, deaths have their own kind, level-up alerts belong to the level rules", () => {
  const alerts = [
    { seq: 4, kind: "death", wake: true, text: "You have been slain by a goblin" },
    { seq: 5, kind: "death", wake: false, text: "a goblin has been slain!" },
    { seq: 6, kind: "levelUp", wake: true, text: "You have gained a level! Welcome to level 36" },
    { seq: 7, kind: "lootFull", wake: true, text: "3 item(s) left on corpses" },
    // An outcome the coordinator already acts on asks for nobody.
    { seq: 8, kind: "raid", wake: true, text: "killed Tolapumj", killed: "Tolapumj" },
    { seq: 9, kind: "errand", wake: true, text: "Gauntlets of Potence in droga: idle (crowded) in Mines of Droga" },
    { seq: 10, kind: "raid", wake: true, text: "raid mode is still on: Request timeout" },
  ];
  const res = run(() => ok(snap({ bot: bot({ alerts }) })), 1, 30);
  expect(res.items.map((i) => [i.severity, i.kind, i.text])).toEqual([
    ["act", "death", "You have been slain by a goblin"],
    ["act", "alert-lootFull", "3 item(s) left on corpses"],
    ["info", "alert-raid", "killed Tolapumj"],
    ["info", "alert-errand", "Gauntlets of Potence in droga: idle (crowded) in Mines of Droga"],
    ["act", "alert-raid", "raid mode is still on: Request timeout"],
  ]);
});

test("a bags alert settles once the free slots are back at the bot's reserve", () => {
  const step = (bags: Snap) => stepSession({ state: {}, obs: { reachable: true, present: true, snap: snap({ bags }) }, now: T0, label: "G2" });
  expect(step({ free: 7, cursor: null, reserve: 8 }).settled["alert-bags"]).toBeUndefined();
  expect(step({ free: 12, cursor: null, reserve: 8 }).settled["alert-bags"]).toBe(T0);
  // A snapshot from a bot without the reserve settles nothing.
  expect(step({ free: 12, cursor: null }).settled["alert-bags"]).toBeUndefined();
});

test("an offline alert settles once the page is connected in the game world", () => {
  const step = (conn: Snap) => stepSession({ state: {}, obs: { reachable: true, present: true, snap: snap({ conn }) }, now: T0, label: "G2" });
  expect(step({ screen: "login", connected: false }).settled["alert-offline"]).toBeUndefined();
  // The client can show the game screen while its socket is down.
  expect(step({ screen: "game", connected: false }).settled["alert-offline"]).toBeUndefined();
  expect(step({ screen: "game", connected: true }).settled["alert-offline"]).toBe(T0);
});

test("heap above 85% of the limit raises", () => {
  expect(kinds(run(() => ok(snap({ heap: { used: 3300, limit: 4000 } })), 1, 30))).toEqual([]);
  expect(kinds(run(() => ok(snap({ heap: { used: 3500, limit: 4000 } })), 1, 30))).toEqual(["heap"]);
});

test("level-ups of any character are info, trigger levels are decide, first sight raises nothing", () => {
  const triggers = [{ level: 36, text: "Check the rotation.", doc: "docs/x.md#y" }];
  expect(run(() => ok(snap()), 1, 30, { levels: {}, triggers }).items).toEqual([]);

  const leveled = ok(snap({ leader: { id: 1, name: "Tagu", level: 36, class: "Warrior" }, party: [{ id: 2, name: "Dome", level: 35, type: 2 }] }));
  const res = run(() => leveled, 1, 30, { levels: { 1: 35, 2: 34 }, triggers });
  expect(res.items.map((i) => [i.severity, i.kind, i.key])).toEqual([
    ["info", "levelup", "levelup:1:36"],
    ["info", "levelup", "levelup:2:35"],
    ["decide", "trigger", "trigger:1:36"],
  ]);
  expect(res.items[2].text).toContain("docs/x.md#y");

  // Past the trigger level already: no decide item.
  const later = ok(snap({ leader: { id: 1, name: "Tagu", level: 37, class: "Warrior" } }));
  expect(kinds(run(() => later, 1, 30, { levels: { 1: 36 }, triggers }))).not.toContain("trigger");
});

test("items are deduplicated by key while open and conditions resolve themselves", () => {
  const db = openDb(":memory:");
  let state: Record<string, unknown> = {};
  const step = (i: number, s: Snap) => {
    const now = T0 + i * 30 * SEC;
    const res: Result = stepSession({ state, obs: ok(s), now, label: "Tagu" });
    state = res.state;
    syncAttention(db, { label: "Tagu", res, now });
  };
  const rows = () => db.query("SELECT * FROM attention").all() as { id: number; kind: string; resolved: number | null; note: string | null }[];

  for (let i = 0; i < 12; i++) step(i, idleSnap("off")); // 330 s idle: one item, not eight
  expect(rows().map((r) => r.kind)).toEqual(["stall"]);
  const busy = (i: number) => snap({ kills: { last: T0 + i * 30 * SEC - 5 * SEC } });
  step(12, busy(12)); // fighting and killing again
  expect(rows()[0].resolved).not.toBeNull();
  expect(rows()[0].note).toBe("condition cleared");

  // An event is read or resolved by hand, and a resolved key can be raised again.
  const death = { t: T0 + 13 * 30 * SEC, severity: "act", kind: "death", session: "Tagu", key: "death:111:4", text: "You have been slain" };
  const id = raiseItem(db, death) as number;
  expect(id).toBeGreaterThan(0);
  expect(raiseItem(db, death)).toBeNull();
  step(13, busy(13));
  expect(rows().find((r) => r.id === id)?.resolved).toBeNull();
  expect(resolveItem(db, id, "read")).toBe(true);
  expect(raiseItem(db, death)).not.toBeNull();
});

test("a newer event of a kind replaces the older one, and events expire once the tab plays", () => {
  const db = openDb(":memory:");
  const rows = () => db.query("SELECT id, kind, resolved, note FROM attention ORDER BY id").all() as { id: number; kind: string; resolved: number | null; note: string | null }[];
  const playing: Result = { state: {}, items: [], evaluated: ["stall", "gone", "nobridge", "heap"] };
  const idle = (key: string): Result => ({ ...playing, items: [{ severity: "act", kind: "alert-idle", key, text: "idle (crowded) after every remedy" }] });
  syncAttention(db, { label: "Tagu", res: idle("alert-idle:1:5"), now: T0 });
  syncAttention(db, { label: "Tagu", res: idle("alert-idle:1:9"), now: T0 + 11 * 60 * SEC });
  expect(rows().map((r) => r.note)).toEqual(["replaced by #2", null]);

  // Info expires after ten minutes, an act event after an hour, but not while the tab stalls.
  raiseItem(db, { t: T0, severity: "info", kind: "levelup", session: "Tagu", key: "levelup:2:35", text: "Dome reached level 35" });
  raiseItem(db, { t: T0, severity: "decide", kind: "trigger", session: "Tagu", key: "trigger:1:46", text: "Tagu reached level 46" });
  const stalled: Result = { ...playing, items: [{ severity: "act", kind: "stall", key: "stall:Tagu", text: "idle (off) for 130 s" }] };
  syncAttention(db, { label: "Tagu", res: stalled, now: T0 + 75 * 60 * SEC });
  expect(rows().map((r) => [r.kind, r.note])).toEqual([["alert-idle", "replaced by #2"], ["alert-idle", null], ["levelup", "expired"], ["trigger", null], ["stall", null]]);
  syncAttention(db, { label: "Tagu", res: playing, now: T0 + 76 * 60 * SEC });
  expect(rows().map((r) => [r.kind, r.note])).toEqual([["alert-idle", "replaced by #2"], ["alert-idle", "expired"], ["levelup", "expired"], ["trigger", null], ["stall", "condition cleared"]]);
});

test("a parked tab clears the items it had", () => {
  const db = openDb(":memory:");
  raiseItem(db, { severity: "act", kind: "stall", session: "Tagu", key: "stall:Tagu", text: "idle" });
  const res: Result = stepSession({ state: {}, obs: ok(snap({ autoLevel: { running: false }, bot: bot({ enabled: false }) })), now: T0, label: "Tagu" });
  syncAttention(db, { label: "Tagu", res, now: T0 });
  const row = db.query("SELECT note FROM attention").get() as { note: string };
  expect(row.note).toBe("tab is parked");
});

test("items of a label no tab shows close: a condition at once, an event after its time to live, a decision never", () => {
  const db = openDb(":memory:");
  const notes = () => (db.query("SELECT session, kind, note FROM attention ORDER BY id").all() as { session: string; kind: string; note: string | null }[]).map((r) => [r.session, r.kind, r.note]);
  raiseItem(db, { t: T0, severity: "act", kind: "stall", session: "Gone", key: "stall:Gone", text: "idle" });
  raiseItem(db, { t: T0, severity: "info", kind: "levelup", session: "Gone", key: "levelup:1:12", text: "reached level 12" });
  raiseItem(db, { t: T0, severity: "act", kind: "alert-task", session: "Gone", key: "alert-task:1:2", text: "quest failed" });
  raiseItem(db, { t: T0, severity: "decide", kind: "trigger", session: "Gone", key: "trigger:1:46", text: "reached level 46" });
  // A label a tab shows stays with syncAttention.
  raiseItem(db, { t: T0, severity: "info", kind: "levelup", session: "Tagu", key: "levelup:2:30", text: "reached level 30" });
  sweepOrphans(db, ["Tagu"], T0 + 11 * 60 * SEC);
  expect(notes()).toEqual([["Gone", "stall", "no tab shows this label"], ["Gone", "levelup", "expired"], ["Gone", "alert-task", null], ["Gone", "trigger", null], ["Tagu", "levelup", null]]);
  sweepOrphans(db, ["Tagu"], T0 + 61 * 60 * SEC);
  expect(notes()[2]).toEqual(["Gone", "alert-task", "expired"]);
});

test("status lists what needs a person, counts what a mechanism handles, and stays within 40 lines", () => {
  const db = openDb(":memory:");
  // Deaths and a young stall are handled without anyone, and a stall of eleven minutes is not.
  raiseItem(db, { t: T0 - 11 * 60000, severity: "act", kind: "stall", session: "Edro", key: "stall:b", text: "no kill for 15 min" });
  raiseItem(db, { t: T0 - 60000, severity: "act", kind: "stall", session: "Tagu", key: "stall:a", text: "no kill for 5 min" });
  for (let i = 0; i < 3; i++) raiseItem(db, { t: T0, severity: "act", kind: "death", session: "Tagu", key: `death:${i}`, text: `character ${i} was slain` });
  for (let i = 0; i < 30; i++) raiseItem(db, { t: T0, severity: "act", kind: "alert-bags", session: "Tagu", key: `bags:${i}`, text: `bag ${i} holds only kept items` });
  const text = renderStatus(db, T0);
  expect(text.split("\n").length).toBeLessThanOrEqual(40);
  expect(text).toContain("Needs you (31), handled without you: 3 deaths, 1 stalls");
  expect(text).toContain("no kill for 15 min");
  expect(text).not.toContain("was slain");
  expect(text).toContain("and 23 more");
});

test("a later finished task settles a failed one, and playing again settles an idle alert", () => {
  const db = openDb(":memory:");
  const notes = () => (db.query("SELECT kind, note FROM attention ORDER BY id").all() as { kind: string; note: string | null }[]).map((r) => [r.kind, r.note]);
  raiseItem(db, { t: T0, severity: "act", kind: "alert-task", session: "Tagu", key: "alert-task:111:3", text: "quest failed" });
  raiseItem(db, { t: T0, severity: "act", kind: "alert-idle", session: "Tagu", key: "alert-idle:111:4", text: "idle (crowded)" });
  const at = (s: Snap, now: number) => syncAttention(db, { label: "Tagu", res: stepSession({ state: {}, obs: ok(s), now, label: "Tagu" }), now });
  // Still idle and the failed task is the last one: nothing settles.
  at(snap({ activity: { act: "idle", why: "crowded", since: T0 - 5 * SEC }, bot: bot({ task: { status: "failed", endedAt: T0 - SEC } }) }), T0 + 60 * SEC);
  expect(notes()).toEqual([["alert-task", null], ["alert-idle", null]]);
  at(snap({ activity: { act: "fight", why: null, since: T0 + 90 * SEC }, bot: bot({ task: { status: "done", endedAt: T0 + 80 * SEC } }) }), T0 + 120 * SEC);
  expect(notes()).toEqual([["alert-task", "a later task finished"], ["alert-idle", "the tab plays again"]]);
});

test("a task running past an hour under its bot pause raises a long-task item, a shorter one does not", () => {
  const tasked = (startedAt: number) => ok(snap({ kills: { last: T0 }, bot: { enabled: true, pauseUntil: T0 + 7200 * SEC, task: { kind: "quest", status: "running", step: "wait for Anson McBale", startedAt }, alerts: [] } }));
  expect(kinds(run(() => tasked(T0 - 59 * 60 * SEC), 1, 30))).toEqual([]);
  const res = run(() => tasked(T0 - 61 * 60 * SEC), 1, 30);
  expect(kinds(res)).toEqual(["longtask"]);
  expect(res.items[0].text).toContain("wait for Anson McBale");
});

const collector = (over: Record<string, unknown> = {}) => Object.assign(new Daemon({
  db: openDb(":memory:"), relay: { connected: true, tabs: () => new Map() }, runs: "", intervalSec: 30, log: () => {},
}), over);
const meta = (db: Database, key: string, value?: unknown) => {
  if (value !== undefined) db.query("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").run(key, JSON.stringify(value));
  return JSON.parse(db.query("SELECT v FROM meta WHERE k = ?").get(key)?.v ?? "null");
};
// Only the streams and exit promise are used by the collector's subprocess boundary.
const processResult = (code: number, out = "", error = "") => ({
  stdout: new Blob([out]).stream(), stderr: new Blob([error]).stream(), exited: Promise.resolve(code),
}) as unknown as Subprocess;

test("sessionless client attention survives orphan sweeps", () => {
  const d = collector();
  const id = raiseItem(d.db, { t: T0, kind: "client", severity: "act", key: "client:release", text: "missing store" });
  sweepOrphans(d.db, [], T0 + 2 * 3600000);
  expect(d.db.query("SELECT resolved FROM attention WHERE id = ?").get(id).resolved).toBeNull();
});

test("saving a pass keeps outcomes recorded by intervening cycles and taskless failures", () => {
  const d = collector();
  const h = { t: T0, label: "A", kind: "hunt", id: "piece", task: 1 };
  meta(d.db, "coordinator", { history: [{ ...h, status: "done", endedAt: T0 + SEC, kills: 2 }], extra: 7 });
  const failure = { t: T0 + 2 * SEC, label: "B", kind: "quest", id: "q", task: null, status: "failed", error: "not queued" };
  const state = { history: [h, failure], experiments: { running: {} }, last: { t: T0 } };
  d.saveCoordinator(state, 2000);
  const saved = meta(d.db, "coordinator");
  expect(saved.history).toEqual([{ ...h, status: "done", endedAt: T0 + SEC, kills: 2 }, failure]);
  expect(saved.extra).toBe(7);
  expect(saved.passMs).toBe(2000);
  expect(settleHistory(saved.history, [{ id: 2, status: "done" }])).toBe(false);
  expect(saved.history[1]).toEqual(failure);
});

test("chain loot progress stops at the missing copies, including loot not written yet", () => {
  const d = collector({ targetWants: [] });
  d.recordPassProgress(T0, {
    quests: { q: { class: "Ranger", reward: "Sword", needs: ["Piece"], ids: { Piece: 21 } } },
    opportunities: [], missing: {}, lacking: { 21: 2 }, doneItems: () => [], progressItems: () => [],
    chainsBefore: [], chains: [], aaBefore: {}, aa: {},
  });
  expect(d.itemFor("Piece", 0)?.piece).toBe(true);
  expect(d.itemFor("Piece", 1)?.piece).toBe(true);
  expect(d.itemFor("Piece", 2)).toBeNull();
  d.db.query("INSERT INTO progress (t, kind, sig, item, text, key) VALUES (?, 'item', 1, 'Piece', '', 'loot')").run(T0 + SEC);
  expect(d.itemFor("Piece", 1)).toBeNull();
  delete d.pieceFor;
  expect(d.itemFor("Piece", 0)?.piece).toBe(true);
  expect(d.itemFor("Piece", 1)).toBeNull();
});

test("an unusable poll marks the tracker without reusing the old snapshot", async () => {
  const d = collector({ relay: { connected: true, tabs: () => new Map([["tab", {}]]), evaluate: async () => ({ hasBridge: false }) } });
  const old = snap();
  const tr = { targetId: "tab", rowId: null, label: "A", state: {}, usable: true, snap: old };
  d.applyItems = () => {};
  await d.poll(tr, T0, []);
  expect(tr.usable).toBe(false);
  expect(tr.snap).toBe(old);
});

test("an install without deploy state never evaluates page code", async () => {
  let calls = 0;
  const d = collector({ relay: { evaluate: async () => { calls++; } } });
  await d.pageAction({ targetId: "tab", label: "A" }, { kind: "install", why: "missing bridge" }, T0);
  expect(calls).toBe(0);
});

test("Inventory Search preserves item ids for same-name pieces", async () => {
  // The in-page function needs only this fixture, not a DOM implementation.
  const host = globalThis as unknown as { window: unknown };
  const previous = host.window;
  host.window = { iq: {
    stores: { character: { getState: () => ({ characterProfile: { id: 1, stateSessionId: 2 } }) } },
    query: async () => ({ matches: [{ itemId: 16545, itemName: "Shovel", characterName: "A", quantity: 1 }, { itemId: 99, itemName: "Shovel", characterName: "B", quantity: 2 }] }),
  } };
  try {
    expect((await searchInPage({ q: "Shovel" })).map((r: { itemId: number; n: number }) => [r.itemId, r.n])).toEqual([[16545, 1], [99, 2]]);
  } finally {
    host.window = previous;
  }
});

test("unserved releases are recorded and checker crashes are throttled without recording success", async () => {
  const d = collector({ trackers: new Map([["tab", { snap: { release: "__iqd_unserved_fixture__" } }]]) });
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => processResult(0));
  try {
    await d.checkRelease(T0);
    expect(meta(d.db, "clientChecks").__iqd_unserved_fixture__.unserved).toBe(true);
    // This resolves to the repository, which exists, without creating a release fixture there.
    d.trackers = new Map([["tab", { snap: { release: "../.." } }]]);
    spawn.mockImplementation((args) => processResult(Array.isArray(args) && args[1] === "tools/check-client.mjs" ? 1 : 0, "", "fixture crash"));
    await d.checkRelease(T0);
    expect(meta(d.db, "clientChecks")["../.."]).toBeUndefined();
    const calls = spawn.mock.calls.length;
    await d.checkRelease(T0 + 3599999);
    expect(spawn.mock.calls.length).toBe(calls);
    await d.checkRelease(T0 + 3600000);
    expect(spawn.mock.calls.length).toBe(calls + 2);
  } finally {
    spawn.mockRestore();
  }
});

test("kill odds retain a complete file through a partial rewrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iqd-odds-"));
  const d = collector({ runs: dir });
  try {
    await mkdir(join(dir, "state"));
    await writeFile(join(dir, "state/kill-odds.json"), JSON.stringify({ t: T0, odds: { boss: {} } }));
    const good = await d.killOdds(T0);
    await writeFile(join(dir, "state/kill-odds.json"), '{"t":');
    expect(await d.killOdds(T0 + SEC)).toBe(good);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kill odds failures back off, report stderr and raise attention until success", async () => {
  const logs: string[] = [];
  const d = collector({ odds: null, log: (s: string) => logs.push(s) });
  const clock = spyOn(Date, "now").mockReturnValue(T0);
  let exit = 1;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => processResult(exit, "", "fixture error"));
  const finish = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  try {
    await d.killOdds(T0);
    await finish();
    expect(d.oddsRetryAt).toBe(T0 + 1800000);
    await d.killOdds(T0 + 1799999);
    expect(spawn.mock.calls.length).toBe(1);
    clock.mockReturnValue(T0 + 1800000);
    await d.killOdds(T0 + 1800000);
    await finish();
    expect(d.db.query("SELECT kind, severity, resolved FROM attention").get()).toEqual({ kind: "odds", severity: "act", resolved: null });
    expect(logs.some((s) => s.includes("fixture error"))).toBe(true);
    exit = 0;
    clock.mockReturnValue(T0 + 3600000);
    await d.killOdds(T0 + 3600000);
    await finish();
    expect(d.db.query("SELECT resolved FROM attention").get().resolved).toBe(T0 + 3600000);
  } finally {
    clock.mockRestore();
    spawn.mockRestore();
  }
});

test("gear surveys skip running gear, retry search and reject a crashed group report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iqd-gear-"));
  const called: string[] = [];
  const trackers = new Map(["a", "b"].map((id) => [id, { targetId: id, label: id, usable: true, state: {}, snap: { leader: {}, bot: { task: { kind: "gear", status: "running" } } } }]));
  const d = collector({ runs: dir, trackers, shop: [], items: new Map(), itemModel: { epics: {} }, killsPerHour: { g1: 100 }, relay: { evaluate: async (id: string, expression: string) => {
    called.push(expression);
    if (expression.includes("inventoryInPage")) throw new Error("must not read running gear");
    if (id === "a") throw new Error("page reloaded");
    return expression.includes("startJobInPage") ? 1 : { done: true, ok: true, result: { rows: [] } };
  } } });
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => processResult(1, "", "groups crash"));
  // Polling is immediate in this fixture and does not wait on the wall clock.
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
  try {
    await mkdir(join(dir, "state"));
    await expect(d.gearPass(T0, [{ targetId: "a", label: "a" }, { targetId: "b", label: "b" }])).rejects.toThrow("groups crash");
    expect(called.some((s) => s.includes("inventoryInPage"))).toBe(false);
    expect(called.filter((s) => s.includes("startJobInPage")).length).toBe(2);
    expect(d.killsPerHour).toEqual({ g1: 100 });
    expect(meta(d.db, "gear").next).toBe(T0 + 600000);
    expect(meta(d.db, "gearPlan")).toBeNull();
  } finally {
    timer.mockRestore();
    spawn.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("epic targets keep separate rewards and the pieces other needers still lack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iqd-epics-"));
  const survey = [
    { characterName: "R1", characterId: 1, itemId: 10, itemInstanceId: "reward", location: "Carried" },
    { characterName: "R1", characterId: 1, itemId: 21, itemInstanceId: "piece", location: "Carried" },
  ];
  const d = collector({
    runs: dir, shop: [], drops: [], items: new Map([10, 11, 21, 22].map((id) => [id, { id, Name: `Item${id}` }])),
    itemModel: { epics: { Ranger: [10, 11] }, epicNeeds: new Map(), pieces: new Map([[10, []], [11, [{ itemId: 21 }, { itemId: 22 }]]]), names: new Map([[21, "Piece21"], [22, "Piece22"]]) },
    trackers: new Map([["tab", { usable: true, state: {}, snap: {} }]]),
    relay: { evaluate: async (_id: string, expression: string) => expression.includes("startJobInPage") ? 1 : { done: true, ok: true, result: { rows: survey } } },
  });
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => processResult(0, "[]"));
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
  const people = spyOn(gearPlan, "rosterPeople").mockReturnValue([{ name: "R1", cls: "ranger" }, { name: "R2", cls: "ranger" }]);
  let epics: { rewardId: number; to: string; pieces: { itemId: number }[] }[] = [];
  const plan = spyOn(gearPlan, "planGear").mockImplementation((input) => { epics = input.epics; throw new Error("captured plan"); });
  try {
    await mkdir(join(dir, "state"));
    await expect(d.gearPass(T0, [{ targetId: "tab" }])).rejects.toThrow("captured plan");
    expect(epics).toEqual([
      { rewardId: 11, to: "R1", pieces: [{ itemId: 22, name: "Piece22" }] },
      { rewardId: 11, to: "R2", pieces: [{ itemId: 21, name: "Piece21" }, { itemId: 22, name: "Piece22" }] },
    ]);
  } finally {
    plan.mockRestore();
    people.mockRestore();
    timer.mockRestore();
    spawn.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("boss planning ignores stale raids and holds looks and retries with each tab's code", async () => {
  const d = collector({
    runs: "/__iqd_fixture_missing__", code: "fleet", targetWants: [], itemModel: { bosses: [] },
    relay: { evaluate: async () => ({ daily: { resetsRemaining: 2, bosses: [{ key: "boss", name: "Boss", zone: "z", status: "available" }] }, time: null }) },
    trackers: new Map([["gone", { usable: false, state: {}, snap: { raid: true } }]]),
    bossSpawns: { key: "Boss", spawns: new Map([["Boss", [{ zone: "z", respawnMs: 3600000 }]]]) },
  });
  d.raidGoal = () => ["Boss"];
  const tabs = [{ targetId: "tab", label: "A", group: "g1", code: "canary", members: [{ name: "A", level: 50 }] }];
  const groupOf = new Map([["A", "g1"]]);
  const odds = { strongest: "g1", odds: { boss: { raid: { kills: 1, fights: 1 } } } };
  expect((await d.bossPass(T0, tabs, [], groupOf, odds))?.kind).toBe("raid");
  const failed = { t: T0 - 600000, endedAt: T0 - 600000, label: "A", kind: "raid", id: "boss:summon:boss", status: "failed", code: "canary" };
  expect(await d.bossPass(T0, tabs, [], groupOf, odds, {}, [failed])).toBeNull();
  expect(meta(d.db, "bossPlan").look).toBeNull();
  expect(await d.bossPass(T0, tabs, [], groupOf, odds, {}, [{ ...failed, step: "fight Boss", result: "wiped in z" }])).toBeNull();
  expect(meta(d.db, "bossPlan").look).toBeNull();
});

test("a boss whose respawn has passed gets a look while no hour of raid time can be bought", async () => {
  // Lord Nagafen on 2026-11-13: off the goal, his respawn eight hours past, no raid time running.
  const d = collector({
    runs: "/__iqd_fixture_missing__", targetWants: [], itemModel: { bosses: [] },
    relay: { evaluate: async () => ({ daily: { resetsRemaining: 0, bosses: [{ key: "boss", name: "Boss", zone: "z", status: "limit" }] }, time: { active: false, pricePp: 10000 } }) },
    bossSpawns: { key: "Boss", spawns: new Map([["Boss", [{ zone: "z", respawnMs: 3600000 }]]]) },
  });
  d.raidGoal = () => [];
  meta(d.db, "bossesSeen", { boss: { name: "Boss", zone: "z", state: "respawning", respawnAt: T0 - 3600000, seenAt: T0 - 7200000 } });
  const tabs = [{ targetId: "a", label: "A", group: "g1", members: [{ name: "A", level: 50 }] }, { targetId: "b", label: "B", group: "g2", members: [{ name: "B", level: 50 }] }];
  const groupOf = new Map([["A", "g1"], ["B", "g2"]]);
  const odds = { strongest: "g1", odds: { boss: { raid: { kills: 1, fights: 1 } } } };
  expect(await d.bossPass(T0, tabs, [], groupOf, odds)).toMatchObject({ label: "B", kind: "look", id: "look:boss", spec: { zone: "z", name: "Boss" } });
  expect(meta(d.db, "bossPlan").watch[0]).toMatchObject({ key: "boss", state: "due" });
  // With every other tab on a task, the plan says what the look waits for.
  const busy = [tabs[0], { ...tabs[1], task: { status: "running", kind: "hunt" } }];
  expect(await d.bossPass(T0, busy, [], groupOf, odds)).toBeNull();
  expect(meta(d.db, "bossPlan").look).toMatchObject({ key: "boss", waits: expect.any(String) });
});

test("a standing casino boss gets three fights, then the twelve-hour loss hold", async () => {
  const boss = { key: "boss", name: "Boss", zone: "z", itemId: 99 };
  const d = collector({
    runs: "/__iqd_fixture_missing__", targetWants: [], itemModel: { bosses: [boss] },
    relay: { evaluate: async () => ({ daily: { resetsRemaining: 0, bosses: [] }, time: null }) },
    bossSpawns: { key: "Boss", spawns: new Map([["Boss", [{ zone: "z", respawnMs: 3600000 }]]]) },
  });
  d.raidGoal = () => ["Boss"];
  const tabs = [{ targetId: "tab", label: "A", group: "g1", members: [{ name: "A", level: 50 }] }];
  const groupOf = new Map([["A", "g1"]]);
  const odds = { strongest: "g1", odds: { boss: { raid: { kills: 1, fights: 1 } } } };
  const history = [3, 2, 1].map((n) => ({ t: T0 - n * 60000, endedAt: T0 - n * 60000, label: "A", kind: "raid", id: "boss:potion:99:A", status: "failed", step: "fight Boss", result: "wiped in z" }));
  expect((await d.bossPass(T0, tabs, [], groupOf, odds, {}, history.slice(0, 2)))?.kind).toBe("raid");
  expect(await d.bossPass(T0, tabs, [], groupOf, odds, {}, history)).toBeNull();
});

test("queued tasks use queue time and tab code, failures persist, and only queued gear leaves the plan", async () => {
  const a = { item: "A" }, b = { item: "B" }, held = { item: "Held" };
  let time = T0;
  let firstSearch = true;
  let fallback = false;
  const trackers = new Map(["a", "b"].map((id) => [id, {
    targetId: id, label: id, usable: true, state: {}, snap: { leader: { name: id, level: 50 }, bot: { enabled: true } },
  }]));
  const d = collector({
    coordinate: true, runs: "/__iqd_fixture_missing__", xpEvents: {}, trackers, pendingGear: { moves: [a, b, held] },
    itemModel: { chains: {}, epics: {}, epicNeeds: new Map(), names: new Map(), ids: new Map(), branches: [], bosses: [] },
    relay: { evaluate: async (id: string, expression: string) => {
      if (expression.includes("searchInPage")) {
        if (firstSearch) { firstSearch = false; throw new Error("reloaded"); }
        if (id === "b") fallback = true;
        return [];
      }
      if (expression.includes("queueInPage")) {
        time += 180000;
        if (id === "b") throw new Error("could not move");
        return { id: expression.includes('"kind":"gear"') ? 1 : null };
      }
      return [];
    } },
  });
  d.codeOf = (tr: { targetId: string }) => tr.targetId === "a" ? "canary" : "fleet";
  d.experimentPass = async (_now: number, _tabs: unknown, state: { experiments?: unknown }) => { state.experiments = { running: { fixture: {} } }; return []; };
  d.loadRates = async () => ({});
  d.gearPass = async () => null;
  d.bossPass = async () => null;
  d.killOdds = async () => null;
  d.predictedRates = async () => { throw new Error("zone fixture failure"); };
  const decide = spyOn(coordinator, "decide").mockReturnValue({ actions: [
    { label: "a", kind: "gear", spec: { moves: [a] }, why: "" },
    { label: "b", kind: "gear", spec: { moves: [b] }, why: "" },
    { label: "a", kind: "errand", id: "errand", spec: {}, why: "" },
  ], targets: {} });
  const points = spyOn(content, "spawnPoints").mockImplementation(async (entries) => entries.map(() => []));
  const clock = spyOn(Date, "now").mockImplementation(() => time);
  try {
    await expect(d.coordinatePass(T0)).rejects.toThrow("zone fixture failure");
    const state = meta(d.db, "coordinator");
    expect(fallback).toBe(true);
    expect(state.experiments.running.fixture).toEqual({});
    expect(state.history.map((h: { t: number; code: string; status?: string; task: number | null }) => [h.t, h.code, h.status ?? null, h.task])).toEqual([
      [T0 + 180000, "canary", null, 1],
      [T0 + 360000, "fleet", "failed", null],
      [T0 + 540000, "canary", null, null],
    ]);
    expect(state.history[1].error).toBe("could not move");
    expect(d.pendingGear.moves).toEqual([b, held]);
    expect(coordinator.settleErrands(state.history, [{ label: "a", errand: { since: T0 + 540000 } }], T0 + 900000)).toBe(false);
  } finally {
    clock.mockRestore();
    points.mockRestore();
    decide.mockRestore();
  }
});

test("cycles drop never-usable vanished tabs and clear the active part even on failure", async () => {
  const d = collector({
    runs: "/__iqd_fixture_missing__",
    trackers: new Map([["missing", { rowId: null, targetId: "missing", label: "tab:missing", state: {} }]]),
  });
  d.triggers = async () => [];
  d.recordOutcomes = async () => {};
  d.checkRelease = async () => {};
  d.coordinatePass = async () => {};
  const clock = spyOn(Date, "now").mockReturnValue(T0);
  try {
    await expect(d.cycle()).rejects.toThrow();
    expect(d.trackers.size).toBe(0);
    expect(d.part).toBeNull();
  } finally {
    clock.mockRestore();
  }
});

test("a tab that was busy does not count against the task it refused", () => {
  // The bot's refusals (`takeTab` and `errand` in src/bot.js), as the relay hands them on.
  expect(tabWasBusy("Error: the tab is paused for upkeep (level or spells changed)")).toBe(true);
  expect(tabWasBusy("Error: the hunt task is still running")).toBe(true);
  expect(tabWasBusy("Error: the errand in velketor is still running")).toBe(true);
  expect(tabWasBusy("Error: could not move to velketor")).toBe(false);
  expect(tabWasBusy("Error: Tagujazolu is not a character on this account")).toBe(false);
});
