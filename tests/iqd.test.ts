// Checks the attention rules of tools/iqd.mjs on fixture snapshots. No browser, no relay, no clock.
// Run with `bun test`.
import { expect, test } from "bun:test";
import { openDb, raiseItem, renderStatus, resolveItem, stepSession, syncAttention, THRESHOLDS } from "../tools/iqd.mjs";

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

test("AutoLevel off for three minutes raises once the limit is reached", () => {
  const off = ok(snap({ autoLevel: { running: false } }));
  expect(kinds(run(() => off, 1, 30))).toEqual([]);
  expect(kinds(run(() => off, 6, 30))).toEqual([]); // 150 s
  expect(kinds(run(() => off, 7, 30))).toEqual(["autolevel-off"]); // 180 s
});

test("AutoLevel off during a pause, a raid or an errand raises nothing", () => {
  const overrides: Snap[] = [{ raid: true }, { bot: bot({ pauseUntil: T0 + 3600 * SEC }) }, { bot: bot({ errand: { zone: "x", item: "y" } }) }];
  for (const over of overrides) {
    const off = ok(snap({ autoLevel: { running: false }, ...over }));
    expect(kinds(run(() => off, 20, 30))).toEqual([]);
  }
});

test("when a pause ends the three minutes start again", () => {
  const paused = ok(snap({ autoLevel: { running: false }, bot: bot({ pauseUntil: T0 + 300 * SEC }) }));
  // Five minutes paused, then 30 s off without a pause.
  expect(kinds(run(() => paused, 12, 30))).toEqual([]);
});

test("no kill for ten minutes while running raises, a fresh kill does not", () => {
  const stale = ok(snap({ kills: { last: T0 - 11 * 60 * SEC } }));
  expect(kinds(run(() => stale, 1, 30))).toEqual([]); // counted from the first look
  expect(kinds(run(() => stale, 20, 30))).toEqual([]); // 570 s
  expect(kinds(run(() => stale, 21, 30))).toEqual(["nokill"]); // 600 s
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

  for (let i = 0; i < 12; i++) step(i, snap({ autoLevel: { running: false } })); // 330 s off: one item, not five
  expect(rows().map((r) => r.kind)).toEqual(["autolevel-off"]);
  step(12, snap()); // AutoLevel runs again
  expect(rows()[0].resolved).not.toBeNull();
  expect(rows()[0].note).toBe("condition cleared");

  // Events stay open until someone resolves them, and a resolved key can be raised again.
  const death = { severity: "act", kind: "death", session: "Tagu", key: "death:111:4", text: "You have been slain" };
  const id = raiseItem(db, death) as number;
  expect(id).toBeGreaterThan(0);
  expect(raiseItem(db, death)).toBeNull();
  step(13, snap());
  expect(rows().find((r) => r.id === id)?.resolved).toBeNull();
  expect(resolveItem(db, id, "read")).toBe(true);
  expect(raiseItem(db, death)).not.toBeNull();
});

test("a parked tab clears the items it had", () => {
  const db = openDb(":memory:");
  raiseItem(db, { severity: "act", kind: "autolevel-off", session: "Tagu", key: "autolevel-off:Tagu", text: "off" });
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
  expect(THRESHOLDS.goneSec).toBe(60);
});
