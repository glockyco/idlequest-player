// Checks the dashboard's views of the collector database (tools/lib/dashboard.mjs) on an in-memory
// database. Run with `bun test`.
import { expect, test } from "bun:test";
import { openDb } from "../tools/iqd.mjs";
import { aaView, coordinatorView, dayStart, engineeringView, epicsView, gearSheetView, gearView, groupRowsView, hourlyView, makeCatalog, minuteTotals, nameIds, needsYouView, retryAt, rosterView, statusView, taskName, taskView, xpRate } from "../tools/lib/dashboard.mjs";
import { xpStart } from "../tools/lib/xp.mjs";

const H = 3600000;

test("engineering rates divide by group-hours of unparked sessions, split at local midnight", () => {
  const db = openDb(":memory:");
  const today = dayStart(Date.now());
  const now = today + 12 * H;
  const session = db.query("INSERT INTO sessions (target_id, page_session, first_seen, last_seen, parked) VALUES (?, ?, ?, ?, ?)");
  session.run("a", 1, today - 2 * H, today + 2 * H, 0); // two hours each side of midnight
  session.run("b", 2, today + H, today + 3 * H, 1); // parked: not play time
  const note = db.query("INSERT INTO interventions (t, actor, text) VALUES (?, ?, ?)");
  note.run(today + H, "sdk", "errand");
  note.run(today + H, "bot", "restart"); // the bot's own actions are not manual
  db.query("INSERT INTO attention (t, severity, kind, dedupe, text, resolved) VALUES (?, 'act', 'stall', 'k1', 'x', ?)").run(today + H, today + H + 6 * 60000);
  const days = engineeringView(db, now, 14);
  expect(days.map((d) => d.day)).toEqual([today - 86400000, today]);
  const [yesterday, day] = days;
  expect(yesterday.groupHours).toBeCloseTo(2);
  expect(day.groupHours).toBeCloseTo(2);
  expect(day.interventionsPerGroupHour).toBeCloseTo(0.5);
  expect(day.stallsPerGroupHour).toBeCloseTo(0.5);
  expect(day.stallMinutes).toBeCloseTo(6);
  expect(yesterday.interventions).toBe(0);
});

test("roster progress counts XP with race and class factors, and members never seen count as nothing", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  db.query("INSERT INTO characters (id, name, class, race, first_seen, last_seen) VALUES (1, 'Tank', 'Warrior', 'Troll', ?, ?)").run(now, now);
  db.query("INSERT INTO char_snapshots (char_id, t, level, xp_pct) VALUES (1, ?, 59, 0), (1, ?, 60, 0)").run(now - 1000, now);
  const view = rosterView(db, { groups: [{ id: "G1", members: ["Tank", "Unseen"] }] }, 60);
  expect(view.atTarget).toBe(1);
  expect(view.minLevel).toBe(60);
  // Troll Warrior needs 1.2 x 0.9 of the XP, the unseen member counts at factor 1 with none of it.
  const need = xpStart(60) * 1.08 + xpStart(60);
  expect(view.progress).toBeCloseTo((xpStart(60) * 1.08) / need);
});

const item = (id: number, over: Record<string, unknown>) => ({ id, t: 0, severity: "act", kind: "alert-task", session: "Tank", text: `item ${id}`, ...over });

test("needs-you keeps decisions, bags, sign-ins, unknown kinds and stalls older than ten minutes", () => {
  const now = 100 * 60000;
  const open = [
    item(1, { severity: "decide", kind: "trigger", t: now - 1000 }),
    item(2, { kind: "alert-bags", t: now - 1000 }),
    item(3, { kind: "stall", t: now - 11 * 60000 }),
    item(4, { kind: "stall", session: "Other", t: now - 5 * 60000 }),
    item(5, { kind: "alert-task" }),
    item(6, { kind: "alert-task" }),
    item(7, { kind: "alert-cursor" }),
    item(8, { kind: "alert-offline", t: now - 2000 }),
    item(9, { kind: "invented-kind", t: now - 2000 }),
    item(10, { severity: "info", kind: "levelup" }),
  ];
  const view = needsYouView(open, now, new Map([["Tank", "G1"]]));
  // A decision comes first, then the others from the oldest.
  expect(view.needs.map((n) => n.id)).toEqual([1, 3, 8, 9, 2]);
  expect(view.needs[1]).toMatchObject({ group: "G1", label: "stalls", ageMs: 11 * 60000 });
  expect(view.handledTotal).toBe(4);
  expect(view.handled.map((h) => [h.kind, h.n])).toEqual([["alert-task", 2], ["stall", 1], ["alert-cursor", 1]]);
});

