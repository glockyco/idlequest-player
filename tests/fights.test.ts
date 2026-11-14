import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "iq-fights-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const tool = new URL("../tools/fights.mjs", import.meta.url).pathname;
const start = Date.now() - 30000;
const party = join(dir, "party");
mkdirSync(party);
const event = (seq: number, dt: number, type: string, text: string) => ({ ses: "fixture", seq, t: start + dt, type, text });
const events = [
  event(1, 0, "SYSTEM", "You engage a rat in combat!"),
  event(3, 2000, "EXPERIENCE_GAIN", "You have defeated a rat and gained 10 experience"),
  event(2, 1000, "COMBAT_INCOMING", "a rat hits you for 4 damage!"),
  event(2, 1000, "COMBAT_INCOMING", "a rat hits you for 4 damage!"),
  event(4, 15000, "SYSTEM", "You engage a rat in combat!"),
  event(5, 16000, "COMBAT_INCOMING", "a rat hits you for 8 damage!"),
];
writeFileSync(join(party, "events.jsonl"), events.map((r) => JSON.stringify(r)).join("\n") + "\n");
const samples = Array.from({ length: 21 }, (_, k) => ({ ses: "fixture", seq: k, t: start - 2000 + k * 1000, zone: null, lvl: 4, party: [["me", 90, 100]], lv: [4] }));
writeFileSync(join(party, "samples.jsonl"), samples.map((r) => JSON.stringify(r)).join("\n") + "\n");
function fights(...args: string[]) {
  const proc = Bun.spawnSync(["bun", tool, "--dump", ...args, party]);
  expect(proc.exitCode).toBe(0);
  const text = proc.stdout.toString().trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

test("fight streams reorder and deduplicate rows and preserve cycle summaries", () => {
  const rows = fights();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ start, secs: 2, dmgTaken: 4, kills: 1, xp: 10, cycle: 15, toNext: 13, leaderLevel: 4, closedBy: "quiet" });
  expect(rows[1]).toMatchObject({ start: start + 15000, dmgTaken: 8, cycle: null, toNext: null });
  expect(rows[0].raw).toBeUndefined();
  expect(rows[0].replayRows).toBeUndefined();
});

test("fight time options exclude old rows without becoming directory arguments", () => {
  expect(fights("--since", String(start + 10000))).toHaveLength(1);
  expect(fights("--last", "60")).toHaveLength(2);
  expect(fights("--last", "60", "--since", String(start + 10000))).toHaveLength(1);
});
