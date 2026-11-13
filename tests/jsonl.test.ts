// The run log readers (tools/lib/jsonl.mjs) against files written here.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastJsonl, readJsonlSince } from "../tools/lib/jsonl.mjs";

const dir = mkdtempSync(join(tmpdir(), "iq-jsonl-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a window's rows come from where the window starts, the same as from a whole read", () => {
  // Half a megabyte of rows a second apart, with text of mixed length and a name of several
  // bytes, and a few rows up to twenty seconds out of order, as two sources write them.
  const T0 = 1_800_000_000_000;
  const rows = Array.from({ length: 4000 }, (_, k) => ({ seq: k, t: T0 + k * 1000 - (k % 97 === 0 ? 20000 : 0), text: `Vulak\`Aerr häuft ${"x".repeat(k % 180)}` }));
  const file = join(dir, "events.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (const since of [T0 - 5000, T0 + 1, T0 + 1_400_500, T0 + 3_990_000, T0 + 30_000_000]) {
    expect(readJsonlSince(file, since)).toEqual(rows.filter((r) => r.t >= since));
  }
  expect(lastJsonl(file)).toEqual(rows.at(-1));
});

test("a short file, a file without a last newline and an empty one read as they are", () => {
  const file = join(dir, "short.jsonl");
  writeFileSync(file, '{"t":1,"a":1}\n{"t":5,"a":2}');
  expect(readJsonlSince(file, 2)).toEqual([{ t: 5, a: 2 }]);
  expect(lastJsonl(file)).toEqual({ t: 5, a: 2 });
  writeFileSync(file, "");
  expect(readJsonlSince(file, 0)).toEqual([]);
  expect(lastJsonl(file)).toBeNull();
});

test("cut and glued lines do not hide valid rows", () => {
  const file = join(dir, "damaged.jsonl");
  writeFileSync(file, '{"t":1}\n{"t":2}{"t":3}\n{"t":4}\n{"t":');
  expect(readJsonlSince(file, 2)).toEqual([{ t: 4 }]);
  expect(lastJsonl(file)).toEqual({ t: 4 });
  writeFileSync(file, '{"t":1}\n' + "x".repeat(300000));
  expect(lastJsonl(file)).toEqual({ t: 1 });
  writeFileSync(file, '{"t":');
  expect(readJsonlSince(file, 0)).toEqual([]);
  expect(lastJsonl(file)).toBeNull();
});