/** A session row of a group's leader with the snapshot fields the dashboard reads. */
function addSession(db: ReturnType<typeof openDb>, leader: string, now: number, snap: Record<string, unknown>, state: Record<string, unknown> = {}) {
  db.query("INSERT INTO sessions (target_id, page_session, leader, first_seen, last_seen, snap, state) VALUES (?, 1, ?, ?, ?, ?, ?)").run(`t-${leader}`, leader, now - 3600000, now - 5000, JSON.stringify(snap), JSON.stringify(state));
}

test("group rows give every roster group one row with its activity, idle share, task and details", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  for (const [id, name, cls] of [[1, "Tank", "Warrior"], [2, "Healer", "Cleric"], [3, "Solo", "Wizard"]] as const) {
    db.query("INSERT INTO characters (id, name, class, race, first_seen, last_seen) VALUES (?, ?, ?, 'Human', ?, ?)").run(id, name, cls, now, now);
    db.query("INSERT INTO char_snapshots (char_id, t, level, xp_pct) VALUES (?, ?, ?, 50)").run(id, now - 1000, 30);
  }
  const roster = { groups: [{ id: "G1", members: ["Tank", "Healer"] }, { id: "G2", members: ["Solo"] }] };
  const leader = { name: "Tank", level: 30, class: "Warrior", xpPct: 50 };
  addSession(db, "Tank", now, {
    leader,
    party: [{ type: 2, name: "Healer", level: 29, class: "Cleric" }],
    zone: "The City of Guk",
    activity: { act: "idle", why: "noTarget", since: now - 40000 },
    activitySec: { fight: 400, "idle/noTarget": 150, "idle/off": 50 },
    kills: { n30: 60, xp30: 3000000, winMs: 1800000, last: now - 20000 },
    heap: { used: 500, limit: 4000 },
    bags: { capacity: 64, free: 9, cursor: null },
    t: now,
    bot: { enabled: true, rotation: ["guktop", "paw"], crowdedAt: { paw: now - 120000, dalnir: now - 60000 }, task: { id: "hunt-1", kind: "hunt", status: "failed", step: "make room", error: "no free bag slot", startedAt: now - 300000, endedAt: now - 240000 } },
  });
  db.query("INSERT INTO meta (k, v) VALUES ('coordinator', ?)").run(JSON.stringify({ history: [{ t: now - 300000, label: "Tank", kind: "hunt", id: "gear-shimmering-orb", task: "hunt-1", ms: 60000, status: "failed", step: "make room", error: "no free bag slot" }] }));
  db.query("INSERT INTO interventions (t, session, actor, text) VALUES (?, 'Tank', 'coordinator', 'hunt: Shimmering Orb for G1')").run(now - 300000);
  const catalog = makeCatalog({ opportunities: [{ id: "gear-shimmering-orb", item: "Shimmering Orb", retryMin: 30 }], zones: { guktop: "The Upper Guk", paw: "Splitpaw" } });
  const rows = groupRowsView(db, now, { roster: rosterView(db, roster), groupOf: new Map([["Tank", "G1"], ["Healer", "G1"], ["Solo", "G2"]]), catalog, report: [{ group: "G1", idle: 0.2, idleCause: "crowded", waitedFor: "Healer:mana 100s" }] });

  expect(rows.map((r) => r.id)).toEqual(["G1", "G2"]);
  const [g1, g2] = rows;
  expect(g1.state).toMatchObject({ kind: "activity", act: "idle", why: "noTarget", forMs: 40000 });
  expect(g1).toMatchObject({ leader: "Tank", level: 30, partyMin: 29, partyMax: 30, zone: "The City of Guk", playing: true, stuck: false });
  expect(g1.xpPerHour).toBeCloseTo(6000000);
  // The last hour's report wins over the tab's own 10 minutes (25% idle, mostly noTarget).
  expect(g1).toMatchObject({ idleShare: 0.2, idleCause: "crowded", idleWindow: "hour", waitedFor: "Healer:mana 100s" });
  expect(g1.task).toMatchObject({ name: "Shimmering Orb", status: "failed", error: "no free bag slot" });
  // The retry comes thirty minutes after the hunt, so it is a quarter of an hour away.
  expect(g1.task.retryInMs).toBeCloseTo(-300000 + 30 * 60000, -3);
  expect(g1.details.rotation).toEqual([{ zone: "The Upper Guk", crowdedMs: null }, { zone: "Splitpaw", crowdedMs: 120000 }]);
  expect(g1.details.crowded).toEqual([{ zone: "dalnir", crowdedMs: 60000 }]);
  expect(g1.details.history[0]).toMatchObject({ name: "Shimmering Orb", outcome: { status: "failed" } });
  expect(g1.details.lines[0].text).toBe("hunt: Shimmering Orb for G1");
  // A group without a tab still has its row.
  expect(g2).toMatchObject({ id: "G2", leader: "Solo", hasTab: false, playing: false, state: { kind: "none" }, task: null });
  expect(g2.share).toBeGreaterThan(0);
});

