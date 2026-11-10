// Checks the minute totals (tools/lib/minutes.mjs) that the collector writes and the dashboard reads.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../tools/iqd.mjs";
import { MinuteFolder, RETENTION_MS, backfillMinutes, foldMinutes, pruneMinutes, storeMinutes } from "../tools/lib/minutes.mjs";

const MIN = 60000;
const T0 = 1000 * MIN; // a minute boundary
type Sample = { ses: number; seq?: number; t: number; act: string; why?: string; xp?: number | null; lv?: number[]; party?: unknown[] };
const at = (sec: number, over: Partial<Sample> = {}): Sample => ({ ses: 1, t: T0 + sec * 1000, act: "fight", xp: 1000, ...over });

test("seconds count by activity and cause in the minute of the later sample, and gaps are not play time", () => {
  const totals = foldMinutes(null, [
    at(55),
    at(56),
    at(57, { act: "idle", why: "noTarget" }),
    at(58, { act: "travel", why: "zone" }),
    at(59, { act: "task", why: "task hunt: camp x" }),
    at(61), // the next minute
    at(80), // a 19 s gap: not play time
  ]);
  const [m0, m1] = [totals.get(T0 / MIN), totals.get(T0 / MIN + 1)];
  expect(m0.sec).toEqual({ fight: 1, "idle/noTarget": 1, "travel/zone": 1, task: 1 });
  expect(m1.sec).toEqual({ fight: 2 }); // the gap's 19 s are left out, the 2 s before it count
});

test("XP is the active character's net change, with deaths counted once and party changes left out", () => {
  const solo = { lv: [41], party: [["me"]] };
  const group = { lv: [41, 45, 45], party: [["me"], ["Healer"], ["Pet"]] };
  const totals = foldMinutes(null, [
    at(0, { xp: 100, ...group }),
    at(1, { xp: 600, ...group }), // +500 from a kill
    at(2, { xp: 600, act: "dead", ...group }),
    at(3, { xp: 100, act: "dead", ...group }), // the death took 500, one death
    at(4, { xp: 100, act: "dead", ...group }), // still dead: no second death
    at(5, { xp: 90_000_000, ...solo }), // another character took the tab: not XP gained
    at(6, { xp: 90_000_300, ...solo }),
  ]);
  const row = totals.get(T0 / MIN);
  expect(row.xp).toBe(500 - 500 + 300);
  expect(row.deaths).toBe(1);
});

test("a switch between characters whose parties look alike is not XP gained, because each sample names its character", () => {
  // While a switch runs, neither sample shows a companion yet.
  const alone = { lv: [51], party: [["me"]] };
  const totals = foldMinutes(null, [at(0, { xp: 40_000_000, cid: 1, ...alone }), at(1, { xp: 18_000_000, cid: 2, ...alone }), at(2, { xp: 18_000_400, cid: 2, ...alone })]);
  expect(totals.get(T0 / MIN).xp).toBe(400);
});

test("a recorder session change pairs with nothing", () => {
  const totals = foldMinutes(null, [at(1, { ses: 1, xp: 0 }), at(2, { ses: 2, xp: 5000 })]);
  expect(totals.size).toBe(0);
});

test("stored minutes add up across drains and old rows are pruned", () => {
  const db = openDb(":memory:");
  storeMinutes(db, "G1", foldMinutes(null, [at(10), at(11), at(12)]));
  storeMinutes(db, "G1", foldMinutes(at(12), [at(13, { act: "recover" })]));
  const row = db.query("SELECT sec, xp, deaths FROM minutes WHERE grp = 'G1'").get() as { sec: string };
  expect(JSON.parse(row.sec)).toEqual({ fight: 2, recover: 1 });
  const now = T0 + RETENTION_MS + 5 * MIN;
  db.query("INSERT INTO minutes (grp, minute, sec) VALUES ('G1', ?, '{}')").run(Math.floor(now / MIN));
  expect(pruneMinutes(db, now)).toBe(1);
  expect(db.query("SELECT COUNT(*) AS n FROM minutes").get()).toEqual({ n: 1 });
});

test("the folder pairs samples across drains and counts a sample drained twice once", () => {
  const db = openDb(":memory:");
  const folder = new MinuteFolder(db);
  folder.add("G1", [at(1), at(2), at(3)]);
  folder.add("G1", [at(4), at(5)]); // pairs with the sample before it
  folder.add("G1", [at(1), at(2), at(3), at(4), at(5)]); // another character's directory holds the same samples
  expect(JSON.parse((db.query("SELECT sec FROM minutes").get() as { sec: string }).sec)).toEqual({ fight: 4 });
  // A restarted collector skips what the stored minute already holds.
  new MinuteFolder(db).add("G1", [at(5), at(6), at(7)]);
  expect(JSON.parse((db.query("SELECT sec FROM minutes").get() as { sec: string }).sec)).toEqual({ fight: 4 });
});

test("the backfill counts samples that two characters' files hold once", async () => {
  const runs = mkdtempSync(join(tmpdir(), "iqd-minutes-"));
  const rows = [1, 2, 3, 4].map((s) => ({ ...at(s), seq: s }));
  for (const name of ["Tank", "Healer"]) {
    mkdirSync(join(runs, "live", name), { recursive: true });
    writeFileSync(join(runs, "live", name, "samples.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  const db = openDb(":memory:");
  const n = await backfillMinutes(db, runs, new Map([["Tank", "G1"], ["Healer", "G1"]]), T0 - MIN);
  expect(n).toBe(1);
  expect(JSON.parse((db.query("SELECT sec FROM minutes").get() as { sec: string }).sec)).toEqual({ fight: 3 });
});
