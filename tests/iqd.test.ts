// Checks the attention rules of tools/iqd.mjs on fixture snapshots. No browser, no relay, no clock.
// Run with `bun test`.
import { expect, test } from "bun:test";
import { lootlessKills, openDb, raiseItem, recycleReason, renderStatus, resolveItem, stepSession, syncAttention } from "../tools/iqd.mjs";

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
  ];
  const res = run(() => ok(snap({ bot: bot({ alerts }) })), 1, 30);
  expect(res.items.map((i) => [i.severity, i.kind, i.text])).toEqual([
    ["act", "death", "You have been slain by a goblin"],
    ["act", "alert-lootFull", "3 item(s) left on corpses"],
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

test("status stays within 40 lines with many open items", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 30; i++) raiseItem(db, { severity: "act", kind: "death", session: "Tagu", key: `death:${i}`, text: `character ${i} was slain` });
  const text = renderStatus(db, T0);
  expect(text.split("\n").length).toBeLessThanOrEqual(40);
  expect(text).toContain("and 22 more");
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

test("a page reloads once its heap floor over ten minutes reaches half the limit, and only at a quiet moment", () => {
  const snap = { heap: { used: 2400, limit: 4000 }, conn: { worldReady: true, inCombat: false, zoneLoading: false }, raid: false, bot: { task: null } };
  // Readings every 30 s for 12 minutes that saw between `low` and 2600 MB.
  const log = (low: number, min = 12) => Array.from({ length: 2 * min + 1 }, (_, k) => ({ t: T0 - (min * 60 - 30 * k) * SEC, used: k % 4 === 0 ? low : 2600 }));
  expect(recycleReason({ log: log(2100), snap, now: T0 })).toContain("above 2100 of 4000 MB");
  // One collection down to 1900 within the window keeps the page: the floor is below half.
  expect(recycleReason({ log: log(1900), snap, now: T0 })).toBeNull();
  // A page that loaded under ten minutes ago has no full window yet.
  expect(recycleReason({ log: log(2100, 9), snap, now: T0 })).toBeNull();
  // A running task, a fight, a raid or a zone load waits for a later reading.
  for (const busy of [{ bot: { task: { status: "running" } } }, { conn: { ...snap.conn, inCombat: true } }, { raid: true }, { conn: { ...snap.conn, zoneLoading: true } }]) {
    expect(recycleReason({ log: log(2100), snap: { ...snap, ...busy }, now: T0 })).toBeNull();
  }
});

test("a page reloads after 25 kills in a row without a loot line, and the count ends only at a loot line", () => {
  const kill = { type: "EXPERIENCE_GAIN", text: "You have defeated a gnomish miner and gained 19130 experience!" };
  // A client without its loot messages still shows that items stayed on the corpse.
  const remain = { type: "LOOT", text: "Uncollected items remain on the corpse. Make room and loot it manually." };
  expect(lootlessKills(20, [kill, remain, kill])).toBe(22);
  expect(lootlessKills(20, [kill, { type: "LOOT", text: "You loot 7 gold, 2 silver!" }, kill])).toBe(1);
  const snap = { heap: { used: 900, limit: 4000 }, conn: { worldReady: true, inCombat: false, zoneLoading: false }, raid: false, bot: { task: null } };
  expect(recycleReason({ log: [], lootless: 24, snap, now: T0 })).toBeNull();
  expect(recycleReason({ log: [], lootless: 25, snap, now: T0 })).toContain("25 kills brought no loot line");
  // It waits for a quiet moment like the heap reason.
  expect(recycleReason({ log: [], lootless: 30, snap: { ...snap, conn: { ...snap.conn, inCombat: true } }, now: T0 })).toBeNull();
});