test("the group row's own idle seconds stand in without a report, and a long idle stretch marks it stuck", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  db.query("INSERT INTO characters (id, name, class, race, first_seen, last_seen) VALUES (1, 'Tank', 'Warrior', 'Human', ?, ?)").run(now, now);
  addSession(db, "Tank", now, { leader: { name: "Tank", level: 10 }, activity: { act: "idle", why: "off", since: now - 200000 }, activitySec: { fight: 100, "idle/off": 80, "idle/noTarget": 20 }, t: now });
  const view = rosterView(db, { groups: [{ id: "G1", members: ["Tank"] }] });
  const [row] = groupRowsView(db, now, { roster: view, groupOf: new Map([["Tank", "G1"]]), catalog: makeCatalog() });
  expect(row).toMatchObject({ idleCause: "off", idleWindow: "10 minutes", stuck: true });
  expect(row.idleShare).toBeCloseTo(0.5);
});

test("coordinator ids become item, quest and target names", () => {
  const catalog = makeCatalog({
    opportunities: [{ id: "gear-loam-encrusted-pantaloons", item: "Loam Encrusted Pantaloons" }],
    quests: { "paladin-epic-note": { class: "Paladin", reward: "Sealed Note" } },
    targets: [{ zone: "dalnir", npc: "a coerced gnome", items: [{ item: "Sap of Piety" }, { item: "Gnome Hat" }] }],
    zones: { dalnir: "The Crypt of Dalnir" },
  });
  expect(taskName(catalog, "gear-loam-encrusted-pantaloons")).toBe("Loam Encrusted Pantaloons");
  expect(taskName(catalog, "paladin-epic-note")).toBe("Paladin quest for Sealed Note");
  expect(taskName(catalog, "target-dalnir-a-coerced-gnome")).toBe("a coerced gnome in The Crypt of Dalnir (Sap of Piety, Gnome Hat)");
  expect(nameIds(catalog, "quest: paladin-epic-note for A, B")).toBe("quest: Paladin quest for Sealed Note for A, B");
});

