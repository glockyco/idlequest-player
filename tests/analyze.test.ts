// Checks tools/analyze.mjs on a recorded run written to a temporary directory. Run with `bun test`.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const analyze = (samples: object[], events: object[]) => {
  const dir = mkdtempSync(join(tmpdir(), "analyze-"));
  try {
    writeFileSync(join(dir, "samples.jsonl"), samples.map((s) => JSON.stringify(s)).join("\n"));
    writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
    const run = Bun.spawnSync(["bun", new URL("../tools/analyze.mjs", import.meta.url).pathname, dir, "--json"]);
    return JSON.parse(run.stdout.toString());
  } finally {
    rmSync(dir, { recursive: true });
  }
};

test("a DoT tick counts for its caster, and a caster-less tick only on an enemy", () => {
  const party = [["Lead", 100, 100, 50, 100], ["Fushyny", 100, 100, 50, 100]];
  const samples = [1, 2, 3, 4].map((k) => ({ t: 1000 * k, party, combat: true, run: true }));
  const events = [
    "a ghoul has taken 12 damage from your spell.",
    "a ghoul has taken 30 damage from Fushyny's spell.",
    "a ghoul has taken 7 damage from Stranger's spell.",
    "a ghoul has taken 5 damage from a spell.",
    "Fushyny has taken 9 damage from a spell.",
    "Fushyny hits a ghoul for 20 damage.",
  ].map((text, k) => ({ t: 2100 + 100 * k, text }));
  const { damage } = analyze(samples, events);
  expect(damage.me.parts).toEqual({ "DoT ticks": 12 });
  expect(damage.Fushyny.parts).toEqual({ "DoT ticks": 30, melee: 20 });
  expect(damage["no caster"].parts).toEqual({ "DoT ticks": 5 });
  expect(Object.keys(damage).sort()).toEqual(["Fushyny", "me", "no caster"]);
});
