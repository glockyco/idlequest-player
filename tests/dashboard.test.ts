// Checks the dashboard's views of the collector database (tools/lib/dashboard.mjs) on an in-memory
// database. Run with `bun test`.
import { expect, test } from "bun:test";
import { openDb } from "../tools/iqd.mjs";
import { dayStart, engineeringView, rosterView } from "../tools/lib/dashboard.mjs";
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