test("the status line turns amber and red at its thresholds and stays calm otherwise", () => {
  const now = 1000000;
  const row = (over: Record<string, unknown>) => ({ playing: true, xpPerHour: 1000000, idleShare: 0.02, details: { heap: { used: 500, limit: 4000 } }, ...over });
  const none = { needs: [], handled: [], handledTotal: 0 };
  const level = (items: ReturnType<typeof statusView>, id: string) => items.find((i) => i.id === id)?.level;
  const daemon = { last: now - 10000, intervalSec: 30, relay: true };

  const calm = statusView({ now, daemon, rows: [row({}), row({})], needs: none, xp24: { perHour: 1500000, leaders: 2 } });
  expect(calm.map((i) => i.level)).toEqual(Array(calm.length).fill("ok"));
  expect(calm.find((i) => i.id === "xp")?.value).toBe(2000000);
  expect(calm.find((i) => i.id === "playing")?.value).toBe("2 / 2");

  const worse = statusView({
    now,
    daemon: { ...daemon, relay: false, last: now - 200000 },
    rows: [row({ playing: false, idleShare: 0.35, details: { heap: { used: 3500, limit: 4000 } } }), row({ idleShare: 0.2 })],
    needs: { ...none, needs: [{ severity: "decide" }] as never },
    xp24: null,
  });
  expect(level(worse, "collector")).toBe("bad");
  expect(level(worse, "relay")).toBe("bad");
  expect(level(worse, "playing")).toBe("bad");
  expect(level(worse, "idle")).toBe("warn"); // the mean of 35% and 20%
  expect(level(worse, "needs")).toBe("bad");
  expect(level(worse, "memory")).toBe("bad");
  expect(worse.find((i) => i.id === "xp24")?.value).toBeNull();
});

/** Insert minute totals of group `grp` at `minutesAgo` minutes before `now`. */
function addMinute(db: ReturnType<typeof openDb>, grp: string, now: number, minutesAgo: number, sec: Record<string, number>, xp = 0, deaths = 0) {
  db.query("INSERT INTO minutes (grp, minute, sec, xp, deaths) VALUES (?, ?, ?, ?, ?)").run(grp, Math.floor(now / 60000) - minutesAgo, JSON.stringify(sec), xp, deaths);
}

test("the timeline has a cell per minute with data, task spans and death marks, and the row's idle share comes from the last hour", () => {
  const db = openDb(":memory:");
  const now = Math.floor(Date.now() / 3600000) * 3600000 + 30 * 60000; // half past an hour, so the hourly bars split
  db.query("INSERT INTO characters (id, name, class, race, first_seen, last_seen) VALUES (1, 'Tank', 'Warrior', 'Human', ?, ?)").run(now, now);
  addSession(db, "Tank", now, { leader: { name: "Tank", level: 30, class: "Warrior" }, activity: { act: "fight", since: now - 5000 }, t: now, bot: { enabled: true, rotation: [], crowdedAt: {}, task: { id: "hunt-9", kind: "hunt", status: "running", step: "camp x", startedAt: now - 10 * 60000 } } });
  db.query("INSERT INTO meta (k, v) VALUES ('coordinator', ?)").run(JSON.stringify({ history: [{ t: now - 90 * 60000, label: "Tank", kind: "hunt", id: "o1", task: "hunt-1", ms: 20 * 60000 }, { t: now - 10 * 60000, label: "Tank", kind: "hunt", id: "o1", task: "hunt-9" }] }));
  // 50 minutes of data: fights, a stretch of idle minutes (crowded), and a death. Nothing before them.
  for (let a = 59; a >= 10; a--) {
    if (a >= 20 && a <= 29) addMinute(db, "G1", now, a, { "idle/crowded": 45, "idle/noTarget": 10, fight: 5 });
    else if (a === 40) addMinute(db, "G1", now, a, { fight: 20, dead: 40 }, -500, 1);
    else addMinute(db, "G1", now, a, { fight: 50, recover: 10 }, 1000);
  }
  const catalog = makeCatalog({ opportunities: [{ id: "o1", item: "Orb" }] });
  const roster = rosterView(db, { groups: [{ id: "G1", members: ["Tank"] }] });
  const [row] = groupRowsView(db, now, { roster, groupOf: new Map([["Tank", "G1"]]), catalog, report: [{ group: "G1", idle: 0.9, idleCause: "off" }] });

  const tl = row.timeline;
  expect(tl.minutes).toBe(120);
  expect(tl.cells.length).toBe(50);
  // Offsets count from the window's start, 119 minutes before the current minute.
  expect(tl.cells.find((c: { m: number }) => c.m === 119 - 59)).toMatchObject({ k: "fight", i: null });
  expect(tl.cells.find((c: { m: number }) => c.m === 119 - 25)).toMatchObject({ k: "idle", i: "crowded" });
  expect(tl.cells.find((c: { m: number }) => c.m === 119 - 40)).toMatchObject({ k: "dead", d: 1, x: -500 });
  // A finished task shows as a span from its queue time for its length, the running one up to now.
  expect(tl.spans.map((s: { name: string; status: string; to: number }) => [s.name, s.status])).toEqual([["Orb", "done"], ["Orb", "running"]]);
  expect(tl.spans[0].to - tl.spans[0].from).toBeCloseTo(20);
  expect(tl.spans[1].to).toBeCloseTo(119, 0);
  // The last hour of minute totals beats the report: 10 minutes with 55 idle seconds each in 50 minutes of data.
  expect(row.idleWindow).toBe("hour");
  expect(row.idleShare).toBeCloseTo(550 / 3000, 3);
  expect(row.idleCause).toBe("crowded");

  // XP over the day and the hourly bars read the same minutes.
  const minutes = minuteTotals(db, now);
  expect(xpRate(minutes, now)).toBeNull(); // under an hour recorded is no rate
  for (let a = 60 * 3; a < 60 * 5; a++) addMinute(db, "G1", now, a, { fight: 60 }, 2000);
  const rate = xpRate(minuteTotals(db, now), now);
  expect(rate?.groups).toBe(1);
  expect(rate?.perHour).toBeGreaterThan(0);
  const bars = hourlyView(minuteTotals(db, now), now);
  expect(bars.length).toBe(24);
  const current = bars.at(-1);
  expect(current).toMatchObject({ partial: true });
  expect(current.sec["idle/crowded"]).toBeGreaterThan(0);
  // The death at 40 minutes ago falls in the hour before.
  expect(bars.at(-2).sec.dead).toBe(40);
  expect(bars.at(-2).deaths).toBe(1);
  expect(bars.at(-2).groupHours).toBeGreaterThan(0);
  expect(bars[0].groupHours).toBe(0);
});

test("the group's task history and the coordinator's outcomes show each task's own outcome", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  db.query("INSERT INTO characters (id, name, class, race, first_seen, last_seen) VALUES (1, 'Tank', 'Warrior', 'Human', ?, ?)").run(now, now);
  db.query("INSERT INTO characters (id, name, class, race, first_seen, last_seen) VALUES (2, 'Solo', 'Wizard', 'Human', ?, ?)").run(now, now);
  addSession(db, "Tank", now, { leader: { name: "Tank", level: 30 }, activity: { act: "fight", since: now }, t: now, bot: { enabled: true, rotation: [], crowdedAt: {}, task: { id: "hunt-3", kind: "hunt", status: "running", startedAt: now - 1000 } } });
  const history = [
    { t: now - 100 * 60000, label: "Tank", kind: "hunt", id: "o1", task: "hunt-1", ms: 600000, status: "failed", step: "make room", error: "no free bag slot", endedAt: now - 90 * 60000 },
    { t: now - 60 * 60000, label: "Tank", kind: "hunt", id: "o2", task: "hunt-2", ms: 300000, status: "done", result: "got Orb", endedAt: now - 55 * 60000 },
    { t: now - 60000, label: "Solo", kind: "quest", id: "q1", task: "quest-1" }, // no outcome yet
    { t: now - 1000, label: "Tank", kind: "hunt", id: "o2", task: "hunt-3" },
  ];
  db.query("INSERT INTO meta (k, v) VALUES ('coordinator', ?)").run(JSON.stringify({ history, last: { t: now, missing: {} } }));
  const catalog = makeCatalog({ opportunities: [{ id: "o1", item: "Shell" }, { id: "o2", item: "Orb" }] });
  const groupOf = new Map([["Tank", "G1"], ["Solo", "G2"]]);
  const roster = rosterView(db, { groups: [{ id: "G1", members: ["Tank"] }, { id: "G2", members: ["Solo"] }] });
  const rows = groupRowsView(db, now, { roster, groupOf, catalog });
  expect(rows[0].details.history.map((h: { name: string; outcome: unknown }) => [h.name, (h.outcome as { status: string } | null)?.status ?? null])).toEqual([["Orb", null], ["Orb", "done"], ["Shell", "failed"]]);
  expect(rows[0].details.history[2].outcome).toMatchObject({ error: "no free bag slot", step: "make room" });
  // A failed task shows red on the timeline.
  expect(rows[0].timeline.spans.map((s: { status: string }) => s.status)).toEqual(["done", "failed", "running"]);
  const view = coordinatorView(db, now, { catalog, rows, groupOf });
  expect(view?.outcomes.map((o: { name: string; status: string; group: string }) => [o.group, o.name, o.status])).toEqual([["G1", "Orb", "done"], ["G1", "Shell", "failed"]]);
  expect(view?.outcomes[1]).toMatchObject({ error: "no free bag slot", step: "make room" });
});

test("the epics summary counts holders, starters and needers of the epic chains, and the goal bar is the done share", () => {
  const chains = {
    "paladin-epic-note": { class: "Paladin", reward: "Sealed Note", minLevel: 15, holders: ["A"], started: ["B"], needers: ["B", "C", "D"] },
    "warrior-epic-1": { class: "Warrior", reward: "Totem", minLevel: 10, holders: ["E", "F"], started: [], needers: [] },
    "other-quest": { class: "Cleric", reward: "X", minLevel: 1, holders: ["G"], started: [], needers: ["H"] },
  };
  const view = epicsView({ last: { chains } });
  expect(view?.chains.map((c: { id: string }) => c.id)).toEqual(["paladin-epic-note", "warrior-epic-1"]);
  expect([view?.holders, view?.started, view?.needers]).toEqual([3, 1, 3]);
  expect(view?.share).toBeCloseTo(3 / 6);
  expect(epicsView({ last: {} })).toBeNull();
});

test("the gear view groups each character's scores by roster group, and the sheet adds the optimal item and its source", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  const card = (id: number, name: string, extra = {}) => ({ id, name, icon: id, slots: ["head"], classes: 65535, races: 65535, reqlevel: 0, type: 10, ...extra });
  const slot = (slotNum: number, slot: string, over = {}) => ({ slotNum, slot, worn: null, move: null, drop: null, ...over });
  db.query("INSERT INTO meta (k, v) VALUES ('gearPlan', ?)").run(JSON.stringify({ t: now, characters: [{ name: "Tank", cls: "warrior", level: 30, score: { now: 50, moves: 75, target: 100 } }, { name: "Healer", cls: "cleric", level: 30, score: { now: 90, moves: 90, target: 90 } }] }));
  db.query("INSERT INTO meta (k, v) VALUES ('gearSheets', ?)").run(JSON.stringify({
    t: now,
    sheets: {
      Tank: [
        slot(2, "head", { worn: { itemId: 1, name: "Cap" }, move: { itemId: 2, item: "Helm", from: "Holder", gain: 9, replaces: "Cap" }, drop: { itemId: 3, item: "Crown", zone: "kurn", npc: "a skeleton", hours: 4, gain: 20 } }),
        slot(5, "neck", { worn: { itemId: 4, name: "Collar" }, move: { itemId: 5, item: "Pendant", from: null, gain: 6, replaces: "Collar", buy: { merchant: "Bob", zone: "kurn", price: 3 } } }),
        slot(1, "ear"),
      ],
      Healer: [],
    },
    items: { 1: card(1, "Cap"), 2: card(2, "Helm"), 3: card(3, "Crown", { flags: ["NO DROP"] }), 4: card(4, "Collar"), 5: card(5, "Pendant") },
  }));
  const roster = rosterView(db, { groups: [{ id: "G1", members: ["Tank", "Healer", "Unplanned"] }] });
  const catalog = makeCatalog({ zones: { kurn: "Kurn's Tower" } });
  const view = gearView(db, { roster });
  expect(view.characters).toBe(2);
  expect(view.groups[0].characters.map((c: { name: string; share: number | null }) => [c.name, c.share])).toEqual([["Tank", 0.5], ["Healer", 1], ["Unplanned", null]]);
  expect(view.groups[0].share).toBeCloseTo(0.75);
  expect(view.share).toBeCloseTo(0.75);
  expect(view.afterMoves).toBeCloseTo(0.875);

  const sheet = gearSheetView(db, "Tank", { roster, catalog });
  expect(sheet.found).toBe(true);
  // The wanted drop is the optimal item and names its zone, enemy and hours, a merchant buy names the merchant, and an empty plan gives no optimal item.
  expect(sheet.slots[0].optimal).toMatchObject({ kind: "drop", item: "Crown" });
  expect(sheet.slots[0].drop).toMatchObject({ zoneName: "Kurn's Tower", npc: "a skeleton", hours: 4 });
  expect(sheet.slots[1].optimal).toMatchObject({ kind: "buy", item: "Pendant" });
  expect(sheet.slots[1].move.buy).toMatchObject({ merchant: "Bob", zoneName: "Kurn's Tower" });
  expect(sheet.slots[2].optimal).toBeNull();
  expect(Object.keys(sheet.items).sort()).toEqual(["1", "2", "3", "4", "5"]);
  expect(gearSheetView(db, "Unplanned", { roster, catalog }).found).toBe(false);
});

test("the AA bar counts trained ranks against the catalog for recorded characters past the unlock level", () => {
  const aa = {
    High: { level: 47, ranks: { 50001: 2, 50002: 1 }, maxRanks: 100, points: 4, t: 1000 },
    Low: { level: 30, ranks: {}, maxRanks: 100, points: 0, t: 2000 },
  };
  expect(aaView(aa, { reached: 1, characters: 72 })).toMatchObject({ share: 0.03, recorded: 1, trained: 3, possible: 100, points: 4, passT: 1000 });
  expect(aaView({}, { reached: 0, characters: 72 }).share).toBeNull();
});

test("a running errand shows instead of an ended task, and a running task instead of an errand", () => {
  const now = 1_800_000_000_000;
  const catalog = makeCatalog({ zones: { gukbottom: "The Ruins of Old Guk" } });
  const errand = { zone: "gukbottom", keep: "ghoul arch magus", item: "Shining Metallic Robes", since: now - 10 * 60000, until: now + 50 * 60000 };
  const ended = { id: "t1", kind: "hunt", status: "done", endedAt: now - 2 * H };
  expect(taskView(catalog, ended, [], now, errand)).toMatchObject({ kind: "errand", name: "Shining Metallic Robes", status: "running", step: "errand for ghoul arch magus in The Ruins of Old Guk, ends in 50 min", forMs: 10 * 60000 });
  expect(taskView(catalog, { ...ended, status: "running", step: "camp" }, [], now, errand)).toMatchObject({ kind: "hunt", status: "running" });
  // A gear target no longer on the wanted list still reads as its enemy in its zone.
  expect(taskName(catalog, "target-gukbottom-a-ghoul-scribe")).toBe("a ghoul scribe in The Ruins of Old Guk");
});

test("a quest's retry time is the coordinator's: a failure under older code is due at once unless the world holds the quest", () => {
  const now = 1_800_000_000_000;
  const catalog = makeCatalog({ quests: { ink: { retryMin: 240 } } });
  const failed = { t: now - 600000, label: "A", kind: "quest", id: "ink", status: "failed", code: "old" };
  expect(retryAt(catalog, failed, { history: [failed], code: "old" })).toBe(failed.t + 240 * 60000);
  expect(retryAt(catalog, failed, { history: [failed], code: "new" })).toBe(0);
  // Another tab's run that waits for the spawn point's roll holds the quest for every tab.
  const waiting = { t: now - 60000, label: "B", kind: "quest", id: "ink", status: "waiting", nextAt: now + 1200000 };
  expect(retryAt(catalog, failed, { history: [failed, waiting], code: "new" })).toBe(now + 1200000);
});
